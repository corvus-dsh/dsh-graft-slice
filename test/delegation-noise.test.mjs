import test from 'node:test'
import assert from 'node:assert/strict'

import { extractConstraints } from '../index.js'

/**
 * 真实桌面端 E2E 发现：迁移一个 subagent 会话时，DSH 注入的委派样板
 * （"Your parent agent id is … send your result to that agent with
 * send_message({...})"）被当成长期约束带进了 target。
 *
 * 后果：target 是顶层会话，却去调用 send_message 发给一个它不属于的父
 * agent，得到 SubagentError "belongs to another parent session"。
 *
 * 迁移刻意剥掉 lineage，那么这段文本也必须一起消失。
 */

const DELEGATION = [
  'Your parent agent id is "session-parent-fixture".',
  'Before you finish, send your result to that agent with send_message({ agent_id: "session-parent-fixture", message: "<self-contained result>" }).',
  'The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning.',
].join(' ')

function message(text) {
  return {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

test('delegation: harness boilerplate is never extracted as a constraint', () => {
  const found = extractConstraints([message(DELEGATION)])
  assert.equal(found.length, 0, `unexpected constraints: ${JSON.stringify(found)}`)
})

test('delegation: boilerplate is dropped even next to a real standing rule', () => {
  const found = extractConstraints([
    message(`${DELEGATION}\n\n必须始终只在要点列表里回答，不要写段落。`),
  ])
  assert.equal(found.length, 1, `expected exactly the real rule, got ${JSON.stringify(found)}`)
  assert.equal(found[0].includes('要点列表'), true)
  assert.equal(/parent agent id|send_message|self-contained/iu.test(found[0]), false)
})

test('delegation: a short delegation reply instruction never drags the boilerplate in', () => {
  // "请直接回复 noop" is a genuine one-shot imperative, so it may still be
  // extracted. What must never appear is the delegation boilerplate around it.
  const found = extractConstraints([message(`${DELEGATION}\n请直接回复 "noop"。`)])
  for (const item of found) {
    assert.equal(
      /parent agent id|send_message|self-contained result|does not automatically receive/iu.test(item),
      false,
      `delegation boilerplate leaked: ${item}`,
    )
  }
})
