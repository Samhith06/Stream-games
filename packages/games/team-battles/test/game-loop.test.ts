/**
 * Team Battles, played through the real engine.
 *
 * The unit tests cover the arithmetic; this covers the state machine, and it
 * exists mostly for §6.2. "A veto is only available before the flip" is the one
 * rule in this game that has to hold under adversarial use — a veto available
 * after the flip is a re-roll of the team, and a streamer who vetoes a slot
 * that just landed on the team they were rooting for has rigged the session
 * whether they meant to or not. That is enforced here, not documented.
 */

import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { GameEngine, type Effect, type InternalEvent } from '@streamarena/core'
import { teamBattles } from '../dist/index.js'
import type { BattlesConfig } from '../dist/types.js'

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }

let seq = 0
beforeEach(() => {
  seq = 0
})

const ev = (partial: Omit<InternalEvent, 'seq' | 'at'> & { at?: number }): InternalEvent => {
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
    messageId: `m-${name}`,
  })

const resolvedFor = (
  name: string,
  slotId: string,
  slotName: string,
  extra: Record<string, unknown> = {},
): InternalEvent =>
  ev({
    type: 'slot.resolved',
    query: slotName,
    then: { kind: 'pool', userId: `u-${name}` },
    match: { slotId, name: slotName, provider: 'Pragmatic Play', confidence: 1, thumbnail: null, ...extra },
    suggestions: [],
  })

const sideCmd = (name: string, team: string): InternalEvent =>
  ev({
    type: 'command',
    command: 'side',
    args: team,
    raw: `!side ${team}`,
    actor: { userId: `u-${name}`, username: name, role: 'viewer' },
    messageId: `s-${name}`,
  })

const control = (action: string, payload: Record<string, unknown> = {}): InternalEvent =>
  ev({ type: 'control', action, payload, actor: OWNER })

function engine(config: Partial<BattlesConfig> = {}, seed = 'battle-seed') {
  return new GameEngine(teamBattles, {
    config: teamBattles.configSchema.parse({ maxPicks: 8, joinWindowMs: null, ...config }),
    init: { sessionId: 's-1', channelId: 'c-1', seed, startedAt: 1_000, owner: OWNER },
  })
}

