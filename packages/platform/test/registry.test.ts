/**
 * Contract checks that apply to every registered game, not to any one of them.
 *
 * These exist because the failures they catch are silent. A game whose
 * dashboard projection replaces the overlay's instead of extending it builds
 * clean, passes its own tests, and then shows the streamer an empty page — the
 * only symptom is a screen with nothing on it, which reads as a network problem
 * rather than a missing spread operator.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistry } from '../src/registry.ts'

const registry = buildRegistry()
const games = registry.list()

test('every game is registered under the id it declares', () => {
  for (const game of games) {
    assert.equal(registry.require(game.id).id, game.id)
  }
})

test("a game's dashboard projection extends the overlay's rather than replacing it", () => {
  /*
   * The dashboard is the overlay plus the controls. Dropping a key here means
   * the streamer's own screen is missing something their viewers can see, and
   * the phase key going missing takes the entire render with it.
   */
  for (const game of games) {
    const config = game.configSchema.parse(defaultsFor(game.id))
    const state = game.initialState(config, { now: 1_700_000_000_000, seed: 'contract-test' })

    const overlay = game.project(state) as Record<string, unknown>
    const dashboard = game.projectDashboard!(state) as Record<string, unknown>

    const missing = Object.keys(overlay).filter((key) => !(key in dashboard))
    assert.deepEqual(missing, [], `${game.id} drops from its dashboard projection: ${missing.join(', ')}`)
  }
})

test('every game projects the phase it reports', () => {
  // The clients switch on `phase` before anything else, so a projection without
  // one renders the joining screen forever.
  for (const game of games) {
    const config = game.configSchema.parse(defaultsFor(game.id))
    const state = game.initialState(config, { now: 1_700_000_000_000, seed: 'contract-test' })

    const overlay = game.project(state) as Record<string, unknown>
    assert.equal(overlay.phase, game.phaseOf(state), `${game.id} projects a phase that isn't its own`)
  }
})

test('no two games claim the same command keyword', () => {
  // Not fatal — commands are resolved per session — but a shared keyword means
  // a streamer who runs two games back to back teaches chat the wrong verb.
  const seen = new Map<string, string>()
  const clashes: string[] = []

  for (const game of games) {
    for (const command of game.commands) {
      for (const keyword of command.keywords) {
        const owner = seen.get(keyword)
        if (owner && owner !== game.id) clashes.push(`!${keyword}: ${owner} and ${game.id}`)
        else seen.set(keyword, game.id)
      }
    }
  }

  // Recorded rather than forbidden: `!join` is deliberately shared by the two
  // pool games, and it should mean the same thing in both.
  assert.deepEqual(
    clashes,
    [
      // Shared on purpose: Tournament, Bingo and Team Battles all use the same
      // entry verb because §5 wants nothing new for a viewer to learn. It has
      // to mean the same thing in all three.
      '!join: slot-tournament and slot-bingo',
      '!enter: slot-tournament and slot-bingo',
      '!join: slot-tournament and team-battles',
      '!enter: slot-tournament and team-battles',
    ],
    'a new keyword clash appeared — either rename it or record it here on purpose',
  )
})

/** Bonus Hunt has one required field with no sensible default (§13). */
function defaultsFor(gameId: string): Record<string, unknown> {
  return gameId === 'bonus-hunt' ? { startBalance: 1000 } : {}
}
