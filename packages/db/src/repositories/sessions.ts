import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { ChatPolicy, SessionStatus } from '@streamarena/shared'
import { DEFAULT_CHAT_POLICY } from '@streamarena/shared'
import type { Database } from '../client.js'
import { channels, gameSessions } from '../schema.js'
import type { GameSessionRow } from '../schema.js'

export const ACTIVE_STATUSES = ['created', 'running'] as const

export interface CreateSessionInput {
  channelId: string
  gameId: string
  stateVersion: number
  seed: string
  config: Record<string, unknown>
  chatPolicy: Partial<ChatPolicy>
  overlayToken: string
  createdBy: string | null
}

export class SessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateSessionInput): Promise<GameSessionRow> {
    const [row] = await this.db.insert(gameSessions).values(input).returning()
    return row!
  }

  async byId(id: string): Promise<GameSessionRow | null> {
    const [row] = await this.db.select().from(gameSessions).where(eq(gameSessions.id, id)).limit(1)
    return row ?? null
  }

  /** The overlay authenticates with a per-session token, never a user session. */
  async byOverlayToken(token: string): Promise<GameSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.overlayToken, token))
      .limit(1)
    return row ?? null
  }

  /**
   * Step 3 of the pipeline. Redis answers this on the hot path; this is the
   * cold path and the boot-time reconcile.
   */
  async activeForChannel(channelId: string): Promise<GameSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(gameSessions)
      .where(
        and(eq(gameSessions.channelId, channelId), inArray(gameSessions.status, [...ACTIVE_STATUSES])),
      )
      .limit(1)
    return row ?? null
  }

  async activeByBroadcasterUserId(
    broadcasterUserId: string,
  ): Promise<{ session: GameSessionRow; channelId: string } | null> {
    const [row] = await this.db
      .select({ session: gameSessions, channelId: channels.id })
      .from(gameSessions)
      .innerJoin(channels, eq(channels.id, gameSessions.channelId))
      .where(
        and(
          eq(channels.broadcasterUserId, broadcasterUserId),
          inArray(gameSessions.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1)
    return row ?? null
  }

  /** Every session still holding a Kick subscription — the boot reconcile list. */
  async allActive(): Promise<GameSessionRow[]> {
    return this.db
      .select()
      .from(gameSessions)
      .where(inArray(gameSessions.status, [...ACTIVE_STATUSES]))
  }

  async listForChannel(channelId: string, limit = 50): Promise<GameSessionRow[]> {
    return this.db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.channelId, channelId))
      .orderBy(desc(gameSessions.createdAt))
      .limit(limit)
  }

  async markRunning(id: string): Promise<void> {
    await this.db
      .update(gameSessions)
      .set({ status: 'running', startedAt: sql`COALESCE(${gameSessions.startedAt}, now())` })
      .where(eq(gameSessions.id, id))
  }

  async setPhase(id: string, phase: string | null): Promise<void> {
    await this.db.update(gameSessions).set({ phase }).where(eq(gameSessions.id, id))
  }

  async end(id: string, status: Extract<SessionStatus, 'ended' | 'abandoned'>): Promise<void> {
    await this.db
      .update(gameSessions)
      .set({ status, endedAt: sql`now()` })
      .where(eq(gameSessions.id, id))
  }

  /** Effective policy = platform defaults <- channel settings <- session override. */
  static resolveChatPolicy(row: Pick<GameSessionRow, 'chatPolicy'>): ChatPolicy {
    return { ...DEFAULT_CHAT_POLICY, ...(row.chatPolicy ?? {}) }
  }
}
