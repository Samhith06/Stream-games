/**
 * The hot-path session cache — §10 step 3, §11.
 *
 * "Most webhook traffic is not a command — on a busy stream, 95%+ of deliveries
 * are ordinary conversation. Make 'no active session' and 'not a command' the
 * fastest code in the system: a Redis hash lookup and a single-character check
 * on the first byte."
 *
 * This file is that Redis hash lookup. Everything in it is reconstructible from
 * Postgres; nothing here is a source of truth.
 */

import type { Redis } from 'ioredis'
import type { ChatPolicy, OverlayState } from '@streamarena/shared'
import { KEY, SESSION_TTL_SECONDS } from './redis.js'

/** The minimum the router needs before it can decide to do anything at all. */
export interface SessionMeta {
  sessionId: string
  channelId: string
  broadcasterUserId: string
  ownerUserId: string
  gameId: string
  stateVersion: number
  seed: string
  startedAt: number
  ownerUsername: string
  config: Record<string, unknown>
  chatPolicy: ChatPolicy
  /** Per-command keyword overrides from game_configs. */
  commandOverrides: Record<string, string[]>
  /** Per-command enable/gate overrides from game_configs. */
  commandSettings: Record<string, { enabled?: boolean; gate?: string }>
  accepting: boolean
}

export class SessionCache {
  constructor(private readonly redis: Redis) {}

  /**
   * Step 3's actual lookup. Returns null for the overwhelming majority of
   * webhook deliveries, which is exactly the point.
   */
  async sessionIdForChannel(broadcasterUserId: string): Promise<string | null> {
    return this.redis.get(KEY.channelSession(broadcasterUserId))
  }

  async meta(sessionId: string): Promise<SessionMeta | null> {
    const raw = await this.redis.get(KEY.sessionMeta(sessionId))
    return raw === null ? null : (JSON.parse(raw) as SessionMeta)
  }

  async putMeta(meta: SessionMeta): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.sessionMeta(meta.sessionId), JSON.stringify(meta), 'EX', SESSION_TTL_SECONDS)
      .set(
        KEY.channelSession(meta.broadcasterUserId),
        meta.sessionId,
        'EX',
        SESSION_TTL_SECONDS,
      )
      .exec()
  }

  /** Called on session end. The channel pointer goes first — it gates ingest. */
  async clear(meta: Pick<SessionMeta, 'sessionId' | 'broadcasterUserId'>): Promise<void> {
    await this.redis
      .multi()
      .del(KEY.channelSession(meta.broadcasterUserId))
      .del(KEY.sessionMeta(meta.sessionId))
      .del(KEY.sessionState(meta.sessionId))
      .del(KEY.sessionSeq(meta.sessionId))
      .del(KEY.sessionFrame(meta.sessionId))
      .exec()
  }

  /**
   * The projected overlay state, so a reconnecting browser source gets its
   * snapshot without replaying the log (§19).
   */
  async putProjection(sessionId: string, seq: number, state: OverlayState): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.sessionState(sessionId), JSON.stringify(state), 'EX', SESSION_TTL_SECONDS)
      .set(KEY.sessionSeq(sessionId), String(seq), 'EX', SESSION_TTL_SECONDS)
      .exec()
  }

  /**
   * Allocates the next broadcast frame number. Contiguous per session, so the
   * overlay can tell a genuinely missed frame from an event that simply had
   * nothing visible to say.
   */
  async nextFrame(sessionId: string): Promise<number> {
    const frame = await this.redis.incr(KEY.sessionFrame(sessionId))
    if (frame === 1) await this.redis.expire(KEY.sessionFrame(sessionId), SESSION_TTL_SECONDS)
    return frame
  }

  async currentFrame(sessionId: string): Promise<number> {
    return Number((await this.redis.get(KEY.sessionFrame(sessionId))) ?? 0)
  }

  async projection(
    sessionId: string,
  ): Promise<{ seq: number; state: OverlayState } | null> {
    const [state, seq] = await this.redis.mget(
      KEY.sessionState(sessionId),
      KEY.sessionSeq(sessionId),
    )
    if (state === null || state === undefined) return null
    return { seq: Number(seq ?? 0), state: JSON.parse(state) as OverlayState }
  }
}

/**
 * Shallow diff between two projections, by top-level key — the patch the
 * overlay merges (§19). Deliberately shallow: a game that wants finer-grained
 * updates should split its projection into more top-level keys rather than
 * having every overlay implement a deep merge.
 */
export function diffProjection(
  before: OverlayState,
  after: OverlayState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    if (!shallowEqual(before[key], value)) patch[key] = value
  }
  // A key that disappeared has to be sent as null, or the overlay keeps showing
  // it forever.
  for (const key of Object.keys(before)) {
    if (!(key in after)) patch[key] = null
  }
  return patch
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  // Projections are plain JSON, so this is both correct and fast enough at the
  // sizes involved (a few KB at most).
  return JSON.stringify(a) === JSON.stringify(b)
}
