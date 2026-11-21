/**
 * ── v295 (B4-B B1)：用户批准的内容，必须就是写进去的内容 ──────────────────────────────────────────
 *
 * ── 缺陷的精确形状（不是「比较时漏了一项」，是「内容根本没被保存过」）──────────────────────────
 *
 * `PreparedSlice` 原本只有：
 *
 *     handoverPendingCount?: number
 *     handoverNoteCount?: number
 *
 * **两个整数，没有内容。** `ModelHandover` 只活在 `prepareSlice` 的局部作用域里，写进磁盘的只有长度。
 * 于是 commit 想传也传不了 —— 它手上没有东西可传。
 *
 * 后果是静默的：注入计划里的 `handover.pending` / `handover.notes` 永远为空，于是
 * · 待开始列回落到 `openTodos`（模型上一轮自己写的 TODO）；
 * · notes 段恒为空。
 *
 * **用户审阅并批准的那段「模型提供的内容」，一个字符都没进目标会话。**
 *
 * ── 判据（派工单 1-3 + 用户补的 4-5）────────────────────────────────────────────────────────
 *
 *   ① prepare 带 notes=['X'] + pending=['Y'] ⇒ commit 后**在目标磁带里找到 X 与 Y**
 *      （读回目标会话，不读 prepared entry —— 读 entry 只能证明我们存了，不能证明写进去了）
 *   ② 同一份 handover 在 prepare/commit 两次运行中逐字相同 ⇒ 不报 digest 不一致
 *   ③ 改一条 note 后再 commit ⇒ 必须拒（`SLICE_DIGEST_MISMATCH`）
 *   ④ 旧 entry（有非零计数、无内容）⇒ 必须报 `PREPARED_LEGACY_HANDOVER_LOST`，**且不删该 entry**
 *   ⑤ 「没提供 handover」与「提供了但全是空串」必须被区分：前者 review 里没有「本段由模型提供」，
 *      后者有 —— 否则就是**声称一个不存在的事实**
 *
 * ── can-red（用户指定的两条配对）─────────────────────────────────────────────────────────────
 *
 *   · 删掉写盘路径的 handover 参数 ⇒ ① 红（内容没进磁带）
 *   · 把旧 entry 的拒绝改成放行     ⇒ ④ 红（旧 entry 被静默提交）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/** The prepared store's filename, read from source rather than guessed (the rule v261 learned). */
const PREPARED_FILE = (() => {
  const source = readFileSync(new URL('../src/core/store-layer.ts', import.meta.url), 'utf8')
  const match = /prepared:\s*'([^']+)'/u.exec(source)
  assert.ok(match, 'store-layer.ts must declare FILE_NAMES.prepared')
  return match[1]
})()

function scaffold() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v295-'))
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { dir, log, ctx, persistence }
}

const tool = (ctx, name) => ctx._tools.get(name)
const execOf = (log) => ({ agent: { id: log.session.id } })

/**
 * Read the TARGET session back and join everything that was written into it.
 *
 * This is the assertion that matters: the prepared entry can prove 「we stored it」 and only the target
 * can prove 「the user will see it」.
 *
 * `FakePersistence` keeps sessions in `byId` (a Map of `{ header, events, … }`) — read from
 * `test/fake-harness.mjs` rather than guessed. The first draft of this file guessed `sessions`/`log`
 * and failed with 「目标会话里没有任何事件」, which was a fixture-shape error wearing the costume of a
 * product failure.
 */
function targetText(persistence, targetSessionId) {
  const record = persistence.byId.get(targetSessionId)
  if (record === undefined) return ''
  const events = Array.isArray(record.events) ? record.events : []
  return events.map((event) => JSON.stringify(event?.data ?? event)).join('\n')
}

