/**
 * Giveaways reducer — §2 to §12.
 *
 * Pure, like every reducer. Three rules in here are the whole game, and each
 * one is a place where a plausible-looking simplification would be a bug in
 * front of a live chat.
 *
 * **The server closes late** (§2). The overlay countdown is the contract: a
 * viewer who types when their screen says zero always makes it, because their
 * screen is showing them the past. Entry is accepted until `entryClosesAtMs`
 * plus the grace, the grace is stream delay plus five seconds, and nothing
 * about it is announced, badged or acked. An entry that lands inside the grace
 * is indistinguishable from any other entry to everyone, including the entrant.
 *
 * **The claim clock starts when chat sees the name** (§8.1), not when the reel
 * stopped. The winner announcement is held behind the stream delay so it cannot
 * spoil the overlay, so starting the clock at the settle would spend twelve to
 * thirty seconds of the window before the winner had any way of knowing they
 * had won. `startedAtMs` is therefore scheduled forward, and the expiry timer
 * with it.
 *
 * **There is no re-draw, at any privilege level, in any phase** (§3, §11). The
 * order was committed at `LOCKED` and a passover is a cursor advancing down it.
 * `commitDrawOrder` has exactly one call site in this file and it is guarded on
 * `drawOrder.length === 0`.
 */

import {
  announce,
  broadcast,
  cancelTimer,
  end,
  reply,
  timer,
  type Effect,
  type InternalEvent,
  type ReduceContext,
  type ReduceResult,
} from '@streamarena/core'
import { commitDrawOrder, seedHash } from './draw.js'
import { oddsFor, oddsTiers, totalWeight, weightFor, type EntryRole } from './weighting.js'
import {
  gateLineFor,
  CLAIM_START_TIMER_ID,
  CLAIM_TIMER_ID,
  CLOSING_COUNTDOWN_MS,
  CLOSING_TIMER_ID,
  ENTRY_TIMER_ID,
  LOCKED_HOLD_MS,
  PASSOVER_REVEAL_MS,
  PASSOVER_TIMER_ID,
  REEL_TIMER_ID,
  REJECTION_COPY,
  REJECTION_SUMMARY_MIN_COUNT,
  REJECTION_SUMMARY_AT_MS_REMAINING,
  REJECTION_TIMER_ID,
  REMINDER_TIMER_ID,
  ODDS_REPLY_COOLDOWN_MS,
  graceFor,
  type Entry,
  type GiveawayConfig,
  type GiveawayState,
  type Passover,
  type PassoverReason,
  type RejectionReason,
} from './types.js'

type Ctx = ReduceContext<GiveawayConfig>
type Result = ReduceResult<GiveawayState>

/**
 * Whether the runtime can tell us when an account was created and when someone
 * started following — §10.1, "the one genuine unknown in this specification,
 * and it should be verified against the live API before the build starts".
 *
 * It was verified, and the answer is no. Kick's chat payload carries badges and
 * nothing else (`packages/kick/src/normalise.ts` says the same thing about the
 * follower badge, and reaches the same conclusion for the same reason), and the
 * public API exposes no follow timestamp and no account creation date to a
 * third-party app.
 *
 * The consequence, stated rather than hidden: **`entryGate: 'followers'`,
 * `minFollowAgeMins` and `minAccountAgeDays` do not run.** They are accepted by
 * the schema, they are carried on the session, and the moment the platform can
 * supply the two timestamps this constant becomes a capability check and the
 * guards below start firing — but today the honest thing is to say the guard is
 * off rather than let a streamer running a €500 prize believe an alt-farm
 * defence is in place. §10.1: "which the streamer needs to be told rather than
 * left to assume."
 *
 * `subscribers` gating is unaffected. A subscriber badge is on the message, and
 * §10.3 is explicit that a genuinely valuable prize should be gated there
 * anyway, where Kick's own payment rail does the verification.
 */
export const IDENTITY_FACTS_AVAILABLE = false

export function reduce(state: GiveawayState, event: InternalEvent, ctx: Ctx): Result {
  switch (event.type) {
    case 'session.started':
      /*
       * §4 — deliberately does nothing but publish the resting frame.
       *
       * `IDLE` exists so a configured giveaway can sit ready on the dashboard
       * and be fired with one button when the streamer reaches a natural break,
       * which is how this game will actually be used. Opening entry the instant
       * the session is created would burn the window while they are still
       * talking about something else.
       */
      return { state, effects: [broadcast({ phase: state.phase })] }

    case 'command':
      return handleCommand(state, event, ctx)
    case 'control':
      return handleControl(state, event, ctx)
    case 'timer':
      return handleTimer(state, event, ctx)

    case 'session.ended':
      return event.reason === 'abandoned' ? abandon(state, ctx) : complete(state, ctx)

    default:
      return { state, effects: [] }
  }
}

// ─── Chat commands ──────────────────────────────────────────────────────────

function handleCommand(
  state: GiveawayState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  switch (event.command) {
    case 'enter':
      return enter(state, event, ctx)
    case 'claim':
      return claim(state, event, ctx)
    case 'odds':
      return oddsReply(state, event, ctx)
    case 'ga':
      return modCommand(state, event, ctx)
    default:
      return { state, effects: [] }
  }
}

/**
 * The keyword — §5.
 *
 * **Nothing is acked to an individual entrant. Ever.** This is a deliberate
 * departure from the platform's errors-only default and it is a quota decision
 * before it is a design one: eight hundred entries in a follower-gated session
 * produces eight hundred rejections, and a bot that replies to each of them is
 * both impossible inside Kick's rate limits and the worst thing that has ever
 * happened to that channel's chat.
 *
 * So every path out of this function returns either an accepted entry or a
 * counter increment, and never a `ChatEffect`. What replaces the ack is the
 * permanent gate line on the overlay, the joining-names feed, and one batched
 * rejection summary at thirty seconds remaining.
 */
