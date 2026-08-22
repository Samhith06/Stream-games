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
const PAGES = ['session.html', 'history.html', 'settings.html', 'games.html', 'setup.html', 'recap.html']

function moduleBody(file: string): string {
  const html = readFileSync(join(PUBLIC_DIR, file), 'utf8')
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/)
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
  for (const m of body.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!)
  for (const m of body.matchAll(/^(?:async )?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!)

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
 * async ones.
 */
function topLevelFunctions(body: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const m of body.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
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

  for (const page of PAGES) {
    const lines = moduleBody(page).split('\n')

    // Unindented let/const are the module's own state.
    const declaredAt = new Map<string, number>()
    lines.forEach((line, i) => {
      const m = line.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/)
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

    for (const call of calls) {
      const source = functions.get(call.name)
      if (!source) continue

      for (const [name, line] of declaredAt) {
        if (line <= call.line) continue
        // Referenced inside a function that runs before the declaration is
        // reached: the read or write hits the temporal dead zone.
        if (new RegExp(`\\b${name}\\b`).test(source)) {
          problems.push(
            `${page}: ${call.name}() on line ${call.line + 1} uses "${name}", declared on line ${line + 1}`,
          )
        }
      }
    }
  }

  assert.deepEqual(problems, [], `\n  ${problems.join('\n  ')}`)
})
