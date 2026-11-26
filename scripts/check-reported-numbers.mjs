#!/usr/bin/env node
/**
 * ── KEY NUMBERS MUST CARRY THEIR SOURCE (N5 / S16, previously R3) ───────────────────────────────
 *
 * THREE TIMES IN A ROW a report quoted a number that was not read from a file:
 *
 *   · `paradise 509 / 509`   — actually 508 (a test was red)
 *   · `地板 6,762`            — the document said 6,732, and 6,732 was right
 *   · `第 3/4 簇`             — `git log --diff-filter=A` says 3 and 4, the report said 4 and 5
 *
 * The first two were caught by re-running; the third by reading git. **The common defect is not the
 * arithmetic — it is that the number had no stated origin, so nobody could check it cheaply.**
 *
 * ── WHY ONLY FOUR KINDS OF NUMBER ─────────────────────────────────────────────────────────────
 *
 * A rule that demands a source for EVERY number in a report would be red on its first paragraph and
 * would be switched off — this repository has recorded that failure mode repeatedly. So this gate
 * covers the four where being wrong has actually caused damage:
 *
 *   1. test counts          `N / M` or `N tests`
 *   2. line counts          `index.ts` … `14,067 行`
 *   3. floors / ceilings    `地板` / `ceiling` … `6,708`
 *   4. cluster ordinals     `第 N 簇`
 *
 * Each occurrence must sit on a line that ALSO names its evidence: a command (`node --test`,
 * `npm run check`, `git log`, `index-ratchet`), or an explicit provenance marker (`来源：` /
 * `measured` / `实测`).
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Only the file(s) passed on the command line. This is not a linter for the whole workspace — it is
 * pointed at a report by whoever wants it checked, the same way `check-doc-copies` is.
 *
 * Usage:
 *   node scripts/check-reported-numbers.mjs <report.md> [...]
 *   node scripts/check-reported-numbers.mjs --self-test
 *
 * Exit: 0 all cited · 1 some uncited · 2 nothing to measure (`VACUOUS`, not a pass)
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The four kinds, each with the shape that makes it a CLAIM rather than prose. */
export const KINDS = [
  {
    name: 'test-count',
    /**
     * 千分位必须进正则：`48 / 1,750` 曾因为 `\d{1,5}` 不含逗号而被截成 `48 / 1`。
     *
     * ── 并且要求有词界两侧，避免把 `2/3`（「第 2/3 层」）、`0.716 / 0.702`（比值）当断言 ──────────
     *
     * 实测（S17）：过宽的 `\d+ / \d+` 把三种东西当成了关键数字 ——
     *   · `2/2`（「那条测试抓住了 2/2」，一个**结果**而非计数断言）；
     *   · `0.716 / 0.702`（**比值**，小数点两侧）；
     *   · `第 2/3 层`（**序数**，不是分数）。
     * 前两种是 `\b` 与小数点的边界问题，第三种靠**要求 `/` 两侧有空格**排除 —— 计数断言在这份
     * 文档里一律写作 `12 / 348`，而序数写作 `2/3`。
     */
    pattern: /\b\d{1,5}\s+\/\s+\d{1,3}(?:,\d{3})*\b|\b\d{2,5}\s*(?:个)?tests?\b/gu,
  },
  {
    name: 'line-count',
    pattern: /\b\d{1,3}(?:,\d{3})+\s*行|\b\d{1,3}(?:,\d{3})+\s*lines\b/gu,
  },
  {
    name: 'floor-or-ceiling',
    pattern: /(?:地板|ceiling|下限)[^\n]{0,40}?\d{1,3}(?:,\d{3})+/gu,
  },
  {
    name: 'cluster-ordinal',
    pattern: /第\s*\d+\s*簇/gu,
  },
]

/**
 * A line cites its evidence when it names the instrument that produced the number, or carries an
 * explicit provenance marker.
 *
 * `实测` is accepted because it is this project's own word for 「I ran it」, used consistently since
 * the first audit; requiring a literal command would reject honest sentences like 「实测 508/509」.
 */
export const EVIDENCE = /node\s+--test|npm\s+run\s+check|git\s+log|index-ratchet|check-[a-z-]+\.mjs|来源[:：]|measured|实测|measuredAndCited/iu