function enter(
  state: GiveawayState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const actor = event.actor

  if (state.phase !== 'open') return { state: count(state, 'closed'), effects: [] }

  /*
   * §2 rule 2 — the single highest-value line in the game.
   *
   * `entryClosesAtMs` is countdown-zero, the number the overlay renders. The
   * server keeps accepting for `graceMs` past it so that a viewer whose screen
   * is 20 seconds behind the studio, who typed the instant their own clock hit
   * zero, is not rejected for doing exactly the right thing.
   */
  const closesAt = state.entryClosesAtMs
  if (closesAt !== null && ctx.now > closesAt + graceFor(ctx.config)) {
    return { state: count(state, 'late'), effects: [] }
  }

  // One entry per viewer. A repeat is counted once and ignored silently — a
  // second keyword is not an error and must not read as one.
  if (state.entries.some((e) => e.userId === actor.userId)) return { state, effects: [] }

  const rejection = gateVerdict(state, actor.userId, actor.role, ctx.config)
  if (rejection !== null) return { state: count(state, rejection), effects: [] }

  const role = entryRole(actor.role)
  const entry: Entry = {
    userId: actor.userId,
    username: actor.username,
    role,
    // Kick's chat payload carries a subscriber badge but not its tier, so a sub
    // lands on the plain `subscriber` multiplier rather than a tier one. Better
    // than guessing a tier and quoting a viewer odds they do not have.
    subTier: null,
    weight: weightFor({ role, subTier: null, messageCount: 0 }, ctx.config),
    messageCount: 0,
    joinedAtSeq: ctx.seq,
    joinedAt: ctx.now,
  }

  const entries = [...state.entries, entry]

  /*
   * §13 — the entry count is the hero number of the whole phase, and it counts
   * up and never down. It is broadcast on every single entry rather than
   * batched, because the overlay's joining-names feed is the only confirmation
   * a viewer who typed ever receives that anything landed.
   */
  return {
    state: { ...state, entries },
    effects: [
      broadcast({
        entryCount: entries.length,
        lastEntrant: { username: entry.username, role: entry.role, weight: entry.weight },
      }),
    ],
  }
}

/**
 * §8 — the winner's command.
 *
 * "Ignored from anyone else — never acked, or the winner's window fills with
 * noise." Everyone in chat will type this, constantly, for three minutes. Every
 * one of those is a silent no-op, and a second `!claim` from the winner is
 * idempotent rather than a second ack.
 */
function claim(
  state: GiveawayState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const c = state.claim
  if (c === null) return { state, effects: [] }
  if (event.actor.userId !== c.userId) return { state, effects: [] }
  if (ctx.now > c.expiresAtMs) return { state, effects: [] }
  if (state.awards.some((a) => a.prizeIndex === c.prizeIndex)) return { state, effects: [] }

  const prize = state.prizes[c.prizeIndex]
  return settlePrize(state, ctx, {
    userId: c.userId,
    username: c.username,
    prizeIndex: c.prizeIndex,
    method: 'claimed',
    manualReason: null,
    claimedWithMsLeft: Math.max(0, c.expiresAtMs - ctx.now),
    announcement: `@${c.username} claimed ${prize?.title ?? 'the prize'}. Congratulations.`,
  })
}

/**
 * `!odds` — §11, throttled to one batched reply per 30 seconds.
 *
 * Throttled here rather than by a per-viewer cooldown on the CommandSpec,
 * because a guard denial produces a chat write and this game's entire chat
 * discipline (§12) is that the bot never speaks to an entrant. A viewer who
 * asks inside the cooldown gets silence and the answer that is already on the
 * overlay; the one message that does go out answers all of them at once.
 */
function oddsReply(
  state: GiveawayState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  if (state.phase !== 'open' && state.phase !== 'locked') return { state, effects: [] }
  if (state.entries.length === 0) return { state, effects: [] }

  const last = state.lastOddsReplyAtMs
  if (last !== null && ctx.now - last < ODDS_REPLY_COOLDOWN_MS) return { state, effects: [] }

  /*
   * §6.1 — computed odds, never ticket counts. "You: 1 in 214" is a true
   * statement a viewer can act on; "you have 5 entries" is a number whose
   * meaning depends on the pool size and the prize count, neither of which the
   * viewer has.
   */
  const prizes = state.prizes.filter((p) => p.status !== 'voided').length
  const tiers = oddsTiers(state.entries, prizes)
  const line =
    tiers.length === 1
      ? `1 in ${tiers[0]!.oneIn}`
      : tiers.map((t) => `${t.weight}× entry: 1 in ${t.oneIn}`).join(' · ')

  return {
    state: { ...state, lastOddsReplyAtMs: ctx.now },
    effects: [reply(`${state.entries.length} in so far — ${line}. ${prizeLine(state)}`)],
  }
}

/** `!ga remove|close|extend|award` — §11's mod surface. */
function modCommand(
  state: GiveawayState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const [verb = '', ...rest] = event.args.trim().split(/\s+/)
  const target = rest[0]?.replace(/^@/, '') ?? ''

  switch (verb.toLowerCase()) {
    case 'remove':
      return removeEntrant(state, target, ctx)
    case 'close':
      return closeEntry(state, ctx)
    case 'extend': {
      const seconds = Number(rest[0])
      return Number.isFinite(seconds) && seconds > 0
        ? extend(state, Math.round(seconds) * 1000, ctx)
        : { state, effects: [] }
    }
    case 'award':
      return manualAward(state, target, `awarded by @${event.actor.username} in chat`, ctx)
    default:
      return { state, effects: [] }
  }
}

// ─── Dashboard controls ─────────────────────────────────────────────────────

