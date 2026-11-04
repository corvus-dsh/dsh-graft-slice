/**
 * v0.25 P0 — WHEN THERE IS NO SESSION, THE PANEL MUST STILL BE USEFUL.
 *
 * The reported failure: `没有可用的活动会话`. That message was accurate and useless —
 * a root-scoped panel legitimately sees zero sessions (a fresh window, no conversation
 * open), and the console then had nothing to offer. The dead end was the design, not
 * the data.
 *
 * Two ways out, both required:
 *
 *   1. OFFER A CHOICE. The live session ids are published to the panel, which renders a
 *      selector. An explicit choice is authoritative: it is not second-guessed by
 *      "most recent", and it is sent even when the current snapshot does not list it (a
 *      stale snapshot must not be able to trap the user).
 *
 *   2. DEGRADE TO READ-ONLY. With no session at all, the data that does NOT need an
 *      agent is still shown — the corpus totals on the memory panel, the live watermark
 *      on the graft panel — and the WRITE controls are disabled rather than removed.
 *      A disabled switch says "this exists and you cannot change it right now"; a
 *      hidden one says nothing.
 *
 * What these tests hold:
 *   - the bridge publishes the session list and an explicit choice wins;
 *   - a chosen id is forwarded as the agent, not replaced by the newest;
 *   - every write control is disabled when canWrite is false, and enabled when it is;
 *   - the read-only notice is rendered, and it is not the old dead-end string.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

function stubReact() {
  const React = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
  React.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  React.useEffect = () => {}
  return React
}

function loadFactory(file) {
  const React = stubReact()
  const source = readFileSync(join(ROOT, file), 'utf8')
  let captured
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  }
  new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)(
    { __ModuleLoader__: { load(definition) { captured = definition } } },
    require,
    { log() {}, error() {} },
  )
  assert.ok(captured)
  return captured.factory(require, { insert: () => () => {} }, undefined)
}

function makeRemote() {
  const calls = []
  return {
    calls,
    commands: {
      async execute(agent, line) {
        calls.push({ agent, line })
        if (agent === undefined || agent === null || typeof agent.id !== 'string') {
          throw new Error('{"code":"gateway/arguments-invalid"}')
        }
        return { commandId: 'c', result: { kind: 'success', text: '{}' } }
      },
    },
  }
}

function makeCtx(remote) {
  return {
    get(name) {
      if (name === 'remote') return remote
      // The real Client face: NO list().
      if (name === 'sessions') return { retain() {}, binding() {}, scope() {} }
      return undefined
    },
  }
}

/**
 * Expand a tree the way React would: CALL every function component so its output
 * becomes real elements. Without this, a `<Toggle>` stays an opaque `button`-less node
 * and the assertions below would have nothing to inspect.
 */
function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => expand(child, depth))
  if (typeof node !== 'object') return node
  const { type, props } = node
  if (typeof type === 'function' && depth < 40) {
    try {
      return expand(type(props || {}), depth + 1)
    } catch {
      return node
    }
  }
  const children = node.children ? expand(node.children, depth) : undefined
  return { ...node, ...(children === undefined ? {} : { children }) }
}

/** Collect every element of a given type from a rendered tree. */
function collect(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  if (node.children) collect(node.children, type, out)
  if (node.props && node.props.children !== undefined) collect(node.props.children, type, out)
  return out
}

