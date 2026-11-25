/**
 * ── v348：`index.ts` 的量具必须是编译器，不是数花括号 ────────────────────────────────────────────
 *
 * 病（实测）：`index-ratchet.mjs` 曾经逐字符数 `{` / `}`,从声明行开始——而本文件的签名参数里就有
 * **对象类型字面量**，那些花括号在签名内部配平，于是计数在签名结束处就回到 0：
 *
 *   buildInjectionPlan          39 行（花括号）  vs  931 行（编译器）
 *   autoGraftIfNeeded           24              vs  229
 *   extractConstraintsDetailed   4              vs  180
 *   extractPhaseRoadmap          4              vs   98
 *   …共 14 个单元差 >3 行
 *
 * 同一个扫描器还把 **`apply()` 体内的 9 个声明**当成顶层函数,于是棘轮的分母是 190,而真实顶层是 181。
 *
 * ── 为什么这条判据本身必须用编译器算 ────────────────────────────────────────────────────────────
 *
 * 用花括号去测「花括号对不对」是自证。所以这里的独立测量走 `scripts/ts-compiler.mjs`（**与被测脚本
 * 同一个加载器**,不是第二份实现）：一份加载器、两种用法,分歧只在「谁来读」。
 *
 * 判据：
 *   ① 抽查 17 个单元的跨度必须与编译器一致（正是旧量具错的那批）
 *   ② **负向** 合成源码：参数里塞对象类型字面量 ⇒ 花括号口径必然错、编译器口径必然对
 *   ③**负向** 体内声明必须恰好是那五个**名字**（人审过）；顶层数与 manifest 必须由两套独立实现给出同一个值。
 *      绝对顶层数已经不再钉常数——它随每次合法搬动改变，钉它会让判据在正确的工作上变红（见 ③ 的函数体注释）
 *   ④ **负向** 无编译器 ⇒ `exit 2` 且打印 `VACUOUS`，绝不 `exit 0`、绝不静默回退
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeTypeScript } from '../scripts/ts-compiler.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'index-ratchet.mjs')
const MANIFEST = join(ROOT, 'docs', 'index-manifest.json')
const SOURCE = join(ROOT, 'src', 'index.ts')

const { ts } = await describeTypeScript()
if (ts === undefined) {
  throw new Error('v348 needs a resolvable typescript compiler — without one it could not tell a right span from a wrong one')
}

/** Measure a source text with the compiler: every function declaration with its span and its parent. */
const measureWithCompiler = (text, fileName) => {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lineOf = (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1
  const found = []
  const visit = (node, owner) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const start = lineOf(node.getStart(sourceFile))
      const end = lineOf(node.getEnd())
      found.push({ name: node.name.text, line: start, end, span: end - start + 1, top: owner === undefined })
      for (const child of node.body?.statements ?? []) visit(child, node.name.text)
      return
    }
    ts.forEachChild(node, (child) => visit(child, owner))
  }
  for (const statement of sourceFile.statements) visit(statement, undefined)
  return found
}

/** The OLD ruler, kept here ONLY as the negative control: it must be wrong on the synthetic source. */
const measureWithBraces = (text) => {
  const lines = text.split('\n')
  const DECL = /^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/u
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = DECL.exec(lines[i])
    if (match === null) continue
    let depth = 0
    let end = i + 1
    let seen = false
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth += 1; seen = true } else if (ch === '}') depth -= 1
      }
      if (seen && depth <= 0) { end = j + 1; break }
    }
    found.push({ name: match[1], line: i + 1, end, span: end - i })
  }
  return found
}

