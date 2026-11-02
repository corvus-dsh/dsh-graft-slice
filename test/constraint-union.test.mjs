import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, extractConstraints, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 后台 LLM 结果必须与正则兜底取并集。
 *
 * 真实 E2E 发现：正则抓到 2 条、LLM 只回 1 条时，旧实现直接用 LLM 结果覆盖，
 * 用户在系统头里看到的规则和随后注入的规则不一致，且丢了一条从未被撤销的约束。
 */

const BASELINE = '必须始终只在要点列表里回答，不要写段落。'
const EXTRA = '涉及数字时必须写成英文单词。'

function setup(llmText) {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-union-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  // Give the fixture a real standing constraint so the regex baseline is non-empty.
  sourceLog.events.push({
    type: 'user/message',
    seq: sourceLog.events.length,
    time: Date.now(),
    data: {
      id: 'u-constraints',
      role: 'user',
      content: [{ type: 'text', text: BASELINE }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: llmText }
      })()
    },
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'llm' ? llm : originalGet.call(ctx, name))
  apply(ctx, {})
  return { ctx, sourceLog, dir }
}

function readPending(dir, targetId) {
  const parsed = JSON.parse(readFileSync(join(dir, '.pending-constraints.json'), 'utf8'))
  return parsed.find((item) => item.targetId === targetId)
}

test('union: the regex baseline really is non-empty in this fixture', () => {
  resetRetiredSessions()
  const sourceLog = makeSourceLog({ turns: 1 })
  sourceLog.events.push({
    type: 'user/message',
    seq: sourceLog.events.length,
    time: Date.now(),
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: BASELINE }], source: { kind: 'user' } },
    surfaceOp: 'append',
  })
  const found = extractConstraints(sourceLog.events)
  assert.equal(found.length > 0, true, 'fixture must produce a regex constraint')
})

test('union: a shorter LLM answer does not drop the regex baseline', async () => {
  // LLM returns only the extra rule; the baseline must survive the merge.
  const { ctx, sourceLog, dir } = setup(JSON.stringify([EXTRA]))
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-union-1' }, {})
  await new Promise((resolve) => setTimeout(resolve, 80))
  const entry = readPending(dir, 'session-union-1')
  assert.ok(entry, 'pending entry must exist')
  assert.equal(
    entry.constraints.some((item) => item.includes('要点列表')),
    true,
    'the regex baseline must survive a shorter LLM answer',
  )
  assert.equal(
    entry.constraints.some((item) => item.includes('英文单词')),
    true,
    'the LLM extra rule must also survive',
  )
})

test('union: duplicate wording is collapsed', async () => {
  const { ctx, sourceLog, dir } = setup(JSON.stringify([EXTRA, EXTRA]))
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-union-2' }, {})
  await new Promise((resolve) => setTimeout(resolve, 80))
  const entry = readPending(dir, 'session-union-2')
  assert.equal(entry.constraints.filter((item) => item.includes('英文单词')).length, 1)
})
