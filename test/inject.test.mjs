import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  apply,
  getRetiredSessions,
  graftReadResult,
  graftSliceAndInject,
  isRetired,
  resetRetiredSessions,
  TURN_STOPPING_EVENT,
} from '../index.js'
import {
  dispatchPreStep,
  FakePersistence,
  makeCtx,
  makeSourceLog,
} from './fake-harness.mjs'

function setup({ turns = 7, config = {} } = {}) {
  resetRetiredSessions()
  const sourceLog = makeSourceLog({ turns })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog, persistence })
  apply(ctx, config)
  return { ctx, persistence, sourceLog }
}

test('phase 3/4: creates a durable detached session and enforces every red line', async () => {
  const { ctx, persistence, sourceLog } = setup()
  const sourceId = sourceLog.session.id
  const newId = 'session-graft-1'
  const tool = ctx._tools.get('graft_slice_and_inject')
  assert.equal(typeof tool?.execute, 'function', 'tool definition exists')

  const report = await tool.execute({ sourceSessionId: sourceId, newSessionId: newId }, {})
  assert.equal(report.ok, true)
  assert.equal(report.sourceSessionId, sourceId)
  assert.equal(report.newSessionId, newId)
  assert.equal(report.durability.attached, true)
  assert.equal(report.durability.verified, true)
  assert.equal(report.durability.barrier, 'sessionPersistence.handle.flush')
  assert.equal(report.retired.source, true)
  assert.equal(report.injected.system, 1)
  assert.equal(report.injected.goal, 1)
  assert.equal(report.injected.title, 1)
  assert.equal(report.injected.tape, report.adaptiveDepth.depth)
  assert.equal(report.injected.pending, 1)
  // v6.3: total = system + goal + title + every adaptive chunk.
  // v7.0: the report now breaks out every block kind, so the parts sum to the total.
  assert.equal(
    report.injected.total,
    3 +
      report.injected.oldSummary +
      report.injected.taskStatus +
      report.injected.subagentReports +
      report.injected.tape +
      report.injected.pending +
      report.injected.workspaceFiles +
      report.injected.openTurn +
      report.injected.omittedTurns +
      report.injected.readback,
  )
  assert.equal(report.turns, 7)
  assert.equal(report.workspace.attached, true)
  assert.equal(report.workspace.id, 'ws-test')
  assert.deepEqual(ctx._attachedSessions, [newId])
  // v7.0: the fixture now carries provider usage, which the adaptive-depth
  // heuristic reads. The window is 4 turns out of 7, so the fixture's single
  // tool call (turn 1) sits in the OLDER span and is counted there.
  assert.equal(report.pointers.total, 1)
  assert.equal(report.pointers.recent, 0)
  assert.equal(report.pointers.older, 1)

  // No live-store pollution: the artifact is prepared, persisted, and resumable.
  assert.equal(ctx.sessions.get(newId), undefined)
  assert.equal(ctx.sessions.createCalls.length, 0)
  assert.equal(ctx.sessions.flushCalls, 0)
  assert.deepEqual(persistence.order, ['create', 'append', 'flush', 'close'])
  assert.equal(persistence.createCalls.length, 1)
  assert.equal(persistence.createCalls[0].options.inheritedEventCount, 0)
  // Compare against the events actually written instead of a hardcoded count;
  // adaptive depth changes how many chunks exist, not how they are structured.
  const writtenCount = persistence.appendCalls[0].count
  const stored0 = persistence.read(newId)
  assert.equal(writtenCount, stored0.events.length)
  assert.equal(persistence.flushCalls, 1)
  assert.equal(persistence.closeCalls, 1)

  const stored = persistence.read(newId)
  assert.equal(stored.inheritedEventCount, 0)
  assert.equal(stored.session.cwd, sourceLog.session.cwd)
  const types = stored.events.map((event) => event.type)
  assert.deepEqual(types.slice(0, 4), ['turn/start', 'step/start', 'system/message', 'user/message'])
  assert.equal(types[4], 'session/title')
  // The skeleton closes before the runtime-intent knobs, which DSH also writes
  // after the turn so they stay log-only.
  assert.deepEqual(types.slice(-3), ['step/end', 'turn/end', 'permission/preset'])
  assert.equal(types.includes('tool/result'), false)

  const titleEvent = stored.events.find((event) => event.type === 'session/title')
  // v6.1: the title carries an id tail so two targets of one source stay
  // distinguishable in the sidebar (identical titles made the second look lost).
  // v7.0 P2: the goal now joins the last three substantive messages, oldest
  // first, so the title head comes from the OLDEST anchor in that window — the
  // one that states the task rather than the correction on top of it.
  assert.match(titleEvent.data.title, /^\[接续\] 你是一个资深 DSH 插件开发者。/)
  assert.match(titleEvent.data.title, /· raft-1$/)
  assert.equal(titleEvent.surfaceOp, undefined)
  // v7.3 CRITICAL: the host's v4 validator requires empty `messageSeqs` to pair
  // with `source.kind: 'user'`, and any cited seq to be an EARLIER HUMAN message.
  // A target has no human message (its only user/message is the plugin-authored
  // goal), so the title must cite nothing and declare a user source. The previous
  // expectation — `messageSeqs: [3]` with `kind: 'fallback'` — was the shape that
  // made every graft target unopenable in the live store.
  assert.deepEqual(titleEvent.data.messageSeqs, [])
  assert.equal(titleEvent.data.source.kind, 'user')

  const surfaceEvents = stored.events.filter((event) =>
    ['system/message', 'user/message', 'assistant/message'].includes(event.type),
  )
  assert.equal(surfaceEvents[0].type, 'system/message', 'the first surface event must be system/message')

  const skeleton = stored.events.filter((event) =>
    ['turn/start', 'step/start', 'step/end', 'turn/end'].includes(event.type),
  )
  for (const event of skeleton) {
    assert.equal('surfaceOp' in event, false, `${event.type} must not carry surfaceOp`)
    assert.equal('sourceEventSeqs' in event, false, `${event.type} must not carry sourceEventSeqs`)
  }

  const messages = stored.events.filter(
    (event) => event.type === 'system/message' || event.type === 'user/message' || event.type === 'assistant/message',
  )
  for (const event of messages) {
    assert.equal(event.surfaceOp, 'append', `${event.type} must be append`)
    if (event.type === 'system/message') {
      assert.equal(event.data.message.role, 'system')
      assert.equal(event.data.message.source.kind, 'system-prompt')
      const prompt = event.data.message.content.map((block) => block.text).join('\n')
      // v7.0 P2-1: the prompt must describe the pointers the tape ACTUALLY
      // writes. v6.x pointed at the bracketed `[tool name=… expand_result(…)]`
      // form, which the humanized recollection replaced — an instruction that
      // described a shape appearing nowhere in the injected history.
      // v7.4 P4-1: the tape writes compact runs; the prompt must lead with THAT.
      assert.match(prompt, /pwsh\(seq=364,372,380\)/)
      assert.match(prompt, /call graft_read_result\(sourceSessionId, seq\)/)
      // The legacy forms are still named, so an older tape still matches.
      assert.match(prompt, /\[tool name=xx seq=YY\]/)
      assert.match(prompt, /（回顾：…）/)
      assert.match(prompt, /NEVER guess or fabricate a tool result/)
      assert.match(prompt, /Do NOT read the source session log directly via shell or other tools unless graft_read_result fails\./)
      assert.match(prompt, /SetNamedSecurityInfoW failed/)
      assert.match(prompt, /danger-full-access/)
    }
    if (event.type === 'assistant/message') {
      assert.equal('sourceEventSeqs' in event, false)
      assert.deepEqual(event.data.stream, [])
      assert.equal(event.data.turn, 1)
      assert.equal(event.data.step, 1)
      assert.notEqual(event.data.message.source.kind, 'plugin')
      assert.equal('replayState' in event.data.message.source, false)
    }
  }

  const goal = stored.events.find((event) => event.type === 'user/message')
  // v7.0 B4: the seed must read as a continuation, not as a handoff notice.
  const seedText = goal.data.content[0].text
  assert.equal(seedText.includes('persistent-capability-seed'), false)
  assert.equal(seedText.trimStart().startsWith('{'), false)
  assert.equal(seedText.includes('**'), false, 'no markdown scaffolding')
  // The acceptance criterion is "looks like a continuous conversation, not an
  // outline". A preamble about being relocated is the largest source of
  // outline-ness, so none of these may appear.
  assert.equal(seedText.includes('【系统交接】'), false, 'no handoff narration')
  assert.equal(seedText.includes('系统安全接管'), false)
  assert.equal(seedText.includes('不必从头开始'), false)
  assert.equal(seedText.includes('复述这段说明'), false)
  // What it says instead: where the work lives, what to do, where the rest is.
  assert.match(seedText, /工作目录 /)
  assert.match(seedText, /这个会话的任务/)
  assert.equal(seedText.includes(sourceId), true)
  // v7.0 A4: the seed names the newest intent, so a target resumed days later
  // acts on what the user last asked for rather than the opening brief.
  assert.equal(seedText.includes('补上测试和冷恢复验证'), true)
  assert.equal(seedText.includes(sourceLog.session.cwd), true)

  // Top-level lineage: the new header must not carry subagent identity.
  assert.equal(stored.session.parentSession, undefined)
  assert.equal(stored.session.origin, undefined)
  assert.equal(stored.session.delegationDepth ?? 0, 0)
  assert.equal(stored.session.isSeeded, false)

  // v7.0 A3: older turns collapse to a metadata index rather than prose.
  const oldSummary = stored.events.find(
    (event) => event.type === 'assistant/message' && event.data.message.content[0].text.startsWith('[历史片段索引]'),
  )
  assert.ok(oldSummary, 'the older-turn index must be injected')
  const summaryText = oldSummary.data.message.content[0].text
  assert.match(summaryText, /\[历史片段: Turn 1-/)
  assert.match(summaryText, /graft_read_result/)
  // The old span is turns 1-3 and does contain the fixture's single tool call,
  // so the index names the tool it used. (An earlier revision dropped the
  // downgraded `历史记录：…` pointer shape from the scan, which made this line
  // claim "no tools" while 342 pointers existed.)
  assert.match(summaryText, /涉及工具: read_file/)
  assert.equal(summaryText.includes('[tool name=read_file seq='), false)
  // It must stay small: the whole point is to spend the budget on recent turns.
  assert.ok(summaryText.length < 400, `index should stay tiny, got ${summaryText.length}`)

  // Retirement is in memory and rejects the source at the pre-step waterfall.
  assert.equal(isRetired(sourceId), true)
  assert.equal(getRetiredSessions().has(sourceId), true)
  const rejected = await dispatchPreStep(ctx, { agent: { id: sourceId }, messages: [] })
  assert.equal(rejected.kind, 'reject')
  assert.match(rejected.reason, /已转移至新会话/)
  const allowed = await dispatchPreStep(ctx, { agent: { id: 'session-other' }, messages: [] })
  assert.equal(allowed.kind, 'enter')
})

test('phase 3/4: retireSource:false keeps the source live', async () => {
  const { ctx, sourceLog } = setup({ config: { retireSource: false } })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-2' }, {})
  assert.equal(report.retired.source, false)
  assert.equal(isRetired(sourceLog.session.id), false)
  const decision = await dispatchPreStep(ctx, { agent: { id: sourceLog.session.id }, messages: [] })
  assert.equal(decision.kind, 'enter')
})

test('phase 1: the running turn is trimmed, not refused, so an in-turn call works', async () => {
  const { ctx, persistence, sourceLog } = setup({ turns: 2 })
  // The caller is always inside its own open turn; that must not block the tool.
  sourceLog.events.push({ type: 'turn/start', seq: sourceLog.events.length, time: Date.now(), data: { turn: 3 } })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-open' }, {})
  assert.equal(report.ok, true)
  assert.equal(report.turns, 2, 'only the closed turns are sliced')
  assert.equal(persistence.createCalls.length, 1)
})

test('phase 1: refuses a source without an absolute cwd', async () => {
  const { ctx, persistence, sourceLog } = setup({ turns: 2 })
  sourceLog.session.cwd = undefined
  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-cwd' }, {}),
    /MISSING_CWD/,
  )
  assert.equal(persistence.createCalls.length, 0)
})

