/**
 * v1.3 REFACTOR (batch 2, step 3) — the WATERMARK layer.
 *
 * Moved verbatim from index.ts: the derivation of the two ratios, the handoff-cost model and
 * the constants they are built from.
 *
 * Dependency rules honoured here:
 *   - the ONLY imports are `node:*` and `../utils/serialize.js` (clampRatio);
 *   - nothing in this file imports index.ts, so no cycle can form;
 *   - the host is never consulted: `effectiveWatermarks` receives the settings it needs as
 *     an argument. (`readTokenWatermark` stays in index.ts for now — it is the one function
 *     that talks to the tokenMeter service, and it moves in its own step.)
 */

import { clampRatio } from '../utils/serialize.js'

/**
 * The subset of the plugin config this layer reads.
 *
 * Declared structurally instead of importing `GraftConfig` from index.ts: the dependency
 * must not point backwards, and a caller passing `Required<GraftConfig>` still satisfies
 * this shape.
 */
export interface WatermarkSettings {
  watermarkMode: 'fixed' | 'dynamic'
  modelDrivenGraftAtRatio: number
  autoGraftAtRatio: number
  contextWindowTokens: number
  growthTokensPerTurn: number
  growthReserveTurns: number
}

export function deriveAutoTapeBudget(contextWindow: number, ratio = 0.5): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0
  const safeRatio = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.5
  return Math.max(0, Math.floor(contextWindow * safeRatio))
}

// ===========================================================================
// v0.18 module 2 — the DYNAMIC watermark
// ===========================================================================

/**
 * v0.18: what one handoff COSTS, measured before deciding WHEN to run one.
 *
 * THE DEFECT THIS REPLACES
 *
 * `modelDrivenGraftAtRatio: 0.70` and `autoGraftAtRatio: 0.75` were constants. They
 * encode one implicit assumption — that a graft costs roughly the same fraction of
 * every window — and that assumption is false at both ends of the range. On a
 * 1M-token window a 6k-token handoff is free and 0.75 is needlessly early; on a
 * 16k-token window the same handoff plus one more turn with a tool result cannot
 * fit in the 25% the constant leaves, so the migration is attempted and fails —
 * `graft_prepare` reads a log, the model call comes back, and the write is refused
 * because the window filled during the handoff itself. "Migrating at 90% of a
 * window that a graft needs 12% of is not late, it is impossible."
 *
 * So the thresholds are DERIVED:
 *
 *     safeCeiling = 1 - (fixed + package + growthReserve) / windowLimit
 *
 * and the fixed ratios survive in exactly two places: as the LATEST point we ever
 * cut (`WATERMARK_HARD_CEILING`, the measured turn-stopping point — a dynamic
 * value is not license to migrate later than the host can survive), and verbatim
 * under `watermarkMode: 'fixed'` for the differential test that proves this
 * module is what moved the line.
 */
export const GRAFT_FIXED_COST_TOKENS = 6000
export const DEFAULT_GROWTH_TOKENS_PER_TURN = 1200
/** The historical `autoGraftAtRatio`: the latest ratio this plugin will ever cut at. */
export const WATERMARK_HARD_CEILING = 0.75
/**
 * The earliest ratio a dynamic calculation may pull the cutoff to.
 *
 * A floor exists because "the estimate does not fit" must not become "migrate at
 * 8%". Below this the honest answer is not an earlier cut but a visible
 * `feasible: false` (the console and the debug panel report it) — the operator
 * either raises `contextWindowTokens`' assumptions or moves to a larger window.
 */
export const WATERMARK_HARD_FLOOR = 0.5
/** Never let the nudge land on top of the cutoff: the model needs a window to act in. */
export const WATERMARK_MIN_GAP = 0.02
/** Default distance between the nudge and the hard cutoff. */
export const WATERMARK_NUDGE_MARGIN = 0.05
/**
 * Characters per token for the handoff package ECHO.
 *
 * The package is mostly paths, seq numbers, JSON and code, so 4 chars/token is
 * the conservative end for Latin text and still generous for CJK prose. The tape
 * itself is not re-priced here: this term is the cost of the source seeing the
 * plan/review round trip, not the cost of the target's seeded history.
 */
const REVIEW_CHARS_PER_TOKEN = 4

export interface GraftCostInput {
  /** Tokens the `graft_prepare` -> `graft_commit` round trip costs the SOURCE. */
  fixedTokens?: number
  /** Characters of plan/review text the source echoes during that round trip. */
  packageChars?: number
  /** Tokens one completed turn adds near the ceiling (the growth prediction). */
  growthPerTurnTokens?: number
  /** How many turns of growth headroom to reserve. */
  reserveTurns?: number
}

export interface GraftCostEstimate {
  windowLimit: number
  fixedTokens: number
  packageChars: number
  packageTokens: number
  growthPerTurnTokens: number
  reserveTurns: number
  growthReserveTokens: number
  totalTokens: number
  /** `totalTokens / windowLimit`; 0 when the window is unknown. */
  ratio: number
}

