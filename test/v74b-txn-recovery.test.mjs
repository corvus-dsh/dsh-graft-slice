/**
 * v7.4b regression: recovery must actually READ the journal.
 *
 * Why this file exists
 *
 * The P0-2 journal (`.txn/`) was written on every migration, and a test asserted
 * that the file appeared after a failed migration. Nothing ever called
 * `recoverGraftTransactions()` against a journal that had content, so a missing
 * `readdirSync` import shipped: the scan threw, `catch {}` turned it into
 * "0 records", and every crash looked like a clean start. The crash-injection
 * suite found it; this test keeps it found.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, recoverGraftTransactions, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold() {
  const log = makeSourceLog({ turns: 3 })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-txn-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { log, ctx, dir, persistence }
}

function writeJournal(dir, record) {
  const txnDir = join(dir, '.txn')
  mkdirSync(txnDir, { recursive: true })
  const file = join(txnDir, `${encodeURIComponent(record.sourceSessionId)}.json`)
  writeFileSync(file, JSON.stringify(record), 'utf8')
  return file
}

test('v7.4b: recovery scans the journal, rolls back, and deletes the record', () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()
  const file = writeJournal(dir, {
    sourceSessionId: log.session.id,
    targetSessionId: 'half-built-target',
    state: 'PREPARING',
    stage: 'persistence.create',
    updatedAt: new Date().toISOString(),
  })

  const first = recoverGraftTransactions(ctx)
  assert.equal(first.scanned, 1, 'the record on disk must be seen — not reported as a clean start')
  assert.deepEqual(first.rolledBack, [log.session.id])
  assert.equal(existsSync(file), false, 'the record is deleted once handled')

  const second = recoverGraftTransactions(ctx)
  assert.equal(second.scanned, 0)
  assert.deepEqual(second.rolledBack, [], 'a second start must be a no-op')
  resetRetiredSessions()
})

test('v7.4b: a COMMITTED journal is dropped without touching the source', () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()
  const file = writeJournal(dir, {
    sourceSessionId: log.session.id,
    targetSessionId: 'done-target',
    state: 'COMMITTED',
    stage: 'retire',
    updatedAt: new Date().toISOString(),
  })

  const result = recoverGraftTransactions(ctx)
  assert.equal(result.scanned, 1)
  assert.deepEqual(result.rolledBack, [])
  assert.equal(existsSync(file), false)
  resetRetiredSessions()
})

test('v7.4b: a corrupt journal is dropped, not retried forever', () => {
  resetRetiredSessions()
  const { ctx, dir } = scaffold()
  const txnDir = join(dir, '.txn')
  mkdirSync(txnDir, { recursive: true })
  const file = join(txnDir, 'garbage.json')
  writeFileSync(file, '{not json', 'utf8')

  const result = recoverGraftTransactions(ctx)
  assert.equal(result.scanned, 1)
  assert.equal(existsSync(file), false)
  assert.equal(readdirSync(txnDir).filter((name) => name.endsWith('.json')).length, 0)
  resetRetiredSessions()
})