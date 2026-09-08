/**
 * A channel's two session slots.
 *
 * The platform's rule was one session per channel, full stop, and its two
 * stated reasons were subscriptions we cannot attribute and a chat command with
 * two possible meanings. Giveaways is the case that argued the rule down to its
 * actual content — a three-minute game with its own overlay, its own log and
 * its own keyword has no business stopping a two-hour team battle — so the rule
 * is now one `exclusive` session plus one `companion`.
 *
 * Both original reasons still have to hold, and neither fails loudly:
 *
 *   - a companion ending must not take the primary game's chat feed with it,
 *     which would look like Kick going down mid-hunt;
 *   - two sessions must not share a keyword, or `!enter` means two things in
 *     one chat and entries land in the wrong game.
 *
 * These are the tests for the parts of that reachable without a database.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistry, keywordsFor, sessionKeywords } from '../src/registry.ts'

const registry = buildRegistry()
const games = registry.list()

test('exactly one game claims the companion slot', () => {
  /*
   * Not a limit on how many there could ever be — it is that a second one would
   * need the slot model to grow past two, and the router reads the slots by
   * name in its hottest path. Adding a third is a deliberate change to that
   * code, not something that should arrive with a game.
   */
  const companions = games.filter((g) => g.concurrency === 'companion')

  assert.deepEqual(companions.map((g) => g.id), ['giveaways'])
})

test('every other game is exclusive, whether it says so or not', () => {
  // The field is optional so no existing game had to be edited, which means the
  // default has to be the safe one.
  for (const game of games) {
    if (game.id === 'giveaways') continue
    assert.notEqual(
      game.concurrency,
      'companion',
      `${game.id} would silently start sharing a channel`,
    )
  }
})

test('the companion does not share a keyword with any exclusive game', () => {
  /*
   * The reason the one-session rule existed, enforced instead of assumed.
   *
   * This checks the *defaults*, which is what a streamer gets if they change
   * nothing — a default that collided would make the headline feature (a
   * giveaway inside a bonus hunt) fail on the most common path there is.
   * Per-session collisions are refused at session creation, where the fix is
   * one field on a form the streamer is already looking at.
   */
  const companion = games.find((g) => g.concurrency === 'companion')!
  const mine = sessionKeywords(companion, {})

  const clashes: string[] = []
  for (const game of games) {
    if (game.id === companion.id) continue
    for (const keyword of sessionKeywords(game, defaultsFor(game.id))) {
      if (mine.has(keyword)) clashes.push(`!${keyword}: ${game.id}`)
    }
  }

  assert.deepEqual(clashes, [], `the companion game's defaults collide with: ${clashes.join(', ')}`)
})

test('a themed keyword is what the collision check actually compares', () => {
  /*
   * `sessionKeywords` has to read the session's own config, not the module's
   * declared defaults — otherwise a streamer who renames the giveaway keyword
   * to `!join` gets past the check and then finds their entries joining a
   * tournament.
   */
  const giveaways = registry.require('giveaways')

  assert.ok(sessionKeywords(giveaways, {}).has('drop'))
  assert.ok(sessionKeywords(giveaways, { keyword: 'gates' }).has('gates'))
  assert.ok(!sessionKeywords(giveaways, { keyword: 'gates' }).has('drop'), 'the default is replaced, not added to')

  // And the case the check exists for.
  const tournament = registry.require('slot-tournament')
  const themed = sessionKeywords(giveaways, { keyword: 'join' })
  const theirs = sessionKeywords(tournament, {})
  assert.ok([...themed].some((k) => theirs.has(k)), 'a collision this obvious must be visible to the check')
})

test('keyword overrides are normalised the same way on both sides of the comparison', () => {
  // A stray '!' or some capitals on one side and not the other would make two
  // identical keywords compare as different, which is the quietest possible way
  // for this check to stop working.
  assert.deepEqual(keywordsFor('giveaways', { keyword: '!DROP' }), { enter: ['DROP'] })
  assert.ok(sessionKeywords(registry.require('giveaways'), { keyword: '!DROP' }).has('drop'))
})

test('the setup form beats a saved channel override, and only for the field it owns', () => {
  /*
   * The two sources compose, and the precedence matters: `config.keyword` is
   * the field the streamer just filled in on the setup screen, so it wins over
   * a channel-level override saved weeks ago. Everything the config does not
   * name still falls through to the override, which is how a streamer who
   * renamed `!claim` to `!mine` for their channel keeps it.
   */
  const giveaways = registry.require('giveaways')
  const keywords = sessionKeywords(giveaways, { keyword: 'gates' }, { claim: ['mine'], enter: ['stale'] })

  assert.ok(keywords.has('gates'), 'the setup form wins for the field it owns')
  assert.ok(!keywords.has('stale'), 'the older channel override does not')
  assert.ok(keywords.has('mine'), 'and it still applies to commands the config says nothing about')

  // With no keyword in the config at all — unreachable after a parse, since the
  // schema defaults it — the channel override is the only instruction there is.
  assert.ok(sessionKeywords(giveaways, {}, { enter: ['stale'] }).has('stale'))
})

/** Bonus Hunt has one required field with no sensible default (§13). */
function defaultsFor(gameId: string): Record<string, unknown> {
  if (gameId === 'bonus-hunt') return { startBalance: 1000 }
  if (gameId === 'giveaways') return { prizes: [{ title: 'p' }] }
  return {}
}
