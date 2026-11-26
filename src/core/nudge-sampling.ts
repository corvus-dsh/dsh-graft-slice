import type { ForcedCutFacts, GrowthPrediction } from './nudge-margin.js'
import { forcedCutSentence } from './nudge-margin.js'
import { isResetEventType, nudgeDeltas, predictGrowthTokens, recordNudgeSample } from './nudge-margin.js'
import { forcedCutMarks, nudgeDeliveredAt, nudgeSamples } from './state.js'
import type { PluginContextLike } from './gateway-types.js'
import type { SessionEventLike, TokenWatermark } from './watermark.js'

export function noteForcedCut(sourceSessionId?: string): string | undefined {
  if (sourceSessionId === undefined) return undefined
  const mark = forcedCutMarks.get(sourceSessionId)
  if (mark === undefined) return undefined
  forcedCutMarks.delete(sourceSessionId)
  const facts: ForcedCutFacts = {
    ratio: mark.ratio,
    warned: mark.warned,
    ...(mark.warnedAtRatio === undefined ? {} : { warnedAtRatio: mark.warnedAtRatio }),
    ...(mark.beforeRatio === undefined ? {} : { beforeRatio: mark.beforeRatio }),
    ...(mark.resetAfterNudge === true ? { resetAfterNudge: true } : {}),
  }
  return forcedCutSentence(facts)
}

export function nudgePredictionFor(ctx: PluginContextLike, agentId: string, watermark: TokenWatermark): GrowthPrediction {
  let seq = 0
  let resetSinceLastSample = false
  try {
    const live = ctx.sessions.get(agentId) as any
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      const events = live.snapshotEvents(0) as SessionEventLike[]
      seq = Number(events.at(-1)?.seq ?? 0)
      const previous = nudgeSamples.get(agentId)?.at(-1)
      if (previous !== undefined) {
        resetSinceLastSample = events.some(
          (event) => Number(event?.seq ?? -1) > previous.seq && isResetEventType(event?.type),
        )
      }
    }
  } catch {
    // An unreadable log costs one sample; it must not suppress the warning.
  }
  const ring = recordNudgeSample(
    nudgeSamples.get(agentId) ?? [],
    { seq, tokens: watermark.tokens },
    watermark.contextWindow,
    resetSinceLastSample,
  )
  nudgeSamples.set(agentId, ring)
  /**
   * ── W0-2b: A RESET ALSO INVALIDATES THE *AWARENESS* HALF OF THE DELIVERY FACT ─────────────────
   *
   * The same `resetSinceLastSample` the predictor uses (same judgement, one source — see the comment
   * above) now downgrades a recorded delivery: the nudge WAS sent, and it may no longer be in the
   * context. Keeping the record and flagging it is better than deleting it, because "delivered, then
   * reset" and "never delivered" produce different sentences and only one of them is true.
   */
  if (resetSinceLastSample) {
    const delivered = nudgeDeliveredAt.get(agentId)
    if (delivered !== undefined && delivered.resetAfter !== true) {
      nudgeDeliveredAt.set(agentId, { ratio: delivered.ratio, resetAfter: true })
    }
  }
  return predictGrowthTokens(nudgeDeltas(ring), watermark.contextWindow)
}

export function previousRatioOf(agentId: string, contextWindow: number): number | undefined {
  const last = nudgeSamples.get(agentId)?.at(-1)
  if (last === undefined || !(Number.isFinite(contextWindow) && contextWindow > 0)) return undefined
  return last.tokens / contextWindow
}

export function resetSinceLastNudgeSample(ctx: PluginContextLike, agentId: string): boolean {
  const previous = nudgeSamples.get(agentId)?.at(-1)
  if (previous === undefined) return false
  try {
    const live = ctx.sessions.get(agentId) as any
    if (live === undefined || typeof live.snapshotEvents !== 'function') return false
    const events = live.snapshotEvents(0) as SessionEventLike[]
    return events.some((event) => Number(event?.seq ?? -1) > previous.seq && isResetEventType(event?.type))
  } catch {
    // An unreadable log must not manufacture a reset (or hide one we already recorded).
    return false
  }
}