function handleControl(
  state: GiveawayState,
  event: Extract<InternalEvent, { type: 'control' }>,
  ctx: Ctx,
): Result {
  const p = (event.payload ?? {}) as Record<string, unknown>

  switch (event.action) {
    case 'entry.open':
      return openEntry(state, ctx)
    case 'entry.close':
      return closeEntry(state, ctx)
    case 'entry.extend':
      return extend(state, Math.max(0, Number(p.ms ?? 60_000)), ctx)
    case 'entry.remove':
      return removeEntrant(state, String(p.username ?? p.userId ?? ''), ctx)
    case 'gate.loosen':
      return loosenGate(state, String(p.reason ?? ''), ctx)

    case 'prize.draw':
      return runReel(state, ctx)
    case 'draw.skip':
      return settleReel(state, ctx)
    case 'prize.next':
      return runReel(state, ctx)

    case 'claim.extend':
      return extend(state, Math.max(0, Number(p.ms ?? 60_000)), ctx)
    case 'prize.award':
      return manualAward(state, String(p.username ?? ''), String(p.reason ?? ''), ctx)
    case 'prize.void':
      return voidPrize(state, String(p.reason ?? ''), ctx)
    case 'prize.passover':
      return passOver(state, ctx, 'passed-over-by-streamer', String(p.reason ?? ''))

    /*
     * §16 — the one case where changing a clock mid-session is correct.
     *
     * Kick chat dropped, entries stopped arriving through no fault of anyone
     * watching, and the window was consumed anyway. Extend it by the outage and
     * say so on the overlay. Not yet wired to anything: the worker has no
     * chat-liveness detector, so today this is a button a streamer presses when
     * they notice. Flagged in the build notes.
     */
    case 'chat.outage':
      return chatOutage(state, Math.max(0, Number(p.ms ?? 0)), ctx)

    case 'giveaway.end':
      return complete(state, ctx)
    case 'giveaway.abandon':
      return abandon(state, ctx)

    default:
      return { state, effects: [] }
  }
}

/**
 * `OPEN` — §3, and the only moment in the session where a seed is committed.
 *
 * The hash goes out before a single entry is accepted, which is the half of the
 * construction the streamer cannot fake: they could not have chosen a
 * favourable seed, because the seed was fixed and published-in-hash before they
 * knew who would enter. The other half — the entry list — arrives from chat and
 * is not under their control either, and the two halves together are the whole
 * result.
 */
function openEntry(state: GiveawayState, ctx: Ctx): Result {
  if (state.phase !== 'idle') return { state, effects: [] }

  const windowMs = ctx.config.entryWindowMs
  const grace = graceFor(ctx.config)
  const closesAt = ctx.now + windowMs

  const effects: Effect[] = [
    /*
     * §2 rule 4 — chat announces the *prize*, the overlay runs the *clock*.
     *
     * By the time a bot message about a three-minute window has been read
     * through the stream delay, a chunk of the window is gone. Every timing
     * decision in this game assumes the viewer is looking at the overlay,
     * because that is the only surface where the clock and the video are on the
     * same delay — so this message deliberately does not carry a duration.
     */
    announce(
      `GIVEAWAY OPEN — ${state.prizes[0]?.title ?? 'prize'}. Type !${state.keyword} on stream to enter. ` +
        `${state.gateLine}.` +
        (ctx.config.publishSeed ? ` Draw seed committed: ${state.seedHash}` : ''),
    ),
    // Fires at countdown-zero *plus the grace*, so the phase does not leave
    // `open` while entries are still legitimately landing.
    timer(windowMs + grace, { kind: 'entryClosed' }, ENTRY_TIMER_ID),
  ]

  /*
   * §5 — one batched rejection summary, timed so there is still a window left
   * to act in. Skipped entirely when the window is too short for the message to
   * be actionable, since a remedy nobody can reach is just noise.
   */
  if (windowMs > REJECTION_SUMMARY_AT_MS_REMAINING + 10_000) {
    effects.push(
      timer(
        windowMs - REJECTION_SUMMARY_AT_MS_REMAINING,
        { kind: 'rejectionSummary' },
        REJECTION_TIMER_ID,
      ),
    )
  }

  return {
    state: {
      ...state,
      phase: 'open',
      entryOpensAtMs: ctx.now,
      entryClosesAtMs: closesAt,
      currentPrizeIndex: 0,
    },
    effects,
  }
}

/**
 * §2 rule 3 — **there is no snap close.**
 *
 * A "closing entries now" button that closed entries now would re-create the
 * exact failure the grace period exists to prevent: the streamer's now is the
 * audience's fifteen-to-thirty-seconds-ago. Closing shortens the window to a
 * fresh, visible fifteen-second countdown, and the grace still applies on the
 * far side of it.
 *
 * Pressing it when less than fifteen seconds remain does nothing at all, rather
 * than *extending* the window back up to the floor — the clock the audience is
 * looking at must never move away from them.
 */
function closeEntry(state: GiveawayState, ctx: Ctx): Result {
  if (state.phase !== 'open') return { state, effects: [] }

  const closesAt = state.entryClosesAtMs
  const shortened = ctx.now + CLOSING_COUNTDOWN_MS
  if (closesAt !== null && closesAt <= shortened) {
    // Already closing sooner than a fresh countdown would. Leave it alone.
    return { state: { ...state, closing: true }, effects: [broadcast({ closing: true })] }
  }

  return {
    state: { ...state, closing: true, entryClosesAtMs: shortened },
    effects: [
      announce(`Last call — entries close in ${CLOSING_COUNTDOWN_MS / 1000} seconds.`),
      timer(CLOSING_COUNTDOWN_MS + graceFor(ctx.config), { kind: 'entryClosed' }, ENTRY_TIMER_ID),
      cancelTimer(REJECTION_TIMER_ID),
      cancelTimer(CLOSING_TIMER_ID),
    ],
  }
}

/** `!ga extend 60` — adds time to whichever clock is running (§11). */
function extend(state: GiveawayState, ms: number, ctx: Ctx): Result {
  if (ms <= 0) return { state, effects: [] }

  if (state.phase === 'open' && state.entryClosesAtMs !== null) {
    const closesAt = state.entryClosesAtMs + ms
    return {
      state: { ...state, entryClosesAtMs: closesAt, closing: false },
      effects: [
        timer(closesAt - ctx.now + graceFor(ctx.config), { kind: 'entryClosed' }, ENTRY_TIMER_ID),
        announce(`${Math.round(ms / 1000)} more seconds on the clock.`),
      ],
    }
  }

  if (state.phase === 'claim' && state.claim !== null) {
    const claim = { ...state.claim, expiresAtMs: state.claim.expiresAtMs + ms }
    return {
      state: { ...state, claim },
      effects: [
        timer(claim.expiresAtMs - ctx.now, { kind: 'claimExpired' }, CLAIM_TIMER_ID),
        announce(`@${claim.username} — ${Math.round(ms / 1000)} more seconds to claim.`),
      ],
    }
  }

  return { state, effects: [] }
}

