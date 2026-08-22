/**
 * §14 is the game whose fairness IS the product, so most of what's asserted
 * here is about the draw being reproducible, byes being explicit, and every
 * tiebreak stating how it was decided.
 */

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { GameEngine, type Effect, type InternalEvent } from '@streamarena/core'
import { slotTournament } from '../dist/index.js'
import type { TournamentConfig, TournamentState } from '../dist/types.js'

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }

function engine(config: Partial<TournamentConfig> = {}, seed = 'seed-alpha') {
  return new GameEngine(slotTournament, {
    config: slotTournament.configSchema.parse({ seats: 8, ...config }),
    init: {
      sessionId: 'sess-1',
      channelId: 'chan-1',
      seed,
      startedAt: 1_000,
      owner: OWNER,
    },
  })
}

let seq = 0
beforeEach(() => {
  seq = 0
})

function ev(partial: Omit<InternalEvent, 'seq' | 'at'> & { at?: number }): InternalEvent {
  seq += 1
  return { ...partial, seq, at: partial.at ?? 1_000 + seq } as InternalEvent
}

function joinCmd(name: string, slot: string): InternalEvent {
  return ev({
    type: 'command',
    command: 'join',
    args: slot,
    raw: `!join ${slot}`,
    actor: { userId: `u-${name}`, username: name, role: 'viewer' },
    messageId: `m-${name}`,
  })
}

function voteCmd(name: string, choice: string): InternalEvent {
  return ev({
    type: 'command',
    command: 'vote',
    args: choice,
    raw: `!vote ${choice}`,
    actor: { userId: `u-${name}`, username: name, role: 'viewer' },
    messageId: `v-${name}-${choice}`,
  })
}

function resolvedFor(name: string, slotId: string, slotName: string): InternalEvent {
  return ev({
    type: 'slot.resolved',
    query: slotName,
    then: { kind: 'pool', userId: `u-${name}` },
    match: { slotId, name: slotName, provider: 'Hacksaw Gaming', confidence: 1 },
    suggestions: [],
  })
}

function control(action: string, payload: Record<string, unknown> = {}): InternalEvent {
  return ev({ type: 'control', action, payload, actor: OWNER })
}

function run(events: InternalEvent[], config: Partial<TournamentConfig> = {}, seed?: string) {
  const e = engine(config, seed)
  let state = e.initialState()
  const effects: Effect[] = []
  for (const event of events) {
    const folded = e.apply(state, event)
    state = folded.state
    effects.push(...folded.effects)
  }
  return { state, effects }
}

const chatTexts = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { kind: 'chat' }> => e.kind === 'chat').map((e) => e.text)

const announcements = (effects: Effect[]) =>
  effects.filter(
    (e): e is Extract<Effect, { kind: 'chat' }> => e.kind === 'chat' && e.priority === 'announce',
  )

/** Fills a pool of n viewers, each with a distinct resolved slot. */
function poolOf(n: number): InternalEvent[] {
  const events: InternalEvent[] = []
  for (let i = 0; i < n; i++) {
    events.push(joinCmd(`p${i}`, `Slot ${i}`))
    events.push(resolvedFor(`p${i}`, `slot-${i}`, `Slot ${i}`))
  }
  return events
}

test('!join adds to an uncapped pool and asks the catalog to resolve', () => {
  const { state, effects } = run([joinCmd('alice', 'le bandit')])
  assert.equal(state.pool.length, 1)
  assert.equal(state.pool[0]!.slotId, null)
  assert.equal(effects.filter((e) => e.kind === 'lookup').length, 1)
})

test('a duplicate slot claim is rejected IN CHAT, not silently (§14)', () => {
  const { state, effects } = run([
    joinCmd('alice', 'le bandit'),
    resolvedFor('alice', 'slot-1', 'Le Bandit'),
    joinCmd('bob', 'le bandit'),
    resolvedFor('bob', 'slot-1', 'Le Bandit'),
  ])

  assert.equal(state.pool.length, 1)
  assert.equal(state.pool[0]!.username, 'alice')
  assert.match(chatTexts(effects).at(-1)!, /Le Bandit is already claimed by @alice/)
})

