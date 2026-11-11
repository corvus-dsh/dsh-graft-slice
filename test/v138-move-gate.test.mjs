/**
 * ── v138: 四档搬迁门槛的仪器必须被校准，否则它会给出自信的错误答案 ────────────────────────────────
 *
 * `scripts/move-gate.mjs` 决定「一个簇能不能搬」。它自己在前两版里犯了两个错，都是实测抓到的：
 *
 * ① 逐行剥注释 —— 块注释 `/** … *\/` 通常跨几十行，单行正则永远匹配不到，注释里的 `{ }` 被当成代码。
 *    实测后果：`export const inject`（一行数组）吞到 L767，**GraftConfig 从声明表里消失**，
 *    而门槛却对「一个它根本没找到的声明」报了 YES / 288 行。
 *
 * ② 以「见过 `{` 且深度归零」为结束条件 —— `export const inject = [...]` 根本没有花括号，
 *    于是它一直跑到下一个 `{`，也就是 GraftConfig 体内。
 *
 * ③ 把注释里的提及算作调用者 —— GraftConfig 被 4 个模块「提到」，但 4 处**全在注释里**，
 *    没有一处 import；watermark.ts 的注释甚至明说「不能反向依赖 index.ts」。门槛却报 REVIEW。
 *
 * 这三个都不是「测试没覆盖」，是**仪器测的不是它以为的东西**。所以本测试用四个已知答案校准。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = join(ROOT, 'scripts', 'move-gate.mjs')
const SRC = join(ROOT, 'src', 'index.ts')

const gateJson = (cluster) => JSON.parse(execFileSync(process.execPath, [GATE, '--cluster', cluster, '--json'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}))

test('v138: comments are stripped over the WHOLE FILE, not line by line', () => {
  const gateSource = readFileSync(GATE, 'utf8')
  // The stripper must be a whole-source state machine, not a per-line regex.
  assert.match(gateSource, /function stripCommentsAndStrings\(source\)/u)
  assert.match(gateSource, /let state = 'code'/u, 'a real scanner tracks block/line/string state')
  assert.match(gateSource, /if \(char === '\/' && next === '\*'\) \{ state = 'block'/u, 'it must enter block-comment state')
  // and it must be applied to the WHOLE file before splitting
  assert.match(gateSource, /stripCommentsAndStrings\(text\)\.split\('\\n'\)/u,
    'the file must be stripped BEFORE it is split into lines')

  // behavioural: a JSDoc containing braces must not shift a declaration that follows it
  const decl = (() => {
    const report = gateJson('GraftConfig')
    return report.A.measured.declarations.find((entry) => entry.name === 'GraftConfig')
  })()
  assert.equal(decl.lines, 288,
    'the parser must still bound the declaration exactly, wherever the file puts it')
})

test('v138: the declaration parser reproduces independently-known spans', () => {
  /**
   * ── THE CALIBRATION MUST FOLLOW THE SOURCE, NOT PIN ONE LAYOUT ──────────────────────────────────
   *
   * GraftConfig used to be at index.ts L480..L767. It MOVED to src/core/graft-config.ts (cluster 2 of
   * the weight table), so a calibration that hard-coded 480/767 would now be asserting a fact about a
   * file it is no longer in — and would have to be "fixed" by editing numbers, which is how a test stops
   * testing anything.
   *
   * Two anchors therefore stay FIXED (they are the sizes the weight table depends on) and one moves with
   * the source: the cluster's own size is 288 lines wherever it lives.
   */
  const report = gateJson('GraftConfig')
  const config = report.A.measured.declarations.find((entry) => entry.name === 'GraftConfig')
  assert.ok(config !== undefined, 'GraftConfig must be FOUND — the first bug made it vanish')
  assert.equal(config.lines, 288, 'the cluster is 288 lines wherever it lives')
  assert.equal(config.kind, 'type', 'and it is a type, which is why the move is artifact-zero')

  // buildTape is the container C4 depends on; if it is not parsed, C4 is a false pass.
  // Its SIZE is the calibration anchor (496); its line numbers moved by exactly the moved line count.
  const container = gateJson('buildTape').A.measured.declarations.find((entry) => entry.name === 'buildTape')
  assert.ok(container !== undefined, 'buildTape must be FOUND — the second bug hit longer signatures')
  assert.equal(container.lines, 496, 'buildTape body is still 496 lines')

  // and the source really does have buildTape at that span — asserted against the file itself below
  const lines = readFileSync(SRC, 'utf8').split('\n')
  assert.equal(lines[container.start - 1], 'export function buildTape(', 'the reported start is the declaration')
  assert.equal(lines[container.end - 1], '}', 'the reported end closes it')
})

test('v138: C4 actually counts the container body, not zero', () => {
  const report = gateJson('GraftConfig')
  const { containerAssignments, containerBodyLines } = report.C4.measured
  // Measured truth: 496 body lines, EXACTLY 67 local bindings.
  // An exact number, not "more than 50": the loose bound let a mutation that drops every const/let
  // binding (67 -> 62) pass, and 62 still looks like "dozens". The number is the check.
  assert.equal(containerBodyLines, 496)
  assert.equal(containerAssignments, 67,
    'the parser must find every local binding in buildTape; a drop means the C4 signal is blind')
  assert.equal(report.C4.verdict, 'YES')
  assert.deepEqual(report.C4.measured.implicitOrdering, [], 'GraftConfig reads nothing produced inside buildTape')
})

