/**
 * Guards on the hand-maintained starter catalog.
 *
 * The list is edited by people, and the mistakes people make in it are quiet
 * ones: two slots that normalise to the same string, or an alias that could
 * mean either of two games. Neither breaks a build or throws at runtime — the
 * resolver just returns the wrong slot, confidently, in front of a live chat.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
// From dist: repositories/slots.ts uses a TypeScript parameter property, which
// Node's strip-only type stripping cannot parse.
import { SEED_SLOTS } from '../dist/seed-slots.js'
import { normaliseSlotName } from '../dist/repositories/slots.js'

/** Every string the resolver could match, mapped to the slots claiming it. */
function resolutionKeys(): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>()

  const claim = (raw: string, slot: string) => {
    const key = normaliseSlotName(raw)
    if (key === '') return
    if (!keys.has(key)) keys.set(key, new Set())
    keys.get(key)!.add(slot)
  }

  for (const slot of SEED_SLOTS) {
    claim(slot.name, slot.name)
    for (const alias of slot.aliases) claim(alias, slot.name)
  }
  return keys
}

test('no key resolves to two different slots', () => {
  const ambiguous = [...resolutionKeys()]
    .filter(([, owners]) => owners.size > 1)
    .map(([key, owners]) => `"${key}" -> ${[...owners].join(' | ')}`)

  assert.deepEqual(ambiguous, [], `ambiguous resolution keys:\n  ${ambiguous.join('\n  ')}`)
})

test('slot names are unique once normalised', () => {
  const seen = new Map<string, string>()
  for (const slot of SEED_SLOTS) {
    const key = normaliseSlotName(slot.name)
    const previous = seen.get(key)
    assert.equal(previous, undefined, `"${slot.name}" collides with "${previous}"`)
    seen.set(key, slot.name)
  }
})

test('every slot has a name and a provider', () => {
  for (const slot of SEED_SLOTS) {
    assert.ok(slot.name.trim() !== '', 'a slot has an empty name')
    assert.ok(slot.provider.trim() !== '', `${slot.name} has no provider`)
    assert.notEqual(normaliseSlotName(slot.name), '', `${slot.name} normalises to nothing`)
  }
})

test('aliases add reach rather than repeating the name', () => {
  // The resolver already normalises case, spacing and punctuation, so an alias
  // that normalises to its own slot's name is dead weight — it can never match
  // anything the name would have missed.
  for (const slot of SEED_SLOTS) {
    const name = normaliseSlotName(slot.name)
    for (const alias of slot.aliases) {
      assert.notEqual(
        normaliseSlotName(alias),
        name,
        `"${alias}" on ${slot.name} is the name again — the resolver matches that already`,
      )
    }
  }
})

test('the catalog is big enough to be useful on a fresh install', () => {
  // Not a style rule: a streamer's first hunt resolving half of what chat
  // shouts is the difference between the product working and not.
  assert.ok(SEED_SLOTS.length >= 100, `only ${SEED_SLOTS.length} slots seeded`)
  const providers = new Set(SEED_SLOTS.map((s) => s.provider))
  assert.ok(providers.size >= 10, `only ${providers.size} providers represented`)
})
