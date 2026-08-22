/**
 * Slot Tournament reducer — §14.
 *
 * "Tying slots to people is what makes this work. A bracket of slots is a
 * spreadsheet; a bracket of viewers is a tournament."
 *
 * Pure, like every reducer. The draw and every coin flip derive from
 * `ctx.rng(label)`, which is seeded from the session seed — so a replay reaches
 * the same champion, which is the whole basis for answering "the draw was
 * rigged".
 */

import {
  announce,
  broadcast,
  cancelTimer,
  drawSeats,
  end,
  formatMoney,
  formatMultiplier,
  lookup,
  rankScores,
  rejection,
  reply,
  round2,
  timer,
  topPredictor as pickTopPredictor,
  voteSplit,
  type Effect,
  type InternalEvent,
  type ReduceContext,
  type ReduceResult,
} from '@streamarena/core'
import {
  assignSeeds,
  buildBracket,
  cloneRounds,
  findMatch,
  nextPlayable,
  placeWinner,
  recomputeScores,
  resolveMatch,
  sideOf,
  validateResult,
} from './bracket.js'
import {
  JOIN_TIMER_ID,
  VOTE_TIMER_ID,
  type Entrant,
  type LookupThen,
  type Match,
  type PoolMember,
  type TournamentConfig,
  type TournamentState,
} from './types.js'

type Ctx = ReduceContext<TournamentConfig>
type Result = ReduceResult<TournamentState>

const STATUS_REPLY_COOLDOWN_MS = 60_000

export function reduce(state: TournamentState, event: InternalEvent, ctx: Ctx): Result {
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
      return handleTimer(state, event, ctx)

    default:
      return { state, effects: [] }
  }
}

// ─── Chat commands ──────────────────────────────────────────────────────────

function handleCommand(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  switch (event.command) {
    case 'join':
      return join(state, event, ctx)
    case 'vote':
      return vote(state, event, ctx)
    case 'bracket':
      return bracketReply(state, event, ctx)
    case 'score':
      return scoreReply(state, event)
    default:
      return { state, effects: [] }
  }
}

function join(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const { actor, messageId } = event

  if (state.phase !== 'joining' || state.joinsClosed) {
    return { state, effects: [rejection(`@${actor.username} entries are closed for this one.`, messageId)] }
  }

  const query = event.args.trim()
  if (query === '') {
    return {
      state,
      effects: [rejection(`@${actor.username} pick a slot to bring, e.g. !join Le Bandit`, messageId)],
    }
  }

  // §14 — one entry per viewer; a second !join replaces the first while the
  // window is open. Pool is uncapped: hundreds of joiners is fine, it's a list.
  const member: PoolMember = {
    userId: actor.userId,
    username: actor.username,
    role: actor.role,
    slotId: null,
    slotName: null,
    provider: null,
    rawText: query,
    joinedAtSeq: state.pool.find((p) => p.userId === actor.userId)?.joinedAtSeq ?? ctx.seq,
    suggestions: [],
  }

  const pool = [...state.pool.filter((p) => p.userId !== actor.userId), member]
  const then: LookupThen = { kind: 'pool', userId: actor.userId }
  return { state: { ...state, pool }, effects: [lookup(query, then)] }
}

function vote(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const { actor, messageId } = event
  const match = currentMatchOf(state)

  if (!match || match.status !== 'voting') {
    return { state, effects: [rejection(`@${actor.username} voting isn't open right now.`, messageId)] }
  }

  const choice = parseVote(event.args, match)
  if (!choice) {
    return {
      state,
      effects: [rejection(`@${actor.username} type !vote a or !vote b — or the slot name.`, messageId)],
    }
  }

  const rounds = cloneRounds(state.rounds)
  const target = findMatch(rounds, match.id)!
  target.votes[actor.userId] = choice
  target.voterNames[actor.userId] = actor.username

  return {
    state: {
      ...state,
      rounds,
      voterFirstSeen: {
        ...state.voterFirstSeen,
        [actor.userId]: state.voterFirstSeen[actor.userId] ?? ctx.seq,
      },
    },
    // Silent by design: the live A/B split bar on the overlay is the feedback,
    // and 400 vote acks would drown the channel (§15.1).
    effects: [],
  }
}

