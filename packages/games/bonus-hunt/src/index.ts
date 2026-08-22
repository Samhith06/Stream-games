import type { GameModule, InitContext } from '@streamarena/core'
import { leaderboard } from '@streamarena/core'
import { collectedCount, derive, guessDistribution, participantCount } from './derived.js'
import { reduce } from './reduce.js'
import {
  bonusHuntConfigSchema,
  type BonusHuntConfig,
  type BonusHuntState,
} from './types.js'

/**
 * Game 1 — Bonus Hunt, with Guess the Balance built in (§13).
 *
 * "Guess the Balance is what turns a hunt from something viewers watch into
 * something they're invested in — every bonus opening now matters to every
 * viewer who guessed, not just the streamer."
 */
export const bonusHunt: GameModule<BonusHuntState, BonusHuntConfig> = {
  id: 'bonus-hunt',
  stateVersion: 1,
  displayName: 'Bonus Hunt',
  tagline:
    'Collect bonuses from viewer-suggested slots, then open them all and see if you profit.',

  configSchema: bonusHuntConfigSchema,

  // §6.3 — the subscription scope is derived from this list, so a game that
  // doesn't need sub events never causes us to pay for their delivery.
  subscriptions: ['chat.message.sent'],

  commands: [
    {
      id: 'sr',
      keywords: ['sr', 'slot', 'request'],
      description: 'Suggest a slot for the hunt',
      gate: 'anyone',
      cooldownMs: 15_000,
      perUserLimit: 0, // enforced by the game, which knows the configured cap
      globalLimit: 0,
    },
    {
      id: 'editsr',
      keywords: ['editsr', 'changesr', 'swap'],
      description: 'Swap the slot you requested for a different one',
      gate: 'anyone',
      // Cheaper than !sr on purpose: changing your mind is a normal thing to
      // do, and a long cooldown here would just push people to spam !sr.
      cooldownMs: 8_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'guess',
      keywords: ['guess', 'g'],
      description: 'Guess the final balance',
      gate: 'anyone',
      // Editable until lock (§13), so no per-user cap — a replacement guess
      // must not be rejected as a second use.
      cooldownMs: 3_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'hunt',
      keywords: ['hunt', 'status'],
      description: 'Show the current hunt status',
      gate: 'anyone',
      cooldownMs: 30_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'myslot',
      keywords: ['myslot', 'mine'],
      description: 'Show which slot you requested',
      gate: 'anyone',
      cooldownMs: 20_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
  ],

  initialState(config: BonusHuntConfig, _ctx: InitContext): BonusHuntState {
    return {
      phase: 'collecting',
      currency: config.currency,
      startBalance: config.startBalance,
      targetBonuses: config.targetBonuses,
      entries: [],
      guesses: [],
      guessWindowEndsAt: null,
      guessesLocked: false,
      balanceAtCloseOfCollection: null,
      totals: { spent: 0, won: 0 },
      winner: null,
      finalBalance: null,
      lastStatusReplyAt: null,
    }
  },

  reduce,

  /**
   * §19 — the overlay is a different design problem. It gets the numbers and
   * nothing else: no raw user ids, no catalog suggestions, no unresolved-queue
   * plumbing.
   */
  project(state: BonusHuntState) {
    const d = derive(state)

    return {
      phase: state.phase,
      currency: state.currency,
      startBalance: state.startBalance,
      targetBonuses: state.targetBonuses,

      entries: state.entries
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((e) => ({
          id: e.id,
          slotName: e.slotName ?? e.rawText,
          provider: e.provider,
          thumbnail: e.thumbnail,
          bet: e.bet,
          win: e.win,
          multiplier: e.win !== null && e.bet > 0 ? Math.round((e.win / e.bet) * 100) / 100 : null,
          status: e.status,
          requestedBy: e.requestedBy.username,
          order: e.order,
        })),

      // The emotional centre of the game (§13) — the largest number on the
      // overlay during collection and guessing.
      breakEvenPerBonus: d.breakEvenPerBonus,
      spent: d.spent,
      won: state.totals.won,
      profit: d.profit,
      returnMultiple: d.returnMultiple,
      remainingBonuses: d.remainingBonuses,
      openedCount: d.openedCount,
      /** Banked bonuses — the "18 / 30" the progress bar counts. */
      collectedCount: collectedCount(state),
      /** Every suggestion, banked or not, for the collecting-phase list. */
      suggestionCount: state.entries.length,
      bestEntry: d.bestEntry,

      guessCount: state.guesses.length,
      participantCount: participantCount(state),
      guessWindowEndsAt: state.guessWindowEndsAt,
      guessesLocked: state.guessesLocked,

      /** Histogram + stat row on the guessing screen. */
      guessDistribution: guessDistribution(state),

      /**
       * Live guess feed, newest first. Capped: the overlay and the dashboard
       * both only ever render the top of this list, and shipping 1,200 guesses
       * on every patch would swamp the socket.
       */
      recentGuesses: state.guesses
        .slice()
        .sort((a, b) => b.submittedAt - a.submittedAt || b.submittedAtSeq - a.submittedAtSeq)
        .slice(0, 25)
        .map((g) => ({
          username: g.username,
          role: g.role,
          amount: g.amount,
          submittedAt: g.submittedAt,
          edited: g.edited,
        })),

      /**
       * §20 — "The guess leaderboard during opening": the five guesses currently
       * closest to the running total. The streamer's narration fuel for the
       * whole opening phase.
       */
      closestGuesses:
        state.phase === 'opening' || state.phase === 'complete'
          ? leaderboard(state.finalBalance ?? d.runningBalance, state.guesses, 5).map((r) => ({
              username: r.candidate.username,
              amount: r.candidate.amount,
              difference: Math.round(r.difference * 100) / 100,
            }))
          : [],

      finalBalance: state.finalBalance,
      winner: state.winner,
      /** Results screen headline: average multiplier across opened bonuses. */
      averageMultiplier: d.averageMultiplier,
      /** "To break-even" on the opening screen — what's still needed to profit. */
      toBreakEven: Math.max(0, Math.round((d.spent - state.totals.won) * 100) / 100),
    }
  },

  /** The dashboard sees more: the unresolved queue and who asked for what. */
  projectDashboard(state: BonusHuntState) {
    return {
      ...(this.project(state) as Record<string, unknown>),
      unresolved: state.entries
        .filter((e) => e.slotId === null)
        .map((e) => ({
          entryId: e.id,
          rawText: e.rawText,
          requestedBy: e.requestedBy,
          suggestions: e.suggestions,
        })),
      guesses: state.guesses,
      balanceAtCloseOfCollection: state.balanceAtCloseOfCollection,
    }
  },

  phaseOf: (state) => state.phase,
}

export * from './types.js'
export * from './derived.js'
export { reduce } from './reduce.js'
export default bonusHunt
