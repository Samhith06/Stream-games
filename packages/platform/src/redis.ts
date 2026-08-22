/**
 * Redis keys and connections — §11.
 *
 * "Nothing lives only in Redis. If Redis is wiped, every session rebuilds from
 * snapshots plus events." Every helper here is a cache or a queue, never a
 * source of truth, and `rebuildable` is asserted by the session runner rather
 * than assumed.
 */

import { Redis, type RedisOptions } from 'ioredis'

export const KEY = {
  /** Current projected state, for a fast overlay snapshot without a replay. */
  sessionState: (sessionId: string) => `session:${sessionId}:state`,
  sessionSeq: (sessionId: string) => `session:${sessionId}:seq`,
  /** Monotonic count of broadcast frames — see PatchFrame.frame. */
  sessionFrame: (sessionId: string) => `session:${sessionId}:frame`,
  /** Step-3 lookup: broadcaster -> active session. The hottest key we have. */
  channelSession: (broadcasterUserId: string) => `channel:${broadcasterUserId}:session`,
  /** Session metadata the router needs before it can decide anything. */
  sessionMeta: (sessionId: string) => `session:${sessionId}:meta`,
  dedupe: (kickMessageId: string) => `dedupe:${kickMessageId}`,
  cooldown: (sessionId: string, commandId: string, userId: string) =>
    `cooldown:${sessionId}:${commandId}:${userId}`,
  useCount: (sessionId: string, commandId: string, userId?: string) =>
    userId === undefined ? `uses:${sessionId}:${commandId}` : `uses:${sessionId}:${commandId}:${userId}`,
  chatBucket: (channelId: string) => `bucket:chat:${channelId}`,
  chatLastText: (channelId: string) => `chat:last:${channelId}`,
  chatBatch: (sessionId: string) => `chat:batch:${sessionId}`,
  quotaBuffer: (day: string) => `quota:${day}`,
  overlayChannel: (sessionId: string) => `overlay:${sessionId}`,
} as const

/** 24h — long enough to cover any redelivery window Kick might use (§10). */
export const DEDUPE_TTL_SECONDS = 24 * 60 * 60
/** Session caches outlive any realistic session but never linger forever. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60

export function createRedis(url: string, opts: RedisOptions = {}): Redis {
  return new Redis(url, {
    // BullMQ requires this, and it's the right behaviour for us anyway: a
    // command that queues forever behind a dead connection is worse than one
    // that fails fast and gets retried by the job.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts,
  })
}

/**
 * §10 step 1 — "check Kick-Event-Message-Id in Redis (24h TTL) -> drop dupes".
 * Returns true the first time a message id is seen, false on every redelivery.
 */
export async function claimDelivery(redis: Redis, kickMessageId: string): Promise<boolean> {
  const result = await redis.set(KEY.dedupe(kickMessageId), '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
  return result === 'OK'
}