/** `!vote a`, `!vote b`, or a slot name matched against the two contenders only. */
function parseVote(args: string, match: Match): 'a' | 'b' | null {
  const raw = args.trim().toLowerCase()
  if (raw === 'a' || raw === '1') return 'a'
  if (raw === 'b' || raw === '2') return 'b'
  if (raw === '') return null

  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const needle = normalise(raw)
  if (needle === '') return null

  const aName = match.a ? normalise(match.a.slotName) : ''
  const bName = match.b && match.b !== 'bye' ? normalise(match.b.slotName) : ''
  const aUser = match.a ? normalise(match.a.username) : ''
  const bUser = match.b && match.b !== 'bye' ? normalise(match.b.username) : ''

  const hitsA = aName.includes(needle) || needle.includes(aName) || aUser === needle
  const hitsB = bName.includes(needle) || needle.includes(bName) || bUser === needle

  // Ambiguous between the two contenders is a non-vote, not a coin flip.
  if (hitsA && !hitsB) return 'a'
  if (hitsB && !hitsA) return 'b'
  return null
}

function bracketReply(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const last = state.lastStatusReplyAt
  if (last !== null && ctx.now - last < STATUS_REPLY_COOLDOWN_MS) return { state, effects: [] }

  const ranked = rankScores(state.scores).slice(0, 3)
  const standings =
    ranked.length === 0
      ? 'no predictions scored yet'
      : ranked.map((r) => `@${r.username} ${r.correct}/${r.total}`).join(', ')

  const match = currentMatchOf(state)
  const now =
    match && match.a && match.b !== 'bye' && match.b
      ? `Now: ${match.a.slotName} vs ${match.b.slotName}. `
      : ''

  return {
    state: { ...state, lastStatusReplyAt: ctx.now },
    effects: [reply(`${now}Top predictors: ${standings}`, event.messageId)],
  }
}

function scoreReply(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'command' }>,
): Result {
  const mine = state.scores[event.actor.userId]
  const text = mine
    ? `@${event.actor.username} you've called ${mine.correct} of ${mine.total} correctly.`
    : `@${event.actor.username} you haven't voted on a match yet — type !vote a or !vote b.`
  return { state, effects: [reply(text, event.messageId)] }
}

// ─── Slot resolution ────────────────────────────────────────────────────────

function handleSlotResolved(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'slot.resolved' }>,
  ctx: Ctx,
): Result {
  const then = event.then as LookupThen | null
  if (!then || then.kind !== 'pool') return { state, effects: [] }

  const member = state.pool.find((p) => p.userId === then.userId)
  if (!member) return { state, effects: [] }

  if (!event.match) {
    const top = event.suggestions[0]
    const patched = { ...member, suggestions: event.suggestions.slice(0, 3) }
    return {
      state: { ...state, pool: replaceMember(state.pool, patched) },
      effects: [
        rejection(
          top
            ? `@${member.username} couldn't match "${member.rawText}" — did you mean ${top.name}?`
            : `@${member.username} couldn't find "${member.rawText}" — check the spelling and try again.`,
        ),
      ],
    }
  }

  // §14 — "Slots are unique. First come, first served." And the duplicate
  // rejection MUST reach chat: a silently dropped !join leaves the viewer
  // believing they're entered until the draw passes them by.
  const holder = ctx.config.uniqueSlots
    ? state.pool.find((p) => p.slotId === event.match!.slotId && p.userId !== member.userId)
    : undefined

  if (holder) {
    return {
      state: { ...state, pool: state.pool.filter((p) => p.userId !== member.userId) },
      effects: [
        rejection(
          `@${member.username} ${event.match.name} is already claimed by ` +
            `@${holder.username} — pick another slot.`,
        ),
      ],
    }
  }

  const patched: PoolMember = {
    ...member,
    slotId: event.match.slotId,
    slotName: event.match.name,
    provider: event.match.provider,
    suggestions: [],
  }
  return { state: { ...state, pool: replaceMember(state.pool, patched) }, effects: [] }
}

// ─── Timers ─────────────────────────────────────────────────────────────────

function handleTimer(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'timer' }>,
  ctx: Ctx,
): Result {
  const payload = event.payload as { kind?: string; matchId?: string } | null

  if (payload?.kind === 'joinWindowEnd') {
    if (state.phase !== 'joining') return { state, effects: [] }
    return closeJoining(state)
  }

  if (payload?.kind === 'votingEnd') {
    const match = currentMatchOf(state)
    if (!match || match.id !== payload.matchId || match.status !== 'voting') {
      return { state, effects: [] }
    }
    return lockVoting(state, ctx)
  }

  return { state, effects: [] }
}

// ─── Streamer / moderator control ───────────────────────────────────────────

