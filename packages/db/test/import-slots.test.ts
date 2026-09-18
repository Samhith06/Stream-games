/**
 * Guards on the catalog fetch loop.
 *
 * Both failure modes here are silent ones. Stopping after page 1 imports a
 * fraction of the catalog and reports success; never stopping hammers
 * slot.report until the release times out. Neither throws, so neither shows up
 * anywhere but in a slot chat cannot find.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
// From dist: import-slots.ts transitively imports repositories/slots.ts, which
// uses a TypeScript parameter property that Node's type stripping cannot parse.
import { fetchAll } from '../dist/import-slots.js'

/** Stands in for the endpoint; returns whatever the handler says, as JSON. */
function stubFetch(handler: (url: URL) => unknown) {
  const calls: URL[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input))
    calls.push(url)
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  return { calls, restore: () => void (globalThis.fetch = original) }
}

const slot = (n: number) => ({ name: `Slot ${n}`, slug: `slot-${n}`, provider: 'Pragmatic Play' })

test('the unpaginated dump is fetched once, not refetched', async () => {
  // What slot.report actually does today: every request answers with the whole
  // catalog, whatever page or limit was asked for.
  const all = Array.from({ length: 250 }, (_, i) => slot(i))
  const stub = stubFetch(() => ({ count: all.length, results: all }))

  try {
    const rows = await fetchAll('key')
    assert.equal(rows.length, 250)
    assert.equal(stub.calls.length, 1, 'declared count was already satisfied by page 1')
  } finally {
    stub.restore()
  }
})

test('a dump that declares no count stops as soon as a page repeats', async () => {
  const all = Array.from({ length: 30 }, (_, i) => slot(i))
  const stub = stubFetch(() => ({ results: all }))

  try {
    assert.equal((await fetchAll('key')).length, 30)
    assert.equal(stub.calls.length, 2, 'one probe past the dump, then stop')
  } finally {
    stub.restore()
  }
})

test('a paginated endpoint is read to the end', async () => {
  const all = Array.from({ length: 2500 }, (_, i) => slot(i))
  const stub = stubFetch((url) => {
    const page = Number(url.searchParams.get('page'))
    const size = Number(url.searchParams.get('limit'))
    return { count: all.length, results: all.slice((page - 1) * size, page * size) }
  })

  try {
    const rows = await fetchAll('key')
    assert.equal(rows.length, 2500, 'every page, not just the first')
    assert.equal(stub.calls.length, 3, '1000 + 1000 + 500')
    assert.deepEqual(
      stub.calls.map((u) => u.searchParams.get('page')),
      ['1', '2', '3'],
    )
  } finally {
    stub.restore()
  }
})

test('pages are collected without a client-side cap', async () => {
  // 12k rows is well past anything the catalog holds today; nothing in the
  // fetch path may quietly truncate it.
  const all = Array.from({ length: 12_000 }, (_, i) => slot(i))
  const stub = stubFetch((url) => {
    const page = Number(url.searchParams.get('page'))
    const size = Number(url.searchParams.get('limit'))
    return { results: all.slice((page - 1) * size, page * size) }
  })

  try {
    assert.equal((await fetchAll('key')).length, 12_000)
  } finally {
    stub.restore()
  }
})

test('an endless endpoint throws instead of looping forever', async () => {
  // Distinct rows on every page and no count: the one shape where neither exit
  // condition fires, and the page bound is all that stops us.
  let n = 0
  const stub = stubFetch(() => ({ results: [slot(n++)] }))

  try {
    await assert.rejects(fetchAll('key'), /pagination contract changed/)
  } finally {
    stub.restore()
  }
})

test('bonus buy stays tri-state through dedupe', async () => {
  const { dedupe } = await import('../dist/import-slots.js')

  const rows = dedupe([
    { name: 'Has One', has_bonus_buy: true },
    { name: 'Has None', has_bonus_buy: false },
    { name: 'Explicit Null', has_bonus_buy: null },
    { name: 'Absent' },
    // Upstream is not schema-checked, and a truthy string coerced to `true`
    // would claim a buy exists on a slot nobody has checked.
    { name: 'Junk', has_bonus_buy: 'yes' as unknown as boolean },
  ])

  const buy = (name: string) => rows.find((r) => r.name === name)!.has_bonus_buy
  assert.equal(buy('Has One'), true)
  assert.equal(buy('Has None'), false, 'false is an answer, not a missing value')
  assert.equal(buy('Explicit Null'), null)
  assert.equal(buy('Absent'), null)
  assert.equal(buy('Junk'), null, 'only a real boolean counts')
})

test('the richer of two spellings wins, counting a false bonus buy as data', async () => {
  const { dedupe } = await import('../dist/import-slots.js')

  // Same normalised name, so only one can exist under the unique index.
  const rows = dedupe([
    { name: 'Blood & Shadow', provider: 'Nolimit City' },
    { name: 'Blood and Shadow', provider: 'Nolimit City', rtp: 96.09, has_bonus_buy: false },
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.name, 'Blood and Shadow', 'the row carrying rtp and a buy answer')
  assert.equal(rows[0]!.has_bonus_buy, false)
})

test('a mis-attributed provider is corrected on every import', async () => {
  const { dedupe } = await import('../dist/import-slots.js')

  // Upstream files these under whichever big studio the tagger assumed. The
  // correction has to happen here rather than once in the database, because the
  // upsert writes EXCLUDED.provider straight over a hand-fix.
  const rows = dedupe([
    { name: 'Laced', provider: 'Thunderkick', rtp: 96.12 },
    { name: 'Black Friday', provider: 'Nolimit City' },
    { name: 'Sheeple', provider: 'Pragmatic Play' },
    { name: 'Fire in the Hole 2', provider: 'Nolimit City' },
  ])

  const provider = (name: string) => rows.find((r) => r.name === name)!.provider
  assert.equal(provider('Laced'), 'Shady Lady')
  assert.equal(provider('Black Friday'), 'Shady Lady')
  assert.equal(provider('Sheeple'), 'Shady Lady')
  assert.equal(provider('Fire in the Hole 2'), 'Nolimit City', 'only listed titles are touched')
})

test('a correction keeps the upstream label for the coverage count', async () => {
  const { dedupe } = await import('../dist/import-slots.js')

  // Otherwise every import would report four Nolimit City slots as missing,
  // and a real gap would be lost in the noise of our own edits.
  const [laced] = dedupe([{ name: 'Laced', provider: 'Thunderkick' }])
  assert.equal(laced!.provider, 'Shady Lady')
  assert.equal(laced!.upstreamProvider, 'Thunderkick')
})
