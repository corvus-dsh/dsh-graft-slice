/**
 * v0.32 P0 — THE 0.2.2 SIGNAL CONTRACT (the "no auto wake-up" regression).
 *
 * What the user saw: the target session was created, the source was retired, and
 * NOTHING started. The audit line named the cause:
 *
 *   sessionController.prompt: Cannot read properties of undefined (reading 'throwIfAborted')
 *
 * In 0.2.2-rc.1 the Remote signature is `prompt(request, signal)` and the signal is
 * REQUIRED: the very first thing the Host does is `signal.throwIfAborted()`, so that a
 * caller cancelled before admission never queues a prompt. v0.31 passed `undefined`
 * there, which threw before a single event was written — the target stayed durable and
 * permanently inert.
 *
 * These tests drive a controller that is FAITHFUL to 0.2.2 (it touches the signal), so
 * the old bug cannot come back silently: passing `undefined` fails them.
 *
 * The second half holds the retry contract: a queued ignition must not re-instruct a
 * target that is already live, because a duplicate admission reads to the target as the
 * same instruction given twice.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  getIgnitionAdmissions,
  igniteTargetSession,
  normalizeConfig,
  resetRetiredSessions,
} from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold(controller) {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-signal-'))
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
  if (controller !== undefined) ctx.sessionController = controller
  apply(ctx, { dataDir: dir })
  return { ctx, log, dir }
}

/** A controller shaped like 0.2.2-rc.1: the signal is required and touched at once. */
function contractController({ sessions = {} } = {}) {
  const calls = []
  return {
    calls,
    async prompt(request, signal) {
      // This line IS the contract. With `undefined` it throws exactly the production
      // error: Cannot read properties of undefined (reading 'throwIfAborted').
      signal.throwIfAborted()
      calls.push({ request, signal })
      return { accepted: true }
    },
    async state(request, signal) {
      signal.throwIfAborted()
      return sessions[request.sessionId] ?? { cursor: 0, active: false, running: false, queue: null, pendingInput: [] }
    },
  }
}

test('v0.32 P0: a full graft wakes the target through a 0.2.2-shaped prompt', async () => {
  const controller = contractController()
  const { ctx, log } = scaffold(controller)

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-woken' }, {})

  assert.equal(report.ok, true)
  assert.equal(report.ignition.ok, true, 'the migration reports a real wake-up, not a crash')
  assert.equal(report.ignition.channel, 'sessionController.prompt')
  assert.equal(controller.calls.length, 1, 'exactly one prompt')
  assert.equal(controller.calls[0].request.sessionId, 'session-woken')
  resetRetiredSessions()
})

test('v0.32 P0: the Host receives a live AbortSignal, not undefined', async () => {
  const controller = contractController()
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-signal', 'source-signal')

  assert.equal(result.ok, true)
  assert.equal(controller.calls.length, 1)
  const signal = controller.calls[0].signal
  assert.ok(signal instanceof AbortSignal, 'the second argument must be an AbortSignal')
  assert.equal(signal.aborted, false, 'a signal we hand over must still be live')
  resetRetiredSessions()
})

test('v0.32 P0: a FAILING prompt still reports the reason instead of a crash', async () => {
  const controller = {
    async prompt() {
      throw new Error('session/writer-held')
    },
  }
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-busy', 'source-busy')

  assert.equal(result.attempted, true)
  assert.equal(result.ok, false)
  assert.match(result.reason, /writer-held/u, 'the reason survives into the report')
  resetRetiredSessions()
})

test('v0.32 P0: a RETRY never re-instructs a target that is already live', async () => {
  const controller = contractController({ sessions: { 'target-live': { cursor: 7, active: true, running: false, queue: [], pendingInput: [] } } })
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-live', 'source-live', { retry: true })

  assert.equal(result.ok, true, 'a live target is a success, not a failure that rolls back')
  assert.equal(result.alreadyIgnited, true)
  assert.equal(result.channel, 'sessionController.state')
  assert.equal(controller.calls.length, 0, 'no duplicate instruction was admitted')
  resetRetiredSessions()
})

test('v0.32 P0: a RETRY still wakes a cold target', async () => {
  const controller = contractController()
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-cold', 'source-cold', { retry: true })

  assert.equal(result.ok, true)
  assert.equal(result.alreadyIgnited, undefined)
  assert.equal(controller.calls.length, 1, 'a genuinely inert target is still woken')
  resetRetiredSessions()
})

