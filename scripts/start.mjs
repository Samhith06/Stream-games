/**
 * Picks which of the two processes (§8) this container runs.
 *
 *   SERVICE=web      HTTP, WebSocket, the dashboard and overlay
 *   SERVICE=worker   game logic, Kick calls, timers, queues
 *
 * They ship in one image and differ only in entrypoint. Selecting with a
 * variable rather than a start command is what lets a platform deploy the pair
 * from one config: Railway's start command and config-file path are per-service
 * dashboard settings with no API in the CLI, but variables are scriptable, so
 * this keeps the whole deployment reproducible from a terminal.
 *
 * Imported rather than spawned, so the process that handles SIGTERM is the one
 * the platform signals — an intermediate shell would swallow it and the
 * graceful shutdown in both entrypoints would never run.
 */

const ENTRYPOINTS = {
  web: '../apps/web/dist/index.js',
  worker: '../apps/worker/dist/index.js',
}

const service = process.env.SERVICE ?? 'web'
const entry = ENTRYPOINTS[service]

if (!entry) {
  const known = Object.keys(ENTRYPOINTS).join(', ')
  console.error(`SERVICE must be one of: ${known} (got ${JSON.stringify(service)})`)
  process.exit(1)
}

await import(entry)
