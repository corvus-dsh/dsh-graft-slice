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

import { classifySkipLine } from '../scripts/check-readme-tally.mjs'

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
