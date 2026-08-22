/**
 * Scheduled housekeeping.
 *
 * Quota telemetry (§6.3) is buffered in Redis on the hot path and flushed here,
 * because a database write per webhook delivery would cost more than the game
 * logic it's measuring.
 */

import type { QuotaCounter } from '@streamarena/db'
import type { WorkerContext } from './context.js'
import { endSession } from './session-lifecycle.js'

const COUNTERS: QuotaCounter[] = ['deliveries', 'commands', 'dropped', 'chatWrites', 'chatFailures']

export async function flushQuota(ctx: WorkerContext): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const key = `quota:${day}`

  const buffered = await ctx.redis.hgetall(key)
  const fields = Object.keys(buffered)
  if (fields.length === 0) return

  // Take the buffer atomically so deliveries arriving during the flush land in
  // a fresh buffer rather than being counted twice or lost.
  const taken = await ctx.redis.multi().hgetall(key).del(key).exec()
  const snapshot = (taken?.[0]?.[1] ?? {}) as Record<string, string>

  const byChannel = new Map<string, Partial<Record<QuotaCounter, number>>>()
  for (const [field, value] of Object.entries(snapshot)) {
    const sep = field.lastIndexOf(':')
    if (sep < 0) continue
    const channelId = field.slice(0, sep)
    const counter = field.slice(sep + 1) as QuotaCounter
    if (!COUNTERS.includes(counter)) continue

    const bucket = byChannel.get(channelId) ?? {}
    bucket[counter] = (bucket[counter] ?? 0) + Number(value)
    byChannel.set(channelId, bucket)
  }

  for (const [channelId, counts] of byChannel) {
    await ctx.repos.quota
      .incrementMany(channelId === 'unknown' ? null : channelId, counts)
      .catch((err) => ctx.log.error({ channelId, err: String(err) }, 'quota flush failed'))
  }

  ctx.log.debug({ channels: byChannel.size }, 'quota flushed')
}

/**
 * A session left running because the streamer closed the tab keeps a Kick
 * subscription alive, and that is the one thing §6.3 says never to do. After a
 * long silence, close it out.
 */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

export async function sweepStaleSessions(ctx: WorkerContext): Promise<void> {
  const active = await ctx.repos.sessions.allActive()
  const cutoff = Date.now() - STALE_AFTER_MS

  for (const session of active) {
    const started = (session.startedAt ?? session.createdAt).getTime()
    if (started > cutoff) continue

    ctx.log.warn(
      { sessionId: session.id, startedAt: session.startedAt },
      'abandoning stale session and releasing its Kick subscription',
    )
    await endSession(ctx, session.id, 'abandoned').catch((err) =>
      ctx.log.error({ sessionId: session.id, err: String(err) }, 'stale sweep failed'),
    )
  }
}
