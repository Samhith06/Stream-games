import { z } from 'zod'
import type { Currency } from '@streamarena/shared'

/** §13 — COLLECTING -> GUESSING -> OPENING -> COMPLETE. */
export type HuntPhase = 'collecting' | 'guessing' | 'opening' | 'complete'

/**
 * §13 — the life of one entry.
 *
 *   pending    the catalog hasn't matched the name yet (unresolved queue)
 *   queued     matched, waiting for the streamer to actually play it
 *   collected  the streamer banked the bonus — this one counts
 *   opened     the win has been entered
 *
 * `queued` and `collected` are separate because a streamer can play a slot and
 * fail to trigger a bonus. Conflating them would mean the hunt claims bonuses it
 * never got, and would break the "one outstanding request at a time" rule, which
 * has to know whether a viewer's suggestion has been dealt with.
 */
export type EntryStatus = 'pending' | 'queued' | 'collected' | 'opened'

/**
 * How the bonus was entered. Recorded when the streamer banks it, because a
 * 100x from a regular bonus and a 100x from a bought super are not the same
 * result and chat will say so.
 */
export type BonusType = 'regular' | 'super' | 'five_scatter'

export interface SlotSuggestion {
  slotId: string
  name: string
  provider: string | null
  thumbnail: string | null
  confidence: number
}

export interface HuntEntry {
  id: string
  /** null while unresolved — the entry appears immediately and firms up (§9). */
  slotId: string | null
  slotName: string | null
  provider: string | null
  thumbnail: string | null
  /** What the viewer actually typed. Feeds the unresolved queue and the audit. */
  rawText: string
  requestedBy: { userId: string; username: string; role: string }
  /** The base bet the bonus was played at. The multiplier is win / bet. */
  bet: number
  /** null until the streamer banks it and says which kind it was. */
  bonusType: BonusType | null
  win: number | null
  status: EntryStatus
  order: number
  /** Top three catalog candidates, shown in the unresolved queue (§21). */
  suggestions: SlotSuggestion[]
}

export interface HuntGuess {
  userId: string
  username: string
  role: string
  amount: number
  /** Sequence, not wall clock — the tiebreak input for "earliest wins" (§13). */
  submittedAtSeq: number
  /** Wall clock, for the "2s ago" stamp on the live guess feed. */
  submittedAt: number
  /** True once this viewer has replaced an earlier guess. */
  edited: boolean
}

export interface HuntWinner {
  userId: string
  username: string
  amount: number
  difference: number
}

export interface BonusHuntState {
  phase: HuntPhase
  currency: Currency
  startBalance: number
  targetBonuses: number

  entries: HuntEntry[]
  guesses: HuntGuess[]

  guessWindowEndsAt: number | null
  guessesLocked: boolean

  /**
   * §13 — "spent is captured once, in the 'close entries' confirm dialog, which
   * asks 'What's your balance now?'". Null until collection closes.
   */
  balanceAtCloseOfCollection: number | null

  totals: { spent: number; won: number }
  winner: HuntWinner | null

  /** Set once at complete, so the result card and the log agree forever. */
  finalBalance: number | null
  /** Rate limiter for `!hunt` — one per 60s per channel (§13). */
  lastStatusReplyAt: number | null
}

export const bonusHuntConfigSchema = z.object({
  currency: z.enum(['EUR', 'USD', 'GBP']).default('EUR'),
  startBalance: z.number().positive().max(10_000_000),
  targetBonuses: z.number().int().min(1).max(200).default(20),

  /**
   * Guess the Balance can be switched off entirely — some streamers want a
   * plain hunt. Collection then closes straight into opening.
   */
  guessEnabled: z.boolean().default(true),

  /** §13 — default 3 minutes, with a manual lock override. */
  guessWindowMs: z.number().int().min(15_000).max(1_800_000).default(180_000),

  /**
   * Who may run `!sr`. 'moderators' is the setup screen's "Only me" — the
   * streamer builds the list themselves and chat just watches.
   */
  srGate: z.enum(['anyone', 'followers', 'subscribers', 'moderators']).default('anyone'),

  /**
   * How `maxEntriesPerViewer` is counted.
   *
   * `true`  — a lifetime cap. One slot each for the whole hunt, however it goes.
   * `false` — an outstanding cap. A viewer may request again once the streamer
   *           has dealt with their last one, by banking it or dropping it.
   *
   * Off by default: a channel with ten viewers cannot fill a thirty-bonus hunt
   * on one suggestion each, and the alternative — raising the cap outright —
   * lets one person take ten slots in the first minute.
   */
  oneEntryPerViewer: z.boolean().default(false),

  /** Entries a viewer may hold at once, or in total when the toggle is on. */
  maxEntriesPerViewer: z.number().int().min(1).max(10).default(1),
  /** Duplicate slots in the list are allowed — different bet sizes are normal. */
  allowDuplicateSlots: z.boolean().default(true),
  /** Cooldown between `!sr` attempts from one viewer. */
  requestCooldownMs: z.number().int().min(0).max(300_000).default(15_000),

  /**
   * §13 — "Reject above a sanity ceiling, default 100x starting balance —
   * otherwise someone guesses a billion for the meme and clutters the
   * distribution forever."
   */
  guessCeilingMultiple: z.number().min(2).max(1000).default(100),

  /** Absolute override for the ceiling, when the streamer types a figure. */
  guessCeiling: z.number().positive().nullable().default(null),

  /** Default bet applied to a newly banked bonus, editable per entry. */
  defaultBet: z.number().min(0).default(0),

  /** Stop accepting `!sr` once the list reaches targetBonuses. */
  closeCollectionAtTarget: z.boolean().default(false),
})

export type BonusHuntConfig = z.infer<typeof bonusHuntConfigSchema>

/** Continuation carried through a slot lookup and echoed back on resolution. */
export interface LookupThen {
  kind: 'entry'
  entryId: string
}

/** Timer payloads this game schedules. */
export type HuntTimer = { kind: 'guessWindowEnd' }

export const GUESS_TIMER_ID = 'guess-window'
