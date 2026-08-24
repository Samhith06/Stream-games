/**
 * Team Battles — state and config (§14, §15).
 *
 * Two things in here are load-bearing and easy to mistake for detail.
 *
 * The **flip sequence** is committed at session creation and indexed by pick
 * number, not by person (§6.1). That is what makes "the flip is rigged"
 * answerable with a fact instead of a promise, and it is why the sequence can
 * exist before anyone has joined.
 *
 * The **win metric is an average**, not a total (§2). Coin-flipped team sizes
 * are lopsided far more often than intuition suggests — a ten-pick session is
 * 7–3 or worse a third of the time — and under a total the bigger team wins
 * 80% of the time. That would make the scoreboard a report on the coin flips.
 */

import { z } from 'zod'
import type { PoolMember as CorePoolMember } from '@streamarena/core'

export type BattlePhase =
  | 'joining'
  | 'pick'
  | 'flip'
  | 'buying'
  | 'result'
  | 'final'
  | 'complete'

/** There are exactly two teams, and §3 is explicit that this must not grow. */
export type TeamKey = 'A' | 'B'

/** Same shape as Tournament's and Bingo's — §5 reuses their joining rules whole. */
export interface PoolMember extends CorePoolMember {
  userId: string
  username: string
  role: string
  /** null while the catalog is still resolving what they typed. */
  slotId: string | null
  slotName: string | null
  provider: string | null
  thumbnail: string | null
  /** Buy cost in bet multiples — §10. Null means the catalog doesn't know. */
  buyCostX: number | null
  rawText: string
  joinedAtSeq: number
  suggestions: { slotId: string; name: string; provider: string | null; thumbnail: string | null }[]
}

export interface TeamIdentity {
  key: TeamKey
  name: string
  colour: string
  emoji: string
}

export interface SideDeclaration {
  username: string
  team: TeamKey
  declaredAtSeq: number
  /**
   * Assigned by `autoSideOnJoin` rather than chosen in chat.
   *
   * Tracked because §6.4's callout — "@slotgoblin declared FORTUNE, the coin
   * says CHAOS" — is only a betrayal if they actually picked a side. Firing it
   * for a side the system handed out would turn the best recurring beat in the
   * game into noise on half of all picks.
   */
  auto: boolean
}

export interface Pick {
  /** 0-based, and the index into `flipSequence`. §6.1 */
  index: number
  userId: string
  username: string
  slotId: string | null
  slotName: string | null
  thumbnail: string | null
  /** Always equal to flipSequence[index]. Stored so a replay can be audited. */
  team: TeamKey
  /** What they had declared in chat, for the §6.4 callout. */
  declaredSide: TeamKey | null
  source: 'random' | 'reserved'

  buyCostCents: number | null
  payoutCents: number | null
  /** payout ÷ cost. Computed, never entered (§8.1). */
  multiplier: number | null

  /** Seeded, for animation playback only — the reducer never reads it. §6.3 */
  fakeOut: boolean
  vetoed: { atSeq: number; reason: string } | null
  revertedFrom: { buyCostCents: number; payoutCents: number } | null
  resolvedAtSeq: number | null
}

export type DecidedBy = 'average' | 'total' | 'best' | 'fewerPicks' | 'coinflip'

export interface Award {
  userId: string
  username: string
  slotName: string | null
  multiplier: number
}

export interface BattleResult {
  winner: TeamKey
  decidedBy: DecidedBy
  scoreA: number
  scoreB: number
  mvp: Award | null
  anchor: Award | null
  /** True when one team never got a pick at all — §16's shutout. */
  shutout: boolean
}

export interface BattleState {
  phase: BattlePhase
  joinsOpen: boolean

  teams: { A: TeamIdentity; B: TeamIdentity }

  /** Committed at session creation, length maxPicks + maxSuddenDeath. §6.1 */
  flipSequence: TeamKey[]
  flipSequenceHash: string
  /** Published only at COMPLETE, so the commitment can be checked after. */
  flipSequenceRevealed: boolean
  /** Seeded fake-out schedule, same length. Playback only. §6.3 */
  fakeOutSchedule: boolean[]

