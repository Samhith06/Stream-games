/**
 * Migration runner. Plain SQL files applied in filename order, tracked in a
 * table — no ORM migration state to get out of sync with the DDL that actually
 * ran, which matters when the schema file is authoritative for partial indexes
 * and extensions that Drizzle can't express.
 */

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Arbitrary but fixed — any migrator in any process must pick the same one.
 * Kept under 2^53 so it survives as an exact JS number; pg_advisory_lock takes
 * a bigint and the driver will widen it.
 */
const ADVISORY_LOCK_KEY = 8_274_113_905_471_002

export async function migrate(url: string, log: (msg: string) => void = console.log) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  try {
    /*
     * One migrator at a time.
     *
     * Every service runs this on release, and a service can have several
     * replicas, so concurrent runs are the normal case rather than the
     * exception. Without the lock two runners read the same `applied` set, both
     * try the same file, and the loser fails the deploy on a duplicate key —
     * turning a no-op into a failed release. The lock is released with the
     * connection, including if this process dies holding it.
     */
    await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `

    const applied = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
    )

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

    for (const file of files) {
      if (applied.has(file)) continue
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      log(`applying ${file}`)
      // One transaction per file: a half-applied migration is worse than a
      // failed one.
      await sql.begin(async (tx) => {
        await tx.unsafe(body)
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`
      })
    }

    log(`migrations up to date (${files.length} total)`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}
