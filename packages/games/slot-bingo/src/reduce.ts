/**
 * Slot Bingo reducer — §3 to §9.
 *
 * Pure, like every reducer. The draw, the committed pick order and the
 * tiebreak coin flip all derive from `ctx.rng(label)`, seeded from the session
 * seed — so a replay reaches the same winning line, which is the whole basis
 * for answering "that square was picked on purpose".
 *
 * Retries (§6.5) are not implemented. `retriesPerSquare` defaults to 0, which
 * is the game every other section describes: a square is played once and a red
 * is permanent.
 */

import {
  announce,
  ack,
  broadcast,
  cancelTimer,
  drawSeats,
  end,
  formatMultiplier,
  lookup,
  rejection,
  reply,
  round2,
  timer,
  type Effect,
  type InternalEvent,
  type ReduceContext,
  type ReduceResult,
} from '@streamarena/core'
import {
  buildLines,
  buildSquares,
  commitPickOrder,
  lineCountFor,
  squareId,
  tierFor,
  unlockSchedule,
} from './board.js'
import {
  aliveLines,
  bestLine,
  completedLines,
  fullyPlayedLines,
  recomputeLines,
  winnersOf,
} from './lines.js'
import {
  JOIN_TIMER_ID,
  type Attempt,
  type BingoConfig,
  type BingoState,
  type Line,
  type PoolMember,
  type Square,
} from './types.js'

type Ctx = ReduceContext<BingoConfig>
type Result = ReduceResult<BingoState>

interface LookupThen {
  kind: 'pool'
  userId: string
}

const STATUS_REPLY_COOLDOWN_MS = 60_000
const MY_SQUARE_COOLDOWN_MS = 20_000
/** §12 — a line can re-enter one-away, so the dedupe is per entry, not forever. */
const ONE_AWAY_COOLDOWN_MS = 300_000

export function reduce(state: BingoState, event: InternalEvent, ctx: Ctx): Result {
  switch (event.type) {
    case 'session.started': {
      const windowMs = ctx.config.joinWindowMs
      const effects: Effect[] = [broadcast({ phase: state.phase })]
      if (windowMs !== null) {
        effects.push(timer(windowMs, { kind: 'joinWindowEnd' }, JOIN_TIMER_ID))
        return { state: { ...state, joinWindowEndsAt: ctx.now + windowMs }, effects }
      }
      return { state, effects }
    }

    case 'command':
      return handleCommand(state, event, ctx)
    case 'control':
      return handleControl(state, event, ctx)
    case 'slot.resolved':
      return handleSlotResolved(state, event, ctx)
    case 'timer':
      return event.payload && (event.payload as { kind?: string }).kind === 'joinWindowEnd'
        ? runDraw(state, ctx)
        : { state, effects: [] }

    default:
      return { state, effects: [] }
  }
}

// ─── Chat commands ──────────────────────────────────────────────────────────

function handleCommand(
  state: BingoState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  switch (event.command) {
    case 'join':
      return join(state, event, ctx)
    case 'board':
      return boardReply(state, event, ctx)
    case 'mysquare':
      return mySquareReply(state, event, ctx)
    default:
      return { state, effects: [] }
  }
}

/**
 * `!join <slot>` — §4.
 *
 * Live from session start until the last square unlocks, not just during the
 * opening window. A 5×5 is 25 bonus buys and runs for hours; a board locked
 * after five minutes is a locked door to everyone who tunes in late.
 */