/**
 * §16 — Kick chat dropped mid-window.
 *
 * "Extend the window by the outage duration and say so on the overlay — this is
 * the one case where changing the clock mid-session is correct." Distinct from
 * a plain extension precisely so the overlay can say *why*: a clock that grows
 * for no stated reason is the second-most suspicious thing this product could
 * do, after a silent substitution.
 */
function chatOutage(state: GiveawayState, ms: number, ctx: Ctx): Result {
  if (ms <= 0 || state.phase !== 'open' || state.entryClosesAtMs === null) {
    return { state, effects: [] }
  }

  const closesAt = state.entryClosesAtMs + ms
  return {
    state: { ...state, entryClosesAtMs: closesAt, extendedForOutageMs: state.extendedForOutageMs + ms },
    effects: [
      timer(closesAt - ctx.now + graceFor(ctx.config), { kind: 'entryClosed' }, ENTRY_TIMER_ID),
      broadcast({ entryClosesAtMs: closesAt, extendedForOutageMs: state.extendedForOutageMs + ms }),
      announce(
        `Chat dropped for ${Math.round(ms / 1000)}s — the entry window is extended by the same amount.`,
      ),
    ],
  }
}

/**
 * `!ga remove @user` — §11, legal during `OPEN` and `LOCKED` only.
 *
 * After `LOCKED` the order exists, and removing someone from it is a re-draw
 * wearing a moderation badge. §10.3: curation happens before the draw, or it
 * does not happen.
 *
 * The removal is subtracted from the *dashboard* figure. The overlay's hero
 * number counts accepted entries and is monotonic (§13) — a count that drops by
 * forty in front of the whole channel invites exactly one conclusion.
 */
function removeEntrant(state: GiveawayState, target: string, ctx: Ctx): Result {
  if (state.phase !== 'open' && state.phase !== 'locked') return { state, effects: [] }
  const needle = target.replace(/^@/, '').toLowerCase()
  if (needle === '') return { state, effects: [] }

  const found = state.entries.find(
    (e) => e.username.toLowerCase() === needle || e.userId === target,
  )
  if (!found) return { state, effects: [] }

  return {
    state: {
      ...state,
      entries: state.entries.filter((e) => e.userId !== found.userId),
      removedUserIds: [...state.removedUserIds, found.userId],
    },
    effects: [],
  }
}

/**
 * §5 — loosening a gate while the window is still running.
 *
 * "The dashboard shows the rejection breakdown live, so a streamer can see
 * gating set too tight while they can still loosen it." A streamer watching a
 * third of their channel bounce off a followers gate has about ninety seconds
 * to notice and fix it, and this is the fix.
 *
 * Three properties this has to hold:
 *
 * It **only ever loosens.** There is no path here that tightens a gate
 * mid-window, because tightening after people have entered is removing entries
 * for a rule that did not exist when they typed.
 *
 * It **is not retroactive.** The rejected entries were never recorded per-user
 * (§5 forbids it), so there is nobody to let back in — they have to type again,
 * and the overlay footer changing is how they find out they now can. Anything
 * else would require keeping exactly the per-user rejection list this game
 * refuses to keep.
 *
 * It **updates the gate line**, so the overlay stops advertising a rule that no
 * longer applies. §5: nobody should ever have to discover a gate by being
 * rejected by it, and the same goes for discovering one was lifted.
 */
function loosenGate(state: GiveawayState, reason: string, ctx: Ctx): Result {
  if (state.phase !== 'open') return { state, effects: [] }
  if (state.gateOverride === 'anyone') return { state, effects: [] }

  // Everything this control can reach reduces to the same thing: the gate that
  // was rejecting people stops rejecting them. The reason names which counter
  // the streamer clicked, and is recorded rather than acted on differently.
  const next: GiveawayState = {
    ...state,
    gateOverride: 'anyone',
    gateLine: gateLineFor({ ...ctx.config, entryGate: 'anyone' }, state.identityGuardsEnforced),
  }

  return {
    state: next,
    effects: [
      broadcast({ gateLine: next.gateLine, gateLoosened: true }),
      announce(
        `Entry is open to everyone now — if you were turned away, type !${state.keyword} again. ` +
          `There's still time.`,
      ),
    ],
  }
}

// ─── The draw ───────────────────────────────────────────────────────────────

/**
 * `LOCKED` — the held beat, and the one place the order is computed.
 *
 * §4: "a deliberate held beat, three to five seconds, showing the final entry
 * count. Do not skip it; the number is the payoff for the window and the
 * audience has been watching it climb."
 *
 * `commitDrawOrder` is called here and nowhere else, and only when `drawOrder`
 * is still empty. That guard is the whole of §3 in one line: there is no code
 * path that draws twice.
 */
function lockEntries(state: GiveawayState, ctx: Ctx): Result {
  if (state.phase !== 'open') return { state, effects: [] }

  const seed = state.seed
  const drawOrder =
    state.drawOrder.length > 0 || seed === null ? state.drawOrder : commitDrawOrder(state.entries, seed)

  // §16 — a giveaway nobody entered is information. No draw, no auto-extend,
  // and the overlay says so plainly.
  if (state.entries.length === 0) {
    return {
      state: { ...state, phase: 'complete', closing: false, seedRevealed: ctx.config.publishSeed },
      effects: [announce('Entries closed with nobody in. No draw this time.')],
    }
  }

  return {
    state: { ...state, phase: 'locked', closing: false, drawOrder },
    effects: [
      announce(`Entries closed — ${state.entries.length} in. Drawing now.`),
      cancelTimer(REJECTION_TIMER_ID),
      // Non-blocking: the streamer's Draw button is what actually fires the
      // reel, but the dashboard can use this to hold it disabled so a slam from
      // close straight to reel throws away the payoff for the window.
      timer(LOCKED_HOLD_MS, { kind: 'lockedHoldDone' }, CLOSING_TIMER_ID),
    ],
  }
}

