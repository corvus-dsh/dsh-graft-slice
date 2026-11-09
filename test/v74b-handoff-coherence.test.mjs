import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildInjectionPlan,
  extractTaskState,
  extractWorkspaceState,
  inheritedConstraintAnchor,
  isGraftAuthored,
  isHumanAuthored,
  staleTodoHint,
} from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

/**
 * The three defects were all found by reading ONE real handoff
 * (`handoff-demo`, sliced from session-source-demo at 21:58). Each test below
 * reproduces the exact shape that produced it, so a regression fails here
 * instead of in a user's next session.
 */

const userMessage = (seq, text, kind) => ({
  type: 'user/message',
  seq,
  data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

const toolCall = (seq, name, callId) => ({
  type: 'tool/call',
  seq,
  data: { name, callId, arguments: '{}' },
})

const toolResult = (seq, callId, text) => ({
  type: 'tool/result',
  seq,
  data: {
    message: { source: { callId }, content: [{ type: 'text', text }] },
  },
})

// ---------------------------------------------------------------------------
// 硬约束 4: the breakpoint beats the todo list when the open turn already ran it
// ---------------------------------------------------------------------------

test('v7.4b: a todo the open turn already performed is flagged, not re-issued silently', () => {
  const hint = staleTodoHint('用 graft_prepare 真机体检并自我切片到新会话', {
    tool: 'graft_prepare',
    seq: 14965,
  })
  assert.match(hint, /graft_prepare/u)
  assert.match(hint, /seq=14965/u)
  assert.match(hint, /不要直接重跑/u)
})

test('v7.4b: an unrelated open call leaves the todo instruction untouched', () => {
  assert.equal(staleTodoHint('跑全量测试', { tool: 'graft_prepare', seq: 1 }), undefined)
  assert.equal(staleTodoHint('读一下 index.ts', { tool: 'read', seq: 2 }), undefined)
  assert.equal(staleTodoHint(undefined, { tool: 'graft_prepare', seq: 3 }), undefined)
  assert.equal(staleTodoHint('用 graft_prepare 体检', undefined), undefined)
})

// ---------------------------------------------------------------------------
// 硬约束 7 + 8: constraints provenance, and only a human can be the origin
// ---------------------------------------------------------------------------

const EXTRACTED = [
  '工作目录 D:\\work\\demo。',
  '',
  '这个会话的任务：继续修插件。',
  '',
  'HARD CONSTRAINTS（从源会话用户消息中抽取，逐条有效，不可协商）:',
  '1. 断档状态，必须灾后重建。',
  '2. 严格校验 source.kind === user。',
].join('\n')

test('v7.4b: a human goal that PASTES an extracted constraints block gets the anchor', () => {
  const events = [userMessage(17, EXTRACTED, 'user')]
  const anchor = inheritedConstraintAnchor(events, 'session-src')
  assert.ok(anchor !== undefined, 'an extraction pasted by a human is still a copy')
  assert.match(anchor, /高优锚点/u)
  // v0.9.3: 这条断言在本次修复前断言的是「块数 == 代数」这个缺陷行为。
  // 原断言是 `assert.match(anchor, /第 1 代会话/u)` —— 无论链有多深都硬编码「第 1 代」，
  // 而日志里根本没有这个信息。
  // 改为跟随 mark 之后，seq 仍指向最新块（性质未变），但代数来自 mark。
  assert.match(anchor, /原始会话/u)
  assert.equal(/第 [01] 代/u.test(anchor), false, 'no mark means no generation claim')
  assert.match(anchor, /seq=17/u)
  assert.match(anchor, /副本/u)
})

test('v7.4b: the anchor names the EARLIEST human statement, not the newest copy', () => {
  const events = [
    userMessage(2282, EXTRACTED, 'user'),
    userMessage(7420, EXTRACTED, 'user'),
  ]
  const anchor = inheritedConstraintAnchor(events, 'session-src')
  assert.match(anchor, /seq=2282/u)
})

test('v7.4b: human-authored rules with no constraints block get no anchor', () => {
  const typed = EXTRACTED.replace(/HARD CONSTRAINTS.*\n/u, '')
  assert.equal(inheritedConstraintAnchor([userMessage(5, typed, 'user')], 's'), undefined)
})

test('v7.4b: a plugin re-assertion is never an origin, even with the marker', () => {
  // 硬约束 8: this is exactly the "[系统提示] 本次任务的硬约束…" copy the plugin
  // injects on later steps. It arrives as role=user but is not a human — and it
  // is not goal-shaped either, so it can neither anchor nor count as a generation.
  const reassertion = [
    '[系统提示] 本次任务的硬约束（来自用户原话，始终有效，不因上下文压缩而失效）：',
    '1. 断档状态，必须灾后重建。',
    '2. 严格校验 source.kind === user。',
    '',
    'HARD CONSTRAINTS（从源会话用户消息中抽取，逐条有效，不可协商）:',
  ].join('\n')
  const events = [userMessage(1425, reassertion, 'plugin:graft-replay')]
  assert.equal(inheritedConstraintAnchor(events, 's'), undefined)
})

test('v7.4b: a graft-authored goal still counts the chain in generations', () => {
  const events = [
    userMessage(3, EXTRACTED, 'plugin:graft-replay'),
    userMessage(40, EXTRACTED, 'plugin:graft-replay'),
  ]
  const anchor = inheritedConstraintAnchor(events, 'session-src')
  // v0.9.3: 这条断言在本次修复前断言的是「块数 == 代数」这个缺陷行为。
  // 原断言是 `assert.match(anchor, /第 2 代会话/u)` —— 两个 HARD CONSTRAINTS 块就推出
  // 「第 2 代」，于是这个测试**和缺陷站在一起**，正是它让缺口活了下来。
  // 改为跟随 mark 之后，seq 仍指向最新块（性质未变），但代数来自 mark（见下方 marked 调用）。
  assert.match(anchor, /seq=40/u, 'the newest block is still the pointer target')
  assert.equal(/第 2 代会话/u.test(anchor), false, 'two blocks do not make a generation')
  assert.match(anchor, /原始会话/u)

  // Same log, with the mark saying generation 2: now the generation is stated, and it
  // agrees with `goalMessage`'s `graft_generation` because both read the same mark.
  const marked = inheritedConstraintAnchor(events, 'session-src', 2)
  assert.match(marked, /第 2 代会话/u)
  assert.match(marked, /当前是第 3 代/u)
  assert.match(marked, /seq=40/u)
})

test('isHumanAuthored is the strict source.kind test, and only that value', () => {
  assert.equal(isHumanAuthored({ kind: 'user' }), true)
  for (const kind of ['plugin:graft-replay', 'runtime-context', 'skill-catalog', 'time-context', 'user-approval']) {
    assert.equal(isHumanAuthored({ kind }), false, `${kind} must not pass as a human`)
  }
  assert.equal(isHumanAuthored(undefined), false)
  assert.equal(isGraftAuthored({ kind: 'plugin:graft-replay' }), true)
})

// ---------------------------------------------------------------------------
// Subagent Reports: a keyword inside a dump is not a report
// ---------------------------------------------------------------------------

test('v7.4b: read/pwsh/job_output dumps are not reported as subagent reports', () => {
  const readDump = [
    '<path>D:\\work\\demo\\dsh-graft-slice\\test\\real-log.test.mjs</path>',
    '<type>file</type>',
    '<content>',
    '1: import test from "node:test"',
    '2: // the report of the runner is asserted below',
    '3: const report = 1',
    '</content>',
  ].join('\n')
  const events = [
    toolCall(1, 'read', 'c1'),
    toolResult(2, 'c1', readDump),
    toolCall(3, 'job_output', 'c2'),
    toolResult(4, 'c2', '✔ pass a\n✔ pass b\n✔ pass c\nreport ok'),
  ]
  assert.deepEqual(extractTaskState(events).subagentReports, [])
})

test('v7.4b: a real subagent conclusion still survives the filter', () => {
  const events = [
    toolCall(1, 'send_message', 'c1'),
    toolResult(2, 'c1', '子代理回传报告：解析器已完成，batch 需要去重。'),
  ]
  const reports = extractTaskState(events).subagentReports
  assert.equal(reports.length, 1)
  assert.match(reports[0], /batch 需要去重/u)
})

test('v7.4b: a report-shaped result wins even when the body is long', () => {
  const events = [
    toolCall(1, 'wait_agent', 'c1'),
    toolResult(2, 'c1', '调研结果：三条路径都可行，推荐第二条，理由是 …\n' + 'x'.repeat(3000)),
  ]
  const reports = extractTaskState(events).subagentReports
  assert.equal(reports.length, 1)
})
// ---------------------------------------------------------------------------
// Workspace Files: the cited seq must be one graft_read_result can open
// ---------------------------------------------------------------------------

test('v7.4b: the workspace block cites the RESULT seq, not the call seq', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 14888,
      data: {
        name: 'edit',
        callId: 'c1',
        arguments: JSON.stringify({ file_path: 'test/v74-two-phase.test.mjs', old_string: 'a', new_string: 'b' }),
      },
    },
    toolResult(14889, 'c1', 'The file has been updated successfully.'),
  ]
  const files = extractWorkspaceState(events)
  assert.equal(files.length, 1)
  assert.equal(files[0].seq, 14889, 'graft_read_result opens 14889; 14888 answers "No payload"')
})

