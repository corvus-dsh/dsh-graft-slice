/**
 * Real-shape regression: a genuine DSH v4 log must slice, inject, persist and
 * cold-read.
 *
 * Why this file now reads a committed fixture instead of the host store:
 *
 * The previous version called listSessionFiles() and took the first closed log
 * it found. That made the suite depend on what happened to be on the machine
 * at that moment. It failed exactly once, for a reason that had nothing to do
 * with the plugin: the workspace's own active session had an open turn, so the
 * scan moved on to `78f00ba5…`, a **subagent** session, and the v6.1 subagent
 * guard correctly refused it. A test that goes red because the machine is busy
 * is not a regression signal — it is noise that trains people to ignore red.
 *
 * Why it is not a hand-written mock either:
 *
 * v6.4 found a defence that compiled, passed a hand-written fixture, and never
 * fired on a real log: tool results are nested (`data.message.toolCallId`,
 * `data.message.isError`), not flat (`data.toolCallId`). A synthetic fixture
 * reproduces whatever shape its author believed in. So `fixtures/
 * real-session.v4.jsonl.zstd` is **derived from an actual persisted log**
 * (`session-legacy-fixture`, rescued from the
 * 2026-11-01 recursive delete): the event sequence, nesting and field names are
 * recorded, not invented. Only payload sizes were reduced — long strings
 * clipped, the bulky `request/header.header` body and per-message `stream`
 * arrays shortened — because the slicer discards `stream` and only reads the
 * header for its context-window shape. `fixtures/MANIFEST.json` records the
 * provenance, the counts and the sha256.
 *
 * The assertions below are deliberately about the *shapes* that broke in
 * production, so the fixture keeps earning its place.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { apply, graftSliceAndInject } from '../index.js'
import { FakePersistence, makeCtx } from './fake-harness.mjs'
import { readSessionLogFile } from '../scripts/read-session-log.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/real-session.v4.jsonl.zstd', import.meta.url))
const FIXTURE_MANIFEST = fileURLToPath(new URL('./fixtures/MANIFEST.json', import.meta.url))

const BASE_CONFIG = {
  maxTurnChars: 4000,
  maxTotalChars: 20000,
  oldTurnSummaryChars: 500,
  retireSource: true,
  verifyReadBack: true,
  skeletonTurn: 1,
  skeletonStep: 1,
}

function loadFixture() {
  return readSessionLogFile(FIXTURE)
}

test('real fixture: the log on disk really carries the nested v4 tool-result shape', () => {
  const log = loadFixture()
  const results = log.events.filter((event) => event.type === 'tool/result')
  assert.ok(results.length > 0, 'fixture must contain tool results')

  // This is the exact assumption v6.4 was fixed for. If the fixture ever drifts
  // to the flat shape, this test fails before the workspace-state tests do.
  const nested = results.filter((event) => event.data?.message?.toolCallId !== undefined)
  assert.equal(nested.length, results.length, 'every tool/result must be nested under data.message')

  const failures = results.filter((event) => event.data?.message?.isError === true)
  assert.ok(failures.length > 0, 'fixture must contain at least one failed tool result')
  assert.equal(
    results.every((event) => event.data?.isError === undefined),
    true,
    'fixture must not also carry the flat isError shape, or the guard could pass for the wrong reason',
  )
})

test('real fixture: the fixture still matches its recorded provenance', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST, 'utf8'))
  const log = loadFixture()
  assert.equal(log.session.id, manifest.sessionId)
  assert.equal(log.events.length, manifest.events)
  assert.equal(log.events.filter((event) => event.type === 'turn/end').length, manifest.turns)
  assert.equal(
    log.events.every((event, index) => event.seq === index),
    true,
    'fixture seq must stay contiguous or the boundary logic sees a different log than the one recorded',
  )
  assert.notEqual(log.session.origin, 'subagent', 'the fixture must be a top-level session, not a subagent')
  assert.equal(log.session.delegationDepth, 0)
})

test('real fixture: plans, injects, persists, and cold-reads', async () => {
  const log = loadFixture()
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  const config = { ...BASE_CONFIG, recentTurns: 5 }
  apply(ctx, config)

  const newSessionId = 'session-graft-real-fixture'
  const report = await graftSliceAndInject(ctx, config, log.session.id, newSessionId, undefined)

  assert.equal(report.ok, true)
  assert.equal(report.durability.verified, true)
  assert.equal(ctx.sessions.get(newSessionId), undefined)

  const stored = persistence.read(newSessionId)
  assert.equal(stored.events[0].type, 'turn/start')

  // v5.2+ records runtime intent after the closed turn (model/selection and the
  // three permission knobs), so turn/end is no longer literally last.
  assert.equal(stored.events.some((event) => event.type === 'turn/end'), true)
  const tailTypes = stored.events.slice(-8).map((event) => event.type)
  assert.equal(
    tailTypes.every((type) =>
      [
        'assistant/message',
        'step/end',
        'turn/end',
        'permission/preset',
        'sandbox/mode',
        'approval/policy',
        'model/selection',
      ].includes(type),
    ),
    true,
    `unexpected tail: ${tailTypes.join(',')}`,
  )

  // Red lines that this fixture would catch if they regressed.
  assert.equal(stored.events.some((event) => event.type === 'tool/result'), false)
  const surfaceEvents = stored.events.filter((event) =>
    ['system/message', 'user/message', 'assistant/message'].includes(event.type),
  )
  assert.equal(surfaceEvents[0].type, 'system/message')
  for (const event of stored.events.filter((candidate) => candidate.type === 'assistant/message')) {
    assert.deepEqual(event.data.stream, [])
    assert.equal('sourceEventSeqs' in event, false)
  }
})

test('real fixture: with adaptive depth off, older turns are summarised, not dropped', async () => {
  const log = loadFixture()
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence })
  const config = { ...BASE_CONFIG, recentTurns: 2, adaptiveDepth: false }
  apply(ctx, config)

  const newSessionId = 'session-graft-real-fixture-older'
  const report = await graftSliceAndInject(ctx, config, log.session.id, newSessionId, undefined)

  assert.equal(report.ok, true)
  // `recentTurns` is only honoured when adaptive depth is off; with it on, the
  // source's own shape wins. Pinning both here keeps that contract honest.
  assert.equal(report.recentTurnCount, 2)
  assert.ok(report.olderTurnCount > 0, 'fixture must have turns old enough to summarise')
  assert.equal(report.injected.oldSummary, 1)

  // Older tool results must survive as read-back pointers, not vanish.
  assert.ok(report.pointers.older > 0)
  assert.ok(report.pointers.olderToolNames.length > 0)

  const stored = persistence.read(newSessionId)
  const text = JSON.stringify(stored.events)
  assert.ok(text.includes('graft_read_result'), 'pointer text must reference the read-back tool')
  assert.equal(stored.events.some((event) => event.type === 'tool/result'), false)
})

test('real fixture: a subagent log is refused before any write happens', async () => {
  const log = loadFixture()
  // Same fixture, marked as a subagent session the way DSH marks one.
  const subagentLog = {
    ...log,
    session: { ...log.session, origin: 'subagent', delegationDepth: 1 },
  }
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: subagentLog, persistence })
  const config = { ...BASE_CONFIG, recentTurns: 5 }
  apply(ctx, config)

  await assert.rejects(
    () => graftSliceAndInject(ctx, config, subagentLog.session.id, 'session-graft-from-subagent', undefined),
    (error) => error.code === 'GRAFT_REFUSED' && /subagent/u.test(error.message),
  )
  assert.equal(persistence.read('session-graft-from-subagent'), undefined)
})
