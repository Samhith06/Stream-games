/**
 * When the sweep is allowed to end a session.
 *
 * Its own file, and pure, for two reasons: this decision closes somebody's live
 * game, so it has to be testable without standing up a worker; and keeping it
 * free of relative imports lets the tests read it from source rather than from
 * a build that might be a minute behind.
 */

import type { GameSessionRow } from '@streamarena/db'

/**
 * A session left running because the streamer closed the tab keeps a Kick
 * subscription alive, and that is the one thing §6.3 says never to do.
 *
 * The signal is inactivity, not age. Measuring age abandons a live session on a
 * marathon stream mid-hunt — the worst possible failure, because it happens
 * precisely when the streamer is most engaged and has the most on screen. Two
 * thresholds, because two different things are being cleaned up:
 *
 *   - A session that never saw a single event is a misclick or an abandoned
 *     setup screen. Nothing is lost by closing it, so close it soon.
 *   - A session with activity is somebody's actual game. It gets a long leash
 *     from its LAST event, so a stream that runs all day is never touched.
 */
const IDLE_AFTER_MS = 45 * 60 * 1000
const SILENT_AFTER_MS = 12 * 60 * 60 * 1000

/**
 * Phases where a long gap is normal rather than a sign of abandonment.
 *
 * Bonus Hunt's `opening` phase is the streamer sitting on a pile of bonuses,
 * and the gap between banking the last one and opening the first is however
 * long they want it to be. Sweeping there would end the session at the exact
 * moment the payoff starts.
 */
const PATIENT_PHASES = new Set(['opening'])

export type SweepVerdict =
  | { sweep: false; reason: 'patient-phase' | 'still-active' }
  | { sweep: true; reason: 'no-activity-at-all' | 'silent-since-last-event'; idleMs: number }

/**
 * Whether one session has gone quiet enough to close.
 *
 * Pure and exported so the thresholds can be tested directly. This decision
 * ends somebody's live session — the cost of getting it wrong is a stream
 * losing its game mid-hunt, and that is not something to leave to a number
 * nobody ever asserted on.
 */
export function sweepVerdict(
  session: Pick<GameSessionRow, 'phase' | 'startedAt' | 'createdAt'>,
  lastActivityAt: Date | undefined,
  now: number,
): SweepVerdict {
  if (session.phase && PATIENT_PHASES.has(session.phase)) {
    return { sweep: false, reason: 'patient-phase' }
  }

  const since = (lastActivityAt ?? session.startedAt ?? session.createdAt).getTime()
  const idleMs = now - since
  const budget = lastActivityAt ? SILENT_AFTER_MS : IDLE_AFTER_MS

  if (idleMs < budget) return { sweep: false, reason: 'still-active' }
  return {
    sweep: true,
    reason: lastActivityAt ? 'silent-since-last-event' : 'no-activity-at-all',
    idleMs,
  }
}

