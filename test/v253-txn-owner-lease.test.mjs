/**
 * v253 (B4-0a④): recovery must not roll back a migration ANOTHER live process is writing.
 *
 * The user ruling this implements (2026-11-19): two windows of the same desktop writing one
 * `dataDir` is a SUPPORTED deployment. Before this test, `recoverGraftTransactions()` ran on
 * every activation and treated "not COMMITTED" as "mine to roll back": window B starting up
 * would `markTargetBroken()` and `discardPartialTarget()` a target window A was still
 * flushing — the recovery deleting the very artifact the writer had not finished writing.
 *
 * The journal said "in flight" but not "whose". The fix is an owner stamp on the record plus
 * a rule (`txnOwnerVerdict`) whose FIRST job is to answer "do I have any right to touch it".
 *
 * ── what these tests are careful about ──────────────────────────────────────────────
 *
 * ① drives the REAL write path (a failed migration) and reads the journal it left. Without
 *    this, a regression that dropped the stamp from `writeGraftTxn` would leave every other
 *    test green — the hand-written journals below supply their own owner, so only the plugin
 *    writing one proves the plugin stamps one. (This is the "tests green, production dead"
 *    shape this repo has hit twice; see v243 in dsh-observer.)
 *
 * ②–⑥ are the decision table, one record each. The can-red for this batch is documented in
 * the report: delete the `verdict !== 'reclaim'` branch in `recoverGraftTransactions` ⇒ ② ⑤
 * go red while ③ ④ stay green (they are the "reclaim" side and must keep working).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  graftTxnOwner,
  isProcessAlive,
  recoverGraftTransactions,
  resetRetiredSessions,
  txnOwnerVerdict,
  TXN_OWNER_GRACE_MS,
} from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold(settings = {}) {
  const log = makeSourceLog({ turns: 3 })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-txn-owner-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir, ...settings })
  return { log, ctx, dir, persistence }
}

function writeJournal(dir, record) {
  const txnDir = join(dir, '.txn')
  mkdirSync(txnDir, { recursive: true })
  const file = join(txnDir, `${encodeURIComponent(record.sourceSessionId)}.json`)
  writeFileSync(file, JSON.stringify(record), 'utf8')
  return file
}

function journalEntries(dir) {
  const txnDir = join(dir, '.txn')
  return existsSync(txnDir) ? readdirSync(txnDir).filter((name) => name.endsWith('.json')) : []
}

/** A pid that is definitely not running. Picked high and verified before use. */
function deadPid() {
  for (const candidate of [999999, 999998, 999997]) {
    if (!isProcessAlive(candidate)) return candidate
  }
  throw new Error('could not find an unused pid to stand for a dead owner')
}

test('v253 ①: the journal the plugin writes carries an owner stamp', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence, dir } = scaffold({ verifyReadBack: true, retireSource: true })

  // Force the post-write read-back to disagree, which is a migration that stops
  // after the journal was written — the exact state a crash leaves behind.
  const realRead = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
  ctx.sessionQuery.readSession = async (id) => {
    if (id === 'owner-stamp-target') throw new Error('simulated round-trip corruption')
    return realRead(id)
  }

  await assert.rejects(() =>
    ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: 'owner-stamp-target' }, {}),
  )

  const entries = journalEntries(dir)
  assert.ok(entries.length >= 1, 'a failed migration must leave a journal record')
  const record = JSON.parse(readFileSync(join(dir, '.txn', entries[0]), 'utf8'))
  assert.ok(record.owner !== undefined, 'the record must say WHOSE migration this is')
  assert.equal(record.owner.pid, process.pid, 'the writer stamps its own pid')
  assert.equal(record.owner.host, hostname())
  assert.ok(typeof record.owner.token === 'string' && record.owner.token.length > 0)
  assert.ok(Number.isFinite(Date.parse(record.owner.leaseUntil)), 'the lease must be a parseable instant')
  assert.equal(record.state === 'COMMITTED', false, 'a failed migration must not claim to be committed')
  assert.equal(persistence.byId.get('owner-stamp-target') !== undefined, true, 'the target artifact exists')
  resetRetiredSessions()
})