test('v348 ①: the 17 spot-checked spans agree with the compiler', () => {
  /**
   * These are the units whose brace-measured span was wrong by more than three lines. If any one of
   * them disagrees with the compiler, the manifest is carrying a number no other tool would reproduce.
   *
   * `nudgePanelState` was on this list until S6 moved it into `core/nudge-panel.ts`: the list is about
   * units **in this file**, so a moved unit has to be replaced, not kept as a permanent failure.
   * (Measured: keeping it produced `nudgePanelState: 编译器找不到它` in a suite that was otherwise green —
   * a genuine prompt to update the list, not a regression.)
   */
  const SPOT_CHECK = [
    'buildInjectionPlan', 'autoGraftIfNeeded', 'extractConstraintsDetailed', 'extractPhaseRoadmap',
    'graftReadResult', 'collectDebugStatus', 'governedWatermarks', 'filterRejectedConstraints',
    'markTargetBroken', 'summariseThresholdReason', 'removeManualConstraint', 'removeConstraintRejection',
    'applyManualConstraints', 'recordLeftover', 'graftSliceAndInjectUnlocked', 'buildTape', 'apply',
  ]
  const measured = new Map(measureWithCompiler(readFileSync(SOURCE, 'utf8'), SOURCE).map((fn) => [fn.name, fn]))
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const registered = new Map(manifest.units.map((unit) => [unit.name, unit]))

  const mismatches = []
  for (const name of SPOT_CHECK) {
    const truth = measured.get(name)
    const unit = registered.get(name)
    if (truth === undefined) { mismatches.push(`${name}: 编译器找不到它`); continue }
    if (unit === undefined) { mismatches.push(`${name}: manifest 里没有它`); continue }
    if (unit.line !== truth.line || unit.end !== truth.end) {
      mismatches.push(`${name}: manifest L${unit.line}..L${unit.end} (${unit.end - unit.line + 1}) vs compiler L${truth.line}..L${truth.end} (${truth.span})`)
    }
  }
  assert.deepEqual(mismatches, [], `① 跨度必须与编译器逐条一致：\n  ${mismatches.join('\n  ')}`)
})

test('v348 ② (negative half): an object literal in the parameter list breaks the brace ruler and not the compiler', () => {
  /**
   * The synthetic source is the bug in miniature, and its SHAPE matters: the object literal must span
   * several lines inside the parameter list, because that is when the brace count returns to zero while
   * still inside the signature. (Measured on the real file: `buildInjectionPlan`'s `options?: {` at
   * L4162 closes at L4192 as `  },` — the counter ends the function there, 892 lines early.)
   */
  const synthetic = [
    'export function outer(',
    '  input: {',
    '    a: number',
    '    nested: { b: string }',
    '  },',
    '): number {',
    '  const first = 1',
    '  const second = 2',
    '  const third = 3',
    "  const label = 'still inside the body'",
    '  return input.a + first + second + third + label.length',
    '}',
    '',
  ].join('\n')

  const byCompiler = measureWithCompiler(synthetic, 'synthetic.ts')
  const byBraces = measureWithBraces(synthetic)
  assert.equal(byCompiler.length, 1, '编译器必须看到 1 个函数')
  assert.equal(byCompiler[0].span, 12, `编译器口径必须是 12 行，实测 ${byCompiler[0].span}`)

  assert.equal(byBraces.length, 1, '花括号口径也看到 1 个函数——它错在终点，不是漏检')
  assert.equal(byBraces[0].span, 5,
    `花括号口径必须在这里提前收尾（否则它就不能证明 ① 在量什么）；实测 ${byBraces[0].span}`)
  assert.notEqual(byBraces[0].span, byCompiler[0].span,
    '两种口径必须给出不同答案——这正是本判据存在的理由')
})

test('v348 ③ (negative half): the compiler sees EXACTLY these five nested declarations, and the two rulers agree', () => {
  /**
   * ── What is pinned here, and what is no longer ──────────────────────────────────────────────────
   *
   * The instrument's defect was a RULER defect in two halves, and both are still pinned:
   *
   *   (a) the declarations that need `apply()`'s scope are named EXACTLY. If the ruler starts calling
   *       one of them top-level again (the brace counter's 190), `nested` loses it and the list changes;
   *   (b) the test's own compiler walk must agree with the script's manifest — two implementations, one
   *       number. Comparing the manifest with itself would prove nothing, which is why ① exists too.
   *
   * ── Why the absolute top-level count is NOT pinned any more (2026-11-25, S5) ────────────────────
   *
   * It was pinned through S3 (185) and S4 (181), and every edit was a legitimate 段一 step, not a ruler
   * change — the pin was reddening on correct work. That is exactly what `v349 ②` documents:
   * 「钉常数会让判据在每次正确的搬动后变红，而人是会把它改宽的」.
   *
   * The number that carries the HUMAN decision is the nested list: moving a unit out of the file does
   * not answer "may this declaration leave `apply()`?", while promoting one does. So that list is
   * pinned by name, and the top count is checked as an agreement between two independent rulers.
   *
   * History: 181 / 9 (first compiler measurement) → 185 / 5 (S3 promoted four) → 181 / 5 (S4 moved them
   * out) → 180 / 5 (S5 moved the first cluster out). The old brace ruler said 190 / 0.
   */
  const functions = measureWithCompiler(readFileSync(SOURCE, 'utf8'), SOURCE)
  const top = functions.filter((fn) => fn.top)
  const nested = functions.filter((fn) => !fn.top)

  const NESTED = [
    'refineConstraintsInBackground',
    'captureDraft',
    'takeDraftMerge',
    'takePendingConstraintMessages',
    'appendTransitionCard',
  ]
  assert.deepEqual(nested.map((fn) => fn.name).sort(), [...NESTED].sort(),
    `体内声明必须恰好是这五个（实测 ${nested.map((fn) => fn.name).join(', ')}）` +
    '—— 提升一个、或把某个塞回体内，都要人来看')

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.equal(top.length, manifest.measured.functions,
    `两条独立实现必须给出同一个顶层数：测试的编译器遍历 ${top.length} vs 脚本 ${manifest.measured.functions}`)
  assert.equal(manifest.measured.nested, 5, 'manifest 必须登记嵌套数，否则顶层数说明不了自己排除了什么')
  assert.equal(manifest.units.filter((unit) => unit.top).length, top.length,
    '清单里 top=true 的条数必须等于实测顶层数')
  assert.equal(manifest.units.filter((unit) => !unit.top).length, 5, '清单里 top=false 的必须是 5 条')
  /** The nested ones must say so in their own line — a reader must not have to infer it from `top`. */
  for (const unit of manifest.units.filter((candidate) => !candidate.top)) {
    assert.ok(unit.why.includes('体内声明'), `${unit.name}: 体内声明必须在 why 里说明（否则它读起来像可搬单元）`)
  }
})

