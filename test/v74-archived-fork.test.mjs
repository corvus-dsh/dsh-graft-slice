/**
 * v7.4 P4-3: an archived fork must be VISIBLE.
 *
 * THE GAP
 *
 * `sessions.fork` persists a copy of a session but never publishes it, and the
 * Web UI learns about sessions exclusively from `api-session/added`, emitted by
 * the host on `session/created` — i.e. for published sessions only. A fork kept
 * as an experiment sample therefore exists on disk, is resumable, and is absent
 * from the sidebar.
 *
 * Measured in this project: `baseline-fork-demo`, 1,200 events, zero rows in the
 * client's session list. The user's own words were "工作区没有出现新会话".
 *
 * The fix cannot publish the fork either (publishing makes `sessions.enter`
 * throw on resume — the same trap the graft targets avoid), so it attaches the
 * session to its workspace group and emits the same cold-shape summary the
 * target path already emits.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { registerArchivedForks, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

function harness(records) {
  const log = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog: log })
  const attached = []
  const original = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'sessionQuery') return { listSessions: async () => records }
    if (name === 'workspaceRegistry') {
      return {
        resolveByPath: async () => ({ id: 'ws-1', attachSession: async (id) => attached.push(id) }),
      }
    }
    return original(name)
  }
  return { ctx, attached }
}

test('v7.4 P4-3: a cold fork is attached to its workspace and announced', async () => {
  resetRetiredSessions()
  const { ctx, attached } = harness([
    { header: { id: 'baseline-fork-demo', cwd: 'D:\\work\\demo', createdAt: 1000 }, live: false, persisted: true, formatStatus: 'current' },
    { header: { id: 'session-live', cwd: 'D:\\work\\demo', createdAt: 2000 }, live: true, persisted: true, formatStatus: 'current' },
  ])
  const before = ctx._emitted.length
  const announced = await registerArchivedForks(ctx, { registerArchivedForks: true })
  assert.equal(announced, 1, 'exactly one fork, and the live session is not one')

  const added = ctx._emitted.slice(before).filter((entry) => entry.name === 'api-session/added')
  assert.equal(added.length, 1)
  const summary = added[0].args[0]
  assert.equal(summary.sessionId, 'baseline-fork-demo')
  assert.equal(summary.agentAvailable, false, 'a cold fork has no live agent')
  assert.equal(summary.running, false)
  assert.equal(summary.blank, false)
  assert.equal(summary.cwd, 'D:\\work\\demo')
  assert.equal(summary.updatedAt, 1000, 'the header timestamp is preserved, not now()')

  assert.deepEqual(attached, ['baseline-fork-demo'], 'the fork joins its workspace group')
})

test('v7.4 P4-3: a live or non-fork session is never announced as an archive', async () => {
  resetRetiredSessions()
  const { ctx, attached } = harness([
    { header: { id: 'session-ordinary-cold', cwd: 'D:\\x' }, live: false, persisted: true },
    { header: { id: 'session-live' }, live: true, persisted: true },
  ])
  const before = ctx._emitted.length
  const announced = await registerArchivedForks(ctx, { registerArchivedForks: true })
  assert.equal(announced, 0)
  assert.equal(ctx._emitted.length, before)
  assert.deepEqual(attached, [])
})

test('v7.4 P4-3: the sweep can be switched off', async () => {
  resetRetiredSessions()
  const { ctx } = harness([
    { header: { id: 'baseline-fork-demo', cwd: 'D:\\x', createdAt: 1 }, live: false, persisted: true },
  ])
  const before = ctx._emitted.length
  const announced = await registerArchivedForks(ctx, { registerArchivedForks: false })
  assert.equal(announced, 0)
  assert.equal(ctx._emitted.length, before)
})

test('v7.4 P4-3: a host without listSessions or emit does not throw', async () => {
  resetRetiredSessions()
  const { ctx } = harness([{ header: { id: 'baseline-fork-demo' }, live: false }])
  const original = ctx.get.bind(ctx)
  ctx.get = (name) => (name === 'sessionQuery' ? {} : original(name))
  assert.equal(await registerArchivedForks(ctx, { registerArchivedForks: true }), 0)
})