import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 桌面对宿主不导出 DSH_PROFILE_DIR，环境推断会静默回退到插件目录 —— 所有
 * profile 共享一份状态。config.dataDir 是唯一可靠的隔离手段，必须优先。
 */

test('dataDir: an explicit config directory wins over every fallback', () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-datadir-'))
  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 1 }), persistence: new FakePersistence() })
  // Remove the paths service so only config.dataDir can supply the location.
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'paths' ? undefined : originalGet.call(ctx, name))
  apply(ctx, { dataDir: join(dir, 'explicit') })
  assert.equal(existsSync(join(dir, 'explicit')), true, 'config.dataDir must be created at activation')
})

test('dataDir: two profiles with different dirs never share state', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-graft-dir-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-graft-dir-b-'))

  resetRetiredSessions()
  const a = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), persistence: new FakePersistence() })
  const originalA = a.get
  a.get = (name) => (name === 'paths' ? undefined : originalA.call(a, name))
  apply(a, { dataDir: dirA })
  const logA = makeSourceLog({ turns: 2 })
  await a._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: logA.session.id, newSessionId: 'session-dir-a' }, {})
  assert.equal(existsSync(join(dirA, '.transferred.json')), true)

  resetRetiredSessions()
  const b = makeCtx({ sourceLog: makeSourceLog({ turns: 1 }), persistence: new FakePersistence() })
  const originalB = b.get
  b.get = (name) => (name === 'paths' ? undefined : originalB.call(b, name))
  apply(b, { dataDir: dirB })
  assert.equal(existsSync(join(dirB, '.transferred.json')), false, 'profile B must not inherit A state')
})
