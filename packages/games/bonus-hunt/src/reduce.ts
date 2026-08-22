/**
 * Bonus Hunt reducer — §13.
 *
 * Pure. No I/O, no Date.now(), no Math.random(). Time comes from `ctx.now`
 * (carried on the event and persisted), ids come from `ctx.seq`. Feed it an
 * array of events and it produces the same state and the same effects every
 * time, which is what makes replay and crash recovery work.
 */

import {
  announce,
  broadcast,
  cancelTimer,
  closestTo,
  end,
  formatMoney,
  formatMultiplier,
  formatSigned,
  lookup,
  parseAmount,
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
  collectedCount,
  derive,
  entryCountFor,
  findEntry,
  hasSlot,
  nextOrder,
  outstandingCountFor,
} from './derived.js'
import {
  GUESS_TIMER_ID,
  type BonusHuntConfig,
  type BonusHuntState,
  type HuntEntry,
  type LookupThen,
} from './types.js'

type Ctx = ReduceContext<BonusHuntConfig>
type Result = ReduceResult<BonusHuntState>

const STATUS_REPLY_COOLDOWN_MS = 60_000

export function reduce(state: BonusHuntState, event: InternalEvent, ctx: Ctx): Result {
  switch (event.type) {
    case 'session.started':
      return {
        state,
        effects: [broadcast({ phase: state.phase })],
      }

    case 'command':
      return handleCommand(state, event, ctx)

    case 'control':
      return handleControl(state, event, ctx)

    case 'slot.resolved':
      return handleSlotResolved(state, event, ctx)

    case 'timer':
      return handleTimer(state, event, ctx)

    case 'session.ended':
      return { state: { ...state, phase: 'complete' }, effects: [] }

    default:
      return { state, effects: [] }
  }
}

// ─── Chat commands ──────────────────────────────────────────────────────────

function handleCommand(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  switch (event.command) {
    case 'sr':
      return requestSlot(state, event, ctx)
    case 'editsr':
      return editSlot(state, event, ctx)
    case 'guess':
      return submitGuess(state, event, ctx)
    case 'hunt':
      return statusReply(state, event, ctx)
    case 'myslot':
      return mySlotReply(state, event)
    default:
      return { state, effects: [] }
  }
}

function requestSlot(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const { actor, messageId, args } = event

  if (state.phase !== 'collecting') {
    return {
      state,
      effects: [
        rejection(
          state.phase === 'guessing'
            ? `@${actor.username} the list is locked — type !guess <amount> instead.`
            : `@${actor.username} slot requests are closed for this hunt.`,
          messageId,
        ),
      ],
    }
  }

  const query = args.trim()
  if (query === '') {
    return {
      state,
      effects: [rejection(`@${actor.username} type a slot name, e.g. !sr Gates of Olympus`, messageId)],
    }
  }

  // §13 — the entry cap, counted one of two ways depending on the setting.
  //
  // Lifetime: one slot each for the whole hunt.
  // Outstanding (default): one at a time, and you may go again once the
  // streamer has banked or dropped your last one.
  const cap = ctx.config.maxEntriesPerViewer
  const held = ctx.config.oneEntryPerViewer
    ? entryCountFor(state, actor.userId)
    : outstandingCountFor(state, actor.userId)

  if (held >= cap) {
    return {
      state,
      effects: [rejection(capMessage(actor.username, ctx.config, state.phase), messageId)],
    }
  }

  if (ctx.config.closeCollectionAtTarget && collectedCount(state) >= ctx.config.targetBonuses) {
    return {
      state,
      effects: [
        rejection(`@${actor.username} the list is full at ${ctx.config.targetBonuses} bonuses.`, messageId),
      ],
    }
  }

  // The entry appears as pending immediately, then firms up when the catalog
  // answers (§9, two-pass pattern). Feels fast, stays pure.
  const entry: HuntEntry = {
    id: entryId(ctx.seq),
    slotId: null,
    slotName: null,
    provider: null,
    thumbnail: null,
    rawText: query,
    requestedBy: { userId: actor.userId, username: actor.username, role: actor.role },
    bet: ctx.config.defaultBet,
    win: null,
    status: 'pending',
    order: nextOrder(state),
    suggestions: [],
  }

  const then: LookupThen = { kind: 'entry', entryId: entry.id }
  return {
    state: { ...state, entries: [...state.entries, entry] },
    effects: [lookup(query, then)],
  }
}