function handleControl(
  state: TournamentState,
  event: Extract<InternalEvent, { type: 'control' }>,
  ctx: Ctx,
): Result {
  const p = event.payload

  switch (event.action) {
    case 'join.close':
      return closeJoining(state)
    case 'seats.set':
      return setSeats(state, Number(p.seats ?? state.seats))
    case 'reserve.add':
      return reserve(state, String(p.userId ?? ''), true)
    case 'reserve.remove':
      return reserve(state, String(p.userId ?? ''), false)
    case 'pool.resolve':
      return resolvePoolMember(state, p)
    case 'pool.remove':
      return { state: { ...state, pool: state.pool.filter((m) => m.userId !== String(p.userId ?? '')) }, effects: [] }
    case 'draw.run':
      return runDraw(state, ctx)
    case 'entrant.replace':
      return replaceEntrant(state, String(p.entrantId ?? ''), ctx)
    case 'match.startVoting':
      return startVoting(state, ctx)
    case 'match.lockVoting':
      return lockVoting(state, ctx)
    case 'match.result':
      return recordResult(state, p, ctx)
    case 'match.revert':
      return revertMatch(state, String(p.matchId ?? ''))
    case 'tournament.abandon':
      // §14 — "Abandoned mid-bracket: no champion; prediction leaderboard still
      // saved and announced."
      return abandon(state)
    default:
      return { state, effects: [] }
  }
}

function closeJoining(state: TournamentState): Result {
  if (state.phase !== 'joining') return { state, effects: [] }
  return {
    state: { ...state, phase: 'draw', joinsClosed: true, joinWindowEndsAt: null },
    effects: [cancelTimer(JOIN_TIMER_ID)],
  }
}

function setSeats(state: TournamentState, seats: number): Result {
  // §14 — "Fewer joiners than seats: offer next size down." The dashboard asks;
  // this just applies the answer, and only before the draw has run.
  if (state.drawCompleted) return { state, effects: [] }
  if (![8, 12, 16].includes(seats)) return { state, effects: [] }
  return { state: { ...state, seats }, effects: [] }
}

function reserve(state: TournamentState, userId: string, add: boolean): Result {
  if (userId === '' || state.drawCompleted) return { state, effects: [] }
  const current = new Set(state.reservedUserIds)
  if (add) {
    if (current.size >= state.seats) return { state, effects: [] }
    current.add(userId)
  } else {
    current.delete(userId)
  }
  return { state: { ...state, reservedUserIds: [...current] }, effects: [] }
}

function resolvePoolMember(state: TournamentState, p: Record<string, unknown>): Result {
  const userId = String(p.userId ?? '')
  const member = state.pool.find((m) => m.userId === userId)
  if (!member || !p.slotId) return { state, effects: [] }

  const patched: PoolMember = {
    ...member,
    slotId: String(p.slotId),
    slotName: p.slotName ? String(p.slotName) : member.slotName,
    provider: p.provider ? String(p.provider) : member.provider,
    suggestions: [],
  }
  return { state: { ...state, pool: replaceMember(state.pool, patched) }, effects: [] }
}

/**
 * §14 — the draw.
 *
 *   1. Reserved seats first, labelled openly. "Shown openly and up front, the
 *      same act reads as generosity."
 *   2. Random fill from the rest, using the session seed so the draw is
 *      reproducible on replay.
 *
 * "The draw runs once and cannot be re-rolled. No re-roll button anywhere in
 * the UI. The fairness of this game is the product." — hence the guard below.
 */
