/**
 * v0.9.3 — THE HARBOUR'S TIME DIMENSION.
 *
 * ── THE DEFECT (found by the third-party report, confirmed in source) ─────────────────────────────
 *
 * `checkSafeHarbor` was purely structural: `openCalls` was a `Set<string>` of ids, so "a `tool/call`
 * with no `tool/result`" held the harbour closed with no notion of how long. Measured consequence: it is
 * NOT a deadlock while the user is active (`turn-stopping` and `pendingGraftSources` still fire). It is
 * what happens after the session goes QUIET — nothing re-triggers the check, so that session sits above
 * the watermark permanently and never migrates.
 *
 * These tests pin BOTH halves of the fix and, equally important, pin that the OLD behaviour is intact
 * when no limit is configured:
 *
 *   1. no `time` fields at all  → `safe:false`, age 0  (the pre-existing behaviour, unchanged)
 *   2. a fresh dangling call    → `safe:false`, age small
 *   3. an OLD dangling call     → `safe:true`,  reason names the age and the limit
 *   4. limit 0 / Infinity       → the limit is OFF and behaviour is exactly the old one
 *   5. the age comes from the LOG, not a wall clock — the same event list always gives the same answer
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { checkSafeHarbor } from '../index.js'

const T0 = 1_700_000_000_000

/** A dangling call: `tool/call` with no matching `tool/result`. */
const dangling = (time) => [
  { type: 'turn/start', seq: 0, time: time - 1000, data: { turn: 1 } },
  { type: 'tool/call', seq: 1, time, data: { name: 'pwsh', callId: 'call-1' } },
  // A later event supplies the "now" the age is measured against.
  { type: 'assistant/chunk', seq: 2, time, data: {} },
]

test('v0.9.3: a log with NO time fields keeps the old verdict and reports age 0', () => {
  /**
   * THE BACKWARD-COMPATIBILITY ASSERTION. Every pre-existing fixture omits `time`; if this changed,
   * dozens of tests would still pass while real behaviour shifted. `latestTime` stays 0, so the age is 0,
   * so an active limit cannot expire anything that has no clock.
   */
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'tool/call', seq: 1, data: { name: 'pwsh', callId: 'call-1' } },
  ]
  const harbor = checkSafeHarbor(events, { openCallMaxAgeMs: 1 })
  assert.equal(harbor.safe, false, 'no clock ⇒ no age ⇒ the dangling call still holds the harbour')
  assert.equal(harbor.openCallAgeSeconds, 0)
  assert.match(harbor.reason, /awaiting a result/u)
})

test('v0.9.3: a FRESH dangling call is unsafe', () => {
  const harbor = checkSafeHarbor(dangling(T0), { openCallMaxAgeMs: 600_000 })
  assert.equal(harbor.safe, false)
  assert.equal(harbor.openCallAgeSeconds, 0, 'the newest event is the call itself, so its age is 0')
})

test('v0.9.3: an OLD dangling call EXPIRES the wait, with the age in the reason', () => {
  /**
   * 20 minutes of silence after a call that never returned, against a 10-minute limit.
   *
   * This is the case the fix exists for: without it, this session never migrates again.
   */
  const events = dangling(T0)
  events.push({ type: 'turn/end', seq: 3, time: T0 + 20 * 60 * 1000, data: { turn: 1 } })

  const harbor = checkSafeHarbor(events, { openCallMaxAgeMs: 10 * 60 * 1000 })
  assert.equal(harbor.safe, true, 'past the limit, stop waiting')
  assert.equal(harbor.openCallAgeSeconds, 1200, '20 minutes, in seconds')
  assert.match(harbor.reason, /超龄 1200 秒/u, 'the reason names the age a reader needs')
  assert.match(harbor.reason, /上限 600 秒/u, 'and the limit it exceeded')
  assert.match(harbor.reason, /1 个 tool call 仍未返回/u, 'and how many are still outstanding')
})

test('v0.9.3: the limit is OFF for 0 and Infinity — old behaviour, exactly', () => {
  const events = dangling(T0)
  events.push({ type: 'turn/end', seq: 3, time: T0 + 20 * 60 * 1000, data: { turn: 1 } })

  for (const openCallMaxAgeMs of [0, Number.POSITIVE_INFINITY, -1]) {
    const harbor = checkSafeHarbor(events, { openCallMaxAgeMs })
    assert.equal(harbor.safe, false, `limit ${String(openCallMaxAgeMs)} must not expire anything`)
    assert.equal(harbor.openCallAgeSeconds, 1200, 'the age is still REPORTED even when the limit is off')
    assert.match(harbor.reason, /awaiting a result/u)
  }
})

test('v0.9.3: no limit option at all ⇒ old behaviour (the default callers keep)', () => {
  const events = dangling(T0)
  events.push({ type: 'turn/end', seq: 3, time: T0 + 20 * 60 * 1000, data: { turn: 1 } })
  const harbor = checkSafeHarbor(events)
  assert.equal(harbor.safe, false, 'a caller that passes no options sees what it always saw')
})

test('v0.9.3: the age is deterministic — same list, same answer (no wall clock)', () => {
  const events = dangling(T0)
  events.push({ type: 'turn/end', seq: 3, time: T0 + 20 * 60 * 1000, data: { turn: 1 } })
  const first = checkSafeHarbor(events, { openCallMaxAgeMs: 1 })
  const second = checkSafeHarbor(events, { openCallMaxAgeMs: 1 })
  assert.deepEqual(first, second, 'a pure function must not consult Date.now()')
})

test('v0.9.3: a resolved call reports age 0 and stays safe', () => {
  const events = [
    { type: 'tool/call', seq: 0, time: T0, data: { callId: 'call-1' } },
    { type: 'tool/result', seq: 1, time: T0 + 1000, data: { message: { toolCallId: 'call-1' } } },
    { type: 'turn/end', seq: 2, time: T0 + 20 * 60 * 1000, data: { turn: 1 } },
  ]
  const harbor = checkSafeHarbor(events, { openCallMaxAgeMs: 1000 })
  assert.equal(harbor.safe, true)
  assert.equal(harbor.openCallAgeSeconds, 0, 'nothing is open, so there is no age to report')
  assert.equal(harbor.reason, 'quiet boundary')
})
