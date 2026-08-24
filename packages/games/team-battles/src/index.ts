/**
 * Game 4 — Team Battles.
 *
 * Structurally this is a bonus hunt with two buckets and a coin flip, which is
 * the argument for building it fourth: the pool, the seeded draw, the slot
 * catalog and result entry all came across from Tournament and Hunt unchanged.
 * The design work was §2 — deciding the win metric — not the code.
 */

import type { GameModule, InitContext } from '@streamarena/core'
import { createRng, round2 } from '@streamarena/core'
import { bagRemaining, commitFakeOuts, commitFlipSequence, hashSequence } from './flip.js'
import { curationVerdict, reduce } from './reduce.js'
import {
  crowd,
  mvpOf,
  picksRemaining,
  swing,
  teamCash,
  teamPicks,
  teamScore,
  teamTotal,
} from './scoring.js'
import {
  battlesConfigSchema,
  sideLockPick,
  teamsFrom,
  type BattleState,
  type BattlesConfig,
  type TeamKey,
} from './types.js'

export const teamBattles: GameModule<BattleState, BattlesConfig> = {
  id: 'team-battles',
  stateVersion: 1,
  displayName: 'Team Battles',
  tagline: 'Viewers join, a coin decides their team, and their bonus carries eleven other people with it.',

  configSchema: battlesConfigSchema,
  subscriptions: ['chat.message.sent'],

  commands: [
    {
      id: 'join',
      keywords: ['join', 'enter'],
      description: 'Enter the pool with a slot',
      gate: 'anyone',
      cooldownMs: 10_000,
      perUserLimit: 0, // replacing your slot must not count as a second use
      globalLimit: 0,
    },
    {
      id: 'side',
      keywords: ['side', 'chaos', 'fortune'],
      description: 'Declare which team you are rooting for — permanent',
      gate: 'anyone',
      cooldownMs: 5_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'teams',
      keywords: ['teams', 'battle'],
      description: 'Current team scores',
      gate: 'anyone',
      // §11 — throttled hard: in a two-team game this is the most spammable
      // command in the catalog and the answer is already on screen.
      cooldownMs: 30_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'me',
      keywords: ['me', 'mypick', 'myteam'],
      description: 'Your status — in pool, drawn, your team, your multiplier',
      gate: 'anyone',
      cooldownMs: 20_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
  ],

  initialState(config, ctx: InitContext): BattleState {
    /*
     * §6.1 — committed here, once, and never re-rolled.
     *
     * Length covers sudden death too: generating only `maxPicks` flips and
     * extending later would mean the extra picks were decided after the session
     * started, which is the precise thing the commitment exists to rule out.
     */
    const length = config.maxPicks + config.maxSuddenDeath
    const flipSequence = commitFlipSequence(
      length,
      createRng(ctx.seed, 'flips'),
      config.drawMode,
    )
    const fakeOutSchedule = commitFakeOuts(
      length,
      config.fakeOutRate,
      createRng(ctx.seed, 'fakeouts'),
    )

    return {
      phase: 'joining',
      joinsOpen: true,
      teams: teamsFrom(config),

      flipSequence,
      flipSequenceHash: hashSequence(flipSequence),
      flipSequenceRevealed: false,
      fakeOutSchedule,

      pool: [],
      reservedUserIds: [],
      drawnUserIds: [],

      sides: {},
      sidesLocked: false,
      sideLockAtPick: sideLockPick(config),

      picks: [],
      currentPickIndex: null,
      suddenDeathPicks: 0,

      maxPicks: config.maxPicks,
      animationMs: config.animationMs,
      currency: config.currency,
      joinWindowEndsAt: null,
      poolCapReached: false,

      lastLeader: null,
      lastLeadChangeAt: null,
      lastTeamsReplyAt: null,

      result: null,
    }
  },

  reduce,

  /**
   * The overlay's view — §13, §19 doctrine: usernames only, never user ids.
   *
   * Two things are deliberately withheld. The **committed flip sequence** stays
   * hidden until COMPLETE, because publishing it early would let anyone read
   * off every remaining team assignment and the animation would be pointless.
   * And the **current pick's team** is only present once the flip has started —
   * an overlay that knows the answer before it animates can leak it.
   */
  project(state) {
    const metric = 'average' as const
    const current = state.picks.find((p) => p.index === state.currentPickIndex) ?? null
    const teamRevealed = state.phase !== 'pick'

    const scoreA = teamScore(state.picks, 'A', metric)
    const scoreB = teamScore(state.picks, 'B', metric)
    const trailing: TeamKey = scoreA >= scoreB ? 'B' : 'A'

    return {
      phase: state.phase,
      teams: state.teams,
      joinsOpen: state.joinsOpen,
      joinWindowEndsAt: state.joinWindowEndsAt,

      scoreA,
      scoreB,
      totalA: teamTotal(state.picks, 'A'),
      totalB: teamTotal(state.picks, 'B'),
      cashA: teamCash(state.picks, 'A'),
      cashB: teamCash(state.picks, 'B'),

      /** Member lists, ordered by multiplier descending — §13. */
      rosterA: roster(state, 'A'),
      rosterB: roster(state, 'B'),

      // §7 — the crowd bar. No effect on scoring whatsoever, and that is
      // exactly why it works: a free popularity contest running in parallel.
      crowdA: crowd(state.sides, 'A'),
      crowdB: crowd(state.sides, 'B'),
      sidesLocked: state.sidesLocked,

      pickNumber: state.picks.filter((p) => !p.vetoed).length,
      /** Per team, since the scoreboard shows "8 picks · 113.6x total" (§13). */
      picksA: teamPicks(state.picks, 'A').length,
      picksB: teamPicks(state.picks, 'B').length,
      maxPicks: state.maxPicks,
      suddenDeathPicks: state.suddenDeathPicks,
      picksRemaining: picksRemaining(state.picks, state.maxPicks, state.suddenDeathPicks),

      // §9.3 — the largest thing on the overlay after the two team scores.
      swingTeam: trailing,
      swing: swing(state.picks, trailing, metric),

      currentPick: current
        ? {
            index: current.index,
            username: current.username,
            slotName: current.slotName,
            thumbnail: current.thumbnail,
            source: current.source,
            declaredSide: current.declaredSide,
            team: teamRevealed ? current.team : null,
            fakeOut: teamRevealed ? current.fakeOut : false,
            /** §6.4 — the coin overriding a declared allegiance. */
            allegianceOverridden:
              teamRevealed && current.declaredSide !== null && current.declaredSide !== current.team,
          }
        : null,

      entrantCount: state.pool.length,
      waitingForEntries: state.pool.filter((m) => m.slotId !== null).length === 0,
      poolCapReached: state.poolCapReached,

      flipSequenceHash: state.flipSequenceHash,
      /** §6.1 — published only at COMPLETE, so the commitment can be checked. */
      flipSequence: state.flipSequenceRevealed ? state.flipSequence : null,
      /** §2 — a bag whose contents are secret while chat can count them anyway. */
      bagRemaining:
        state.flipSequence.length > 0 && state.currentPickIndex !== null
          ? bagRemaining(state.flipSequence, state.currentPickIndex + 1)
          : null,

      /** §6.3 — playback length, so the overlay's timings follow the config. */
      animationMs: state.animationMs,
      currency: state.currency,

      result: state.result,
      mvpSoFar: mvpOf(state.picks),
    }
  },

  /** The dashboard is the overlay plus what the streamer needs to act. */
  projectDashboard(state) {
    return {
      ...(this.project(state) as Record<string, unknown>),
      pool: state.pool.map((m) => ({
        userId: m.userId,
        username: m.username,
        slotId: m.slotId,
        slotName: m.slotName,
        thumbnail: m.thumbnail,
        buyCostX: m.buyCostX,
        rawText: m.rawText,
        reserved: state.reservedUserIds.includes(m.userId),
      })),
      reservedUserIds: state.reservedUserIds,
      unresolved: state.pool
        .filter((m) => m.slotId === null)
        .map((m) => ({
          userId: m.userId,
          username: m.username,
          rawText: m.rawText,
          suggestions: m.suggestions,
        })),
      picks: state.picks.map((p) => ({
        index: p.index,
        userId: p.userId,
        username: p.username,
        slotName: p.slotName,
        team: p.team,
        multiplier: p.multiplier,
        buyCostCents: p.buyCostCents,
        payoutCents: p.payoutCents,
        vetoed: p.vetoed,
        revertedFrom: p.revertedFrom,
      })),
      currentPickIndex: state.currentPickIndex,
      /** §7 — the streamer can see when allegiance closes. */
      sideLockAtPick: state.sideLockAtPick,
    }
  },

  phaseOf: (state) => state.phase,
}

/** §13 — ordered by multiplier descending, so the best pull tops the column. */
function roster(state: BattleState, team: TeamKey) {
  return teamPicks(state.picks, team)
    .map((p) => ({
      username: p.username,
      slotName: p.slotName,
      multiplier: p.multiplier,
      /** §6.4 — the crossed-out badge stays for the rest of the session. */
      overridden: p.declaredSide !== null && p.declaredSide !== p.team,
    }))
    .sort((a, b) => (b.multiplier ?? 0) - (a.multiplier ?? 0))
}

export {
  commitFakeOuts,
  commitFlipSequence,
  curationVerdict,
  hashSequence,
  bagRemaining,
  sideLockPick,
  teamsFrom,
  round2,
}
export * from './scoring.js'
export * from './types.js'
