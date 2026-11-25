import type { TokenWatermark, WatermarkThresholds } from './watermark.js'
import type { NudgeSample, WarnMarginDerivation } from './nudge-margin.js'
import { forcedCutMarks, modelDrivenNudgeTurns, nudgeDeliveredAt, nudgeSamples } from './state.js'
import { nudgeDeltas, predictGrowthTokens, shouldNudge } from './nudge-margin.js'

/**
 * The panel's view of layer 2 + layer 3 for one session.
 *
 * Written as a function so the debug payload and any future caller cannot disagree about the shape —
 * and so `undefined` (nothing to report) is a distinguishable answer from "reported zero".
 *
 * ── §12.2 第 4 层: 「哑了」与「不需要」必须能区分 ────────────────────────────────────────────────
 *
 * `nudgeReason` is the field that does that work, and it has exactly the four values the dispatch names:
 *
 *   `already-nudged`          — the pacing key already fired this turn; silence is CORRECT.
 *   `threshold`               — the ratio is at/over the line; silence would be a defect.
 *   `predicted`               — still under the line, but the predicted growth crosses; this is layer 2.
 *   `forced-cut-unannounced`  — a forced cut is pending and no nudge was ever delivered; this is the
 *                               fact layer 3 exists to disclose, and it is the ONE reason the handoff
 *                               says 「未经预警」.
 *
 * A panel that printed only `warnAt`/`hardAt` would make the first three indistinguishable.
 */
export function nudgePanelState(
  sessionId: string,
  watermark: TokenWatermark | undefined,
  thresholds: (WatermarkThresholds & { warnMargin?: WarnMarginDerivation }) | undefined,
  cutoffRatio: number | undefined,
): Record<string, unknown> | undefined {
  if (sessionId.length === 0) return undefined
  const delivered = nudgeDeliveredAt.get(sessionId)
  const ring: readonly NudgeSample[] = nudgeSamples.get(sessionId) ?? []
  const mark = forcedCutMarks.get(sessionId)
  if (delivered === undefined && ring.length === 0 && mark === undefined && watermark === undefined) return undefined
  const prediction = predictGrowthTokens(nudgeDeltas(ring), watermark?.contextWindow)
  const warnAt = thresholds?.warnAt
  const verdict =
    watermark === undefined || warnAt === undefined
      ? undefined
      : shouldNudge({
          tokens: watermark.tokens,
          contextWindow: watermark.contextWindow,
          warnAt,
          cutoffRatio: cutoffRatio ?? 1,
          prediction,
        })
  const nudgeReason = (() => {
    if (mark !== undefined && !mark.warned) return 'forced-cut-unannounced'
    if (verdict === undefined) return 'predicted-unavailable'
    if (!verdict.fire) return 'below-both'
    // `modelDrivenNudgeTurns` is keyed by the CURRENT turn, so a match means "already said this turn".
    return modelDrivenNudgeTurns.has(sessionId) ? 'already-nudged' : verdict.reason
  })()
  return {
    ...(thresholds?.warnMargin === undefined
      ? {}
      : { warnMarginSource: thresholds.warnMargin.source, warnMarginTokens: thresholds.warnMargin.marginTokens ?? null }),
    ...(thresholds?.warnMargin?.fallbackReason === undefined
      ? {}
      : { warnMarginFallbackReason: thresholds.warnMargin.fallbackReason }),
    warnAt: warnAt ?? null,
    predictedTokens: prediction.tokens,
    predictedFrom: prediction.from,
    predictedSamples: prediction.samples,
    wouldCross: verdict?.wouldCross ?? null,
    nudgeReason,
    samples: Math.max(0, ring.length - 1),
    ...(delivered === undefined
      ? {}
      : {
          nudgeDeliveredAt: Number(delivered.ratio.toFixed(4)),
          /**
           * W0-2b, observability half: 「送达了」 and 「送达之后上下文被重置」 are different readings, and a
           * panel that printed only the first would make them look the same.
           */
          ...(delivered.resetAfter ? { nudgeResetAfterDelivery: true } : {}),
        }),
    ...(mark === undefined
      ? {}
      : { forcedCutPending: { ratio: Number(mark.ratio.toFixed(4)), warned: mark.warned } }),
  }
}
