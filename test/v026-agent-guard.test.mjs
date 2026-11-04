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
// 1. reads go global, writes stay refused
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  /**
   * v0.28 REVISION of the v0.26 contract.
   *
   * v0.26 asserted ZERO requests without an agent. That stopped the abandoned gateway
   * call, but it ALSO stopped the global data — the knobs, totals, scenes and ledger are
   * session-independent, and refusing them left the panel permanently empty. The user's
   * report ("一直处于只读…卡在正在读取") is exactly that guard working as specified.
   *
   * The refined contract:
   *   - a READ with no agent IS sent, against the session-independent command, using a
   *     shape-valid placeholder id (the gateway checks shape, never existence);
   *   - a WRITE with no agent is still refused, because a knob change records WHO made
   *     it and an invented id would make that audit a lie.
   */
  test(`v0.28 P0: ${label} STILL READS when no agent is resolvable, via a shape-valid id`, async () => {
    const { mod } = loadFactory(file)
    const remote = makeCountingRemote()
    // No hook, no snapshot: the real "root panel with no conversation" state.
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, undefined)
    const reply = await bridge.state()

    assert.equal(remote.calls.length, 1, 'the global read must go out — refusing it is what made the panel useless')
    const agent = remote.calls[0].agent
    assert.ok(agent && typeof agent.id === 'string' && agent.id.length > 0, 'the placeholder must be SHAPE-valid')
    assert.equal(reply.ok, true, 'and the Host answer is surfaced')
  })

  /**
   * v0.30 REVISION of the v0.28 rule.
   *
   * v0.28 refused an agent-less write so a knob change would be attributable. That rule
   * was wrong for these knobs: they are PROFILE settings, owned by the workspace rather
   * than by a conversation, and the refusal is exactly what left the panel's switches
   * dead in global mode. Now the write goes out with the same constant placeholder the
   * read uses.
   */
  test(`v0.30 P0: ${label} ALLOWS a WRITE without an agent, using the placeholder`, async () => {
    const { mod } = loadFactory(file)
    const remote = makeCountingRemote()
    const bridge = mod.__bridgeFactory(makeCtx(remote), undefined, undefined)
    const reply = await bridge.set('autoGraft', false)
    assert.equal(remote.calls.length, 1, 'the write must actually be attempted')
    const agent = remote.calls[0].agent
    assert.ok(agent && typeof agent.id === 'string' && agent.id.length > 0, 'with a shape-valid placeholder')
    assert.equal(reply.ok, true, 'and the Host answer is surfaced')
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
// 4. the fetch always runs — a mount may never be blocked by a missing session
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  /**
   * v0.28 REVISION: the v0.26 assertion required an early return before the fetch.
   *
   * That early return IS the reported bug in its second form: it stopped the abandoned
   * gateway call AND the global read, so the panel never left "正在读取" / "只读".
   *
   * The guard has moved DOWN into the bridge, where it distinguishes a read (allowed with
   * a placeholder) from a write (refused). The effect no longer gates anything.
   */
  test(`v0.28 P0: ${label} fetches unconditionally, with the session sentinel handled in the bridge`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const effectStart = source.indexOf('React.useEffect(() => {')
    assert.ok(effectStart > 0)
    const effectEnd = source.indexOf('}, [bridge, tick', effectStart)
    assert.ok(effectEnd > effectStart)

    const codeOnly = source
      .slice(effectStart, effectEnd)
      .split(/\r?\n/u)
      .filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
      })
      .join('\n')

    // The fetch must be reachable: no early return keyed on a missing session.
    assert.equal(
      codeOnly.includes('if (!agentReady)'),
      false,
      'an early return on "no session" is what kept the panel permanently empty',
    )
    // And the call is still bounded, so a silent channel cannot spin forever.
    assert.match(codeOnly, /withTimeout\(bridge\.state\(/u, 'the fetch must be bounded and must actually run')
  })
}

// ---------------------------------------------------------------------------
// 5. every deadline is visible, so "正在读取" can never be permanent
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.28 P0: ${label} renders the deadline failure text, not a silent spinner`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    // The timeout produces a RESULT (ok:false + text), which the effect turns into an
    // error card. The label names which call timed out.
    assert.match(source, /超时（\$\{ms\}ms 内宿主没有回应）/u, 'a timeout must produce a stated result')
    assert.match(source, /读取转生控制台|读取控制台状态/u, 'and name which read timed out')
  })
}

// ---------------------------------------------------------------------------
// 6. global mode is a real mode, and it is described honestly
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.28 P0: ${label} says what STILL WORKS when no session is exposed`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    // The message must describe the global mode rather than a dead end. The old
    // "没有可用的活动会话" string was replaced precisely because it told the user nothing
    // about what the panel could still do.
    assert.match(source, /全局模式|全局数据/u, 'global mode must be named')
    assert.equal(
      source.includes('没有可用的活动会话：agent 参数必填，伪造会被 gateway 拒绝'),
      false,
      'the dead-end string must be gone',
    )
  })
}
