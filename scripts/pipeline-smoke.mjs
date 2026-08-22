/**
 * Drives the REAL queue pipeline with the worker process running.
 *
 * Where scripts/smoke.mjs folds events in-process, this one pushes jobs onto
 * BullMQ and waits for the worker to pick them up — so it exercises the parts
 * the other test doesn't: the ingest router, the guard chain, the per-session
 * lock, the effect executor, the catalog lookup round trip, and session
 * lifecycle including the Kick subscription attempt.
 *
 * No Kick credentials required: the subscribe and chat-send steps are expected
 * to fail and degrade, which is itself the behaviour §12 and §15.6 describe.
 *
 * Run with the worker running: node scripts/pipeline-smoke.mjs
 */

import { randomBytes } from 'node:crypto'
import { createDb, createRepos } from '../packages/db/dist/index.js'
import { createQueues, createRedis, SessionCache, buildRegistry } from '../packages/platform/dist/index.js'
import { generateSeed } from '../packages/core/dist/index.js'

const { DATABASE_URL, REDIS_URL } = process.env
if (!DATABASE_URL || !REDIS_URL) {
  console.error('DATABASE_URL and REDIS_URL must be set')
  process.exit(1)
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}

const { db, close } = createDb({ url: DATABASE_URL, max: 4 })
const repos = createRepos(db)
const redis = createRedis(REDIS_URL)
const queueRedis = createRedis(REDIS_URL)
const queues = createQueues(queueRedis)
const cache = new SessionCache(redis)
const registry = buildRegistry()

const suffix = randomBytes(4).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls until `fn` returns truthy or the deadline passes. */
async function until(fn, timeoutMs = 15_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(everyMs)
  }
  return null
}

