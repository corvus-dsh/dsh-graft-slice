/**
 * v0.26 P0 — NO AGENT MEANS NO REQUEST. Not "a request that fails politely".
 *
 * THE REPORTED BUG, and why it survived the previous fix.
 *
 * v0.25 made the panel degrade to read-only when no session was resolvable, and that UI
 * worked. But the MOUNT-TIME FETCH still ran: `bridge.state()` went out with an
 * undefined agent, the gateway rejected it, and a red `remote.commands.execute` card
 * appeared on top of a panel that was already correctly saying "read-only". The UI was
 * right; the traffic was not.
 *
 * There was a second, deeper reason it kept happening. v0.24 read `useSessions` from the
 * `inject` callback:
 *
 *     inject: (props) => ({ bridge: makeBridge(ctx, host, props) })
 *
 * A ROOT-SCOPED slot's `InjectParams` is `[]` — the callback receives NO arguments. So
 * `props` was always `undefined`, `sessionIdsFromProps()` always returned `[]`, and the
 * bridge always believed there was no session. The hook is a standard selector delivered
 * as a COMPONENT PROP; it has to be attached from the component body.
 *
 * What these tests hold:
 *   1. the hook reaches the bridge through the component, not through inject;
 *   2. with NO agent, ZERO calls reach `remote.commands.execute` — the count is asserted,
 *      because "it failed gracefully" is exactly the behaviour that shipped;
 *   3. no error is raised in that state ("nobody has picked yet" is normal, not a fault);
 *   4. once an agent exists, the very next fetch does go out;
 *   5. the panel renders its skeleton with a "waiting" line meanwhile.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

function stubReact() {
  const React = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
  React.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  React.useEffect = (fn) => { React.__effect = fn }
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
  return { mod: captured.factory(require, { insert: () => () => {} }, undefined), React }
}

/** A remote that COUNTS every call, including rejected ones. */
function makeCountingRemote() {
  const calls = []
  return {
    calls,
    commands: {
      async execute(agent, line) {
        calls.push({ agent, line })
        if (agent === undefined || agent === null || typeof agent.id !== 'string') {
          const error = new Error('{"code":"gateway/arguments-invalid","details":{"endpoint":"commands/execute"}}')
          throw error
        }
        return { commandId: 'c', result: { kind: 'success', text: '{"workspace":"D:\\\\x","skills":[],"counts":{"skills":0,"active":0,"superseded":0,"queued":0},"scenes":[]}' } }
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

// ---------------------------------------------------------------------------
// 1. the count is zero — the actual requirement
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.26 P0: ${label} sends NOTHING when no agent is resolvable`, async () => {
    const { mod } = loadFactory(file)
    const remote = makeCountingRemote()
    // No hook, no snapshot: the real "root panel with no conversation" state.
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, undefined)
    const reply = await bridge.state()

    assert.equal(remote.calls.length, 0, `ZERO requests may leave the panel; got ${remote.calls.length}`)
    assert.equal(reply.ok, false, 'the reply reports that nothing was sent')
    // And it must not be the gateway's opaque rejection, which is what the user saw.
    assert.equal(
      String(reply.text).includes('gateway/arguments-invalid'),
      false,
      'the panel must never surface a gateway rejection it could have avoided',
    )
  })

  test(`v0.26 P0: ${label} sends nothing for a WRITE either`, async () => {
    const { mod } = loadFactory(file)
    const remote = makeCountingRemote()
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, undefined)
    await bridge.set('autoGraft', false)
    assert.equal(remote.calls.length, 0, 'a write must be blocked by the same guard as a read')
  })
}

// ---------------------------------------------------------------------------
// 2. the hook arrives as a component prop, not through inject
// ---------------------------------------------------------------------------

for (const [label, file, panelKey] of [
  ['graft', 'dsh-graft-slice/client.js', 'GraftConsole'],
  ['memory', 'dsh-memory/client.js', 'MemoryConsole'],
]) {
  test(`v0.26 P0: ${label} attaches useSessions from its PROPS`, () => {
    const { mod } = loadFactory(file)
    const remote = makeCountingRemote()
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, undefined)

    // Before the component renders, the bridge knows nothing.
    assert.deepEqual(bridge.sessions(), [], 'no hook yet, no sessions')
    assert.equal(bridge.canWrite(), false)

    // Render the panel, passing the hook the way the slot owner does.
    const panel = mod.__panelForTest
    panel({
      bridge,
      useSessions: (selector) => selector({ sessions: [{ id: 'live-1' }] }),
    })

    assert.deepEqual(bridge.sessions(), ['live-1'], 'the hook must reach the bridge through the component')
    assert.equal(bridge.canWrite(), true, 'and a real session makes writes possible')
  })
}

// ---------------------------------------------------------------------------
// 3. the fetch runs once an agent exists
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.26 P0: ${label} DOES fetch once a session is attached`, async () => {
    const { mod } = loadFactory(file)
    const remote = makeCountingRemote()
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, {
      useSessions: (selector) => selector({ sessions: [{ id: 'live-9' }] }),
    })
    const reply = await bridge.state()
    assert.equal(remote.calls.length, 1, 'one request, now that there is somewhere to send it')
    assert.deepEqual(remote.calls[0].agent, { id: 'live-9' })
    assert.equal(reply.ok, true)
  })
}

// ---------------------------------------------------------------------------
// 4. the guard lives in the effect, so a mount cannot bypass it
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.26 P0: ${label} guards inside the MOUNT effect, not only in the renderer`, () => {
    // The bug was mount-time traffic, so the assertion is on the source that runs at
    // mount: there must be an early return keyed on agent readiness BEFORE the fetch.
    const source = readFileSync(join(ROOT, file), 'utf8')
    const marker = source.indexOf('agentReady')
    assert.ok(marker > 0, 'the effect must compute an agent-ready flag')
    const fetchAt = source.indexOf('bridge.state(', marker)
    assert.ok(fetchAt > marker, 'the guard must appear BEFORE the fetch in the same effect')

    // The early return must be between them.
    const between = source.slice(marker, fetchAt)
    assert.match(between, /if \(!agentReady\)/u, 'and it must return early when not ready')
    assert.match(between, /return/u, 'the branch must actually return')
  })
}

// ---------------------------------------------------------------------------
// 5. no error card while merely waiting
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.26 P0: ${label} clears the error instead of showing one while waiting`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const marker = source.indexOf('agentReady')
    const between = source.slice(marker, source.indexOf('bridge.state(', marker))
    // setError('') — not setError(<message>). Waiting is a normal state.
    assert.match(between, /setError\(''\)/u, 'waiting must CLEAR the error, not raise one')
  })
}

// ---------------------------------------------------------------------------
// 6. the panel renders a skeleton with a waiting line
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.26 P0: ${label} shows a "wait for a choice" line, not a failure`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /等待选择会话|当前没有活动会话|未能确定活动会话/u, 'a waiting/read-only line must exist')
    assert.match(source, /只读/u, 'and it must say the panel is read-only, not broken')
  })
}
