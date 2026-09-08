/**
 * Giveaways — state and config (§14, §15).
 *
 * Three things in here are load-bearing and easy to mistake for detail.
 *
 * **`graceMs` is the most valuable field in the schema.** §2: a Kick stream
 * reaches a viewer 8–30 seconds after it happens, so a viewer who types the
 * instant their own overlay countdown hits zero has typed *after* the server
 * closed. They did exactly the right thing and were rejected for it. The server
 * therefore closes late by the channel's stream delay plus five seconds, and
 * nothing about that is announced, badged, or visible to the audience.
 *
 * **`drawOrder` is written exactly once**, at `LOCKED`, and is immutable for the
 * life of the session. There is no transition that regenerates a seed and no
 * second call site for `commitDrawOrder`. §14 says that invariant is worth a
 * test of its own; it has one.
 *
 * **`streamDelayMs` lives on the config rather than being read from the chat
 * policy**, because a reducer is pure and gets nothing but its config. It is a
 * mirror of `chatPolicy.streamDelayMs` and the setup screen prefills it from
 * there — see the note on the field.
 */

import { z } from 'zod'
import type { EntryRole } from './weighting.js'

export type GiveawayPhase =
  | 'idle'
  | 'open'
  | 'locked'
  | 'draw'
  | 'claim'
  | 'passover'
  | 'awarded'
  | 'complete'

export type PrizeStatus = 'pending' | 'drawn' | 'claimed' | 'voided'
export type AwardMethod = 'claimed' | 'manual' | 'voided'
export type PassoverReason = 'expired' | 'passed-over-by-streamer'

/**
 * Why an entry did not count. Aggregate only, and that is a rule rather than a
 * simplification: §5 forbids acking an individual entrant at all, so a per-user
 * rejection record would be data with no legitimate consumer and one very
 * tempting illegitimate one.
 */
export type RejectionReason =
  | 'gate'
  | 'follow-age'
  | 'account-age'
  | 'blocked'
  | 'removed'
  | 'late'
  | 'closed'

/** Human copy for the batched rejection summary — §12's template. */
export const REJECTION_COPY: Record<RejectionReason, { reason: string; remedy: string }> = {
  gate: { reason: 'followers only', remedy: 'Follow and type it again' },
  'follow-age': { reason: 'you need to have been following a little longer', remedy: 'Stick around' },
  'account-age': { reason: 'account too new', remedy: 'Nothing to do on this one' },
  blocked: { reason: 'blocked from giveaways on this channel', remedy: 'Talk to a mod' },
  removed: { reason: 'removed by a mod', remedy: 'Talk to a mod' },
  late: { reason: 'entries had already closed', remedy: 'Be quicker next time' },
  closed: { reason: 'entries were not open', remedy: 'Wait for the next one' },
}

export interface Prize {
  index: number
  title: string
  description: string | null
  imageUrl: string | null
  status: PrizeStatus
}

export interface Entry {
  userId: string
  username: string
  role: EntryRole
  subTier: 1 | 2 | 3 | null
  /** Computed at entry time and frozen — see `weighting.ts`. */
  weight: number
  messageCount: number
  /** The ordering the draw is committed against. */
  joinedAtSeq: number
  joinedAt: number
}

export interface ClaimWindow {
  userId: string
  username: string
  prizeIndex: number
  /** Position in `drawOrder`, so the record can say "second in the order". */
  orderIndex: number
  /**
   * §8.1 — when the chat announcement lands, not when the draw resolved.
   *
   * Starting the clock at the settle would silently spend the stream delay —
   * twelve to thirty seconds of a three-minute window — before the winner had
   * any way of knowing they had won. The reducer schedules this forward by
   * `streamDelayMs` for exactly that reason.
   */
  startedAtMs: number
  expiresAtMs: number
  remindersSent: number
}

export interface Award {
  prizeIndex: number
  userId: string
  username: string
  method: AwardMethod
  manualReason: string | null
  awardedAtMs: number
  /** ms left on the clock when they claimed. Null for manual and voided. */
  claimedWithMsLeft: number | null
}

export interface Passover {
  prizeIndex: number
  userId: string
  username: string
  reason: PassoverReason
  /** Required for a streamer-initiated pass — §16, discretion stays visible. */
  note: string | null
  atMs: number
}

export interface GiveawayState {
  phase: GiveawayPhase

  /**
   * The session seed. Withheld from every client projection until `COMPLETE`,
   * and then published in full so anybody can recompute the order.
   */
  seed: string | null
  seedHash: string
  seedRevealed: boolean

  prizes: Prize[]
  currentPrizeIndex: number | null

  entries: Entry[]
  /** Aggregate counts by reason. Never per-user — see `RejectionReason`. */
  rejected: Record<string, number>
  removedUserIds: string[]

