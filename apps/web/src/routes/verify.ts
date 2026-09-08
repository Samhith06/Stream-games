/**
 * The verification record — Giveaways §3.
 *
 * "Publish a verification page. A permanent, linkable page per completed
 * giveaway showing the hash, the seed, the ordered entry list, and the
 * resulting order, with the draw function's algorithm stated in plain terms
 * next to it. This costs a template and it turns 'prove it' into a URL."
 *
 * §18 calls it the highest trust-per-hour item in the whole specification, and
 * the reason is that it is a template over data that is already stored: the
 * seed is on the session row, the entry list and the order are in the log, and
 * replaying the log is something the platform does anyway.
 *
 * **Three properties this route has to hold, and each is a decision:**
 *
 * It is **public and unauthenticated**, because a page only the streamer can
 * open proves nothing to the chat that is accusing them. The session id is a
 * UUID, so a link is unguessable until the streamer shares it, and everything
 * behind it was designed to be published.
 *
 * It **refuses to serve a session that is still running**. Publishing the seed
 * before the draw would let anyone holding the entry list compute the winner in
 * advance, which is the entire thing the commitment exists to prevent.
 *
 * It **states the algorithm rather than linking to it**. A verifier who has to
 * read the source to check the arithmetic will not check the arithmetic.
 */

import type { FastifyInstance } from 'fastify'
import type { WebContext } from '../context.js'
import { rebuildProjection } from '../lib/rebuild.js'

/**
 * The draw, in the terms a stranger can reimplement it in.
 *
 * Deliberately prose plus four numbered steps rather than a code listing: the
 * audience for this is a viewer in chat who thinks the giveaway was rigged, and
 * the useful form of an argument for that reader is one they can follow in a
 * language they already use. It matches `commitDrawOrder` in
 * `packages/games/giveaways/src/draw.ts` line for line.
 */
const ALGORITHM = {
  summary:
    'The seed was fixed and its fingerprint published before the first entry was accepted. ' +
    'The order below is a pure function of that seed and the entry list — run it yourself and ' +
    'you get the same result, every time.',
  steps: [
    'Take the entrants in join order — the order they typed the keyword, which is the order listed below.',
    'For the entrant in position i (counting from 0), compute u = SHA-256("<seed>:<i>"), read the first 52 bits as an integer, and divide by 2^52. That gives a number between 0 and 1.',
    'Compute that entrant\'s key as k = u ^ (1 / weight). With flat weighting every weight is 1, so k is just u.',
    'Sort every entrant by k, largest first. Ties break on join order. That ranking is the result: position 1 is the winner, position 2 takes the prize if the winner does not claim it, and a session with three prizes awards positions 1, 2 and 3.',
  ],
  note:
    'Sorting on u^(1/weight) is the Efraimidis–Spirakis method: it is exactly equivalent to drawing ' +
    'names one at a time with probability proportional to weight and not putting them back. That is ' +
    'why one ranking covers the winner, every passover and every prize — the draw runs once, and a ' +
    'prize moving to the next name is a cursor advancing down a list that already existed.',
} as const

export async function registerVerifyRoutes(app: FastifyInstance, ctx: WebContext) {
  /**
   * The record itself. Public, and only for a giveaway that has finished.
   */
  app.get('/api/verify/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }

    const session = await ctx.repos.sessions.byId(sessionId)
    if (!session || session.gameId !== 'giveaways') {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'No giveaway with that id.' },
      })
    }

    const config = (session.config ?? {}) as Record<string, unknown>
    if (config.verificationPageEnabled === false || config.publishSeed === false) {
      return reply.code(404).send({
        error: {
          code: 'not_published',
          message: 'This giveaway was run with seed publication turned off.',
        },
      })
    }

    /*
     * Still running means still secret. The seed is the one thing in this
     * record that must not exist publicly before the draw has resolved, and
     * "the session ended" is the only signal that is true of every ending —
     * completed, abandoned, or stopped by a crash.
     */
    if (session.status !== 'ended' && session.status !== 'abandoned') {
      return reply.code(409).send({
        error: {
          code: 'session_running',
          message: 'This giveaway has not finished. The seed is published when it does.',
        },
      })
    }

    const state = await rebuildProjection(ctx, sessionId, 'overlay')
    if (!state) {
      return reply.code(409).send({
        error: {
          code: 'unreplayable',
          message:
            'This giveaway was recorded by an older version of the game and cannot be replayed. ' +
            'Its seed is still published below.',
          details: { seed: session.seed },
        },
      })
    }

    const channel = await ctx.repos.channels.byId(session.channelId)

    return {
      sessionId: session.id,
      channel: channel?.slug ?? null,
      /*
       * §3 — the two halves of the commitment, side by side. The fingerprint
       * was published at OPEN, before anyone had entered; the seed is published
       * here, after everything settled. Anyone can hash the one and check it
       * against the other.
       */
      seed: state.seed ?? session.seed,
      seedHash: state.seedHash ?? null,
      /** In join order, with the weight each entrant was frozen at. */
      entries: state.entryList ?? [],
      entryCount: Array.isArray(state.entryList) ? state.entryList.length : 0,
      /** The full ranking the draw produced. Position 1 is the winner. */
      order: state.drawOrder ?? null,
      prizes: state.prizes ?? [],
      /*
       * §8.3 — passovers are part of the record, openly. A verification page
       * that showed only the winners would hide the exact moment the product
       * most needs to be seen doing the honest thing.
       */
      awards: state.awards ?? [],
      passovers: state.passovers ?? [],
      claimRate: state.claimRate ?? null,
      /*
       * §3 — "a streamer who opens a giveaway, sees a name they dislike, and
       * abandons the session leaves a public row in history saying exactly
       * that." This is that row, and it is on the page the streamer shares to
       * prove the session was fair.
       */
      abandoned: session.status === 'abandoned',
      startedAt: session.startedAt?.toISOString() ?? null,
      endedAt: session.endedAt?.toISOString() ?? null,
      algorithm: ALGORITHM,
    }
  })

  /**
   * The entry list as a file — §9, "it exports".
   *
   * Public alongside the record, because an entry list a sceptic cannot
   * download is an entry list they have to take on trust, and re-running the
   * draw by hand is the whole point of publishing it.
   */
  app.get('/api/verify/:sessionId/entries.csv', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string }

    const session = await ctx.repos.sessions.byId(sessionId)
    if (!session || session.gameId !== 'giveaways') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No giveaway with that id.' } })
    }
    if (session.status !== 'ended' && session.status !== 'abandoned') {
      return reply
        .code(409)
        .send({ error: { code: 'session_running', message: 'This giveaway has not finished.' } })
    }

    const state = await rebuildProjection(ctx, sessionId, 'overlay')
    const entries = (state?.entryList ?? []) as { username: string; weight: number; seq: number }[]
    const order = (state?.drawOrder ?? null) as string[] | null

    // Join order is the order the commitment was made against, so it is the
    // order the file is in — a verifier reading it top to bottom is reading the
    // exact input to step 1 of the algorithm.
    const header = 'join_position,username,weight,final_rank'
    const rows = entries.map((e, i) => {
      const rank = order ? order.indexOf(e.username) : -1
      return [i, csv(e.username), e.weight, rank >= 0 ? rank + 1 : ''].join(',')
    })

    reply.header('content-type', 'text/csv; charset=utf-8')
    reply.header(
      'content-disposition',
      `attachment; filename="giveaway-${sessionId.slice(0, 8)}-entries.csv"`,
    )
    return [header, ...rows].join('\n')
  })
}

const csv = (value: string) =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
