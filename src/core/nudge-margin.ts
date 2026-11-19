/**
 * ── W0-2 (B4-0b-2 §十二): THE NUDGE MARGIN, IN TOKENS ────────────────────────────────────────────
 *
 * MEASURED PROBLEM (W0, 38 sessions / 25,180 adjacent steps): the nudge window was a RATIO interval,
 * `[warnAt, hardAt)`. On a 1M-token window that is 30,000 tokens wide, and the measured single-step
 * growth reaches **320,941 tokens** (0.3209 of the window, 10.7× the width). A step that is below
 * `warnAt` at one pre-step and above `hardAt` at the next NEVER lands inside the interval, so no
 * nudge is ever sent and the forced cut arrives unannounced.
 *
 * The ruling (dispatch §12.2) is explicit and this module is its arithmetic half:
 *
 *   · widening the interval is NOT the fix — 0.03 covers 30k, 0.10 covers 100k, and a real step can
 *     be 320k. Widening only manufactures false positives; it cannot eliminate the silent cut.
 *   · the margin must be stated in TOKENS (`WARN_MARGIN_TOKENS`), so "how early do we talk to the
 *     model" stops depending on how large the window happens to be;
 *   · the ratio constant is NOT deleted: it is the fallback, and it says so through
 *     `source: 'ratio-fallback'` — a derivation nobody can name is a guess.
 *
 * ZERO IMPORTS on purpose: the whole decision surface is arithmetic over numbers the caller already
 * measured, so it is testable without a host, a log or a settings object.
 */

/**
 * The nudge's token margin — how much room the model is given to hand over on its own terms.
 *
 * 30,000 is not a tuned number: it is the width the old 0.03 ratio had on this project's measured
 * 1,000,000-token window (`compaction-guard`'s `COMPACTION_WARN_MARGIN` × W). Stating it in tokens
 * keeps that behaviour on a 1M window and CORRECTS it on every other window — a 200k session used to
 * be warned 6,000 tokens early, which one tool result can swallow.
 */
export const WARN_MARGIN_TOKENS = 30_000

/** How many recent step deltas the predictor reads. */
export const NUDGE_PREDICT_WINDOW = 20

/**
 * Below this many usable samples the p90 is noise, not a distribution.
 *
 * Two samples are a line; three is the first sample count whose p90 is not necessarily the maximum
 * (with n=2, the p90 index rounds to the max). Below three the predictor says `floor` out loud
 * instead of pretending to have measured anything.
 */
export const NUDGE_PREDICT_MIN_SAMPLES = 3

/** The p90 quantile the predictor uses (dispatch §12.2: "取 p90，不设上限"). */
export const NUDGE_PREDICT_QUANTILE = 0.9

export interface WarnMarginDerivation {
  /** The ratio the nudge fires at. */
  warnAt: number
  /**
   * WHICH derivation produced `warnAt`.
   *
   * `tokens` — the window was readable AND the resulting margin fits, so the margin is
   *   `max(ratioFallback, WARN_MARGIN_TOKENS / W)`.
   * `ratio-fallback` — either the window was unreadable, or a 30,000-token margin is so large a
   *   fraction of it that the derived line would sit below `WARN_MIN_RATIO`. The ratio constant
   *   governs, which is the only thing it is still allowed to do.
   */
  source: 'tokens' | 'ratio-fallback'
  /** The margin in tokens when `source === 'tokens'`; `undefined` when it could not be stated. */
  marginTokens?: number
  /** Why the fallback was taken. Only present for `ratio-fallback`. */
  fallbackReason?: 'window-unreadable' | 'margin-exceeds-window'
}

const roundRatio4 = (value: number): number => Number(value.toFixed(4))

/**
 * The lowest `warnAt` a token margin may produce before it is treated as not fitting the window.
 *
 * Same floor `calculateSafeWatermark` uses, for the same reason: a "warning" at a few percent is not a
 * warning, it is a stream of false alarms that costs the model attention on every step.
 */
export const WARN_MIN_RATIO = 0.05

