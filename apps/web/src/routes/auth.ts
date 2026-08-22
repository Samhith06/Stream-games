/**
 * Kick OAuth 2.1 + PKCE — §6, §12.
 *
 * The PKCE verifier is held in Redis against the `state` value rather than in a
 * cookie, so a state parameter that didn't originate here can't complete a
 * flow, and nothing sensitive ever reaches the browser.
 */

import type { FastifyInstance } from 'fastify'
import { createPkcePair, createState } from '@streamarena/kick'
import type { WebContext } from '../context.js'
import { clearSessionCookie, requireUser, setSessionCookie } from '../plugins/session.js'

const STATE_TTL_SECONDS = 600
const stateKey = (state: string) => `oauth:state:${state}`

export async function registerAuthRoutes(app: FastifyInstance, ctx: WebContext) {
  app.get('/auth/kick', async (req, reply) => {
    if (!ctx.env.KICK_CLIENT_ID) {
      return reply.code(503).send({ error: 'Kick OAuth is not configured' })
    }

    const { verifier, challenge } = createPkcePair()
    const state = createState()
    const redirectTo = typeof (req.query as { next?: string }).next === 'string'
      ? (req.query as { next: string }).next
      : '/'

    await ctx.redis.set(
      stateKey(state),
      JSON.stringify({ verifier, redirectTo }),
      'EX',
      STATE_TTL_SECONDS,
    )

    return reply.redirect(ctx.auth.authorizeUrl({ state, challenge }))
  })

  app.get('/auth/kick/callback', async (req, reply) => {
    const query = req.query as { code?: string; state?: string; error?: string }

    if (query.error) {
      ctx.log.warn({ error: query.error }, 'kick returned an oauth error')
      return reply.redirect(`${ctx.env.PUBLIC_BASE_URL}/login?error=${encodeURIComponent(query.error)}`)
    }
    if (!query.code || !query.state) {
      return reply.code(400).send({ error: 'missing code or state' })
    }

    // Single-use: consuming the state here means a replayed callback URL is
    // worthless to anyone who captures it.
    const stored = await ctx.redis.getdel(stateKey(query.state))
    if (!stored) {
      return reply.code(400).send({ error: 'unknown or expired state' })
    }
    const { verifier, redirectTo } = JSON.parse(stored) as {
      verifier: string
      redirectTo: string
    }

    const tokens = await ctx.auth.exchangeCode(query.code, verifier)

    // Identify the streamer with the token we just received, before it's stored
    // against anyone — we don't know who this is until Kick tells us.
    const probe = ctx.tokens
    const tempClient = new (await import('@streamarena/kick')).KickClient({
      apiBase: ctx.env.KICK_API_BASE,
      getAccessToken: async () => tokens.accessToken,
    })

    const kickUser = await tempClient.currentUser()
    const user = await ctx.repos.users.upsertByKickId({
      kickUserId: kickUser.userId,
      displayName: kickUser.name,
      avatarUrl: kickUser.profilePicture,
      email: kickUser.email,
    })

    await probe.save(user.id, tokens)

    const kickChannel = await tempClient.currentChannel().catch(() => null)
    if (kickChannel) {
      await ctx.repos.channels.upsert({
        broadcasterUserId: kickChannel.broadcasterUserId,
        slug: kickChannel.slug,
        ownerUserId: user.id,
      })
    }

    setSessionCookie(reply, ctx, user.id)
    ctx.log.info({ userId: user.id, kickUserId: kickUser.userId }, 'streamer connected Kick')

    return reply.redirect(`${ctx.env.PUBLIC_BASE_URL}${redirectTo.startsWith('/') ? redirectTo : '/'}`)
  })

  app.post('/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply)
    return reply.send({ ok: true })
  })

  /**
   * "You can revoke access anytime" on the login screen has to be true from our
   * side too: this revokes the refresh token at Kick and deletes our copy.
   */
  app.post('/auth/disconnect', async (req, reply) => {
    const user = await requireUser(ctx, req)

    const channel = await ctx.repos.channels.byOwner(user.id)
    if (channel) {
      const active = await ctx.repos.sessions.activeForChannel(channel.id)
      if (active) {
        return reply.code(409).send({
          error: {
            code: 'session_running',
            message: 'End your running session before disconnecting Kick.',
          },
        })
      }
    }

    await ctx.tokens.disconnect(user.id)
    clearSessionCookie(reply)
    return reply.send({ ok: true })
  })
}