/**
 * ── A CLUSTER ORDINAL'S SOURCE IS THE COMMIT ITSELF ───────────────────────────────────────────
 *
 * Deleting the `ACCOUNT` exemption exposed 4 lines: every 「段一 · 第 N 簇的行数账」 heading, whose only
 * number is the ordinal. Demanding a literal command on those would be wrong — the account line IS the
 * evidence for what it moved (the move is a commit), and `v378` already requires that commit to EXIST
 * and be named (`缺第 N 簇` / `声称的簇并不存在`).
 *
 * So the ordinal is cited when the line announces an account (the structure check owns it), and
 * uncited anywhere else. That is narrower than the old blanket `ACCOUNT` exemption (which also
 * swallowed any test count or line count sharing the line) and wider than demanding a command.
 */
export const ACCOUNT_LINE = /段一\s*·\s*第\s*\d+\s*簇的行数账/u

/**
 * ── TWO KINDS OF LINE ARE NOT CLAIMS ABOUT TODAY, AND MUST NOT BE DEMANDED A SOURCE ────────────
 *
 * Measured on the first real run (8 hits, and MOST were false positives):
 *
 *   1. **A DATED line** — `（**当时**：…1,462 行闭包口径）`, `historical`, `v7.6 登记`. These say
 *      「this was true at a stated moment」. Demanding today's instrument would either fail an honest
 *      historical record or push someone to delete the date.
 *   2. **An account paragraph** — `段一 · 第 N 簇的行数账：搬 77 行 … index.ts 14,324 → 14,252`.
 *      Its numbers are the paragraph's own subject; the paragraph IS the evidence (the move is in
 *      git). `v378`/`v381` already hold those numbers to an exact, gap-naming standard.
 *
 * A criterion that fires on those would be red on correct documents — the 「宽一格的判据会惩罚正确
 * 代码」 shape this repo has recorded repeatedly. So both are exempt, explicitly and with a reason.
 */
export const DATED = /当时|historical|历史|v\d+\.\d+|起(?:为)?|登记时为/u
/**
 * ── N8（S17）：这条豁免被**删除**了，因为它一次都没有执行过 ──────────────────────────────────────
 *
 * 上一版有一条 `ACCOUNT` 豁免，注释里写着「账目段的数字是它自己的主题，v378/v381 已用更严的标准
 * 管它们」。听起来合理，而实测：ARCHITECTURE.md 里 5 行账目标题都含「第 N 簇」，
 * **没有一行同时含测试数或行数** —— 豁免每次都排在别的分支之后、永远不被触达。
 *
 * **一条写了却从不执行的规则，比没有更坏**：它让人以为那个情形已被处理，于是不再去想它。
 *
 * 现在改成：账目段**不豁免**。它若带了关键数字，就必须和其它行一样写明出处。
 * （`v378`/`v381` 管的是账目段的**结构与顺序**，那是另一件事，不能顶替出处。）
 *
 * 保留这个常量作**否定断言**，让判据可以证明「这条豁免没有回来」。
 */
export const ACCOUNT_EXEMPTION_REMOVED = true

/**
 * ── WHAT A TABLE HEADER IS, AND WHY IT IS THE ONLY TABLE LINE THAT MAY BE SKIPPED ─────────────
 *
 * A separator is `|---|---|` (dashes/colons only). A header is a row whose EVERY cell is a known
 * column name — this document uses 项 / 内容 / 模块 / 仓 / 等级 / 事实 / 时点 / 目标 / 说明 / 闭包 /
 * 工单文件 / S.
 *
 * The rule is deliberately **all-cells**, not **any-cell**: a data row such as
 * `| `renderTaskBoard` | **12 / 348** | none | … |` mentions the word 「模块」 in its first cell's
 * header position on OTHER tables, and an `any-cell` test would exempt it. Requiring EVERY cell to be
 * a column name cannot be satisfied by a row that carries a number.
 *
 * That distinction is the whole fix: 6 real claims were hidden by treating 「starts with |」 as
 * 「is a header」.
 */