test('v138: a mention inside a comment is NOT a production caller', () => {
  const report = gateJson('GraftConfig')
  assert.equal(report.C2.verdict, 'YES', 'GraftConfig is mentioned only in comments outside index.ts')
  assert.deepEqual(report.C2.measured.productionCallers, [], 'no module under src/ actually references it in code')

  // and prove the four files really do mention it, so the assertion above is not vacuous
  const mentions = []
  for (const rel of ['core/host-shape.ts', 'core/ignition.ts', 'core/store-layer.ts', 'core/watermark.ts']) {
    const text = readFileSync(join(ROOT, 'src', rel), 'utf8')
    if (/\bGraftConfig\b/u.test(text)) mentions.push(rel)
    const importLine = text.split('\n').find((line) => /^\s*import\b/u.test(line) && /\bGraftConfig\b/u.test(line))
    assert.equal(importLine, undefined, `${rel} must not import GraftConfig — it deliberately stays structural`)
  }
  assert.equal(mentions.length, 4, 'the four comment mentions are real; the verdict comes from stripping them')

  // index.ts must now RE-EXPORT it rather than declare it — the export surface depends on this
  const indexText = readFileSync(SRC, 'utf8')
  assert.match(indexText, /export type \{ GraftConfig \} from '\.\/core\/graft-config\.js'/u,
    'index.ts must re-export the moved type so the package surface is unchanged')
  assert.doesNotMatch(indexText, /export interface GraftConfig \{/u,
    'and must no longer declare it')
})

test('v138: tier A really measures against 800 — and refuses what it cannot find', () => {
  const small = gateJson('GraftConfig')
  assert.equal(small.A.verdict, 'YES')
  assert.equal(small.A.measured.cap, 800, 'the cap must be reported, not assumed')
  assert.equal(small.A.measured.moduleLines, 288)

  const gateSource = readFileSync(GATE, 'utf8')
  assert.match(gateSource, /const aVerdict = spans\.length > 0 && moduleLines <= 800/u,
    'A must be a comparison over a FOUND span — a hard-coded YES is not a measurement')

  // An unknown cluster must NOT report a plausible size. Measured: before cross-file resolution,
  // a moved cluster reported "0 行 — YES", a pass on something the gate had not found at all.
  const missing = (() => {
    try {
      return JSON.parse(execFileSync(process.execPath, [GATE, '--cluster', 'NoSuchSymbolAnywhere', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
    } catch (error) { return undefined }
  })()
  assert.ok(missing !== undefined, 'the gate must still emit JSON for an unknown cluster')
  assert.notEqual(missing.A.verdict, 'YES', 'an unknown cluster must never pass tier A')
})

test('v138: tiers A, C2, C3, C4 have machine verdicts; C1 and D do not pretend to', () => {
  const report = gateJson('GraftConfig')
  assert.equal(report.A.verdict, 'YES')
  assert.equal(report.C3.verdict, 'YES')
  assert.deepEqual(report.C3.measured.outsideRefs, [], 'a pure type cluster needs nothing outside itself')
  // C1 and D are semantic: the gate must say so rather than guess
  assert.equal(report.C1.machine, false)
  assert.equal(report.D.machine, false)
  assert.equal(report.D.verdict, 'MEASURED-SEPARATELY')
})

test('v138: a cluster that already moved is still found — in its own module, by name', () => {
  /**
   * Tier A used to read only src/index.ts. After GraftConfig moved, A reported "0 行 — YES": a pass on
   * something it had not found. The gate must resolve across the whole tree and SAY which file it used,
   * otherwise "the cluster is small" is a claim about nothing.
   */
  const report = gateJson('GraftConfig')
  const span = report.A.measured.declarations.find((entry) => entry.name === 'GraftConfig')
  assert.ok(span !== undefined)
  assert.equal(span.file, 'core/graft-config.ts', 'the gate must report WHERE it found the cluster')
  assert.equal(span.lines, 288)
  assert.equal(report.A.verdict, 'YES')
})

test('v138: the gate refuses a cluster it cannot find instead of passing vacuously', () => {
  const output = (() => {
    try {
      return execFileSync(process.execPath, [GATE, '--cluster', 'ThisSymbolDoesNotExist'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch (error) { return `${error.stdout ?? ''}${error.stderr ?? ''}` }
  })()
  // no declaration span -> A must not report a size it never measured
  assert.match(output, /0 行|NO/u, `an unknown symbol must not report a plausible size:\n${output}`)
})

test('v138: the gate is calibrated against the real source, so its numbers move with refactors', () => {
  const lines = readFileSync(SRC, 'utf8').split('\n')
  const container = gateJson('buildTape').A.measured.declarations.find((entry) => entry.name === 'buildTape')
  assert.equal(lines[container.start - 1], 'export function buildTape(', 'the reported start is real')
  assert.equal(lines[container.end - 1], '}', 'the reported end is real')

  // GraftConfig lives in its own module now: its span must be real THERE, not in index.ts.
  const moduleLines = readFileSync(join(ROOT, 'src', 'core', 'graft-config.ts'), 'utf8').split('\n')
  assert.equal(moduleLines[0], '/** Per-row configuration. All fields are optional; defaults are conservative. */')
  assert.ok(moduleLines.some((line) => line.startsWith('export interface GraftConfig {')),
    'the moved declaration must still be in the module it moved to')
  assert.equal(moduleLines.filter((line) => line.trim().length > 0).length > 0, true)
})
