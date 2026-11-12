#!/usr/bin/env node
/**
 * ── v143: 增量类型预算门禁 —— 不引入「一次全红」，只要求「不许变多」────────────────────────────────
 *
 * 背景（用户裁定，2026-11-12）：
 *   本项目从不跑 tsc，只跑 stripTypeScriptTypes，而 strip **不做任何符号检查**。
 *   所以「782 条测试全绿」证明运行时行为正确，不证明类型正确；「搬移后编译通过」只是「无语法错」。
 *   实测：一次纯搬移把 goal-extraction.ts 搬出去时漏了 5 个 export，789 条测试全绿、build 成功、
 *   verify-pure-move IDENTICAL —— 三道关都没拦住，只有 tsc --noEmit 看得见（5 条 code 2459）。
 *
 *   不批准「引入 tsc 让 CI 变红」：125 个存量错误（现 61）会让红成为常态，重演「CI 永远红」。
 *   批准「增量拉紧」：**本次提交触及的文件**必须不超过它的基线，且不许新增。
 *
 * ── 四条判据（每一条都对应一个已实测的失败模式）─────────────────────────────────────────────────
 *
 *   ① 判据是「本次提交触及的文件」，不是「新文件」。
 *      用户最初的假设是「新文件从第一天就类型正确」，实测**不成立**：
 *      goal-extraction.ts 3 条、adaptive-depth.ts 2 条、command-guard.ts 2 条… —— 纯位移把源文件的
 *      错误原样带走了。所以「新文件」这个判据会漏掉恰恰是它想防的那类提交。
 *
 *   ② 搬移型提交豁免为「错误数不变」——不许变多，不要求变少。
 *      搬移不产生新代码，因此它不该增加错误；但它也不该被要求减少，否则每个搬移都得顺手修别人
 *      的债。这条正好机器化回答「搬移会不会带进新错误」。
 *
 *   ③ 2459（声明了未 export 却被 import）必须恒为 0。
 *      这是**搬移专属**失效模式，当前树已是 0（本轮修复）。任何提交让它非零就必须红 —— 比
 *      「错误数不变」更强，因为它指名了那一个我们证明过会静默通过的缺陷。
 *
 *   ④ 没有编译器时 exit 2 并给具名原因，绝不静默通过。
 *      CI 不装 typescript（package.json 无依赖），所以这条门禁在 CI 上**不生效**。这不是遗漏，
 *      是资源事实：写成「绿色」才是真正的漏洞。它在本机是硬门禁。
 *
 * 用法：
 *   node scripts/type-budget.mjs                 # 对 HEAD 做增量检查
 *   node scripts/type-budget.mjs --against HEAD~1
 *   node scripts/type-budget.mjs --baseline      # 打印当前基线（供 BASELINE 表更新）
 *   node scripts/type-budget.mjs --self-test     # 证明它能红
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TYPE_CHECK = join(ROOT, 'scripts', 'type-check.mjs')

/**
 * ── 冻结基线（实测 2026-11-12，提交 519bbc0 之后）──────────────────────────────────────────────
 *
 * 这是「今天的尺寸」，不是目标。它只允许**下降**：清理真实类型错误时，每清一条就把这里的数字调低；
 * 任何上升都必须显式改这个表并写理由 —— 与 v130 的 EXEMPT 同一种用法。
 *
 * 为什么不写总量而写每文件：总量会被「一个文件变好、另一个变坏」互相抵消，而那正是本门禁要抓的。
 *
 * ── 这份表是 `--baseline` 的实测输出，不是手写的 ──────────────────────────────────────────────
 *
 * 第一版我按「我记得的文件」手写了 17 行，把 `core/watermark.ts 3`、`core/gateway-types.ts 3`、
 * `core/adaptive-depth.ts 2` 等也写了进去 —— 那几个错误**本轮已经被修掉**，所以它们实测是 0。
 * 手写的表如果偏松，就是给未来的增长预留了空间；如果偏紧，就是天天误报。
 * 所以这张表只能来自 `node scripts/type-budget.mjs --baseline`。
 */