test('a second !join replaces the first while the window is open', () => {
  const { state } = run([
    joinCmd('alice', 'le bandit'),
    resolvedFor('alice', 'slot-1', 'Le Bandit'),
    joinCmd('alice', 'mental'),
    resolvedFor('alice', 'slot-2', 'Mental'),
  ])
  assert.equal(state.pool.length, 1)
  assert.equal(state.pool[0]!.slotName, 'Mental')
})

test('reserved seats fill before the random draw and are labelled (§14)', () => {
  const { state } = run([
    ...poolOf(20),
    control('join.close'),
    control('reserve.add', { userId: 'u-p17' }),
    control('reserve.add', { userId: 'u-p18' }),
    control('draw.run'),
  ])

  const reserved = state.entrants.filter((e) => e.source === 'reserved')
  assert.equal(reserved.length, 2)
  assert.deepEqual(
    reserved.map((e) => e.username).sort(),
    ['p17', 'p18'],
  )
  assert.equal(state.entrants.length, 8)
})

test('the same seed always draws the same eight; a different seed does not', () => {
  const script = [...poolOf(30), control('join.close'), control('draw.run')]

  const a = run(script, {}, 'seed-alpha')
  seq = 0
  const b = run(script, {}, 'seed-alpha')
  seq = 0
  const c = run(script, {}, 'seed-beta')

  const names = (s: TournamentState) => s.entrants.map((e) => e.username).sort().join(',')
  assert.equal(names(a.state), names(b.state))
  assert.notEqual(names(a.state), names(c.state))
})

test('the draw cannot be re-rolled (§14 — the fairness is the product)', () => {
  const first = run([...poolOf(20), control('join.close'), control('draw.run')])
  const firstNames = first.state.entrants.map((e) => e.username).join(',')

  seq = 0
  const again = run([
    ...poolOf(20),
    control('join.close'),
    control('draw.run'),
    control('draw.run'),
  ])

  assert.equal(again.state.entrants.map((e) => e.username).join(','), firstNames)
})

test('12 seats produce a 16 bracket with exactly 4 explicit byes (§14)', () => {
  const { state } = run([...poolOf(20), control('join.close'), control('draw.run')], { seats: 12 })

  assert.equal(state.entrants.length, 12)
  assert.equal(state.bracketSize, 16)
  assert.equal(state.rounds.length, 4)

  const byeMatches = state.rounds[0]!.matches.filter((m) => m.b === 'bye')
  assert.equal(byeMatches.length, 4)
  assert.ok(byeMatches.every((m) => m.decidedBy === 'bye'))
  assert.equal(state.entrants.filter((e) => e.hasBye).length, 4)

  // §14 — 11 real matches for a 12-player bracket.
  const real = state.rounds.flatMap((r) => r.matches).filter((m) => m.b !== 'bye').length
  assert.equal(real, 11)
})

test('byes are not systematically handed to the streamer picks', () => {
  // Reserved picks are drawn first; if seeding followed draw order they would
  // take every bye, which would read as a rig.
  const { state } = run(
    [
      ...poolOf(20),
      control('join.close'),
      control('reserve.add', { userId: 'u-p0' }),
      control('reserve.add', { userId: 'u-p1' }),
      control('reserve.add', { userId: 'u-p2' }),
      control('reserve.add', { userId: 'u-p3' }),
      control('draw.run'),
    ],
    { seats: 12 },
  )

  const reservedWithBye = state.entrants.filter((e) => e.source === 'reserved' && e.hasBye).length
  assert.ok(reservedWithBye < 4, `all four byes went to reserved picks (${reservedWithBye})`)
})

