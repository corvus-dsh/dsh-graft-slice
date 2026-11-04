/**
 * v0.23 — BOTH PANELS MUST RENDER. The blank-page regression, pinned.
 *
 * THE REPORT. After restart the two sidebar ICONS appeared, but clicking either one
 * produced a pure white panel. Host.call was reaching the Host (the earlier
 * `remote.commands` error was gone), so this was not a data problem — it was the
 * render crashing before anything was committed.
 *
 * THE DIAGNOSIS THIS FILE ENCODES. The two cells are function components in the same
 * bundle. The only difference that can produce "icon draws, panel is white" is that
 * the icon calls NO HOOK and the panel called `React.useCallback`. The React surface
 * the client sandbox advertises is exactly:
 *
 *     React.createElement / React.useState / React.useEffect
 *
 * `useCallback` is not on it. If the sandbox hands a narrowed React, the panel throws
 * `TypeError: React.useCallback is not a function` DURING RENDER — which unmounts the
 * tree and leaves a blank page, while the hook-free icon still draws. That matches the
 * report exactly.
 *
 * So the test below renders each panel against a React that provides ONLY the three
 * advertised symbols. On the v0.22 bundle this throws; on this one it renders. That is
 * the regression guard: no future edit may reintroduce a hook outside that surface.
 *
 * A note on what this can and cannot prove. It does not prove the live page is fixed —
 * only the real browser can. It proves the specific failure mode is gone and that the
 * panels render to content given the narrowest React the sandbox documents.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

/**
 * Load one client bundle with a controlled sandbox.
 *
 * @param file       bundle path relative to the workspace root
 * @param reactApi   the symbol names to expose on `React`
 * @param hostReply  what `host.call`/commands return (a JSON string)
 */
function load(file, { reactApi, hostReply = '{"ok":true}' } = {}) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  let captured
  const logged = []

  // A minimal React. Each hook is a real (if trivial) implementation so a component
  // using it produces an element rather than throwing for the wrong reason.
  const calls = { state: 0, effect: 0 }
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
  }
  for (const name of reactApi) {
    if (name === 'createElement') continue
    if (name === 'useState') {
      React.useState = (initial) => {
        calls.state += 1
        return [typeof initial === 'function' ? initial() : initial, () => {}]
      }
      continue
    }
    if (name === 'useEffect') {
      React.useEffect = () => { calls.effect += 1 }
      continue
    }
    if (name === 'useCallback') {
      // Deliberately faithful: identity is preserved, but the symbol only exists when
      // the caller asked for it. This is what the real sandbox may or may not provide.
      React.useCallback = (fn) => fn
      continue
    }
    // Any other requested symbol is exposed as a harmless stub.
    React[name] = () => undefined
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) { captured = definition },
      },
    },
    require(name) {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    },
    console: {
      log: (...args) => logged.push(['log', args]),
      error: (...args) => logged.push(['error', args]),
    },
  }

  // The bundles are written as `window.__ModuleLoader__.load({...})` with no imports,
  // so evaluating them against the sandbox is exactly what the page does.
  const run = new Function(
    'window', 'require', 'console',
    `"use strict";\n${source}\n;return undefined;`,
  )
  run(sandbox.window, sandbox.require, sandbox.console)
  assert.ok(captured, `${file} must register a module definition`)
  return { definition: captured, React, calls, logged }
}

