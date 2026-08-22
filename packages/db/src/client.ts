import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDb>['db']

export interface DbOptions {
  url: string
  /**
   * `web` stays responsive and does almost no work, so it needs few
   * connections; `worker` does all the game logic. Sized separately (§8).
   */
  max?: number
  onNotice?: (notice: unknown) => void
}

export function createDb(opts: DbOptions) {
  const sql = postgres(opts.url, {
    max: opts.max ?? 10,
    // Prepared statements are disabled because managed PaaS Postgres commonly
    // sits behind a transaction-mode pooler, where they silently break.
    prepare: false,
    onnotice: opts.onNotice ?? (() => {}),
  })
  const db = drizzle(sql, { schema })
  return { db, sql, close: () => sql.end({ timeout: 5 }) }
}

export { schema }