test('higher multiplier wins, not higher payout (§14)', () => {
  const setup = [...poolOf(8), control('join.close'), control('draw.run')]
  const { state } = run([
    ...setup,
    control('match.startVoting'),
    control('match.lockVoting'),
    // A: 100 -> 425 = 4.25x. B: 200 -> 610 = 3.05x. B paid more, A wins.
    control('match.result', { aBuyCost: 100, aPayout: 425, bBuyCost: 200, bPayout: 610 }),
  ])

  const first = state.rounds[0]!.matches[0]!
  assert.equal(first.winner, 'a')
  assert.equal(first.decidedBy, 'multiplier')
  assert.equal(first.a!.multiplier, 4.25)
})

test('two dead bonuses resolve down the ladder and say how (§14)', () => {
  const setup = [...poolOf(8), control('join.close'), control('draw.run')]

  // Equal multiplier (0), equal payout (0), different cost -> lower cost wins.
  const cheaper = run([
    ...setup,
    control('match.startVoting'),
    control('match.lockVoting'),
    control('match.result', { aBuyCost: 200, aPayout: 0, bBuyCost: 100, bPayout: 0 }),
  ])
  const m1 = cheaper.state.rounds[0]!.matches[0]!
  assert.equal(m1.winner, 'b')
  assert.equal(m1.decidedBy, 'cost')

  // Identical in every respect -> seeded coin flip, and it says so.
  seq = 0
  const flipped = run([
    ...setup,
    control('match.startVoting'),
    control('match.lockVoting'),
    control('match.result', { aBuyCost: 100, aPayout: 0, bBuyCost: 100, bPayout: 0 }),
  ])
  const m2 = flipped.state.rounds[0]!.matches[0]!
  assert.ok(m2.winner === 'a' || m2.winner === 'b')
  assert.equal(m2.decidedBy, 'coinflip')
})

test('a zero buy cost is refused rather than dividing by zero (§14)', () => {
  const { state, effects } = run([
    ...poolOf(8),
    control('join.close'),
    control('draw.run'),
    control('match.startVoting'),
    control('match.lockVoting'),
    control('match.result', { aBuyCost: 0, aPayout: 100, bBuyCost: 100, bPayout: 50 }),
  ])

  assert.equal(state.rounds[0]!.matches[0]!.winner, null)
  const errors = effects.filter(
    (e) => e.kind === 'broadcast' && 'inputError' in (e.patch as object),
  )
  assert.equal(errors.length, 1)
})

test('votes are silent, scored on decision, and !vote accepts a slot name', () => {
  const { state, effects } = run([
    ...poolOf(8),
    control('join.close'),
    control('draw.run'),
    control('match.startVoting'),
    voteCmd('fan1', 'a'),
    voteCmd('fan2', 'b'),
    control('match.lockVoting'),
    control('match.result', { aBuyCost: 100, aPayout: 400, bBuyCost: 100, bPayout: 100 }),
  ])

  assert.equal(state.scores['u-fan1']!.correct, 1)
  assert.equal(state.scores['u-fan2']!.correct, 0)
  assert.equal(state.scores['u-fan2']!.total, 1)
  // 400 votes would drown the channel — the overlay's split bar is the feedback.
  assert.deepEqual(chatTexts(effects).filter((t) => t.includes('fan1')), [])
})

test('votes cast after the lock are rejected', () => {
  const { state } = run([
    ...poolOf(8),
    control('join.close'),
    control('draw.run'),
    control('match.startVoting'),
    control('match.lockVoting'),
    voteCmd('late', 'a'),
  ])
  assert.equal(Object.keys(state.rounds[0]!.matches[0]!.votes).length, 0)
})

