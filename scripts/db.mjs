/**
 * Migration and seed runner.
 *
 * A separate entry point rather than an `import.meta.main`-style guard inside
 * the library: those guards compare paths, and on Windows the comparison is
 * fragile enough that `npm run db:migrate` silently does nothing.
 */

import { migrate } from '../packages/db/dist/migrate.js'
import { seed } from '../packages/db/dist/seed.js'
import { importSlots } from '../packages/db/dist/import-slots.js'

const task = process.argv[2]
const url = process.env.DATABASE_URL

if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

try {
  // `release` is one command on purpose: a deploy platform runs preDeployCommand
  // without a shell, so `migrate && seed` arrives as extra argv that argv[2]
  // silently ignores — the migration runs, the seed never does, and the deploy
  // reports success with an empty slot catalog.
  if (task === 'release') {
    await migrate(url)
    await seed(url)
    await importCatalog(url)
  } else if (task === 'migrate') await migrate(url)
  else if (task === 'seed') await seed(url)
  else if (task === 'import-slots') await importSlots(url, requireKey())
  else {
    console.error('usage: node scripts/db.mjs release|migrate|seed|import-slots')
    process.exit(1)
  }
} catch (err) {
  console.error(err)
  process.exit(1)
}

function requireKey() {
  const key = process.env.SLOT_REPORT_API_KEY
  if (!key) {
    console.error('SLOT_REPORT_API_KEY is not set')
    process.exit(1)
  }
  return key
}

/**
 * Catalog breadth is a nice-to-have, so a failure here must not fail a release.
 *
 * The seed has already put the curated slots and every alias in place, which is
 * what chat actually types. If slot.report is down, rate limiting us, or the key
 * has lapsed, the right outcome is a deploy that ships with a slightly smaller
 * catalog — not a deploy that does not ship.
 */
async function importCatalog(url) {
  const key = process.env.SLOT_REPORT_API_KEY
  if (!key) return console.log('SLOT_REPORT_API_KEY not set — skipping catalog import')

  try {
    await importSlots(url, key)
  } catch (err) {
    console.warn(`catalog import skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}
