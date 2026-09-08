/**
 * Weighting and odds — §6.
 *
 * The design work here was almost entirely about making weighting *legible*
 * rather than about the weighting itself, and two findings from §6.1 shape the
 * code:
 *
 * **What matters is prizes as a percentage of the pool, and pool size is
 * irrelevant.** Below ~5% of the pool an advertised 5x behaves as 4.8x or
 * better. So for the normal case — one to five prizes, a pool in the hundreds —
 * the weighting does exactly what the streamer told chat it does and there is
 * no correcting machinery to build. That is why this file is short.
 *
 * **The overlay shows computed odds, never ticket counts.** "You: 1 in 214" is
 * a true statement a viewer can act on. "You have 5 entries" is a number whose
 * meaning depends on the pool size and the prize count, neither of which the
 * viewer has. `oddsFor` is computed against the actual number of prizes, which
 * is what keeps it honest in exactly the small-pool case where a ticket count
 * would have lied.
 */

import type { GiveawayConfig } from './types.js'

export type EntryRole = 'viewer' | 'follower' | 'subscriber' | 'vip' | 'mod'

export interface WeightInput {
  role: EntryRole
  subTier: 1 | 2 | 3 | null
  /** Messages this viewer has sent this session. Activity mode only. */
  messageCount: number
}

/**
 * The weight an entrant is frozen at.
 *
 * Frozen at entry time and never recomputed, because the alternative is a
 * viewer's odds changing after they entered for reasons they cannot see —
 * subscribing mid-window, or a bucket boundary crossed by a message they sent
 * about something else. The number the overlay quoted them is the number they
 * got.
 */
export function weightFor(input: WeightInput, config: GiveawayConfig): number {
  const raw =
    config.weightMode === 'flat'
      ? 1
      : config.weightMode === 'role'
        ? roleWeight(input, config)
        : config.weightMode === 'activity'
          ? activityWeight(input.messageCount, config)
          : roleWeight(input, config) * activityWeight(input.messageCount, config)

  // §6.2 — the cap is not about fairness. Heavy weighting suppresses the entry
  // count, and the entry count is the only number this game produces.
  return clampWeight(raw, config.maxWeight)
}

export function clampWeight(weight: number, maxWeight: number): number {
  if (!Number.isFinite(weight) || weight < 1) return 1
  return Math.min(weight, maxWeight)
}

function roleWeight(input: WeightInput, config: GiveawayConfig): number {
  const key =
    input.role === 'subscriber' && input.subTier !== null ? `sub${input.subTier}` : input.role
  return config.roleWeights[key] ?? config.roleWeights[input.role] ?? 1
}

/**
 * §6.3 — bucketed, never linear.
 *
 * Linear weighting on message count is a machine for producing chat spam, and
 * it rewards precisely the behaviour a streamer would otherwise mod against.
 * Three buckets, a low ceiling, and no reward at all past twenty messages. A
 * lurker who types only the keyword is never excluded and never zero-weighted:
 * the mode rewards presence, it does not gate on it.
 */
export function activityWeight(messageCount: number, config: GiveawayConfig): number {
  let weight = 1
  for (const bucket of config.activityBuckets) {
    if (messageCount >= bucket.minMessages) weight = bucket.weight
  }
  return weight
}

/**
 * "1 in N" for a given weight — §6.1.
 *
 * Computed against the prize count, so a session giving away ten prizes to
 * forty people reports 1 in 4 rather than 1 in 40. Returns null for an empty
 * pool: there is no honest odds figure before anybody has entered, and showing
 * "1 in 0" or "1 in 1" would both be lies of a different kind.
 */
export function oddsFor(weight: number, totalWeight: number, prizes: number): number | null {
  if (totalWeight <= 0 || prizes <= 0) return null
  const p = Math.min(1, (weight / totalWeight) * prizes)
  if (p <= 0) return null
  return Math.max(1, Math.round(1 / p))
}

/** The denominator every odds figure on the overlay is computed against. */
export function totalWeight(entries: readonly { weight: number }[]): number {
  return entries.reduce((sum, e) => sum + e.weight, 0)
}

/**
 * The distinct weight tiers present in the pool, for the overlay's odds line
 * and the dashboard's readout ("a viewer: 1 in 847 · a tier-1 sub: 1 in 282").
 *
 * Derived from who actually entered rather than from the config, so a session
 * configured with sub multipliers and no subs in it does not advertise a tier
 * nobody is in.
 */
export function oddsTiers(
  entries: readonly { weight: number }[],
  prizes: number,
): { weight: number; count: number; oneIn: number | null }[] {
  const total = totalWeight(entries)
  const counts = new Map<number, number>()
  for (const e of entries) counts.set(e.weight, (counts.get(e.weight) ?? 0) + 1)

  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weight, count]) => ({ weight, count, oneIn: oddsFor(weight, total, prizes) }))
}
