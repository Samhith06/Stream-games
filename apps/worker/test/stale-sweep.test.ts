/**
 * When the sweep is allowed to end somebody's session.
 *
 * The bug this replaces measured session AGE, so a stream that ran for thirteen
 * hours had its live session abandoned mid-hunt — the subscription released and
 * the overlay dead at the moment the streamer was most engaged. Age is the wrong
 * signal entirely; these tests pin the right one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { sweepVerdict } from '../src/sweep-policy.ts'

const NOW = Date.UTC(2026, 7, 24, 20, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN

const ago = (ms: number) => new Date(NOW - ms)

/** Only the three fields the verdict reads. */
const session = (over: Partial<{ phase: string | null; startedAt: Date | null; createdAt: Date }> = {}) => ({
  phase: 'collecting' as string | null,
  startedAt: ago(2 * HOUR) as Date | null,
  createdAt: ago(2 * HOUR),
  ...over,
})

// ─── the regression ─────────────────────────────────────────────────────────

test('a marathon stream that is still playing is never swept', () => {
  // The actual bug: 13 hours old, active 30 seconds ago. The old sweep killed
  // this. Nothing about a long session makes it abandoned.
  const verdict = sweepVerdict(
    session({ startedAt: ago(13 * HOUR), createdAt: ago(13 * HOUR) }),
    ago(30_000),
    NOW,
  )

  assert.equal(verdict.sweep, false)
  assert.equal(verdict.reason, 'still-active')
})

test('age alone never decides anything', () => {
  // Same recent activity, wildly different ages — the verdict must not move.
  for (const age of [1 * HOUR, 8 * HOUR, 24 * HOUR, 72 * HOUR]) {
    const verdict = sweepVerdict(
      session({ startedAt: ago(age), createdAt: ago(age) }),
      ago(5 * MIN),
      NOW,
    )
    assert.equal(verdict.sweep, false, `a session ${age / HOUR}h old with recent activity was swept`)
  }
})

// ─── a session that never started ───────────────────────────────────────────

test('a session with no activity at all is closed after the short window', () => {
  // A misclick or an abandoned setup screen. It holds a Kick subscription for
  // nothing, and there is nothing to lose by closing it.
  const fresh = sweepVerdict(session({ startedAt: ago(20 * MIN), createdAt: ago(20 * MIN) }), undefined, NOW)
  assert.equal(fresh.sweep, false, '20 minutes is not yet abandoned')

  const stale = sweepVerdict(session({ startedAt: ago(50 * MIN), createdAt: ago(50 * MIN) }), undefined, NOW)
  assert.equal(stale.sweep, true)
  assert.equal(stale.reason, 'no-activity-at-all')
})

test('a session with no startedAt falls back to when it was created', () => {
  // Status 'created' never sets startedAt, and that is exactly the row most
  // likely to be an abandoned setup screen — it must not read as idle-for-zero.
  const verdict = sweepVerdict(
    { phase: null, startedAt: null, createdAt: ago(3 * HOUR) },
    undefined,
    NOW,
  )
  assert.equal(verdict.sweep, true)
  assert.equal(verdict.reason, 'no-activity-at-all')
})

// ─── a session that went quiet ──────────────────────────────────────────────

test('a session with activity gets a long leash from its last event', () => {
  const quiet = sweepVerdict(session(), ago(6 * HOUR), NOW)
  assert.equal(quiet.sweep, false, 'six hours of silence is a break, not an abandonment')

  const gone = sweepVerdict(session(), ago(13 * HOUR), NOW)
  assert.equal(gone.sweep, true)
  assert.equal(gone.reason, 'silent-since-last-event')
})

test('the two windows do not get crossed', () => {
  // A one-event session must NOT inherit the 45-minute window, or a streamer
  // who takes an hour off after the first !join loses the session.
  const oneEvent = sweepVerdict(session(), ago(90 * MIN), NOW)
  assert.equal(oneEvent.sweep, false, 'a single event should buy the long leash')

  // And a no-event session must not inherit the 12-hour one.
  const noEvents = sweepVerdict(session(), undefined, NOW)
  assert.equal(noEvents.sweep, true, 'a session with nothing in it should not wait 12 hours')
})

// ─── phases where a gap is normal ───────────────────────────────────────────

test('the opening phase is never swept, however long the gap', () => {
  // §13 — the gap between banking the last bonus and opening the first is
  // however long the streamer wants it to be. Sweeping here would end the
  // session at the exact moment the payoff starts.
  const verdict = sweepVerdict(session({ phase: 'opening' }), ago(20 * HOUR), NOW)
  assert.equal(verdict.sweep, false)
  assert.equal(verdict.reason, 'patient-phase')
})

test('a patient phase protects a session with no events too', () => {
  const verdict = sweepVerdict(session({ phase: 'opening' }), undefined, NOW)
  assert.equal(verdict.sweep, false)
})

test('other phases are not patient', () => {
  // The exemption is specific. If it silently covered every phase the sweep
  // would never fire at all, which is the failure mode that leaks
  // subscriptions — the thing §6.3 says never to do.
  for (const phase of ['joining', 'collecting', 'guessing', 'pick', 'buying', 'draw']) {
    const verdict = sweepVerdict(session({ phase }), ago(14 * HOUR), NOW)
    assert.equal(verdict.sweep, true, `${phase} should be swept after 14 hours of silence`)
  }
})
