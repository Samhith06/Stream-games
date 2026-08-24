/**
 * Scoring — §8, and the swing number from §9.3.
 *
 * Pure functions over the pick list. Nothing here is stored: §14 is explicit
 * that every team figure is derived, so a reverted pick (§16) recomputes the
 * scoreboard from the log rather than trying to unwind an accumulator.
 */

import { round2, type Rng } from '@streamarena/core'
import type { Award, BattleResult, DecidedBy, Pick, TeamKey } from './types.js'

/** Only resolved picks score. A drawn-but-unplayed pick is not a zero. */
export function teamPicks(picks: readonly Pick[], team: TeamKey): Pick[] {
  return picks.filter((p) => p.team === team && p.multiplier !== null && !p.vetoed)
}

export function teamTotal(picks: readonly Pick[], team: TeamKey): number {
  return round2(teamPicks(picks, team).reduce((sum, p) => sum + (p.multiplier ?? 0), 0))
}

/**
 * The number that decides the session — §2.
 *
 * Total ÷ picks, so team size cannot decide anything. An empty team scores 0
 * rather than undefined: §16's shutout is a team that loses, not a draw and not
 * a crash.
 */
export function teamScore(
  picks: readonly Pick[],
  team: TeamKey,
  metric: 'average' | 'total' | 'trimmed' = 'average',
): number {
  const mine = teamPicks(picks, team)
  if (mine.length === 0) return 0

  const values = mine.map((p) => p.multiplier ?? 0)

  if (metric === 'total') return round2(values.reduce((a, b) => a + b, 0))

  if (metric === 'trimmed') {
    /*
     * Drop each team's best before averaging — §2 offers this and advises
     * against it. With one pick there is nothing left after the trim, so the
     * single result stands rather than becoming a 0; trimming a team out of
     * existence would be a worse answer than not trimming.
     */
    if (values.length <= 1) return round2(values[0] ?? 0)
    const trimmed = [...values].sort((a, b) => b - a).slice(1)
    return round2(trimmed.reduce((a, b) => a + b, 0) / trimmed.length)
  }

  return round2(values.reduce((a, b) => a + b, 0) / values.length)
}

/** Secondary, displayed, never decisive — §8.2. */
export function teamCash(picks: readonly Pick[], team: TeamKey): number {
  return teamPicks(picks, team).reduce(
    (sum, p) => sum + ((p.payoutCents ?? 0) - (p.buyCostCents ?? 0)),
    0,
  )
}

export function crowd(
  sides: Record<string, { team: TeamKey }>,
  team: TeamKey,
): number {
  return Object.values(sides).filter((s) => s.team === team).length
}

/**
 * The swing number — §9.3.
 *
 * What this single bonus has to pay for `team` to take the lead right now. It
 * is what makes the buying phase watchable instead of dead air: the streamer is
 * loading a bonus and there is a specific figure on screen it has to beat.
 *
 *     required = score(other) × (picks(team) + 1) − total(team)
 *
 * Returns 0 when the team is already ahead — there is nothing to chase — and
 * the caller inverts the framing in that case (§9.3's weaker beat).
 */
export function swing(
  picks: readonly Pick[],
  team: TeamKey,
  metric: 'average' | 'total' | 'trimmed' = 'average',
): number {
  const other: TeamKey = team === 'A' ? 'B' : 'A'
  const target = teamScore(picks, other, metric)
  const mine = teamPicks(picks, team)

  if (metric === 'total') {
    return round2(Math.max(0, target - teamTotal(picks, team)))
  }

  const required = target * (mine.length + 1) - teamTotal(picks, team)
  return round2(Math.max(0, required))
}

/** §8.2 — biggest single multiplier of the session, cross-team. */
export function mvpOf(picks: readonly Pick[]): Award | null {
  return extremeOf(picks, (a, b) => b.multiplier! - a.multiplier!)
}

/**
 * §8.2 — the lowest, "awarded with affection". Never a punishment, never a
 * penalty, and only when `showAnchor` is on.
 */
export function anchorOf(picks: readonly Pick[]): Award | null {
  return extremeOf(picks, (a, b) => a.multiplier! - b.multiplier!)
}

