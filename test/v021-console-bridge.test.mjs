/**
 * v0.21 — the console's Client→Host bridge.
 *
 * THE LIVE FAILURE THIS REPLACES
 *
 * After the v0.20 restart the panels rendered `cannot get property "remote.commands"
 * without inject` and nothing was clickable. The cause is not a typo: on the Client
 * side `remote` is a GENERATED namespace that exists only after the api-remotes
 * package is declared in `dsh.client.inject`, and the property read is guarded. The
 * panel treated it as a plain service.
 *
 * Two fixes, and this file holds both:
 *   1. `dsh.client.inject` declares `@deepseek-ai/dsh-api-remotes` (plus the slot
 *      owner), so the namespace exists when it is used;
 *   2. the bridge tries `host.call(...)` — the package-private RPC builtin, which
 *      needs no declaration — FIRST, and every method resolves to a RESULT rather
 *      than throwing, so one dead channel cannot blank the whole panel.
 *
 * The bridge is exercised here by evaluating the real source, not a copy: a fixture
 * that reimplements the bridge would keep passing after the plugin regressed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// This file lives in <workspace>/dsh-graft-slice/test, and the assertions span BOTH
// repositories (the two consoles share one bridge contract), so the baseline is the
// workspace root, two levels up.
const ROOT = join(import.meta.dirname, '..', '..')

/** Pull the `makeBridge` factory out of a real client bundle and instantiate it. */
function loadBridge(file) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const start = source.indexOf('    function makeBridge(')
  assert.ok(start >= 0, `${file} must define makeBridge`)
  // Cut at the matching closing brace of the function by brace counting.
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

test('v0.21: both bundles declare the api-remotes client dependency', () => {
  for (const dir of ['dsh-graft-slice', 'dsh-memory']) {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
    const inject = pkg.dsh?.client?.inject
    assert.ok(Array.isArray(inject), `${dir}: dsh.client.inject must be an array`)
    assert.ok(
      inject.includes('@deepseek-ai/dsh-api-remotes'),
      `${dir}: api-remotes must be declared or ctx.remote is guarded away`,
    )
    // `immediately` is what loads the bundle without a dependent plugin, which is
    // why the panellist entry appears at all.
    assert.equal(pkg.dsh.client.immediately, true, `${dir}: the console must load on its own`)
  }
})

test('v0.21: the bridge prefers host.call and never throws when every channel dies', async () => {
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const { factory } = loadBridge(file)

    // (a) A dead everything: the guarded `ctx.get` THROWS exactly what the page threw.
    const hostile = {
      get() {
        throw new Error(CHANNEL_ERROR)
      },
    }
    const deadBridge = factory(hostile, undefined)
    const method = file.startsWith('dsh-graft') ? 'state' : 'state'
    const result = await deadBridge[method]()
    assert.equal(result.ok, false, `${file}: a dead bridge reports failure`)
    assert.equal(result.via, 'none')
    assert.match(String(result.text), /面板无法调用宿主/u, `${file}: it says so in the panel`)
    // The whole point: this is a value, not an exception. A throw blanks the slot.
    assert.equal(typeof result.text, 'string')

    // (b) host.call works: no declaration needed, so this is the primary channel.
    const calls = []
    const host = {
      async call(method, args) {
        calls.push([method, args])
        return JSON.stringify({ ok: true })
      },
    }
    const live = factory(hostile, host)
    const liveResult = await live[method]()
    assert.equal(liveResult.ok, true, `${file}: host.call is enough on its own`)
    assert.match(liveResult.via, /host\.call/u)
    assert.equal(calls.length, 1)
  }
})

test('v0.21: host.call is tried BEFORE the generated namespace', async () => {
  const { factory } = loadBridge('dsh-graft-slice/client.js')
  const order = []
  const ctx = {
    get(name) {
      order.push(`get:${name}`)
      return {
        commands: {
          async execute() {
            order.push('remote.commands.execute')
            return { result: { kind: 'success', text: '{}' } }
          },
        },
      }
    },
  }
  const host = {
    async call() {
      order.push('host.call')
      return '{}'
    },
  }
  const bridge = factory(ctx, host)
  await bridge.state()
  assert.deepEqual(order, ['host.call'], 'the declaration-free channel wins, and the namespace is untouched')
})

test('v0.21: the generated namespace still works as the fallback', async () => {
  const { factory } = loadBridge('dsh-graft-slice/client.js')
  const ctx = {
    get() {
      return {
        commands: {
          async execute(method) {
            return { result: { kind: 'success', text: JSON.stringify({ method }) } }
          },
        },
      }
    },
  }
  const bridge = factory(ctx, undefined)
  const result = await bridge.state()
  assert.equal(result.ok, true)
  assert.equal(result.via, 'remote.commands.execute')
  assert.deepEqual(JSON.parse(result.text), { method: 'graft-console' })
})

test('v0.21: a set() passes the knob as structured args, not a shell line', async () => {
  const { factory } = loadBridge('dsh-graft-slice/client.js')
  const seen = []
  const bridge = factory({ get: () => undefined }, {
    async call(method, args) {
      seen.push([method, args])
      return '已保存'
    },
  })
  await bridge.set('autoGraft', false)
  assert.deepEqual(seen, [['graft-console-set', { rawInput: 'autoGraft false' }]])
})
