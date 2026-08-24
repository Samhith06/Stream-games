/**
 * The slot resolution ladder — §21.
 *
 * "!sr gates, !sr gates of olympus, !sr GOO, and !sr gatez must all resolve to
 * one canonical slot. This is what makes the product feel magic or feel broken."
 *
 *   1. Exact match on canonical name (normalised)
 *   2. Exact match on a known alias
 *   3. Trigram / fuzzy above a confidence threshold -> auto-resolve
 *   4. Below threshold -> unresolved queue with top three suggestions
 *   5. No candidates -> "not found" ack with a search hint
 *
 * Ship order (§21): steps 1-2 for v1, with the unresolved queue carrying the
 * rest. Step 3 sits behind the same interface and the same `fuzzy` flag, so
 * thresholds get tuned against what viewers actually type rather than guesses.
 */

import type { AliasRepository, SlotRepository } from '@streamarena/db'
import { normaliseSlotName } from '@streamarena/db'

export interface SlotSuggestion {
  slotId: string
  name: string
  provider: string | null
  /** Slot art, shown on the overlay queue and in every results table. */
  thumbnail: string | null
  confidence: number
  /** Curation facts — Team Battles §10. Null means the catalog doesn't know. */
  buyCostX?: number | null
  hasBonusBuy?: boolean | null
  volatility?: string | null
}

/**
 * The curation facts Team Battles §10 judges an entry on.
 *
 * `buy_cost_x` is a Postgres numeric, which the driver hands back as a string
 * to avoid silently losing precision — so it is parsed here rather than being
 * passed along to be coerced by whatever reads it next. A row that has never
 * been curated yields nulls, and null means unknown throughout: §10's guards
 * distinguish "this buy is too rich" from "we cannot tell what this buy costs".
 */
export function curationOf(row: {
  buyCostX?: string | number | null
  hasBonusBuy?: boolean | null
  volatility?: string | null
}) {
  const raw = row.buyCostX
  const buyCostX = raw === null || raw === undefined || raw === '' ? null : Number(raw)
  return {
    buyCostX: buyCostX !== null && Number.isFinite(buyCostX) ? buyCostX : null,
    hasBonusBuy: row.hasBonusBuy ?? null,
    volatility: row.volatility ?? null,
  }
}

export type Resolution =
  | { kind: 'resolved'; slot: SlotSuggestion; via: 'exact' | 'alias' | 'fuzzy' }
  | { kind: 'ambiguous'; suggestions: SlotSuggestion[] }
  | { kind: 'not_found' }

export interface CatalogOptions {
  /** Step 3 of the ladder. Off until there's real request data to tune against. */
  fuzzy?: boolean
  /** At or above this similarity, resolve without asking a human. */
  autoResolveThreshold?: number
  /** Below this, don't even offer it as a suggestion — it's noise. */
  suggestThreshold?: number
  /** Hot !sr storms repeat the same names; a small cache saves the round trip. */
  cacheSize?: number
}

const DEFAULTS = {
  fuzzy: false,
  autoResolveThreshold: 0.82,
  suggestThreshold: 0.3,
  cacheSize: 500,
} satisfies Required<CatalogOptions>

export class SlotCatalog {
  private readonly opts: Required<CatalogOptions>
  private readonly cache = new Map<string, Resolution>()

