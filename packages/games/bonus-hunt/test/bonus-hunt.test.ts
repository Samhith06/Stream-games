/**
 * §9 — "Testable without Kick. Feed an array of events, assert on final state.
 * The entire game test suite runs in milliseconds with no network, no database,
 * no OAuth. You can simulate a 500-viewer spam storm in a unit test."
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { GameEngine, type Effect, type InternalEvent } from '@streamarena/core'
import { bonusHunt } from '../dist/index.js'
import type { BonusHuntConfig, BonusHuntState } from '../dist/types.js'

const CONFIG: BonusHuntConfig = bonusHunt.configSchema.parse({ startBalance: 5000, targetBonuses: 3 })

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }

function engine(config: Partial<BonusHuntConfig> = {}) {
  return new GameEngine(bonusHunt, {
    config: { ...CONFIG, ...config },
    init: {
      sessionId: 'sess-1',
      channelId: 'chan-1',
      seed: 'deadbeef',
      startedAt: 1_000,
      owner: OWNER,
    },
  })
}

// Entry ids derive from the event sequence (§9 — no Math.random), so each test
// starts from a clean sequence to keep the ids in its script predictable.
let seq = 0
beforeEach(() => {
  seq = 0
})

function ev(partial: Omit<InternalEvent, 'seq' | 'at'> & { at?: number }): InternalEvent {
  seq += 1
  return { ...partial, seq, at: partial.at ?? 1_000 + seq } as InternalEvent
}

function viewer(name: string) {
  return { userId: `u-${name}`, username: name, role: 'viewer' as const }
}

function sr(name: string, slot: string): InternalEvent {
  return ev({
    type: 'command',
    command: 'sr',
    args: slot,
    raw: `!sr ${slot}`,
    actor: viewer(name),
    messageId: `m-${name}-${slot}`,
  })
}

function editsr(name: string, slot: string): InternalEvent {
  return ev({
    type: 'command',
    command: 'editsr',
    args: slot,
    raw: `!editsr ${slot}`,
    actor: viewer(name),
    messageId: `e-${name}-${slot}`,
  })
}

function guess(name: string, amount: string): InternalEvent {
  return ev({
    type: 'command',
    command: 'guess',
    args: amount,
    raw: `!guess ${amount}`,
    actor: viewer(name),
    messageId: `g-${name}-${amount}`,
  })
}

function control(action: string, payload: Record<string, unknown> = {}): InternalEvent {
  return ev({ type: 'control', action, payload, actor: OWNER })
}

function resolved(entryId: string, slotId: string, name: string): InternalEvent {
  return ev({
    type: 'slot.resolved',
    query: name,
    then: { kind: 'entry', entryId },
    match: { slotId, name, provider: 'Pragmatic Play', confidence: 1 },
    suggestions: [],
  })
}

/** Folds a script of events and returns the final state plus every effect. */
function run(events: InternalEvent[], config: Partial<BonusHuntConfig> = {}) {
  const e = engine(config)
  let state = e.initialState()
  const effects: Effect[] = []
  for (const event of events) {
    const folded = e.apply(state, event)
    state = folded.state
    effects.push(...folded.effects)
  }
  return { state, effects, engine: e }
}

const chatTexts = (effects: Effect[]) =>
  effects.filter((e): e is Extract<Effect, { kind: 'chat' }> => e.kind === 'chat').map((e) => e.text)

const announcements = (effects: Effect[]) =>
  effects.filter((e) => e.kind === 'chat' && e.priority === 'announce') as Extract<
    Effect,
    { kind: 'chat' }
  >[]

test('!sr creates a pending entry and asks the catalog to resolve it', () => {
  const { state, effects } = run([sr('alice', 'gates')])

  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0]!.status, 'pending')
  assert.equal(state.entries[0]!.slotId, null)
  assert.equal(state.entries[0]!.rawText, 'gates')

  const lookups = effects.filter((e) => e.kind === 'lookup')
  assert.equal(lookups.length, 1)
  assert.deepEqual((lookups[0] as { query: string }).query, 'gates')
})

