import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 零伪造原则的强断言。
 *
 * 事故背景：card 曾在 turn 92 里写入 step/start{step:1}（此前已用过 1、2），
 * 真实 v4 校验器判定 "step/start does not match the open turn and next step"，
 * 把一个 7,531 事件、92 轮的用户日志判成 corrupt。
 *
 * 因此这里锁死：
 *   - 绝不写 turn/start 或 step/start（无论有没有 open turn）
 *   - 只在已有 open step 时写，且只写 developer/message 与 session/title
 *   - 写前预校验必须按 v4 规则放行/拒绝
 *
 * 注意：预校验要求 turn 从 1 递增，所以 fixture 必须构造合法前缀，
 * 否则被拒的是 fixture 而不是被测逻辑。
 */

function setup() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-zeroforge-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  const warnings = []
  ctx.logger = { warn: (...a) => warnings.push(a.join(' ')), info: () => {}, error: () => {} }
  apply(ctx, {})
  return { ctx, warnings }
}

function wire(ctx, id, events, sink) {
  const sessions = {
    get: (candidate) =>
      candidate === id
        ? {
            header: { id },
            snapshotEvents: () => events,
            append: (type, data) => {
              sink.push({ type, data })
            },
          }
        : undefined,
    flush: async () => {},
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'sessions' ? sessions : originalGet.call(ctx, name))
}

function transfer(id, target) {
  getTransferredSessions().set(id, { newSessionId: target, at: Date.now(), reason: '已转移' })
}

test('zero-forgery: an open step 3 never receives a lower step number', async () => {
  const { ctx } = setup()
  const appended = []
  const id = 'session-zf-open'
  // Legal prefix: turn 1, steps 1 and 2 finished, step 3 still open.
  wire(ctx, id, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 3, data: { turn: 1, step: 2 } },
    { type: 'step/end', seq: 4, data: { turn: 1, step: 2 } },
    { type: 'step/start', seq: 5, data: { turn: 1, step: 3 } },
  ], appended)
  transfer(id, 'session-zf-dst')
  await dispatchPreStep(ctx, { agent: { id }, messages: [] })

  const lifecycle = appended.filter((event) =>
    ['turn/start', 'step/start', 'turn/end', 'step/end'].includes(event.type),
  )
  assert.equal(lifecycle.length, 0, 'the card must never write lifecycle events')
  const card = appended.find((event) => event.type === 'developer/message')
  assert.ok(card, 'the card is written when a step is genuinely open')
  assert.equal(card.data.turn, 1)
  assert.equal(card.data.step, 3, 'the card attaches to the step the loop already opened')
})

test('zero-forgery: a finished log receives nothing at all', async () => {
  const { ctx } = setup()
  const appended = []
  const id = 'session-zf-closed'
  wire(ctx, id, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ], appended)
  transfer(id, 'session-zf-dst2')
  await dispatchPreStep(ctx, { agent: { id }, messages: [] })

  assert.equal(appended.length, 0, 'nothing may be appended to a closed log')
})

test('zero-forgery: an open turn with no open step receives nothing', async () => {
  const { ctx } = setup()
  const appended = []
  const id = 'session-zf-between'
  wire(ctx, id, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 2, data: { turn: 1, step: 1 } },
  ], appended)
  transfer(id, 'session-zf-dst3')
  await dispatchPreStep(ctx, { agent: { id }, messages: [] })

  assert.equal(appended.length, 0, 'between steps there is no safe attachment point')
})

test('zero-forgery: only developer/message and session/title are ever appended', async () => {
  const { ctx } = setup()
  const appended = []
  const id = 'session-zf-types'
  wire(ctx, id, [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ], appended)
  transfer(id, 'session-zf-dst4')
  await dispatchPreStep(ctx, { agent: { id }, messages: [] })

  const types = new Set(appended.map((event) => event.type))
  for (const type of types) {
    assert.equal(
      type === 'developer/message' || type === 'session/title',
      true,
      `unexpected appended event type: ${type}`,
    )
  }
})

test('zero-forgery: an illegal prefix is refused by pre-validation', async () => {
  const { ctx, warnings } = setup()
  const appended = []
  const id = 'session-zf-illegal'
  // turn 5 with no preceding turns: v4 would reject the log itself.
  wire(ctx, id, [
    { type: 'turn/start', seq: 0, data: { turn: 5 } },
    { type: 'step/start', seq: 1, data: { turn: 5, step: 1 } },
  ], appended)
  transfer(id, 'session-zf-dst5')
  await dispatchPreStep(ctx, { agent: { id }, messages: [] })

  assert.equal(appended.length, 0, 'pre-validation must refuse a log it cannot prove safe')
  assert.equal(
    warnings.some((line) => line.includes('transition card skipped')),
    true,
    'the refusal is logged rather than silent',
  )
})
