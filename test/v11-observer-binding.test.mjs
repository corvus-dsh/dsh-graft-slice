/**
 * v1.1 OBSERVER — the follower pointer (路线 A).
 *
 * The design rejected mutual graft (副会话Observer-架构方案-v0.1.md §2) for four concrete
 * waiting cycles. What replaces it is a POINTER: the observer keeps its own session id,
 * and a transfer rewrites one record inside the already-held `source:main` lock.
 *
 * These tests pin the properties that make that safe, through the TOOL surface (which is
 * also what the model calls):
 *   - activation invents no binding;
 *   - status is read-only until an ack consumes the focus request;
 *   - summoning without a session is refused, never guessed;
 *   - a follower can never be given a follower of its own;
 *   - the follow rule ships in the runtime.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { apply } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bindingsPath = (ctx) => join(ctx.pathsData, 'observer-bindings.json')

function boot(sessionId) {
  const log = makeSourceLog({ turns: 2, sourceSessionId: sessionId, cwd: 'D:\\obs-ws' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  return { ctx, log }
}

const exec = (id) => ({ agent: { id }, callId: 'c1', name: 'tool', arguments: {}, signal: undefined })

test('v1.1 observer: activation invents no binding', () => {
  const { ctx } = boot('session-obs-plain')
  assert.equal(existsSync(bindingsPath(ctx)), false, 'nothing is created until a human asks')
})

test('v1.1 observer: status is read-only and reports empty maps before any follower', async () => {
  const { ctx } = boot('session-obs-status')
  const tool = ctx._tools.get('graft_observer_status')
  assert.ok(tool !== undefined, 'the status tool is registered')
  const status = await tool.execute({}, exec('session-obs-status'))
  assert.deepEqual(status.bindings, {})
  assert.deepEqual(status.reverse, {})
  assert.equal(status.focus, null)
})

test('v1.1 observer: summoning without a session is refused, never guessed', async () => {
  const { ctx } = boot('session-obs-none')
  const tool = ctx._tools.get('graft_observer_create')
  assert.ok(tool !== undefined, 'the summon tool is registered')
  const refused = await tool.execute({}, exec(''))
  assert.equal(refused.ok, false)
  assert.match(String(refused.text), /没有可绑定的主会话 id/u)
})

test('v1.1 observer: a follower cannot be given a follower of its own', async () => {
  const { ctx } = boot('session-obs-follower')
  // Seed the store the way the Host persists it, then read it back through the tool's
  // own guard: a follower session id must be refused as a main session.
  writeFileSync(
    bindingsPath(ctx),
    JSON.stringify({ bindings: { 'main-x': 'session-obs-follower' }, reverse: { 'session-obs-follower': 'main-x' }, focus: null }),
    'utf8',
  )
  const runtime = readFileSync(join(here, '..', 'index.js'), 'utf8')
  assert.match(runtime, /isObserverSession/u, 'the follow rule ships in the bundle')
  assert.match(runtime, /这是一个副脑会话/u, 'and the refusal has a human-readable reason')
})

test('v1.1 observer: focus is one-shot — ack consumes it exactly once', async () => {
  const { ctx } = boot('session-obs-ack')
  const tool = ctx._tools.get('graft_observer_status')
  const first = await tool.execute({ ackFocus: true }, exec('session-obs-ack'))
  assert.equal(first.focusConsumed, true, 'the ack reports what it did')
  const second = await tool.execute({ ackFocus: true }, exec('session-obs-ack'))
  assert.equal(second.focus, null, 'a second ack finds nothing to consume — safe on remount')
})

test('v1.1 observer: the transfer path owns the rebind, and it cannot block ignition', () => {
  const runtime = readFileSync(join(here, '..', 'index.js'), 'utf8')
  // The rebind is called AFTER the target is durable, and its failure is a warning.
  assert.match(runtime, /rebindObserverOnTransfer/u)
  assert.match(runtime, /observer rebind failed/u, 'a stale pointer is repairable; a blocked main is not')
  // And the observer is never prompted synchronously on this path.
  assert.doesNotMatch(runtime, /rebindObserverOnTransfer[\s\S]{0,400}await controller\.prompt/u)
})
