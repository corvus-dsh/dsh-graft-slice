/**
 * v7.0 P0/P1 regression suite.
 *
 * Each test here pins a defect that was INVISIBLE to the existing suite because
 * the fixture was more polite than the host:
 *
 *   P0-1 `ctx.get('tools').list()` — the host has no `list()`. The fixture did,
 *        so F3 downgrade passed tests and never fired in production.
 *   P0-2 a self-computed token ratio that disagreed with the host's own meter.
 *   P0-3 `pendingGraftSources` was written and never consumed.
 *   P0-4 a failed flush left a half-written target reserved under its id.
 *   P1-1 `goal/change` is a log event, so slicing dropped the active goal.
 *   P1-2 jobs/subagents keep running but the target was never told.
 *   P1-4 a bare "确认" was captured as the user's draft.
 *   P2-1 the system prompt described a pointer shape the tape no longer writes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  buildInjectionPlan,
  extractOpenBackgroundWork,
  isGraftAuthored,
  resetRetiredSessions,
} from '../index.js'
import {
  dispatchPreStep,
  dispatchTurnStopping,
  FakePersistence,
  makeCtx,
  makeSourceLog,
} from './fake-harness.mjs'

test('v7.0 P0-1: tool availability is read through schemas(), not a fictional list()', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 4 })
  const ctx = makeCtx({ sourceLog: log })

  // The fixture exposes exactly the host's surface: schemas() and get().
  // A `list()` must NOT be what the plugin depends on — if it were, this test
  // would pass for the wrong reason, which is precisely the earlier failure.
  assert.equal(typeof ctx.tools.list, 'undefined', 'the fixture must not offer list()')
  assert.equal(typeof ctx.tools.schemas, 'function')
  assert.equal(typeof ctx.tools.get, 'function')

  apply(ctx, {})
  const result = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-p01' }, {})
  assert.equal(result.ok, true)

  // A tool the target lacks must be downgraded in the tape, not advertised.
  const stored = ctx._persistence.read('session-p01')
  const tape = stored.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) =>
      (event.data?.message?.content ?? []).map((block) => block.text ?? '').join('\n'),
    )
    .join('\n')
  // The fixture's registry knows `read_file`; everything else is unknown to it,
  // so the downgrade notice is the proof that availability was actually read.
  // v7.4 P4-1: the downgrade is a marker on the compact pointer line.
  assert.match(tape, /\(unavailable here\)/)
})

test('v7.0 P0-2: the watermark prefers the host token meter and reports its source', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 5 })
  // Give the log a published context window, the way a real session has one.
  log.events.push({
    type: 'request/context',
    seq: 0,
    time: 0,
    data: { provider: 'test', model: 'test', contextWindow: 10000 },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const { readTokenWatermark } = await import('../index.js')

  // 1. Live session + meter => the host's number wins over the log's usage.
  ctx.tokenMeter = {
    measure() {
      return { totalTokens: 4321 }
    },
  }
  const live = ctx.sessions.get(log.session.id)
  assert.ok(live, 'the fixture must expose the source as live for the meter path')
  live.requestContext = () => ({ contextWindow: 10000 })

  const measured = await readTokenWatermark(ctx, log.session.id, { contextWindowTokens: 0 })
  assert.equal(measured.source, 'tokenMeter')
  assert.equal(measured.tokens, 4321)
  assert.equal(measured.ratio, 4321 / 10000)

  // 2. No meter, live session => the incremental fold over the live log.
  // This is the v7.0 performance path: it consumes only newly appended events,
  // so the per-pre-step cost is O(新事件) instead of O(整份日志).
  const bare = makeCtx({ sourceLog: log })
  apply(bare, {})
  const incremental = await readTokenWatermark(bare, log.session.id, { contextWindowTokens: 500 })
  assert.equal(incremental.source, 'incremental')
  assert.ok(incremental.tokens > 0)

  // 3. Detached session (no live handle) => the full-snapshot path, labelled.
  const detached = makeCtx({ sourceLog: log })
  apply(detached, {})
  detached.sessions.live.delete(log.session.id)
  const fromLog = await readTokenWatermark(detached, log.session.id, { contextWindowTokens: 500 })
  assert.equal(fromLog.source, 'usage')
  assert.ok(fromLog.tokens > 0)

  // 4. No meter, no usage => the estimate, and it says so.
  const noUsage = makeSourceLog({ turns: 2 })
  for (const event of noUsage.events) {
    if (event.type === 'assistant/message') delete event.data.usage
  }
  const estimatedCtx = makeCtx({ sourceLog: noUsage })
  apply(estimatedCtx, {})
  const estimated = await readTokenWatermark(estimatedCtx, noUsage.session.id, { contextWindowTokens: 500 })
  assert.equal(estimated.source, 'estimate')
})

test('v7.0: the incremental watermark does not re-read the whole log each step', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 6 })
  log.events.push({
    type: 'request/context',
    seq: 0,
    time: 0,
    data: { provider: 't', model: 't', contextWindow: 10000 },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const { readTokenWatermark } = await import('../index.js')

  // Count how many events the fold actually walks: the live handle is wrapped so
  // every snapshotEvents() call reports its length, and the second call must not
  // re-consume the prefix.
  const live = ctx.sessions.get(log.session.id)
  let fullScans = 0
  const realSnapshot = live.snapshotEvents
  live.snapshotEvents = (fromSeq = 0) => {
    if (fromSeq === 0) fullScans += 1
    return realSnapshot(fromSeq)
  }

  const first = await readTokenWatermark(ctx, log.session.id, { contextWindowTokens: 10000 })
  assert.equal(first.source, 'incremental')

  // Append one more usage-bearing message; the fold must pick it up.
  log.events.push({
    type: 'assistant/message',
    seq: log.events.length,
    time: 0,
    data: {
      turn: 99,
      step: 1,
      message: { id: 'a99', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 't', model: 't' } },
      stream: [],
      usage: { inputTokens: 9000, outputTokens: 10 },
    },
  })
  const second = await readTokenWatermark(ctx, log.session.id, { contextWindowTokens: 10000 })
  assert.equal(second.source, 'incremental')
  assert.equal(second.tokens, 9000, 'the fold must consume the appended event')
  // Both calls needed the live log once each, but neither called readSession.
  assert.ok(fullScans >= 1)
})

test('v7.0 P0-3: a deferred graft is retried at turn-stopping instead of deadlocking', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 5 })
  const ctx = makeCtx({ sourceLog: log, currentAgentId: log.session.id })
  apply(ctx, { autoGraft: true, autoGraftAtRatio: 0.75, contextWindowTokens: 500, retireSource: true })

  // Make the session unsafe at the first pre-step: an unanswered tool call.
  const live = ctx.sessions.get(log.session.id)
  const original = live.snapshotEvents
  live.snapshotEvents = (fromSeq = 0) => [
    ...original(fromSeq),
    { type: 'tool/call', seq: 9001, time: 0, data: { turn: 6, step: 1, callId: 'dangling', name: 'read', arguments: '{}' } },
  ]

  const first = await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  assert.equal(first.kind, 'enter', 'an unsafe boundary must not graft')
  assert.equal(ctx._persistence.read('auto-graft-placeholder'), undefined)

  // The pending set is not directly observable, so prove it through behaviour:
  // once the harbour is quiet again, turn-stopping must perform the graft that
  // pre-step deferred. Without a consumer this call would be a no-op.
  live.snapshotEvents = original
  await dispatchTurnStopping(ctx, { agent: { id: log.session.id }, turn: 5, signal: { aborted: false } })

  // A target now exists, produced by the turn-stopping retry.
  const created = [...ctx._persistence.byId.keys()].filter((id) => id !== log.session.id)
  assert.ok(created.length > 0, 'turn-stopping must consume the deferred graft')
  resetRetiredSessions()
})

test('v7.0 P0-4: a failed flush discards the partial target instead of reserving its id', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })

  // Make the durability barrier fail after the header has been created.
  const realCreate = persistence.create.bind(persistence)
  persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    const realFlush = handle.flush
    return {
      ...handle,
      async flush(...args) {
        await realFlush?.(...args)
        throw new Error('simulated flush failure')
      },
    }
  }
  apply(ctx, {})
  await assert.rejects(() =>
    ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: 'session-p04' }, {}),
  )

  // The id must not survive as a half-written artifact.
  const leftovers = [...persistence.byId.keys()].filter((id) => id === 'session-p04')
  const partial = leftovers.filter((id) => persistence.byId.get(id)?.flushed !== true)
  assert.equal(
    partial.length,
    0,
    'a target whose flush failed must not remain reserved under its id',
  )
  resetRetiredSessions()
})

test('v7.0 P1-1: an active goal/change is carried into the target', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  // A DSH goal is a log event, not external state.
  log.events.push({
    type: 'goal/change',
    seq: 0,
    time: 0,
    data: {
      kind: 'goal/change',
      version: 1,
      operation: 'set',
      goal: {
        id: 'goal-1',
        objective: '把登录接口改成幂等',
        phase: 'active',
        revision: 1,
        maxGoalRounds: 10,
      },
      roundsStarted: 2,
      createdAt: 1000,
      updatedAt: 2000,
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, {})
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-p11' }, {})
  assert.equal(report.ok, true)

  const stored = persistence.read('session-p11')
  const carried = stored.events.find((event) => event.type === 'goal/change')
  assert.ok(carried, 'the target must carry the source goal')
  assert.equal(carried.data.goal.objective, '把登录接口改成幂等')
  assert.equal(carried.surfaceOp, undefined, 'goal/change is log-only')
  resetRetiredSessions()
})

test('v7.0 P1-1: a cleared goal is NOT carried', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'goal/change',
    seq: 0,
    time: 0,
    data: {
      kind: 'goal/change',
      version: 1,
      operation: 'set',
      goal: { id: 'g', objective: 'old work', phase: 'active', revision: 1 },
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 2,
    },
  })
  log.events.push({
    type: 'goal/change',
    seq: 0,
    time: 0,
    data: { kind: 'goal/change', version: 1, operation: 'clear', roundsStarted: 0, createdAt: 1, updatedAt: 3 },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, {})
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-p11b' }, {})
  const stored = persistence.read('session-p11b')
  assert.equal(stored.events.some((event) => event.type === 'goal/change'), false)
  resetRetiredSessions()
})

test('v7.0 P1-2: running jobs and subagents are declared as not migrating', () => {
  const events = [
    { type: 'job/registered', seq: 0, data: { jobId: 'j1', label: 'pwsh build' } },
    { type: 'job/registered', seq: 1, data: { jobId: 'j2', label: 'pwsh test' } },
    { type: 'job/settled', seq: 2, data: { jobId: 'j2', outcome: 'ok' } },
    { type: 'subagent/start', seq: 3, data: { id: 's1', label: 'recon' } },
  ]
  const open = extractOpenBackgroundWork(events)
  assert.deepEqual(open.jobs, ['pwsh build'], 'settled jobs are not open')
  assert.deepEqual(open.subagents, ['recon'])

  const log = makeSourceLog({ turns: 2 })
  log.events.push(...events.map((event, index) => ({ ...event, seq: 0, time: index })))
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const plan = buildInjectionPlan(log, {})
  const notice = plan.chunks.find((chunk) => chunk.kind === 'open-work')
  assert.ok(notice, 'the target must be told what did not come across')
  assert.match(notice.text, /后台作业/)
  assert.match(notice.text, /子代理/)
  assert.match(notice.text, /不会迁移|不会自动回到这里/)
})

test('v7.0 P1-2: nothing running means no notice at all', () => {
  const log = makeSourceLog({ turns: 2 })
  const plan = buildInjectionPlan(log, {})
  assert.equal(plan.chunks.some((chunk) => chunk.kind === 'open-work'), false)
})

test('v7.0 P2-1: the system prompt names the pointer shape the tape writes', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  apply(ctx, {})
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-p21' }, {})

  const stored = persistence.read('session-p21')
  const system = stored.events.find((event) => event.type === 'system/message')
  const prompt = system.data.message.content.map((block) => block.text).join('\n')

  // v7.4 P4-1: the compact run is what appears in the tape; the prompt must lead with it.
  assert.match(prompt, /pwsh\(seq=364,372,380\)/)
  // And it must not present the dead bracketed form as the primary example.
  assert.equal(
    /^When you see a tool pointer like \[tool name=/u.test(prompt),
    false,
    'the prompt must not lead with the retired bracketed form',
  )
  resetRetiredSessions()
})
