/**
 * Team Battles — the rules that decide who wins.
 *
 * Weighted toward §2 (the win metric), §6 (the committed flip) and §8.3 (the
 * tiebreak ladder), because those are the three places where a wrong answer is
 * invisible: the session still completes, the overlay still shows a winner, and
 * the only symptom is that the wrong team won in front of a live chat.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../../core/src/primitives/rng.ts'
import { bagRemaining, commitFakeOuts, commitFlipSequence, hashSequence } from '../src/flip.ts'
import {
  anchorOf,
  mvpOf,
  needsSuddenDeath,
  picksRemaining,
  resolveWinner,
  swing,
  teamCash,
  teamPicks,
  teamScore,
  teamTotal,
} from '../src/scoring.ts'
import { battlesConfigSchema, sideLockPick, teamsFrom, type Pick, type TeamKey } from '../src/types.ts'

/** A resolved pick. Only the fields scoring reads. */
const pick = (index: number, team: TeamKey, multiplier: number | null, over: Partial<Pick> = {}): Pick => ({
  index,
  userId: `u${index}`,
  username: `viewer${index}`,
  slotId: `s${index}`,
  slotName: `Slot ${index}`,
  thumbnail: null,
  team,
  declaredSide: null,
  source: 'random',
  buyCostCents: multiplier === null ? null : 10_000,
  payoutCents: multiplier === null ? null : Math.round(10_000 * multiplier),
  multiplier,
  fakeOut: false,
  vetoed: null,
  revertedFrom: null,
  resolvedAtSeq: multiplier === null ? null : index,
  ...over,
})

// ─── §2: the win metric ─────────────────────────────────────────────────────

test('the average is size-independent, which is the entire point', () => {
  /*
   * §2 — the decision the whole game hinges on, in one 7–3 session.
   *
   * A: seven picks at 5x  → 35x total, 5x average
   * B: three picks at 10x → 30x total, 10x average
   *
   * The totals and the averages name different winners, which is what §2
   * measured happening in ~19% of sessions. Under a total, A wins on volume it
   * did nothing to earn — the coin handed it four extra picks.
   */
  const picks = [
    ...Array.from({ length: 7 }, (_, i) => pick(i, 'A', 5)),
    ...Array.from({ length: 3 }, (_, i) => pick(7 + i, 'B', 10)),
  ]

  assert.equal(teamScore(picks, 'A'), 5)
  assert.equal(teamScore(picks, 'B'), 10)
  assert.ok(teamTotal(picks, 'A') > teamTotal(picks, 'B'), 'the bigger team has the bigger total')

  const result = resolveWinner(picks, { metric: 'average', showAnchor: true, rng: createRng('s') })
  assert.equal(result.winner, 'B', 'the average must not reward the larger team')

  const byTotal = resolveWinner(picks, { metric: 'total', showAnchor: true, rng: createRng('s') })
  assert.equal(byTotal.winner, 'A', 'and total must genuinely behave the other way')
})

test('an empty team scores zero and loses, rather than being undefined', () => {
  // §16's shutout — ~0.2% at ten picks. Not a draw, not a crash.
  const picks = [pick(0, 'A', 1.5), pick(1, 'A', 3)]

  assert.equal(teamScore(picks, 'B'), 0)

  const result = resolveWinner(picks, { metric: 'average', showAnchor: true, rng: createRng('s') })
  assert.equal(result.winner, 'A')
  assert.equal(result.shutout, true, 'the overlay has to be able to say one team never got a pick')
})

test('a zero payout banks a real 0.00x and drags the average down', () => {
  // §8.1 — a dead bonus is a real result and the most damaging thing that can
  // happen to a team's average. It must not be skipped.
  const withDud = [pick(0, 'A', 10), pick(1, 'A', 0)]
  assert.equal(teamScore(withDud, 'A'), 5)
  assert.equal(teamPicks(withDud, 'A').length, 2)
})

test('an unresolved pick is not a zero', () => {
  // A drawn-but-unplayed pick would otherwise silently halve the average.
  const picks = [pick(0, 'A', 10), pick(1, 'A', null)]
  assert.equal(teamScore(picks, 'A'), 10)
  assert.equal(teamPicks(picks, 'A').length, 1)
})

