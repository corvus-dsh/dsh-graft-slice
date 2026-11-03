/**
 * v7.6 (Model-Driven): hand the decision to the model, keep the system as fallback.
 *
 * THE CHANGE
 *
 * v4.0 cut at 75% regardless of what the model was doing. Inside a long
 * implementation round that is a physical interruption: the sentence being
 * written and the tool call just issued are lost. v7.6 reserves a 5% margin —
 * at 70% the model is told, once per turn, that it may hand over itself. It can
 * finish the current action, inspect `graft_prepare`, and call
 * `graft_slice_and_inject` at a point it chose. The 75% hard cutoff remains: an
 * ignored nudge still ends in a forced migration.
 *
 * These tests pin the two watermarks, the one-nudge-per-turn pacing, and the
 * target's "continue without waiting" bootstrap.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  buildInjectionPlan,
  getTransferredSessions,
  normalizeConfig,
  resetRetiredSessions,
} from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const NUDGE = /当前上下文水位已达 \d+%/u
const USER_TURN = '继续推进实现，先把这一轮写完。'

/** 7 turns → last provider usage is 1900 input tokens; the window sets the ratio. */
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
    retireSource: true,
    verifyReadBack: true,
    ...config,
  })
  return { log, ctx }
}

function payloadFor(log, turn = 1) {
  return {
    agent: { id: log.session.id },
    turn,
    step: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: USER_TURN }] }],
  }
}

function textsOf(decision) {
  return (decision?.messages ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
}

test('v7.6: at 70–75% the model is nudged to hand over, and the system does not cut', async () => {
  // 1900 / 2600 ≈ 73% — inside the [0.70, 0.75) window.
  const { log, ctx } = setup()
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))

  assert.equal(decision.kind, 'enter', 'a nudge must not reject the step')
  const joined = textsOf(decision).join('\n')
  assert.match(joined, /^\[系统提示\] 当前上下文水位已达 73%。/mu)
  assert.match(joined, /graft_prepare/u, 'the model must be told how to inspect the handoff')
  assert.match(joined, /graft_slice_and_inject/u, 'and how to perform it')
  assert.equal(getTransferredSessions().size, 0, 'the model decides; no forced migration yet')
})

test('v7.6: the nudge is injected at most once per turn', async () => {
  const { log, ctx } = setup()
  const first = await dispatchPreStep(ctx, payloadFor(log, 1))
  assert.equal(textsOf(first).filter((text) => NUDGE.test(text)).length, 1)
  // Same turn, next step: pre-step runs again, the reader must not be nagged.
  const second = await dispatchPreStep(ctx, payloadFor(log, 1))
  assert.equal(textsOf(second).filter((text) => NUDGE.test(text)).length, 0)
  // A new turn is a new chance to notice the watermark.
  const nextTurn = await dispatchPreStep(ctx, payloadFor(log, 2))
  assert.equal(textsOf(nextTurn).filter((text) => NUDGE.test(text)).length, 1)
})

test('v7.6: below 70% nothing is injected', async () => {
  // 1900 / 3000 ≈ 63%.
  const { log, ctx } = setup({ window: 3000 })
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))
  assert.equal(decision.kind, 'enter')
  assert.equal(textsOf(decision).filter((text) => NUDGE.test(text)).length, 0)
})

test('v7.6: modelDrivenGraft:false keeps the old silent behaviour', async () => {
  const { log, ctx } = setup({ config: { modelDrivenGraft: false } })
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))
  assert.equal(decision.kind, 'enter')
  assert.equal(textsOf(decision).filter((text) => NUDGE.test(text)).length, 0)
  assert.equal(getTransferredSessions().size, 0)
})