export const TABLE_HEADER_CELLS = /^(?:项|内容|模块|仓|等级|事实|时点|目标|说明|闭包|工单文件|编号|项点|动作|文件|状态|问题|判定|S|#)$/u

export function isTableHeaderOrSeparator(line) {
  if (!/^\s*\|/u.test(line)) return false
  /** Separator: pipes, dashes, colons and spaces only. */
  if (/^\s*\|[\s:|-]+\|\s*$/u.test(line)) return true
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
  if (cells.length === 0) return false
  return cells.every((cell) => TABLE_HEADER_CELLS.test(cell))
}

/**
 * Is `a / b` a TEST COUNT or a CLOSURE SPAN?
 *
 * ONE function, one answer — because two competing regexes would let a single row match both kinds
 * and the verdict would depend on array order.
 *
 * ── THIS HEURISTIC WAS TRIED AND REJECTED, AND THE REASON IS WORTH KEEPING ────────────────────
 *
 * The first version classified by magnitude (`b >= a * 5` ⇒ closure span). It produced two errors:
 *
 *   · `48 / 1,750` was cut at the comma, so the ratio read `48 / 1` ⇒ classified as a test count;
 *   · the reclassification made the gate report 16 problems where the honest answer was 6 —
 *     it was inventing precision about MEANING from a NUMBER, exactly the 「检查粗了一级 / 细错了方向」
 *     family this batch keeps meeting.
 *
 * So the gate does NOT decide what a ratio means. It reports `ratio` and demands a source for it,
 * which is the only claim it can actually support. The KINDS list keeps the name honest.
 */
export function classifyRatio() {
  return 'ratio'
}

/** Every claim on `text` that lacks a cited source. */
export function uncitedClaims(text) {
  const problems = []
  const lines = text.split('\n')
  /** Track fenced blocks: a block of pasted output is itself the evidence. */
  let inFence = false
  /** Whether the CURRENT block (a heading/paragraph or the table under it) carries a date marker. */
  let lineHasDatedAncestor = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    /**
     * A non-table, non-empty line starts a new block: recompute whether that block is dated.
     * Table rows inherit it — see N7c below.
     */
    if (line.trim() !== '' && !/^\s*\|/u.test(line)) {
      lineHasDatedAncestor = DATED.test(line)
    }
    /**
     * ── N7（S17）：表行豁免必须收窄到「表头与分隔行」──────────────────────────────────────────
     *
     * 旧写法是 `if (/^\s*\|/u.test(line)) continue` —— **整行跳过每一行表格**。
     * 实测后果：6 处关键数字因此免检，其中 TD-2 的立论依据写着「`src/index.ts` 约 1,300 行」
     * 而实测 **2,890** —— 差一倍多。**一条被豁免的数字，正好是一条错的数字**，
     * 而它决定的正是这条技术债该不该存在。
     *
     * 表头与分隔行不含数据：`| 项 | 内容 |` 与 `|---|---|`。它们豁免是对的。
     * 但**数据行是断言**，必须逐个过判据 —— 一张表里的数字与一句散文里的数字，可信度没有区别。
     */
    if (isTableHeaderOrSeparator(line)) continue
    if (DATED.test(line)) continue
    /**
     * N8: no blanket ACCOUNT exemption. An account line's ORDINAL is cited by its commit (`v378`
     * proves the commit exists); any OTHER key number on such a line still needs its own source, which
     * is exactly what the old blanket exemption let through.
     */
    const accountLine = ACCOUNT_LINE.test(line)
    /**
     * ── N7c：时点限定可以写在**区块标题**上，不必重复在每一行 ────────────────────────────────────
     *
     * 实测（S17）：N7 的表头写着「**当时**（2026-11-10 实测，同一口径）」，而它下面 5 行表行
     * 各自不含时点词。要求每行都带时点，会逼作者在 5 行里各写一遍同一个日期 —— 而重复的日期
     * 正是最先与标题不一致的那一份。
     *
     * 所以：**最近一个非空行的时点限定对后续表格行生效**。这不是放宽 —— DATED 仍然必须出现，
     * 只是它可以在标题上。一段话没有时点、表里又有数字，仍然红。
     */
    if (lineHasDatedAncestor) continue

    const cited = EVIDENCE.test(line)
    for (const kind of KINDS) {
      kind.pattern.lastIndex = 0
      const match = kind.pattern.exec(line)
      if (match === null) continue
      /**
       * Report the shape honestly: a `N / M` pair is a *ratio*, and what it means (test count vs
       * closure span) is not something this gate can decide from the digits.
       */
      const classification = /^\d+\s*\/\s*\d+$/u.test(match[0]) ? classifyRatio() : kind.name
      /** An account line's own ordinal needs no separate citation (the commit is its source). */
      if (classification === 'cluster-ordinal' && accountLine) continue
      if (!cited) problems.push({ line: i + 1, kind: classification, text: match[0], raw: line.trim().slice(0, 120) })
      break
    }
  }
  return problems
}

