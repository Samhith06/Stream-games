/**
 * BullMQ queues — §8, §10.
 *
 * The web process enqueues and returns 200 in under 50ms; the worker does all
 * the actual work. Three queues, deliberately: ingest (hot, high volume),
 * outbound chat (rate-limited, per-channel ordering matters), and timers
 * (delayed jobs).
 */

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

/**
 * BullMQ rejects ':' in a queue name — it uses the character itself as the key
 * separator — so namespacing goes through `prefix` instead.
 */
export const QUEUE_PREFIX = 'sa'

export const QUEUE = {
  ingest: 'ingest',
  chat: 'chat',
  timer: 'timer',
  lookup: 'lookup',
  maintenance: 'maintenance',
} as const

/**
 * Everything that can advance a session goes through one queue, so a channel's
 * events stay in a single ordered path: a chat command and the streamer's
 * "close entries" click can never be folded out of order.
 */
export type IngestJob =
  /** Raw webhook payload, straight off the wire. Normalised in-worker. */
  | {
      kind: 'kick'
      eventType: string
      kickMessageId: string
      /** Parsed JSON body — the raw bytes were only needed for signature checking. */
      payload: unknown
      receivedAt: number
    }
  /** A dashboard action. Never originates from chat. */
  | {
      kind: 'control'
      sessionId: string
      action: string
      payload: Record<string, unknown>
      actor: { userId: string; username: string; role: string }
      at: number
    }
  /** Session lifecycle, driven by the dashboard through the same path. */
  | { kind: 'start'; sessionId: string; at: number }
  | { kind: 'end'; sessionId: string; reason: 'complete' | 'abandoned'; at: number }

export interface ChatJob {
  sessionId: string
  channelId: string
  /** The Kick user id of the account we post as (the streamer). */
  ownerUserId: string
  broadcasterUserId: string
  text: string
  replyTo?: string
  priority: 'announce' | 'error' | 'reply' | 'ack' | 'batched'
  attempt?: number
}

export interface TimerJob {
  sessionId: string
  payload: unknown
  timerId?: string
}

export interface LookupJob {
  sessionId: string
  query: string
  then: unknown
}

export interface MaintenanceJob {
  kind: 'reconcile-subscriptions' | 'flush-quota' | 'sweep-stale-sessions'
}

/**
 * Keep completed jobs briefly and failures for a day — enough to answer "what
 * happened at 11pm" without letting Redis grow without bound.
 */
export const DEFAULT_JOB_OPTS: JobsOptions = {
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
}

export interface Queues {
  ingest: Queue<IngestJob>
  chat: Queue<ChatJob>
  timer: Queue<TimerJob>
  lookup: Queue<LookupJob>
  maintenance: Queue<MaintenanceJob>
  close(): Promise<void>
}

export function createQueues(connection: Redis | ConnectionOptions): Queues {
  const opts = {
    connection: connection as ConnectionOptions,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTS,
  }

  const ingest = new Queue<IngestJob>(QUEUE.ingest, opts)
  const chat = new Queue<ChatJob>(QUEUE.chat, opts)
  const timer = new Queue<TimerJob>(QUEUE.timer, opts)
  const lookup = new Queue<LookupJob>(QUEUE.lookup, opts)
  const maintenance = new Queue<MaintenanceJob>(QUEUE.maintenance, opts)

  return {
    ingest,
    chat,
    timer,
    lookup,
    maintenance,
    async close() {
      await Promise.all([
        ingest.close(),
        chat.close(),
        timer.close(),
        lookup.close(),
        maintenance.close(),
      ])
    },
  }
}

/** Priority lanes — BullMQ treats lower numbers as more urgent (§15.5). */
export const CHAT_PRIORITY: Record<ChatJob['priority'], number> = {
  announce: 1,
  error: 2,
  reply: 3,
  ack: 4,
  batched: 5,
}
