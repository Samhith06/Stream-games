/**
 * The runtime's own guarantees — the parts every game inherits and therefore
 * only has to be right once.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandRegistry,
  MemoryGuardStore,
  bracketShape,
  closestTo,
  coalesce,
  createRng,
  decideChat,
  drawSeats,
  emptyWindow,
  formatMoney,
  lockWindow,
  looksLikeCommand,
  openWindow,
  parseAmount,
  rankScores,
  runGuards,
  seedOrder,
  submit,
  varyIfRepeat,
  voteSplit,
  type ChatEffect,
  type CommandSpec,
} from '../dist/index.js'
import { DEFAULT_CHAT_POLICY } from '@streamarena/shared'

// ─── Parsing (§10 step 4) ───────────────────────────────────────────────────

const SPECS: CommandSpec[] = [
  {
    id: 'sr',
    keywords: ['sr', 'slot'],
    description: '',
    gate: 'anyone',
    cooldownMs: 1000,
    perUserLimit: 0,
    globalLimit: 0,
  },
  {
    id: 'guess',
    keywords: ['guess'],
    description: '',
    gate: 'anyone',
    cooldownMs: 0,
    perUserLimit: 1,
    globalLimit: 0,
  },
]

test('the cheap gate rejects ordinary chat without allocating', () => {
  assert.equal(looksLikeCommand('hello everyone'), false)
  assert.equal(looksLikeCommand('!'), false)
  assert.equal(looksLikeCommand('!sr gates'), true)
})

test('commands parse by keyword and report their canonical id', () => {
  const registry = new CommandRegistry(SPECS)

  assert.deepEqual(registry.parse('!sr Gates of Olympus')?.id, 'sr')
  assert.equal(registry.parse('!slot gates')?.id, 'sr') // alias keyword
  assert.equal(registry.parse('!SR   gates   of   olympus')?.args, 'gates of olympus')
  assert.equal(registry.parse('!nope x'), null)
  assert.equal(registry.parse('just talking'), null)
})

test('keyword overrides let a streamer rename a command without touching the game', () => {
  const registry = new CommandRegistry(SPECS, { sr: ['add'] })
  assert.equal(registry.parse('!add gates')?.id, 'sr')
  // The default keyword is gone once overridden — two keywords for one command
  // would make the help text a lie.
  assert.equal(registry.parse('!sr gates'), null)
})

// ─── Guards (§10 step 5) ────────────────────────────────────────────────────

const viewer = { userId: 'u1', username: 'viewer', role: 'viewer' as const }

function guardInput(overrides: Partial<Parameters<typeof runGuards>[1]> = {}) {
  return {
    sessionId: 's1',
    spec: SPECS[0]!,
    actor: viewer,
    sessionAccepting: true,
    enabled: true,
    ...overrides,
  }
}

test('guards fail fast in order and never consume quota on rejection', async () => {
  const store = new MemoryGuardStore()

  assert.deepEqual(await runGuards(store, guardInput({ sessionAccepting: false })), {
    allowed: false,
    denial: { reason: 'session_closed' },
  })
  assert.deepEqual(await runGuards(store, guardInput({ enabled: false })), {
    allowed: false,
    denial: { reason: 'command_disabled' },
  })

  const gated = await runGuards(store, guardInput({ gateOverride: 'subscribers' }))
  assert.equal(gated.allowed, false)

  // None of those rejections recorded a use.
  assert.equal(await store.userCount('s1', 'sr', 'u1'), 0)
})

test('a per-user cap blocks the second use but not the first', async () => {
  const store = new MemoryGuardStore()
  const input = guardInput({ spec: SPECS[1]! })

  assert.equal((await runGuards(store, input)).allowed, true)
  await store.recordUse('s1', 'guess', 'u1')

  const second = await runGuards(store, input)
  assert.equal(second.allowed, false)
  assert.deepEqual(second.allowed === false && second.denial, {
    reason: 'per_user_limit',
    limit: 1,
  })
})

test('moderators and the broadcaster bypass cooldowns and caps', async () => {
  const store = new MemoryGuardStore()
  await store.recordUse('s1', 'guess', 'mod')
  await store.startCooldown('s1', 'guess', 'mod', 60_000)

  const verdict = await runGuards(
    store,
    guardInput({
      spec: SPECS[1]!,
      actor: { userId: 'mod', username: 'mod', role: 'moderator' },
    }),
  )
  assert.equal(verdict.allowed, true)
})

// ─── Chat policy (§15) ──────────────────────────────────────────────────────

const ack: ChatEffect = { kind: 'chat', text: 'entry added', priority: 'ack' }
const error: ChatEffect = { kind: 'chat', text: 'already in', priority: 'error' }
const announcement: ChatEffect = {
  kind: 'chat',
  text: 'Hunt complete!',
  priority: 'announce',
  holdForStreamDelay: true,
}

test('errors-only is the default and collapses acks to nothing (§15.1)', () => {
  assert.equal(DEFAULT_CHAT_POLICY.ackMode, 'errors')
  assert.equal(decideChat(ack, DEFAULT_CHAT_POLICY).send, 'drop')
  assert.equal(decideChat(error, DEFAULT_CHAT_POLICY).send, 'now')
})

test('acks off silences everything except announcements', () => {
  const policy = { ...DEFAULT_CHAT_POLICY, ackMode: 'off' as const }
  assert.equal(decideChat(ack, policy).send, 'drop')
  assert.equal(decideChat(error, policy).send, 'drop')
  assert.notEqual(decideChat(announcement, policy).send, 'drop')
})

test('announcements are held behind the stream delay (§15.3)', () => {
  const decision = decideChat(announcement, DEFAULT_CHAT_POLICY)
  assert.equal(decision.send, 'delayed')
  assert.equal(decision.send === 'delayed' && decision.delayMs, 12_000)
})

test('turning off winner announcements drops them entirely', () => {
  const policy = { ...DEFAULT_CHAT_POLICY, announceResults: false }
  assert.equal(decideChat(announcement, policy).send, 'drop')
})

test('batching coalesces a window into one <=500 char write and defers the rest', () => {
  const many: ChatEffect[] = Array.from({ length: 60 }, (_, i) => ({
    kind: 'chat',
    text: `@viewer${i} couldn't match that slot`,
    priority: 'batched',
  }))

  const { text, used, deferred } = coalesce(many)
  assert.ok(text.length <= 500)
  assert.ok(used.length > 0)
  // Nothing is silently dropped — the overflow comes back for the next window.
  assert.equal(used.length + deferred.length, many.length)
})

test('duplicate batch keys collapse into a single mention', () => {
  const dupes: ChatEffect[] = [
    { kind: 'chat', text: 'entries are closed', priority: 'batched', batchKey: 'closed' },
    { kind: 'chat', text: 'entries are closed', priority: 'batched', batchKey: 'closed' },
    { kind: 'chat', text: 'entries are closed', priority: 'batched', batchKey: 'closed' },
  ]
  const { text } = coalesce(dupes)
  assert.equal(text, 'entries are closed')
})

test('a repeated message is varied so Kick anti-spam does not swallow it (§15.5)', () => {
  const first = varyIfRepeat('slow down', null, 1)
  const second = varyIfRepeat('slow down', 'slow down', 1)
  assert.equal(first, 'slow down')
  assert.notEqual(second, 'slow down')
})

// ─── Amount parsing (§13) ───────────────────────────────────────────────────

test('guess amounts strip currency and expand k/m', () => {
  assert.deepEqual(parseAmount('€6,500'), { ok: true, value: 6500 })
  assert.deepEqual(parseAmount('6.5k'), { ok: true, value: 6500 })
  assert.deepEqual(parseAmount('1.2m'), { ok: true, value: 1_200_000 })
  assert.deepEqual(parseAmount('  $ 1 234 '), { ok: true, value: 1234 })
  assert.equal(parseAmount('banana').ok, false)
  assert.equal(parseAmount('').ok, false)
})

test('the sanity ceiling rejects the meme guess', () => {
  const result = parseAmount('999999999', { ceiling: 500_000 })
  assert.deepEqual(result, { ok: false, error: 'above_ceiling' })
})

test('whole amounts render without decimals, fractional ones keep cents', () => {
  assert.equal(formatMoney(1720, 'EUR'), '€1,720')
  assert.equal(formatMoney(30.5, 'EUR'), '€30.50')
  assert.equal(formatMoney(-880, 'USD'), '-$880')
})

// ─── Determinism (§9) ───────────────────────────────────────────────────────

test('the same seed and label always produce the same sequence', () => {
  const a = createRng('seed-1', 'draw')
  const b = createRng('seed-1', 'draw')
  const c = createRng('seed-1', 'seeding')

  const takeFive = (rng: ReturnType<typeof createRng>) =>
    Array.from({ length: 5 }, () => rng.next())

  assert.deepEqual(takeFive(a), takeFive(b))
  assert.notDeepEqual(takeFive(createRng('seed-1', 'draw')), takeFive(c))
})

test('a seeded shuffle is reproducible and a permutation', () => {
  const items = Array.from({ length: 20 }, (_, i) => i)
  const first = createRng('s', 'x').shuffle(items)
  const again = createRng('s', 'x').shuffle(items)

  assert.deepEqual(first, again)
  assert.deepEqual([...first].sort((a, b) => a - b), items)
})

// ─── Shared primitives (§16) ────────────────────────────────────────────────

test('a submission window is editable until lock, then closed', () => {
  let window = openWindow(emptyWindow<number>(), { now: 0, durationMs: 60_000 })

  const first = submit(window, {
    userId: 'u1',
    username: 'a',
    value: 100,
    submittedAtSeq: 1,
    submittedAt: 1,
  })
  assert.equal(first.outcome, 'accepted')

  const second = submit(first.window, {
    userId: 'u1',
    username: 'a',
    value: 200,
    submittedAtSeq: 2,
    submittedAt: 2,
  })
  assert.equal(second.outcome, 'replaced')
  assert.equal(Object.keys(second.window.submissions).length, 1)

  window = lockWindow(second.window, 3)
  const late = submit(window, {
    userId: 'u2',
    username: 'b',
    value: 300,
    submittedAtSeq: 4,
    submittedAt: 4,
  })
  assert.equal(late.outcome, 'closed')
})

test('closest-value ties break on the earliest submission', () => {
  const result = closestTo(1000, [
    { userId: 'late', username: 'late', amount: 1100, submittedAtSeq: 9 },
    { userId: 'early', username: 'early', amount: 900, submittedAtSeq: 2 },
  ])
  assert.equal(result?.winner.username, 'early')
  assert.equal(result?.difference, 100)
})

test('the draw fills reserved seats first and stays reproducible (§14)', () => {
  const pool = Array.from({ length: 30 }, (_, i) => ({ userId: `u${i}`, joinedAtSeq: i }))
  const opts = { seats: 8, reservedUserIds: ['u29', 'u28'], rng: createRng('seed', 'draw') }

  const first = drawSeats(pool, opts)
  const second = drawSeats(pool, { ...opts, rng: createRng('seed', 'draw') })

  assert.equal(first.seats.length, 8)
  // Reserved seats come out in join order, not in the order they were reserved —
  // the streamer picks a set, not a ranking.
  assert.deepEqual(
    first.seats.filter((s) => s.source === 'reserved').map((s) => s.member.userId).sort(),
    ['u28', 'u29'],
  )
  assert.deepEqual(
    first.seats.map((s) => s.member.userId),
    second.seats.map((s) => s.member.userId),
  )
})

test('an underfilled pool is reported rather than silently padded', () => {
  const pool = Array.from({ length: 5 }, (_, i) => ({ userId: `u${i}`, joinedAtSeq: i }))
  const result = drawSeats(pool, { seats: 8, reservedUserIds: [], rng: createRng('s', 'd') })
  assert.equal(result.underfilled, true)
  assert.equal(result.seats.length, 5)
})

test('bracket shapes match the table in §14', () => {
  assert.deepEqual(bracketShape(8), { bracketSize: 8, byes: 0, rounds: 3, realMatches: 7 })
  assert.deepEqual(bracketShape(12), { bracketSize: 16, byes: 4, rounds: 4, realMatches: 11 })
  assert.deepEqual(bracketShape(16), { bracketSize: 16, byes: 0, rounds: 4, realMatches: 15 })
})

test('seed order keeps the top two seeds apart until the final', () => {
  const order = seedOrder(16)
  assert.equal(order.length, 16)
  assert.equal(order[0], 1)
  assert.equal(order[1], 16)
  // Seeds 1 and 2 sit in opposite halves.
  assert.ok(order.indexOf(1) < 8 && order.indexOf(2) >= 8)
})

test('prediction scores rank on correct, then accuracy, then earliest', () => {
  const ranked = rankScores({
    a: { username: 'a', correct: 3, total: 5, firstSeenSeq: 10 },
    b: { username: 'b', correct: 3, total: 3, firstSeenSeq: 20 },
    c: { username: 'c', correct: 3, total: 3, firstSeenSeq: 5 },
  })
  assert.deepEqual(ranked.map((r) => r.username), ['c', 'b', 'a'])
})

test('an empty vote split reads 50/50 rather than dividing by zero', () => {
  assert.deepEqual(voteSplit({}), { a: 0, b: 0, total: 0, aPct: 50, bPct: 50 })
  assert.deepEqual(voteSplit({ x: 'a', y: 'a', z: 'b' }).aPct, 67)
})
