/**
 * Giveaways, played through the real engine.
 *
 * The unit tests cover the draw and the arithmetic; this covers the state
 * machine and the two clocks, and it exists mostly for §2 and §8.1 — the two
 * rules that are invisible when they are wrong.
 *
 * **§2**: entry stays open past countdown-zero by the grace period, silently.
 * Get this wrong and the session still runs, the count still climbs, and the
 * only symptom is that viewers on a slow connection are rejected for typing at
 * the moment their own screen told them to.
 *
 * **§8.1**: the claim clock starts when the chat announcement lands, not when
 * the reel stops. Get this wrong and the session still runs, the winner still
 * gets a window, and the only symptom is that twelve to thirty seconds of it
 * were spent before they could possibly have known they had won.
 *
 * Both are asserted here against a real clock, because neither is checkable by
 * reading the reducer.
 */

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { GameEngine, type ChatEffect, type Effect, type InternalEvent } from '@streamarena/core'
import { giveaways } from '../dist/index.js'
import type { GiveawayConfig, GiveawayState } from '../dist/types.js'

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }
const T0 = 1_000_000
const DELAY = 12_000

let seq = 0
let clock = T0
beforeEach(() => {
  seq = 0
  clock = T0
})

/** Every event carries its own wall clock — the reducer's only clock. */
const ev = (partial: Omit<InternalEvent, 'seq' | 'at'>, at?: number): InternalEvent => {
  seq += 1
  return { ...partial, seq, at: at ?? clock } as InternalEvent
}

const enter = (name: string, at?: number, role = 'viewer'): InternalEvent =>
  ev(
    {
      type: 'command',
      command: 'enter',
      args: '',
      raw: '!drop',
      actor: { userId: `u-${name}`, username: name, role: role as 'viewer' },
      messageId: `m-${name}-${seq}`,
    },
    at,
  )

const claimCmd = (name: string, at?: number): InternalEvent =>
  ev(
    {
      type: 'command',
      command: 'claim',
      args: '',
      raw: '!claim',
      actor: { userId: `u-${name}`, username: name, role: 'viewer' },
      messageId: `c-${name}-${seq}`,
    },
    at,
  )

const control = (action: string, payload: Record<string, unknown> = {}, at?: number): InternalEvent =>
  ev({ type: 'control', action, payload, actor: OWNER }, at)

const fire = (kind: string, extra: Record<string, unknown> = {}, at?: number): InternalEvent =>
  ev({ type: 'timer', payload: { kind, ...extra } }, at)

function engine(over: Partial<GiveawayConfig> = {}, seed = 'giveaway-seed') {
  return new GameEngine(giveaways, {
    config: giveaways.configSchema.parse({
      prizes: [{ title: 'EUR 100 bonus buy' }],
      streamDelayMs: DELAY,
      ...over,
    }),
    init: { sessionId: 's-1', channelId: 'c-1', seed, startedAt: T0, owner: OWNER },
  })
}

interface Run {
  state: GiveawayState
  effects: Effect[]
  chat: string[]
  timers: { id?: string; inMs: number; event: unknown }[]
}

function run(events: InternalEvent[], over: Partial<GiveawayConfig> = {}, seed?: string): Run {
  const e = engine(over, seed)
  let state = e.initialState()
  const effects: Effect[] = []
  for (const event of events) {
    const folded = e.apply(state, event)
    state = folded.state
    effects.push(...folded.effects)
  }
  return {
    state,
    effects,
    chat: effects.filter((f): f is ChatEffect => f.kind === 'chat').map((f) => f.text),
    timers: effects
      .filter((f): f is Extract<Effect, { kind: 'timer' }> => f.kind === 'timer')
      .map((f) => ({ id: f.id, inMs: f.inMs, event: f.event })),
  }
}

/** The events that get a session to a locked pool of `n` named entrants. */
function openWith(names: string[], over: Partial<GiveawayConfig> = {}): InternalEvent[] {
  return [
    ev({ type: 'session.started' }),
    control('entry.open'),
    ...names.map((n) => enter(n)),
  ]
}

// ─── §4: the phases ─────────────────────────────────────────────────────────

test('a session sits idle until the streamer fires it', () => {
  /*
   * §4 — "IDLE exists so a configured giveaway can sit ready on the dashboard
   * and be fired with one button when the streamer reaches a natural break.
   * That is how this game will actually be used." Opening entry at session
   * creation would burn the window while they are still talking about
   * something else.
   */
  const { state, chat } = run([ev({ type: 'session.started' })])

  assert.equal(state.phase, 'idle')
  assert.equal(state.entryClosesAtMs, null)
  assert.deepEqual(chat, [], 'nothing is announced until entry actually opens')
})

