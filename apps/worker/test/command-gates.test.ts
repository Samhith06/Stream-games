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
import { GATED_COMMANDS, gatesFor } from '../src/command-gates.ts'

const games = buildRegistry().list()

/** Config keys a game exposes that look like a role gate. */
function gateKeys(schema: unknown): string[] {
  // Schemas wrap in ZodEffects once they use .superRefine().
  const inner =
    schema instanceof z.ZodEffects ? (schema.innerType() as unknown) : schema
  if (!(inner instanceof z.ZodObject)) return []
  return Object.keys(inner.shape as Record<string, unknown>).filter((k) => k.endsWith('Gate'))
}

test('every gate a game offers is mapped to a command', () => {
  const unmapped: string[] = []

  for (const game of games) {
    for (const key of gateKeys(game.configSchema)) {
      if (!GATED_COMMANDS[key]) unmapped.push(`${game.id}: ${key}`)
    }
  }

  assert.deepEqual(
    unmapped,
    [],
    `these gates are on a setup screen but restrict nothing:\n  ${unmapped.join('\n  ')}`,
  )
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
