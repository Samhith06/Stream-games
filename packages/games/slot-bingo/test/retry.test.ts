/**
 * Slot Bingo — the retry dial under Model B, the re-entry draw (§6.5).
 *
 * "Green locks you in. Red puts you back in the draw."
 *
 * The rules these pin down are the ones a live chat will argue about: who
 * loses a square, who gets it next, when the board ends, and who is paid.
 */

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { GameEngine, type Effect, type InternalEvent } from '@streamarena/core'
import { slotBingo } from '../dist/index.js'
import { bestLine } from '../dist/lines.js'
import type { BingoConfig, BingoState } from '../dist/types.js'

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }

/** Endless re-entry on a 3×3 unless a test says otherwise. */
const ENDLESS: Partial<BingoConfig> = {
  size: 3,
  openSquares: 0,
  retriesPerSquare: null,
  budgetCapCents: 10_000_000,
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
    messageId: `m-${name}-${seq}`,
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

const mySquare = (name: string): InternalEvent =>
  ev({
    type: 'command',
    command: 'mysquare',
    args: '',
    raw: '!mysquare',
    actor: { userId: `u-${name}`, username: name, role: 'viewer' },
    messageId: `m-${name}-${seq}`,
  })

/** A live board: feed it events one at a time and inspect as you go. */
class Board {
  engine: GameEngine<BingoState, BingoConfig>
  state: BingoState
  effects: Effect[] = []

  constructor(config: Partial<BingoConfig> = ENDLESS, seed = 'seed-alpha') {
    this.engine = new GameEngine(slotBingo, {
      config: slotBingo.configSchema.parse({ ...ENDLESS, ...config }),
      init: { sessionId: 's-1', channelId: 'c-1', seed, startedAt: 1_000, owner: OWNER },
    })
    this.state = this.engine.initialState()
  }

  apply(...events: InternalEvent[]): Effect[] {
    const out: Effect[] = []
    for (const event of events) {
      const folded = this.engine.apply(this.state, event)
      this.state = folded.state
      out.push(...folded.effects)
    }
    this.effects.push(...out)
    return out
  }

  join(name: string, slotId: string, slotName = slotId): Effect[] {
    return this.apply(joinCmd(name, slotName), resolvedFor(name, slotId, slotName))
  }

  /** n viewers with distinct slots, then the draw. Extras land in standby. */
  seat(n: number): this {
    for (let i = 0; i < n; i++) this.join(`p${i}`, `slot-${i}`, `Slot ${i}`)
    this.apply(control('draw.run'))
    return this
  }

  /** Arm the next square off the order and enter a result on it. */
  play(multiplier: number, buyCost = 100): { squareId: string; effects: Effect[] } {
    const picked = this.apply(control('square.pick'))
    const squareId = this.state.currentSquareId!
    assert.ok(squareId, 'a square should be armed')
    const effects = this.apply(
      control('square.result', { squareId, buyCost, payout: buyCost * multiplier }),
    )
    return { squareId, effects: [...picked, ...effects] }
  }

  square(id: string) {
    return this.state.squares.find((s) => s.id === id)!
  }

  get owned() {
    return this.state.squares.filter((s) => s.owner === 'viewer')
  }
}

const announcements = (effects: Effect[]) =>
  effects
    .filter(
      (e): e is Extract<Effect, { kind: 'chat' }> => e.kind === 'chat' && e.priority === 'announce',
    )
    .map((e) => e.text)

const chatTexts = (effects: Effect[]) =>
  effects
    .filter((e): e is Extract<Effect, { kind: 'chat' }> => e.kind === 'chat')
    .map((e) => e.text)

// ─── config ─────────────────────────────────────────────────────────────────

test('square retry (Model A) is refused, not silently ignored', () => {
  const parsed = slotBingo.configSchema.safeParse({ ...ENDLESS, retryModel: 'square' })
  assert.equal(parsed.success, false)
})

test('Endless without a budget cap is still refused', () => {
  const parsed = slotBingo.configSchema.safeParse({ size: 3, openSquares: 0, retriesPerSquare: null })
  assert.equal(parsed.success, false)
})

test('Endless with re-entry and a cap is accepted, and re-entry is the default model', () => {
  const parsed = slotBingo.configSchema.parse(ENDLESS)
  assert.equal(parsed.retriesPerSquare, null)
  assert.equal(parsed.retryModel, 'reentry')
})

// ─── a red reopens the square ───────────────────────────────────────────────

test('a red takes the square off its owner and sends them back to the pool', () => {
  const board = new Board().seat(9)
  const first = board.state.pickOrder[0]!
  const loser = board.square(first)

  const { squareId, effects } = board.play(0.2)
  assert.equal(squareId, first)

  const square = board.square(first)
  // Their slot is not on the board any more.
  assert.equal(square.owner, 'open')
  assert.equal(square.userId, null)
  assert.equal(square.slotName, null)
  // Scarred, not neutral (§6.5.5): the square remembers what happened.
  assert.equal(square.status, 'wounded')
  assert.equal(square.attempts.length, 1)
  assert.equal(square.history[0]!.burnedAtSeq !== null, true)

  // The loser is back in the pool, not out of the session.
  const back = board.state.standby.find((m) => m.userId === loser.userId)
  assert.ok(back)
  assert.equal(back.reentry?.squareId, first)

  // The square goes to the back of the committed order.
  assert.equal(board.state.pickOrder.at(-1), first)
  assert.equal(board.state.pickOrder.length, 10)

  assert.ok(announcements(effects).some((t) => t.startsWith(`${first} didn't pay — @${loser.username}`)))
})

test('a red with retries on does not kill any line', () => {
  const board = new Board().seat(9)
  board.play(0)
  assert.equal(board.state.lines.filter((l) => l.state === 'dead').length, 0)
})

test('the next pick moves on to the next viewer — the reopened square waits its turn', () => {
  const board = new Board().seat(9)
  const order = board.state.pickOrder.slice()
  board.play(0.1)
  const { squareId } = board.play(2)
  assert.equal(squareId, order[1])
})

test('green locks you in — a green square is never reopened', () => {
  const board = new Board().seat(9)
  const { squareId } = board.play(3)
  const square = board.square(squareId)
  assert.equal(square.status, 'settled')
  assert.equal(square.tier, 'green')
  assert.equal(square.owner, 'viewer')
  assert.equal(board.state.pickOrder.length, 9)
})

// ─── slots after a red ──────────────────────────────────────────────────────

test('the loser has to call a new slot — the one that burned is done for the session', () => {
  const board = new Board().seat(9)
  const loser = board.square(board.state.pickOrder[0]!)
  const burnedSlot = loser.slotId!
  const name = loser.username!
  board.play(0.2)

  // Re-entered without a slot, so not drawable until they pick one.
  const back = board.state.standby.find((m) => m.userId === loser.userId)!
  assert.equal(back.slotId, null)
  assert.deepEqual(board.state.burnedSlotIds, [burnedSlot])

  // !mysquare tells them what to do.
  const reply = chatTexts(board.apply(mySquare(name)))
  assert.ok(reply.some((t) => /back in the pool — !join <slot> with a new slot/.test(t)))

  // Calling the same slot again is rejected in chat.
  const again = chatTexts(board.join(name, burnedSlot, loser.slotName!))
  assert.ok(again.some((t) => /already bought this session/.test(t)))

  // Calling a new one puts them back in the draw.
  board.join(name, 'slot-new', 'Fresh Slot')
  const rejoined = board.state.standby.find((m) => m.userId === loser.userId)!
  assert.equal(rejoined.slotId, 'slot-new')
})

test('nobody else can claim a burned slot either', () => {
  const board = new Board().seat(9)
  const burned = board.square(board.state.pickOrder[0]!)
  board.play(0.2)

  const texts = chatTexts(board.join('latecomer', burned.slotId!, burned.slotName!))
  assert.ok(texts.some((t) => /already bought this session/.test(t)))
})

test('with burnPlayedSlots off, the loser keeps their slot and is drawable at once', () => {
  const board = new Board({ burnPlayedSlots: false }).seat(9)
  const loser = board.square(board.state.pickOrder[0]!)
  board.play(0.2)

  const back = board.state.standby.find((m) => m.userId === loser.userId)!
  assert.equal(back.slotId, loser.slotId)
  assert.deepEqual(board.state.burnedSlotIds, [])
})

test('a knocked-back viewer is not shown to the streamer as an unresolved slot', () => {
  const board = new Board().seat(9)
  board.play(0.2)
  const dash = slotBingo.projectDashboard!(board.state) as { unresolved: unknown[] }
  assert.equal(dash.unresolved.length, 0)
})

test('joins stay open all session in retry mode, even with no held-back squares', () => {
  const board = new Board().seat(9)
  const texts = chatTexts(board.join('late', 'slot-late', 'Late Slot'))
  assert.ok(texts.some((t) => /in the pool — every red reopens a square/.test(t)))
  assert.ok(board.state.standby.some((m) => m.userId === 'u-late'))
})

// ─── refilling a reopened square ────────────────────────────────────────────

/** Plays greens until the reopened square comes back round, returning its pick. */
function playUntil(board: Board, id: string) {
  for (let guard = 0; guard < 40; guard++) {
    board.apply(control('square.pick'))
    if (board.state.currentSquareId === id) return
    const armed = board.state.currentSquareId!
    board.apply(control('square.result', { squareId: armed, buyCost: 100, payout: 0 }))
    if (board.state.phase === 'complete') return
  }
  throw new Error(`never reached ${id}`)
}

test('when the reopened square comes round it is drawn from the pool', () => {
  // 11 viewers on 9 squares: two are waiting in standby before anyone loses.
  const board = new Board({ burnPlayedSlots: false }).seat(11)
  const waiting = board.state.standby.map((m) => m.userId)
  assert.equal(waiting.length, 2)

  const first = board.state.pickOrder[0]!
  const loser = board.square(first).userId!
  board.play(0.2)

  // Walk every other square once with reds too — each reopens in turn — then
  // back round to the first.
  playUntil(board, first)
  const square = board.square(first)
  assert.equal(square.owner, 'viewer')
  // Not the viewer it just burned, while anyone else is available (§6.5.3).
  assert.notEqual(square.userId, loser)
  assert.equal(square.history.at(-1)!.via, 'reentry')
  assert.equal(square.status, 'wounded', 'a new owner does not un-scar the square')
  assert.ok(announcements(board.effects).some((t) => t.startsWith(`${first} reopens to @`)))
})

test('the viewer a square just burned is redrawn onto it only when nobody else is left', () => {
  // Exactly 9 viewers, slots follow their owners. Picking the reopened square
  // straight away leaves its own loser as the whole pool: the block is waived
  // rather than stalling the board (§6.5.3).
  const board = new Board({ burnPlayedSlots: false }).seat(9)
  const first = board.state.pickOrder[0]!
  const loser = board.square(first).userId!
  board.play(0.2)

  board.apply(control('square.pickManual', { squareId: first }))
  assert.equal(board.state.currentSquareId, first)
  assert.equal(board.square(first).userId, loser)
})

test('…and is blocked from it while anyone else is drawable', () => {
  const board = new Board({ burnPlayedSlots: false }).seat(10)
  const first = board.state.pickOrder[0]!
  const loser = board.square(first).userId!
  const other = board.state.standby[0]!.userId
  board.play(0.2)

  board.apply(control('square.pickManual', { squareId: first }))
  assert.equal(board.square(first).userId, other)
  assert.ok(board.state.standby.some((m) => m.userId === loser))
})

test('a reopened square with nobody drawable plays as HOUSE once it is the last work left', () => {
  // burnPlayedSlots on and nobody re-joins: the pool has no drawable members.
  const board = new Board().seat(9)
  const first = board.state.pickOrder[0]!
  board.play(0.2)

  // While owned squares are still ahead, an unfillable reopened square rolls
  // to the back of the order rather than going HOUSE. Everything else busts
  // too, so every loser re-enters without a drawable slot.
  const before = board.state.pickOrder.length
  for (let i = 1; i < 9; i++) {
    board.apply(control('square.pick'))
    const armed = board.state.currentSquareId!
    assert.notEqual(armed, first, 'owned work comes first while the pool is empty')
    board.apply(control('square.result', { squareId: armed, buyCost: 100, payout: 0 }))
  }
  assert.ok(board.state.pickOrder.length > before)

  // Now every square is reopened and nobody has a drawable slot.
  assert.equal(board.owned.length, 0)
  board.apply(control('square.pick'))
  const armed = board.state.currentSquareId!
  assert.equal(board.square(armed).owner, 'house')
  assert.ok(announcements(board.effects).some((t) => /plays as HOUSE/.test(t)))

  // A house red is final — no real money on a square that wins nobody anything.
  board.apply(control('square.result', { squareId: armed, buyCost: 100, payout: 0 }))
  assert.equal(board.square(armed).status, 'settled')
  assert.equal(board.square(armed).tier, 'red')
})

test('the same seed refills the same way', () => {
  const script = (b: Board) => {
    b.seat(12)
    b.play(0.2)
    playUntil(b, b.state.pickOrder[0]!)
    return b.state.squares.map((s) => `${s.id}:${s.username}`)
  }
  assert.deepEqual(script(new Board({ burnPlayedSlots: false }, 'seed-x')), script(new Board({ burnPlayedSlots: false }, 'seed-x')))
})

// ─── Endless ends on a line ─────────────────────────────────────────────────

test('Endless: the board ends the moment a line is fully green', () => {
  const board = new Board({ burnPlayedSlots: false }).seat(12)
  // Green everything in order until a bingo fires. Reds never end an Endless
  // board, so a line is the only way this stops.
  let guard = 0
  while (board.state.phase !== 'complete' && guard++ < 50) board.play(2)

  assert.equal(board.state.phase, 'complete')
  assert.equal(board.state.decidedBy, 'bingo')
  assert.ok(board.state.bingoLines.length > 0)
})

test('Endless: reds only delay the bingo — no line ever dies', () => {
  const board = new Board({ burnPlayedSlots: false }).seat(20)
  let guard = 0
  let n = 0
  while (board.state.phase !== 'complete' && guard++ < 200) {
    // Every other buy busts.
    board.play(n++ % 2 === 0 ? 0 : 2)
    assert.equal(board.state.lines.filter((l) => l.state === 'dead').length, 0)
  }
  assert.equal(board.state.decidedBy, 'bingo')
})

test('winners are whoever holds the square when the line completes — not who it burned', () => {
  const board = new Board({ burnPlayedSlots: false }).seat(14)
  const first = board.state.pickOrder[0]!
  const burned = board.square(first).userId!
  board.play(0.2)

  let guard = 0
  while (board.state.phase !== 'complete' && guard++ < 60) board.play(2)

  assert.equal(board.state.decidedBy, 'bingo')
  const winnerIds = board.state.winners.map((w) => w.userId)
  const onWinningSquares = board.state.bingoLines
    .flatMap((id) => board.state.lines.find((l) => l.id === id)!.squareIds)
    .map((id) => board.square(id))
    .filter((s) => s.owner === 'viewer')
    .map((s) => s.userId)
  assert.deepEqual(new Set(winnerIds), new Set(onWinningSquares))
  // The burned viewer only wins if they were redrawn onto a winning square.
  if (!onWinningSquares.includes(burned)) assert.ok(!winnerIds.includes(burned))
})

// ─── finite retries ─────────────────────────────────────────────────────────

test('Second Chance: the first red reopens, the second is final and kills the lines', () => {
  const board = new Board({ retriesPerSquare: 1, burnPlayedSlots: false, budgetCapCents: null }).seat(12)
  const first = board.state.pickOrder[0]!
  assert.equal(board.square(first).livesLeft, 1)

  const { effects } = board.play(0.2)
  assert.equal(board.square(first).livesLeft, 0)
  assert.ok(announcements(effects).some((t) => /Last life/.test(t)))

  playUntil(board, first)
  assert.equal(board.state.currentSquareId, first)
  board.apply(control('square.result', { squareId: first, buyCost: 100, payout: 10 }))

  const square = board.square(first)
  assert.equal(square.status, 'settled')
  assert.equal(square.tier, 'red')
  assert.equal(square.owner, 'viewer', 'a final red keeps its owner — the line just dies')
  const through = board.state.lines.filter((l) => l.squareIds.includes(first))
  assert.ok(through.every((l) => l.state === 'dead'))
})

// ─── scoring and caps ───────────────────────────────────────────────────────

test('with retries on, best line is scored on net across every attempt', () => {
  const board = new Board({ retriesPerSquare: 1, burnPlayedSlots: false, budgetCapCents: null }).seat(9)
  board.play(0.5)
  board.apply(control('board.settleEarly'))
  const view = slotBingo.project(board.state) as { scoring: string }
  assert.equal(view.scoring, 'net')
  // Every line's net is payout minus cost over all its attempts, reds included.
  for (const line of board.state.lines) {
    assert.equal(line.netScore, Math.round((line.totalPayout - line.totalCost) * 100) / 100)
  }
})

test('a line that burned money scores below one that greened clean', () => {
  // §8 — on multiplier, a square that went 0.2× → 0.4× → 80× beats a clean
  // 1.3×; on net, the money it burned counts against it.
  const line = (id: string, totalMultiplier: number, totalPayout: number, totalCost: number, attemptCount: number) => ({
    id,
    squareIds: [],
    state: 'open' as const,
    totalMultiplier,
    totalPayout,
    totalCost,
    netScore: totalPayout - totalCost,
    attemptCount,
    greenCount: 3,
  })
  const burner = line('row1', 82, 8060, 500, 5) // net +7,560
  const clean = line('row2', 60, 8000, 300, 3) //  net +7,700

  assert.equal(bestLine([burner, clean], () => 0, 'multiplier')!.line.id, 'row1')
  const net = bestLine([burner, clean], () => 0, 'net')!
  assert.equal(net.line.id, 'row2')
  assert.equal(net.decidedBy, 'net')

  // Tied on net and payout: fewer attempts wins, and says so.
  const a = line('col1', 10, 1000, 400, 4)
  const b = line('col2', 10, 1000, 400, 3)
  const tie = bestLine([a, b], () => 0, 'net')!
  assert.equal(tie.line.id, 'col2')
  assert.equal(tie.decidedBy, 'attempts')
})

test('the budget cap ends the board as capped before a buy it cannot cover', () => {
  // €100 buys, €350 cap: after three buys the fourth would reach €400.
  const board = new Board({ budgetCapCents: 35_000, burnPlayedSlots: false }).seat(12)
  board.play(0.2)
  board.play(0.2)
  board.play(0.2)
  const effects = board.apply(control('square.pick'))

  assert.equal(board.state.phase, 'complete')
  assert.equal(board.state.decidedBy, 'capped')
  assert.ok(announcements(effects).some((t) => t.startsWith('Budget cap reached.')))
})

test('a buy cap ends the board the same way', () => {
  const board = new Board({ maxBuys: 2, burnPlayedSlots: false }).seat(12)
  board.play(0.2)
  board.play(0.2)
  const effects = board.apply(control('square.pick'))
  assert.equal(board.state.decidedBy, 'capped')
  assert.ok(announcements(effects).some((t) => t.startsWith('Buy cap reached.')))
})

// ─── revert ─────────────────────────────────────────────────────────────────

test('reverting a red that burned its owner gives the square back', () => {
  const board = new Board().seat(9)
  const before = JSON.parse(JSON.stringify(board.state)) as BingoState
  const first = before.pickOrder[0]!
  const owner = board.square(first)

  board.play(0.2)
  board.apply(control('square.revert', { squareId: first }))

  const square = board.square(first)
  assert.equal(square.owner, 'viewer')
  assert.equal(square.userId, owner.userId)
  assert.equal(square.slotId, owner.slotId)
  assert.equal(square.thumbnail, owner.thumbnail)
  assert.equal(square.status, 'unplayed')
  assert.equal(square.attempts.length, 0)
  assert.equal(square.history.at(-1)!.burnedAtSeq, null)
  assert.ok(!board.state.standby.some((m) => m.userId === owner.userId))
  assert.deepEqual(board.state.burnedSlotIds, [])
  assert.deepEqual(board.state.pickOrder, before.pickOrder)
  assert.equal(board.state.pickCursor, before.pickCursor)
})

test('reverting is blocked once the reopened square has a new owner', () => {
  const board = new Board({ burnPlayedSlots: false }).seat(11)
  const first = board.state.pickOrder[0]!
  board.play(0.2)
  playUntil(board, first)
  assert.equal(board.square(first).owner, 'viewer')

  const effects = board.apply(control('square.revert', { squareId: first }))
  assert.ok(
    effects.some(
      (e) => e.kind === 'broadcast' && /already been redrawn/.test(String(e.patch.inputError ?? '')),
    ),
  )
  assert.equal(board.square(first).owner, 'viewer')
})

// ─── the default board is untouched ─────────────────────────────────────────

test('Sudden Death (the default) still settles a red for good', () => {
  const board = new Board({ retriesPerSquare: 0, budgetCapCents: null }).seat(9)
  const { squareId } = board.play(0.2)
  const square = board.square(squareId)
  assert.equal(square.status, 'settled')
  assert.equal(square.tier, 'red')
  assert.equal(square.owner, 'viewer')
  assert.equal(board.state.standby.length, 0)
  assert.equal(board.state.pickOrder.length, 9)
})
