/**
 * v0.16 console: the Host half that lets the Web panel change configuration
 * WITHOUT hand-editing cordis.patch.yml and WITHOUT a restart.
 *
 * Two properties are worth pinning down here, because both are easy to get
 * subtly wrong:
 *   - the write must go through the profile's OWN row (`configEditor.edit`), and
 *     must spread the current override (a matching override replaces the whole
 *     config, so losing the unmanaged keys would be silent data loss);
 *   - an invalid value must be REFUSED with a reason, never clamped: a ratio of
 *     0 migrates on every request, and a ratio above 1 never migrates at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, parseConsoleSetting, withConsoleSetting } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A `commands` registry plus a `configEditor` that records what it persisted. */
function makeConsoleServices(entry = { patchId: 'dsh-graft-slice', id: 'dsh-graft-slice' }) {
  const registered = new Map()
  const edits = []
  const commands = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const configEditor = {
    entries: () => [entry],
    configuration: () => [],
    async edit(target, change) {
      edits.push({ target, next: change({ autoGraft: true, modelDrivenGraftAtRatio: 0.7 }) })
    },
  }
  return { commands, configEditor, registered, edits }
}

test('v0.16: a console setting is parsed strictly, and a bad value is refused with a reason', () => {
  assert.deepEqual(parseConsoleSetting('autoGraft false').setting, { key: 'autoGraft', value: false })
  assert.deepEqual(parseConsoleSetting('modelDrivenGraft true').setting, { key: 'modelDrivenGraft', value: true })
  assert.deepEqual(parseConsoleSetting('autoGraftAtRatio 0.701').setting, { key: 'autoGraftAtRatio', value: 0.7 })
  assert.deepEqual(parseConsoleSetting('commandGuard  TRUE ').setting, { key: 'commandGuard', value: true })

  assert.match(String(parseConsoleSetting('autoGraft').error), /需要两个参数/u)
  assert.match(String(parseConsoleSetting('autoGraft yes').error), /只接受 true \/ false/u)
  assert.match(String(parseConsoleSetting('nope true').error), /未知的配置键/u)
  // Both ends of the ratio are refused: 0 migrates on every request, 1 never does.
  assert.match(String(parseConsoleSetting('modelDrivenGraftAtRatio 0').error), /0 与 1 之间/u)
  assert.match(String(parseConsoleSetting('modelDrivenGraftAtRatio 1.2').error), /0 与 1 之间/u)
  assert.match(String(parseConsoleSetting('modelDrivenGraftAtRatio abc').error), /0 与 1 之间/u)
})

test('v0.16: the config patch keeps every key the console does not manage', () => {
  const current = { autoGraft: true, maxTotalChars: 24000, memoryDir: 'C:/x' }
  const next = withConsoleSetting(current, { key: 'autoGraftAtRatio', value: 0.8 })
  assert.deepEqual(next, { autoGraft: true, maxTotalChars: 24000, memoryDir: 'C:/x', autoGraftAtRatio: 0.8 })
  assert.notEqual(next, current, 'a new object, so the Loader sees a change')
})

test('v0.16: the console commands are registered at activation and drive configEditor', async () => {
  const log = makeSourceLog({ turns: 3, sourceSessionId: 'session-console-source' })
  const ctx = makeCtx({ sourceLog: log })
  const services = makeConsoleServices()
  ctx.commands = services.commands
  ctx.configEditor = services.configEditor
  apply(ctx, {})

  assert.ok(services.registered.has('graft-console'), 'the read command is registered')
  assert.ok(services.registered.has('graft-console-set'), 'the write command is registered')

  const state = await services.registered.get('graft-console').handler({})
  assert.equal(state.kind, 'success')
  const parsed = JSON.parse(state.text)
  assert.equal(parsed.config.modelDrivenGraftAtRatio, 0.7)
  assert.equal(parsed.config.autoGraftAtRatio, 0.75)
  assert.ok(Array.isArray(parsed.rows), 'the status rows are a list, even when no session has a watermark')

  const written = await services.registered.get('graft-console-set').handler({ rawInput: 'autoGraftAtRatio 0.8' })
  assert.equal(written.kind, 'success')
  assert.match(written.text, /已保存 autoGraftAtRatio=0.8/u)
  assert.match(written.text, /无需重启/u)
  assert.equal(services.edits.length, 1)
  assert.equal(services.edits[0].target.patchId, 'dsh-graft-slice', 'the write targets OUR row, not a new one')
  assert.deepEqual(services.edits[0].next, { autoGraft: true, modelDrivenGraftAtRatio: 0.7, autoGraftAtRatio: 0.8 })

  const refused = await services.registered.get('graft-console-set').handler({ rawInput: 'autoGraftAtRatio 3' })
  assert.equal(refused.kind, 'error', 'an out-of-range ratio is an ERROR result, not a silent clamp')
  assert.equal(services.edits.length, 1, 'and nothing was persisted')
})

test('v0.16: without configEditor the console says so instead of pretending to save', async () => {
  const log = makeSourceLog({ turns: 3, sourceSessionId: 'session-console-source-2' })
  const ctx = makeCtx({ sourceLog: log })
  const services = makeConsoleServices()
  ctx.commands = services.commands
  // No ctx.configEditor: the service is optional in a profile that never mounted it.
  apply(ctx, {})
  const result = await services.registered.get('graft-console-set').handler({ rawInput: 'autoGraft false' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /configEditor 服务不可用/u)
  assert.match(result.text, /cordis\.patch\.yml/u, 'the failure names the fallback the user still has')
})

test('v0.16: a profile row that cannot be found is reported, not guessed around', async () => {
  const log = makeSourceLog({ turns: 3, sourceSessionId: 'session-console-source-3' })
  const ctx = makeCtx({ sourceLog: log })
  const services = makeConsoleServices({ patchId: 'some-other-plugin', id: 'some-other-plugin' })
  ctx.commands = services.commands
  ctx.configEditor = services.configEditor
  apply(ctx, {})
  const result = await services.registered.get('graft-console-set').handler({ rawInput: 'autoGraft false' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /找不到 dsh-graft-slice 的配置行/u)
  assert.equal(services.edits.length, 0)
})

test('v0.16: commandGuard:false also disarms the console registration path safely', async () => {
  const log = makeSourceLog({ turns: 3, sourceSessionId: 'session-console-source-4' })
  const ctx = makeCtx({ sourceLog: log })
  const services = makeConsoleServices()
  ctx.commands = services.commands
  ctx.configEditor = services.configEditor
  apply(ctx, { commandGuard: false })
  // The console is independent of the command GUARD (different "command"): the
  // guard denies agent tool calls, the console registers user commands.
  assert.ok(services.registered.has('graft-console'))
})
