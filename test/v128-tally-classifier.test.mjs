/**
 * ── THE TALLY GATE'S INPUT RULE, PINNED ───────────────────────────────────────────────────────────
 *
 * `scripts/check-readme-tally.mjs` decides whether a skipped test is a RESOURCE skip (a file missing on
 * THIS machine — excluded from the documented number) or a PENDING skip (the repo declared it as awaiting
 * a decision — the README must document it, in every checkout).
 *
 * That decision is made by matching the SKIP REASON text, and it is the gate's entire input. It had no
 * test, and it was wrong in the direction that fails a build:
 *
 *   CI run 60: `documented skipped 2 != measured PENDING skips 6`
 *
 * The four extra were v127's tests, whose reason begins `RESOURCE: typescript is not installed…`. The
 * marker listed `RESOURCE_MISSING` but not the bare `RESOURCE:` prefix, so four MACHINE skips were
 * counted as REPO skips.
 *
 * ── WHY THE CASES BELOW ARE THE REAL STRINGS ────────────────────────────────────────────────────
 *
 * Every reason in this file is copied from a `t.skip(...)` that exists in `test/`. A synthetic list would
 * pin the classifier against my imagination instead of against the suite — the same error as testing a
 * copy of a helper rather than the helper (v126).
 *
 * ── AND THE DEFAULT IS DELIBERATE ───────────────────────────────────────────────────────────────
 *
 * An unrecognised reason classifies as PENDING, i.e. the gate demands the README document it and goes
 * red. That is the fail-loud direction: the alternative (defaulting to resource) would silently exclude
 * a skip from the documented number, which is the "report claiming more coverage than exists" failure
 * this gate exists to prevent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { classifySkipLine, tallyClaims } from '../scripts/check-readme-tally.mjs'

/** TAP lines exactly as the reporter prints them (`ok …` and `not ok …`). */
const line = (reason) => `ok 700 - some test name # SKIP ${reason}`

test('tally classifier: machine-missing resources are classified RESOURCE (excluded from the README)', () => {
  const reasons = [
    // v127 — THE ONE THAT BROKE CI: a bare `RESOURCE:` prefix, not `RESOURCE_MISSING`.
    'RESOURCE: typescript is not installed; closure.mjs exits 2 rather than guessing',
    'RESOURCE_MISSING: ../_scratch/real-texts.json is not in this checkout',
    'corpus absent at D:\\x\\_scratch\\real-texts.json — provenance unverified in this checkout (not a pass)',
    'observer source absent at D:\\x\\dsh-observer\\src — parity unverified in this checkout (not a pass)',
    'observer source absent — intent note unverified',
    'ledger absent at D:\\x\\.graft-ledger.jsonl — reverse validation not run in this checkout',
    'CORPUS-CHECK SKIPPED (RESOURCE_MISSING): full corpus not present; the committed sample above still ran',
    'git unavailable in this environment',
  ]
  const misclassified = reasons.filter((reason) => classifySkipLine(line(reason)) !== 'resource')
  assert.deepEqual(misclassified, [], 'these are properties of the MACHINE, not of the repo; counting them as ' +
    'pending skips makes the gate demand a README number that is false in every complete checkout')
})

test('tally classifier: declared-pending skips stay PENDING (the README number must match them)', () => {
  const reasons = [
    'TD-17 ruled to KEEP this behaviour: recursive delete inside the workspace stays ALLOWED',
    'pending a ruling on goal semantics (用户要什么 vs 用户最后说了什么)',
  ]
  const misclassified = reasons.filter((reason) => classifySkipLine(line(reason)) !== 'pending')
  assert.deepEqual(misclassified, [], 'a repo-declared pending test must be documented; classifying it as a ' +
    'resource skip would hide it from the tally')
})

test('tally classifier: `not ok … # SKIP` is a SKIP, not a failure (the reporter uses both verbs)', () => {
  /**
   * Measured in this checkout: `t.skip()` after a real assertion is reported through the failing channel —
   * `not ok 373 - C1: … # SKIP pending a ruling …`. Keying on `^ok ` counted 1 of the 2 pending tests.
   */
  assert.equal(
    classifySkipLine('not ok 373 - C1: a pasted REPORT is not presented as the requirement # SKIP pending a ruling on goal semantics'),
    'pending',
  )
  assert.equal(classifySkipLine(line('RESOURCE: typescript is not installed')), 'resource')
})

test('tally classifier: an UNKNOWN reason defaults to PENDING, so a new skip cannot slip through quietly', () => {
  /**
   * The fail-loud default. If someone adds a skip with a reason this classifier has never seen, the gate
   * must complain rather than exclude it — otherwise "a guard went quiet" becomes invisible again.
   */
  assert.equal(classifySkipLine(line('something nobody thought about')), 'pending')
})

test('tally classifier: a non-skip line is not counted at all', () => {
  for (const notASkip of ['ok 1 - a normal passing test', 'not ok 2 - a genuine failure', '# tests 702']) {
    assert.equal(classifySkipLine(notASkip), undefined, `${notASkip} is not a skip line`)
  }
})

