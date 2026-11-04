/**
 * v0.29 P0 — THE PANEL MUST SURVIVE A HOST THAT NEVER ANSWERS.
 *
 * THE REPORT, four symptoms:
 *   1. the panel entered global mode but every switch was disabled / showed no state;
 *   2. the ledger section stayed on "正在读取…";
 *   3. "读取失败" was shown but NO error card was drawn underneath;
 *   4. (claimed) the plugins were not in the installed list.
 *
 * (4) turned out to be false — `plugin_manager list_plugins` shows both rows enabled and
 * `fiberPhase: active`, so registration was never the problem. Symptoms 1–3 are ONE
 * cause: the fetch failed, `state` stayed null, and everything derived from it looked
 * broken:
 *
 *   - switches were `disabled: !canWrite` with `canWrite = state !== null`;
 *   - the ledger rendered its `state === null` branch forever;
 *   - a failure path returned BEFORE setting an error, so the card's condition
 *     (`error ? … : null`) stayed false while the summary said 读取失败.
 *
 * Three fixes, and this file holds each one:
 *
 *   A. a 3s budget, because 12s is indistinguishable from a hang to a watcher;
 *   B. a REAL fallback state carrying the shipped defaults, tagged `degraded`, so the
 *      panel stays readable and the switches reflect something;
 *   C. an error card keyed on BOTH `error` and `degraded`, drawn as a plain inline-styled
 *      div — a diagnostic must not depend on the styling layer it diagnoses.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

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
  return { React, begin: () => { cursor = 0 }, flush: () => effect }
}

function load(file) {
  const react = stubReact()
  const source = readFileSync(join(ROOT, file), 'utf8')
  let captured
  const require = (name) => {
    if (name === 'react') return react.React
    throw new Error(`unexpected require(${name})`)
  }
  new Function('window', 'require', 'console', `"use strict";\n${source}\n;`)(
    { __ModuleLoader__: { load(d) { captured = d } } }, require, { log() {}, error() {} },
  )
  return { mod: captured.factory(require, { insert: () => () => {} }, undefined), react }
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

/** A bridge whose request NEVER settles — the exact "卡在正在读取" situation. */
function hangingBridge() {
  return {
    sessions: () => [],
    canWrite: () => false,
    state: () => new Promise(() => {}),
    set: () => new Promise(() => {}),
    clear: () => new Promise(() => {}),
  }
}

// ---------------------------------------------------------------------------
// A. the budget is short enough to read as responsive
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.29 P0: ${label} gives the Host THREE seconds, not twelve`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const budget = source.match(/withTimeout\(\s*bridge\.state\([\s\S]*?\),\s*([\d_]+)\s*,/u)
    assert.ok(budget !== null, `${label}: the fetch must go through withTimeout`)
    const ms = Number(String(budget[1]).replace(/_/gu, ''))
    assert.ok(ms > 0 && ms <= 3_000, `${label}: budget must be <= 3s; got ${ms}ms`)
    assert.ok(ms >= 1_000, `${label}: budget must be long enough for a healthy round trip; got ${ms}ms`)
  })
}

// ---------------------------------------------------------------------------
// B. a failed fetch still yields a usable state
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.29 P0: ${label} falls back to REAL default state instead of null`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /function fallbackState\(reason\)/u, 'a fallback state factory must exist')
    assert.match(source, /degraded: true/u, 'and it must be marked degraded')
    assert.match(source, /degradedReason: reason/u, 'carrying the reason for the card')
    // The failure paths must actually USE it, not return with state still null.
    const uses = (source.match(/fallbackState\(reason\)/gu) ?? []).length
    assert.ok(uses >= 2, `every failure path must fall back; found ${uses} use(s)`)
  })

  test(`v0.29 P0: ${label} keeps the switches enabled on the fallback state`, () => {
    // `canWrite` keys off the state object; a degraded state IS an object, so the
    // switches become operable. This is the "有数据但无法点击" deadlock the user hit.
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.match(source, /const canWrite = state !== null && state !== undefined/u,
      'canWrite must be driven by the state object, which the fallback now provides')
  })
}

// ---------------------------------------------------------------------------
// C. the error card is unmissable, and it is raw HTML
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.29 P0: ${label} draws the error card from error OR degraded state`, () => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    // Keyed on both, so a lost error message cannot suppress the card.
    assert.match(source, /error \|\| \(state !== null && state !== undefined && state\.degraded === true\)/u,
      'the card must survive a lost error string')
    // Plain inline styling, not a themed class: a diagnostic must not depend on the
    // styling layer it is diagnosing.
    assert.match(source, /color: '#b91c1c'/u, 'the card must use an inline literal colour')
    assert.match(source, /读取失败/u, 'and be titled so it is unmissable')
  })
}

// ---------------------------------------------------------------------------
// D. behaviour, not just structure: a hanging Host must not deadlock the panel
// ---------------------------------------------------------------------------

for (const [label, file] of [
  ['graft', 'dsh-graft-slice/client.js'],
  ['memory', 'dsh-memory/client.js'],
]) {
  test(`v0.29 P0: ${label} survives a never-settling Host and unlocks its controls`, async () => {
    const { mod, react } = load(file)
    const bridge = hangingBridge()

    // Render once so the effect is captured, then run it (the mount fetch).
    react.begin()
    mod.__panelForTest({ bridge, useSessions: (selector) => selector({ sessions: [] }) })
    const effect = react.flush()
    assert.equal(typeof effect, 'function', `${label}: the panel must register a mount effect`)
    const cleanup = effect()

    // Wait past the 3s budget, then dispose the interval.
    await new Promise((resolve) => setTimeout(resolve, 3_400))
    if (typeof cleanup === 'function') cleanup()

    // Re-render: the fallback state must have landed, so switches exist AND are usable.
    react.begin()
    const tree = expand(mod.__panelForTest({ bridge, useSessions: (selector) => selector({ sessions: [] }) }))
    const switches = collect(tree, 'button').filter((node) => node.props && node.props.role === 'switch')
    assert.ok(switches.length > 0, `${label}: the switches must render`)
    assert.equal(
      switches.some((node) => node.props.disabled === true),
      false,
      `${label}: a degraded state must NOT disable the switches — that is the deadlock the user reported`,
    )

    const card = collect(tree, 'div').filter((node) => node.props && node.props.style && node.props.style.color === '#b91c1c')
    assert.equal(card.length, 1, `${label}: exactly one unmissable error card`)
  })
}
