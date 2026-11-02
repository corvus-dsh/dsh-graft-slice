/**
 * v7.4 P1-1: the user's own words must be searchable — and only the user's.
 *
 * THE GAP
 *
 * `graft_search_history` scanned `assistant/message` and `tool/result` only, and
 * `graft_read_result` accepted the same two types. The user's constraints live in
 * `user/message` ("绝对不能使用 import re 正则库"), so searching for them returned
 * ZERO hits and the resumed target had no way to recover the original wording —
 * everything else is a summary, and a summary may have truncated exactly the
 * clause that mattered.
 *
 * THE HAZARD THIS MUST NOT INTRODUCE
 *
 * `user/message` is not synonymous with "a human said it". This plugin writes the
 * goal into one (`plugin:graft-replay`), and the host injects `runtime-context`,
 * `time-context`, `skill-catalog`, `tool-jobs` and `user-approval` into the same
 * event type. Letting those through would let the search answer "the user said X"
 * when the user said nothing of the kind.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, graftReadResult, graftSearchHistory, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A source containing one human message and one plugin-authored one, same text. */
function sourceWithTwoAuthors() {
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'human-1',
      role: 'user',
      content: [{ type: 'text', text: '绝对不能使用 import re 正则库。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'plugin-goal',
      role: 'user',
      content: [{ type: 'text', text: '这是插件写的 goal，也提到了 import re 但这不算用户原话。' }],
      source: { kind: 'plugin:graft-replay' },
    },
    surfaceOp: 'append',
  })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'runtime-ctx',
      role: 'user',
      content: [{ type: 'text', text: 'Current runtime context … import re …' }],
      source: { kind: 'runtime-context' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

test('v7.4 P1-1: a human user/message is searchable', async () => {
  resetRetiredSessions()
  const log = sourceWithTwoAuthors()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const result = await graftSearchHistory(ctx, log.session.id, 'import re', 10)
  assert.equal(result.found, true, 'the human constraint must be findable')
  const human = result.hits.find((hit) => hit.type === 'user/message' && hit.sourceKind === 'user')
  assert.ok(human, 'the hit must come from the human message')
  assert.match(human.preview, /import re/)
})

test('v7.4 P1-1: plugin-authored and host-injected user/messages are NOT searchable', async () => {
  resetRetiredSessions()
  const log = sourceWithTwoAuthors()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const result = await graftSearchHistory(ctx, log.session.id, 'import re', 10)
  // Three events contain the phrase; only the human one may surface.
  assert.equal(result.hits.length, 1, `only one hit expected, got ${result.hits.length}`)
  assert.equal(result.totalHits, 1, 'the excluded events must not even be counted')
  for (const hit of result.hits) {
    assert.equal(hit.type, 'user/message')
    assert.equal(hit.sourceKind, 'user', 'every returned user/message must be human-authored')
  }
})

test('v7.4 P1-1: read_result returns the user text verbatim and labels its author', async () => {
  resetRetiredSessions()
  const log = sourceWithTwoAuthors()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  const humanSeq = log.events.find((event) => event.data?.id === 'human-1').seq
  const human = await graftReadResult(ctx, log.session.id, humanSeq)
  assert.equal(human.found, true)
  assert.equal(human.text, '绝对不能使用 import re 正则库。', 'the text must be verbatim')
  assert.equal(human.sourceKind, 'user')
})

test('v7.4 P1-1: a plugin-authored user/message stays READABLE but is labelled', async () => {
  resetRetiredSessions()
  const log = sourceWithTwoAuthors()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})

  // Reading is allowed for every author: the log is a fact and hiding it would be
  // dishonest. What must never happen is the reader mistaking it for the user's
  // words, so the payload carries the source kind.
  const goalSeq = log.events.find((event) => event.data?.id === 'plugin-goal').seq
  const goal = await graftReadResult(ctx, log.session.id, goalSeq)
  assert.equal(goal.found, true, 'a plugin-authored message is still readable')
  assert.equal(goal.sourceKind, 'plugin:graft-replay')
  assert.equal(goal.text.includes('不算用户原话'), true, 'text stays verbatim')
})

test('v7.4 P1-1: search still finds tool results and assistant messages', async () => {
  resetRetiredSessions()
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
        source: { kind: 'tool', callId: 'c1' },
        toolCallId: 'c1',
        isError: true,
        content: [{ type: 'text', text: 'AssertionError: expected 401 to equal 200' }],
      },
    },
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence() })
  apply(ctx, {})
  const result = await graftSearchHistory(ctx, log.session.id, 'AssertionError', 10)
  assert.equal(result.found, true)
  assert.equal(result.hits[0].type, 'tool/result')
  // A tool result has no author ambiguity, so it must NOT claim to be user text.
  assert.equal('sourceKind' in result.hits[0], false)
})