/**
 * ── v260 (B4-0b-2 §十二 / W0-2): the three-layer nudge defence ──────────────────────────────────
 *
 * THE DEFECT THIS PINS. W0 measured 25,180 adjacent steps and found 29 crossings — a pre-step below the
 * nudge line followed by one at/above the cutoff, with no sample in between. The nudge test was an
 * INTERVAL (`[warnAt, hardAt)`), and the measured worst single step was 320,941 tokens — 10.7× the
 * interval's 30,000-token width. So the model could be cut off having never been told, and the handoff
 * said nothing at all about it.
 *
 * THREE LAYERS, and this file drives all three through the REAL `agent/pre-step` listener — not through
 * the leaf functions with hand-fed arguments. That distinction is the whole `canred-must-drive-real-
 * callsite` rule (`v250`): a test that hands the right arguments to the right function proves the
 * function, not that the production path passes them.
 *
 *   ① de-intervalised: above the cutoff, with the forced cut NOT acting (autoGraft off), the model is
 *      still told. The old code's `ratio < ceiling` guard silenced exactly this case.
 *   ② predicted crossing: a session under the line whose measured growth would cross it is warned NOW.
 *      Reset points are excluded, so a post-compaction re-read does not masquerade as growth.
 *   ③ unconditional forced-cut mark: a session that JUMPS the window gets a mark even though no nudge
 *      was ever delivered, and the handoff says 「未经预警」 — never 「拒绝」, never 「70%」.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'
import {
  nudgeDeltas,
  predictGrowthTokens,
  recordNudgeSample,
} from '../src/core/nudge-margin.ts'

const NUDGE = /当前上下文水位已达 \d+%/u
const FORCED_WARNED = /预警已送达（\d+%）/u
const FORCED_UNANNOUNCED = /未经预警的强制中断/u
const REFUSAL = /拒绝/u

function setup({ window = 2600, config = {} } = {}) {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 7 })
  const ctx = makeCtx({ sourceLog: log, currentAgentId: log.session.id })
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    modelDrivenGraft: true,
    modelDrivenGraftAtRatio: 0.7,
    contextWindowTokens: window,
    watermarkMode: 'fixed',
    retireSource: true,
    verifyReadBack: true,
    ...config,
  })
  return { log, ctx }
}

function payloadFor(log, turn = 1, step = 1) {
  return {
    agent: { id: log.session.id },
    turn,
    step,
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续推进实现。' }] }],
  }
}

function textsOf(decision) {
  return (decision?.messages ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
}

/** Append one event to the live fixture log (`snapshotEvents` reads this array). */
function appendEvent(log, type, data) {
  const event = { type, seq: log.events.length, time: Date.now(), data }
  log.events.push(event)
  return event
}

function textsIn(stored) {
  const out = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.text === 'string') out.push(node.text)
    for (const value of Object.values(node)) walk(value)
  }
  walk(typeof stored === 'string' ? JSON.parse(stored) : stored)
  return out
}

test('v260 ①: ABOVE the cutoff with no forced cut acting, the model is still told (the interval is gone)', async () => {
  /**
   * `autoGraft: false` removes the cutoff entirely, so the branch that normally returns before the nudge
   * cannot run. The old code then ALSO withheld the nudge (`ratio < ceiling` with ceiling = 1 would have
   * allowed it — the real silence came from `ceiling = hardCutoffRatio` being 0.75 in the allowlist case).
   *
   * The configuration that reproduces it is the allowlist: autoGraft is ON (so a cutoff ratio is passed
   * in) but THIS session is excluded (so the cut never runs). 76% of a 2,500-token window used to sit in
   * exactly this hole: too full for the interval, no cut to force the hand, and therefore no message.
   */
  const { log, ctx } = setup({
    window: 2500,
    config: { autoGraftSessionIds: ['some-other-session'] },
  })
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))
  assert.equal(decision.kind, 'enter', 'an excluded session must not be cut')
  const joined = textsOf(decision).join('\n')
  assert.match(joined, NUDGE, 'above the line the model MUST be told, cut or no cut')
  assert.equal(getTransferredSessions().size, 0, 'and nothing was migrated')
})