/** `DRAW` — playback only. The order has been in the log since `LOCKED`. */
function runReel(state: GiveawayState, ctx: Ctx): Result {
  if (state.phase !== 'locked' && state.phase !== 'awarded') return { state, effects: [] }

  const prizeIndex = nextPendingPrize(state)
  if (prizeIndex === null) return complete(state, ctx)

  /*
   * §16 — fewer entrants than prizes. "Draw what there is. Remaining prizes are
   * voided and announced."
   *
   * All of them, in one step, rather than one per press of the draw button.
   * Once the order is exhausted no later prize can find an entrant either, so
   * making the streamer click through three prizes that are already decided is
   * three chances to look like they are trying something.
   */
  if (nextEligible(state, prizeIndex, ctx.config) === null) {
    return voidRemaining(state, ctx, 'no eligible entrants left in the committed order')
  }

  return {
    state: { ...state, phase: 'draw', currentPrizeIndex: prizeIndex, passoversThisPrize: 0 },
    effects: [timer(ctx.config.reelMs, { kind: 'reelSettled' }, REEL_TIMER_ID)],
  }
}

/**
 * The settle — §7.2.
 *
 * "The reel decelerates through real names and settles exactly once. After the
 * settle, nothing moves." There is no fake-out here and the contrast with Team
 * Battles is the design point: there, the reel settles on the losing colour and
 * snaps, and the trick works because a coin has two faces and neither of them
 * belongs to anyone. Here the faces are people, and a reel that settles on
 * somebody, holds long enough for them to believe it, and then moves has shown
 * a viewer they won a prize they did not win.
 */
function settleReel(state: GiveawayState, ctx: Ctx): Result {
  if (state.phase !== 'draw') return { state, effects: [] }

  const prizeIndex = state.currentPrizeIndex
  if (prizeIndex === null) return { state, effects: [] }

  const pick = nextEligible(state, prizeIndex, ctx.config)
  // Unreachable in practice — `runReel` checks the same thing before it starts
  // the animation. Kept because the alternative to a settle with nobody to
  // settle on is a session frozen on a spinning reel.
  if (pick === null) return voidRemaining(state, ctx, 'no eligible entrants left in the committed order')

  return openClaim(state, ctx, { ...pick, prizeIndex, passover: null })
}

/**
 * Arm a claim window — §8.1, and the reason this is one function used by both
 * the settle and the passover.
 *
 * **The clock starts when chat sees the name, not when the reel stops.** The
 * winner announcement goes out behind the stream delay so it cannot spoil the
 * reveal for viewers watching the overlay, so `startedAtMs` is scheduled forward
 * by the same delay and the expiry timer is armed against the resulting
 * `expiresAtMs`. The overlay clock and the server clock agree because the thing
 * they are counting is the same event.
 *
 * With `announceWinnerInChat` off there is no announcement to wait for, so the
 * clock starts at the settle. That is the correct behaviour for that setting and
 * it is also why the setting carries a warning: a winner who is not looking at
 * the overlay now has no way of learning they won at all.
 */
function openClaim(
  state: GiveawayState,
  ctx: Ctx,
  pick: { userId: string; username: string; orderIndex: number; prizeIndex: number; passover: Passover | null },
): Result {
  const delay = ctx.config.announceWinnerInChat ? ctx.config.streamDelayMs : 0
  const startedAtMs = ctx.now + delay
  const expiresAtMs = startedAtMs + ctx.config.claimWindowMs
  const prize = state.prizes[pick.prizeIndex]
  const claimMins = Math.round(ctx.config.claimWindowMs / 60_000)

  const prizes = state.prizes.map((p) =>
    p.index === pick.prizeIndex && p.status === 'pending' ? { ...p, status: 'drawn' as const } : p,
  )

  const effects: Effect[] = [
    timer(expiresAtMs - ctx.now, { kind: 'claimExpired', prizeIndex: pick.prizeIndex }, CLAIM_TIMER_ID),
    /*
     * §8.2 — reminders at 50% and 20%, `@`-mentioning the winner. This is the
     * one place in this game where a per-event chat write is unambiguously
     * worth the quota, because the message is addressed to exactly one person
     * who needs to receive it. **Not held for the stream delay**: the name is
     * already public by then and the delay would spend the window (§12).
     */
    timer(delay + ctx.config.claimWindowMs * 0.5, { kind: 'claimReminder', pct: 50 }, `${REMINDER_TIMER_ID}:50`),
    timer(delay + ctx.config.claimWindowMs * 0.8, { kind: 'claimReminder', pct: 20 }, `${REMINDER_TIMER_ID}:20`),
    // Marks the moment the announcement lands, so the dashboard's claim-state
    // line can move from "revealed" to "waiting for the command".
    timer(Math.max(1, delay), { kind: 'claimStarted' }, CLAIM_START_TIMER_ID),
  ]

  if (ctx.config.announceWinnerInChat) {
    /*
     * §12 — the winner and passover messages are the only ones in this game a
     * viewer might *read* rather than see, so they carry the prize name in full
     * rather than referring to "the prize".
     */
    effects.push(
      pick.passover === null
        ? announce(
            `@${pick.username} WINS ${prize?.title ?? 'the prize'}. ` +
              `Type !claim in the next ${claimMins} minutes to lock it in.`,
          )
        : announce(
            `@${pick.passover.username} didn't claim in time. ${prize?.title ?? 'The prize'} goes to ` +
              `@${pick.username} — ${claimMins} minutes on the clock.`,
          ),
    )
  }

  const claim = {
    userId: pick.userId,
    username: pick.username,
    prizeIndex: pick.prizeIndex,
    orderIndex: pick.orderIndex,
    startedAtMs,
    expiresAtMs,
    remindersSent: 0,
  }

  return {
    state: {
      ...state,
      // A passover is a distinct phase, not a silent state change, because it
      // must be shown (§8.3). The reveal timer moves it on to `claim`.
      phase: pick.passover === null ? 'claim' : 'passover',
      prizes,
      cursor: pick.orderIndex,
      claim,
    },
    effects:
      pick.passover === null
        ? effects
        : [...effects, timer(PASSOVER_REVEAL_MS, { kind: 'passoverRevealed' }, PASSOVER_TIMER_ID)],
  }
}

