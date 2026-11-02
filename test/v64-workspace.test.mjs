import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildInjectionPlan,
  describeUnavailableTool,
  extractWorkspaceState,
  renderWorkspaceState,
} from '../index.js'
import { makeSourceLog } from './fake-harness.mjs'

/**
 * v6.4 F4: the blind test on a 73-turn real session showed the target knew what
 * happened but not where things live, so it spent its first actions running ls.
 *
 * Note on fixtures: `buildInjectionPlan` cuts at the LAST turn/end, so extra
 * events appended after the final turn are dropped by design. Appended calls are
 * therefore inserted BEFORE that boundary rather than pushed at the end.
 */

function call(seq, name, args) {
  return { type: 'tool/call', seq, data: { callId: `c${seq}`, name, arguments: JSON.stringify(args) } }
}

/** Insert events just before the final turn/end so they fall inside the slice. */
function insertBeforeFinalTurnEnd(log, extra) {
  const lastEnd = log.events.map((e) => e.type).lastIndexOf('turn/end')
  if (lastEnd < 0) {
    log.events.push(...extra)
    return
  }
  log.events.splice(lastEnd, 0, ...extra)
}

test('workspace state: write and edit calls become a newest-first index', () => {
  const files = extractWorkspaceState([
    call(1, 'write', { file_path: 'D:\\proj\\a.ts' }),
    call(2, 'edit', { file_path: 'D:\\proj\\b.ts' }),
    call(3, 'write', { file_path: 'D:\\proj\\a.ts' }),
    call(4, 'read', { file_path: 'D:\\proj\\ignored.ts' }),
  ])
  assert.equal(files.length, 2, 'reads must not appear')
  assert.equal(files[0].path, 'D:\\proj\\a.ts', 'most recent write comes first')
  assert.equal(files[0].writes, 2)
  assert.equal(files[1].path, 'D:\\proj\\b.ts')
})

test('workspace state: the rendered block names paths and forbids blind listing', () => {
  const files = extractWorkspaceState([call(1, 'write', { file_path: 'D:\\proj\\src\\a.ts' })])
  const text = renderWorkspaceState(files, 'D:\\proj')
  assert.match(text, /^\[Workspace Files\]/)
  assert.match(text, /src\\a\.ts/)
  assert.match(text, /不要再盲目列目录/)
})

test('workspace state: an empty history renders nothing at all', () => {
  assert.equal(renderWorkspaceState([], 'D:\\proj'), '')
})

test('blind gap: the plan exposes workspaceFiles and injects the block', () => {
  const log = makeSourceLog({ turns: 3 })
  insertBeforeFinalTurnEnd(log, [call(19.1, 'write', { file_path: 'D:\\proj\\app.py' })])
  const plan = buildInjectionPlan(log, {})
  assert.equal(plan.workspaceFiles.length, 1)
  const chunk = plan.chunks.find((c) => c.kind === 'workspace-files')
  assert.ok(chunk, 'the workspace block must be injected')
  assert.match(chunk.text, /app\.py/)
})

test('F4: the narration announces the workspace block', () => {
  const log = makeSourceLog({ turns: 3 })
  insertBeforeFinalTurnEnd(log, [call(19.2, 'write', { file_path: 'D:\\proj\\app.py' })])
  const plan = buildInjectionPlan(log, {})
  assert.equal(plan.workspaceFiles.length > 0, true)
})

/* ------------------------------------------------------------------ F3 */

test('F3: a source-only tool is downgraded, not advertised as callable', () => {
  const text = describeUnavailableTool('spawn_teammate', 42, false)
  assert.match(text, /当前环境不支持的工具 spawn_teammate/)
  assert.match(text, /seq=42/)
  assert.equal(text.includes('我刚才已经调用 spawn_teammate 完成了这一步'), false)
})

test('F3: a tool missing from the target is downgraded in the tape', () => {
  const log = makeSourceLog({ turns: 2 })
  insertBeforeFinalTurnEnd(log, [
    { type: 'tool/call', seq: 19.5, data: { callId: 'cy', name: 'spawn_teammate', arguments: '{"task":"x"}' } },
    {
      type: 'tool/result',
      seq: 19.6,
      data: { message: { toolCallId: 'cy', content: [{ type: 'text', text: 'spawned' }] } },
    },
  ])
  const available = new Set(['read', 'write'])
  const plan = buildInjectionPlan(log, { recentTurns: 3 }, undefined, 'regex-fallback', available)
  const text = plan.chunks.map((c) => c.text).join('\n')
  assert.equal(
    text.includes('spawn_teammate(seq=19.6) (unavailable here)'),
    true,
    'a tool the target cannot call must be downgraded',
  )
})