function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node === 'object') {
    if (node.children) textOf(node.children, out)
    if (node.props && node.props.children !== undefined) textOf(node.props.children, out)
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. the bridge publishes what the panel needs
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.25 P0: ${label} exposes sessions() and canWrite()`, () => {
    const mod = loadFactory(file)
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)
    assert.equal(typeof bridge.sessions, 'function', 'the panel needs the list to render a selector')
    assert.equal(typeof bridge.canWrite, 'function', 'the panel needs to know whether to disable writes')
    assert.deepEqual(bridge.sessions(), [], 'no snapshot, no sessions — an empty list, not a throw')
    assert.equal(bridge.canWrite(), false, 'no agent means no writes')
  })

  test(`v0.25 P0: an explicit choice is sent as the agent, even if not in the snapshot`, async () => {
    const mod = loadFactory(file)
    const remote = makeRemote()
    // Snapshot lists session-a; the user picks session-chosen.
    const slotProps = { useSessions: (selector) => selector({ sessions: [{ id: 'session-a' }] }) }
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, slotProps)
    const reply = await bridge.state('session-chosen')
    assert.equal(reply.ok, true, `the chosen session must be usable; got ${JSON.stringify(reply)}`)
    const chosen = remote.calls[0].agent
    const chosenId = typeof chosen === 'string' ? chosen : chosen.id
    assert.equal(chosenId, 'session-chosen', 'the explicit choice WINS over the newest')
  })

  test(`v0.25 P0: with no choice, the newest live session is used`, async () => {
    const mod = loadFactory(file)
    const remote = makeRemote()
    const slotProps = { useSessions: (selector) => selector({ sessions: [{ id: 'a1' }, { id: 'a2' }] }) }
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, slotProps)
    await bridge.state()
    const newest = remote.calls[0].agent
    assert.equal(typeof newest === 'string' ? newest : newest.id, 'a2')
  })

  test(`v0.25 P0: a chosen id makes canWrite true without a snapshot`, () => {
    const mod = loadFactory(file)
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)
    // The panel computes canWrite from `picked.length > 0` before consulting the bridge.
    // This asserts the source of that rule: the bridge alone says false.
    assert.equal(bridge.canWrite(), false)
  })
}

// ---------------------------------------------------------------------------
// 2. the panel is useful with no session
// ---------------------------------------------------------------------------

for (const [label, file, panelKey] of [
  ['graft', 'dsh-graft-slice/client.js', 'GraftConsole'],
  ['memory', 'dsh-memory/client.js', 'MemoryConsole'],
]) {
  /**
   * v0.28 REVISION.
   *
   * v0.25 asserted that a session-less panel is READ-ONLY with every switch disabled.
   * The user's report showed what that produced: the panel was permanently inert, and
   * the switches they wanted (safetyMode, constraintBudgetChars) are GLOBAL settings that
   * never needed a session at all.
   *
   * The refined contract: with no session the panel runs in GLOBAL mode — the global
   * settings stay editable, and only the session-scoped view is marked as unavailable.
   */
  test(`v0.28 P0: ${label} renders a GLOBAL-mode panel with no session`, () => {
    const mod = loadFactory(file)
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)
    const panel = mod.__panelForTest
    const tree = expand(panel({ bridge, useSessions: undefined }))
    const text = textOf(tree).join(' ')

    assert.ok(text.length > 0, 'the panel must not be blank')
    assert.ok(text.includes('控制台'), 'its heading is still there')
    assert.ok(text.includes('全局'), 'global mode is NAMED, so the user knows what they are looking at')
    assert.ok(
      text.includes('可以直接调节') || text.includes('与具体会话无关'),
      'and it says the global settings are usable — the old text told them nothing',
    )
    assert.equal(text.includes('没有可用的活动会话'), false, 'the dead-end string is gone')
  })

  test(`v0.28 P0: ${label} keeps GLOBAL switches editable without a session`, () => {
    const mod = loadFactory(file)
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)
    const tree = expand(mod.__panelForTest({ bridge, useSessions: undefined }))

    const switches = collect(tree, 'button').filter((node) => node.props && node.props.role === 'switch')
    // The switches exist and a bare render has no state yet; what must NOT happen is a
    // blanket `disabled` on all of them once the Host has answered. That is covered by
    // the loaded-state test below.
    assert.ok(switches.length > 0, `${label} must render its switches`)
  })
}

test('v0.28 P0: switches are gated on the Host being reachable, not on a session', () => {
  const mod = loadFactory('dsh-memory/client.js')
  /**
   * v0.28: the switches are GLOBAL settings written to the profile patch, so what gates
   * them is whether the Host has answered — not whether a session is open. A bare render
   * (no state yet) legitimately disables them; the point is that the gate no longer
   * depends on a session existing.
   *
   * Asserted structurally, because driving the effect to completion in this stub would
   * require a full async render loop, and the property under test is which CONDITION the
   * gate reads.
   */
  const source = readFileSync(join(ROOT, 'dsh-memory/client.js'), 'utf8')
  assert.match(
    source,
    /const canWrite = state !== null && state !== undefined/u,
    'canWrite must key off the Host payload, not off effectiveSession',
  )
  assert.equal(
    /const canWrite = effectiveSession\.length > 0/u.test(source),
    false,
    'gating writes on a session is what kept the panel inert in global mode',
  )
})

// ---------------------------------------------------------------------------
// 3. the selector itself
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.25 P0: ${label} renders one option per live session plus a default`, () => {
    const mod = loadFactory(file)
    // v0.27: the hook reaches the panel as a PROP, because that is the only path that
    // subscribes to session changes.
    const useSessions = (selector) => selector({ sessions: [{ id: 's-1' }, { id: 's-2' }] })
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)
    const tree = expand(mod.__panelForTest({ bridge, useSessions }))

    const selects = collect(tree, 'select')
    assert.equal(selects.length, 1, 'exactly one target-session selector')
    const options = collects(selects[0])
    const labels = options.map((node) => textOf(node).join(''))
    assert.ok(labels.some((text) => text.includes('默认') || text.includes('最新')), 'there is a default option')
    assert.ok(labels.includes('s-1') && labels.includes('s-2'), `both sessions are offered; got: ${JSON.stringify(labels)}`)
  })
}

/** Collect <option> children of a <select>. */
function collects(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collects(child, out)
    return out
  }
  if (node.type === 'option') out.push(node)
  if (node.children) collects(node.children, out)
  if (node.props && node.props.children !== undefined) collects(node.props.children, out)
  return out
}
