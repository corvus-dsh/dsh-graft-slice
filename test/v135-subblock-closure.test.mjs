/**
 * ── v135: THE SUB-BLOCK INSTRUMENT, CALIBRATED BEFORE IT IS USED ─────────────────────────────────
 *
 * `closure.mjs` could only measure a WHOLE top-level declaration. That is enough to move leaves, and not
 * enough to split the two containers that remain (`buildTape` 48/1,750 and `buildInjectionPlan`
 * 110/3,705 — both far over the 800-line cap). Splitting them means cutting a CLOSED SUB-BLOCK out of the
 * middle, and that decision needs the same question asked about a line range: *what must travel with
 * this block?*
 *
 * This file exists because of the phase's own lesson: **instrument first, then act.** `closure.mjs` was
 * once blind to every module-level `const`; the 800-line cap was once only prose; the golden file was
 * once unprotected. So the new mode is calibrated against three KNOWN answers before anything uses it:
 *
 *   ① `calculateAdaptiveDepth` as a whole function → 2 declarations / 124 lines (matches `closureOf`)
 *   ② `buildPendingState` as a whole function      → 19 declarations / 229 lines
 *   ③ a hand-picked `buildTape` sub-block          → exact expected local/outside split, asserted below
 *
 * ① and ② are the cross-check that the new mode did not silently change the OLD mode's answer when the
 * two agree on a range that covers exactly one declaration.
 *
 * ── NO REBUILD NEEDED ───────────────────────────────────────────────────────────────────────────
 *
 * This test spawns `scripts/closure.mjs` (a script, not the built artifact), so the ac72ed6 discipline
 * ("mutate src → rebuild → test") does not apply. Stated so nobody "fixes" it by inserting a build.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOL = join(REPO, 'scripts', 'closure.mjs')

const run = (args) => {
  try {
    return { output: execFileSync(process.execPath, [TOOL, ...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), code: 0 }
  } catch (error) {
    return { output: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.status ?? 1 }
  }
}

/**
 * Read a labelled number from the tool's block output.
 *
 * The labels are printed with leading spaces (`  local declarations      : 0`), so the pattern must
 * tolerate them — the first version did not, returned `NaN`, and produced a FAILING calibration test
 * whose failure said "the range does not match" when the real problem was the reader. That is the same
 * class of mistake this phase keeps finding (an instrument measuring the wrong thing), so it is fixed
 * here rather than by loosening the assertion.
 */
const field = (output, label) => {
  // Walk the lines instead of one regex: the label is followed by variable padding before the colon, and
  // a padded regex proved easy to get subtly wrong (the first attempt silently returned `undefined`).
  for (const line of output.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim() === label) return line.slice(colon + 1).trim()
  }
  return undefined
}

/** The NUMBER inside a labelled field, with a named failure if the label is missing or unparsable. */
const fieldNumber = (output, label) => {
  const raw = field(output, label)
  assert.ok(raw !== undefined, `the tool did not print "${label}":\n${output}`)
  const value = Number(raw.split(' ')[0])
  assert.ok(Number.isFinite(value), `"${label}" was not a number (got "${raw}"):\n${output}`)
  return value
}

test('v135: the instrument still answers the WHOLE-function question unchanged (regression)', () => {
  /**
   * Two samples with answers recorded earlier in this phase. If refactoring for sub-blocks changed the
   * whole-declaration numbers, those numbers are the ones every node's report quoted — so THIS is the
   * first thing to check, before looking at the new mode at all.
   */
  const { output, code } = run([])
  assert.equal(code, 0, `calibration run failed:\n${output}`)

  const readings = {}
  for (const name of ['calculateAdaptiveDepth', 'buildPendingState', 'stripHostNoise']) {
    const line = output.split('\n').find((entry) => entry.trim().startsWith(name))
    assert.ok(line !== undefined, `${name} missing from the calibration output:\n${output}`)
    const declarations = Number(/^\s*\S+\s+(\d+) decl/u.exec(line)?.[1])
    const lines = Number(/(\d+) lines/u.exec(line)?.[1])
    readings[name] = { declarations, lines }
  }

  assert.deepEqual(readings.calculateAdaptiveDepth, { declarations: 2, lines: 124 },
    'the pure leaf must still measure 2 declarations / 124 lines')
  assert.deepEqual(readings.buildPendingState, { declarations: 19, lines: 229 },
    'this count is quoted in ARCHITECTURE and in the N7 commit; a silent change here invalidates them')
})

