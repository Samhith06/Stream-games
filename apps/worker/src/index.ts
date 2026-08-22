/**
 * The worker process — §8.
 *
 * "All game logic, all outbound Kick calls, all scheduled jobs." It holds no
 * HTTP surface and no sockets; it consumes queues and publishes to Redis.
 * Scale trigger: queue depth.
 */

import { Worker, type Job } from 'bullmq'
import { createRedis, QUEUE, QUEUE_PREFIX, type ChatJob, type IngestJob, type LookupJob, type MaintenanceJob, type TimerJob } from '@streamarena/platform'
import { createContext, type WorkerContext } from './context.js'
import { handleIngestJob } from './router.js'
import { handleChatJob } from './chat-sender.js'
import { handleLookupJob } from './lookup.js'
import { handleTimerJob } from './timers.js'
import { recoverActiveSessions } from './session-lifecycle.js'
import { flushQuota, sweepStaleSessions } from './maintenance.js'
import { startHealthServer } from './health.js'

const ctx = createContext()

// Each Worker needs its own blocking connection.
const connections = [1, 2, 3, 4, 5].map(() => createRedis(ctx.env.REDIS_URL))

const ingest = new Worker<IngestJob>(
  QUEUE.ingest,
  (job) => handleIngestJob(ctx, job.data),
  {
    connection: connections[0]!,
    prefix: QUEUE_PREFIX,
    // Sessions are serialised by their own lock, so concurrency here buys
    // parallelism across channels without risking interleaved folds.
    concurrency: 16,
  },
)

const chat = new Worker<ChatJob>(
  QUEUE.chat,
  (job) => handleChatJob(ctx, job.data, job.name),
  {
    connection: connections[1]!,
    prefix: QUEUE_PREFIX,
    // §15.5 — "Single outbound worker per channel." The token bucket is
    // per-channel and shared across instances, so modest concurrency here is
    // safe and keeps one slow channel from blocking every other one.
    concurrency: 4,
  },
)

const timers = new Worker<TimerJob>(QUEUE.timer, (job) => handleTimerJob(ctx, job.data), {
  connection: connections[2]!,
  prefix: QUEUE_PREFIX,
  concurrency: 8,
})

const lookups = new Worker<LookupJob>(QUEUE.lookup, (job) => handleLookupJob(ctx, job.data), {
  connection: connections[3]!,
  prefix: QUEUE_PREFIX,
  concurrency: 8,
})

const maintenance = new Worker<MaintenanceJob>(
  QUEUE.maintenance,
  async (job) => {
    switch (job.data.kind) {
      case 'reconcile-subscriptions':
        await ctx.subscriptions.reconcile()
        return
      case 'flush-quota':
        await flushQuota(ctx)
        return
      case 'sweep-stale-sessions':
        await sweepStaleSessions(ctx)
        return
    }
  },
  { connection: connections[4]!, prefix: QUEUE_PREFIX, concurrency: 1 },
)

const workers = [ingest, chat, timers, lookups, maintenance]

for (const worker of workers) {
  worker.on('failed', (job: Job | undefined, err: Error) => {
    ctx.log.error({ queue: worker.name, jobId: job?.id, err: err.message }, 'job failed')
  })
  worker.on('error', (err) => {
    ctx.log.error({ queue: worker.name, err: err.message }, 'worker error')
  })
}

async function boot(): Promise<void> {
  ctx.log.info({ games: ctx.registry.ids() }, 'worker starting')

  // §12 — reconcile on boot: list Kick's subscriptions and drop orphans from
  // crashed sessions, so a crash can't leave a channel burning quota all day.
  await ctx.subscriptions
    .reconcile()
    .catch((err) => ctx.log.error({ err: String(err) }, 'boot reconcile failed'))

  // §11 — a worker that died mid-hunt left sessions marked running. Rebuild
  // their caches so the next chat message routes instead of being dropped.
  await recoverActiveSessions(ctx).catch((err) =>
    ctx.log.error({ err: String(err) }, 'session recovery failed'),
  )

  await ctx.queues.maintenance.add(
    'flush-quota',
    { kind: 'flush-quota' },
    { repeat: { every: 60_000 }, jobId: 'flush-quota' },
  )
  await ctx.queues.maintenance.add(
    'reconcile-subscriptions',
    { kind: 'reconcile-subscriptions' },
    { repeat: { every: 15 * 60_000 }, jobId: 'reconcile-subscriptions' },
  )
  await ctx.queues.maintenance.add(
    'sweep-stale-sessions',
    { kind: 'sweep-stale-sessions' },
    { repeat: { every: 30 * 60_000 }, jobId: 'sweep-stale-sessions' },
  )

  ctx.log.info('worker ready')
}

const health = startHealthServer({
  port: ctx.env.WORKER_PORT,
  redis: ctx.redis,
  log: ctx.log,
})

async function shutdown(signal: string): Promise<void> {
  ctx.log.info({ signal }, 'worker shutting down')
  // Stop answering probes first, so the platform stops routing to a process
  // that is on its way out.
  health.close()
  // Close the workers first so in-flight jobs finish before the connections
  // they depend on go away — a job killed mid-append is exactly the case the
  // event log's idempotency is there to absorb, but finishing cleanly is better.
  await Promise.all(workers.map((w) => w.close()))
  await Promise.all(connections.map((c) => c.quit().catch(() => {})))
  await ctx.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => {
  ctx.log.error({ reason: String(reason) }, 'unhandled rejection')
})

boot().catch((err) => {
  ctx.log.fatal({ err: String(err) }, 'worker failed to boot')
  process.exit(1)
})
