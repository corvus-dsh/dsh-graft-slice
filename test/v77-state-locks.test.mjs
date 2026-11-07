/**
 * v7.7: state files must survive CONCURRENT writers.
 *
 * The field failure this encodes: two sessions grafted at the same time. Each
 * process serialised its own in-memory map and renamed it over the shared file,
 * so the second write erased the first session's retirement. After a restart the
 * "erased" session was usable again and grafted a second target, while the first
 * saw "already transferred" and reported a drift that never happened.
 *
 * Contract under test:
 *   1. a write MERGES with what is on disk (never blind-overwrites);
 *   2. an explicit removal stays removed (rollback / resume);
 *   3. the mkdir lock is mutually exclusive ACROSS PROCESSES;
 *   4. a crashed holder cannot pin the store (stale lock is stolen).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply, getTransferredSessions, resetRetiredSessions, readLedgerPayload } from '../index.js'
import { acquireFileLock, setAuditSink } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CONFIG = {
  autoGraft: true,
  autoGraftAtRatio: 0.75,
  contextWindowTokens: 500,
  recentTurns: 2,
  retireSource: true,
  verifyReadBack: true,
}

const settle = (ms = 2400) => new Promise((resolve) => setTimeout(resolve, ms))

function twoSessionsOneDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-lock-'))
  const logA = makeSourceLog({ turns: 7, sourceSessionId: 'session-lock-a' })
  const logB = makeSourceLog({ turns: 7, sourceSessionId: 'session-lock-b' })
  const ctxA = makeCtx({ sourceLog: logA, paths: { data: dir } })
  const ctxB = makeCtx({ sourceLog: logB, paths: { data: dir } })
  // Both contexts activate BEFORE either writes: each holds an empty view, which
  // is exactly the stale-writer shape that used to erase the other side.
  apply(ctxA, { ...CONFIG, dataDir: dir })
  apply(ctxB, { ...CONFIG, dataDir: dir })
  return { dir, logA, logB, ctxA, ctxB }
}

function readRetired(dir) {
  return readLedgerPayload(join(dir, '.retired.json'))
}

test('v7.7: concurrent retirement writes merge instead of erasing each other', async () => {
  resetRetiredSessions()
  const { dir, logA, logB, ctxA, ctxB } = twoSessionsOneDir()

  await dispatchPreStep(ctxA, { agent: { id: logA.session.id }, messages: [] })
  await settle()
  assert.ok(getTransferredSessions().get(logA.session.id), 'A must be grafted first')
  assert.deepEqual(readRetired(dir), [logA.session.id], 'A is on disk')

  await dispatchPreStep(ctxB, { agent: { id: logB.session.id }, messages: [] })
  await settle()

  const retired = readRetired(dir).sort()
  assert.deepEqual(
    retired,
    [logA.session.id, logB.session.id].sort(),
    'B\'s write must ADD to the ledger, not replace it',
  )
  const transfers = readLedgerPayload(join(dir, '.transferred.json'))
  assert.ok(transfers[logA.session.id], 'A\'s transfer survives B\'s write')
  assert.ok(transfers[logB.session.id], 'B\'s transfer is recorded')
  resetRetiredSessions()
})

test('v7.7: a prepared slice survives another process preparing its own', async () => {
  resetRetiredSessions()
  const { dir, logA, logB, ctxA, ctxB } = twoSessionsOneDir()

  const preparedA = await ctxA._tools.get('graft_prepare').execute({ sourceSessionId: logA.session.id }, {})
  assert.ok(preparedA.preparedId)

  // Another process prepares its own slice into the same dataDir.
  const preparedB = await ctxB._tools.get('graft_prepare').execute({ sourceSessionId: logB.session.id }, {})
  assert.ok(preparedB.preparedId)

  const store = JSON.parse(readFileSync(join(dir, '.graft-prepared.json'), 'utf8'))
  assert.ok(store[preparedA.preparedId], 'A\'s prepared entry must not be overwritten by B')
  assert.ok(store[preparedB.preparedId])

  const committed = await ctxA._tools
    .get('graft_commit')
    .execute({ preparedId: preparedA.preparedId, digest: preparedA.digest }, {})
  assert.equal(committed.ok, true, 'A\'s commit must still find its own prepared slice')
  resetRetiredSessions()
})

test('v7.7: the lock is mutually exclusive across real processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-mp-'))
  const counter = join(dir, 'counter.txt')
  const entry = pathToFileURL(join(ROOT, 'index.js')).href
  const script = `
import { acquireFileLock } from ${JSON.stringify(entry)};
import fs from 'node:fs';
const target = process.argv[1];
const release = acquireFileLock(target, { timeoutMs: 30000, silent: true });
try {
  const current = fs.existsSync(target) ? Number(fs.readFileSync(target, 'utf8') || '0') : 0;
  await new Promise((resolve) => setTimeout(resolve, 30));
  fs.writeFileSync(target, String(current + 1));
} finally {
  release();
}
`
  const children = Array.from({ length: 8 }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', script, counter], { stdio: ['ignore', 'pipe', 'pipe'] }),
  )
  const codes = await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.on('exit', (code) => resolve(code ?? -1))
        }),
    ),
  )
  assert.deepEqual(codes, Array(8).fill(0), 'every child must finish without a lock error')
  assert.equal(readFileSync(counter, 'utf8'), '8', 'eight read-modify-write cycles, zero lost updates')
})

test('v7.7: a crashed holder is stolen, not waited on forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-stale-'))
  const target = join(dir, 'state.json')
  const lock = `${target}.lock`
  mkdirSync(lock)
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)

  const started = Date.now()
  const release = acquireFileLock(target, { timeoutMs: 5000, staleMs: 1000, silent: true })
  release()
  assert.ok(Date.now() - started < 2000, 'a stale lock must be stolen immediately, not waited out')
})

/**
 * v2.2.0 — A TIMESTAMP IS NOT PROOF OF DEATH.
 *
 * The failure this pins: the stale rule used to be `now - leaseAt > staleMs`, and nothing else.
 * The lease is renewed by a `setInterval`, which is an ordinary JS timer — so a holder whose event
 * loop is blocked (eight concurrent writers, a loaded machine, a suspended laptop) cannot fire it,
 * its lease ages past `staleMs`, and a WAITER steals a lock that is still being held. Two writers
 * then enter the same read-modify-write, which is the exact corruption the lock exists to prevent.
 *
 * The holder's pid is in the owner record and costs one `process.kill(pid, 0)` to check. So the
 * rule is: steal only on EVIDENCE that the holder is gone.
 *
 * Note the age chosen below: `staleMs` (1000) < age (3000) < forced-steal cap (staleMs x 10). Inside
 * that window a live holder must be respected. Past the cap the lock is reclaimed anyway (see the
 * pid-reuse test), because a recycled pid must not wedge the store forever.
 */
