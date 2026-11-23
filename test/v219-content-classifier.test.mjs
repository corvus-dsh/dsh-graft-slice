/**
 * ── v219: F2 `content-classifier` —— 19 种 `source.kind` 的分类，以及两类「假 user」──────────
 *
 * WHY THIS FILE EXISTS（Q1 的核心：粘贴的报告不算用户需求）
 *
 * DSH 把 19 种东西塞进 `user/message`（B0.8 实测 227 个日志 / 5,967 条）。旧代码只认识
 * `user` 与 `plugin:graft*`，其余 17 种没有名字。本文件的断言是：
 *
 *   ① 19 种 kind **逐个**映射正确 —— 用 `test/fixtures/source-kinds.json` 驱动，不手抄清单；
 *   ② 未登记 kind ⇒ `host-noise` + `unclassified: true`，且 `summarizeUnclassified` 能点名；
 *   ③ 两个实测的「假 user」（系统内容套 user 壳）⇒ `legacy-injection`；
 *   ④ 一个粘贴报告样本 ⇒ `task-transcript`（Q1 的核心形状）；
 *   ⑤ 一句正常的短话 ⇒ `human`（阈值不能宽到把真消息误判）；
 *   ⑥ can-red：一个「全判 human」的分类器必须被 ①/② 的判据抓住。
 *
 * ── 样本从哪来 ────────────────────────────────────────────────────────────────────────────────
 *
 * ③ 的两条是造样本的**实测原文**（leader 提供）。④ 的报告样本按真实粘贴报告的形态构造：
 * B0.8 夹具的 `sampleText` 同此处置 —— 真实语料受会话内容隐私约束，而分类器需要的是
 * 「最小可识别形态」而不是某次真实粘贴的原文。这一点必须写明，否则下一个人会拿它当语料证据。
 *
 * ── ⑥ 为什么是「模拟的坏分类器」而不是改源码 ──────────────────────────────────────────────────
 *
 * 本文件不能修改 `classifyBySource` 的源码（那会让测试自己制造并发事故）；⑥ 用同一个判据
 * 去判一个 `() => ({ cls: 'human' })` 的替代实现，证明 ①/② 的断言**有区分力**，不是恒绿。
 * 真正的「先改源码再跑」由派工单的 can-red 流程在仓库外做一次（证据贴在交付消息里）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  classifyBySource,
  classifyHumanText,
  summarizeUnclassified,
} from '../src/core/content-classifier.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIXTURE = join(ROOT, 'test', 'fixtures', 'source-kinds.json')
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const kinds = fixture.kinds ?? []

/**
 * 期望映射 —— 逐字来自派工单的映射表，**独立于实现**写在这里。
 * 它不抄夹具的顺序/内容，而是与夹具的 kind 集合互相对账（① 的最后一条断言）。
 */
const EXPECTED = {
  'user': 'human',
  'goal': 'objective',
  'tool-goal': 'objective',
  'agent-instructions': 'project-rule',
  'subagent-settled': 'async-result',
  'tool-jobs': 'async-result',
  'agent-message': 'peer-message',
  'plugin:observer-briefing': 'peer-message',
  /**
   * ── PHASE A（lead §25.3① 裁定）：`self-authored` 不是内容类，是 provenance ──────────────────────
   *
   * 所以 `plugin:graft-replay` 的内容类是 **history**（它是上一代的回放：内容上是历史），
   * 而「是我自己注入的」这个事实落到 **provenance: 'self'**。
   *
   * 这不是「改期望值把测试弄绿」：20 个内容类/来源的组合里，只有这一个的**分类维度**变了，
   * 所以只改这一行；其余 18 行一个都没动，可以逐行对照。
   */
  'plugin:graft-replay': 'history',
  'plugin:dsh-memory': 'reference',
  'compact-checkpoint': 'history',
  'time-context': 'host-noise',
  'runtime-context': 'host-noise',
  'skill-catalog': 'host-noise',
  'model-selection': 'host-noise',
  'user-approval': 'host-noise',
  'repeat-tool-reminder': 'host-noise',
  'plugin:chat-import': 'host-noise',
  'working-directory': 'host-noise',
}