/**
 * `!editsr <slot>` — swap the slot you asked for.
 *
 * Changing your mind before the hunt starts is normal, and making viewers ask a
 * mod to remove their entry so they can re-request is a worse experience than
 * simply letting them retype it. Mirrors the tournament's `!join`, which already
 * replaces a previous pick while the window is open (§14).
 */
function editSlot(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const { actor, messageId, args } = event

  if (state.phase !== 'collecting') {
    return {
      state,
      effects: [
        rejection(`@${actor.username} the list is locked — slots can't be changed now.`, messageId),
      ],
    }
  }

  const query = args.trim()
  if (query === '') {
    return {
      state,
      effects: [rejection(`@${actor.username} type the new slot, e.g. !editsr Le Bandit`, messageId)],
    }
  }

  // Their most recent entry is the one they meant, if they somehow have several.
  const mine = state.entries.filter((e) => e.requestedBy.userId === actor.userId)
  const target = mine.at(-1)

  if (!target) {
    return {
      state,
      effects: [
        rejection(`@${actor.username} you haven't picked a slot yet — use !sr <slot>.`, messageId),
      ],
    }
  }

  // A bonus that's already been opened is history; its win is in the totals and
  // rewriting the slot behind it would make the result card a lie.
  if (target.status === 'opened') {
    return {
      state,
      effects: [
        rejection(`@${actor.username} that bonus has already been opened.`, messageId),
      ],
    }
  }

  // Same two-pass shape as !sr: the entry goes pending immediately, then firms
  // up when the catalog answers.
  const swapped: HuntEntry = {
    ...target,
    slotId: null,
    slotName: null,
    provider: null,
    thumbnail: null,
    rawText: query,
    status: 'pending',
    suggestions: [],
  }

  const then: LookupThen = { kind: 'entry', entryId: swapped.id }
  return {
    state: { ...state, entries: replace(state.entries, swapped) },
    effects: [lookup(query, then)],
  }
}

/**
 * The rejection a viewer sees when they've hit the cap. It has to tell them what
 * to do next, which differs entirely between the two modes — "change it" when
 * they only ever get one, "wait" when another is coming.
 */
function capMessage(username: string, config: BonusHuntConfig, phase: string): string {
  if (config.oneEntryPerViewer) {
    return config.maxEntriesPerViewer === 1
      ? `@${username} you're already in — one slot each. ` +
        `Use !editsr <slot> to change it, or !myslot to check yours.`
      : `@${username} you've used all ${config.maxEntriesPerViewer} of your requests.`
  }

  return config.maxEntriesPerViewer === 1
    ? `@${username} your slot is still waiting to be played — ` +
      `you can request another once it's done. !editsr <slot> to change it.`
    : `@${username} you already have ${config.maxEntriesPerViewer} slots waiting to be played.`
}

function submitGuess(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  const { actor, messageId, args } = event

  if (state.phase !== 'guessing' || state.guessesLocked) {
    return {
      state,
      effects: [
        rejection(
          state.phase === 'collecting'
            ? `@${actor.username} guessing opens once the list is locked in.`
            : `@${actor.username} guesses are locked.`,
          messageId,
        ),
      ],
    }
  }

  const ceiling =
    ctx.config.guessCeiling ?? round2(state.startBalance * ctx.config.guessCeilingMultiple)
  const parsed = parseAmount(args, { ceiling })

  if (!parsed.ok) {
    const why =
      parsed.error === 'above_ceiling'
        ? `keep it under ${formatMoney(ceiling, state.currency)}`
        : `try something like !guess ${Math.round(state.startBalance * 1.2)}`
    return { state, effects: [rejection(`@${actor.username} couldn't read that guess — ${why}.`, messageId)] }
  }

  // §13 edge case — "Viewer guesses twice: last guess silently replaces the
  // first." Silently: no ack, the overlay already shows the change.
  const previous = state.guesses.find((g) => g.userId === actor.userId)
  const others = state.guesses.filter((g) => g.userId !== actor.userId)
  const guess = {
    userId: actor.userId,
    username: actor.username,
    role: actor.role,
    amount: parsed.value,
    // The tiebreak keeps the ORIGINAL sequence: §13 rewards committing early,
    // and re-typing the same number shouldn't cost someone that.
    submittedAtSeq: previous?.submittedAtSeq ?? ctx.seq,
    submittedAt: ctx.now,
    edited: previous !== undefined,
  }

  return { state: { ...state, guesses: [...others, guess] }, effects: [] }
}