test('phase 3: refuses a duplicate live or persisted target id', async () => {
  const { ctx, persistence, sourceLog } = setup({ turns: 2 })

  ctx.sessions.live.set('session-graft-live', { id: 'session-graft-live' })
  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-live' }, {}),
    /SESSION_EXISTS/,
  )

  await persistence.create(
    { version: 4, id: 'session-graft-stored', createdAt: Date.now(), cwd: sourceLog.session.cwd, isSeeded: false },
    { inheritedEventCount: 0 },
  )
  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-stored' }, {}),
    /SESSION_EXISTS/,
  )
})

test('phase 3: refuses source and target being identical', async () => {
  const { ctx, sourceLog } = setup({ turns: 2 })
  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: sourceLog.session.id, newSessionId: sourceLog.session.id }, {}),
    /SAME_SESSION/,
  )
})

test('phase 4: fails closed when sessionPersistence is not mounted', async () => {
  const { ctx, sourceLog } = setup({ turns: 2 })
  const original = ctx.get
  ctx.get = (name) => (name === 'sessionPersistence' ? undefined : original.call(ctx, name))
  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-no-persistence' }, {}),
    /PERSISTENCE_REQUIRED/,
  )
})

test('phase 4 fallback: reads a tool result and reports a missing seq', async () => {
  const { ctx, sourceLog } = setup({ turns: 2 })
  const resultEvent = sourceLog.events.find((event) => event.type === 'tool/result')
  const found = await graftReadResult(ctx, sourceLog.session.id, Number(resultEvent.seq))
  assert.equal(found.found, true)
  assert.equal(found.text, 'SESSION API VERIFIED: prepare/create/append/flush')
  assert.equal(found.truncated, false)

  const missing = await graftReadResult(ctx, sourceLog.session.id, 99999)
  assert.deepEqual(missing, { found: false, seq: 99999, text: null, truncated: false, totalChars: 0 })

  const viaTool = await ctx._tools
    .get('graft_read_result')
    .execute({ sourceSessionId: sourceLog.session.id, seq: Number(resultEvent.seq) }, {})
  assert.equal(viaTool.found, true)
  assert.equal(viaTool.text.includes('SESSION API VERIFIED'), true)
})

