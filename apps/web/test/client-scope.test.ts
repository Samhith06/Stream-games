/**
 * Guards the dashboard's client script against out-of-scope references.
 *
 * These pages are plain ES modules served as-is — no bundler, no type checker,
 * nothing that would notice a function reaching for a name it cannot see. The
 * failure is invisible until someone clicks: the handler throws ReferenceError,
 * the console shows it, and the button simply does nothing. That is exactly how
 * the collect dialog shipped broken — it called `act`, which was a const inside
 * wire(), from a function defined outside it.
 *
 * So: any helper declared inside wire() is off limits to top-level functions.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

function moduleBody(file: string): string {
  const html = readFileSync(join(PUBLIC_DIR, file), 'utf8')
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/)
  assert.ok(match, `${file} has no module script`)
  return match![1]!
}

/** Names introduced at the top level of the module: imports, const/let, functions. */
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
  for (const m of body.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]!)

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

/** Top-level functions, and the names each one calls. */
function topLevelFunctions(body: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const m of body.matchAll(/\nfunction ([A-Za-z_$][\w$]*)\([^)]*\) \{([\s\S]*?)\n\}\n/g)) {
    found.set(m[1]!, m[2]!)
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
    for (const call of new Set([...source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!))) {
      // Declared inside wire() and not shadowed by anything at module scope:
      // reaching it from out here throws the moment the handler runs.
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