test('a resolved lookup firms the entry up without a chat write', () => {
  const first = sr('alice', 'gates')
  const { state, effects } = run([first, resolved('e1', 'slot-1', 'Gates of Olympus')])

  // Matched, not banked — the streamer still has to play it and trigger a bonus.
  assert.equal(state.entries[0]!.status, 'queued')
  assert.equal(state.entries[0]!.slotName, 'Gates of Olympus')
  assert.deepEqual(chatTexts(effects), [])
})

test('an unresolved name reaches chat with the top suggestion (§15.1)', () => {
  const { state, effects } = run([
    sr('alice', 'gatez'),
    ev({
      type: 'slot.resolved',
      query: 'gatez',
      then: { kind: 'entry', entryId: 'e1' },
      match: null,
      suggestions: [
        { slotId: 'slot-1', name: 'Gates of Olympus', provider: 'Pragmatic Play', confidence: 0.6 },
      ],
    }),
  ])

  assert.equal(state.entries[0]!.status, 'pending')
  assert.equal(state.entries[0]!.suggestions.length, 1)
  assert.match(chatTexts(effects)[0]!, /did you mean Gates of Olympus/)
})

test('one outstanding request per viewer by default — the second !sr is rejected', () => {
  const { state, effects } = run([sr('alice', 'gates'), sr('alice', 'sugar rush')])

  assert.equal(state.entries.length, 1)
  assert.match(chatTexts(effects).at(-1)!, /still waiting to be played/)
})

test('!editsr swaps the slot in place rather than adding a second entry', () => {
  const { state, effects } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    editsr('alice', 'le bandit'),
  ])

  assert.equal(state.entries.length, 1)
  // Back to pending while the catalog re-resolves — same two-pass shape as !sr.
  assert.equal(state.entries[0]!.status, 'pending')
  assert.equal(state.entries[0]!.rawText, 'le bandit')
  assert.equal(state.entries[0]!.id, 'e1', 'keeps its id, so order and bet survive')

  const lookups = effects.filter((e) => e.kind === 'lookup')
  assert.equal(lookups.length, 2, 'the swap triggers a fresh lookup')
})

test('!editsr keeps the bet the streamer already set', () => {
  const { state } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('entry.setBet', { entryId: 'e1', bet: 250 }),
    editsr('alice', 'le bandit'),
    ev({
      type: 'slot.resolved',
      query: 'le bandit',
      then: { kind: 'entry', entryId: 'e1' },
      match: { slotId: 'slot-9', name: 'Le Bandit', provider: 'Hacksaw', thumbnail: null, confidence: 1 },
      suggestions: [],
    }),
  ])

  assert.equal(state.entries[0]!.slotName, 'Le Bandit')
  assert.equal(state.entries[0]!.bet, 250)
})

test('!editsr from someone with no entry tells them to use !sr', () => {
  const { effects } = run([editsr('nobody', 'le bandit')])
  assert.match(chatTexts(effects).at(-1)!, /haven't picked a slot yet/)
})

test('!editsr is refused once the list is locked', () => {
  const { state, effects } = run([
    sr('alice', 'gates'),
    control('collection.close', { balanceNow: 4900 }),
    editsr('alice', 'le bandit'),
  ])

  assert.equal(state.entries[0]!.rawText, 'gates', 'the original slot stands')
  assert.match(chatTexts(effects).at(-1)!, /list is locked/)
})

test('!editsr cannot rewrite a bonus that was already opened', () => {
  const { state, effects } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('entry.setBet', { entryId: 'e1', bet: 100 }),
    control('entry.setWin', { entryId: 'e1', win: 500 }),
    editsr('alice', 'le bandit'),
  ])

  assert.equal(state.entries[0]!.slotName, 'Gates of Olympus')
  assert.match(chatTexts(effects).at(-1)!, /already been opened/)
})

test('the one-entry rejection points at !editsr', () => {
  const { effects } = run([sr('alice', 'gates'), sr('alice', 'sugar rush')])
  assert.match(chatTexts(effects).at(-1)!, /!editsr/)
})

