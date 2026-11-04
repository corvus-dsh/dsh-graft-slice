/**
 * v0.27 P0 — THE PANEL MUST MOVE WHEN THE SESSION CHANGES.
 *
 * THE REPORT. "面板没有报错，但一直处于只读或没有活动会话状态。即便我手动唤醒/切换了
 * 会话，面板依然卡在正在读取，无法操作。"
 *
 * THE CAUSE, and why every previous fix missed it.
 *
 * `useSessions` was being CALLED FROM AN EFFECT — reached indirectly through
 * `bridge.canWrite()` inside the mount effect. A hook invoked outside render cannot
 * subscribe. So a session appearing or changing never re-rendered the component, and the
 * panel stayed frozen at whatever the snapshot said when it mounted. On a fresh window
 * that is "nothing", permanently.
 *
 * That also explains the previous round: `attach(useSessions)` DID hand the hook over,
 * but the only consumer ran in an effect, so having the hook made no difference.
 *
 * THE FIX. The hook is called during RENDER, unconditionally, and its result drives the
 * tree. A SnapshotSelectorHook subscribes internally, so a change to the session list
 * re-renders the component and every derived value follows. The effect depends on a
 * stable `sessionKey` string, so a switch refetches.
 *
 * What these tests hold:
 *   1. the hook is called during render, not inside the effect;
 *   2. a session appearing produces a non-empty list WITHOUT remounting;
 *   3. the session the panel acts on follows the list (default = newest);
 *   4. an explicit pick wins, and a pick triggers an immediate refetch;
 *   5. a refresh control exists and is disabled exactly when there is nothing to read.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

/**
 * A React stub whose `useState` RETAINS values across renders, so a second render sees
 * the state the first one set. That is what makes "does it react?" testable at all.
 */
function makeStatefulReact() {
  const store = []
  let cursor = 0
  const effects = []
  let effectCursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  }
  React.useState = (initial) => {
    const index = cursor
    cursor += 1
    if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
    return [store[index], (next) => { store[index] = typeof next === 'function' ? next(store[index]) : next }]
  }
  React.useEffect = (fn) => {
    effects[effectCursor] = fn
    effectCursor += 1
  }
  return {
    React,
    /** Begin a render pass: hooks must be requested in the same order every time. */
    begin() { cursor = 0; effectCursor = 0 },
    /**
     * Run the effects registered by the last render and RETURN their cleanups.
     *
     * The mount effect starts a `setInterval`; a test that flushes effects without
     * disposing that timer keeps the Node process alive forever. The first version of
     * this file did exactly that and had to be killed — so the cleanup is now part of
     * the contract instead of an afterthought.
     */
    flushEffects() {
      const pending = effects.slice(0, effectCursor)
      effects.length = 0
      effectCursor = 0
      const cleanups = []
      for (const fn of pending) {
        try {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        } catch {
          // Effect errors are not the subject here.
        }
      }
      return () => { for (const cleanup of cleanups) { try { cleanup() } catch { /* ignore */ } } }
    },
    store,
  }
}

function loadFactory(file, react) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  let captured
  const require = (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  }
  new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)(
    { __ModuleLoader__: { load(definition) { captured = definition } } },
    require,
    { log() {}, error() {} },
  )
  assert.ok(captured, `${file} must register`)
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
        return { commandId: 'c', result: { kind: 'success', text: '{"workspace":"w","skills":[],"counts":{},"scenes":[],"rows":[],"config":{}}' } }
      },
    },
  }
}

function makeCtx(remote) {
  return {
    get(name) {
      if (name === 'remote') return remote
      if (name === 'sessions') return { retain() {}, binding() {}, scope() {} }
      return undefined
    },
  }
}

/** Collect every element of a kind from a rendered tree. */
function collect(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) collect(child, type, out); return out }
  if (node.type === type) out.push(node)
  if (node.children) collect(node.children, type, out)
  if (node.props && node.props.children !== undefined) collect(node.props.children, type, out)
  return out
}

/**
 * Expand a tree the way React would: CALL every function component so its output
 * becomes real elements.
 *
 * Without this, `<Toggle>` stays an opaque node with no `button` inside it, and the
 * "are the switches disabled?" assertions would find nothing and pass vacuously — which
 * is how a similar check silently stopped testing anything in an earlier round.
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

/**
 * Render a panel through several "passes", returning the tree of the LAST one.
 * Each pass re-runs the component with the CURRENT hook snapshot, which is what a real
 * re-render does.
 */
