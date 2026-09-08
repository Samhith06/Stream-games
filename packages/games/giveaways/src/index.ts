/**
 * Game 5 — Giveaways.
 *
 * The cheapest game in the catalog to build, by some distance, and the one
 * whose value depends least on the code and most on two durations and one
 * animation being right (§18). Almost everything structural came across
 * unchanged: the entry pool and its gating from Tournament, the
 * committed-randomness-with-a-published-hash doctrine from Team Battles and
 * Bingo, the full-frame takeover as playback from Team Battles, and the winner
 * announcement, stream delay and priority lane from Core.
 *
 * What is new is small and is almost all in `reduce.ts`: an entry grace period
 * that is one comparison and the highest-value line in the game, a claim clock
 * that starts when chat sees the name rather than when the reel stops, and a
 * cursor that walks an order committed before the first person typed.
 *
 * Its shape is different from everything before it in three ways that show up
 * directly in this file. **The whole channel is in it** — so nothing is ever
 * acked to an entrant and every rejection is an aggregate. **There is no
 * scoreboard** — so the projection is dominated by two numbers and two clocks.
 * And **the streamer is not playing** — so the control surface is six buttons
 * and the game runs itself between them.
 */

import type { GameModule, InitContext } from '@streamarena/core'
import { commitDrawOrder, seedHash, uniformAt } from './draw.js'
import { IDENTITY_FACTS_AVAILABLE, entryRole, nextEligible, nextPendingPrize, reduce } from './reduce.js'
import { activityWeight, clampWeight, oddsFor, oddsTiers, totalWeight, weightFor } from './weighting.js'
import {
  gateLineFor,
  giveawayConfigSchema,
  graceFor,
  usableWindowMs,
  type GiveawayConfig,
  type GiveawayState,
} from './types.js'