test('tally classifier: an ESCAPED `\\# SKIP` inside a test NAME is not a directive', () => {
  /**
   * ── THIS GATE COUNTED ITS OWN TEST AS A SKIP ────────────────────────────────────────────────────
   *
   * Measured: after adding this file, the gate reported `measured PENDING skips 3` while the suite
   * printed `# skipped 2`. The culprit was the test named
   * ``` `not ok … # SKIP` is a SKIP, not a failure ``` — TAP escapes a literal `#` in a NAME as `\#`,
   * and the directive regex accepted it anyway.
   *
   * Left in the suite ON PURPOSE as the regression probe: if the lookbehind is ever dropped, this test
   * stays green (it asserts nothing about itself) but the gate's pending count goes wrong again — so the
   * assertion below is the thing that must hold, and it fails on the old regex.
   */
  assert.equal(
    classifySkipLine('ok 436 - tally classifier: `not ok … \\# SKIP` is a SKIP, not a failure'),
    undefined,
    'an escaped # inside a test NAME is text, not a TAP directive',
  )
  // The real directive has no backslash and must still be seen.
  assert.equal(classifySkipLine('ok 437 - something # SKIP a real reason'), 'pending')
})

/**
 * ── THE CLAIM PARSER, PINNED AGAINST THE REAL DOCUMENT ──────────────────────────────────────────
 *
 * `tallyClaims` had NO test at all — only the skip classifier above did. So when the README's tally
 * row was re-typeset (`**696/698**（2 条待裁定跳过）` → `**850 / 852**（**2 条 skipped，不是 failed**）`),
 * the parser silently stopped matching, the gate reported `claims found: 0`, and nothing local noticed
 * because the gate only ran in CI (measured 2026-11-17, graft CI run 44019243007, step 15).
 *
 * The failure mode is ⑰: a parser tested only against samples its author wrote will always agree with
 * itself. So the FIRST case below reads the actual README row off disk instead of carrying a copy —
 * a fixture that is not the document proves nothing, and a copy drifts with the document.
 */
test('tally claims: the REAL README row parses (read from README.md, not copied into this file)', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const row = readme.split(/\r?\n/u).find((line) => /全量测试\s*\|/u.test(line) && /\*\*\d+\s*\/\s*\d+\*\*/u.test(line))
  assert.ok(row !== undefined,
    'README.md 里找不到「全量测试」表格行 —— 这一行的形状变了，解析器必须跟着改，' +
    '而不是让门禁在 CI 上报 `claims found: 0`（选择器同时要求 `全量测试 |` 与 `**N/M**`：' +
    'README 里还有别的行含「全量测试」三个字，只看这三个字会抓到散文行）')

  const claims = tallyClaims(row)
  const own = claims.find((claim) => claim.repo === 'graft')
  assert.ok(own !== undefined, `解析器在真实的 README 行上抓不到本仓的声明：\n${row}`)
  // Parser-level invariants only — the NUMBERS are the gate's business, not this test's.
  assert.equal(typeof own.passed, 'number')
  assert.equal(typeof own.total, 'number')
  assert.ok(own.skipped !== undefined, '这一行声明了 skipped 段，解析器必须把它读出来')
  assert.equal(own.passed + own.skipped, own.total, '读出来的三个数必须自洽')
  // The same row carries a sibling repo's tally, which must be attributed, not swallowed.
  assert.ok(claims.some((claim) => claim.repo === 'memory'),
    `同一行里 memory 的声明必须被识别为「另一个仓」而不是本仓：\n${JSON.stringify(claims)}`)
})

test('tally claims: four spellings of the same declaration all parse', () => {
  /**
   * The variants are not decoration: each one was a real re-typesetting of the row. Relaxing the
   * parser is allowed to change HOW the claim is found; it must not change WHAT is required of it.
   */
  const cases = [
    ['**850/852**（2 条跳过）', 'no spaces, 中文'],
    ['**850 / 852**（2 条 跳过）', 'spaces around the slash'],
    ['graft **850 / 852**（**2 条 skipped，不是 failed**：…）', 'number inside **, English word'],
    ['graft **850/852**（2 条待裁定跳过）', 'the shape this parser was originally written against'],
  ]
  for (const [line, why] of cases) {
    const [claim] = tallyClaims(line)
    assert.ok(claim !== undefined, `解析不到：${why} —— ${line}`)
    assert.deepEqual(
      { passed: claim.passed, total: claim.total, skipped: claim.skipped },
      { passed: 850, total: 852, skipped: 2 },
      `${why} 被解析成了别的三个数：${line}`,
    )
  }
  // A complete run declares no skipped section at all.
  assert.equal(tallyClaims('memory **546 / 546**')[0].skipped, undefined)
})

test('tally claims: text with NO declaration yields ZERO claims (the gate turns that into a FAIL)', () => {
  /**
   * This is the half that must NOT be relaxed. `check-readme-tally.mjs` treats "no claim found" as a
   * failure — "a missing claim is a missing check, not a pass" — so the parser must keep returning an
   * empty array rather than inventing a claim.
   */
  assert.deepEqual(tallyClaims('测试全绿；见 README。'), [])
  assert.deepEqual(tallyClaims('| 全量测试 | 850 of 852 | x |'), [])
})
