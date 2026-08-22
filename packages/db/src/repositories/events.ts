/**
 * The event log — §10 step 7, §11.
 *
 * "append to session_events (Postgres) / write projection to Redis / the log is
 * the source of truth."
 *
 * Two invariants this file exists to hold:
 *
 *   1. Sequence numbers are gapless and allocated under a row lock, so two
 *      workers folding the same session can never both claim seq N.
 *   2. A redelivered webhook is a no-op. Kick retries; the unique index on
 *      (session_id, kick_message_id) makes that safe, and we return the event
 *      that already exists rather than raising.
 */

import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import type { InternalEvent } from '@streamarena/core'
import type { Database } from '../client.js'
import { gameSessions, sessionEvents, sessionSnapshots } from '../schema.js'
import type { SessionEventRow, SessionSnapshotRow } from '../schema.js'

const UNIQUE_VIOLATION = '23505'

export interface AppendInput {
  sessionId: string
  type: string
  payload: Record<string, unknown>
  kickMessageId?: string | null
}

export interface AppendResult {
  seq: number
  /** False when this exact Kick message had already been folded in. */
  appended: boolean
}

export class EventRepository {
  constructor(private readonly db: Database) {}

  /**
   * Allocate a sequence and append, atomically.
   *
   * The `FOR UPDATE` on the session row is what serialises concurrent appends.
   * It's a per-session lock, so channels never contend with each other.
   */
  async append(input: AppendInput): Promise<AppendResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ lastSeq: gameSessions.lastSeq })
          .from(gameSessions)
          .where(eq(gameSessions.id, input.sessionId))
          .for('update')
          .limit(1)

        if (!locked) throw new SessionNotFoundError(input.sessionId)

        const seq = Number(locked.lastSeq) + 1

        await tx.insert(sessionEvents).values({
          sessionId: input.sessionId,
          seq,
          type: input.type,
          payload: input.payload,
          kickMessageId: input.kickMessageId ?? null,
        })

        await tx
          .update(gameSessions)
          .set({ lastSeq: seq })
          .where(eq(gameSessions.id, input.sessionId))

        return { seq, appended: true }
      })
    } catch (err) {
      // Redelivery. Find what we already stored and report its sequence, so the
      // caller can decide whether it still needs to broadcast.
      if (isUniqueViolation(err) && input.kickMessageId) {
        const existing = await this.byKickMessageId(input.sessionId, input.kickMessageId)
        if (existing) return { seq: Number(existing.seq), appended: false }
      }
      throw err
    }
  }

  async byKickMessageId(sessionId: string, kickMessageId: string): Promise<SessionEventRow | null> {
    const [row] = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.kickMessageId, kickMessageId)),
      )
      .limit(1)
    return row ?? null
  }

  /** Replay input: everything after a snapshot, in order. */
  async since(sessionId: string, afterSeq: number, limit = 10_000): Promise<SessionEventRow[]> {
    return this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, afterSeq)))
      .orderBy(asc(sessionEvents.seq))
      .limit(limit)
  }

  async count(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
    return row?.n ?? 0
  }

  async latestSnapshot(sessionId: string): Promise<SessionSnapshotRow | null> {
    const [row] = await this.db
      .select()
      .from(sessionSnapshots)
      .where(eq(sessionSnapshots.sessionId, sessionId))
      .orderBy(desc(sessionSnapshots.seq))
      .limit(1)
    return row ?? null
  }

  async writeSnapshot(input: {
    sessionId: string
    seq: number
    stateVersion: number
    state: Record<string, unknown>
  }): Promise<void> {
    await this.db.insert(sessionSnapshots).values(input).onConflictDoNothing()
  }

  /**
   * Rehydrate everything a replay needs in one call. Returns the snapshot to
   * start from (or null for a from-scratch replay) plus the tail of the log.
   */
  async loadForReplay(
    sessionId: string,
  ): Promise<{ snapshot: SessionSnapshotRow | null; events: SessionEventRow[] }> {
    const snapshot = await this.latestSnapshot(sessionId)
    const events = await this.since(sessionId, snapshot ? Number(snapshot.seq) : 0)
    return { snapshot, events }
  }
}

/** Rows come back as JSON; this restores the InternalEvent shape reduce() wants. */
export function toInternalEvent(row: SessionEventRow): InternalEvent {
  return { ...(row.payload as object), seq: Number(row.seq) } as InternalEvent
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} not found`)
    this.name = 'SessionNotFoundError'
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION
}
