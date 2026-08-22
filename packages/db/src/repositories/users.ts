import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { channels, gameConfigs, kickSubscriptions, oauthTokens, users } from '../schema.js'
import type { ChannelRow, GameConfigRow, OauthTokenRow, UserRow } from '../schema.js'

export class UserRepository {
  constructor(private readonly db: Database) {}

  /** Login is idempotent: the same Kick account always lands on the same row. */
  async upsertByKickId(input: {
    kickUserId: string
    displayName: string
    avatarUrl?: string | null
    email?: string | null
  }): Promise<UserRow> {
    const [row] = await this.db
      .insert(users)
      .values(input)
      .onConflictDoUpdate({
        target: users.kickUserId,
        set: {
          displayName: input.displayName,
          avatarUrl: input.avatarUrl ?? null,
          updatedAt: sql`now()`,
        },
      })
      .returning()
    return row!
  }

  async byId(id: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    return row ?? null
  }

  async byKickId(kickUserId: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(users).where(eq(users.kickUserId, kickUserId)).limit(1)
    return row ?? null
  }
}

export class TokenRepository {
  constructor(private readonly db: Database) {}

  /** Both values must already be ciphertext — this layer never encrypts (§12). */
  async put(input: {
    userId: string
    accessToken: string
    refreshToken: string
    scopes: string[]
    expiresAt: Date
  }): Promise<void> {
    await this.db
      .insert(oauthTokens)
      .values(input)
      .onConflictDoUpdate({
        target: oauthTokens.userId,
        set: {
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          scopes: input.scopes,
          expiresAt: input.expiresAt,
          updatedAt: sql`now()`,
        },
      })
  }

  async byUserId(userId: string): Promise<OauthTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId))
      .limit(1)
    return row ?? null
  }

  async remove(userId: string): Promise<void> {
    await this.db.delete(oauthTokens).where(eq(oauthTokens.userId, userId))
  }
}

export class ChannelRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    broadcasterUserId: string
    slug: string
    ownerUserId: string
  }): Promise<ChannelRow> {
    const [row] = await this.db
      .insert(channels)
      .values(input)
      .onConflictDoUpdate({
        target: channels.broadcasterUserId,
        set: { slug: input.slug, ownerUserId: input.ownerUserId, updatedAt: sql`now()` },
      })
      .returning()
    return row!
  }

  async byId(id: string): Promise<ChannelRow | null> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, id)).limit(1)
    return row ?? null
  }

  async byBroadcasterUserId(broadcasterUserId: string): Promise<ChannelRow | null> {
    const [row] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.broadcasterUserId, broadcasterUserId))
      .limit(1)
    return row ?? null
  }

  async byOwner(ownerUserId: string): Promise<ChannelRow | null> {
    const [row] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.ownerUserId, ownerUserId))
      .limit(1)
    return row ?? null
  }

  async list(limit = 200): Promise<ChannelRow[]> {
    return this.db.select().from(channels).limit(limit)
  }
}

export class GameConfigRepository {
  constructor(private readonly db: Database) {}

  async get(channelId: string, gameId: string): Promise<GameConfigRow | null> {
    const [row] = await this.db
      .select()
      .from(gameConfigs)
      .where(and(eq(gameConfigs.channelId, channelId), eq(gameConfigs.gameId, gameId)))
      .limit(1)
    return row ?? null
  }

  async put(input: {
    channelId: string
    gameId: string
    config: Record<string, unknown>
    commands?: Record<string, string[]>
    chatPolicy?: Record<string, unknown>
  }): Promise<void> {
    await this.db
      .insert(gameConfigs)
      .values({
        channelId: input.channelId,
        gameId: input.gameId,
        config: input.config,
        commands: input.commands ?? {},
        chatPolicy: input.chatPolicy ?? {},
      })
      .onConflictDoUpdate({
        target: [gameConfigs.channelId, gameConfigs.gameId],
        set: {
          config: input.config,
          ...(input.commands ? { commands: input.commands } : {}),
          ...(input.chatPolicy ? { chatPolicy: input.chatPolicy } : {}),
          updatedAt: sql`now()`,
        },
      })
  }
}

/**
 * Session-scoped webhook subscriptions (§6.3). Never hold standing
 * subscriptions on idle channels — this table is what makes the boot-time
 * reconcile able to find and drop orphans from a crashed worker.
 */
export class SubscriptionRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    channelId: string
    sessionId: string | null
    kickSubscriptionId: string
    eventType: string
  }): Promise<void> {
    await this.db.insert(kickSubscriptions).values(input).onConflictDoNothing()
  }

  async activeForChannel(channelId: string) {
    return this.db
      .select()
      .from(kickSubscriptions)
      .where(and(eq(kickSubscriptions.channelId, channelId), isNull(kickSubscriptions.deletedAt)))
  }

  async allActive() {
    return this.db.select().from(kickSubscriptions).where(isNull(kickSubscriptions.deletedAt))
  }

  async markDeleted(kickSubscriptionId: string): Promise<void> {
    await this.db
      .update(kickSubscriptions)
      .set({ deletedAt: sql`now()` })
      .where(eq(kickSubscriptions.kickSubscriptionId, kickSubscriptionId))
  }
}
