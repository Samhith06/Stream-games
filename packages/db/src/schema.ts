/**
 * Drizzle schema mirroring migrations/0001_init.sql — §11.
 *
 * The SQL file is authoritative for DDL (indexes, partial uniques, extensions);
 * this file exists for typed queries. Keep them in step.
 */

import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { ChatPolicy } from '@streamarena/shared'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  kickUserId: text('kick_user_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const oauthTokens = pgTable('oauth_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Ciphertext. Never store either token in the clear (§12). */
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  scopes: text('scopes').array().notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    broadcasterUserId: text('broadcaster_user_id').notNull().unique(),
    slug: text('slug').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channels_owner_idx').on(t.ownerUserId)],
)

export const gameSessions = pgTable(
  'game_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    gameId: text('game_id').notNull(),
    stateVersion: integer('state_version').notNull(),
    seed: text('seed').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    chatPolicy: jsonb('chat_policy').$type<Partial<ChatPolicy>>().notNull().default({}),
    status: text('status', { enum: ['created', 'running', 'ended', 'abandoned'] })
      .notNull()
      .default('created'),
    phase: text('phase'),
    overlayToken: text('overlay_token').notNull().unique(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('game_sessions_channel_idx').on(t.channelId, t.createdAt)],
)

export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    kickMessageId: text('kick_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('session_events_seq_unique').on(t.sessionId, t.seq),
    index('session_events_replay_idx').on(t.sessionId, t.seq),
  ],
)

export const sessionSnapshots = pgTable(
  'session_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    stateVersion: integer('state_version').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('session_snapshots_seq_unique').on(t.sessionId, t.seq)],
)

export const gameConfigs = pgTable(
  'game_configs',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    gameId: text('game_id').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Keyword overrides, keyed by CommandSpec.id. */
    commands: jsonb('commands').$type<Record<string, string[]>>().notNull().default({}),
    chatPolicy: jsonb('chat_policy').$type<Partial<ChatPolicy>>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.gameId] })],
)

export const slots = pgTable(
  'slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    normalised: text('normalised').notNull(),
    provider: text('provider'),
    rtp: numeric('rtp', { precision: 5, scale: 2 }),
    maxWin: integer('max_win'),
    volatility: text('volatility'),
    thumbnail: text('thumbnail'),
    isCustom: boolean('is_custom').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('slots_provider_idx').on(t.provider)],
)

export const slotAliases = pgTable(
  'slot_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slotId: uuid('slot_id')
      .notNull()
      .references(() => slots.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    normalised: text('normalised').notNull(),
    source: text('source', { enum: ['manual', 'learned'] })
      .notNull()
      .default('manual'),
    weight: real('weight').notNull().default(1),
    hitCount: integer('hit_count').notNull().default(0),
    approved: boolean('approved').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('slot_aliases_unique').on(t.normalised, t.slotId)],
)

export const webhookQuotaDaily = pgTable(
  'webhook_quota_daily',
  {
    day: date('day').notNull(),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'cascade' }),
    deliveries: bigint('deliveries', { mode: 'number' }).notNull().default(0),
    commands: bigint('commands', { mode: 'number' }).notNull().default(0),
    dropped: bigint('dropped', { mode: 'number' }).notNull().default(0),
    chatWrites: bigint('chat_writes', { mode: 'number' }).notNull().default(0),
    chatFailures: bigint('chat_failures', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.channelId] })],
)

export const kickSubscriptions = pgTable(
  'kick_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => gameSessions.id, { onDelete: 'set null' }),
    kickSubscriptionId: text('kick_subscription_id').notNull(),
    eventType: text('event_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('kick_subscriptions_remote_unique').on(t.kickSubscriptionId)],
)

export type UserRow = typeof users.$inferSelect
export type ChannelRow = typeof channels.$inferSelect
export type OauthTokenRow = typeof oauthTokens.$inferSelect
export type GameSessionRow = typeof gameSessions.$inferSelect
export type SessionEventRow = typeof sessionEvents.$inferSelect
export type SessionSnapshotRow = typeof sessionSnapshots.$inferSelect
export type GameConfigRow = typeof gameConfigs.$inferSelect
export type SlotRow = typeof slots.$inferSelect
export type SlotAliasRow = typeof slotAliases.$inferSelect
export type KickSubscriptionRow = typeof kickSubscriptions.$inferSelect
