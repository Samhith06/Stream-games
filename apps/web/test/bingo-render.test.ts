/**
 * The board views, rendered from a projection the real reducer produced.
 *
 * The failure this is written for is field drift. A view reading
 * `state.entryId` against a projection that emits `userId` throws nothing at
 * build time, passes every reducer test, and renders an empty box — or, when
 * the missing field is nested, takes the whole page down with a TypeError that
 * only ever appears in a console nobody has open mid-stream. Nothing catches it
 * except putting the two halves together, which is what this file does.
 *
 * The renderers are pure string functions by design, so no DOM is needed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { GameEngine, type InternalEvent } from '@streamarena/core'
import { slotBingo } from '@streamarena/game-slot-bingo'
import { bingoBoard, bingoJoining, bingoResult, lineRail } from '../public/bingo-view.js'

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }

let seq = 0
const ev = (partial: Record<string, unknown>): InternalEvent =>
  ({ ...partial, seq: ++seq, at: 1_000 + seq }) as InternalEvent

const join = (name: string, slot: string): InternalEvent[] => [
  ev({
    type: 'command',
    command: 'join',
    args: slot,
    raw: `!join ${slot}`,
    actor: { userId: `u-${name}`, username: name, role: 'viewer' },
    messageId: `m-${name}`,
  }),
  ev({
    type: 'slot.resolved',
    query: slot,
    then: { kind: 'pool', userId: `u-${name}` },
    match: { slotId: `slot-${name}`, name: slot, provider: 'Hacksaw Gaming', confidence: 1 },
    suggestions: [],
  }),
]

const control = (action: string, payload: Record<string, unknown> = {}): InternalEvent =>
  ev({ type: 'control', action, payload, actor: OWNER })

/** Folds events through the real engine and hands back both projections. */
function play(events: InternalEvent[]) {
  seq = 0
  const engine = new GameEngine(slotBingo, {
    config: slotBingo.configSchema.parse({ size: 3, openSquares: 0 }),
    init: { sessionId: 's-1', channelId: 'c-1', seed: 'render-seed', startedAt: 1_000, owner: OWNER },
  })

  let state = engine.initialState()
  for (const event of events) state = engine.apply(state, event).state

  return {
    /** What session.html actually receives on the socket. */
    dashboard: engine.projectDashboard(state) as Record<string, any>,
    overlay: engine.project(state) as Record<string, any>,
    raw: state,
  }
}

const nine = () => [
  ...join('ana', 'Slot A'), ...join('ben', 'Slot B'), ...join('cai', 'Slot C'),
  ...join('dee', 'Slot D'), ...join('eli', 'Slot E'), ...join('fay', 'Slot F'),
  ...join('gus', 'Slot G'), ...join('hal', 'Slot H'), ...join('ivy', 'Slot I'),
]

const settle = (squareId: string, x: number) =>
  control('square.result', { squareId, buyCost: 100, payout: 100 * x })

// ─── the board ──────────────────────────────────────────────────────────────

test('a drawn board renders one cell per square, each carrying its id', () => {
  const { dashboard } = play([...nine(), control('draw.run')])
  const html = bingoBoard(dashboard)

  assert.equal(dashboard.squares.length, 9, 'the projection should reach the view at all')
  for (const square of dashboard.squares) {
    assert.ok(html.includes(`${square.id}</span>`), `${square.id} is missing from the board`)
  }
})

test('an unplayed square is a button and a settled one is not', () => {
  // The manual pick has to be reachable, and a settled square must not be
  // clickable — clicking one would re-arm a square chat already watched resolve.
  const drawn = play([...nine(), control('draw.run')])
  const target = drawn.dashboard.squares[0]!.id

  assert.ok(bingoBoard(drawn.dashboard).includes(`data-pickmanual="${target}"`))

  const played = play([...nine(), control('draw.run'), settle(target, 3)])
  const html = bingoBoard(played.dashboard)
  assert.ok(!html.includes(`data-pickmanual="${target}"`), 'a settled square stayed clickable')
})

test('manual picks are off entirely when the config forbids them', () => {
  const { dashboard } = play([...nine(), control('draw.run')])
  assert.ok(!bingoBoard(dashboard, { manualPick: false }).includes('data-pickmanual'))
})

test('a settled square shows its multiplier and its tier colour', () => {
  const { dashboard } = play([...nine(), control('draw.run'), settle('A1', 12.5)])
  const html = bingoBoard(dashboard)

  assert.ok(html.includes('12.50x'), 'the multiplier never reached the cell')
  assert.ok(html.includes('text-win'), 'a green square should be rendered green')
})

// ─── the line rail ──────────────────────────────────────────────────────────