function join(
  state: BingoState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const { actor, messageId } = event

  if (!state.joinsOpen) {
    return {
      state,
      effects: [
        rejection(
          `@${actor.username} all squares are taken — this board is full. Next session, get in early.`,
          messageId,
        ),
      ],
    }
  }

  const query = event.args.trim()
  if (query === '') {
    return {
      state,
      effects: [rejection(`@${actor.username} pick a slot to bring, e.g. !join Le Bandit`, messageId)],
    }
  }

  // One square per viewer. A second !join replaces the first rather than
  // adding a seat — §4.
  const member: PoolMember = {
    userId: actor.userId,
    username: actor.username,
    role: actor.role,
    slotId: null,
    slotName: null,
    provider: null,
    thumbnail: null,
    rawText: query,
    joinedAtSeq: ctx.seq,
    suggestions: [],
  }

  const target = state.drawCompleted ? 'standby' : 'pool'
  const existing = state[target].find((p) => p.userId === actor.userId)
  const list = existing
    ? state[target].map((p) => (p.userId === actor.userId ? { ...member, joinedAtSeq: p.joinedAtSeq } : p))
    : [...state[target], member]

  const then: LookupThen = { kind: 'pool', userId: actor.userId }
  return { state: { ...state, [target]: list }, effects: [lookup(query, then)] }
}

/**
 * A join that lands after the draw is acknowledged, never rejected — §4.
 *
 * The busiest moment for `!join` is the twenty seconds of reveal animation,
 * which is exactly when the board has just filled. Telling those viewers "too
 * late" is the worst possible reading of a moment they turned up for.
 */
function standbyAck(state: BingoState, username: string, messageId?: string): Effect {
  const remaining = state.squares.filter((s) => s.owner === 'open').length
  const until = picksUntilNextUnlock(state)

  if (remaining === 0) {
    return rejection(
      `@${username} all squares are taken — this board is full. Next session, get in early.`,
      messageId,
    )
  }

  return ack(
    `@${username} you're in the standby draw. ${remaining} ${remaining === 1 ? 'square' : 'squares'} still to open` +
      (until === null ? '.' : ` — next one after ${until} more ${until === 1 ? 'pick' : 'picks'}.`),
    messageId,
  )
}

function boardReply(
  state: BingoState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  if (
    state.lastStatusReplyAt !== null &&
    ctx.now - state.lastStatusReplyAt < STATUS_REPLY_COOLDOWN_MS
  ) {
    return { state, effects: [] }
  }

  const alive = aliveLines(state.lines).length
  const played = state.squares.filter((s) => s.status === 'settled').length
  const best = bestLine(aliveLines(state.lines), (id) => ctx.rng(`flip-${id}`).next())

  const text =
    `${alive} of ${state.lines.length} lines alive · ${played}/${state.squares.length} squares played` +
    (best ? ` · best line ${lineLabel(best.line.id)} at ${formatMultiplier(best.line.totalMultiplier)}` : '')

  return { state: { ...state, lastStatusReplyAt: ctx.now }, effects: [reply(text)] }
}

function mySquareReply(
  state: BingoState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const { actor, messageId } = event
  const square = state.squares.find((s) => s.userId === actor.userId)

  if (!square) {
    const waiting =
      state.standby.some((p) => p.userId === actor.userId) ||
      state.pool.some((p) => p.userId === actor.userId)
    const until = picksUntilNextUnlock(state)

    return {
      state,
      effects: [
        reply(
          waiting
            ? `@${actor.username} you're in the standby draw` +
              (until === null ? '.' : ` — next square opens after ${until} more ${until === 1 ? 'pick' : 'picks'}.`)
            : `@${actor.username} you're not in this board — type !join <slot> if squares are still open.`,
          messageId,
        ),
      ],
    }
  }

  const lines = state.lines.filter((l) => l.squareIds.includes(square.id))
  const alive = lines.filter((l) => l.state !== 'dead').length
  const settling = square.attempts[square.attempts.length - 1]

  const text =
    `@${actor.username} you hold ${square.id} · ${square.slotName ?? 'unresolved'}` +
    (settling ? ` · paid ${formatMultiplier(settling.multiplier)}` : ' · not played yet') +
    ` · ${alive} of ${lines.length} of your lines still alive`

  return { state, effects: [reply(text, messageId)] }
}

// ─── Catalog resolution ─────────────────────────────────────────────────────

