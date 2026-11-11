/**
 * ── v137: 「总数对」不等于「每类对」——分类的逐条证据必须出现在输出里 ──────────────────────────────
 *
 * 用户 2026-11-11 的质疑：CI 报 skipped 17 = pending 2 + resource 15，算术对（734+17=751），
 * 但**分类器前三次都出过错**，所以「总数恰好对上」不能作为「每类都对」的证据。
 *
 * 实测查清的事实：
 *   - `check-readme-tally.mjs` 确实在子进程里用 --test-reporter=tap 跑套件，**逐条分类**；
 *   - 但它只把结果汇总成 `measured: ... (pending=2 resource=15)` 一行，
 *     **逐条分类结果从不离开那个进程**；
 *   - 于是任何读 CI 日志的人都无法验证那 15 条真是 resource，只能验证加法。
 *   - run #97 的日志里之所以能看到 TAP 行，是因为当次 v135 **失败**，失败详情顺带打印了 not ok 行。
 *     那次是运气，不是机制。
 *
 * 本测试钉住新的机制：分类逻辑抽成纯函数 `classifySkipLines`（可被检查而不必跑套件），
 * 且 gate 的每一行分类都必须连同**原因**打印出来。
 *
 * ── 为什么这里不 spawn check-readme-tally.mjs ────────────────────────────────────────────────────
 *
 * 第一版这么做了，结果是**递归**：gate 的 main 在子进程里跑 `node --test test/*.test.mjs`，
 * 而那套测试包含本文件 —— 实测把套件从 756 条推到 760 条、fail 从 0 推到 4。
 * 所以本文件只调纯函数，并用「读源码断言打印逻辑存在」来钉住输出形状。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TALLY = join(ROOT, 'scripts', 'check-readme-tally.mjs')
const TALLY_URL = pathToFileURL(TALLY).href

const load = () => import(TALLY_URL)

/** Real TAP lines this repo produces, copied from an actual run. */
const PENDING_KEEP = 'ok 369 - D2 control: a recursive delete is still destructive wherever it points # SKIP TD-17 ruled to KEEP this behaviour: recursive delete inside the workspace stays ALLOWED'
const PENDING_RULING = 'not ok 373 - C1: a pasted REPORT is not presented as the requirement # SKIP pending a ruling on goal semantics (用户要什么 vs 用户最后说了什么)'
/**
 * A RESOURCE skip in TAP shape. NOTE: the corpus gate prints
 * `# CORPUS-CHECK SKIPPED (RESOURCE_MISSING): …`, which contains `#` but NOT `# SKIP` — so it is not a
 * TAP directive at all and the classifier correctly returns undefined for it. The resource skips that DO
 * reach the classifier carry the standard `# SKIP RESOURCE:` prefix (the v127 mechanism).
 */
const RESOURCE_TS = 'ok 481 - v135: the instrument answers # SKIP RESOURCE: typescript is not installed in this checkout'
const RESOURCE_CORPUS = 'ok 482 - FULL CORPUS (local only) # SKIP RESOURCE: full corpus not present, denominator unverified here'
/** Not a directive: a test NAME that merely mentions the escape sequence. */
const ESCAPED_NAME = 'ok 436 - tally classifier: `not ok … \\# SKIP` is a SKIP, not a failure (the reporter uses both verbs)'

test('v137: the classifier tells the four real shapes apart, and ignores an escaped name', async () => {
  const { classifySkipLine } = await load()
  assert.equal(classifySkipLine(PENDING_KEEP), 'pending')
  assert.equal(classifySkipLine(PENDING_RULING), 'pending')
  assert.equal(classifySkipLine(RESOURCE_TS), 'resource')
  assert.equal(classifySkipLine(RESOURCE_CORPUS), 'resource')
  // a test NAME containing an escaped # SKIP is not a directive
  assert.equal(classifySkipLine(ESCAPED_NAME), undefined)
  // and the corpus gate's own non-TAP line is not a directive either
  assert.equal(classifySkipLine('ok 480 - FULL CORPUS # CORPUS-CHECK SKIPPED (RESOURCE_MISSING): full corpus not present'), undefined,
    '`# CORPUS-CHECK SKIPPED` is not `# SKIP` — counting it would double-count the resource skip')
})

test('v137: classifySkipLines returns one entry per directive, with its reason', async () => {
  const { classifySkipLines } = await load()
  const classified = classifySkipLines([PENDING_KEEP, PENDING_RULING, RESOURCE_CORPUS, RESOURCE_TS, ESCAPED_NAME].join('\n'))

  assert.equal(classified.length, 4, 'the escaped-name line is not a directive')
  assert.deepEqual(classified.map((entry) => entry.verdict), ['pending', 'pending', 'resource', 'resource'])
  for (const entry of classified) {
    assert.ok(entry.name.length > 0, 'every skip must name its test')
    assert.ok(entry.reason.length > 0, `"${entry.name}" must carry a reason, not just a verdict`)
  }
  // the corpus resource skip and the compiler resource skip both keep their own reason text
  assert.match(classified[2].reason, /RESOURCE:/u)
  assert.match(classified[2].reason, /full corpus not present/u)
  assert.match(classified[3].reason, /RESOURCE: typescript/u)
  // and the pending reasons stay distinguishable from the resource ones
  assert.match(classified[0].reason, /TD-17 ruled to KEEP/u)
  assert.match(classified[1].reason, /pending a ruling/u)
})

test('v137: the two totals are DERIVED from the classified lines, not counted separately', () => {
  const source = readFileSync(TALLY, 'utf8')
  // the totals must come out of the same list that gets printed
  assert.match(source, /const classified = classifySkipLines\(output\)/u)
  assert.match(source, /pending: classified\.filter\(\(entry\) => entry\.verdict === 'pending'\)\.length/u)
  assert.match(source, /resource: classified\.filter\(\(entry\) => entry\.verdict === 'resource'\)\.length/u)
  assert.doesNotMatch(source, /if \(verdict === 'resource'\) resource \+= 1/u,
    'the old separate counters would let the totals drift from the printed evidence')
})

test('v137: the gate PRINTS the evidence, with a self-consistency check that can fail', () => {
  const source = readFileSync(TALLY, 'utf8')
  assert.match(source, /skip evidence: \$\{classified\.length\} classified line\(s\)/u)
  assert.match(source, /for \(const \[index, entry\] of classified\.entries\(\)\)/u)
  assert.match(source, /totals derived from these lines: \$\{totalsAgree \? 'AGREE' : 'DISAGREE — gate bug'\}/u)
  assert.match(source, /if \(!totalsAgree\) process\.exitCode = 1/u)
})

test('v137: measureSuite no longer recurses — it does not spawn this test file', () => {
  const source = readFileSync(TALLY, 'utf8')
  // It runs the suite (that is its job), but the classification is a pure function so a test can
  // inspect it without triggering the suite again.
  assert.match(source, /export function classifySkipLines\(tapOutput\)/u)
  assert.match(source, /--test-reporter=tap/u, 'the gate must still measure with TAP, or reasons vanish')
})