test('v260 ②: a predicted crossing warns BEFORE the jump — driven through the real pre-step', async () => {
  /**
   * THE HARD PART OF THIS TEST IS AVOIDING A VACUOUS PASS. A predictor that always says "yes" would fire
   * here for the wrong reason, and a predictor that always says "no" would pass the negative half. So the
   * sequence below is built to cross the line by PREDICTION ONLY, with three measured steps that stay
   * under `warnAt`, and it asserts both halves:
   *
   *   · at 12,000 / 20,000 = 60% with p90 ≈ 1,000 and a 2,000-token floor, 12,000+2,000 = 14,000 does
   *     NOT reach the 15,000 cutoff ⇒ silent (so the guard is not a constant);
   *   · at 13,600 / 20,000 = 68% with p90 = 1,600, 13,600+1,600 = 15,200 ≥ 15,000 ⇒ fires BELOW the line.
   *
   * `warnAt` is 70% here (fixed 0.70/0.75 on a 20k window), so 68% is genuinely under it — the message
   * can only come from layer 2.
   */
  const window = 20_000
  const { log, ctx } = setup({ window })
  const step = async (tokens, turn) => {
    appendEvent(log, 'request/context', { contextWindow: window })
    appendEvent(log, 'assistant/message', { usage: { inputTokens: tokens, outputTokens: 10, totalTokens: tokens + 10 } })
    return dispatchPreStep(ctx, payloadFor(log, turn, 1))
  }
  // Three measured steps with consistent 1,400 growth: the p90 is 1,400, which is exactly one ten-th of
  // this window (the floor cap) — the predictor is using MEASURED data here, not the floor.
  await step(10_000, 1) // 50%
  await step(11_400, 2) // 57%
  const third = await step(12_800, 3) // 64%
  assert.doesNotMatch(textsOf(third).join('\n'), NUDGE, 'below the line AND under the cutoff: stay quiet')

  const fourth = await step(13_000, 4) // 65% — 13,000+1,400 = 14,400 < 15,000 ⇒ still room
  assert.doesNotMatch(textsOf(fourth).join('\n'), NUDGE, '65% with 1,400 of growth still has room')

  // 13,700 = 68.5%: BELOW `warnAt` (70%), but 13,700 + 1,400 = 15,100 ≥ 15,000 ⇒ predicted crossing.
  const predicted = await step(13_700, 5)
  const joined = textsOf(predicted).join('\n')
  assert.match(joined, NUDGE, 'the prediction must warn while there is still room, i.e. BELOW warnAt')
  /**
   * Evidence that it was the PREDICTION, not the ratio: the audit line carries the reason. Reading the
   * audit file (not a re-implementation) is what makes this a claim about the production path.
   */
  const audit = readFileSync(join(ctx.pathsData, '.graft-audit.jsonl'), 'utf8')
  const lines = audit.split('\n').filter((line) => line.includes('"kind":"model-nudge"'))
  assert.ok(lines.length > 0, 'the nudge must leave an audit line')
  const last = JSON.parse(lines.at(-1))
  assert.match(String(last.detail), /reason=predicted/u, `the last nudge must be the predicted one: ${last.detail}`)
  assert.match(String(last.detail), /wouldCross=true/u, 'and it must have said so')
  assert.ok(Number(last.ratio) < 0.7, `and it fired BELOW warnAt; ratio=${last.ratio}`)
})

