/**
 * v7.8: plan-before-work, artifact reuse, owned+leased locks.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireFileLock, buildInjectionPlan, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

function withTodos(log, todos) {
  const base = log.events.at(-1).seq
  log.events.push({ type: 'tool/call', seq: base + 1, data: { name: 'todo_write', callId: 'todo-1', arguments: JSON.stringify({ todos }) } })
  log.events.push({ type: 'tool/result', seq: base + 2, data: { message: { source: { callId: 'todo-1' }, content: [{ type: 'text', text: 'ok' }] } } })
  return log
}

test('v7.8: a long unplanned task gets the phase-planning nudge', async () => {
  resetRetiredSessions()
  const todos = Array.from({ length: 5 }, (_, index) => ({ content: `待办事项 ${index + 1}`, status: 'pending' }))
  const log = withTodos(makeSourceLog({ turns: 3 }), todos)
  const ctx = makeCtx({ sourceLog: log })
  const { apply } = await import('../index.js')
  apply(ctx, { modelDrivenGraft: true, autoGraft: false })
  const decision = await dispatchPreStep(ctx, {
    agent: { id: log.session.id },
    turn: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续实现，先把手上的事情推进。' }] }],
  })
  const text = JSON.stringify(decision)
  assert.match(text, /制定阶段节点（Phase）/u)
  assert.match(text, /明确每个节点的完成标准/u)
  resetRetiredSessions()
})

test('v7.8: a task with phase-prefixed todos is not nagged', async () => {
  resetRetiredSessions()
  const todos = Array.from({ length: 5 }, (_, index) => ({ content: `阶段 ${index + 1}: 待办 ${index + 1}`, status: 'pending' }))
  const log = withTodos(makeSourceLog({ turns: 3 }), todos)
  const ctx = makeCtx({ sourceLog: log })
  const { apply } = await import('../index.js')
  apply(ctx, { modelDrivenGraft: true, autoGraft: false })
  const decision = await dispatchPreStep(ctx, {
    agent: { id: log.session.id },
    turn: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续。' }] }],
  })
  assert.doesNotMatch(JSON.stringify(decision), /制定阶段节点（Phase）/u)
  resetRetiredSessions()
})

test('v7.8: written files are named as reusable artifacts in the pending state', () => {
  const log = makeSourceLog({ turns: 2 })
  const endIndex = log.events.findLastIndex((event) => event.type === 'turn/end')
  const seq = log.events[endIndex].seq
  // Insert BEFORE the closing turn/end: a write in the open turn would be carried
  // separately, and the artifact note belongs to the closed tape.
  log.events.splice(
    endIndex,
    0,
    { type: 'tool/call', seq: seq - 0.2, data: { name: 'write', callId: 'w1', arguments: JSON.stringify({ file_path: 'D:\\proj\\orm.py', content: 'x' }) } },
    { type: 'tool/result', seq: seq - 0.1, data: { message: { source: { callId: 'w1' }, content: [{ type: 'text', text: 'written' }] } } },
  )
  const plan = buildInjectionPlan(log, {})
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')?.text ?? ''
  assert.match(pending, /已完成节点产物：D:\\proj\\orm\.py/u)
  assert.match(pending, /直接 read 复用，避免重复生成/u)
})

test('v7.8: the lock lease is renewed and only the owner may release', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-lease-'))
  const target = join(dir, 'state.json')
  const release = acquireFileLock(target, { leaseMs: 120, staleMs: 5_000, silent: true })
  const ownerPath = join(`${target}.lock`, 'owner')
  const first = JSON.parse(readFileSync(ownerPath, 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 220))
  const renewed = JSON.parse(readFileSync(ownerPath, 'utf8'))
  assert.equal(renewed.token, first.token, 'the owner token is stable across renewals')
  assert.ok(renewed.at > first.at, 'the lease timestamp advanced while held')

  // A foreign owner must not be able to delete a lock it does not hold.
  writeFileSync(ownerPath, JSON.stringify({ token: 'someone-else', pid: 1, at: Date.now() }), 'utf8')
  release()
  assert.ok(existsSync(`${target}.lock`), 'release refused: the lock belongs to another owner')
  // Cleanup for the next test.
  const { rmSync } = await import('node:fs')
  rmSync(`${target}.lock`, { recursive: true, force: true })
})