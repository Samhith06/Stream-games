/**
 * Steps 2-5 of the pipeline (§10): normalise, route, parse, guard.
 *
 *   2. NORMALISE KickEvent -> InternalEvent
 *   3. ROUTE     broadcaster_user_id -> active session?  no session -> drop
 *   4. PARSE     message text -> command?
 *   5. GUARD     ordered, fail fast
 *
 * §10's emphasis: "Most webhook traffic is not a command — on a busy stream,
 * 95%+ of deliveries are ordinary conversation." Steps 3 and 4 are therefore
 * the cheapest code here, and everything expensive happens after them.
 */

import {
  CommandRegistry,
  denialMessage,
  looksLikeCommand,
  runGuards,
  type Actor,
} from '@streamarena/core'
import type { RoleGate } from '@streamarena/shared'
import { normalise } from '@streamarena/kick'
import type { IngestJob, SessionMeta } from '@streamarena/platform'
import type { WorkerContext } from './context.js'
import { applyEvent } from './session-runner.js'
import { endSession, startSession } from './session-lifecycle.js'

export async function handleIngestJob(ctx: WorkerContext, job: IngestJob): Promise<void> {
  switch (job.kind) {
    case 'kick':
      return handleKickEvent(ctx, job)
    case 'control':
      return handleControl(ctx, job)
    case 'start':
      return startSession(ctx, job.sessionId)
    case 'end':
      return endSession(ctx, job.sessionId, job.reason)
  }
}

async function handleKickEvent(
  ctx: WorkerContext,
  job: Extract<IngestJob, { kind: 'kick' }>,
): Promise<void> {
  // ── 2. Normalise ──────────────────────────────────────────────────────────
  const event = normalise(job.eventType, job.payload)
  if (!event) return

  // ── 3. Route. Most traffic dies here, on one Redis GET. ───────────────────
  const sessionId = await ctx.cache.sessionIdForChannel(event.broadcasterUserId)
  if (!sessionId) {
    await bumpQuota(ctx, null, { deliveries: 1, dropped: 1 })
    return
  }

  const meta = await ctx.cache.meta(sessionId)
  if (!meta) {
    ctx.log.warn({ sessionId }, 'session pointer with no metadata; clearing')
    await ctx.redis.del(`channel:${event.broadcasterUserId}:session`)
    return
  }

  await bumpQuota(ctx, meta.channelId, { deliveries: 1 })

  if (event.kind !== 'chat') {
    // A platform event the active game asked for. Games opt in through
    // `subscriptions`, so if we're receiving it, somebody wants it.
    await applyEvent(ctx, meta, {
      type: event.kind === 'subscription' ? 'channel.subscription' : 'channel.kicks',
      at: job.receivedAt,
      actor: event.actor,
      payload: event.payload,
    })
    return
  }

  // ── 4. Parse. One charAt before anything allocates. ───────────────────────
  if (!looksLikeCommand(event.text)) {
    await bumpQuota(ctx, meta.channelId, { dropped: 1 })
    return
  }

  const registry = commandRegistryFor(ctx, meta)
  const parsed = registry.parse(event.text)
  if (!parsed) {
    await bumpQuota(ctx, meta.channelId, { dropped: 1 })
    return
  }

  // ── 5. Guard ──────────────────────────────────────────────────────────────
  const settings = meta.commandSettings[parsed.id] ?? {}
  const verdict = await runGuards(ctx.guards, {
    sessionId: meta.sessionId,
    spec: parsed.spec,
    actor: event.actor,
    sessionAccepting: meta.accepting,
    enabled: settings.enabled !== false,
    ...(settings.gate ? { gateOverride: settings.gate as RoleGate } : {}),
  })

  if (!verdict.allowed) {
    await rejectInChat(ctx, meta, event.actor, event.messageId, verdict.denial)
    return
  }

  await bumpQuota(ctx, meta.channelId, { commands: 1 })

  // ── 6-8, in the session runner ────────────────────────────────────────────
  const result = await applyEvent(
    ctx,
    meta,
    {
      type: 'command',
      at: job.receivedAt,
      command: parsed.id,
      args: parsed.args,
      raw: event.text,
      actor: event.actor,
      messageId: event.messageId,
    },
    { kickMessageId: event.messageId },
  )

  // Quota is consumed only by a command that actually took effect, so a
  // rejected `!sr` never eats someone's single entry.
  if (result.applied) {
    await ctx.guards.recordUse(meta.sessionId, parsed.id, event.actor.userId)
    if (parsed.spec.cooldownMs > 0) {
      await ctx.guards.startCooldown(
        meta.sessionId,
        parsed.id,
        event.actor.userId,
        parsed.spec.cooldownMs,
      )
    }
  }
}

