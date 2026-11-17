/**
 * ── v224：接缝与工具接线（B1-5 第 6 步）────────────────────────────────────────────────────────
 *
 * ── 为什么需要这个文件（实测，2026-11-17）──────────────────────────────────────────────────────
 *
 * v222 的 ①⑤⑦ 与 v223 的往返把 **函数** 和 **store** 都钉住了，但 `src/` 里搜
 * `filterRejectedConstraints` 只出现两处：一处是注释，一处是定义 —— **没有调用点**。
 * 也就是说那 8 条测试证明的是「如果调用它，它会正确过滤」，而不是「它会被调用」。
 *
 * 而 `index.ts` 的注释当时写着「It is applied by the extraction path」。**那句注释是假的**，
 * 比沉默更糟：下一个读代码的人会因此不再找这条接缝。
 *
 * 这正是本仓反复记录的那一类：一条绿得很漂亮的测试，守着一个没人走的分支。
 *
 * ── 本文件钉住的两件事 ──────────────────────────────────────────────────────────────────────────
 *
 *   ① **生产路径真的过滤**：`buildInjectionPlan`（工具层唯一入口）必须把否决记录读进来并生效，
 *      而不是只在 `extractConstraintsDetailed(..., {records})` 手传时才生效。
 *   ② **工具接线**：`graft_constraint` 已注册、四种动作都能调用、有回执、且 promote/demote
 *      在没有对应旧状态时**拒绝**（不是默默等于 add/reject）。
 *
 *  ③ 顺手钉住「stored fragment 不许进」：`graft_constraint` 是主动轨唯一的写入口，
 *      它若不判形状，存进去的碎片会在下一轮被无判据地注入 —— TD-11 的边界就破了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { apply, buildInjectionPlan, readConstraintRejections, constraintRejectionPath } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)

const WS = 'D:\\持久层能力架构'
const RULE = '绝对禁止在没有备份的情况下删除任何脚本'

/** 一个带一条可抽取规则的源日志，cwd 固定为 WS。 */
function logWithRule(sessionId = 'session-wiring') {
  const log = makeSourceLog({ turns: 2, sourceSessionId: sessionId, cwd: WS })
  log.events.push({
    type: 'user/message',
    seq: log.events.length,
    time: Date.now(),
    data: {
      id: 'rule-1',
      role: 'user',
      content: [{ type: 'text', text: RULE }],
      source: { kind: 'user' },
    },
  })
  return log
}

const call = (tool, args, sessionId) =>
  tool.execute(args, { agent: { id: sessionId }, callId: 'c1', name: 'graft_constraint', arguments: args, signal: undefined })