// ─── the entry cap, both ways (§13) ─────────────────────────────────────────

test('by default a viewer may request again once their slot is banked', () => {
  const { state } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('entry.markCollected', { entryId: 'e1' }),
    sr('alice', 'sugar rush'),
  ])

  // Small channels cannot fill a hunt on one suggestion each, so the default
  // cap is "one outstanding", not "one ever".
  assert.equal(state.entries.length, 2)
  assert.equal(state.entries[1]!.rawText, 'sugar rush')
})

test('by default a viewer is blocked while their slot is still waiting', () => {
  const { state, effects } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    sr('alice', 'sugar rush'),
  ])

  assert.equal(state.entries.length, 1)
  assert.match(chatTexts(effects).at(-1)!, /still waiting to be played/)
})

test('dropping a slot the streamer could not bank frees the viewer', () => {
  const { state } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    // Played it, no bonus — the streamer drops it.
    control('entry.remove', { entryId: 'e1' }),
    sr('alice', 'sugar rush'),
  ])

  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0]!.rawText, 'sugar rush')
})

test('with the toggle on, one slot each is a lifetime cap', () => {
  const { state, effects } = run(
    [
      sr('alice', 'gates'),
      resolved('e1', 'slot-1', 'Gates of Olympus'),
      control('entry.markCollected', { entryId: 'e1' }),
      sr('alice', 'sugar rush'),
    ],
    { oneEntryPerViewer: true },
  )

  assert.equal(state.entries.length, 1)
  assert.match(chatTexts(effects).at(-1)!, /already in — one slot each/)
})

test('the outstanding cap counts unresolved requests too', () => {
  // A name the catalog could not match still occupies the viewer's slot —
  // otherwise a typo would let them queue endlessly.
  const { state, effects } = run([
    sr('alice', 'gatez typo'),
    ev({
      type: 'slot.resolved',
      query: 'gatez typo',
      then: { kind: 'entry', entryId: 'e1' },
      match: null,
      suggestions: [],
    }),
    sr('alice', 'sugar rush'),
  ])

  assert.equal(state.entries.length, 1)
  assert.match(chatTexts(effects).at(-1)!, /still waiting/)
})

test('only banked bonuses count toward the target and break-even', () => {
  const { state } = run([
    sr('alice', 'gates'),
    sr('bob', 'sugar'),
    sr('carol', 'mental'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    resolved('e2', 'slot-2', 'Sugar Rush'),
    resolved('e3', 'slot-3', 'Mental'),
    // Only two of the three actually produced a bonus.
    control('entry.markCollected', { entryId: 'e1', bet: 100 }),
    control('entry.markCollected', { entryId: 'e2', bet: 100 }),
    control('collection.close', { balanceNow: 4600 }),
  ])

  const projected = bonusHunt.project(state) as Record<string, number>
  assert.equal(projected.collectedCount, 2, 'two banked')
  assert.equal(projected.suggestionCount, 3, 'three suggested')
  // 400 spent over the two bonuses that will actually be opened.
  assert.equal(projected.breakEvenPerBonus, 200)
})

test('uncollecting puts a bonus back in the queue', () => {
  const { state } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('entry.markCollected', { entryId: 'e1' }),
    control('entry.uncollect', { entryId: 'e1' }),
  ])
  assert.equal(state.entries[0]!.status, 'queued')
})

test('a 500-viewer spam storm produces 500 entries and no chat flood', () => {
  const events: InternalEvent[] = []
  for (let i = 0; i < 500; i++) events.push(sr(`viewer${i}`, 'gates'))
  // Every one of them also spams a duplicate.
  for (let i = 0; i < 500; i++) events.push(sr(`viewer${i}`, 'gates'))

  const started = performance.now()
  const { state, effects } = run(events, { maxEntriesPerViewer: 1 })
  const elapsed = performance.now() - started

  assert.equal(state.entries.length, 500)
  // The duplicates are the only thing that speaks, and each speaks once.
  assert.equal(chatTexts(effects).length, 500)
  assert.ok(elapsed < 2000, `reducer took ${elapsed}ms`)
})

