/**
 * Local simulator — drive a real session by hand, with no Kick account and no
 * dashboard.
 *
 * It talks to the same queues the webhook receiver talks to, so everything past
 * step 1 of the pipeline is the real thing: the router, the guards, the
 * reducer, the catalog, the timers, the effect executor. Only Kick's own
 * delivery is faked.
 *
 *   node scripts/sim.mjs new bonus-hunt
 *   node scripts/sim.mjs chat alice "!sr gates of olympus"
 *   node scripts/sim.mjs state
 *   node scripts/sim.mjs do collection.close '{"balanceNow":4850}'
 *   node scripts/sim.mjs end
 *
 * The current session id is kept in .sim-session so commands don't need it.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createDb, createRepos } from '../packages/db/dist/index.js'
import { createQueues, createRedis, SessionCache, buildRegistry } from '../packages/platform/dist/index.js'
import { generateSeed } from '../packages/core/dist/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = join(ROOT, '.sim-session')

const { DATABASE_URL, REDIS_URL, PUBLIC_BASE_URL = 'http://localhost:3000' } = process.env
if (!DATABASE_URL || !REDIS_URL) {
  console.error('DATABASE_URL and REDIS_URL must be set — run with:  set -a && . ./.env && set +a')
  process.exit(1)
}

const { db, close } = createDb({ url: DATABASE_URL, max: 3 })
const repos = createRepos(db)
const redis = createRedis(REDIS_URL)
const queueRedis = createRedis(REDIS_URL)
const queues = createQueues(queueRedis)
const cache = new SessionCache(redis)
const registry = buildRegistry()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

function saveSession(data) {
  writeFileSync(STATE_FILE, JSON.stringify(data, null, 2))
}

function loadSession() {
  if (!existsSync(STATE_FILE)) {
    console.error(yellow('No simulated session. Start one:  node scripts/sim.mjs new bonus-hunt'))
    process.exit(1)
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

/**
 * The real connected Kick account, for a live test against actual chat.
 *
 * Everything downstream is identical to the simulated path — the difference is
 * that the worker subscribes to Kick for real, so messages arrive over the
 * webhook rather than being injected onto the queue.
 */
async function liveChannel(wantedSlug) {
  const channels = (await repos.channels.list(50)).filter(
    (c) => !c.slug.startsWith('sim-') && !c.slug.startsWith('smoke-') && !c.slug.startsWith('pipe-'),
  )

  if (channels.length === 0) {
    console.error(yellow('No Kick account connected. Visit /auth/kick and sign in first.'))
    process.exit(1)
  }

  // Picking arbitrarily when several accounts are connected is how you end up
  // running a game on the wrong channel — make it an explicit choice.
  let real
  if (wantedSlug) {
    real = channels.find((c) => c.slug === wantedSlug)
    if (!real) {
      console.error(yellow(`No connected channel called "${wantedSlug}".`))
      console.error(dim('  connected: ' + channels.map((c) => c.slug).join(', ')))
      process.exit(1)
    }
  } else if (channels.length === 1) {
    real = channels[0]
  } else {
    console.error(yellow(`${channels.length} Kick accounts are connected — say which one:`))
    for (const c of channels) console.error(dim(`  node scripts/sim.mjs live bonus-hunt --channel ${c.slug}`))
    process.exit(1)
  }

  const user = await repos.users.byId(real.ownerUserId)

  if (!(await repos.tokens.byUserId(user.id))) {
    console.error(yellow(`${user.displayName} has no stored Kick tokens — reconnect at /auth/kick.`))
    process.exit(1)
  }

  return { user, channel: real }
}

/**
 * A stable dev streamer, reused across runs so the channel keeps its history.
 * `sim-local` is not a real Kick id, so it can never collide with a live one.
 */
