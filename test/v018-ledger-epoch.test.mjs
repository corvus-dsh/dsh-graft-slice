/**
 * v0.18 (shared defence) — the ledger EPOCH.
 *
 * `.retired.json` and `.transferred.json` are the ONE file contract between the two
 * plugins, and the two are released separately. A reader that half-understands a
 * record is worse than a reader that refuses it: dsh-memory would attribute a skill
 * to a handoff it only partly saw.
 *
 * What is asserted here:
 *   1. this plugin WRITES an epoch envelope;
 *   2. it READS a legacy bare payload (epoch 1) and upgrades it in place on the next
 *      write — a migration, not a flag day;
 *   3. a future epoch and a torn envelope are REFUSED, not guessed at;
 *   4. a refused ledger does not resurrect a retired source.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  getRetiredSessions,
  LEDGER_EPOCH,
  readLedger,
  readLedgerEpoch,
  readLedgerPayload,
  resetRetiredSessions,
} from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

function stateDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-graft-epoch-'))
}

function activate(data) {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log, paths: { data } })
  // v0.21: mount a working ignition channel.
  //
  // Without one, a migration now ROLLS BACK (the source is un-retired) — which is the
  // correct v0.21 behaviour and the wrong thing to test here: these cases are about
  // the LEDGER's epoch handling, so the migration they observe must be one that
  // actually sticks.
  ctx.sessionController = { async prompt() { return { accepted: true } } }
  apply(ctx, { dataDir: data })
  return { ctx, log }
}

test('v0.18: a retirement is written as an epoch envelope', async () => {
  const dir = stateDir()
  const { ctx, log } = activate(dir)
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-epoch-target' }, {})

  const raw = JSON.parse(readFileSync(join(dir, '.retired.json'), 'utf8'))
  assert.equal(raw.epoch, LEDGER_EPOCH)
  assert.equal(typeof raw.at, 'string')
  assert.equal(Array.isArray(raw.payload), true)
  assert.equal(raw.payload.includes(log.session.id), true)

  assert.equal(readLedgerEpoch(join(dir, '.retired.json')), LEDGER_EPOCH)
  assert.deepEqual(readLedgerPayload(join(dir, '.retired.json')), raw.payload)

  const transfers = readLedger(join(dir, '.transferred.json'))
  assert.equal(transfers.epoch, LEDGER_EPOCH)
  assert.equal(transfers.payload[log.session.id].newSessionId, 'session-epoch-target')
})

test('v0.18: a legacy bare ledger is still read, and is upgraded on the next write', () => {
  const dir = stateDir()
  // What v0.17 wrote: a bare array, no envelope at all.
  writeFileSync(join(dir, '.retired.json'), JSON.stringify(['legacy-session']), 'utf8')
  writeFileSync(
    join(dir, '.transferred.json'),
    JSON.stringify({ 'legacy-session': { newSessionId: 'legacy-target', at: 1, reason: 'r' } }),
    'utf8',
  )
  assert.equal(readLedgerEpoch(join(dir, '.retired.json')), 1, 'a bare payload is epoch 1')

  const { ctx, log } = activate(dir)
  assert.equal(getRetiredSessions().has('legacy-session'), true, 'the legacy entry still retires its source')
  assert.equal(ctx === undefined, false)

  // The next write of ANY retirement upgrades the file in place, keeping the entry.
  ctx._tools.get('graft_resume_session') // sanity: the tool exists
  return ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-epoch-upgrade' }, {})
    .then(() => {
      const upgraded = readLedger(join(dir, '.retired.json'))
      assert.equal(upgraded.epoch, LEDGER_EPOCH)
      assert.equal(upgraded.payload.includes('legacy-session'), true, 'the upgrade keeps legacy entries')
      assert.equal(upgraded.payload.includes(log.session.id), true)
    })
})

test('v0.18: a future epoch is refused instead of half-understood', () => {
  const dir = stateDir()
  writeFileSync(
    join(dir, '.retired.json'),
    JSON.stringify({ epoch: LEDGER_EPOCH + 1, at: 'later', pid: 1, payload: ['future-session'] }),
    'utf8',
  )
  writeFileSync(
    join(dir, '.transferred.json'),
    JSON.stringify({ epoch: LEDGER_EPOCH + 1, at: 'later', pid: 1, payload: { 'future-session': { newSessionId: 'x' } } }),
    'utf8',
  )
  const retired = readLedger(join(dir, '.retired.json'))
  assert.equal(retired.epoch, LEDGER_EPOCH + 1)
  assert.equal(retired.defect, 'future-epoch')
  assert.equal(retired.payload, undefined, 'a newer writer is not interpreted by an older reader')

  activate(dir)
  assert.equal(getRetiredSessions().has('future-session'), false, 'a refused ledger contributes no retirements')
})

test('v0.18: a torn envelope is refused, and a later complete one is obeyed', async () => {
  const dir = stateDir()
  // An envelope with no payload: exactly "we read half a record".
  writeFileSync(join(dir, '.retired.json'), JSON.stringify({ epoch: LEDGER_EPOCH, at: 'now', pid: 1 }), 'utf8')
  assert.equal(readLedger(join(dir, '.retired.json')).defect, 'torn')
  assert.equal(readLedgerPayload(join(dir, '.retired.json')), undefined)

  const { ctx, log } = activate(dir)
  assert.equal(getRetiredSessions().size, 0, 'a torn ledger retires nobody this round')

  // The retry: a complete write lands, and the NEXT activation honours it.
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-epoch-complete' }, {})
  resetRetiredSessions()
  const again = makeCtx({ sourceLog: log, paths: { data: dir } })
  apply(again, { dataDir: dir })
  assert.equal(getRetiredSessions().has(log.session.id), true, 'the complete write is obeyed on the retry')

  const decision = await dispatchPreStep(again, { agent: { id: log.session.id }, messages: [] })
  assert.equal(decision.kind, 'reject')
  resetRetiredSessions()
})