/**
 * Derive `warnAt` from `hardAt` so the warning always leaves at least `WARN_MARGIN_TOKENS` of headroom.
 *
 * ── WHY `max(ratio, tokens)` AND NOT A PURE TOKEN LINE ───────────────────────────────────────────
 *
 * The dispatch states the rule as "W 可读时 `warnAt = hardAt − WARN_MARGIN_TOKENS / W`（1M 窗口下与旧
 * 0.03 等价）". Those two clauses only agree if the token margin is a FLOOR on the margin, not a
 * replacement for it: on a 1,000,000-token window 30,000 tokens IS exactly 0.03, and a pure token line
 * would reproduce the old pair — while on the 0.75/0.70 uncapped pair it would move the nudge from
 * 0.70 to 0.72, i.e. LATER, which contradicts both 「接近上限就该说」 and the measured problem. Taking the
 * larger of the two margins:
 *
 *   · leaves the shipped 1M behaviour bit-identical (0.03 = 30k there),
 *   · makes the margin at least 30k on windows where 0.03 is only a few thousand tokens (a 200k window
 *     used to warn 6,000 tokens early — one tool result swallows that),
 *   · never moves the warning later than it is today, so it is not a regression dressed as a fix.
 *
 * The ratio constant is still the fallback, and that is now its ONLY job.
 */
export function deriveWarnAt(
  hardAt: number,
  contextWindow: number,
  ratioFallback: number,
  minGap = 0.01,
): WarnMarginDerivation {
  const hard = Number.isFinite(hardAt) ? hardAt : 1
  const window = Number(contextWindow)
  const gap = Number.isFinite(minGap) && minGap > 0 ? minGap : 0.01
  const ceiling = Math.max(0.01, hard - gap)
  const byRatio = Number.isFinite(ratioFallback) && ratioFallback > 0 ? ratioFallback : 0.03
  if (Number.isFinite(window) && window > 0) {
    const byTokens = WARN_MARGIN_TOKENS / window
    const margin = Math.max(byRatio, byTokens)
    if (hard - margin >= WARN_MIN_RATIO) {
      return {
        warnAt: roundRatio4(Math.min(hard - margin, ceiling)),
        source: 'tokens',
        marginTokens: Math.round(margin * window),
      }
    }
    // A margin this large is not a warning line, it is a stream of false alarms near zero.
    return {
      warnAt: roundRatio4(Math.max(0.01, Math.min(hard - byRatio, ceiling))),
      source: 'ratio-fallback',
      fallbackReason: 'margin-exceeds-window',
    }
  }
  return {
    warnAt: roundRatio4(Math.max(0.01, Math.min(hard - byRatio, ceiling))),
    source: 'ratio-fallback',
    fallbackReason: 'window-unreadable',
  }
}

export interface GrowthPrediction {
  /** The token growth to budget for in the NEXT step. */
  tokens: number
  /**
   * `p90` — measured over the session's own recent non-reset deltas.
   * `floor` — too few usable samples; the value is `WARN_MARGIN_TOKENS` and means "not measured".
   */
  from: 'p90' | 'floor'
  /** How many deltas the quantile was taken over (`floor` keeps the count it saw). */
  samples: number
}

/**
 * When there is no measured growth yet, the token floor is capped at this fraction of the window.
 *
 * ── MEASURED MISTAKE THIS CAP FIXES (caught by `v76`, not by inspection) ─────────────────────────
 *
 * The floor was a flat `WARN_MARGIN_TOKENS = 30,000`. On the 3,000-token fixture window `v76` uses,
 * that floor is TEN TIMES the entire window: `1900 + 30000 >= 2250` is trivially true, so layer 2 fired
 * on every pre-step and the "below the line, stay quiet" behaviour disappeared. A prediction larger
 * than the window it predicts into is not a lower bound, it is a constant "yes".
 *
 * So the floor is `min(WARN_MARGIN_TOKENS, W × FLOOR_MAX_RATIO)`: with no evidence, assume a step grows
 * at most a tenth of the window. `FLOOR_MAX_RATIO` applies ONLY to the unevidenced floor — a MEASURED
 * p90 is never capped (dispatch: 「不设上限」), because a real 320k step is exactly what layer 2 must be
 * able to believe in.
 */
export const FLOOR_MAX_RATIO = 0.1

/**
 * p90 of the session's own recent NON-RESET step deltas.
 *
 * The caller filters resets (dispatch §12.2 step 2: `shrinkThenGrow` / `afterResetEvent` / `firstCall`
 * — 154 of the 160 measured >50k jumps were exactly these). This function does NOT re-filter: a
 * predictor that silently drops values cannot be audited against the samples it was given.
 *
 * NO UPPER CAP on a measured p90, on purpose: a large tool result genuinely is unpredictable, and
 * capping the prediction would turn layer 2 into a confident lie. The forced-cut mark (layer 3) is the
 * layer that does not depend on this number at all.
 */