test('a vetoed pick scores nothing at all', () => {
  const picks = [pick(0, 'A', 10), pick(1, 'A', 4, { vetoed: { atSeq: 5, reason: 'not on casino' } })]
  assert.equal(teamScore(picks, 'A'), 10)
})

test('the trimmed mean drops the best result, and survives a one-pick team', () => {
  // §2 offers it and advises against it. Trimming a single-pick team out of
  // existence would be a worse answer than not trimming.
  const many = [pick(0, 'A', 100), pick(1, 'A', 2), pick(2, 'A', 4)]
  assert.equal(teamScore(many, 'A', 'trimmed'), 3, 'the 100x is dropped')

  const one = [pick(0, 'B', 7)]
  assert.equal(teamScore(one, 'B', 'trimmed'), 7)
})

test('cash is tracked but never decides anything', () => {
  const picks = [pick(0, 'A', 3)] // 100 in, 300 out
  assert.equal(teamCash(picks, 'A'), 20_000)
})

// ─── §6.1: the committed flip ───────────────────────────────────────────────

test('the same seed commits the same flip sequence', () => {
  // The basis for answering "the flip is rigged" with a fact.
  const a = commitFlipSequence(13, createRng('same', 'flips'))
  const b = commitFlipSequence(13, createRng('same', 'flips'))
  const c = commitFlipSequence(13, createRng('other', 'flips'))

  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
})

test('the sequence covers sudden death, not just the scheduled picks', () => {
  // §9.2 — extending later would mean the extra picks were decided after the
  // session started, which is what the commitment exists to rule out.
  const config = battlesConfigSchema.parse({ maxPicks: 10, maxSuddenDeath: 3 })
  assert.equal(
    commitFlipSequence(config.maxPicks + config.maxSuddenDeath, createRng('s', 'flips')).length,
    13,
  )
})

test('the coin is actually even-handed over many sessions', () => {
  // Not a fairness proof — a check that nothing in the plumbing skews it.
  let a = 0
  let total = 0
  for (let i = 0; i < 400; i++) {
    for (const team of commitFlipSequence(10, createRng(`seed-${i}`, 'flips'))) {
      if (team === 'A') a++
      total++
    }
  }
  const share = a / total
  assert.ok(share > 0.45 && share < 0.55, `team A took ${(share * 100).toFixed(1)}% of flips`)
})

test('bag mode gives even teams, and its last chip is predetermined', () => {
  // §2 — this is the trade, stated as a test so nobody "fixes" it later.
  const seq = commitFlipSequence(10, createRng('s', 'flips'), 'bag')
  assert.equal(seq.filter((t) => t === 'A').length, 5)
  assert.equal(seq.filter((t) => t === 'B').length, 5)

  const before = bagRemaining(seq, 9)
  assert.equal(before.A + before.B, 1, 'one chip left means the final flip has no suspense')
})

test('an odd bag draws its spare chip rather than assigning it', () => {
  // Otherwise `bag` quietly favours team A on every odd pick count.
  const counts = { A: 0, B: 0 }
  for (let i = 0; i < 200; i++) {
    const seq = commitFlipSequence(11, createRng(`seed-${i}`, 'flips'), 'bag')
    const a = seq.filter((t) => t === 'A').length
    counts[a === 6 ? 'A' : 'B']++
  }
  assert.ok(counts.A > 60 && counts.B > 60, `spare chip went A:${counts.A} B:${counts.B}`)
})

test('the hash changes when the sequence does', () => {
  const a = commitFlipSequence(10, createRng('one', 'flips'))
  const b = commitFlipSequence(10, createRng('two', 'flips'))
  assert.notEqual(hashSequence(a), hashSequence(b))
  assert.equal(hashSequence(a), hashSequence([...a]), 'and is stable for the same input')
})

test('fake-outs are scheduled at roughly the configured rate', () => {
  // §6.3 — every flip faking out becomes a rhythm chat learns by pick five.
  const schedule = commitFakeOuts(15, 0.33, createRng('s', 'fakeouts'))
  assert.equal(schedule.length, 15)
  assert.equal(schedule.filter(Boolean).length, 5, '15 x 0.33 rounds to 5')

  assert.equal(commitFakeOuts(10, 0, createRng('s')).filter(Boolean).length, 0)
  assert.equal(commitFakeOuts(10, 1, createRng('s')).filter(Boolean).length, 10)
})

// ─── §9.3: the swing number ─────────────────────────────────────────────────

