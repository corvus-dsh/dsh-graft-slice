/**
 * v7.3 retrieval suite: the tool that makes read-back usable.
 *
 * The hole this closes, stated plainly: `graft_read_result(seq)` answers "what is
 * at seq N". Nothing answered "which seq mentions AssertionError". The injected
 * index caps at 24 recent pointers plus the oldest constraint block, so anything
 * older was reachable in principle and unreachable in practice — a target that
 * needed an earlier failure had to guess seq numbers or re-run the command.
 *
 * A "read it back by seq" philosophy without a way to FIND the seq is not a
 * philosophy, it is a documented dead end.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  deriveAutoTapeBudget,
  graftSearchHistory,
  resetRetiredSessions,
} from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function searchableLog() {
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 3, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' },
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
        source: { kind: 'tool', callId: 'c1' },
        toolCallId: 'c1',
        isError: true,
        content: [
          {
            type: 'text',
            text: 'FAIL src/login.test.ts\nAssertionError: expected 401 to equal 200\n  at login.ts:42',
          },
        ],
      },
    },
  })
  log.events.push({
    type: 'assistant/message',
    seq: 0,
    time: 0,
    data: {
      turn: 3,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'The login handler returns 401 because the token check runs before the body parse.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

test('v7.3: search finds a seq by keyword and previews around it', async () => {
  resetRetiredSessions()
  const log = searchableLog()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const result = await graftSearchHistory(ctx, log.session.id, 'AssertionError')
  assert.equal(result.found, true)
  assert.equal(result.totalMatches, 1)
  const hit = result.hits[0]
  assert.equal(hit.type, 'tool/result')
  assert.ok(Number.isFinite(hit.seq))
  // The preview must show the match plus context, on one line.
  assert.match(hit.preview, /AssertionError/)
  assert.match(hit.preview, /login\.test\.ts/)
  assert.equal(hit.preview.includes('\n'), false, 'previews are whitespace-collapsed')
  assert.ok(hit.totalChars > 0)
})

test('v7.3: search reads assistant messages too, not only tool output', async () => {
  resetRetiredSessions()
  const log = searchableLog()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const result = await graftSearchHistory(ctx, log.session.id, 'token check')
  assert.equal(result.found, true)
  assert.equal(result.hits[0].type, 'assistant/message')
})

test('v7.3: search is case-insensitive and treats metacharacters literally by default', async () => {
  resetRetiredSessions()
  const log = searchableLog()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const upper = await graftSearchHistory(ctx, log.session.id, 'ASSERTIONERROR')
  assert.equal(upper.found, true, 'matching must be case-insensitive')

  // A query full of regex metacharacters must be a substring, not a pattern.
  const literal = await graftSearchHistory(ctx, log.session.id, 'login.ts:42')
  assert.equal(literal.found, true, 'dots must not act as wildcards')
  const wrong = await graftSearchHistory(ctx, log.session.id, 'loginXts:42')
  assert.equal(wrong.found, false)
})

test('v7.3: regex mode works, and a malformed pattern reports instead of throwing', async () => {
  resetRetiredSessions()
  const log = searchableLog()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const re = await graftSearchHistory(ctx, log.session.id, 'expected \\d+ to equal \\d+', 10, true)
  assert.equal(re.found, true)
  assert.equal(re.regex, true)

  const bad = await graftSearchHistory(ctx, log.session.id, '[unclosed', 10, true)
  assert.equal(bad.found, false)
  assert.equal(typeof bad.error, 'string')
  assert.match(bad.error, /invalid regular expression/)
})

test('v7.3: limit caps the hits and truncation is declared, not silent', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 3 })
  for (let index = 0; index < 5; index += 1) {
    log.events.push({
      type: 'tool/result',
      seq: 0,
      time: 0,
      data: {
        turn: 3,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: `m${index}` },
          toolCallId: `m${index}`,
          content: [{ type: 'text', text: `needle occurrence ${index}` }],
        },
      },
    })
  }
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const capped = await graftSearchHistory(ctx, log.session.id, 'needle', 2)
  assert.equal(capped.hits.length, 2)
  assert.equal(capped.totalMatches, 5)
  assert.equal(capped.truncated, true, 'a capped result must say how many it withheld')
})

test('v7.3: the search tool is registered and model-visible', async () => {
  resetRetiredSessions()
  const log = searchableLog()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})
  const names = [...ctx._tools.keys()]
  assert.equal(names.includes('graft_search_history'), true)
  // And the schema declares the required arguments.
  const tool = ctx._tools.get('graft_search_history')
  assert.deepEqual(tool.parameters.required, ['sourceSessionId', 'query'])
  assert.equal(tool.parameters.properties.limit.type, 'integer')
})

test('v7.3: one event yields one hit, with its match density reported', async () => {
  resetRetiredSessions()
  // Discovered on the live host: a search for "jet hub" returned limit=5 results
  // that were ALL seq=152, because that single event (a grep dump) contained the
  // phrase 24 times. Every result slot went to one event, hiding the others —
  // the index stopped answering "where should I look".
  const log = makeSourceLog({ turns: 2 })
  log.events.push({
    type: 'tool/result',
    seq: 0,
    time: 0,
    data: {
      turn: 2,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'bulk' },
        toolCallId: 'bulk',
        content: [{ type: 'text', text: 'needle '.repeat(24) }],
      },
    },
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
        source: { kind: 'tool', callId: 'other' },
        toolCallId: 'other',
        content: [{ type: 'text', text: 'a single needle elsewhere' }],
      },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const result = await graftSearchHistory(ctx, log.session.id, 'needle', 5)
  // Two distinct events matched, so two hits — not five rows of the same seq.
  assert.equal(result.totalHits, 2)
  assert.equal(result.hits.length, 2)
  assert.equal(new Set(result.hits.map((hit) => hit.seq)).size, 2)
  // Density stays visible instead of being spent on repeated rows.
  const bulk = result.hits.find((hit) => hit.matchCount > 1)
  assert.ok(bulk, 'the dense event must report its match count')
  assert.equal(bulk.matchCount, 24)
  assert.equal(result.totalMatches, 25)
})

test('v7.3: truncation counts withheld EVENTS, since limit caps events', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  for (let index = 0; index < 4; index += 1) {
    log.events.push({
      type: 'tool/result',
      seq: 0,
      time: 0,
      data: {
        turn: 2,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: `e${index}` },
          toolCallId: `e${index}`,
          content: [{ type: 'text', text: `needle in event ${index}` }],
        },
      },
    })
  }
  log.events.forEach((event, i) => {
    event.seq = i
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})
  const result = await graftSearchHistory(ctx, log.session.id, 'needle', 2)
  assert.equal(result.hits.length, 2)
  assert.equal(result.totalHits, 4)
  assert.equal(result.totalMatches, 4)
  assert.equal(result.truncated, true)
})

test('v7.3: the auto budget converts characters to tokens at 1:1, not 2:1', () => {
  // The old formula divided by 0.5, so a 1M-token window became a 1M-character
  // budget. On Chinese text 1 character is ~1 token, so that filled the entire
  // window and left nothing for the system prompt, tool schemas, or the reply.
  assert.equal(deriveAutoTapeBudget(1_000_000), 500_000)
  assert.equal(deriveAutoTapeBudget(200_000), 100_000)
  assert.equal(deriveAutoTapeBudget(0), 0)
  // Never exceed half the window in characters.
  for (const window of [32_000, 200_000, 1_000_000]) {
    assert.ok(deriveAutoTapeBudget(window) <= window * 0.5)
  }
})