try {
  console.log('\n── setup ────────────────────────────────────────────────')

  const user = await repos.users.upsertByKickId({
    kickUserId: `pipe-${suffix}`,
    displayName: `pipe_streamer_${suffix}`,
  })
  const channel = await repos.channels.upsert({
    broadcasterUserId: `pipebc-${suffix}`,
    slug: `pipe-${suffix}`,
    ownerUserId: user.id,
  })

  const game = registry.require('bonus-hunt')
  const config = game.configSchema.parse({ startBalance: 5000, targetBonuses: 5, defaultBet: 50 })

  const session = await repos.sessions.create({
    channelId: channel.id,
    gameId: game.id,
    stateVersion: game.stateVersion,
    seed: generateSeed((n) => randomBytes(n)),
    config,
    chatPolicy: {},
    overlayToken: randomBytes(24).toString('base64url'),
    createdBy: user.id,
  })
  check('session row created', Boolean(session.id))

  console.log('\n── lifecycle through the queue ──────────────────────────')

  await queues.ingest.add('start', { kind: 'start', sessionId: session.id, at: Date.now() })

  const meta = await until(() => cache.meta(session.id))
  check('the worker started the session and cached its metadata', meta !== null)
  check(
    'the channel pointer is live, so ingest will route (§10 step 3)',
    (await cache.sessionIdForChannel(channel.broadcasterUserId)) === session.id,
  )

  const running = await repos.sessions.byId(session.id)
  check('the session is marked running', running.status === 'running')
  check(
    'it started despite having no Kick tokens — degrades, does not refuse',
    running.status === 'running',
  )

  console.log('\n── chat commands through the router ─────────────────────')

  // A normal chat line. Must be dropped at step 4 without touching the game.
  await queues.ingest.add('kick', {
    kind: 'kick',
    eventType: 'chat.message.sent',
    kickMessageId: `chatter-${suffix}`,
    receivedAt: Date.now(),
    payload: {
      message_id: `chatter-${suffix}`,
      broadcaster: { user_id: channel.broadcasterUserId, username: 'streamer' },
      sender: { user_id: 'v-noise', username: 'noise', identity: { badges: [] } },
      content: 'hello everyone how is the hunt going',
    },
  })

  const srMessageId = `sr-${suffix}`
  await queues.ingest.add('kick', {
    kind: 'kick',
    eventType: 'chat.message.sent',
    kickMessageId: srMessageId,
    receivedAt: Date.now(),
    payload: {
      message_id: srMessageId,
      broadcaster: { user_id: channel.broadcasterUserId, username: 'streamer' },
      sender: { user_id: 'v-alice', username: 'alice', identity: { badges: [] } },
      content: '!sr gates',
    },
  })

  // The lookup is asynchronous: the entry appears pending, then firms up.
  const resolved = await until(async () => {
    const projection = await cache.projection(session.id)
    const entry = projection?.state?.entries?.[0]
    return entry && entry.status === 'queued' ? entry : null
  })

  check('!sr routed, reduced and resolved through the catalog', resolved !== null)
  check(
    'the two-pass lookup filled in the canonical slot name',
    resolved?.slotName === 'Gates of Olympus',
    JSON.stringify(resolved),
  )
  check('the requester is attributed', resolved?.requestedBy === 'alice')

  const afterNoise = await cache.projection(session.id)
  check(
    'ordinary conversation never became an entry',
    afterNoise.state.entries.length === 1,
    `entries: ${afterNoise.state.entries.length}`,
  )

  // §13 — one entry per viewer. The guard is in the game, so this needs a
  // second message from the same viewer.
  await queues.ingest.add('kick', {
    kind: 'kick',
    eventType: 'chat.message.sent',
    kickMessageId: `sr2-${suffix}`,
    receivedAt: Date.now(),
    payload: {
      message_id: `sr2-${suffix}`,
      broadcaster: { user_id: channel.broadcasterUserId, username: 'streamer' },
      sender: { user_id: 'v-alice', username: 'alice', identity: { badges: [] } },
      content: '!sr sweet bonanza',
    },
  })
  await sleep(1500)

  const afterDuplicate = await cache.projection(session.id)
  // The cooldown guard gets there before the game's one-entry-per-viewer rule
  // does; either way the viewer ends up with exactly one entry.
  check(
    'a second !sr from the same viewer was refused',
    afterDuplicate.state.entries.length === 1,
    `entries: ${afterDuplicate.state.entries.length}`,
  )

  console.log('\n── dashboard control through the same path ──────────────')

  await queues.ingest.add('control', {
    kind: 'control',
    sessionId: session.id,
    action: 'collection.close',
    payload: { balanceNow: 4850 },
    actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
    at: Date.now(),
  })

  const guessing = await until(async () => {
    const p = await cache.projection(session.id)
    return p?.state?.phase === 'guessing' ? p : null
  })
  check('the streamer control advanced the phase', guessing !== null)
  check('spent was captured once, at close', guessing?.state.spent === 150)

  // §13 — a guess window timer was scheduled as a delayed BullMQ job.
  const delayed = await queues.timer.getDelayed()
  check(
    'the guess window was armed as a delayed job',
    delayed.some((job) => job.data.sessionId === session.id),
    `${delayed.length} delayed timers`,
  )

  await queues.ingest.add('kick', {
    kind: 'kick',
    eventType: 'chat.message.sent',
    kickMessageId: `guess-${suffix}`,
    receivedAt: Date.now(),
    payload: {
      message_id: `guess-${suffix}`,
      broadcaster: { user_id: channel.broadcasterUserId, username: 'streamer' },
      sender: { user_id: 'v-bob', username: 'bob', identity: { badges: [] } },
      content: '!guess 5.2k',
    },
  })

  const guessed = await until(async () => {
    const p = await cache.projection(session.id)
    return p?.state?.guessCount === 1 ? p : null
  })
  check('!guess parsed the k-suffix and landed', guessed !== null)

  console.log('\n── quota telemetry (§6.3) ───────────────────────────────')

  // Counters live in a Redis buffer until the worker's flush moves them into
  // Postgres. Reading both and summing races that flush — if it lands between
  // the two reads the same counts appear twice. So force a flush, wait for the
  // buffer to drain, then read one side only.
  const day = new Date().toISOString().slice(0, 10)
  await queues.maintenance.add('flush-quota', { kind: 'flush-quota' })

  const drained = await until(async () => {
    const buffered = await redis.hgetall(`quota:${day}`)
    return Object.keys(buffered).length === 0 ? true : null
  }, 10_000)
  check('the quota buffer flushed into Postgres', drained === true)

  const [row = {}] = await repos.quota.forChannel(channel.id, 1)
  const deliveries = Number(row.deliveries ?? 0)
  const commands = Number(row.commands ?? 0)
  const dropped = Number(row.dropped ?? 0)

  check('inbound deliveries are counted', deliveries >= 4, `deliveries=${deliveries}`)
  // Two, not three: alice's second !sr never became a command because the
  // per-viewer cooldown guard refused it first (§10 step 5). A rejected command
  // costs a chat write, not a command slot.
  check('only commands that took effect are counted', commands === 2, `commands=${commands}`)
  check(
    'non-command chat is counted as dropped, not as work',
    dropped >= 1,
    `dropped=${dropped}`,
  )

  console.log('\n── teardown releases the Kick subscription ──────────────')

  await queues.ingest.add('end', {
    kind: 'end',
    sessionId: session.id,
    reason: 'abandoned',
    at: Date.now(),
  })

  const ended = await until(async () => {
    const row = await repos.sessions.byId(session.id)
    return row.status === 'abandoned' ? row : null
  })
  check('the session ended', ended !== null)
  check(
    'the channel pointer is cleared, so ingest stops routing (§6.3)',
    (await cache.sessionIdForChannel(channel.broadcasterUserId)) === null,
  )
  check('the session cache is gone', (await cache.meta(session.id)) === null)

  await db.execute((await import('drizzle-orm')).sql`DELETE FROM users WHERE id = ${user.id}::uuid`)
} catch (err) {
  failures++
  console.error('\npipeline smoke threw:', err)
} finally {
  await queues.close()
  await redis.quit()
  await queueRedis.quit()
  await close()
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure${failures === 1 ? '' : 's'}\n`)
process.exit(failures === 0 ? 0 : 1)
