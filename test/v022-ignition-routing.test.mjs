/**
 * v0.22 P0 — IGNITION ROUTING ISOLATION.
 *
 * "A's instruction must never be delivered to B." Two ways that can happen, and the
 * test holds both:
 *
 *   1. state shared across targets — a single "last ignited id", or a boolean — would
 *      let A's admission mark B as already started: A's instruction goes nowhere and B
 *      never gets one;
 *   2. a route that does not name the target — `prompt(request)` built from ambient
 *      state rather than from the id it was called for.
 *
 * The fixture asserts on the SESSION ID RECEIVED BY THE HOST CHANNEL, which is the only
 * place the mistake is visible.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  getIgnitionAdmissions,
  hasIgnitionAdmission,
  igniteTargetSession,
  markIgnitionAdmission,
  normalizeConfig,
  resetRetiredSessions,
} from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold(controller) {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  if (controller !== undefined) ctx.sessionController = controller
  apply(ctx, { dataDir: ctx.pathsData })
  return { ctx, log }
}

function recording() {
  const calls = []
  return {
    calls,
    async prompt(request) {
      calls.push(request)
      return { accepted: true }
    },
  }
}

test('v0.22 P0: two targets each get their OWN prompt, to their OWN id', async () => {
  const controller = recording()
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  await igniteTargetSession(ctx, settings, 'target-a', 'source-a')
  await igniteTargetSession(ctx, settings, 'target-b', 'source-b')

  assert.equal(controller.calls.length, 2, 'both targets were woken')
  assert.equal(controller.calls[0].sessionId, 'target-a')
  assert.equal(controller.calls[1].sessionId, 'target-b')
  assert.notEqual(controller.calls[0].requestId, controller.calls[1].requestId, 'request ids are per attempt, not shared')
})

test('v0.22 P0: an admission for A does not mark B as already ignited', async () => {
  const controller = recording()
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  await igniteTargetSession(ctx, settings, 'target-a', 'source-a')
  assert.equal(hasIgnitionAdmission('target-a'), true)
  // THE ASSERTION: B is a different target and must be untouched by A's admission.
  assert.equal(hasIgnitionAdmission('target-b'), false, 'a shared flag would silently skip B')

  await igniteTargetSession(ctx, settings, 'target-b', 'source-b')
  assert.equal(controller.calls.length, 2, 'B still got its own prompt')
  assert.equal(controller.calls[1].sessionId, 'target-b')
})

test('v0.22 P0: re-igniting the SAME target is refused as already ignited', async () => {
  const controller = recording()
  const { ctx } = scaffold(controller)
  const settings = normalizeConfig({})

  const first = await igniteTargetSession(ctx, settings, 'target-same', 'source-same')
  assert.equal(first.ok, true)
  const second = await igniteTargetSession(ctx, settings, 'target-same', 'source-same')
  assert.equal(second.ok, true)
  assert.equal(second.alreadyIgnited, true, 'a duplicate admission reads as two turns of user intent')
  assert.equal(controller.calls.length, 1, 'only one prompt was delivered')
})

test('v0.22 P0: the admission ledger is keyed by target id', () => {
  resetRetiredSessions()
  markIgnitionAdmission('t-1', 42)
  markIgnitionAdmission('t-2', 7)
  const admissions = getIgnitionAdmissions()
  assert.equal(admissions.size, 2)
  assert.equal(admissions.get('t-1')?.promptChars, 42)
  assert.equal(admissions.get('t-2')?.promptChars, 7)
  // Re-marking one target must not disturb the other.
  markIgnitionAdmission('t-1', 99)
  assert.equal(admissions.get('t-2')?.promptChars, 7, 'A overwrote B')
  resetRetiredSessions()
  assert.equal(getIgnitionAdmissions().size, 0, 'a reset clears the per-target marks')
})

test('v0.22 P0: the target log is consulted per id, not once per process', async () => {
  // A target whose log ALREADY carries the ignition prompt is skipped; a DIFFERENT
  // target with a clean log is not. This is the log-based half of the routing contract.
  const controller = recording()
  const { ctx, log } = scaffold(controller)
  const settings = normalizeConfig({})

  // Create a REAL durable target, then seed its log with the marker (as the host would
  // have done when it admitted a prompt whose acknowledgement was lost).
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'warm' }, {})
  const warmCalls = controller.calls.length
  assert.ok(warmCalls >= 1)
  const record = ctx._persistence.byId.get('warm')
  assert.ok(record, 'the target is durable')
  record.events.push({
    type: 'user/message',
    seq: record.events.length,
    time: Date.now(),
    data: {
      id: 'ignite-in-log',
      role: 'user',
      content: [{ type: 'text', text: '[dsh-graft-slice 点火] 继续' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })

  // Clear only the in-process admissions, so the decision must come from the LOGS.
  resetRetiredSessions()
  await igniteTargetSession(ctx, settings, 'warm', log.session.id)
  assert.equal(controller.calls.length, warmCalls, 'the warm target was not prompted again')

  const coldResult = await igniteTargetSession(ctx, settings, 'cold', log.session.id)
  assert.equal(coldResult.ok, true)
  assert.equal(controller.calls.length, warmCalls + 1, 'the clean target still woke up')
  assert.equal(controller.calls.at(-1).sessionId, 'cold')
  resetRetiredSessions()
})