/** 把「分类器的返回」与「期望表」的差异收集出来；① 和 ⑥ 共用同一个判据。 */
function mismatchesOf (classifier) {
  const out = []
  for (const kind of kinds.map((entry) => entry.kind)) {
    const expected = EXPECTED[kind]
    if (expected === undefined) {
      out.push(`${kind}: 夹具里的 kind 在期望表里没有 —— 新 kind 必须有人决定它属于哪一类`)
      continue
    }
    const got = classifier(kind)
    if (got.cls !== expected) out.push(`${kind}: ${got.cls} != ${expected}`)
    if (got.unclassified !== undefined) out.push(`${kind}: 已登记的 kind 被标成 unclassified`)
  }
  return out
}

// ── ③ 的实测样本：用 user 壳发的系统内容 ──────────────────────────────────────────────────────
const LEGACY_SAMPLES = [
  '只输出一个 JSON 对象，不要用工具、不要读文件、不要探索目录。\n上下文刚刚被压缩。以下是压缩摘要（机械摘要，不含人设信息）：',
  '[AI 设定 · 人设 v1 · id=partner-cold] 角色：冷酷、客观…',
  '<system-reminder>\n今天的日期是 2026-11-16。\n</system-reminder>',
]

// ── ④ 的报告粘贴样本（形态构造，非逐字语料；见文件头）──────────────────────────────────────────
const REPORT_PASTE = `# 迁移复盘报告

以下是这次从旧站迁到新站的完整报告，请评估其中的风险与遗漏。

## 一、背景

旧站运行了三年，单机数据库在高峰期 CPU 长期在 90% 以上。本次迁移目标是把读写拆开，
并把历史数据完整搬到新集群。迁移窗口定在周六凌晨，预计 40 分钟。

## 二、关键指标

| 指标 | 旧站 | 新站 | 说明 |
| --- | --- | --- | --- |
| 峰值 QPS | 120 | 400 | 只读请求占比 85% |
| P99 延迟 | 320ms | 90ms | 迁移后第一周 |
| 数据量 | 1.2TB | 1.2TB | 全量 + 增量 |
| 回滚耗时 | — | 8 分钟 | 演练三次取最慢 |

## 三、遇到的三个问题

1. 增量同步的位点在高写入时段落后 3 分钟，切换前必须等追平；
2. 旧站的软删除记录在新站没有索引，首轮压测的查询计划退化成全表扫描；
3. 部分客户端把 IP 写死在配置里，切换后需要灰度改 DNS，而不是一次切完。

## 四、切换脚本

\`\`\`sql
-- 冻结旧站写入
SET GLOBAL read_only = ON;
-- 追平增量后校验行数
SELECT COUNT(*) FROM orders;
\`\`\`

## 五、结论

建议把切换拆成两次：第一次只切只读流量，观察 48 小时；第二次再切写入。全量切换的窗口
太短，一旦位点没追平，回滚成本会超过预算。以上是本次复盘的完整记录，请分析是否还有遗漏。

## 六、附录：回滚检查清单

- 位点校验：旧站写入冻结后，读取旧站与新站的 binlog 位点，差值必须为 0 才能切流量；
- 数据校验：对订单、支付、用户三张表抽样 10 万行，逐行比对主键与更新时间；
- 客户端校验：灰度 DNS 生效后，统计旧站入口的连接数，必须降到 0 才能关闭旧站；
- 监控校验：切换后 30 分钟内，P99 延迟、错误率、连接池占用三项指标都要在基线以内；
- 回滚演练：正式切换前至少完整演练一次，并记录每一步的实际耗时；
- 沟通计划：切换窗口内每 10 分钟同步一次状态，出现任一红色项立刻回滚。`

/** 只有「以下是…报告」短语、没有报告结构的样本：证明短语分支单独成立。 */
const PHRASE_ONLY = `以下是这次迁移的报告，请你分析。\n${'过程记录：服务在迁移后偶发超时。'.repeat(60)}`

