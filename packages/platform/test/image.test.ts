/**
 * The deployment image, checked against the workspace it ships.
 *
 * The Dockerfile's dependency stage copies one `package.json` per workspace
 * before `npm ci`, so that layer is rebuilt when a dependency changes rather
 * than on every edit. The cost of that optimisation is a hand-written list of
 * every workspace, and a hand-written list of anything goes stale: three games
 * were added after it and none of them were added to it.
 *
 * Nothing catches that. The image still built, because the next stage copies
 * the whole tree, and it still ran, so the missing links were being created by
 * something downstream rather than by the install that was supposed to create
 * them. A deploy standing on a side effect works right up until it doesn't, and
 * the symptom then is a container that cannot resolve a game package — at boot,
 * in production, on a Friday.
 *
 * So: the list is compared against the workspaces the root manifest actually
 * declares. Adding game #6 fails here until the Dockerfile knows about it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n')

/** Every workspace the root manifest resolves to, as a repo-relative path. */
function workspaces(): string[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const out: string[] = []

  for (const pattern of manifest.workspaces as string[]) {
    if (!pattern.endsWith('/*')) {
      out.push(pattern)
      continue
    }
    const parent = pattern.slice(0, -2)
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(ROOT, parent, entry.name, 'package.json'))) {
        out.push(`${parent}/${entry.name}`)
      }
    }
  }
  return out.sort()
}

/** The manifests the dependency stage copies, in the order it copies them. */
function copied(): string[] {
  const deps = DOCKERFILE.match(/\nFROM base AS deps\n[\s\S]*?\nRUN npm ci[^\n]*/)
  assert.ok(deps, 'the Dockerfile has no dependency stage any more — this guard needs rewriting')

  return [...deps![0]!.matchAll(/^COPY (\S+)\/package\.json\s/gm)].map((m) => m[1]!).sort()
}

test('the image installs every workspace the repo declares', () => {
  assert.deepEqual(
    copied(),
    workspaces(),
    'the Dockerfile dependency stage and the workspace list disagree — a workspace ' +
      'missing here is one npm ci never links, and the container finds out at boot',
  )
})

test('the whole tree still arrives in the build stage', () => {
  /*
   * The per-workspace copies are a caching optimisation, not the source of
   * truth — the build stage copies `packages` and `apps` wholesale. If that
   * ever stops being true, the test above changes from a staleness guard into
   * the only thing standing between a missing entry and a broken image, and
   * whoever makes that change should know it.
   */
  const build = DOCKERFILE.match(/\nFROM deps AS build\n[\s\S]*?\nRUN npm run build[^\n]*/)
  assert.ok(build, 'the Dockerfile has no build stage any more')
  assert.match(build![0], /^COPY packages packages$/m)
  assert.match(build![0], /^COPY apps apps$/m)
})
