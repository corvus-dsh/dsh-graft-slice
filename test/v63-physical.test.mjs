import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  calculateAdaptiveDepth,
  checkSafeHarbor,
  extractAttachmentPointers,
  resetRetiredSessions,
} from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/* ---------------------------------------------------------------- module 1 */

test('safe harbor: an unanswered tool call blocks the cut', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, data: { callId: 'c1', name: 'pwsh', arguments: '{}' } },
  ]
  const state = checkSafeHarbor(events)
  assert.equal(state.safe, false)
  assert.match(state.reason, /awaiting a result/)
})

test('safe harbor: a resolved tool call is a quiet boundary', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, data: { callId: 'c1', name: 'pwsh', arguments: '{}' } },
    { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'step/end', seq: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(checkSafeHarbor(events).safe, true)
})

test('safe harbor: a streaming assistant blocks the cut', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 1 } },
  ]
  const state = checkSafeHarbor(events)
  assert.equal(state.safe, false)
  assert.match(state.reason, /streaming/)
})

/* ---------------------------------------------------------------- module 2 */

test('attachments: an image block becomes a readable path pointer', () => {
  const pointers = extractAttachmentPointers({
    role: 'user',
    content: [
      { type: 'text', text: 'what is wrong here?' },
      { type: 'image', path: 'D:\\shots\\bug.png', name: 'bug.png' },
    ],
  })
  assert.equal(pointers.length, 1)
  assert.match(pointers[0], /图片/)
  assert.match(pointers[0], /D:\\shots\\bug\.png/)
  assert.match(pointers[0], /必要时请直接读取该路径/)
})

test('attachments: a file block without a path is reported honestly', () => {
  const pointers = extractAttachmentPointers({
    role: 'user',
    content: [{ type: 'file' }],
  })
  assert.equal(pointers.length, 1)
  assert.match(pointers[0], /没有留下可读取的路径/)
})

test('attachments: plain text messages produce no pointers', () => {
  assert.deepEqual(extractAttachmentPointers({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), [])
})

/* ---------------------------------------------------------------- module 3 */

function codeHeavyEvents() {
  const events = []
  let seq = 0
  const push = (type, data) => events.push({ type, seq: seq++, data })
  for (let turn = 1; turn <= 6; turn += 1) {
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    for (let call = 0; call < 4; call += 1) {
      const id = `t${turn}c${call}`
      push('tool/call', { turn, step: 1, callId: id, name: 'pwsh', arguments: '{}' })
      push('tool/result', {
        turn,
        step: 1,
        error: { name: 'CommandError' },
        message: { toolCallId: id, content: [{ type: 'text', text: 'Exit code 1' }] },
      })
    }
    push('assistant/message', {
      turn,
      step: 1,
      message: { content: [{ type: 'text', text: '\u4fee\u590d\u4e2d' }] },
      stream: [],
    })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

function proseHeavyEvents() {
  const events = []
  let seq = 0
  const push = (type, data) => events.push({ type, seq: seq++, data })
  const prose = '\u8fd9\u662f\u4e00\u6bb5\u5f88\u957f\u7684\u6587\u5b57\u8bf4\u660e\u3002'.repeat(150)
  for (let turn = 1; turn <= 6; turn += 1) {
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    push('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: prose }] }, stream: [] })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

test('adaptive depth: a debug-shaped session keeps ZERO replayed turns', () => {
  const result = calculateAdaptiveDepth(codeHeavyEvents(), { adaptiveDepthMin: 3, adaptiveDepthMax: 8 })
  assert.equal(result.mode, 'debug')
  // v7.2: measured on a real 14-turn session, tier A (0 turns) and tier C
  // (5 turns) carry the SAME 342 read-back handles while A is ~70% smaller.
  // The replayed turns added bulk, not retrieval — so debug gets none.
  assert.equal(result.depth, 0, 'debug must replay nothing')
  assert.match(result.reason, /zero replay/)
})

test('adaptive depth: a prose-shaped session keeps a shallower window', () => {
  const result = calculateAdaptiveDepth(proseHeavyEvents(), { adaptiveDepthMin: 3, adaptiveDepthMax: 8 })
  assert.equal(result.mode, 'generation')
  assert.equal(result.depth <= 4, true, `expected <= 4, got ${result.depth}`)
})

test('adaptive depth: the two densities really do differ', () => {
  const debug = calculateAdaptiveDepth(codeHeavyEvents(), { adaptiveDepthMin: 3, adaptiveDepthMax: 8 })
  const prose = calculateAdaptiveDepth(proseHeavyEvents(), { adaptiveDepthMin: 3, adaptiveDepthMax: 8 })
  // v7.2: the axis flipped. A debug session now keeps the SHALLOWEST window of
  // the three shapes, because its recent turns are the least compressible.
  assert.equal(debug.depth < prose.depth, true, `debug ${debug.depth} should be below prose ${prose.depth}`)
})

/* ---------------------------------------------------------------- module 4 */

test('confirm mode: the watermark asks before migrating', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-confirm-'))
  const sourceLog = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    contextWindowTokens: 100,
    graftMode: 'confirm',
  })
  const decision = await dispatchPreStep(ctx, { agent: { id: sourceLog.session.id }, messages: [] })
  assert.equal(decision.kind, 'reject')
  assert.match(decision.reason, /是否由系统进行无缝迁移/)
})