test('v260 ②b: the predictor is fed the SESSION ITSELF, and a reset clears it', () => {
  /**
   * A leaf-level pin on the two exclusions, using the SHIPPED functions (not a copy of the arithmetic).
   * `v260 ②` above covers the wiring into the production path; this covers the rules the wiring relies on.
   */
  let ring = []
  /**
   * Tokens are well above 5% of the window on purpose: `recordNudgeSample` drops a trailing sample under
   * `SHRINK_RATIO × W`, so a fixture starting at 1,000 of 100,000 would be treated as a post-reset
   * baseline — and (correctly) discarded. The first draft of this test did exactly that and failed with
   * an empty delta list, which is the exclusion working, not a bug.
   */
  for (const [seq, tokens] of [[1, 20_000], [2, 21_000], [3, 22_000], [4, 23_000]]) {
    ring = recordNudgeSample(ring, { seq, tokens }, 100_000, false)
  }
  assert.deepEqual(nudgeDeltas(ring), [1000, 1000, 1000])
  assert.equal(predictGrowthTokens(nudgeDeltas(ring), 100_000).from, 'p90')

  // A reset invalidates everything before it: the next delta would span the replacement.
  ring = recordNudgeSample(ring, { seq: 5, tokens: 90_000 }, 100_000, true)
  assert.equal(ring.length, 1, 'a reset discards the ring instead of averaging across it')
  assert.equal(nudgeDeltas(ring).length, 0)
  assert.equal(predictGrowthTokens(nudgeDeltas(ring), 100_000).from, 'floor')

  // `shrinkThenGrow`: a trailing sample under 5% of the window is a post-reset context, not a base.
  ring = recordNudgeSample([{ seq: 10, tokens: 500 }], { seq: 11, tokens: 80_000 }, 100_000, false)
  assert.equal(ring.length, 1, 'the tiny baseline is dropped, so its re-read is not "growth"')
  assert.equal(ring[0].tokens, 80_000)
})

test('v260 ③: a JUMPED window gets an 「未经预警」 mark even though no nudge was ever delivered', async () => {
  /**
   * THE CASE LAYER 2 CANNOT SAVE. The session sits at 19% — nowhere near the 70% nudge line, so NO nudge
   * is delivered — and then one step takes it to 80%, past the 75% cutoff. No p90, no margin, no
   * prediction can bridge 56 points. The old code set the mark ONLY when a nudge had been delivered, so
   * this — the exact failure the ruling was written about — produced no mark at all and the target read a
   * forced stop as a planned handover.
   *
   * The window is deliberately LARGE relative to the fixture's 1,900-token usage: the first case that
   * comes to mind (2,600 window) starts at 73% and therefore DOES get nudged, which tests the announced
   * branch instead. That distinction is the point of this test, so the setup has to be exact.
   */
  const { log, ctx } = setup({ window: 10_000 })
  const first = await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  assert.doesNotMatch(textsOf(first).join('\n'), NUDGE, '19% of the window: no nudge may be delivered')
  // One giant step: 1,900 → 8,000 = 19% → 80%, past the 75% cutoff, with no sample in between.
  appendEvent(log, 'assistant/message', { usage: { inputTokens: 8000, outputTokens: 80, totalTokens: 8080 } })

  const cut = await dispatchPreStep(ctx, payloadFor(log, 2, 1))
  assert.equal(cut.kind, 'reject', 'the hard cutoff still stops the step')
  const targetId = getTransferredSessions().get(log.session.id)?.newSessionId
  assert.ok(targetId, 'a target must have been created')

  const note = textsIn(ctx._persistence.read(targetId)).find((text) => FORCED_UNANNOUNCED.test(text))
  assert.ok(note, `the handoff must disclose an UNANNOUNCED cut; got: ${textsIn(ctx._persistence.read(targetId)).join(' | ').slice(0, 600)}`)
  assert.doesNotMatch(note, REFUSAL, 'and must not assert a motive it cannot observe')
  assert.doesNotMatch(note, /70%/u, 'nor name a threshold that is not necessarily in force')
  assert.match(note, /从 19% 跳到 80%/u, 'and it must state the jump it observed')
})

test('v260 ③b: a nudged session says 「预警已送达」 at the ratio the nudge actually used', async () => {
  const { log, ctx } = setup()
  const nudged = await dispatchPreStep(ctx, payloadFor(log, 1, 1))
  assert.match(textsOf(nudged).join('\n'), NUDGE, 'the nudge must fire first')
  appendEvent(log, 'assistant/message', { usage: { inputTokens: 2000, outputTokens: 80, totalTokens: 2080 } })
  const cut = await dispatchPreStep(ctx, payloadFor(log, 2, 1))
  assert.equal(cut.kind, 'reject')
  const targetId = getTransferredSessions().get(log.session.id)?.newSessionId
  const note = textsIn(ctx._persistence.read(targetId)).find((text) => FORCED_WARNED.test(text))
  assert.ok(note, 'a nudged session must report that the nudge was delivered')
  assert.doesNotMatch(note, FORCED_UNANNOUNCED, 'the two sentences are exclusive')
  assert.doesNotMatch(note, REFUSAL)
})
