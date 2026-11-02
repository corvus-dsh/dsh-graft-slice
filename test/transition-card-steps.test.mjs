import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 回归：transition card 绝不能写回退的 step 号。
 *
 * 真实事故：turn 92 里已经跑过 step 1 和 2，卡片又写了一条 step/start{step:1}，
 * 真实 v4 校验器判定 "step/start does not match the open turn and next step"，
 * 直接把这个用户的源会话日志弄成 corrupt。
 */

function setup() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-card-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, {})
  return { ctx, sourceLog }
}

/** A live-session stub that records what the card appends. */
function liveStub(events, sink) {
  return {
    header: { id: 'session-card-src' },
    snapshotEvents: () => events,
    append: (type, data) => {
      sink.push({ type, data })
      return { type, data, seq: events.length + sink.length }
    },
  }
}

test('card: step numbers advance inside an already-open turn', async () => {
  const { ctx, sourceLog } = setup()
  const appended = []
  // turn 5 is open at step 3: the card must open step 4, never reuse a lower number.
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 5 } },
    { type: 'step/start', seq: 1, data: { turn: 5, step: 1 } },
    { type: 'step/end', seq: 2, data: { turn: 5, step: 1 } },
    { type: 'step/start', seq: 3, data: { turn: 5, step: 3 } },
    { type: 'step/end', seq: 4, data: { turn: 5, step: 3 } },
  ]
  const sessions = {
    get: (id) => (id === 'session-card-src' ? liveStub(events, appended) : undefined),
    flush: async () => {},
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'sessions' ? sessions : originalGet.call(ctx, name))

  // Drive the card path: tell the plugin this id is transferred.
  const { getTransferredSessions } = await import('../index.js')
  getTransferredSessions().set('session-card-src', {
    newSessionId: 'session-card-dst',
    at: Date.now(),
    reason: '已转移',
  })
  await dispatchPreStep(ctx, { agent: { id: 'session-card-src' }, messages: [] })

  const stepStarts = appended.filter((event) => event.type === 'step/start')
  for (const event of stepStarts) {
    assert.equal(
      event.data.step > 3,
      true,
      `card opened step ${event.data.step} inside a turn that already used step 3`,
    )
  }
  const card = appended.find((event) => event.type === 'assistant/message')
  if (card !== undefined) {
    assert.equal(card.data.turn, 5)
    assert.equal(card.data.step > 3, true)
  }
})

test('card: never fabricates a turn when the source has no open turn', async () => {
  const { ctx } = setup()
  const appended = []
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const sessions = {
    get: (id) => (id === 'session-card-closed' ? liveStub(events, appended) : undefined),
    flush: async () => {},
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'sessions' ? sessions : originalGet.call(ctx, name))
  const { getTransferredSessions } = await import('../index.js')
  getTransferredSessions().set('session-card-closed', {
    newSessionId: 'session-card-dst2',
    at: Date.now(),
    reason: '已转移',
  })
  await dispatchPreStep(ctx, { agent: { id: 'session-card-closed' }, messages: [] })

  const fabricated = appended.filter((event) => event.type === 'turn/start' || event.type === 'step/start')
  assert.equal(fabricated.length, 0, 'a finished log must not receive fabricated lifecycle events')
})
