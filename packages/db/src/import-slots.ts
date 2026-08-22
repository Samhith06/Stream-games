/**
 * Imports the slot catalog from slot.report.
 *
 * Breadth only. The hand-curated seed keeps its job of supplying the *aliases* —
 * the shorthand chat actually types ("goo", "fith", "mt4") — which no upstream
 * dataset carries. This adds the six thousand canonical names behind them, so a
 * viewer naming a slot in full resolves whether or not anyone curated it.
 *
 * Fetched at run time rather than vendored into the repo. The data is
 * slot.report's, and committing their database into a public repository would
 * be redistributing it, which is a different thing from using it.
 *
 * ATTRIBUTION: their terms are "free to use with an active dofollow link to
 * https://slot.report". The link lives in the dashboard footer. Remove the link
 * and this import is no longer licensed — see the note in login.html.
 */

import postgres from 'postgres'
import { normaliseSlotName } from './repositories/slots.js'
import { ADVISORY_LOCK_KEY } from './migrate.js'

const ENDPOINT = 'https://slot.report/api/v1/slots.json'

/** Postgres caps parameters per statement, and six columns per row adds up. */
const BATCH = 500

interface UpstreamSlot {
  name?: string
  provider?: string | null
  rtp?: number | null
  max_win?: number | null
  volatility?: string | null
}

export interface ImportResult {
  fetched: number
  imported: number
}

export async function importSlots(
  url: string,
  apiKey: string,
  log: (msg: string) => void = console.log,
): Promise<ImportResult> {
  const response = await fetch(ENDPOINT, { headers: { 'X-API-Key': apiKey } })
  if (!response.ok) {
    throw new Error(`slot.report returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }

  const body = (await response.json()) as { results?: UpstreamSlot[] }
  const rows = dedupe(body.results ?? [])
  if (rows.length === 0) return { fetched: 0, imported: 0 }

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  try {
    // Shared with migrate and seed: all three are release steps, and every
    // service runs them.
    await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`

    let imported = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      /*
       * The unique index is partial — `WHERE is_custom = false` — so the
       * conflict target has to repeat that predicate or Postgres will not
       * recognise it. It also means a streamer's own custom slots are never
       * touched by an import, which is the behaviour we want: their additions
       * outrank an upstream list.
       */
      const result = await sql`
        INSERT INTO slots ${sql(batch, 'name', 'normalised', 'provider', 'rtp', 'max_win', 'volatility')}
        ON CONFLICT (normalised) WHERE is_custom = false
        DO UPDATE SET
          provider   = COALESCE(EXCLUDED.provider, slots.provider),
          rtp        = COALESCE(EXCLUDED.rtp, slots.rtp),
          max_win    = COALESCE(EXCLUDED.max_win, slots.max_win),
          volatility = COALESCE(EXCLUDED.volatility, slots.volatility),
          updated_at = now()
      `
      imported += result.count ?? batch.length
    }

    log(`imported ${imported} slots from slot.report`)
    return { fetched: rows.length, imported }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * One row per normalised name.
 *
 * Postgres refuses an INSERT whose own rows conflict with each other ("cannot
 * affect row a second time"), and an upstream list of six thousand titles
 * reliably contains a couple that normalise together — a re-release, or the
 * same game under two spellings. First wins; the rest would only overwrite it
 * with equivalent data.
 */
function dedupe(rows: readonly UpstreamSlot[]) {
  const seen = new Map<string, {
    name: string
    normalised: string
    provider: string | null
    rtp: string | null
    max_win: number | null
    volatility: string | null
  }>()

  for (const row of rows) {
    const name = (row.name ?? '').trim()
    const normalised = normaliseSlotName(name)
    if (name === '' || normalised === '' || seen.has(normalised)) continue

    seen.set(normalised, {
      name,
      normalised,
      provider: row.provider ?? null,
      // numeric(5,2) — sent as text so the driver doesn't round-trip a float.
      rtp: typeof row.rtp === 'number' ? row.rtp.toFixed(2) : null,
      max_win: typeof row.max_win === 'number' ? Math.round(row.max_win) : null,
      volatility: row.volatility ?? null,
    })
  }

  return [...seen.values()]
}
