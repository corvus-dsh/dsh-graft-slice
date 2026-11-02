/**
 * v7.4：解除退休必须真的"解除"。
 *
 * THE LOOP THIS PINS
 *
 * `graft_resume_session` clears the retirement, the user types one sentence, and
 * the auto-graft fires immediately — because the log never shrank, so the
 * watermark is still ≥ the ratio the moment the session becomes usable again.
 * The result is a NEW target and a NEW retirement. Observed twice on this
 * project: the second time the source had 13,905 events and was re-grafted
 * within one message of being resumed.
 *
 * The undo was therefore cosmetic from the user's point of view. The fix is a
 * grace window that starts at resume time and survives a restart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getTransferredSessions, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const WATERMARK = {
  autoGraft: true,
  autoGraftAtRatio: 0.75,
  contextWindowTokens: 500,
  recentTurns: 2,
  retireSource: true,
}

function scaffold(settings = {}) {
  const log = makeSourceLog({ turns: 7 })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-resume-grace-'))
  const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
  apply(ctx, { ...WATERMARK, dataDir: dir, ...settings })
  return { log, ctx, dir }
}

test('v7.4: a resumed session is not re-grafted by the next message', async () => {
  resetRetiredSessions()
  const { log, ctx } = scaffold()

  await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  await new Promise((resolve) => setTimeout(resolve, 2400))
  const first = getTransferredSessions().get(log.session.id)
  assert.ok(first, 'the watermark still grafts a session that was never resumed')

  await ctx._tools.get('graft_resume_session').execute({ sessionId: log.session.id }, {})
  assert.equal(getTransferredSessions().get(log.session.id), undefined, 'resume clears the transfer')

  // One sentence later — the old behaviour produced a brand-new target here.
  await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  await new Promise((resolve) => setTimeout(resolve, 2400))
  assert.equal(
    getTransferredSessions().get(log.session.id),
    undefined,
    'the resumed session keeps its grace window instead of being retired again',
  )
  resetRetiredSessions()
})

test('v7.4: the grace window survives a restart', async () => {
  resetRetiredSessions()
  const { log, ctx, dir } = scaffold()

  await dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })
  await new Promise((resolve) => setTimeout(resolve, 2400))
  assert.ok(getTransferredSessions().get(log.session.id))

  await ctx._tools.get('graft_resume_session').execute({ sessionId: log.session.id }, {})
  resetRetiredSessions()

  // Restart: a fresh context over the same data directory.
  const restarted = makeCtx({ sourceLog: log, paths: { data: dir } })
  apply(restarted, { ...WATERMARK, dataDir: dir })
  await dispatchPreStep(restarted, { agent: { id: log.session.id }, messages: [] })
  await new Promise((resolve) => setTimeout(resolve, 2400))
  assert.equal(
    getTransferredSessions().get(log.session.id),
    undefined,
    'the suppression is durable, so a restart does not re-arm the trap',
  )
  resetRetiredSessions()
})