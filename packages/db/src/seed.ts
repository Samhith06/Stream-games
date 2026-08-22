/**
 * Seeds the starter slot catalog. Safe to re-run: slots upsert on their
 * normalised name and aliases on (normalised, slot_id).
 */

import { createDb } from './client.js'
import { AliasRepository, SlotRepository } from './repositories/slots.js'
import { SEED_SLOTS } from './seed-slots.js'

export async function seed(url: string, log: (msg: string) => void = console.log) {
  const { db, close } = createDb({ url, max: 1 })
  const slots = new SlotRepository(db)
  const aliases = new AliasRepository(db)

  let created = 0
  for (const entry of SEED_SLOTS) {
    const row = await slots.upsert({ name: entry.name, provider: entry.provider })
    created++
    for (const alias of entry.aliases) {
      await aliases.learn({ slotId: row.id, alias, source: 'manual', approved: true })
    }
  }

  log(`seeded ${created} slots`)
  await close()
}