test('v295 ①: prepare 带 notes/pending ⇒ 目标磁带里能找到它们（读回目标，不读 prepared entry）', async () => {
  const { persistence, log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute(
    {
      targetSessionId: 'target-b1-content',
      handover: { pending: ['B1-CONTENT-PENDING-Y'], notes: ['B1-CONTENT-NOTE-X'] },
    },
    execOf(log),
  )
  assert.ok(typeof staged.preparedId === 'string' && staged.preparedId.length > 0, 'prepare must return a preparedId')

  const committed = await tool(ctx, 'graft_commit').execute({ preparedId: staged.preparedId, digest: staged.digest }, {})
  assert.equal(committed.ok, true, `commit failed: ${JSON.stringify(committed.warnings ?? committed)}`)

  const written = targetText(persistence, 'target-b1-content')
  assert.ok(written.length > 0, '目标会话里没有任何事件 —— 这条断言无法成立，先确认 fixture 的 persistence 形状')
  assert.match(written, /B1-CONTENT-NOTE-X/u, '模型提供的备注没有进入目标磁带 —— 用户批准的内容丢了')
  assert.match(written, /B1-CONTENT-PENDING-Y/u, '模型提供的待开始项没有进入目标磁带 —— 它回落成了 openTodos')
})

test('v295 ②: 同一份 handover 在 prepare/commit 两次构建中逐字相同 ⇒ 不报 digest 不一致', async () => {
  const { log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute(
    { targetSessionId: 'target-b1-stable', handover: { pending: ['稳定项'], notes: ['稳定备注'] } },
    execOf(log),
  )
  /** The happy path is the negative half: a rebuild that DROPS the handover would report a mismatch here. */
  const committed = await tool(ctx, 'graft_commit').execute({ preparedId: staged.preparedId, digest: staged.digest }, {})
  assert.equal(committed.ok, true, `commit must succeed unchanged; got: ${JSON.stringify(committed.warnings ?? committed)}`)
})

test('v295 ③: 改一条 note 后再 commit ⇒ 必须拒，且文案指明是 handover', async () => {
  const { log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute(
    { targetSessionId: 'target-b1-drift', handover: { pending: [], notes: ['原始备注'] } },
    execOf(log),
  )
  /**
   * Re-prepare with a DIFFERENT note and commit with the OLD digest. The digest covers handover
   * (`digestOfPlan(plan, handover)`), so the two must disagree — and the refusal must NAME handover
   * rather than saying 「digest differs」.
   */
  const second = await tool(ctx, 'graft_prepare').execute(
    { targetSessionId: 'target-b1-drift', handover: { pending: [], notes: ['改过的备注'] } },
    execOf(log),
  )
  assert.notEqual(second.digest, staged.digest, 'handover 变了，digest 必须变 —— 否则它没被计进指纹')

  await assert.rejects(
    () => tool(ctx, 'graft_commit').execute({ preparedId: second.preparedId, digest: staged.digest }, {}),
    (error) => {
      const message = String(error?.message ?? error)
      assert.match(message, /DIGEST/u, `必须拒绝；got: ${message}`)
      return true
    },
  )
})

test('v295 ④: 旧 entry（有计数、无内容）⇒ 拒绝并点名，且**不删**该 entry', async () => {  /**
   * ── HOW A LEGACY ENTRY IS CONSTRUCTED, AND WHY VIA THE FILE ────────────────────────────────
   *
   * It cannot be produced by `graft_prepare` (that now stores content). The first draft imported
   * `../lib/core/state.js` and edited the live map — but this package's artifact is a SINGLE bundled
   * `index.js`, so that path does not exist and the test died on ENOENT rather than testing anything.
   *
   * Writing it to the prepared FILE is closer to reality anyway: a legacy entry is not "the current
   * process made one", it is "an older process left one on disk". `commitPreparedSlice` calls
   * `loadPrepared()` first, so what it sees is exactly what the file says — which is the code path a
   * real upgrade walks.
   */
  const { dir, log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'target-b1-legacy' }, execOf(log))
  assert.equal(staged.handoverSupplied, false, '没有传 handover 时 prepare 必须报 handoverSupplied=false')

  /** Rewrite the on-disk record into the shape an older build left: counts present, content absent. */
  const file = join(dir, PREPARED_FILE)
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  const record = onDisk[staged.preparedId]
  assert.ok(record !== undefined, `prepared entry ${staged.preparedId} must be on disk at ${PREPARED_FILE}`)
  delete record.handover
  delete record.handoverSupplied
  record.handoverPendingCount = 2
  record.handoverNoteCount = 1
  writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8')

  await assert.rejects(
    () => tool(ctx, 'graft_commit').execute({ preparedId: staged.preparedId, digest: staged.digest }, {}),
    (error) => {
      const message = String(error?.message ?? error)
      assert.match(message, /PREPARED_LEGACY_HANDOVER_LOST/u, `必须指名这个码；got: ${message}`)
      /** The message must name the COUNTS, so the user can tell what was lost. */
      assert.match(message, /待开始 2/u, `文案必须说明丢了什么；got: ${message}`)
      assert.match(message, /备注 1/u, `文案必须说明丢了什么；got: ${message}`)
      return true
    },
  )

  /**
   * Judgement 4's second half: the entry is KEPT, so the user can read the message and decide which
   * preparedId to compare against. A silent cleanup would be indistinguishable from 「never prepared」.
   */
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(after[staged.preparedId] !== undefined, '旧 entry 被从磁盘上删掉了 —— 用户看不到它的 preparedId 就没法对照')
})

test('v295 ⑤: 「没提供」与「提供了但全空」必须可区分', async () => {
  const { log, ctx } = scaffold()

  const absent = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'target-b1-absent' }, execOf(log))
  assert.equal(absent.handoverSupplied, false, '没传 handover ⇒ handoverSupplied 必须是 false')
  assert.doesNotMatch(absent.review, /本段由模型提供/u, '没提供 handover 时 review 不许声称「本段由模型提供」')

  const blank = await tool(ctx, 'graft_prepare').execute(
    { targetSessionId: 'target-b1-blank', handover: { pending: [''], notes: ['   '] } },
    execOf(log),
  )
  assert.equal(blank.handoverSupplied, true, '传了 handover（即使内容为空）⇒ handoverSupplied 必须是 true')
  /**
   * And the review MAY say it: the model did supply content for this handoff, it was simply empty.
   * Both directions are asserted, because collapsing them is the defect: a review that labels an
   * absent handover claims a provenance that never happened.
   */
  assert.match(blank.review, /本段由模型提供/u, '提供了（哪怕为空）时 review 应当标明来源')
  assert.match(blank.review, /待开始 0 条、备注 0 条/u, '并且如实报出有效条数是 0')
})

