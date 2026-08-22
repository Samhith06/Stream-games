/**
 * End-to-end smoke test against real Postgres and Redis.
 *
 * Drives a full Bonus Hunt through the actual pipeline — no Kick account
 * required — and asserts the things §10 and §11 promise:
 *
 *   - a chat command routes, guards, reduces and commits
 *   - a redelivered webhook is a no-op (idempotency)
 *   - the projection lands in Redis and the overlay can read it
 *   - wiping Redis rebuilds the session from snapshot + event log
 *   - ending the session clears the channel pointer
 *
 * Run: node scripts/smoke.mjs   (with the .env loaded)
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createDb, createRepos } from '../packages/db/dist/index.js'
import { createRedis, SessionCache, buildRegistry } from '../packages/platform/dist/index.js'
import { GameEngine, generateSeed } from '../packages/core/dist/index.js'
import { SlotCatalog } from '../packages/catalog/dist/index.js'

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL
if (!DATABASE_URL || !REDIS_URL) {
  console.error('DATABASE_URL and REDIS_URL must be set')
  process.exit(1)
}

let failures = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}

const { db, close } = createDb({ url: DATABASE_URL, max: 4 })
const repos = createRepos(db)
const redis = createRedis(REDIS_URL)
const cache = new SessionCache(redis)
const registry = buildRegistry()
const catalog = new SlotCatalog(repos.slots, repos.aliases, { fuzzy: false })

const suffix = randomBytes(4).toString('hex')

try {
  console.log('\n── setup ────────────────────────────────────────────────')

  const user = await repos.users.upsertByKickId({
    kickUserId: `smoke-${suffix}`,
    displayName: `smoke_streamer_${suffix}`,
  })
  const channel = await repos.channels.upsert({
    broadcasterUserId: `bc-${suffix}`,
    slug: `smoke-${suffix}`,
    ownerUserId: user.id,
  })
  check('user and channel created', user.id && channel.id)

  const game = registry.require('bonus-hunt')
  const config = game.configSchema.parse({ startBalance: 5000, targetBonuses: 3, defaultBet: 100 })

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
  check('session created', session.status === 'created')

  const meta = {
    sessionId: session.id,
    channelId: channel.id,
    broadcasterUserId: channel.broadcasterUserId,
    ownerUserId: user.id,
    ownerUsername: user.displayName,
    gameId: game.id,
    stateVersion: game.stateVersion,
    seed: session.seed,
    startedAt: Date.now(),
    config,
    chatPolicy: { ackMode: 'errors', announceResults: true, streamDelayMs: 12000 },
    commandOverrides: {},
    commandSettings: {},
    accepting: true,
  }
  await cache.putMeta(meta)

  check(
    'the channel pointer resolves — step 3 of the pipeline',
    (await cache.sessionIdForChannel(channel.broadcasterUserId)) === session.id,
  )

  // ── The fold loop, mirroring apps/worker/src/session-runner.ts ────────────
  const engine = new GameEngine(game, {
    config,
    init: {
      sessionId: session.id,
      channelId: channel.id,
      seed: session.seed,
      startedAt: meta.startedAt,
      owner: { userId: user.id, username: user.displayName, role: 'broadcaster' },
    },
  })

  let state = engine.initialState()

  async function fold(event, kickMessageId = null) {
    const { seq, appended } = await repos.events.append({
      sessionId: session.id,
      type: event.type,
      payload: event,
      kickMessageId,
    })
    if (!appended) return { seq, appended: false, effects: [] }

    const folded = engine.apply(state, { ...event, seq })
    state = folded.state
    await cache.putProjection(session.id, seq, engine.project(state))
    return { seq, appended: true, effects: folded.effects }
  }

  console.log('\n── the pipeline ─────────────────────────────────────────')

  const sr = {
    type: 'command',
    at: Date.now(),
    command: 'sr',
    args: 'gates',
    raw: '!sr gates',
    actor: { userId: 'viewer-1', username: 'alice', role: 'viewer' },
    messageId: `msg-${suffix}-1`,
  }
  const first = await fold(sr, sr.messageId)
  check('a chat command appends and reduces', first.appended && state.entries.length === 1)
  check(
    'the entry is pending and a catalog lookup was requested',
    state.entries[0].status === 'pending' && first.effects.some((e) => e.kind === 'lookup'),
  )

  // §10 step 1 / §11 — Kick retries; the unique index must absorb it.
  const redelivery = await fold(sr, sr.messageId)
  check(
    'a redelivered webhook is a no-op (idempotency)',
    !redelivery.appended && state.entries.length === 1,
  )

  // §21 — the real resolution ladder against the seeded catalog.
  const resolution = await catalog.resolve('gates')
  check(
    'the catalog resolves "gates" to Gates of Olympus via a learned alias',
    resolution.kind === 'resolved' && resolution.slot.name === 'Gates of Olympus',
    JSON.stringify(resolution),
  )

  await fold({
    type: 'slot.resolved',
    at: Date.now(),
    query: 'gates',
    then: { kind: 'entry', entryId: state.entries[0].id },
    match: {
      slotId: resolution.slot.slotId,
      name: resolution.slot.name,
      provider: resolution.slot.provider,
      thumbnail: resolution.slot.thumbnail,
      confidence: 1,
    },
    suggestions: [],
  })
  // Matched, not banked — the streamer still has to play it (§13).
  check('the entry firms up to queued', state.entries[0].status === 'queued')

  await fold({
    type: 'control',
    at: Date.now(),
    action: 'entry.markCollected',
    payload: { entryId: state.entries[0].id },
    actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
  })
  check('marking it collected banks the bonus', state.entries[0].status === 'collected')

  await fold({
    type: 'control',
    at: Date.now(),
    action: 'collection.close',
    payload: { balanceNow: 4900 },
    actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
  })
  check('collection closed and spent captured once', state.phase === 'guessing' && state.totals.spent === 100)

  for (const [name, amount] of [
    ['bob', '5300'],
    ['carol', '5500'],
  ]) {
    await fold({
      type: 'command',
      at: Date.now(),
      command: 'guess',
      args: amount,
      raw: `!guess ${amount}`,
      actor: { userId: `viewer-${name}`, username: name, role: 'viewer' },
      messageId: `msg-${suffix}-${name}`,
    })
  }
  check('guesses recorded', state.guesses.length === 2)

  await fold({
    type: 'control',
    at: Date.now(),
    action: 'guesses.lock',
    payload: {},
    actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
  })

  const completed = await fold({
    type: 'control',
    at: Date.now(),
    action: 'entry.setWin',
    payload: { entryId: state.entries[0].id, win: 400 },
    actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
  })

  check('the hunt completed when the last bonus opened', state.phase === 'complete')
  check('final balance is start-of-opening plus wins', state.finalBalance === 5300)
  check('the closest guess won', state.winner?.username === 'bob')

  const announcements = completed.effects.filter(
    (e) => e.kind === 'chat' && e.priority === 'announce',
  )
  check('two announcements, never merged (§15.4)', announcements.length === 2, `got ${announcements.length}`)
  check(
    'announcements are held behind the stream delay (§15.3)',
    announcements.every((a) => a.holdForStreamDelay === true),
  )

  console.log('\n── persistence and recovery ─────────────────────────────')

  // Nine folds, eight events: the redelivery was absorbed by the unique index
  // on (session_id, kick_message_id), which is exactly the point.
  const eventCount = await repos.events.count(session.id)
  check('every accepted fold is in the log, and only those', eventCount === 8, `found ${eventCount}`)

  const projection = await cache.projection(session.id)
  check(
    'the projection is in Redis for a reconnecting overlay',
    projection !== null && projection.state.phase === 'complete',
  )

  // §11 — "If Redis is wiped, every session rebuilds from snapshots plus
  // events. This should be tested deliberately, not assumed."
  await redis.del(`session:${session.id}:state`, `session:${session.id}:seq`)
  check('redis projection wiped', (await cache.projection(session.id)) === null)

  const { snapshot, events } = await repos.events.loadForReplay(session.id)
  const replayEngine = new GameEngine(game, {
    config,
    init: {
      sessionId: session.id,
      channelId: channel.id,
      seed: session.seed,
      startedAt: meta.startedAt,
      owner: { userId: user.id, username: user.displayName, role: 'broadcaster' },
    },
  })
  const rebuilt = replayEngine.replay(
    events.map((row) => ({ ...row.payload, seq: Number(row.seq) })),
    snapshot
      ? { state: snapshot.state, seq: Number(snapshot.seq), stateVersion: snapshot.stateVersion }
      : undefined,
  )

  check('the session rebuilds from the log alone', rebuilt.state.phase === 'complete')
  check('the rebuilt winner is identical', rebuilt.state.winner?.username === state.winner?.username)
  check(
    'the rebuilt state matches byte for byte',
    JSON.stringify(rebuilt.state) === JSON.stringify(state),
  )

  console.log('\n── teardown ─────────────────────────────────────────────')

  await repos.sessions.end(session.id, 'ended')
  await cache.clear(meta)
  check(
    'the channel pointer is gone, so ingest stops routing',
    (await cache.sessionIdForChannel(channel.broadcasterUserId)) === null,
  )

  const ended = await repos.sessions.byId(session.id)
  check('the session is marked ended with a timestamp', ended.status === 'ended' && ended.endedAt)

  // Leave the database as we found it.
  await db.execute(
    (await import('drizzle-orm')).sql`DELETE FROM users WHERE id = ${user.id}::uuid`,
  )
} catch (err) {
  failures++
  console.error('\nsmoke test threw:', err)
} finally {
  await redis.quit()
  await close()
}

console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure${failures === 1 ? '' : 's'}\n`,
)
process.exit(failures === 0 ? 0 : 1)
