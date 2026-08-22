/**
 * Redis-backed GuardStore — §10 step 5.
 *
 * Cooldowns and per-viewer caps have to survive a worker restart, or every
 * deploy hands the whole channel a free reset. They're still only a cache:
 * worst case after a Redis wipe, a few viewers get one extra `!sr`, which is a
 * far better failure than refusing to start.
 */

import type { Redis } from 'ioredis'
import type { GuardStore } from '@streamarena/core'
import { KEY, SESSION_TTL_SECONDS } from './redis.js'

export class RedisGuardStore implements GuardStore {
  constructor(private readonly redis: Redis) {}

  async cooldownRemaining(sessionId: string, commandId: string, userId: string): Promise<number> {
    const ttl = await this.redis.pttl(KEY.cooldown(sessionId, commandId, userId))
    return ttl > 0 ? ttl : 0
  }

  async startCooldown(
    sessionId: string,
    commandId: string,
    userId: string,
    ms: number,
  ): Promise<void> {
    if (ms <= 0) return
    await this.redis.set(KEY.cooldown(sessionId, commandId, userId), '1', 'PX', ms)
  }

  async userCount(sessionId: string, commandId: string, userId: string): Promise<number> {
    return Number((await this.redis.get(KEY.useCount(sessionId, commandId, userId))) ?? 0)
  }

  async globalCount(sessionId: string, commandId: string): Promise<number> {
    return Number((await this.redis.get(KEY.useCount(sessionId, commandId))) ?? 0)
  }

  /** Only called after reduce() succeeds — a rejection never consumes quota. */
  async recordUse(sessionId: string, commandId: string, userId: string): Promise<void> {
    const perUser = KEY.useCount(sessionId, commandId, userId)
    const global = KEY.useCount(sessionId, commandId)
    await this.redis
      .multi()
      .incr(perUser)
      .expire(perUser, SESSION_TTL_SECONDS)
      .incr(global)
      .expire(global, SESSION_TTL_SECONDS)
      .exec()
  }

  /** Called when a session ends, so counters can't bleed into the next one. */
  async clearSession(sessionId: string): Promise<void> {
    const patterns = [`cooldown:${sessionId}:*`, `uses:${sessionId}:*`]
    for (const pattern of patterns) {
      // SCAN rather than KEYS: this runs on a live Redis serving the hot path,
      // and KEYS on a large keyspace blocks the server.
      let cursor = '0'
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
        cursor = next
        if (keys.length > 0) await this.redis.del(...keys)
      } while (cursor !== '0')
    }
  }
}