/** Minimal slot/ctx harness the bundle's `apply` needs. */
function makeCtx() {
  const registrations = []
  const ctx = {
    slots: {
      inject(_key, callback) { callback() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get(name) {
      if (name === 'remote') return undefined
      return undefined
    },
  }
  return { ctx, registrations }
}

/** Invoke a component function as React would, returning its element tree. */
function render(Component, props) {
  return Component(props || {})
}

/** Collect every string of text in an element tree, for "did it actually draw" checks. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object') {
    // Our stub createElement puts children on the element itself; a real React element
    // keeps them on `props.children`. Support both so the helper is renderer-agnostic.
    if (Array.isArray(node.children)) textOf(node.children, out)
    else if (node.children !== undefined) textOf(node.children, out)
    if (node.props && node.props.children !== undefined) textOf(node.props.children, out)
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. the narrowed-React surface: the actual regression
// ---------------------------------------------------------------------------

const NARROW = ['createElement', 'useState', 'useEffect']

for (const [label, file, panelKey] of [
  ['dsh-graft-slice', 'dsh-graft-slice/client.js', 'GraftConsole'],
  ['dsh-memory', 'dsh-memory/client.js', 'MemoryConsole'],
]) {
  test(`v0.23: ${label} panel RENDERS against a React with only the three documented symbols`, () => {
    const { definition, logged } = load(file, { reactApi: NARROW })
    assert.equal(typeof definition.factory, 'function')

    const factory = definition.factory
    const { ctx } = makeCtx()
    // A dead bridge: the panel must STILL render, showing its own error state. If the
    // render depended on a live Host it could not prove the surface is the issue.
    const deadBridge = {
      state: async () => ({ ok: false, via: 'none', text: '宿主调用失败（测试）' }),
      set: async () => ({ ok: false, via: 'none', text: '宿主调用失败（测试）' }),
      clear: async () => ({ ok: false, via: 'none', text: '宿主调用失败（测试）' }),
    }
    const mod = factory(
      (name) => {
        if (name === 'react') {
          // Re-derive the same narrowed React the sandbox would hand over.
          const R = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
          R.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
          R.useEffect = () => {}
          return R
        }
        throw new Error(`unexpected require(${name})`)
      },
      { insert: () => () => {} },
      undefined,
    )
    assert.equal(typeof mod.apply, 'function')
    mod.apply(ctx)

    const panel = mod.__panelForTest
    assert.equal(typeof panel, 'function', `${panelKey} must be reachable for a render test`)
    const tree = render(panel, { bridge: deadBridge })
    const text = textOf(tree).join(' ')
    assert.ok(text.length > 0, 'the panel produced NO text — that is the white page')
    assert.ok(
      text.includes('控制台'),
      `the panel must draw its own heading; got: ${text.slice(0, 200)}`,
    )
    const crashes = logged.filter(([level]) => level === 'error')
    assert.equal(crashes.length, 0, `render logged an error: ${JSON.stringify(crashes).slice(0, 400)}`)
  })
}

// ---------------------------------------------------------------------------
// 2. the bundle must not reach for a symbol outside the documented surface
// ---------------------------------------------------------------------------

/**
 * Symbols the sandbox documents. Anything OUTSIDE this set may be absent at runtime,
 * so it may only be used after a `typeof` probe with a working fallback.
 */
const DOCUMENTED = new Set(['createElement', 'useState', 'useEffect'])

for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
  test(`v0.23: ${file} takes no UNGUARDED dependency on a symbol outside the documented surface`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const lines = source.split(/\r?\n/u)
    const violations = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const trimmed = line.trim()
      // Skip comments: the file DISCUSSES useCallback at length on purpose.
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      for (const match of line.matchAll(/React\.([A-Za-z_$][\w$]*)/gu)) {
        const name = match[1]
        if (DOCUMENTED.has(name)) continue
        // An extension symbol is allowed ONLY when it is probed before use. The probe
        // may sit a few lines above (`guard` reads `typeof React.Component` and then
        // returns early), so the window is the enclosing few lines, and `typeof
        // React.<name>` must appear in them. That is what turns an absence from a crash
        // into a documented fallback.
        const from = Math.max(0, index - 6)
        const window = lines.slice(from, index + 1).join('\n')
        const PROBED = new RegExp(`typeof\\s+React\\.${name}\\b`, 'u').test(window)
        if (!PROBED) violations.push(`line ${index + 1}: React.${name} (no typeof probe nearby)`)
      }
    }
    assert.deepEqual(
      violations,
      [],
      `${file} uses ${violations.join(', ')} without a typeof probe — a missing symbol throws during render and blanks the panel`,
    )
  })
}

