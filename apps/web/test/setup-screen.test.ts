/**
 * The setup screen, checked against the code that judges what it produces and
 * keeps the promises it makes.
 *
 * Two halves. The steppers are held against the config schemas that validate
 * them, and the live unlock explainer is held against the engine's own unlock
 * schedule.
 *
 * A stepper is the only way a number reaches the config, so its bounds *are*
 * the field's range as far as the streamer is concerned. They used to be one
 * hard-coded `Math.max(1, Math.min(10, …))` shared by every stepper on the
 * screen, which quietly made three settings unreachable — no squares held back,
 * no passovers, no sudden death — even though all three are documented in the
 * hint text directly beneath the control and accepted by the schema.
 *
 * Nothing catches that: the page renders, the button clicks, the value just
 * refuses to fall past 1. So the bounds are read out of the source here and
 * compared against the schema's own, which is the thing they have to agree
 * with.
 *
 * The explainer has the same shape of problem one layer along: it names the
 * picks the held-back squares will open after, and it recomputes them locally
 * because these pages are served unbundled and cannot import the engine. Two
 * copies of one formula is a drift waiting to happen, and the drift is visible
 * on stream — the screen promises pick 6, the board opens at 7.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { buildRegistry } from '@streamarena/platform'
import { unlockSchedule } from '@streamarena/game-slot-bingo'

const SETUP = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'setup.html'),
  'utf8',
).replace(/\r\n/g, '\n')

/** Which game's schema owns each stepper on the screen. */
const OWNER: Record<string, string> = {
  maxEntriesPerViewer: 'bonus-hunt',
  openSquares: 'slot-bingo',
  maxPassovers: 'giveaways',
  maxSuddenDeath: 'team-battles',
}

