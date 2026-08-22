/**
 * Bracket construction and match resolution — §14.
 *
 * Everything here is pure and seeded. "A replay that produces a different
 * champion is worse than no replay at all" (§9), so the draw, the seeding and
 * the coin-flip tiebreak all derive from the session seed plus a fixed label.
 */

import { bracketShape, round2, seedOrder, type Rng } from '@streamarena/core'
import type { DecidedBy, Entrant, Match, MatchSide, Round } from './types.js'

export { bracketShape }

export function matchId(roundIndex: number, matchIndex: number): string {
  return `r${roundIndex}m${matchIndex}`
}

/**
 * Assign seed numbers by seeded shuffle rather than by draw order.
 *
 * §14 puts reserved picks first in the draw so they're visibly hand-chosen. If
 * seeding then followed draw order, the standard bracket would hand every bye
 * to a reserved pick — turning an act of generosity into an apparent rig. The
 * shuffle keeps byes independent of how a seat was won.
 */
export function assignSeeds<T extends { seedNumber: number }>(entrants: T[], rng: Rng): T[] {
  const order = rng.shuffle(entrants.map((_, i) => i + 1))
  return entrants.map((e, i) => ({ ...e, seedNumber: order[i]! }))
}

/**
 * Standard single-elimination bracket. Seeds above the entrant count don't
 * exist, so their opponents draw a BYE — marked explicitly, because an
 * unexplained gap reads as a bug (§14).
 */
export function buildBracket(entrants: readonly Entrant[]): {
  rounds: Round[]
  entrants: Entrant[]
} {
  const shape = bracketShape(entrants.length)
  const order = seedOrder(shape.bracketSize)
  const bySeed = new Map(entrants.map((e) => [e.seedNumber, e]))

  const firstRound: Match[] = []
  for (let i = 0; i < order.length; i += 2) {
    const seedA = order[i]!
    const seedB = order[i + 1]!
    const a = bySeed.get(seedA) ?? bySeed.get(seedB) ?? null
    const other = (bySeed.get(seedA) ? bySeed.get(seedB) : null) ?? null
    const matchIndex = firstRound.length

    firstRound.push({
      id: matchId(0, matchIndex),
      roundIndex: 0,
      matchIndex,
      a: a ? sideOf(a) : null,
      b: other ? sideOf(other) : a ? 'bye' : null,
      winner: a && !other ? 'a' : null,
      decidedBy: a && !other ? 'bye' : null,
      votes: {},
      voterNames: {},
      votingEndsAt: null,
      status: a && !other ? 'decided' : 'pending',
    })
  }

  const rounds: Round[] = [{ roundIndex: 0, matches: firstRound }]
  let width = firstRound.length
  let roundIndex = 1
  while (width > 1) {
    width = Math.floor(width / 2)
    rounds.push({
      roundIndex,
      matches: Array.from({ length: width }, (_, matchIndex) => ({
        id: matchId(roundIndex, matchIndex),
        roundIndex,
        matchIndex,
        a: null,
        b: null,
        winner: null,
        decidedBy: null,
        votes: {},
        voterNames: {},
        votingEndsAt: null,
        status: 'pending' as const,
      })),
    })
    roundIndex++
  }

  // Byes resolved at build time propagate straight into round two.
  const withByes = rounds.map((r) => ({ ...r, matches: r.matches.slice() }))
  for (const match of withByes[0]!.matches) {
    if (match.decidedBy === 'bye' && match.a) {
      placeWinner(withByes, match, match.a)
    }
  }

  const byeIds = new Set(
    withByes[0]!.matches.filter((m) => m.decidedBy === 'bye').map((m) => m.a?.entrantId),
  )

  return {
    rounds: withByes,
    entrants: entrants.map((e) => ({ ...e, hasBye: byeIds.has(e.id) })),
  }
}

export function sideOf(entrant: Entrant): MatchSide {
  return {
    entrantId: entrant.id,
    // §20 — "Username above slot name, everywhere in the tournament. The viewer
    // is the contender; the slot is what they brought."
    username: entrant.username,
    slotName: entrant.slotName,
    buyCost: null,
    payout: null,
    multiplier: null,
  }
}

/** Writes the winner into the correct slot of the next round's match. */
export function placeWinner(rounds: Round[], match: Match, side: MatchSide): void {
  const next = rounds[match.roundIndex + 1]
  if (!next) return
  const target = next.matches[Math.floor(match.matchIndex / 2)]
  if (!target) return
  const carried: MatchSide = { ...side, buyCost: null, payout: null, multiplier: null }
  if (match.matchIndex % 2 === 0) target.a = carried
  else target.b = carried
}

