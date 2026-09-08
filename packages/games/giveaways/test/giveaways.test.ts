/**
 * Giveaways — the parts where a wrong answer is invisible.
 *
 * Weighted heavily toward §3 (the committed order) and §6 (weighting), because
 * those are the two places where a bug produces a session that looks completely
 * normal: the reel spins, a name lands, chat cheers, and the only symptom is
 * that the result was not the one the published seed implies. Everything a
 * viewer could ever check is checked here.
 *
 * §2's grace period is covered in `game-loop.test.ts`, where it can be tested
 * against a real clock running through the engine.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { commitDrawOrder, seedHash, uniformAt } from '../src/draw.ts'
import { activityWeight, oddsFor, oddsTiers, totalWeight, weightFor } from '../src/weighting.ts'
import {
  gateLineFor,
  giveawayConfigSchema,
  graceFor,
  usableWindowMs,
  type GiveawayConfig,
} from '../src/types.ts'

const config = (over: Record<string, unknown> = {}): GiveawayConfig =>
  giveawayConfigSchema.parse({ prizes: [{ title: 'A prize' }], ...over })

const entrant = (id: string, weight = 1, seq = Number(id.slice(1))) => ({
  userId: id,
  weight,
  joinedAtSeq: seq,
})

const pool = (n: number, weight = 1) =>
  Array.from({ length: n }, (_, i) => entrant(`u${i + 1}`, weight, i + 1))

// ─── §3: the commitment ─────────────────────────────────────────────────────

test('the same seed and the same entries produce the same order, always', () => {
  /*
   * The property the whole trust position rests on. "The draw is deterministic:
   * seed plus ordered entry list plus weights produces one ordered output,
   * every time, for anybody who runs it." A verifier reimplementing the four
   * documented steps has to land on this exact array.
   */
  const entries = pool(50)
  const first = commitDrawOrder(entries, 'seed-abc')
  const second = commitDrawOrder(entries, 'seed-abc')

  assert.deepEqual(first, second)
  assert.equal(first.length, 50, 'the draw produces an order over everyone, not a winner')
  assert.equal(new Set(first).size, 50, 'nobody appears twice and nobody is dropped')
})

test('the order does not depend on the order the caller happens to hold entries in', () => {
  /*
   * §3 commits against the join sequence, which is the order chat produced.
   * The pool arrives keyed by userId in some maps, so an implementation that
   * trusted insertion order would produce a different winner depending on how
   * the state was rebuilt — and a replay that names a different winner is worse
   * than no replay at all.
   */
  const entries = pool(30)
  const shuffled = [...entries].reverse()

  assert.deepEqual(commitDrawOrder(entries, 's'), commitDrawOrder(shuffled, 's'))
})

test('a different seed produces a different order', () => {
  const entries = pool(40)
  assert.notDeepEqual(commitDrawOrder(entries, 'seed-a'), commitDrawOrder(entries, 'seed-b'))
})

test('the published hash is short, stable, and does not leak the seed', () => {
  // §3 — twelve hex characters, for legibility on an overlay and in one chat
  // line. Forty-eight bits is far more than a streamer can grind a second seed
  // against inside a three-minute entry window.
  const hash = seedHash('a-real-session-seed')

  assert.match(hash, /^[0-9a-f]{12}$/)
  assert.equal(hash, seedHash('a-real-session-seed'))
  assert.notEqual(hash, seedHash('a-real-session-seee'))
  assert.ok(!hash.includes('a-real-session-seed'))
})

test('the uniform is a pure function of the seed and the position', () => {
  // Not a stream. A verifier gets value 7 without having to reproduce values
  // 1 through 6 in the right order, which is what keeps the algorithm
  // describable in a paragraph on the verification page.
  assert.equal(uniformAt('s', 7), uniformAt('s', 7))
  assert.notEqual(uniformAt('s', 7), uniformAt('s', 8))

  for (let i = 0; i < 200; i++) {
    const u = uniformAt('spread', i)
    assert.ok(u >= 0 && u < 1, `uniform out of range at ${i}: ${u}`)
  }
})

