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
 * ATTRIBUTION: their terms are free use in exchange for an *editorial* dofollow
 * link to https://slot.report — running text in the body of a page, with a
 * sentence either side of it. Footer and sidebar placements stopped qualifying
 * on 2026-09-04, so the link lives in the sign-in copy on login.html, in a
 * paragraph. Strip the prose around it and this import is no longer licensed —
 * see the note there.
 */

import postgres from 'postgres'
import { normaliseSlotName } from './repositories/slots.js'
import { ADVISORY_LOCK_KEY } from './migrate.js'

const ENDPOINT = 'https://slot.report/api/v1/slots.json'
const PROVIDERS_ENDPOINT = 'https://slot.report/api/v1/providers.json'

/** Postgres caps parameters per statement, and six columns per row adds up. */
const BATCH = 500

/**
 * Page size *requested*. Today the endpoint ignores it and answers with the
 * whole catalog in one response; the parameter goes out anyway so that the day
 * they start paginating, the loop below is already asking for pages instead of
 * quietly importing the first one. It is not a cap on what we keep — the loop
 * runs until upstream stops handing us rows we do not have.
 */
const PAGE_SIZE = 1000

/**
 * Safety bound on the page loop, not a limit on the catalog. At PAGE_SIZE rows
 * a page this allows 200k slots — two orders of magnitude past the current
 * 6.4k — so reaching it means the pagination contract changed and we are
 * spinning, which deserves an error rather than an endless import.
 */
const MAX_PAGES = 200

/**
 * Provider corrections, applied to every import.
 *
 * Upstream has no "Shady Lady" label. Their games either do not appear at all —
 * those are seeded by hand, see seed-slots.ts — or they appear under whichever
 * large studio the tagger assumed. Laced is theirs and arrives as Thunderkick;
 * Truth, Suck, Black Friday and Mortal Bromance arrive as Nolimit City.
 *
 * This has to live in the import rather than being fixed once in the database,
 * because the upsert sets `provider = COALESCE(EXCLUDED.provider, …)` and
 * EXCLUDED.provider is never null for these rows — a hand-fix would survive
 * exactly until the next release.
 *
 * Keyed on the normalised name, and deliberately narrow. A correction is a
 * claim that upstream is wrong about a specific title, so each one is a title
 * someone checked against the studio's own site, not a guess from a naming
 * pattern. If another studio ever ships a slot of the same name, this map would
 * mislabel it — which is the cost of the mechanism and the reason it stays
 * short rather than growing into a general rewriting layer.
 */
const PROVIDER_FIXES = new Map<string, string>([
  ['sheeple', 'Shady Lady'],
  ['mortal bromance', 'Shady Lady'],
  ['preach tv', 'Shady Lady'],
  ['truth', 'Shady Lady'],
  ['suck', 'Shady Lady'],
  ['laced', 'Shady Lady'],
  ['black friday', 'Shady Lady'],
])

interface UpstreamSlot {
  name?: string
  slug?: string | null
  provider?: string | null
  rtp?: number | null
  max_win?: number | null
  volatility?: string | null
  has_bonus_buy?: boolean | null
}

interface UpstreamPage {
  count?: number
  results?: UpstreamSlot[]
}

interface UpstreamProvider {
  name?: string
  total_slots?: number
}

export interface ProviderShortfall {
  provider: string
  upstream: number
  imported: number
}

export interface ImportResult {
  fetched: number
  imported: number
  /** Providers we did not land in full, biggest gap first. */
  shortfalls: ProviderShortfall[]
}

