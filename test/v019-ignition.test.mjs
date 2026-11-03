/**
 * v0.19 module 2 — PHYSICAL IGNITION.
 *
 * The user's requirement: "在落盘并 flush 成功后，必须在代码里主动调用该接口，向 Target
 * 发送第一条唤醒指令……切断对人类的依赖，新会话必须自己开始干活。"
 *
 * These tests hold the mechanism (the host channel is actually called, with the
 * right session and mode), the ordering (only AFTER the target is durable), the
 * honesty (a missing channel is reported, never a silent no-op) and the recovery
 * (a failed ignition is queued and retried on the next activation).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  attemptIgnition,
  buildIgnitionPrompt,
  getPendingIgnitions,
  IGNITION_MARKER,
  igniteTargetSession,
  isIgnitionText,
  normalizeConfig,
  resetRetiredSessions,
} from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold({ controller } = {}) {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-ignite-'))
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
  if (controller !== undefined) ctx.sessionController = controller
  apply(ctx, { dataDir: dir })
  return { ctx, log, dir }
}

function recordingController({ throwOnPrompt = false } = {}) {
  const calls = []
  return {
    calls,
    async prompt(request) {
      calls.push(request)
      if (throwOnPrompt) throw new Error('gateway/internal')
      return { accepted: true }
    },
  }
}

test('v0.19: the prompt is marked, so a later reader can tell it from human intent', () => {
  assert.equal(isIgnitionText('普通用户消息'), false)
  assert.equal(isIgnitionText(`  ${IGNITION_MARKER} 继续`), true)
  const custom = buildIgnitionPrompt({ ignitionPrompt: '接着干' })
  assert.ok(custom.startsWith(IGNITION_MARKER))
  assert.ok(custom.includes('接着干'))
  // A custom prompt that already carries the marker is not double-stamped.
  const stamped = buildIgnitionPrompt({ ignitionPrompt: `${IGNITION_MARKER} 接着干` })
  assert.equal(stamped.split(IGNITION_MARKER).length - 1, 1)
  assert.equal(normalizeConfig({}).igniteTarget, true, 'ignition is on by default')
  assert.equal(normalizeConfig({}).ignitionMode, 'queue')
  assert.equal(normalizeConfig({ ignitionMode: 'steer' }).ignitionMode, 'steer')
})

test('v0.19: a completed graft CALLS the host channel for the new session', async () => {
  const controller = recordingController()
  const { ctx, log } = scaffold({ controller })

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-ignited' }, {})

  assert.equal(report.ok, true)
  assert.equal(controller.calls.length, 1, 'exactly one ignition, not a loop')
  const request = controller.calls[0]
  assert.equal(request.sessionId, 'session-ignited', 'the TARGET is the session that wakes')
  assert.equal(request.mode, 'queue')
  assert.equal(typeof request.requestId, 'string')
  assert.ok(request.content[0].text.startsWith(IGNITION_MARKER))

  // ...and the report says so, because "it woke up" is part of the job.
  assert.equal(report.ignition.ok, true)
  assert.equal(report.ignition.channel, 'sessionController.prompt')
  assert.equal(getPendingIgnitions().size, 0, 'a successful ignition leaves no retry behind')
  resetRetiredSessions()
})

test('v0.19: ignition happens AFTER the target is durable', async () => {
  // The channel is given a view of persistence: if the ignition ran before the
  // flush, the target's log would not be there yet.
  const seen = []
  const { ctx, log, dir } = scaffold({
    controller: {
      async prompt(request) {
        const stored = ctx._persistence.read(request.sessionId)
        seen.push(stored === undefined ? 'missing' : 'present')
        return { accepted: true }
      },
    },
  })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-durable-first' }, {})
  assert.equal(report.ok, true)
  assert.deepEqual(seen, ['present'], 'the target was already on disk when it was woken')
  resetRetiredSessions()
})

test('v0.19: no channel is REPORTED, not swallowed — and the intent is queued', async () => {
  const { ctx, log, dir } = scaffold()
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-no-channel' }, {})

  assert.equal(report.ok, true, 'a missing channel never fails a completed migration')
  assert.equal(report.ignition.attempted, false)
  assert.match(report.ignition.reason, /sessionController\.prompt/u)
  assert.equal(getPendingIgnitions().has('session-no-channel'), true)

  const queueFile = join(dir, '.graft-pending-ignition.json')
  assert.equal(existsSync(queueFile), true, 'the retry intent is durable')
  const queue = JSON.parse(readFileSync(queueFile, 'utf8'))
  assert.equal(queue.some((item) => item.targetId === 'session-no-channel'), true)

  // The next activation with a channel present retries it — that is the whole
  // point of the durable queue.
  const controller = recordingController()
  ctx.sessionController = controller
  const results = await import('../index.js').then((module) =>
    module.resumePendingIgnitions(ctx, normalizeConfig({})),
  )
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, true, `retry said: ${JSON.stringify(results[0])}`)
  assert.equal(controller.calls[0].sessionId, 'session-no-channel')
  assert.equal(getPendingIgnitions().size, 0)
  resetRetiredSessions()
})

test('v0.19: a channel that throws is reported and never rolls the migration back', async () => {
  const { ctx, log } = scaffold({ controller: recordingController({ throwOnPrompt: true }) })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-throws' }, {})

  assert.equal(report.ok, true)
  assert.equal(report.ignition.attempted, true)
  assert.equal(report.ignition.ok, false)
  assert.match(report.ignition.reason, /gateway\/internal/u)
  assert.equal(getPendingIgnitions().has('session-throws'), true, 'a failure is queued for retry')

  const audit = readFileSync(join(ctx.pathsData, '.graft-audit.jsonl'), 'utf8')
  assert.match(audit, /"kind":"ignite-failed"/u)
  assert.match(audit, /gateway\/internal/u)
  resetRetiredSessions()
})

test('v0.19: a target whose log already carries the prompt is not ignited twice', async () => {
  const controller = recordingController()
  const { ctx, log } = scaffold({ controller })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-twice' }, {})
  controller.calls.length = 0

  // Simulate what the HOST does when it admits the prompt: the target's own log
  // gains the ignition user/message. That is the state a retry must recognise.
  const record = ctx._persistence.byId.get('session-twice')
  record.events.push({
    type: 'user/message',
    seq: record.events.length,
    time: Date.now(),
    data: {
      id: 'ignite-admitted',
      role: 'user',
      content: [{ type: 'text', text: buildIgnitionPrompt(normalizeConfig({})) }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })

  const again = await attemptIgnition(ctx, normalizeConfig({}), log.session.id, 'session-twice')
  assert.equal(again.ok, true)
  assert.equal(again.alreadyIgnited, true)
  assert.equal(controller.calls.length, 0, 'a queued duplicate would read as two turns of user intent')
  resetRetiredSessions()
})

test('v0.19: igniteTarget:false is a differential switch, and it says so', async () => {
  const controller = recordingController()
  const { ctx, log } = scaffold({ controller })
  // Re-apply with the switch off BEFORE the graft runs.
  resetRetiredSessions()
  const off = makeCtx({ sourceLog: log, paths: { data: ctx.pathsData } })
  off.sessionController = controller
  apply(off, { dataDir: off.pathsData, igniteTarget: false })

  const report = await off._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-off' }, {})
  assert.equal(report.ok, true)
  assert.equal(report.ignition.attempted, false)
  assert.equal(report.ignition.reason, 'igniteTarget=false')
  assert.equal(controller.calls.length, 0)
  resetRetiredSessions()
})

test('v0.19: the Remote face is used when the service face is absent', async () => {
  const calls = []
  const { ctx, log } = scaffold()
  ctx.remote = {
    session: {
      async prompt(request) {
        calls.push(request)
        return { accepted: true }
      },
    },
  }
  const result = await igniteTargetSession(ctx, normalizeConfig({}), 'session-remote', 'session-source')
  assert.equal(result.ok, true)
  assert.equal(result.channel, 'remote.session.prompt')
  assert.equal(calls[0].sessionId, 'session-remote')
})
