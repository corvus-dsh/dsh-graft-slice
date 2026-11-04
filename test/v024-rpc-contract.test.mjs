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
        if (agent === undefined || agent === null) {
          throw new Error('{"code":"gateway/arguments-invalid","details":{"endpoint":"commands/execute"}}')
        }
        // v1.0.3: the live contract is the ID STRING (`session/not-found` proves the
        // gateway looked it up); the object shapes are still accepted here so the tests
        // keep describing "any well-formed id", not one specific spelling.
        const id = typeof agent === 'string' ? agent : typeof agent.id === 'string' ? agent.id : typeof agent.agentId === 'string' ? agent.agentId : ''
        if (id.length === 0) {
          throw new Error('{"code":"gateway/input-invalid","details":{"endpoint":"commands/execute","field":"agentId"}}')
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
    // v1.0.2: `via` also names which probed arg shape the host accepted.
    assert.match(String(reply.via), /^remote\.commands\.execute\(/u)
    assert.equal(remote.calls.length, 1, 'exactly one execute call — the working shape is remembered')
    const { agent, line } = remote.calls[0]
    // v1.0.3: the id may arrive as a bare string (the accepted contract) or wrapped; what
    // matters is WHICH session it names.
    const usedId = typeof agent === 'string' ? agent : agent.id
    assert.equal(usedId, 'session-live-2', 'the MOST RECENT live session is used')
    assert.match(String(line), /^\/[a-z-]+/u, 'the line is a complete slash command')
  })

  /**
   * v0.28 REVISION.
   *
   * v0.24 asserted that NOTHING is sent without an agent, and that the panel reports
   * "no session". That was correct against the v0.24 gateway failure, and it became the
   * v0.28 defect: the panel then refused the GLOBAL data too, and sat empty forever.
   *
   * The rule that survives is narrower and better: the gateway must never receive an
   * INVALID agent. A shape-valid placeholder for a session-independent command is fine;
   * `undefined` is not.
   */
  test(`v0.28: ${label} never sends an INVALID agent — it substitutes a shape-valid one for global reads`, async () => {
    const React = stubReact()
    const mod = loadModule(file, React)
    const remote = makeRemote()
    const ctx = makeCtx(remote)

    // No slot props, and a sessions face with no list(): the real no-session state.
    const bridge = mod.__bridgeFactory(ctx, undefined, undefined)
    const reply = await bridge.state()

    assert.equal(remote.calls.length, 1, 'a global read must go out; refusing it empties the panel')
    const agent = remote.calls[0].agent
    assert.ok(agent !== undefined && agent !== null, 'an undefined agent must NEVER reach the gateway')
    const placeholderId = typeof agent === 'string' ? agent : agent.id
    assert.equal(typeof placeholderId, 'string', 'the placeholder must satisfy the id contract')
    assert.ok(String(placeholderId).length > 0, 'and not be an empty string')
    assert.equal(reply.ok, true, 'so the Host answer is actually surfaced')
    assert.equal(String(reply.text).includes('没有可用的活动会话'), false, 'the dead-end message must be gone')
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
  test(`v0.28: ${label} tolerates whatever shape useSessions returns`, async () => {
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
      // Whatever the shape, whenever a request DID go out it carried a non-empty id
      // (v1.0.3: a bare string is the accepted contract; the object shapes are tolerated).
      for (const call of remote.calls) {
        const sentId = typeof call.agent === 'string' ? call.agent : call.agent && call.agent.id
        assert.ok(typeof sentId === 'string' && sentId.length > 0,
          `${file}: shape ${shape.name} sent an invalid agent`)
      }
    }
  })

  test(`v0.28: ${label} survives a useSessions that throws`, async () => {
    const React = stubReact()
    const mod = loadModule(file, React)
    const remote = makeRemote()
    const ctx = makeCtx(remote)
    const slotProps = { useSessions: () => { throw new Error('hook blew up') } }
    const bridge = mod.__bridgeFactory(ctx, undefined, slotProps)
    // A throwing hook must degrade to "no session", and the global read must still work.
    const reply = await bridge.state()
    assert.equal(typeof reply.ok, 'boolean', 'a throwing hook must not break the panel')
    for (const call of remote.calls) {
      const sentId = typeof call.agent === 'string' ? call.agent : call.agent && call.agent.id
      assert.ok(typeof sentId === 'string' && sentId.length > 0, 'and must not emit an invalid agent')
    }
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
    // v0.29: the budget is 3s. The assertion pins that the bound is CONCRETE and SHORT
    // enough to read as responsive — 12s was indistinguishable from a hang to anyone
    // watching the panel.
    assert.match(source, /withTimeout\(\s*bridge\.state\([^)]*\)\s*,\s*(\d[\d_]*)\s*,/u,
      'the fetch must be called through withTimeout with an explicit budget')
    const budget = source.match(/withTimeout\(\s*bridge\.state\([^)]*\)\s*,\s*([\d_]+)\s*,/u)
    assert.ok(budget !== null, 'the budget must be readable from the source')
    const ms = Number(String(budget[1]).replace(/_/gu, ''))
    assert.ok(ms > 0 && ms <= 5_000, `the budget must be short (<= 5s) so it cannot read as a hang; got ${ms}ms`)
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
