/**
 * §13 — "Derived values — computed, never stored."
 *
 *   spent              = startBalance - balanceAtEndOfCollection
 *   profit             = totals.won - spent
 *   returnMultiple     = totals.won / spent
 *   remainingBonuses   = entries.filter(e => e.status !== 'opened').length
 *
 *   breakEvenMultiplier = (startBalance - won) / sum(bet of unopened bonuses)
 *
 * The multiplier is the emotional centre of the game and should be the largest
 * number on the overlay during collection and opening. Streamers talk in
 * multiples, not money — "we need 40x average" means something to chat in a way
 * that "we need EUR 180 a bonus" does not, because it is comparable across
 * different bet sizes and different hunts.
 *
 * It is measured against the *starting balance*: what you have to pull back to
 * be whole. As bonuses open and wins land the target shrinks, so the number
 * falls through the opening phase and reaching 0 is the moment of breaking even.
 */

import { round2 } from '@streamarena/core'
import type { BonusHuntState, HuntEntry } from './types.js'

/**
 * The average multiplier the bonuses still to open must hit to recover the
 * starting balance.
 *
 * Only banked-but-unopened bonuses count on the stake side: an opened bonus has
 * already paid whatever it paid, and that win is subtracted from the target
 * instead. So the number answers the only question that matters mid-hunt —
 * "given what is left, what does each one need to average?"
 *
 * null rather than 0 when there is nothing left to open or no stake recorded:
 * the answer is genuinely undefined, and 0 would read as "we are home".
 */
export function breakEvenMultiplier(state: BonusHuntState): number | null {
  const unopened = state.entries.filter((e) => e.status === 'collected')
  const stake = unopened.reduce((sum, e) => sum + (e.bet ?? 0), 0)
  if (stake <= 0) return null

  const remaining = state.startBalance - state.totals.won
  // Already ahead: nothing more is *needed*, which is worth showing as 0.
  if (remaining <= 0) return 0

  return round2(remaining / stake)
}

export interface HuntDerived {
  spent: number
  /** Average multiplier the unopened bonuses must average to recover the start
   *  balance. null when nothing is left to open, or no stake is recorded. */
  breakEvenMultiplier: number | null
  profit: number
  returnMultiple: number
  remainingBonuses: number
  openedCount: number
  totalBonuses: number
  runningBalance: number
  /** Mean multiplier across opened bonuses — the results screen's stat tile. */
  averageMultiplier: number
  bestEntry: { slotName: string; win: number; multiplier: number } | null
}

export function derive(state: BonusHuntState): HuntDerived {
  // Before collection closes we don't know what was spent, so the break-even
  // figure runs off the cost of the bets banked so far.
  const spent =
    state.totals.spent > 0
      ? state.totals.spent
      : round2(
          state.entries
            .filter((e) => e.status === 'collected' || e.status === 'opened')
            .reduce((sum, e) => sum + e.bet, 0),
        )

  // Only banked bonuses will ever be opened, so they are what the hunt is
  // measured against. Counting suggestions would understate break-even and let
  // the progress bar claim bonuses that were never obtained.
  const totalBonuses = state.entries.filter(
    (e) => e.status === 'collected' || e.status === 'opened',
  ).length
  const opened = state.entries.filter((e) => e.status === 'opened')

  return {
    spent,
    breakEvenMultiplier: breakEvenMultiplier(state),
    profit: round2(state.totals.won - spent),
    returnMultiple: spent === 0 ? 0 : round2(state.totals.won / spent),
    remainingBonuses: totalBonuses - opened.length,
    openedCount: opened.length,
    totalBonuses,
    runningBalance: round2((state.balanceAtCloseOfCollection ?? state.startBalance) + state.totals.won),
    averageMultiplier: averageMultiplierOf(opened),
    bestEntry: bestOf(opened),
  }
}

/**
 * Bonuses with no bet recorded are skipped rather than counted as 0x — an
 * un-entered bet would otherwise drag the average down and make the number lie.
 */
function averageMultiplierOf(opened: readonly HuntEntry[]): number {
  const rated = opened.filter((e) => e.win !== null && e.bet > 0)
  if (rated.length === 0) return 0
  const total = rated.reduce((sum, e) => sum + e.win! / e.bet, 0)
  return round2(total / rated.length)
}

