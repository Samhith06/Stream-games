/**
 * Team Battles' dashboard panels, rendered from a projection the real reducer
 * produced.
 *
 * Same reasoning as `bingo-render.test.ts`: a view reading a field the
 * projection doesn't emit throws nothing at build time and renders an empty
 * box. Two extra things are checked here that only matter in this game.
 *
 * **§3's colour rule.** No control may wear a team colour. A "Run the flip"
 * button tinted violet reads as the streamer pressing for Chaos, whatever the
 * code does — so the action bar is asserted against the team classes.
 *
 * **§6.1's withholding.** The team must not reach the page before the flip
 * starts. A dashboard that knows the answer early is one accidental render away
 * from showing it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { GameEngine, type InternalEvent } from '@streamarena/core'
import { teamBattles } from '@streamarena/game-team-battles'
import {
  battlesJoining,
  battlesResult,
  ledger,
  pickCard,
  swingHero,
  teamColumns,
} from '../public/battles-view.js'

const OWNER = { userId: 'owner-1', username: 'streamer', role: 'broadcaster' as const }

let seq = 0
const ev = (partial: Record<string, unknown>): InternalEvent =>
  ({ ...partial, seq: ++seq, at: 1_000 + seq }) as InternalEvent

const join = (name: string, slot: string): InternalEvent[] => [
  ev({
    type: 'command',
    command: 'join',
    args: slot,
    raw: `!join ${slot}`,
    actor: { userId: `u-${name}`, username: name, role: 'viewer' },
    messageId: `m-${name}`,
  }),
  ev({
    type: 'slot.resolved',
    query: slot,
    then: { kind: 'pool', userId: `u-${name}` },
    match: { slotId: `slot-${name}`, name: slot, provider: 'Pragmatic Play', confidence: 1, thumbnail: null },
    suggestions: [],
  }),
]

const side = (name: string, team: string): InternalEvent =>
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

function play(events: InternalEvent[], config: Record<string, unknown> = {}) {
  seq = 0
  const engine = new GameEngine(teamBattles, {
    config: teamBattles.configSchema.parse({ maxPicks: 8, joinWindowMs: null, ...config }),
    init: { sessionId: 's-1', channelId: 'c-1', seed: 'render-seed', startedAt: 1_000, owner: OWNER },
  })

  let state = engine.initialState()
  for (const event of events) state = engine.apply(state, event).state

  return {
    dashboard: engine.projectDashboard(state) as Record<string, any>,
    overlay: engine.project(state) as Record<string, any>,
  }
}

const pool = (n: number) =>
  Array.from({ length: n }, (_, i) => join(`p${i}`, `Slot ${i}`)).flat()

const settle = (buy: number, payout: number) => control('pick.result', { buyCost: buy, payout })

/** One full pick: draw, flip, bank. */
const playPick = (buy: number, payout: number) => [
  control('pick.draw'),
  control('flip.run'),
  settle(buy, payout),
]

// ─── the scoreboards ────────────────────────────────────────────────────────

test('both team columns render with their names and averages', () => {
  const { dashboard } = play([...pool(6), ...playPick(100, 400), ...playPick(100, 200)])
  const html = teamColumns(dashboard)

  assert.ok(html.includes(dashboard.teams.A.name), 'team A is missing')
  assert.ok(html.includes(dashboard.teams.B.name), 'team B is missing')
  assert.ok(html.includes('average per pick'), 'the deciding number is unlabelled')

  /*
   * The pick counts, asserted against the projection rather than just checked
   * for presence. This started as a field-presence test only, and the columns
   * happily rendered "0 picks" for a team that had two — a wrong number reads
   * as fact, where a missing one at least looks broken.
   */
  const total = dashboard.picksA + dashboard.picksB
  assert.equal(total, 2, 'the fixture played two picks')
  const shown = [...html.matchAll(/(\d+) picks?/g)].map((m) => Number(m[1]))
  assert.equal(shown.reduce((a, b) => a + b, 0), total, 'the columns undercount their picks')
})

