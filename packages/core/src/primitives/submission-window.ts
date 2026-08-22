/**
 * Timed submission window — §16.1.
 *
 * "slot requests, guesses, tournament joins, match votes. Open a window, one
 * submission per viewer, editable until lock, countdown on overlay, lock,
 * resolve. One component, four uses."
 *
 * Pure data + pure transitions. The countdown is expressed as an absolute
 * `endsAt` derived from event time, so a replay lands on the same instant.
 */

export type WindowStatus = 'idle' | 'open' | 'locked'

export interface SubmissionWindow<T> {
  status: WindowStatus
  /** Absolute ms timestamp, or null for a manually-closed window. */
  endsAt: number | null
  /** Keyed by userId — one submission per viewer, last write wins. */
  submissions: Record<string, Submission<T>>
  /** Sequence at lock, so downstream scoring can be ordered deterministically. */
  lockedAtSeq: number | null
}

export interface Submission<T> {
  userId: string
  username: string
  value: T
  /** Sequence, not wall clock — the tiebreak input for "earliest wins". */
  submittedAtSeq: number
  submittedAt: number
}

export function emptyWindow<T>(): SubmissionWindow<T> {
  return { status: 'idle', endsAt: null, submissions: {}, lockedAtSeq: null }
}

export function openWindow<T>(
  w: SubmissionWindow<T>,
  opts: { now: number; durationMs: number | null },
): SubmissionWindow<T> {
  return {
    ...w,
    status: 'open',
    endsAt: opts.durationMs === null ? null : opts.now + opts.durationMs,
    lockedAtSeq: null,
  }
}

export type SubmitOutcome = 'accepted' | 'replaced' | 'closed'

export interface SubmitResult<T> {
  window: SubmissionWindow<T>
  outcome: SubmitOutcome
}

/**
 * Editable until lock: a second submission from the same viewer silently
 * replaces the first and reports `replaced` so callers can vary the ack.
 */
export function submit<T>(
  w: SubmissionWindow<T>,
  entry: Omit<Submission<T>, 'value'> & { value: T },
): SubmitResult<T> {
  if (w.status !== 'open') return { window: w, outcome: 'closed' }
  const existed = w.submissions[entry.userId] !== undefined
  return {
    window: { ...w, submissions: { ...w.submissions, [entry.userId]: entry } },
    outcome: existed ? 'replaced' : 'accepted',
  }
}

export function withdraw<T>(w: SubmissionWindow<T>, userId: string): SubmissionWindow<T> {
  if (w.submissions[userId] === undefined) return w
  const next = { ...w.submissions }
  delete next[userId]
  return { ...w, submissions: next }
}

export function lockWindow<T>(w: SubmissionWindow<T>, seq: number): SubmissionWindow<T> {
  if (w.status === 'locked') return w
  return { ...w, status: 'locked', endsAt: null, lockedAtSeq: seq }
}

export function isExpired<T>(w: SubmissionWindow<T>, now: number): boolean {
  return w.status === 'open' && w.endsAt !== null && now >= w.endsAt
}

export function count<T>(w: SubmissionWindow<T>): number {
  return Object.keys(w.submissions).length
}

/** Submissions in the order they were made — the canonical iteration order. */
export function ordered<T>(w: SubmissionWindow<T>): Submission<T>[] {
  return Object.values(w.submissions).sort((a, b) => a.submittedAtSeq - b.submittedAtSeq)
}

export function remainingMs<T>(w: SubmissionWindow<T>, now: number): number | null {
  if (w.status !== 'open' || w.endsAt === null) return null
  return Math.max(0, w.endsAt - now)
}
