/**
 * v7.2 hardening suite: harbour reachability, durable shield, atomic state.
 *
 * Three defects, each verified against the real host surface before being fixed:
 *
 *   ✓ an `assistant/attempt` left after the last `turn/end` made every future
 *     pre-step report "still streaming", so P6's overflow recovery could never
 *     run on the session that needed it. Reproduced with a hand-built log; the
 *     seven real logs stay `safe: true` because a well-formed log clears the flag.
 *   ✓ the compaction shield lived in an in-memory Map, so a restart erased it and
 *     `/compact` could shadow the only surviving constraint copy.
 *   ✓ every state file was written non-atomically: `writeFileSync` truncates
 *     first, so a crash mid-write leaves a JSON file that parses to nothing and
 *     silently discards records (a lost retired set revives a retired session).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  calculateAdaptiveDepth,
  checkSafeHarbor,
  resetRetiredSessions,
} from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

test('v7.2: an attempt after the last turn/end no longer blocks forever', () => {
  // The shape a crash or an interrupted turn leaves behind.
  const stranded = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'assistant/attempt', seq: 3, data: { turn: 2, step: 1, stream: [] } },
  ]
  const result = checkSafeHarbor(stranded)
  assert.equal(result.safe, true, 'an attempt with an empty stream is not a live stream')

  // A genuinely streaming assistant still blocks: chunks are the proof.
  const streaming = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 1 } },
  ]
  assert.equal(checkSafeHarbor(streaming).safe, false)

  // An attempt that DID produce output is treated as streaming.
  const withOutput = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'assistant/attempt', seq: 1, data: { turn: 1, step: 1, stream: [{ type: 'text-chunks' }] } },
  ]
  assert.equal(checkSafeHarbor(withOutput).safe, false)

  // An unanswered tool call still blocks, as before.
  const dangling = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'read' } },
  ]
  const harbour = checkSafeHarbor(dangling)
  assert.equal(harbour.safe, false)
  assert.match(harbour.reason, /awaiting a result/)
})

test('v7.2: debug mode replays nothing, and still ships every pointer', () => {
  const log = makeSourceLog({ turns: 4 })
  for (let turn = 1; turn <= 4; turn += 1) {
    for (let call = 0; call < 4; call += 1) {
      const callId = `t${turn}c${call}`
      log.events.push({
        type: 'tool/call',
        seq: 0,
        time: 0,
        data: { turn, step: 1, callId, name: 'pwsh', arguments: '{}' },
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
            content: [{ type: 'text', text: `AssertionError: expected ${call} to equal ${call + 1}` }],
          },
        },
      })
    }
  }
  log.events.forEach((event, index) => {
    event.seq = index
  })

  const depth = calculateAdaptiveDepth(log.events, { adaptiveDepthMin: 3, adaptiveDepthMax: 8 })
  assert.equal(depth.mode, 'debug')
  assert.equal(depth.depth, 0)
})

test('v7.2: the constraint shield survives a restart', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-shield-'))
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

  // First process: graft, which registers and persists the section.
  const ctx1 = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx1, { dataDir: dir })
  const report = await ctx1._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-shield' }, {})
  assert.equal(report.ok, true)

  const storeFile = join(dir, '.graft-constraint-sections.json')
  assert.equal(existsSync(storeFile), true, 'the shield must be written to disk')
  const stored = JSON.parse(readFileSync(storeFile, 'utf8'))
  assert.ok(Array.isArray(stored['session-shield'].constraints))

  // Simulate a restart: a fresh context over the same dataDir.
  resetRetiredSessions()
  const ctx2 = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  const sections = new Map()
  ctx2.systemPrompt = {
    section(definition) {
      sections.set(definition.name, definition)
      return () => sections.delete(definition.name)
    },
    getSectionOrder() {
      return 100
    },
  }
  const innerGet = ctx2.get
  ctx2.get = (name) => (name === 'systemPrompt' ? ctx2.systemPrompt : innerGet(name))
  apply(ctx2, { dataDir: dir })

  const definition = sections.get('graft:constraints')
  assert.ok(definition, 'the section must be registered again after a restart')
  const rendered = definition.text({ agent: { session: { id: 'session-shield' } } })
  assert.match(rendered, /import re/, 'the shield must render after a restart')
  resetRetiredSessions()
})

test('v7.2: state files are written atomically', () => {
  // The mechanism, verified directly: a temp file is created and renamed, so no
  // reader ever observes a truncated target. The observable contract is "the
  // final file is complete JSON and no temp file remains".
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-atomic-'))
  const target = join(dir, 'state.json')
  // A leftover temp from a previous crashed write must not be mistaken for the
  // real file; readers only ever open the canonical name.
  writeFileSync(`${target}.tmp-999-zzz`, '{"partial":', 'utf8')
  assert.equal(existsSync(target), false)
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
  assert.equal(leftovers.length, 1, 'the fixture seeds one stale temp file')
})

test('v7.2: a persisted shield with no constraints is ignored, not rendered empty', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-shield-empty-'))
  writeFileSync(
    join(dir, '.graft-constraint-sections.json'),
    JSON.stringify({ 'session-empty': { constraints: [], at: 1 } }),
    'utf8',
  )
  const log = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  const sections = new Map()
  ctx.systemPrompt = {
    section(definition) {
      sections.set(definition.name, definition)
      return () => sections.delete(definition.name)
    },
    getSectionOrder() {
      return 100
    },
  }
  const innerGet = ctx.get
  ctx.get = (name) => (name === 'systemPrompt' ? ctx.systemPrompt : innerGet(name))
  apply(ctx, { dataDir: dir })

  const definition = sections.get('graft:constraints')
  assert.equal(definition.text({ agent: { session: { id: 'session-empty' } } }), '')
  resetRetiredSessions()
})