function runDraw(state: TournamentState, ctx: Ctx): Result {
  if (state.drawCompleted) return { state, effects: [] }

  // Only entrants whose slot actually resolved can be drawn — a seat holding an
  // unknown slot has nothing to play. Say so rather than failing silently, or
  // the dashboard sits on a spinner with no idea what went wrong.
  const eligible = state.pool.filter((m) => m.slotId !== null)
  if (eligible.length === 0) {
    return {
      state,
      effects: [
        broadcast({
          inputError:
            state.pool.length === 0
              ? 'Nobody joined yet — no one to draw from.'
              : `None of the ${state.pool.length} joins matched a slot. Resolve them in the queue first.`,
        }),
      ],
    }
  }

  const result = drawSeats(eligible, {
    seats: state.seats,
    reservedUserIds: state.reservedUserIds,
    rng: ctx.rng('draw'),
  })

  const drawn: Entrant[] = result.seats.map((seat) => ({
    id: `s${seat.seedNumber}`,
    userId: seat.member.userId,
    username: seat.member.username,
    slotId: seat.member.slotId,
    slotName: seat.member.slotName ?? seat.member.rawText,
    seedNumber: seat.seedNumber,
    source: seat.source,
    hasBye: false,
  }))

  const seeded = assignSeeds(drawn, ctx.rng('seeding'))
  const built = buildBracket(seeded)

  const next: TournamentState = {
    ...state,
    phase: 'seeding',
    entrants: built.entrants,
    rounds: built.rounds,
    bracketSize: built.rounds[0]!.matches.length * 2,
    drawCompleted: true,
    currentMatch: null,
  }

  const withPointer = pointAtNextMatch(next)
  const effects: Effect[] = [
    // §14 — make the draw an on-stream moment. The overlay owns the animation;
    // the reducer just tells it the reveal is starting and hands it the order.
    broadcast({
      drawReveal: {
        order: built.entrants
          .slice()
          .sort((a, b) => a.seedNumber - b.seedNumber)
          .map((e) => ({
            username: e.username,
            slotName: e.slotName,
            source: e.source,
            hasBye: e.hasBye,
          })),
      },
    }),
  ]

  if (ctx.config.announceDraw) {
    effects.push(announce(drawAnnouncement(built.entrants)))
  }

  return { state: withPointer.state, effects: [...effects, ...withPointer.effects] }
}

/**
 * §15.4 — "Sixteen usernames plus slot names overflows 500 characters —
 * announce usernames only, and truncate with '…and 4 more — full bracket on
 * screen.'"
 */
function drawAnnouncement(entrants: readonly Entrant[]): string {
  const tail = ' Predictions open now — type !vote a or !vote b each round.'
  const head = `Tournament locked in! ${entrants.length} entrants: `
  const budget = 500 - head.length - tail.length

  const names: string[] = []
  let used = 0
  for (const e of entrants) {
    const piece = `@${e.username}`
    const extra = names.length === 0 ? piece.length : piece.length + 2
    const remaining = entrants.length - names.length
    const suffix = `…and ${remaining} more — full bracket on screen.`
    if (used + extra + suffix.length > budget) break
    names.push(piece)
    used += extra
  }

  const omitted = entrants.length - names.length
  const list =
    omitted > 0
      ? `${names.join(', ')}…and ${omitted} more — full bracket on screen.`
      : `${names.join(', ')}.`

  return `${head}${list}${tail}`
}

/**
 * §14 — "Entrant's slot unresolvable at draw: flag the seat; 'Replace' draws a
 * fresh entrant." Uses the same seed with a per-seat label, so it stays
 * reproducible without disturbing the original draw.
 */
function replaceEntrant(state: TournamentState, entrantId: string, ctx: Ctx): Result {
  const entrant = state.entrants.find((e) => e.id === entrantId)
  if (!entrant || state.phase === 'complete') return { state, effects: [] }

  const taken = new Set(state.entrants.map((e) => e.userId))
  const candidates = state.pool.filter((m) => m.slotId !== null && !taken.has(m.userId))
  const replacement = ctx.rng(`replace:${entrantId}`).pick(
    candidates.slice().sort((a, b) => a.joinedAtSeq - b.joinedAtSeq),
  )
  if (!replacement) return { state, effects: [] }

  const patched: Entrant = {
    ...entrant,
    userId: replacement.userId,
    username: replacement.username,
    slotId: replacement.slotId,
    slotName: replacement.slotName ?? replacement.rawText,
    source: 'random',
  }

  const rounds = cloneRounds(state.rounds)
  for (const round of rounds) {
    for (const match of round.matches) {
      if (match.a?.entrantId === entrantId) match.a = { ...match.a, ...sideOf(patched) }
      if (match.b && match.b !== 'bye' && match.b.entrantId === entrantId) {
        match.b = { ...match.b, ...sideOf(patched) }
      }
    }
  }

  return {
    state: {
      ...state,
      entrants: state.entrants.map((e) => (e.id === entrantId ? patched : e)),
      rounds,
    },
    effects: [],
  }
}

function startVoting(state: TournamentState, ctx: Ctx): Result {
  const match = currentMatchOf(state)
  if (!match || match.status === 'decided') return { state, effects: [] }

  const rounds = cloneRounds(state.rounds)
  const target = findMatch(rounds, match.id)!
  target.status = 'voting'
  target.votingEndsAt = ctx.now + ctx.config.votingWindowMs

  return {
    state: { ...state, phase: 'voting', rounds },
    effects: [timer(ctx.config.votingWindowMs, { kind: 'votingEnd', matchId: match.id }, VOTE_TIMER_ID)],
  }
}