export interface ResolutionInput {
  aBuyCost: number
  aPayout: number
  bBuyCost: number
  bPayout: number
}

export interface Resolution {
  winner: 'a' | 'b'
  decidedBy: DecidedBy
  aMultiplier: number
  bMultiplier: number
}

/**
 * §14 tiebreak ladder. Ties are common — two dead bonuses both paying zero is
 * frequent, and resolves all the way down to the coin flip.
 *
 *   1. Higher multiplier (payout / buy cost)
 *   2. Higher raw payout
 *   3. Lower buy cost — better value for the same return
 *   4. Seeded coin flip, from the session seed plus the match id
 */
export function resolveMatch(input: ResolutionInput, coinFlip: () => boolean): Resolution {
  const aMultiplier = round2(input.aPayout / input.aBuyCost)
  const bMultiplier = round2(input.bPayout / input.bBuyCost)

  if (aMultiplier !== bMultiplier) {
    return {
      winner: aMultiplier > bMultiplier ? 'a' : 'b',
      decidedBy: 'multiplier',
      aMultiplier,
      bMultiplier,
    }
  }

  if (input.aPayout !== input.bPayout) {
    return {
      winner: input.aPayout > input.bPayout ? 'a' : 'b',
      decidedBy: 'payout',
      aMultiplier,
      bMultiplier,
    }
  }

  if (input.aBuyCost !== input.bBuyCost) {
    return {
      winner: input.aBuyCost < input.bBuyCost ? 'a' : 'b',
      decidedBy: 'cost',
      aMultiplier,
      bMultiplier,
    }
  }

  return { winner: coinFlip() ? 'a' : 'b', decidedBy: 'coinflip', aMultiplier, bMultiplier }
}

/** §14 — "buy cost must exceed zero. Payout of zero is valid and common." */
export function validateResult(buyCost: number, payout: number): string | null {
  if (!Number.isFinite(buyCost) || buyCost <= 0) return 'Buy cost must be greater than zero.'
  if (!Number.isFinite(payout) || payout < 0) return 'Payout must be zero or more.'
  return null
}

export function findMatch(rounds: readonly Round[], id: string): Match | undefined {
  for (const round of rounds) {
    const found = round.matches.find((m) => m.id === id)
    if (found) return found
  }
  return undefined
}

/** The next real match awaiting play, in bracket order. Byes are already done. */
export function nextPlayable(rounds: readonly Round[]): Match | null {
  for (const round of rounds) {
    for (const match of round.matches) {
      if (match.winner !== null) continue
      if (match.a && match.b && match.b !== 'bye') return match
    }
  }
  return null
}

export function finalMatch(rounds: readonly Round[]): Match | undefined {
  return rounds.at(-1)?.matches[0]
}

/** Deep clone so the reducer never mutates the state it was handed. */
export function cloneRounds(rounds: readonly Round[]): Round[] {
  return rounds.map((r) => ({
    roundIndex: r.roundIndex,
    matches: r.matches.map((m) => ({
      ...m,
      a: m.a ? { ...m.a } : m.a,
      b: m.b && m.b !== 'bye' ? { ...m.b } : m.b,
      votes: { ...m.votes },
      voterNames: { ...m.voterNames },
    })),
  }))
}

/**
 * §14 — "Match reverted: votes restored, scores recalculated from the event
 * log." Rather than incrementally undoing, scores are always rebuilt from the
 * decided matches, so a revert can never leave a stale tally behind.
 */
export function recomputeScores(
  rounds: readonly Round[],
  firstSeen: Record<string, number>,
): Record<string, { username: string; correct: number; total: number; firstSeenSeq: number }> {
  const scores: Record<
    string,
    { username: string; correct: number; total: number; firstSeenSeq: number }
  > = {}

  for (const round of rounds) {
    for (const match of round.matches) {
      if (match.winner === null || match.decidedBy === 'bye') continue
      for (const [userId, choice] of Object.entries(match.votes)) {
        const prev = scores[userId]
        scores[userId] = {
          username: match.voterNames[userId] ?? prev?.username ?? userId,
          correct: (prev?.correct ?? 0) + (choice === match.winner ? 1 : 0),
          total: (prev?.total ?? 0) + 1,
          firstSeenSeq: firstSeen[userId] ?? 0,
        }
      }
    }
  }

  return scores
}
