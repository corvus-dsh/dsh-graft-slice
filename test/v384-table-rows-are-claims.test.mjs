/**
 * ── v384：表行豁免必须收窄，写而不执行的豁免必须删除（N7 / N8，S17）────────────────────────────────
 *
 * **N7（P2）**：`check-reported-numbers.mjs:103` 是 `if (/^\s*\|/u.test(line)) continue` ——
 * **整行跳过每一行表格**。实测后果：6 处关键数字因此免检，其中 TD-2 的立论依据写着
 * 「`src/index.ts` 约 1,300 行」而实测 **2,890** —— **差一倍多**。
 * **一条被豁免的数字，正好是一条错的数字**，而它决定的正是这条技术债该不该存在。
 *
 * **N8（P3）**：`ACCOUNT` 豁免实际**命中 0 次**。5 行账目标题都含「第 N 簇」，但没有一行同时含
 * 测试数或行数 —— 豁免每次都排在别的分支之后、永远不被触达。**一条写了却从不执行的规则，
 * 比没有更坏**：它让人以为那个情形已被处理。
 *
 * ── 判据五条 ──────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 表头与分隔行仍然豁免（`| 项 | 内容 |`、`|---|---|`）—— 它们不含数据
 *   ② **负向**：数据行**不**豁免。合成的 `| x | 12 / 348 |` 必须被抓到
 *   ③ `any-cell` 陷阱：一个含数字的行，即使某一格像列名，也**不得**被判成表头
 *   ④ 真实文档通过：ARCHITECTURE.md 零未引用（含 TD-2 那条已改正的 2,890）
 *   ⑤ **负向**：把一条数据行改回「约 N 行」的无出处形态 ⇒ 红
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = 'file://' + join(ROOT, 'scripts', 'check-reported-numbers.mjs').replace(/\\/gu, '/')

const { isTableHeaderOrSeparator, uncitedClaims } = await import(GATE)

test('v384 ①: a real header and a separator ARE exempt', () => {
  assert.equal(isTableHeaderOrSeparator('| 项 | 内容 |'), true, '① 「| 项 | 内容 |」是表头')
  assert.equal(isTableHeaderOrSeparator('|---|---|'), true, '① 分隔行必须豁免')
  assert.equal(isTableHeaderOrSeparator('| 模块 | 职责（一句话） | 导出 | 依赖（本地模块） |'), false,
    '① 「职责（一句话）」不是纯列名，这行是**真表头**但含描述 —— 它不该被当成数据行要求出处，' +
    '也不该因为一格不是列名就被判成数据行。这条断言记录的是当前取舍：保守地按数据行处理，宁可多查')
})

test('v384 ② (negative): a DATA row is NOT exempt — the N7 defect', () => {
  const tableWithUncitedData = [
    '| 项 | 内容 |',
    '|---|---|',
    '| 现状 | `src/index.ts` 约 1,300 行 |',
  ].join('\n')

  const problems = uncitedClaims(tableWithUncitedData)
  assert.equal(problems.length, 1,
    `② 数据行里的「约 1,300 行」必须被抓到，实测 ${problems.length} 处：${JSON.stringify(problems)}`)
  assert.ok(problems[0].raw.includes('1,300'), `② 必须点名那个数字，实测：${problems[0].raw}`)
  assert.equal(problems[0].line, 3, `② 必须点名第 3 行，实测 ${problems[0].line}`)
})

test('v384 ③ (negative): a row carrying a NUMBER is never a header, even if a cell looks like one', () => {
  /**
   * The `any-cell` trap: `| 模块 | **12 / 348** | none | … |` starts with a column name, so an
   * 「any cell is a column name」 test would exempt it. The rule is EVERY cell.
   */
  const dataRow = '| `renderTaskBoard` | **12 / 348** | none | `core/task-board.ts`（已搬） | — |'
  assert.equal(isTableHeaderOrSeparator(dataRow), false,
    '③ 含数字的数据行不得被判成表头 —— 这正是 any-cell 会漏掉的那一行')

  const problems = uncitedClaims(['| 目标 | 闭包（声明 / 行） | mutable |', '|---|---|---|', dataRow].join('\n'))
  assert.ok(problems.length >= 1, '③ 这一行必须被要求出处')
})

test('v384 ④: the real document passes — including the corrected TD-2 line', () => {
  const arch = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8')
  const problems = uncitedClaims(arch)
  assert.deepEqual(problems.map((p) => `L${p.line} ${p.text}`), [],
    `④ ARCHITECTURE.md 必须零未引用，实测：\n${problems.map((p) => `L${p.line} [${p.kind}] ${p.text}`).join('\n')}`)

  /** And the specific number N7 exposed must be the MEASURED one, not the old guess. */
  assert.ok(arch.includes('2,890 行 / 2,824 非空'),
    '④ TD-2 必须写实测的 2,890 / 2,824')
  assert.ok(!arch.includes('`src/index.ts` 约 1,300 行'),
    '④ 旧的「约 1,300 行」必须已被替换 —— 它差了一倍多，而它是那条技术债的立论依据')
})

test('v384 ⑤ (negative): restoring the uncited form is caught', () => {
  const arch = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8')
  /**
   * The row now names its repo (`dsh-memory/src/index.ts`), because `check-readme-counts` resolves a
   * bare `src/index.ts` to THIS repo and compared 2,890 against graft's 13,995.
   * **Both gates were right; they disagreed about WHICH FILE the sentence is about.** The fix belongs
   * in the document — name the repo, so neither a reader nor a gate has to guess.
   */
  const corrected = '| 现状 | **`dsh-memory/src/index.ts`** **2,890 行 / 2,824 非空**'
  if (!arch.includes(corrected)) throw new Error('⑤ 已修正的那行没找到 —— 名称可能又变了')

  /** Put the ORIGINAL defect back: a bare `src/index.ts` with a guessed number and no source. */
  const start = arch.indexOf(corrected)
  const end = arch.indexOf('\n', start)
  const regressed = `${arch.slice(0, start)}| 现状 | \`src/index.ts\` 约 1,300 行${arch.slice(end)}`

  const problems = uncitedClaims(regressed)
  assert.ok(problems.some((p) => p.raw.includes('1,300')),
    `⑤ 回退成「约 1,300 行」必须被抓到，实测：${JSON.stringify(problems)}`)
})
