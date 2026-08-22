/**
 * Overlay and dashboard transport — §19.
 *
 * "On connect, the server sends a full snapshot; after that, patches. The client
 * tracks a sequence number and requests a resync on any gap. A silently
 * desynced overlay showing stale data on stream is the worst failure mode in
 * the product."
 *
 * Fan-out comes from Redis pub/sub, so it doesn't matter which web instance a
 * browser source happens to land on (§8).
 */

import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import {
  WS_CLIENT_TIMEOUT_MS,
  WS_HEARTBEAT_MS,
  type ClientFrame,
  type ServerFrame,
} from '@streamarena/shared'
import type { WebContext } from '../context.js'
import { readSession, SESSION_COOKIE } from '../plugins/session.js'
import { isAllowedSocketOrigin } from '../lib/origins.js'
import { rebuildProjection } from '../lib/rebuild.js'

export async function registerWebSocketRoutes(app: FastifyInstance, ctx: WebContext) {
  /**
   * The OBS browser source. Authenticated by the per-session overlay token —
   * never by a user cookie, because OBS has no login.
   */
  app.get('/ws/overlay/:token', { websocket: true }, async (socket, req) => {
    const { token } = req.params as { token: string }
    const session = await ctx.repos.sessions.byOverlayToken(token)

    if (!session) {
      send(socket, { t: 'error', code: 'unauthorized', message: 'Unknown overlay token' })
      socket.close()
      return
    }

    await attach(ctx, socket, session.id, 'overlay')
  })

  /** The dashboard's live view. Cookie-authenticated and gets the fuller state. */
  app.get('/ws/session/:id', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string }

    // WebSockets ignore CORS, so a cookie-authenticated socket has to check the
    // origin itself or any page on the internet could open one in the
    // streamer's browser and read the live session. The overlay socket needs no
    // such check: it authenticates with an unguessable per-session token rather
    // than a cookie, and OBS browser sources are not a reliable source of
    // `Origin` headers.
    if (!isAllowedSocketOrigin(ctx.env, req.headers.origin, req.headers.host)) {
      ctx.log.warn({ origin: req.headers.origin, sessionId: id }, 'rejected cross-origin socket')
      send(socket, { t: 'error', code: 'unauthorized', message: 'Origin not allowed' })
      socket.close()
      return
    }

    const payload = readSession(ctx.env.SESSION_SECRET, req.cookies[SESSION_COOKIE])

    if (!payload) {
      send(socket, { t: 'error', code: 'unauthorized', message: 'Not signed in' })
      socket.close()
      return
    }

    const session = await ctx.repos.sessions.byId(id)
    const channel = session ? await ctx.repos.channels.byId(session.channelId) : null
    if (!session || !channel || channel.ownerUserId !== payload.userId) {
      send(socket, { t: 'error', code: 'session_not_found', message: 'Session not found' })
      socket.close()
      return
    }

    await attach(ctx, socket, session.id, 'dashboard')
  })
}

async function attach(
  ctx: WebContext,
  socket: WebSocket,
  sessionId: string,
  view: 'overlay' | 'dashboard',
): Promise<void> {
  let alive = true
  let lastSeen = Date.now()

  const unsubscribe = await ctx.bus.subscribe(sessionId, (frame) => {
    if (!alive) return

    // One frame is published per event carrying both views. The overlay must
    // never receive the dashboard keys — they hold user ids (§19).
    if (frame.t === 'patch' && frame.dashboardPatch) {
      const { dashboardPatch, ...rest } = frame
      send(
        socket,
        view === 'dashboard'
          ? { ...rest, patch: { ...rest.patch, ...dashboardPatch } }
          : rest,
      )
      return
    }

    send(socket, frame)
  })

  const sendSnapshot = async () => {
    const snapshot = await buildSnapshot(ctx, sessionId, view)
    if (snapshot) send(socket, snapshot)
  }

  // A browser source that just (re)connected has no idea where it is, so the
  // first thing it always receives is a complete picture.
  await sendSnapshot()

  socket.on('message', (raw: Buffer) => {
    lastSeen = Date.now()
    let frame: ClientFrame
    try {
      frame = JSON.parse(raw.toString('utf8')) as ClientFrame
    } catch {
      return
    }

    if (frame.t === 'ping') {
      send(socket, { t: 'pong', serverTime: Date.now() })
      return
    }

    if (frame.t === 'resync') {
      // Always answer a resync with a full snapshot rather than the patches
      // since `haveSeq`: replaying a gap costs more than one state dump, and
      // getting it wrong is the failure mode §19 warns about.
      void sendSnapshot()
    }
  })

  // OBS browser sources drop constantly and don't always close cleanly, so a
  // heartbeat is how we notice a socket that's gone without saying so.
  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > WS_CLIENT_TIMEOUT_MS) {
      socket.terminate()
      return
    }
    send(socket, { t: 'pong', serverTime: Date.now() })
  }, WS_HEARTBEAT_MS)

  socket.on('pong', () => {
    lastSeen = Date.now()
  })

  const cleanup = () => {
    if (!alive) return
    alive = false
    clearInterval(heartbeat)
    unsubscribe()
  }

  socket.on('close', cleanup)
  socket.on('error', cleanup)
}

async function buildSnapshot(
  ctx: WebContext,
  sessionId: string,
  view: 'overlay' | 'dashboard',
): Promise<ServerFrame | null> {
  const session = await ctx.repos.sessions.byId(sessionId)
  if (!session) return null

  // The live path: the worker keeps the projection warm in Redis, so a
  // reconnect costs one GET rather than a replay of the whole log.
  const cached = view === 'overlay' ? await ctx.cache.projection(sessionId) : null
  const state = cached?.state ?? (await rebuildProjection(ctx, sessionId, view)) ?? {}

  return {
    t: 'snapshot',
    sessionId,
    gameId: session.gameId,
    status: session.status,
    seq: cached?.seq ?? Number(session.lastSeq),
    // The client resumes gap detection from here. Patches published while the
    // snapshot was in flight arrive with a higher frame and are applied on top.
    frame: await ctx.cache.currentFrame(sessionId),
    state: state as Record<string, unknown>,
    serverTime: Date.now(),
  }
}

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== socket.OPEN) return
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    // A send failure on a socket that's already going away is not worth logging
    // once per patch on a busy stream.
  }
}
