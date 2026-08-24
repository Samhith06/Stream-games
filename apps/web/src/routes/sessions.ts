/**
 * Session REST — the dashboard's control surface.
 *
 * Every mutation the streamer makes becomes a `control` event on the same
 * ingest queue chat commands use, so "close entries" and a viewer's `!sr` can
 * never be folded out of order (§10). This route never reduces anything itself.
 */

import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DEFAULT_CHAT_POLICY, type ChatPolicy } from '@streamarena/shared'
import { generateSeed } from '@streamarena/core'
import type { WebContext } from '../context.js'
import { NotFoundError, requireOwnedSession, requireUser } from '../plugins/session.js'
import { sessionSummary, summariseHistory } from '../lib/history.js'

/**
 * Per-field parse, keeping whatever the schema can supply on its own and
 * dropping only the fields that genuinely need input. Used when a whole-object
 * parse fails because the config isn't complete yet.
 */
function fieldDefaults(schema: unknown, saved: unknown): Record<string, unknown> {
  const source = (saved ?? {}) as Record<string, unknown>
  if (!(schema instanceof z.ZodObject)) return source

  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
    const parsed = field.safeParse(source[key])
    if (parsed.success) out[key] = parsed.data
  }
  return out
}

const chatPolicySchema = z
  .object({
    ackMode: z.enum(['off', 'errors', 'batched', 'all']),
    announceResults: z.boolean(),
    streamDelayMs: z.number().int().min(0).max(120_000),
  })
  .partial()

const createSchema = z.object({
  gameId: z.string().min(1),
  config: z.record(z.unknown()),
  chatPolicy: chatPolicySchema.optional(),
  /** Per-command keyword overrides, keyed by CommandSpec.id. */
  commands: z.record(z.array(z.string())).optional(),
  /** Persist this config as the channel default for next time. */
  saveAsDefault: z.boolean().optional(),
})

const controlSchema = z.object({
  action: z.string().min(1).max(64),
  payload: z.record(z.unknown()).default({}),
})

