/**
 * Steps 6-8 of the pipeline (§10): reduce, commit, execute.
 *
 *   6. REDUCE   game.reduce(state, event, ctx) -> { state, effects }
 *   7. COMMIT   append to session_events, write projection to Redis
 *               the log is the source of truth
 *   8. EXECUTE  chat / broadcast / timer / lookup
 *
 * Crash-safety comes from doing these in this order. If the worker dies between
 * 7 and 8, the next worker replays the log and re-derives the state; the only
 * cost is an effect that never fired, which is why announcements are allowed to
 * fail silently (§15.5) and why the overlay is always re-synced from the
 * projection rather than from a stream of patches alone.
 */

import {
  GameEngine,
  shouldSnapshot,
  type Effect,
  type InternalEvent,
} from '@streamarena/core'
import { toInternalEvent } from '@streamarena/db'
import { diffProjection, type SessionMeta } from '@streamarena/platform'
import type { WorkerContext } from './context.js'
import { executeEffects } from './effect-executor.js'
import { withSessionLock } from './session-lock.js'

/**
 * An event ready to fold, minus the sequence the log will assign it.
 *
 * Omit must distribute over the union — a plain `Omit<InternalEvent, 'seq'>`
 * collapses to the keys every member shares, which would silently discard
 * `command`, `actor` and everything else that makes an event useful.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type PendingEvent = DistributiveOmit<InternalEvent, 'seq'>

export interface ApplyResult {
  applied: boolean
  seq: number
  phase: string | null
}

/**
 * Fold one event into a session and run whatever it asks for.
 *
 * Serialised per session by a Redis lock. The database's row lock already makes
 * sequence allocation safe, but without this lock two workers could both read
 * the same state, reduce independently, and each write a valid-looking event
 * that ignores the other's effect.
 */
export async function applyEvent(
  ctx: WorkerContext,
  meta: SessionMeta,
  event: PendingEvent,
  opts: { kickMessageId?: string | null } = {},
): Promise<ApplyResult> {
  return withSessionLock(ctx.redis, meta.sessionId, async () => {
    const engine = buildEngine(ctx, meta)

    // ── 7a. Append first, so the sequence is assigned by the log ──────────
    const { seq, appended } = await ctx.repos.events.append({
      sessionId: meta.sessionId,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
      kickMessageId: opts.kickMessageId ?? null,
    })

    // A redelivered webhook. Kick retried; we already folded this exact
    // message. Doing nothing is the whole point of the unique index (§11).
    if (!appended) {
      ctx.log.debug({ sessionId: meta.sessionId, seq }, 'duplicate event ignored')
      return { applied: false, seq, phase: null }
    }

    // Everything strictly before the event we just appended.
    const before = await loadState(ctx, meta, engine, seq)

    // ── 6. Reduce ─────────────────────────────────────────────────────────
    const sequenced = { ...event, seq } as InternalEvent
    const folded = engine.apply(before.state, sequenced)

    // ── 7b. Projection to Redis, so a reconnecting overlay can be answered
    //        without replaying the log ────────────────────────────────────
    const beforeProjection = engine.project(before.state)
    const afterProjection = engine.project(folded.state)
    await ctx.cache.putProjection(meta.sessionId, seq, afterProjection)

    if (shouldSnapshot(seq, ctx.env.SNAPSHOT_EVERY_N_EVENTS)) {
      await ctx.repos.events.writeSnapshot({
        sessionId: meta.sessionId,
        seq,
        stateVersion: meta.stateVersion,
        state: folded.state as Record<string, unknown>,
      })
    }

    const phase = engine.phaseOf(folded.state)
    if (phase !== null && phase !== before.phase) {
      await ctx.repos.sessions.setPhase(meta.sessionId, phase)
    }

    // ── 8. Execute ────────────────────────────────────────────────────────
    // The runtime always broadcasts the projection diff; a game only emits an
    // explicit broadcast effect for ephemeral cues that aren't in its state.
    const patch = diffProjection(beforeProjection, afterProjection)

    // The dashboard sees more than the overlay does, and those extra keys change
    // on exactly the events that matter most — a slot the catalog could not
    // match has to reach the unresolved queue without a page reload (§20).
    const dashboardPatch = diffProjection(
      engine.projectDashboard(before.state),
      engine.projectDashboard(folded.state),
    )
    for (const key of Object.keys(patch)) delete dashboardPatch[key]

    const hasUpdate = Object.keys(patch).length > 0 || Object.keys(dashboardPatch).length > 0
    const effects: Effect[] = hasUpdate
      ? [{ kind: 'broadcast', patch, dashboardPatch }, ...folded.effects]
      : folded.effects

    await executeEffects(ctx, meta, { seq, effects, state: folded.state })

    cacheState(meta.sessionId, { state: folded.state, seq, phase })
    return { applied: true, seq, phase }
  })
}