async function devChannel() {
  const user = await repos.users.upsertByKickId({
    kickUserId: 'sim-local',
    displayName: 'sim_streamer',
  })
  const channel = await repos.channels.upsert({
    broadcasterUserId: 'sim-local-channel',
    slug: 'sim-local',
    ownerUserId: user.id,
  })
  return { user, channel }
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdNew(gameId = 'bonus-hunt', configJson, { live = false, liveSlug } = {}) {
  const game = registry.get(gameId)
  if (!game) {
    console.error(`Unknown game "${gameId}". Available: ${registry.ids().join(', ')}`)
    process.exit(1)
  }

  const { user, channel } = live ? await liveChannel(liveSlug) : await devChannel()

  // End whatever was running — one session per channel, same as the API.
  const existing = await repos.sessions.activeForChannel(channel.id)
  if (existing) {
    console.log(dim(`ending previous session ${existing.id.slice(0, 8)}…`))
    await queues.ingest.add('end', {
      kind: 'end',
      sessionId: existing.id,
      reason: 'abandoned',
      at: Date.now(),
    })
    await sleep(1200)
  }

  const defaults =
    gameId === 'bonus-hunt'
      ? { startBalance: 5000, targetBonuses: 5, defaultBet: 50, guessWindowMs: 60_000 }
      : { seats: 8, votingWindowMs: 30_000, joinWindowMs: 120_000 }

  const config = game.configSchema.parse({ ...defaults, ...(configJson ? JSON.parse(configJson) : {}) })

  const session = await repos.sessions.create({
    channelId: channel.id,
    gameId,
    stateVersion: game.stateVersion,
    seed: generateSeed((n) => randomBytes(n)),
    config,
    chatPolicy: {},
    overlayToken: randomBytes(24).toString('base64url'),
    createdBy: user.id,
  })

  await queues.ingest.add('start', { kind: 'start', sessionId: session.id, at: Date.now() })

  const ready = await waitFor(() => cache.meta(session.id), 15_000)
  if (!ready) {
    console.error(yellow('The worker did not pick the session up. Is it running?'))
    console.error(dim('  npm run start:worker'))
    process.exit(1)
  }

  saveSession({
    sessionId: session.id,
    gameId,
    channelId: channel.id,
    broadcasterUserId: channel.broadcasterUserId,
    ownerUserId: user.id,
    ownerUsername: user.displayName,
    overlayToken: session.overlayToken,
  })

  console.log(`\n${green('session started')}  ${bold(gameId)}`)
  console.log(`  id       ${session.id}`)
  console.log(`  overlay  ${PUBLIC_BASE_URL}/overlay/${session.overlayToken}`)
  console.log(`  socket   ${PUBLIC_BASE_URL.replace(/^http/, 'ws')}/ws/overlay/${session.overlayToken}`)
  console.log(`\n${dim('watch it live:')}  node scripts/watch.mjs`)
  console.log(dim(`try:`) + `  node scripts/sim.mjs chat alice "!sr gates"\n`)
}

/** One simulated Kick chat message, delivered exactly as the webhook would. */
async function cmdChat(username, text, roleFlag) {
  if (!username || !text) {
    console.error('usage: sim.mjs chat <username> "<message>" [--mod|--sub]')
    process.exit(1)
  }
  const s = loadSession()

  const badges =
    roleFlag === '--mod'
      ? [{ type: 'moderator' }]
      : roleFlag === '--sub'
        ? [{ type: 'subscriber' }]
        : []

  const messageId = `sim-${randomBytes(6).toString('hex')}`
  await queues.ingest.add('kick', {
    kind: 'kick',
    eventType: 'chat.message.sent',
    kickMessageId: messageId,
    receivedAt: Date.now(),
    payload: {
      message_id: messageId,
      broadcaster: { user_id: s.broadcasterUserId, username: s.ownerUsername },
      sender: { user_id: `sim-viewer-${username}`, username, identity: { badges } },
      content: text,
    },
  })

  console.log(dim(`→ ${username}: ${text}`))
  await sleep(900)
  await printState(s, { compact: true })
}

/** Several viewers at once — the spam storm the overlay has to survive. */
async function cmdFlood(count = '25', template = '!sr gates') {
  const s = loadSession()
  const n = Number(count)

  for (let i = 0; i < n; i++) {
    const messageId = `sim-${randomBytes(6).toString('hex')}`
    await queues.ingest.add('kick', {
      kind: 'kick',
      eventType: 'chat.message.sent',
      kickMessageId: messageId,
      receivedAt: Date.now(),
      payload: {
        message_id: messageId,
        broadcaster: { user_id: s.broadcasterUserId, username: s.ownerUsername },
        sender: { user_id: `sim-viewer-flood${i}`, username: `viewer${i}`, identity: { badges: [] } },
        content: template.replace('{i}', String(i)),
      },
    })
  }

  console.log(dim(`→ ${n} viewers sent "${template}"`))
  await sleep(2500)
  await printState(s, { compact: true })
}

/**
 * n viewers each claim a DIFFERENT real slot from the catalog.
 *
 * Tournaments need this rather than `flood`: slots are unique per entrant
 * (§14), and a slot that doesn't resolve can't be drawn into a seat.
 */
async function cmdJoin(count = '8') {
  const s = loadSession()
  const n = Number(count)

  const slots = await repos.slots.list(n, 0)
  if (slots.length < n) {
    console.error(yellow(`Only ${slots.length} slots in the catalog. Run: npm run db:seed`))
    process.exit(1)
  }

  for (const [i, slot] of slots.entries()) {
    const messageId = `sim-${randomBytes(6).toString('hex')}`
    await queues.ingest.add('kick', {
      kind: 'kick',
      eventType: 'chat.message.sent',
      kickMessageId: messageId,
      receivedAt: Date.now(),
      payload: {
        message_id: messageId,
        broadcaster: { user_id: s.broadcasterUserId, username: s.ownerUsername },
        sender: { user_id: `sim-viewer-p${i}`, username: `player${i}`, identity: { badges: [] } },
        content: `!join ${slot.name}`,
      },
    })
  }

  console.log(dim(`→ ${n} viewers claimed: ${slots.map((x) => x.name).join(', ')}`))
  await sleep(2500)
  await printState(s, { compact: true })
}

/** A streamer control action — the same path the dashboard uses. */
async function cmdDo(action, payloadJson = '{}') {
  if (!action) {
    console.error('usage: sim.mjs do <action> [json-payload]')
    process.exit(1)
  }
  const s = loadSession()

  await queues.ingest.add('control', {
    kind: 'control',
    sessionId: s.sessionId,
    action,
    payload: JSON.parse(payloadJson),
    actor: { userId: s.ownerUserId, username: s.ownerUsername, role: 'broadcaster' },
    at: Date.now(),
  })

  console.log(dim(`→ control ${action} ${payloadJson}`))
  await sleep(900)
  await printState(s, { compact: true })
}

async function cmdState(mode) {
  await printState(loadSession(), { compact: mode === '--compact' })
}

async function cmdEnd(reason = 'complete') {
  const s = loadSession()
  await queues.ingest.add('end', {
    kind: 'end',
    sessionId: s.sessionId,
    reason,
    at: Date.now(),
  })
  await sleep(1200)
  rmSync(STATE_FILE, { force: true })
  console.log(green(`session ended (${reason})`))
}

async function printState(s, { compact }) {
  let projection = await cache.projection(s.sessionId)

  // A finished session has had its cache cleared, so fall back to the replay
  // path — the same one the history screen uses for old sessions (§11).
  if (!projection) {
    projection = await rebuildFromLog(s.sessionId)
    if (!projection) {
      console.log(yellow('no projection yet'))
      return
    }
    console.log(dim('(rebuilt from the event log — this session has ended)'))
  }

  const st = projection.state
  console.log(`\n${dim(`seq ${projection.seq}`)}  phase ${bold(String(st.phase))}`)

  if (s.gameId === 'bonus-hunt') {
    console.log(
      `  banked ${st.collectedCount ?? 0}/${st.targetBonuses}` +
        `  (${st.suggestionCount ?? 0} suggested)   spent ${st.spent}   won ${st.won}` +
        `   break-even/bonus ${bold(String(st.breakEvenPerBonus))}`,
    )
    console.log(`  guesses ${st.guessCount}   participants ${st.participantCount}`)
    if (st.winner) console.log(`  ${green('winner')} @${st.winner.username} off by ${st.winner.difference}`)

    if (!compact && st.entries?.length) {
      console.log(dim('\n  #  slot                          by            bet     win     mult  status'))
      for (const e of st.entries) {
        console.log(
          `  ${String(e.order).padEnd(2)} ${String(e.slotName).slice(0, 28).padEnd(28)} ` +
            `${String(e.requestedBy).slice(0, 12).padEnd(12)} ${String(e.bet).padStart(6)} ` +
            `${String(e.win ?? '—').padStart(7)} ${String(e.multiplier ?? '—').padStart(7)}  ${e.status}`,
        )
      }
    }
  } else {
    console.log(`  pool ${st.poolCount}   entrants ${st.entrants?.length ?? 0}/${st.seats}`)
    if (st.currentMatch) {
      const m = st.currentMatch
      console.log(
        `  now: @${m.a?.username} (${m.a?.slotName}) vs @${m.b?.username} (${m.b?.slotName})` +
          `   votes ${m.voteCount}  split ${m.split?.aPct}/${m.split?.bPct}`,
      )
    }
    if (st.champion) console.log(`  ${green('champion')} @${st.champion.username} — ${st.champion.slotName}`)
    if (st.topPredictor) {
      console.log(`  ${green('top predictor')} @${st.topPredictor.username} ${st.topPredictor.correct}/${st.topPredictor.total}`)
    }
  }

  // Anything the catalog could not match is the streamer's to fix (§20).
  const unresolved = (st.entries ?? []).filter((e) => e.status === 'pending')
  if (unresolved.length > 0) {
    console.log(yellow(`\n  ${unresolved.length} unresolved: ${unresolved.map((e) => e.slotName).join(', ')}`))
  }
  console.log()
}

/** §11 — snapshot plus events, exactly as the dashboard does for old sessions. */
async function rebuildFromLog(sessionId) {
  const session = await repos.sessions.byId(sessionId)
  if (!session) return null

  const game = registry.get(session.gameId)
  if (!game) return null

  const { GameEngine } = await import('../packages/core/dist/index.js')
  const { toInternalEvent } = await import('../packages/db/dist/index.js')

  const engine = new GameEngine(game, {
    config: session.config,
    init: {
      sessionId: session.id,
      channelId: session.channelId,
      seed: session.seed,
      startedAt: (session.startedAt ?? session.createdAt).getTime(),
      owner: { userId: 'sim', username: 'sim_streamer', role: 'broadcaster' },
    },
  })

  const { snapshot, events } = await repos.events.loadForReplay(sessionId)
  const replayed = engine.replay(
    events.map(toInternalEvent),
    snapshot
      ? { state: snapshot.state, seq: Number(snapshot.seq), stateVersion: snapshot.stateVersion }
      : undefined,
  )

  return { seq: replayed.seq, state: engine.project(replayed.state) }
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(250)
  }
  return null
}

