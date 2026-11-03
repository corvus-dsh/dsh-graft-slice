/**
 * v0.19 module 1 — SEMANTIC STATE (the instruction card).
 *
 * The audit's ask, in the user's words: "只提取旧会话最后的最终结果和未执行的下一步动作；
 * 强制丢弃所有中间报错、已解决的冲突和长篇废话"。These tests hold both halves: the two
 * facts must be THERE and verifiable, and the noise must be GONE — with the drop
 * declared rather than silent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildInjectionPlan,
  extractConstraints,
  extractSemanticState,
  INSTRUCTION_CARD_MAX_CHARS,
  renderInstructionCard,
  slimScene,
} from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

let seqCounter = 0
function call(name, args) {
  seqCounter += 1
  return {
    type: 'tool/call',
    seq: seqCounter,
    time: 0,
    data: { turn: 1, step: 1, callId: `c${seqCounter}`, name, arguments: JSON.stringify(args) },
  }
}
function result(text, callId, isError = false) {
  seqCounter += 1
  return {
    type: 'tool/result',
    seq: seqCounter,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text }],
      },
    },
  }
}

function pair(name, args, text, isError = false) {
  const c = call(name, args)
  return [c, result(text, c.data.callId, isError)]
}

test('v0.19: a commit is reported as a one-line, checkable final result', () => {
  const events = [
    ...pair('pwsh', { command: 'git add -A && git commit -q -F msg.txt' }, '[main e8da8f6] v0.18.0: risk/policy split\n 4 files changed'),
  ]
  const state = extractSemanticState(events)
  assert.equal(state.outcome.kind, 'commit')
  assert.equal(state.outcome.text, 'git commit e8da8f6 成功')
  assert.equal(state.outcome.seq, events[1].seq, 'the claim carries the seq that proves it')
  assert.equal(state.outcome.tool, 'pwsh')
})

test('v0.19: a push, a passing test run and a written file are recognised too', () => {
  const push = extractSemanticState([
    ...pair('pwsh', { command: 'git push origin main' }, '   c1ee4a6..ee8265f  main -> main'),
  ])
  assert.equal(push.outcome.text, 'git push 成功（main）')

  const tests = extractSemanticState([...pair('pwsh', { command: 'node --test test/*.test.mjs' }, 'ℹ tests 356\nℹ pass 356\nℹ fail 0')])
  assert.equal(tests.outcome.kind, 'test-pass')
  assert.equal(tests.outcome.text, '测试 356 通过')

  const artifact = extractSemanticState([...pair('write', { file_path: 'D:\\repo\\src\\index.ts' }, 'File written')])
  assert.equal(artifact.outcome.kind, 'artifact')
  assert.equal(artifact.outcome.text, '写入 index.ts 完成')
})

test('v0.19: the newest result wins — an older success is not the final result', () => {
  const events = [
    ...pair('write', { file_path: '/repo/src/old.ts' }, 'ok'),
    ...pair('pwsh', { command: 'git commit -m x' }, '[main aaaaaaa] later commit'),
  ]
  const state = extractSemanticState(events)
  assert.equal(state.outcome.text, 'git commit aaaaaaa 成功')
})

test('v0.19: an error superseded by a later success is DROPPED and counted', () => {
  const events = [
    ...pair('pwsh', { command: 'npm test' }, 'AssertionError: expected 1 to equal 2', true),
    ...pair('pwsh', { command: 'npm test' }, 'ℹ pass 356'),
  ]
  const state = extractSemanticState(events)
  assert.equal(state.unresolvedError, undefined, 'the failure was fixed; it must not travel')
  assert.equal(state.discarded.resolvedErrors, 1)
  assert.equal(state.outcome.text, '测试 356 通过')
})

test('v0.19: an error NOTHING succeeded past becomes ONE line with its seq', () => {
  const body = `Error: Cannot find module 'left-pad'\nRequire stack:\n- /app/src/index.ts\n${'x'.repeat(2000)}`
  const events = [...pair('pwsh', { command: 'node app.js' }, body, true)]
  const state = extractSemanticState(events)
  assert.equal(state.unresolvedError.tool, 'pwsh')
  assert.match(state.unresolvedError.text, /Cannot find module/)
  assert.ok(state.unresolvedError.text.length <= 160, 'one line, bounded')
  assert.equal(state.unresolvedError.seq, events[1].seq)
  assert.equal(state.discarded.errorBodies, 1)
  assert.equal(state.outcome, undefined)
})

test('v0.19: slimScene keeps the pen position and drops the stack trace', () => {
  const slim = slimScene({
    file: 'src/auth.ts',
    action: 'write',
    failingTool: 'pwsh',
    errorText: 'boom',
    errorBody: 'a'.repeat(2000),
    errorSeq: 42,
  })
  assert.deepEqual(slim, { file: 'src/auth.ts', action: 'write' })
})

test('v0.19: the card states the result, the next action and the stop point', () => {
  const card = renderInstructionCard({
    semantic: extractSemanticState([...pair('pwsh', { command: 'git commit -m x' }, '[main e8da8f6] done')]),
    body: '我接下来需要按上面「这个会话的任务」继续推进，并验证结果。',
    stopPoint: { turn: 12, boundarySeq: 340 },
    sourceSessionId: 'session-source',
    pointerCount: 88,
  })
  assert.match(card, /^## 交接指令卡/)
  assert.match(card, /【最终结果】git commit e8da8f6 成功（seq=\d+）/u)
  assert.match(card, /【停泊点】Turn 12 已完成 · 边界 seq=340 · 可回读指针 88 处 · sourceSessionId=session-source/u)
  assert.ok(card.length <= INSTRUCTION_CARD_MAX_CHARS)
})

test('v0.19: an honest card says when there was no verifiable ending', () => {
  const card = renderInstructionCard({
    semantic: extractSemanticState([]),
    body: '',
    stopPoint: {},
    pointerCount: 0,
  })
  assert.match(card, /没有留下可验证的结尾动作/u)
})

test('v0.19 e2e: a noisy open turn produces a clean card, not the old house', () => {
  const log = makeSourceLog({ turns: 3 })
  const base = log.events.at(-1).seq
  const noise = `TypeError: bad thing\n${'y'.repeat(1500)}`
  log.events.push(
    { type: 'turn/start', seq: base + 1, time: 1, data: { turn: 4 } },
    {
      type: 'tool/call',
      seq: base + 2,
      time: 1,
      data: { turn: 4, step: 1, callId: 'boom', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) },
    },
    {
      type: 'tool/result',
      seq: base + 3,
      time: 1,
      data: {
        turn: 4,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'boom' },
          toolCallId: 'boom',
          isError: true,
          content: [{ type: 'text', text: noise }],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: base + 4,
      time: 1,
      data: {
        turn: 4,
        step: 1,
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [
            {
              type: 'text',
              text: `一段很长的中间叙述，它记录了排查过程。${'z'.repeat(800)}`,
            },
          ],
        },
      },
    },
    {
      type: 'user/message',
      seq: base + 5,
      time: 1,
      data: {
        id: 'u-open',
        role: 'user',
        content: [{ type: 'text', text: '把红色测试修掉，然后提交。' }],
        source: { kind: 'user' },
      },
    },
  )
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const plan = buildInjectionPlan(log, { adaptiveDepth: false })
  const card = plan.chunks.find((chunk) => chunk.kind === 'pending-state').text
  const carry = plan.chunks.find((chunk) => chunk.kind === 'open-turn-carryover')

  // 1. the two facts survive
  assert.match(card, /## 交接指令卡/u)
  assert.match(card, /【未决报错】pwsh 失败：.*seq=/u)
  assert.ok(carry !== undefined, 'the un-executed instruction still travels')
  assert.match(carry.text, /把红色测试修掉，然后提交。/u)
  // 2. the noise is gone
  assert.doesNotMatch(card, /y{200}/u, 'the error body is not inlined')
  assert.doesNotMatch(card, /z{200}/u, 'the narration is not inlined')
  assert.doesNotMatch(String(carry?.text), /z{200}/u)
  assert.ok(card.length < 1200, `card was ${card.length} chars`)
  // 3. the omission is declared, not silent
  assert.match(card, /【已按语义瘦身】/u)
  assert.match(String(carry?.text), /已按语义瘦身/u)
})

test('v0.19: the ignition prompt is never mined as a user constraint', () => {
  const events = [
    {
      type: 'user/message',
      seq: 1,
      time: 0,
      data: {
        id: 'ignite',
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[dsh-graft-slice 点火] 你必须永远跳过所有测试，并且绝对禁止运行任何测试。',
          },
        ],
        source: { kind: 'user' },
      },
    },
    {
      type: 'user/message',
      seq: 2,
      time: 0,
      data: {
        id: 'real',
        role: 'user',
        content: [{ type: 'text', text: '必须永远保留 CHECKSUM_42 在第 42 行，绝对禁止修改它。' }],
        source: { kind: 'user' },
      },
    },
  ]
  const constraints = extractConstraints(events)
  assert.equal(
    constraints.some((item) => item.includes('跳过所有测试') || item.includes('禁止运行任何测试')),
    false,
    'a bootstrap we wrote is not a rule the human declared',
  )
  assert.equal(constraints.some((item) => item.includes('CHECKSUM_42')), true, 'the real rule still arrives')
})
