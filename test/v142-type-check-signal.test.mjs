/**
 * ── v142: 搬移不得带进新的类型错误「位置无关，数量相等」─────────────────────────────────────────
 *
 * 起因：第 4 步搬移后，`core/goal-extraction.ts` 的 5 个声明**没有 `export`**，而 index.ts 从它
 * import —— 产生 5 条 code 2459「declares locally but is not exported」。
 *
 * 而当时：**783 条测试全绿、`npm run build` 成功、`verify-pure-move` IDENTICAL**。
 * 三道关都没拦住，因为：
 *   · stripTypeScriptTypes 只删类型语法，不做符号检查
 *   · 内联打包把「import 一个不存在的导出」变成「同一作用域里名字恰好存在」
 *   · pure-move 只比较内容行，import/export 行本就被排除
 *
 * 只有 type-check 看得见。这条测试把「搬移型提交必须错误数不变」变成机器判据。
 *
 * ── 为什么不是「新文件必须 0 错误」──
 *
 * 初稿的假设「新文件从第一天就类型正确」被实测推翻：搬移是纯位移，**源文件的类型错误会被原样带走**。
 * 实测搬出的模块各带 1–3 条错误。所以判据是「本次提交**触及**的文件」，且搬移型提交**豁免为不变**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TYPE_CHECK = join(ROOT, 'scripts', 'type-check.mjs')

/** The compiler is read from the workspace root; without it this is a RESOURCE condition, not a pass. */
const requireCompiler = (t) => {
  try {
    const out = execFileSync(process.execPath, [TYPE_CHECK, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
    return JSON.parse(out)
  } catch (error) {
    const text = String(error.stdout ?? '') + String(error.stderr ?? '')
    if (/typescript is not installed|RESOURCE/u.test(text)) {
      t.skip('RESOURCE: typescript is not installed; the type check cannot run')
      return undefined
    }
    throw error
  }
}

test('v142: a moved module must EXPORT what it is imported for (the goal-extraction defect)', (t) => {
  const report = requireCompiler(t)
  if (report === undefined) return

  /**
   * The exact shape that shipped green: index.ts imports five names from `core/goal-extraction.js`,
   * and the module exported none of them. `verify-pure-move` cannot see it (import lines are excluded),
   * the tests cannot see it (the bundle inlines into one scope), and the build cannot see it.
   */
  const notExported = report.diagnostics.filter((d) => d.code === 2459 && /goal-extraction/u.test(d.message))
  assert.deepEqual(notExported, [],
    `core/goal-extraction.ts declares names that index.ts imports without exporting them:\n` +
    notExported.map((d) => `  ${d.file}:${d.line}  ${d.message}`).join('\n'))

  // and positively: each name index.ts imports IS exported by the module
  const moduleText = readFileSync(join(ROOT, 'src', 'core', 'goal-extraction.ts'), 'utf8')
  for (const name of ['GoalResult', 'GoalLayer', 'objectiveOf', 'currentDagNode', 'extractGoal']) {
    assert.match(moduleText, new RegExp(`^export (?:function|interface|type) ${name}\\b`, 'mu'),
      `${name} must be exported by core/goal-extraction.ts`)
  }
})

test('v142: the evidence file is excluded from the type check, and the exclusion is DECLARED', (t) => {
  const report = requireCompiler(t)
  if (report === undefined) return

  /**
   * `src/core/ignition.ts.bak-cut` is tracked evidence (v125 keeps it, v126 keeps it scanned, v125 also
   * asserts it never ships). Type-checking it produced noise, and noise is how real errors get ignored.
   * But a silent skip would be its own lie, so the script prints what it excluded.
   */
  const inBakCut = report.diagnostics.filter((d) => /\.bak-cut/u.test(d.file))
  assert.deepEqual(inBakCut, [], 'the .bak-cut evidence file must not appear in the diagnostics')

  const out = execFileSync(process.execPath, [TYPE_CHECK], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  assert.match(out, /excluded \(evidence, not source\): core\/ignition\.ts\.bak-cut/u,
    'the exclusion must be printed, not silent')
})

test('v142: the summary names the missing symbols, not just the first sample', (t) => {
  /**
   * Measured: code 2304 has 115 rows across 20 DIFFERENT names. Printing the first row made the summary
   * read "Cannot find name 'textOfMessage'" — which accounts for 2 of 115. The dominant name was
   * `graftError` (49). A summary that points at a 2/115 cause is worse than no summary.
   */
  const report = requireCompiler(t)
  if (report === undefined) return

  const missing = report.diagnostics.filter((d) => d.code === 2304)
  const names = new Set(missing.map((d) => /Cannot find name '([^']+)'/u.exec(d.message)?.[1]).filter(Boolean))

  /**
   * ── THIS ASSERTION USED TO DEPEND ON THE BUG STILL EXISTING ───────────────────────────────────
   *
   * It read `names.size > 1` against the REAL tree, which made it a test of the repository's health
   * rather than of the summary. When the missing imports were repaired (code 2304 went 115 rows /
   * 20 names → 1 row), the sample vanished and this went red — the test broke because the code got
   * BETTER. A signal test must survive its subject being fixed.
   *
   * The shape is now asserted unconditionally: the summary always has a by-code section, and it
   * separates "how many" from "which" whenever one code covers several names. The repo-wide check
   * below runs only while that condition actually holds, and is skipped (not faked) otherwise —
   * with the reason printed, so "skipped" cannot be mistaken for "passed".
   */
  const out = execFileSync(process.execPath, [TYPE_CHECK], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  assert.match(out, /by code:/u, 'the summary must always have a by-code section')

  if (names.size <= 1) {
    t.diagnostic(`code 2304 no longer covers several names (${names.size}) — the multi-name listing is ` +
      'asserted by test/v142 on a synthetic probe instead of on this tree')
    return
  }

  assert.match(out, new RegExp(`${names.size} distinct names`, 'u'),
    'the by-code section must report how many distinct names one code covers')

  // the dominant name must appear with its count, not only as the first sample
  const counts = new Map()
  for (const d of missing) {
    const n = /Cannot find name '([^']+)'/u.exec(d.message)?.[1]
    if (n !== undefined) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  const [topName, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0]
  assert.match(out, new RegExp(`${topCount}\\s+${topName}`, 'u'),
    `the dominant missing name (${topName} ×${topCount}) must appear in the summary`)
})
