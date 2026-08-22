/**
 * Entry pool and seeded draw — §16.2.
 *
 * "collect an uncapped pool, let the streamer reserve seats, fill the rest by
 * seeded draw, animate the reveal. Giveaways are the same mechanic with a
 * different prize, so this makes that future game nearly free."
 *
 * §14: reserved seats are filled BEFORE the random draw and labelled openly.
 * The draw runs once and cannot be re-rolled — the fairness of this game is the
 * product.
 */

import type { Rng } from './rng.js'

export interface PoolMember {
  userId: string
  joinedAtSeq: number
}

export interface DrawnSeat<T extends PoolMember> {
  member: T
  source: 'reserved' | 'random'
  /** 1-based seat number, in draw order. Reserved seats come first. */
  seedNumber: number
}

export interface DrawResult<T extends PoolMember> {
  seats: DrawnSeat<T>[]
  /** Everyone who joined but missed out. Kept for "replace this seat". */
  unpicked: T[]
  /** Fewer joiners than seats — the caller offers the next size down (§14). */
  underfilled: boolean
}

export function drawSeats<T extends PoolMember>(
  pool: readonly T[],
  opts: { seats: number; reservedUserIds: readonly string[]; rng: Rng },
): DrawResult<T> {
  const { seats, reservedUserIds, rng } = opts

  // Deterministic base order. The pool arrives keyed by userId in some maps, so
  // never trust insertion order — sort by join sequence explicitly.
  const byJoin = pool.slice().sort((a, b) => a.joinedAtSeq - b.joinedAtSeq)

  const reservedSet = new Set(reservedUserIds)
  const reserved = byJoin.filter((m) => reservedSet.has(m.userId)).slice(0, seats)
  const rest = byJoin.filter((m) => !reservedSet.has(m.userId))

  const randomCount = Math.max(0, seats - reserved.length)
  const drawn = rng.shuffle(rest).slice(0, randomCount)
  const drawnIds = new Set(drawn.map((m) => m.userId))

  const result: DrawnSeat<T>[] = [
    ...reserved.map((member, i) => ({ member, source: 'reserved' as const, seedNumber: i + 1 })),
    ...drawn.map((member, i) => ({
      member,
      source: 'random' as const,
      seedNumber: reserved.length + i + 1,
    })),
  ]

  return {
    seats: result,
    unpicked: rest.filter((m) => !drawnIds.has(m.userId)),
    underfilled: result.length < seats,
  }
}

/**
 * §14 bracket structure.
 *
 *   seats 8  -> bracket 8,  0 byes, 3 rounds,  7 matches
 *   seats 12 -> bracket 16, 4 byes, 4 rounds, 11 matches
 *   seats 16 -> bracket 16, 0 byes, 4 rounds, 15 matches
 */
export interface BracketShape {
  bracketSize: number
  byes: number
  rounds: number
  realMatches: number
}

export function bracketShape(seats: number): BracketShape {
  const bracketSize = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(2, seats))))
  return {
    bracketSize,
    byes: bracketSize - seats,
    rounds: Math.log2(bracketSize),
    realMatches: seats - 1,
  }
}

/**
 * Standard single-elimination seeding order (1v16, 8v9, 5v12 ...), so the two
 * top seeds can only meet in the final. Byes land on the top seeds, which is
 * both conventional and the only assignment that keeps the bracket balanced.
 */
export function seedOrder(bracketSize: number): number[] {
  let order = [1, 2]
  while (order.length < bracketSize) {
    const size = order.length * 2
    const next: number[] = []
    for (const s of order) {
      next.push(s, size + 1 - s)
    }
    order = next
  }
  return order
}