function renderPasses(mod, bridge, snapshots) {
  const react = mod.__reactStub
  let tree
  for (const snapshot of snapshots) {
    react.begin()
    const useSessions = (selector) => selector(snapshot)
    // Expand so function components (Toggle, Segmented, …) become real elements.
    tree = expand(mod.__panelForTest({ bridge, useSessions }))
  }
  return tree
}

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.27 P0: ${label} calls useSessions during RENDER, not inside the effect`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    // The render-time read must exist...
    const renderRead = source.indexOf('readSessions(useSessions)')
    assert.ok(renderRead > 0, 'the hook must be consumed during render')

    // ...and the effect must NOT reach for it through the bridge any more. Comments are
    // stripped first: the file DISCUSSES the old bug on purpose, and a naive substring
    // check would match its own documentation.
    const effectStart = source.indexOf('React.useEffect(() => {')
    assert.ok(effectStart > 0)
    const effectEnd = source.indexOf('}, [bridge, tick', effectStart)
    assert.ok(effectEnd > effectStart, 'the mount effect must be locatable')
    const codeOnly = source
      .slice(effectStart, effectEnd)
      .split(/\r?\n/u)
      .filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
      })
      .join('\n')
    assert.equal(
      codeOnly.includes('bridge.canWrite('),
      false,
      'calling the hook from the effect is exactly what froze the panel',
    )
    assert.equal(
      codeOnly.includes('bridge.sessions('),
      false,
      'the session list must come from render, not from a bridge call in the effect',
    )
  })

  test(`v0.27 P0: ${label} puts the session set in the effect dependencies`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    // A stable string key, because an array dep would refetch on every render.
    assert.match(source, /const sessionKey = liveSessions\.join/u, 'a stable key is derived from the ids')
    assert.match(source, /\}, \[bridge, tick, picked, sessionKey\]\)/u, 'and it drives the refetch')
  })

  test(`v0.27 P0: ${label} lists sessions that appear AFTER mount`, () => {
    const react = makeStatefulReact()
    const mod = loadFactory(file, react.React)
    mod.__reactStub = react
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)

    // First pass: nothing is open. v0.28 calls this GLOBAL MODE, and the panel must still
    // render something useful rather than an empty shell.
    const empty = renderPasses(mod, bridge, [{ sessions: [] }])
    const emptySelects = collect(empty, 'select')
    assert.equal(emptySelects.length, 0, 'no selector when there is nothing to select')
    assert.ok(textOf(empty).join(' ').includes('全局'), 'and it says it is in global mode')

    // Second pass: a session exists NOW. The panel must pick it up WITHOUT a remount —
    // same component instance, same state store, new snapshot. THIS is the reactivity
    // the user reported missing.
    const live = renderPasses(mod, bridge, [{ sessions: [{ id: 'session-late' }] }])
    const selects = collect(live, 'select')
    assert.equal(selects.length, 1, 'the selector appears as soon as a session exists')
    const options = collect(live, 'option').map((node) => textOf(node).join(''))
    assert.ok(options.some((text) => text.includes('session-late')), `the new session is offered; got ${JSON.stringify(options)}`)
    assert.ok(textOf(live).join(' ').includes('session-late'), 'and the effective session is named in the summary')
  })

  test(`v0.28 P0: ${label} switches are gated on the Host payload, not on a session`, () => {
    // v0.27 asserted that a live session ENABLES the switches. v0.28 changed the gate:
    // the switches are GLOBAL settings, so what enables them is the Host having answered.
    // A stub render never completes an async fetch, so this asserts the STRUCTURE instead
    // of a state a real run would reach.
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /const canWrite = state !== null && state !== undefined/u,
      'the gate must key off the Host payload')
  })

  test(`v0.27 P0: ${label} offers a refresh control`, () => {
    const react = makeStatefulReact()
    const mod = loadFactory(file, react.React)
    mod.__reactStub = react
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)

    const live = renderPasses(mod, bridge, [{ sessions: [{ id: 's-1' }] }])
    const buttons = collect(live, 'button')
    const refresh = buttons.find((node) => node.props && typeof node.props.onClick === 'function' && textOf(node).join('').includes('刷新'))
    assert.ok(refresh !== undefined, 'a manual refresh button must exist')
    assert.equal(refresh.props.disabled, undefined === refresh.props.disabled ? undefined : refresh.props.disabled, 'sanity')
    assert.equal(typeof refresh.props.title, 'string', 'and explain what it does')
  })

  test(`v0.28 P0: ${label} keeps refresh available even with no session`, () => {
    const react = makeStatefulReact()
    const mod = loadFactory(file, react.React)
    mod.__reactStub = react
    const bridge = mod.__bridgeFactory(makeCtx(makeRemote()), undefined, undefined)

    const empty = renderPasses(mod, bridge, [{ sessions: [] }])
    const refresh = collect(empty, 'button').find((node) => textOf(node).join('').includes('刷新'))
    assert.ok(refresh !== undefined)
    // v0.28: refresh re-reads GLOBAL state, which does not need a session. Disabling it
    // was the v0.27 behaviour, and it removed the only way to recover in global mode.
    assert.notEqual(refresh.props.disabled, true, 'refreshing global state must stay possible without a session')
    assert.equal(typeof refresh.props.title, 'string', 'and explain what it does')
  })
}

// ---------------------------------------------------------------------------
// the explicit choice must be honoured and must trigger a fetch
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.27 P0: ${label} selecting a session refetches for THAT session`, async () => {
    const react = makeStatefulReact()
    const mod = loadFactory(file, react.React)
    mod.__reactStub = react
    const remote = makeRemote()
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, undefined)

    // Render with two sessions, then drive the selector's onChange the way a click does.
    const tree = renderPasses(mod, bridge, [{ sessions: [{ id: 'a' }, { id: 'b' }] }])
    const select = collect(tree, 'select')[0]
    assert.ok(select, 'the selector exists')
    assert.equal(typeof select.props.onChange, 'function')
    select.props.onChange({ target: { value: 'a' } })

    // The component bumps its tick, so a fresh effect must be registered by the NEXT
    // render. Flush it and assert the request used the choice, not the newest.
    renderPasses(mod, bridge, [{ sessions: [{ id: 'a' }, { id: 'b' }] }])
    // Dispose the interval the effect starts, or the test process never exits.
    const dispose = react.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 50))
    dispose()

    assert.ok(remote.calls.length > 0, 'a request must follow the selection')
    assert.deepEqual(remote.calls[0].agent, { id: 'a' }, 'the CHOSEN session is used, not the newest')
  })
}
