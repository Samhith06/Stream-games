/**
 * Per-session mutex.
 *
 * The database row lock already makes sequence allocation safe, but two workers
 * could still read the same state, reduce independently, and each produce a
 * plausible-looking event that ignores the other's effect — two viewers both
 * "first" to claim a slot, say. This serialises load -> reduce -> commit per
 * session. It's per session, so channels never contend with each other.
 */

import type { Redis } from 'ioredis'

const LOCK_TTL_MS = 15_000
const RETRY_DELAY_MS = 25
const MAX_WAIT_MS = 10_000

export class SessionLockTimeout extends Error {
  constructor(sessionId: string) {
    super(`Timed out waiting for the lock on session ${sessionId}`)
    this.name = 'SessionLockTimeout'
  }
}

export async function withSessionLock<T>(
  redis: Redis,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `lock:session:${sessionId}`
  // A unique token so we only ever release a lock we still hold — without it, a
  // slow handler whose lock expired would delete the next holder's.
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`

  const deadline = Date.now() + MAX_WAIT_MS
  while (true) {
    const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')
    if (acquired === 'OK') break
    if (Date.now() > deadline) throw new SessionLockTimeout(sessionId)
    await sleep(RETRY_DELAY_MS)
  }

  try {
    return await fn()
  } finally {
    // Compare-and-delete, so an expired lock now held by someone else survives.
    await redis
      .eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        key,
        token,
      )
      .catch(() => {})
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