  entryOpensAtMs: number | null
  /**
   * Countdown-zero — the number the overlay renders. The server keeps
   * accepting until this plus `graceMs`, and says nothing about it.
   */
  entryClosesAtMs: number | null
  /** True between `!ga close` and the lock, so the button can say "Closing". */
  closing: boolean
  /** §16 — set when the window was extended to cover a Kick chat outage. */
  extendedForOutageMs: number

  /**
   * Computed once, at `LOCKED`, from (seed, entries in join order, weights).
   * Never regenerated. §3.
   */
  drawOrder: string[]
  /** Position in `drawOrder` currently holding, or last to have held, a prize. */
  cursor: number
  passoversThisPrize: number

  claim: ClaimWindow | null
  awards: Award[]
  passovers: Passover[]

  /**
   * §8.4 — the passovers ran out and the streamer must choose explicitly. The
   * session cannot resolve this itself, so it stops and says so.
   */
  passoversExhausted: boolean

  /** §5 — carried on state so no client ever has to read the config. */
  keyword: string
  gateLine: string
  /**
   * A gate loosened mid-window from the dashboard — §5's rejection strip.
   *
   * Null means "whatever the config said". Only ever set to something looser,
   * and never retroactive: the rejected entries were never recorded per user,
   * so the people it lets in are the ones who type again.
   */
  gateOverride: 'anyone' | null
  /**
   * False when the runtime cannot supply account-creation or follow timestamps
   * (§10.1 — the one genuine unknown in the spec, and Kick does not supply them
   * today). With it false the follower gate and both age guards are inert, and
   * the dashboard must say so in as many words rather than let a streamer
   * assume an alt-farm defence that is not running.
   */
  identityGuardsEnforced: boolean

  /** §11 — one batched `!odds` reply per 30s, throttled here, not by a guard. */
  lastOddsReplyAtMs: number | null
  rejectionSummarySent: boolean

  /** Playback lengths, so the overlay never reads config. */
  reelMs: number
  claimWindowMs: number
}

export const ENTRY_TIMER_ID = 'giveaway-entry-window'
export const CLOSING_TIMER_ID = 'giveaway-closing'
export const REJECTION_TIMER_ID = 'giveaway-rejection-summary'
export const REEL_TIMER_ID = 'giveaway-reel'
export const CLAIM_START_TIMER_ID = 'giveaway-claim-start'
export const CLAIM_TIMER_ID = 'giveaway-claim'
export const REMINDER_TIMER_ID = 'giveaway-claim-reminder'
export const PASSOVER_TIMER_ID = 'giveaway-passover'

/** §2 — "the config screen refuses to go below the floor". */
export const ENTRY_WINDOW_FLOOR_MS = 60_000
/** §2 rule 3 — a shortened window still gets a visible countdown. */
export const CLOSING_COUNTDOWN_MS = 15_000
/** §4 — the held beat that pays off the window. Do not skip it. */
export const LOCKED_HOLD_MS = 4_000
/** §8.3 — the struck-through name stays up while the next one reveals. */
export const PASSOVER_REVEAL_MS = 3_000
/** §11 — !odds is the only viewer command that produces a write. */
export const ODDS_REPLY_COOLDOWN_MS = 30_000
/** §5 — the batched rejection summary lands here, with time left to act. */
export const REJECTION_SUMMARY_AT_MS_REMAINING = 30_000
/** Below this, a rejection summary is noise rather than information. */
export const REJECTION_SUMMARY_MIN_COUNT = 5
/** §6.2 — not overridable. A hard ceiling that bends is not a ceiling. */
export const MAX_WEIGHT_CEILING = 10

const prizeSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(240).nullable().default(null),
  imageUrl: z.string().url().max(500).nullable().default(null),
})

