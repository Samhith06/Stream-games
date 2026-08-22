/**
 * Closest-value resolution — §16.3.
 *
 * "absolute difference, earliest-submission tiebreak. Guess the Balance now;
 * guess-the-multiplier later."
 *
 * §13 winner rule: closest in either direction; ties go to the earliest guess —
 * deterministic, needs no randomness, and rewards committing early.
 */

export interface ClosestCandidate {
  userId: string
  username: string
  amount: number
  submittedAtSeq: number
}

export interface ClosestResult<T extends ClosestCandidate> {
  winner: T
  difference: number
  /** Every candidate ranked, nearest first — feeds the live leaderboard. */
  ranked: { candidate: T; difference: number }[]
}

export function closestTo<T extends ClosestCandidate>(
  target: number,
  candidates: readonly T[],
): ClosestResult<T> | null {
  if (candidates.length === 0) return null

  const ranked = candidates
    .map((candidate) => ({ candidate, difference: Math.abs(candidate.amount - target) }))
    .sort((a, b) =>
      a.difference !== b.difference
        ? a.difference - b.difference
        : a.candidate.submittedAtSeq - b.candidate.submittedAtSeq,
    )

  const top = ranked[0]!
  return { winner: top.candidate, difference: top.difference, ranked }
}

/**
 * §20 — "The guess leaderboard during opening": the five guesses currently
 * closest to the running total. The streamer's narration fuel for the whole
 * opening phase, so it recomputes on every win entered.
 */
export function leaderboard<T extends ClosestCandidate>(
  runningTotal: number,
  candidates: readonly T[],
  limit = 5,
): { candidate: T; difference: number }[] {
  return closestTo(runningTotal, candidates)?.ranked.slice(0, limit) ?? []
}
