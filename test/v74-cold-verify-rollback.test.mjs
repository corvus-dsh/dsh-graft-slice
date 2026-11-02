/**
 * v7.4 P0-1a: a failed cold verification must not leave an orphan target.
 *
 * THE GAP
 *
 * The append/flush failure path had a cleanup (`discardPartialTarget`, v7.0
 * P0-4). The COLD VERIFICATION path did not: `assertColdLog` ran outside any
 * try/catch, so a rejection threw straight out of the graft. By then
 * `persistence.create` had reserved the target id and the flush had made a
 * complete-looking log durable — a session the host can list but not open, under
 * an id that can never be reused.
 *
 * The source is still live at that point (retirement is the LAST step), so the
 * rollback direction is unambiguous: destroy the target, keep the source.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold() {
  const log = makeSourceLog({ turns: 3 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-coldverify-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  return { log, ctx, persistence, dir }
}

test('v7.4 P0-1a: an invalid tape never reaches persistence — validation runs first', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence, dir } = scaffold()
  apply(ctx, { dataDir: dir, verifyReadBack: true })

  // Corrupt the tape in memory: fewer events than the plan says must exist. The
  // pre-write check catches this BEFORE `persistence.create`, which is the whole
  // point of the reordering — the host has no delete, so avoidance beats cleanup.
  const realPrepare = ctx.sessions.prepare.bind(ctx.sessions)
  ctx.sessions.prepare = (id, options) => {
    const session = realPrepare(id, options)
    const realSnapshot = session.snapshotEvents.bind(session)
    session.snapshotEvents = (from) => {
      const all = realSnapshot(from)
      return from === undefined || from === 0 ? all.slice(0, Math.max(0, all.length - 1)) : all
    }
    return session
  }

  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: log.session.id, newSessionId: 'prewrite-target' }, {}),
    /APPEND_COUNT_MISMATCH|cold/iu,
  )

  // Nothing was reserved, so nothing has to be cleaned up.
  assert.equal(persistence.byId.get('prewrite-target'), undefined, 'no artifact may be created')
  assert.equal(
    persistence.createCalls.filter((call) => call.header?.id === 'prewrite-target').length,
    0,
    'persistence.create must not run when the tape is invalid',
  )
  resetRetiredSessions()
})

test('v7.4 P0-1a: a post-write verification failure marks the target and keeps the source', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence, dir } = scaffold()
  apply(ctx, { dataDir: dir, verifyReadBack: true, retireSource: true })

  // Force the READ-BACK to disagree with what was written. The tape itself was
  // valid (it passed the pre-write gate), so this models a persistence round-trip
  // that corrupted the artifact — the one case cleanup cannot undo.
  const realRead = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  ctx.sessionQuery.readSession = async (id) => {
    if (id === 'roundtrip-target') throw new Error('simulated round-trip corruption')
    return realRead(id)
  }

  await assert.rejects(() =>
    ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: 'roundtrip-target' }, {}),
  )

  // The source must remain usable: retirement is the last step and never ran.
  const { resumeSession } = await import('../index.js')
  const outcome = resumeSession(ctx, log.session.id)
  assert.equal(outcome.wasRetired, false, 'the source must not have been retired')
  assert.equal(outcome.wasTransferred, false)

  // A journal entry survives so the NEXT start can finish the cleanup.
  const txnDir = join(dir, '.txn')
  const entries = existsSync(txnDir) ? readdirSync(txnDir).filter((n) => n.endsWith('.json')) : []
  assert.ok(entries.length >= 1, 'an interrupted migration must leave a recoverable record')
  resetRetiredSessions()
})

test('v7.4 P0-1a: the source is NOT retired when verification fails', async () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()
  apply(ctx, { dataDir: dir, verifyReadBack: true, retireSource: true })

  const realRead = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  ctx.sessionQuery.readSession = async (id) => {
    if (id === 'coldverify-target-2') throw new Error('simulated cold verification rejection')
    return realRead(id)
  }

  await assert.rejects(() =>
    ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: 'coldverify-target-2' }, {}),
  )

  // Retirement is the last step of the transaction, so a failure here must leave
  // the source untouched. `resumeSession` reporting `wasRetired: false` proves it.
  const { resumeSession } = await import('../index.js')
  const outcome = resumeSession(ctx, log.session.id)
  assert.equal(outcome.wasRetired, false, 'the source must not have been retired')
  assert.equal(outcome.wasTransferred, false)
  resetRetiredSessions()
})

test('v7.4 P0-1a: a successful verification still commits normally', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence, dir } = scaffold()
  apply(ctx, { dataDir: dir, verifyReadBack: true, retireSource: true })

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'coldverify-ok' }, {})
  assert.equal(report.ok, true)
  assert.ok(persistence.byId.get('coldverify-ok'), 'the verified target must survive')
  assert.equal(report.retired.source, true)
  assert.equal(
    report.warnings.some((warning) => warning.includes('cold verification failed')),
    false,
    'no failure warning on the success path',
  )
  resetRetiredSessions()
})