export function predictGrowthTokens(samples: readonly number[], contextWindow?: number): GrowthPrediction {
  const usable = samples.filter((value) => Number.isFinite(value) && value > 0)
  const window = Number(contextWindow)
  const floor =
    Number.isFinite(window) && window > 0
      ? Math.min(WARN_MARGIN_TOKENS, Math.round(window * FLOOR_MAX_RATIO))
      : WARN_MARGIN_TOKENS
  if (usable.length < NUDGE_PREDICT_MIN_SAMPLES) {
    return { tokens: floor, from: 'floor', samples: usable.length }
  }
  const sorted = [...usable].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * NUDGE_PREDICT_QUANTILE)))
  return { tokens: Math.max(0, Math.round(sorted[index] as number)), from: 'p90', samples: sorted.length }
}

/**
 * Layers 1 and 2 as ONE predicate.
 *
 * They answer one question — "should the model be told on THIS step" — and splitting them is how a
 * caller ends up implementing one and forgetting the other.
 *
 *   threshold: ratio >= warnAt                          (the slow climb; the old behaviour)
 *   predicted: tokens + predictedTokens >= W × cutoff   (the jump; layer 2)
 */
export function shouldNudge(input: {
  tokens: number
  contextWindow: number
  warnAt: number
  /** The ratio at which the session is cut (`hardAt`, or 1 when nothing that force-cuts applies). */
  cutoffRatio: number
  prediction: GrowthPrediction
}): { fire: boolean; reason: 'below-both' | 'threshold' | 'predicted'; ratio: number; hardTokens: number; wouldCross: boolean } {
  const window = Number(input.contextWindow)
  const ratio = Number.isFinite(window) && window > 0 ? input.tokens / window : 0
  const cutoff = Number.isFinite(input.cutoffRatio) && input.cutoffRatio > 0 ? input.cutoffRatio : 1
  const hardTokens = Number.isFinite(window) && window > 0 ? cutoff * window : Number.POSITIVE_INFINITY
  const wouldCross = Number.isFinite(hardTokens) && input.tokens + input.prediction.tokens >= hardTokens
  if (ratio >= input.warnAt) return { fire: true, reason: 'threshold', ratio, hardTokens, wouldCross }
  if (wouldCross) return { fire: true, reason: 'predicted', ratio, hardTokens, wouldCross }
  return { fire: false, reason: 'below-both', ratio, hardTokens, wouldCross }
}

/**
 * ── LAYER 3: THE FORCED-CUT MARK, AND THE TWO SENTENCES IT MAY PRODUCE ───────────────────────────
 *
 * MEASURED (dispatch §12.2, verified line by line): `forcedCutMarks.set` ran only when
 * `watermarkEscalations.has || watermarkEscalated.has` — i.e. only when a nudge HAD been delivered and
 * the model kept working. A step that JUMPED the whole interval is exactly the case where no nudge was
 * ever delivered, so the mark was absent and the handoff said NOTHING about the cut being forced.
 *
 * The old text also said 「模型拒绝提前切走（70% 预警后仍继续调用工具）」. Two false statements live in
 * that sentence: it asserts a MOTIVE ("refused") that "continued calling tools" does not prove, and it
 * hard-codes 70% while the effective `hardAt` can be 0.55 under the compaction ceiling.
 *
 * So the mark carries the facts (`ratio`, `warned`, `warnedAtRatio`) and the sentence states only those
 * facts. 「拒绝」 is deliberately not reachable from here: this tree has no audit evidence that the
 * model SAW the nudge, only that it was delivered.
 */
export interface ForcedCutFacts {
  /** Watermark ratio at the moment of the forced cut. */
  ratio: number
  /** Did a nudge reach this session before the cut? */
  warned: boolean
  /** The ratio the nudge was delivered at, when `warned` is true. */
  warnedAtRatio?: number
  /** The ratio observed at the previous pre-step, when it is known (states the jump). */
  beforeRatio?: number
}

const ratioPct = (ratio: number): string => `${Math.round(ratio * 100)}%`

/**
 * The ONE sentence a forced cut is allowed to say, chosen by a fact rather than by a guess.
 *
 * Both branches state (a) whether a nudge was delivered, (b) the ratio(s) involved, and (c) that the
 * handoff content is taken from the state before the cut. Neither branch says WHY the model kept
 * working, and neither names a percentage that is not the measured one.
 */