export function estimateGraftCost(windowLimit: number, input: GraftCostInput = {}): GraftCostEstimate {
  const limit = Number.isFinite(windowLimit) && windowLimit > 0 ? Math.trunc(windowLimit) : 0
  const int = (value: unknown, fallback: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : fallback
  const fixedTokens = int(input.fixedTokens, GRAFT_FIXED_COST_TOKENS)
  const packageChars = int(input.packageChars, deriveAutoTapeBudget(limit, 0.5))
  const growthPerTurnTokens = int(input.growthPerTurnTokens, DEFAULT_GROWTH_TOKENS_PER_TURN)
  const reserveTurns = int(input.reserveTurns, 2)
  const packageTokens = Math.ceil(packageChars / REVIEW_CHARS_PER_TOKEN)
  const growthReserveTokens = growthPerTurnTokens * reserveTurns
  const totalTokens = fixedTokens + packageTokens + growthReserveTokens
  return {
    windowLimit: limit,
    fixedTokens,
    packageChars,
    packageTokens,
    growthPerTurnTokens,
    reserveTurns,
    growthReserveTokens,
    totalTokens,
    ratio: limit > 0 ? totalTokens / limit : 0,
  }
}

export interface WatermarkThresholds {
  mode: 'fixed' | 'dynamic'
  /** Ratio at which the model is nudged to hand over on its own terms. */
  warnAt: number
  /** Ratio at which the system force-grafts regardless. */
  hardAt: number
  windowLimit: number
  estimatedGraftCost: number
  growthReserveTokens: number
  /** `1 - estimatedGraftCost / windowLimit`, before the ceiling/floor clamp. */
  safeCeiling: number
  /** False when even the floor cannot absorb the handoff; reported, never hidden. */
  feasible: boolean
  reason: string
}

function round4(value: number): number {
  return Number(value.toFixed(4))
}

// v1.3: clampRatio moved to src/utils/serialize.ts.

export interface WatermarkOptions {
  warnMargin?: number
  hardCeiling?: number
  hardFloor?: number
  minGap?: number
}

/**
 * v0.18: the two ratios, derived from a window and an estimated handoff cost.
 *
 * `estimatedGraftCost` is a token COUNT (not a ratio), because that is the unit
 * the caller can actually measure — see `estimateGraftCost`.
 */
export function calculateSafeWatermark(
  windowLimit: number,
  estimatedGraftCost: number,
  options: WatermarkOptions = {},
): WatermarkThresholds {
  const limit = Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : 0
  const cost = Number.isFinite(estimatedGraftCost) && estimatedGraftCost > 0 ? estimatedGraftCost : 0
  const hardCeiling = options.hardCeiling ?? WATERMARK_HARD_CEILING
  const hardFloor = options.hardFloor ?? WATERMARK_HARD_FLOOR
  const minGap = options.minGap ?? WATERMARK_MIN_GAP
  const warnMargin = options.warnMargin ?? WATERMARK_NUDGE_MARGIN
  if (limit === 0) {
    return {
      mode: 'dynamic',
      warnAt: round4(Math.max(0.01, hardCeiling - warnMargin)),
      hardAt: round4(hardCeiling),
      windowLimit: 0,
      estimatedGraftCost: cost,
      growthReserveTokens: 0,
      safeCeiling: round4(hardCeiling),
      feasible: false,
      reason: 'context window unknown; falling back to the hard ceiling',
    }
  }
  const safeCeiling = 1 - cost / limit
  const hardAt = round4(clampRatio(safeCeiling, hardFloor, hardCeiling))
  const warnAt = round4(clampRatio(hardAt - warnMargin, 0.05, hardAt - minGap))
  const feasible = safeCeiling >= hardFloor
  const reason = safeCeiling >= hardCeiling
    ? `cost ${cost} of ${limit} fits below the ceiling (${round4(safeCeiling)}); cutoff stays at ${hardCeiling}`
    : feasible
      ? `cost ${cost} of ${limit} = ${round4(cost / limit)} of the window; cutoff pulled to ${hardAt}`
      : `cost ${cost} of ${limit} = ${round4(cost / limit)} of the window does not fit the floor ${hardFloor}; cutoff held at ${hardAt} and the handoff may still fail`
  return {
    mode: 'dynamic',
    warnAt,
    hardAt,
    windowLimit: limit,
    estimatedGraftCost: cost,
    growthReserveTokens: 0,
    safeCeiling: round4(safeCeiling),
    feasible,
    reason,
  }
}

/**
 * v0.18: the thresholds a session is actually governed by.
 *
 * `watermarkMode: 'fixed'` returns the configured ratios verbatim — the old
 * behaviour, kept so a differential test can show that the DYNAMIC branch is what
 * changed a decision rather than some unrelated edit.
 */
export function effectiveWatermarks(
  settings: WatermarkSettings,
  watermark?: { contextWindow?: number; tokens?: number },
): WatermarkThresholds {
  const windowLimit = Number(
    watermark?.contextWindow && watermark.contextWindow > 0
      ? watermark.contextWindow
      : settings.contextWindowTokens,
  )
  if (settings.watermarkMode === 'fixed') {
    return {
      mode: 'fixed',
      warnAt: round4(settings.modelDrivenGraftAtRatio),
      hardAt: round4(settings.autoGraftAtRatio),
      windowLimit: Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : 0,
      estimatedGraftCost: 0,
      growthReserveTokens: 0,
      safeCeiling: round4(settings.autoGraftAtRatio),
      feasible: true,
      reason: 'watermarkMode=fixed: using modelDrivenGraftAtRatio / autoGraftAtRatio verbatim',
    }
  }
  const cost = estimateGraftCost(
    Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : 0,
    {
      growthPerTurnTokens: settings.growthTokensPerTurn,
      reserveTurns: settings.growthReserveTurns,
    },
  )
  const thresholds = calculateSafeWatermark(cost.windowLimit, cost.totalTokens)
  return { ...thresholds, growthReserveTokens: cost.growthReserveTokens }
}