test('guesses are rejected during collection and accepted during guessing', () => {
  const beforeClose = run([guess('bob', '6000')])
  assert.match(chatTexts(beforeClose.effects)[0]!, /guessing opens/)
  assert.equal(beforeClose.state.guesses.length, 0)

  const { state } = run([
    sr('alice', 'gates'),
    control('collection.close', { balanceNow: 3000 }),
    guess('bob', '6000'),
  ])
  assert.equal(state.guesses.length, 1)
  assert.equal(state.guesses[0]!.amount, 6000)
})

test('closing collection captures spent once and opens a timed window (§13)', () => {
  const { state, effects } = run([
    sr('alice', 'gates'),
    sr('bob', 'sugar'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    resolved('e2', 'slot-2', 'Sugar Rush'),
    control('entry.markCollected', { entryId: 'e1' }),
    control('entry.markCollected', { entryId: 'e2' }),
    control('collection.close', { balanceNow: 3200 }),
  ])

  assert.equal(state.phase, 'guessing')
  assert.equal(state.totals.spent, 1800)
  assert.equal(state.balanceAtCloseOfCollection, 3200)

  const timers = effects.filter((e) => e.kind === 'timer')
  assert.equal(timers.length, 1)
  assert.equal((timers[0] as { inMs: number }).inMs, 180_000)

  // Break-even is the emotional centre of the game, so it goes in the call to
  // action: 1800 spent over 2 bonuses = 900 each.
  assert.match(announcements(effects)[0]!.text, /break-even is €900/)
})

test('k/K guesses expand and absurd guesses hit the sanity ceiling (§13)', () => {
  const { state, effects } = run([
    control('collection.close', { balanceNow: 0 }),
    guess('bob', '6.5k'),
    guess('troll', '999999999'),
  ])

  assert.equal(state.guesses.length, 1)
  assert.equal(state.guesses[0]!.amount, 6500)
  assert.match(chatTexts(effects).at(-1)!, /couldn't read that guess/)
})

test('a second guess silently replaces the first (§13 edge cases)', () => {
  const { state, effects } = run([
    control('collection.close', { balanceNow: 0 }),
    guess('bob', '6000'),
    guess('bob', '7000'),
  ])

  assert.equal(state.guesses.length, 1)
  assert.equal(state.guesses[0]!.amount, 7000)
  // Silently: the overlay already shows it.
  assert.deepEqual(chatTexts(effects).filter((t) => t.includes('bob')), [])
})

test('the guess window timer locks guesses and moves to opening', () => {
  const { state } = run([
    control('collection.close', { balanceNow: 3000 }),
    guess('bob', '6000'),
    ev({ type: 'timer', payload: { kind: 'guessWindowEnd' }, timerId: 'guess-window' }),
    guess('late', '6100'),
  ])

  assert.equal(state.phase, 'opening')
  assert.equal(state.guessesLocked, true)
  assert.equal(state.guesses.length, 1)
})

test('closest guess wins, ties go to the earliest submission (§13)', () => {
  const { state, effects } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('entry.markCollected', { entryId: 'e1', bet: 100 }),
    control('collection.close', { balanceNow: 4900 }),
    // Equidistant either side of the eventual 5300 final balance.
    guess('early', '5250'),
    guess('later', '5350'),
    control('guesses.lock'),
    control('entry.setWin', { entryId: 'e1', win: 400 }),
  ])

  assert.equal(state.phase, 'complete')
  assert.equal(state.finalBalance, 5300)
  assert.equal(state.winner?.username, 'early')
  assert.equal(state.winner?.difference, 50)

  // §15.4 — always two messages, not one.
  const announced = announcements(effects)
  assert.equal(announced.length, 3) // window opened, hunt result, guess winner
  assert.match(announced[1]!.text, /Hunt complete! €5,000 → €5,300 \(\+€300\)/)
  assert.match(announced[2]!.text, /@early wins Guess the Balance/)
  // Announcements are held behind the stream delay so they don't spoil the
  // overlay reveal (§15.3).
  assert.ok(announced.every((a) => a.holdForStreamDelay === true))
})

