import type { GameModule, InitContext } from '@streamarena/core'
import { bracketShape, rankScores, voteSplit } from '@streamarena/core'
import { currentMatchOf, reduce } from './reduce.js'
import {
  tournamentConfigSchema,
  type Match,
  type TournamentConfig,
  type TournamentState,
} from './types.js'

/**
 * Game 2 — Slot Tournament (§14).
 *
 * "The real validation — adds pool/draw and prediction scoring, both reusable.
 * Slot Tournament taking days rather than weeks is how you'll know the
 * architecture held." (§23)
 */
export const slotTournament: GameModule<TournamentState, TournamentConfig> = {
  id: 'slot-tournament',
  stateVersion: 1,
  displayName: 'Slot Tournament',
  tagline: 'Viewers claim slots and fight a knockout bracket while chat predicts every match.',

  configSchema: tournamentConfigSchema,
  subscriptions: ['chat.message.sent'],

  commands: [
    {
      id: 'join',
      keywords: ['join', 'enter'],
      description: 'Claim a slot and enter the draw',
      // The configured joinGate is applied as a per-channel override by the
      // runtime, so the game never re-implements role checking.
      gate: 'anyone',
      cooldownMs: 10_000,
      perUserLimit: 0, // replacing your pick must not count as a second use
      globalLimit: 0,
    },
    {
      id: 'vote',
      keywords: ['vote', 'v', 'predict'],
      description: 'Predict the winner of the current match',
      gate: 'anyone',
      cooldownMs: 2_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'bracket',
      keywords: ['bracket', 'standings'],
      description: 'Show the current standings',
      gate: 'anyone',
      cooldownMs: 30_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'score',
      keywords: ['score', 'myscore'],
      description: 'Show your prediction record',
      gate: 'anyone',
      cooldownMs: 20_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
  ],

  initialState(config: TournamentConfig, _ctx: InitContext): TournamentState {
    return {
      phase: 'joining',
      seats: config.seats,
      bracketSize: bracketShape(config.seats).bracketSize,
      pool: [],
      reservedUserIds: [],
      entrants: [],
      rounds: [],
      currentMatch: null,
      joinWindowEndsAt: null,
      joinsClosed: false,
      scores: {},
      voterFirstSeen: {},
      champion: null,
      topPredictor: null,
      drawCompleted: false,
      lastStatusReplyAt: null,
    }
  },

  reduce,

  /**
   * §19 + §20. The overlay gets three bracket fidelities' worth of data but
   * decides for itself which to render: the full match card, the structural
   * minimap, and the between-rounds takeover. It never gets user ids.
   */
  project(state: TournamentState) {
    const match = currentMatchOf(state)
    const shape = bracketShape(Math.max(2, state.entrants.length || state.seats))

    return {
      phase: state.phase,
      seats: state.seats,
      bracketSize: state.bracketSize || shape.bracketSize,
      poolCount: state.pool.length,
      joinWindowEndsAt: state.joinWindowEndsAt,
      joinsClosed: state.joinsClosed,

      entrants: state.entrants
        .slice()
        .sort((a, b) => a.seedNumber - b.seedNumber)
        .map((e) => ({
          id: e.id,
          // §20 — "Username above slot name, everywhere in the tournament."
          username: e.username,
          slotName: e.slotName,
          seedNumber: e.seedNumber,
          source: e.source,
          hasBye: e.hasBye,
        })),

      /** Structural only — the corner minimap renders this without text (§20). */
      rounds: state.rounds.map((r) => ({
        roundIndex: r.roundIndex,
        matches: r.matches.map(projectMatch),
      })),

      currentMatch: match ? { ...projectMatch(match), split: voteSplit(match.votes) } : null,
      votingEndsAt: match?.votingEndsAt ?? null,

      leaderboard: rankScores(state.scores)
        .slice(0, 10)
        .map((s) => ({
          rank: s.rank,
          username: s.username,
          correct: s.correct,
          total: s.total,
        })),

      champion: state.champion,
      topPredictor: state.topPredictor,
    }
  },

  /** The dashboard also gets the raw pool and the unresolved joins. */
  projectDashboard(state: TournamentState) {
    return {
      ...(this.project(state) as Record<string, unknown>),
      pool: state.pool.map((m) => ({
        userId: m.userId,
        username: m.username,
        role: m.role,
        slotId: m.slotId,
        slotName: m.slotName,
        rawText: m.rawText,
        joinedAtSeq: m.joinedAtSeq,
      })),
      unresolved: state.pool
        .filter((m) => m.slotId === null)
        .map((m) => ({
          entryId: m.userId,
          rawText: m.rawText,
          requestedBy: { userId: m.userId, username: m.username },
          suggestions: m.suggestions,
        })),
      reservedUserIds: state.reservedUserIds,
      drawCompleted: state.drawCompleted,
    }
  },

  phaseOf: (state) => state.phase,
}

function projectMatch(m: Match) {
  return {
    id: m.id,
    roundIndex: m.roundIndex,
    matchIndex: m.matchIndex,
    a: m.a
      ? {
          username: m.a.username,
          slotName: m.a.slotName,
          buyCost: m.a.buyCost,
          payout: m.a.payout,
          multiplier: m.a.multiplier,
        }
      : null,
    b:
      m.b === 'bye'
        ? 'bye'
        : m.b
          ? {
              username: m.b.username,
              slotName: m.b.slotName,
              buyCost: m.b.buyCost,
              payout: m.b.payout,
              multiplier: m.b.multiplier,
            }
          : null,
    winner: m.winner,
    // §14 — always state on screen how a tiebreak was decided.
    decidedBy: m.decidedBy,
    status: m.status,
    voteCount: Object.keys(m.votes).length,
  }
}

export * from './types.js'
export * from './bracket.js'
export { reduce, currentMatchOf } from './reduce.js'
export default slotTournament