export const giveaways: GameModule<GiveawayState, GiveawayConfig> = {
  id: 'giveaways',
  stateVersion: 1,
  displayName: 'Giveaways',
  /**
   * §17 — the catalog's old "Soon" copy advertised watch-time auto-drops, which
   * is a different game wearing this one's name: no entry window, no keyword,
   * no claim, a different overlay, and an upstream dependency on presence
   * tracking the platform does not have. "The copy should change."
   */
  tagline: 'Keyword entry, gated or open, an animated draw and a claim clock.',

  /**
   * §1's structural warning, answered.
   *
   * "The thing this game most wants is to run *inside* another game — a
   * giveaway during the collection phase of a bonus hunt, between tournament
   * rounds, while a team battle waits on a buy. The runtime does not support
   * concurrent sessions on a channel, so v1 is a standalone session that the
   * streamer stops the other game to run. That is survivable and it is not
   * ideal, and Giveaways is the strongest argument the platform has yet
   * produced for making concurrency a real priority."
   *
   * It was made a priority. This is the flag that consumes it: a channel holds
   * one `exclusive` session and one `companion`, a giveaway is the companion,
   * and the streamer no longer has to stop a two-hour team battle to run a
   * three-minute giveaway inside it.
   *
   * What that costs this game, and why it is affordable: a companion brings its
   * own overlay source, its own event log and its own keyword, and it reads
   * nothing from the game it runs beside. The one genuine coupling is the chat
   * keyword — `!enter` cannot mean two things at once — and that is refused at
   * session creation rather than resolved at runtime, which is also why §5's
   * "the config field is prefilled `!enter` and expects to be changed" stops
   * being advice and starts being enforced.
   */
  concurrency: 'companion',

  configSchema: giveawayConfigSchema,
  subscriptions: ['chat.message.sent'],

  commands: [
    {
      id: 'enter',
      /*
       * §5 — the most themeable string in the product, and a placeholder that
       * expects to be replaced: a keyword matching what the streamer is saying
       * out loud converts better than a generic one. `keywordsFor` rewrites
       * this from `config.keyword` per session.
       *
       * `drop` rather than the spec's `enter`, because this game runs *inside*
       * another one and `!enter` already belongs to three of them. See the
       * `keyword` field in `types.ts` for the full argument.
       */
      keywords: ['drop'],
      description: 'Enter the giveaway',
      /*
       * Deliberately wide open, and deliberately uncapped, in a game that has
       * gating and a one-entry rule.
       *
       * Every guard the runtime enforces produces a chat write on denial, and
       * §5 is absolute that nothing is ever acked to an individual entrant —
       * eight hundred rejections is both outside Kick's rate limits and the
       * worst thing that has ever happened to a channel's chat. So the gate,
       * the one-entry rule and the lateness check all live in the reducer,
       * where a rejection can be counted into an aggregate silently.
       */
      gate: 'anyone',
      cooldownMs: 0,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'claim',
      keywords: ['claim'],
      description: 'Claim the prize you just won',
      gate: 'anyone',
      // Everyone in chat will type this for three minutes. Every one of those
      // is a silent no-op in the reducer; a cooldown here would answer them.
      cooldownMs: 0,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'odds',
      keywords: ['odds', 'chance'],
      description: 'Your odds and the current entry count',
      gate: 'anyone',
      // §11's throttle is one batched reply per 30s for the whole channel, not
      // one per viewer, so it is enforced in the reducer — see `oddsReply`.
      cooldownMs: 0,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'ga',
      keywords: ['ga', 'giveaway'],
      description: 'Mod controls — remove, close, extend, award',
      gate: 'moderators',
      cooldownMs: 0,
      perUserLimit: 0,
      globalLimit: 0,
      operatorOnly: true,
    },
  ],

  initialState(config, ctx: InitContext): GiveawayState {
    /*
     * §3 — the seed exists from session creation and the hash is published at
     * `OPEN`, before a single entry is accepted.
     *
     * The runtime already generates one seed per session and never changes it,
     * which is exactly the property the commitment needs: the streamer could
     * not have chosen a favourable seed, because it was fixed before they knew
     * who would enter. It is held here and withheld from every projection until
     * `COMPLETE` — see `project()`.
     */
    return {
      phase: 'idle',
      seed: ctx.seed,
      seedHash: seedHash(ctx.seed),
      seedRevealed: false,

      prizes: config.prizes.map((p, index) => ({
        index,
        title: p.title,
        description: p.description,
        imageUrl: p.imageUrl,
        status: 'pending' as const,
      })),
      currentPrizeIndex: null,

      entries: [],
      rejected: {},
      removedUserIds: [],

      entryOpensAtMs: null,
      entryClosesAtMs: null,
      closing: false,
      extendedForOutageMs: 0,

      drawOrder: [],
      cursor: 0,
      passoversThisPrize: 0,

      claim: null,
      awards: [],
      passovers: [],
      passoversExhausted: false,

      keyword: config.keyword,
      identityGuardsEnforced: IDENTITY_FACTS_AVAILABLE,
      gateLine: gateLineFor(config, IDENTITY_FACTS_AVAILABLE),
      gateOverride: null,

      lastOddsReplyAtMs: null,
      rejectionSummarySent: false,

      reelMs: config.reelMs,
      claimWindowMs: config.claimWindowMs,
    }
  },

  reduce,

  /**
   * The overlay's view — §13.
   *
   * Two things are withheld and one is shaped, and each is load-bearing.
   *
   * **The seed** stays hidden until `COMPLETE`. Publishing it while entry is
   * open would let anyone who can also see the entry list compute the order in
   * advance, which is the entire thing the commitment exists to prevent.
   *
   * **The rest of the draw order** is never sent at all. The dashboard gets the
   * next three names so the streamer can see what a passover would produce; the
   * overlay gets only the current one, because chat seeing the next name before
   * the passover replaces the reveal with an anticlimax.
   *
   * **The entry count is accepted entries only, and monotonic** (§13). Rejected
   * and removed entries are subtracted from the dashboard figure and never from
   * this one: a hero number that drops by forty in front of the whole channel
   * invites exactly one conclusion.
   */
  project(state) {
    const prizes = state.prizes.filter((p) => p.status !== 'voided').length
    const total = totalWeight(state.entries)

    return {
      phase: state.phase,

      // §13 — the hero, and the largest thing on screen for three minutes.
      entryCount: state.entries.length,
      keyword: state.keyword,
      gateLine: state.gateLine,

      entryOpensAtMs: state.entryOpensAtMs,
      /*
       * Countdown-zero, and the contract. The grace period is deliberately not
       * projected: a viewer who typed at zero and got in should have no idea
       * anything was extended for them (§2, UI §"the four highest-value
       * decisions").
       */
      entryClosesAtMs: state.entryClosesAtMs,
      closing: state.closing,
      extendedForOutageMs: state.extendedForOutageMs,

      /*
       * §6.1 — computed odds, never ticket counts. Recomputed live as the pool
       * grows and computed against the actual number of prizes, which is what
       * keeps it true in exactly the small-pool case where a ticket count would
       * have lied.
       */
      oddsOneIn: oddsFor(1, total, prizes),
      oddsTiers: oddsTiers(state.entries, prizes),

      /** §13 — the feed is the proof that entries are landing. */
      recentEntrants: state.entries
        .slice(-12)
        .reverse()
        .map((e) => ({ username: e.username, role: e.role, weight: e.weight })),

      prizes: state.prizes,
      currentPrizeIndex: state.currentPrizeIndex,

      /** §7 — the reel animates real names, so it needs real names. */
      reelNames: state.phase === 'draw' ? reelNames(state) : [],
      reelMs: state.reelMs,

      claim: state.claim,
      claimWindowMs: state.claimWindowMs,
      /** §8.3 — the strike-through persists in the strip for the session. */
      passovers: state.passovers,
      passoversThisPrize: state.passoversThisPrize,
      passoversExhausted: state.passoversExhausted,

      awards: state.awards,
      /** §8.3 — the health metric of this game, recorded per session. */
      claimRate: claimRate(state),

      seedHash: state.seedHash,
      /** §3 — published at COMPLETE, and only then. */
      seed: state.seedRevealed ? state.seed : null,
      /** §3 — the entry list, in join order, with weights. The other half. */
      entryList: state.seedRevealed
        ? state.entries.map((e) => ({ username: e.username, weight: e.weight, seq: e.joinedAtSeq }))
        : null,
      /*
       * §3 — the resulting order, published with the seed and not a moment
       * earlier. Before COMPLETE this is the answer to the whole game and
       * sending it to a browser source would put every remaining passover on
       * the wire before the reel had run.
       *
       * Usernames rather than user ids, per the platform's projection doctrine:
       * nothing a client receives ever carries an internal id, and the
       * verification page's whole job is to be readable by a stranger.
       */
      drawOrder: state.seedRevealed
        ? state.drawOrder.map(
            (userId) => state.entries.find((e) => e.userId === userId)?.username ?? '',
          )
        : null,
    }
  },

  /**
   * The dashboard is the overlay plus what the streamer needs to act — and one
   * thing they need to *see* that the audience must not.
   */
  projectDashboard(state) {
    return {
      ...(this.project(state) as Record<string, unknown>),

      /*
       * UI §4 — the next three names in the committed order, "deliberately
       * visible to the streamer and deliberately not on the overlay". Chat
       * seeing the next name before a passover would replace the reveal with an
       * anticlimax; the streamer seeing it costs nothing, because they cannot
       * change it.
       */
      nextInOrder: upcoming(state, 3),

      /*
       * UI §2 — the highest-value control on the entry screen. A streamer who
       * set gating too tight has about ninety seconds to notice and loosen it,
       * and this breakdown is the only place that is visible.
       */
      rejected: state.rejected,
      rejectedTotal: Object.values(state.rejected).reduce((a, b) => a + b, 0),
      removedUserIds: state.removedUserIds,

      entries: state.entries.map((e) => ({
        userId: e.userId,
        username: e.username,
        role: e.role,
        weight: e.weight,
        joinedAt: e.joinedAt,
      })),

      /*
       * §10.1 — said out loud, on the surface where the streamer is choosing
       * the gates. A guard that is configured and not running has to be visible
       * as such, or a streamer running a valuable prize believes in an
       * alt-farm defence they do not have.
       */
      identityGuardsEnforced: state.identityGuardsEnforced,
    }
  },

  phaseOf: (state) => state.phase,
}

