/**
 * v0.13 GUARD RAILS — the two defences that came out of the handoff post-mortem.
 *
 * 1. the workspace red line: a migrated session is told, in two channels, where its
 *    working directory ends and what to do instead of widening the search.
 * 2. the one-off action filter: a task step that names one file and one act
 *    ("立刻删除 D:\workspace\repair-log.cjs") must never become a standing rule.
 *
 * Both are asserted on the ARTIFACT the plugin actually writes, not on the source
 * text, because the failure they prevent happens in the injected log.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { apply, extractConstraints, migrationSystemPrompt, workspaceRedline } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

test('v0.13: the red line names the cwd and forbids root searches, in the requested wording', () => {
  const line = workspaceRedline('D:\\workspace')
  assert.match(line, /【红线警告】你的工作目录严格限定为 D:\\workspace。/u)
  assert.match(line, /严禁执行任何针对 C 盘、AppData 或全局根目录的搜索（如 rg \/）。/u)
  assert.match(line, /如果遇到找不到文件的情况，请只在当前目录下用 ls 或 dir 查找。/u)
  // A session whose log never recorded a cwd must not read as "anywhere is fine".
  assert.match(workspaceRedline(''), /工作目录未记录/u)
  assert.match(workspaceRedline('   '), /工作目录未记录/u)

  const prompt = migrationSystemPrompt('D:\\work\\demo')
  assert.match(prompt, /migrated coding session/u, 'the base instruction survives')
  assert.match(prompt, /D:\\work\\demo/u, 'the boundary is interpolated from the plan, not from the model')
})

test('v0.13: the boundary reaches BOTH channels — the system node and the durable goal message', async () => {
  const cwd = 'D:\\workspace'
  const log = makeSourceLog({ turns: 7, cwd })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const report = await ctx._tools.get('graft_slice_and_inject').execute(
    { sourceSessionId: log.session.id, newSessionId: 'session-graft-redline' },
    {},
  )
  assert.equal(report.ok, true)
  const stored = ctx._persistence.read('session-graft-redline')

  const system = stored.events.find((event) => event.type === 'system/message')
  const systemPrompt = system.data.message.content[0].text
  assert.match(systemPrompt, /红线警告/u)
  assert.match(systemPrompt, /D:\\workspace/u)
  assert.doesNotMatch(systemPrompt, /HARD CONSTRAINTS/u, 'the system head stays payload-free')

  // The system node is replaced by the host on the target's first live step, so the
  // goal user/message is what actually makes the guard survive.
  const goal = stored.events.find((event) => event.type === 'user/message')
  const goalText = goal.data.content[0].text
  assert.match(goalText, /红线警告/u)
  assert.match(goalText, /D:\\workspace/u)
  assert.match(goalText, /只在当前目录下用 ls 或 dir 查找/u)
})

test('v0.13: a one-off "delete this file" instruction is dropped, the standing rule stays', () => {
  const polluted = [
    '1. 删除危险脚本：立刻删除 D:\\workspace\\repair-log.cjs，绝不能让这个无备份、强制覆盖的脚本再跑一次。',
    '绝对禁止在没有备份的情况下删除任何脚本。',
  ].join('\n')
  const events = [
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: polluted }] },
    },
  ]
  const constraints = extractConstraints(events)
  assert.equal(
    constraints.some((item) => item.includes('repair-log.cjs')),
    false,
    'a step that names one artifact must not become a hard constraint',
  )
  assert.ok(
    constraints.some((item) => item.includes('绝对禁止在没有备份的情况下删除任何脚本')),
    'a prohibition that generalizes is exactly what must survive',
  )
})

test('v0.13: the filter does not eat ordinary rules that merely mention a file', () => {
  const events = [
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [
          {
            type: 'text',
            text: [
              'Do not delete any file without approval.',
              'Never remove the lock file while a writer is running.',
              '必须把 CHECKSUM_42 标记写在第 42 行。',
              '每次提交前必须更新 RELEASE_NOTES.md，并保持格式统一。',
            ].join('\n'),
          },
        ],
      },
    },
  ]
  const constraints = extractConstraints(events)
  assert.equal(constraints.some((item) => item.includes('Do not delete any file')), true)
  assert.equal(constraints.some((item) => item.includes('Never remove the lock file')), true)
  assert.equal(constraints.some((item) => item.includes('CHECKSUM_42')), true)
  assert.equal(
    constraints.some((item) => item.includes('RELEASE_NOTES.md')),
    true,
    'a recurring duty that names a file is still a rule',
  )
})

test('v0.13: workspaceRedline:false really removes the guard (the switch is not decorative)', async () => {
  // A private source id: the retirement ledger is module state shared by the
  // whole test process, so a second graft of the same source is refused.
  const log = makeSourceLog({ turns: 7, sourceSessionId: 'session-source-noredline' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, { workspaceRedline: false })
  const report = await ctx._tools.get('graft_slice_and_inject').execute(
    { sourceSessionId: log.session.id, newSessionId: 'session-graft-noredline' },
    {},
  )
  assert.equal(report.ok, true)
  const stored = ctx._persistence.read('session-graft-noredline')
  assert.doesNotMatch(stored.events.find((event) => event.type === 'system/message').data.message.content[0].text, /红线警告/u)
  assert.doesNotMatch(stored.events.find((event) => event.type === 'user/message').data.content[0].text, /红线警告/u)
})

test('v0.13: the LLM constraint prompt states the same exclusion as the regex path', () => {
  // Two extractors decide what becomes a HARD CONSTRAINT; they must agree, or the
  // model path quietly reintroduces what the deterministic path removes.
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const prompt = source.slice(source.indexOf('const LLM_CONSTRAINT_PROMPT'))
  assert.match(prompt, /Do NOT extract one-off ACTION instructions/u)
  assert.match(prompt, /never delete X without a backup/u)
})