test('① 生产路径真的过滤：buildInjectionPlan 读得到 store 里的否决记录', async () => {
  /**
   * ── THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT THE MISSING WIRING ───────────────────────────
   *
   * It goes through `buildInjectionPlan` — the single choke point every tool path shares — and NOT
   * through `extractConstraintsDetailed(..., { records })`. The earlier version of this guarantee was
   * tested by handing records to the pure function by hand, which is exactly the reading that made a
   * missing call site invisible: the test and the production path agreed on the function's contract
   * while disagreeing on whether it is ever called.
   */
  const dir = mkdtempSync(join(tmpdir(), 'graft-wiring-'))
  try {
    const log = logWithRule('session-wiring-filter')
    const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
    apply(ctx, { dataDir: dir })

    // 先证明它本来会被抽上来（否则下一条断言就是空转）。
    const before = buildInjectionPlan(log, {})
    assert.ok(before.constraints.includes(RULE) || before.constraintIntegrity.candidateCount >= 1,
      `前置条件：这条规则本来应当进入候选池，实测 candidateCount=${before.constraintIntegrity.candidateCount}`)

    const tool = ctx._tools.get('graft_constraint')
    assert.ok(tool !== undefined, 'graft_constraint 必须已注册（B1-5 第 6 步）')

    // 用工具写一条否决（而不是手写文件）：两个动作一起验。
    const receipt = await call(tool, { action: 'reject', text: RULE, workspace: WS, reason: 'v224' }, log.session.id)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.action, 'reject')
    assert.equal(receipt.effect, 'rejected', '回执必须说明它生效在「否决」这条轨道上')

    const file = constraintRejectionPath(dir)
    assert.equal(existsSync(file), true, 'reject 必须真的落盘')
    assert.equal(readConstraintRejections(file).length, 1)

    /**
     * 同一个 cwd ⇒ 生产路径必须把它过滤掉。注意这里**没有**传任何 records：
     * 如果 `buildInjectionPlan` 没接上 store，这条断言就会红 —— 这正是它的用途。
     */
    const after = buildInjectionPlan(log, {})
    assert.equal(after.constraints.includes(RULE), false,
      '被否决的文本不许再进 prompt（生产路径，不是手传 records 的纯函数）')
    assert.equal(after.constraintIntegrity.candidateCount, 0,
      `被否决的候选不该进入候选池，实测 candidateCount=${after.constraintIntegrity.candidateCount}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② 跨 workspace 在生产路径上隔离：另一个 cwd 的 plan 仍抽得到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-wiring-ws-'))
  try {
    const log = logWithRule('session-wiring-ws')
    const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
    apply(ctx, { dataDir: dir })
    const tool = ctx._tools.get('graft_constraint')
    await call(tool, { action: 'reject', text: RULE, workspace: WS }, log.session.id)

    const other = logWithRule('session-wiring-other')
    other.session.cwd = 'D:\\other-project'
    const plan = buildInjectionPlan(other, {})
    assert.ok(plan.constraintIntegrity.candidateCount >= 1,
      '约束是项目级事实：B 项目没否决过它，就必须仍能抽到（否则选项 2 退化成全局否决）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ 工具接线：add 进 prompt（不经正则打分），promote/demote 要求对应旧状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-wiring-tool-'))
  try {
    const log = logWithRule('session-wiring-tool')
    const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
    apply(ctx, { dataDir: dir })
    const tool = ctx._tools.get('graft_constraint')
    /**
     * 这条文本必须同时满足两个门：形状门（是一句独立的话）与 add 的额外门槛（读起来像规则）。
     * 第一版是 `每次提交前都要跑一遍 npm run check` —— 形状合格但**没有规则词、也不是祈使开头**，
     * 所以被 add 的严格判据拒绝了。那是判据在正常工作，不是测试该绕过去的东西：
     * 想让它别再被抽上来，用 reject；想主动声明它，就得说成一条规则。
     */
    const declared = '必须每次提交前都跑一遍 npm run check'

    // promote 在没有否决记录时必须拒绝 —— 否则回执会声称一次没发生的撤销。
    const early = await call(tool, { action: 'promote', text: declared, workspace: WS }, log.session.id)
    assert.equal(early.ok, false)
    assert.match(String(early.error), /add/u, '拒绝消息要指出正确动作是 add')

    const added = await call(tool, { action: 'add', text: declared, workspace: WS }, log.session.id)
    assert.equal(added.ok, true)
    assert.equal(added.effect, 'prompt')

    const plan = buildInjectionPlan(log, {})
    assert.ok(plan.constraints.includes(declared),
      '主动声明的约束必须进 prompt；它不该靠与正则打分竞争获胜')

    // demote 在没有声明记录时必须拒绝（先 promote 掉那条否决，再验 demote 的存在性检查）。
    const demoteMissing = await call(tool, { action: 'demote', text: '从未声明过的规则', workspace: WS }, log.session.id)
    assert.equal(demoteMissing.ok, false)
    assert.match(String(demoteMissing.error), /reject/u)

    const demoted = await call(tool, { action: 'demote', text: declared, workspace: WS }, log.session.id)
    assert.equal(demoted.ok, true)
    assert.equal(demoted.effect, 'rejected', 'demote 的落点是否决轨')
    const afterDemote = buildInjectionPlan(log, {})
    assert.equal(afterDemote.constraints.includes(declared), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 主动轨唯一的写入口要判形状：碎片被拒绝，不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-wiring-shape-'))
  try {
    const log = logWithRule('session-wiring-shape')
    const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
    apply(ctx, { dataDir: dir })
    const tool = ctx._tools.get('graft_constraint')
    /**
     * A table row is the canonical fragment: it is short, it reads like a rule, and it is exactly the
     * shape `shapeOfConstraint` exists to refuse. If this were stored, every later handoff would inject
     * it WITHOUT re-judging — which is the five-fragment failure of generation 8 through a new door.
     */
    const fragment = '| 必须 | 禁止 | 绝对 |'
    let error
    try {
      await call(tool, { action: 'add', text: fragment, workspace: WS }, log.session.id)
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== undefined, '碎片必须被拒绝（抛错），不许静默存下来')
    assert.match(String(error.message ?? error), /S2_TABLE|not a standalone sentence/u, '拒绝消息要点明形状判据')
    assert.equal(existsSync(join(dir, 'constraint-manual.json')), false, '被拒绝的碎片不许留下文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ 两种记录不共存：add 撤销旧否决，reject 撤销旧声明', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-wiring-exclusive-'))
  try {
    const log = logWithRule('session-wiring-exclusive')
    const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
    apply(ctx, { dataDir: dir })
    const tool = ctx._tools.get('graft_constraint')

    await call(tool, { action: 'reject', text: RULE, workspace: WS }, log.session.id)
    await call(tool, { action: 'add', text: RULE, workspace: WS }, log.session.id)
    const rejections = readConstraintRejections(constraintRejectionPath(dir))
    assert.equal(
      rejections.some((r) => r.text === RULE),
      false,
      'add 必须撤销同文本的旧否决 —— 两条记录同时存在时，结果取决于哪个读取者先看，那就是两种读法',
    )

    await call(tool, { action: 'reject', text: RULE, workspace: WS }, log.session.id)
    const manualRaw = readFileSync(join(dir, 'constraint-manual.json'), 'utf8')
    assert.equal(manualRaw.includes(RULE), false, 'reject 必须撤销同文本的旧声明（同一理由）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑥ 旧记录（无 workspace）：生产路径上不参与过滤，且 WARN 进 plan.warnings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-wiring-legacy-'))
  try {
    const log = logWithRule('session-wiring-legacy')
    const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
    apply(ctx, { dataDir: dir })
    /**
     * 手写一条**没有 workspace 字段**的记录：模拟 B1-5 之前的旧数据。
     * 它必须（a）不参与过滤（b）产生恰好一条 WARN 并被 plan 渲染出来。
     * 静默当成全局否决，就是「安静地匹配一切」，与 D14 的「安静地什么都不匹配」同一家族。
     */
    const file = constraintRejectionPath(dir)
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ text: RULE, rejectedBy: 'old', at: '2026-01-01T00:00:00.000Z' }] }), 'utf8')

    const plan = buildInjectionPlan(log, {})
    assert.ok(plan.constraintIntegrity.candidateCount >= 1, '旧记录不许过滤任何东西')
    assert.equal(plan.warnings.filter((w) => /workspace/u.test(w)).length, 1,
      `必须恰好一条点名 workspace 的 WARN，实测 ${JSON.stringify(plan.warnings)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑧ 两个方向用不同的门槛：reject 接受「不像规则」，add 拒绝它（放宽朝安全侧）', async () => {
  /**
   * ── THE TWO DIRECTIONS DO NOT FAIL THE SAME WAY, SO THEY MUST NOT BE JUDGED THE SAME WAY ────────
   *
   * Measured before this assertion existed: one judge for all four actions, and the STRICT part of it
   * (`isConstraintSentence` / `IMPERATIVE_START`) was not applied to `add` at all — only the shape gate
   * was. So the model could `add` any well-formed-but-not-a-rule sentence and have it injected into
   * the prompt on every later turn without ever being re-judged.
   *
   * The correct asymmetry:
   *
   *   reject / demote — the text LEAVES the pool. The user is pointing at a specific string, often one
   *                     extraction produced by splitting a paragraph. Demanding it read like an
   *                     imperative refuses the user's own words at the moment they are being precise,
   *                     and a loose record cannot inject anything.
   *
   *   add / promote   — the text ENTERS the pool and is re-injected forever. A non-rule stored here is
   *                     permanent prompt content ⇒ it must also read like a rule.
   *
   * Relaxing the SAFE side is the whole point: if the relaxation were on `add`, this test would have to
   * assert that a non-rule got into the prompt, which is the failure TD-11 exists to prevent.
   */
  const dir = mkdtempSync(join(tmpdir(), 'graft-wiring-two-modes-'))
  try {
    const log = logWithRule('session-wiring-modes')
    const ctx = makeCtx({ sourceLog: log, paths: { data: dir } })
    apply(ctx, { dataDir: dir })
    const tool = ctx._tools.get('graft_constraint')

    /**
     * A sentence that is a perfectly good standalone sentence, contains no rule vocabulary, and does
     * not open with an imperative. `shapeOfConstraint` is happy with it — that is exactly the gap.
     */
    const notARule = '那个文件在星期二之后就不需要了。'

    const rejected = await call(tool, { action: 'reject', text: notARule, workspace: WS }, log.session.id)
    assert.equal(rejected.ok, true,
      `reject 必须接受「不像规则但形状合格」的文本：用户就是指着这一句说别再用。实测：${JSON.stringify(rejected)}`)
    assert.equal(rejected.effect, 'rejected')

    let error
    try {
      await call(tool, { action: 'add', text: notARule, workspace: WS }, log.session.id)
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== undefined,
      'add 必须拒绝「不像规则」的文本 —— 它会进 prompt 且不再被重判形状，放它进来就是 TD-11 的破口')
    assert.match(String(error?.message ?? error), /add\/promote 只接受/u, '拒绝消息要说明门槛与替代动作')
    // 它还必须是可执行的建议：告诉用户该用哪个 action。
    assert.match(String(error?.message ?? error), /reject/u)

    /**
     * And the strictness is not accidental: a real rule still passes, so the gate is a filter rather
     * than a wall. Without this half, the test would be satisfied by refusing everything.
     */
    const realRule = '绝对禁止在没有备份的情况下删除任何脚本'
    const added = await call(tool, { action: 'add', text: realRule, workspace: WS }, log.session.id)
    assert.equal(added.ok, true, `真正的规则必须能 add。实测：${JSON.stringify(added)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑦ re-export: 新导出必须真的在 bundle 的导出面上（否则外部只能靠 src 路径）', () => {
  for (const name of [
    'filterRejectedConstraints',
    'applyManualConstraints',
    'normalizeWorkspace',
    'readConstraintRejections',
    'appendConstraintRejection',
    'readManualConstraints',
    'appendManualConstraint',
    'removeManualConstraint',
    'removeConstraintRejection',
    'manualTextsForWorkspace',
    'constraintManualPath',
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} 必须在 index.js 的导出面上`)
  }
})
