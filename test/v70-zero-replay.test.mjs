/**
 * v7.0 "zero replay" suite: what a target knows when the tape is empty.
 *
 * The premise under test: dropping the replayed turns must not drop the SCENE.
 * A model that gets `recentTurns: 0` reads only the structured blocks, so those
 * blocks have to carry the three things a resumption needs — where the work
 * physically stopped, what the task is, and how to read the rest.
 *
 * Also under test: the cross-generation anchor. After several migrations the
 * read-back index lists only the most recent pointers, so a deep generation
 * cannot see where its constraints came from. An anchor that names the origin is
 * constant-size and survives arbitrarily many hops; relying on the index to still
 * list it does not.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  buildInjectionPlan,
  extractLastStepScene,
  findConstraintProvenance,
  resetRetiredSessions,
} from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

test('v7.0: pending state describes the last concrete step, not just the goal', () => {
  const log = makeSourceLog({ turns: 3 })
  // A failing tool result and a file write: the two facts that make a scene.
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 3, step: 1, callId: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'src/auth.ts', content: 'x' }) },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 3,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'w1' },
        toolCallId: 'w1',
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 3, step: 1, callId: 'c2', name: 'pwsh', arguments: '{"command":"npm test"}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 3,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'c2' },
        toolCallId: 'c2',
        isError: true,
        content: [{ type: 'text', text: 'AssertionError: expected 3 to equal 4' }],
      },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const scene = extractLastStepScene(log.events)
  assert.equal(scene.file, 'src/auth.ts')
  assert.equal(scene.failingTool, 'pwsh', 'the failing tool must be named, not reported as "tool"')
  assert.match(scene.errorText, /AssertionError: expected 3 to equal 4/)

  const plan = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 0 })
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  assert.ok(pending)
  // v0.20: the scene leads the BODY, which the board carries as a note (the file and
  // action are now the 🔄/note material). The property under test is unchanged: with
  // no replayed turn, the last step must still reach the reader.
  assert.match(pending.text, /最后一步我(在)?(写|改) src\/auth\.ts/)
  // v0.20: the error BODY is no longer inlined — the unresolved failure is one line
  // with its seq, so `AssertionError` survives only as that line's text, and `pwsh`
  // as the tool name on it.
  assert.match(pending.text, /唯一未决阻塞.*pwsh/u)
  assert.match(pending.text, /AssertionError/)
})

test('v7.0: pending state points at the goal instead of quoting it', () => {
  const log = makeSourceLog({ turns: 4 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const plan = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 0 })
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  // The goal is a multi-anchor join since P2; quoting it produced a wall of
  // text that read as damaged prose. The pointer form is what survives.
  //
  // v0.20: the board's ⏭️ column carries that pointer, so the assertion moves with
  // it. The property under test is unchanged: the card POINTS at the goal, it does
  // not quote it.
  assert.equal(pending.text.includes('继续推进「'), false)
  assert.match(pending.text, /按上面「(?:这个会话的任务|原始用户要求)」继续推进/)
})

test('v7.3.1: the goal is labelled as the session task, never as the current one', async () => {
  // The live failure: the goal captured the ORIGINAL request (already completed),
  // labelled it "当前要做的事", and the target re-ran that finished research. The
  // next action has exactly one owner — the pending state — so the goal message
  // must not claim to be next.
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-goal-label-'))
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc',
      role: 'user',
      content: [{ type: 'text', text: '帮我研究一下 jet hub 这个插件。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'goal-label-target' }, {})

  const stored = ctx._persistence.read('goal-label-target')
  const goal = stored.events.find((event) => event.type === 'user/message')
  const text = (goal.data.content ?? []).map((block) => block.text ?? '').join('')
  assert.match(text, /这个会话的任务：/)
  assert.equal(text.includes('当前要做的事'), false, 'the goal must not claim to be the current task')
  // And it must not present itself as an assignment with a deadline either.
  assert.equal(text.includes('立刻'), false)
  resetRetiredSessions()
})

test('v7.0: zero replay keeps every structured block', () => {
  const log = makeSourceLog({ turns: 5 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const plan = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 0 })
  const kinds = plan.chunks.map((chunk) => chunk.kind)
  assert.equal(kinds.includes('recent-turn'), false, 'zero replay means zero replay')
  assert.equal(plan.recentInjectedCount, 0)
  // The retrieval surface must still be complete.
  assert.ok(kinds.includes('readback-index'), 'the read-back index is the whole point')
  assert.ok(kinds.includes('pending-state'))
  assert.ok(kinds.includes('old-summary'), 'older turns become an index, not nothing')
  // And it must actually be lighter than the default.
  const heavy = buildInjectionPlan(log, { adaptiveDepth: true, recentTurns: 5 })
  assert.ok(plan.totalTapeChars < heavy.totalTapeChars, 'tier A must be lighter than tier C')
})

test('v7.0: one replayed turn is the whole difference between tiers A and B', () => {
  const log = makeSourceLog({ turns: 5 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const a = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 0 })
  const b = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 1 })
  const c = buildInjectionPlan(log, { adaptiveDepth: true, recentTurns: 5 })

  assert.equal(a.recentInjectedCount, 0)
  assert.equal(b.recentInjectedCount, 1)
  assert.ok(c.recentInjectedCount > 1)
  // Monotonic: more replay never means less total material.
  assert.ok(a.totalTapeChars < b.totalTapeChars)
  assert.ok(b.totalTapeChars < c.totalTapeChars)
})

test('v7.0: constraints survive a second generation instead of being re-derived', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 4 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re 正则库；必须保留 CHECKSUM_42。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  // Generation 1.
  const ctx1 = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx1, {})
  const r1 = await ctx1._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'gen-a' }, {})
  assert.equal(r1.ok, true)
  assert.ok(r1.constraints.length > 0)

  // Generation 2 reads generation 1's log. Before the fix, `extractConstraints`
  // skipped every `plugin:graft-replay` message, so the rules vanished on the
  // first hop — the exact amnesia the anchor is meant to point at.
  const gen1 = ctx1._persistence.read('gen-a')
  const plan2 = buildInjectionPlan({ session: gen1.session, events: gen1.events }, {})
  assert.equal(plan2.constraints.length, r1.constraints.length, 'the rule count must survive the hop')
  assert.equal(
    plan2.constraints.some((line) => line.includes('CHECKSUM_42')),
    true,
    'the rule text must survive verbatim',
  )
  resetRetiredSessions()
})

test('v7.0: the read-back index names where the constraints came from', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 4 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re 正则库。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const ctx1 = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx1, {})
  await ctx1._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'gen-p' }, {})
  const gen1 = ctx1._persistence.read('gen-p')

  const provenance = findConstraintProvenance(gen1.events, 'gen-p', 1)
  assert.ok(provenance, 'a prior constraints block must be locatable')
  assert.equal(provenance.generationsBack, 1)
  assert.ok(Number.isFinite(provenance.seq))

  const plan2 = buildInjectionPlan({ session: gen1.session, events: gen1.events }, {})
  const index = plan2.chunks.find((chunk) => chunk.kind === 'readback-index')
  assert.ok(index)
  assert.match(index.text, /核心约束最早记录在/)
  assert.match(index.text, /gen-p/)
  assert.match(index.text, new RegExp(`seq=${provenance.seq}`))
  resetRetiredSessions()
})

test('v7.0: a first-generation graft has nothing to point back at', () => {
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re 正则库。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  assert.equal(findConstraintProvenance(log.events, 'session-src', 0), undefined)
})