  pool: PoolMember[]
  reservedUserIds: string[]
  /** Viewers already drawn — kept so re-entry can be gated on §5's rules. */
  drawnUserIds: string[]

  /** userId → declaration. First one wins, permanently (§7). */
  sides: Record<string, SideDeclaration>
  sidesLocked: boolean
  /** Resolved from config at init — §7's halfway default needs `maxPicks`. */
  sideLockAtPick: number | null

  picks: Pick[]
  currentPickIndex: number | null
  suddenDeathPicks: number

  maxPicks: number
  /** §6.3 — carried on state so the overlay never has to read config. */
  animationMs: number
  /** Money formatting for the ledger. Same reason: no config on the client. */
  currency: string
  joinWindowEndsAt: number | null
  poolCapReached: boolean

  /** Which team was ahead when we last said so — §12's deduped lead change. */
  lastLeader: TeamKey | null
  lastLeadChangeAt: number | null
  lastTeamsReplyAt: number | null

  result: BattleResult | null
}

export const JOIN_TIMER_ID = 'battles-join-window'

/** §3 — colour-checked pairs a streamer can pick without re-doing the work. */
export const TEAM_PRESETS = {
  'chaos-fortune': {
    A: { name: 'Chaos', colour: '#B44BFF', emoji: '⚡' },
    B: { name: 'Fortune', colour: '#FFC53D', emoji: '🪙' },
  },
  'blaze-frost': {
    A: { name: 'Blaze', colour: '#FF4D2E', emoji: '🔥' },
    B: { name: 'Frost', colour: '#2EC4FF', emoji: '❄' },
  },
  'kraken-phoenix': {
    A: { name: 'Kraken', colour: '#7C3AED', emoji: '🦑' },
    B: { name: 'Phoenix', colour: '#F59E0B', emoji: '🔥' },
  },
  'high-low': {
    A: { name: 'High', colour: '#B44BFF', emoji: '⬆' },
    B: { name: 'Low', colour: '#FFC53D', emoji: '⬇' },
  },
} as const

export type TeamPreset = keyof typeof TEAM_PRESETS

