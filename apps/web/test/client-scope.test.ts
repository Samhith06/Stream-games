/**
 * Guards the dashboard's client scripts against the two mistakes that keep
 * shipping.
 *
 * These pages are plain ES modules served as-is — no bundler, no type checker,
 * nothing that would notice a function reaching for a name it cannot see. Both
 * failures are invisible until runtime and neither breaks a build:
 *
 *   1. A top-level function calling a helper that only exists inside wire().
 *      The handler throws ReferenceError on click and the button does nothing.
 *      That is how the collect dialog shipped broken.
 *
 *   2. Top-level code running before the state it touches is declared. A
 *      module-scope let/const is in its temporal dead zone until its line is
 *      reached, so `await load()` above `let finished = 0` throws at startup
 *      and the page shows "Loading…" forever.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/** Every page with a module body worth policing. */
const PAGES = [
  'session.html',
  'history.html',
  'settings.html',
  'games.html',
  'setup.html',
  'recap.html',
  // The one page that is literally on stream: a TDZ here is a broken overlay in
  // front of an audience, with no console anyone will be looking at.
  'overlay.html',
]

/** Plain modules, which have no <script> wrapper to unpack. */
const MODULES = ['bingo-view.js', 'battles-view.js']

function moduleBody(file: string): string {
  const source = readFileSync(join(PUBLIC_DIR, file), 'utf8')
  if (!file.endsWith('.html')) return source

  const match = source.match(/<script type="module">([\s\S]*?)<\/script>/)
  assert.ok(match, `${file} has no module script`)
  return match![1]!
}

/** Names introduced at the top level: imports, const/let, function declarations. */
function moduleScope(body: string): Set<string> {
  const names = new Set<string>()

  for (const m of body.matchAll(/^import \{([^}]*)\} from/gm)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  // Unindented declarations are the top level; anything nested is indented.
  for (const m of body.matchAll(/^(?:export )?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!)
  for (const m of body.matchAll(/^(?:export )?(?:async )?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!)

  return names
}

/** Helpers declared inside wire(), which only wire()'s own closures can see. */
function wireLocals(body: string): Set<string> {
  const wire = body.match(/\nfunction wire\(\) \{([\s\S]*?)\n\}\n/)
  const names = new Set<string>()
  if (!wire) return names
  for (const m of wire[1]!.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]!)
  return names
}

/**
 * Top-level functions, and the body of each.
 *
 * Braces are counted rather than pattern-matched. A regex ending at the first
 * `\n}\n` stops at the first nested block that happens to close in column zero,
 * so it captures some functions, truncates others and drops the rest entirely —
 * and a guard that silently skips a function reports green while the bug it was
 * written for ships. `async` is included for the same reason: the functions
 * that run at startup, and can therefore hit a dead zone, are exactly the
 * async ones. So is `export`: a shared module declares everything with it, and
 * without the prefix the guard finds no functions at all in one and reports
 * green on a file it never actually read.
 */
function topLevelFunctions(body: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const m of body.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    const open = m.index! + m[0]!.length - 1
    let depth = 0

    for (let i = open; i < body.length; i++) {
      const ch = body[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          found.set(m[1]!, body.slice(open + 1, i))
          break
        }
      }
    }
  }

  return found
}

test('no top-level function calls a helper that only exists inside wire()', () => {
  const body = moduleBody('session.html')
  const scope = moduleScope(body)
  const locals = wireLocals(body)
  const violations: string[] = []

  for (const [name, source] of topLevelFunctions(body)) {
    if (name === 'wire') continue
    const called = new Set([...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!))
    for (const call of called) {
      // Declared inside wire() and not shadowed at module scope: reaching it
      // from out here throws the moment the handler runs.
      if (locals.has(call) && !scope.has(call)) {
        violations.push(`${name}() calls ${call}(), which is local to wire()`)
      }
    }
  }

  assert.deepEqual(violations, [], violations.join('\n  '))
})

test('the collect dialog can reach everything it needs', () => {
  // The specific regression: banking a bonus is the one action reached from a
  // dialog rather than from a handler wired inside wire().
  const body = moduleBody('session.html')
  const scope = moduleScope(body)

  const dialog = topLevelFunctions(body).get('collectDialog')
  assert.ok(dialog, 'collectDialog should be a top-level function')

  for (const needed of ['act', 'toast', 'escapeHtml']) {
    assert.ok(dialog!.includes(needed), `collectDialog should use ${needed}`)
    assert.ok(scope.has(needed), `${needed} must be reachable at module scope`)
  }
})

test('no top-level call runs before the state it touches is declared', () => {
  const problems: string[] = []

  for (const page of [...PAGES, ...MODULES]) {
    const lines = moduleBody(page).split('\n')

    // Unindented let/const are the module's own state.
    const declaredAt = new Map<string, number>()
    lines.forEach((line, i) => {
      const m = line.match(/^(?:export )?(?:const|let)\s+([A-Za-z_$][\w$]*)/)
      if (m) declaredAt.set(m[1]!, i)
    })

    // Unindented calls are top-level execution.
    const calls: { name: string; line: number }[] = []
    lines.forEach((line, i) => {
      const m = line.match(/^(?:await\s+)?([A-Za-z_$][\w$]*)\(/)
      if (m && !['if', 'for', 'while', 'switch', 'function', 'return', 'catch'].includes(m[1]!)) {
        calls.push({ name: m[1]!, line: i })
      }
    })

    const functions = topLevelFunctions(moduleBody(page))

    /*
     * Everything a top-level call can reach, following calls transitively.
     *
     * Checking only the called function's own body is not enough, and it let a
     * real bug ship: setup.html's `render()` reached a later-declared const
     * three calls down, through summarise() -> battlesSummary(). The module
     * threw before its submit listener attached, the button fell back to a
     * native form GET, and choosing Team Battles silently reloaded the page as
     * Bonus Hunt. A guard that stops at depth one reports green on exactly that.
     */
    const reachableFrom = (entry) => {
      const seen = new Set()
      const queue = [entry]
      while (queue.length > 0) {
        const name = queue.pop()
        if (seen.has(name)) continue
        // `wire()` is this codebase's handler-registration function by
        // convention: everything it names runs on a click, long after the
        // module has finished evaluating. Descending into it would flag every
        // dialog helper as a dead-zone read, which is noise, not a finding.
        if (name === 'wire') continue
        const body = functions.get(name)
        if (!body) continue
        seen.add(name)
        for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          if (!seen.has(m[1])) queue.push(m[1])
        }
      }
      return seen
    }

    for (const call of calls) {
      if (!functions.has(call.name)) continue

      const bodies = [...reachableFrom(call.name)].map((name) => ({
        name,
        source: functions.get(name),
      }))

      for (const [name, line] of declaredAt) {
        if (line <= call.line) continue
        const hit = bodies.find((b) => new RegExp(`\\b${name}\\b`).test(b.source))
        if (!hit) continue

        // Reached before the declaration is evaluated: the read hits the
        // temporal dead zone and takes the whole module down with it.
        const via = hit.name === call.name ? '' : ` (via ${hit.name}())`
        problems.push(
          `${page}: ${call.name}() on line ${call.line + 1}${via} uses "${name}", declared on line ${line + 1}`,
        )
      }
    }
  }

  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`)
})