export const giveawayConfigSchema = z
  .object({
    /**
     * §5 — the most themeable string in the product, and it expects to be
     * changed. A keyword that matches what the streamer is saying out loud
     * converts better than a generic one.
     *
     * Stored without the prefix. `keywordsFor` in `@streamarena/platform` turns
     * it into the actual chat keyword, on the same rule that governs every
     * other setup control: a setting the runtime does not read is a lie on a
     * form.
     *
     * **The default is `drop`, not the spec's `enter`, and the reason is
     * concurrency.** §5 prefilled `!enter` on the assumption this game ran
     * alone. It does not any more — it is the platform's one `companion` game
     * and its whole point is running inside a bonus hunt or a team battle — and
     * `!enter` is already the entry verb of Tournament, Bingo and Team Battles.
     * A default that collides with the game underneath it would either be
     * refused at session creation on the most common path this feature has, or
     * would give one word two meanings in a live chat, which is precisely what
     * the one-session-per-channel rule existed to prevent.
     *
     * `drop` is one of §5's own suggested themings, it collides with nothing,
     * and it still expects to be changed.
     */
    keyword: z
      .string()
      .min(1)
      .max(24)
      .regex(/^[a-z0-9_-]+$/i, 'Letters, digits, dashes and underscores only — the ! is added for you.')
      .default('drop'),

    prizes: z.array(prizeSchema).min(1).max(20),

    // ── §2. The two durations the whole game rests on ─────────────────────
    entryWindowMs: z.number().int().min(ENTRY_WINDOW_FLOOR_MS).max(1_800_000).default(180_000),
    /**
     * A mirror of the channel's `chatPolicy.streamDelayMs`.
     *
     * The reducer is pure and receives nothing but its config, so the delay has
     * to be *in* the config for the grace period and the claim floor to be
     * computable at all. The setup screen prefills it from the chat policy
     * (`GET /api/games/giveaways/config` returns both) and should show it
     * read-only with a link to the chat settings, rather than offering a second
     * place to set the same number.
     */
    streamDelayMs: z.number().int().min(0).max(120_000).default(12_000),
    /**
     * §2 rule 2. Null means "derive it" — stream delay plus five seconds —
     * which is what it should almost always be. An explicit value exists for a
     * channel whose real delay the streamer has measured and does not trust the
     * chat-policy figure for.
     */
    graceMs: z.number().int().min(0).max(60_000).nullable().default(null),

    entryGate: z.enum(['anyone', 'followers', 'subscribers']).default('anyone'),
    /**
     * §10.2 — the setting that actually does the work. Follower gating on its
     * own stops nothing: following takes one click and can be undone
     * immediately afterward. Ten minutes defeats the click-follow-enter reflex
     * without excluding a genuine new viewer who found the channel that
     * evening.
     *
     * **Currently unenforceable.** See `ageGuardsEnforced` on the state.
     */
    minFollowAgeMins: z.number().int().min(0).max(10_080).default(10),
    /** §10.1 — the single most effective alt-farm guard, and the same caveat. */
    minAccountAgeDays: z.number().int().min(0).max(365).default(7),
    /** §10.1 — the channel blocklist, shared across sessions. */
    blockedUserIds: z.array(z.string().min(1)).max(1000).default([]),

    // ── §6. Weighting ─────────────────────────────────────────────────────
    weightMode: z.enum(['flat', 'role', 'activity', 'custom']).default('flat'),
    roleWeights: z.record(z.number().min(1).max(MAX_WEIGHT_CEILING)).default({
      viewer: 1,
      follower: 1,
      subscriber: 2,
      sub1: 2,
      sub2: 3,
      sub3: 4,
      vip: 2,
      mod: 1,
    }),
    /** §6.3 — three buckets, a low ceiling, nothing past twenty messages. */
    activityBuckets: z
      .array(z.object({ minMessages: z.number().int().min(0), weight: z.number().min(1) }))
      .min(1)
      .default([
        { minMessages: 0, weight: 1 },
        { minMessages: 1, weight: 1.5 },
        { minMessages: 5, weight: 2 },
        { minMessages: 20, weight: 3 },
      ]),
    maxWeight: z.number().min(1).max(MAX_WEIGHT_CEILING).default(5),

    // ── §8. The claim ─────────────────────────────────────────────────────
    claimWindowMs: z.number().int().min(30_000).max(1_800_000).default(180_000),
    maxPassovers: z.number().int().min(0).max(10).default(3),
    /**
     * §9 — false spreads a three-prize session across three people instead of
     * concentrating it in one. True lets the top of the order take everything,
     * which is what the setting says and why it is off by default.
     */
    allowPreviousWinners: z.boolean().default(false),

    // ── §7, §12, §3. Presentation and publication ─────────────────────────
    reelMs: z.number().int().min(2_000).max(10_000).default(4_500),
    /**
     * §15 — "this one should not be turned off". With it off, a winner who is
     * not looking at the overlay has no way of learning they won and the claim
     * rate collapses. It exists for the streamer who reads winners out loud
     * themselves, and the setup screen must carry an inline warning next to it.
     */
    announceWinnerInChat: z.boolean().default(true),
    publishSeed: z.boolean().default(true),
    verificationPageEnabled: z.boolean().default(true),
  })
  .superRefine((config, ctx) => {
    /*
     * §8.2 — the claim floor is §2 one level harder. This viewer is not
     * necessarily looking at the stream; they may be in another tab or on a
     * phone in a pocket. Sixty seconds of *usable* time is the minimum that
     * gives an attentive viewer a real chance, and usable time is wall time
     * minus the delay.
     *
     * Refused here rather than warned about, because §15 asks the setup screen
     * to explain the floor inline while the streamer is dragging the slider —
     * and a floor that can be dragged through is not a floor.
     */
    const claimFloor = config.streamDelayMs + 60_000
    if (config.claimWindowMs < claimFloor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claimWindowMs'],
        message:
          `On a ${Math.round(config.streamDelayMs / 1000)}s stream delay the claim window has to be at ` +
          `least ${Math.round(claimFloor / 1000)}s — anything shorter gives the winner under a minute ` +
          `of real time to see the message and type the command.`,
      })
    }

    // §6.2 — the ceiling is not overridable, and a role weight above the
    // session's own cap is a control that silently does nothing.
    for (const [role, weight] of Object.entries(config.roleWeights)) {
      if (weight > config.maxWeight) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roleWeights', role],
          message:
            `${role} is set to ${weight}× but the session cap is ${config.maxWeight}× — ` +
            `raise the cap or lower the multiplier.`,
        })
      }
    }

    /*
     * §6.3 — buckets that do not start at zero would leave a lurker who typed
     * only the keyword with no weight at all, which the mode explicitly must
     * not do: it rewards presence, it does not gate on it.
     */
    const buckets = [...config.activityBuckets].sort((a, b) => a.minMessages - b.minMessages)
    if (buckets[0]!.minMessages !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['activityBuckets'],
        message:
          'The first activity bucket must start at 0 messages — a lurker who types only the ' +
          'keyword is never excluded and never zero-weighted.',
      })
    }

    /*
     * §6.3's upstream dependency, and §18's instruction about it: "Activity mode
     * has an upstream dependency — a per-session message counter that the
     * runtime does not currently keep … Ship `weightMode: 'activity'` disabled
     * if it slips."
     *
     * It slipped. The chat pipeline drops non-command messages at the cheapest
     * possible gate (`looksLikeCommand`, one charAt before anything allocates),
     * which is the design decision that makes a busy channel affordable — so
     * counting every message costs a Redis write on 95% of deliveries that
     * currently cost nothing at all. That is a platform change with a platform
     * argument behind it, not something to smuggle in under a weighting mode.
     *
     * Refused at config rather than accepted-and-ignored. Accepting it would
     * quietly weight every entrant at 1× while the setup screen said otherwise,
     * and the streamer would have told chat that talking improves their odds.
     * `activityWeight` in weighting.ts is complete and tested; the day the
     * counter exists this refusal is the only thing that has to go.
     */
    if (config.weightMode === 'activity' || config.weightMode === 'custom') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weightMode'],
        message:
          'Activity weighting needs a per-session message counter the runtime does not keep yet, ' +
          'so it would weight everyone at 1× while telling chat otherwise. Use flat or role ' +
          'weighting for now.',
      })
    }
  })