test('v0.23: a panel using only the three documented hooks renders — the regression itself', () => {
  // This is the load-bearing assertion of the whole file: it reproduces the sandbox
  // that broke the panels (no useCallback, no Component) and requires both to draw.
  for (const file of ['dsh-graft-slice/client.js', 'dsh-memory/client.js']) {
    const React = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
    React.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
    React.useEffect = () => {}
    // NOTHING else — no useCallback, no Component, no memo, no useRef.
    let captured
    const require = (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    }
    const source = readFileSync(join(ROOT, file), 'utf8')
    const run = new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)
    run({ __ModuleLoader__: { load(definition) { captured = definition } } }, require, { log() {}, error() {} })
    assert.ok(captured, `${file} must register`)

    // `apply` must not throw: the guard probes for Component and falls back.
    const mod = captured.factory(require, { insert: () => () => {} }, undefined)
    const registrations = []
    const ctx = {
      slots: { inject: (_k, cb) => cb(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
      get: () => undefined,
    }
    assert.doesNotThrow(() => mod.apply(ctx), `${file} apply() threw without the class API`)
    assert.equal(registrations.length, 2, 'both the panel and the sidebar cell must register')
    // And the components it registered actually render.
    //
    // NOTE: the registered component is the BOUNDARY-WRAPPED one. With no class API in
    // this sandbox, `withBoundary` returns the bare component, so calling it directly is
    // correct here. The assertion is on visible TEXT, not on element identity, so an
    // implementation that keeps a wrapper still passes.
    const bridge = { state: async () => ({ ok: false, text: 'x' }), set: async () => ({ ok: false }), clear: async () => ({ ok: false }) }
    for (const { options, component } of registrations) {
      // `main` registrations take the injected `bridge`; a sidebar cell takes icon
      // owner props and needs none. Both must produce visible content.
      const props = options.name === 'main' ? { bridge } : {}
      const tree = component(props)
      assert.ok(tree !== null && tree !== undefined, `${file}: ${options.key || options.id} rendered nothing at all`)
      if (options.name === 'main') {
        // The PANEL must draw text — that is what "not a white page" means.
        const text = textOf(tree).join(' ')
        assert.ok(text.length > 0, `${file}: the panel produced no content`)
        assert.ok(
          text.includes('控制台'),
          `${file}: the panel rendered without its heading; got: ${text.slice(0, 160)}`,
        )
      } else {
        // The ICON is an svg with no text by design (v0.22 kept the label to the owner,
        // which is what fixed the doubled "转生 转生"). Require an ELEMENT, not text.
        assert.ok(typeof tree === 'object' && tree.type !== undefined, `${file}: the sidebar cell must draw an element`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 3. an incomplete Host payload must not blank the panel
// ---------------------------------------------------------------------------

test('v0.23: the graft panel survives a payload with every optional field missing', () => {
  const { definition } = load('dsh-graft-slice/client.js', { reactApi: NARROW })
  const mod = definition.factory(
    (name) => {
      if (name !== 'react') throw new Error(`unexpected require(${name})`)
      const R = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
      R.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
      R.useEffect = () => {}
      return R
    },
    { insert: () => () => {} },
    undefined,
  )
  const panel = mod.__panelForTest

  // `state` is injected through the hook, which the stub returns as its initial value.
  // Instead of driving the hook, assert directly on the exported row renderer, which is
  // where `.toLocaleString()` on a missing field used to throw.
  const row = mod.__sessionRowForTest
  assert.equal(typeof row, 'function')
  // An EMPTY row: no percent, no tokens, no state. Must render, not throw.
  assert.doesNotThrow(() => render(row, { row: {} }))
  const text = textOf(render(row, { row: {} })).join(' ')
  assert.ok(text.includes('未知会话'), 'a row with no sessionId says so instead of rendering undefined')
  void panel
})

test('v0.23: the memory panel survives a skill record with missing fields', () => {
  const { definition } = load('dsh-memory/client.js', { reactApi: NARROW })
  const mod = definition.factory(
    (name) => {
      if (name !== 'react') throw new Error(`unexpected require(${name})`)
      const R = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
      R.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
      R.useEffect = () => {}
      return R
    },
    { insert: () => () => {} },
    undefined,
  )
  const skillRow = mod.__skillRowForTest
  assert.equal(typeof skillRow, 'function')
  // `invalidAt` was read as `skill.invalidAt.length` — a TypeError on a missing field.
  assert.doesNotThrow(() => render(skillRow, { skill: {} }))
  const text = textOf(render(skillRow, { skill: {} })).join(' ')
  assert.ok(text.includes('未命名'), 'a record with no title/name says so')
})

// ---------------------------------------------------------------------------
// 4. the error boundary turns a throw into a card, not a blank page
// ---------------------------------------------------------------------------

/**
 * A React with the class API, so the boundary can be exercised for real.
 *
 * `createElement` is LAZY on purpose (it records an element), which is exactly why a
 * try/catch around it cannot catch a render throw — the first draft of the boundary
 * made that mistake and this file caught it. Driving the boundary therefore needs a
 * renderer that actually calls component functions.
 */
function makeClassReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
  }
  React.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  React.useEffect = () => {}
  React.Component = class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(patch) { this.state = { ...this.state, ...patch } }
  }
  return React
}

/**
 * Render an element tree with the class API, honouring error boundaries.
 * Returns the final tree, invoking component functions along the way.
 */
function renderTree(node, React, errors = []) {
  if (node === null || node === undefined || node === false) return node
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => renderTree(child, React, errors))
  if (typeof node !== 'object') return node

  const { type, props } = node
  // A class component: instantiate, then try to render it, catching into the boundary.
  if (typeof type === 'function' && type.prototype && type.prototype.isReactComponent !== false && type.prototype.render && type.prototype.setState) {
    const instance = new type(props)
    try {
      return renderTree(instance.render(), React, errors)
    } catch (error) {
      errors.push(error)
      return { type: 'span', props: {}, children: [`uncaught: ${error.message}`] }
    }
  }
  if (typeof type === 'function') {
    // A function component. A class boundary ABOVE it would catch; here we recurse and
    // let the caller's boundary decide. For the plain-panel tests no boundary is above,
    // so a throw propagates — which is the point of those tests.
    return renderTree(type(props), React, errors)
  }
  // A host element: render its children.
  return {
    type,
    props,
    children: node.children.map((child) => renderTree(child, React, errors)),
  }
}

for (const [label, file] of [
  ['dsh-graft-slice', 'dsh-graft-slice/client.js'],
  ['dsh-memory', 'dsh-memory/client.js'],
]) {
  test(`v0.23: ${label} guards a throwing panel behind a visible error card`, () => {
    const React = makeClassReact()
    const logged = []
    const source = readFileSync(join(ROOT, file), 'utf8')
    let captured
    const require = (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require(${name})`)
    }
    const consoleStub = { log: () => {}, error: (...args) => logged.push(args) }
    const run = new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)
    run({ __ModuleLoader__: { load(definition) { captured = definition } } }, require, consoleStub)
    assert.ok(captured)

    const mod = captured.factory(require, { insert: () => () => {} }, undefined)
    const guard = mod.__guardForTest
    assert.equal(typeof guard, 'function', 'the boundary must be exported for test')

    const Boom = () => { throw new Error('组件炸了') }
    const Boundary = guard(Boom)
    assert.notEqual(Boundary, Boom, 'with the class API present the guard must wrap, not pass through')

    // Mount it exactly as React would: construct, then the child throws during render
    // and React feeds the error through getDerivedStateFromError.
    const instance = new Boundary({ children: null })
    assert.equal(instance.state.crash, null, 'a healthy boundary renders normally')
    let thrown
    try {
      // This is the render React would perform; the throw is what a boundary exists for.
      Boom({})
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, 'the probe component must actually throw')
    instance.state = Boundary.getDerivedStateFromError(thrown)
    const text = textOf(renderTree(instance.render(), React)).join(' ')
    assert.ok(text.includes('控制台渲染失败'), `expected the red card, got: ${text.slice(0, 200)}`)
    assert.ok(text.includes('组件炸了'), 'the card carries the actual error, not a generic message')
  })
}
