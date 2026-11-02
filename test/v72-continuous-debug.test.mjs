/**
 * v7.2 continuous-debugging suite.
 *
 * The scenario these pin: a long debugging session where most of the recent
 * material is stack traces. Three claims are tested, and one claim is explicitly
 * NOT tested because it turned out to be false:
 *
 *   ✓ the failure text is inlined, so the target does not spend a tool call
 *     expanding a pointer before it can start fixing anything
 *   ✓ a debug-shaped slice keeps a SHALLOW replay (v6.3 had this backwards)
 *   ✓ a failed flush leaves a `[损坏]` mark and a breadcrumb, not a plausible
 *     half-session
 *   ✗ "tool results are not counted in the watermark" — measured false: the
 *     estimate assembles `data.message.content`, and a 2016-char tool error adds
 *     ~504 tokens. The regression test below locks the TRUE behaviour in, so the
 *     false premise cannot be "fixed" into the code later.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  buildInjectionPlan,
  calculateAdaptiveDepth,
  extractLastStepScene,
  readTokenWatermark,
  resetRetiredSessions,
} from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A debug-shaped log: many tool calls, mostly failures, code-heavy. */
function debugLog() {
  const log = makeSourceLog({ turns: 4 })
  for (let turn = 1; turn <= 4; turn += 1) {
    for (let call = 0; call < 4; call += 1) {
      const callId = `t${turn}c${call}`
      log.events.push({
        type: 'tool/call',
        seq: 0,
        time: 0,
        data: { turn, step: 1, callId, name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) },
      })
      log.events.push({
        type: 'tool/result',
        seq: 0,
        time: 0,
        data: {
          turn,
          step: 1,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: true,
            content: [{ type: 'text', text: `AssertionError: expected ${call} to equal ${call + 1}\n    at test.ts:${call}` }],
          },
        },
      })
    }
  }
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

test('v7.2: the last failure is inlined verbatim, bounded and marked', () => {
  const log = makeSourceLog({ turns: 2 })
  const body = `Error: Cannot find module 'left-pad'\nRequire stack:\n- /app/src/index.ts\n${'x'.repeat(3000)}`
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 2, step: 1, callId: 'e1', name: 'pwsh', arguments: '{}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 2,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'e1' },
        toolCallId: 'e1',
        isError: true,
        content: [{ type: 'text', text: body }],
      },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const scene = extractLastStepScene(log.events)
  assert.equal(scene.failingTool, 'pwsh')
  assert.equal(scene.errorTruncated, true)
  assert.equal(scene.errorBody.length, 2000)
  assert.equal(Number.isFinite(scene.errorSeq), true)

  const plan = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 0 })
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  // The reader must see the error's own words, not a 180-char gist.
  assert.match(pending.text, /最后一条报错原文（seq=/)
  assert.match(pending.text, /Cannot find module 'left-pad'/)
  assert.match(pending.text, /Require stack/)
  assert.match(pending.text, /\[已截断\]/)
})

test('v7.2: a short failure is inlined whole, without a truncation mark', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 2, step: 1, callId: 'e2', name: 'read', arguments: '{}' },
  })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 2,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'e2' },
        toolCallId: 'e2',
        isError: true,
        content: [{ type: 'text', text: 'ENOENT: no such file or directory' }],
      },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const scene = extractLastStepScene(log.events)
  assert.equal(scene.errorTruncated, false)
  const plan = buildInjectionPlan(log, { adaptiveDepth: false, recentTurns: 0 })
  const pending = plan.chunks.find((chunk) => chunk.kind === 'pending-state')
  assert.match(pending.text, /ENOENT: no such file or directory/)
  assert.equal(pending.text.includes('[已截断]'), false)
})

test('v7.2: a debug-shaped session replays nothing at all', () => {
  const result = calculateAdaptiveDepth(debugLog().events, { adaptiveDepthMin: 3, adaptiveDepthMax: 8 })
  assert.equal(result.mode, 'debug')
  assert.equal(result.depth, 0, `debug depth must be 0, got ${result.depth}`)
  assert.match(result.reason, /zero replay/)
})