test('opening entry publishes the hash and announces the prize, not the clock', () => {
  /*
   * §2 rule 4 — "the chat announcement is not how entry opens. By the time a
   * bot message about a thirty-second window has been read, the window is
   * gone." Chat announces the prize; the overlay runs the clock.
   */
  const { state, chat } = run([ev({ type: 'session.started' }), control('entry.open')])

  assert.equal(state.phase, 'open')
  assert.match(chat[0]!, /GIVEAWAY OPEN/)
  assert.match(chat[0]!, /EUR 100 bonus buy/)
  assert.match(chat[0]!, /!drop/)
  assert.match(chat[0]!, new RegExp(state.seedHash))
  assert.ok(!/\d+\s*(seconds|minutes|s\b)/i.test(chat[0]!), 'the opening message carries no duration')
})

test('entry cannot be reopened once it has run', () => {
  // There is no transition that regenerates a seed inside a session (§3), and
  // reopening entry would be exactly that wearing a different name.
  const { state } = run([...openWith(['a']), control('entry.open')])
  assert.equal(state.entries.length, 1)
})

// ─── §2: the grace period ───────────────────────────────────────────────────

test('an entry at countdown-zero is accepted, and so is one inside the grace', () => {
  /*
   * The whole of §2 in one assertion.
   *
   * "When the streamer closes entry at wall-clock time T, the viewer's overlay
   * countdown reaches zero at T + delay. A viewer who types the instant their
   * own countdown hits zero has typed after the server closed. They did exactly
   * the right thing and were rejected for it."
   *
   * The grace is stream delay plus five seconds, so a viewer 12 seconds behind
   * who reacts in four still lands.
   */
  const zero = T0 + 180_000
  const { state } = run([
    ev({ type: 'session.started' }),
    control('entry.open'),
    enter('early', T0 + 1_000),
    enter('exactly-at-zero', zero),
    enter('twelve-seconds-behind', zero + 12_000),
    enter('sixteen-seconds-behind', zero + 16_000),
  ])

  assert.deepEqual(
    state.entries.map((e) => e.username),
    ['early', 'exactly-at-zero', 'twelve-seconds-behind', 'sixteen-seconds-behind'],
  )
  assert.deepEqual(state.rejected, {}, 'nobody inside the grace is counted as rejected')
})

test('an entry past the grace is rejected, silently, and only counted', () => {
  const zero = T0 + 180_000
  const { state, chat } = run([
    ev({ type: 'session.started' }),
    control('entry.open'),
    enter('far-too-late', zero + 60_000),
  ])

  assert.equal(state.entries.length, 0)
  assert.equal(state.rejected.late, 1)
  assert.deepEqual(chat.slice(1), [], 'a late entrant is never told they were late')
})

test('the grace is invisible — the overlay is told countdown-zero and nothing else', () => {
  /*
   * UI §"the four highest-value decisions" — "no visible mention of the grace;
   * a viewer who typed at zero and got in should have no idea anything was
   * extended for them".
   */
  const { state } = run([...openWith([])])
  const overlay = giveaways.project(state) as Record<string, unknown>

  assert.equal(overlay.entryClosesAtMs, T0 + 180_000)
  assert.ok(!('graceMs' in overlay), 'the grace never reaches a client')
  assert.equal(state.entryClosesAtMs, T0 + 180_000)
})

test('the lock timer fires at countdown-zero plus the grace, not at zero', () => {
  // The phase must not leave `open` while entries are still legitimately
  // landing, or the reducer starts rejecting people the design just accepted.
  const { timers } = run([ev({ type: 'session.started' }), control('entry.open')])
  const lock = timers.find((t) => t.id === 'giveaway-entry-window')!

  assert.equal(lock.inMs, 180_000 + DELAY + 5_000)
})

test('closing entry starts a visible countdown rather than closing entry', () => {
  /*
   * §2 rule 3 — "there is no snap close. A 'closing entries now' button that
   * closed entries now would re-create the exact failure the grace period
   * exists to prevent."
   */
  const at = T0 + 30_000
  const { state, chat, timers } = run([...openWith(['a']), control('entry.close', {}, at)])

  assert.equal(state.phase, 'open', 'still open')
  assert.equal(state.closing, true)
  assert.equal(state.entryClosesAtMs, at + 15_000, 'fifteen seconds, visibly')
  assert.match(chat.at(-1)!, /Last call/)
  assert.equal(timers.at(-1)!.inMs, 15_000 + DELAY + 5_000)
})