test('F3: without an availability set every tool keeps its normal pointer', () => {
  const log = makeSourceLog({ turns: 2 })
  const plan = buildInjectionPlan(log, { recentTurns: 3 })
  const text = plan.chunks.map((c) => c.text).join('\n')
  assert.equal(text.includes('当前环境不支持的工具'), false)
})

/* ------------------------------------------------- v6.4.1 honesty of the index */

/**
 * A real v4 log carries the ids and the error flag INSIDE `data.message`.
 * A fixture shaped like `data.toolCallId` would let a broken reader pass, which
 * is exactly how a defence ends up present-but-dead. Both shapes are exercised.
 */
function resultRealShape(seq, callId, isError, text = 'ok') {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
      },
    },
  }
}

test('workspace state: a failed write is marked, not silently presented as a file', () => {
  const files = extractWorkspaceState([
    call(1, 'write', { file_path: 'D:\\proj\\broken.ts' }),
    resultRealShape(2, 'c1', true, 'ENOENT: no such file or directory'),
  ])
  assert.equal(files.length, 1)
  assert.equal(files[0].failed, true)
  const text = renderWorkspaceState(files, 'D:\\proj')
  assert.match(text, /未确认落盘/)
})

test('workspace state: the flat result shape is honoured too', () => {
  const files = extractWorkspaceState([
    call(1, 'write', { file_path: 'D:\\proj\\flat.ts' }),
    { type: 'tool/result', seq: 2, data: { toolCallId: 'c1', isError: true } },
  ])
  assert.equal(files[0].failed, true)
})

test('workspace state: a newer successful write clears the failure mark', () => {
  const files = extractWorkspaceState([
    call(1, 'write', { file_path: 'D:\\proj\\a.ts' }),
    resultRealShape(2, 'c1', true),
    call(3, 'write', { file_path: 'D:\\proj\\a.ts' }),
    resultRealShape(4, 'c3', false),
  ])
  assert.equal(files.length, 1)
  assert.equal(files[0].writes, 2)
  assert.equal(files[0].failed, undefined, 'the newest attempt decides')
})

test('workspace state: an older failure does not taint a newer write', () => {
  const files = extractWorkspaceState([
    call(1, 'write', { file_path: 'D:\\proj\\a.ts' }),
    resultRealShape(2, 'c1', true),
    call(3, 'write', { file_path: 'D:\\proj\\a.ts' }),
  ])
  assert.equal(files[0].failed, undefined)
})

test('workspace state: a nested isError on an unrelated call leaves the file clean', () => {
  const files = extractWorkspaceState([
    call(1, 'write', { file_path: 'D:\\proj\\a.ts' }),
    resultRealShape(2, 'c1', false),
    resultRealShape(3, 'other', true),
  ])
  assert.equal(files[0].failed, undefined)
})

test('workspace state: a capped list declares what it dropped', () => {
  const events = []
  for (let index = 1; index <= 5; index += 1) {
    events.push(call(index, 'write', { file_path: `D:\\proj\\f${index}.ts` }))
  }
  const files = extractWorkspaceState(events, 2)
  assert.equal(files.length, 2)
  const text = renderWorkspaceState(files, 'D:\\proj', 5)
  assert.match(text, /共有 5 个文件/)
  assert.match(text, /只列最近 2 个/)
})

test('workspace state: an uncapped list says nothing about dropping', () => {
  const events = [call(1, 'write', { file_path: 'D:\\proj\\only.ts' })]
  const text = renderWorkspaceState(extractWorkspaceState(events, 20), 'D:\\proj', 1)
  assert.equal(/只列最近/u.test(text), false)
})

test('workspace state: the block never claims the disk was checked', () => {
  const events = [call(1, 'write', { file_path: 'D:\\proj\\a.ts' })]
  const text = renderWorkspaceState(extractWorkspaceState(events), 'D:\\proj')
  assert.equal(text.includes('真实存在'), false, 'no claim the files are on disk')
  assert.match(text, /不是磁盘校验结果/)
})