function statusReply(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'command' }>,
  ctx: Ctx,
): Result {
  // §13 — "!hunt: status reply, rate-limited to one per 60s per channel."
  const last = state.lastStatusReplyAt
  if (last !== null && ctx.now - last < STATUS_REPLY_COOLDOWN_MS) {
    return { state, effects: [] }
  }

  const d = derive(state)
  const money = (n: number) => formatMoney(n, state.currency)

  const text =
    state.phase === 'collecting'
      ? `Bonus hunt: ${state.entries.length}/${ctx.config.targetBonuses} bonuses collected. ` +
        `Type !sr <slot> to add one.`
      : state.phase === 'guessing'
        ? `${state.entries.length} bonuses, ${money(d.spent)} spent — break-even is ` +
          `${money(d.breakEvenPerBonus)} per bonus. Type !guess <amount> for the final balance.`
        : state.phase === 'opening'
          ? `Opening ${d.openedCount}/${d.totalBonuses}. Running total ${money(state.totals.won)} ` +
            `against ${money(d.spent)} spent.`
          : `Hunt finished: ${money(state.finalBalance ?? 0)} from ${money(state.startBalance)} ` +
            `(${formatSigned(d.profit, state.currency)}).`

  return {
    state: { ...state, lastStatusReplyAt: ctx.now },
    effects: [reply(text, event.messageId)],
  }
}

function mySlotReply(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'command' }>,
): Result {
  const mine = state.entries.filter((e) => e.requestedBy.userId === event.actor.userId)

  if (mine.length === 0) {
    return {
      state,
      effects: [
        reply(`@${event.actor.username} you haven't picked a slot yet — !sr <slot name>.`, event.messageId),
      ],
    }
  }

  const described = mine
    .map((e) => {
      if (e.status === 'opened' && e.win !== null) {
        return `${e.slotName ?? e.rawText} paid ${formatMoney(e.win, state.currency)}`
      }
      if (e.slotId === null) return `${e.rawText} (still matching)`
      return e.slotName ?? e.rawText
    })
    .join(', ')

  return {
    state,
    effects: [
      reply(
        `@${event.actor.username} you're in with ${described}.` +
          (state.phase === 'collecting' ? ' Change it with !editsr <slot>.' : ''),
        event.messageId,
      ),
    ],
  }
}

// ─── Slot resolution (§9 two-pass, §21 ladder) ──────────────────────────────

function handleSlotResolved(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'slot.resolved' }>,
  _ctx: Ctx,
): Result {
  const then = event.then as LookupThen | null
  if (!then || then.kind !== 'entry') return { state, effects: [] }

  const entry = findEntry(state, then.entryId)
  if (!entry || entry.status === 'opened') return { state, effects: [] }

  if (event.match) {
    const patched: HuntEntry = {
      ...entry,
      slotId: event.match.slotId,
      slotName: event.match.name,
      provider: event.match.provider,
      thumbnail: event.match.thumbnail,
      // Matched, not banked. The streamer still has to play it and actually
      // trigger the bonus — see EntryStatus. An entry already banked keeps that
      // standing; opened ones returned early above.
      status: entry.status === 'collected' ? 'collected' : 'queued',
      suggestions: [],
    }
    return { state: { ...state, entries: replace(state.entries, patched) }, effects: [] }
  }

  // §15.1 — an unresolved slot name is one of the few cases where chat is the
  // only channel that works. The entry stays in the list as pending so the
  // streamer can rescue it from the unresolved queue in two seconds (§20).
  const patched: HuntEntry = { ...entry, suggestions: event.suggestions.slice(0, 3) }
  const top = event.suggestions[0]

  const message = top
    ? `@${entry.requestedBy.username} couldn't match "${entry.rawText}" — did you mean ${top.name}?`
    : `@${entry.requestedBy.username} couldn't find "${entry.rawText}" — check the spelling and try again.`

  return {
    state: { ...state, entries: replace(state.entries, patched) },
    effects: [rejection(message)],
  }
}

// ─── Timers ─────────────────────────────────────────────────────────────────

function handleTimer(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'timer' }>,
  ctx: Ctx,
): Result {
  const payload = event.payload as { kind?: string } | null
  if (payload?.kind !== 'guessWindowEnd') return { state, effects: [] }
  if (state.phase !== 'guessing' || state.guessesLocked) return { state, effects: [] }
  return lockGuesses(state, ctx)
}

