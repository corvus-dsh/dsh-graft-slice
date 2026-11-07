/**
 * AUDIT F1 and F2 — the two defects where "the parameter exists" was mistaken for "the parameter workes".
 *
 * F1: `recentTurns` was overwritten by a shape-based guess whenever `adaptiveDepth` was on, which is
 *     the default. The documented field, present in `cordis.patch.yml` with its own comment, did
 *     nothing. Measured: the same source sliced with recentTurns = 1, 2 and 5 produced byte-identical
 *     tapes. It "worked" only with `adaptiveDepth=false`, where the override is an identity — which
 *     is why the old suite never saw it.
 *
 * F2: `callsPerTurn` divided by the WINDOW SIZE (a constant 6) instead of the number of turns the
 *     window actually contained. A session shorter than six turns got its tool density under-reported
 *     by the ratio, so the shortest, most precious sessions were classified "generation-shaped" and
 *     given the loosest boundary.
 *
 * THE RULE THESE TESTS ENCODE, stated once: a parameter must have a test proving that CHANGING IT
 * CHANGES THE RESULT. Asserting "passing it does not throw" is what let both defects live.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInjectionPlan, calculateAdaptiveDepth, normalizeConfig } from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

/** A log of `turns` turns with an ADDITIONAL constant `perTurn` tool calls each — isolates the divisor. */
function logWithDensity(turns, perTurn) {
  const log = makeSourceLog({ turns })
  for (let t = 1; t <= turns; t += 1) {
    for (let k = 0; k < perTurn; k += 1) {
      log.events.push({
        type: 'tool/call',
        seq: 0,
        time: 0,
        data: { turn: t, step: 1, callId: `c-${t}-${k}`, name: 'pwsh', arguments: '{}' },
      })
    }
  }
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

/** Total tool calls and turn starts actually present, so the expectation is derived not assumed. */
function counts(events) {
  let calls = 0
  let turns = 0
  for (const event of events) {
    if (event.type === 'tool/call') calls += 1
    if (event.type === 'turn/start') turns += 1
  }
  return { calls, turns }
}

/**
 * The denominator the fixed code uses, computed independently of it:
 * calls inside the WINDOW (the last `windowTurns` turns, or everything if there are fewer)
 * divided by the number of `turn/start` events actually inside that window.
 *
 * `windowTurns` is 6 by definition of the window, so a log longer than six turns reports density
 * over the last six — that is the WINDOW being applied, which is correct and is why this expectation
 * cannot simply be `calls / allTurns`.
 */
function expectedDensity(events, windowTurns = 6) {
  const starts = []
  events.forEach((e, i) => {
    if (e.type === 'turn/start') starts.push(i)
  })
  const windowStart = starts.length > windowTurns ? starts[starts.length - windowTurns] : 0
  const window = events.slice(windowStart)
  let calls = 0
  let turns = 0
  for (const e of window) {
    if (e.type === 'tool/call') calls += 1
    if (e.type === 'turn/start') turns += 1
  }
  return (calls / Math.max(1, turns)).toFixed(1)
}

const SETTINGS = { adaptiveDepthMin: 3, adaptiveDepthMax: 8 }

test('audit F2: tool-call density is per ACTUAL turn in the window, not per window size', () => {
  /**
   * The measured defect: the old code divided the window's tool calls by `Math.max(1, windowTurns)`
   * — the WINDOW SIZE, always 6 — instead of by the turns the window really contained. For a session
   * shorter than six turns that is a systematic under-report: 6 calls over 2 turns reported 1.0
   * instead of 3.0, and the shortest, most precious sessions were classified "generation-shaped" and
   * given the loosest boundary.
   *
   * The expectations below are DERIVED by an independent re-count (`expectedDensity`) rather than
   * hard-coded, because hard-coding would test my arithmetic instead of the code. And a 6-turn log
   * is used on purpose: `windowTurns` IS 6, so for exactly six turns the old and new divisors
   * coincide and the assertion isolates the divisor rather than the window.
   */
  const shortLog = logWithDensity(2, 3)
  const short = calculateAdaptiveDepth(shortLog.events, SETTINGS)
  const wantShort = expectedDensity(shortLog.events)
  assert.match(
    short.reason,
    new RegExp(`${wantShort.replace('.', '\\.')} tool calls/turn`, 'u'),
    `2-turn log must report ${wantShort} calls/turn, got: ${short.reason}`,
  )
  /**
   * THE PROOF THAT THE OLD CODE WOULD FAIL THIS: for a 2-turn log, `calls / 6` differs from the
   * correct value. If those two ever coincided the assertion above would be vacuous.
   */
  const callsShort = shortLog.events.filter((e) => e.type === 'tool/call').length
  assert.notEqual(
    (callsShort / 6).toFixed(1),
    wantShort,
    'precondition: for a 2-turn log, the old divisor must differ from the correct one',
  )
  const shortTurns = shortLog.events.filter((e) => e.type === 'turn/start').length
  assert.equal(shortTurns, 2)

  /**
   * And the longer log, where the WINDOW applies: density is over the last six turns, which the
   * independent re-count already accounts for. Length still must not be mistaken for density.
   */
  const longLog = logWithDensity(8, 3)
  const long = calculateAdaptiveDepth(longLog.events, SETTINGS)
  const wantLong = expectedDensity(longLog.events)
  assert.match(
    long.reason,
    new RegExp(`${wantLong.replace('.', '\\.')} tool calls/turn`, 'u'),
    `8-turn log must report ${wantLong} calls/turn over its 6-turn window, got: ${long.reason}`,
  )
})

test('audit F2: a session with NO turn/start events still divides by one, not zero', () => {
  /**
   * The guard on the fix itself. Replacing the constant with a real count introduces a division by
   * zero wherever a window has tool calls but no `turn/start` (a log truncated mid-turn, or a
   * provider that does not emit the marker). `Math.max(1, …)` stays, and this pins it.
   */
  const events = [
    { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'x', name: 'pwsh', arguments: '{}' } },
    { type: 'tool/result', seq: 1, time: 0, data: { turn: 1, step: 1, message: { role: 'tool', content: [] } } },
  ]
  const result = calculateAdaptiveDepth(events, SETTINGS)
  assert.equal(Number.isFinite(result.depth), true, 'a missing turn/start must not produce NaN/Infinity')
  assert.match(result.reason, /tool calls\/turn/u)
  assert.doesNotMatch(result.reason, /NaN|Infinity/u)
})