function usage() {
  console.log(`
${bold('StreamArena local simulator')}

  ${bold('new')} [game] [config-json]      start a simulated session (bonus-hunt | slot-tournament)
  ${bold('live')} [game] [config-json]     start a session on the REAL connected Kick channel
  ${bold('chat')} <user> "<msg>" [--mod]   send one chat message
  ${bold('flood')} [n] [template]          n viewers at once; {i} is the index
  ${bold('join')} [n]                      n viewers claim n real catalog slots
  ${bold('do')} <action> [json]            a streamer control action
  ${bold('state')} [--compact]             print the current projection
  ${bold('end')} [complete|abandoned]      end the session

${dim('Bonus Hunt walkthrough')}
  node scripts/sim.mjs new bonus-hunt
  node scripts/sim.mjs flood 6 "!sr gates"
  node scripts/sim.mjs chat bob "!sr sweet bonanza"
  node scripts/sim.mjs do collection.close '{"balanceNow":4500}'
  node scripts/sim.mjs chat bob "!guess 6.5k"
  node scripts/sim.mjs do guesses.lock
  node scripts/sim.mjs state
  node scripts/sim.mjs do entry.setWin '{"entryId":"e2","win":900}'

${dim('Tournament walkthrough')}
  node scripts/sim.mjs new slot-tournament
  node scripts/sim.mjs join 8
  node scripts/sim.mjs do join.close
  node scripts/sim.mjs do draw.run
  node scripts/sim.mjs do match.startVoting
  node scripts/sim.mjs chat bob "!vote a"
  node scripts/sim.mjs do match.lockVoting
  node scripts/sim.mjs do match.result '{"aBuyCost":100,"aPayout":425,"bBuyCost":200,"bPayout":610}'
`)
}

// ─── dispatch ───────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv

try {
  switch (command) {
    case 'new':
      await cmdNew(args[0], args[1])
      break
    case 'live': {
      // Same as `new`, but bound to the real connected Kick channel.
      const flag = args.indexOf('--channel')
      const liveSlug = flag === -1 ? undefined : args[flag + 1]
      const positional = args.filter((a, i) => a !== '--channel' && args[i - 1] !== '--channel')
      await cmdNew(positional[0], positional[1], { live: true, liveSlug })
      break
    }
    case 'chat':
      await cmdChat(args[0], args[1], args[2])
      break
    case 'flood':
      await cmdFlood(args[0], args[1])
      break
    case 'join':
      await cmdJoin(args[0])
      break
    case 'do':
      await cmdDo(args[0], args[1])
      break
    case 'state':
      await cmdState(args[0])
      break
    case 'end':
      await cmdEnd(args[0])
      break
    default:
      usage()
  }
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await queues.close()
  await redis.quit()
  await queueRedis.quit()
  await close()
}
