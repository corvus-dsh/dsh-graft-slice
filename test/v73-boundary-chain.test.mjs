/**
 * v7.3 boundary-probe and cross-generation-address suite.
 *
 * checkTaskBoundary: a SECOND gate, orthogonal to checkSafeHarbor.
 *   - safeHarbor asks: is the log physically quiet (no dangling call, no live
 *     stream)?
 *   - taskBoundary asks: if we cut HERE, does the target inherit a task that is
 *     mid-hole — a failing test with no fix, a todo list that is not done?
 *
 * The wait is capped (taskBoundaryMaxDeferTurns, default 1), because a
 * permanently red test must not pin a session at the watermark forever.
 *
 * [历史链追溯]: by generation 3-4 the current sourceSessionId names a tape that
 * no longer contains the earliest failure. A search against it returns nothing
 * and looks like "it never happened". The chain line names the previous
 * session's id so the search can be aimed at the right log.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  checkTaskBoundary,
  resetRetiredSessions,
} from '../index.js'
import { dispatchPreStep, FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function allAssistantText(stored) {
  return stored.events
    .filter((e) => e.type === 'assistant/message')
    .map((e) => (e.data?.message?.content ?? []).map((b) => b.text ?? '').join(''))
    .join('\n\n')
}

test('v7.3: a clean boundary — no todos, last call fine — does not defer', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.forEach((e, i) => { e.seq = i })
  const state = checkTaskBoundary(log.events, [])
  assert.equal(state.shouldDefer, false)
  assert.equal(state.openTodoCount, 0)
  assert.equal(state.lastCallFailed, false)
})

test('v7.3: an open todo defers, and names the count', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.forEach((e, i) => { e.seq = i })
  const state = checkTaskBoundary(log.events, ['fix login', 'add test'])
  assert.equal(state.shouldDefer, true)
  assert.equal(state.openTodoCount, 2)
  assert.match(state.reason, /todo/)
})

test('v7.3: a failed last call defers, detected from the result text', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 2, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 2,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c1' },
        toolCallId: 'c1',
        isError: true,
        content: [{ type: 'text', text: 'AssertionError: expected 401 to equal 200' }],
      },
    },
  })
  log.events.forEach((e, i) => { e.seq = i })
  const state = checkTaskBoundary(log.events, [])
  assert.equal(state.shouldDefer, true)
  assert.equal(state.lastCallFailed, true)
  assert.match(state.reason, /last tool call failed/)
})

test('v7.3: a passing last call does not defer on its own', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 2, step: 1, callId: 'c2', name: 'pwsh', arguments: '{}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 2,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c2' },
        toolCallId: 'c2',
        content: [{ type: 'text', text: 'All tests passed (3 assertions)' }],
      },
    },
  })
  log.events.forEach((e, i) => { e.seq = i })
  const state = checkTaskBoundary(log.events, [])
  assert.equal(state.shouldDefer, false)
  assert.equal(state.lastCallFailed, false)
})

test('v7.3: the auto path defers at a failing boundary, then migrates anyway after the cap', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 3, step: 1, callId: 'c3', name: 'pwsh', arguments: '{}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 3,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c3' },
        toolCallId: 'c3',
        isError: true,
        content: [{ type: 'text', text: 'FAIL src/login.test.ts' }],
      },
    },
  })
  log.events.forEach((e, i) => { e.seq = i })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), currentAgentId: log.session.id })
  // Force the watermark over: ratio 1.0 against a tiny window.
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.05,
    contextWindowTokens: 100,
    taskBoundaryMaxDeferTurns: 1,
  })

  const live = ctx.sessions.get(log.session.id)
  live.requestContext = () => ({ contextWindow: 100 })

  // First pre-step: boundary says defer, no target yet.
  await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  const afterFirst = [...ctx._persistence.byId.keys()].filter((id) => id !== log.session.id)
  assert.equal(afterFirst.length, 0, 'a failing boundary must postpone the graft once')

  // Second pre-step: the deferral cap is reached; the graft proceeds.
  await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  const afterSecond = [...ctx._persistence.byId.keys()].filter((id) => id !== log.session.id)
  assert.ok(afterSecond.length > 0, 'after the cap, the graft must proceed')
  resetRetiredSessions()
})

test('v7.3: the chain line names the previous session at the top of the index', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: { id: 'uc', role: 'user', content: [{ type: 'text', text: '绝对不能使用 import re。' }], source: { kind: 'user' } },
    surfaceOp: 'append',
  })
  log.events.forEach((e, i) => { e.seq = i })

  const ctx1 = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx1, {})
  await ctx1._tools.get('graft_slice_and_inject').execute({ sourceSessionId: log.session.id, newSessionId: 'gen-a' }, {})
  const gen1 = ctx1._persistence.read('gen-a')

  // Gen 2 grafts gen 1.
  const ctx2 = makeCtx({ sourceLog: { session: gen1.session, events: gen1.events }, persistence: new FakePersistence() })
  apply(ctx2, {})
  await ctx2._tools.get('graft_slice_and_inject').execute({ sourceSessionId: 'gen-a', newSessionId: 'gen-b' }, {})
  const gen2 = ctx2._persistence.read('gen-b')

  const text = allAssistantText(gen2)
  // The chain in gen-b's tape names gen-a as the current source and the ORIGINAL
  // session as the previous generation — the exact id a search must be aimed at.
  const lastChain = text.lastIndexOf('[历史链追溯]')
  assert.ok(lastChain >= 0, 'the injected tape must carry a chain line')
  const block = text.slice(lastChain)
  assert.match(block, /当前：gen-a/)
  assert.match(block, /上一代：session-source/)
  // The chain itself must be a direct pointer, not a paragraph of explanation.
  // Bounding it here (the two chain lines) rather than the whole trailing index:
  // the index below it legitimately grows with the pointer count, so a bound on
  // "everything after the marker" measures the wrong thing.
  const chainOnly = block.split('\n').slice(0, 2).join('\n')
  assert.ok(chainOnly.length < 300, `chain line must stay short, got ${chainOnly.length}`)
  resetRetiredSessions()
})

test('v7.3: a first-generation graft has no chain line — there is no previous generation', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: { id: 'uc', role: 'user', content: [{ type: 'text', text: '绝对不能用 import re。' }], source: { kind: 'user' } },
    surfaceOp: 'append',
  })
  log.events.forEach((e, i) => { e.seq = i })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})
  await ctx._tools.get('graft_slice_and_inject').execute({ sourceSessionId: log.session.id, newSessionId: 'gen-1' }, {})
  const gen1 = ctx._persistence.read('gen-1')
  // The source is a real session, not a graft target: nothing came before it, so
  // a chain line would be inventing ancestry.
  assert.equal(gen1.events.some((e) => e.type === 'assistant/message' && /历史链追溯/u.test((e.data?.message?.content ?? []).map((b) => b.text ?? '').join(''))), false)
  resetRetiredSessions()
})

test('v7.3: the chain accumulates — generation 3 still names generation 1', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: { id: 'uc', role: 'user', content: [{ type: 'text', text: '绝对不能使用 import re。' }], source: { kind: 'user' } },
    surfaceOp: 'append',
  })
  log.events.forEach((e, i) => { e.seq = i })

  const ctx1 = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx1, {})
  await ctx1._tools.get('graft_slice_and_inject').execute({ sourceSessionId: log.session.id, newSessionId: 'gen-1' }, {})
  const g1 = ctx1._persistence.read('gen-1')

  const ctx2 = makeCtx({ sourceLog: { session: g1.session, events: g1.events }, persistence: new FakePersistence() })
  apply(ctx2, {})
  await ctx2._tools.get('graft_slice_and_inject').execute({ sourceSessionId: 'gen-1', newSessionId: 'gen-2' }, {})
  const g2 = ctx2._persistence.read('gen-2')

  const ctx3 = makeCtx({ sourceLog: { session: g2.session, events: g2.events }, persistence: new FakePersistence() })
  apply(ctx3, {})
  await ctx3._tools.get('graft_slice_and_inject').execute({ sourceSessionId: 'gen-2', newSessionId: 'gen-3' }, {})
  const g3 = ctx3._persistence.read('gen-3')

  const text = allAssistantText(g3)
  // Each generation's index is replayed verbatim, so gen-3's tape carries every
  // previous chain line: the model can walk back to gen-1's parent.
  assert.match(text, /当前：gen-1　上一代：session-source/)
  assert.match(text, /当前：gen-2　上一代：gen-1/)
  resetRetiredSessions()
})