test('every line reaches the rail with a readable label', () => {
  const { dashboard } = play([...nine(), control('draw.run')])
  const html = lineRail(dashboard)

  assert.equal(dashboard.lines.length, 8)
  for (const line of dashboard.lines) {
    assert.ok(line.label, `${line.id} projected without a label`)
    assert.ok(html.includes(line.label), `${line.label} is missing from the rail`)
  }
})

test('a one-away line names the square it still needs', () => {
  // §7 — this is the money state, and the rail exists to make it findable.
  const { dashboard } = play([
    ...nine(), control('draw.run'), settle('A1', 5), settle('B1', 5),
  ])

  const html = lineRail(dashboard)
  assert.ok(html.includes('1 away'), 'a one-away line was not called out')
  assert.ok(html.includes('Need C1'), 'the rail did not say which square is needed')
})

test('a red poisons its lines and the rail marks them dead', () => {
  const { dashboard } = play([...nine(), control('draw.run'), settle('A1', 0)])
  assert.ok(lineRail(dashboard).includes('Dead'))
})

// ─── joining and the result ─────────────────────────────────────────────────

test('the joining panel counts entrants from the projection', () => {
  const { dashboard } = play(nine())
  assert.equal(dashboard.entrantCount, 9)
  assert.ok(bingoJoining(dashboard).includes('9 entrants'))
})

test('a bingo renders as a bingo, with the winners named', () => {
  const { dashboard } = play([
    ...nine(), control('draw.run'), settle('A1', 5), settle('B1', 5), settle('C1', 5),
  ])

  assert.ok(dashboard.bingoLines.length > 0, 'the fixture did not actually produce a bingo')

  const html = bingoResult(dashboard)
  assert.ok(html.includes('BINGO'))
  for (const winner of dashboard.winners) {
    assert.ok(html.includes(winner.username), `${winner.username} won but was not named`)
  }
})

test('a board that ends without a bingo says how it was decided', () => {
  // §8 — "an unexplained winning line reads as broken software."
  const { dashboard } = play([
    ...nine(),
    control('draw.run'),
    // Reds down the main diagonal poison all eight lines, so nothing completes.
    settle('A1', 0), settle('B2', 0), settle('C3', 0),
    settle('B1', 4), settle('C1', 4), settle('A2', 2),
    settle('C2', 2), settle('A3', 1), settle('B3', 1),
  ])

  assert.equal(dashboard.phase, 'complete')
  assert.equal(dashboard.bingoLines.length, 0, 'the fixture produced a bingo it should not have')

  const html = bingoResult(dashboard)
  assert.ok(html.includes('BEST LINE'))
  assert.ok(dashboard.decidedBy, 'the projection did not say how it was decided')
  assert.ok(
    html.includes('multiplier') || html.includes('payout') || html.includes('coin flip') ||
      html.includes('green count') || html.includes('cost'),
    'the result screen did not explain the decision',
  )
})

// ─── the shapes the views assume ────────────────────────────────────────────

test('the dashboard projection carries every field the views read', () => {
  const { dashboard } = play([...nine(), control('draw.run'), settle('A1', 2)])

  for (const key of [
    'phase', 'size', 'squares', 'lines', 'linesAlive', 'linesTotal',
    'squaresPlayed', 'squaresTotal', 'currentSquareId', 'entrantCount',
    'totalSpent', 'totalReturned', 'netPosition', 'drawCompleted', 'unresolved',
  ]) {
    assert.ok(key in dashboard, `session.html reads ${key}, which the projection does not send`)
  }
})

test('the unresolved queue arrives in the shape the shared panel normalises', () => {
  // The panel keys on `entryId ?? userId` and `requestedBy?.username ?? username`.
  // A pool game supplies the second of each pair; losing either blanks the queue.
  const { dashboard } = play([
    ev({
      type: 'command',
      command: 'join',
      args: 'gattes of olympu',
      raw: '!join gattes of olympu',
      actor: { userId: 'u-zed', username: 'zed', role: 'viewer' },
      messageId: 'm-zed',
    }),
    ev({
      type: 'slot.resolved',
      query: 'gattes of olympu',
      then: { kind: 'pool', userId: 'u-zed' },
      match: null,
      suggestions: [{ slotId: 'slot-gates', name: 'Gates of Olympus', provider: 'Pragmatic', confidence: 0.8 }],
    }),
  ])

  assert.equal(dashboard.unresolved.length, 1)
  const item = dashboard.unresolved[0]!
  assert.ok(item.userId, 'the panel has no id to key on')
  assert.ok(item.username, 'the panel has no name to show')
  assert.ok(item.rawText, 'the alias flywheel needs what the viewer typed')
})