function main() {
  const args = process.argv.slice(2)

  if (args.includes('--self-test')) {
    /** A criterion that cannot say NO is a comment — and it must ALSO accept a cited line. */
    const bad = [
      '# 报告',
      'paradise 509 / 509 全绿。',
      'index.ts 14,067 行。',
      '这是第 5 簇。',
    ].join('\n')
    const good = [
      '# 报告',
      '`npm run check` 输出：509 / 509（命令见下）。',
      '`node scripts/index-ratchet.mjs`：14,067 行。',
      '`git log --diff-filter=A` 显示第 3 簇（1325286）。',
    ].join('\n')

    const badFound = uncitedClaims(bad)
    const goodFound = uncitedClaims(good)
    const ok = badFound.length >= 3 && goodFound.length === 0
    console.log(`check-reported-numbers self-test: ${ok ? 'PASS' : 'FAIL'}`)
    console.log(`  uncited in the bad sample: ${badFound.length} (expected >= 3)`)
    console.log(`  uncited in the good sample: ${goodFound.length} (expected 0)`)
    if (!ok) {
      for (const problem of goodFound) console.log(`    false positive: L${problem.line} ${problem.kind} ${problem.text}`)
    }
    return ok ? 0 : 1
  }

  const paths = args.filter((arg) => !arg.startsWith('--'))
  if (paths.length === 0) {
    console.error('usage: node scripts/check-reported-numbers.mjs <report.md> [...]')
    console.error('This gate needs a denominator: no file means nothing was checked.')
    return 2
  }

  const missing = paths.filter((path) => !existsSync(resolve(path)))
  if (missing.length > 0) {
    console.log('VACUOUS — these path(s) do not exist, so nothing was checked:')
    for (const path of missing) console.log(`  missing: ${path}`)
    return 2
  }

  let failures = 0
  for (const path of paths) {
    const problems = uncitedClaims(readFileSync(resolve(path), 'utf8'))
    if (problems.length === 0) {
      console.log(`ok — ${path}: every key number names its source`)
      continue
    }
    failures += 1
    console.log(`FAIL — ${path}: ${problems.length} number(s) with no stated source`)
    for (const problem of problems.slice(0, 12)) {
      console.log(`  L${problem.line} [${problem.kind}] ${problem.text}`)
      console.log(`      ${problem.raw}`)
    }
    if (problems.length > 12) console.log(`  … and ${problems.length - 12} more`)
  }

  if (failures > 0) {
    console.log(`\ncheck-reported-numbers: ${failures} file(s) with uncited numbers`)
    return 1
  }
  console.log(`\ncheck-reported-numbers: ${paths.length} file(s) clean`)
  return 0
}

/**
 * ── RUN ONLY WHEN EXECUTED, NOT WHEN IMPORTED ────────────────────────────────────────────────
 *
 * Measured (S17): `v384` imports `uncitedClaims` / `isTableHeaderOrSeparator` from this file to
 * exercise the SAME rules the gate applies. The first version called `main()` unconditionally, so the
 * import printed `usage: …` and set a non-zero exit — **a module that does its work on import cannot be
 * audited by its own consumers.**
 *
 * The user's own lesson from the previous round was 「审一个门禁必须用那个门禁自己的函数」.
 * That is only possible if importing is side-effect free.
 *
 * ── WHY THE FIRST GUARD WAS WRONG ───────────────────────────────────────────────────────────────
 *
 * It compared `import.meta.url` to `file://${argv[1]}`. On Windows, `import.meta.url` percent-encodes
 * the CJK path (`%E6%8C%81…`) while `argv[1]` does not — so the comparison was false **even when the
 * file WAS the entry point**, `main()` never ran, and v382's three subprocess tests failed with
 * `exit 0` and no output.
 *
 * A guard that is wrong in the "not the entry point" direction silently disables the gate. The robust
 * form compares RESOLVED PATHS through `pathToFileURL`, which encodes both sides the same way.
 */
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1]
    if (entry === undefined) return false
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()

if (invokedDirectly) process.exitCode = main()