export async function importSlots(
  url: string,
  apiKey: string,
  log: (msg: string) => void = console.log,
): Promise<ImportResult> {
  const fetched = await fetchAll(apiKey, log)
  const rows = dedupe(fetched)
  if (rows.length === 0) return { fetched: 0, imported: 0, shortfalls: [] }

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
        INSERT INTO slots ${sql(batch, 'name', 'normalised', 'provider', 'rtp', 'max_win', 'volatility', 'has_bonus_buy')}
        ON CONFLICT (normalised) WHERE is_custom = false
        DO UPDATE SET
          provider   = COALESCE(EXCLUDED.provider, slots.provider),
          rtp        = COALESCE(EXCLUDED.rtp, slots.rtp),
          max_win    = COALESCE(EXCLUDED.max_win, slots.max_win),
          volatility = COALESCE(EXCLUDED.volatility, slots.volatility),
          -- Tri-state, so COALESCE rather than a plain assignment: upstream
          -- going quiet must not erase an answer we already hold. False is a
          -- real answer the join guard acts on, and COALESCE keeps it --
          -- only null falls through to the existing value.
          has_bonus_buy = COALESCE(EXCLUDED.has_bonus_buy, slots.has_bonus_buy),
          updated_at = now()
      `
      imported += result.count ?? batch.length
    }

    log(`imported ${imported} slots from slot.report (${fetched.length} fetched, ${rows.length} after dedupe)`)
    const shortfalls = await reportCoverage(apiKey, rows, log)
    return { fetched: fetched.length, imported, shortfalls }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Every page, not just the first.
 *
 * As of this writing `slots.json` is a single full dump: it answers with all
 * 6,408 titles and ignores `page`, `limit` and `offset` outright. A loop that
 * trusted those parameters would refetch the same dump forever, so the exit
 * condition is what upstream *gave* us rather than what we asked for — stop
 * when a page carries nothing new, or when we hold the `count` they declared.
 * That reads the whole catalog today and keeps reading it whole if the endpoint
 * starts paginating tomorrow.
 *
 * Exported for the test that pins those exit conditions — importSlots wants a
 * database, and the loop is the part worth testing without one.
 */
export async function fetchAll(
  apiKey: string,
  log: (msg: string) => void = () => {},
): Promise<UpstreamSlot[]> {
  const seen = new Map<string, UpstreamSlot>()
  let declared: number | null = null

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(ENDPOINT)
    url.searchParams.set('page', String(page))
    url.searchParams.set('limit', String(PAGE_SIZE))
    url.searchParams.set('offset', String((page - 1) * PAGE_SIZE))

    const body = await getJson<UpstreamPage>(url, apiKey)
    const results = body.results ?? []
    if (typeof body.count === 'number') declared = body.count
    if (results.length === 0) break

    let added = 0
    for (const row of results) {
      /*
       * Slug *and* provider. The slug alone looks like an id and is not one:
       * upstream ships 26 of them twice, because two studios both make a
       * "Plinko" and both rows are real slots. Keying on slug alone silently
       * drops one of each pair before dedupe ever sees it.
       *
       * This is identity for *fetching* only — deciding whether a page repeats
       * an earlier one. The narrower collapse onto a normalised name happens
       * later, in dedupe, so a page is never judged repetitive merely because
       * two of its titles punctuate alike.
       */
      const identity = (row.slug ?? row.name ?? '').trim().toLowerCase()
      if (identity === '') continue
      const key = `${identity}|${(row.provider ?? '').trim().toLowerCase()}`
      if (seen.has(key)) continue
      seen.set(key, row)
      added++
    }

    log(`  page ${page}: ${results.length} rows, ${added} new (${seen.size} held)`)

    // A page repeating what we already hold is the unpaginated dump handing us
    // the same file again; another request would prove nothing.
    if (added === 0) break
    if (declared !== null && seen.size >= declared) break
    if (page === MAX_PAGES) {
      throw new Error(`slot.report paged past ${MAX_PAGES} pages — pagination contract changed`)
    }
  }

  if (declared !== null && seen.size < declared) {
    log(`WARNING: slot.report declared ${declared} slots but only ${seen.size} came back`)
  }
  return [...seen.values()]
}

/**
 * Per-provider check against upstream's own totals.
 *
 * The catalog is only useful if the providers chat actually names are complete
 * in it — Pragmatic, Hacksaw and Nolimit between them are a fifth of it.
 * `providers.json` publishes a per-provider total, so comparing it against what
 * we are inserting turns "the import ran" into "the import is complete", and
 * names the provider when it is not.
 *
 * Verification only: a failure here leaves the imported catalog alone.
 */
async function reportCoverage(
  apiKey: string,
  rows: readonly SlotInsert[],
  log: (msg: string) => void,
): Promise<ProviderShortfall[]> {
  let providers: UpstreamProvider[]
  try {
    const body = await getJson<{ results?: UpstreamProvider[] }>(new URL(PROVIDERS_ENDPOINT), apiKey)
    providers = body.results ?? []
  } catch (err) {
    log(`provider coverage check skipped: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }

  // Counted under upstream's own labels — see SlotInsert.upstreamProvider.
  const mine = new Map<string, number>()
  for (const row of rows) {
    if (row.upstreamProvider === null) continue
    mine.set(row.upstreamProvider, (mine.get(row.upstreamProvider) ?? 0) + 1)
  }

  const shortfalls: ProviderShortfall[] = []
  for (const provider of providers) {
    const name = provider.name ?? ''
    const upstream = provider.total_slots ?? 0
    if (name === '' || upstream === 0) continue
    const imported = mine.get(name) ?? 0
    if (imported < upstream) shortfalls.push({ provider: name, upstream, imported })
  }
  shortfalls.sort((a, b) => b.upstream - b.imported - (a.upstream - a.imported))

  if (shortfalls.length === 0) {
    log(`coverage: all ${providers.length} providers complete`)
  } else {
    /*
     * Expected to be a handful of rows, and to be duplicate titles rather than
     * missing ones — see dedupe. Logged by name so that a real gap, when one
     * appears, is not read as more of the same.
     */
    log(`coverage: ${shortfalls.length} provider(s) short of their upstream total`)
    for (const s of shortfalls.slice(0, 10)) log(`  ${s.provider}: ${s.imported}/${s.upstream}`)
  }
  return shortfalls
}

