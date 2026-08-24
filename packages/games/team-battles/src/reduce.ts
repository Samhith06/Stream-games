/**
 * Team Battles reducer — §4 to §12.
 *
 * Pure, like every reducer. The one thing to keep in mind while reading it is
 * that **the flip is not decided here**. `flipSequence` was committed at
 * session creation (§6.1) and this file only reads it, which is what lets the
 * overlay animation be playback rather than a decision.
 *
 * The other load-bearing rule is §6.2: a veto is legal in `pick` and rejected
 * in every phase after it. That is enforced in the state machine rather than in
 * guidance, because a veto available after the flip is a re-roll of the team,
 * and a streamer who vetoes a slot that just landed on the team they were
 * rooting for has visibly rigged the session whether they meant to or not.
 */

import {
  ack,
  announce,
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
import { bagRemaining } from './flip.js'
import {
  crowd,
  needsSuddenDeath,
  picksRemaining,
  resolveWinner,
  swing,
  teamPicks,
  teamScore,
  teamTotal,
} from './scoring.js'
import {
  JOIN_TIMER_ID,
  type BattlePhase,
  type BattleState,
  type BattlesConfig,
  type Pick,
  type PoolMember,
  type TeamKey,
} from './types.js'

type Ctx = ReduceContext<BattlesConfig>
type Result = ReduceResult<BattleState>

interface LookupThen {
  kind: 'pool'
  userId: string
}

/** §11 — !teams is the most spammable command in a two-team game. */
const TEAMS_REPLY_COOLDOWN_MS = 30_000
/** §12 — the one mid-session event worth a chat write, deduped. */
const LEAD_CHANGE_COOLDOWN_MS = 90_000

export function reduce(state: BattleState, event: InternalEvent, ctx: Ctx): Result {
  switch (event.type) {
    case 'session.started': {
      const effects: Effect[] = [broadcast({ phase: state.phase })]

      // §6.1 — the commitment is published once, at the start, so it can be
      // checked against the reveal at COMPLETE.
      if (ctx.config.publishFlipHash) {
        effects.push(
          announce(
            `TEAM BATTLES — ${state.maxPicks} picks, ${state.teams.A.name} vs ${state.teams.B.name}. ` +
              `!join <slot> to enter, !side ${state.teams.A.name.toLowerCase()} / ` +
              `!side ${state.teams.B.name.toLowerCase()} to pick who you're rooting for. ` +
              `Flip sequence committed: ${state.flipSequenceHash}`,
          ),
        )
      }

      const windowMs = ctx.config.joinWindowMs
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
        ? closeJoinWindow(state)
        : { state, effects: [] }

    default:
      return { state, effects: [] }
  }
}

// ─── Chat commands ──────────────────────────────────────────────────────────

function handleCommand(
  state: BattleState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  switch (event.command) {
    case 'join':
      return join(state, event, ctx)
    case 'side':
      return declareSide(state, event, ctx)
    case 'teams':
      return teamsReply(state, event, ctx)
    case 'me':
      return meReply(state, event, ctx)
    default:
      return { state, effects: [] }
  }
}

/**
 * `!join <slot>` — §5.
 *
 * Joins never close after the opening window. A viewer arriving at pick 9 of 15
 * can still enter and still be drawn, which is also what stops an empty pool
 * from ending the session (§16).
 */
function join(
  state: BattleState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const actor = event.actor
  const query = (event.args ?? '').trim()

  if (!state.joinsOpen) {
    return { state, effects: [rejection(`@${actor.username} joining is closed.`, event.messageId)] }
  }
  if (query === '') {
    return {
      state,
      effects: [rejection(`@${actor.username} name a slot — !join Gates of Olympus`, event.messageId)],
    }
  }

  // §5 — one pick per viewer per session, unless re-entry is configured.
  const alreadyDrawn = state.drawnUserIds.includes(actor.userId)
  if (alreadyDrawn && !canReenter(state, actor.userId, ctx)) {
    return {
      state,
      effects: [
        rejection(`@${actor.username} you've already had your pick this session.`, event.messageId),
      ],
    }
  }

  const existing = state.pool.find((m) => m.userId === actor.userId)

  /*
   * §5 — the cap is a rolling window, not a first-minute land grab: drawn
   * entrants free their spot. And when it is hit, say so, because a silently
   * closed door is the worst version of this.
   */
  if (!existing && ctx.config.poolCap !== null && state.pool.length >= ctx.config.poolCap) {
    return {
      state: { ...state, poolCapReached: true },
      effects: [
        rejection(
          `@${actor.username} pool is full — ${ctx.config.poolCap} slots claimed. ` +
            `Spots reopen as entrants get drawn.`,
          event.messageId,
        ),
      ],
    }
  }

  const member: PoolMember = {
    userId: actor.userId,
    username: actor.username,
    role: actor.role,
    slotId: null,
    slotName: null,
    provider: null,
    thumbnail: null,
    buyCostX: null,
    rawText: query,
    joinedAtSeq: existing?.joinedAtSeq ?? ctx.seq,
    suggestions: [],
  }

  const pool = existing
    ? state.pool.map((m) => (m.userId === actor.userId ? member : m))
    : [...state.pool, member]

  const then: LookupThen = { kind: 'pool', userId: actor.userId }
  return { state: { ...state, pool }, effects: [lookup(query, then)] }
}

function canReenter(state: BattleState, userId: string, ctx: Ctx): boolean {
  const after = ctx.config.reentryAfterPicks
  if (after === null) return false

  const lastPick = [...state.picks].reverse().find((p) => p.userId === userId)
  if (!lastPick) return true

  const resolvedSince = state.picks.filter(
    (p) => p.index > lastPick.index && (p.multiplier !== null || p.vetoed),
  ).length
  return resolvedSince >= after
}

/**
 * `!side chaos` / `!side fortune` — §7.
 *
 * First declaration is permanent. A game where allegiance is fluid has no
 * allegiance, and the reward at the end becomes a prize for correct timing
 * rather than for backing a side.
 */
function declareSide(
  state: BattleState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const actor = event.actor
  const raw = (event.args ?? '').trim().toLowerCase()

  /*
   * The router already switches the command off, so this should be
   * unreachable. Kept because the reducer is the thing replayed from the log,
   * and a config change between a session's start and a later replay must not
   * be able to let a declaration in through the back door.
   */
  if (ctx.config.sideGate === 'nobody') return { state, effects: [] }

  if (state.sidesLocked) {
    return {
      state,
      effects: [
        rejection(
          `@${actor.username} sides are locked for this session — but !join is still open.`,
          event.messageId,
        ),
      ],
    }
  }

  /*
   * A side the system handed out is not a decision, so it does not bind.
   *
   * §7's "no switching" exists to stop a viewer reading the scoreboard and
   * changing their mind — it was never meant to lock someone out of choosing at
   * all. With autoSideOnJoin on, refusing here would take the choice away from
   * exactly the people who participate most: everyone who enters the pool would
   * be stuck with a coin toss they never asked for.
   */
  if (state.sides[actor.userId] && !state.sides[actor.userId]!.auto) {
    const held = state.sides[actor.userId]!
    return {
      state,
      effects: [
        rejection(
          `@${actor.username} you're already with ${state[
            'teams'
          ][held.team].name.toUpperCase()} — sides are for the whole session.`,
          event.messageId,
        ),
      ],
    }
  }

  const team = matchTeam(state, raw)
  if (!team) {
    return {
      state,
      effects: [
        rejection(
          `@${actor.username} pick a side — !side ${state.teams.A.name.toLowerCase()} or ` +
            `!side ${state.teams.B.name.toLowerCase()}`,
          event.messageId,
        ),
      ],
    }
  }

  const sides = {
    ...state.sides,
    [actor.userId]: { username: actor.username, team, declaredAtSeq: ctx.seq, auto: false },
  }

  return {
    state: { ...state, sides },
    effects: [
      // Batched: at scale this is the highest-volume command in the game and
      // every one of them is a viewer expecting confirmation.
      ack(`@${actor.username} is with ${state.teams[team].name.toUpperCase()}`, event.messageId),
      broadcast({ crowdA: crowd(sides, 'A'), crowdB: crowd(sides, 'B') }),
    ],
  }
}

/** Accepts the team's own name, plus `a`/`b`, so aliases keep working if renamed. */
function matchTeam(state: BattleState, raw: string): TeamKey | null {
  const word = raw.split(/\s+/)[0] ?? ''
  if (word === '') return null
  if (word === 'a' || word === state.teams.A.name.toLowerCase()) return 'A'
  if (word === 'b' || word === state.teams.B.name.toLowerCase()) return 'B'
  return null
}

/** `!teams` — §11, throttled hard because the answer is already on screen. */
function teamsReply(
  state: BattleState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  if (
    state.lastTeamsReplyAt !== null &&
    ctx.now - state.lastTeamsReplyAt < TEAMS_REPLY_COOLDOWN_MS
  ) {
    return { state, effects: [] }
  }

  const metric = ctx.config.winMetric
  const remaining = picksRemaining(state.picks, state.maxPicks, state.suddenDeathPicks)

  return {
    state: { ...state, lastTeamsReplyAt: ctx.now },
    effects: [
      reply(
        `${state.teams.A.name.toUpperCase()} ${formatMultiplier(teamScore(state.picks, 'A', metric))} ` +
          `(${teamPicks(state.picks, 'A').length} picks) · ` +
          `${state.teams.B.name.toUpperCase()} ${formatMultiplier(teamScore(state.picks, 'B', metric))} ` +
          `(${teamPicks(state.picks, 'B').length} picks) · ${remaining} picks left`,
      ),
    ],
  }
}

/** `!me` — in pool, drawn, which team, what they pulled. */
function meReply(
  state: BattleState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const actor = event.actor
  const pick = [...state.picks].reverse().find((p) => p.userId === actor.userId && !p.vetoed)

  if (pick) {
    const team = state.teams[pick.team].name.toUpperCase()
    const text =
      pick.multiplier !== null
        ? `@${actor.username} you played ${pick.slotName ?? 'your slot'} for ${team} — ${formatMultiplier(pick.multiplier)}`
        : `@${actor.username} you're up for ${team} with ${pick.slotName ?? 'your slot'}`
    return { state, effects: [reply(text, event.messageId)] }
  }

  const entry = state.pool.find((m) => m.userId === actor.userId)
  if (entry) {
    const side = state.sides[actor.userId]
    const rooting = side ? ` · rooting for ${state.teams[side.team].name.toUpperCase()}` : ''
    return {
      state,
      effects: [
        reply(
          `@${actor.username} you're in the pool with ${entry.slotName ?? entry.rawText}${rooting}`,
          event.messageId,
        ),
      ],
    }
  }

  return {
    state,
    effects: [reply(`@${actor.username} you're not in yet — !join <slot>`, event.messageId)],
  }
}

// ─── Slot resolution ────────────────────────────────────────────────────────

/**
 * The catalog came back — and §10's curation guards run here rather than at buy
 * time.
 *
 * A bad-faith entry in this game is not a personal loss any more: the
 * multiplier is banked to a team of a dozen people who had no say in it. So a
 * rejection has to reach the person who typed it, in chat, at join time.
 */
function handleSlotResolved(
  state: BattleState,
  event: Extract<InternalEvent, { type: 'slot.resolved' }>,
  ctx: Ctx,
): Result {
  const then = event.then as LookupThen | undefined
  if (!then || then.kind !== 'pool') return { state, effects: [] }

  const member = state.pool.find((m) => m.userId === then.userId)
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

  const verdict = curationVerdict(event.match, ctx.config)
  if (!verdict.ok) {
    return {
      state: { ...state, pool: state.pool.filter((m) => m.userId !== member.userId) },
      effects: [rejection(`@${member.username} ${verdict.reason}`)],
    }
  }

  // §5 — slots are unique, first come first served, and the rejection reaches
  // chat. A silently dropped !join leaves the viewer believing they're entered
  // right up until the session passes them by.
  if (ctx.config.uniqueSlots) {
    const holder =
      state.pool.find((m) => m.slotId === event.match!.slotId && m.userId !== member.userId) ??
      state.picks.find((p) => p.slotId === event.match!.slotId && p.userId !== member.userId)

    if (holder) {
      return {
        state: { ...state, pool: state.pool.filter((m) => m.userId !== member.userId) },
        effects: [
          rejection(
            `@${member.username} ${event.match.name} is already claimed by @${holder.username} — pick another slot.`,
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
    buyCostX: event.match.buyCostX ?? null,
    suggestions: [],
  }

  const next = { ...state, pool: replaceMember(state.pool, patched) }
  return { state: autoSide(next, member.userId, member.username, ctx), effects: [] }
}

/**
 * `autoSideOnJoin` — put a confirmed entrant on a side if they haven't picked.
 *
 * Applied here rather than at !join, because a viewer whose slot never resolves
 * is removed from the pool again and should not be left holding an allegiance
 * to a session they are not in.
 *
 * Never overrides a real declaration, never fires once sides are locked, and is
 * seeded per user so a replay produces the same crowd split. The `sideGate`
 * deliberately does not apply: it governs who may *choose* a side in chat, and
 * this is the streamer choosing on behalf of everyone who entered.
 */
function autoSide(
  state: BattleState,
  userId: string,
  username: string,
  ctx: Ctx,
): BattleState {
  if (!ctx.config.autoSideOnJoin) return state
  if (state.sidesLocked) return state
  if (state.sides[userId]) return state

  const team: TeamKey = ctx.rng(`autoside-${userId}`).coinFlip() ? 'A' : 'B'
  return {
    ...state,
    sides: {
      ...state.sides,
      [userId]: { username, team, declaredAtSeq: ctx.seq, auto: true },
    },
  }
}

type Curation = { ok: true } | { ok: false; reason: string }

/**
 * §10's guards, in the order that produces the most useful rejection.
 *
 * Unknown is not failure. Almost nothing in the imported catalog carries buy
 * data, so treating "we don't know" as "too expensive" would reject nearly
 * every entry and the streamer would conclude the game is broken rather than
 * that the catalog is thin. `allowUnknownBuyCost` is the switch for a streamer
 * who has curated their own list and wants the strict reading.
 */
export function curationVerdict(
  match: {
    name: string
    provider: string | null
    buyCostX?: number | null
    hasBonusBuy?: boolean | null
    volatility?: string | null
  },
  config: BattlesConfig,
): Curation {
  const blockedSlot = config.blockedSlots.some(
    (s) => s.toLowerCase() === match.name.toLowerCase(),
  )
  if (blockedSlot) return { ok: false, reason: `${match.name} isn't in play this session.` }

  if (
    match.provider &&
    config.blockedProviders.some((p) => p.toLowerCase() === match.provider!.toLowerCase())
  ) {
    return { ok: false, reason: `${match.provider} isn't available on this casino — pick another slot.` }
  }

  // Established fact, not an assumption: only `false` blocks, never null.
  if (match.hasBonusBuy === false) {
    return { ok: false, reason: `${match.name} has no bonus buy — pick a slot with one.` }
  }

  const buy = match.buyCostX ?? null
  if (buy === null) {
    if (!config.allowUnknownBuyCost) {
      return {
        ok: false,
        reason: `we don't have a buy price for ${match.name} — pick another slot.`,
      }
    }
  } else if (buy < config.minBuyX || buy > config.maxBuyX) {
    return {
      ok: false,
      reason:
        `${match.name}'s buy is ${round2(buy)}x — this session takes ` +
        `${config.minBuyX}x–${config.maxBuyX}x buys. Pick another slot.`,
    }
  }

  if (config.minVolatility && match.volatility) {
    const rank = { low: 0, medium: 1, high: 2 }
    const floor = rank[config.minVolatility]
    const actual = rank[match.volatility.toLowerCase() as 'low' | 'medium' | 'high']
    if (actual !== undefined && actual < floor) {
      return {
        ok: false,
        reason: `${match.name} is ${match.volatility} volatility — this session wants ${config.minVolatility} or above.`,
      }
    }
  }

  return { ok: true }
}

const replaceMember = (pool: PoolMember[], patched: PoolMember): PoolMember[] =>
  pool.map((m) => (m.userId === patched.userId ? patched : m))

// ─── Control actions ────────────────────────────────────────────────────────

function handleControl(
  state: BattleState,
  event: Extract<InternalEvent, { type: 'control' }>,
  ctx: Ctx,
): Result {
  const p = (event.payload ?? {}) as Record<string, unknown>

  switch (event.action) {
    case 'join.close':
      return closeJoinWindow(state)
    case 'joins.open':
      return { state: { ...state, joinsOpen: true }, effects: [broadcast({ joinsOpen: true })] }
    case 'joins.close':
      return { state: { ...state, joinsOpen: false }, effects: [broadcast({ joinsOpen: false })] }

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
      return { state: { ...state, pool: state.pool.filter((m) => m.userId !== p.userId) }, effects: [] }
    case 'pool.resolve':
      return resolvePoolSlot(state, p)

    case 'pick.draw':
      return drawPick(state, ctx)
    case 'pick.veto':
      return veto(state, String(p.reason ?? ''), Boolean(p.removeFromPool), ctx)
    case 'flip.run':
      return runFlip(state, ctx)
    case 'pick.result':
      return enterResult(state, p, ctx)
    case 'pick.revert':
      return revert(state, ctx)

    case 'sides.lock':
      return { state: { ...state, sidesLocked: true }, effects: [broadcast({ sidesLocked: true })] }
    case 'battle.end':
      return endSession(state, ctx)
    case 'battle.abandon':
      return { state: { ...state, phase: 'complete' }, effects: [end('abandoned')] }

    default:
      return { state, effects: [] }
  }
}

function closeJoinWindow(state: BattleState): Result {
  // §4 — the opening window closing does NOT close joins. Only the countdown
  // ends; the pool stays open for the rest of the session.
  return {
    state: { ...state, joinWindowEndsAt: null, phase: state.phase === 'joining' ? 'pick' : state.phase },
    effects: [cancelTimer(JOIN_TIMER_ID), broadcast({ phase: 'pick', joinWindowEndsAt: null })],
  }
}

function resolvePoolSlot(state: BattleState, p: Record<string, unknown>): Result {
  const userId = String(p.userId ?? '')
  const slotId = p.slotId ? String(p.slotId) : null
  if (!userId || !slotId) return { state, effects: [] }

  return {
    state: {
      ...state,
      pool: state.pool.map((m) =>
        m.userId === userId
          ? {
              ...m,
              slotId,
              slotName: p.slotName ? String(p.slotName) : m.slotName,
              provider: p.provider ? String(p.provider) : m.provider,
              thumbnail: p.thumbnail ? String(p.thumbnail) : m.thumbnail,
              suggestions: [],
            }
          : m,
      ),
    },
    effects: [],
  }
}

/**
 * Draw the next entrant — §5, §6.
 *
 * The pick index and its committed flip are allocated here, but the team is not
 * revealed until the flip runs. That gap is the whole mechanic: the name lands,
 * chat reacts, and *then* the thing that actually matters gets decided.
 */
function drawPick(state: BattleState, ctx: Ctx): Result {
  if (state.currentPickIndex !== null) return { state, effects: [] }

  const total = state.maxPicks + state.suddenDeathPicks
  const nextIndex = state.picks.filter((p) => !p.vetoed || p.vetoed).length

  if (nextIndex >= total) return { state, effects: [] }

  // §16 — an empty pool pauses draws rather than ending the session. This is
  // precisely why joins never close.
  const eligible = state.pool.filter((m) => m.slotId !== null)
  if (eligible.length === 0) {
    return {
      state: { ...state, phase: 'pick' },
      effects: [broadcast({ phase: 'pick', waitingForEntries: true })],
    }
  }

  // One seat at a time, and drawSeats already prefers a reserved entrant and
  // labels the source — which is what the overlay badges as Streamer's pick.
  const seat = drawSeats(eligible, {
    seats: 1,
    reservedUserIds: state.reservedUserIds,
    rng: ctx.rng(`draw-${nextIndex}`),
  }).seats[0]
  if (!seat) return { state, effects: [] }

  const drawn = seat.member

  const team = state.flipSequence[nextIndex]
  if (!team) return { state, effects: [] }

  const pick: Pick = {
    index: nextIndex,
    userId: drawn.userId,
    username: drawn.username,
    slotId: drawn.slotId,
    slotName: drawn.slotName,
    thumbnail: drawn.thumbnail,
    team,
    // §6.4 — only a side they actually chose. An auto-assigned one was never
    // a prediction, so the coin cannot contradict it.
    declaredSide: state.sides[drawn.userId]?.auto === false
      ? state.sides[drawn.userId]!.team
      : null,
    source: seat.source,
    buyCostCents: null,
    payoutCents: null,
    multiplier: null,
    fakeOut: state.fakeOutSchedule[nextIndex] ?? false,
    vetoed: null,
    revertedFrom: null,
    resolvedAtSeq: null,
  }

  const next: BattleState = {
    ...state,
    phase: 'pick',
    picks: [...state.picks, pick],
    currentPickIndex: nextIndex,
    pool: state.pool.filter((m) => m.userId !== drawn.userId),
    reservedUserIds: state.reservedUserIds.filter((id) => id !== drawn.userId),
    drawnUserIds: [...new Set([...state.drawnUserIds, drawn.userId])],
  }

  return {
    state: next,
    effects: [
      broadcast({
        phase: 'pick',
        // The team is deliberately withheld — the overlay must not be able to
        // spoil the flip it is about to animate.
        currentPick: publicPick(pick, { revealTeam: false }),
        waitingForEntries: false,
      }),
    ],
  }
}

/**
 * §6.2 — legal in `pick`, rejected everywhere after.
 *
 * A veto consumes the pick index and its committed flip. It does not shuffle
 * the sequence: re-rolling on a veto would make every veto a re-roll of the
 * team, which is the exact thing this rule exists to prevent.
 */
function veto(state: BattleState, reason: string, removeFromPool: boolean, ctx: Ctx): Result {
  if (state.phase !== 'pick' || state.currentPickIndex === null) return { state, effects: [] }

  const index = state.currentPickIndex
  const pick = state.picks.find((p) => p.index === index)
  if (!pick || pick.vetoed) return { state, effects: [] }

  const returned = !removeFromPool && pick.slotId
  const restored: PoolMember | null = returned
    ? {
        userId: pick.userId,
        username: pick.username,
        role: 'viewer',
        slotId: pick.slotId,
        slotName: pick.slotName,
        provider: null,
        thumbnail: pick.thumbnail,
        buyCostX: null,
        rawText: pick.slotName ?? '',
        joinedAtSeq: ctx.seq,
        suggestions: [],
      }
    : null

  return {
    state: {
      ...state,
      picks: state.picks.map((p) =>
        p.index === index ? { ...p, vetoed: { atSeq: ctx.seq, reason } } : p,
      ),
      pool: restored ? [...state.pool, restored] : state.pool,
      drawnUserIds: returned
        ? state.drawnUserIds.filter((id) => id !== pick.userId)
        : state.drawnUserIds,
      currentPickIndex: null,
    },
    effects: [broadcast({ currentPick: null, phase: 'pick' })],
  }
}

/**
 * Run the flip — the point of no return.
 *
 * The result is read from the committed sequence; nothing is decided here. What
 * this does is move the state machine past the phase where a veto is legal, and
 * hand the overlay everything it needs to play the animation back.
 */
function runFlip(state: BattleState, ctx: Ctx): Result {
  if (state.phase !== 'pick' || state.currentPickIndex === null) return { state, effects: [] }

  const pick = state.picks.find((p) => p.index === state.currentPickIndex)
  if (!pick || pick.vetoed) return { state, effects: [] }

  const lock = state.sideLockAtPick
  const sidesLocked = state.sidesLocked || (lock !== null && pick.index + 1 >= lock)

  return {
    state: { ...state, phase: 'flip', sidesLocked },
    effects: [
      broadcast({
        phase: 'flip',
        currentPick: publicPick(pick, { revealTeam: true }),
        // §6.4 — the coin overriding a declared allegiance is one of the best
        // recurring beats in the game, so it is flagged rather than left for
        // the overlay to work out.
        allegianceOverridden: pick.declaredSide !== null && pick.declaredSide !== pick.team,
        animationMs: ctx.config.animationMs,
        sidesLocked,
        ...(ctx.config.drawMode === 'bag'
          ? { bagRemaining: bagRemaining(state.flipSequence, pick.index + 1) }
          : {}),
      }),
    ],
  }
}

/**
 * Cost and payout — §8.1.
 *
 * Buy cost must be above zero and is rejected if it isn't. A payout of zero is
 * valid and banks a 0.00×, which is the most damaging thing that can happen to
 * a team's average and is shown as such rather than hidden.
 */
function enterResult(state: BattleState, p: Record<string, unknown>, ctx: Ctx): Result {
  if (state.currentPickIndex === null) return { state, effects: [] }
  if (state.phase !== 'flip' && state.phase !== 'buying' && state.phase !== 'result') {
    return { state, effects: [] }
  }

  const pick = state.picks.find((x) => x.index === state.currentPickIndex)
  if (!pick || pick.vetoed) return { state, effects: [] }

  const buyCostCents = Math.round(Number(p.buyCost ?? 0) * 100)
  const payoutCents = Math.round(Number(p.payout ?? 0) * 100)

  if (!Number.isFinite(buyCostCents) || buyCostCents <= 0) return { state, effects: [] }
  if (!Number.isFinite(payoutCents) || payoutCents < 0) return { state, effects: [] }

  const multiplier = round2(payoutCents / buyCostCents)

  const picks = state.picks.map((x) =>
    x.index === pick.index
      ? { ...x, buyCostCents, payoutCents, multiplier, resolvedAtSeq: ctx.seq }
      : x,
  )

  const metric = ctx.config.winMetric
  const effects: Effect[] = []

  // §12 — the one mid-session chat write worth making, deduped on a cooldown.
  const leader = leaderOf(picks, metric)
  const leadChanged = leader !== null && leader !== state.lastLeader
  const cooledDown =
    state.lastLeadChangeAt === null || ctx.now - state.lastLeadChangeAt >= LEAD_CHANGE_COOLDOWN_MS

  if (leadChanged && cooledDown && ctx.config.announceLeadChange && state.lastLeader !== null) {
    effects.push(
      announce(
        `${state.teams[leader].name.toUpperCase()} take the lead — ` +
          `${formatMultiplier(teamScore(picks, 'A', metric))} vs ${formatMultiplier(teamScore(picks, 'B', metric))} ` +
          `with ${picksRemaining(picks, state.maxPicks, state.suddenDeathPicks)} picks left.`,
      ),
    )
  }

  const next: BattleState = {
    ...state,
    phase: 'result',
    picks,
    currentPickIndex: null,
    lastLeader: leader,
    lastLeadChangeAt: leadChanged && cooledDown ? ctx.now : state.lastLeadChangeAt,
  }

  effects.push(broadcast(scoreboardPatch(next, ctx)))

  // §9.1/§9.2 — the count was declared before pick 1, so reaching it is what
  // ends the session, not the streamer deciding they've seen enough.
  const remaining = picksRemaining(picks, state.maxPicks, state.suddenDeathPicks)
  if (remaining === 0) {
    if (
      needsSuddenDeath(picks, {
        threshold: ctx.config.suddenDeathThreshold,
        used: state.suddenDeathPicks,
        max: ctx.config.maxSuddenDeath,
        metric,
      })
    ) {
      const sudden = { ...next, suddenDeathPicks: state.suddenDeathPicks + 1, phase: 'pick' as BattlePhase }
      return {
        state: sudden,
        effects: [
          ...effects,
          announce(
            `SUDDEN DEATH — ${formatMultiplier(teamScore(picks, 'A', metric))} vs ` +
              `${formatMultiplier(teamScore(picks, 'B', metric))}. One more pick.`,
          ),
          broadcast({ phase: 'pick', suddenDeath: true }),
        ],
      }
    }

    return { state: { ...next, phase: 'final' }, effects: [...effects, broadcast({ phase: 'final' })] }
  }

  return { state: next, effects }
}

/**
 * §16 — an explicit, logged correction rather than a silent edit.
 *
 * The flip is **not** re-rolled: same person, same team, corrected numbers. A
 * revert that also re-flipped would be a re-roll wearing a different name.
 */
function revert(state: BattleState, ctx: Ctx): Result {
  const last = [...state.picks].reverse().find((p) => p.multiplier !== null && !p.vetoed)
  if (!last) return { state, effects: [] }

  const picks = state.picks.map((p) =>
    p.index === last.index
      ? {
          ...p,
          revertedFrom: { buyCostCents: p.buyCostCents ?? 0, payoutCents: p.payoutCents ?? 0 },
          buyCostCents: null,
          payoutCents: null,
          multiplier: null,
          resolvedAtSeq: null,
        }
      : p,
  )

  const next: BattleState = {
    ...state,
    phase: 'buying',
    picks,
    currentPickIndex: last.index,
    result: null,
  }

  return {
    state: next,
    effects: [
      broadcast({
        ...scoreboardPatch(next, ctx),
        phase: 'buying',
        correction: { index: last.index, username: last.username },
      }),
    ],
  }
}

/**
 * §9.1 — enabled only once the declared count is reached.
 *
 * The asymmetry with abandon is deliberate: a streamer can always stop; what
 * they cannot do is stop *and have it count as a finished session with a
 * winner*.
 */
function endSession(state: BattleState, ctx: Ctx): Result {
  if (state.phase !== 'final') return { state, effects: [] }

  const result = resolveWinner(state.picks, {
    metric: ctx.config.winMetric,
    showAnchor: ctx.config.showAnchor,
    rng: ctx.rng('tiebreak'),
  })

  const winners = teamPicks(state.picks, result.winner)
  const names = winners.map((p) => `@${p.username}`)
  const shown = names.slice(0, 8).join(', ')
  const more = names.length > 8 ? ` …and ${names.length - 8} more — full teams on screen` : ''

  const effects: Effect[] = [
    announce(
      `${state.teams[result.winner].name.toUpperCase()} WIN — ` +
        `${formatMultiplier(result.winner === 'A' ? result.scoreA : result.scoreB)} average against ` +
        `${formatMultiplier(result.winner === 'A' ? result.scoreB : result.scoreA)} over ` +
        `${state.picks.filter((p) => p.multiplier !== null).length} picks. ` +
        `${shown}${more} …and everyone who called ${state.teams[result.winner].name.toUpperCase()}.`,
    ),
  ]

  if (result.mvp) {
    effects.push(
      announce(
        `MVP: @${result.mvp.username} — ${result.mvp.slotName ?? 'their slot'} paid ` +
          `${formatMultiplier(result.mvp.multiplier)}. Biggest pull of the session.`,
      ),
    )
  }

  if (result.anchor) {
    effects.push(
      announce(
        `And the Anchor goes to @${result.anchor.username} — ` +
          `${result.anchor.slotName ?? 'their slot'}, ${formatMultiplier(result.anchor.multiplier)}. It happens.`,
      ),
    )
  }

  const next: BattleState = {
    ...state,
    phase: 'complete',
    result,
    // §6.1 — the commitment is now checkable. Anyone who cares can verify the
    // flips were decided before the first !join landed.
    flipSequenceRevealed: true,
  }

  effects.push(
    broadcast({
      phase: 'complete',
      result,
      flipSequence: state.flipSequence,
      flipSequenceRevealed: true,
    }),
    end('complete'),
  )

  return { state: next, effects }
}

// ─── shared ─────────────────────────────────────────────────────────────────

function leaderOf(picks: readonly Pick[], metric: BattlesConfig['winMetric']): TeamKey | null {
  const a = teamScore(picks, 'A', metric)
  const b = teamScore(picks, 'B', metric)
  if (a === b) return null
  return a > b ? 'A' : 'B'
}

/** Everything the scoreboard needs, recomputed rather than accumulated (§14). */
export function scoreboardPatch(state: BattleState, ctx: Ctx): Record<string, unknown> {
  const metric = ctx.config.winMetric
  const trailing: TeamKey = teamScore(state.picks, 'A', metric) >= teamScore(state.picks, 'B', metric) ? 'B' : 'A'

  return {
    phase: state.phase,
    scoreA: teamScore(state.picks, 'A', metric),
    scoreB: teamScore(state.picks, 'B', metric),
    totalA: teamTotal(state.picks, 'A'),
    totalB: teamTotal(state.picks, 'B'),
    picksA: teamPicks(state.picks, 'A').length,
    picksB: teamPicks(state.picks, 'B').length,
    picksRemaining: picksRemaining(state.picks, state.maxPicks, state.suddenDeathPicks),
    swingTeam: trailing,
    swing: swing(state.picks, trailing, metric),
  }
}

/** A pick as the overlay may see it — §6.1 forbids leaking the team early. */
export function publicPick(pick: Pick, opts: { revealTeam: boolean }) {
  return {
    index: pick.index,
    username: pick.username,
    slotName: pick.slotName,
    thumbnail: pick.thumbnail,
    source: pick.source,
    declaredSide: pick.declaredSide,
    fakeOut: opts.revealTeam ? pick.fakeOut : false,
    team: opts.revealTeam ? pick.team : null,
  }
}