// ─── Streamer / moderator control ───────────────────────────────────────────

function handleControl(
  state: BonusHuntState,
  event: Extract<InternalEvent, { type: 'control' }>,
  ctx: Ctx,
): Result {
  const p = event.payload

  switch (event.action) {
    case 'entry.add':
      return addEntry(state, p, ctx)
    case 'entry.remove':
      return removeEntry(state, String(p.entryId ?? ''))
    case 'entry.resolve':
      return resolveEntry(state, p)
    case 'entry.setBet':
      return patchEntry(state, String(p.entryId ?? ''), (e) => ({
        ...e,
        bet: Math.max(0, round2(Number(p.bet ?? e.bet))),
      }))
    case 'entry.markCollected':
      // The streamer banked the bonus. This is what frees the requester to
      // suggest another when the outstanding cap is in force.
      return patchEntry(state, String(p.entryId ?? ''), (e) => ({
        ...e,
        status: e.status === 'opened' ? 'opened' : 'collected',
        ...(p.bet !== undefined ? { bet: Math.max(0, round2(Number(p.bet))) } : {}),
      }))
    case 'entry.uncollect':
      // Misclicks happen mid-stream; putting it back in the queue must not cost
      // the win if one was already entered.
      return patchEntry(state, String(p.entryId ?? ''), (e) =>
        e.status === 'opened' ? e : { ...e, status: e.slotId ? 'queued' : 'pending' },
      )
    case 'entry.setWin':
      return setWin(state, p, ctx)
    case 'entry.reorder':
      return reorder(state, String(p.entryId ?? ''), Number(p.order ?? 0))
    case 'collection.close':
      return closeCollection(state, p, ctx)
    case 'guesses.extend':
      return extendGuessWindow(state, Number(p.ms ?? 60_000), ctx)
    case 'guesses.lock':
      return lockGuesses(state, ctx)
    case 'hunt.complete':
      return complete(state, ctx)
    case 'hunt.abandon':
      // §13 — "Hunt abandoned mid-way: no winner; session saved incomplete."
      return { state, effects: [end('abandoned')] }
    default:
      return { state, effects: [] }
  }
}

function addEntry(state: BonusHuntState, p: Record<string, unknown>, ctx: Ctx): Result {
  const rawText = String(p.rawText ?? p.slotName ?? '').trim()
  if (rawText === '') return { state, effects: [] }

  const slotId = p.slotId ? String(p.slotId) : null
  const entry: HuntEntry = {
    id: entryId(ctx.seq),
    slotId,
    slotName: p.slotName ? String(p.slotName) : null,
    provider: p.provider ? String(p.provider) : null,
    thumbnail: p.thumbnail ? String(p.thumbnail) : null,
    rawText,
    requestedBy: {
      userId: String(p.requestedByUserId ?? ctx.owner.userId),
      username: String(p.requestedByUsername ?? ctx.owner.username),
      role: String(p.requestedByRole ?? 'broadcaster'),
    },
    bet: Math.max(0, round2(Number(p.bet ?? ctx.config.defaultBet))),
    win: null,
    // A slot the streamer adds by hand is one they are about to play, so it
    // starts queued rather than banked.
    status: slotId ? 'queued' : 'pending',
    order: nextOrder(state),
    suggestions: [],
  }

  const effects: Effect[] = []
  if (!slotId) {
    const then: LookupThen = { kind: 'entry', entryId: entry.id }
    effects.push(lookup(rawText, then))
  }

  return { state: { ...state, entries: [...state.entries, entry] }, effects }
}

function removeEntry(state: BonusHuntState, id: string): Result {
  const entry = findEntry(state, id)
  if (!entry) return { state, effects: [] }

  // §13 — "Entry removed after guesses lock: allowed. Guesses stand — the hunt
  // changed, that's the risk." So no recalculation and no apology.
  const remaining = state.entries.filter((e) => e.id !== id)
  const wonBack = entry.status === 'opened' && entry.win !== null ? entry.win : 0

  return {
    state: {
      ...state,
      entries: remaining,
      totals: { ...state.totals, won: round2(state.totals.won - wonBack) },
    },
    effects: [],
  }
}

