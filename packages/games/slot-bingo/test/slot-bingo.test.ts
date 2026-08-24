/**
 * Slot Bingo — the rules that decide who wins.
 *
 * Weighted toward geometry and resolution rather than plumbing: a board that
 * mis-scores a line names the wrong winner in front of a live chat, and unlike
 * a crash it produces no error anyone can point at.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../../core/src/primitives/rng.ts'
import {
  buildLines,
  buildSquares,
  commitPickOrder,
  lineCountFor,
  squareId,
  tierFor,
  unlockSchedule,
} from '../src/board.ts'
import { bingoConfigSchema } from '../src/types.ts'
import { lineLabel } from '../dist/index.js'

// ─── geometry ───────────────────────────────────────────────────────────────

test('a 5x5 has 12 lines and a 3x3 has 8', () => {
  assert.equal(buildLines(5).length, 12) // 5 rows + 5 cols + 2 diagonals
  assert.equal(buildLines(3).length, 8)
})

test('square ids are column letter then row number', () => {
  assert.equal(squareId(0, 0), 'A1')
  assert.equal(squareId(2, 2), 'C3')
  assert.equal(squareId(4, 0), 'A5')
})

test('the diagonals actually run corner to corner', () => {
  const lines = buildLines(5)
  const diagA = lines.find((l) => l.id === 'diagA')!
  const diagB = lines.find((l) => l.id === 'diagB')!

  assert.deepEqual(diagA.squareIds, ['A1', 'B2', 'C3', 'D4', 'E5'])
  assert.deepEqual(diagB.squareIds, ['E1', 'D2', 'C3', 'B4', 'A5'])
})

test('every square appears in exactly its row and column, plus any diagonal', () => {
  const size = 5
  const lines = buildLines(size)
  const squares = buildSquares(size)

  for (const square of squares) {
    const on = lines.filter((l) => l.squareIds.includes(square.id)).length
    assert.equal(
      on,
      lineCountFor(square, size),
      `${square.id} is on ${on} lines but lineCountFor says ${lineCountFor(square, size)}`,
    )
  }
})

test('placement is not neutral, and the spread is 2x', () => {
  // §5.1 — the centre sits on four lines and an edge square on two. This is the
  // number the overlay shows at claim time, so it had better be right.
  const size = 5
  const squares = buildSquares(size)
  const at = (id: string) => lineCountFor(squares.find((s) => s.id === id)!, size)

  assert.equal(at('C3'), 4, 'centre: row, column, both diagonals')
  assert.equal(at('A1'), 3, 'corner: row, column, one diagonal')
  assert.equal(at('B2'), 3, 'diagonal, non-centre')
  assert.equal(at('B1'), 2, 'everything else')
})

// ─── unlock schedule ────────────────────────────────────────────────────────

test('held-back squares unlock spread across the board', () => {
  // §5.3 — 3 of 25 lands on 6/12/19 by the k x total / (n+1) rule.
  assert.deepEqual(unlockSchedule(3, 25), [6, 13, 19])
  assert.deepEqual(unlockSchedule(1, 9), [5])
  assert.deepEqual(unlockSchedule(0, 25), [])
})

test('the schedule scales with expected picks, not the square count', () => {
  // Retries lengthen the board; fixed pick numbers would land every unlock in
  // the first third of a session that runs twice as long.
  const short = unlockSchedule(3, 25)
  const long = unlockSchedule(3, 60)
  assert.ok(long.every((pick, i) => pick > short[i]!), 'a longer board unlocks later')
})

// ─── committed pick order ───────────────────────────────────────────────────

test('the pick order contains every square exactly once', () => {
  const squares = buildSquares(5)
  const order = commitPickOrder(squares, [], [], createRng('seed', 'order'))

  assert.equal(order.length, 25)
  assert.equal(new Set(order).size, 25)
})

test('a held-back square is never played before it unlocks', () => {
  // §5.3 — otherwise you unlock C3 at pick 18 having played it at pick 5.
  const squares = buildSquares(5)
  const openIds = ['A1', 'C3', 'E5']
  const schedule = unlockSchedule(3, 25)

  for (let attempt = 0; attempt < 50; attempt++) {
    const order = commitPickOrder(squares, openIds, schedule, createRng(`seed-${attempt}`, 'order'))
    openIds.forEach((id, index) => {
      assert.ok(
        order.indexOf(id) >= schedule[index]!,
        `${id} landed at ${order.indexOf(id)}, before its unlock at ${schedule[index]}`,
      )
    })
  }
})

test('the same seed commits the same order', () => {
  // §5.1 — "you picked that square on purpose" has to be answerable with a
  // fact, which requires the order to replay from the log.
  const squares = buildSquares(5)
  const a = commitPickOrder(squares, ['B2'], [6], createRng('same-seed', 'order'))
  const b = commitPickOrder(squares, ['B2'], [6], createRng('same-seed', 'order'))
  const c = commitPickOrder(squares, ['B2'], [6], createRng('other-seed', 'order'))

  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c, 'a different seed should give a different order')
})

// ─── colour tiers ───────────────────────────────────────────────────────────

test('tiers land on the right side of their thresholds', () => {
  assert.equal(tierFor(0.99, 1, 50), 'red')
  assert.equal(tierFor(1, 1, 50), 'green', 'at the threshold is green, not red')
  assert.equal(tierFor(49.99, 1, 50), 'green')
  assert.equal(tierFor(50, 1, 50), 'gold', 'at the threshold is gold')
  assert.equal(tierFor(0, 1, 50), 'red', 'a zero payout is a red, and common')
})

// ─── line labels ────────────────────────────────────────────────────────────

test('a line is named the way its squares are labelled', () => {
  // The rail prints the label next to "Need A5". Naming that line "Column 1"
  // makes the viewer translate between two coordinate systems mid-stream.
  assert.equal(lineLabel('col1'), 'Column A')
  assert.equal(lineLabel('col3'), 'Column C')
  assert.equal(lineLabel('col5'), 'Column E')
  assert.equal(lineLabel('row3'), 'Row 3', 'rows are already numbered like the ids')
  assert.equal(lineLabel('diagA'), 'Diagonal ↘')
  assert.equal(lineLabel('diagB'), 'Diagonal ↙')
})

// ─── config ─────────────────────────────────────────────────────────────────

test('a default config is a 5x5 with sudden death', () => {
  const config = bingoConfigSchema.parse({})
  assert.equal(config.size, 5)
  assert.equal(config.openSquares, 3)
  assert.equal(config.greenThresholdX, 1)
  assert.equal(config.bigWinThresholdX, 50)
  assert.equal(config.retriesPerSquare, 0, 'retries are off by default')
})

test('endless retries without a budget cap is refused, not warned about', () => {
  // §11 — an uncapped Endless 5x5 has no upper bound on what it costs, and a
  // warning is something a streamer clicks through at 9pm and regrets at 1am.
  assert.throws(
    () => bingoConfigSchema.parse({ retriesPerSquare: null }),
    /budget cap/i,
  )

  const capped = bingoConfigSchema.parse({ retriesPerSquare: null, budgetCapCents: 250_000 })
  assert.equal(capped.retriesPerSquare, null)
})

test('the big-win threshold must sit above the green one', () => {
  // Otherwise every green is also gold and the celebration means nothing.
  assert.throws(() => bingoConfigSchema.parse({ greenThresholdX: 50, bigWinThresholdX: 50 }), /above/)
})

test('a 3x3 cannot hold back three squares', () => {
  assert.throws(() => bingoConfigSchema.parse({ size: 3, openSquares: 3 }), /at most one/)
  assert.equal(bingoConfigSchema.parse({ size: 3, openSquares: 1 }).openSquares, 1)
})

test('the free centre is a 5x5 option', () => {
  assert.throws(() => bingoConfigSchema.parse({ size: 3, openSquares: 1, freeCentre: true }), /5×5/)
})
