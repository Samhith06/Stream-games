/**
 * Slot Bingo — state and config (§10, §11).
 *
 * Scope note: the retry dial (§6.5) is not implemented yet. Its config lives
 * here and is validated, and the state carries the fields it will need —
 * `attempts`, `history`, `livesLeft`, `status` — so turning it on later is
 * filling in a reducer rather than reshaping the board. Everything else in the
 * spec assumes retries off, which is the default and the game built here.
 */

import { z } from 'zod'
import type { PoolMember as CorePoolMember } from '@streamarena/core'

export type BingoPhase =
  | 'joining'
  | 'draw'
  | 'placement'
  | 'pick'
  | 'buying'
  | 'result'
  | 'complete'

export type SquareTier = 'red' | 'green' | 'gold'

/** Same shape as Tournament's, deliberately — §4 reuses its joining rules whole. */
export interface PoolMember extends CorePoolMember {
  userId: string
  username: string
  role: string
  /** null while the catalog is still resolving what they typed. */
  slotId: string | null
  slotName: string | null
  provider: string | null
  thumbnail: string | null
  rawText: string
  joinedAtSeq: number
  suggestions: { slotId: string; name: string; provider: string | null; thumbnail: string | null }[]
}

export interface Attempt {
  seq: number
  round: number
  /** Who owned the square for this attempt — not necessarily the current owner. */
  userId: string | null
  username: string | null
  slotId: string | null
  slotName: string | null
  buyCost: number
  payout: number
  /** payout / buyCost. Computed, never entered (§6). */
  multiplier: number
  tier: SquareTier
  /** Paid for with a rebuy token rather than a life. §6.5.7 */
  rebuy: boolean
}

export interface Ownership {
  userId: string
  username: string
  slotId: string | null
  slotName: string | null
  claimedAtSeq: number
  via: 'draw' | 'unlock' | 'reentry'
  /** Set when this owner went red and the square reopened. Model B. */
  burnedAtSeq: number | null
}

export interface Square {
  /** 'C3' — column letter, row number. Stable id used everywhere. */
  id: string
  row: number
  col: number
  /** null while OPEN, and for HOUSE and free-centre squares. */
  userId: string | null
  username: string | null
  slotId: string | null
  slotName: string | null
  thumbnail: string | null
  owner: 'viewer' | 'house' | 'free' | 'open'
  source: 'reserved' | 'random' | 'unlock' | 'house'
  /** Set on held-back squares. Cleared when an unlock draw fills it. */
  unlockAfterPick: number | null
  claimedAtSeq: number | null

  /** Every bonus bought on this square. Length > 1 only with retries (§6.5). */
  attempts: Attempt[]
  /** Every viewer who has held it. Length > 1 only under Model B. Append-only. */
  history: Ownership[]
  /** §6.5. null while retries are off. */
  livesLeft: number | null
  status: 'unplayed' | 'wounded' | 'settled'
  /** Tier of the settling attempt. null until settled. */
  tier: SquareTier | null
  /** Streamer chose this square out of order. Badged openly (§6). */
  manualPick: boolean
}

export interface Line {
  id: string // 'row3' | 'col2' | 'diagA' | 'diagB'
  squareIds: string[]
  state: 'open' | 'oneAway' | 'dead' | 'complete'
  /** Sum of multipliers across settling attempts. The default board's score. */
  totalMultiplier: number
  /** Across EVERY attempt on the line, reds included. */
  totalPayout: number
  totalCost: number
  /** totalPayout − totalCost. Best-line score whenever retries are on (§8). */
  netScore: number
  attemptCount: number
  greenCount: number
}

export interface BingoWinner {
  userId: string
  username: string
  slotName: string | null
  squareId: string
}

export type DecidedBy =
  | 'bingo'
  | 'bestLine'
  | 'net'
  | 'payout'
  | 'greenCount'
  | 'attempts'
  | 'cost'
  | 'coinflip'
  | 'settledEarly'
  | 'capped'

export interface BingoState {
  phase: BingoPhase
  size: 3 | 5
  greenThresholdX: number
  bigWinThresholdX: number
  freeCentre: boolean

  /** §6.5. 0 = sudden death (default). null = Endless. */
  retriesPerSquare: number | null
  retryModel: 'square' | 'reentry'
  retrySlot: 'same' | 'reroll'
  burnPlayedSlots: boolean
  rebuyTokens: number
  rebuyTokensUsed: number
  suddenDeathAfterRound: number | null
  suddenDeathActive: boolean
  budgetCapCents: number | null
  maxBuys: number | null

