/**
 * Prediction scoring — §16.5.
 *
 * "per-viewer correct/total, leaderboard with tiebreaks, top-scorer
 * announcement." §14: +1 per correct pick; leaderboard ties break on accuracy
 * percentage, then earliest join.
 */

export interface Score {
  username: string
  correct: number
  total: number
  /** Sequence at which this viewer first participated — the final tiebreak. */
  firstSeenSeq: number
}

export type Scores = Record<string, Score>

export function recordPredictions(
  scores: Scores,
  votes: Record<string, string>,
  winningChoice: string,
  voterNames: Record<string, string>,
  seq: number,
): Scores {
  const next: Scores = { ...scores }
  for (const [userId, choice] of Object.entries(votes)) {
    const prev = next[userId]
    const username = voterNames[userId] ?? prev?.username ?? userId
    next[userId] = {
      username,
      correct: (prev?.correct ?? 0) + (choice === winningChoice ? 1 : 0),
      total: (prev?.total ?? 0) + 1,
      firstSeenSeq: prev?.firstSeenSeq ?? seq,
    }
  }
  return next
}

export interface RankedScore extends Score {
  userId: string
  accuracy: number
  rank: number
}

export function rankScores(scores: Scores): RankedScore[] {
  return Object.entries(scores)
    .map(([userId, s]) => ({
      ...s,
      userId,
      accuracy: s.total === 0 ? 0 : s.correct / s.total,
      rank: 0,
    }))
    .sort((a, b) => {
      if (a.correct !== b.correct) return b.correct - a.correct
      if (a.accuracy !== b.accuracy) return b.accuracy - a.accuracy
      return a.firstSeenSeq - b.firstSeenSeq
    })
    .map((s, i) => ({ ...s, rank: i + 1 }))
}

export function topPredictor(scores: Scores): RankedScore | null {
  const ranked = rankScores(scores)
  const top = ranked[0]
  // Nobody voted on any match — skip the announcement rather than showing a
  // winner card with a zero in it (§14 edge cases).
  if (!top || top.total === 0) return null
  return top
}

/** Live A/B split for the overlay — §14. Watching it swing is the entertainment. */
export function voteSplit(votes: Record<string, string>): {
  a: number
  b: number
  total: number
  aPct: number
  bPct: number
} {
  let a = 0
  let b = 0
  for (const v of Object.values(votes)) {
    if (v === 'a') a++
    else if (v === 'b') b++
  }
  const total = a + b
  return {
    a,
    b,
    total,
    aPct: total === 0 ? 50 : Math.round((a / total) * 100),
    bPct: total === 0 ? 50 : 100 - Math.round((a / total) * 100),
  }
}
