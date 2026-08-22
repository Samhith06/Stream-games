/**
 * Step 8 — the effect executor (§10).
 *
 *   chat      -> outbound queue (batched, throttled)
 *   broadcast -> Redis pub/sub -> WS -> overlay
 *   timer     -> BullMQ delayed job
 *   lookup    -> catalog -> re-enters at step 2
 *
 * This is the only place in the platform that turns a game's intent into an
 * action. A game never reaches any of these services directly (§9), which is
 * what lets chat policy, throttling and the stream delay be applied uniformly.
 */

import { decideChat, type ChatEffect, type Effect } from '@streamarena/core'
import { CHAT_PRIORITY, KEY, type SessionMeta } from '@streamarena/platform'
import type { WorkerContext } from './context.js'

export interface ExecuteInput {
  seq: number
  effects: Effect[]
  state: unknown
}

export async function executeEffects(
  ctx: WorkerContext,
  meta: SessionMeta,
  input: ExecuteInput,
): Promise<void> {
  for (const effect of input.effects) {
    try {
      await executeOne(ctx, meta, input, effect)
    } catch (err) {
      // One failed effect must never abort the rest. The state is already
      // committed; dropping the remaining broadcasts because a chat write
      // failed would desync the overlay, which is worse (§19).
      ctx.log.error(
        { sessionId: meta.sessionId, kind: effect.kind, err: String(err) },
        'effect failed',
      )
    }
  }
}

async function executeOne(
  ctx: WorkerContext,
  meta: SessionMeta,
  input: ExecuteInput,
  effect: Effect,
): Promise<void> {
  switch (effect.kind) {
    case 'broadcast':
      await ctx.bus.publish(meta.sessionId, {
        t: 'patch',
        sessionId: meta.sessionId,
        seq: input.seq,
        frame: await ctx.cache.nextFrame(meta.sessionId),
        patch: effect.patch,
        ...(effect.dashboardPatch && Object.keys(effect.dashboardPatch).length > 0
          ? { dashboardPatch: effect.dashboardPatch }
          : {}),
        serverTime: Date.now(),
      })
      return

    case 'chat':
      await queueChat(ctx, meta, effect)
      return

    case 'timer': {
      // Named timers replace one another, so re-arming a countdown can't leave
      // the old one to fire later and lock a window twice.
      const jobId = effect.id ? timerJobId(meta.sessionId, effect.id) : undefined
      if (jobId) await removeTimer(ctx, jobId)
      await ctx.queues.timer.add(
        'timer',
        { sessionId: meta.sessionId, payload: effect.event, timerId: effect.id },
        { delay: effect.inMs, ...(jobId ? { jobId } : {}) },
      )
      return
    }

    case 'cancelTimer':
      await removeTimer(ctx, timerJobId(meta.sessionId, effect.id))
      return

    case 'lookup':
      await ctx.queues.lookup.add('lookup', {
        sessionId: meta.sessionId,
        query: effect.query,
        then: effect.then,
      })
      return

    case 'persist':
      // Reserved for records a game wants durably stored outside its own state.
      // Nothing uses it yet; the log already holds everything either game needs.
      ctx.log.debug({ sessionId: meta.sessionId }, 'persist effect ignored (no consumers)')
      return

    case 'end':
      await ctx.queues.ingest.add('ingest', {
        kind: 'end',
        sessionId: meta.sessionId,
        reason: effect.reason ?? 'complete',
        at: Date.now(),
      })
      return
  }
}

/**
 * Applies the streamer's chat policy (§15.1-15.3) before anything reaches the
 * outbound queue. A dropped ack costs nothing here — the overlay already showed
 * the result.
 */
async function queueChat(
  ctx: WorkerContext,
  meta: SessionMeta,
  effect: ChatEffect,
): Promise<void> {
  const decision = decideChat(effect, meta.chatPolicy)

  if (decision.send === 'drop') {
    ctx.log.debug(
      { sessionId: meta.sessionId, reason: decision.reason },
      'chat effect dropped by policy',
    )
    return
  }

  const job = {
    sessionId: meta.sessionId,
    channelId: meta.channelId,
    ownerUserId: meta.ownerUserId,
    broadcasterUserId: meta.broadcasterUserId,
    text: effect.text,
    ...(effect.replyTo ? { replyTo: effect.replyTo } : {}),
    priority: effect.priority,
  }

  if (decision.send === 'batched') {
    // §15.5 — coalesced into one <=500 char write by the batch flusher.
    await ctx.redis.rpush(KEY.chatBatch(meta.sessionId), JSON.stringify(effect))
    await ctx.redis.expire(KEY.chatBatch(meta.sessionId), 300)
    await ctx.queues.chat.add(
      'flush-batch',
      { ...job, text: '', priority: 'batched' },
      {
        // One flush job per window per session — a hundred queued acks must not
        // become a hundred flushes.
        jobId: `batch-${meta.sessionId}-${Math.floor(Date.now() / ctx.env.CHAT_BATCH_WINDOW_MS)}`,
        delay: ctx.env.CHAT_BATCH_WINDOW_MS,
        priority: CHAT_PRIORITY.batched,
      },
    )
    return
  }

  await ctx.queues.chat.add('send', job, {
    priority: CHAT_PRIORITY[effect.priority],
    // §15.3 — the stream delay, so chat doesn't spoil the overlay reveal.
    ...(decision.send === 'delayed' ? { delay: decision.delayMs } : {}),
  })
}

/**
 * BullMQ rejects ':' in a custom job id — it is the key separator. Getting this
 * wrong is silent: the add throws, the executor logs it, and the countdown that
 * was supposed to close a guess window simply never fires.
 */
function timerJobId(sessionId: string, timerId: string): string {
  return `t-${sessionId}-${timerId}`
}

async function removeTimer(ctx: WorkerContext, jobId: string): Promise<void> {
  const job = await ctx.queues.timer.getJob(jobId)
  if (job) await job.remove().catch(() => {})
}