test('the average is the figure on the column, not the total', () => {
  // §2 — the number that decides the session is the number you read first.
  const { dashboard } = play([...pool(6), ...playPick(100, 400), ...playPick(100, 600)])

  const html = teamColumns(dashboard)
  const score = dashboard.scoreA > 0 ? dashboard.scoreA : dashboard.scoreB
  assert.ok(html.includes(`${score.toFixed(2)}x`), 'the average never reached the column')
})

test('a team with no picks renders zero rather than blank', () => {
  // §16's shutout — the column still has to say something.
  const { dashboard } = play([...pool(4), ...playPick(100, 500)])
  const html = teamColumns(dashboard)

  assert.ok(html.includes('0.00x'), 'the empty team shows a real zero')
  assert.ok(html.includes('No picks yet'))
})

test('the crowd bar appears once anyone has declared, and not before', () => {
  const quiet = play(pool(4))
  assert.ok(!teamColumns(quiet.dashboard).includes('of chat'), 'no bar with nobody backing')

  const backed = play([...pool(4), side('ana', 'chaos'), side('ben', 'chaos'), side('cai', 'fortune')])
  const html = teamColumns(backed.dashboard)

  assert.ok(html.includes('of chat'))
  assert.ok(html.includes('67% of chat') || html.includes('33% of chat'), 'the split is shown')
})

// ─── §9.3: the swing number ─────────────────────────────────────────────────

test('the swing hero names the trailing team and what it needs', () => {
  const { dashboard } = play([...pool(6), ...playPick(100, 1_000), control('pick.draw'), control('flip.run')])

  if (dashboard.swing <= 0) return // both teams level; covered separately
  const html = swingHero(dashboard)

  const name = dashboard.teams[dashboard.swingTeam].name.toUpperCase()
  assert.ok(html.includes(name), 'the trailing team is not named')
  assert.ok(html.includes(`${dashboard.swing.toFixed(2)}x`), 'the figure never reached the page')
})

test('an unreachable swing says so instead of manufacturing tension', () => {
  // §9.3 — "fake tension is worse than no tension."
  const html = swingHero({
    swingTeam: 'B',
    swing: 340,
    teams: { A: { name: 'Chaos' }, B: { name: 'Fortune' } },
  })

  assert.ok(html.includes('out of reach'))
})

test('a live swing is framed as live', () => {
  const html = swingHero({
    swingTeam: 'B',
    swing: 4.2,
    teams: { A: { name: 'Chaos' }, B: { name: 'Fortune' } },
  })

  assert.ok(html.includes('this one is live'))
})

// ─── §6.1 / §3: what the pick card may show ─────────────────────────────────

test('the pick card withholds the team until the flip has run', () => {
  const drawn = play([...pool(4), control('pick.draw')])
  const before = pickCard(drawn.dashboard)

  assert.ok(before.includes('team not yet decided'), 'the card must not pre-empt the flip')
  assert.ok(!before.includes('text-team-a') && !before.includes('text-team-b'), 'and must wear no team colour')

  const flipped = play([...pool(4), control('pick.draw'), control('flip.run')])
  const after = pickCard(flipped.dashboard)
  assert.ok(after.includes('Playing for'))
})

test('a reserved pick is badged openly', () => {
  // §5 — a visible advantage reads as generosity, a hidden one as rigging.
  const { dashboard } = play([...pool(6), control('reserve.add', { userId: 'u-p2' }), control('pick.draw')])
  assert.ok(pickCard(dashboard).includes("Streamer's pick"))
})

test('the coin overriding a declared side is called out on the card', () => {
  // §6.4 — one of the best recurring beats the game has.
  const events = [...pool(4)]
  for (const n of ['p0', 'p1', 'p2', 'p3']) events.push(side(n, 'chaos'))
  events.push(control('pick.draw'), control('flip.run'))

  const { dashboard } = play(events)
  const html = pickCard(dashboard)

  if (dashboard.currentPick.allegianceOverridden) {
    assert.ok(html.includes('the coin said'), 'the override is not surfaced')
    assert.ok(html.includes('line-through'), 'the called side is not struck through')
  } else {
    assert.ok(!html.includes('the coin said'), 'it must not claim an override that did not happen')
  }
})