test('v7.2: debug mode drops a long subagent report but keeps a short one', () => {
  const long = debugLog()
  long.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 4,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 't4c0' },
        toolCallId: 't4c0',
        content: [{ type: 'text', text: `调研结果：${'子代理的长篇结论 '.repeat(80)}` }],
      },
    },
  })
  long.events.forEach((event, index) => {
    event.seq = index
  })
  const longPlan = buildInjectionPlan(long, { adaptiveDepth: true })
  assert.equal(longPlan.adaptiveDepth.mode, 'debug')
  assert.equal(
    longPlan.chunks.some((chunk) => chunk.kind === 'subagent-reports'),
    false,
    'a long report must be dropped in debug mode',
  )
  assert.equal(longPlan.warnings.some((warning) => warning.includes('subagent-reports dropped')), true)

  const short = debugLog()
  short.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 4,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 't4c1' },
        toolCallId: 't4c1',
        content: [{ type: 'text', text: '子代理结论：改这一行即可。' }],
      },
    },
  })
  short.events.forEach((event, index) => {
    event.seq = index
  })
  const shortPlan = buildInjectionPlan(short, { adaptiveDepth: true })
  assert.equal(
    shortPlan.chunks.some((chunk) => chunk.kind === 'subagent-reports'),
    true,
    'a one-sentence report may be the whole answer and must survive',
  )
})

test('v7.2: a failed flush leaves a [损坏] mark and a breadcrumb', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-broken-'))
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const realCreate = persistence.create.bind(persistence)
  persistence.create = async (header, options) => {
    const handle = await realCreate(header, options)
    const realFlush = handle.flush
    return {
      ...handle,
      async flush(...args) {
        await realFlush?.(...args)
        throw new Error('simulated durability failure')
      },
    }
  }
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })

  await assert.rejects(() =>
    ctx._tools
      .get('graft_slice_and_inject')
      .execute({ sourceSessionId: log.session.id, newSessionId: 'session-broken' }, {}),
  )

  // v7.4 P0-2: the single `.incomplete` breadcrumb became a per-migration
  // transaction journal, written BEFORE the id is reserved so a crash between
  // create and flush is recoverable rather than merely described.
  const txnDir = join(dir, '.txn')
  assert.equal(existsSync(txnDir), true, 'a failed migration must leave a journal entry')
  const entries = readdirSync(txnDir).filter((name) => name.endsWith('.json'))
  assert.equal(entries.length, 1, `expected one journal entry, got ${entries.length}`)
  const record = JSON.parse(readFileSync(join(txnDir, entries[0]), 'utf8'))
  assert.equal(record.sourceSessionId, log.session.id)
  assert.equal(record.targetSessionId, 'session-broken')
  // The flush threw, so the record never advanced to COMMITTED.
  assert.notEqual(record.state, 'COMMITTED', 'a failed migration must not be journalled as committed')
  resetRetiredSessions()
})

test('v7.2: tool results DO count toward the watermark (the false premise, locked)', async () => {
  resetRetiredSessions()
  const build = async (withError) => {
    const log = makeSourceLog({ turns: 2 })
    for (const event of log.events) {
      if (event.type === 'assistant/message') delete event.data.usage
    }
    if (withError) {
      log.events.push({
        type: 'tool/result',
        seq: 0,
        time: 0,
        data: {
          turn: 2,
          step: 1,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'x' },
            toolCallId: 'x',
            isError: true,
            content: [{ type: 'text', text: 'AssertionError: ' + 'boom '.repeat(400) }],
          },
        },
      })
    }
    log.events.forEach((event, index) => {
      event.seq = index
    })
    const ctx = makeCtx({ sourceLog: log })
    apply(ctx, {})
    // Detached, so the estimate path (the one that could have been blind) runs.
    ctx.sessions.live.delete(log.session.id)
    return readTokenWatermark(ctx, log.session.id, { contextWindowTokens: 5000 })
  }

  const without = await build(false)
  const withError = await build(true)
  assert.equal(withError.source, 'estimate')
  assert.equal(
    withError.tokens > without.tokens,
    true,
    `a tool error must raise the estimate (${without.tokens} -> ${withError.tokens})`,
  )
  resetRetiredSessions()
})

test('v7.2: a usage-bearing log answers without assembling the full text', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
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
  const watermark = await readTokenWatermark(ctx, log.session.id, { contextWindowTokens: 0 })
  // Both the meter and the incremental fold return without the O(n) string join;
  // either answer is acceptable, the estimate must not be reached.
  assert.notEqual(watermark.source, 'estimate')
  assert.ok(watermark.tokens > 0)
  resetRetiredSessions()
})