test('the uniform is spread evenly enough that position does not decide the draw', () => {
  // A hash that clustered would make early joiners systematically luckier,
  // which is the one bias nobody would ever spot from a single session.
  const buckets = new Array(10).fill(0)
  for (let i = 0; i < 10_000; i++) buckets[Math.floor(uniformAt('spread-check', i) * 10)]++

  for (const [decile, count] of buckets.entries()) {
    assert.ok(count > 850 && count < 1150, `decile ${decile} had ${count} of 10000`)
  }
})

test('a flat pool gives every position an equal shot at winning', () => {
  /*
   * The claim the streamer makes to chat, measured. Across many seeds, first
   * place should land on each entrant about equally often — if it did not,
   * "flat" would be a lie told by the software rather than by the streamer.
   */
  const entries = pool(10)
  const wins = new Map<string, number>()

  for (let i = 0; i < 20_000; i++) {
    const winner = commitDrawOrder(entries, `flat-${i}`)[0]!
    wins.set(winner, (wins.get(winner) ?? 0) + 1)
  }

  for (const e of entries) {
    const share = (wins.get(e.userId) ?? 0) / 20_000
    assert.ok(share > 0.085 && share < 0.115, `${e.userId} won ${(share * 100).toFixed(1)}% of the time`)
  }
})

test('a weighted entrant wins about as often as advertised', () => {
  /*
   * §6.1's whole finding, as a test: with one prize and 20% of the pool at 5×,
   * the advertised multiple holds. The simulation in the spec measured 4.99×
   * over 400,000 draws; this is the same measurement at a size a test suite can
   * afford, so the tolerance is correspondingly wide.
   *
   * The point is not the third decimal. It is that a streamer who tells chat
   * "subs get five times the entries" has said something true.
   */
  const entries = [...pool(20, 5).slice(0, 4), ...pool(20).slice(4)]
  let weightedWins = 0

  for (let i = 0; i < 20_000; i++) {
    const winner = commitDrawOrder(entries, `w-${i}`)[0]!
    if (Number(winner.slice(1)) <= 4) weightedWins++
  }

  // 4 entrants at 5× against 16 at 1× is 20 weight against 16: expect ~55.6%.
  const share = weightedWins / 20_000
  assert.ok(share > 0.53 && share < 0.58, `weighted entrants won ${(share * 100).toFixed(1)}%`)
})

test('an empty pool draws nothing rather than throwing', () => {
  // §16 — a giveaway nobody entered is information, and the code path that
  // reports it must not be an exception.
  assert.deepEqual(commitDrawOrder([], 'seed'), [])
})

// ─── §6: weighting and odds ─────────────────────────────────────────────────

test('flat is flat, and it is the default', () => {
  const c = config()
  assert.equal(c.weightMode, 'flat')
  assert.equal(weightFor({ role: 'subscriber', subTier: 3, messageCount: 99 }, c), 1)
})

test('the cap is a ceiling on the computed weight, not a suggestion', () => {
  /*
   * §6.2 — and the reason is not fairness. Heavy weighting suppresses the entry
   * count, and the entry count is the only number this game produces. A
   * non-sub who reads "subs get 20× entries" correctly concludes there is no
   * point typing.
   */
  const c = config({ weightMode: 'role', maxWeight: 3, roleWeights: { viewer: 1, subscriber: 3 } })
  assert.equal(weightFor({ role: 'subscriber', subTier: null, messageCount: 0 }, c), 3)
})

test('a role weight above the session cap is refused rather than silently clamped', () => {
  // A control that quietly does something other than what it says is the
  // failure mode `command-gates.ts` exists for, one layer up.
  const parsed = giveawayConfigSchema.safeParse({
    prizes: [{ title: 'p' }],
    weightMode: 'role',
    maxWeight: 2,
    roleWeights: { viewer: 1, subscriber: 5 },
  })

  assert.equal(parsed.success, false)
  assert.match(parsed.error!.issues[0]!.message, /cap is 2/)
})

test('the hard ceiling is not overridable', () => {
  // §6.2 — "capped at 5× by default and 10× hard". A ceiling that bends is not
  // a ceiling.
  assert.equal(giveawayConfigSchema.safeParse({ prizes: [{ title: 'p' }], maxWeight: 11 }).success, false)
})

