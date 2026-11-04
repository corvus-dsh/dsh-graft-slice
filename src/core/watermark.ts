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

/**
 * v1.3 batch 2, step 3b ??the service surface this module needs, declared structurally.
 *
 * Deliberately NOT imported from index.ts: the dependency must stay one-way, and the
 * earlier decision (types erased at build time, so an import would be invisible at runtime
 * but still a design inversion) is the reason this interface exists.
 */
export interface WatermarkContext {
  get?: (name: string) => any
  sessionQuery: { readSession: (id: string) => Promise<unknown> }
}

export interface SessionEventLike {
  type: string
  seq: number
  time?: number
  data?: any
  surfaceOp?: any
  sourceEventSeqs?: any
}

export function textOfMessage(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

export function estimateTokensFromText(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/gu) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

/**
 * v7.0: per-session incremental fold state for the watermark.
 *
 * `scannedUpTo` is the event count the cached figures were computed at, so a
 * later call only consumes the tail. Cleared by `resetRetiredSessions()`.
 */
export const watermarkCache = new Map<
  string,
  { scannedUpTo: number; contextWindow: number; usageTokens: number }
>()

/**
 * v4.0 / v7.0 P0-2: token pressure, measured by the HOST first.
 *
 * The plugin used to compute this itself: read `contextWindow` from the last
 * `request/context`, read `usage.inputTokens` from the last `assistant/message`,
 * and if neither existed, estimate from a character count. That estimate is a
 * different number from the one the host's compaction engine acts on
 * (`tokenMeter.measure()` prices per surface node, reuses provider usage only
 * when the request envelope matches, and re-prices the whole surface
 * otherwise). Two owners of one session disagreeing about "how full is it" is
 * how a plugin migrates at 60% while the engine thinks it is at 43%.
 *
 * The order below is deliberate:
 *
 *   1. `ctx.tokenMeter.measure(session)` — the authoritative measurement. The
 *      session must be LIVE for this (the meter folds over a Session object, not
 *      a snapshot), so it is skipped when the session is not in the store.
 *   2. Provider usage + context window from the log — still real data, just not
 *      the host's fold. Used when the meter is absent or the session is detached.
 *   3. Character estimate — last resort, and it says so in the returned source.
 *
 * The `source` field is not decoration: a migration log that cannot say which
 * of the three produced the number is unauditable.
 */
export async function readTokenWatermark(
  ctx: WatermarkContext,
  sourceSessionId: string,
  settings: WatermarkSettings,
): Promise<TokenWatermark | undefined> {
  // --- 1. the host's own measurement -------------------------------------
  try {
    const meter = ctx.get?.('tokenMeter')
    const live = ctx.get?.('sessions')?.get?.(sourceSessionId)
    if (meter !== undefined && meter !== null && typeof meter.measure === 'function' && live !== undefined) {
      const measurement = meter.measure(live)
      const total = Number(measurement?.totalTokens)
      const window = Number(
        live?.requestContext?.()?.contextWindow ?? 0,
      )
      const contextWindow = settings.contextWindowTokens > 0 ? settings.contextWindowTokens : window
      if (Number.isFinite(total) && total > 0 && Number.isFinite(contextWindow) && contextWindow > 0) {
        return { tokens: total, contextWindow, ratio: total / contextWindow, source: 'tokenMeter' }
      }
    }
  } catch {
    // Fall through: a meter that throws must not stop the migration check.
  }

  // --- 2. incremental fold over the LIVE log -----------------------------
  //
  // The old path called `ctx.sessionQuery.readSession()` on every pre-step, which
  // replays and validates the ENTIRE log — O(n) per step, on a session that is
  // already the largest thing in the process. That is the wrong complexity for a
  // check that runs before every model request.
  //
  // When the session is live we can fold incrementally instead: keep the cached
  // watermark per session plus the log length it was computed at, and on each
  // call consume only the events appended since. The two facts that matter
  // (newest `contextWindow`, newest provider usage) are both "last one wins", so
  // an incremental fold is exact, not an approximation.
  //
  // The full read stays as the fallback for a detached session, where there is
  // no live log to fold and the snapshot is the only source.
  const liveForFold = (() => {
    try {
      return ctx.get?.('sessions')?.get?.(sourceSessionId)
    } catch {
      return undefined
    }
  })()
  if (liveForFold !== undefined && typeof liveForFold.snapshotEvents === 'function') {
    try {
      const events = liveForFold.snapshotEvents(0) as readonly SessionEventLike[]
      const cached = watermarkCache.get(sourceSessionId)
      let contextWindow = cached?.contextWindow ?? 0
      let usageTokens = cached?.usageTokens ?? 0
      let from = cached?.scannedUpTo ?? 0
      // A shorter log than we remember means the store was replaced (restore,
      // migration, HMR). Recompute from scratch rather than trusting the fold.
      if (cached !== undefined && events.length < cached.scannedUpTo) {
        contextWindow = 0
        usageTokens = 0
        from = 0
      }
      for (let index = from; index < events.length; index += 1) {
        const event = events[index]
        if (event?.type === 'request/context') {
          const window = Number(event.data?.contextWindow)
          if (Number.isFinite(window) && window > 0) contextWindow = window
          continue
        }
        if (event?.type === 'assistant/message') {
          const usage = event.data?.usage
          const candidate =
            typeof usage?.inputTokens === 'number'
              ? usage.inputTokens
              : typeof usage?.totalTokens === 'number'
                ? usage.totalTokens
                : 0
          if (candidate > 0) usageTokens = candidate
        }
      }
      watermarkCache.set(sourceSessionId, { scannedUpTo: events.length, contextWindow, usageTokens })
      const effectiveWindow = settings.contextWindowTokens > 0 ? settings.contextWindowTokens : contextWindow
      if (usageTokens > 0 && Number.isFinite(effectiveWindow) && effectiveWindow > 0) {
        return {
          tokens: usageTokens,
          contextWindow: effectiveWindow,
          ratio: usageTokens / effectiveWindow,
          source: 'incremental',
        }
      }
    } catch {
      // Fall through to the full read.
    }
  }

  let snapshot: any
  try {
    snapshot = await ctx.sessionQuery.readSession(sourceSessionId)
  } catch {
    return undefined
  }
  const events: any[] = Array.isArray(snapshot?.events) ? snapshot.events : []
  if (events.length === 0) return undefined
  let contextWindow = 0
  for (const event of events) {
    if (event.type === 'request/context' && typeof event.data?.contextWindow === 'number' && event.data.contextWindow > 0) {
      contextWindow = event.data.contextWindow
    }
  }
  if (settings.contextWindowTokens > 0) contextWindow = settings.contextWindowTokens
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  let usageTokens = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    const candidate =
      typeof usage?.inputTokens === 'number'
        ? usage.inputTokens
        : typeof usage?.totalTokens === 'number'
          ? usage.totalTokens
          : 0
    if (candidate > 0) {
      usageTokens = candidate
      break
    }
  }
  // --- 2. provider usage, when the log carries one ------------------------
  if (usageTokens > 0) {
    return { tokens: usageTokens, contextWindow, ratio: usageTokens / contextWindow, source: 'usage' }
  }
  // --- 3. character estimate, last resort --------------------------------
  const text = events
    .map((event) => {
      const message = event.data?.message ?? event.data
      return textOfMessage(message) || String(event.data?.arguments ?? '')
    })
    .join('\n')
  const tokens = Math.max(usageTokens, estimateTokensFromText(text))
  return { tokens, contextWindow, ratio: tokens / contextWindow, source: 'estimate' }
}
