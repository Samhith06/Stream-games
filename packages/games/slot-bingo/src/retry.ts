/**
 * The retry dial, Model B — the re-entry draw (§6.5.2, §6.5.3).
 *
 * "Green locks you in. Red puts you back in the draw."
 *
 * A red on a square with a life left does not settle it. The owner loses the
 * square and drops back into the pool; the square reopens — scarred, not
 * neutral (§6.5.5) — and goes to the back of the committed order. When the
 * cursor reaches it again it is refilled by the same one-seat `drawSeats()`
 * call a scheduled unlock uses, against the same pool. One pool, one primitive,
 * two reasons a square might need an owner.
 *
 * Everything here is pure and seeded, like the reducer that calls it.
 */

import { drawSeats, round2, type ReduceContext } from '@streamarena/core'
import type { BingoConfig, BingoState, PoolMember, Square } from './types.js'

type Ctx = ReduceContext<BingoConfig>

/** True whenever the dial is off Sudden Death. Model A is refused by the schema. */
export const retriesOn = (state: BingoState): boolean => state.retriesPerSquare !== 0

export const isEndless = (state: BingoState): boolean => state.retriesPerSquare === null

/** Lives a square starts with. null in Endless — it never runs out — and with retries off. */
export const startingLives = (state: BingoState): number | null =>
  state.retriesPerSquare === null || state.retriesPerSquare === 0 ? null : state.retriesPerSquare

/**
 * Whether a red on this square reopens it rather than settling it.
 *
 * House and free squares get zero lives — no spending real money on a square
 * that wins nobody anything (§13).
 */
export function hasLife(state: BingoState, square: Square): boolean {
  if (!retriesOn(state)) return false
  if (square.owner !== 'viewer') return false
  if (isEndless(state)) return true
  return (square.livesLeft ?? 0) > 0
}

/** A square a red emptied, waiting for its next owner. */
export const isReopened = (square: Square): boolean =>
  square.owner === 'open' && square.status === 'wounded'

/** How many viewers a square has taken. The cursed-square counter (§10 derived). */
export const burnCount = (square: Square): number =>
  square.history.filter((h) => h.burnedAtSeq !== null).length

/** Standby members who can actually be drawn: a resolved slot nobody else holds. */
export function drawablePool(state: BingoState): PoolMember[] {
  return state.standby.filter((m) => m.slotId !== null && !slotUnavailable(state, m.slotId, m.userId))
}

/**
 * Slot uniqueness, re-checked at draw time in case the board changed since the
 * join was accepted (§13) — plus the burn list under `burnPlayedSlots`.
 */
export function slotUnavailable(state: BingoState, slotId: string, userId: string): boolean {
  if (state.burnPlayedSlots && (state.burnedSlotIds ?? []).includes(slotId)) return true
  return state.squares.some((s) => s.owner !== 'open' && s.slotId === slotId && s.userId !== userId)
}

/**
 * A red on a square with a life left — the square reopens and the owner goes
 * back in the pool (§6.5.3).
 *
 * Re-entry is automatic. With `burnPlayedSlots` on (the default) the slot they
 * lost on is done for the session, so they re-enter without one and `!join` a
 * new slot to become drawable again. With it off, their slot follows them.
 */