/**
 * §8.3 — openly, every time.
 *
 * "The passed-over name stays on screen, struck through, labelled 'didn't claim
 * in time', while the next name is revealed beneath it. A silent substitution is
 * the single most suspicious thing this product could do, and the whole
 * construction in §3 exists so that this moment can be shown rather than
 * hidden."
 */
function passOver(
  state: GiveawayState,
  ctx: Ctx,
  reason: PassoverReason,
  note: string,
): Result {
  const c = state.claim
  if (c === null) return { state, effects: [] }
  if (state.awards.some((a) => a.prizeIndex === c.prizeIndex)) return { state, effects: [] }

  const passover: Passover = {
    prizeIndex: c.prizeIndex,
    userId: c.userId,
    username: c.username,
    reason,
    // §16 — a streamer-initiated pass is recorded as a streamer action, not as
    // an expiry. The distinction matters and hiding it would be dishonest.
    note: reason === 'passed-over-by-streamer' ? note || 'no reason given' : null,
    atMs: ctx.now,
  }

  const passed = { ...state, passovers: [...state.passovers, passover], claim: null }
  const used = state.passoversThisPrize + 1

  const cleared: Effect[] = [
    cancelTimer(CLAIM_TIMER_ID),
    cancelTimer(`${REMINDER_TIMER_ID}:50`),
    cancelTimer(`${REMINDER_TIMER_ID}:20`),
  ]

  /*
   * §8.4 — when the passovers run out, the session stops and the streamer
   * decides explicitly from three options. It cannot silently resolve this
   * itself: every one of the three has a different meaning for the record, and
   * picking one on the streamer's behalf would be the platform exercising the
   * discretion §3 exists to remove.
   */
  const next = used > ctx.config.maxPassovers ? null : nextEligible(passed, c.prizeIndex, ctx.config)
  if (next === null) {
    return {
      state: { ...passed, phase: 'passover', passoversThisPrize: used, passoversExhausted: true },
      effects: [
        ...cleared,
        announce(
          `@${c.username} didn't claim in time — that's ${used} ${used === 1 ? 'pass' : 'passes'} on ` +
            `${state.prizes[c.prizeIndex]?.title ?? 'this prize'}. Streamer's call from here.`,
        ),
      ],
    }
  }

  const armed = openClaim({ ...passed, passoversThisPrize: used }, ctx, {
    ...next,
    prizeIndex: c.prizeIndex,
    passover,
  })
  return { state: armed.state, effects: [...cleared, ...armed.effects] }
}

/**
 * §8.4 — "Mods can award manually at any point, for the case that always
 * happens: the winner is right there, talking, and typed `!clam`."
 *
 * Logged, badged on the overlay as a manual award, and named as such in the
 * verification record. Visible generosity rather than invisible discretion.
 */
function manualAward(state: GiveawayState, target: string, reason: string, ctx: Ctx): Result {
  const prizeIndex = state.currentPrizeIndex
  if (prizeIndex === null) return { state, effects: [] }
  if (state.awards.some((a) => a.prizeIndex === prizeIndex)) return { state, effects: [] }

  const needle = target.replace(/^@/, '').toLowerCase()
  const winner =
    needle === ''
      ? state.claim && { userId: state.claim.userId, username: state.claim.username }
      : state.entries.find((e) => e.username.toLowerCase() === needle) ??
        (state.claim?.username.toLowerCase() === needle
          ? { userId: state.claim.userId, username: state.claim.username }
          : null)

  if (!winner) return { state, effects: [] }

  const prize = state.prizes[prizeIndex]
  return settlePrize(state, ctx, {
    userId: winner.userId,
    username: winner.username,
    prizeIndex,
    method: 'manual',
    manualReason: reason || 'no reason given',
    claimedWithMsLeft: null,
    announcement: `${prize?.title ?? 'The prize'} goes to @${winner.username} — awarded by the streamer.`,
  })
}

/** §16 — a prize with nobody left to give it to, or one the streamer voids. */
function voidPrize(state: GiveawayState, reason: string, ctx: Ctx, index?: number): Result {
  const prizeIndex = index ?? state.currentPrizeIndex
  if (prizeIndex === null) return { state, effects: [] }
  if (state.awards.some((a) => a.prizeIndex === prizeIndex)) return { state, effects: [] }

  const prize = state.prizes[prizeIndex]
  return settlePrize(state, ctx, {
    userId: '',
    username: '',
    prizeIndex,
    method: 'voided',
    manualReason: reason || 'voided by the streamer',
    claimedWithMsLeft: null,
    announcement: `${prize?.title ?? 'A prize'} goes unclaimed this session.`,
  })
}

/**
 * §16 — every prize the order can no longer reach, voided together.
 *
 * Announced as one message naming all of them, because three separate "goes
 * unclaimed" lines read as three separate failures rather than as one pool that
 * ran out of people.
 */
function voidRemaining(state: GiveawayState, ctx: Ctx, reason: string): Result {
  const pending = state.prizes.filter((p) => p.status === 'pending')
  if (pending.length === 0) return complete(state, ctx)

  const voided: GiveawayState = {
    ...state,
    phase: 'awarded',
    claim: null,
    passoversExhausted: false,
    passoversThisPrize: 0,
    prizes: state.prizes.map((p) => (p.status === 'pending' ? { ...p, status: 'voided' as const } : p)),
    awards: [
      ...state.awards,
      ...pending.map((p) => ({
        prizeIndex: p.index,
        userId: '',
        username: '',
        method: 'voided' as const,
        manualReason: reason,
        awardedAtMs: ctx.now,
        claimedWithMsLeft: null,
      })),
    ],
  }

  const titles = pending.map((p) => p.title).join(', ')
  const done = complete(voided, ctx)

  return {
    state: done.state,
    effects: [
      cancelTimer(CLAIM_TIMER_ID),
      cancelTimer(REEL_TIMER_ID),
      announce(
        pending.length === 1
          ? `${titles} goes unclaimed — nobody left in the draw.`
          : `${titles} go unclaimed — nobody left in the draw.`,
      ),
      ...done.effects,
    ],
  }
}