/** `{ k: 'openSquares', … type: 'stepper' … min: 0, max: 4 …` */
function steppers(): { key: string; min: number; max: string }[] {
  const out: { key: string; min: number; max: string }[] = []
  // Zero-width lookahead for the window, so one field's match cannot swallow
  // the next one, and the window is cut at the field after it either way.
  for (const row of SETUP.matchAll(/\{ k: '(\w+)',[^\n]*type: 'stepper'(?=([\s\S]{0,400}))/g)) {
    const key = row[1]!
    const text = row[2]!.split(/\n\s*\{ k: '/)[0]!
    const min = text.match(/\bmin: (\d+)/)
    const max = text.match(/\bmax: ([^,\n}]+)/)
    assert.ok(min, `${key} is a stepper with no min — it would silently get 0`)
    assert.ok(max, `${key} is a stepper with no max — it would silently get 10`)
    out.push({ key, min: Number(min![1]), max: max![1]!.trim() })
  }
  return out
}

/**
 * The object at the heart of a config schema. Every game's is wrapped in at
 * least one .superRefine() for its cross-field rules, and a ZodEffects has no
 * .shape of its own.
 */
function objectShape(schema: z.ZodTypeAny): z.ZodRawShape {
  let node: any = schema
  while (node && !(node instanceof z.ZodObject)) node = node._def?.schema ?? node._def?.innerType
  assert.ok(node, 'a config schema that is not an object at heart')
  return (node as z.ZodObject<z.ZodRawShape>).shape
}

/** The numeric bound a zod number carries, unwrapped past .default(). */
function bound(schema: z.ZodTypeAny, kind: 'min' | 'max'): number | null {
  let node: any = schema
  while (node?._def?.innerType) node = node._def.innerType
  const check = node?._def?.checks?.find((c: any) => c.kind === kind)
  return check ? Number(check.value) : null
}

test('every stepper declares its own bounds', () => {
  const found = steppers().map((s) => s.key).sort()
  assert.deepEqual(found, Object.keys(OWNER).sort())
})

test('a stepper can reach every value its schema accepts', () => {
  const registry = buildRegistry()

  for (const { key, min, max } of steppers()) {
    const game = registry.require(OWNER[key]!)
    const field = objectShape(game.configSchema as unknown as z.ZodTypeAny)[key]
    assert.ok(field, `${OWNER[key]} has no ${key} to configure`)

    const schemaMin = bound(field, 'min')
    const schemaMax = bound(field, 'max')

    assert.equal(
      min,
      schemaMin,
      `${key}: the stepper stops at ${min} but the schema accepts ${schemaMin} — ` +
        'the hint text under the control promises a setting the control cannot reach',
    )

    /*
     * The top is allowed to be lower than the schema's: holding back 4 of 25
     * squares is already a lot of board, and a 3×3 caps at 1 because the
     * schema's cross-field rule refuses more. Above it is the failure — a
     * stepper that climbs to a value the form will be rejected for.
     */
    const ceiling = Math.max(
      ...[3, 5].map((size) => Number(new Function('cfg', `return ${max}`)({ size }))),
    )
    assert.ok(
      Number.isFinite(ceiling) && schemaMax !== null && ceiling <= schemaMax,
      `${key}: the stepper climbs to ${ceiling} but the schema stops at ${schemaMax}`,
    )
  }
})

test('the stepper handler clamps to the field it is on, not to one shared range', () => {
  const handler = SETUP.match(/for \(const btn of document\.querySelectorAll\('\[data-step\]'\)[\s\S]*?\n  \}/)
  assert.ok(handler, 'the stepper handler moved — this guard needs rewriting')
  assert.match(handler![0], /dataset\.min/)
  assert.match(handler![0], /dataset\.max/)
})

// ─── the live unlock explainer ──────────────────────────────────────────────

/** One top-level function's source, lifted out of the page. */
function lift(name: string): string {
  const match = SETUP.match(new RegExp(String.raw`\nfunction ${name}\([\s\S]*?\n\}`))
  assert.ok(match, `setup.html has no top-level ${name}() any more`)
  return match![0]!
}

/** Runs the page's own explainer against a config, with no DOM in sight. */
function explain(cfg: Record<string, unknown>): { tone: string; text: string } {
  const source = [lift('clamp'), lift('unlockPicks'), lift('unlockNote')].join('\n')
  return new Function('cfg', `${source}\nreturn unlockNote()`)(cfg)
}

test('the explainer names the picks the engine will actually unlock on', () => {
  for (const size of [3, 5]) {
    for (let held = 1; held <= (size === 3 ? 1 : 4); held++) {
      const { text } = explain({ size, openSquares: held })
      const expected = unlockSchedule(held, size * size)

      for (const pick of expected) {
        assert.match(
          text,
          new RegExp(String.raw`\b${pick}\b`),
          `${size}×${size} holding ${held} back: the board unlocks at ` +
            `${expected.join(', ')} and the screen says "${text}"`,
        )
      }
    }
  }
})

test('the explainer counts the squares the draw will actually fill', () => {
  // A free centre is one fewer square drawn — the same subtraction runDraw
  // makes when it works out how many seats there are.
  assert.match(explain({ size: 5, openSquares: 3 }).text, /^22 squares drawn/)
  assert.match(explain({ size: 5, openSquares: 3, freeCentre: true }).text, /^21 squares drawn/)
  assert.match(explain({ size: 3, openSquares: 1 }).text, /^8 squares drawn/)
})

test('holding nothing back reads as the warning it is', () => {
  const none = explain({ size: 5, openSquares: 0 })
  assert.equal(none.tone, 'warn')
  assert.match(none.text, /No late entry/)

  // And the other way round: a board with open squares is not a warning.
  assert.equal(explain({ size: 5, openSquares: 3 }).tone, 'info')
})

test('one held-back square is described in the singular', () => {
  const one = explain({ size: 3, openSquares: 1 })
  assert.match(one.text, /opening after pick \d+ /)
  assert.doesNotMatch(one.text, /picks/)
})
