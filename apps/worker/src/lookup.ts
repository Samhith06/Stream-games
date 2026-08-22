/**
 * The catalog side of the two-pass lookup (§9).
 *
 *   !sr gates
 *     -> reduce() returns a pending entry + { kind: 'lookup', query: 'gates' }
 *     -> this worker calls the catalog service
 *     -> the result re-enters as a SlotResolved event
 *     -> reduce() fills the entry, or emits a "did you mean" chat effect
 */

import type { LookupJob } from '@streamarena/platform'
import type { WorkerContext } from './context.js'
import { applyEvent } from './session-runner.js'

export async function handleLookupJob(ctx: WorkerContext, job: LookupJob): Promise<void> {
  const meta = await ctx.cache.meta(job.sessionId)
  if (!meta) return

  const resolution = await ctx.catalog.resolve(job.query)

  const match =
    resolution.kind === 'resolved'
      ? {
          slotId: resolution.slot.slotId,
          name: resolution.slot.name,
          provider: resolution.slot.provider,
          thumbnail: resolution.slot.thumbnail,
          confidence: resolution.slot.confidence,
        }
      : null

  const suggestions =
    resolution.kind === 'ambiguous'
      ? resolution.suggestions.map((s) => ({
          slotId: s.slotId,
          name: s.name,
          provider: s.provider,
          thumbnail: s.thumbnail,
          confidence: s.confidence,
        }))
      : []

  await applyEvent(ctx, meta, {
    type: 'slot.resolved',
    at: Date.now(),
    query: job.query,
    then: job.then,
    match,
    suggestions,
  })
}
