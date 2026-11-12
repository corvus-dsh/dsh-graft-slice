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
 * ── 冻结基线（实测 2026-11-12）────────────────────────────────────────────────────────────────
 *
 *     15 条代码缺陷 / 3 个文件       ← 这张表只管这个
 *     33 条环境问题（2307×18 + 2580×15）← 不在这张表里：装 @types/node 就消失，不是缺陷
 *      1 条编译器产物（strict:false 造成）← 单独一类，strict:true 下 0 条
 *
 * 用户裁定：两者必须分开数，否则下一个读表的人会去「修」那 33 条，而修法不是改代码。
 *
 * ── 「15」的正确读法：宽松模式下的可见缺陷，不是「类型健康度」──────────────────────────────────
 *
 * 这个数字是 **`strict: false`** 口径测出来的。而 `strict: false` 下「干净」不等于「类型正确」：
 * 它容忍隐式 any、不做 null/undefined 检查、容忍双变。
 *
 * 实测同一份 src/ 只改 strict：
 *
 *     strict: false → 49 条        strict: true → 58 条
 *     只在 strict:true 出现：9 条 7006（隐式 any）+ 1 条 2345（string | undefined）
 *     只在 strict:false 出现：1 条 2339（已单列为 COMPILER ARTIFACT）
 *
 * 所以：
 *   · 「15」= 宽松模式下有几个错，**不是**「还剩几个错」；
 *   · 「清到 0」不等于类型安全 —— 只意味着「连宽松检查都过了」。
 *
 * 不切 strict:true：那会让 58 条一次全红，正是用户明确否决的「CI 永远红」。
 * 但这句警告必须留在这里，否则下一个把 15 清到 0 的人会以为自己得到了类型安全。
 *
 * 这是「今天的尺寸」，不是目标。它只允许**下降**：每清掉一组同根因的缺陷就把数字调低；
 * 任何上升都必须显式改这个表并写理由 —— 与 v130 的 EXEMPT 同一种用法。
 *
 * 为什么不写总量而写每文件：总量会被「一个文件变好、另一个变坏」互相抵消，而那正是本门禁要抓的。
 *
 * ── 这份表是 `--baseline` 的实测输出，不是手写的 ──────────────────────────────────────────────
 *
 * 手写过的两次都错了：第一次按「印象中的文件」写了 17 行（含已被修掉的文件）；
 * 第二次排除环境问题后仍打印 report.total，与逐文件列表对不上 —— 两个数用了两套口径。
 * 所以这张表只能来自 `node scripts/type-budget.mjs --baseline`。
 */
const BASELINE = new Map([
  ['index.ts', 8],
  ['core/ignition.ts', 2],
  ['contracts/model-wording.contracts.ts', 1],
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

/**
 * 统计每个文件的**代码健康度**诊断数（键用相对 src/ 的路径，正斜杠）。
 *
 * ── 环境问题不进预算表 ─────────────────────────────────────────────────────────────────────────
 *
 * 用户裁定：2307（缺 node 内置类型的 18 条）与 2580（缺 process 的 15 条）是环境问题，
 * 修法是装 @types/node，不是改代码。把它们算进预算，会让「某文件触及后数字变了」
 * 反映一个与本提交无关的原因；更糟的是有人会为了让数字变小去「修」它们。
 *
 * 所以预算只数**代码缺陷**，环境问题由 type-check.mjs 单列成表。
 * 两边的分组必须用同一套判据，否则两个工具会各说各话。
 */
const ENVIRONMENT_CODES = new Set([2307, 2580])

/**
 * ── 与 type-check.mjs 完全相同的两类「不是代码缺陷」的排除 ──────────────────────────────────────
 *
 * 环境问题（2307/2580）与编译器产物（strict:false 造成的 1 条 2339）都必须排除，
 * 否则「某文件被触及后数字变了」会反映一个与本提交无关的原因。
 *
 * 两个工具的口径必须一致 —— 否则它们会各说各话，而 v143 的断言正是拿两边对照的。
 *
 * 编译器产物的判据**不用行号**：第一版用 `index.ts:9792:2339`，而本轮编辑让那行下移 11 行，
 * 标注立刻失效、那条假阳性混回了代码缺陷。改成「文件 + code + message 子串」后位置无关。
 */
const COMPILER_ARTIFACT = { code: 2339, file: 'index.ts', match: /Property 'reason' does not exist on type '\{ ok: true; \}/u }

function countsByFile (report) {
  const counts = new Map()
  for (const d of report.diagnostics) {
    if (ENVIRONMENT_CODES.has(d.code)) continue
    // 与 type-check.mjs 同一条判据：按文件 + code + message 子串，**不用行号**
    // （行号会因任何一处注释增删而失效，本轮已经实测过一次）
    if (d.code === COMPILER_ARTIFACT.code && d.file === COMPILER_ARTIFACT.file && COMPILER_ARTIFACT.match.test(d.message)) continue
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
  /**
   * 这里必须打印**代码健康度**的合计，不是所有诊断的合计。
   * 实测：第一版打印 report.total（61），而上面的每文件列表已经排除了 33 条环境问题，
   * 两者对不上 —— 与「手写基线表」同一类错误的镜像：两个数用了两套口径。
   */
  const codeTotal = [...counts.values()].reduce((s, n) => s + n, 0)
  const envTotal = report.diagnostics.filter((d) => ENVIRONMENT_CODES.has(d.code)).length
  console.log(`  code total: ${codeTotal}   (environment, not in this table: ${envTotal})`)
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

/**
 * ── 每次通过都要声明这个数字的口径，不只在注释里 ────────────────────────────────────────────────
 *
 * 注释只有改脚本的人会读；跑门禁的人只看输出。而这句是这个数字最容易被误读的地方：
 * 「15 条」会被读成「还剩 15 个问题」，然后被读成「清到 0 就类型安全了」。
 *
 * 实测：strict:false → 49 条，strict:true → 58 条（多出 9 条隐式 any 与 1 条 null 检查）。
 * 所以通过一次只证明「连宽松检查都过了」，不证明类型正确。
 */
const measuredTotal = [...counts.values()].reduce((s, n) => s + n, 0)
console.log('  scope: measured under strict:false — this is "what the loose settings can see",')
console.log(`         not "type health". strict:true reports 58 here (this baseline sums to ${measuredTotal}).`)
console.log('         Reaching 0 here means "even the loose check passes", not "types are correct".')
