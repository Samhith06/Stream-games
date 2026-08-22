/**
 * Seeds the starter slot catalog.
 *
 * Runs on every release rather than once by hand, because an empty catalog
 * means every `!sr` fails to resolve and that is not a state anyone should be
 * able to deploy into. Safe to re-run: slots upsert on their normalised name,
 * and aliases use ensure() rather than learn() so repeated runs leave their
 * usage statistics alone.
 */

import postgres from 'postgres'
import { createDb } from './client.js'
import { ADVISORY_LOCK_KEY } from './migrate.js'
import { AliasRepository, SlotRepository } from './repositories/slots.js'
import { SEED_SLOTS } from './seed-slots.js'

export async function seed(url: string, log: (msg: string) => void = console.log) {
  // The same lock migrate() uses. Every service runs the release steps, so two
  // seeders would otherwise interleave their upserts against the same rows.
  const lock = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  await lock`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`

  const { db, close } = createDb({ url, max: 1 })
  const slots = new SlotRepository(db)
  const aliases = new AliasRepository(db)

  let created = 0
  for (const entry of SEED_SLOTS) {
    const row = await slots.upsert({ name: entry.name, provider: entry.provider })
    created++
    for (const alias of entry.aliases) {
      await aliases.ensure({ slotId: row.id, alias })
    }
  }

  log(`seeded ${created} slots`)
  await close()
  // Releases the advisory lock with the connection.
  await lock.end({ timeout: 5 })
}
