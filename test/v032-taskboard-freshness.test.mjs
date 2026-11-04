/**
 * v0.32 P1 — the Task Board must show the LATEST todo_write, not a plan from an
 * older turn.
 *
 * Live report: "⏭️ 待开始" listed P1-1/P1-2 from dozens of turns earlier while a
 * fresh todo_write had just been written. Three shapes can produce that
 * without the caller noticing:
 *
 *   1. the array is not in seq order (live tail + persisted prefix), so "the
 *      last write in the array" is an older one;
 *   2. the newest write has no usable parse (a rejected call, an object payload,
 *      or a list nested in a string) and the old code silently kept the previous
 *      state;
 *   3. the latest written list is entirely COMPLETED, and "no open items" was
 *      conflated with "no plan", so the board recycled prose from an older turn.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { extractTaskState, renderInstructionCard, renderTaskBoard } from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

const emptyDiscard = { errorBodies: 0, resolvedErrors: 0, narrationChars: 0, pointerLines: 0 }

function withTodoWrites(writes) {
  const log = makeSourceLog({ turns: 2 })
  let seq = log.events.at(-1).seq
  for (const write of writes) {
    seq += 1
    log.events.push({
      type: 'tool/call',
      seq,
      time: Date.now() + seq,
      data: {
        turn: 2,
        step: 1,
        callId: write.callId,
        name: write.name ?? 'todo_write',
        arguments:
          typeof write.arguments === 'string' ? write.arguments : JSON.stringify({ todos: write.arguments }),
      },
    })
    if (write.error === true) {
      seq += 1
      log.events.push({
        type: 'tool/result',
        seq,
        time: Date.now() + seq,
        data: {
          turn: 2,
          step: 1,
          message: {
            id: `tool-${write.callId}`,
            role: 'tool',
            source: { kind: 'tool', callId: write.callId },
            toolCallId: write.callId,
            isError: true,
            content: [{ type: 'text', text: 'invalid todo payload' }],
          },
        },
      })
    }
  }
  return log
}

test('P1: an older write cannot win just because it is later in the array', () => {
  const log = makeSourceLog({ turns: 2 })
  const base = log.events.at(-1).seq
  const oldWrite = {
    type: 'tool/call',
    seq: base + 1,
    time: Date.now() + 1,
    data: {
      trace: 'old',
      callId: 'todo-old',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: [
          { content: 'P1-1: old pending item', status: 'pending' },
          { content: 'P1-2: another old item', status: 'pending' },
        ],
      }),
    },
  }
  const newWrite = {
    type: 'tool/call',
    seq: base + 2,
    time: Date.now() + 2,
    data: {
      trace: 'new',
      callId: 'todo-new',
      name: 'todo_write',
      arguments: JSON.stringify({
        todos: [
          { content: 'P1-1: old pending item', status: 'completed' },
          { content: 'P1-2: another old item', status: 'completed' },
          { content: 'P0-NEW: the item written just now', status: 'pending' },
        ],
      }),
    },
  }
  // A concatenated log can hand us the older write later. The state must still
  // be the highest seq, not the highest array index.
  log.events.push(newWrite, oldWrite)

  const state = extractTaskState(log.events)
  assert.deepEqual(state.openTodos, ['P0-NEW: the item written just now'])
  assert.equal(state.todoSeq, base + 2)
})

test('P1: a rejected todo_write does not replace the last successful state', () => {
  const log = withTodoWrites([
    {
      callId: 'todo-good',
      arguments: [{ content: 'KEEP: the successful item', status: 'pending' }],
    },
    {
      callId: 'todo-bad',
      arguments: [{ content: 'STALE: a rejected write', status: 'pending' }],
      error: true,
    },
  ])

  const state = extractTaskState(log.events)
  assert.deepEqual(state.openTodos, ['KEEP: the successful item'])
  assert.equal(state.todoSeq, log.events.find((event) => event.data?.callId === 'todo-good').seq)
})

test('P1: the newest write is parsed from an object payload and a namespaced tool', () => {
  const log = makeSourceLog({ turns: 2 })
  const base = log.events.at(-1).seq
  log.events.push({
    type: 'tool/call',
    seq: base + 1,
    time: Date.now() + 1,
    data: {
      callId: 'todo-old',
      name: 'todo_write',
      arguments: JSON.stringify({ todos: [{ content: 'OLD: previous plan', status: 'pending' }] }),
    },
  })
  log.events.push({
    type: 'tool/call',
    seq: base + 2,
    time: Date.now() + 2,
    data: {
      callId: 'todo-new',
      name: 'mcp__notes__todo_write',
      // Some producers hand the parsed object through instead of its JSON text.
      arguments: { todos: [{ content: 'NEW: namespaced plan', status: 'pending' }] },
    },
  })

  const state = extractTaskState(log.events)
  assert.deepEqual(state.openTodos, ['NEW: namespaced plan'])
})

test('P1: an all-completed written plan is stated as finished, not replaced by old prose', () => {
  const log = withTodoWrites([
    {
      callId: 'todo-done',
      arguments: [
        { content: 'P1-1: old item', status: 'completed' },
        { content: 'P1-2: old item', status: 'completed' },
      ],
    },
  ])
  const state = extractTaskState(log.events)
  assert.deepEqual(state.openTodos, [])
  assert.ok(state.todoSeq !== undefined, 'a write exists even when nothing is open')

  const card = renderInstructionCard({
    semantic: {
      outcome: undefined,
      unresolvedError: undefined,
      discarded: emptyDiscard,
    },
    body:
      '我接下来需要立刻执行：P1-1: old item。\n再往后还有：P1-2: old item。\n' +
      '我写的待办清单已全部完成；接下来按「这个会话的任务」做最后验证与收尾。',
    pending: state.openTodos,
    hasWrittenPlan: true,
    request: '跑通 0.2.2 修复',
    stopPoint: {},
    pointerCount: 0,
  })
  assert.match(card, /待办清单已全部完成/u)
  assert.doesNotMatch(card, /^- P1-1: old item$/mu, 'a completed item must not reappear as pending')
  assert.doesNotMatch(card, /再往后还有/u, 'the body must not duplicate the board column')
})

test('P1: an empty pending column distinguishes "never planned" from "plan finished"', () => {
  const base = {
    request: 'r',
    pending: [],
    stopPoint: {},
    pointerCount: 0,
    discarded: emptyDiscard,
  }
  assert.match(renderTaskBoard(base), /按上面的「原始用户要求」继续推进/u)
  assert.match(renderTaskBoard({ ...base, hasWrittenPlan: true }), /待办清单已全部完成/u)
})
