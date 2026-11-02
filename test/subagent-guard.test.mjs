import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 真实 E2E 教训：迁移一个 subagent 会话会产出一个非法 target。
 *
 * 子代理没有独立目标，且携带 DSH 注入的委派样板（"send your result to that
 * agent with send_message(...)"）。插件事先剥掉了 lineage，于是 target 变成
 * 顶层会话却仍试图调用 send_message，得到
 * SubagentError "belongs to another parent session"。
 *
 * 因此入口必须直接拒绝 subagent 源。
 */

function setupWithHeader(headerPatch) {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-subagent-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  Object.assign(sourceLog.session, headerPatch)
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { retireSource: false })
  return { ctx, sourceLog }
}

const cases = [
  ['origin: subagent', { origin: 'subagent' }],
  ['delegationDepth: 1', { delegationDepth: 1 }],
  ['parentSession present', { parentSession: 'session-parent' }],
  ['parentSessionId present', { parentSessionId: 'session-parent' }],
]

for (const [label, patch] of cases) {
  test(`subagent guard: refuses a source with ${label}`, async () => {
    const { ctx, sourceLog } = setupWithHeader(patch)
    await assert.rejects(
      () =>
        ctx._tools
          .get('graft_slice_and_inject')
          .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-sub-reject' }, {}),
      /GRAFT_REFUSED/,
    )
  })
}

test('subagent guard: a top-level source still migrates', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-toplevel-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  // makeSourceLog already produces a top-level header; assert it stays allowed.
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { retireSource: false })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-top-ok' }, {})
  assert.equal(report.ok, true)
})
