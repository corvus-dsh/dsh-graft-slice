import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 真实桌面端反馈：同一源会话迁移两次后，侧边栏出现两条完全同名的
 * "[接续] 检查下大量会话…"，用户以为第二个会话消失了。
 *
 * 标题必须能区分不同的 target。
 */

function setup() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-title-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { retireSource: false })
  return { ctx, sourceLog }
}

test('title: two targets of one source get distinguishable titles', async () => {
  const { ctx, sourceLog } = setup()
  const tool = ctx._tools.get('graft_slice_and_inject')

  const first = await tool.execute(
    { sourceSessionId: sourceLog.session.id, newSessionId: 'session-title-alpha' },
    {},
  )
  const second = await tool.execute(
    { sourceSessionId: sourceLog.session.id, newSessionId: 'session-title-beta' },
    {},
  )
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)

  const readTitle = (id) => {
    const stored = ctx._persistence.read(id)
    return stored.events.find((event) => event.type === 'session/title').data.title
  }
  const titleA = readTitle('session-title-alpha')
  const titleB = readTitle('session-title-beta')

  assert.notEqual(titleA, titleB, 'identical titles hide one target from the sidebar')
  assert.match(titleA, /· alpha$/)
  assert.match(titleB, /· e-beta$/)
})

test('title: a structured goal still falls back to a timestamp form', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-title2-'))
  const sourceLog = makeSourceLog({ turns: 1 })
  // Replace the leading user message so the extracted goal IS the JSON payload.
  const firstUser = sourceLog.events.findIndex((event) => event.type === 'user/message')
  sourceLog.events[firstUser] = {
    type: 'user/message',
    seq: sourceLog.events[firstUser].seq,
    time: Date.now(),
    data: {
      id: 'u-json',
      role: 'user',
      content: [{ type: 'text', text: '{"kind":"persistent-capability-seed","goal":"x"}' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { retireSource: false })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-title-json' }, {})

  const stored = ctx._persistence.read('session-title-json')
  const title = stored.events.find((event) => event.type === 'session/title').data.title
  assert.equal(title.includes('{'), false, 'no half-JSON may reach the sidebar')
  assert.match(title, /^\[接续\] \d{2}-\d{2} \d{2}:\d{2}/)
})