test('v219 ①: 19 种 kind 逐个映射正确（由 B0.8 夹具驱动）', () => {
  assert.deepEqual(mismatchesOf(classifyBySource), [],
    '有 kind 的映射与映射表不一致。新增 kind 时，改实现的同时必须改期望表与夹具 —— 两边都改才是「有人决定过」')
  assert.deepEqual(
    Object.keys(EXPECTED).sort(),
    kinds.map((entry) => entry.kind).sort(),
    '期望表的键与夹具的 kind 集合不一致：夹具多了/少了，都会让 ① 在一条没被检查的路上变绿',
  )
  assert.equal(kinds.length, 19, 'B0.8 的实测是 19 种；夹具或期望表被改成了别的数量')
})

test('v219 ②: 未登记 kind ⇒ host-noise + unclassified，且 summarizeUnclassified 能点名', () => {
  /**
   * 返回形状现在多一个 `provenance` 字段（内容类与来源属性正交）。未登记的 kind 走合同的
   * `UNKNOWN_POLICY`：内容类取它指定的那个，来源记 `host` —— 「我们不知道该把它算成谁的」和
   * 「它是宿主噪音」是两件事，所以 provenance 仍然给一个诚实的默认而不是留空。
   */
  assert.deepEqual(classifyBySource('some-new-kind'), { cls: 'host-noise', provenance: 'host', unclassified: true })
  assert.deepEqual(classifyBySource(undefined), { cls: 'host-noise', provenance: 'host', unclassified: true })

  const events = [
    { source: { kind: 'user' } },
    { source: { kind: 'some-new-kind' } },
    { source: { kind: 'another-new-kind' } },
    { source: { kind: 'some-new-kind' } }, // 重复只报一次
    { source: {} }, // 连 kind 都没有
    {}, // 连 source 都没有
  ]
  assert.deepEqual(summarizeUnclassified(events), [
    'some-new-kind',
    'another-new-kind',
    '(no source.kind)',
  ])
  assert.deepEqual(summarizeUnclassified([{ source: { kind: 'user' } }]), [],
    '全部已登记时必须返回空数组 —— 不能把「没有未知」和「没扫到」混为一谈')
})

test('v219 ③: 实测的「假 user」样本 ⇒ legacy-injection', () => {
  for (const sample of LEGACY_SAMPLES) {
    assert.equal(classifyHumanText(sample), 'legacy-injection',
      `这条应该是 legacy-injection：${JSON.stringify(sample.slice(0, 60))}`)
  }
})

test('v219 ④: 粘贴的报告 ⇒ task-transcript（Q1 的核心）', () => {
  assert.ok(REPORT_PASTE.length > 800,
    `报告样本必须超过 800 字阈值才能验证「长粘贴」路径，实测 ${REPORT_PASTE.length}`)
  assert.equal(classifyHumanText(REPORT_PASTE), 'task-transcript')
  assert.ok(PHRASE_ONLY.length > 800, `短语样本也必须超过阈值，实测 ${PHRASE_ONLY.length}`)
  assert.equal(classifyHumanText(PHRASE_ONLY), 'task-transcript',
    '「以下是…报告」短语分支应当单独成立（不依赖标题/表格/代码块）')
})

test('v219 ⑤: 正常短句 ⇒ human（阈值不能宽到误判真消息）', () => {
  assert.equal(classifyHumanText('把这个仓库的测试跑一遍，失败的列出来。'), 'human')
  assert.equal(classifyHumanText('以下是我想问的：这个函数为什么返回 undefined？'), 'human',
    '短句里的「以下是」不是粘贴材料 —— 长度阈值必须先挡住它')
  assert.equal(classifyHumanText('这是一个很长的需求描述的开头，但整段话其实很短。'), 'human',
    '「这是…的」只有配上报告类名词才判粘贴，普通的「这是」不能判')
})

test('v219 ⑥ can-red: 「全判 human」的分类器必须被 ①/② 的判据抓住', () => {
  const broken = () => ({ cls: 'human' })
  const failures = mismatchesOf(broken)
  // 19 种里 user 本来就是 human，其余 18 种必须被点出来。
  assert.equal(failures.length, 18,
    `全判 human 的分类器应当产生 18 条错配，实际 ${failures.length} 条：\n  ${failures.join('\n  ')}`)
  assert.notDeepEqual(broken('some-new-kind'), { cls: 'host-noise', unclassified: true },
    '② 的判据对「全判 human」同样必须红 —— 这是 Q1 功能反弹回原状的直接证据')
})
