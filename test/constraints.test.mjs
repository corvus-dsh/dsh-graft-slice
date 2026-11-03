import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, buildInjectionPlan, extractConstraints, extractConstraintsDetailed } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

function withConstraints(log) {
  const first = log.events.find(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'user',
  )
  first.data.content[0].text +=
    '\n\n绝对约束：绝对不能使用 import re 正则库；必须把 CHECKSUM_42 标记写在第 42 行。'
}

test('v3.2: extracts absolute constraints from user messages', () => {
  const log = makeSourceLog({ turns: 7 })
  withConstraints(log)
  const constraints = extractConstraints(log.events)
  assert.equal(constraints.length, 2)
  assert.ok(constraints.some((item) => /绝对不能使用 import re/.test(item)))
  assert.ok(constraints.some((item) => /CHECKSUM_42/.test(item) && /第 42 行/.test(item)))
})

test('v7.0 C1: constraints travel in the goal user message, never the system head', async () => {
  const log = makeSourceLog({ turns: 7 })
  withConstraints(log)
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const report = await ctx._tools.get('graft_slice_and_inject').execute(
    { sourceSessionId: log.session.id, newSessionId: 'session-graft-constraints' },
    {},
  )
  assert.equal(report.ok, true)
  assert.equal(report.constraints.length, 2)
  const stored = ctx._persistence.read('session-graft-constraints')

  // The host replaces surface node 0 with its own rendered prompt on the
  // target's first live step (SystemPromptProjection.project), so anything
  // parked in the system message is destroyed before the model reads it.
  const system = stored.events.find((event) => event.type === 'system/message')
  const systemPrompt = system.data.message.content[0].text
  assert.doesNotMatch(
    systemPrompt,
    /HARD CONSTRAINTS/,
    'the system head must not carry payload the host will overwrite',
  )

  // The goal message is a user/message, which the host never rewrites.
  const goal = stored.events.find((event) => event.type === 'user/message')
  const goalText = goal.data.content[0].text
  assert.match(goalText, /HARD CONSTRAINTS/)
  assert.match(goalText, /1\. \[ \] /)
  assert.match(goalText, /enumerate every single item above without skipping or summarizing/)
  assert.match(goalText, /绝对不能使用 import re/)
  assert.match(goalText, /CHECKSUM_42/)
})

test('v3.3: extracts long conditional constraints without truncating at 600 chars', () => {
  const detail =
    '如果请求超时，则优先捕获 TimeoutError，' +
    '并且必须保留原始 checksum 字段，'.repeat(35) +
    '除非错误发生在第 42 行之后。'
  const events = [
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: detail }],
      },
    },
  ]
  const constraints = extractConstraints(events)
  assert.equal(constraints.length > 0, true)
  assert.ok(constraints.some((item) => item.includes('如果请求超时')))
  assert.ok(constraints.some((item) => item.includes('除非')))
  assert.ok(constraints.some((item) => item.length > 600))
})

test('v4.3: filters short, long, question-like and non-action sentences', () => {
  const long = '必须' + '保留字段'.repeat(250)
  const events = [
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [
          {
            type: 'text',
            text: [
              'OK?',
              'What is the default timeout?',
              'This is just descriptive prose with no action.',
              long,
              'Do not send any email without approval.',
              'Write every number as a word.',
            ].join('\n'),
          },
        ],
      },
    },
  ]
  const constraints = extractConstraints(events)
  assert.equal(constraints.some((item) => item.includes('OK?')), false)
  assert.equal(constraints.some((item) => item.includes('default timeout')), false)
  assert.equal(constraints.some((item) => item.startsWith('This is just')), false)
  assert.equal(constraints.some((item) => item.length > 800), false)
  assert.equal(constraints.some((item) => item.includes('Do not send')), true)
  assert.equal(constraints.some((item) => item.includes('Write every number')), true)
})

test('v0.18: capacity, not a count, decides how many constraints survive', () => {
  const seeds = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
  const events = [
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [
          {
            type: 'text',
            text: seeds.map((seed) => `Always keep ${seed} configuration enabled for this session.`).join('\n'),
          },
        ],
      },
    },
  ]
  // v0.18: the old rule kept the best EIGHT and said nothing about the other four.
  // Now every qualifying rule fits the declared capacity, and the ones that do not
  // fit are REPORTED — which is what lets `buildInjectionPlan` abort instead of
  // shipping a shortened list.
  const selection = extractConstraintsDetailed(events)
  assert.equal(selection.constraints.length, 12)
  assert.deepEqual(selection.dropped, [])

  const tight = extractConstraintsDetailed(events, 120)
  assert.ok(tight.constraints.length < 12, 'a small budget cannot hold all twelve')
  assert.equal(tight.constraints.length + tight.dropped.length, 12, 'every rule is kept or reported')
  assert.ok(tight.dropped.every((item) => item.reason === 'budget'))
})

test('v7.0 A3: older turns become a metadata index, not squeezed prose', () => {
  const log = makeSourceLog({ turns: 7 })
  const olderAssistant = log.events.find(
    (event) => event.type === 'assistant/message' && event.data?.turn === 1,
  )
  olderAssistant.data.message.content[0].text +=
    '\n\n必须保留 CHECKSUM_42 在第 42 行，并且绝对禁止使用正则。'
  const plan = buildInjectionPlan(log, {})
  const summary = plan.chunks.find((chunk) => chunk.kind === 'old-summary')
  assert.ok(summary)

  // v6.x ran the old turn's prose through a 600-char squeezer and hoped the
  // constraint sentence survived the squeeze. That spent budget describing work
  // the target cannot act on, and it was lossy: a regex'd paraphrase of an
  // assistant message is not the instruction.
  //
  // v7.0 states the span, the size, and the seq range to read the real thing.
  assert.match(summary.text, /\[历史片段: Turn 1-/)
  assert.match(summary.text, /轮/)
  assert.match(summary.text, /graft_read_result/)
  assert.match(summary.text, /seq=\d+-\d+/)

  // The constraint itself is no longer summarised here — it is anchored in the
  // HARD CONSTRAINTS block, which is the durable channel for it.
  assert.match(summary.text, /涉及工具:|原文按 seq=/)

  // And the index must be far smaller than the prose it replaced.
  assert.ok(summary.text.length < 400, `index should stay tiny, got ${summary.text.length}`)
})
