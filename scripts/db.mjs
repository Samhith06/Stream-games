/**
 * Migration and seed runner.
 *
 * A separate entry point rather than an `import.meta.main`-style guard inside
 * the library: those guards compare paths, and on Windows the comparison is
 * fragile enough that `npm run db:migrate` silently does nothing.
 */

import { migrate } from '../packages/db/dist/migrate.js'
import { seed } from '../packages/db/dist/seed.js'

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
  } else if (task === 'migrate') await migrate(url)
  else if (task === 'seed') await seed(url)
  else {
    console.error('usage: node scripts/db.mjs release|migrate|seed')
    process.exit(1)
  }
} catch (err) {
  console.error(err)
  process.exit(1)
}
