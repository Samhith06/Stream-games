/**
 * Board geometry — §5, §7.
 *
 * Everything positional lives here: square ids, which lines run through them,
 * the committed pick order and the unlock schedule. All of it is pure and
 * seeded, so a board replays identically from the log.
 */

import type { Rng } from '@streamarena/core'
import type { Line, Square, SquareTier } from './types.js'

export const COLUMNS = 'ABCDE'

/** 'C3' — column letter, row number. Stable, and what chat will say out loud. */
export function squareId(row: number, col: number): string {
  return `${COLUMNS[col]}${row + 1}`
}

/**
 * The lines a board of this size has: every row, every column, both diagonals.
 * 3×3 gives 8 lines, 5×5 gives 12.
 */
export function buildLines(size: number): Line[] {
  const lines: Line[] = []
  const blank = {
    state: 'open' as const,
    totalMultiplier: 0,
    totalPayout: 0,
    totalCost: 0,
    netScore: 0,
    attemptCount: 0,
    greenCount: 0,
  }

  for (let row = 0; row < size; row++) {
    lines.push({
      id: `row${row + 1}`,
      squareIds: Array.from({ length: size }, (_, col) => squareId(row, col)),
      ...blank,
    })
  }
  for (let col = 0; col < size; col++) {
    lines.push({
      id: `col${col + 1}`,
      squareIds: Array.from({ length: size }, (_, row) => squareId(row, col)),
      ...blank,
    })
  }
  lines.push({
    id: 'diagA',
    squareIds: Array.from({ length: size }, (_, i) => squareId(i, i)),
    ...blank,
  })
  lines.push({
    id: 'diagB',
    squareIds: Array.from({ length: size }, (_, i) => squareId(i, size - 1 - i)),
    ...blank,
  })

  return lines
}

/** An empty board. Ownership arrives later, from the draw. */
export function buildSquares(size: number): Square[] {
  const squares: Square[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      squares.push({
        id: squareId(row, col),
        row,
        col,
        userId: null,
        username: null,
        slotId: null,
        slotName: null,
        thumbnail: null,
        owner: 'open',
        source: 'random',
        unlockAfterPick: null,
        claimedAtSeq: null,
        attempts: [],
        history: [],
        livesLeft: null,
        status: 'unplayed',
        tier: null,
        manualPick: false,
      })
    }
  }
  return squares
}

/**
 * How many lines run through a square.
 *
 * §5.1 — on a 5×5 the centre sits on four lines and an edge square on two, a
 * 2× spread in win odds decided purely by where you land. The overlay shows
 * this at claim time: an advantage that is visible reads as luck, one that is
 * hidden reads as rigging.
 */
export function lineCountFor(square: Square, size: number): number {
  let count = 2 // its row and its column, always
  if (square.row === square.col) count++
  if (square.row + square.col === size - 1) count++
  return count
}

/**
 * Pick numbers at which each held-back square opens — §5.3.
 *
 * Spread across the board rather than all at the start: if they all opened when
 * the draw ended, the three fastest typists would take them and the viewer who
 * arrives at hour two is exactly where they started.
 *
 * `expectedPicks` rather than the square count, because retries lengthen the
 * board and fixed pick numbers would land every unlock in the first third of a
 * session that runs twice as long.
 */
export function unlockSchedule(openSquares: number, expectedPicks: number): number[] {
  if (openSquares <= 0) return []
  return Array.from({ length: openSquares }, (_, i) =>
    Math.round(((i + 1) * expectedPicks) / (openSquares + 1)),
  )
}

/**
 * The order squares will be played in, committed once at draw time (§5.1).
 *
 * Two properties this has to hold:
 *
 *   1. Seeded and stored, never re-rolled. "You picked that square on purpose"
 *      becomes answerable with a fact rather than a promise.
 *   2. A held-back square must appear strictly *after* the pick that unlocks
 *      it — otherwise you unlock C3 at pick 18 having played it at pick 5. Open
 *      squares are placed into their eligible window first and the rest are
 *      shuffled into what is left.
 */
export function commitPickOrder(
  squares: readonly Square[],
  openIds: readonly string[],
  schedule: readonly number[],
  rng: Rng,
): string[] {
  const total = squares.length
  const slots: (string | null)[] = Array.from({ length: total }, () => null)
  const placed = new Set<string>()

  // Held-back squares first, each into a free position after its unlock pick.
  openIds.forEach((id, index) => {
    const unlockAfter = schedule[index] ?? 0
    const eligible: number[] = []
    for (let position = unlockAfter; position < total; position++) {
      if (slots[position] === null) eligible.push(position)
    }
    // No room left after the unlock point — take the last free position rather
    // than dropping the square. Only reachable on a tiny board.
    const chosen =
      eligible.length > 0 ? eligible[rng.int(eligible.length)]! : slots.lastIndexOf(null)

    slots[chosen] = id
    placed.add(id)
  })

  const rest = rng.shuffle(squares.filter((s) => !placed.has(s.id)).map((s) => s.id))

  let cursor = 0
  for (let position = 0; position < total; position++) {
    if (slots[position] === null) slots[position] = rest[cursor++]!
  }

  return slots as string[]
}

/** §6 — red below the green threshold, gold at or above the big-win one. */
export function tierFor(
  multiplier: number,
  greenThresholdX: number,
  bigWinThresholdX: number,
): SquareTier {
  if (multiplier >= bigWinThresholdX) return 'gold'
  return multiplier >= greenThresholdX ? 'green' : 'red'
}
