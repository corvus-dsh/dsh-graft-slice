import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 补丁一：被拦截瞬间的草稿不能丢。
 *
 * 旧会话 reject 时捕获最后一条 user 文本，写进 .graft-drafts.json；
 * target 第一次收到输入时把草稿与新输入合并成一条，然后立刻删除。
 */

function seedTransfer(dir, sourceId, targetId) {
  const payload = {}
  payload[sourceId] = { newSessionId: targetId, at: Date.now(), reason: `已转移至新会话 ${targetId}` }
  return payload
}

function setup({ dir, draft } = {}) {
  resetRetiredSessions()
  const tree = dir ?? mkdtempSync(join(tmpdir(), 'dsh-graft-draft-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  const targetLog = makeSourceLog({ turns: 1 })
  targetLog.session.id = 'session-draft-target'
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: tree } })
  // Pre-load the transfer file so activation marks the source as transferred.
  const transferPath = join(tree, '.transferred.json')
  mkdirSync(tree, { recursive: true })
  writeFileSync(transferPath, JSON.stringify(seedTransfer(tree, sourceLog.session.id, 'session-draft-target')), 'utf8')
  if (draft !== undefined) {
    writeFileSync(
      join(tree, '.graft-drafts.json'),
      JSON.stringify([
        {
          sourceSessionId: sourceLog.session.id,
          targetSessionId: 'session-draft-target',
          text: draft,
          capturedAt: 1,
        },
      ]),
      'utf8',
    )
  }
  apply(ctx, { retireSource: false })
  return { ctx, sourceLog, tree }
}

test('draft: a rejected source captures the in-flight user text', async () => {
  const { ctx, sourceLog, tree } = setup()
  const decision = await dispatchPreStep(ctx, {
    agent: { id: sourceLog.session.id },
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '把 auth 模块的 token 刷新改成' }] },
    ],
  })
  assert.equal(decision.kind, 'reject')
  const file = join(tree, '.graft-drafts.json')
  assert.equal(existsSync(file), true, 'the draft must be persisted')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const entry = parsed.find((item) => item.targetSessionId === 'session-draft-target')
  assert.ok(entry)
  assert.equal(entry.text, '把 auth 模块的 token 刷新改成')
})

test('draft: the target merges the draft with its new prompt exactly once', async () => {
  const { ctx } = setup({ draft: '把 auth 模块的 token 刷新改成' })
  const first = await dispatchPreStep(ctx, {
    agent: { id: 'session-draft-target' },
    messages: [{ id: 'm2', role: 'user', content: [{ type: 'text', text: '继续。' }] }],
  })
  assert.equal(first.kind, 'enter')
  const injected = first.messages.filter((m) => String(m.id ?? '').startsWith('graft-draft-'))
  assert.equal(injected.length, 1, 'exactly one merged message')
  const text = injected[0].content[0].text
  assert.match(text, /用户在上一个会话被拦截前，正在输入/)
  assert.match(text, /把 auth 模块的 token 刷新改成/)
  assert.match(text, /继续。/)

  const second = await dispatchPreStep(ctx, {
    agent: { id: 'session-draft-target' },
    messages: [{ id: 'm3', role: 'user', content: [{ type: 'text', text: '再来一次' }] }],
  })
  const again = (second.messages ?? []).filter((m) => String(m.id ?? '').startsWith('graft-draft-'))
  assert.equal(again.length, 0, 'the draft must not be injected twice')
})

test('draft: capture is skipped when the source is not actually rejected', async () => {
  resetRetiredSessions()
  const tree = mkdtempSync(join(tmpdir(), 'dsh-graft-draft-live-'))
  const sourceLog = makeSourceLog({ turns: 1 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: tree } })
  apply(ctx, {})
  const decision = await dispatchPreStep(ctx, {
    agent: { id: sourceLog.session.id },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '普通输入' }] }],
  })
  assert.equal(decision.kind, 'enter')
  assert.equal(existsSync(join(tree, '.graft-drafts.json')), false, 'nothing captured for a live session')
})
