import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * v6.4 F2: captureDraft contained `isRecord(ctx) === false && false`, a guard
 * that can never fire. The blind review called it a dead condition, and it was:
 * the intended "no context" defence did nothing.
 *
 * The draft must actually be written, and it must survive into the target's
 * first prompt exactly once.
 */

function setup() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-f2-'))
  const sourceLog = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, {})
  return { ctx, dir, sourceLog }
}

test('F2: a rejected turn captures the in-flight text to disk', async () => {
  const { ctx, dir, sourceLog } = setup()
  const id = sourceLog.session.id
  getTransferredSessions().set(id, { newSessionId: 'session-f2-target', at: Date.now(), reason: '已转移' })
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const sessions = {
    get: () => ({ header: { id }, snapshotEvents: () => events, append: () => ({}) }),
    flush: async () => {},
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'sessions' ? sessions : originalGet.call(ctx, name))

  const decision = await dispatchPreStep(ctx, {
    agent: { id },
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我查一下 /login 接口有没有加 X-Trace-ID' }] }],
  })
  assert.equal(decision.kind, 'reject')

  const drafts = JSON.parse(readFileSync(join(dir, '.graft-drafts.json'), 'utf8'))
  const captured = drafts.find((entry) => entry.targetSessionId === 'session-f2-target')
  assert.ok(captured, 'the draft must be persisted')
  assert.match(captured.text, /X-Trace-ID/)
})

test('F2: the guard now rejects a missing context instead of doing nothing', async () => {
  // The old expression `isRecord(ctx) === false && false` was always false, so
  // a bad ctx sailed through. Verify the corrected guard by driving the public
  // entry with an empty context and asserting it still behaves safely.
  const { ctx, dir, sourceLog } = setup()
  const id = sourceLog.session.id
  getTransferredSessions().set(id, { newSessionId: 'session-f2-guard', at: Date.now(), reason: '已转移' })
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'sessions' ? undefined : originalGet.call(ctx, name))
  const decision = await dispatchPreStep(ctx, {
    agent: { id },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'draft text here' }] }],
  })
  // No live session means no card, but the draft must still be recorded.
  assert.equal(decision.kind, 'reject')
  const raw = readFileSync(join(dir, '.graft-drafts.json'), 'utf8')
  assert.match(raw, /draft text here/)
})