async function handleControl(
  ctx: WorkerContext,
  job: Extract<IngestJob, { kind: 'control' }>,
): Promise<void> {
  const meta = await ctx.cache.meta(job.sessionId)
  if (!meta) {
    ctx.log.warn({ sessionId: job.sessionId }, 'control event for an unknown session')
    return
  }

  await applyEvent(ctx, meta, {
    type: 'control',
    at: job.at,
    action: job.action,
    payload: job.payload,
    actor: job.actor as Actor,
  })
}

/**
 * §15.1 — rejections are one of the few cases where chat is the only channel
 * that works, so they bypass the reducer and go straight to the sender. The
 * game never sees a command that failed a guard.
 */
async function rejectInChat(
  ctx: WorkerContext,
  meta: SessionMeta,
  actor: Actor,
  messageId: string,
  denial: Parameters<typeof denialMessage>[0],
): Promise<void> {
  // A silent denial reason. The session simply isn't listening; telling every
  // viewer that would be noise, not help.
  if (denial.reason === 'command_disabled') return

  const { decideChat } = await import('@streamarena/core')
  const decision = decideChat(
    { kind: 'chat', text: denialMessage(denial, actor.username), replyTo: messageId, priority: 'error' },
    meta.chatPolicy,
  )
  if (decision.send === 'drop') return

  await ctx.queues.chat.add('send', {
    sessionId: meta.sessionId,
    channelId: meta.channelId,
    ownerUserId: meta.ownerUserId,
    broadcasterUserId: meta.broadcasterUserId,
    text: decision.effect.text,
    replyTo: messageId,
    priority: 'error',
  })
}

/**
 * Command registries are per session, not per message — building one on every
 * chat line would undo the point of step 4 being cheap.
 */
const registryCache = new Map<string, { registry: CommandRegistry; gameId: string }>()

function commandRegistryFor(ctx: WorkerContext, meta: SessionMeta): CommandRegistry {
  const cached = registryCache.get(meta.sessionId)
  if (cached && cached.gameId === meta.gameId) return cached.registry

  const game = ctx.registry.require(meta.gameId)
  const registry = new CommandRegistry(game.commands, meta.commandOverrides)
  registryCache.set(meta.sessionId, { registry, gameId: meta.gameId })
  return registry
}

export function forgetCommandRegistry(sessionId: string): void {
  registryCache.delete(sessionId)
}

/**
 * §6.3 — quota telemetry. Buffered in Redis and flushed periodically, because
 * a database write per webhook delivery would cost more than the game logic.
 */
async function bumpQuota(
  ctx: WorkerContext,
  channelId: string | null,
  counts: Record<string, number>,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const field = channelId ?? 'unknown'
  const pipeline = ctx.redis.multi()
  for (const [counter, amount] of Object.entries(counts)) {
    pipeline.hincrby(KEY_QUOTA(day), `${field}:${counter}`, amount)
  }
  pipeline.expire(KEY_QUOTA(day), 3 * 86_400)
  await pipeline.exec().catch(() => {})
}

const KEY_QUOTA = (day: string) => `quota:${day}`