function run(events: InternalEvent[], config: Partial<BattlesConfig> = {}, seed?: string) {
  const e = engine(config, seed)
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

/** n viewers, each with a distinct resolved slot. */
function poolOf(n: number): InternalEvent[] {
  const events: InternalEvent[] = []
  for (let i = 0; i < n; i++) {
    events.push(joinCmd(`p${i}`, `Slot ${i}`), resolvedFor(`p${i}`, `slot-${i}`, `Slot ${i}`))
  }
  return events
}

const result = (buyCost: number, payout: number) =>
  control('pick.result', { buyCost, payout })

// ─── §6.2: the veto rule ────────────────────────────────────────────────────

test('a veto is legal before the flip', () => {
  const { state } = run([...poolOf(4), control('pick.draw'), control('pick.veto', { reason: 'not on casino' })])

  assert.equal(state.picks.length, 1)
  assert.ok(state.picks[0]!.vetoed, 'the pick should be marked vetoed')
  assert.equal(state.currentPickIndex, null)
})

test('a veto after the flip is refused by the state machine', () => {
  // The whole point. Not a warning, not a guideline — the action does nothing.
  const { state } = run([
    ...poolOf(4),
    control('pick.draw'),
    control('flip.run'),
    control('pick.veto', { reason: 'changed my mind' }),
  ])

  assert.equal(state.picks[0]!.vetoed, null, 'the flip has run; the slot is played')
  assert.equal(state.phase, 'flip')
})

test('a veto consumes its pick index and does not shuffle the sequence', () => {
  // §6.2 — re-rolling on a veto would make every veto a re-roll of the team.
  const base = run([...poolOf(6), control('pick.draw')])
  const committed = base.state.flipSequence

  const after = run([
    ...poolOf(6),
    control('pick.draw'),
    control('pick.veto', { reason: 'x' }),
    control('pick.draw'),
  ])

  assert.deepEqual(after.state.flipSequence, committed, 'the sequence is untouched')
  assert.equal(after.state.picks.length, 2)
  assert.equal(after.state.picks[1]!.index, 1, 'the next draw takes the next index')
  assert.equal(after.state.picks[1]!.team, committed[1], 'and that index keeps its committed flip')
})

// ─── §6.1: the commitment ───────────────────────────────────────────────────

test('the team is withheld from the overlay until the flip runs', () => {
  // An overlay that knows the answer before it animates can leak it.
  const drawn = run([...poolOf(4), control('pick.draw')])
  const beforeFlip = teamBattles.project(drawn.state) as Record<string, any>
  assert.equal(beforeFlip.currentPick.team, null, 'the team must not reach the overlay early')

  const flipped = run([...poolOf(4), control('pick.draw'), control('flip.run')])
  const afterFlip = teamBattles.project(flipped.state) as Record<string, any>
  assert.ok(afterFlip.currentPick.team, 'and must be there once the animation starts')
})

test('the flip sequence is published only at COMPLETE', () => {
  // §6.1 — publishing early would let anyone read off every remaining team.
  const mid = run([...poolOf(4), control('pick.draw'), control('flip.run')])
  const during = teamBattles.project(mid.state) as Record<string, any>

  assert.equal(during.flipSequence, null, 'hidden while the session runs')
  assert.ok(during.flipSequenceHash, 'but the commitment is visible from the start')
})

test('the same seed replays to the same teams', () => {
  const events = () => [...poolOf(5), control('pick.draw'), control('flip.run')]
  const a = run(events(), {}, 'identical')
  const b = run(events(), {}, 'identical')

  assert.equal(a.state.picks[0]!.team, b.state.picks[0]!.team)
  assert.equal(a.state.flipSequenceHash, b.state.flipSequenceHash)
})

// ─── §7: sides ──────────────────────────────────────────────────────────────

test('a side declaration is permanent', () => {
  const { state, effects } = run([sideCmd('ana', 'chaos'), sideCmd('ana', 'fortune')])

  assert.equal(state.sides['u-ana']!.team, 'A', 'the first declaration stands')
  assert.ok(
    chatTexts(effects).some((t) => t.includes('already with')),
    'and the second is refused out loud',
  )
})

test('sides can be declared by team name or by key', () => {
  const { state } = run([sideCmd('ana', 'chaos'), sideCmd('ben', 'fortune'), sideCmd('cai', 'b')])

  assert.equal(state.sides['u-ana']!.team, 'A')
  assert.equal(state.sides['u-ben']!.team, 'B')
  assert.equal(state.sides['u-cai']!.team, 'B')
})

test('sides lock at the halfway pick, and joining stays open', () => {
  // §7 — nobody reads the scoreboard at pick 14 and piles onto the winner.
  // §16 — a viewer refused a side can still !join.
  const events: InternalEvent[] = [...poolOf(8)]
  for (let i = 0; i < 4; i++) {
    events.push(control('pick.draw'), control('flip.run'), result(100, 200))
  }
  events.push(sideCmd('late', 'chaos'))

  const { state, effects } = run(events, { maxPicks: 8 })

  assert.equal(state.sidesLocked, true)
  assert.equal(state.sides['u-late'], undefined)
  assert.ok(chatTexts(effects).some((t) => t.includes('!join is still open')))
  assert.equal(state.joinsOpen, true)
})

test('the coin overriding a declared side is flagged, not hidden', () => {
  // §6.4 — one of the best recurring beats in the game.
  const events = [...poolOf(4)]
  const withSides = [
    ...events,
    sideCmd('p0', 'chaos'),
    sideCmd('p1', 'chaos'),
    sideCmd('p2', 'chaos'),
    sideCmd('p3', 'chaos'),
    control('pick.draw'),
    control('flip.run'),
  ]

  const { state } = run(withSides)
  const pick = state.picks[0]!
  const projected = teamBattles.project(state) as Record<string, any>

  assert.equal(pick.declaredSide, 'A', 'the declaration is kept on the record')
  assert.equal(
    projected.currentPick.allegianceOverridden,
    pick.team !== 'A',
    'and the override is reported exactly when it happened',
  )
})

// ─── autoSideOnJoin ─────────────────────────────────────────────────────────

test('off by default, joining leaves you with no side', () => {
  // §7 — nobody is auto-assigned unless the streamer asks for it.
  const { state } = run([...poolOf(3)])
  assert.equal(Object.keys(state.sides).length, 0)
})

test('on, a confirmed entrant is put on a side', () => {
  const { state } = run([...poolOf(4)], { autoSideOnJoin: true })

  assert.equal(Object.keys(state.sides).length, 4, 'everyone who joined has a side')
  assert.ok(Object.values(state.sides).every((s) => s.auto), 'and it is marked as assigned')
})

test('an assigned side never overrides one the viewer chose', () => {
  const { state } = run(
    [sideCmd('p0', 'fortune'), ...poolOf(2)],
    { autoSideOnJoin: true },
  )

  assert.equal(state.sides['u-p0']!.team, 'B', 'their own pick stands')
  assert.equal(state.sides['u-p0']!.auto, false, 'and stays marked as chosen')
})

test('a join whose slot never resolves gets no side', () => {
  // Their entry is dropped from the pool, so an allegiance to a session they
  // are not in would be a lie on the crowd bar.
  const { state } = run(
    [
      joinCmd('ghost', 'not a real slot'),
      ev({
        type: 'slot.resolved',
        query: 'not a real slot',
        then: { kind: 'pool', userId: 'u-ghost' },
        match: null,
        suggestions: [],
      }),
    ],
    { autoSideOnJoin: true },
  )

  assert.equal(state.sides['u-ghost'], undefined)
})

test('assignment is seeded, so a replay produces the same crowd', () => {
  const a = run([...poolOf(6)], { autoSideOnJoin: true }, 'same-seed')
  const b = run([...poolOf(6)], { autoSideOnJoin: true }, 'same-seed')

  assert.deepEqual(
    Object.entries(a.state.sides).map(([id, s]) => [id, s.team]),
    Object.entries(b.state.sides).map(([id, s]) => [id, s.team]),
  )
})

test('an assigned side never fires the coin-betrayal callout', () => {
  /*
   * §6.4 is the point of this whole flag being tracked. The callout is only a
   * betrayal if they picked a side; if everyone were auto-assigned it would
   * fire on roughly half of all picks and stop meaning anything.
   */
  const { state } = run([...poolOf(4), control('pick.draw'), control('flip.run')], {
    autoSideOnJoin: true,
  })

  const pick = state.picks[0]!
  assert.ok(state.sides[pick.userId]?.auto, 'the fixture should have assigned them a side')
  assert.equal(pick.declaredSide, null, 'which must not read as a prediction')

  const projected = teamBattles.project(state) as Record<string, any>
  assert.equal(projected.currentPick.allegianceOverridden, false)
})

test('a chosen side still fires it when the coin disagrees', () => {
  // The other half: turning the flag on must not mute genuine declarations.
  const events = [...poolOf(4)]
  for (const n of ['p0', 'p1', 'p2', 'p3']) events.push(sideCmd(n, 'chaos'))
  events.push(control('pick.draw'), control('flip.run'))

  const { state } = run(events, { autoSideOnJoin: true })
  const pick = state.picks[0]!

  assert.equal(pick.declaredSide, 'A', 'their own call is on the record')
  const projected = teamBattles.project(state) as Record<string, any>
  assert.equal(projected.currentPick.allegianceOverridden, pick.team !== 'A')
})

test('nobody is assigned once sides have locked', () => {
  const events: InternalEvent[] = [...poolOf(8)]
  for (let i = 0; i < 4; i++) {
    events.push(control('pick.draw'), control('flip.run'), result(100, 200))
  }
  // A genuinely new viewer, arriving after the lock.
  events.push(joinCmd('latecomer', 'Late Slot'), resolvedFor('latecomer', 'late', 'Late Slot'))

  const { state } = run(events, { autoSideOnJoin: true, maxPicks: 8 })

  assert.equal(state.sidesLocked, true)
  assert.equal(state.sides['u-latecomer'], undefined, 'the crowd is closed by then')
})

test('an assigned side can still be replaced by a real choice', () => {
  /*
   * The point of the auto flag cutting both ways. Being put on a team must not
   * lock someone out of picking one — that would take the choice away from
   * exactly the viewers who bothered to enter.
   */
  const { state, effects } = run([...poolOf(2), sideCmd('p0', 'fortune')], {
    autoSideOnJoin: true,
  })

  assert.equal(state.sides['u-p0']!.team, 'B', 'their own call wins')
  assert.equal(state.sides['u-p0']!.auto, false, 'and counts as chosen from then on')
  assert.ok(
    !chatTexts(effects).some((t) => t.includes('already with')),
    'and they are not told off for it',
  )

  // But a second change is still refused — §7's actual rule.
  const twice = run([...poolOf(2), sideCmd('p0', 'fortune'), sideCmd('p0', 'chaos')], {
    autoSideOnJoin: true,
  })
  assert.equal(twice.state.sides['u-p0']!.team, 'B')
  assert.ok(chatTexts(twice.effects).some((t) => t.includes('already with')))
})

test('with sideGate nobody, a declaration is refused even if it reaches the game', () => {
  /*
   * The router switches !side off, so this should never arrive. Asserted at the
   * reducer anyway: the log is what gets replayed, and a config edited between
   * a session's start and a later replay must not let one in the back door.
   */
  const { state } = run([...poolOf(2), sideCmd('p0', 'fortune')], {
    sideGate: 'nobody',
    autoSideOnJoin: true,
  })

  assert.ok(state.sides['u-p0']?.auto, 'they keep the side they were assigned')
  assert.equal(state.sides['u-p0']!.team !== undefined, true)
})

test('everyone still lands on a team with picking switched off', () => {
  const { state } = run([...poolOf(6)], { sideGate: 'nobody', autoSideOnJoin: true })

  assert.equal(Object.keys(state.sides).length, 6)
  assert.ok(Object.values(state.sides).every((s) => s.auto))

  const projected = teamBattles.project(state) as Record<string, any>
  assert.equal(projected.crowdA + projected.crowdB, 6, 'and the crowd bar has something to show')
})

// ─── §8.1 / §16: results ────────────────────────────────────────────────────

test('the multiplier is computed from the two numbers entered', () => {
  const { state } = run([...poolOf(4), control('pick.draw'), control('flip.run'), result(200, 500)])

  assert.equal(state.picks[0]!.multiplier, 2.5)
  assert.equal(state.picks[0]!.buyCostCents, 20_000)
})

test('a zero buy cost is refused; a zero payout is a real result', () => {
  const zeroCost = run([...poolOf(4), control('pick.draw'), control('flip.run'), result(0, 500)])
  assert.equal(zeroCost.state.picks[0]!.multiplier, null, 'a zero buy cost cannot produce a multiplier')

  const zeroPayout = run([...poolOf(4), control('pick.draw'), control('flip.run'), result(200, 0)])
  assert.equal(zeroPayout.state.picks[0]!.multiplier, 0, 'a dead bonus banks 0.00x')
})

test('a revert clears the numbers but never re-rolls the flip', () => {
  // §16 — same person, same team, corrected numbers.
  const played = run([...poolOf(4), control('pick.draw'), control('flip.run'), result(200, 500)])
  const team = played.state.picks[0]!.team

  const reverted = run([
    ...poolOf(4),
    control('pick.draw'),
    control('flip.run'),
    result(200, 500),
    control('pick.revert'),
  ])

  const pick = reverted.state.picks[0]!
  assert.equal(pick.multiplier, null)
  assert.equal(pick.team, team, 'the team survives the correction')
  assert.deepEqual(pick.revertedFrom, { buyCostCents: 20_000, payoutCents: 50_000 })
})

// ─── §10: curation at join time ─────────────────────────────────────────────

test('a buy outside the bounds is rejected in front of the viewer', () => {
  const { state, effects } = run(
    [joinCmd('ana', 'Sweet Alchemy'), resolvedFor('ana', 'sa', 'Sweet Alchemy', { buyCostX: 75 })],
    { minBuyX: 100, maxBuyX: 400 },
  )

  assert.equal(state.pool.length, 0, 'and removed from the pool')
  assert.ok(
    chatTexts(effects).some((t) => t.includes('75x') && t.includes('100x–400x')),
    'the rejection names the actual numbers',
  )
})

test('an unknown buy cost is allowed by default and refused when strict', () => {
  // The catalog is thin; refusing unknowns by default would reject nearly
  // every !join and read as the game being broken.
  const lenient = run([joinCmd('ana', 'Mystery'), resolvedFor('ana', 'm', 'Mystery')])
  assert.equal(lenient.state.pool.length, 1)

  const strict = run([joinCmd('ana', 'Mystery'), resolvedFor('ana', 'm', 'Mystery')], {
    allowUnknownBuyCost: false,
  })
  assert.equal(strict.state.pool.length, 0)
})

test('a slot known to have no buy is refused; an unknown one is not', () => {
  const noBuy = run([joinCmd('ana', 'Flat'), resolvedFor('ana', 'f', 'Flat', { hasBonusBuy: false })])
  assert.equal(noBuy.state.pool.length, 0)

  const unknown = run([joinCmd('ben', 'Maybe'), resolvedFor('ben', 'mb', 'Maybe', { hasBonusBuy: null })])
  assert.equal(unknown.state.pool.length, 1, 'null is unknown, not false')
})

test('a blocked provider is refused', () => {
  const { state } = run(
    [joinCmd('ana', 'Some Slot'), resolvedFor('ana', 's', 'Some Slot')],
    { blockedProviders: ['Pragmatic Play'] },
  )
  assert.equal(state.pool.length, 0)
})

test('a duplicate slot is rejected in chat, not silently dropped', () => {
  const { state, effects } = run([
    joinCmd('ana', 'Gates'),
    resolvedFor('ana', 'gates', 'Gates of Olympus'),
    joinCmd('ben', 'Gates'),
    resolvedFor('ben', 'gates', 'Gates of Olympus'),
  ])

  assert.equal(state.pool.length, 1)
  assert.ok(chatTexts(effects).some((t) => t.includes('already claimed by @ana')))
})

// ─── §5 / §16: the pool ─────────────────────────────────────────────────────

test('one pick per viewer — a drawn entrant cannot rejoin', () => {
  const { state, effects } = run([
    ...poolOf(2),
    control('pick.draw'),
    control('flip.run'),
    result(100, 200),
    joinCmd('p0', 'Another Slot'),
    joinCmd('p1', 'Another Slot'),
  ])

  const drawn = state.picks[0]!.username
  assert.ok(
    chatTexts(effects).some((t) => t.includes(`@${drawn}`) && t.includes('already had your pick')),
    'the drawn viewer is turned away by name',
  )
})

test('an empty pool pauses draws instead of ending the session', () => {
  // §16 — precisely why joins never close.
  const { state } = run([control('pick.draw')])

  assert.equal(state.picks.length, 0)
  assert.equal(state.phase, 'pick')
  assert.equal((teamBattles.project(state) as Record<string, any>).waitingForEntries, true)
})

test('a reserved pick is drawn first and badged', () => {
  // §5 — a visible advantage reads as generosity, a hidden one as rigging.
  const { state } = run([
    ...poolOf(6),
    control('reserve.add', { userId: 'u-p4' }),
    control('pick.draw'),
  ])

  assert.equal(state.picks[0]!.userId, 'u-p4')
  assert.equal(state.picks[0]!.source, 'reserved')
})

test('a reserved pick never touches the flip', () => {
  /*
   * §5 — nobody, including the streamer, chooses a team.
   *
   * Asserted against the committed sequence rather than by comparing two draws:
   * the random draw can legitimately land on the reserved viewer anyway, and a
   * test that depends on it not doing so fails on an unlucky seed while telling
   * you nothing about the rule.
   */
  for (const reserve of ['u-p1', 'u-p3', 'u-p5']) {
    const drawn = run([...poolOf(6), control('reserve.add', { userId: reserve }), control('pick.draw')])
    const pick = drawn.state.picks[0]!

    assert.equal(pick.userId, reserve, 'the reserved viewer is the one drawn')
    assert.equal(pick.source, 'reserved')
    assert.equal(
      pick.team,
      drawn.state.flipSequence[0],
      'and pick 0 keeps the flip committed to index 0, whoever fills it',
    )
  }
})

// ─── §9: ending ─────────────────────────────────────────────────────────────

/** Plays a full session to its declared count. */
function playOut(picks: number, payouts: number[], config: Partial<BattlesConfig> = {}) {
  const events: InternalEvent[] = [...poolOf(picks + 4)]
  for (let i = 0; i < picks; i++) {
    events.push(control('pick.draw'), control('flip.run'), result(100, payouts[i] ?? 200))
  }
  return run(events, { maxPicks: picks, ...config })
}

test('reaching the declared count moves to FINAL, not COMPLETE', () => {
  // §9.1 — the streamer stops, but only the rule finishes the session.
  const { state } = playOut(8, [500, 100, 900, 0, 300, 250, 150, 400], { maxSuddenDeath: 0 })
  assert.equal(state.phase, 'final')
  assert.equal(state.result, null, 'no winner until the session is ended')
})

test('ending before the count is reached does nothing', () => {
  const { state } = run([...poolOf(6), control('pick.draw'), control('flip.run'), result(100, 200), control('battle.end')])
  assert.notEqual(state.phase, 'complete')
  assert.equal(state.result, null)
})

test('a finished session names a winner, an MVP and how it was decided', () => {
  const played = playOut(8, [500, 100, 900, 0, 300, 250, 150, 400], { maxSuddenDeath: 0 })
  const { state, effects } = (() => {
    const folded = played.engine.apply(played.state, control('battle.end'))
    return { state: folded.state, effects: folded.effects }
  })()

  assert.equal(state.phase, 'complete')
  assert.ok(state.result, 'a result is recorded')
  assert.ok(state.result!.decidedBy, 'and says which rung decided it')
  assert.ok(state.result!.mvp, 'the MVP is always named')
  assert.equal(state.flipSequenceRevealed, true, '§6.1 — the commitment becomes checkable')

  const texts = chatTexts(effects)
  assert.ok(texts.some((t) => t.includes('WIN')), 'the winner reaches chat')
  assert.ok(texts.some((t) => t.includes('MVP')), 'and so does the MVP, separately')
})

test('abandoning saves incomplete and announces no winner', () => {
  const { state, effects } = run([
    ...poolOf(4),
    control('pick.draw'),
    control('flip.run'),
    result(100, 500),
    control('battle.abandon'),
  ])

  assert.equal(state.phase, 'complete')
  assert.equal(state.result, null, 'no winner, no rewards')
  assert.ok(!chatTexts(effects).some((t) => t.includes('WIN')))
  assert.ok(effects.some((e) => e.kind === 'end' && e.reason === 'abandoned'))
})

test('a tied session runs sudden death, bounded', () => {
  // Force a dead heat: every pick pays the same, so both averages match.
  const { state } = playOut(8, Array(8).fill(200), { maxSuddenDeath: 2 })

  assert.equal(state.phase, 'pick', 'sudden death re-opens the draw')
  assert.equal(state.suddenDeathPicks, 1)
})

// ─── §11 / §12: chat discipline ─────────────────────────────────────────────

test('per-pick results never reach chat', () => {
  // §12 — fifteen picks x three events each is straight into the quota wall.
  const { effects } = run([...poolOf(4), control('pick.draw'), control('flip.run'), result(100, 5_000)])

  const texts = chatTexts(effects)
  assert.ok(!texts.some((t) => t.includes('50.00x')), 'the overlay is where results live')
})

test('!teams is throttled to one reply per window', () => {
  const ask = (name: string, at: number): InternalEvent =>
    ev({
      type: 'command',
      command: 'teams',
      args: '',
      raw: '!teams',
      at,
      actor: { userId: `u-${name}`, username: name, role: 'viewer' },
      messageId: `t-${name}`,
    })

  const { effects } = run([ask('a', 10_000), ask('b', 11_000), ask('c', 12_000)])
  const replies = effects.filter((e) => e.kind === 'chat' && e.priority === 'reply')
  assert.equal(replies.length, 1, 'the answer is already on screen')
})

test('the session opens with the flip commitment posted once', () => {
  const e = engine({ publishFlipHash: true })
  const folded = e.apply(e.initialState(), ev({ type: 'session.started', actor: OWNER }))

  const texts = chatTexts(folded.effects)
  assert.equal(texts.length, 1)
  assert.ok(texts[0]!.includes('Flip sequence committed:'))
})