export async function registerSessionRoutes(app: FastifyInstance, ctx: WebContext) {
  /** The game catalog, including the "Soon" cards. */
  app.get('/api/games', async () => {
    const { COMING_SOON } = await import('@streamarena/platform')
    return {
      games: [
        ...ctx.registry.list().map((game) => ({
          id: game.id,
          displayName: game.displayName,
          tagline: game.tagline,
          status: 'available' as const,
          commands: game.commands
            .filter((c) => !c.operatorOnly)
            .map((c) => ({ id: c.id, keyword: c.keywords[0], description: c.description })),
        })),
        ...COMING_SOON.map((g) => ({ ...g, status: 'coming_soon' as const, commands: [] })),
      ],
    }
  })

  /** Default config for a game's setup screen: schema defaults <- saved config. */
  app.get('/api/games/:gameId/config', async (req) => {
    const { gameId } = req.params as { gameId: string }
    const user = await requireUser(ctx, req)
    const game = ctx.registry.require(gameId)
    const channel = await ctx.repos.channels.byOwner(user.id)

    const saved = channel ? await ctx.repos.configs.get(channel.id, gameId) : null
    // Parsing an empty object yields every default the schema declares, which is
    // exactly what an unconfigured setup form should show.
    const defaults = game.configSchema.safeParse(saved?.config ?? {})

    return {
      gameId,
      // A setup form is allowed to have required fields nobody has filled in
      // yet — Bonus Hunt's starting balance has no default on purpose, because
      // only the streamer knows it. A strict parse fails on that one field and
      // would take every other default down with it, leaving the form blank.
      config: defaults.success ? defaults.data : fieldDefaults(game.configSchema, saved?.config),
      commands: saved?.commands ?? {},
      chatPolicy: { ...DEFAULT_CHAT_POLICY, ...(saved?.chatPolicy ?? {}) },
    }
  })

  /** Create a session. It exists but isn't running until /start. */
  app.post('/api/sessions', async (req, reply) => {
    const user = await requireUser(ctx, req)
    const body = createSchema.parse(req.body)

    const channel = await ctx.repos.channels.byOwner(user.id)
    if (!channel) {
      return reply.code(409).send({
        error: { code: 'no_channel', message: 'Reconnect Kick so we can find your channel.' },
      })
    }

    if (!(await ctx.tokens.hasTokens(user.id))) {
      return reply.code(409).send({
        error: { code: 'kick_disconnected', message: 'Reconnect your Kick account to run a game.' },
      })
    }

    const game = ctx.registry.get(body.gameId)
    if (!game) return reply.code(404).send({ error: { code: 'unknown_game', message: 'No such game' } })

    const parsed = game.configSchema.safeParse(body.config)
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_config', message: 'Check the setup form', details: parsed.error.issues },
      })
    }

    // §6.3 — one session per channel at a time. More would mean holding
    // subscriptions we can't attribute and a chat command with two possible
    // meanings.
    const existing = await ctx.repos.sessions.activeForChannel(channel.id)
    if (existing) {
      return reply.code(409).send({
        error: {
          code: 'session_running',
          message: 'A session is already running on this channel.',
          // The game id travels with the error so the setup screen can say
          // WHICH session is in the way. "A session is already running" plus a
          // redirect reads as the wrong game having opened.
          details: { sessionId: existing.id, gameId: existing.gameId },
        },
      })
    }

    const session = await ctx.repos.sessions.create({
      channelId: channel.id,
      gameId: game.id,
      stateVersion: game.stateVersion,
      // §9 — every draw and coin flip derives from this, and it never changes.
      seed: generateSeed((n) => randomBytes(n)),
      config: parsed.data as Record<string, unknown>,
      chatPolicy: body.chatPolicy ?? {},
      overlayToken: randomBytes(24).toString('base64url'),
      createdBy: user.id,
    })

    if (body.saveAsDefault !== false) {
      await ctx.repos.configs.put({
        channelId: channel.id,
        gameId: game.id,
        config: parsed.data as Record<string, unknown>,
        commands: body.commands ?? {},
        chatPolicy: body.chatPolicy ?? {},
      })
    }

    return reply.code(201).send(await sessionDetail(ctx, session.id))
  })

  /** History list, with the filters the history screen offers. */
  app.get('/api/sessions', async (req) => {
    const user = await requireUser(ctx, req)
    const channel = await ctx.repos.channels.byOwner(user.id)
    if (!channel) return { sessions: [], summary: summariseHistory([]) }

    const query = req.query as { gameId?: string; result?: string; limit?: string }
    const rows = await ctx.repos.sessions.listForChannel(channel.id, Number(query.limit ?? 50))

    const enriched = await Promise.all(
      rows.map((row) => sessionSummary(ctx, row)),
    )

    const filtered = enriched.filter((s) => {
      if (query.gameId && query.gameId !== 'all' && s.gameId !== query.gameId) return false
      if (query.result === 'profit' && (s.profit ?? 0) <= 0) return false
      if (query.result === 'loss' && (s.profit ?? 0) >= 0) return false
      return true
    })

    return { sessions: filtered, summary: summariseHistory(enriched) }
  })

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string }
    await requireOwnedSession(ctx, req, id)
    return sessionDetail(ctx, id)
  })

  /** Starts the session: subscribes to Kick and emits session.started. */
  app.post('/api/sessions/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { session } = await requireOwnedSession(ctx, req, id)

    if (session.status === 'ended' || session.status === 'abandoned') {
      return reply.code(409).send({
        error: { code: 'session_finished', message: 'This session has already finished.' },
      })
    }

    await ctx.queues.ingest.add('start', { kind: 'start', sessionId: id, at: Date.now() })
    return reply.send({ ok: true })
  })

  /**
   * Every dashboard action — close entries, enter a win, run the draw, resolve
   * an unresolved slot — arrives here and becomes a control event.
   */
  app.post('/api/sessions/:id/control', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { user, session } = await requireOwnedSession(ctx, req, id)
    const body = controlSchema.parse(req.body)

    if (session.status !== 'running' && session.status !== 'created') {
      return reply.code(409).send({
        error: { code: 'session_finished', message: 'This session has already finished.' },
      })
    }

    await ctx.queues.ingest.add('control', {
      kind: 'control',
      sessionId: id,
      action: body.action,
      payload: body.payload,
      actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
      at: Date.now(),
    })

    return reply.send({ ok: true })
  })

  app.post('/api/sessions/:id/end', async (req, reply) => {
    const { id } = req.params as { id: string }
    await requireOwnedSession(ctx, req, id)
    const body = z.object({ reason: z.enum(['complete', 'abandoned']).default('complete') }).parse(
      req.body ?? {},
    )

    await ctx.queues.ingest.add('end', {
      kind: 'end',
      sessionId: id,
      reason: body.reason,
      at: Date.now(),
    })
    return reply.send({ ok: true })
  })

  /**
   * §25 — per-session overlay tokens exist so a leaked browser-source URL can
   * be revoked without touching the streamer's Kick credentials.
   */
  app.post('/api/sessions/:id/overlay-token', async (req) => {
    const { id } = req.params as { id: string }
    await requireOwnedSession(ctx, req, id)

    const token = randomBytes(24).toString('base64url')
    await ctx.repos.db.execute(
      // Kept as a direct statement: rotating a token is the one write that must
      // not go through a cached repository read.
      (await import('drizzle-orm')).sql`
        UPDATE game_sessions SET overlay_token = ${token} WHERE id = ${id}::uuid
      `,
    )
    return { overlayUrl: overlayUrl(ctx, token) }
  })

  /** Export CSV — the results screen's "Export CSV". */
  app.get('/api/sessions/:id/export.csv', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { session } = await requireOwnedSession(ctx, req, id)

    const state = await stateFor(ctx, id)
    const entries = (state?.entries ?? []) as Record<string, unknown>[]

    const header = 'order,slot,provider,requested_by,bet,win,multiplier,status'
    const rows = entries.map((e) =>
      [
        e.order,
        csv(String(e.slotName ?? '')),
        csv(String(e.provider ?? '')),
        csv(String(e.requestedBy ?? '')),
        e.bet ?? '',
        e.win ?? '',
        e.multiplier ?? '',
        e.status ?? '',
      ].join(','),
    )

    reply.header('content-type', 'text/csv; charset=utf-8')
    reply.header(
      'content-disposition',
      `attachment; filename="streamarena-${session.gameId}-${id.slice(0, 8)}.csv"`,
    )
    return [header, ...rows].join('\n')
  })
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function overlayUrl(ctx: WebContext, token: string): string {
  return `${ctx.env.PUBLIC_BASE_URL}/overlay/${token}`
}

/**
 * The dashboard projection. Read from the Redis cache when the session is live;
 * rebuilt from the log for a finished one, which is also what makes a session
 * from six months ago still openable.
 */
export async function stateFor(
  ctx: WebContext,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const cached = await ctx.cache.projection(sessionId)
  if (cached) return cached.state as Record<string, unknown>

  const { rebuildProjection } = await import('../lib/rebuild.js')
  return rebuildProjection(ctx, sessionId)
}

async function sessionDetail(ctx: WebContext, sessionId: string) {
  const session = await ctx.repos.sessions.byId(sessionId)
  if (!session) throw new NotFoundError('Session not found')

  const state = await stateFor(ctx, sessionId)
  const policy: ChatPolicy = { ...DEFAULT_CHAT_POLICY, ...(session.chatPolicy ?? {}) }

  return {
    id: session.id,
    gameId: session.gameId,
    channelId: session.channelId,
    status: session.status,
    phase: session.phase,
    seq: Number(session.lastSeq),
    config: session.config,
    chatPolicy: policy,
    state: state ?? {},
    overlayUrl: overlayUrl(ctx, session.overlayToken),
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
  }
}

const csv = (value: string) =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
