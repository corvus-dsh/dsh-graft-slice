/**
 * v0.18 module 2 — the watermark is DERIVED, and it is never later than the
 * historical cutoff.
 *
 * The old contract was two constants (0.70 / 0.75). A constant encodes one
 * assumption — that a handoff costs the same fraction of every window — and that
 * is false at both ends: on a 1M-token window 0.75 is needlessly early, and on a
 * 2.6k-token window it is impossible (the graft cannot finish before the window
 * fills during the graft itself).
 *
 * What is asserted here:
 *   1. the cost model is a token COUNT with named terms;
 *   2. the derived pair is monotone in the cost and clamped to a sane band;
 *   3. the historical ratios survive as the CEILING and as `watermarkMode: fixed`;
 *   4. the running system actually cuts earlier when the window cannot absorb a
 *      handoff — end to end, on a live pre-step.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  calculateSafeWatermark,
  collectDebugStatus,
  effectiveWatermarks,
  estimateGraftCost,
  normalizeConfig,
  resetRetiredSessions,
  WATERMARK_HARD_CEILING,
  WATERMARK_HARD_FLOOR,
} from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const BIG_WINDOW = 128_000
const SMALL_WINDOW = 32_000
const TINY_WINDOW = 2_600

test('v0.18: the cost estimate names its terms and scales with the window', () => {
  const cost = estimateGraftCost(SMALL_WINDOW)
  assert.equal(cost.windowLimit, SMALL_WINDOW)
  assert.ok(cost.fixedTokens > 0, 'the prepare -> commit round trip is not free')
  assert.ok(cost.packageTokens > 0, 'the review/plan echo is part of the cost')
  assert.equal(cost.growthReserveTokens, cost.growthPerTurnTokens * cost.reserveTurns)
  assert.equal(cost.totalTokens, cost.fixedTokens + cost.packageTokens + cost.growthReserveTokens)
  assert.equal(cost.ratio > 0, true)

  // A bigger window carries a bigger package, so the package term grows with it.
  assert.ok(estimateGraftCost(BIG_WINDOW).packageTokens > cost.packageTokens)
  // Overrides are honoured (this is what makes the model auditable).
  const priced = estimateGraftCost(SMALL_WINDOW, { fixedTokens: 100, packageChars: 400, growthPerTurnTokens: 10, reserveTurns: 1 })
  assert.equal(priced.totalTokens, 100 + 100 + 10)
})

test('v0.18: the derivation is monotone in cost, clamped to the historical band', () => {
  const cheap = calculateSafeWatermark(BIG_WINDOW, 1_000)
  const dear = calculateSafeWatermark(BIG_WINDOW, 60_000)
  assert.ok(dear.hardAt < cheap.hardAt, 'a dearer handoff moves the cutoff earlier')

  // Never later than the measured turn-stopping ceiling, never earlier than the floor.
  assert.equal(cheap.hardAt, WATERMARK_HARD_CEILING)
  assert.equal(calculateSafeWatermark(BIG_WINDOW, 10_000_000).hardAt, WATERMARK_HARD_FLOOR)
  assert.equal(calculateSafeWatermark(BIG_WINDOW, 10_000_000).feasible, false, 'an impossible handoff says so')
  assert.equal(cheap.feasible, true)

  // The nudge always leaves the model a window to act in.
  for (const thresholds of [cheap, dear, calculateSafeWatermark(BIG_WINDOW, 10_000_000)]) {
    assert.ok(thresholds.warnAt < thresholds.hardAt, `${thresholds.warnAt} < ${thresholds.hardAt}`)
  }
  assert.equal(calculateSafeWatermark(0, 5_000).feasible, false, 'an unknown window is not a safe window')
})

test('v0.18: on a real window the derived pair is not later than the old constants', () => {
  const settings = normalizeConfig({})
  assert.equal(settings.watermarkMode, 'dynamic')

  // The default profile: the estimate fits, so the constants remain the ceiling —
  // this is the no-regression half of the change, stated as an assertion.
  const big = effectiveWatermarks(settings, { contextWindow: BIG_WINDOW })
  assert.equal(big.mode, 'dynamic')
  assert.equal(big.hardAt, 0.75)
  assert.equal(big.warnAt, 0.7)
  assert.match(big.reason, /fits below the ceiling/u)

  // A window that cannot absorb the handoff: the cutoff moves EARLIER, and the two
  // numbers are still 5 points apart.
  const small = effectiveWatermarks(settings, { contextWindow: SMALL_WINDOW })
  assert.equal(small.hardAt, 0.6125)
  assert.equal(small.warnAt, 0.5625)
  assert.ok(small.hardAt < 0.75)
  assert.ok(small.feasible)
})

test('v0.18: the growth prediction moves the cutoff, so the tool long tail is priced', () => {
  const calm = effectiveWatermarks(normalizeConfig({}), { contextWindow: 64_000 })
  const busy = effectiveWatermarks(
    normalizeConfig({ growthTokensPerTurn: 5_000, growthReserveTurns: 3 }),
    { contextWindow: 64_000 },
  )
  assert.equal(calm.hardAt, 0.7438)
  assert.equal(busy.hardAt, 0.5469)
  assert.ok(busy.hardAt < calm.hardAt, 'a session that grows fast must be cut earlier')
  assert.equal(busy.growthReserveTokens, 15_000)
})

test('v0.18: watermarkMode=fixed restores the constants verbatim (the differential)', () => {
  const fixed = effectiveWatermarks(
    normalizeConfig({ watermarkMode: 'fixed', modelDrivenGraftAtRatio: 0.7, autoGraftAtRatio: 0.75 }),
    { contextWindow: TINY_WINDOW },
  )
  assert.equal(fixed.mode, 'fixed')
  assert.equal(fixed.hardAt, 0.75)
  assert.equal(fixed.warnAt, 0.7)
  assert.match(fixed.reason, /verbatim/u)
})

test('v0.18: dynamic pricing cuts a small-window session BEFORE the old nudge could fire', async () => {
  // 7 turns -> last provider usage 1900 input tokens. On a 2600-token window that
  // is ~73%: under `fixed` it is a nudge, under `dynamic` the window cannot absorb
  // a handoff at all (cost 8725 > 2600), so the cutoff is the floor and the session
  // is already past it.
  const base = {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    modelDrivenGraft: true,
    modelDrivenGraftAtRatio: 0.7,
    contextWindowTokens: TINY_WINDOW,
    retireSource: true,
    verifyReadBack: true,
  }

  const fixedLog = makeSourceLog({ turns: 7 })
  const fixedCtx = makeCtx({ sourceLog: fixedLog })
  resetRetiredSessions()
  apply(fixedCtx, { ...base, watermarkMode: 'fixed' })
  const fixedDecision = await dispatchPreStep(fixedCtx, { agent: { id: fixedLog.session.id }, turn: 1, step: 1, messages: [] })
  assert.equal(fixedDecision.kind, 'enter', 'fixed mode nudges instead of cutting')

  const dynamicLog = makeSourceLog({ turns: 7 })
  const dynamicCtx = makeCtx({ sourceLog: dynamicLog })
  resetRetiredSessions()
  apply(dynamicCtx, { ...base, watermarkMode: 'dynamic' })
  const dynamicDecision = await dispatchPreStep(dynamicCtx, { agent: { id: dynamicLog.session.id }, turn: 1, step: 1, messages: [] })
  assert.equal(dynamicDecision.kind, 'reject')
  assert.match(dynamicDecision.reason, /已自动迁移/u)
  resetRetiredSessions()
})

test('v0.18: the debug panel explains the derivation, not just the numbers', () => {
  const settings = normalizeConfig({})
  const status = collectDebugStatus({
    section: 'watermark',
    settings,
    watermark: { tokens: 15_000, contextWindow: SMALL_WINDOW, ratio: 15_000 / SMALL_WINDOW, source: 'usage' },
  })
  const watermark = status.watermark
  assert.equal(watermark.watermarkMode, 'dynamic')
  assert.equal(watermark.hardAt, 0.6125)
  assert.equal(watermark.feasible, true)
  assert.equal(watermark.estimatedGraftCost, 12_400)
  assert.match(String(watermark.thresholdReason), /pulled to/u)
  assert.equal(watermark.state, 'below-warn-line')
})
