/**
 * v0.24 — THE RPC CONTRACT, and the reason the panels sat at "读取中…".
 *
 * THE REPORTED FAILURE. The panels finally rendered, but the switches were unset, the
 * graft panel's derivation line stayed at "当前推导：读取中…", and the memory panel
 * showed a red card whose whole content was:
 *
 *     {"code": "gateway/arguments-invalid", "details": {"endpoint": "commands/execute"}}
 *
 * THE CAUSE, measured against the live contracts rather than guessed:
 *
 *   - The Host registers `commands.execute(agent, line, attachments, signal)` where
 *     `agent` is typed `Agent` = `{ id: SessionId }`. It is REQUIRED and validated; the
 *     gateway rejects anything else with exactly that error.
 *   - The CLIENT `sessions` service has NO `list()` method. Its face is
 *     retain / using / retainInfo / refreshProjections / search / fork / scope /
 *     binding. `list()` exists on the HOST session store, which is a different object.
 *   - The old `agentOf()` called `ctx.get('sessions').list()`, which therefore returned
 *     `undefined` on every render, and `execute(undefined, …)` was rejected.
 *
 * So the plugin was not passing the wrong SHAPE — it was passing NOTHING, and the
 * gateway was right to refuse it.
 *
 * What these tests hold:
 *   1. an agent is resolved from the SLOT props (`useSessions`), never by inventing one;
 *   2. `execute` is never called with an undefined agent — a no-session state is
 *      REPORTED as such instead of being sent as an invalid argument;
 *   3. a rejected call surfaces the gateway message, so the next failure is diagnosable;
 *   4. the panel distinguishes "loading" from "failed", so it cannot spin forever.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

/** Load a client bundle and return the module `apply` lives on (factory's result). */
function loadModule(file, React) {
  const source = readFileSync(join(ROOT, file), 'utf8')
  let captured
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  }
  const run = new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)
  run({ __ModuleLoader__: { load(definition) { captured = definition } } }, require, { log() {}, error() {} })
  assert.ok(captured, `${file} must register`)
  // `__bridgeFactory` is on the object the FACTORY returns, not on the loader definition.
  return captured.factory(require, { insert: () => () => {} }, undefined)
}

function stubReact() {
  const React = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat() }) }
  React.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  React.useEffect = () => {}
  return React
}

/**
 * A fake `remote.commands` that RECORDS every call and can reject the way the gateway
 * does. This is the whole point: the test must observe what was actually sent.
 */
function makeRemote({ reject } = {}) {
  const calls = []
  return {
    calls,
    commands: {
      async execute(agent, line, attachments, signal) {
        calls.push({ agent, line, attachments, signal })
        if (reject === true) {
          const error = new Error('{"code":"gateway/arguments-invalid","details":{"endpoint":"commands/execute"}}')
          throw error
        }
        if (agent === undefined || agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') {
          throw new Error('{"code":"gateway/arguments-invalid","details":{"endpoint":"commands/execute"}}')
        }
        return { commandId: 'c1', result: { kind: 'success', text: '{"ok":true}' } }
      },
    },
  }
}