/** §15.4 — the result announcement names the best slot and its multiplier. */
function bestOf(opened: readonly HuntEntry[]): HuntDerived['bestEntry'] {
  let best: HuntDerived['bestEntry'] = null
  for (const e of opened) {
    if (e.win === null) continue
    const multiplier = e.bet > 0 ? e.win / e.bet : 0
    if (!best || multiplier > best.multiplier) {
      best = { slotName: e.slotName ?? e.rawText, win: e.win, multiplier: round2(multiplier) }
    }
  }
  return best
}

/**
 * Guess distribution for the guessing screen's histogram and its stat row
 * (lowest / median / highest / where the cluster sits).
 *
 * Computed, never stored — like every other derived value in §13.
 */
export interface GuessDistribution {
  count: number
  lowest: number | null
  median: number | null
  highest: number | null
  /** Fixed-width buckets spanning the guess range, for the histogram bars. */
  buckets: { from: number; to: number; count: number }[]
  /** The busiest bucket — "Clustered: EUR10k - EUR12k" on the stat row. */
  clustered: { from: number; to: number; count: number } | null
}

export function guessDistribution(
  state: BonusHuntState,
  bucketCount = 8,
): GuessDistribution {
  const amounts = state.guesses.map((g) => g.amount).sort((a, b) => a - b)
  if (amounts.length === 0) {
    return { count: 0, lowest: null, median: null, highest: null, buckets: [], clustered: null }
  }

  const lowest = amounts[0]!
  const highest = amounts.at(-1)!
  const mid = Math.floor(amounts.length / 2)
  const median =
    amounts.length % 2 === 0 ? round2((amounts[mid - 1]! + amounts[mid]!) / 2) : amounts[mid]!

  // A single distinct value (or everyone guessing the same) still deserves one
  // bar rather than a divide-by-zero.
  const span = highest - lowest
  const width = span === 0 ? 1 : span / bucketCount

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    from: round2(lowest + i * width),
    to: round2(lowest + (i + 1) * width),
    count: 0,
  }))

  for (const amount of amounts) {
    const index = span === 0 ? 0 : Math.min(bucketCount - 1, Math.floor((amount - lowest) / width))
    buckets[index]!.count++
  }

  const clustered = buckets.reduce<GuessDistribution['clustered']>(
    (best, b) => (best === null || b.count > best.count ? b : best),
    null,
  )

  return { count: amounts.length, lowest, median, highest, buckets, clustered }
}

/** Everyone who took part, by either route — the "Participants" stat tile. */
export function participantCount(state: BonusHuntState): number {
  const ids = new Set<string>()
  for (const e of state.entries) ids.add(e.requestedBy.userId)
  for (const g of state.guesses) ids.add(g.userId)
  return ids.size
}

export function nextOrder(state: BonusHuntState): number {
  return state.entries.reduce((max, e) => Math.max(max, e.order), 0) + 1
}

export function findEntry(state: BonusHuntState, entryId: string): HuntEntry | undefined {
  return state.entries.find((e) => e.id === entryId)
}

export function entryCountFor(state: BonusHuntState, userId: string): number {
  return state.entries.filter((e) => e.requestedBy.userId === userId).length
}

/**
 * Entries this viewer is still waiting on — the ones the streamer hasn't dealt
 * with yet. A banked or opened bonus is settled; dropping an entry removes it
 * entirely. This is what the outstanding-request cap counts.
 */
export function outstandingCountFor(state: BonusHuntState, userId: string): number {
  return state.entries.filter(
    (e) =>
      e.requestedBy.userId === userId && (e.status === 'pending' || e.status === 'queued'),
  ).length
}

/** Bonuses actually banked — what `targetBonuses` and break-even count. */
export function collectedCount(state: BonusHuntState): number {
  return state.entries.filter((e) => e.status === 'collected' || e.status === 'opened').length
}

export function hasSlot(state: BonusHuntState, slotId: string): boolean {
  return state.entries.some((e) => e.slotId === slotId)
}
