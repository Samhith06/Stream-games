/**
 * The web process — §8.
 *
 * "HTTP + WebSocket. Stays responsive; does almost no work." Scale trigger:
 * WebSocket connections and ingest latency.
 */

import { createWebContext } from './context.js'
import { buildServer } from './server.js'

const ctx = createWebContext()

async function main(): Promise<void> {
  const app = await buildServer(ctx)

  await app.listen({ port: ctx.env.WEB_PORT, host: '0.0.0.0' })
  ctx.log.info(
    { port: ctx.env.WEB_PORT, games: ctx.registry.ids(), baseUrl: ctx.env.PUBLIC_BASE_URL },
    'web listening',
  )

  const shutdown = async (signal: string) => {
    ctx.log.info({ signal }, 'web shutting down')
    // Close the server first so in-flight requests finish and no new webhook is
    // accepted that we then fail to enqueue — a 500 there costs quota twice.
    await app.close()
    await ctx.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  ctx.log.fatal({ err: String(err) }, 'web failed to start')
  process.exit(1)
})