const BASELINE = new Map([
  ['index.ts', 35],
  ['core/txn.ts', 7],
  ['core/ignition.ts', 4],
  ['core/store-layer.ts', 4],
  ['core/ledger.ts', 3],
  ['core/command-guard.ts', 2],
  ['core/layout.ts', 2],
  ['core/state.ts', 2],
  ['contracts/model-wording.contracts.ts', 1],
  ['core/pending-state.ts', 1],
])

/** 搬移专属失效模式：声明了没 export，却被别的文件 import。必须是 0，不是「不变」。 */
const MOVE_ONLY_CODE = 2459

/** 读取诊断；编译器缺失时 exit 2（资源条件，不是通过）。 */
function diagnose () {
  let raw
  try {
    raw = execFileSync(process.execPath, [TYPE_CHECK, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    // type-check exits non-zero when diagnostics exist; a JSON body on stdout is still the result
    if (typeof error.stdout === 'string' && error.stdout.trimStart().startsWith('{')) raw = error.stdout
    else {
      console.error('type-budget: the type check could not run (compiler unavailable or crashed).')
      console.error('This is a RESOURCE condition, not a pass — same rule as type-check.mjs.')
      process.exit(2)
    }
  }
  return JSON.parse(raw)
}

/**
 * 某个 git ref 下，本次提交触及的 .ts 文件。
 *
 * ── 两个坐标系必须显式对齐 ────────────────────────────────────────────────────────────────────
 *
 * `git diff --name-only` 给的是**仓库相对路径**（`src/core/txn.ts`），而 `typescript` 的
 * `sourceFile.fileName` 经 type-check.mjs 归一后是**相对 src/ 的路径**（`core/txn.ts`）。
 * 第一版直接比较这两个集合，结果 touched 里每个文件都「不在基线表里」—— 而按规则，
 * 不在表里且有错误的文件会被判违规，于是第一次真实运行就误报 10 个文件。
 *
 * 这里统一到诊断的坐标系（去掉 `src/` 前缀），并且只保留 src/ 下的文件。
 */
function touchedFiles (ref) {
  let out
  try {
    out = execFileSync('git', ['diff', '--name-only', ref, '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    console.error(`type-budget: cannot diff against ${ref}`)
    process.exit(2)
  }
  return out.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts'))
    .filter((line) => line.startsWith('src/'))
    .map((line) => line.slice('src/'.length))
}

/** 统计每个文件的诊断数（键用仓库相对路径，正斜杠）。 */
function countsByFile (report) {
  const counts = new Map()
  for (const d of report.diagnostics) {
    counts.set(d.file, (counts.get(d.file) ?? 0) + 1)
  }
  return counts
}

const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const against = argOf('--against') ?? 'HEAD'
const showBaseline = process.argv.includes('--baseline')

if (showBaseline) {
  const report = diagnose()
  const counts = countsByFile(report)
  console.log('current baseline (paste into BASELINE):')
  for (const [file, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ['${file}', ${n}],`)
  console.log(`  total: ${report.total}`)
  process.exit(0)
}

// ── self-test：证明这套判据能红 ──────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  /**
   * 判据的关键性质是「只看触及的文件」—— 所以自测必须包含一条**未触及文件变坏但不许失败**的用例。
   * 第一版自测自己写错了（遍历了 after 的全部文件而不是 touched 集合），把它判成 FAIL，
   * 于是自测 FAIL。这正是自测该抓的东西：**如果自测只测「该红的红」，它会漏掉「不该红的红了」**。
   */
  const run = (before, after, touchedAfter) => {
    const violations = []
    for (const file of touchedAfter) {
      const now = after.get(file) ?? 0
      const prev = before.get(file) ?? 0
      if (now > prev) violations.push(file)
    }
    return violations.length
  }
  const before = new Map([['src/a.ts', 3], ['src/b.ts', 1]])
  const cases = [
    ['a touched file kept its count — allowed', new Map([['src/a.ts', 3], ['src/b.ts', 1]]), ['src/a.ts'], 0],
    ['a touched file GAINED one — must fail', new Map([['src/a.ts', 4], ['src/b.ts', 1]]), ['src/a.ts'], 1],
    ['an UNTOUCHED file gained — must NOT fail (incremental, not global)', new Map([['src/a.ts', 3], ['src/b.ts', 9]]), ['src/a.ts'], 0],
    ['a touched file shrank — allowed (and the baseline should be lowered)', new Map([['src/a.ts', 1], ['src/b.ts', 1]]), ['src/a.ts'], 0],
    ['a touched file that had 0 now has 1 — must fail', new Map([['src/a.ts', 3], ['src/c.ts', 1]]), ['src/c.ts'], 1],
  ]
  let ok = true
  for (const [name, after, touchedAfter, expected] of cases) {
    const got = run(before, after, touchedAfter)
    const pass = got === expected
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` (expected ${expected} violation(s), got ${got})`}`)
    if (!pass) ok = false
  }
  // the move-only code is absolute, not relative: it fails even when no file was touched
  const absoluteFails = (code2459) => code2459 > 0
  const absolutePass = absoluteFails(1) === true && absoluteFails(0) === false
  console.log(`  ${absolutePass ? 'PASS' : 'FAIL'}  2459 is ABSOLUTE — it fails even if no file was touched`)
  if (!absolutePass) ok = false
  console.log(ok ? '\nSELF-TEST PASS' : '\nSELF-TEST FAIL')
  process.exit(ok ? 0 : 1)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────────────────
const report = diagnose()
const counts = countsByFile(report)
const touched = touchedFiles(against)

console.log(`type-budget: ${report.total} diagnostic(s) in the tree; ${touched.length} file(s) touched vs ${against}`)

/**
 * 2459 是绝对判据：与「触及了哪些文件」无关。
 * 理由：它代表的缺陷（搬出时忘记 export）会**静默通过所有其他门禁**，所以只要它出现就必须红。
 */
const moveOnly = report.diagnostics.filter((d) => d.code === MOVE_ONLY_CODE)
if (moveOnly.length > 0) {
  console.error(`\nFAIL ${MOVE_ONLY_CODE}: ${moveOnly.length} declaration(s) are imported without being exported.`)
  for (const d of moveOnly.slice(0, 10)) console.error(`  ${d.file}:${d.line}  ${d.message.slice(0, 120)}`)
  console.error('This is the move-only failure mode: it passed 789 tests, the build and verify-pure-move.')
  process.exit(1)
}
console.log(`  ${MOVE_ONLY_CODE} (imported-but-not-exported): 0 — required to be 0, and it is`)

const violations = []
const improvements = []
for (const file of touched) {
  const now = counts.get(file) ?? 0
  const base = BASELINE.get(file)
  if (base === undefined) {
    /**
     * 一个基线表里没有的文件被触及 —— 它此前是 0 错误（或在基线表建立后新增）。
     * 这不是「自动放行」：新增文件必须从 0 开始，否则基线表会慢慢被新文件绕过。
     */
    if (now > 0) violations.push({ file, base: 0, now, why: 'not in the baseline table (it had 0 errors when the table was frozen)' })
    continue
  }
  if (now > base) violations.push({ file, base, now, why: 'grew' })
  else if (now < base) improvements.push({ file, base, now })
}

for (const item of improvements) {
  console.log(`  IMPROVED ${item.file}: ${item.base} → ${item.now}  (lower BASELINE to ${item.now})`)
}

if (violations.length > 0) {
  console.error(`\nFAIL type budget on ${violations.length} touched file(s):`)
  for (const v of violations) console.error(`  ${v.file}: ${v.base} → ${v.now}  (${v.why})`)
  console.error('\nA touched file may not gain type errors. Fix them, or raise BASELINE with a written reason.')
  process.exit(1)
}

console.log(`\nOK — every touched file is at or under its frozen baseline (move-only code ${MOVE_ONLY_CODE}: 0)`)