function resolveEntry(state: BonusHuntState, p: Record<string, unknown>): Result {
  const id = String(p.entryId ?? '')
  const slotId = p.slotId ? String(p.slotId) : null
  if (!slotId) return { state, effects: [] }

  return patchEntry(state, id, (e) => ({
    ...e,
    slotId,
    slotName: p.slotName ? String(p.slotName) : e.slotName,
    provider: p.provider ? String(p.provider) : e.provider,
    thumbnail: p.thumbnail ? String(p.thumbnail) : e.thumbnail,
    status: e.status === 'pending' ? 'queued' : e.status,
    suggestions: [],
  }))
}

function setWin(state: BonusHuntState, p: Record<string, unknown>, ctx: Ctx): Result {
  const id = String(p.entryId ?? '')
  const entry = findEntry(state, id)
  if (!entry) return { state, effects: [] }

  const raw = p.win
  // Clearing a win is how the streamer undoes a mistyped number (§13 edge
  // cases: "Streamer mistypes a win: editable until the session completes").
  const win = raw === null || raw === undefined || raw === '' ? null : Math.max(0, round2(Number(raw)))
  if (win !== null && !Number.isFinite(win)) return { state, effects: [] }

  const previous = entry.status === 'opened' && entry.win !== null ? entry.win : 0

  const patched: HuntEntry = {
    ...entry,
    win,
    status: win === null ? (entry.slotId ? 'collected' : 'pending') : 'opened',
    // Entering a win implies the bonus was banked, even if nobody pressed the
    // button — the streamer is plainly opening it.
    ...(p.bet !== undefined ? { bet: Math.max(0, round2(Number(p.bet))) } : {}),
  }

  const entries = replace(state.entries, patched)
  const totals = { ...state.totals, won: round2(state.totals.won - previous + (win ?? 0)) }
  const next: BonusHuntState = { ...state, entries, totals }

  const effects: Effect[] = []
  if (win !== null && patched.bet > 0) {
    // Ephemeral overlay cue — the running projection is diffed and broadcast by
    // the runtime, but the "this one just landed" flash isn't in the state.
    effects.push(
      broadcast({
        flash: {
          entryId: patched.id,
          slotName: patched.slotName ?? patched.rawText,
          win,
          multiplier: round2(win / patched.bet),
        },
      }),
    )
  }

  // Every bonus opened — the final balance is known, so resolve the game.
  const allOpened = entries.length > 0 && entries.every((e) => e.status === 'opened')
  if (allOpened && state.phase === 'opening') {
    const finished = complete(next, ctx)
    return { state: finished.state, effects: [...effects, ...finished.effects] }
  }

  return { state: next, effects }
}

function reorder(state: BonusHuntState, id: string, order: number): Result {
  const entry = findEntry(state, id)
  if (!entry || !Number.isFinite(order)) return { state, effects: [] }

  const others = state.entries.filter((e) => e.id !== id).sort((a, b) => a.order - b.order)
  const target = Math.max(0, Math.min(others.length, Math.trunc(order) - 1))
  others.splice(target, 0, entry)

  return {
    state: { ...state, entries: others.map((e, i) => ({ ...e, order: i + 1 })) },
    effects: [],
  }
}

/**
 * §13 — the "close entries" confirm dialog asks "What's your balance now?".
 * Fewer inputs during play, and it's the moment the streamer would naturally
 * look anyway. This is the only place `spent` is ever captured.
 */
function closeCollection(state: BonusHuntState, p: Record<string, unknown>, ctx: Ctx): Result {
  if (state.phase !== 'collecting') return { state, effects: [] }

  const balanceNow = Math.max(0, round2(Number(p.balanceNow ?? 0)))
  const spent = round2(Math.max(0, state.startBalance - balanceNow))

  // Guess the Balance switched off — collection closes straight into opening.
  if (!ctx.config.guessEnabled) {
    return {
      state: {
        ...state,
        phase: 'opening',
        balanceAtCloseOfCollection: balanceNow,
        totals: { ...state.totals, spent },
        guessesLocked: true,
        guessWindowEndsAt: null,
      },
      effects: [],
    }
  }

  const windowMs = Number(p.guessWindowMs ?? ctx.config.guessWindowMs)
  const next: BonusHuntState = {
    ...state,
    phase: 'guessing',
    balanceAtCloseOfCollection: balanceNow,
    totals: { ...state.totals, spent },
    guessWindowEndsAt: ctx.now + windowMs,
    guessesLocked: false,
  }

  const d = derive(next)
  const money = (n: number) => formatMoney(n, state.currency)

  return {
    state: next,
    effects: [
      timer(windowMs, { kind: 'guessWindowEnd' }, GUESS_TIMER_ID),
      announce(
        `Guess the Balance is open! ${next.entries.length} bonuses, ${money(spent)} spent — ` +
          `break-even is ${money(d.breakEvenPerBonus)} per bonus. ` +
          `Type !guess <amount> for the final balance. ${Math.round(windowMs / 1000)}s on the clock.`,
      ),
    ],
  }
}

