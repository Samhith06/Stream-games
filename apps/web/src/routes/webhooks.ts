/**
 * Step 1 of the pipeline (§10).
 *
 *   POST /webhooks/kick
 *     verify Kick signature against their public key
 *     check Kick-Event-Message-Id in Redis (24h TTL) -> drop dupes
 *     enqueue raw payload to BullMQ
 *     return 200  (target <50ms, hard ceiling 2s)
 *
 * §12: "Return 200 fast and unconditionally on any valid payload — a 500
 * triggers redelivery and burns quota twice." Given the inbound cap is the
 * binding constraint on the whole platform (§6.3), a redelivery we caused
 * ourselves is the most expensive kind of bug there is.
 */

import type { FastifyInstance } from 'fastify'
import { claimDelivery } from '@streamarena/platform'
import { readHeaders, verifySignature } from '@streamarena/kick'
import type { WebContext } from '../context.js'

export async function registerWebhookRoutes(app: FastifyInstance, ctx: WebContext) {
  app.post('/webhooks/kick', async (req, reply) => {
    const started = process.hrtime.bigint()

    const headers = readHeaders(req.headers as Record<string, string | string[] | undefined>)
    if (!headers) {
      // Malformed enough that retrying can't help. 400 tells Kick to stop.
      return reply.code(400).send({ error: 'missing Kick event headers' })
    }

    // `rawBody` is captured by the content-type parser in server.ts. The bytes
    // matter: re-serialising the JSON would change them and break the signature.
    const raw = (req as { rawBody?: Buffer }).rawBody ?? Buffer.from('')

    const key = await ctx.publicKeys.get()
    const verified = verifySignature(key, headers, raw, {
      allowUnsigned: ctx.env.KICK_WEBHOOK_ALLOW_UNSIGNED,
    })

    if (!verified.ok) {
      if (verified.reason === 'bad_signature' || verified.reason === 'no_public_key') {
        // Kick may have rotated its signing key. Refresh at most once a minute,
        // then let the retry succeed rather than rejecting everything forever.
        await ctx.publicKeys.invalidate()
      }
      ctx.log.warn({ reason: verified.reason }, 'rejected webhook')
      return reply.code(401).send({ error: verified.reason })
    }

    // Idempotency. Kick retries; the same message id must never be enqueued
    // twice, and the event log's unique index is the second line of defence.
    const fresh = await claimDelivery(ctx.redis, headers.messageId)
    if (!fresh) {
      return reply.code(200).send({ ok: true, duplicate: true })
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' })
    }

    await ctx.queues.ingest.add(
      'kick',
      {
        kind: 'kick',
        eventType: headers.eventType,
        kickMessageId: headers.messageId,
        payload,
        receivedAt: Date.now(),
      },
      // Deliveries are cheap and numerous; keeping failed ones around for a day
      // is enough to diagnose a bad night without filling Redis.
      { removeOnComplete: { count: 100 }, attempts: 2 },
    )

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    if (elapsedMs > 200) {
      ctx.log.warn({ elapsedMs, eventType: headers.eventType }, 'slow webhook ingest')
    }

    return reply.code(200).send({ ok: true })
  })
}
