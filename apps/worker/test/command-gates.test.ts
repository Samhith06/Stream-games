/**
 * Every gate a setup screen offers must actually restrict something.
 *
 * This is written for a failure that is pure silence. Team Battles' `sideGate`
 * was in the config schema and on the setup form, the streamer set it to
 * subscribers, the summary reported it — and every viewer could still declare a
 * side, because nothing mapped that field onto a command. Nothing threw,
 * nothing logged, and the only way to notice was to watch a non-subscriber be
 * accepted.
 *
 * So the check runs the other way round: take what the games advertise, and
 * insist the runtime knows what to do with all of it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { buildRegistry } from '../../../packages/platform/src/registry.ts'
import {
  GATED_COMMANDS,
  KEYWORD_FIELDS,
  SELF_ENFORCED_GATES,
  gatesFor,
  keywordsFor,
} from '../src/command-gates.ts'

const games = buildRegistry().list()

/** Config keys a game exposes that look like a role gate. */
function gateKeys(schema: unknown): string[] {
  // Schemas wrap in ZodEffects once they use .superRefine().
  const inner =
    schema instanceof z.ZodEffects ? (schema.innerType() as unknown) : schema
  if (!(inner instanceof z.ZodObject)) return []
  return Object.keys(inner.shape as Record<string, unknown>).filter((k) => k.endsWith('Gate'))
}

test('every gate a game offers is mapped to a command, or exempted on the record', () => {
  const unmapped: string[] = []

  for (const game of games) {
    for (const key of gateKeys(game.configSchema)) {
      if (GATED_COMMANDS[key]) continue
      // An exemption is allowed, but only a written one. Silence is the
      // failure mode this whole file exists to catch.
      if (SELF_ENFORCED_GATES[`${game.id}.${key}`]) continue
      unmapped.push(`${game.id}: ${key}`)
    }
  }

  assert.deepEqual(
    unmapped,
    [],
    `these gates are on a setup screen but restrict nothing:\n  ${unmapped.join('\n  ')}`,
  )
})

test('an exempted gate names a real field on a real game', () => {
  // Otherwise the exemption outlives the field it excused and starts excusing
  // the next thing that happens to be called entryGate.
  const dangling = Object.keys(SELF_ENFORCED_GATES).filter((entry) => {
    const [gameId, key] = entry.split('.')
    const game = games.find((g) => g.id === gameId)
    return !game || !gateKeys(game.configSchema).includes(key!)
  })

  assert.deepEqual(dangling, [], `exemptions for gates that no longer exist: ${dangling.join(', ')}`)
})

test('every keyword field a game offers renames a command that game has', () => {
  // Same failure shape as the gates, one field over: the streamer sets !drop,
  // the overlay says !drop, and the parser is still listening for !enter.
  const broken: string[] = []

  for (const [gameId, fields] of Object.entries(KEYWORD_FIELDS)) {
    const game = games.find((g) => g.id === gameId)
    if (!game) {
      broken.push(`${gameId}: no such game`)
      continue
    }
    for (const [field, command] of Object.entries(fields)) {
      const inner =
        game.configSchema instanceof z.ZodEffects
          ? (game.configSchema.innerType() as unknown)
          : (game.configSchema as unknown)
      const shape = inner instanceof z.ZodObject ? (inner.shape as Record<string, unknown>) : {}
      if (!(field in shape)) broken.push(`${gameId}: no config field '${field}'`)
      if (!game.commands.some((c) => c.id === command)) {
        broken.push(`${gameId}: no command '${command}'`)
      }
    }
  }

  assert.deepEqual(broken, [], broken.join('\n  '))
})

test('a themed keyword reaches the parser, with or without the prefix', () => {
  assert.deepEqual(keywordsFor('giveaways', { keyword: 'drop' }), { enter: ['drop'] })
  // A streamer who types the ! anyway must not end up with a '!!drop' command
  // nobody in chat can reach.
  assert.deepEqual(keywordsFor('giveaways', { keyword: '!gates' }), { enter: ['gates'] })
  // Unset means the game's own default, not an empty keyword that matches
  // every bare '!'.
  assert.deepEqual(keywordsFor('giveaways', {}), {})
  assert.deepEqual(keywordsFor('giveaways', { keyword: '  ' }), {})
  assert.deepEqual(keywordsFor('bonus-hunt', { keyword: 'drop' }), {})
})

test('every mapped gate names a command some game actually has', () => {
  // The other direction: a mapping onto a command nobody exposes is dead
  // config, and would quietly stop working if a command were ever renamed.
  const known = new Set(games.flatMap((g) => g.commands.map((c) => c.id)))
  const dangling = Object.entries(GATED_COMMANDS)
    .filter(([, command]) => !known.has(command))
    .map(([key, command]) => `${key} -> ${command}`)

  assert.deepEqual(dangling, [], `mapped onto commands that do not exist: ${dangling.join(', ')}`)
})

test('a gate set in config reaches the command settings', () => {
  const settings = gatesFor({ joinGate: 'followers', sideGate: 'subscribers' })

  assert.deepEqual(settings.join, { gate: 'followers' })
  assert.deepEqual(settings.side, { gate: 'subscribers' })
})

test('an unset gate leaves the command alone', () => {
  // Absent must mean "the game's own default", not an empty gate that
  // accidentally denies everyone.
  const settings = gatesFor({ joinGate: 'anyone' })

  assert.deepEqual(settings.join, { gate: 'anyone' })
  assert.equal(settings.side, undefined)
  assert.equal(settings.sr, undefined)
})

test("'nobody' switches the command off rather than gating it to a role", () => {
  // It is not a role, so it cannot be one. Disabling routes it through the
  // router's own "this command is off" path and the denial reads correctly.
  const settings = gatesFor({ sideGate: 'nobody' })

  assert.deepEqual(settings.side, { enabled: false })
  assert.equal(settings.side!.gate, undefined, 'no impossible role is invented')
})

test('a real role still gates rather than disables', () => {
  const settings = gatesFor({ sideGate: 'subscribers' })
  assert.deepEqual(settings.side, { gate: 'subscribers' })
})

test('Team Battles offers a side gate, and it is wired', () => {
  // The specific regression. §7 gates who may declare an allegiance.
  const battles = games.find((g) => g.id === 'team-battles')!
  assert.ok(gateKeys(battles.configSchema).includes('sideGate'))
  assert.equal(GATED_COMMANDS.sideGate, 'side')
  assert.ok(
    battles.commands.some((c) => c.id === 'side'),
    'the command the gate points at must exist on the game',
  )
})
