/**
 * v7.3.1: a completed handoff must be VISIBLE, not just durable.
 *
 * THE GAP THIS PINS
 *
 * On the desktop, `graft_slice_and_inject` returned `ok: true`, the target was
 * written, `.graft-targets.json` recorded it, and `workspace.json` listed it
 * first — and the sidebar still showed nothing. The user's report was simply
 * "工作区没有出现新会话".
 *
 * Cause, verified in the host:
 *
 *   // dsh-api-session-controller
 *   ctx.on("session/created", (session) => {
 *     ctx.emit("api-session/added", this.listState.summaryFor(session));
 *   });
 *
 * `session/created` fires only for sessions PUBLISHED into the live store
 * (prepare + enter + announce). This plugin writes targets through
 * `sessionPersistence` instead — and it MUST, because publishing breaks
 * resumability:
 *
 *   // dsh-agent-loop, resume
 *   handle = await persistence.open(id, "write", { signal })
 *   // ... and the agent factory calls sessions.enter(session), which
 *   //     "throws if a session with this id is already in the store"
 *
 * So the target stays cold and the plugin emits the notification itself.
 * `dsh-api-remotes` forwards `api-session/added` to peers keyed by
 * `summary.sessionId`, and the client applies it via `handleSessionAdded`
 * → `mergeSummary`.
 *
 * The payload is deliberately `summarizeCold(record)`'s shape with `projections`
 * OMITTED: the client only calls `applyListBlock` when that field is present, so
 * omitting it cannot corrupt the projection store. A hand-built projection frame
 * is not worth risking the user's sidebar for.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold() {
  const log = makeSourceLog({ turns: 3 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-announce-'))
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { log, ctx, persistence }
}

test('v7.3.1: a completed graft announces the target through api-session/added', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence } = scaffold()
  const before = ctx._emitted.length

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'announced-target' }, {})
  assert.equal(report.ok, true)

  const added = ctx._emitted
    .slice(before)
    .filter((entry) => entry.name === 'api-session/added')
  assert.equal(added.length, 1, 'exactly one announcement per graft')

  const summary = added[0].args[0]
  // The identity the remote layer keys the notification by.
  assert.equal(summary.sessionId, 'announced-target')
  // Shape copied from the host's summarizeCold(record).
  assert.equal(typeof summary.updatedAt, 'number')
  assert.equal(summary.agentAvailable, false, 'a cold target has no live agent')
  assert.equal(summary.formatStatus, 'current')
  assert.equal(summary.running, false)
  assert.equal(summary.blank, false, 'the target carries a seeded tape')
  assert.equal(summary.cwd, log.session.cwd)
  // Deliberately omitted: the client only applies a projection block when this
  // field is present, so a hand-built frame could corrupt its projection store.
  assert.equal('projections' in summary, false, 'no hand-built projection frame')

  // The announcement must describe a session that actually exists.
  const stored = persistence.read('announced-target')
  assert.ok(stored, 'the target must be durable before it is announced')
  resetRetiredSessions()
})

test('v7.3.1: a failing emit never fails the handoff', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence } = scaffold()
  // A host that refuses the emit must not turn a completed migration into an
  // error: the session is written either way, and the source is already retired.
  ctx.emit = () => {
    throw new Error('emit refused by test')
  }

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'unannounced-target' }, {})
  assert.equal(report.ok, true, 'the graft must still succeed')
  assert.ok(persistence.read('unannounced-target'), 'the target must still be durable')
  assert.equal(
    report.warnings.some((warning) => warning.includes('client announcement failed')),
    true,
    'the refusal must be reported as a warning, not swallowed',
  )
  resetRetiredSessions()
})

test('v7.3.1: a host without emit still grafts', async () => {
  resetRetiredSessions()
  const { log, ctx, persistence } = scaffold()
  delete ctx.emit

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'no-emit-target' }, {})
  assert.equal(report.ok, true)
  assert.ok(persistence.read('no-emit-target'))
  resetRetiredSessions()
})