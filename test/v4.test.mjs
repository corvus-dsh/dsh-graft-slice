import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  buildInjectionPlan,
  extractTaskState,
  getTransferredSessions,
  resetRetiredSessions,
} from '../index.js'
import {
  dispatchPreStep,
  dispatchSessionEvent,
  dispatchTurnStopping,
  makeCtx,
  makeSourceLog,
} from './fake-harness.mjs'

test('v3.3: extracts todo progress and subagent reports', () => {
  const events = [
    {
      type: 'tool/call',
      data: {
        name: 'todo_write',
        callId: 'call-todo',
        arguments: JSON.stringify({
          todos: [
            { content: '完成解析器', status: 'completed' },
            { content: '补 batch 模式', status: 'pending' },
          ],
        }),
      },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          source: { callId: 'call-todo' },
          content: [{ type: 'text', text: '子代理调研结果：JSONDecoder 可以处理多行值。' }],
        },
      },
    },
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'text', text: '- [ ] 补测试\n- [x] 写解析器\n子代理回传报告：batch 需要去重。' },
          ],
        },
      },
    },
  ]
  const state = extractTaskState(events)
  // v6.2: only the LAST todo_write forms the list — it is state, not a log.
  assert.ok(state.todos.some((line) => line.includes('[x] 完成解析器')))
  assert.ok(state.todos.some((line) => line.includes('[ ] 补 batch 模式')))
  // Assistant markdown checkboxes are no longer harvested: scraping them is what
  // produced duplicated and stale task lists on real logs.
  assert.equal(state.todos.some((line) => line.includes('补测试')), false)
  assert.ok(state.subagentReports.some((line) => line.includes('JSONDecoder')))
  assert.deepEqual(state.openTodos, ['补 batch 模式'])
})

test('v3.3: injects Task Status and Subagent Reports chunks', () => {
  const log = makeSourceLog({ turns: 7 })
  log.events.push(
    {
      type: 'tool/call',
      seq: 9001,
      data: {
        name: 'todo_write',
        callId: 'call-todo',
        arguments: JSON.stringify({ todos: [{ content: '补 batch 模式', status: 'pending' }] }),
      },
    },
    {
      type: 'tool/result',
      seq: 9002,
      data: {
        message: {
          source: { callId: 'call-todo' },
          content: [{ type: 'text', text: '子代理报告：解析器已完成，等待 batch 测试。' }],
        },
      },
    },
  )
  const plan = buildInjectionPlan(log, {})
  assert.ok(plan.chunks.some((chunk) => chunk.kind === 'task-status'))
  assert.ok(plan.chunks.some((chunk) => chunk.kind === 'subagent-reports'))
  assert.ok(plan.taskStatus.some((line) => line.includes('补 batch 模式')))
  assert.ok(plan.subagentReports.some((line) => line.includes('解析器已完成')))
})

test('v4.0: auto-grafts at the token watermark and blocks the old session', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 7 })
  const ctx = makeCtx({ sourceLog: log, currentAgentId: log.session.id })
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    contextWindowTokens: 500,
    recentTurns: 5,
    retireSource: true,
    verifyReadBack: true,
  })

  await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  await new Promise((resolve) => setTimeout(resolve, 2200))

  const transfer = getTransferredSessions().get(log.session.id)
  assert.ok(transfer, 'the source should be marked transferred')
  assert.ok(transfer.newSessionId.startsWith('auto-graft-'))
  const stored = ctx._persistence.read(transfer.newSessionId)
  assert.ok(stored, 'the auto target should be persisted')

  const blocked = await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  assert.equal(blocked.kind, 'reject')
  assert.match(blocked.reason, /Transferred|已转移至新会话/)
  assert.equal(blocked.newSessionId, transfer.newSessionId)

  const other = await dispatchPreStep(ctx, { agent: { id: 'session-other' }, messages: [] })
  assert.equal(other.kind, 'enter')
})