  constructor(
    private readonly slots: SlotRepository,
    private readonly aliases: AliasRepository,
    opts: CatalogOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  async resolve(rawQuery: string): Promise<Resolution> {
    const normalised = normaliseSlotName(rawQuery)
    if (normalised === '') return { kind: 'not_found' }

    const cached = this.cache.get(normalised)
    if (cached) return cached

    const result = await this.ladder(normalised)
    this.remember(normalised, result)
    return result
  }

  private async ladder(normalised: string): Promise<Resolution> {
    // 1. Canonical name.
    const exact = await this.slots.exact(normalised)
    if (exact) {
      return {
        kind: 'resolved',
        via: 'exact',
        slot: {
          slotId: exact.id,
          name: exact.name,
          provider: exact.provider,
          thumbnail: exact.thumbnail,
          confidence: 1,
          ...curationOf(exact),
        },
      }
    }

    // 2. Known alias. Hit counts feed the flywheel's weighting.
    const aliased = await this.slots.byAlias(normalised)
    if (aliased) {
      void this.aliases.recordHit(normalised, aliased.slot.id).catch(() => {})
      return {
        kind: 'resolved',
        via: 'alias',
        slot: {
          slotId: aliased.slot.id,
          name: aliased.slot.name,
          provider: aliased.slot.provider,
          thumbnail: aliased.slot.thumbnail,
          confidence: Math.min(1, aliased.alias.weight),
          ...curationOf(aliased.slot),
        },
      }
    }

    if (!this.opts.fuzzy) return { kind: 'not_found' }

    // 3-5. Trigram candidates, then the auto-resolve / suggest / nothing split.
    let candidates: SlotSuggestion[]
    try {
      candidates = await this.slots.fuzzy(normalised, 3, this.opts.suggestThreshold)
    } catch {
      // pg_trgm missing or the query failed — never block a hunt on the catalog
      // (§21). Fall through to the unresolved queue.
      return { kind: 'not_found' }
    }

    const best = candidates[0]
    if (!best) return { kind: 'not_found' }

    if (best.confidence >= this.opts.autoResolveThreshold) {
      // A confident fuzzy hit is exactly the alias we wish we'd had. Learn it,
      // unapproved, so the admin queue can confirm or reject it later.
      void this.aliases
        .learn({ slotId: best.slotId, alias: normalised, source: 'learned', approved: false })
        .catch(() => {})
      return { kind: 'resolved', via: 'fuzzy', slot: best }
    }

    return { kind: 'ambiguous', suggestions: candidates }
  }

  /**
   * A human picked a slot for an unresolved entry. That decision is the alias
   * flywheel's only fuel — §21.
   */
  async confirm(rawQuery: string, slotId: string): Promise<void> {
    const normalised = normaliseSlotName(rawQuery)
    if (normalised === '') return
    await this.aliases.learn({ slotId, alias: rawQuery, source: 'manual', approved: true })
    this.cache.delete(normalised)
  }

  /**
   * The escape hatch (§21): "Never block on the catalog. The slot picker's empty
   * state offers 'Add as custom slot' accepting free text, so a missing catalog
   * entry can never stop a hunt or a tournament mid-stream."
   */
  async createCustom(name: string): Promise<SlotSuggestion> {
    const row = await this.slots.upsert({ name, isCustom: true })
    this.cache.delete(normaliseSlotName(name))
    return {
      slotId: row.id,
      name: row.name,
      provider: row.provider,
      thumbnail: row.thumbnail,
      confidence: 1,
      ...curationOf(row),
    }
  }

  async byId(slotId: string): Promise<SlotSuggestion | null> {
    const row = await this.slots.byId(slotId)
    return row
      ? {
          slotId: row.id,
          name: row.name,
          provider: row.provider,
          thumbnail: row.thumbnail,
          confidence: 1,
          ...curationOf(row),
        }
      : null
  }

  /** Dashboard slot picker. */
  async search(query: string, limit = 25): Promise<SlotSuggestion[]> {
    const rows = await this.slots.search(query, limit)
    return rows.map((r) => ({
      slotId: r.id,
      name: r.name,
      provider: r.provider,
      thumbnail: r.thumbnail,
      confidence: 1,
      ...curationOf(r),
    }))
  }

  invalidate(): void {
    this.cache.clear()
  }

  private remember(key: string, value: Resolution): void {
    // Negative results are deliberately not cached: an admin adding the missing
    // slot mid-session must take effect on the very next !sr.
    if (value.kind !== 'resolved') return
    if (this.cache.size >= this.opts.cacheSize) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, value)
  }
}