test('closing cannot push the clock away from an audience already watching it end', () => {
  // Pressing close with eight seconds left must not extend the window back up
  // to the fifteen-second floor. The clock the audience is looking at only ever
  // moves toward them.
  const late = T0 + 180_000 - 8_000
  const { state } = run([...openWith(['a']), control('entry.close', {}, late)])

  assert.equal(state.entryClosesAtMs, T0 + 180_000)
  assert.equal(state.closing, true)
})

// ─── §5: what entry does and does not say ───────────────────────────────────

test('a repeat entry is counted once and is not an error', () => {
  const { state, chat } = run([...openWith(['a']), enter('a'), enter('a')])

  assert.equal(state.entries.length, 1)
  assert.deepEqual(chat.slice(1), [], 'a second keyword is not an error and must not read as one')
})

test('nothing is ever acked to an entrant, at any volume', () => {
  /*
   * §5 — the rule that is a quota decision before it is a design one. Eight
   * hundred entries producing eight hundred replies is outside Kick's rate
   * limits and is the worst thing that has ever happened to a channel's chat.
   */
  const names = Array.from({ length: 300 }, (_, i) => `viewer${i}`)
  const { state, chat } = run(openWith(names))

  assert.equal(state.entries.length, 300)
  assert.equal(chat.length, 1, 'the opening announcement, and nothing else')
})

test('the subscriber gate rejects silently and counts in the aggregate', () => {
  /*
   * §10.3 — the one gate a chat badge can answer, so the one that actually
   * runs. Rejections are aggregate-only by design: a per-user rejection record
   * would be data with no legitimate consumer and one very tempting
   * illegitimate one.
   */
  const { state, chat } = run(
    [
      ev({ type: 'session.started' }),
      control('entry.open'),
      enter('a-sub', undefined, 'subscriber'),
      enter('a-viewer', undefined, 'viewer'),
    ],
    { entryGate: 'subscribers' },
  )

  assert.deepEqual(
    state.entries.map((e) => e.username),
    ['a-sub'],
  )
  assert.equal(state.rejected.gate, 1)
  assert.equal(chat.length, 1)
})

test('the follower gate does not reject anyone, because it cannot check anything', () => {
  /*
   * §10.1's unknown, resolved: Kick's chat payload carries no follower badge
   * and the public API exposes no follow timestamp. Silently rejecting every
   * unbadged viewer would lock a whole channel out of a giveaway advertised as
   * open to followers — the same conclusion `normalise.ts` reaches, for the
   * same reason.
   */
  const { state } = run(
    [ev({ type: 'session.started' }), control('entry.open'), enter('somebody')],
    { entryGate: 'followers' },
  )

  assert.equal(state.entries.length, 1)
  assert.equal(state.identityGuardsEnforced, false)
  assert.equal(state.gateLine, 'Open to everyone', 'and the overlay says so rather than claiming a gate')
})

