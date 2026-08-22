/**
 * Slot catalog storage — §21, "the hardest unglamorous problem".
 *
 * The resolution ladder itself lives in `packages/catalog`; this file is only
 * the queries it needs. Keeping them apart is what lets step 3 (trigram) be
 * added later without the catalog interface changing.
 */

import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { slotAliases, slots } from '../schema.js'
import type { SlotAliasRow, SlotRow } from '../schema.js'

/** Step 1 of the ladder: "normalised: lowercase, strip punctuation". */
export function normaliseSlotName(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export interface SlotCandidate {
  slotId: string
  name: string
  provider: string | null
  thumbnail: string | null
  confidence: number
  via: 'exact' | 'alias' | 'trigram'
}

export class SlotRepository {
  constructor(private readonly db: Database) {}

  async byId(id: string): Promise<SlotRow | null> {
    const [row] = await this.db.select().from(slots).where(eq(slots.id, id)).limit(1)
    return row ?? null
  }

  async byIds(ids: readonly string[]): Promise<SlotRow[]> {
    if (ids.length === 0) return []
    return this.db
      .select()
      .from(slots)
      .where(sql`${slots.id} = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'`).join(',')}]::uuid[]`)})`)
  }

  /** Ladder step 1 — exact match on the canonical name. */
  async exact(normalised: string): Promise<SlotRow | null> {
    const [row] = await this.db
      .select()
      .from(slots)
      .where(and(eq(slots.normalised, normalised), eq(slots.isCustom, false)))
      .limit(1)
    return row ?? null
  }

  /** Ladder step 2 — exact match on a known alias. */
  async byAlias(normalised: string): Promise<{ slot: SlotRow; alias: SlotAliasRow } | null> {
    const [row] = await this.db
      .select({ slot: slots, alias: slotAliases })
      .from(slotAliases)
      .innerJoin(slots, eq(slots.id, slotAliases.slotId))
      .where(and(eq(slotAliases.normalised, normalised), eq(slotAliases.approved, true)))
      .orderBy(desc(slotAliases.weight), desc(slotAliases.hitCount))
      .limit(1)
    return row ?? null
  }

  /**
   * Ladder step 3 — trigram similarity across names and aliases.
   *
   * §21 ship order: exact and near-exact only for v1, with the unresolved queue
   * carrying the rest. This is behind the same interface so the threshold can be
   * tuned against real request data instead of guesses.
   */
  async fuzzy(normalised: string, limit = 3, threshold = 0.3): Promise<SlotCandidate[]> {
    const rows = await this.db.execute<{
      id: string
      name: string
      provider: string | null
      thumbnail: string | null
      score: number
    }>(sql`
      SELECT id, name, provider, thumbnail, score FROM (
        SELECT s.id, s.name, s.provider, s.thumbnail,
               similarity(s.normalised, ${normalised}) AS score
        FROM slots s
        WHERE s.is_custom = false AND s.normalised %> ${normalised}
        UNION ALL
        SELECT s.id, s.name, s.provider, s.thumbnail,
               similarity(a.normalised, ${normalised}) * LEAST(a.weight, 1.0) AS score
        FROM slot_aliases a
        JOIN slots s ON s.id = a.slot_id
        WHERE a.approved = true AND a.normalised %> ${normalised}
      ) candidates
      WHERE score >= ${threshold}
      ORDER BY score DESC
      LIMIT ${limit * 3}
    `)

    // A slot can surface through both its name and several aliases — keep its
    // best score only.
    const best = new Map<string, SlotCandidate>()
    for (const r of rows) {
      const existing = best.get(r.id)
      if (!existing || existing.confidence < Number(r.score)) {
        best.set(r.id, {
          slotId: r.id,
          name: r.name,
          provider: r.provider,
          thumbnail: r.thumbnail,
          confidence: Number(r.score),
          via: 'trigram',
        })
      }
    }
    return [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit)
  }

  async search(query: string, limit = 25): Promise<SlotRow[]> {
    const n = normaliseSlotName(query)
    if (n === '') return this.db.select().from(slots).orderBy(slots.name).limit(limit)
    return this.db
      .select()
      .from(slots)
      .where(or(sql`${slots.normalised} LIKE ${`%${n}%`}`, sql`${slots.normalised} %> ${n}`))
      .orderBy(sql`similarity(${slots.normalised}, ${n}) DESC`)
      .limit(limit)
  }

  async list(limit = 100, offset = 0): Promise<SlotRow[]> {
    return this.db.select().from(slots).orderBy(slots.name).limit(limit).offset(offset)
  }

  async upsert(input: {
    name: string
    provider?: string | null
    rtp?: string | null
    maxWin?: number | null
    volatility?: string | null
    thumbnail?: string | null
    isCustom?: boolean
  }): Promise<SlotRow> {
    const normalised = normaliseSlotName(input.name)
    const existing = await this.exact(normalised)
    if (existing && !input.isCustom) return existing

    const [row] = await this.db
      .insert(slots)
      .values({
        name: input.name.trim(),
        normalised,
        provider: input.provider ?? null,
        rtp: input.rtp ?? null,
        maxWin: input.maxWin ?? null,
        volatility: input.volatility ?? null,
        thumbnail: input.thumbnail ?? null,
        isCustom: input.isCustom ?? false,
      })
      .returning()
    return row!
  }

  async update(id: string, patch: Partial<Omit<SlotRow, 'id' | 'createdAt'>>): Promise<void> {
    const next: Record<string, unknown> = { ...patch, updatedAt: sql`now()` }
    if (typeof patch.name === 'string') next.normalised = normaliseSlotName(patch.name)
    await this.db.update(slots).set(next).where(eq(slots.id, id))
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(slots).where(eq(slots.id, id))
  }
}