/**
 * Push the guess deadline back. Chat is usually still arriving when the clock
 * runs out, and a streamer mid-narration should be able to buy a minute without
 * locking and reopening.
 */
function extendGuessWindow(state: BonusHuntState, ms: number, ctx: Ctx): Result {
  if (state.phase !== 'guessing' || state.guessesLocked) return { state, effects: [] }
  if (!Number.isFinite(ms) || ms <= 0) return { state, effects: [] }

  // Extend from whichever is later, so an extension pressed after the clock
  // expired still gives a full window rather than a deadline in the past.
  const endsAt = Math.max(state.guessWindowEndsAt ?? ctx.now, ctx.now) + ms

  return {
    state: { ...state, guessWindowEndsAt: endsAt },
    // The named timer replaces the previous one, so the old countdown can't
    // fire and lock the window early.
    effects: [timer(endsAt - ctx.now, { kind: 'guessWindowEnd' }, GUESS_TIMER_ID)],
  }
}

function lockGuesses(state: BonusHuntState, _ctx: Ctx): Result {
  if (state.phase !== 'guessing') return { state, effects: [] }

  return {
    state: { ...state, phase: 'opening', guessesLocked: true, guessWindowEndsAt: null },
    effects: [
      cancelTimer(GUESS_TIMER_ID),
      broadcast({ flash: { kind: 'guessesLocked', count: state.guesses.length } }),
    ],
  }
}

/**
 * §15.4 — "Always two messages, not one. The game result and the viewer winner
 * are different achievements; merging them buries both." Both are announcements,
 * so both are held behind the stream delay (§15.3) and spaced by the sender.
 */
function complete(state: BonusHuntState, _ctx: Ctx): Result {
  if (state.phase === 'complete') return { state, effects: [] }

  const d = derive(state)
  const finalBalance = round2((state.balanceAtCloseOfCollection ?? state.startBalance) + state.totals.won)
  const money = (n: number) => formatMoney(n, state.currency)

  const closest = closestTo(finalBalance, state.guesses)
  const winner = closest
    ? {
        userId: closest.winner.userId,
        username: closest.winner.username,
        amount: closest.winner.amount,
        difference: round2(closest.difference),
      }
    : null

  const next: BonusHuntState = {
    ...state,
    phase: 'complete',
    finalBalance,
    winner,
    guessesLocked: true,
    guessWindowEndsAt: null,
  }

  const effects: Effect[] = [cancelTimer(GUESS_TIMER_ID)]

  const best = d.bestEntry
  effects.push(
    announce(
      `Hunt complete! ${money(state.startBalance)} → ${money(finalBalance)} ` +
        `(${formatSigned(round2(finalBalance - state.startBalance), state.currency)}).` +
        (best ? ` Best slot: ${best.slotName} at ${formatMultiplier(best.multiplier)}` : ''),
    ),
  )

  // §13 — "If nobody guessed, skip the announcement rather than showing an
  // empty winner card."
  if (winner) {
    effects.push(
      announce(
        `@${winner.username} wins Guess the Balance! Final was ${money(finalBalance)} — ` +
          `guessed ${money(winner.amount)}, off by ${money(winner.difference)}. ` +
          `${state.guesses.length} ${state.guesses.length === 1 ? 'player' : 'players'} entered.`,
      ),
    )
  }

  effects.push(end('complete'))
  return { state: next, effects }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Ids derive from the event sequence, so a replay reproduces them exactly. */
function entryId(seq: number): string {
  return `e${seq}`
}

function replace(entries: readonly HuntEntry[], patched: HuntEntry): HuntEntry[] {
  return entries.map((e) => (e.id === patched.id ? patched : e))
}

function patchEntry(
  state: BonusHuntState,
  id: string,
  fn: (entry: HuntEntry) => HuntEntry,
): Result {
  const entry = findEntry(state, id)
  if (!entry) return { state, effects: [] }
  return { state: { ...state, entries: replace(state.entries, fn(entry)) }, effects: [] }
}

export { hasSlot }