function lockVoting(state: TournamentState, _ctx: Ctx): Result {
  const match = currentMatchOf(state)
  if (!match || match.status !== 'voting') return { state, effects: [] }

  const rounds = cloneRounds(state.rounds)
  const target = findMatch(rounds, match.id)!
  target.status = 'playing'
  target.votingEndsAt = null

  return {
    state: { ...state, phase: 'playing', rounds },
    effects: [cancelTimer(VOTE_TIMER_ID), broadcast({ flash: { kind: 'votesLocked', split: voteSplit(target.votes) } })],
  }
}

/**
 * The streamer enters four numbers; the winner is computed, never chosen (§14).
 * Editable until the winner advances — after that a revert is required, which
 * is deliberate friction on a decision viewers already watched happen.
 */
function recordResult(state: TournamentState, p: Record<string, unknown>, ctx: Ctx): Result {
  const id = String(p.matchId ?? currentMatchOf(state)?.id ?? '')
  const match = findMatch(state.rounds, id)
  if (!match || !match.a || !match.b || match.b === 'bye') return { state, effects: [] }
  if (match.winner !== null) return { state, effects: [] }

  const aBuyCost = round2(Number(p.aBuyCost))
  const aPayout = round2(Number(p.aPayout))
  const bBuyCost = round2(Number(p.bBuyCost))
  const bPayout = round2(Number(p.bPayout))

  // §14 — rejected at input with an inline error. The reducer refuses too, so a
  // scripted or replayed control event can't sneak a divide-by-zero through.
  const problem = validateResult(aBuyCost, aPayout) ?? validateResult(bBuyCost, bPayout)
  if (problem) return { state, effects: [broadcast({ inputError: problem })] }

  const resolution = resolveMatch(
    { aBuyCost, aPayout, bBuyCost, bPayout },
    () => ctx.rng(`coinflip:${match.id}`).coinFlip(),
  )

  const rounds = cloneRounds(state.rounds)
  const target = findMatch(rounds, id)!
  target.a = { ...target.a!, buyCost: aBuyCost, payout: aPayout, multiplier: resolution.aMultiplier }
  target.b = {
    ...(target.b as Exclude<Match['b'], 'bye' | null>),
    buyCost: bBuyCost,
    payout: bPayout,
    multiplier: resolution.bMultiplier,
  }
  target.winner = resolution.winner
  target.decidedBy = resolution.decidedBy
  target.status = 'decided'

  const winnerSide = resolution.winner === 'a' ? target.a : (target.b as Exclude<Match['b'], 'bye' | null>)
  placeWinner(rounds, target, winnerSide)

  const next: TournamentState = {
    ...state,
    rounds,
    scores: recomputeScores(rounds, state.voterFirstSeen),
  }

  const effects: Effect[] = [
    broadcast({
      matchResult: {
        matchId: target.id,
        winner: resolution.winner,
        // §14 — "Always state on screen how a tiebreak was decided. An
        // unexplained winner on stream reads as broken software."
        decidedBy: resolution.decidedBy,
        a: { username: target.a.username, slotName: target.a.slotName, multiplier: resolution.aMultiplier },
        b: {
          username: (target.b as MatchSideLike).username,
          slotName: (target.b as MatchSideLike).slotName,
          multiplier: resolution.bMultiplier,
        },
      },
    }),
  ]

  const advanced = advance(next, ctx)
  return { state: advanced.state, effects: [...effects, ...advanced.effects] }
}

type MatchSideLike = { username: string; slotName: string }

