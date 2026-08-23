/**
 * Line arithmetic and resolution — §7, §8.
 *
 * Recomputed from the squares after every result, never patched incrementally.
 * §9 makes that a requirement rather than a preference: a mistyped payout does
 * not flip one square, it can resurrect or kill four lines at once, and undoing
 * that by hand is how a board ends up in a state nobody can explain on stream.
 */

import { round2 } from '@streamarena/core'
import type { BingoState, DecidedBy, Line, Square } from './types.js'

/** A square that will never be green. With retries off, any red is permanent. */
function isPermanentRed(square: Square): boolean {
  return square.status === 'settled' && square.tier === 'red'
}

/** Green or gold — gold is a louder green, cosmetic to the rules (§6). */
function isGreen(square: Square): boolean {
  return square.status === 'settled' && (square.tier === 'green' || square.tier === 'gold')
}

/**
 * Every line's state and score, from the board as it stands.
 *
 * The free centre counts as a settled green nobody owns, which is the whole
 * point of the toggle: the four lines through it then need four greens, not
 * five (§7).
 */
export function recomputeLines(state: BingoState): Line[] {
  const byId = new Map(state.squares.map((s) => [s.id, s]))

  return state.lines.map((line) => {
    const squares = line.squareIds.map((id) => byId.get(id)!).filter(Boolean)

    let totalMultiplier = 0
    let totalPayout = 0
    let totalCost = 0
    let attemptCount = 0
    let greenCount = 0
    let settled = 0
    let dead = false

    for (const square of squares) {
      // Every attempt counts toward the ledger, reds included — that is what
      // keeps a red weighing a line down rather than vanishing from it (§8).
      for (const attempt of square.attempts) {
        totalPayout += attempt.payout
        totalCost += attempt.buyCost
        attemptCount++
      }

      if (isPermanentRed(square)) dead = true
      if (isGreen(square)) {
        greenCount++
        // Score on the settling attempt: the multiplier the square finished on.
        const settling = square.attempts[square.attempts.length - 1]
        totalMultiplier += settling?.multiplier ?? 0
      }
      if (square.status === 'settled') settled++
    }

    const remaining = squares.length - settled
    const lineState: Line['state'] = dead
      ? 'dead'
      : remaining === 0
        ? 'complete'
        : remaining === 1
          ? 'oneAway'
          : 'open'

    return {
      ...line,
      state: lineState,
      totalMultiplier: round2(totalMultiplier),
      totalPayout: round2(totalPayout),
      totalCost: round2(totalCost),
      netScore: round2(totalPayout - totalCost),
      attemptCount,
      greenCount,
    }
  })
}

/**
 * Lines that just completed — an instant bingo (§8).
 *
 * Returns all of them: if one square completes two lines at once, both are
 * announced and everyone on either wins. Picking one would be arbitrary and
 * would read, correctly, as the software choosing a favourite.
 */
export function completedLines(lines: readonly Line[]): Line[] {
  return lines.filter((line) => line.state === 'complete')
}

/**
 * Best line, by the tiebreak ladder in §8.
 *
 * `eligible` is what changes between a full board and a settle-early: a settle
 * only considers lines whose squares have all been played, because a line
 * holding an unplayed square has not earned anything yet.
 */
export function bestLine(
  lines: readonly Line[],
  seedFlip: (lineId: string) => number,
): { line: Line; decidedBy: DecidedBy } | null {
  if (lines.length === 0) return null

  const ranked = lines.slice().sort((a, b) => {
    // 1. Highest combined multiplier. (With retries on this becomes netScore —
    //    see §8; the default board scores on multiplier.)
    if (b.totalMultiplier !== a.totalMultiplier) return b.totalMultiplier - a.totalMultiplier
    // 2. Higher combined payout.
    if (b.totalPayout !== a.totalPayout) return b.totalPayout - a.totalPayout
    // 3. More green squares.
    if (b.greenCount !== a.greenCount) return b.greenCount - a.greenCount
    // 4. Lower combined buy cost — the line that got there cheapest.
    if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost
    // 5. Seeded coin flip. Deterministic, so a replay picks the same winner.
    return seedFlip(a.id) - seedFlip(b.id)
  })

  const winner = ranked[0]!
  const runnerUp = ranked[1]

  // Naming *which* rung decided it is not decoration: §8 requires the board to
  // say how it was decided, because an unexplained winning line reads as broken
  // software.
  let decidedBy: DecidedBy = 'bestLine'
  if (runnerUp) {
    if (winner.totalMultiplier === runnerUp.totalMultiplier) {
      decidedBy =
        winner.totalPayout !== runnerUp.totalPayout
          ? 'payout'
          : winner.greenCount !== runnerUp.greenCount
            ? 'greenCount'
            : winner.totalCost !== runnerUp.totalCost
              ? 'cost'
              : 'coinflip'
    }
  }

  return { line: winner, decidedBy }
}

/** Lines every square of which has been played — the settle-early filter (§8). */
export function fullyPlayedLines(state: BingoState, lines: readonly Line[]): Line[] {
  const byId = new Map(state.squares.map((s) => [s.id, s]))
  return lines.filter((line) =>
    line.squareIds.every((id) => byId.get(id)?.status === 'settled'),
  )
}

/**
 * Who wins a line.
 *
 * House and free squares play and colour normally and count toward lines, but
 * they win nothing (§5.4) — so a winning line containing them pays only the
 * viewers on it.
 */
export function winnersOf(state: BingoState, lineIds: readonly string[]) {
  const byId = new Map(state.squares.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const winners = []

  for (const lineId of lineIds) {
    const line = state.lines.find((l) => l.id === lineId)
    if (!line) continue

    for (const squareId of line.squareIds) {
      const square = byId.get(squareId)
      if (!square || square.owner !== 'viewer' || !square.userId) continue
      if (seen.has(square.userId)) continue

      seen.add(square.userId)
      winners.push({
        userId: square.userId,
        username: square.username ?? '',
        slotName: square.slotName,
        squareId: square.id,
      })
    }
  }

  return winners
}

/** Lines still capable of winning — the "lines alive" tension meter (§7). */
export const aliveLines = (lines: readonly Line[]): Line[] =>
  lines.filter((line) => line.state !== 'dead')
