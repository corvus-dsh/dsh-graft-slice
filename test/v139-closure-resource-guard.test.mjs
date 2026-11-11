/**
 * ── v139: 任何 spawn closure.mjs 的测试，必须自带资源守卫（元测试）──────────────────────────────
 *
 * 这是同一件事的**第三次**：
 *   - v135 用了 requireCompiler(t) + t.skip('RESOURCE: …')，修好了；
 *   - v138 忘了抄，run #103 双 Node 全红（本地 11/11 绿 ——「在我机器上能过」的最纯粹形态）；
 *   - 修 v138 时判据又写错（用 `closureLines === 0 && declarations === 0`，而无编译器时
 *     move-gate 返回的是**空对象 `{}`**，判据恒 false，守卫从不触发；模拟 CI 才抓到）。
 *
 * 「修一个实例」和「钉住这一类」是两回事。踩了三次说明靠记性不管用，所以这条测试检查的是
 * **所有测试文件的形状**，而不是某一个测试的行为：
 *
 *   若一个 test/*.test.mjs 以任何方式运行 closure.mjs（直接 execFileSync，
 *   或间接跑 move-gate.mjs —— 后者内部会 spawn closure.mjs），
 *   那么它必须同时出现 skip 机制（t.skip + RESOURCE 字样）。
 *
 * 缺了就红，并点名是哪个文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEST_DIR = join(ROOT, 'test')

/**
 * ── A MENTION IS NOT AN EXECUTION — THE DETECTOR MUST STRIP COMMENTS FIRST ──────────────────────
 *
 * First version matched the file NAME anywhere in the source, and immediately flagged two innocent
 * files: `v129-gate-coverage` lists `closure.mjs` in a table of instruments, and
 * `v133-store-layer-conformance` mentions it in a doc comment. Neither runs it.
 *
 * That is the same defect this whole phase keeps finding, now inside the META-test: a name in prose is
 * not a name in code. So comments are stripped before the detector looks, and the execution patterns
 * require an actual spawn-ish call rather than the bare filename.
 */
/** A file is guarded only when the skip is BOTH available and actually invoked. */
function hasSkipGuard(source) {
  const defines = DEFINES_SKIP.some((pattern) => pattern.test(source))
  const calls = CALLS_SKIP.some((pattern) => pattern.test(source))
  return defines && calls
}

/**
 * ── PER-TEST, NOT PER-FILE: THE FOURTH TIME IS WHAT TAUGHT THIS ────────────────────────────────
 *
 * A file-level guard is not enough. Measured on run #105: v138 had `requireCompiler(t)` present in the
 * file, and TWO of its eleven tests used it — the other nine called `gateJson` (which spawns
 * move-gate → closure.mjs) with no guard at all. Locally all eleven passed; on CI eight went red.
 *
 * So the check is per test: every `test('…', (t) => {` whose body reaches the tool must also invoke the
 * guard inside that body. A single guarded test does not cover its siblings.
 */
function unguardedTests(source) {
  const offenders = []
  // split on top-level test declarations; the body runs to the next `test(` or EOF
  const pattern = /test\(\s*'([^']+)'\s*,\s*(?:\((\w*)\)\s*=>|\w+\s*=>)\s*\{/gu
  const matches = [...source.matchAll(pattern)]
  for (const [index, match] of matches.entries()) {
    const bodyStart = match.index + match[0].length
    const bodyEnd = index + 1 < matches.length ? matches[index + 1].index : source.length
    const body = source.slice(bodyStart, bodyEnd)
    const reaches = reachesTool(body) !== undefined || /\bgateJson\(/u.test(body)
    if (!reaches) continue
    const guarded = hasSkipGuard(body) || /if\s*\(\s*!\s*requireCompiler\(\s*t\s*\)\s*\)\s*return/u.test(body)
    if (!guarded) offenders.push({ name: match[1], hasT: match[2] === 't' })
  }
  return offenders
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/^\s*\/\/.*$/gmu, ' ')
}

/**
 * How a test file ACTUALLY reaches the compiler-dependent tool.
 *
 * Two shapes occur in this repo, and the detector must know both or it reports "covered 1 file" while
 * the two files that actually matter sail past (measured: exactly that happened on the first attempt):
 *
 *   a) the filename inline:      execFileSync(..., ['scripts/closure.mjs', ...])
 *   b) a module-level constant:  const TOOL = join(REPO, 'scripts', 'closure.mjs')
 *                                execFileSync(process.execPath, [TOOL, ...])
 *
 * So a file reaches the tool when its CODE declares a constant pointing at the tool AND the code passes
 * that constant to execFileSync.
 */
function reachesTool(source) {
  const inlineClosure = /execFileSync\([^)]*closure\.mjs/u.test(source)
  const inlineGate = /execFileSync\([^)]*move-gate\.mjs/u.test(source)
  if (inlineClosure || inlineGate) return inlineClosure ? 'closure.mjs inline' : 'move-gate.mjs inline'

  // shape (b): find `const NAME = …closure.mjs` / `…move-gate.mjs`, then look for `[NAME` in a spawn
  const constantPattern = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*[^\n]*(closure\.mjs|move-gate\.mjs)/gu
  for (const match of source.matchAll(constantPattern)) {
    const name = match[1]
    const tool = match[2]
    const passedToSpawn = new RegExp(`execFileSync\\([^)]*\\[\\s*${name}\\b`, 'u').test(source)
    if (passedToSpawn) return `${tool} via ${name}`
  }
  return undefined
}

