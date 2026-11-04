/**
 * v0.22 — the console's Client→Host bridge, CORRECTED against the live contracts.
 *
 * WHAT WAS WRONG IN v0.21 (and why the page still failed after "the fix")
 *
 *  1. `dsh.client.inject` declares PACKAGES for bundle-load order. It grants no
 *     service access. The Cordis property guard reads the plugin's own `inject`
 *     array, and the official client plugins declare SERVICE keys:
 *         inject: ["inputTriggers", "sessions", "remote", "remote.commands", "locale"]
 *     Declaring only `['slots']` is what produced
 *         cannot get property "remote.commands" without inject
 *     twice in a row, even though the package declaration looked right.
 *
 *  2. `remote.commands.execute` is `(agent, line, attachments, signal)` — an AGENT
 *     first, then a complete `/name args` line. The v0.21 call passed
 *     `(method, args, ...)`, which cannot work whatever the guard says.
 *
 *  3. `host.call(...)` is a DYNAMIC-package builtin (the sandbox passes `host` as a
 *     factory parameter). An installed client module's factory receives `require`
 *     alone, so `host` is normally `undefined` and cannot be the primary channel.
 *
 * What this file holds:
 *   - the service keys are declared;
 *   - the bridge calls `remote.commands.execute(agent, '/line', [], signal)`;
 *   - a dead bridge returns a RESULT and never throws (a throw blanks the slot);
 *   - the dynamic `host.call` path still works when a sandbox does provide it;
 *   - the sidebar cell draws the ICON ONLY, because the owner renders the label and
 *     drawing both produced "转生 转生".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// This file lives in <workspace>/dsh-graft-slice/test and the assertions span BOTH
// repositories, so the baseline is the workspace root.
const ROOT = join(import.meta.dirname, '..', '..')

function loadBridge(file) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const start = source.indexOf('    function makeBridge(')
  assert.ok(start >= 0, `${file} must define makeBridge`)
  let depth = 0
  let end = -1
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  assert.ok(end > start, `${file}: could not find the end of makeBridge`)
  const body = source.slice(start, end)
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${body}; return makeBridge;`)()
  return { factory, source }
}

const CHANNEL_ERROR = 'cannot get property "remote.commands" without inject'

test('v0.22: both bundles declare the SERVICE keys, not just the package', () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    // The PLUGIN declaration is the one on the returned object, marked by its
    // following `apply(ctx)`. A bare /inject:/ search also matches the slot
    // registration's `inject: () => ({ bridge })`, which declares no services at all.
    const match = /inject:\s*\[([^\]]*)\],\s*\n\s*apply\(/u.exec(source)
    assert.ok(match, `${file}: no plugin-level inject declaration before apply(ctx)`)
    const keys = match[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean)
    assert.ok(keys.includes('slots'), `${file}: slots is required for the panel`)
    // The guard reads THESE, and it is the guard that threw the page error.
    assert.ok(keys.includes('remote'), `${file}: 'remote' must be declared`)
    assert.ok(keys.includes('remote.commands'), `${file}: 'remote.commands' must be declared`)
  }
})

test('v0.22: the bridge calls execute(agent, "/line", attachments, signal)', async () => {
  const { factory } = loadBridge('dsh-graft-slice/client.js')
  const seen = []
  const agent = { id: 'agent-1' }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { list: () => [agent] }
      if (name === 'remote') {
        return {
          commands: {
            async execute(...args) {
              seen.push(args)
              return { result: { kind: 'success', text: '{"ok":true}' } }
            },
          },
        }
      }
      return undefined
    },
  }
  const bridge = factory(ctx, undefined)
  const result = await bridge.state()
  assert.equal(result.ok, true)
  // v1.0.2: `via` names the PROBED shape that worked, so an operator can tell a working
  // contract from a lucky guess.
  assert.match(result.via, /^remote\.commands\.execute\(agent-object\)$/u)
  assert.equal(seen.length, 1)
  const [callAgent, line, attachments, signal] = seen[0]
  assert.deepEqual(callAgent, agent, 'the first argument is the receiving AGENT')
  assert.equal(line, '/graft-console', 'the second is a complete slash-command line')
  assert.deepEqual(attachments, [])
  assert.equal(signal, undefined)
})

test('v0.22: a knob write is a complete command line, not a structured payload', async () => {
  const { factory } = loadBridge('dsh-graft-slice/client.js')
  const lines = []
  const ctx = {
    get(name) {
      if (name === 'sessions') return { list: () => [{ id: 'a' }] }
      if (name === 'remote') {
        return {
          commands: {
            async execute(_agent, line) {
              lines.push(line)
              return { result: { kind: 'success', text: '已保存' } }
            },
          },
        }
      }
      return undefined
    },
  }
  const bridge = factory(ctx, undefined)
  await bridge.set('autoGraft', false)
  assert.deepEqual(lines, ['/graft-console-set autoGraft false'])
})

test('v0.22: a dead bridge returns a result and never throws', async () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const { factory } = loadBridge(file)
    // The guarded `ctx.get` throws exactly what the page threw.
    const hostile = {
      get() {
        throw new Error(CHANNEL_ERROR)
      },
    }
    const result = await factory(hostile, undefined).state()
    assert.equal(result.ok, false, `${file}: a dead bridge reports failure`)
    assert.equal(result.via, 'none')
    assert.match(String(result.text), /面板无法调用宿主/u)
    assert.equal(typeof result.text, 'string', 'a value, not an exception: a throw blanks the slot')
  }
})

test('v0.22: the dynamic-package host.call path still works when a sandbox provides it', async () => {
  const { factory } = loadBridge('dsh-graft-slice/client.js')
  const calls = []
  const host = {
    async call(method, args) {
      calls.push([method, args])
      return '{"ok":true}'
    },
  }
  // No `remote` at all: only the dynamic channel exists.
  const ctx = { get: () => undefined }
  const result = await factory(ctx, host).state()
  assert.equal(result.ok, true)
  assert.match(result.via, /host\.call/u)
  assert.equal(calls[0][0], 'commands.execute')
})

test('v0.22: the sidebar cell draws an ICON only — the owner renders the label', () => {
  for (const [file, label] of [
    ['dsh-graft-slice/client.js', '转生'],
    ['dsh-memory/client.js', '记忆'],
  ]) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const start = source.indexOf('function SidebarEntry()')
    assert.ok(start >= 0, `${file}: SidebarEntry missing`)
    const end = source.indexOf('\n    }', start)
    const body = source.slice(start, end)
    // The registration already supplies `label`, and the owner projects it. Drawing
    // the text here as well is what produced "转生 转生" / "记忆 记忆".
    assert.equal(
      body.includes(`'${label}'`),
      false,
      `${file}: the cell must not draw '${label}'; the panellist label already does`,
    )
    assert.ok(body.includes('<svg') || body.includes("h('svg'"), `${file}: the icon is still there`)
  }
})

/**
 * v1.0.1 P0 — THE SHAPE THE MOCKS ABOVE GOT WRONG.
 *
 * Every test in this file used to answer `{ result: { kind, text } }`. The Host answers
 * a bare CommandExecution `{ kind, text }`, and the bridge's fallback turned that
 * envelope into panel state: toggles OFF and un-flippable, "当前推导：读取失败",
 * 记忆库 "0 条", 工作区 "(未知)" — while writes really persisted (the toast was honest,
 * the read-back was not). These two cases pin the real shape and the honest failure.
 */