test('activity weighting is bucketed, and a lurker is never zero-weighted', () => {
  /*
   * §6.3 — linear weighting on message count is a machine for producing chat
   * spam, and it rewards exactly what a streamer would otherwise mod against.
   * Three buckets, a low ceiling, and nothing at all past twenty.
   */
  const c = config()

  assert.equal(activityWeight(0, c), 1, 'a lurker who types only the keyword still gets in')
  assert.equal(activityWeight(3, c), 1.5)
  assert.equal(activityWeight(19, c), 2)
  assert.equal(activityWeight(20, c), 3)
  assert.equal(activityWeight(500, c), 3, 'no reward for going past twenty')
})

test('activity mode is refused while the message counter does not exist', () => {
  /*
   * §18 — "ship `weightMode: 'activity'` disabled if it slips". It slipped.
   * Accepting it would weight everyone at 1× while the setup screen said
   * otherwise, and the streamer would have told chat that talking improves
   * their odds.
   */
  for (const weightMode of ['activity', 'custom']) {
    const parsed = giveawayConfigSchema.safeParse({ prizes: [{ title: 'p' }], weightMode })
    assert.equal(parsed.success, false, `${weightMode} should be refused`)
    assert.match(parsed.error!.issues[0]!.message, /message counter/)
  }
})

test('odds are computed against the prize count, which is what keeps them true', () => {
  /*
   * §6.1 — "the overlay displays computed odds, never ticket counts". The
   * small-pool case is the one that matters: forty people and ten prizes is
   * 1 in 4, and a ticket count would have said "you have 1 entry" and left the
   * viewer to work out the rest with facts they do not have.
   */
  assert.equal(oddsFor(1, 400, 1), 400)
  assert.equal(oddsFor(1, 40, 10), 4)
  assert.equal(oddsFor(5, 400, 1), 80, 'a 5× entrant sees 5× better odds')
})

test('odds refuse to invent a figure for an empty pool', () => {
  // "1 in 0" and "1 in 1" are both lies, of different kinds.
  assert.equal(oddsFor(1, 0, 1), null)
  assert.equal(oddsFor(1, 100, 0), null)
})

test('odds never claim better than certain', () => {
  // More prizes than weight is a real configuration (§16, fewer entrants than
  // prizes) and it must read as "1 in 1", not as a fraction.
  assert.equal(oddsFor(1, 2, 10), 1)
})

test('the odds tiers describe who actually entered, not what was configured', () => {
  /*
   * A session configured with sub multipliers and no subs in it must not
   * advertise a tier nobody is in — the line on the overlay is meant to be
   * actionable, and an unreachable tier is the opposite.
   */
  const entries = [{ weight: 1 }, { weight: 1 }, { weight: 3 }]
  const tiers = oddsTiers(entries, 1)

  assert.equal(tiers.length, 2)
  assert.deepEqual(
    tiers.map((t) => [t.weight, t.count]),
    [
      [1, 2],
      [3, 1],
    ],
  )
  assert.equal(totalWeight(entries), 5)
})

// ─── §2: the durations ──────────────────────────────────────────────────────

test('the entry window has a floor and it cannot be dragged through', () => {
  /*
   * §2 — "a thirty-second giveaway is not a fast giveaway. It is a giveaway
   * that excludes every viewer on a slow connection, and it excludes them
   * silently." Anything shorter than the floor is not a design choice, it is a
   * bug with a number on it.
   */
  assert.equal(giveawayConfigSchema.safeParse({ prizes: [{ title: 'p' }], entryWindowMs: 30_000 }).success, false)
  assert.equal(giveawayConfigSchema.safeParse({ prizes: [{ title: 'p' }], entryWindowMs: 60_000 }).success, true)
  assert.equal(config().entryWindowMs, 180_000, 'and the default is three minutes, not the floor')
})