// ─── State loading and replay ───────────────────────────────────────────────

interface CachedState {
  state: unknown
  seq: number
  phase: string | null
}

/**
 * In-process memo of the last state we computed per session. Purely a
 * performance shortcut for the common case where the same worker folds
 * consecutive events; correctness never depends on it, and a miss falls back to
 * snapshot + replay.
 */
const stateMemo = new Map<string, CachedState>()

function cacheState(sessionId: string, entry: CachedState): void {
  stateMemo.set(sessionId, entry)
  // Bounded so a long-running worker across many channels can't grow forever.
  if (stateMemo.size > 200) {
    const oldest = stateMemo.keys().next().value
    if (oldest !== undefined && oldest !== sessionId) stateMemo.delete(oldest)
  }
}

export function forgetSession(sessionId: string): void {
  stateMemo.delete(sessionId)
}

/**
 * §11 — "If Redis is wiped, every session rebuilds from snapshots plus events."
 * This is that path, and it's the same one crash recovery uses: kill the worker
 * mid-hunt and the replacement lands here.
 */
async function loadState(
  ctx: WorkerContext,
  meta: SessionMeta,
  engine: GameEngine<unknown, unknown>,
  /** Fold only events strictly before this sequence. */
  upToSeq = Number.MAX_SAFE_INTEGER,
): Promise<{ state: unknown; seq: number; phase: string | null }> {
  const memo = stateMemo.get(meta.sessionId)
  if (memo && memo.seq < upToSeq) return memo

  const { snapshot, events } = await ctx.repos.events.loadForReplay(meta.sessionId)

  const from = snapshot
    ? {
        state: snapshot.state as unknown,
        seq: Number(snapshot.seq),
        stateVersion: snapshot.stateVersion,
      }
    : undefined

  const internal = events
    // The event we just appended is already in the log; folding it here as
    // well would apply it twice.
    .filter((row) => Number(row.seq) < upToSeq)
    .map(toInternalEvent)

  const replayed = engine.replay(internal, from)

  ctx.log.debug(
    { sessionId: meta.sessionId, fromSnapshot: snapshot !== null, events: internal.length },
    'session state rebuilt from the log',
  )

  return { state: replayed.state, seq: replayed.seq, phase: engine.phaseOf(replayed.state) }
}

export function buildEngine(
  ctx: WorkerContext,
  meta: SessionMeta,
): GameEngine<unknown, unknown> {
  const game = ctx.registry.require(meta.gameId)
  return new GameEngine(game, {
    config: meta.config,
    init: {
      sessionId: meta.sessionId,
      channelId: meta.channelId,
      seed: meta.seed,
      startedAt: meta.startedAt,
      owner: { userId: meta.ownerUserId, username: meta.ownerUsername, role: 'broadcaster' },
    },
  })
}

/** Current projected state for the dashboard and the overlay snapshot. */
export async function currentProjection(
  ctx: WorkerContext,
  meta: SessionMeta,
): Promise<{ seq: number; state: Record<string, unknown> }> {
  const cached = await ctx.cache.projection(meta.sessionId)
  if (cached) return { seq: cached.seq, state: cached.state as Record<string, unknown> }

  const engine = buildEngine(ctx, meta)
  const loaded = await loadState(ctx, meta, engine)
  const projected = engine.project(loaded.state) as Record<string, unknown>
  await ctx.cache.putProjection(meta.sessionId, loaded.seq, projected)
  return { seq: loaded.seq, state: projected }
}