test('phase 4 fallback: truncates a large result when a cap is supplied', async () => {
  const { ctx, sourceLog } = setup({ turns: 1 })
  const resultEvent = sourceLog.events.find((event) => event.type === 'tool/result')
  const found = await graftReadResult(ctx, sourceLog.session.id, Number(resultEvent.seq), 10)
  assert.equal(found.truncated, true)
  assert.equal(found.text.length, 10)
  assert.equal(found.totalChars > 10, true)
})

test('phase 3: refuses a prepared header with subagent lineage', async () => {
  const { ctx, persistence, sourceLog } = setup({ turns: 2 })
  const originalPrepare = ctx.sessions.prepare.bind(ctx.sessions)
  ctx.sessions.prepare = (id, options) => {
    const session = originalPrepare(id, options)
    session.header.parentSession = 'session-parent'
    return session
  }
  await assert.rejects(
    () =>
      ctx._tools
        .get('graft_slice_and_inject')
        .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-lineage' }, {}),
    /GRAFT_ERROR: lineage must be empty/,
  )
  assert.equal(persistence.createCalls.length, 0)
})

test('phase 4: persists retirement IDs and reloads them after restart', async () => {
  const { ctx, sourceLog } = setup({ turns: 2 })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-graft-retired' }, {})
  const file = join(ctx.paths.data, '.retired.json')
  const ids = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Array.isArray(ids), true)
  assert.equal(ids.includes(sourceLog.session.id), true)

  resetRetiredSessions()
  const ctx2 = makeCtx({ sourceLog, paths: { data: ctx.paths.data } })
  apply(ctx2, {})
  const decision = await dispatchPreStep(ctx2, { agent: { id: sourceLog.session.id }, messages: [] })
  assert.equal(decision.kind, 'reject')
  assert.match(decision.reason, /已转移至新会话/)
})

test('hooks: registers the pre-step and turn-stopping listeners', () => {
  const { ctx } = setup({ turns: 1 })
  assert.equal((ctx._listeners.get('agent/pre-step') ?? []).length, 1)
  assert.equal((ctx._listeners.get(TURN_STOPPING_EVENT) ?? []).length, 1)
  const listener = ctx._listeners.get(TURN_STOPPING_EVENT)[0]
  assert.doesNotThrow(() => listener({ agent: { id: 'session-x' }, turn: 1 }, async () => undefined))
})

test('phase 3: verifies the cold-read structure via the query path', async () => {
  const { ctx, sourceLog } = setup({ turns: 3 })
  const report = await graftSliceAndInject(ctx, {}, sourceLog.session.id, 'session-graft-cold', undefined)
  assert.equal(report.durability.verified, true)
  const cold = await ctx.sessionQuery.readSession('session-graft-cold')
  assert.equal(cold.inheritedEventCount, 0)
  assert.equal(cold.events[0].type, 'turn/start')
  assert.equal(cold.events[0].data.turn, 1)
  assert.equal(cold.events[1].data.step, 1)
})