test('the grace is the stream delay plus five seconds', () => {
  // §2 rule 2 — the single highest-value line in the game. A viewer who types
  // when their screen says zero always makes it.
  assert.equal(graceFor(config({ streamDelayMs: 20_000 })), 25_000)
  assert.equal(graceFor(config({ streamDelayMs: 20_000, graceMs: 40_000 })), 40_000)
})

test('the claim window floor moves with the stream delay', () => {
  /*
   * §8.2 — §2 one level harder. Sixty seconds of *usable* time is the minimum,
   * and usable time is wall time minus the delay, so a channel on a 45-second
   * delay cannot run a 90-second claim window at all.
   */
  const tight = giveawayConfigSchema.safeParse({
    prizes: [{ title: 'p' }],
    streamDelayMs: 45_000,
    claimWindowMs: 90_000,
  })
  assert.equal(tight.success, false)
  assert.match(tight.error!.issues[0]!.message, /at least 105s/)

  assert.equal(
    giveawayConfigSchema.safeParse({
      prizes: [{ title: 'p' }],
      streamDelayMs: 45_000,
      claimWindowMs: 105_000,
    }).success,
    true,
  )
})

test('the usable window is the number the setup screen has to show', () => {
  // §15 — "180s window · about 155s of real time for a viewer on a 20s delay".
  // This is §2 rendered as a figure that moves while the slider does.
  assert.equal(usableWindowMs(config({ entryWindowMs: 180_000, streamDelayMs: 20_000 })), 155_000)
  // The floor stays honest even where the delay eats the whole window.
  assert.equal(usableWindowMs(config({ entryWindowMs: 60_000, streamDelayMs: 90_000 })), 0)
})

// ─── §5, §10: what the overlay is allowed to claim ──────────────────────────

test('the gate line does not advertise a guard the runtime is not running', () => {
  /*
   * §10.1's unknown, resolved the wrong way: Kick exposes no follow timestamp
   * and no account creation date, so the follower gate and both age guards have
   * nothing to check.
   *
   * An overlay footer reading "Followers only · following 10+ min" over a
   * session that accepts everyone is worse than one that admits it is open —
   * it is the product lying on the streamer's behalf to their whole channel.
   */
  const gated = config({ entryGate: 'followers', minFollowAgeMins: 10, minAccountAgeDays: 7 })

  assert.equal(gateLineFor(gated, false), 'Open to everyone')
  assert.equal(gateLineFor(gated, true), 'Followers only · following 10+ min · account 7+ days old')
})

test('the subscriber gate is advertised either way, because a badge can answer it', () => {
  // §10.3 — a streamer running something genuinely valuable should be told to
  // gate on subscribers, where Kick's own payment rail does the verification.
  assert.equal(gateLineFor(config({ entryGate: 'subscribers' }), false), 'Subscribers only')
})

// ─── §9, §15: the shape of a session ────────────────────────────────────────

test('a giveaway with no prize is refused rather than defaulted', () => {
  // A prize is a fact only the streamer has. Inventing "Prize 1" would produce
  // a session that runs perfectly and awards nothing anybody agreed to.
  assert.equal(giveawayConfigSchema.safeParse({}).success, false)
  assert.equal(giveawayConfigSchema.safeParse({ prizes: [] }).success, false)
})

test('the defaults are the ones §15 argues for', () => {
  const c = config()

  assert.equal(c.entryWindowMs, 180_000)
  assert.equal(c.claimWindowMs, 180_000)
  assert.equal(c.maxPassovers, 3)
  assert.equal(c.allowPreviousWinners, false, 'winning one prize takes you out of the running')
  assert.equal(c.reelMs, 4_500)
  assert.equal(c.announceWinnerInChat, true)
  assert.equal(c.publishSeed, true)
  assert.equal(c.maxWeight, 5)
})

test('the keyword is stored bare and rejects a prefix', () => {
  // The ! is added by the parser. A keyword carrying its own would produce a
  // '!!drop' nobody in chat can reach.
  assert.equal(config().keyword, 'drop')
  assert.equal(giveawayConfigSchema.safeParse({ prizes: [{ title: 'p' }], keyword: '!drop' }).success, false)
  assert.equal(config({ keyword: 'gates' }).keyword, 'gates')
})