/**
 * One prize settled, whatever settled it.
 *
 * The winners record — username, prize, claim time, claimed or manually awarded
 * or voided — is the deliverable of the whole session (§9). Every path that
 * resolves a prize comes through here so that record has exactly one shape.
 */
function settlePrize(
  state: GiveawayState,
  ctx: Ctx,
  award: {
    userId: string
    username: string
    prizeIndex: number
    method: 'claimed' | 'manual' | 'voided'
    manualReason: string | null
    claimedWithMsLeft: number | null
    announcement: string
  },
): Result {
  const prizes = state.prizes.map((p) =>
    p.index === award.prizeIndex
      ? { ...p, status: award.method === 'voided' ? ('voided' as const) : ('claimed' as const) }
      : p,
  )

  const settled: GiveawayState = {
    ...state,
    phase: 'awarded',
    prizes,
    claim: null,
    passoversExhausted: false,
    passoversThisPrize: 0,
    awards: [
      ...state.awards,
      {
        prizeIndex: award.prizeIndex,
        userId: award.userId,
        username: award.username,
        method: award.method,
        manualReason: award.manualReason,
        awardedAtMs: ctx.now,
        claimedWithMsLeft: award.claimedWithMsLeft,
      },
    ],
  }

  const cleared: Effect[] = [
    cancelTimer(CLAIM_TIMER_ID),
    cancelTimer(`${REMINDER_TIMER_ID}:50`),
    cancelTimer(`${REMINDER_TIMER_ID}:20`),
    cancelTimer(PASSOVER_TIMER_ID),
    announce(award.announcement),
  ]

  // §4 — all prizes settled ends the session. The streamer's "next prize"
  // button drives the reel for the ones that remain, so this only fires once.
  if (nextPendingPrize(settled) === null) {
    const done = complete(settled, ctx)
    return { state: done.state, effects: [...cleared, ...done.effects] }
  }

  return { state: settled, effects: cleared }
}

/**
 * `COMPLETE` — §3, the reveal half of the commitment.
 *
 * The seed, the complete entry list in join order with each entrant's weight,
 * and the draw function are all published together, and anybody can recompute
 * the entire result. The seed is the last thing withheld from `project()` and
 * this is the transition that stops withholding it.
 */
function complete(state: GiveawayState, ctx: Ctx): Result {
  if (state.phase === 'complete') return { state, effects: [end('complete')] }

  const winners = state.awards
    .filter((a) => a.method !== 'voided')
    .map((a) => `@${a.username}`)
    .join(', ')

  return {
    state: {
      ...state,
      phase: 'complete',
      claim: null,
      seedRevealed: ctx.config.publishSeed,
      passoversExhausted: false,
    },
    effects: [
      cancelTimer(CLAIM_TIMER_ID),
      cancelTimer(ENTRY_TIMER_ID),
      announce(
        winners === ''
          ? "That's the giveaway — nothing awarded this time."
          : `That's the giveaway. Winners: ${winners}.` +
            (ctx.config.publishSeed ? ` Seed: ${state.seed ?? ''}` : ''),
      ),
    ],
  }
}

/**
 * §3 — "abandoned sessions are recorded."
 *
 * A streamer who opens a giveaway, sees a name they dislike, and abandons the
 * session leaves a public row in history saying exactly that, **with the seed
 * published anyway**. The escape hatch stays open — a streamer must always be
 * able to stop — but it is not silent, on the same doctrine as every other
 * Abandon in the catalog.
 */
function abandon(state: GiveawayState, ctx: Ctx): Result {
  return {
    state: { ...state, phase: 'complete', claim: null, seedRevealed: ctx.config.publishSeed },
    effects: [
      cancelTimer(ENTRY_TIMER_ID),
      cancelTimer(CLAIM_TIMER_ID),
      cancelTimer(REEL_TIMER_ID),
      announce(
        `This giveaway was stopped before it finished. ` +
          (ctx.config.publishSeed ? `Seed published anyway: ${state.seed ?? ''}` : ''),
      ),
      end('abandoned'),
    ],
  }
}

// ─── Timers ─────────────────────────────────────────────────────────────────

function handleTimer(
  state: GiveawayState,
  event: Extract<InternalEvent, { type: 'timer' }>,
  ctx: Ctx,
): Result {
  const payload = (event.payload ?? {}) as { kind?: string; pct?: number; prizeIndex?: number }

  switch (payload.kind) {
    case 'entryClosed':
      return lockEntries(state, ctx)
    case 'rejectionSummary':
      return rejectionSummary(state, ctx)
    case 'lockedHoldDone':
      return state.phase === 'locked'
        ? { state, effects: [broadcast({ drawReady: true })] }
        : { state, effects: [] }
    case 'reelSettled':
      return settleReel(state, ctx)
    case 'claimStarted':
      return state.claim === null
        ? { state, effects: [] }
        : { state, effects: [broadcast({ claimAnnounced: true })] }
    case 'claimReminder':
      return claimReminder(state, payload.pct ?? 50, ctx)
    case 'claimExpired':
      return state.claim !== null && payload.prizeIndex === state.claim.prizeIndex
        ? passOver(state, ctx, 'expired', '')
        : { state, effects: [] }
    case 'passoverRevealed':
      return state.phase === 'passover' && !state.passoversExhausted
        ? { state: { ...state, phase: 'claim' }, effects: [] }
        : { state, effects: [] }
    default:
      return { state, effects: [] }
  }
}

/**
 * §5 — one batched rejection summary, once, at thirty seconds remaining, and
 * only if the count is non-trivial.
 *
 * One message, actionable, timed so there is still a window left to act in. The
 * alternative — a reply to each rejected entrant — is the thing this game's
 * entire chat discipline exists to prevent.
 */
