/**
 * Deterministic RNG — §9.
 *
 * "Randomness and time must come from state, not the environment. A replay that
 * produces a different champion is worse than no replay at all."
 *
 * Seeded with the session seed plus a label (match id, draw index). Pure
 * function of its inputs, no global state, identical in every process.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  /** Fisher-Yates shuffle returning a new array. */
  shuffle<T>(items: readonly T[]): T[]
  pick<T>(items: readonly T[]): T | undefined
  /** true with probability 0.5 — used for the tiebreak coin flip. */
  coinFlip(): boolean
}

/** FNV-1a over the seed string, giving a 32-bit state we can iterate. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 — small, fast, well-distributed, trivially reimplementable. */
function mulberry32(state: number): () => number {
  let a = state >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createRng(seed: string, label = ''): Rng {
  const next = mulberry32(hashSeed(`${seed}::${label}`))
  return {
    next,
    int: (maxExclusive: number) =>
      maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive) % maxExclusive,
    shuffle<T>(items: readonly T[]): T[] {
      const out = items.slice()
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const a = out[i] as T
        const b = out[j] as T
        out[i] = b
        out[j] = a
      }
      return out
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined
      return items[Math.floor(next() * items.length)]
    },
    coinFlip: () => next() < 0.5,
  }
}

/** Factory bound to one session seed — handed to reducers as `ctx.rng`. */
export function rngFactory(seed: string): (label: string) => Rng {
  return (label: string) => createRng(seed, label)
}

/** Session seeds are generated once, at session creation, and never change. */
export function generateSeed(randomBytes: (n: number) => Uint8Array): string {
  return Array.from(randomBytes(16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