test('v2.2.0: a lock whose holder is ALIVE is not stolen, however old its lease looks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-alive-'))
  const target = join(dir, 'state.json')
  const lock = `${target}.lock`

  mkdirSync(lock)
  // A lease that has NOT been renewed for 3s, owned by a pid that is definitely alive: our own.
  // This is the descheduled-holder shape, not the crashed-holder shape.
  writeFileSync(
    join(lock, 'owner'),
    JSON.stringify({ token: 'other-holder', pid: process.pid, at: Date.now() - 3000 }),
    'utf8',
  )

  const started = Date.now()
  assert.throws(
    () => acquireFileLock(target, { timeoutMs: 250, staleMs: 1000, silent: true }),
    /could not acquire/u,
    'the lock must NOT be stolen while its holder is alive — stealing it puts two writers inside',
  )
  assert.ok(Date.now() - started >= 200, 'it must WAIT for the live holder rather than steal')

  // The holder is still there: nothing was removed on our behalf.
  assert.ok(existsSync(lock), 'the live holder\'s lock directory must survive')
  assert.ok(existsSync(join(lock, 'owner')), 'the live holder\'s owner record must survive')
})

/**
 * The OTHER direction, and the reason a bare liveness probe is not enough.
 *
 * A pid can be recycled: the real holder dies, an unrelated process inherits its pid, and the probe
 * then answers "alive" forever. With no cap that lock would never be reclaimed and every later graft
 * would die on `STATE_LOCK_TIMEOUT` — a permanent outage traded for a transient risk. So past
 * `staleMs x LOCK_FORCED_STEAL_MULTIPLE` the lock is reclaimed regardless, and the audit line says
 * so (`lock-stale-forced`), because a forced reclaim must never be silent.
 */
test('v2.2.0: a recycled-pid lock is still reclaimed past the hard cap, and the reclaim is audited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-recycled-'))
  const target = join(dir, 'state.json')
  const lock = `${target}.lock`

  mkdirSync(lock)
  writeFileSync(
    join(lock, 'owner'),
    JSON.stringify({ token: 'recycled', pid: process.pid, at: Date.now() - 30_000 }),
    'utf8',
  )

  const kinds = []
  setAuditSink((entry) => kinds.push(entry.kind))
  try {
    const release = acquireFileLock(target, { timeoutMs: 2000, staleMs: 1000, silent: true })
    release()
  } finally {
    setAuditSink(undefined)
  }

  assert.ok(kinds.includes('lock-stale-forced'), `a forced reclaim must be audited; saw ${kinds.join(',')}`)
})