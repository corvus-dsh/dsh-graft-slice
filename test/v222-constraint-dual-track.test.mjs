/**
 * ── v222：F3 约束双轨 —— 「模型主动声明」这条轨道（B1-5 第 1 步：先写测试让它红）─────
 *
 * ── 现状（实测，2026-11-17）──────────────────────────────────────────────────────────────────────
 *
 * 约束只走一条路：正则打分 → 形状门 → `selectConstraints` 分 PASS1(进 prompt，≤5 条) / PASS2(archived)。
 * **没有任何「否决」概念**：`archived` 是「保留但这次不进 prompt」，`droppedByShape` 是「形状不像一句
 * 话」。被否决过的文本下一次仍会被抽上来 —— 这一层缺失。
 *
 * ── 本批要建的两条轨道 ───────────────────────────────────────────────────────────────────────────
 *
 *   否决轨：某条文本被 reject 过 ⇒ 抽取时直接跳过（过滤插在 `selectConstraints` **之前**，
 *           因为候选文本在进池时已规范化 —— 过滤必须发生在规范化之后、选择之前）。
 *   主动轨：模型主动 add 的约束 ⇒ 不受正则分数影响，直接以 `tier: 'redline'` 进 PASS1。
 *
 * ── 持久化：选项 2（全局单文件 + workspace 字段）────────────────────────────────────────────────
 *
 * 不按 workspace 分文件（会产生不可枚举的一组文件，「哪些 workspace 否决过约束」无法一眼看全），
 * 也不接受全局语义（约束是**项目级**事实：「A 项目否决了这条文本」不应让 B 项目也否决）。
 * 记录形状：`{ text, rejectedBy, generation, workspace, reason, at }`。
 *
 * 两条硬要求（否则选项 2 会退化成选项 3）：
 *   · **workspace 必须先归一化再比较**（`D:\x` / `d:/x/` / `D:\x\` 是同一个）；
 *   · **没有 `workspace` 字段的旧记录 ⇒ 不参与过滤 + 打印一次 WARN**（不许静默当成全局）。
 *
 * ── 本文件的期望状态（TDD 第 1 步）──────────────────────────────────────────────────────────────
 *
 *   ① ② ⑤ ⑥ ⑦ **现在必红** —— 它们依赖尚不存在的导出（`filterRejectedConstraints` /
 *      `applyManualConstraints` / `normalizeWorkspace`）。
 *   ③ ④ 现在**必绿** —— 它们是回归守卫：主动轨不许打破 5 条上限与字符预算，
 *      否决过滤不许改写 `droppedByShape` 的语义（那是「形状不像一句话」，不是「被否决」）。
 *
 * 所以 `npm test` 现在应当是 5 fail / 2 pass —— 这是这一步的**产物**，不是回归。
 * 实现落地后它们必须全绿；届时 README 的计数 `853 / 855` 也要同步成 `860 / 862`
 * （7 条新测试），`852→855` 那两处同理 —— 同一次提交里改。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)

/** 一个候选，形状与 `ConstraintCandidate` 一致（`selectConstraints` 只读这三个字段）。 */
const c = (text, index, score = 10) => ({ text, index, score })

/** 尚不存在的导出必须报「未实现」，而不是 `undefined is not a function` 这种无信息崩溃。 */
const need = (name) => {
  const value = mod[name]
  assert.equal(typeof value, 'function', `${name} 尚未实现（B1-5 第 1 步：本测试现在就该红）`)
  return value
}

const WS_A = 'D:\\持久层能力架构'
const WS_B = 'D:\\other-project'
const at = '2026-11-17T00:00:00.000Z'

test('① 被 reject 过的文本不再被抽上来（过滤在 selectConstraints 之前）', () => {
  const filter = need('filterRejectedConstraints')
  const candidates = [c('绝对不要 force push', 1), c('必须写测试', 2)]
  const records = [{ text: '必须写测试', workspace: WS_A, rejectedBy: 's1', generation: 5, reason: '不适用于本项目', at }]

  const { kept, rejected } = filter(candidates, { workspace: WS_A, records })
  assert.deepEqual(kept.map((x) => x.text), ['绝对不要 force push'])
  assert.deepEqual(rejected.map((x) => x.text), ['必须写测试'])

  // 端到端：它既不在 prompt，也不在 archived —— 「否决」不是「降级保留」。
  const selection = mod.selectConstraints(kept)
  assert.ok(!selection.constraints.includes('必须写测试'))
  assert.ok(!selection.archived.includes('必须写测试'))
})

test('② 主动 add 的约束进 prompt，不受正则分数影响', () => {
  const applyManual = need('applyManualConstraints')
  // 低分、且不含任何 redline 关键词 —— 只靠正则这条路它进不了 PASS1。
  const scored = [c('写文档要短', 1, 1)]
  const manual = '每次都跑 npm run check'
  const withManual = applyManual(scored, [manual], { indexBase: 100 })

  const selection = mod.selectConstraints(withManual)
  assert.ok(selection.constraints.includes(manual),
    '主动声明的约束必须进 PASS1；它不该靠与正则打分竞争获胜')
  assert.ok(selection.redlineCount >= 1)
})

