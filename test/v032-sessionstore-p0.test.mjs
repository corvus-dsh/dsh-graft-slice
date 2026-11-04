/**
 * v0.32 P0 — DSH 0.2.2 moved `Session.append()` behind the store lifecycle.
 *
 * `sessions.prepare()` returns a session that is read-only until `enter()` +
 * `announce()` publish it. The graft target must stay COLD (publishing it makes
 * a later `agents.resume()` collide with a live entry, and leaving a half-live
 * entry is what broke DSH restart recovery before), so the tape is materialised
 * from the public SessionEvent shape and written only through
 * `sessionPersistence.create()` + `handle.append()`.
 *
 * These tests fail on the old code with the live error:
 *   cannot append outside a SessionStore
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, FakeSessionStore, makeCtx, makeSourceLog } from './fake-harness.mjs'

function setup() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-sessionstore-'))
  const sourceLog = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir, verifyReadBack: true })
  return { ctx, persistence, sourceLog, dir }
}

test('0.2.2 contract: a prepared session refuses append until enter + announce', () => {
  const persistence = new FakePersistence()
  const sessions = new FakeSessionStore(persistence)
  const prepared = sessions.prepare('probe-target', { meta: { cwd: process.cwd() } })
  assert.throws(
    () => prepared.append('turn/start', { turn: 1 }),
    /cannot append outside a SessionStore/u,
    'the fixture must model the exact 0.2.2 refusal, or the P0 cannot regress',
  )
  const detach = sessions.enter(prepared)
  assert.throws(
    () => prepared.append('turn/start', { turn: 1 }),
    /cannot append outside a SessionStore/u,
    'enter alone does not open writes',
  )
  sessions.announce(prepared)
  assert.doesNotThrow(() => prepared.append('turn/start', { turn: 1 }))
  detach()
  assert.equal(sessions.get('probe-target'), undefined)
})

test('P0: graft_slice_and_inject writes a cold target without appending to a prepared session', async () => {
  const { ctx, persistence, sourceLog } = setup()
  const sourceId = sourceLog.session.id
  const newId = 'session-cold-022'

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceId, newSessionId: newId }, {})

  assert.equal(report.ok, true)
  assert.equal(report.durability.attached, true)
  assert.equal(report.durability.verified, true)

  // The target is durable but NOT live: no enter/announce, no store entry.
  assert.equal(ctx.sessions.get(newId), undefined, 'a graft target must remain cold')
  assert.equal(ctx.sessions.createCalls.length, 0, 'sessions.create must never publish a graft target')

  const stored = persistence.read(newId)
  assert.ok(stored, 'the target must exist in durable storage')
  assert.equal(stored.events.length, report.durability.appended)
  for (const [index, event] of stored.events.entries()) {
    assert.equal(Number(event.seq), index, `event ${index} must be contiguous from seq 0`)
  }

  // Surface events carry exactly one append intent; log-only events carry none.
  const surfaceTypes = new Set(['system/message', 'user/message', 'assistant/message'])
  for (const event of stored.events) {
    if (surfaceTypes.has(event.type)) {
      assert.equal(event.surfaceOp, 'append', `${event.type} must carry surfaceOp:'append'`)
    } else {
      assert.equal(event.surfaceOp, undefined, `${event.type} must not carry surfaceOp`)
    }
    assert.equal(typeof event.time, 'number')
    assert.ok(event.data !== undefined)
  }

  // The skeleton is closed exactly once, then the source's runtime-intent records
  // follow as log-only events (exactly where DSH writes them).
  assert.equal(stored.events[0].type, 'turn/start')
  assert.equal(stored.events.filter((event) => event.type === 'turn/end').length, 1)
  assert.equal(
    stored.events.filter((event) => event.type === 'tool/result').length,
    0,
    'a graft tape never writes a standalone tool/result',
  )
  assert.ok(stored.events.some((event) => event.type === 'user/message'))
  assert.ok(stored.events.some((event) => event.type === 'session/title'))
})

test('P0: a preflight failure leaves neither a live session nor a durable artifact', async () => {
  const { ctx, persistence, sourceLog } = setup()
  const realPrepare = ctx.sessions.prepare.bind(ctx.sessions)
  ctx.sessions.prepare = (id, options) => {
    const session = realPrepare(id, options)
    session.header.cwd = 'relative/not/absolute'
    return session
  }

  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-prewrite' }, {}),
    /CWD_MISMATCH/u,
  )
  assert.equal(ctx.sessions.get('session-prewrite'), undefined)
  assert.equal(persistence.read('session-prewrite'), undefined)
  assert.equal(
    persistence.createCalls.filter((call) => call.header?.id === 'session-prewrite').length,
    0,
  )
})