test('v348 ④ (negative half): no compiler is VACUOUS and exits 2, never 0', () => {
  /**
   * §五十三.3 的续篇：零编译器不是通过。A silent fallback to the brace counter would make the number
   * depend on the machine while looking exactly like a measurement — so the script must refuse.
   *
   * Measured how: the script and its shared loader are copied into a directory OUTSIDE this workspace,
   * where bare `import('typescript')` resolves to nothing (this package declares no dependency, so the
   * only reason it works here is the workspace root install). Copy-and-run is the real condition; asserting
   * a string in the source would only prove the message exists, not that it is reachable.
   */
  const isolated = mkdtempSync(join(tmpdir(), 'v348-no-compiler-'))
  try {
    mkdirSync(join(isolated, 'scripts'), { recursive: true })
    for (const file of ['index-ratchet.mjs', 'ts-compiler.mjs']) {
      writeFileSync(join(isolated, 'scripts', file), readFileSync(join(ROOT, 'scripts', file), 'utf8'), 'utf8')
    }
    /** A tiny `src/index.ts` so the failure can only be about the compiler, never about a missing file. */
    mkdirSync(join(isolated, 'src'), { recursive: true })
    writeFileSync(join(isolated, 'src', 'index.ts'), 'export function only(): void {}\n', 'utf8')
    mkdirSync(join(isolated, 'docs'), { recursive: true })

    const result = spawnSync(process.execPath, [join(isolated, 'scripts', 'index-ratchet.mjs')], {
      cwd: isolated,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
    /**
     * If the copy DID find a compiler (a machine with a global install), the case cannot be exercised —
     * say so instead of passing quietly on an unrelated code path.
     */
    if (result.status === 0) {
      assert.match(out, /compiler \d+/u, '④ 若在隔离目录里仍找到编译器，这条负向就无法成立，必须显式说明')
      console.log('v348 ④: skipped — a compiler is resolvable even outside this workspace on this machine')
      return
    }
    assert.equal(result.status, 2, `④ 无编译器必须 exit 2，实测 ${result.status}：\n${out}`)
    assert.match(out, /VACUOUS/u, `④ 必须打印 VACUOUS，实测：\n${out}`)
    assert.match(out, /NOT a pass/u, `④ 必须说明这不是通过，实测：\n${out}`)
    /** The old ruler must not reappear as a fallback: a number here would defeat the whole point. */
    assert.doesNotMatch(out, /function\(s\)|ceiling \d+/u, `④ 无编译器时不得报告任何计数：\n${out}`)
  } finally {
    rmSync(isolated, { recursive: true, force: true })
  }
})

test('v348 ⑤: the ratchet reports the compiler it used, so the number is reproducible', () => {
  /**
   * A count without its instrument is a rumour. The manifest records version + resolved path, and the
   * CLI prints the version — both are what make "181" checkable on another machine.
   */
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.ok(manifest.compiler !== undefined && typeof manifest.compiler.version === 'string',
    '⑤ manifest 必须记录编译器版本')
  assert.ok(manifest.compiler.version.length > 0, '⑤ 版本不能是空串')
  const output = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.match(output, /compiler \d+\.\d+\.\d+/u, `⑤ CLI 必须打印编译器版本，实测输出：${output.slice(-300)}`)
})
