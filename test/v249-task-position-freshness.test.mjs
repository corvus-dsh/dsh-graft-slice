/**
 * ── v249 (B3 收口 / TD-M17 ②③): 陈旧图自己说出来 ───────────────────────────────────────────────
 *
 * TD-M17 说：图存在但陈旧，没有任何机制让它与事实重新对齐。① 已做（B2-T4：graft 在「插件在、图不在」
 * 写一格；observer 在「多步无图」纠偏一次）。②③ 是这一笔：`task-position` 渲染时要**说得出**
 * 「这个节点自何时起没更新」。
 *
 * 三条硬约束（收口派工单 §5.1/§5.2）：
 *   1. **不许动 F4 刚定死的七段顺序** —— 这一笔只往既有段里加一行，不新增 chunk kind、不动顺序；
 *   2. **渲染是纯函数（零时钟）** —— `now` 由调用方传进来；本文件用 LITERAL 时间戳，不读 `Date.now()`；
 *   3. **字符上限不许抬高** —— `TASK_POSITION_MAX_CHARS` 仍是 1200，这一笔一个字都没改它。
 *
 * 两条指定测试 + can-red：
 *   · 陈旧 ⇒ 文本出现「自 … 起未更新（已 N 天）」；
 *   · 新鲜 ⇒ 不出现（而且不是「已 0 天」—— 那会让读者学会跳过这一行）。
 *   can-red：把 `staleDays` 改成恒 `undefined` ⇒ 陈旧那条红，新鲜那条仍绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STALE_AFTER_DAYS,
  TASK_POSITION_MAX_CHARS,
  renderTaskPosition,
  staleDays,
  toTaskPosition,
} from '../index.js'

/** A minimal graph with one active node, as `task-graph.json` would hold it. */
function graph(updatedAt) {
  return {
    goal: '把持久层能力全部生产就绪',
    goalLockedAt: '2026-11-18T00:00:00.000Z',
    nodes: [
      { id: 'start', title: '开始', status: 'done', dependsOn: [], requirements: [], updatedAt },
      { id: 'goal', title: '目标', status: 'pending', dependsOn: [], requirements: [], updatedAt },
      { id: 'b2-t1', title: '已完成的节点', status: 'done', dependsOn: ['goal'], requirements: [], updatedAt },
      {
        id: 'b2-t3',
        title: '任务位置接线',
        status: 'active',
        dependsOn: ['goal'],
        requirements: ['六段渲染', '真机一份'],
        progress: 15,
        updatedAt,
      },
      { id: 'b2-t4', title: 'observer 纠偏', status: 'pending', dependsOn: ['b2-t3'], requirements: [], updatedAt },
    ],
  }
}

const NOW = '2026-11-19T00:00:00.000Z'

// ── ① 陈旧 ⇒ 说出来 ──────────────────────────────────────────────────────────────────────────

test('v249 ①: 图陈旧 ⇒ 文本写明「自 … 起未更新」与天数', () => {
  /** 30 days before NOW — comfortably past the threshold. */
  const position = toTaskPosition(graph('2026-10-20T00:00:00.000Z'), { now: NOW })
  assert.ok(position !== undefined)
  const text = renderTaskPosition(position)
  assert.ok(text !== undefined)
  assert.match(text, /自 2026-10-20 起未更新（已 30 天）/u, `陈旧必须说出来：\n${text}`)
  /** The date is the node's own `updatedAt`, not some other field. */
  assert.ok(text.includes('当前节点：b2-t3（active）'), '位置信息仍在，只是多了一行时效')
})

// ── ② 新鲜 ⇒ 不说（而且不是「已 0 天」） ─────────────────────────────────────────────────────

test('v249 ②: 图新鲜 ⇒ 完全不出现那一行（不是「已 0 天」）', () => {
  const position = toTaskPosition(graph('2026-11-18T00:00:00.000Z'), { now: NOW })
  const text = renderTaskPosition(position)
  assert.ok(text !== undefined)
  assert.equal(text.includes('未更新'), false, `新鲜时不许出现时效行：\n${text}`)
})

// ── ③ 判据的三条边界：未知 / 时钟倒退 / 正好等于阈值 ────────────────────────────────────────

test('v249 ③: 未知不猜 —— 缺任意一侧、时钟倒退、正好卡在阈值上，都不产出天数', () => {
  assert.equal(staleDays(undefined), undefined)
  assert.equal(staleDays({ now: NOW }), undefined, '没有 updatedAt ⇒ 未知')
  assert.equal(staleDays({ updatedAt: '2026-10-20T00:00:00.000Z' }), undefined, '没有 now ⇒ 未知')
  assert.equal(staleDays({ updatedAt: 'not-a-date', now: NOW }), undefined, '解析不了 ⇒ 未知')
  assert.equal(
    staleDays({ updatedAt: '2026-11-25T00:00:00.000Z', now: NOW }),
    undefined,
    'now 早于 updatedAt（两台机器的钟不一致）⇒ 不许报「0 天」',
  )
  /** `>` not `>=`: on the boundary the node is still current. */
  const exactly = new Date(Date.parse(NOW) - STALE_AFTER_DAYS * 86_400_000).toISOString()
  assert.equal(staleDays({ updatedAt: exactly, now: NOW }), undefined)
  const justPast = new Date(Date.parse(NOW) - (STALE_AFTER_DAYS + 1) * 86_400_000).toISOString()
  assert.equal(staleDays({ updatedAt: justPast, now: NOW }), STALE_AFTER_DAYS + 1)
})

// ── ④ 零时钟 + 不新增段 + 上限未动 ───────────────────────────────────────────────────────────

test('v249 ④: 不给 `now` 就没有时效判据（渲染是纯函数）；上限仍是 1200，段序不变', () => {
  const withoutNow = toTaskPosition(graph('2026-10-20T00:00:00.000Z'))
  const text = renderTaskPosition(withoutNow)
  assert.ok(text !== undefined)
  assert.equal(text.includes('未更新'), false, '没有调用方的时钟 ⇒ 不许自己看表')

  /** The cap is a promise this batch did not change. */
  assert.equal(TASK_POSITION_MAX_CHARS, 1200)
  const long = toTaskPosition(
    {
      goal: 'x'.repeat(900),
      nodes: [
        { id: 'start', title: 's', status: 'done', dependsOn: [], requirements: [], updatedAt: '2026-10-20T00:00:00.000Z' },
        {
          id: 'n1', title: 't'.repeat(700), status: 'active', dependsOn: [], requirements: ['r'.repeat(400)], updatedAt: '2026-10-20T00:00:00.000Z',
        },
      ],
    },
    { now: NOW },
  )
  const capped = renderTaskPosition(long)
  assert.ok(capped !== undefined)
  assert.ok(capped.length <= TASK_POSITION_MAX_CHARS + 80, `截断后仍受上限约束（含提示行）：实际 ${capped.length}`)
  assert.ok(capped.includes('截断'), '真被截断时必须说出来')

  /** Segment ORDER is unchanged: goal → current → lists → edges → generation. */
  const normal = toTaskPosition(graph('2026-11-18T00:00:00.000Z'), { now: NOW })
  const ordered = renderTaskPosition({ ...normal, generation: 3 })
  assert.ok(ordered !== undefined)
  const idx = (needle) => ordered.indexOf(needle)
  assert.ok(idx('全局目标') < idx('当前节点'))
  assert.ok(idx('当前节点') < idx('已完成'))
  assert.ok(idx('已完成') < idx('未开始'))
  assert.ok(idx('未开始') < idx('本代：'))
})