function extremeOf(picks: readonly Pick[], order: (a: Pick, b: Pick) => number): Award | null {
  const resolved = picks.filter((p) => p.multiplier !== null && !p.vetoed)
  if (resolved.length === 0) return null

  const best = [...resolved].sort(order)[0]!
  return {
    userId: best.userId,
    username: best.username,
    slotName: best.slotName,
    multiplier: best.multiplier!,
  }
}

/** How many picks are still to come, sudden death included. */
export function picksRemaining(
  picks: readonly Pick[],
  maxPicks: number,
  suddenDeathPicks: number,
): number {
  const played = picks.filter((p) => p.multiplier !== null || p.vetoed).length
  return Math.max(0, maxPicks + suddenDeathPicks - played)
}

/**
 * Whether the session should go to sudden death — §9.2.
 *
 * Bounded and automatic, and both matter: bounded so it cannot become an
 * unlimited discretionary extension, which would reintroduce exactly the
 * problem §9.1 exists to solve, and automatic so it fires on a rule everyone
 * can see rather than on a judgement call.
 */
export function needsSuddenDeath(
  picks: readonly Pick[],
  opts: {
    threshold: number
    used: number
    max: number
    metric: 'average' | 'total' | 'trimmed'
  },
): boolean {
  if (opts.used >= opts.max) return false

  const a = teamScore(picks, 'A', opts.metric)
  const b = teamScore(picks, 'B', opts.metric)
  const leader = Math.max(a, b)

  // Nothing paid on either side. A margin measured as a fraction of zero is
  // meaningless, so this goes down the tiebreak ladder instead (§16).
  if (leader <= 0) return false

  return Math.abs(a - b) <= leader * opts.threshold
}

/**
 * The winner, and which rung of the ladder decided it — §8.3.
 *
 * The rung is returned rather than discarded because §8.3 requires the overlay
 * to state it: a tie resolved silently looks like a bug.
 */
export function resolveWinner(
  picks: readonly Pick[],
  opts: {
    metric: 'average' | 'total' | 'trimmed'
    showAnchor: boolean
    rng: Rng
  },
): BattleResult {
  const scoreA = teamScore(picks, 'A', opts.metric)
  const scoreB = teamScore(picks, 'B', opts.metric)

  const countA = teamPicks(picks, 'A').length
  const countB = teamPicks(picks, 'B').length

  const decide = (): { winner: TeamKey; decidedBy: DecidedBy } => {
    if (scoreA !== scoreB) {
      return { winner: scoreA > scoreB ? 'A' : 'B', decidedBy: 'average' }
    }

    // 1. Higher team total multiplier.
    const totalA = teamTotal(picks, 'A')
    const totalB = teamTotal(picks, 'B')
    if (totalA !== totalB) return { winner: totalA > totalB ? 'A' : 'B', decidedBy: 'total' }

    // 2. Higher single best multiplier — the better MVP.
    const bestA = bestOf(picks, 'A')
    const bestB = bestOf(picks, 'B')
    if (bestA !== bestB) return { winner: bestA > bestB ? 'A' : 'B', decidedBy: 'best' }

    // 3. Fewer picks — the same score off fewer bonuses is the better
    //    performance. A team with no picks at all is not "efficient", so a
    //    zero-pick team never wins this rung.
    if (countA !== countB && countA > 0 && countB > 0) {
      return { winner: countA < countB ? 'A' : 'B', decidedBy: 'fewerPicks' }
    }

    return { winner: opts.rng.coinFlip() ? 'A' : 'B', decidedBy: 'coinflip' }
  }

  const { winner, decidedBy } = decide()

  return {
    winner,
    decidedBy,
    scoreA,
    scoreB,
    mvp: mvpOf(picks),
    // §8.2 — off by config, and pointless on a session with a single result.
    anchor: opts.showAnchor && picks.filter((p) => p.multiplier !== null).length > 1
      ? anchorOf(picks)
      : null,
    shutout: countA === 0 || countB === 0,
  }
}

function bestOf(picks: readonly Pick[], team: TeamKey): number {
  const mine = teamPicks(picks, team)
  return mine.length === 0 ? 0 : Math.max(...mine.map((p) => p.multiplier ?? 0))
}