/** §14 — "Match reverted: votes restored, scores recalculated from the event log." */
function revertMatch(state: TournamentState, id: string): Result {
  const match = findMatch(state.rounds, id)
  if (!match || match.winner === null || match.decidedBy === 'bye') return { state, effects: [] }

  const rounds = cloneRounds(state.rounds)
  const target = findMatch(rounds, id)!

  // Clear this match and everything downstream of it — a later round built on a
  // reverted result is no longer meaningful.
  target.winner = null
  target.decidedBy = null
  target.status = 'pending'
  if (target.a) target.a = { ...target.a, buyCost: null, payout: null, multiplier: null }
  if (target.b && target.b !== 'bye') {
    target.b = { ...target.b, buyCost: null, payout: null, multiplier: null }
  }

  for (const round of rounds) {
    if (round.roundIndex <= target.roundIndex) continue
    for (const m of round.matches) {
      m.a = null
      m.b = null
      m.winner = null
      m.decidedBy = null
      m.status = 'pending'
      m.votes = {}
      m.voterNames = {}
    }
  }
  // Re-propagate every still-decided result into the cleared rounds.
  for (const round of rounds) {
    for (const m of round.matches) {
      if (m.winner === null) continue
      const side = m.winner === 'a' ? m.a : m.b
      if (side && side !== 'bye') placeWinner(rounds, m, side)
    }
  }

  return {
    state: {
      ...state,
      rounds,
      phase: 'playing',
      champion: null,
      topPredictor: null,
      scores: recomputeScores(rounds, state.voterFirstSeen),
      currentMatch: null,
    },
    effects: [],
  }
}

/** Move the pointer on, or finish the tournament if the final just resolved. */
function advance(state: TournamentState, ctx: Ctx): Result {
  const upcoming = nextPlayable(state.rounds)
  if (upcoming) return pointAtNextMatch(state)

  const final = state.rounds.at(-1)?.matches[0]
  if (!final || final.winner === null) return { state: { ...state, currentMatch: null }, effects: [] }

  const winningSide = final.winner === 'a' ? final.a : final.b
  const losingSide = final.winner === 'a' ? final.b : final.a
  if (!winningSide || winningSide === 'bye') return { state, effects: [] }

  const championEntrant = state.entrants.find((e) => e.id === winningSide.entrantId)
  const champion = championEntrant
    ? {
        userId: championEntrant.userId,
        username: championEntrant.username,
        slotName: championEntrant.slotName,
      }
    : null

  const top = pickTopPredictor(state.scores)
  const next: TournamentState = {
    ...state,
    phase: 'complete',
    currentMatch: null,
    champion,
    topPredictor: top
      ? { userId: top.userId, username: top.username, correct: top.correct, total: top.total }
      : null,
  }

  const effects: Effect[] = []

  // §15.4 — always two messages. The bracket win and the prediction win are
  // different achievements; merging them buries both.
  if (champion && losingSide && losingSide !== 'bye') {
    effects.push(
      announce(
        `@${champion.username} wins the tournament! ${champion.slotName} took the final at ` +
          `${formatMultiplier(winningSide.multiplier ?? 0)} against @${losingSide.username}'s ` +
          `${losingSide.slotName} at ${formatMultiplier(losingSide.multiplier ?? 0)}.`,
      ),
    )
  } else if (champion) {
    effects.push(announce(`@${champion.username} wins the tournament with ${champion.slotName}!`))
  }

  if (next.topPredictor) {
    effects.push(
      announce(
        `Best predictor: @${next.topPredictor.username} with ${next.topPredictor.correct}/` +
          `${next.topPredictor.total} matches called correctly.`,
      ),
    )
  }

  effects.push(end('complete'))
  return { state: next, effects }
}

function abandon(state: TournamentState): Result {
  const top = pickTopPredictor(state.scores)
  const effects: Effect[] = []
  if (top) {
    effects.push(
      announce(
        `Tournament called off, but the predictions still count — best predictor: ` +
          `@${top.username} with ${top.correct}/${top.total}.`,
      ),
    )
  }
  effects.push(end('abandoned'))
  return {
    state: {
      ...state,
      phase: 'complete',
      topPredictor: top
        ? { userId: top.userId, username: top.username, correct: top.correct, total: top.total }
        : null,
    },
    effects,
  }
}

function pointAtNextMatch(state: TournamentState): Result {
  const match = nextPlayable(state.rounds)
  if (!match) return { state: { ...state, currentMatch: null }, effects: [] }
  return {
    state: {
      ...state,
      phase: state.phase === 'seeding' ? 'seeding' : 'playing',
      currentMatch: { roundIndex: match.roundIndex, matchIndex: match.matchIndex },
    },
    effects: [],
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function currentMatchOf(state: TournamentState): Match | null {
  if (!state.currentMatch) return null
  return (
    state.rounds[state.currentMatch.roundIndex]?.matches[state.currentMatch.matchIndex] ?? null
  )
}

function replaceMember(pool: readonly PoolMember[], patched: PoolMember): PoolMember[] {
  return pool.map((m) => (m.userId === patched.userId ? patched : m))
}

export function formatMoneyFor(amount: number, currency = 'EUR'): string {
  return formatMoney(amount, currency)
}