export type GiveawayConfig = z.infer<typeof giveawayConfigSchema>

/**
 * §2 rule 2 — the grace the server closes late by.
 *
 * Stream delay plus five seconds. The five is reaction time on the viewer's
 * side of the same gap the delay describes, and the whole quantity is invisible
 * to the audience by design: the count simply keeps accepting for a few more
 * seconds and then stops.
 */
export function graceFor(config: GiveawayConfig): number {
  return config.graceMs ?? config.streamDelayMs + 5_000
}

/**
 * §5 — "the overlay states the gate permanently, in the footer, at
 * overlay-legal size. Nobody should ever have to discover a gate by being
 * rejected by it."
 *
 * The corollary the spec does not have to state, because it never expected this
 * to be false: **it must not advertise a gate that is not running either.**
 * `identityGuardsEnforced` is false on Kick today (§10.1 — the account-age and
 * follow-age guards, and the follower gate along with them, have no timestamps
 * to check), and an overlay footer reading "Followers only" over a session that
 * accepts everyone is a worse failure than one that admits it is open.
 */
export function gateLineFor(config: GiveawayConfig, identityGuardsEnforced: boolean): string {
  const followerGateRuns = config.entryGate === 'followers' && identityGuardsEnforced

  const parts: string[] = [
    followerGateRuns
      ? 'Followers only'
      : config.entryGate === 'subscribers'
        ? 'Subscribers only'
        : 'Open to everyone',
  ]

  if (identityGuardsEnforced) {
    if (config.minFollowAgeMins > 0) parts.push(`following ${config.minFollowAgeMins}+ min`)
    if (config.minAccountAgeDays > 0) parts.push(`account ${config.minAccountAgeDays}+ days old`)
  }

  return parts.join(' · ')
}

/**
 * §2, rendered as the number the setup screen must show live: how much of the
 * announced window a viewer on this channel's delay actually gets, at a
 * five-second reaction time.
 *
 * "180s window · about 155s of real time for a viewer on a 20s delay" is the
 * whole of §2 in one line that moves while the streamer drags the slider, and
 * it is the single most useful thing that screen can say.
 */
export function usableWindowMs(config: GiveawayConfig): number {
  return Math.max(0, config.entryWindowMs - config.streamDelayMs - 5_000)
}