test('the swing number is what this bonus must pay to take the lead', () => {
  // Chaos: two picks totalling 20x, average 10x. Fortune: one pick of 2x.
  // Fortune's next pick has to bring their two-pick average to 10x:
  //   required = 10 x 2 - 2 = 18
  const picks = [pick(0, 'A', 12), pick(1, 'A', 8), pick(2, 'B', 2)]
  assert.equal(teamScore(picks, 'A'), 10)
  assert.equal(swing(picks, 'B'), 18)

  // And landing exactly that figure ties it, which is the definition.
  const after = [...picks, pick(3, 'B', 18)]
  assert.equal(teamScore(after, 'B'), 10)
})

test('the leading team has nothing to chase', () => {
  const picks = [pick(0, 'A', 10), pick(1, 'B', 2)]
  assert.equal(swing(picks, 'A'), 0)
})

test('a team with no picks yet needs only to beat the other average', () => {
  const picks = [pick(0, 'A', 6)]
  assert.equal(swing(picks, 'B'), 6, 'one pick at 6x ties a 6x average')
})

// ─── §8.3: the tiebreak ladder ──────────────────────────────────────────────

test('a tie on average falls to total, and says so', () => {
  // Same average, different volume.
  const picks = [pick(0, 'A', 5), pick(1, 'A', 5), pick(2, 'B', 5)]
  const result = resolveWinner(picks, { metric: 'average', showAnchor: false, rng: createRng('s') })

  assert.equal(result.winner, 'A')
  assert.equal(result.decidedBy, 'total')
})

test('a tie on total falls to the better single pull', () => {
  // A: 2 + 8 = 10 over two picks. B: 4 + 6 = 10 over two picks.
  const picks = [pick(0, 'A', 2), pick(1, 'A', 8), pick(2, 'B', 4), pick(3, 'B', 6)]
  const result = resolveWinner(picks, { metric: 'average', showAnchor: false, rng: createRng('s') })

  assert.equal(result.winner, 'A', 'the 8x beats the 6x')
  assert.equal(result.decidedBy, 'best')
})

test('everything dead on both sides lands on the coin, and admits it', () => {
  // §16 — both teams on 0.00x. The overlay has to say a coin decided it.
  const picks = [pick(0, 'A', 0), pick(1, 'B', 0)]
  const result = resolveWinner(picks, { metric: 'average', showAnchor: false, rng: createRng('s') })

  assert.equal(result.decidedBy, 'coinflip')
  assert.equal(result.scoreA, 0)
  assert.equal(result.scoreB, 0)
})

test('a shutout never loses on the fewer-picks rung', () => {
  // A team with no picks is not "efficient". Both on zero: A played two duds,
  // B played none. Fewer picks must not hand it to the team that never played.
  const picks = [pick(0, 'A', 0), pick(1, 'A', 0)]
  const result = resolveWinner(picks, { metric: 'average', showAnchor: false, rng: createRng('s') })
  assert.notEqual(result.decidedBy, 'fewerPicks')
})

// ─── §8.2: the awards ───────────────────────────────────────────────────────

test('MVP is the biggest pull of the session, whichever team it was on', () => {
  // §8.2 — deliberately independent of who won.
  const picks = [pick(0, 'A', 4), pick(1, 'B', 180), pick(2, 'A', 30)]
  const mvp = mvpOf(picks)

  assert.equal(mvp?.multiplier, 180)
  assert.equal(mvp?.username, 'viewer1')
})

test('the Anchor is the lowest, and is skipped on a single-result session', () => {
  const picks = [pick(0, 'A', 4), pick(1, 'B', 0.2), pick(2, 'A', 30)]
  assert.equal(anchorOf(picks)?.multiplier, 0.2)

  const alone = [pick(0, 'A', 4)]
  const result = resolveWinner(alone, { metric: 'average', showAnchor: true, rng: createRng('s') })
  assert.equal(result.anchor, null, 'one result cannot be both MVP and Anchor')
})

test('showAnchor off means no Anchor', () => {
  const picks = [pick(0, 'A', 4), pick(1, 'B', 0.2)]
  const result = resolveWinner(picks, { metric: 'average', showAnchor: false, rng: createRng('s') })
  assert.equal(result.anchor, null)
  assert.ok(result.mvp, 'but MVP is not optional')
})