export class AliasRepository {
  constructor(private readonly db: Database) {}

  /**
   * The alias flywheel (§21).
   *
   * "Every resolution a streamer or mod makes in the unresolved queue creates a
   * learned alias. Frequency across channels raises its weight."
   */
  /**
   * Makes sure a curated alias exists, without disturbing it if it does.
   *
   * Distinct from learn() because learn() counts a *use*: it bumps hitCount and
   * weight on conflict, which is right for a viewer typing "gates" and wrong for
   * the seed, which runs on every release. Using learn() here would inflate the
   * curated aliases' stats a little more with each deploy, and §21 ranks
   * matches on exactly those numbers.
   */
  async ensure(input: { slotId: string; alias: string }): Promise<void> {
    const normalised = normaliseSlotName(input.alias)
    if (normalised === '') return
    await this.db
      .insert(slotAliases)
      .values({
        slotId: input.slotId,
        alias: input.alias.trim(),
        normalised,
        source: 'manual',
        approved: true,
        hitCount: 0,
      })
      .onConflictDoNothing({ target: [slotAliases.normalised, slotAliases.slotId] })
  }

  async learn(input: {
    slotId: string
    alias: string
    source?: 'manual' | 'learned'
    approved?: boolean
  }): Promise<void> {
    const normalised = normaliseSlotName(input.alias)
    if (normalised === '') return
    await this.db
      .insert(slotAliases)
      .values({
        slotId: input.slotId,
        alias: input.alias.trim(),
        normalised,
        source: input.source ?? 'learned',
        approved: input.approved ?? (input.source === 'manual'),
        hitCount: 1,
      })
      .onConflictDoUpdate({
        target: [slotAliases.normalised, slotAliases.slotId],
        set: {
          hitCount: sql`${slotAliases.hitCount} + 1`,
          // Weight climbs with cross-channel frequency and saturates at 1, so a
          // popular learned alias eventually matches as confidently as a curated
          // one without ever outranking it.
          weight: sql`LEAST(1.0, ${slotAliases.weight} + 0.05)`,
        },
      })
  }

  async recordHit(normalised: string, slotId: string): Promise<void> {
    await this.db
      .update(slotAliases)
      .set({ hitCount: sql`${slotAliases.hitCount} + 1` })
      .where(and(eq(slotAliases.normalised, normalised), eq(slotAliases.slotId, slotId)))
  }

  /** Admin review queue, highest-impact fixes first (§21). */
  async reviewQueue(limit = 50) {
    return this.db
      .select({ alias: slotAliases, slot: slots })
      .from(slotAliases)
      .innerJoin(slots, eq(slots.id, slotAliases.slotId))
      .where(eq(slotAliases.approved, false))
      .orderBy(desc(slotAliases.hitCount))
      .limit(limit)
  }

  async approve(id: string): Promise<void> {
    await this.db.update(slotAliases).set({ approved: true }).where(eq(slotAliases.id, id))
  }

  async reject(id: string): Promise<void> {
    await this.db.delete(slotAliases).where(eq(slotAliases.id, id))
  }

  async forSlot(slotId: string): Promise<SlotAliasRow[]> {
    return this.db
      .select()
      .from(slotAliases)
      .where(eq(slotAliases.slotId, slotId))
      .orderBy(desc(slotAliases.hitCount))
  }
}