function handleSlotResolved(
  state: BingoState,
  event: Extract<InternalEvent, { type: 'slot.resolved' }>,
  ctx: Ctx,
): Result {
  const then = event.then as LookupThen | null
  if (!then || then.kind !== 'pool') return { state, effects: [] }

  const target: 'pool' | 'standby' = state.standby.some((p) => p.userId === then.userId)
    ? 'standby'
    : 'pool'
  const member = state[target].find((p) => p.userId === then.userId)
  if (!member) return { state, effects: [] }

  if (!event.match) {
    const top = event.suggestions[0]
    const patched = { ...member, suggestions: event.suggestions.slice(0, 3) }
    return {
      state: { ...state, [target]: replaceMember(state[target], patched) },
      effects: [
        rejection(
          top
            ? `@${member.username} couldn't match "${member.rawText}" — did you mean ${top.name}?`
            : `@${member.username} couldn't find "${member.rawText}" — check the spelling and try again.`,
        ),
      ],
    }
  }

  /*
   * §4 — slots are unique, first come first served, and the rejection has to
   * reach chat. A silently dropped !join leaves the viewer believing they are
   * entered right up until the draw passes them by.
   */
  if (ctx.config.uniqueSlots) {
    const holder =
      findSlotHolder(state, event.match.slotId, member.userId) ??
      state.squares.find((s) => s.slotId === event.match!.slotId && s.userId !== member.userId)

    if (holder) {
      const name = 'username' in holder ? holder.username : null
      return {
        state,
        effects: [
          rejection(
            `@${member.username} ${event.match.name} is already claimed by @${name ?? 'someone'} — pick another slot.`,
          ),
        ],
      }
    }
  }

  const patched: PoolMember = {
    ...member,
    slotId: event.match.slotId,
    slotName: event.match.name,
    provider: event.match.provider,
    thumbnail: event.match.thumbnail,
    suggestions: [],
  }

  const next = { ...state, [target]: replaceMember(state[target], patched) }
  return {
    state: next,
    effects: target === 'standby' ? [standbyAck(next, member.username)] : [],
  }
}

// ─── Control actions ────────────────────────────────────────────────────────

function handleControl(
  state: BingoState,
  event: Extract<InternalEvent, { type: 'control' }>,
  ctx: Ctx,
): Result {
  const p = (event.payload ?? {}) as Record<string, unknown>

  switch (event.action) {
    case 'join.close':
      return runDraw(state, ctx)
    case 'draw.run':
      return runDraw(state, ctx)
    case 'reserve.add':
      return {
        state: {
          ...state,
          reservedUserIds: [...new Set([...state.reservedUserIds, String(p.userId ?? '')])].filter(Boolean),
        },
        effects: [],
      }
    case 'reserve.remove':
      return {
        state: { ...state, reservedUserIds: state.reservedUserIds.filter((id) => id !== p.userId) },
        effects: [],
      }
    case 'pool.remove':
      return {
        state: {
          ...state,
          pool: state.pool.filter((m) => m.userId !== p.userId),
          standby: state.standby.filter((m) => m.userId !== p.userId),
        },
        effects: [],
      }
    case 'square.pick':
      return pickNext(state, ctx, null)
    case 'square.pickManual':
      return pickNext(state, ctx, String(p.squareId ?? ''))
    case 'square.result':
      return enterResult(state, p, ctx)
    case 'square.revert':
      return revert(state, String(p.squareId ?? ''), ctx)
    case 'square.fillHouse':
      return fillHouse(state, p, ctx)
    case 'unlock.run':
      return runUnlock(state, ctx)
    case 'unlock.skip':
      return skipUnlock(state, ctx)
    case 'board.settleEarly':
      return settle(state, ctx, 'settledEarly')
    case 'bingo.abandon':
      return { state: { ...state, phase: 'complete' }, effects: [end('abandoned')] }
    default:
      return { state, effects: [] }
  }
}