// ─── §9.2: sudden death ─────────────────────────────────────────────────────

test('sudden death fires inside the threshold and is bounded', () => {
  const close = [pick(0, 'A', 10), pick(1, 'B', 9.8)]
  const opts = { threshold: 0.05, used: 0, max: 3, metric: 'average' as const }

  assert.equal(needsSuddenDeath(close, opts), true, '2% apart is inside 5%')
  assert.equal(needsSuddenDeath(close, { ...opts, used: 3 }), false, 'and it cannot run forever')

  const clear = [pick(0, 'A', 10), pick(1, 'B', 2)]
  assert.equal(needsSuddenDeath(clear, opts), false)
})

test('sudden death does not fire when nothing paid at all', () => {
  // A margin measured as a fraction of zero is meaningless — §16 sends this
  // down the tiebreak ladder instead of into an extra pick that can't help.
  const dead = [pick(0, 'A', 0), pick(1, 'B', 0)]
  assert.equal(
    needsSuddenDeath(dead, { threshold: 0.05, used: 0, max: 3, metric: 'average' }),
    false,
  )
})

test('picks remaining counts vetoes as consumed', () => {
  // §6.2 — a veto consumes the pick index and its committed flip.
  const picks = [pick(0, 'A', 3), pick(1, 'B', 2, { vetoed: { atSeq: 4, reason: 'x' } })]
  assert.equal(picksRemaining(picks, 10, 0), 8)
})

// ─── §15: config ────────────────────────────────────────────────────────────

test('the default config is a ten-pick average-scored coin session', () => {
  const config = battlesConfigSchema.parse({})
  assert.equal(config.maxPicks, 10)
  assert.equal(config.winMetric, 'average')
  assert.equal(config.drawMode, 'coin')
  assert.equal(config.maxSuddenDeath, 3)
})

test('the buy bound is a range, not a floor', () => {
  // §10 — a floor alone invites entering the priciest buy available so the
  // streamer has to spend €800 on your pick.
  assert.throws(() => battlesConfigSchema.parse({ minBuyX: 500, maxBuyX: 100 }), /range, not a floor/)
  assert.throws(() => battlesConfigSchema.parse({ minBuyX: 100, maxBuyX: 100 }), /range, not a floor/)
})

test('two teams cannot share a colour', () => {
  // The overlay is two colours telling you who is winning (§3).
  assert.throws(
    () => battlesConfigSchema.parse({ teamAColour: '#B44BFF', teamBColour: '#b44bff' }),
    /share a colour/,
  )
})

test('sides lock at the halfway pick by default', () => {
  // §7 — late arrivals can still pick a side, but nobody reads the scoreboard
  // at pick 14 and piles onto the winner.
  assert.equal(sideLockPick(battlesConfigSchema.parse({ maxPicks: 10 })), 5)
  assert.equal(sideLockPick(battlesConfigSchema.parse({ maxPicks: 15 })), 7)
  assert.equal(sideLockPick(battlesConfigSchema.parse({ maxPicks: 10, sideLockAtPick: 3 })), 3)
})

test('a side lock after the last pick is refused rather than silently ignored', () => {
  assert.throws(() => battlesConfigSchema.parse({ maxPicks: 10, sideLockAtPick: 12 }), /lower number/)
})

test('nobody picking and nobody assigned is refused', () => {
  // Otherwise the crowd bar sits empty all session and half of §7 is dead
  // weight on the overlay — a setting that silently does nothing.
  assert.throws(
    () => battlesConfigSchema.parse({ sideGate: 'nobody' }),
    /automatic assignment/,
  )

  const ok = battlesConfigSchema.parse({ sideGate: 'nobody', autoSideOnJoin: true })
  assert.equal(ok.sideGate, 'nobody')
  assert.equal(ok.autoSideOnJoin, true)
})

test('custom teams need both names', () => {
  assert.throws(() => battlesConfigSchema.parse({ teamPreset: 'custom', teamAName: 'Solo' }), /both names/)
})

test('presets resolve to two distinct identities', () => {
  const teams = teamsFrom(battlesConfigSchema.parse({ teamPreset: 'blaze-frost' }))
  assert.equal(teams.A.name, 'Blaze')
  assert.equal(teams.B.name, 'Frost')
  assert.notEqual(teams.A.colour, teams.B.colour)
})