test('audit F1: an EXPLICIT recentTurns changes the plan, and the default does not', () => {
  /**
   * The assertion the old suite was missing: the same log, two explicit values, DIFFERENT results.
   * Before the fix all three of 1 / 2 / 5 were byte-identical because `adaptive.depth` replaced them.
   */
  const log = makeSourceLog({ turns: 9 })

  const plan1 = buildInjectionPlan(log, { recentTurns: 1 })
  const plan4 = buildInjectionPlan(log, { recentTurns: 4 })
  assert.equal(plan1.recentTurnCount, 1, 'recentTurns=1 must replay exactly 1 turn')
  assert.equal(plan4.recentTurnCount, 4, 'recentTurns=4 must replay exactly 4 turns')
  assert.notEqual(
    plan1.recentInjectedCount,
    plan4.recentInjectedCount,
    'an explicit count must change how much is replayed — otherwise the parameter is decorative',
  )

  // And the adaptive guess must NOT override either of them.
  assert.equal(plan1.adaptiveDepth.mode !== undefined, true, 'the guess is still COMPUTED and reported')
  assert.equal(plan1.recentTurnCount, 1, 'but it must not win over an explicit instruction')
})

test('audit F1: omitting recentTurns keeps the self-tuning behaviour', () => {
  /**
   * The other half of the contract, and the reason `recentTurnsExplicit` exists rather than a
   * "recentTurns was set" heuristic: a caller who says nothing must still get adaptive depth.
   */
  const log = makeSourceLog({ turns: 9 })
  const plan = buildInjectionPlan(log, {})
  const normalized = normalizeConfig({})
  assert.equal(normalized.recentTurnsExplicit, false, 'a default is not an instruction')
  assert.equal(
    plan.recentTurnCount,
    plan.adaptiveDepth.depth,
    'with no explicit count, the adaptive depth decides — exactly what "I did not say" means',
  )
})

test('audit F1: explicitness survives being normalized twice', () => {
  /**
   * THE REGRESSION THIS PINS, and it bit during the fix. `apply()` normalizes the operator's config
   * and hands the RESULT down; `buildInjectionPlan` normalizes AGAIN. On the second pass the default
   * 5 the first pass wrote looks exactly like a value the operator named — so naive explicitness
   * detection flips to `true` and adaptive depth silently stops working for everyone.
   */
  assert.equal(normalizeConfig({}).recentTurnsExplicit, false)
  assert.equal(normalizeConfig({ recentTurns: 5 }).recentTurnsExplicit, true)

  const once = normalizeConfig({})
  const twice = normalizeConfig(once)
  assert.equal(twice.recentTurnsExplicit, false, 'the second normalization must not invent explicitness')
  assert.equal(twice.recentTurns, once.recentTurns, 'and must not change the value either')

  // An explicit value stays explicit through re-normalization, which is what apply() relies on.
  const explicitOnce = normalizeConfig({ recentTurns: 2 })
  const explicitTwice = normalizeConfig(explicitOnce)
  assert.equal(explicitTwice.recentTurnsExplicit, true)
  assert.equal(explicitTwice.recentTurns, 2)
})