function rejectionSummary(state: GiveawayState, ctx: Ctx): Result {
  if (state.phase !== 'open' || state.rejectionSummarySent) return { state, effects: [] }

  const worst = Object.entries(state.rejected)
    .filter(([reason]) => reason === 'gate' || reason === 'follow-age' || reason === 'account-age')
    .sort((a, b) => b[1] - a[1])[0]

  if (!worst || worst[1] < REJECTION_SUMMARY_MIN_COUNT) return { state, effects: [] }

  const copy = REJECTION_COPY[worst[0] as RejectionReason]
  return {
    state: { ...state, rejectionSummarySent: true },
    effects: [
      announce(
        `${worst[1]} entries didn't count — ${copy.reason}. ${copy.remedy}, there's still time.`,
      ),
    ],
  }
}

/** §8.2 — at 50% and 20% remaining, addressed to one person. Not delayed. */
function claimReminder(state: GiveawayState, pct: number, ctx: Ctx): Result {
  const c = state.claim
  if (c === null || state.phase !== 'claim') return { state, effects: [] }
  if (state.awards.some((a) => a.prizeIndex === c.prizeIndex)) return { state, effects: [] }

  const remainingMs = c.expiresAtMs - ctx.now
  if (remainingMs <= 0) return { state, effects: [] }

  const prize = state.prizes[c.prizeIndex]
  return {
    state: { ...state, claim: { ...c, remindersSent: c.remindersSent + 1 } },
    effects: [
      {
        kind: 'chat',
        text: `@${c.username} — ${formatRemaining(remainingMs)} left to !claim ${prize?.title ?? 'your prize'}.`,
        priority: 'announce',
        // §12 — "Not delayed. The name is already public and the delay would
        // spend the window."
        holdForStreamDelay: false,
      },
    ],
  }
}

// ─── Gating, ordering, helpers ──────────────────────────────────────────────

/**
 * §5 and §10 — every reason an entry does not count, in the order they are
 * cheapest to check. Returns null when the entry is good.
 *
 * The follow-age and account-age guards are written out in full and are unable
 * to fire, because the runtime cannot supply the two timestamps they need. See
 * `IDENTITY_FACTS_AVAILABLE` — this is the shape the guard takes the day the
 * platform can answer, and leaving it here rather than deleting it is what makes
 * that a one-line change instead of a rewrite.
 */
export function gateVerdict(
  state: GiveawayState,
  userId: string,
  role: string,
  config: GiveawayConfig,
): RejectionReason | null {
  if (config.blockedUserIds.includes(userId)) return 'blocked'
  if (state.removedUserIds.includes(userId)) return 'removed'

  // §5 — a gate the streamer lifted mid-window. Blocks and mod removals are
  // above this line on purpose: loosening a role gate is not an amnesty.
  if (state.gateOverride === 'anyone') return null

  if (config.entryGate === 'subscribers') {
    // The one gate a chat badge can actually answer.
    const privileged = role === 'subscriber' || role === 'moderator' || role === 'broadcaster'
    if (!privileged) return 'gate'
  }

  if (config.entryGate === 'followers' && IDENTITY_FACTS_AVAILABLE) {
    if (role === 'viewer') return 'gate'
  }

  return null
}

/**
 * The next position in the committed order that may hold this prize.
 *
 * The cursor walks `drawOrder`, which was fixed at `LOCKED`, and skips:
 *
 *   - anyone a mod removed;
 *   - anyone already passed over **on this prize** — §5, "the passed-over viewer
 *     stays in the order at their original position and cannot be drawn again
 *     this prize";
 *   - anyone who already won something, unless `allowPreviousWinners` — §9, the
 *     default that spreads a three-prize session across three people instead of
 *     concentrating it in one;
 *   - anyone passed over on an *earlier* prize, under the same setting, since
 *     §5 makes that the flag's other job.
 *
 * With the defaults and no passovers this puts three prizes on positions one,
 * two and three, exactly as §3 describes. With a passover on prize one, prize
 * one goes to position two and prize two to position three — the cursor
 * advancing down a list that was determined before the first person typed.
 */
export function nextEligible(
  state: GiveawayState,
  prizeIndex: number,
  config: GiveawayConfig,
): { userId: string; username: string; orderIndex: number } | null {
  const removed = new Set(state.removedUserIds)
  const won = new Set(state.awards.filter((a) => a.userId !== '').map((a) => a.userId))
  const passedThisPrize = new Set(
    state.passovers.filter((p) => p.prizeIndex === prizeIndex).map((p) => p.userId),
  )
  const passedEver = new Set(state.passovers.map((p) => p.userId))

  for (let i = 0; i < state.drawOrder.length; i++) {
    const userId = state.drawOrder[i] as string
    if (removed.has(userId)) continue
    if (passedThisPrize.has(userId)) continue
    if (!config.allowPreviousWinners && (won.has(userId) || passedEver.has(userId))) continue

    const entry = state.entries.find((e) => e.userId === userId)
    if (!entry) continue
    return { userId, username: entry.username, orderIndex: i }
  }

  return null
}

/** Prizes are revealed one at a time, smallest first — §7.2's ordering. */
export function nextPendingPrize(state: GiveawayState): number | null {
  const pending = state.prizes.find((p) => p.status === 'pending')
  return pending ? pending.index : null
}

/** Aggregate-only rejection counting — never per user. See `RejectionReason`. */
function count(state: GiveawayState, reason: RejectionReason): GiveawayState {
  return {
    ...state,
    rejected: { ...state.rejected, [reason]: (state.rejected[reason] ?? 0) + 1 },
  }
}

/** Kick's badge vocabulary mapped onto the weighting roles. */
export function entryRole(role: string): EntryRole {
  switch (role) {
    case 'broadcaster':
    case 'moderator':
      return 'mod'
    case 'subscriber':
      return 'subscriber'
    case 'follower':
      return 'follower'
    default:
      return 'viewer'
  }
}

function prizeLine(state: GiveawayState): string {
  const pending = state.prizes.filter((p) => p.status === 'pending').length
  return pending === 1
    ? `${state.prizes.find((p) => p.status === 'pending')?.title ?? 'One prize'} up for grabs.`
    : `${pending} prizes up for grabs.`
}

function formatRemaining(ms: number): string {
  const total = Math.round(ms / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`
}

export { oddsFor, totalWeight }
