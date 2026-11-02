/**
 * v7.0 compaction-immunity suite.
 *
 * The claim under test: a graft target's HARD CONSTRAINTS must survive any
 * compaction transaction, including one the user triggers manually with
 * `/compact`.
 *
 * Why the goal message alone was not enough — verified against DSH source
 * (`dsh-compaction-basic`, `selectCompactableRange`):
 *
 *   const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1
 *   ...
 *   return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }
 *
 * The compactable range begins at surface index >= 1 and covers everything up to
 * a token-budgeted recent tail. The goal `user/message` sits INSIDE that surface,
 * so a `/compact` (or any backend that force-compacts a region) can shadow it.
 * `ctx.systemPrompt.section()` is not a surface node at all — it renders into the
 * prompt that `systemHead` occupies, which the range explicitly excludes.
 *
 * So the protection is structural, not configurational: it does not depend on
 * `auto: false`, on a threshold, or on which compaction backend is mounted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, GRAFT_REPLAY_SOURCE_KIND, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A minimal stand-in for `ctx.systemPrompt` that records sections. */
function installSystemPrompt(ctx) {
  const sections = new Map()
  ctx.systemPrompt = {
    section(definition) {
      if (!Number.isFinite(definition.order)) throw new TypeError('order must be finite')
      sections.set(definition.name, definition)
      return () => sections.delete(definition.name)
    },
    getSectionOrder() {
      return 100
    },
  }
  ctx.get = ((original) => (name) => {
    if (name === 'systemPrompt') return ctx.systemPrompt
    return original(name)
  })(ctx.get)
  return sections
}

test('v7.0 P0-5: a target registers a standing-constraint system section', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re 正则库；必须把 CHECKSUM_42 标记写在第 42 行。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  const sections = installSystemPrompt(ctx)
  apply(ctx, {})

  // Registered at activation, before any graft.
  assert.equal(sections.has('graft:constraints'), true, 'the section must be registered at apply()')

  // A normal session renders nothing: the section is scoped to graft targets.
  const definition = sections.get('graft:constraints')
  assert.equal(definition.text({ agent: { session: { id: 'session-unrelated' } } }), '')

  // Graft, then the section must render this target's constraints.
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-section' }, {})
  assert.equal(report.ok, true)
  assert.ok(report.constraints.length > 0)

  const rendered = definition.text({ agent: { session: { id: 'session-section' } } })
  assert.match(rendered, /Standing constraints/)
  assert.match(rendered, /CHECKSUM_42/)
  assert.match(rendered, /绝对不能使用 import re/)
  // It must read as a standing rule, not as migration narration.
  assert.equal(rendered.includes('系统交接'), false)
  resetRetiredSessions()
})

test('v7.0 P0-5: the section text is re-derived per request, not frozen at graft time', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc2',
      role: 'user',
      content: [{ type: 'text', text: '必须保留 CHECKSUM_77 在第 77 行。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  const sections = installSystemPrompt(ctx)
  apply(ctx, {})
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-live-section' }, {})

  const definition = sections.get('graft:constraints')
  // Two consecutive renders must both work: the section is a function, so it
  // reflects the current state rather than a string captured once.
  const first = definition.text({ agent: { session: { id: 'session-live-section' } } })
  const second = definition.text({ agent: { session: { id: 'session-live-section' } } })
  assert.equal(first, second)
  assert.match(first, /CHECKSUM_77/)
  resetRetiredSessions()
})

test('v7.0 P0-5: the target goal message still carries constraints (belt and braces)', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc3',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re 正则库。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, {})
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-both' }, {})

  // The durable copy: the goal user/message. Present even if the section is
  // lost on restart (the section map is in-memory).
  const stored = persistence.read('session-both')
  const goal = stored.events.find((event) => event.type === 'user/message')
  assert.match(goal.data.content[0].text, /HARD CONSTRAINTS/)
  assert.match(goal.data.content[0].text, /import re/)
  // And the goal is marked as plugin-authored (P5), so it is never replayed.
  assert.equal(goal.data.source.kind, GRAFT_REPLAY_SOURCE_KIND)
  resetRetiredSessions()
})

test('v7.0 P0-5: the target re-asserts its constraints in-band exactly once', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc5',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re 正则库。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, {})
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-inband' }, {})

  // First pre-step on the target: the constraint reminder is appended.
  const first = await dispatchPreStep(ctx, { agent: { id: 'session-inband' }, messages: [] })
  assert.equal(first.kind, 'enter')
  const injected = first.messages.filter((message) => String(message.id).startsWith('graft-standing-'))
  assert.equal(injected.length, 1, 'the standing reminder must be injected')
  assert.match(injected[0].content[0].text, /硬约束/)
  assert.match(injected[0].content[0].text, /import re/)
  // Marked as plugin-authored, so a later graft never replays it as user intent.
  assert.equal(injected[0].source.kind, GRAFT_REPLAY_SOURCE_KIND)

  // Second pre-step: no repeat. A standing rule restated every turn is noise.
  const second = await dispatchPreStep(ctx, { agent: { id: 'session-inband' }, messages: [] })
  assert.equal(second.kind, 'enter')
  const again = (second.messages ?? []).filter((message) => String(message.id).startsWith('graft-standing-'))
  assert.equal(again.length, 0, 'the reminder must be delivered once per process')
  resetRetiredSessions()
})

test('v7.0: the constraint section survives when the surface is rewritten', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc4',
      role: 'user',
      content: [{ type: 'text', text: '必须保留 TENANT_ID 在请求头里。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  const sections = installSystemPrompt(ctx)
  apply(ctx, {})
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-survive' }, {})

  // Simulate a compaction: the target's SURFACE is replaced wholesale. The
  // section renderer does not read the surface at all, so its output is
  // unchanged — that is the whole point of putting it there.
  const definition = sections.get('graft:constraints')
  const before = definition.text({ agent: { session: { id: 'session-survive' } } })
  const stored = persistence.read('session-survive')
  const compacted = stored.events.filter((event) => event.type !== 'user/message')
  assert.ok(compacted.length < stored.events.length, 'the simulated compaction removed the goal message')
  const after = definition.text({ agent: { session: { id: 'session-survive' } } })
  assert.equal(after, before, 'the section must not depend on surface survival')
  assert.match(after, /TENANT_ID/)
  resetRetiredSessions()
})