test('v7.4b: a call with no result keeps its own seq (it was interrupted)', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 200,
      data: { name: 'write', callId: 'c2', arguments: JSON.stringify({ file_path: 'a.ts', content: 'x' }) },
    },
  ]
  const files = extractWorkspaceState(events)
  assert.equal(files[0].seq, 200)
})

// ---------------------------------------------------------------------------
// Carryover: v0.19 — the instruction travels, the work log does not
// ---------------------------------------------------------------------------

test('v0.19: an open turn with NO new instruction produces no carryover at all', () => {
  const log = makeSourceLog({ turns: 3 })
  const seq = log.events.at(-1).seq
  log.events.push(
    { type: 'turn/start', seq: seq + 1, time: 1, data: { turn: 4 } },
    {
      type: 'assistant/message',
      seq: seq + 2,
      time: 1,
      data: {
        turn: 4,
        step: 1,
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'text', text: '第一段：重启后先验证构建。\n\n第二段：接着提交。' }],
        },
      },
    },
  )
  const plan = buildInjectionPlan(log, {})
  const carry = plan.chunks.find((chunk) => chunk.kind === 'open-turn-carryover')
  // v0.19: narration alone is history. It used to be carried (with a note saying
  // it was assembled from several steps); now it is not carried at all, because
  // the read-back index already points at every seq it produced.
  assert.equal(carry, undefined, 'a work log with no new user instruction is not a handoff fact')
  assert.ok(
    !JSON.stringify(plan.chunks).includes('第一段：重启后先验证构建。'),
    'the narration must not appear anywhere in the tape',
  )
})
