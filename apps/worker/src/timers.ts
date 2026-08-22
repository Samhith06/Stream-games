import type { TimerJob } from '@streamarena/platform'
import type { WorkerContext } from './context.js'
import { applyEvent } from './session-runner.js'

/**
 * A scheduled TimerEffect firing — a guess window closing, a voting window
 * expiring. It re-enters the pipeline as an ordinary event, so the reducer
 * handles a timer exactly the way it handles a chat command.
 */
export async function handleTimerJob(ctx: WorkerContext, job: TimerJob): Promise<void> {
  const meta = await ctx.cache.meta(job.sessionId)
  // A timer for a session that already ended. Dropping it is correct: the
  // window it was going to close no longer exists.
  if (!meta) return

  await applyEvent(ctx, meta, {
    type: 'timer',
    at: Date.now(),
    payload: job.payload,
    ...(job.timerId ? { timerId: job.timerId } : {}),
  })
}