test('v1.0.1: the bare CommandExecution envelope is unwrapped into panel state', async () => {
  const state = '{"config":{"modelDrivenGraft":true},"thresholds":{"hardAt":0.75,"warnAt":0.7}}'
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const { factory } = loadBridge(file)
    const ctx = {
      get(name) {
        if (name === 'sessions') return { list: () => [{ id: 'a' }] }
        if (name === 'remote') {
          return {
            commands: {
              // The REAL shape: no `.result` wrapper.
              async execute() {
                return { kind: 'success', text: state }
              },
            },
          }
        }
        return undefined
      },
    }
    const result = await factory(ctx, undefined).state()
    assert.equal(result.ok, true, `${file}: a successful execution is ok`)
    assert.equal(result.text, state, `${file}: the COMMAND text is the panel payload, not the envelope`)
    assert.equal(JSON.parse(result.text).config.modelDrivenGraft, true, `${file}: the renderer can read config`)
  }
})

test('v1.0.1: an unrecognised reply shape is an error, never panel state', async () => {
  const { factory } = loadBridge('dsh-graft-slice/client.js')
  const ctx = {
    get(name) {
      if (name === 'sessions') return { list: () => [{ id: 'a' }] }
      if (name === 'remote') return { commands: { async execute() { return { unexpected: true } } } }
      return undefined
    },
  }
  const result = await factory(ctx, undefined).state()
  assert.equal(result.ok, false, 'guessing a state from an unknown shape is how the panel lied before')
  assert.match(String(result.text), /无法识别的返回形状/u)
})