test('③ 回归守卫：主动轨不破坏 5 条上限与字符预算（端到端，不是 selectConstraints 的独自表演）', () => {
  /**
   * ── THIS ASSERTION IS THE REASON THE MANUAL TRACK CANNOT BE A BACK DOOR ─────────────────────────
   *
   * The first version called `selectConstraints(many)` directly — which passes with or without
   * `applyManualConstraints`, i.e. it tested a pure function and called it a guard on the manual
   * track. Measured review 2026-11-17: 「如果实现时 applyManualConstraints 注入 10 条 redline，③ 仍然
   * 是绿的，因为它根本没走那条路」.
   *
   * So it now goes THROUGH the manual track. An unbounded manual track would let a model stuff the
   * prompt without limit, which is more dangerous than a bug in passive extraction: the prompt is
   * spent on every turn.
   */
  const applyManual = need('applyManualConstraints')
  const ten = Array.from({ length: 10 }, (_, i) => `主动声明的规则 ${i}`)
  const injected = applyManual([], ten, { indexBase: 0 })
  const selection = mod.selectConstraints(injected)

  assert.equal(selection.constraints.length, mod.CONSTRAINT_PROMPT_MAX, '主动轨也必须受 5 条上限约束')
  assert.ok(selection.totalChars <= mod.CONSTRAINT_BUDGET_CHARS, '主动轨也必须受字符预算约束')
  assert.equal(selection.archived.length, 10 - mod.CONSTRAINT_PROMPT_MAX,
    '没进 prompt 的仍然被保留（archived），不是被删掉')
  assert.equal(selection.candidateCount, 10)
})

test('④ 回归守卫：droppedByShape 的语义不变（被否决 ≠ 形状不合格）', () => {
  const selection = mod.selectConstraints([c('绝对不要 force push', 1)])
  assert.deepEqual(selection.droppedByShape, [],
    'selectConstraints 不产 shape drop；否决记录也不能借用这个字段 —— '
    + '它的语义是「这段文本不像一句独立的话」，提高预算不该把人否决过的文本带回来，反过来也一样')
  assert.deepEqual(selection.dropped.map((d) => d.reason).filter((r) => r !== 'budget'), [],
    'dropped 只允许是 budget')
})

test('⑤ 跨 workspace 隔离：A 否决的文本，在 B 仍能被抽出（本次裁定的核心）', () => {
  const filter = need('filterRejectedConstraints')
  const records = [{ text: '要写测试', workspace: WS_A, rejectedBy: 's1', generation: 5, reason: '', at }]

  const inA = filter([c('要写测试', 1)], { workspace: WS_A, records })
  assert.deepEqual(inA.kept, [], 'A 否决过 ⇒ A 里不再抽上来')

  const inB = filter([c('要写测试', 1)], { workspace: WS_B, records })
  assert.deepEqual(inB.kept.map((x) => x.text), ['要写测试'],
    '约束是项目级事实：B 没否决过它，就必须仍能抽出。没有这一条，选项 2 就退化成全局否决')
})

test('⑥ workspace 归一化：D:\\x 与 d:/x/ 视为同一个', () => {
  const normalize = need('normalizeWorkspace')
  assert.equal(normalize('D:\\x'), normalize('d:/x/'))
  assert.equal(normalize('D:\\x\\'), normalize('D:/x'))
  assert.notEqual(normalize('D:\\x'), normalize('D:\\x2'))
  // 归一化之后仍然要有意义（不是把所有输入都压成同一个常量）。
  assert.notEqual(normalize('D:\\x'), normalize('D:\\y'))
})

test('⑦ 没有 workspace 字段的旧记录：不参与过滤，且只 WARN 一次', () => {
  const filter = need('filterRejectedConstraints')
  const legacy = { text: '要写测试', rejectedBy: 's1', at } // ← 旧记录：没有 workspace
  const warns = []

  const one = filter([c('要写测试', 1)], { workspace: WS_A, records: [legacy], warn: (m) => warns.push(m) })
  assert.deepEqual(one.kept.map((x) => x.text), ['要写测试'],
    '没有 workspace 字段的旧记录不许静默当成全局否决（那是 D14「安静地不匹配」的反面）')
  assert.equal(warns.length, 1, '必须恰好 WARN 一次')
  assert.match(warns[0], /workspace/iu, 'WARN 必须点名原因：记录缺少 workspace 字段')

  const warns2 = []
  filter([c('a', 1), c('b', 2)], { workspace: WS_A, records: [legacy, { ...legacy, text: 'b' }], warn: (m) => warns2.push(m) })
  assert.equal(warns2.length, 1, '多条旧记录也只 WARN 一次 —— 每条一次会把日志冲掉')
})
