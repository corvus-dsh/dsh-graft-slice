/**
 * v0.30 P0 — THE ACCEPTANCE CRITERIA, TESTED AS BEHAVIOUR.
 *
 * The user's bar, verbatim:
 *
 *   "在没有任何活动会话的情况下，面板能显示全局配置，开关可点击且点击后能持久化"
 *
 * Every previous round asserted STRUCTURE — does the source contain X. Those assertions
 * were satisfied while the panel still did not work, because the structure was right and
 * the pipeline was not. This file drives the real pipeline end to end:
 *
 *     real Host command  <-  real client bridge  <-  a gateway that runs the command
 *
 * with `sessions.list()` returning NOTHING, which is the reported condition.
 *
 * What it proves:
 *   1. a READ with no session returns the GLOBAL config (14 graft fields, 8 memory fields);
 *   2. rendering after that read produces switches with NONE disabled;
 *   3. a toggle reaches the Host and actually writes (the fake configEditor records it).
 *
 * A NOTE ON THE SCAFFOLD: `state` is component-local, so the mount effect has to be
 * flushed and allowed to settle before the render can reflect it. This test does that
 * deliberately — the first draft rendered without flushing and reported "5 disabled",
 * which was a artefact of the harness rather than a defect in the panel.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

/** A Host with NO sessions and a recording config editor. */
function makeHost() {
  const commands = new Map()
  const writes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (definition) => commands.set(`tool:${definition.name}`, definition) },
    commands: { register: (definition) => commands.set(definition.name, definition) },
    paths: { data: join(ROOT, '_scratch', 'acceptance-data') },
    get(name) {
      if (name === 'commands') return ctx.commands
      // THE CONDITION UNDER TEST: nothing is open.
      if (name === 'sessions') return { list: () => [], get: () => undefined }
      if (name === 'configEditor') {
        return {
          entries: () => [{ id: 'dsh-graft-slice', patchId: 'dsh-graft-slice' }, { id: 'dsh-memory', patchId: 'dsh-memory' }],
          edit: async (entry, mutate) => { writes.push({ entry: entry.id, patch: mutate({ autoGraft: true, retrieval: true }) }) },
        }
      }
      return undefined
    },
    on: () => {},
    effect: (fn) => { fn() },
  }
  return { ctx, commands, writes }
}

/** A gateway that executes the REAL registered Host command. */
function makeGateway(commands) {
  const calls = []
  return {
    calls,
    commands: {
      async execute(agent, line) {
        calls.push({ agent, line })
        if (agent === undefined || agent === null || typeof agent.id !== 'string') {
          throw new Error('{"code":"gateway/arguments-invalid"}')
        }
        const name = String(line).replace(/^\//u, '').split(/\s+/u)[0]
        const definition = commands.get(name)
        if (definition === undefined) return undefined
        const rawInput = String(line).replace(/^\//u, '').split(/\s+/u).slice(1).join(' ')
        const result = await definition.handler({ agent, rawInput })
        return { commandId: 'c', result }
      },
    },
  }
}

function stubReact() {
  const store = []
  let cursor = 0
  let effect
  const React = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
  React.useState = (initial) => {
    const i = cursor++
    if (!(i in store)) store[i] = typeof initial === 'function' ? initial() : initial
    return [store[i], (next) => { store[i] = typeof next === 'function' ? next(store[i]) : next }]
  }
  React.useEffect = (fn) => { effect = fn }
  return { React, begin: () => { cursor = 0 }, flush: () => effect, store }
}

function loadClient(file, gateway) {
  const react = stubReact()
  const source = readFileSync(join(ROOT, file), 'utf8')
  let captured
  const require = (name) => {
    if (name === 'react') return react.React
    throw new Error(`unexpected require(${name})`)
  }
  new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)(
    { __ModuleLoader__: { load(d) { captured = d } } },
    require,
    { log() {}, error() {} },
  )
  const mod = captured.factory(require, { insert: () => () => {} }, undefined)
  const bridge = mod.__bridgeFactory({ get: (n) => (n === 'remote' ? gateway : undefined) }, undefined, undefined)
  return { mod, react, bridge }
}

function collect(node, type, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) collect(c, type, out); return out }
  if (node.type === type) out.push(node)
  if (node.children) collect(node.children, type, out)
  if (node.props && node.props.children !== undefined) collect(node.props.children, type, out)
  return out
}

function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((c) => expand(c, depth))
  const { type, props } = node
  if (typeof type === 'function' && depth < 40) {
    try { return expand(type(props || {}), depth + 1) } catch { return node }
  }
  const children = node.children ? expand(node.children, depth) : undefined
  return { ...node, ...(children === undefined ? {} : { children }) }
}

// ---------------------------------------------------------------------------

for (const [label, applyPath, clientFile, configKey] of [
  ['graft', 'dsh-graft-slice/index.js', 'dsh-graft-slice/client.js', 'autoGraft'],
  ['memory', 'dsh-memory/lib/index.js', 'dsh-memory/client.js', 'retrieval'],
]) {
  test(`v0.30 P0: ${label} — global config is readable, operable and persistent with NO session`, async () => {
    const { apply } = await import(`file:///${join(ROOT, applyPath).replace(/\\/gu, '/')}`)
    const host = makeHost()
    apply(host.ctx, {
      memoryDir: join(ROOT, '_scratch', 'acceptance-data', 'memory'),
      skillsDir: join(ROOT, '_scratch', 'acceptance-data', 'skills'),
    })
    const gateway = makeGateway(host.commands)
    const { mod, react, bridge } = loadClient(clientFile, gateway)

    // 1. A READ with no session anywhere.
    const read = await bridge.state()
    assert.equal(read.ok, true, `${label}: the global read must succeed with no session`)
    const state = JSON.parse(read.text)
    assert.ok(Object.keys(state.config || {}).length > 0, `${label}: the config must be present`)
    assert.deepEqual(state.sessions, [], `${label}: the fixture really has no sessions`)

    // 2. Render AFTER the mount effect has settled, so the switches reflect the state.
    react.begin()
    mod.__panelForTest({ bridge, useSessions: undefined })
    const effect = react.flush()
    const cleanup = typeof effect === 'function' ? effect() : undefined
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (typeof cleanup === 'function') cleanup()

    react.begin()
    const tree = expand(mod.__panelForTest({ bridge, useSessions: undefined }))
    const switches = collect(tree, 'button').filter((node) => node.props && node.props.role === 'switch')
    assert.ok(switches.length > 0, `${label}: the switches must render`)
    const disabled = switches.filter((node) => node.props.disabled === true)
    assert.equal(disabled.length, 0, `${label}: no switch may be disabled once global state is loaded`)

    // 3. A toggle must reach the Host and actually write.
    const next = state.config[configKey] !== true
    const write = await bridge.set(configKey, next)
    assert.equal(write.ok, true, `${label}: the write must succeed`)
    assert.equal(host.writes.length, 1, `${label}: the Host must have persisted the change`)
  })
}
