/**
 * Slot Bingo — the loop that decides who wins.
 *
 * Weighted toward resolution rather than plumbing: a board that mis-scores a
 * line names the wrong winner in front of a live chat, and unlike a crash it
 * produces no error anyone can point at.
 */

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { GameEngine, type Effect, type InternalEvent } from '@streamarena/core'
import { slotBingo } from '../dist/index.js'
import type { BingoConfig } from '../dist/types.js'

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }

function engine(config: Partial<BingoConfig> = {}, seed = 'seed-alpha') {
  return new GameEngine(slotBingo, {
    config: slotBingo.configSchema.parse({ size: 3, openSquares: 0, ...config }),
    init: { sessionId: 's-1', channelId: 'c-1', seed, startedAt: 1_000, owner: OWNER },
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

const joinCmd = (name: string, slot: string): InternalEvent =>
  ev({
    type: 'command',
    command: 'join',
    args: slot,
    raw: `!join ${slot}`,
    actor: { userId: `u-${name}`, username: name, role: 'viewer' },
    messageId: `m-${name}`,
  })

const resolvedFor = (name: string, slotId: string, slotName: string): InternalEvent =>
  ev({
    type: 'slot.resolved',
    query: slotName,
    then: { kind: 'pool', userId: `u-${name}` },
    match: { slotId, name: slotName, provider: 'Hacksaw Gaming', confidence: 1 },
    suggestions: [],
  })

const control = (action: string, payload: Record<string, unknown> = {}): InternalEvent =>
  ev({ type: 'control', action, payload, actor: OWNER })

function run(events: InternalEvent[], config: Partial<BingoConfig> = {}, seed?: string) {
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
  effects
    .filter((e): e is Extract<Effect, { kind: 'chat' }> => e.kind === 'chat')
    .map((e) => e.text)

const announcements = (effects: Effect[]) =>
  effects
    .filter(
      (e): e is Extract<Effect, { kind: 'chat' }> => e.kind === 'chat' && e.priority === 'announce',
    )
    .map((e) => e.text)

/** n viewers, each with a distinct resolved slot. */
function poolOf(n: number): InternalEvent[] {
  const events: InternalEvent[] = []
  for (let i = 0; i < n; i++) {
    events.push(joinCmd(`p${i}`, `Slot ${i}`), resolvedFor(`p${i}`, `slot-${i}`, `Slot ${i}`))
  }
  return events
}

/** Plays a square to a given multiplier at a buy of 100. */
const result = (squareId: string, multiplier: number): InternalEvent =>
  control('square.result', { squareId, buyCost: 100, payout: 100 * multiplier })

// ─── the draw ───────────────────────────────────────────────────────────────

test('the draw fills every square and commits an order', () => {
  const { state } = run([...poolOf(9), control('draw.run')])

  assert.equal(state.drawCompleted, true)
  assert.equal(state.squares.filter((s) => s.owner === 'viewer').length, 9)
  assert.equal(new Set(state.pickOrder).size, 9)
})

test('the same seed draws the same board', () => {
  // §5.1 — the draw runs once, no re-roll button anywhere, so a replay has to
  // reach the same board or "the draw was rigged" has no answer.
  const events = [...poolOf(9), control('draw.run')]
  const a = run(events, {}, 'seed-x')
  const b = run(events, {}, 'seed-x')

  assert.deepEqual(
    a.state.squares.map((s) => `${s.id}:${s.username}`),
    b.state.squares.map((s) => `${s.id}:${s.username}`),
  )
  assert.deepEqual(a.state.pickOrder, b.state.pickOrder)
})

test('a duplicate slot is rejected in chat, not silently dropped', () => {
  // §4 — a silently dropped join leaves the viewer believing they are entered
  // right up until the draw passes them by.
  const { effects } = run([
    joinCmd('alice', 'Le Bandit'),
    resolvedFor('alice', 'slot-1', 'Le Bandit'),
    joinCmd('bob', 'Le Bandit'),
    resolvedFor('bob', 'slot-1', 'Le Bandit'),
  ])

  assert.ok(chatTexts(effects).some((t) => /already claimed by @alice/.test(t)))
})

// ─── results and tiers ──────────────────────────────────────────────────────

test('the multiplier is computed from the two numbers entered', () => {
  const { state } = run([...poolOf(9), control('draw.run'), result('A1', 4.25)])
  const square = state.squares.find((s) => s.id === 'A1')!

  assert.equal(square.attempts[0]!.multiplier, 4.25)
  assert.equal(square.tier, 'green')
  assert.equal(square.status, 'settled')
})

test('a zero buy cost is refused; a zero payout is fine', () => {
  // §6 — "buy cost must exceed zero. Payout of zero is valid and common."
  const zeroBuy = run([
    ...poolOf(9),
    control('draw.run'),
    control('square.result', { squareId: 'A1', buyCost: 0, payout: 100 }),
  ])
  assert.equal(zeroBuy.state.squares.find((s) => s.id === 'A1')!.status, 'unplayed')

  const zeroPayout = run([
    ...poolOf(9),
    control('draw.run'),
    control('square.result', { squareId: 'A1', buyCost: 100, payout: 0 }),
  ])
  const square = zeroPayout.state.squares.find((s) => s.id === 'A1')!
  assert.equal(square.tier, 'red')
  assert.equal(square.attempts[0]!.multiplier, 0)
})

// ─── line arithmetic ────────────────────────────────────────────────────────

test('a red kills every line through it', () => {
  const { state } = run([...poolOf(9), control('draw.run'), result('B2', 0)])

  // B2 on a 3x3 is the centre: its row, its column and both diagonals.
  const dead = state.lines
    .filter((l) => l.state === 'dead')
    .map((l) => l.id)
    .sort()
  assert.deepEqual(dead, ['col2', 'diagA', 'diagB', 'row2'])
})

test('a line one square from home reports one-away, loudly', () => {
  // §7 — "if the overlay renders nothing else well, render this."
  const { state, effects } = run([
    ...poolOf(9),
    control('draw.run'),
    result('A1', 2),
    result('B1', 2),
  ])

  assert.equal(state.lines.find((l) => l.id === 'row1')!.state, 'oneAway')
  assert.ok(announcements(effects).some((t) => /one away/i.test(t)))
})

// ─── resolution ─────────────────────────────────────────────────────────────

test('a completed line is an instant bingo and ends the board', () => {
  const { state, effects } = run([
    ...poolOf(9),
    control('draw.run'),
    result('A1', 2),
    result('B1', 2),
    result('C1', 2),
  ])

  assert.equal(state.phase, 'complete')
  assert.deepEqual(state.bingoLines, ['row1'])
  assert.equal(state.decidedBy, 'bingo')
  assert.equal(state.winners.length, 3, 'everyone on the line wins')
  assert.ok(announcements(effects).some((t) => /BINGO/.test(t)))
})

test('one square completing two lines announces both', () => {
  // §8 — "don't pick one." A3 sits on row 3 and the anti-diagonal.
  const { state } = run([
    ...poolOf(9),
    control('draw.run'),
    result('B3', 2),
    result('C3', 2),
    result('B2', 2),
    result('C1', 2),
    result('A3', 2),
  ])

  assert.equal(state.phase, 'complete')
  assert.deepEqual(state.bingoLines.slice().sort(), ['diagB', 'row3'])
})

test('a full board with no bingo resolves on best line, and says how', () => {
  const { state } = run([
    ...poolOf(9),
    control('draw.run'),
    // Reds down the main diagonal, which is the cheapest way to poison all
    // eight lines: A1 takes row 1 and column 1, B2 takes row 2, column 2 and
    // both diagonals, C3 takes row 3 and column 3.
    result('A1', 0),
    result('B1', 5),
    result('C1', 5),
    result('A2', 3),
    result('B2', 0),
    result('C2', 3),
    result('A3', 2),
    result('B3', 2),
    result('C3', 0),
  ])

  assert.equal(
    state.lines.filter((l) => l.state === 'dead').length,
    8,
    'every line should carry a red, or this is not testing best line',
  )

  assert.equal(state.phase, 'complete')
  assert.equal(state.bingoLines.length, 0)
  assert.ok(state.winningLine, 'a winning line is named')
  assert.ok(state.decidedBy, 'and how it was decided')
})

test('settling early only considers lines that are fully played', () => {
  // §8 — "a line with unplayed squares cannot win a settle."
  const { state } = run([
    ...poolOf(9),
    control('draw.run'),
    result('A1', 2),
    result('B1', 2),
    result('C1', 0), // row 1 fully played, and dead
    control('board.settleEarly'),
  ])

  assert.equal(state.settledEarly, true)
  assert.equal(state.decidedBy, 'settledEarly')
  assert.equal(state.winningLine, 'row1', 'the only fully-played line')
})

// ─── ownership ──────────────────────────────────────────────────────────────

test('house squares play and colour but have nobody to pay', () => {
  // §5.4 — "if a winning line contains house squares, only the viewer-owned
  // squares in it take the prize."
  const short = run([...poolOf(8), control('draw.run')])
  const openId = short.state.squares.find((s) => s.owner === 'open')!.id

  const { state } = run([
    ...poolOf(8),
    control('draw.run'),
    control('square.fillHouse', { squareId: openId, slotName: 'House Slot' }),
  ])

  const house = state.squares.find((s) => s.owner === 'house')!
  assert.ok(house, 'the unfilled square became house')
  assert.equal(house.userId, null)
})

test('the free centre is a green nobody owns', () => {
  // §7 — the four lines through it then need four greens, not five.
  const { state } = run([...poolOf(24), control('draw.run')], {
    size: 5,
    openSquares: 0,
    freeCentre: true,
  })

  const centre = state.squares.find((s) => s.id === 'C3')!
  assert.equal(centre.owner, 'free')
  assert.equal(centre.tier, 'green')
  assert.equal(centre.userId, null)
})

test('a join after the draw is acknowledged, never rejected', () => {
  // §4 — the busiest moment for a join is the reveal animation, which is
  // exactly when the board has just filled.
  const { effects } = run(
    [
      ...poolOf(8),
      control('draw.run'),
      joinCmd('latecomer', 'Late Slot'),
      resolvedFor('latecomer', 'slot-late', 'Late Slot'),
    ],
    { size: 3, openSquares: 1 },
  )

  assert.ok(
    chatTexts(effects).some((t) => /standby draw/i.test(t)),
    `expected a standby ack, got: ${chatTexts(effects).join(' | ')}`,
  )
})

// ─── revert ─────────────────────────────────────────────────────────────────

test('revert pops the attempt and recomputes lines from scratch', () => {
  // §9 — a mistyped payout does not flip one square, it can resurrect or kill
  // four lines at once.
  const { state } = run([
    ...poolOf(9),
    control('draw.run'),
    result('B2', 0), // centre red kills four lines
    control('square.revert', { squareId: 'B2' }),
  ])

  const square = state.squares.find((s) => s.id === 'B2')!
  assert.equal(square.status, 'unplayed')
  assert.equal(square.attempts.length, 0)
  assert.equal(state.lines.filter((l) => l.state === 'dead').length, 0, 'the lines came back')
})

test('revert is blocked once the board is complete', () => {
  // A green that already fired a bingo and named winners in chat is not an
  // edit; that is bingo.abandon.
  const { state } = run([
    ...poolOf(9),
    control('draw.run'),
    result('A1', 2),
    result('B1', 2),
    result('C1', 2),
    control('square.revert', { squareId: 'C1' }),
  ])

  assert.equal(state.phase, 'complete')
  assert.equal(state.squares.find((s) => s.id === 'C1')!.status, 'settled')
})

// ─── projection ─────────────────────────────────────────────────────────────

test('the overlay projection carries no user ids', () => {
  // §19 — usernames only, because that is what goes on stream.
  const { state } = run([...poolOf(9), control('draw.run'), result('A1', 3)])
  const json = JSON.stringify(slotBingo.project(state))

  assert.ok(!json.includes('u-p0'), 'a viewer id leaked into the overlay projection')
  assert.ok(json.includes('p0'), 'usernames should still be there')
})

test('the projection carries the running P&L and the tension meter', () => {
  const { state } = run([
    ...poolOf(9),
    control('draw.run'),
    result('A1', 3), // 100 in, 300 out
    result('B2', 0), // 100 in, 0 out — kills four lines
  ])

  const view = slotBingo.project(state) as Record<string, unknown>
  assert.equal(view.totalSpent, 200)
  assert.equal(view.totalReturned, 300)
  assert.equal(view.netPosition, 100)
  assert.equal(view.linesTotal, 8)
  assert.equal(view.linesAlive, 4, 'the centre red took four of the eight')
})
