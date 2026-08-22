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
  if (task === 'migrate') await migrate(url)
  else if (task === 'seed') await seed(url)
  else {
    console.error('usage: node scripts/db.mjs migrate|seed')
    process.exit(1)
  }
} catch (err) {
  console.error(err)
  process.exit(1)
}
