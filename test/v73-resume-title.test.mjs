/**
 * v7.3.1: a resume must take down the `[已转移]` signpost.
 *
 * THE DEFECT THIS PINS
 *
 * Retiring a source rewrites its sidebar title to `[已转移] → <target>`. That
 * marker is TRUE only while the source is retired. `graft_resume_session` undid
 * the retirement but left the marker in place, so the source went on claiming it
 * had moved. Observed on the live desktop: the sidebar showed two entries that
 * could not be told apart —
 *
 *   [已转移] → verify-v731      ← actually the OLD session, original history intact
 *   [接续] 11-02 06:29 · y-v731 ← actually the new target
 *
 * and opening the first looked like "the target is just the old session renamed".
 *
 * A stale label is the mild version of the problem. The serious version is that
 * the source and the target become indistinguishable, and the user cannot tell
 * which one holds the work.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getTransferredSessions, resetRetiredSessions, resumeSession } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** A source with a real human message, so a title can legitimately cite it. */
function sourceWithHumanMessage() {
  const log = makeSourceLog({ turns: 3 })
  log.events.push({
    type: 'user/message',
    seq: 0,
    time: 0,
    data: {
      id: 'uc',
      role: 'user',
      content: [{ type: 'text', text: '帮我把登录接口改成幂等的。' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  return log
}

test('v7.3.1: resuming a source restores the title the transfer marker replaced', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-title-'))
  const log = sourceWithHumanMessage()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })

  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'target-a' }, {})

  // The graft wrote the signpost onto the live source.
  const afterGraft = ctx._sourceTitleAppends.filter((entry) => entry.type === 'session/title')
  assert.equal(afterGraft.length, 1, 'the graft must mark the retired source')
  assert.match(afterGraft[0].data.title, /^\[已转移\] → target-a$/)
  // And that marker is itself a legal title (empty refs + 'user').
  assert.deepEqual(afterGraft[0].data.messageSeqs, [])
  assert.equal(afterGraft[0].data.source.kind, 'user')

  // Resume: the signpost must come down.
  const result = resumeSession(ctx, log.session.id)
  assert.equal(result.wasTransferred, true)

  const titles = ctx._sourceTitleAppends.filter((entry) => entry.type === 'session/title')
  assert.equal(titles.length, 2, 'the resume must append a restoring title')
  const restored = titles[1]
  assert.equal(
    restored.data.title.startsWith('[已转移]'),
    false,
    'the restored title must not still claim a transfer',
  )

  // The original title text comes back, and its cited seq is preserved because it
  // really is an earlier human message in this session.
  const original = log.events.find(
    (event) => event.type === 'session/title' && !String(event.data?.title ?? '').startsWith('['),
  )
  if (original !== undefined) {
    assert.equal(restored.data.title, original.data.title)
  }
  // Whatever it cites must satisfy the host rule: earlier, user/message, human.
  for (const value of restored.data.messageSeqs) {
    const cited = log.events.find((event) => Number(event.seq) === Number(value))
    assert.equal(cited?.type, 'user/message')
    assert.equal(cited?.data?.source?.kind, 'user')
  }
  assert.equal(
    (restored.data.messageSeqs.length === 0) === (restored.data.source.kind === 'user'),
    true,
    'the restored title must satisfy the empty-refs/human-source pairing rule',
  )
  resetRetiredSessions()
})

test('v7.3.1: a resume is idempotent — re-running it still repairs a stale marker', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-title-idem-'))
  const log = sourceWithHumanMessage()
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'target-b' }, {})

  resumeSession(ctx, log.session.id)
  const firstPass = ctx._sourceTitleAppends.filter((entry) => entry.type === 'session/title').length
  // The session is no longer retired, so `resumed` is false — but the call must
  // still run the title repair, because an earlier version may have left the
  // marker behind and this is the only way to clear it.
  const second = resumeSession(ctx, log.session.id)
  assert.equal(second.resumed, false, 'nothing was retired the second time')
  const secondPass = ctx._sourceTitleAppends.filter((entry) => entry.type === 'session/title').length
  assert.ok(secondPass >= firstPass, 'the repair path must be reachable on a repeat call')
  // Crucially, it must never re-add a transfer marker.
  const last = ctx._sourceTitleAppends.filter((entry) => entry.type === 'session/title').at(-1)
  assert.equal(String(last?.data?.title ?? '').startsWith('[已转移]'), false)
  resetRetiredSessions()
})

test('v7.3.1: a source with no prior title gets a neutral one, never a false claim', async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-title-none-'))
  // makeSourceLog produces no session/title of its own in this fixture.
  const log = makeSourceLog({ turns: 3 })
  log.events.forEach((event, index) => {
    event.seq = index
  })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'target-c' }, {})
  resumeSession(ctx, log.session.id)

  const titles = ctx._sourceTitleAppends.filter((entry) => entry.type === 'session/title')
  const last = titles.at(-1)
  assert.ok(last, 'a restoring title must be written')
  assert.equal(String(last.data.title).startsWith('[已转移]'), false)
  assert.equal(
    (Array.isArray(last.data.messageSeqs) ? last.data.messageSeqs.length : 0) === 0,
    true,
  )
  assert.equal(last.data.source.kind, 'user')
  assert.equal(getTransferredSessions().has(log.session.id), false)
  resetRetiredSessions()
})