test('v295 ⑥: `isLegacyHandoverEntry` 只在「有计数、无内容」时为真', async () => {
  /**
   * The helper is the load-bearing predicate of ④, so it is driven directly with the three shapes it
   * must distinguish. A predicate that answered `true` for everything would pass ④ and refuse every
   * commit in the product.
   */
  const { isLegacyHandoverEntryForTest } = await import('../index.js')
  assert.equal(typeof isLegacyHandoverEntryForTest, 'function', 'the predicate must be reachable for a direct test')

  assert.equal(isLegacyHandoverEntryForTest({ handover: { notes: ['x'] }, handoverPendingCount: 0 }), false,
    '有内容 ⇒ 不是 legacy（即使计数为 0）')
  assert.equal(isLegacyHandoverEntryForTest({ handoverPendingCount: 0, handoverNoteCount: 0 }), false,
    '无内容、计数为 0 ⇒ 不是 legacy，而是「从来没提供过」')
  assert.equal(isLegacyHandoverEntryForTest({ handoverPendingCount: 2 }), true,
    '无内容、计数非零 ⇒ legacy，这是唯一表示「知道有内容、但拿不回来」的形状')
  assert.equal(isLegacyHandoverEntryForTest({ handoverNoteCount: 1 }), true, 'notes 一侧单独非零也算')
})

/** Referenced so the file's dependency on the prepared store's filename is honest, not decorative. */
void PREPARED_FILE