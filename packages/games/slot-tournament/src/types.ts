import { z } from 'zod'

/** §14 — JOINING -> DRAW -> SEEDING -> [VOTING -> PLAYING -> ADVANCE] x n -> COMPLETE. */
export type TournamentPhase =
  | 'joining'
  | 'draw'
  | 'seeding'
  | 'voting'
  | 'playing'
  | 'complete'

export interface PoolMember {
  userId: string
  username: string
  role: string
  /** null while the catalog is still resolving what they typed. */
  slotId: string | null
  slotName: string | null
  provider: string | null
  rawText: string
  joinedAtSeq: number
  suggestions: {
    slotId: string
    name: string
    provider: string | null
    thumbnail: string | null
    confidence: number
  }[]
}

export interface Entrant {
  /** Stable across the whole bracket. Derived from the seat, never random. */
  id: string
  userId: string
  username: string
  slotId: string | null
  slotName: string
  seedNumber: number
  /** §14 — labelled openly with a "Streamer's pick" badge. */
  source: 'reserved' | 'random'
  hasBye: boolean
}

export interface MatchSide {
  entrantId: string
  username: string
  slotName: string
  buyCost: number | null
  payout: number | null
  /** payout / buyCost, computed — never entered. */
  multiplier: number | null
}

/** §14 — always state on screen how a tiebreak was decided. */
export type DecidedBy = 'multiplier' | 'payout' | 'cost' | 'coinflip' | 'bye'

export interface Match {
  id: string
  roundIndex: number
  matchIndex: number
  a: MatchSide | null
  b: MatchSide | null | 'bye'
  winner: 'a' | 'b' | null
  decidedBy: DecidedBy | null
  /** userId -> 'a' | 'b'. Locked at match start. */
  votes: Record<string, 'a' | 'b'>
  /** Usernames captured at vote time — Kick usernames change (§15.5). */
  voterNames: Record<string, string>
  votingEndsAt: number | null
  status: 'pending' | 'voting' | 'playing' | 'decided'
}

export interface Round {
  roundIndex: number
  matches: Match[]
}

export interface TournamentState {
  phase: TournamentPhase
  seats: number
  bracketSize: number

  pool: PoolMember[]
  /** Hand-picked by the streamer before the draw runs (§14). */
  reservedUserIds: string[]
  entrants: Entrant[]
  rounds: Round[]

  currentMatch: { roundIndex: number; matchIndex: number } | null
  joinWindowEndsAt: number | null
  joinsClosed: boolean

  /**
   * §16.5 — per-viewer correct/total. Always rebuilt from the decided matches
   * rather than incremented, so a reverted match can't leave a stale tally.
   */
  scores: Record<string, { username: string; correct: number; total: number; firstSeenSeq: number }>
  /** Sequence at which each viewer first voted — the leaderboard's last tiebreak. */
  voterFirstSeen: Record<string, number>

  champion: { userId: string; username: string; slotName: string } | null
  topPredictor: { userId: string; username: string; correct: number; total: number } | null

  /** §14 — the draw runs once and cannot be re-rolled. */
  drawCompleted: boolean
  lastStatusReplyAt: number | null
}

export const tournamentConfigSchema = z.object({
  seats: z.union([z.literal(8), z.literal(12), z.literal(16)]).default(16),

  /** §14 — winner is the higher multiplier, payout / buy cost. */
  metric: z.literal('multiplier').default('multiplier'),

  /** §14 — default 60 seconds with a manual override. */
  votingWindowMs: z.number().int().min(10_000).max(600_000).default(60_000),

  joinGate: z.enum(['anyone', 'followers', 'subscribers']).default('anyone'),
  /** null means manual close only. Default 5 minutes. */
  joinWindowMs: z.number().int().min(30_000).max(3_600_000).nullable().default(300_000),

  /** §14 — slots are unique, first come first served. */
  uniqueSlots: z.boolean().default(true),

  /** Announce the locked-in bracket to chat. On by default (§15.4). */
  announceDraw: z.boolean().default(true),
})

export type TournamentConfig = z.infer<typeof tournamentConfigSchema>

export interface LookupThen {
  kind: 'pool'
  userId: string
}

export type TournamentTimer =
  | { kind: 'joinWindowEnd' }
  | { kind: 'votingEnd'; matchId: string }

export const JOIN_TIMER_ID = 'join-window'
export const VOTE_TIMER_ID = 'voting-window'