export const battlesConfigSchema = z
  .object({
    /** §9.1 — declared before pick 1 so the session cannot be stopped on a lead. */
    maxPicks: z.number().int().min(8).max(25).default(10),

    teamPreset: z
      .enum(['chaos-fortune', 'blaze-frost', 'kraken-phoenix', 'high-low', 'custom'])
      .default('chaos-fortune'),
    teamAName: z.string().min(1).max(24).optional(),
    teamBName: z.string().min(1).max(24).optional(),
    teamAColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    teamBColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),

    /**
     * §2. `total` is offered but the setup screen must warn next to the control
     * that random team sizes hand it to the larger team ~80% of the time.
     */
    winMetric: z.enum(['average', 'total', 'trimmed']).default('average'),
    /** §2 — `bag` guarantees even teams and costs the final flip its suspense. */
    drawMode: z.enum(['coin', 'bag']).default('coin'),

    joinGate: z.enum(['anyone', 'followers', 'subscribers']).default('anyone'),
    joinWindowMs: z.number().int().min(30_000).max(1_800_000).nullable().default(300_000),
    uniqueSlots: z.boolean().default(true),
    /** §5 — uncapped by default; the entry rules do the anti-spam work. */
    poolCap: z.number().int().min(2).max(500).nullable().default(null),
    reentryAfterPicks: z.number().int().min(1).max(20).nullable().default(null),

    sideGate: z.enum(['anyone', 'followers', 'subscribers']).default('anyone'),
    /**
     * Put everyone who enters the pool on a side, if they haven't picked one.
     *
     * Off by default, because §7 is deliberate that nobody is auto-assigned:
     * allegiance is meant to be a choice a viewer lives with for two hours, and
     * that is what makes a comeback feel like anything. Worth turning on for a
     * channel where the crowd layer isn't catching on by itself — an assigned
     * side is still better than no side at all for the people who join, never
     * get drawn, and would otherwise have nothing to watch for.
     *
     * The assignment is seeded, so it replays identically, and it is marked
     * auto so it never triggers the §6.4 callout.
     */
    autoSideOnJoin: z.boolean().default(false),
    /** null means "never lock". Defaults to the halfway pick at parse time. */
    sideLockAtPick: z.number().int().min(1).max(25).nullable().default(null),

    // §10 — curation, applied at !join time so a rejection reaches the viewer.
    minBuyX: z.number().min(1).max(10_000).default(50),
    maxBuyX: z.number().min(1).max(10_000).default(500),
    minVolatility: z.enum(['low', 'medium', 'high']).nullable().default(null),
    blockedProviders: z.array(z.string().min(1)).max(100).default([]),
    blockedSlots: z.array(z.string().min(1)).max(500).default([]),
    /**
     * Whether an entry whose buy cost the catalog doesn't know is allowed in.
     *
     * Default is to allow. Almost nothing in the imported catalog carries buy
     * data yet, so refusing unknowns would reject nearly every !join and the
     * streamer would conclude the game is broken rather than that the catalog
     * is thin. A streamer who has curated their own list can turn it off.
     */
    allowUnknownBuyCost: z.boolean().default(true),

    /** §9.2 — bounded and automatic, so it can't become a discretionary extension. */
    suddenDeathThreshold: z.number().min(0).max(0.5).default(0.05),
    maxSuddenDeath: z.number().int().min(0).max(10).default(3),

    fakeOutRate: z.number().min(0).max(1).default(0.33),
    animationMs: z.number().int().min(1_000).max(15_000).default(5_500),
    publishFlipHash: z.boolean().default(true),
    showAnchor: z.boolean().default(true),
    announceLeadChange: z.boolean().default(true),

    /**
     * Not a game rule — it exists so the setup screen can answer "what does
     * this session cost?" before it starts rather than at pick nine (§9.1).
     */
    typicalBuy: z.number().min(0).max(1_000_000).default(200),
    currency: z.enum(['EUR', 'USD', 'GBP']).default('EUR'),
  })
  .superRefine((config, ctx) => {
    /*
     * §10 — "Set the bounds as a range, not a floor."
     *
     * A floor alone invites the opposite exploit: entering the most expensive
     * buy available so the streamer has to spend €800 on your pick. Bounded
     * both ways, per-pick exposure is known before the session starts, which is
     * also what makes §9.1's projected-spend figure honest.
     */
    if (config.maxBuyX <= config.minBuyX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxBuyX'],
        message: 'The maximum buy must be above the minimum — the bound is a range, not a floor.',
      })
    }

    if (config.teamPreset === 'custom' && (!config.teamAName || !config.teamBName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['teamAName'],
        message: 'Custom teams need both names.',
      })
    }

    // Two teams that look alike defeat the entire overlay, which is two colours
    // telling you who is winning (§3).
    if (
      config.teamAColour &&
      config.teamBColour &&
      config.teamAColour.toLowerCase() === config.teamBColour.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['teamBColour'],
        message: 'The two teams must not share a colour.',
      })
    }

    // Locking allegiance after the session ends is the same as never locking,
    // but it reads as a rule that exists — so say what it actually is.
    if (config.sideLockAtPick !== null && config.sideLockAtPick > config.maxPicks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sideLockAtPick'],
        message: 'Sides would lock after the last pick — use a lower number, or leave it unset.',
      })
    }
  })

export type BattlesConfig = z.infer<typeof battlesConfigSchema>

/** §7 — the default is the halfway pick, which needs `maxPicks` to compute. */
export function sideLockPick(config: BattlesConfig): number | null {
  if (config.sideLockAtPick !== null) return config.sideLockAtPick
  return Math.floor(config.maxPicks / 2)
}

/** Resolves the preset and any per-field overrides into the two identities. */
export function teamsFrom(config: BattlesConfig): { A: TeamIdentity; B: TeamIdentity } {
  const preset =
    config.teamPreset === 'custom'
      ? TEAM_PRESETS['chaos-fortune']
      : TEAM_PRESETS[config.teamPreset]

  return {
    A: {
      key: 'A',
      name: config.teamAName ?? preset.A.name,
      colour: config.teamAColour ?? preset.A.colour,
      emoji: preset.A.emoji,
    },
    B: {
      key: 'B',
      name: config.teamBName ?? preset.B.name,
      colour: config.teamBColour ?? preset.B.colour,
      emoji: preset.B.emoji,
    },
  }
}