async function getJson<T>(url: URL, apiKey: string): Promise<T> {
  const response = await fetch(url, { headers: { 'X-API-Key': apiKey } })
  if (!response.ok) {
    throw new Error(`slot.report returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  return (await response.json()) as T
}

interface SlotInsert {
  name: string
  normalised: string
  provider: string | null
  rtp: string | null
  max_win: number | null
  volatility: string | null
  has_bonus_buy: boolean | null
  /**
   * What upstream called the provider, before PROVIDER_FIXES.
   *
   * Not a column — the INSERT names its columns explicitly, so this rides along
   * unwritten. It exists for the coverage check, which asks "did every row they
   * gave us land", and would otherwise read our own corrections as four missing
   * Nolimit City slots on every single import.
   */
  upstreamProvider: string | null
}

/**
 * One row per normalised name.
 *
 * Postgres refuses an INSERT whose own rows conflict with each other ("cannot
 * affect row a second time"), and an upstream list of six thousand titles
 * reliably contains a few dozen that normalise together: "Blood & Shadow"
 * against "Blood and Shadow", a curly apostrophe against a straight one, or one
 * title licensed to two studios. Only one of each can exist under a unique
 * index on `normalised`, so keep whichever row carries the most data and let
 * the others go — they resolve to the survivor anyway, which is what
 * normalising is for.
 *
 * Exported for the test that pins the tri-state coercion, which is the kind of
 * rule that regresses quietly.
 */
export function dedupe(rows: readonly UpstreamSlot[]): SlotInsert[] {
  const seen = new Map<string, SlotInsert>()

  for (const row of rows) {
    const name = (row.name ?? '').trim()
    const normalised = normaliseSlotName(name)
    if (name === '' || normalised === '') continue

    const candidate: SlotInsert = {
      name,
      normalised,
      provider: PROVIDER_FIXES.get(normalised) ?? row.provider ?? null,
      upstreamProvider: row.provider ?? null,
      // numeric(5,2) — sent as text so the driver doesn't round-trip a float.
      rtp: typeof row.rtp === 'number' ? row.rtp.toFixed(2) : null,
      max_win: typeof row.max_win === 'number' ? Math.round(row.max_win) : null,
      volatility: row.volatility ?? null,
      // Tri-state: only a real boolean is an answer. Anything else — absent,
      // null, a string — stays unknown rather than becoming a false the buy
      // guard would treat as "this slot has no bonus buy".
      has_bonus_buy: typeof row.has_bonus_buy === 'boolean' ? row.has_bonus_buy : null,
    }

    const incumbent = seen.get(normalised)
    if (incumbent === undefined || populated(candidate) > populated(incumbent)) {
      seen.set(normalised, candidate)
    }
  }

  return [...seen.values()]
}

/** Populated columns, as the tie-break between two spellings of one title. */
function populated(row: SlotInsert): number {
  // `!== null` rather than truthiness: `has_bonus_buy: false` is data, and a
  // 0 max_win would be too.
  return [row.provider, row.rtp, row.max_win, row.volatility, row.has_bonus_buy].filter((v) => v !== null)
    .length
}
