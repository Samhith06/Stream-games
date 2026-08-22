/**
 * Account and settings — the Settings screen's four tabs plus /api/me.
 */

import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DEFAULT_CHAT_POLICY } from '@streamarena/shared'
import type { WebContext } from '../context.js'
import { requireUser } from '../plugins/session.js'
import { overlayUrl } from './sessions.js'

const chatPolicySchema = z
  .object({
    ackMode: z.enum(['off', 'errors', 'batched', 'all']),
    announceResults: z.boolean(),
    /**
     * §15.3 — "How many seconds behind is your stream? We'll hold chat
     * announcements this long so they don't spoil your overlay."
     */
    streamDelayMs: z.number().int().min(0).max(120_000),
  })
  .partial()

export async function registerSettingsRoutes(app: FastifyInstance, ctx: WebContext) {
  app.get('/api/me', async (req) => {
    const user = await requireUser(ctx, req)
    const channel = await ctx.repos.channels.byOwner(user.id)
    const scopes = await ctx.tokens.scopes(user.id)

    const active = channel ? await ctx.repos.sessions.activeForChannel(channel.id) : null

    return {
      user: {
        id: user.id,
        kickUserId: user.kickUserId,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      channel: channel
        ? { id: channel.id, slug: channel.slug, broadcasterUserId: channel.broadcasterUserId }
        : null,
      isAdmin: user.isAdmin,
      kickConnected: scopes.length > 0,
      scopes,
      activeSession: active
        ? {
            id: active.id,
            gameId: active.gameId,
            phase: active.phase,
            startedAt: active.startedAt?.toISOString() ?? null,
          }
        : null,
    }
  })

  /** Chat bot + commands tabs, stored per channel per game. */
  app.get('/api/settings/:gameId', async (req) => {
    const { gameId } = req.params as { gameId: string }
    const user = await requireUser(ctx, req)
    const channel = await ctx.repos.channels.byOwner(user.id)
    const game = ctx.registry.require(gameId)
    const saved = channel ? await ctx.repos.configs.get(channel.id, gameId) : null

    return {
      gameId,
      chatPolicy: { ...DEFAULT_CHAT_POLICY, ...(saved?.chatPolicy ?? {}) },
      commands: game.commands.map((spec) => ({
        id: spec.id,
        description: spec.description,
        defaultKeywords: spec.keywords,
        keywords: saved?.commands?.[spec.id] ?? spec.keywords,
        gate: spec.gate,
        cooldownMs: spec.cooldownMs,
        operatorOnly: spec.operatorOnly ?? false,
      })),
      config: saved?.config ?? {},
    }
  })

  app.put('/api/settings/:gameId', async (req, reply) => {
    const { gameId } = req.params as { gameId: string }
    const user = await requireUser(ctx, req)
    const channel = await ctx.repos.channels.byOwner(user.id)
    if (!channel) {
      return reply.code(409).send({ error: { code: 'no_channel', message: 'Reconnect Kick first.' } })
    }

    const body = z
      .object({
        chatPolicy: chatPolicySchema.optional(),
        commands: z.record(z.array(z.string().min(1).max(24))).optional(),
        config: z.record(z.unknown()).optional(),
      })
      .parse(req.body)

    const game = ctx.registry.require(gameId)
    const existing = await ctx.repos.configs.get(channel.id, gameId)

    let config = existing?.config ?? {}
    if (body.config) {
      const parsed = game.configSchema.safeParse(body.config)
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'invalid_config', message: 'Check the form', details: parsed.error.issues },
        })
      }
      config = parsed.data as Record<string, unknown>
    }

    await ctx.repos.configs.put({
      channelId: channel.id,
      gameId,
      config,
      commands: body.commands ?? existing?.commands ?? {},
      chatPolicy: { ...(existing?.chatPolicy ?? {}), ...(body.chatPolicy ?? {}) },
    })

    // Settings changed mid-session apply to the NEXT session by design: a hunt
    // whose commands changed halfway through would be impossible to replay
    // honestly, and viewers who learned !sr shouldn't lose it mid-game.
    return reply.send({ ok: true, appliesTo: 'next_session' })
  })

  /**
   * Overlay tab. The URL is a bearer credential for the session's state, so
   * regenerating it is the revoke button (§25).
   */
  app.post('/api/settings/overlay/regenerate', async (req, reply) => {
    const user = await requireUser(ctx, req)
    const channel = await ctx.repos.channels.byOwner(user.id)
    if (!channel) {
      return reply.code(409).send({ error: { code: 'no_channel', message: 'Reconnect Kick first.' } })
    }

    const active = await ctx.repos.sessions.activeForChannel(channel.id)
    if (!active) {
      return reply.code(409).send({
        error: {
          code: 'no_session',
          message: 'Overlay URLs are per session — start a game to get one.',
        },
      })
    }

    const token = randomBytes(24).toString('base64url')
    await ctx.repos.db.execute(
      sql`UPDATE game_sessions SET overlay_token = ${token} WHERE id = ${active.id}::uuid`,
    )
    return reply.send({ overlayUrl: overlayUrl(ctx, token) })
  })

  /**
   * Danger zone. Deleting a user cascades to their channels, sessions and event
   * log — which is the point: "delete my account" has to mean it.
   */
  app.delete('/api/settings/account', async (req, reply) => {
    const user = await requireUser(ctx, req)
    const body = z.object({ confirm: z.literal(true) }).safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'confirm_required', message: 'Send { "confirm": true } to delete.' },
      })
    }

    const channel = await ctx.repos.channels.byOwner(user.id)
    if (channel) {
      const active = await ctx.repos.sessions.activeForChannel(channel.id)
      if (active) {
        // Deleting mid-session would strand a live Kick subscription with no
        // owner token left to remove it — the one thing §6.3 forbids.
        return reply.code(409).send({
          error: { code: 'session_running', message: 'End your running session first.' },
        })
      }
    }

    await ctx.tokens.disconnect(user.id).catch(() => {})
    await ctx.repos.db.execute(sql`DELETE FROM users WHERE id = ${user.id}::uuid`)
    ctx.log.warn({ userId: user.id }, 'account deleted at user request')

    return reply.send({ ok: true })
  })

  app.delete('/api/settings/history', async (req, reply) => {
    const user = await requireUser(ctx, req)
    const channel = await ctx.repos.channels.byOwner(user.id)
    if (!channel) return reply.send({ ok: true, deleted: 0 })

    const result = await ctx.repos.db.execute(sql`
      DELETE FROM game_sessions
      WHERE channel_id = ${channel.id}::uuid
        AND status IN ('ended', 'abandoned')
    `)
    return reply.send({ ok: true, deleted: (result as unknown as { count?: number }).count ?? 0 })
  })
}