/**
 * Evidence that the file degrades to SKIP instead of FAIL when the compiler is absent.
 *
 * A `t.skip(...)` string is NOT enough on its own — measured: deleting the `if (!requireCompiler(t)) return`
 * call from v138 left the skip TEXT in place, and a detector keyed only on the text stayed green while
 * the guard was in fact unreachable. So the guard must be BOTH defined and CALLED.
 */
const DEFINES_SKIP = [
  /t\.skip\(\s*['"`][^'"`]*RESOURCE/u,
  /function\s+requireCompiler/u,
]
const CALLS_SKIP = [
  /if\s*\(\s*!requireCompiler\(\s*t\s*\)\s*\)\s*return/u,
  /requireCompiler\(\s*t\s*\)/u,
]

const testFiles = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => statSync(join(TEST_DIR, name)).isFile())

test('v139: every test that reaches the compiler-dependent tool carries a SKIP guard', () => {
  const offenders = []
  const reaches = []
  const perTestOffenders = []

  for (const name of testFiles) {
    const raw = readFileSync(join(TEST_DIR, name), 'utf8')
    const source = stripComments(raw)
    const via = reachesTool(source)
    if (via === undefined) continue
    reaches.push({ name, via })
    const guarded = hasSkipGuard(source)
    if (!guarded) offenders.push({ name, via })
    // and the stricter question: is EVERY test in this file guarded, not just the file?
    for (const entry of unguardedTests(source)) perTestOffenders.push({ file: name, ...entry })
  }

  // A denominator: if nothing reaches the tool, this test would pass vacuously.
  assert.ok(reaches.length > 0,
    'no test file reaches closure.mjs / move-gate.mjs — the detector is broken, not the suite')

  assert.deepEqual(offenders, [],
    `${offenders.length} test file(s) run the compiler-dependent tool without any SKIP guard. ` +
    `On CI (no TypeScript) they go RED instead of skipped — that is exactly run #103.\n` +
    offenders.map((entry) => `  ${entry.name}  (via ${entry.via})`).join('\n'))

  /**
   * Per-test check. Run #105 is the reason: v138 HAS the guard, and nine of its eleven tests still went
   * red on CI because they spawn the tool without entering the guarded path.
   */
  assert.deepEqual(perTestOffenders, [],
    `${perTestOffenders.length} individual test(s) reach the tool without a guard in their own body. ` +
    `A file-level guard does not cover its siblings — that is run #105.\n` +
    perTestOffenders.map((entry) => `  ${entry.file}: ${entry.name}${entry.hasT ? '' : '  (no `t` parameter)'}`).join('\n'))

  console.log(`  covered ${reaches.length} file(s):`)
  for (const entry of reaches) console.log(`    ${entry.name}  (via ${entry.via})`)
})

test('v139: the guard detector can fail — a synthetic unguarded file is caught', () => {
  /**
   * Same discipline as every other gate here: prove the check can say NO. Without this, a detector that
   * never matches would make the assertion above pass for the wrong reason — and the first version DID
   * pass for the wrong reason (it matched a doc comment in two innocent files, then covered only one).
   *
   * Three shapes are pinned here: the two that must be DETECTED, and the two that must NOT be.
   */
  const unguardedInline = [
    "import { execFileSync } from 'node:child_process'",
    "const out = execFileSync(process.execPath, ['scripts/closure.mjs', 'buildTape'], { encoding: 'utf8' })",
  ].join('\n')
  assert.equal(reachesTool(unguardedInline), 'closure.mjs inline')
  assert.equal(hasSkipGuard(unguardedInline), false, 'and must NOT see a guard where there is none')

  const unguardedConstant = [
    "const TOOL = join(REPO, 'scripts', 'closure.mjs')",
    "const out = execFileSync(process.execPath, [TOOL, 'buildTape'], { encoding: 'utf8' })",
  ].join('\n')
  assert.equal(reachesTool(unguardedConstant), 'closure.mjs via TOOL',
    'the constant shape must be detected — v127, v135 and v138 all use it')

  const guarded = `${unguardedConstant}\nt.skip('RESOURCE: typescript is not installed')`
  assert.equal(hasSkipGuard(guarded), false,
    'a skip statement that no code path reaches is NOT a guard — measured on v138')

  const guardedAndCalled = `${guarded}\nif (!requireCompiler(t)) return`
  assert.equal(hasSkipGuard(guardedAndCalled), true, 'defined AND called is a guard')

  // A MENTION MUST NOT COUNT: this is the false positive the first version produced.
  const mentionOnly = [
    "const GATE = join(REPO, 'scripts', 'check-readme-counts.mjs')",
    "// closure.mjs needs the compiler; move-gate.mjs spawns it",
    "const stdout = execFileSync(process.execPath, [GATE], { encoding: 'utf8' })",
  ].join('\n')
  assert.equal(reachesTool(stripComments(mentionOnly)), undefined,
    'a doc comment naming the tool, or a DIFFERENT gate, must not be flagged')
})

test('v139: the resource-skip wording is the documented one', () => {
  /**
   * The reason text is part of the contract: the tally gate classifies `# SKIP` lines by matching
   * RESOURCE markers, so a skip introduced with different wording would be counted as PENDING and
   * silently change the README tally. Pin the wording that the classifier recognises.
   */
  const v135 = readFileSync(join(TEST_DIR, 'v135-subblock-closure.test.mjs'), 'utf8')
  assert.match(v135, /RESOURCE: typescript is not installed/u,
    'v135 is the reference implementation of this guard')

  const classiferSource = readFileSync(join(ROOT, 'scripts', 'check-readme-tally.mjs'), 'utf8')
  assert.match(classiferSource, /RESOURCE_MARKER\s*=\s*\/.*RESOURCE:/u,
    'the tally classifier keys on a RESOURCE marker — the skip text must keep matching it')
})