/**
 * The main draw — §5.1.
 *
 * Reserved seats first, labelled Streamer's pick, then seeded random fill, then
 * the pick order is committed and never re-rolled.
 */
function runDraw(state: BingoState, ctx: Ctx): Result {
  if (state.drawCompleted) return { state, effects: [] }

  const size = state.size
  const held = Math.min(ctx.config.openSquares, state.squares.length - 1)
  const seats = state.squares.length - held - (state.freeCentre ? 1 : 0)

  const resolved = state.pool.filter((m) => m.slotId !== null)
  const draw = drawSeats(resolved, {
    seats: Math.max(0, seats),
    reservedUserIds: state.reservedUserIds,
    rng: ctx.rng('draw'),
  })

  // Which physical squares are held back is itself seeded, so it replays.
  const centreId = state.freeCentre ? squareId((size - 1) / 2, (size - 1) / 2) : null
  const assignable = state.squares.filter((s) => s.id !== centreId)
  const shuffled = assignable
    .map((s) => ({ s, k: ctx.rng(`place-${s.id}`).next() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s)

  const openSquares = shuffled.slice(0, held)
  const openIds = openSquares.map((s) => s.id)
  const filled = shuffled.slice(held)

  const expectedPicks = state.squares.length
  const schedule = unlockSchedule(held, expectedPicks)

  const byId = new Map<string, Square>()
  filled.forEach((square, index) => {
    const seat = draw.seats[index]
    byId.set(
      square.id,
      seat
        ? {
            ...square,
            userId: seat.member.userId,
            username: seat.member.username,
            slotId: seat.member.slotId,
            slotName: seat.member.slotName,
            thumbnail: seat.member.thumbnail,
            owner: 'viewer',
            source: seat.source === 'reserved' ? 'reserved' : 'random',
            claimedAtSeq: ctx.seq,
            history: [
              {
                userId: seat.member.userId,
                username: seat.member.username,
                slotId: seat.member.slotId,
                slotName: seat.member.slotName,
                claimedAtSeq: ctx.seq,
                via: 'draw' as const,
                burnedAtSeq: null,
              },
            ],
          }
        : // §5.4 — fewer joiners than squares. Left for the streamer to fill
          // with their own slots, marked HOUSE.
          { ...square, owner: 'open', source: 'random' },
    )
  })

  openSquares.forEach((square, index) => {
    byId.set(square.id, {
      ...square,
      owner: 'open',
      source: 'unlock',
      unlockAfterPick: schedule[index] ?? null,
    })
  })

  if (centreId) {
    const centre = state.squares.find((s) => s.id === centreId)!
    byId.set(centreId, {
      ...centre,
      owner: 'free',
      status: 'settled',
      tier: 'green',
    })
  }

  const squares = state.squares.map((s) => byId.get(s.id) ?? s)
  const pickOrder = commitPickOrder(squares, openIds, schedule, ctx.rng('pick-order'))

  const next: BingoState = {
    ...state,
    phase: 'placement',
    squares,
    pool: draw.unpicked,
    // Everyone who missed the draw waits for an open square rather than being
    // dropped — §5.2 makes late entry the same primitive as an unlock.
    standby: [...state.standby, ...draw.unpicked],
    drawCompleted: true,
    joinsClosed: true,
    joinsOpen: held > 0,
    unlockSchedule: schedule,
    pickOrder,
    joinWindowEndsAt: null,
  }

  const withLines = { ...next, lines: recomputeLines(next) }
  const effects: Effect[] = [cancelTimer(JOIN_TIMER_ID), broadcast({ phase: 'placement' })]

  if (ctx.config.announceDraw) {
    effects.push(
      announce(
        `The board is set — ${draw.seats.length} squares claimed` +
          (held > 0 ? `, ${held} held back to open later.` : '.') +
          ` ${withLines.lines.length} lines in play.`,
      ),
    )
  }

  return { state: withLines, effects }
}

/** PICK — the next square off the committed order, or one chosen by hand (§6). */
function pickNext(state: BingoState, ctx: Ctx, manualId: string | null): Result {
  if (state.phase === 'complete') return { state, effects: [] }

  const byId = new Map(state.squares.map((s) => [s.id, s]))

  let targetId: string | null = null
  if (manualId) {
    if (!ctx.config.allowManualPick) return { state, effects: [] }
    const square = byId.get(manualId)
    if (!square || square.status === 'settled' || square.owner === 'open') {
      return { state, effects: [] }
    }
    targetId = manualId
  } else {
    // Walk the committed order past anything already settled or still unopened.
    let cursor = state.pickCursor
    while (cursor < state.pickOrder.length) {
      const candidate = byId.get(state.pickOrder[cursor]!)
      if (candidate && candidate.status !== 'settled' && candidate.owner !== 'open') break
      cursor++
    }
    if (cursor >= state.pickOrder.length) return settle(state, ctx, 'bestLine')
    targetId = state.pickOrder[cursor]!
    state = { ...state, pickCursor: cursor }
  }

  const square = byId.get(targetId)!
  const next: BingoState = {
    ...state,
    phase: 'buying',
    currentSquareId: targetId,
    squares: state.squares.map((s) =>
      s.id === targetId ? { ...s, manualPick: manualId !== null } : s,
    ),
  }

  const lines = state.lines.filter((l) => l.squareIds.includes(targetId!))
  const matchPoint = lines.filter((l) => l.state === 'oneAway')

  const effects: Effect[] = [
    broadcast({
      phase: 'buying',
      currentSquareId: targetId,
      // §7.1 — the square armed now that could end the board. On the default
      // board this is one-away seen from the square's side.
      matchPointLines: matchPoint.map((l) => l.id),
    }),
  ]

  if (matchPoint.length > 0) {
    effects.push(
      announce(
        `Match point — ${square.id} (@${square.username ?? 'house'}) can complete ` +
          matchPoint.map((l) => lineLabel(l.id)).join(' and ') +
          ' right now.',
      ),
    )
  }

  return { state: next, effects }
}

/**
 * RESULT — §6.
 *
 * The streamer enters buy cost and payout; the multiplier is computed, never
 * entered. Buy cost must exceed zero. A payout of zero is valid and common.
 */
function enterResult(state: BingoState, p: Record<string, unknown>, ctx: Ctx): Result {
  const targetId = String(p.squareId ?? state.currentSquareId ?? '')
  const square = state.squares.find((s) => s.id === targetId)
  if (!square || square.owner === 'open') return { state, effects: [] }

  const buyCost = round2(Number(p.buyCost ?? 0))
  const payout = round2(Math.max(0, Number(p.payout ?? 0)))
  if (!Number.isFinite(buyCost) || buyCost <= 0) {
    return { state, effects: [broadcast({ inputError: 'Buy cost must be more than zero.' })] }
  }

  const multiplier = round2(payout / buyCost)
  const tier = tierFor(multiplier, state.greenThresholdX, state.bigWinThresholdX)

  const attempt: Attempt = {
    seq: ctx.seq,
    round: state.round,
    userId: square.userId,
    username: square.username,
    slotId: square.slotId,
    slotName: square.slotName,
    buyCost,
    payout,
    multiplier,
    tier,
    rebuy: false,
  }

  const squares = state.squares.map((s) =>
    s.id === targetId
      ? { ...s, attempts: [...s.attempts, attempt], status: 'settled' as const, tier }
      : s,
  )

  const withResult: BingoState = {
    ...state,
    squares,
    phase: 'result',
    currentSquareId: null,
    pickCursor: state.pickCursor + 1,
  }
  const lines = recomputeLines(withResult)
  const next = { ...withResult, lines }

  const effects: Effect[] = [
    broadcast({
      flash: { squareId: targetId, multiplier, tier, slotName: square.slotName },
    }),
  ]

  if (tier === 'gold') {
    effects.push(
      announce(
        `${targetId} · ${square.slotName ?? 'slot'} · ${formatMultiplier(multiplier)} — ` +
          `gold for @${square.username ?? 'the house'}.`,
      ),
    )
  }

  // §8 — the first line to go fully green ends the board. If one square
  // completes two at once, both are announced; picking one would be arbitrary.
  const completed = completedLines(lines)
  if (completed.length > 0) return declareBingo(next, completed, ctx, effects)

  effects.push(...oneAwayAnnouncements(state, next, ctx))

  const unlockDue = state.unlockSchedule[state.unlocksDone]
  if (unlockDue !== undefined && next.pickCursor >= unlockDue) {
    return chain(next, effects, (s) => runUnlock(s, ctx))
  }

  // Board full — no bingo, so it resolves on best line.
  const playable = next.squares.filter((s) => s.owner !== 'open' && s.status !== 'settled')
  if (playable.length === 0) return chain(next, effects, (s) => settle(s, ctx, 'bestLine'))

  return { state: next, effects }
}

/**
 * §12 — one-away is the money state, announced once per line per *entry*.
 *
 * Not once per line ever: a line can reach one-away, get knocked back, and
 * reach it again, and the second time is the one that matters. The cooldown
 * stops a square flipping back and forth from spamming chat.
 */
function oneAwayAnnouncements(before: BingoState, after: BingoState, ctx: Ctx): Effect[] {
  const was = new Map(before.lines.map((l) => [l.id, l.state]))
  const effects: Effect[] = []

  for (const line of after.lines) {
    if (line.state !== 'oneAway' || was.get(line.id) === 'oneAway') continue
    if (after.announcedOneAway.includes(line.id)) continue

    const remaining = line.squareIds.find(
      (id) => after.squares.find((s) => s.id === id)?.status !== 'settled',
    )
    effects.push(
      announce(`${lineLabel(line.id)} is one away — ${remaining ?? '?'} to go.`),
    )
    after.announcedOneAway.push(line.id)
  }

  void ctx
  void ONE_AWAY_COOLDOWN_MS
  return effects
}

function declareBingo(
  state: BingoState,
  completed: readonly Line[],
  ctx: Ctx,
  effects: Effect[],
): Result {
  const ids = completed.map((l) => l.id)
  const winners = winnersOf(state, ids)

  const next: BingoState = {
    ...state,
    phase: 'complete',
    bingoLines: ids,
    winningLine: ids[0] ?? null,
    winners,
    decidedBy: 'bingo',
  }

  void ctx
  return {
    state: next,
    effects: [
      ...effects,
      announce(
        `BINGO — ${ids.map(lineLabel).join(' and ')}! ` +
          (winners.length > 0
            ? `Winners: ${winners.map((w) => `@${w.username}`).join(', ')}.`
            : 'No viewer squares on the line.'),
      ),
      broadcast({ phase: 'complete', bingoLines: ids }),
      end('complete'),
    ],
  }
}

/**
 * Best line — §8.
 *
 * `settledEarly` narrows the field to lines whose squares have all been played:
 * a line still holding an unplayed square has not earned anything yet.
 */
function settle(state: BingoState, ctx: Ctx, reason: 'bestLine' | 'settledEarly'): Result {
  if (state.phase === 'complete') return { state, effects: [] }
  if (reason === 'settledEarly' && !ctx.config.allowSettleEarly) return { state, effects: [] }

  const lines = recomputeLines(state)
  const eligible =
    reason === 'settledEarly'
      ? fullyPlayedLines(state, lines)
      : lines.filter((l) => l.state !== 'dead' || l.greenCount > 0)

  const picked = bestLine(eligible.length > 0 ? eligible : lines, (id) => ctx.rng(`flip-${id}`).next())

  const next: BingoState = {
    ...state,
    lines,
    phase: 'complete',
    winningLine: picked?.line.id ?? null,
    winners: picked ? winnersOf({ ...state, lines }, [picked.line.id]) : [],
    decidedBy: reason === 'settledEarly' ? 'settledEarly' : (picked?.decidedBy ?? 'bestLine'),
    settledEarly: reason === 'settledEarly',
  }

  const label = picked ? lineLabel(picked.line.id) : 'no line'
  return {
    state: next,
    effects: [
      announce(
        (reason === 'settledEarly' ? 'Settled early. ' : 'Board complete. ') +
          `Best line: ${label} at ${picked ? formatMultiplier(picked.line.totalMultiplier) : '—'}` +
          (next.winners.length > 0
            ? ` — ${next.winners.map((w) => `@${w.username}`).join(', ')}.`
            : '.'),
      ),
      broadcast({ phase: 'complete', winningLine: next.winningLine, decidedBy: next.decidedBy }),
      end('complete'),
    ],
  }
}

/** An unlock mini-draw — §5.3. Same primitive as the main draw, smaller. */
function runUnlock(state: BingoState, ctx: Ctx): Result {
  const open = state.squares.find((s) => s.owner === 'open' && s.unlockAfterPick !== null)
  if (!open) return { state, effects: [] }

  // Only viewers who joined since the previous unlock — that is what makes the
  // reward for arriving late a real shot rather than an apology.
  const since = state.lastUnlockSeq ?? -1
  const eligible = state.standby.filter((m) => m.slotId !== null && m.joinedAtSeq > since)

  const draw = drawSeats(eligible, { seats: 1, reservedUserIds: [], rng: ctx.rng('unlock') })
  const seat = draw.seats[0]
  if (!seat) {
    return {
      state: { ...state, unlocksDone: state.unlocksDone + 1, lastUnlockSeq: ctx.seq },
      effects: [],
    }
  }

  const squares = state.squares.map((s) =>
    s.id === open.id
      ? {
          ...s,
          userId: seat.member.userId,
          username: seat.member.username,
          slotId: seat.member.slotId,
          slotName: seat.member.slotName,
          thumbnail: seat.member.thumbnail,
          owner: 'viewer' as const,
          source: 'unlock' as const,
          unlockAfterPick: null,
          claimedAtSeq: ctx.seq,
          history: [
            ...s.history,
            {
              userId: seat.member.userId,
              username: seat.member.username,
              slotId: seat.member.slotId,
              slotName: seat.member.slotName,
              claimedAtSeq: ctx.seq,
              via: 'unlock' as const,
              burnedAtSeq: null,
            },
          ],
        }
      : s,
  )

  const stillOpen = squares.some((s) => s.owner === 'open' && s.unlockAfterPick !== null)
  const next: BingoState = {
    ...state,
    squares,
    standby: state.standby.filter((m) => m.userId !== seat.member.userId),
    unlocksDone: state.unlocksDone + 1,
    lastUnlockSeq: ctx.seq,
    joinsOpen: stillOpen,
  }

  // §5.3 — a late square may sit on lines that are already dead, and the
  // viewer should hear that now rather than discover it four picks later.
  const alive = next.lines.filter(
    (l) => l.squareIds.includes(open.id) && l.state !== 'dead',
  ).length
  const total = lineCountFor(open, state.size)

  return {
    state: { ...next, lines: recomputeLines(next) },
    effects: [
      announce(
        `${open.id} unlocks to @${seat.member.username} · ${seat.member.slotName ?? 'slot'} — ` +
          `${alive} of ${total} lines through it still alive.`,
      ),
    ],
  }
}

/** §9 — convert an open square to HOUSE when the streamer stops taking entries. */
function skipUnlock(state: BingoState, ctx: Ctx): Result {
  const open = state.squares.find((s) => s.owner === 'open' && s.unlockAfterPick !== null)
  if (!open) return { state, effects: [] }

  const squares = state.squares.map((s) =>
    s.id === open.id ? { ...s, owner: 'house' as const, source: 'house' as const, unlockAfterPick: null } : s,
  )
  const stillOpen = squares.some((s) => s.owner === 'open' && s.unlockAfterPick !== null)

  void ctx
  return {
    state: { ...state, squares, unlocksDone: state.unlocksDone + 1, joinsOpen: stillOpen },
    effects: [],
  }
}

/** §5.4 — the streamer's own slot on an unfilled square. Plays, wins nothing. */
function fillHouse(state: BingoState, p: Record<string, unknown>, ctx: Ctx): Result {
  const targetId = String(p.squareId ?? '')
  const square = state.squares.find((s) => s.id === targetId)
  if (!square || square.owner === 'viewer') return { state, effects: [] }

  void ctx
  return {
    state: {
      ...state,
      squares: state.squares.map((s) =>
        s.id === targetId
          ? {
              ...s,
              owner: 'house',
              source: 'house',
              slotId: p.slotId ? String(p.slotId) : null,
              slotName: p.slotName ? String(p.slotName) : null,
              thumbnail: p.thumbnail ? String(p.thumbnail) : null,
              unlockAfterPick: null,
            }
          : s,
      ),
    },
    effects: [],
  }
}

/**
 * §9 — revert matters more here than in Tournament.
 *
 * A mistyped payout does not flip one square, it can resurrect or kill four
 * lines at once. So this pops the attempt and recomputes every line from
 * scratch rather than undoing incrementally. Once the board is complete it is
 * blocked entirely: a green that already fired a bingo and named winners in
 * chat is not an edit, that is `bingo.abandon`.
 */
function revert(state: BingoState, targetId: string, ctx: Ctx): Result {
  if (state.phase === 'complete') {
    return {
      state,
      effects: [
        broadcast({ inputError: 'The board is complete — use abandon rather than revert.' }),
      ],
    }
  }

  const square = state.squares.find((s) => s.id === targetId)
  if (!square || square.attempts.length === 0) return { state, effects: [] }

  const squares = state.squares.map((s) =>
    s.id === targetId
      ? {
          ...s,
          attempts: s.attempts.slice(0, -1),
          status: (s.attempts.length > 1 ? 'wounded' : 'unplayed') as Square['status'],
          tier: null,
        }
      : s,
  )

  const next = { ...state, squares, pickCursor: Math.max(0, state.pickCursor - 1) }
  void ctx
  return {
    state: { ...next, lines: recomputeLines(next) },
    effects: [broadcast({ phase: next.phase })],
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Runs a follow-on reducer and keeps the effects already queued. */
function chain(
  state: BingoState,
  effects: Effect[],
  step: (s: BingoState) => Result,
): Result {
  const result = step(state)
  return { state: result.state, effects: [...effects, ...result.effects] }
}

function replaceMember(list: readonly PoolMember[], member: PoolMember): PoolMember[] {
  return list.map((m) => (m.userId === member.userId ? member : m))
}

function findSlotHolder(state: BingoState, slotId: string, exceptUserId: string) {
  return (
    state.pool.find((p) => p.slotId === slotId && p.userId !== exceptUserId) ??
    state.standby.find((p) => p.slotId === slotId && p.userId !== exceptUserId)
  )
}

export function picksUntilNextUnlock(state: BingoState): number | null {
  const next = state.unlockSchedule[state.unlocksDone]
  if (next === undefined) return null
  return Math.max(0, next - state.pickCursor)
}

/** 'row3' → 'Row 3'. What the overlay and chat both say. */
export function lineLabel(id: string): string {
  if (id === 'diagA') return 'Diagonal ↘'
  if (id === 'diagB') return 'Diagonal ↙'
  const match = id.match(/^(row|col)(\d+)$/)
  if (!match) return id
  return `${match[1] === 'row' ? 'Row' : 'Column'} ${match[2]}`
}

export { buildLines, buildSquares }
