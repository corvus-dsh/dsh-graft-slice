/**
 * v7.5: a todo list written before N successful calls is a CLAIM, not the state.
 *
 * The live case: pending said "立刻执行：推送 v0.8.0（等确认）" while the push had
 * already happened. Nothing on screen said the list was stale, so the reader had
 * to check the log to find out. One line fixes that.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInjectionPlan } from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

function withTodos(log, todos, { successesAfter = 0 } = {}) {
  const base = log.events.at(-1).seq
  log.events.push({
    type: 'tool/call',
    seq: base + 1,
    data: { name: 'todo_write', callId: 'todo-1', arguments: JSON.stringify({ todos }) },
  })
  log.events.push({
    type: 'tool/result',
    seq: base + 2,
    data: { message: { source: { callId: 'todo-1' }, content: [{ type: 'text', text: 'ok' }] } },
  })
  for (let index = 0; index < successesAfter; index += 1) {
    log.events.push({
      type: 'tool/result',
      seq: base + 3 + index,
      data: { message: { source: { callId: `late-${index}` }, content: [{ type: 'text', text: 'done' }] } },
    })
  }
  return log
}

const open = [
  { content: '阶段 1: 已完成的事', status: 'completed' },
  { content: '阶段 2: 还没做的事', status: 'pending' },
]

test('pending: three successful calls after the todo snapshot get a freshness stamp', () => {
  const log = withTodos(makeSourceLog({ turns: 2 }), open, { successesAfter: 3 })
  const plan = buildInjectionPlan(log, {})
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  assert.ok(pending !== undefined)
  assert.match(pending.text, /次成功的工具调用/u)
  assert.match(pending.text, /先核对再重跑/u)
})

test('pending: two successful calls are not enough noise to stamp', () => {
  const log = withTodos(makeSourceLog({ turns: 2 }), open, { successesAfter: 2 })
  const plan = buildInjectionPlan(log, {})
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  assert.ok(pending !== undefined)
  assert.doesNotMatch(pending.text, /次成功的工具调用/u)
})

test('pending: failed calls do not count as progress', () => {
  const log = withTodos(makeSourceLog({ turns: 2 }), open, { successesAfter: 0 })
  const base = log.events.at(-1).seq
  for (let index = 0; index < 4; index += 1) {
    log.events.push({
      type: 'tool/result',
      seq: base + 1 + index,
      data: { message: { source: { callId: `fail-${index}` }, isError: true, content: [{ type: 'text', text: 'boom' }] } },
    })
  }
  const plan = buildInjectionPlan(log, {})
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  assert.doesNotMatch(pending.text, /次成功的工具调用/u)
})