export function burnSquare(state: BingoState, squareId: string, ctx: Ctx): BingoState {
  const square = state.squares.find((s) => s.id === squareId)
  if (!square || !square.userId) return state

  const burnedSlot = state.burnPlayedSlots ? square.slotId : null

  const history = square.history.slice()
  const last = history[history.length - 1]
  if (last && last.userId === square.userId && last.burnedAtSeq === null) {
    history[history.length - 1] = { ...last, burnedAtSeq: ctx.seq }
  }

  const reopened: Square = {
    ...square,
    userId: null,
    username: null,
    slotId: null,
    slotName: null,
    thumbnail: null,
    owner: 'open',
    claimedAtSeq: null,
    history,
    livesLeft: square.livesLeft === null ? null : Math.max(0, square.livesLeft - 1),
    status: 'wounded',
    tier: null,
    manualPick: false,
  }

  const loser: PoolMember = {
    userId: square.userId,
    username: square.username ?? '',
    role: 'viewer',
    slotId: burnedSlot ? null : square.slotId,
    slotName: burnedSlot ? null : square.slotName,
    provider: null,
    thumbnail: burnedSlot ? null : square.thumbnail,
    rawText: square.slotName ?? '',
    // Re-stamped on re-entry: a viewer who lost on pick 4 and one who arrived
    // at pick 40 have identical odds at the next draw, scheduled unlocks included.
    joinedAtSeq: ctx.seq,
    suggestions: [],
    // The square's art, kept so a revert can put the square back exactly.
    reentry: { squareId, burnedAtSeq: ctx.seq, thumbnail: square.thumbnail },
  }

  return {
    ...state,
    squares: state.squares.map((s) => (s.id === squareId ? reopened : s)),
    standby: [...state.standby.filter((m) => m.userId !== loser.userId), loser],
    burnedSlotIds:
      burnedSlot && !(state.burnedSlotIds ?? []).includes(burnedSlot)
        ? [...(state.burnedSlotIds ?? []), burnedSlot]
        : (state.burnedSlotIds ?? []),
    // §6.5.8 — a reopened square keeps its place in the committed order; the
    // cursor has always passed it by the time it burns, so it goes on the end.
    pickOrder: [...state.pickOrder, squareId],
  }
}

/**
 * The reopening mini-draw — one seat, the whole pool (§6.5.3).
 *
 * The viewer the square just burned is blocked for this one draw, waived if
 * they are the only one left: a seeded, provable redraw onto the square that
 * just burned you still reads as rigged, but a stalled board is worse.
 *
 * Returns null when nobody is drawable; the caller decides whether the square
 * rolls forward or plays as HOUSE.
 */
export function refillSquare(
  state: BingoState,
  squareId: string,
  ctx: Ctx,
): { state: BingoState; userId: string } | null {
  const square = state.squares.find((s) => s.id === squareId)
  if (!square || !isReopened(square)) return null

  const lastBurn = [...square.history].reverse().find((h) => h.burnedAtSeq !== null)
  const pool = drawablePool(state)
  const preferred = lastBurn ? pool.filter((m) => m.userId !== lastBurn.userId) : pool
  const eligible = preferred.length > 0 ? preferred : pool

  const draw = drawSeats(eligible, {
    seats: 1,
    reservedUserIds: [],
    // Salted with the ownership count so every reopening of this square is
    // its own draw, and a replay reaches the same owner every time.
    rng: ctx.rng(`reopen-${squareId}-${square.history.length}`),
  })
  const seat = draw.seats[0]
  if (!seat) return null

  const member = seat.member
  const filled: Square = {
    ...square,
    userId: member.userId,
    username: member.username,
    slotId: member.slotId,
    slotName: member.slotName,
    thumbnail: member.thumbnail,
    owner: 'viewer',
    source: 'random',
    claimedAtSeq: ctx.seq,
    history: [
      ...square.history,
      {
        userId: member.userId,
        username: member.username,
        slotId: member.slotId,
        slotName: member.slotName,
        claimedAtSeq: ctx.seq,
        via: 'reentry',
        burnedAtSeq: null,
      },
    ],
    // Still wounded: a new owner does not un-scar the square (§6.5.5).
    status: 'wounded',
  }

  return {
    state: {
      ...state,
      squares: state.squares.map((s) => (s.id === squareId ? filled : s)),
      standby: state.standby.filter((m) => m.userId !== member.userId),
    },
    userId: member.userId,
  }
}

/**
 * The budget and buy caps (§6.5.8, §11).
 *
 * Checked before a square is armed, never mid-buy. "Do not start a round the
 * cap cannot finish" becomes, without rounds, "do not start a buy the budget
 * cannot cover" — judged on the average buy so far, since the next one's cost
 * is not known until it is entered.
 */
export function capReached(state: BingoState): 'budget' | 'buys' | null {
  let spent = 0
  let buys = 0
  for (const square of state.squares) {
    for (const attempt of square.attempts) {
      spent += attempt.buyCost
      buys++
    }
  }

  if (state.maxBuys !== null && buys >= state.maxBuys) return 'buys'

  if (state.budgetCapCents !== null && buys > 0) {
    const spentCents = Math.round(round2(spent) * 100)
    const averageCents = spentCents / buys
    if (spentCents + averageCents > state.budgetCapCents) return 'budget'
  }

  return null
}
