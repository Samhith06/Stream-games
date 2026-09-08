/**
 * The commitment and the draw — §3.
 *
 * Everything in this file exists to make one sentence checkable by a stranger:
 * *the order was fixed before the first person typed.*
 *
 * Team Battles could commit its whole flip sequence at session creation because
 * a coin flip is bound to a pick index and needs no people. A giveaway cannot —
 * the entrants do not exist yet — so the commitment moves one level down: the
 * **seed** is committed at `OPEN` and published as a hash, and the draw is a
 * documented pure function of (seed, entries in join order, weights).
 *
 * The consequence is the entire trust position of the game. **The draw produces
 * an order, not a winner.** One run yields the full ranking; the winner is
 * position one, an unclaimed prize moves to position two, three prizes go to
 * positions one, two and three. A reroll is therefore not a new random event —
 * it is a cursor moving down a list that already existed. There is no code path
 * in this package that computes an order twice, and `test/giveaways.test.ts`
 * asserts that invariant directly.
 */

import { createHash } from 'node:crypto'

/** What the draw needs from an entrant. Nothing else is read. */
export interface DrawEntrant {
  userId: string
  /** Frozen at entry time — see `weighting.ts`. Must be > 0. */
  weight: number
  /** The ordering the commitment is made against. */
  joinedAtSeq: number
}

/**
 * The public commitment, published once at `OPEN` and never before.
 *
 * SHA-256 truncated to twelve hex characters, per §3. Truncation is for
 * legibility on an overlay and in a chat line — twelve characters is 48 bits,
 * which is far more than enough to stop a streamer from grinding a second seed
 * that hashes to the same prefix inside the three minutes an entry window runs.
 */
export function seedHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12)
}

/**
 * The draw function, stated plainly because the verification page has to state
 * it plainly (§3, "a pointer to the documented draw function"):
 *
 *   1. Sort the entrants by `joinedAtSeq` ascending. This is the order the
 *      commitment was made against and it is the order chat produced.
 *   2. For entrant *i* in that order, take `u = H(seed, i)`, a uniform value in
 *      [0, 1) derived from the seed and the position alone.
 *   3. Compute the key `k = u ^ (1 / weight)`.
 *   4. Sort descending by `k`. Ties break on `joinedAtSeq` ascending.
 *
 * Step 3 is Efraimidis–Spirakis. It is the reason this is one function rather
 * than a loop: sorting by that key is *exactly* equivalent to repeatedly
 * drawing from the remaining pool with probability proportional to weight, so a
 * single ranking is simultaneously the winner, the first passover, the second,
 * and the order the second and third prizes are drawn from. A sequential
 * without-replacement draw would produce the same distribution and would have
 * to be re-run — and a function you have to re-run is a function somebody can
 * be accused of re-running.
 *
 * `u` is derived per position rather than from a shared stream so that the
 * ranking is stable under a detail that would otherwise be invisible: it does
 * not matter in what order the caller happens to hold the entries in memory,
 * only what their join sequence was.
 */
export function commitDrawOrder(entrants: readonly DrawEntrant[], seed: string): string[] {
  const byJoin = entrants.slice().sort((a, b) => a.joinedAtSeq - b.joinedAtSeq)

  return byJoin
    .map((e, index) => {
      const u = uniformAt(seed, index)
      // A weight of zero would make the key 0 for everyone and collapse the
      // ranking to join order. Weights are clamped at >= 1 upstream; this is
      // the belt to that braces.
      const weight = e.weight > 0 ? e.weight : 1
      return { userId: e.userId, joinedAtSeq: e.joinedAtSeq, key: Math.pow(u, 1 / weight) }
    })
    .sort((a, b) => (b.key === a.key ? a.joinedAtSeq - b.joinedAtSeq : b.key - a.key))
    .map((e) => e.userId)
}

/**
 * A uniform in [0, 1) from the seed and a position.
 *
 * SHA-256 rather than the platform's mulberry32 RNG, deliberately. The seeded
 * RNG in core is a stream — you get value *n* by having drawn the first *n-1* —
 * and a verifier reimplementing that has to reproduce an iteration order as
 * well as a hash. This is a pure function of two published inputs, and the
 * whole of it is "hash the seed with the index, read the first 52 bits". That
 * fits in a paragraph on the verification page, which is the actual
 * requirement.
 */
export function uniformAt(seed: string, index: number): number {
  const digest = createHash('sha256').update(`${seed}:${index}`).digest()
  // 52 bits — the full mantissa of a double, so no value is unreachable and no
  // two adjacent hashes collide onto the same float.
  let value = 0
  for (let i = 0; i < 7; i++) value = value * 256 + (digest[i] as number)
  // The top nibble of byte 6 is discarded to land on exactly 52 bits.
  return (value % 2 ** 52) / 2 ** 52
}