test('v253 ②: a record owned by a LIVE pid is left exactly as it is', () => {
  resetRetiredSessions()
  const { log, ctx, dir, persistence } = scaffold()
  persistence.byId.set('live-owner-target', { header: { id: 'live-owner-target', title: 'in flight' }, events: [] })

  const file = writeJournal(dir, {
    sourceSessionId: log.session.id,
    targetSessionId: 'live-owner-target',
    state: 'TARGET_FLUSHED',
    stage: 'persistence.flush',
    updatedAt: new Date().toISOString(),
    owner: graftTxnOwner(),
  })

  const result = recoverGraftTransactions(ctx)
  assert.equal(result.scanned, 1)
  assert.deepEqual(result.rolledBack, [], 'a live owner must not be rolled back')
  assert.deepEqual(result.skipped, [{ sourceSessionId: log.session.id, verdict: 'live-owner' }])
  assert.equal(existsSync(file), true, 'the record must survive — the next start re-decides')
  assert.equal(persistence.byId.get('live-owner-target') !== undefined, true, 'the target must not be discarded')
  assert.ok(
    ctx._logged.warn.some((line) => line.includes('left an unfinished migration')),
    `the skip must be reported, not silent; got: ${JSON.stringify(ctx._logged.warn)}`,
  )
  resetRetiredSessions()
})

test('v253 ③: a record owned by a DEAD pid is rolled back (the crash case still works)', () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()
  const pid = deadPid()
  const file = writeJournal(dir, {
    sourceSessionId: log.session.id,
    targetSessionId: 'dead-owner-target',
    state: 'PREPARING',
    stage: 'paradise.create',
    updatedAt: new Date().toISOString(),
    owner: { pid, token: `${pid}-0`, host: hostname(), leaseUntil: new Date(Date.now() + 60_000).toISOString() },
  })

  const result = recoverGraftTransactions(ctx)
  assert.deepEqual(result.rolledBack, [log.session.id])
  assert.deepEqual(result.skipped, [])
  assert.equal(existsSync(file), false, 'a dead owner is debris: the record is consumed')
  resetRetiredSessions()
})

test('v253 ④: a legacy record with no owner keeps the pre-v0.35 behaviour', () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()
  const file = writeJournal(dir, {
    sourceSessionId: log.session.id,
    targetSessionId: 'legacy-target',
    state: 'PREPARING',
    stage: 'persistence.create',
    updatedAt: new Date().toISOString(),
  })

  const result = recoverGraftTransactions(ctx)
  assert.deepEqual(result.rolledBack, [log.session.id], 'an upgrade must still clean up what the old build left')
  assert.deepEqual(result.skipped, [])
  assert.equal(existsSync(file), false)
  resetRetiredSessions()
})

test('v253 ⑤: a record owned on ANOTHER host is left alone — its clock is not evidence here', () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()
  const pid = deadPid()
  const file = writeJournal(dir, {
    sourceSessionId: log.session.id,
    targetSessionId: 'foreign-host-target',
    state: 'PREPARING',
    stage: 'paradise.create',
    updatedAt: new Date().toISOString(),
    owner: { pid, token: `${pid}-0`, host: 'graft-test-foreign-host.invalid', leaseUntil: new Date().toISOString() },
  })

  const result = recoverGraftTransactions(ctx)
  assert.deepEqual(result.rolledBack, [])
  assert.deepEqual(result.skipped, [{ sourceSessionId: log.session.id, verdict: 'foreign-host' }])
  assert.equal(existsSync(file), true)
  resetRetiredSessions()
})

test('v253 ⑥: a live pid holding a record past the grace window is treated as recycled', () => {
  resetRetiredSessions()
  const now = Date.now()
  const record = {
    sourceSessionId: 'recycled-pid-source',
    targetSessionId: 'recycled-pid-target',
    state: 'PREPARING',
    stage: 'paradise.create',
    updatedAt: new Date(now - TXN_OWNER_GRACE_MS - 60_000).toISOString(),
    owner: { pid: process.pid, token: `${process.pid}-0`, host: hostname(), leaseUntil: new Date(now).toISOString() },
  }
  assert.equal(txnOwnerVerdict(record, now), 'recycled-pid', 'a six-hour-old claim by a reused pid is not a claim')
  assert.equal(txnOwnerVerdict({ ...record, updatedAt: new Date(now).toISOString() }, now), 'live-owner')
})

test('v253 ⑦: liveness beats the clock — an expired lease does not make a live writer stale', () => {
  const now = Date.now()
  const owner = graftTxnOwner(now - 60 * 60 * 1000) // written an hour ago ⇒ lease long expired
  assert.ok(Date.parse(owner.leaseUntil) < now, 'the fixture must actually be past its lease')
  const record = {
    sourceSessionId: 'slow-but-alive',
    targetSessionId: 'target',
    state: 'TARGET_FLUSHED',
    stage: 'persistence.flush',
    updatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    owner,
  }
  assert.equal(
    txnOwnerVerdict(record, now),
    'live-owner',
    'killing a slow migration because a timer elapsed is the very bug this fix removes',
  )
})