/**
 * The names the reel spins through — §7.1, "a reel of real names".
 *
 * Real entrants, drawn from the actual pool, with the settled name last. The
 * reel is playback: the client is animating a result it already holds, and the
 * only thing it has to be trusted not to do is settle twice.
 */
function reelNames(state: GiveawayState): string[] {
  const names = state.entries.map((e) => e.username)
  if (names.length <= 1) return names
  const winner = state.claim?.username
  const filler = names.filter((n) => n !== winner)
  return winner ? [...filler.slice(0, 40), winner] : filler.slice(0, 40)
}

/** The next few positions the cursor would reach. Dashboard only. */
function upcoming(state: GiveawayState, howMany: number): string[] {
  const seen = new Set([
    ...state.awards.map((a) => a.userId),
    ...state.passovers.map((p) => p.userId),
    ...state.removedUserIds,
    ...(state.claim ? [state.claim.userId] : []),
  ])

  const out: string[] = []
  for (const userId of state.drawOrder) {
    if (seen.has(userId)) continue
    const entry = state.entries.find((e) => e.userId === userId)
    if (!entry) continue
    out.push(entry.username)
    if (out.length === howMany) break
  }
  return out
}

/**
 * §8.3 — "watch the claim rate. It is the health metric of this game."
 *
 * A channel trending below 50% is being told something specific about either
 * its timing or its prizes, and neither is discoverable any other way. Null
 * until something has resolved, because a rate over zero events is not a zero.
 */
export function claimRate(state: GiveawayState): number | null {
  const resolved = state.awards.filter((a) => a.method !== 'voided').length + state.passovers.length
  if (resolved === 0) return null
  return state.awards.filter((a) => a.method === 'claimed').length / resolved
}

export {
  activityWeight,
  clampWeight,
  commitDrawOrder,
  entryRole,
  gateLineFor,
  graceFor,
  nextEligible,
  nextPendingPrize,
  oddsFor,
  oddsTiers,
  seedHash,
  totalWeight,
  uniformAt,
  usableWindowMs,
  weightFor,
  IDENTITY_FACTS_AVAILABLE,
}
export * from './types.js'
export type { EntryRole, WeightInput } from './weighting.js'
