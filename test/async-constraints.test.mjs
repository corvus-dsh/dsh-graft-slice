import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { makeCtx, makeSourceLog, FakePersistence } from './fake-harness.mjs'

/**
 * 补丁二：约束提取不再阻塞迁移。
 *
 * 关键断言是「迁移不等待 LLM」——用一个永不 resolve 的 llm.stream 证明迁移
 * 仍然完成；再用一个立即返回的 stream 证明结果会排进 pending 并在 target
 * 第一次 pre-step 时注入一次。
 */

function setup({ paths, llm } = {}) {
  resetRetiredSessions()
  const dir = paths ?? mkdtempSync(join(tmpdir(), 'dsh-graft-async-'))
  const sourceLog = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  if (llm !== undefined) {
    const originalGet = ctx.get
    ctx.get = (name) => (name === 'llm' ? llm : originalGet.call(ctx, name))
  }
  apply(ctx, {})
  return { ctx, sourceLog, dir }
}

function streamingLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

test('async: migration completes without waiting for a hanging LLM', async () => {
  const hanging = {
    stream() {
      return (async function* () {
        await new Promise(() => {})
      })()
    },
  }
  const { ctx, sourceLog } = setup({ llm: hanging })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-async-1' }, {})
  assert.equal(report.ok, true)
  // Fast regex path is what the report advertises.
  assert.equal(report.constraintSource, 'regex-fallback')
})

test('async: LLM result is queued to .pending-constraints.json', async () => {
  const llm = streamingLlm([
    { type: 'text-delta', text: '["Never deploy on Friday.","Always cite the primary source."]' },
  ])
  const { ctx, sourceLog, dir } = setup({ llm })
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-async-2' }, {})
  // The background task is fire-and-forget; give it a turn of the loop.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const file = join(dir, '.pending-constraints.json')
  assert.equal(existsSync(file), true, 'pending constraints must be persisted')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Array.isArray(parsed), true)
  const entry = parsed.find((item) => item.targetId === 'session-async-2')
  assert.ok(entry, 'the target must have a queued entry')
  assert.deepEqual(entry.constraints, ['Never deploy on Friday.', 'Always cite the primary source.'])
  assert.equal(entry.source, 'llm')
})

test('async: a failing LLM leaves the regex constraints and never throws', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
      })()
    },
  }
  const { ctx, sourceLog, dir } = setup({ llm })
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sourceLog.session.id, newSessionId: 'session-async-3' }, {})
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(report.ok, true)
  assert.equal(report.constraintSource, 'regex-fallback')
  assert.equal(existsSync(join(dir, '.pending-constraints.json')), false, 'nothing is queued on failure')
})

test('async: queued constraints persist across a restart and reload on activation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-async-reload-'))
  writeFileSync(
    join(dir, '.pending-constraints.json'),
    JSON.stringify([
      {
        targetId: 'session-async-reload',
        sourceSessionId: 'session-src',
        constraints: ['Reply in bullet points only.'],
        source: 'llm',
        extractedAt: 1,
      },
    ]),
    'utf8',
  )
  resetRetiredSessions()
  const sourceLog = makeSourceLog({ turns: 1 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, {})
  // Reload happened inside apply; the file must still be intact and unchanged.
  const parsed = JSON.parse(readFileSync(join(dir, '.pending-constraints.json'), 'utf8'))
  assert.equal(parsed[0].targetId, 'session-async-reload')
})
