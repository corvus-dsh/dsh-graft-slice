/**
 * v7.4: a stale Task Status must say it is stale.
 *
 * THE LIVE FAILURE
 *
 * A real 44-turn session was grafted at its 75% watermark. The injected
 * `[Task Status]` block was:
 *
 *   - [x] 第三项：README.en.md 计数改为 173
 *   - [x] 边界探针 checkTaskBoundary
 *   - [x] 跨代寻址：[历史链追溯]
 *   - [x] 补测试 + 全量 181 通过
 *
 * Four completed items, no date. The truth: the last `todo_write` was at seq 9269
 * while the boundary was 13413 — 4,144 events and eleven turns of real work later.
 *
 * The target read a finished list as the live plan, re-verified completed work, and
 * later described the result itself:
 *
 *   "I started believing the task was 'freeze + package + mobile brief' (Turn 39),
 *    and re-verified things already done … that's a measurable cognitive deficit —
 *    and it caused duplicate work."
 *
 * The plugin cannot invent a fresher list. What it must never do is imply that an
 * old one is current.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildInjectionPlan, extractTaskState } from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

/** Build a log whose only todo_write is at `todoAt`, then pad with tool noise. */
function logWithStaleTodos(todoAt, totalEvents) {
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      callId: 'todo-1',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: [
          { content: '已完成的事', status: 'completed' },
          { content: '还没做的事', status: 'pending' },
        ],
      }),
    },
  })
  // Pad with results so the log keeps growing past the todo snapshot.
  let made = log.events.length
  while (made < totalEvents) {
    log.events.push({
      type: 'tool/result',
      seq: 0,
      time: 0,
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'pad' },
          toolCallId: 'pad',
          content: [{ type: 'text', text: `noise ${made}` }],
        },
      },
    })
    made += 1
  }
  log.events.forEach((event, index) => {
    event.seq = index
  })
  // Put the todo at the requested position by moving it there.
  if (todoAt > 0 && todoAt < log.events.length) {
    const idx = log.events.findIndex((event) => event.data?.name === 'todo_write')
    const [todo] = log.events.splice(idx, 1)
    log.events.splice(todoAt, 0, todo)
    log.events.forEach((event, index) => {
      event.seq = index
    })
  }
  return log
}

test('v7.4: extractTaskState reports where the todo snapshot was taken', () => {
  const log = logWithStaleTodos(5, 1200)
  const state = extractTaskState(log.events)
  assert.equal(typeof state.todoSeq, 'number', 'the snapshot seq must be recorded')
  assert.equal(state.todoAgeEvents > 0, true, 'the age must be measured')
  assert.equal(state.todos.length, 2)
  assert.deepEqual(state.openTodos, ['还没做的事'])
})

test('v7.4: a stale Task Status says so, and names the seq to check', () => {
  const log = logWithStaleTodos(5, 1200)
  const plan = buildInjectionPlan(log, { recentTurns: 0, adaptiveDepth: false })
  const block = plan.chunks.find((chunk) => chunk.kind === 'task-status')
  assert.ok(block, 'the block must be injected')
  assert.match(block.text, /^\[Task Status\]（此列表快照于 seq=/u, 'the age line must prefix the list')
  assert.match(block.text, /可能已过期/u)
  assert.match(block.text, /graft_read_result/u, 'it must name the read-back tool')
  // The list itself is unchanged and still follows the notice.
  assert.match(block.text, /- \[x\] 已完成的事/u)
  assert.match(block.text, /- \[ \] 还没做的事/u)
})

test('v7.4: a FRESH Task Status carries no staleness noise', () => {
  // The todo is the very last event, so nothing has moved since.
  const log = logWithStaleTodos(0, 12)
  const plan = buildInjectionPlan(log, { recentTurns: 0, adaptiveDepth: false })
  const block = plan.chunks.find((chunk) => chunk.kind === 'task-status')
  assert.ok(block)
  assert.equal(
    block.text.startsWith('[Task Status]\n'),
    true,
    `a fresh list must not open with a warning, got ${JSON.stringify(block.text.slice(0, 80))}`,
  )
  assert.equal(block.text.includes('可能已过期'), false)
})

test('v7.4: a log with no todo_write produces no Task Status block at all', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const state = extractTaskState(log.events)
  assert.equal(state.todoSeq, undefined, 'no snapshot means no seq')
  const plan = buildInjectionPlan(log, { recentTurns: 0, adaptiveDepth: false })
  assert.equal(plan.chunks.some((chunk) => chunk.kind === 'task-status'), false)
})