export function forcedCutSentence(facts: ForcedCutFacts): string {
  if (facts.warned) {
    const at =
      typeof facts.warnedAtRatio === 'number' && Number.isFinite(facts.warnedAtRatio)
        ? `（${ratioPct(facts.warnedAtRatio)}）`
        : ''
    return (
      `[系统提示] 预警已送达${at}，本代继续调用工具后在 ${ratioPct(facts.ratio)} 水位被强制中断。` +
      '交接内容取自强制中断前的最后状态。'
    )
  }
  const jump =
    typeof facts.beforeRatio === 'number' && Number.isFinite(facts.beforeRatio)
      ? `本步从 ${ratioPct(facts.beforeRatio)} 跳到 ${ratioPct(facts.ratio)}`
      : `在 ${ratioPct(facts.ratio)} 水位`
  return (
    `[系统提示] 未经预警的强制中断（${jump}，跨过了预警窗口）。` +
    '这不是模型主动切走，也没有收到过预警；交接内容取自强制中断前的最后状态。'
  )
}

/**
 * ── THE SAMPLES THE PREDICTOR IS ALLOWED TO SEE ─────────────────────────────────────────────────
 *
 * One entry per pre-step: `{ seq, tokens }` as the watermark measured them. The delta between two
 * consecutive entries is one step's growth. Keeping `seq` is what lets a RESET invalidate the samples
 * taken before it instead of blending them into a p90.
 */
export interface NudgeSample {
  seq: number
  tokens: number
}

/**
 * Event types whose presence means "the context was replaced, so a jump across them is not growth".
 *
 * This is the SAME set the W0 probe used to produce 「160 次 >50k 跳变里 154 次是重置」 (dispatch
 * §12.2 step 2). Written as substrings rather than one regex on purpose: the probe's pattern is the
 * evidence, and a substring list makes a new host event type a one-line, reviewable addition instead
 * of a silently-matching alternation.
 */
export const RESET_EVENT_MARKERS: readonly string[] = [
  'compaction',
  'compact/',
  'context/reset',
  'session/restore',
  'session/resume',
  'plugin:translator',
]

/** True when `type` names a context reset. Any type that is not a string is not a reset. */
export function isResetEventType(type: unknown): boolean {
  if (typeof type !== 'string' || type.length === 0) return false
  return RESET_EVENT_MARKERS.some((marker) => type.includes(marker))
}

/**
 * ── `shrinkThenGrow`: THE SHAPE THAT PRODUCED MOST OF THE MEASURED MAXIMUM ──────────────────────
 *
 * A pre-step that observed a context under 5% of the window is a just-reset context, not a working
 * one: the next delta from it is a re-read of the handoff tape, not growth. 154 of the 160 measured
 * >50k jumps were exactly this. The threshold is a RATIO because "tiny" is relative to the window.
 */
export const SHRINK_RATIO = 0.05

/**
 * Append one observation and return the new ring, applying BOTH reset exclusions.
 *
 * `resetSinceLastSample` is reported by the caller (it has the log; this module only does arithmetic):
 *   · true  → the ring is discarded before appending, because a delta that spans a reset is precisely
 *             the quantity the predictor must not average;
 *   · false → a trailing sample below `SHRINK_RATIO × window` is dropped for the same reason.
 *
 * The ring is capped at `NUDGE_PREDICT_WINDOW` so the estimate stays local to the CURRENT shape of the
 * work: a session that used to run 200k tool calls and no longer does must not keep predicting them.
 */
export function recordNudgeSample(
  ring: readonly NudgeSample[],
  sample: NudgeSample,
  contextWindow: number,
  resetSinceLastSample: boolean,
): NudgeSample[] {
  const window = Number(contextWindow)
  if (resetSinceLastSample) return [{ seq: sample.seq, tokens: sample.tokens }]
  const kept = [...ring]
  const last = kept.at(-1)
  if (last !== undefined && Number.isFinite(window) && window > 0 && last.tokens < window * SHRINK_RATIO) {
    kept.length = 0
  }
  // A repeated seq is the same observation, not a zero-length step.
  if (kept.at(-1)?.seq === sample.seq) return kept.slice(-NUDGE_PREDICT_WINDOW)
  kept.push({ seq: sample.seq, tokens: sample.tokens })
  return kept.slice(-NUDGE_PREDICT_WINDOW)
}

/** The step deltas a ring encodes, in order. */
export function nudgeDeltas(ring: readonly NudgeSample[]): number[] {
  const deltas: number[] = []
  for (let index = 1; index < ring.length; index += 1) {
    deltas.push((ring[index] as NudgeSample).tokens - (ring[index - 1] as NudgeSample).tokens)
  }
  return deltas
}
