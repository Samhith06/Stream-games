/** REST shapes shared by the dashboard, the admin panel and the overlay host. */

import type { SessionStatus } from './protocol.js'

export type Currency = 'EUR' | 'USD' | 'GBP'

export type AckMode = 'off' | 'errors' | 'batched' | 'all'

export type ViewerRole = 'viewer' | 'follower' | 'subscriber' | 'moderator' | 'broadcaster'

export type RoleGate = 'anyone' | 'followers' | 'subscribers' | 'moderators'

/** Per-channel chat policy — §15. Lives beside the session, not inside a game. */
export interface ChatPolicy {
  ackMode: AckMode
  announceResults: boolean
  /** §15.3 — held between overlay reveal and chat write, so we don't spoil it. */
  streamDelayMs: number
}

export const DEFAULT_CHAT_POLICY: ChatPolicy = {
  ackMode: 'errors',
  announceResults: true,
  streamDelayMs: 12_000,
}

export interface MeResponse {
  user: { id: string; kickUserId: string; displayName: string; avatarUrl: string | null }
  channel: { id: string; slug: string; broadcasterUserId: string } | null
  isAdmin: boolean
  kickConnected: boolean
  scopes: string[]
}

export interface GameSummary {
  id: string
  displayName: string
  tagline: string
  status: 'available' | 'coming_soon'
  tags: string[]
}

export interface SessionSummary {
  id: string
  gameId: string
  channelId: string
  status: SessionStatus
  phase: string | null
  startedAt: string | null
  endedAt: string | null
  participantCount: number
}

export interface SessionDetail extends SessionSummary {
  config: Record<string, unknown>
  state: Record<string, unknown>
  seq: number
  overlayUrl: string
  chatPolicy: ChatPolicy
}

export interface UnresolvedItem {
  entryId: string
  rawText: string
  requestedBy: { userId: string; username: string }
  suggestions: { slotId: string; name: string; provider: string | null; confidence: number }[]
}

export interface SlotDto {
  id: string
  name: string
  provider: string | null
  rtp: number | null
  maxWin: number | null
  volatility: string | null
  thumbnail: string | null
  aliasCount?: number
}

export interface QuotaDay {
  date: string
  channelId: string
  slug: string
  deliveries: number
  commands: number
  chatWrites: number
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown }
}