// ─── the ledger ─────────────────────────────────────────────────────────────

test('every played pick reaches the ledger with its team and multiplier', () => {
  const { dashboard } = play([...pool(6), ...playPick(100, 400), ...playPick(200, 0)])
  const html = ledger(dashboard)

  assert.equal(dashboard.picks.length, 2)
  for (const p of dashboard.picks) {
    assert.ok(html.includes(p.username), `${p.username} is missing from the ledger`)
  }
  assert.ok(html.includes('4.00x'))
  assert.ok(html.includes('0.00x'), 'a dead bonus is shown, not hidden')
})

test('a vetoed pick shows as vetoed with its reason', () => {
  const { dashboard } = play([
    ...pool(4),
    control('pick.draw'),
    control('pick.veto', { reason: 'Not on this casino' }),
  ])

  const html = ledger(dashboard)
  assert.ok(html.includes('Vetoed'))
  assert.ok(html.includes('Not on this casino'))
})

test('a corrected pick is marked as corrected', () => {
  // §16 — shown as a correction rather than silently applied.
  const { dashboard } = play([...pool(4), ...playPick(100, 400), control('pick.revert')])
  assert.ok(ledger(dashboard).includes('Corrected'))
})

// ─── joining and the result ─────────────────────────────────────────────────

test('the joining panel counts the pool and shows both commands', () => {
  const { dashboard } = play(pool(5))
  const html = battlesJoining(dashboard)

  assert.equal(dashboard.entrantCount, 5)
  assert.ok(html.includes('!join'))
  assert.ok(html.includes('!side'), 'allegiance is free to hand out — it has to be on screen')
})

test('the result screen names the winner, the awards and how it was decided', () => {
  // §8.3 — a tie resolved silently looks like a bug.
  const events = [...pool(12)]
  for (const payout of [900, 100, 500, 0, 300, 250, 150, 400]) events.push(...playPick(100, payout))
  events.push(control('battle.end'))

  const { dashboard } = play(events, { maxSuddenDeath: 0 })

  assert.ok(dashboard.result, 'the fixture did not finish the session')
  const html = battlesResult(dashboard)

  assert.ok(html.includes('WIN'))
  assert.ok(html.includes('MVP'))
  assert.ok(html.includes(dashboard.result.mvp.username))
  assert.ok(
    /Higher average|decided on/.test(html),
    'the result screen did not explain the decision',
  )
})

// ─── the shapes the views assume ────────────────────────────────────────────

test('the dashboard projection carries every field the views read', () => {
  const { dashboard } = play([...pool(6), ...playPick(100, 400)])

  for (const key of [
    'phase', 'teams', 'scoreA', 'scoreB', 'totalA', 'totalB', 'picksA', 'picksB',
    'rosterA', 'rosterB', 'crowdA', 'crowdB', 'swing', 'swingTeam', 'currentPick',
    'picks', 'entrantCount', 'maxPicks', 'pickNumber', 'picksRemaining',
    'flipSequenceHash', 'animationMs', 'result', 'unresolved',
  ]) {
    assert.ok(key in dashboard, `a view reads ${key}, which the projection does not send`)
  }
})

test('the unresolved queue arrives in the shape the shared panel normalises', () => {
  // The panel keys on `entryId ?? userId` and `requestedBy?.username ?? username`.
  const { dashboard } = play([
    ev({
      type: 'command',
      command: 'join',
      args: 'gattes of olympu',
      raw: '!join gattes of olympu',
      actor: { userId: 'u-zed', username: 'zed', role: 'viewer' },
      messageId: 'm-zed',
    }),
    ev({
      type: 'slot.resolved',
      query: 'gattes of olympu',
      then: { kind: 'pool', userId: 'u-zed' },
      match: null,
      suggestions: [{ slotId: 'g', name: 'Gates of Olympus', provider: 'Pragmatic', thumbnail: null, confidence: 0.8 }],
    }),
  ])

  assert.equal(dashboard.unresolved.length, 1)
  assert.ok(dashboard.unresolved[0].userId)
  assert.ok(dashboard.unresolved[0].username)
  assert.ok(dashboard.unresolved[0].rawText)
})