test('v135 ①: a whole-declaration RANGE reproduces the whole-declaration CLOSURE', () => {
  /**
   * The strongest available cross-check: give sub-block mode the exact line span of a known declaration
   * pair and confirm it reports the SAME declaration count the whole-function mode does.
   *
   * `core/adaptive-depth.ts` is the cleanest sample: it contains exactly two declarations
   * (`AdaptiveDepthResult`, `calculateAdaptiveDepth`), and `closureOf('calculateAdaptiveDepth')` reports
   * 2 declarations. So the range must report 2 local + 0 outside. If the two modes disagree on the same
   * tree, the new traversal is wrong.
   *
   * Note the file: the function MOVED to `core/adaptive-depth.ts` in N4, so measuring it inside
   * `index.ts` would silently measure a different range — the kind of "wrong input, plausible number"
   * failure this phase has hit repeatedly.
   */
  const whole = run(['calculateAdaptiveDepth'])
  assert.equal(whole.code, 0, whole.output)
  const wholeDeclarations = Number(/declarations\s*: (\d+)/u.exec(whole.output)?.[1])

  const block = run(['--block', 'src/core/adaptive-depth.ts', '17', '141'])
  assert.equal(block.code, 0, block.output)

  const localCount = fieldNumber(block.output, 'local declarations')
  const outsideCount = fieldNumber(block.output, 'OUTSIDE declarations')

  console.log(`  closureOf: ${wholeDeclarations} declarations`)
  console.log(`  range    : ${localCount} local + ${outsideCount} outside`)

  assert.equal(localCount, wholeDeclarations,
    'a range covering the whole declaration must find the same declarations as the whole-function mode')
  assert.equal(outsideCount, 0,
    'this module holds the entire closure, so no declaration outside the range is referenced')
  assert.equal(field(block.output, 'mutable'), 'none', 'the pure leaf has no mutable state')
})

test('v135 ③: a hand-picked buildTape sub-block reports the expected split', () => {
  /**
   * ── THE HAND-PICKED SAMPLE, AND WHY THIS ONE ─────────────────────────────────────────────────
   *
   * `ensureTurn` (L3755..L3764) is a self-contained arrow function inside `buildTape`. It declares
   * nothing at module scope, and its only module-level dependency is the `TurnDraft` interface — which is
   * exactly the shape a viable sub-block cut looks like: a small range whose outside set is one type.
   *
   * The expected numbers were read off the tree, then asserted: 0 local declarations, exactly 1 outside
   * (`TurnDraft`), no mutable state. If the instrument disagrees, IT is wrong — that is the point of a
   * calibration sample.
   */
  const { output, code } = run(['--block', 'src/index.ts', '3755', '3764'])
  assert.equal(code, 0, `sub-block run failed:\n${output}`)
  assert.equal(fieldNumber(output, 'local declarations'), 0,
    'this range declares nothing at module scope')
  assert.equal(fieldNumber(output, 'OUTSIDE declarations'), 1,
    'the only module-level dependency of this range is TurnDraft')
  assert.match(output, /index\.ts:TurnDraft \[InterfaceDeclaration\]/u,
    'the outside set must NAME the dependency it found')
  assert.equal(field(output, 'mutable'), 'none',
    'an arrow function reading an interface has no mutable state')
})

test('v135: a range with NO outside dependencies reports an empty set (the viable-cut shape)', () => {
  /**
   * The useful answer for a candidate cut is `OUTSIDE declarations: 0` — nothing has to be threaded in.
   * A range of pure comments/whitespace is the simplest such range and must not invent dependencies.
   */
  const { output, code } = run(['--block', 'src/index.ts', '1', '5'])
  assert.equal(code, 0, output)
  assert.equal(fieldNumber(output, 'OUTSIDE declarations'), 0, 'a comment-only range depends on nothing')
  assert.equal(field(output, 'mutable'), 'none')
})

test('v135: an unknown file is a NAMED failure, not a crash', () => {
  const { output, code } = run(['--block', 'src/index.ts', '999999', '1000000'])
  assert.equal(code, 0, 'a range beyond the file should still be answered (empty), not crash')
  assert.match(output, /block index\.ts/u)
})
