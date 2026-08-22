/**
 * Dashboard sessions.
 *
 * A signed, HTTP-only cookie holding the user id and nothing else. Stateless by
 * design: the alternative is a session table that has to be consulted on every
 * request in a process whose whole job is staying responsive (§8).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { WebContext } from '../context.js'

export const SESSION_COOKIE = 'sa_session'
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

interface SessionPayload {
  userId: string
  /** Issued-at, so a cookie can expire server-side even if the browser keeps it. */
  iat: number
}

export function signSession(secret: string, userId: string): string {
  const payload: SessionPayload = { userId, iat: Date.now() }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${hmac(secret, body)}`
}

export function readSession(secret: string, cookie: string | undefined): SessionPayload | null {
  if (!cookie) return null
  const [body, signature] = cookie.split('.')
  if (!body || !signature) return null

  const expected = hmac(secret, body)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (typeof payload.userId !== 'string') return null
    if (Date.now() - payload.iat > MAX_AGE_SECONDS * 1000) return null
    return payload
  } catch {
    return null
  }
}

function hmac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

export function setSessionCookie(reply: FastifyReply, ctx: WebContext, userId: string): void {
  reply.setCookie(SESSION_COOKIE, signSession(ctx.env.SESSION_SECRET, userId), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_SECONDS,
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Not allowed') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export interface AuthedUser {
  id: string
  kickUserId: string
  displayName: string
  avatarUrl: string | null
  isAdmin: boolean
}

export async function requireUser(
  ctx: WebContext,
  req: FastifyRequest,
): Promise<AuthedUser> {
  const payload = readSession(ctx.env.SESSION_SECRET, req.cookies[SESSION_COOKIE])
  if (!payload) throw new UnauthorizedError()

  const user = await ctx.repos.users.byId(payload.userId)
  if (!user) throw new UnauthorizedError()

  return {
    id: user.id,
    kickUserId: user.kickUserId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    isAdmin: ctx.env.ADMIN_KICK_USER_IDS.includes(user.kickUserId),
  }
}

export async function requireAdmin(ctx: WebContext, req: FastifyRequest): Promise<AuthedUser> {
  const user = await requireUser(ctx, req)
  if (!user.isAdmin) throw new ForbiddenError('Admin only')
  return user
}

/**
 * A session the caller actually owns. Every session route goes through this —
 * a session id in a URL must never be enough to drive someone else's game.
 */
export async function requireOwnedSession(
  ctx: WebContext,
  req: FastifyRequest,
  sessionId: string,
) {
  const user = await requireUser(ctx, req)
  const session = await ctx.repos.sessions.byId(sessionId)
  if (!session) throw new NotFoundError('Session not found')

  const channel = await ctx.repos.channels.byId(session.channelId)
  if (!channel) throw new NotFoundError('Session not found')

  if (channel.ownerUserId !== user.id && !user.isAdmin) {
    // 404 rather than 403: whether a session id exists is not something an
    // unrelated user should be able to probe.
    throw new NotFoundError('Session not found')
  }

  return { user, session, channel }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}
