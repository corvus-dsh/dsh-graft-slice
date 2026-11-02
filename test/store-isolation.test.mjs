import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getRetiredSessions, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * The retirement store decides which sessions a pre-step gate refuses. Two
 * profiles sharing one file means a test retirement in a lab profile can
 * silently block a real session in the desktop profile, so isolation is a
 * correctness requirement, not a tidiness preference.
 */

function setupWithPaths(paths, config = {}) {
  resetRetiredSessions()
  const sourceLog = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths })
  apply(ctx, config)
  return { ctx, sourceLog }
}

test('store: profile A retirement does not leak into profile B', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-graft-iso-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-graft-iso-b-'))

  const a = setupWithPaths({ data: dirA })
  await a.ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: a.sourceLog.session.id, newSessionId: 'session-a-target' }, {})
  assert.equal(existsSync(join(dirA, '.retired.json')), true)

  const retiredInA = JSON.parse(readFileSync(join(dirA, '.retired.json'), 'utf8'))
  assert.equal(retiredInA.includes(a.sourceLog.session.id), true)

  resetRetiredSessions()
  setupWithPaths({ data: dirB })
  assert.equal(getRetiredSessions().size, 0, 'profile B must start with an empty retirement set')
  assert.equal(existsSync(join(dirB, '.retired.json')), false, 'profile B must not inherit profile A file')
})

test('store: transfers are recorded per profile directory', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-graft-tr-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-graft-tr-b-'))

  const a = setupWithPaths({ data: dirA })
  const report = await a.ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: a.sourceLog.session.id, newSessionId: 'session-a-tr' }, {})
  alsoAssertTarget(report)

  const transferred = JSON.parse(readFileSync(join(dirA, '.transferred.json'), 'utf8'))
  assert.equal(transferred[a.sourceLog.session.id].newSessionId, 'session-a-tr')
  assert.equal(existsSync(join(dirB, '.transferred.json')), false)
})

function alsoAssertTarget(report) {
  assert.equal(report.ok, true)
}

test('store: a corrupt store file never blocks activation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-corrupt-'))
  writeFileSync(join(dir, '.retired.json'), '{not json', 'utf8')
  writeFileSync(join(dir, '.transferred.json'), 'also not json', 'utf8')
  const { ctx } = setupWithPaths({ data: dir })
  assert.equal(typeof ctx._tools.get('graft_slice_and_inject')?.execute, 'function')
})

test('store: DSH_PROFILE_DIR fallback isolates when no paths service is mounted', () => {
  const previousProfileDir = process.env.DSH_PROFILE_DIR
  const previousHome = process.env.DSH_HOME
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-graft-profiledir-'))
  process.env.DSH_PROFILE_DIR = profileDir
  delete process.env.DSH_HOME
  try {
    resetRetiredSessions()
    const sourceLog = makeSourceLog({ turns: 1 })
    const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: undefined })
    // Drop the paths lookup so the fallback chain is exercised.
    const originalGet = ctx.get
    ctx.get = (name) => (name === 'paths' ? undefined : originalGet.call(ctx, name))
    apply(ctx, {})
    assert.equal(
      existsSync(join(profileDir, 'data', 'dsh-graft-slice')),
      true,
      'a per-profile data directory must be created even when paths is absent',
    )
  } finally {
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfileDir
    if (previousHome !== undefined) process.env.DSH_HOME = previousHome
  }
})