test('a full 8-seat bracket crowns a champion and a top predictor (§14)', () => {
  const events: InternalEvent[] = [...poolOf(8), control('join.close'), control('draw.run')]

  // Seven matches: open voting, one viewer always backs A, then resolve for A.
  for (let i = 0; i < 7; i++) {
    events.push(control('match.startVoting'))
    events.push(voteCmd('oracle', 'a'))
    events.push(control('match.lockVoting'))
    events.push(control('match.result', { aBuyCost: 100, aPayout: 500, bBuyCost: 100, bPayout: 100 }))
  }

  const { state, effects } = run(events)

  assert.equal(state.phase, 'complete')
  assert.ok(state.champion)
  assert.equal(state.topPredictor?.username, 'oracle')
  assert.equal(state.topPredictor?.correct, 7)

  const announced = announcements(effects).map((a) => a.text)
  // Draw announcement, champion, top predictor — three, never merged (§15.4).
  assert.equal(announced.length, 3)
  assert.match(announced[1]!, /wins the tournament!/)
  assert.match(announced[2]!, /Best predictor: @oracle with 7\/7/)
})

test('the draw announcement stays inside 500 characters with 16 entrants (§15.4)', () => {
  const events = [...poolOf(40), control('join.close'), control('draw.run')]
  const { effects } = run(events, { seats: 16 })

  const drawMsg = announcements(effects)[0]!
  assert.ok(drawMsg.text.length <= 500, `draw announcement was ${drawMsg.text.length} chars`)
  assert.match(drawMsg.text, /Tournament locked in! 16 entrants/)
})

test('reverting a match restores its votes and recomputes scores (§14)', () => {
  const setup = [...poolOf(8), control('join.close'), control('draw.run')]
  const { state } = run([
    ...setup,
    control('match.startVoting'),
    voteCmd('fan1', 'a'),
    control('match.lockVoting'),
    control('match.result', { aBuyCost: 100, aPayout: 400, bBuyCost: 100, bPayout: 100 }),
    control('match.revert', { matchId: 'r0m0' }),
  ])

  const m = state.rounds[0]!.matches[0]!
  assert.equal(m.winner, null)
  assert.equal(m.a!.payout, null)
  // Votes survive the revert — the viewer predicted, the streamer mistyped.
  assert.equal(Object.keys(m.votes).length, 1)
  // Nothing decided means nothing scored.
  assert.equal(state.scores['u-fan1'], undefined)
})

test('abandoning mid-bracket still announces the prediction leaderboard (§14)', () => {
  const { state, effects } = run([
    ...poolOf(8),
    control('join.close'),
    control('draw.run'),
    control('match.startVoting'),
    voteCmd('fan1', 'a'),
    control('match.lockVoting'),
    control('match.result', { aBuyCost: 100, aPayout: 400, bBuyCost: 100, bPayout: 100 }),
    control('tournament.abandon'),
  ])

  assert.equal(state.champion, null)
  assert.equal(state.topPredictor?.username, 'fan1')
  assert.match(announcements(effects).at(-1)!.text, /best predictor/i)
})

test('replaying the log reaches the same champion (§9)', () => {
  const events: InternalEvent[] = [...poolOf(12), control('join.close'), control('draw.run')]
  for (let i = 0; i < 7; i++) {
    events.push(control('match.startVoting'))
    events.push(control('match.lockVoting'))
    events.push(control('match.result', { aBuyCost: 100, aPayout: 0, bBuyCost: 100, bPayout: 0 }))
  }

  const live = run(events)
  const replayed = engine().replay(events)

  assert.deepEqual(replayed.state, live.state)
  assert.equal(
    (replayed.state as TournamentState).champion?.username,
    live.state.champion?.username,
  )
})

test('the overlay projection carries no user ids (§19)', () => {
  const { state } = run([...poolOf(8), control('join.close'), control('draw.run')])
  const projected = JSON.stringify(slotTournament.project(state))
  assert.ok(!projected.includes('u-p0'))

  const dash = JSON.stringify(slotTournament.projectDashboard!(state))
  assert.ok(dash.includes('u-p0')) // the dashboard needs them to reserve seats
})