  pool: PoolMember[]
  reservedUserIds: string[]
  drawCompleted: boolean

  /**
   * Waiting for a square: joined after the main draw, or knocked back into the
   * pool by a red under Model B. One pool, no distinction at draw time (§6.5.3).
   */
  standby: PoolMember[]
  /** True from session start until the last square unlocks (§3). */
  joinsOpen: boolean
  /** Pick numbers at which a held-back square opens, ascending. */
  unlockSchedule: number[]
  unlocksDone: number
  /** Seq at which the last unlock draw ran — scopes the next one's pool. */
  lastUnlockSeq: number | null

  squares: Square[]
  lines: Line[]

  /** Committed at draw time from the session seed. Never re-rolled (§5.1). */
  pickOrder: string[]
  pickCursor: number
  currentSquareId: string | null
  round: number
  roundOrder: string[]

  joinWindowEndsAt: number | null
  joinsClosed: boolean

  bingoLines: string[]
  winningLine: string | null
  winners: BingoWinner[]
  decidedBy: DecidedBy | null
  settledEarly: boolean

  lastStatusReplyAt: number | null
  /** One-away announcements already made, keyed by line id (§12). */
  announcedOneAway: string[]
}

export const JOIN_TIMER_ID = 'bingo-join-window'

export const bingoConfigSchema = z
  .object({
    size: z.union([z.literal(3), z.literal(5)]).default(5),

    /**
     * Squares held back from the main draw for late joiners (§5.2). 0 disables
     * late entry entirely, which on a session that runs for hours is a locked
     * door to everyone who tunes in after the first five minutes.
     */
    openSquares: z.number().int().min(0).max(5).default(3),

    greenThresholdX: z.number().positive().max(1000).default(1),
    bigWinThresholdX: z.number().positive().max(100_000).default(50),
    /** 5×5 only. Roughly doubles instant-bingo odds, ~5% → ~8% (§7). */
    freeCentre: z.boolean().default(false),

    /**
     * The streamer's typical bonus buy. Not a game rule — it exists so the
     * setup screen can answer "what does a full board cost?" before the session
     * rather than after square 14 (§11). The live projected-spend meter uses
     * real buys once there are any.
     */
    typicalBuy: z.number().min(0).max(1_000_000).default(100),
    currency: z.enum(['EUR', 'USD', 'GBP']).default('EUR'),

    joinGate: z.enum(['anyone', 'followers', 'subscribers']).default('anyone'),
    joinWindowMs: z.number().int().min(30_000).max(1_800_000).nullable().default(300_000),
    uniqueSlots: z.boolean().default(true),
    announceDraw: z.boolean().default(true),
    allowManualPick: z.boolean().default(true),
    allowSettleEarly: z.boolean().default(true),

    // §6.5 — the retry dial. Accepted and validated; not yet implemented.
    retriesPerSquare: z.number().int().min(0).max(5).nullable().default(0),
    retryModel: z.enum(['square', 'reentry']).default('reentry'),
    retrySlot: z.enum(['same', 'reroll']).default('same'),
    burnPlayedSlots: z.boolean().default(true),
    rebuyTokens: z.number().int().min(0).max(20).default(0),
    suddenDeathAfterRound: z.number().int().min(1).max(10).nullable().default(null),
    budgetCapCents: z.number().int().positive().nullable().default(null),
    maxBuys: z.number().int().positive().max(500).nullable().default(null),
  })
  .superRefine((config, ctx) => {
    /*
     * §11 — "must be refused, not warned about".
     *
     * An uncapped Endless 5×5 has no upper bound on what it costs, and a warning
     * is something a streamer clicks through at 9pm and regrets at 1am. The game
     * still ends with a cap; it just ends on the cap instead of on nothing.
     */
    if (config.retriesPerSquare === null && config.budgetCapCents === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['budgetCapCents'],
        message: 'Endless retries require a budget cap — an uncapped board has no upper bound on cost.',
      })
    }

    // A 3×3 has one line through most squares and no room to hold three back.
    if (config.size === 3 && config.openSquares > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['openSquares'],
        message: 'A 3×3 board holds back at most one square.',
      })
    }

    if (config.freeCentre && config.size !== 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freeCentre'],
        message: 'The free centre square is a 5×5 option.',
      })
    }

    // Gold is a louder green, so a threshold below it would colour every green
    // gold and the celebration would stop meaning anything.
    if (config.bigWinThresholdX <= config.greenThresholdX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bigWinThresholdX'],
        message: 'The big-win threshold must be above the green threshold.',
      })
    }
  })

export type BingoConfig = z.infer<typeof bingoConfigSchema>
