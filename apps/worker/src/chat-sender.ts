/**
 * The outbound chat worker — §15.5.
 *
 *   - Single outbound worker per channel, token bucket at ~1 msg/sec
 *   - Batching window coalescing queued acks into one <=500 char write
 *   - Priority lanes: errors and announcements beat batched summaries
 *   - 429 -> respect Retry-After, exponential backoff, circuit break
 *   - Vary text on repeats (Kick drops identical consecutive messages)
 *   - Announcements retry twice then give up silently
 *
 * "Never send chat from the webhook handler" — everything here runs in the
 * worker, off the ingest path.
 */

import { coalesce, truncate, varyIfRepeat, type ChatEffect } from '@streamarena/core'
import { KickApiError, KickRateLimitError } from '@streamarena/kick'
import { KEY, type ChatJob } from '@streamarena/platform'
import type { WorkerContext } from './context.js'

/** Announcements retry twice then give up silently (§15.5). */
const ANNOUNCE_MAX_ATTEMPTS = 3
/** Consecutive failures on one channel before we stop trying for a while. */
const CIRCUIT_BREAK_AFTER = 5
const CIRCUIT_OPEN_MS = 60_000

const circuits = new Map<string, { failures: number; openUntil: number }>()

export async function handleChatJob(ctx: WorkerContext, job: ChatJob, name: string): Promise<void> {
  if (isCircuitOpen(job.channelId)) {
    ctx.log.warn({ channelId: job.channelId }, 'chat circuit open, dropping message')
    return
  }

  const text = name === 'flush-batch' ? await drainBatch(ctx, job) : job.text
  if (!text || text.trim() === '') return

  await takeToken(ctx, job.channelId)

  // Kick's anti-spam drops identical consecutive messages, so a repeated
  // rejection ("that slot is taken") would silently stop reaching anyone.
  const lastKey = KEY.chatLastText(job.channelId)
  const previous = await ctx.redis.get(lastKey)
  const finalText = truncate(varyIfRepeat(text, previous, Date.now()))

  try {
    await ctx.tokens.client(job.ownerUserId).sendChat({
      broadcasterUserId: job.broadcasterUserId,
      content: finalText,
      type: 'user',
      ...(job.replyTo ? { replyToMessageId: job.replyTo } : {}),
    })

    await ctx.redis.set(lastKey, finalText, 'EX', 300)
    resetCircuit(job.channelId)
    await ctx.repos.quota.increment(job.channelId, 'chatWrites').catch(() => {})
  } catch (err) {
    await onSendFailure(ctx, job, err)
  }
}

async function onSendFailure(ctx: WorkerContext, job: ChatJob, err: unknown): Promise<void> {
  await ctx.repos.quota.increment(job.channelId, 'chatFailures').catch(() => {})

  if (err instanceof KickRateLimitError) {
    // Respect Retry-After rather than guessing. Re-queue at the same priority
    // so an announcement doesn't fall behind a backlog of acks.
    recordFailure(job.channelId)
    await ctx.queues.chat.add(
      'send',
      { ...job, attempt: (job.attempt ?? 0) + 1 },
      { delay: err.retryAfterMs },
    )
    ctx.log.warn({ channelId: job.channelId, retryInMs: err.retryAfterMs }, 'kick rate limited')
    return
  }

  if (err instanceof KickApiError && err.isChannelRestriction) {
    // §15.6 — the channel is in slow / follower-only / sub-only mode, or our
    // token lost the scope. Degrade to overlay-only feedback rather than
    // retrying into a wall.
    recordFailure(job.channelId)
    ctx.log.warn(
      { channelId: job.channelId, status: err.status },
      'chat write refused by channel restrictions, degrading to overlay-only',
    )
    return
  }

  recordFailure(job.channelId)

  const attempt = (job.attempt ?? 0) + 1
  const isAnnouncement = job.priority === 'announce'

  if (isAnnouncement && attempt < ANNOUNCE_MAX_ATTEMPTS) {
    await ctx.queues.chat.add('send', { ...job, attempt }, { delay: 2_000 * attempt })
    return
  }

  // §15.5 — "Announcements retry twice then give up silently. The overlay
  // already showed the result; a failed chat write isn't worth escalating
  // mid-stream."
  ctx.log.error(
    { channelId: job.channelId, priority: job.priority, attempt, err: String(err) },
    'chat write failed',
  )
}

/**
 * §15.5 — coalesce a batch window's worth of acks into one write. Anything that
 * doesn't fit rolls into the next window rather than vanishing.
 */
async function drainBatch(ctx: WorkerContext, job: ChatJob): Promise<string> {
  const key = KEY.chatBatch(job.sessionId)
  const raw = await ctx.redis.lrange(key, 0, -1)
  if (raw.length === 0) return ''
  await ctx.redis.del(key)

  const effects: ChatEffect[] = []
  for (const item of raw) {
    try {
      effects.push(JSON.parse(item) as ChatEffect)
    } catch {
      // A malformed entry is not worth failing the whole batch over.
    }
  }

  const { text, deferred } = coalesce(effects)

  if (deferred.length > 0) {
    for (const effect of deferred) await ctx.redis.rpush(key, JSON.stringify(effect))
    await ctx.redis.expire(key, 300)
    await ctx.queues.chat.add('flush-batch', { ...job, text: '' }, { delay: ctx.env.CHAT_BATCH_WINDOW_MS })
  }

  return text
}

/**
 * Token bucket, one per channel (§15.5). Implemented as a Redis counter with a
 * one-second window: simple, survives a worker restart, and shared across every
 * worker instance so scaling out doesn't multiply our send rate.
 */
async function takeToken(ctx: WorkerContext, channelId: string): Promise<void> {
  const perSecond = ctx.env.CHAT_TOKENS_PER_SEC
  for (let attempt = 0; attempt < 40; attempt++) {
    const key = `${KEY.chatBucket(channelId)}:${Math.floor(Date.now() / 1000)}`
    const used = await ctx.redis.incr(key)
    if (used === 1) await ctx.redis.expire(key, 2)
    if (used <= perSecond) return
    await sleep(250)
  }
  // Ten seconds of contention on one channel means something is badly wrong
  // upstream; send anyway rather than silently dropping the message.
  ctx.log.warn({ channelId }, 'chat token bucket starved, sending regardless')
}

function isCircuitOpen(channelId: string): boolean {
  const circuit = circuits.get(channelId)
  if (!circuit) return false
  if (circuit.openUntil > Date.now()) return true
  if (circuit.openUntil !== 0) circuits.delete(channelId)
  return false
}

function recordFailure(channelId: string): void {
  const circuit = circuits.get(channelId) ?? { failures: 0, openUntil: 0 }
  circuit.failures += 1
  if (circuit.failures >= CIRCUIT_BREAK_AFTER) {
    circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS
    circuit.failures = 0
  }
  circuits.set(channelId, circuit)
}

function resetCircuit(channelId: string): void {
  circuits.delete(channelId)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