test('v7.6: at 75% the fallback takes over — a forced graft, never a nudge', async () => {
  // 1900 / 2500 = 76% — over the hard cutoff.
  const { log, ctx } = setup({ window: 2500 })
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))

  assert.equal(decision.kind, 'reject', 'the hard cutoff still stops the step')
  assert.match(decision.reason, /已自动迁移/u)
  const transfer = getTransferredSessions().get(log.session.id)
  assert.ok(transfer, 'the forced migration must have produced a target')
  assert.doesNotMatch(JSON.stringify(decision), NUDGE, 'above the cutoff the nudge is not used')
})

test('v7.6: without a hard cutoff the nudge is the only exit', async () => {
  // autoGraft off → ceiling is 100%; the model is still told at 70%.
  const { log, ctx } = setup({ config: { autoGraft: false } })
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))
  assert.equal(decision.kind, 'enter')
  assert.match(textsOf(decision).join('\n'), NUDGE)
  assert.equal(getTransferredSessions().size, 0)
})

test('v7.6: an allowlist-excluded session has no cutoff, so its nudge window extends', async () => {
  // 76% would force-graft a normal session; this one is excluded from autoGraft,
  // so the 70% nudge is the only handover mechanism it has.
  const { log, ctx } = setup({ window: 2500, config: { autoGraftSessionIds: ['some-other-session'] } })
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))
  assert.equal(decision.kind, 'enter', 'no cutoff applies, so the step must not be rejected')
  assert.match(textsOf(decision).join('\n'), NUDGE)
  assert.equal(getTransferredSessions().size, 0)
})

test('v7.6: the target is told to continue without waiting for the user', () => {
  const log = makeSourceLog({ turns: 3 })
  const pending = (config) =>
    buildInjectionPlan(log, config).chunks.find((chunk) => chunk.kind === 'pending-state')?.text ?? ''

  const on = pending({ modelDrivenGraft: true })
  assert.match(on, /\[系统提示\] 你刚刚完成了一次自我切片。/u)
  assert.match(on, /请直接接着“当前任务”继续执行，无需等待用户确认。/u)
  assert.match(on, /无需等待用户确认。$/u, 'the bootstrap sits at the BOTTOM of the pending state')

  assert.doesNotMatch(pending({ modelDrivenGraft: false }), /自我切片/u, 'disabled means no bootstrap')
})

test('v7.6 end-to-end: following the nudge yields a target that continues by itself', async () => {
  const { log, ctx } = setup()
  const decision = await dispatchPreStep(ctx, payloadFor(log, 1))
  const nudge = textsOf(decision).find((text) => NUDGE.test(text))
  assert.ok(nudge, 'the model must have been told it may hand over')

  // What the model does next, per the nudge: the SINGLE-STEP path, because
  // prepare→commit compares a digest the source keeps changing while the model
  // keeps working. slice_and_inject slices fresh and is the path the hint names.
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-self-slice' }, {})
  assert.equal(report.ok, true, `graft failed: ${JSON.stringify(report.warnings ?? report)}`)

  const stored = ctx._persistence.read('session-self-slice')
  const dump = JSON.stringify(stored)
  assert.match(dump, /你刚刚完成了一次自我切片/u, 'the target must be told the slice happened')
  assert.match(dump, /无需等待用户确认/u, 'and that it may continue without the user')
})

test('v7.6: defaults leave a 5% safety margin', () => {
  const config = normalizeConfig({})
  assert.equal(config.modelDrivenGraft, true)
  assert.equal(config.modelDrivenGraftAtRatio, 0.7)
  assert.equal(config.autoGraftAtRatio, 0.75)
  assert.ok(
    config.modelDrivenGraftAtRatio < config.autoGraftAtRatio,
    'the nudge must fire before the cutoff or it can never be acted on',
  )
})

test('v7.6: an out-of-range nudge ratio is refused, not clamped', () => {
  assert.throws(() => normalizeConfig({ modelDrivenGraftAtRatio: 1.2 }), /modelDrivenGraftAtRatio/u)
  assert.throws(() => normalizeConfig({ modelDrivenGraftAtRatio: 0 }), /modelDrivenGraftAtRatio/u)
})