/** Build the ctx the bridge reads from. `sessions` deliberately has NO list(). */
function makeCtx(remote) {
  return {
    get(name) {
      if (name === 'remote') return remote
      if (name === 'sessions') {
        // The real Client face: no `list()`.
        return {
          retain: () => { throw new Error('not used') },
          binding: () => undefined,
          scope: () => undefined,
        }
      }
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// 1. the agent comes from the slot, and is a real { id }
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.24: ${label} resolves the agent from useSessions, not from a missing list()`, async () => {
    const React = stubReact()
    const mod = loadModule(file, React)
    const remote = makeRemote()
    const ctx = makeCtx(remote)

    // The slot props a root-scoped `main` panel receives.
    const slotProps = {
      useSessions: (selector) => selector({ sessions: [{ id: 'session-live-1' }, { id: 'session-live-2' }] }),
    }
    const bridge = mod.__bridgeFactory(ctx, undefined, slotProps)
    const reply = await bridge.state()

    assert.equal(reply.ok, true, `the call must succeed; got ${JSON.stringify(reply)}`)
    assert.equal(reply.via, 'remote.commands.execute')
    assert.equal(remote.calls.length, 1, 'exactly one execute call')
    const { agent, line } = remote.calls[0]
    assert.deepEqual(agent, { id: 'session-live-2' }, 'the MOST RECENT live session is used, as a plain { id }')
    assert.match(String(line), /^\/[a-z-]+/u, 'the line is a complete slash command')
  })

  test(`v0.24: ${label} NEVER sends an undefined agent — it reports "no session" instead`, async () => {
    const React = stubReact()
    const mod = loadModule(file, React)
    const remote = makeRemote()
    const ctx = makeCtx(remote)

    // No slot props, and a sessions face with no list(): the real no-session state.
    const bridge = mod.__bridgeFactory(ctx, undefined, undefined)
    const reply = await bridge.state()

    assert.equal(remote.calls.length, 0, 'the gateway must never see an invalid agent — that is the reported bug')
    assert.equal(reply.ok, false)
    assert.match(String(reply.text), /没有可用的活动会话|没有可用的活动会话/u, `the reason is stated; got: ${reply.text}`)
    // ...and it must NOT be the opaque gateway error, which told the user nothing.
    assert.equal(String(reply.text).includes('gateway/arguments-invalid'), false)
  })

  test(`v0.24: ${label} surfaces a gateway rejection instead of swallowing it`, async () => {
    const React = stubReact()
    const mod = loadModule(file, React)
    const remote = makeRemote({ reject: true })
    const ctx = makeCtx(remote)
    const slotProps = { useSessions: (selector) => selector({ sessions: [{ id: 's1' }] }) }
    const bridge = mod.__bridgeFactory(ctx, undefined, slotProps)
    const reply = await bridge.state()

    assert.equal(reply.ok, false)
    assert.match(
      String(reply.text),
      /gateway\/arguments-invalid|arguments-invalid/u,
      'the gateway error must reach the user verbatim: it is the only diagnostic they have',
    )
  })
}

// ---------------------------------------------------------------------------
// 2. useSessions shapes that must not crash the resolver
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.24: ${label} tolerates whatever shape useSessions returns`, async () => {
    const React = stubReact()
    const mod = loadModule(file, React)

    const shapes = [
      { name: 'array', value: [{ id: 'a1' }] },
      { name: 'sessions key', value: { sessions: [{ id: 'b1' }] } },
      { name: 'list key', value: { list: [{ id: 'c1' }] } },
      { name: 'string entries', value: ['d1'] },
      { name: 'sessionId field', value: { sessions: [{ sessionId: 'e1' }] } },
      { name: 'empty', value: [] },
      { name: 'null', value: null },
      { name: 'undefined', value: undefined },
      { name: 'garbage', value: { nope: true } },
    ]
    for (const shape of shapes) {
      const remote = makeRemote()
      const ctx = makeCtx(remote)
      const slotProps = { useSessions: (selector) => selector(shape.value) }
      const bridge = mod.__bridgeFactory(ctx, undefined, slotProps)
      // Must not throw, whatever the shape: a crash here blanks the panel.
      const reply = await bridge.state()
      assert.equal(typeof reply.ok, 'boolean', `${file}: shape ${shape.name} produced no result`)
      if (shape.name === 'empty' || shape.name === 'null' || shape.name === 'undefined' || shape.name === 'garbage') {
        assert.equal(remote.calls.length, 0, `${file}: shape ${shape.name} must not invent an agent`)
      }
    }
  })

  test(`v0.24: ${label} survives a useSessions that throws`, async () => {
    const React = stubReact()
    const mod = loadModule(file, React)
    const remote = makeRemote()
    const ctx = makeCtx(remote)
    const slotProps = { useSessions: () => { throw new Error('hook blew up') } }
    const bridge = mod.__bridgeFactory(ctx, undefined, slotProps)
    const reply = await bridge.state()
    assert.equal(reply.ok, false, 'a throwing hook degrades to "no session", not to a crash')
  })
}

// ---------------------------------------------------------------------------
// 3. the panel must not spin forever
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.24: ${label} bounds the fetch with a timeout`, () => {
    // A channel that is mounted but never answers is the failure this guards: the await
    // never settles, so a busy flag never clears and the UI has no way back.
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /withTimeout/u, 'the fetch must be wrapped in a timeout')
    assert.match(source, /12_000|12000/u, 'and the bound must be a concrete number of milliseconds')
  })
}

test('v0.24: the graft panel distinguishes loading from failed', () => {
  const source = readFileSync(join(ROOT, 'dsh-graft-slice/client.js'), 'utf8')
  // "读取中" must be conditional on `busy`, not on the mere absence of data.
  assert.match(source, /busy \? '[^']*读取中/u, 'loading text is gated on an in-flight fetch')
  assert.match(source, /读取失败/u, 'and there is an explicit failed state')
})

test('v0.24: the memory panel distinguishes loading from failed', () => {
  const source = readFileSync(join(ROOT, 'dsh-memory/client.js'), 'utf8')
  // A `phase` value is computed once and read twice, so the two states cannot drift.
  assert.match(source, /phase === 'failed'/u, 'a failed fetch is its own phase')
  assert.match(source, /const phase = /u, 'the phase is derived explicitly')
  assert.match(source, /'loading'/u, 'and loading is a named phase')
  assert.match(source, /未能从宿主读取状态|读取失败/u, 'the failed state says something actionable')
})