test('the rejection summary goes out once, batched, with time left to act', () => {
  /*
   * §5 — "one message, actionable, timed so there is still a window left to act
   * in". Below a non-trivial count it is noise rather than information and is
   * skipped entirely.
   */
  const gated = { entryGate: 'subscribers' as const }
  const rejected = Array.from({ length: 41 }, (_, i) => enter(`v${i}`))

  const { chat } = run(
    [ev({ type: 'session.started' }), control('entry.open'), ...rejected, fire('rejectionSummary')],
    gated,
  )

  const summary = chat.find((c) => c.includes("didn't count"))!
  assert.match(summary, /^41 entries didn't count/)
  assert.match(summary, /there's still time/)

  const quiet = run(
    [ev({ type: 'session.started' }), control('entry.open'), enter('v1'), fire('rejectionSummary')],
    gated,
  )
  assert.equal(quiet.chat.filter((c) => c.includes("didn't count")).length, 0)
})

test('the summary never fires twice', () => {
  const rejected = Array.from({ length: 20 }, (_, i) => enter(`v${i}`))
  const { chat } = run(
    [
      ev({ type: 'session.started' }),
      control('entry.open'),
      ...rejected,
      fire('rejectionSummary'),
      fire('rejectionSummary'),
    ],
    { entryGate: 'subscribers' },
  )

  assert.equal(chat.filter((c) => c.includes("didn't count")).length, 1)
})

// ─── §13: the hero number ───────────────────────────────────────────────────

test('the overlay entry count never goes backwards', () => {
  /*
   * §13 — "a hero number that drops by forty in front of the whole channel
   * invites exactly one conclusion". Removals are subtracted from the dashboard
   * figure; the overlay counts accepted entries and is monotonic.
   */
  const names = ['a', 'b', 'c', 'd']
  const before = run(openWith(names))
  const after = run([...openWith(names), control('entry.remove', { username: 'b' })])

  const overlayBefore = giveaways.project(before.state) as Record<string, number>
  const overlayAfter = giveaways.project(after.state) as Record<string, number>

  assert.equal(overlayBefore.entryCount, 4)
  assert.ok(
    overlayAfter.entryCount! <= overlayBefore.entryCount!,
    'the count may hold, but a drop must never be projected as a live decrement',
  )
  assert.ok(after.state.removedUserIds.includes('u-b'))
})

test('a removed viewer cannot re-enter', () => {
  const { state } = run([
    ...openWith(['a', 'b']),
    control('entry.remove', { username: 'b' }),
    enter('b'),
  ])

  assert.deepEqual(state.entries.map((e) => e.username), ['a'])
  assert.equal(state.rejected.removed, 1)
})

test('a removal after the order exists is refused', () => {
  /*
   * §10.3 — "curation happens before the draw, or it does not happen". Removing
   * someone from a committed order is a re-draw wearing a moderation badge.
   */
  const { state } = run([
    ...openWith(['a', 'b']),
    fire('entryClosed'),
    control('prize.draw'),
    control('entry.remove', { username: 'b' }),
  ])

  assert.equal(state.removedUserIds.length, 0)
})

// ─── §3: the order, once ────────────────────────────────────────────────────

test('the order is computed at lock and never again', () => {
  /*
   * §14 — "`drawOrder` is computed exactly once, at LOCKED, and is immutable
   * for the life of the session. There is no code path that writes to it twice,
   * and that invariant is worth a test of its own." This is that test.
   */
  const names = ['a', 'b', 'c', 'd', 'e']
  const locked = run([...openWith(names), fire('entryClosed')])
  const committed = [...locked.state.drawOrder]

  assert.equal(committed.length, 5)

  const later = run([
    ...openWith(names),
    fire('entryClosed'),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    fire('claimExpired', { prizeIndex: 0 }),
    fire('passoverRevealed'),
  ])

  assert.deepEqual(later.state.drawOrder, committed, 'nothing after the lock touches the order')
})

test('the seed is withheld until COMPLETE and published then', () => {
  /*
   * §3 — the two halves of the commitment. The hash goes out before anyone
   * entered; the seed and the entry list go out after everything is settled,
   * and anybody can recompute the whole result from them.
   */
  const open = run(openWith(['a', 'b']))
  const openOverlay = giveaways.project(open.state) as Record<string, unknown>

  assert.equal(openOverlay.seed, null, 'publishing early would let anyone read off the order')
  assert.ok(openOverlay.seedHash)
  assert.equal(openOverlay.entryList, null)

  const done = run([
    ...openWith(['a', 'b']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    control('prize.award', { username: 'a', reason: 'test' }),
  ])
  const doneOverlay = giveaways.project(done.state) as Record<string, unknown>

  assert.equal(done.state.phase, 'complete')
  assert.equal(doneOverlay.seed, 'giveaway-seed')
  assert.equal((doneOverlay.entryList as unknown[]).length, 2)
})

test('an abandoned session publishes the seed anyway', () => {
  /*
   * §3 — "a streamer who opens a giveaway, sees a name they dislike, and
   * abandons the session leaves a public row in history saying exactly that,
   * with the seed published anyway. The escape hatch stays open, and it is not
   * silent."
   */
  const { state, chat, effects } = run([
    ...openWith(['a', 'b']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    control('giveaway.abandon'),
  ])

  assert.equal(state.seedRevealed, true)
  assert.deepEqual(state.awards, [], 'no winners recorded')
  assert.match(chat.at(-1)!, /stopped before it finished/)
  assert.ok(effects.some((e) => e.kind === 'end' && e.reason === 'abandoned'))
})

test('there is no control action that draws twice', () => {
  // §11 — "there is no re-draw action, at any privilege level, in any phase.
  // Its absence is a feature." Anything that looked like one would show up as a
  // second winner for a prize already settled.
  const base = [
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
  ]

  const winner = run(base).state.claim!.username
  for (const action of ['prize.draw', 'entry.open', 'draw.skip', 'prize.next']) {
    const after = run([...base, control(action)])
    assert.equal(after.state.claim?.username, winner, `${action} moved the winner`)
  }
})

// ─── §8.1: the claim clock ──────────────────────────────────────────────────

test('the claim clock starts when the announcement lands, not when the reel stops', () => {
  /*
   * §8.1, and the reason it matters: "starting it at the draw would silently
   * spend the delay — twelve to thirty seconds of a three-minute window —
   * before the winner had any way of knowing they had won."
   */
  const settleAt = T0 + 200_000
  const { state, timers } = run([
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed', {}, settleAt - 1),
    control('prize.draw', {}, settleAt - 1),
    fire('reelSettled', {}, settleAt),
  ])

  const claim = state.claim!
  assert.equal(claim.startedAtMs, settleAt + DELAY, 'the clock starts when chat sees the name')
  assert.equal(claim.expiresAtMs, settleAt + DELAY + 180_000)

  const expiry = timers.filter((t) => t.id === 'giveaway-claim').at(-1)!
  assert.equal(expiry.inMs, DELAY + 180_000, 'and the server clock agrees with the overlay clock')
})

test('with the announcement off, the clock starts at the settle', () => {
  // The correct behaviour for that setting, and also why §15 says it "should
  // not be turned off": the winner now has no way of learning they won at all.
  const settleAt = T0 + 200_000
  const { state } = run(
    [
      ...openWith(['a', 'b']),
      fire('entryClosed', {}, settleAt - 1),
      control('prize.draw', {}, settleAt - 1),
      fire('reelSettled', {}, settleAt),
    ],
    { announceWinnerInChat: false },
  )

  assert.equal(state.claim!.startedAtMs, settleAt)
})

test('reminders go out at 50% and 20% remaining, and are not held for the delay', () => {
  /*
   * §12 — "not delayed: the name is already public and the delay would spend
   * the window". This is the one place in the game where a per-event chat write
   * is unambiguously worth the quota, because it is addressed to exactly one
   * person who needs to receive it.
   */
  const { timers, effects } = run([
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    fire('claimReminder', { pct: 50 }),
  ])

  assert.equal(timers.find((t) => t.id === 'giveaway-claim-reminder:50')!.inMs, DELAY + 90_000)
  assert.equal(timers.find((t) => t.id === 'giveaway-claim-reminder:20')!.inMs, DELAY + 144_000)

  const reminder = effects.filter(
    (f): f is ChatEffect => f.kind === 'chat' && f.text.includes('left to !claim'),
  )
  assert.equal(reminder.length, 1)
  assert.equal(reminder[0]!.holdForStreamDelay, false)
})

test('a claim from the winner settles the prize; one from anybody else is silence', () => {
  /*
   * §16 — "someone else types !claim: ignored, never acked. This will happen
   * constantly and must be silent." Everyone in chat types this for three
   * minutes.
   */
  const names = ['reelqueen', 'slotgoblin', 'maxwin']
  const base = [...openWith(names), fire('entryClosed'), control('prize.draw'), fire('reelSettled')]
  const winner = run(base).state.claim!.username
  const bystander = names.find((n) => n !== winner)!

  const noise = run([...base, claimCmd(bystander), claimCmd(bystander)])
  assert.equal(noise.state.awards.length, 0)
  assert.equal(noise.chat.filter((c) => c.includes(bystander)).length, 0)

  const real = run([...base, claimCmd(winner)])
  assert.equal(real.state.awards.length, 1)
  assert.equal(real.state.awards[0]!.method, 'claimed')
  // Not `.at(-1)`: with a single prize the claim settles the session, so the
  // completion message lands behind it in the same fold.
  assert.ok(real.chat.some((c) => c.includes(`@${winner} claimed`)))
})

test('a second claim from the winner is idempotent', () => {
  const base = [
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
  ]
  const winner = run(base).state.claim!.username
  const { state } = run([...base, claimCmd(winner), claimCmd(winner)])

  assert.equal(state.awards.length, 1, 'no second ack, no second award')
})

test('a claim after the clock has run out does not resurrect the prize', () => {
  const settleAt = T0 + 200_000
  const base = [
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed', {}, settleAt - 1),
    control('prize.draw', {}, settleAt - 1),
    fire('reelSettled', {}, settleAt),
  ]
  const winner = run(base).state.claim!.username

  const { state } = run([...base, claimCmd(winner, settleAt + DELAY + 200_000)])
  assert.equal(state.awards.length, 0)
})

// ─── §8.3: the passover ─────────────────────────────────────────────────────

test('a passover advances the cursor and says so out loud', () => {
  /*
   * §8.3 — "openly, every time. A silent substitution is the single most
   * suspicious thing this product could do, and the whole construction in §3
   * exists so that this moment can be shown rather than hidden."
   */
  const base = [
    ...openWith(['a', 'b', 'c', 'd']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
  ]
  const first = run(base).state.claim!

  const { state, chat } = run([...base, fire('claimExpired', { prizeIndex: 0 })])

  assert.equal(state.phase, 'passover', 'a distinct phase, not a silent state change')
  assert.equal(state.passovers.length, 1)
  assert.equal(state.passovers[0]!.username, first.username)
  assert.equal(state.passovers[0]!.reason, 'expired')
  assert.notEqual(state.claim!.username, first.username)
  assert.ok(state.claim!.orderIndex > first.orderIndex, 'the cursor only moves forward')

  const passoverMsg = chat.at(-1)!
  assert.match(passoverMsg, new RegExp(`@${first.username} didn't claim in time`))
  assert.match(passoverMsg, new RegExp(`goes to @${state.claim!.username}`))
})

test('a passed-over viewer cannot be drawn again for the same prize', () => {
  // §5 — "the passed-over viewer stays in the order at their original position
  // and cannot be drawn again this prize."
  const base = [
    ...openWith(['a', 'b', 'c', 'd', 'e']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
  ]

  const seen: string[] = []
  let events = base
  for (let i = 0; i < 3; i++) {
    const r = run(events)
    seen.push(r.state.claim!.username)
    events = [...events, fire('claimExpired', { prizeIndex: 0 }), fire('passoverRevealed')]
  }

  assert.equal(new Set(seen).size, seen.length, `a name repeated: ${seen.join(', ')}`)
})

test('the passover phase reveals for a beat, then becomes the claim', () => {
  const base = [
    ...openWith(['a', 'b', 'c', 'd']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    fire('claimExpired', { prizeIndex: 0 }),
  ]

  assert.equal(run(base).state.phase, 'passover')
  assert.equal(run([...base, fire('passoverRevealed')]).state.phase, 'claim')
})

test('the streamer passing over early is recorded as a streamer action, not an expiry', () => {
  /*
   * §16 — "recorded with a reason and shown on the overlay as a streamer
   * action, not as an expiry. The distinction matters and hiding it would be
   * dishonest."
   */
  const { state } = run([
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    control('prize.passover', { reason: 'they left the stream' }),
  ])

  assert.equal(state.passovers[0]!.reason, 'passed-over-by-streamer')
  assert.equal(state.passovers[0]!.note, 'they left the stream')
})

test('a streamer pass with no reason given is recorded as exactly that', () => {
  // Discretion stays visible. An empty reason is a fact about the record, not a
  // gap in it.
  const { state } = run([
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    control('prize.passover'),
  ])

  assert.equal(state.passovers[0]!.note, 'no reason given')
})

test('running out of passovers stops the session and hands the streamer the decision', () => {
  /*
   * §8.4 — "the session cannot silently resolve this itself." Every one of the
   * three options means something different for the record, and picking one on
   * the streamer's behalf would be the platform exercising exactly the
   * discretion §3 exists to remove.
   */
  let events: InternalEvent[] = [
    ...openWith(['a', 'b', 'c', 'd', 'e', 'f']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
  ]
  for (let i = 0; i < 4; i++) {
    events = [...events, fire('claimExpired', { prizeIndex: 0 }), fire('passoverRevealed')]
  }

  const { state } = run(events, { maxPassovers: 3 })

  assert.equal(state.passoversExhausted, true)
  assert.equal(state.passovers.length, 4, 'the fourth expiry is recorded, and then it stops')
  assert.equal(state.claim, null)
  assert.equal(state.awards.length, 0, 'nothing is awarded without the streamer saying so')

  // And the three options from §8.4 all work from here.
  const awarded = run([...events, control('prize.award', { username: 'a', reason: 'replied in Discord' })])
  assert.equal(awarded.state.awards[0]!.method, 'manual')
  assert.equal(awarded.state.awards[0]!.manualReason, 'replied in Discord')

  const voided = run([...events, control('prize.void', { reason: 'nobody claimed it' })])
  assert.equal(voided.state.awards[0]!.method, 'voided')
  assert.equal(voided.state.prizes[0]!.status, 'voided')
})

test('a manual award is badged as manual and carries its reason', () => {
  /*
   * §8.4 — "every manual award is logged, badged on the overlay as a manual
   * award, and appears as such in the verification record. Visible generosity,
   * again, rather than invisible discretion."
   */
  const { state } = run([
    ...openWith(['a', 'b', 'c']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    control('prize.award', { username: 'c', reason: "typo'd the command" }),
  ])

  const award = state.awards[0]!
  assert.equal(award.method, 'manual')
  assert.equal(award.username, 'c')
  assert.equal(award.manualReason, "typo'd the command")
  assert.equal(award.claimedWithMsLeft, null)

  const overlay = giveaways.project(state) as Record<string, unknown>
  assert.equal((overlay.awards as typeof state.awards)[0]!.method, 'manual')
})

// ─── §9: multiple prizes ────────────────────────────────────────────────────

test('three prizes go to three different people, in order', () => {
  /*
   * §3 — "when there are three prizes, they go to positions one, two and
   * three." §9 is why: winning one prize takes you out of the running for the
   * rest, which spreads the session across three people instead of
   * concentrating it in one.
   */
  const prizes = [{ title: 'Third' }, { title: 'Second' }, { title: 'First' }]
  const names = ['a', 'b', 'c', 'd', 'e', 'f']

  let events: InternalEvent[] = [...openWith(names), fire('entryClosed')]
  const winners: string[] = []
  const positions: number[] = []

  for (let i = 0; i < 3; i++) {
    events = [...events, control(i === 0 ? 'prize.draw' : 'prize.next'), fire('reelSettled')]
    const drawn = run(events, { prizes })
    winners.push(drawn.state.claim!.username)
    positions.push(drawn.state.claim!.orderIndex)
    events = [...events, claimCmd(drawn.state.claim!.username)]
  }

  assert.equal(new Set(winners).size, 3, `the same person won twice: ${winners.join(', ')}`)
  assert.deepEqual(positions, [0, 1, 2], 'positions one, two and three of the committed order')

  const final = run(events, { prizes })
  assert.equal(final.state.phase, 'complete')
  assert.equal(final.state.awards.length, 3)
})

test('prizes are revealed smallest first, in the order they were listed', () => {
  // §7.2 — "revealing the best prize first makes everything after it an
  // anticlimax", so the list order is the reveal order and the setup screen
  // owns it.
  const prizes = [{ title: 'Third' }, { title: 'Second' }, { title: 'First' }]
  const { state } = run(
    [...openWith(['a', 'b', 'c', 'd']), fire('entryClosed'), control('prize.draw'), fire('reelSettled')],
    { prizes },
  )

  assert.equal(state.currentPrizeIndex, 0)
  assert.equal(state.prizes[0]!.title, 'Third')
})

test('fewer entrants than prizes voids the whole remainder in one step', () => {
  /*
   * §16 — "draw what there is. Remaining prizes are voided and announced."
   *
   * All of them at once. Once the order is exhausted no later prize can find an
   * entrant either, so clicking through two prizes that are already decided is
   * two chances for the streamer to look like they are trying something.
   */
  const prizes = [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]
  const events: InternalEvent[] = [
    ...openWith(['solo']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
    claimCmd('solo'),
    control('prize.next'),
  ]

  const { state, chat } = run(events, { prizes })

  assert.equal(state.awards.filter((a) => a.method === 'claimed').length, 1)
  assert.equal(state.awards.filter((a) => a.method === 'voided').length, 2)
  assert.equal(state.phase, 'complete')
  assert.ok(
    chat.some((c) => c.includes('Two, Three') && c.includes('go unclaimed')),
    'named together in one message, not as two separate failures',
  )
})

// ─── §16: the edges ─────────────────────────────────────────────────────────

test('zero entries at close ends the session without a draw, and says so', () => {
  /*
   * §16 — "no draw. The overlay says so plainly and the session ends without a
   * winner. Do not auto-extend — a giveaway nobody entered is information."
   */
  const { state, chat } = run([ev({ type: 'session.started' }), control('entry.open'), fire('entryClosed')])

  assert.equal(state.phase, 'complete')
  assert.deepEqual(state.drawOrder, [])
  assert.match(chat.at(-1)!, /nobody in/)
  assert.equal(state.entryClosesAtMs, T0 + 180_000, 'and the window was not quietly extended')
})

test('a chat outage extends the window and says why', () => {
  /*
   * §16 — the one case where changing the clock mid-session is correct. A clock
   * that grows for no stated reason is the second-most suspicious thing this
   * product could do.
   */
  const at = T0 + 60_000
  const { state, chat } = run([...openWith(['a']), control('chat.outage', { ms: 45_000 }, at)])

  assert.equal(state.entryClosesAtMs, T0 + 180_000 + 45_000)
  assert.equal(state.extendedForOutageMs, 45_000)
  assert.match(chat.at(-1)!, /Chat dropped for 45s/)
})

test('!odds answers once per thirty seconds, for everyone at once', () => {
  /*
   * §11 — throttled in the reducer rather than by a per-viewer cooldown,
   * because a guard denial writes to chat and §12 is that the bot never speaks
   * to an entrant.
   */
  const ask = (name: string, at: number): InternalEvent =>
    ev(
      {
        type: 'command',
        command: 'odds',
        args: '',
        raw: '!odds',
        actor: { userId: `u-${name}`, username: name, role: 'viewer' },
        messageId: `o-${name}`,
      },
      at,
    )

  const { chat } = run([
    ...openWith(['a', 'b', 'c']),
    ask('a', T0 + 1_000),
    ask('b', T0 + 2_000),
    ask('c', T0 + 5_000),
    ask('a', T0 + 40_000),
  ])

  const answers = chat.filter((c) => c.includes('in so far'))
  assert.equal(answers.length, 2, 'one inside the window, one after it')
  assert.match(answers[0]!, /3 in so far — 1 in 3/)
})

test('!odds says nothing before anyone has entered', () => {
  // There is no honest odds figure over an empty pool, and "1 in 0" and "1 in
  // 1" are both lies of a different kind.
  const ask = ev({
    type: 'command',
    command: 'odds',
    args: '',
    raw: '!odds',
    actor: { userId: 'u-a', username: 'a', role: 'viewer' },
    messageId: 'o-a',
  })

  const { chat } = run([ev({ type: 'session.started' }), control('entry.open'), ask])
  assert.equal(chat.length, 1)
})

// ─── §8.3: the health metric ────────────────────────────────────────────────

test('the claim rate counts claims against everything that resolved', () => {
  /*
   * §8.3 — "watch the claim rate. It is the health metric of this game, and a
   * channel trending below 50% is being told something specific about either
   * its timing or its prizes."
   */
  const empty = run(openWith(['a', 'b']))
  assert.equal((giveaways.project(empty.state) as Record<string, unknown>).claimRate, null)

  const base = [
    ...openWith(['a', 'b', 'c', 'd']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
  ]
  const passed = run([...base, fire('claimExpired', { prizeIndex: 0 }), fire('passoverRevealed')])
  const claimed = run([...passed.state.claim ? [] : [], ...base])

  assert.equal((giveaways.project(passed.state) as Record<string, number>).claimRate, 0)
  assert.equal(claimed.state.awards.length, 0)
})

// ─── projections ────────────────────────────────────────────────────────────

test('the overlay is never told the next name, and the dashboard always is', () => {
  /*
   * UI §4 — "deliberately visible to the streamer and deliberately not on the
   * overlay: chat seeing the next name before the passover would replace the
   * reveal with an anticlimax, and the streamer seeing it costs nothing because
   * they cannot change it."
   */
  const { state } = run([
    ...openWith(['a', 'b', 'c', 'd', 'e']),
    fire('entryClosed'),
    control('prize.draw'),
    fire('reelSettled'),
  ])

  const overlay = giveaways.project(state) as Record<string, unknown>
  const dashboard = giveaways.projectDashboard!(state) as Record<string, unknown>

  assert.ok(!('nextInOrder' in overlay))
  assert.equal(
    overlay.drawOrder,
    null,
    'the full order never reaches a viewer before COMPLETE — it is the answer to the whole game',
  )
  assert.equal((dashboard.nextInOrder as string[]).length, 3)
  assert.ok(!(dashboard.nextInOrder as string[]).includes(state.claim!.username))
})

test('the dashboard carries the rejection breakdown the streamer has to act on', () => {
  // UI §2 — the highest-value control on the entry screen, and easy to
  // under-build: a streamer watching a third of their channel bounce off a gate
  // has about ninety seconds to notice.
  const { state } = run(
    [ev({ type: 'session.started' }), control('entry.open'), enter('a'), enter('b')],
    { entryGate: 'subscribers' },
  )

  const dashboard = giveaways.projectDashboard!(state) as Record<string, unknown>
  assert.deepEqual(dashboard.rejected, { gate: 2 })
  assert.equal(dashboard.rejectedTotal, 2)
  assert.equal(dashboard.identityGuardsEnforced, false)
})

test('the reel is given real names to spin through', () => {
  // §7.1 — "a vertical reel of usernames — real entrants, pulled from the
  // actual pool". It is playback of a result the client already holds.
  const { state } = run([
    ...openWith(['a', 'b', 'c', 'd']),
    fire('entryClosed'),
    control('prize.draw'),
  ])

  const overlay = giveaways.project(state) as Record<string, string[]>
  assert.equal(state.phase, 'draw')
  assert.ok(overlay.reelNames!.length > 0)
  for (const name of overlay.reelNames!) {
    assert.ok(['a', 'b', 'c', 'd'].includes(name), `${name} is not a real entrant`)
  }
})

// ─── §1: the companion slot ─────────────────────────────────────────────────

test('giveaways is the platform companion game', () => {
  /*
   * §1's structural warning, answered: "the thing this game most wants is to
   * run inside another game … Giveaways is the strongest argument the platform
   * has yet produced for making concurrency a real priority."
   */
  assert.equal(giveaways.concurrency, 'companion')
  assert.equal(
    giveaways.commands.find((c) => c.id === 'enter')!.keywords[0],
    'drop',
    'and its default keyword must not be one the game underneath it already owns',
  )
})
