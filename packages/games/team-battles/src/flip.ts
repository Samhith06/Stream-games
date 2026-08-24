/**
 * The flip — §6.
 *
 * Everything here runs once, at session creation, and never again. That is the
 * point: the sequence is committed before anyone has joined, indexed by pick
 * number rather than by person, so "the flip is rigged" becomes a claim
 * answerable with a fact rather than with a promise.
 *
 * The consequence for the front end is the important part: **the animation is
 * playback, not decision.** By the time the coin starts spinning the result has
 * been in the event log for an hour.
 */

import type { Rng } from '@streamarena/core'
import type { TeamKey } from './types.js'

/**
 * The committed sequence.
 *
 * `coin` is an honest independent 50/50 per pick, which is the default and the
 * game the rest of the spec describes. It produces lopsided teams — that is
 * expected and it is exactly why the win metric is an average (§2), not a total.
 *
 * `bag` draws n/2 chips of each colour without replacement. Teams come out
 * even, and the price is that the last pick of every session is predetermined:
 * as the bag empties the flip stops being a flip, and the most dramatic moment
 * on the schedule has zero suspense by construction. §2 keeps it available and
 * requires the overlay to show the remaining chips openly when it is on — a bag
 * whose contents are secret while chat can count them anyway is the worst of
 * both.
 */
export function commitFlipSequence(
  length: number,
  rng: Rng,
  mode: 'coin' | 'bag' = 'coin',
): TeamKey[] {
  if (length <= 0) return []

  if (mode === 'bag') {
    const half = Math.floor(length / 2)
    const chips: TeamKey[] = [
      ...Array<TeamKey>(half).fill('A'),
      ...Array<TeamKey>(half).fill('B'),
    ]
    // An odd length cannot split evenly; the spare chip is drawn rather than
    // assigned, so `bag` never quietly favours team A on odd pick counts.
    if (chips.length < length) chips.push(rng.coinFlip() ? 'A' : 'B')
    return rng.shuffle(chips)
  }

  return Array.from({ length }, () => (rng.coinFlip() ? 'A' : 'B'))
}

/**
 * Which picks get the fake-out — §6.3.
 *
 * The false settle always lands on the *losing* colour, so the snap is always a
 * reversal; that half-second, with half the channel already celebrating, is the
 * entire emotional payload of the mechanic.
 *
 * It is scheduled rather than random-per-flip for a reason the spec is blunt
 * about: a fake-out on every flip becomes a rhythm chat learns by pick five,
 * and a tell chat can read is worse than no tell. Seeded so it is reproducible
 * and so it cannot be gamed.
 */
export function commitFakeOuts(length: number, rate: number, rng: Rng): boolean[] {
  if (length <= 0) return []
  const clamped = Math.max(0, Math.min(1, rate))
  if (clamped === 0) return Array<boolean>(length).fill(false)
  if (clamped === 1) return Array<boolean>(length).fill(true)

  /*
   * Chosen as a fixed count on shuffled positions rather than an independent
   * roll per pick. An independent roll at 0.33 lands five in a row often enough
   * to matter over a 15-pick session, and a run of five is precisely the rhythm
   * this is trying to avoid.
   */
  const count = Math.round(length * clamped)
  const positions = rng.shuffle(Array.from({ length }, (_, i) => i)).slice(0, count)
  const chosen = new Set(positions)
  return Array.from({ length }, (_, i) => chosen.has(i))
}

/**
 * A short public commitment to the sequence — §6.1.
 *
 * FNV-1a, the same hash the seeded RNG uses, because the property that matters
 * here is not cryptographic strength but that anyone can reimplement it in ten
 * lines and check the reveal themselves. The sequence is published at COMPLETE;
 * this is what gets posted at the start.
 */
export function hashSequence(sequence: readonly TeamKey[]): string {
  let h = 0x811c9dc5
  for (const team of sequence) {
    h ^= team.charCodeAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * How many chips of each colour a bag has left — §2 requires this on screen
 * whenever `drawMode` is `bag`, since chat can count them anyway.
 */
export function bagRemaining(
  sequence: readonly TeamKey[],
  fromIndex: number,
): { A: number; B: number } {
  const rest = sequence.slice(fromIndex)
  return {
    A: rest.filter((t) => t === 'A').length,
    B: rest.filter((t) => t === 'B').length,
  }
}