test('nobody guessed — the winner announcement is skipped, not empty (§13)', () => {
  const { state, effects } = run([
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('entry.markCollected', { entryId: 'e1', bet: 100 }),
    control('collection.close', { balanceNow: 4900 }),
    control('guesses.lock'),
    control('entry.setWin', { entryId: 'e1', win: 0 }),
  ])

  assert.equal(state.winner, null)
  const announced = announcements(effects).map((a) => a.text)
  assert.equal(announced.filter((t) => t.includes('Guess the Balance!')).length, 0)
})

test('a mistyped win is editable and the total follows it', () => {
  const { state } = run([
    sr('alice', 'gates'),
    sr('bob', 'sugar'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    resolved('e2', 'slot-2', 'Sugar Rush'),
    control('collection.close', { balanceNow: 4000 }),
    control('guesses.lock'),
    control('entry.setWin', { entryId: 'e1', win: 5000 }), // fat finger
    control('entry.setWin', { entryId: 'e1', win: 500 }),
  ])

  assert.equal(state.totals.won, 500)
  assert.equal(state.phase, 'opening') // e2 still unopened, so not complete
})

test('removing an entry after lock is allowed and guesses stand (§13)', () => {
  const { state } = run([
    sr('alice', 'gates'),
    sr('bob', 'sugar'),
    control('collection.close', { balanceNow: 4000 }),
    guess('carol', '5000'),
    control('guesses.lock'),
    control('entry.remove', { entryId: 'e2' }),
  ])

  assert.equal(state.entries.length, 1)
  assert.equal(state.guesses.length, 1)
})

test('!hunt is rate limited to one reply per 60s per channel (§13)', () => {
  const status = (name: string, at: number) =>
    ev({
      type: 'command',
      command: 'hunt',
      args: '',
      raw: '!hunt',
      actor: viewer(name),
      messageId: `h-${name}-${at}`,
      at,
    })

  const { effects } = run([status('a', 10_000), status('b', 20_000), status('c', 80_000)])
  assert.equal(chatTexts(effects).length, 2)
})

test('replay from the log reproduces the same state and the same winner (§9)', () => {
  const script = [
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('entry.markCollected', { entryId: 'e1', bet: 100 }),
    control('collection.close', { balanceNow: 4900 }),
    guess('bob', '5200'),
    guess('carol', '5400'),
    control('guesses.lock'),
    control('entry.setWin', { entryId: 'e1', win: 400 }),
  ]

  const live = run(script)
  const replayed = engine().replay(script)

  assert.deepEqual(replayed.state, live.state)
  assert.equal((replayed.state as BonusHuntState).winner?.username, 'bob')
})

test('replay resumes from a snapshot, skipping events already folded in', () => {
  const script = [
    sr('alice', 'gates'),
    resolved('e1', 'slot-1', 'Gates of Olympus'),
    control('collection.close', { balanceNow: 4900 }),
    guess('bob', '5200'),
  ]

  const e = engine()
  let state = e.initialState()
  for (const event of script.slice(0, 2)) state = e.apply(state, event).state
  const snapshotSeq = script[1]!.seq

  const resumed = e.replay(script, { state, seq: snapshotSeq, stateVersion: bonusHunt.stateVersion })
  const fromScratch = engine().replay(script)

  assert.deepEqual(resumed.state, fromScratch.state)
})

test('the overlay projection never leaks user ids or catalog plumbing (§19)', () => {
  const { state } = run([sr('alice', 'gatez')])
  const projected = JSON.stringify(bonusHunt.project(state))

  assert.ok(!projected.includes('u-alice'))
  assert.ok(!projected.includes('suggestions'))
  // The dashboard does get the unresolved queue — that's its whole job (§20).
  const dash = JSON.stringify(bonusHunt.projectDashboard!(state))
  assert.ok(dash.includes('unresolved'))
})
