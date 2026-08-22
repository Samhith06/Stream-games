/**
 * A health endpoint for a process that otherwise has no HTTP surface.
 *
 * The worker consumes queues and talks to Kick; it serves nothing. That makes
 * it the harder of the two processes to tell apart from a wedged one — a worker
 * that has silently lost its Redis connection looks exactly like an idle
 * channel. Two consequences:
 *
 *   - the platform can restart it instead of leaving chat commands to pile up
 *   - one deploy config covers both services, because both answer /healthz
 *
 * Deliberately the smallest thing that can answer: `node:http` rather than
 * Fastify, no routing table, no logging of probe traffic.
 */

import { createServer, type Server } from 'node:http'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'

interface Options {
  port: number
  redis: Redis
  log: Logger
}

export function startHealthServer({ port, redis, log }: Options): Server {
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // Liveness: the process is up and the event loop is turning. Nothing more —
    // a liveness probe that checks dependencies restarts a healthy process
    // every time a dependency blips.
    if (req.url === '/healthz') return send(200, { ok: true, service: 'worker' })

    // Readiness: it can actually reach the thing it consumes from. A worker
    // that cannot talk to Redis will never pick up a job.
    if (req.url === '/readyz') {
      redis
        .ping()
        .then(() => send(200, { ok: true }))
        .catch((err: unknown) => send(503, { ok: false, error: String(err) }))
      return
    }

    send(404, { error: { code: 'not_found', message: 'No such route' } })
  })

  server.listen(port, '0.0.0.0', () => log.info({ port }, 'worker health endpoint listening'))
  // A failure to bind must not take the worker down: it would still be
  // processing jobs perfectly well, and losing the probe is the lesser problem.
  server.on('error', (err) => log.error({ err: String(err) }, 'health server error'))

  return server
}
