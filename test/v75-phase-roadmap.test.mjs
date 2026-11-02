/**
 * v7.5 Phase Roadmap：节点计划的三层提取、注入排序与唤醒提示。
 *
 * The block exists because a stale `[Task Status]` answers "what is left" but not
 * "where am I and what is in the way". These tests pin the three layers, the
 * no-fabrication rule, the ordering, and the "no nagging" pacing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildInjectionPlan,
  extractPhaseRoadmap,
  extractTaskState,
  phaseKeyOf,
  renderPhaseRoadmap,
} from '../index.js'
import { apply, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function todoEvents(baseSeq, todos) {
  return [
    {
      type: 'tool/call',
      seq: baseSeq,
      data: { name: 'todo_write', callId: `todo-${baseSeq}`, arguments: JSON.stringify({ todos }) },
    },
    {
      type: 'tool/result',
      seq: baseSeq + 1,
      data: {
        message: {
          source: { callId: `todo-${baseSeq}` },
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    },
  ]
}

const phasedTodos = [
  { content: '阶段 1: 重构边界判定', status: 'completed' },
  { content: '阶段 2: 补两阶段测试', status: 'in_progress' },
  { content: '阶段 3: 真机崩溃注入', status: 'pending' },
]

test('v7.5: 阶段 N: 前缀被确定性分组（L1）', () => {
  const events = todoEvents(100, phasedTodos)
  const state = extractTaskState(events)
  const roadmap = extractPhaseRoadmap(events, state)
  assert.ok(roadmap !== undefined)
  assert.equal(roadmap.unit, '阶段')
  assert.equal(roadmap.phases.length, 3)
  assert.deepEqual(roadmap.phases.map((phase) => phase.status), ['done', 'active', 'pending'])
  assert.match(roadmap.phases[1].label, /阶段 2/u)
  assert.match(roadmap.currentNode, /补两阶段测试/u)
  assert.equal(roadmap.origin, 'todos')
})

test('v7.5: 没有阶段前缀时，assistant 的编号计划作为 L2', () => {
  const events = [
    {
      type: 'assistant/message',
      seq: 10,
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model' },
          content: [
            {
              type: 'text',
              text: '计划如下：\n1. 重构磁带边界\n2. 补两阶段审核测试\n3. 真机崩溃注入\n',
            },
          ],
        },
      },
    },
  ]
  const roadmap = extractPhaseRoadmap(events, extractTaskState(events))
  assert.ok(roadmap !== undefined)
  assert.equal(roadmap.origin, 'assistant-plan')
  assert.equal(roadmap.phases.length, 3)
  assert.match(roadmap.phases[0].label, /重构磁带边界/u)
})

test('v7.5: 没有计划就不产出（绝不编造）', () => {
  const events = todoEvents(200, [
    { content: '写测试', status: 'pending' },
    { content: '改文档', status: 'pending' },
  ])
  assert.equal(extractPhaseRoadmap(events, extractTaskState(events)), undefined)
})

test('v7.5: 四条以上普通 todo 退化为“节点”（L3）', () => {
  const events = todoEvents(300, [
    { content: '收集日志', status: 'completed' },
    { content: '复现问题', status: 'completed' },
    { content: '定位根因', status: 'in_progress' },
    { content: '补回归测试', status: 'pending' },
    { content: '发版', status: 'pending' },
  ])
  const roadmap = extractPhaseRoadmap(events, extractTaskState(events))
  assert.ok(roadmap !== undefined)
  assert.equal(roadmap.unit, '节点')
  assert.equal(roadmap.phases.length, 5)
  assert.match(renderPhaseRoadmap(roadmap), /称为节点/u)
})

test('v7.5: [Phase Roadmap] 排在 [Task Status] 之前', () => {
  const log = makeSourceLog({ turns: 2 })
  log.events.push(...todoEvents(log.events.at(-1).seq + 1, phasedTodos))
  const plan = buildInjectionPlan(log, {})
  const order = plan.chunks.map((chunk) => chunk.kind)
  const roadmapAt = order.indexOf('phase-roadmap')
  const statusAt = order.indexOf('task-status')
  assert.ok(roadmapAt >= 0, 'roadmap chunk missing')
  assert.ok(statusAt >= 0, 'task-status chunk missing')
  assert.ok(roadmapAt < statusAt, `expected roadmap before status, got ${order.join(' > ')}`)
})

test('v7.5: 卡点在之后有成功调用时被丢弃', () => {
  const events = [
    { type: 'tool/result', seq: 5, data: { message: { source: { callId: 'x' }, isError: true, content: [{ type: 'text', text: 'boom' }] } } },
    { type: 'tool/result', seq: 9, data: { message: { source: { callId: 'y' }, content: [{ type: 'text', text: 'fine' }] } } },
    ...todoEvents(100, phasedTodos),
  ]
  const state = extractTaskState(events)
  const stale = extractPhaseRoadmap(events, state, { failingTool: 'pwsh', errorText: 'boom', errorSeq: 5 })
  assert.equal(stale.blocker, undefined, 'a fixed error must not be presented as a blocker')
  const live = extractPhaseRoadmap(events, state, { failingTool: 'pwsh', errorText: 'boom', errorSeq: 200 })
  assert.ok(live.blocker !== undefined, 'an error after the last success is a real blocker')
})

test('v7.5: 唤醒每轮一次且有三轮冷却', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-plan-'))
  const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  const agent = { id: log.session.id }
  const longTask = '请分阶段完成：1. 重构 2. 写单测 3. 部署'

  const first = await dispatchPreStep(ctx, { agent, messages: [{ role: 'user', content: [{ type: 'text', text: longTask }] }] })
  assert.ok(JSON.stringify(first).includes('节点计划'), 'the first long task gets the nudge')

  const again = await dispatchPreStep(ctx, { agent, messages: [{ role: 'user', content: [{ type: 'text', text: longTask }] }] })
  assert.ok(!JSON.stringify(again).includes('节点计划'), 'same turn must not be nudged twice')

  const second = await dispatchPreStep(ctx, { agent, messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }] })
  assert.ok(!JSON.stringify(second).includes('节点计划'), 'cooldown: turn 2 is too soon')

  const third = await dispatchPreStep(ctx, { agent, messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }] })
  assert.ok(!JSON.stringify(third).includes('节点计划'), 'cooldown: turn 3 is too soon')
})

test('v7.5: 已经有阶段前缀时不再提醒', async () => {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  log.events.push(...todoEvents(log.events.at(-1).seq + 1, phasedTodos))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-plan2-'))
  const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  const decision = await dispatchPreStep(ctx, {
    agent: { id: log.session.id },
    messages: [{ role: 'user', content: [{ type: 'text', text: '阶段一 阶段二 阶段三，按计划推进' }] }],
  })
  assert.ok(!JSON.stringify(decision).includes('节点计划'))
})

test('v7.5: 渲染有硬上限，长标签被截断', () => {
  const long = '阶段 1: ' + '长'.repeat(200)
  const events = todoEvents(400, [
    { content: long, status: 'pending' },
    { content: '阶段 2: 第二步', status: 'pending' },
  ])
  const roadmap = extractPhaseRoadmap(events, extractTaskState(events))
  assert.ok(roadmap !== undefined)
  const text = renderPhaseRoadmap(roadmap)
  assert.ok(text.length <= 600, `block must stay under 600 chars, got ${text.length}`)
  assert.ok(text.includes('○'))
})

test('v7.5: phaseKeyOf recognises the three prefix dialects', () => {
  assert.equal(phaseKeyOf('阶段 2: 补测试')?.n, 2)
  assert.equal(phaseKeyOf('Phase 3: deploy')?.n, 3)
  assert.equal(phaseKeyOf('第 4 步：发版')?.n, 4)
  assert.equal(phaseKeyOf('Step 5: verify')?.n, 5)
  assert.equal(phaseKeyOf('普通任务'), undefined)
})