test('v0.32 P0: a FRESH ignition is not skipped by a target that merely has an agent', async () => {
  // The fresh path must prompt even when the Host already holds an agent for the target:
  // "an agent exists" is exactly the inert-but-present state ignition exists to fix.
  const controller = contractController({ sessions: { 'target-fresh': { cursor: 1, active: true, running: false, queue: [], pendingInput: [] } } })
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-fresh', 'source-fresh')

  assert.equal(result.ok, true)
  assert.equal(controller.calls.length, 1, 'the fresh path always delivers its one prompt')
  resetRetiredSessions()
})

test('v0.32 P0: an UNREADABLE target log is a reported failure, never "already ignited"', async () => {
  // The production audit line that exposed this:
  //   {"kind":"ignite","detail":"ok (already ignited)"}   ← for a target with no ignition event
  // Cause: `sessionQuery.readSession` threw 0.2.2's hyphenated Remote code
  // `session/not-found`, the old `/not found/` test missed it, and the error branch
  // answered "already ignited" — so the queue entry was deleted and the target never woke.
  const controller = contractController()
  const { ctx } = scaffold(controller)
  ctx.sessionQuery = {
    async readSession() {
      throw new Error('replay validation failed at seq 12')
    },
  }
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-unreadable', 'source-x')

  assert.equal(result.ok, false, 'an unknown read is not a success')
  assert.equal(result.attempted, false)
  assert.equal(result.alreadyIgnited, undefined, 'it must not claim the target was already ignited')
  assert.match(result.reason, /cannot read target log/u)
  assert.equal(controller.calls.length, 0, 'and it must not prompt blind either')
  resetRetiredSessions()
})

test('v0.32 P0: a LIVE target with an unreadable log is still recognised as already started', async () => {
  // Production case: the retry ran while the target was being driven, `readSession`
  // failed replay validation on a live log, and the old error branch answered
  // "already ignited" — right answer, wrong reason, and the same branch lied for a
  // target that was NOT running. Liveness is now asked of the Host directly.
  const controller = contractController({ sessions: { 'target-busy': { cursor: 3, active: true, running: true, queue: [], pendingInput: [] } } })
  const { ctx } = scaffold(controller)
  ctx.sessionQuery = {
    async readSession() {
      throw new Error('replay validation failed at seq 12')
    },
  }
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-busy', 'source-busy', { retry: true })

  assert.equal(result.ok, true)
  assert.equal(result.alreadyIgnited, true)
  assert.equal(result.reason, 'target already live')
  assert.equal(controller.calls.length, 0)
  resetRetiredSessions()
})

test('v0.32 P0: a genuinely MISSING target is still prompted (the prompt resumes it)', async () => {  const controller = contractController()
  const { ctx } = scaffold(controller)
  ctx.sessionQuery = {
    async readSession() {
      throw new Error('session "target-missing" not found')
    },
  }
  const settings = normalizeConfig({})

  const result = await igniteTargetSession(ctx, settings, 'target-missing', 'source-y')

  assert.equal(result.ok, true, 'a cold target is exactly what prompt is for')
  assert.equal(controller.calls.length, 1)
  resetRetiredSessions()
})

test('v0.32 P0: a RETRY leaves a target alone once it has grown past its seed', async () => {
  // The real sequence the user hit: ignition failed, the queue kept the intent, and the
  // human opened the target and worked in it before the next start. A retry must not
  // push the ignition instruction into a session that already has its own turns.
  const controller = contractController()
  const { ctx, log } = scaffold(controller)
  const settings = normalizeConfig({})

  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'grafted-then-used' }, {})
  const seeded = controller.calls.length

  // The human (or a self-starting agent) writes to the target after the slice.
  const record = ctx._persistence.byId.get('grafted-then-used')
  assert.ok(record, 'the target is durable')
  record.events.push({
    type: 'user/message',
    seq: record.events.length,
    time: Date.now(),
    data: { id: 'human-1', role: 'user', content: [{ type: 'text', text: '请继续，未自动唤醒' }], source: { kind: 'user' } },
    surfaceOp: 'append',
  })

  // Forget the in-process admissions ONLY (a full reset also drops the graft-target
  // mark; in production the mark is durable in .graft-targets.json and reloaded at
  // activation). The decision must come from the log + the mark.
  getIgnitionAdmissions().clear()
  const retry = await igniteTargetSession(ctx, settings, 'grafted-then-used', log.session.id, { retry: true })

  assert.equal(retry.ok, true, 'an already-driven target is not a failed ignition')
  assert.equal(retry.alreadyIgnited, true)
  assert.equal(retry.reason, 'target already driven past its seed')
  assert.equal(controller.calls.length, seeded, 'no second instruction was admitted')
  resetRetiredSessions()
})
