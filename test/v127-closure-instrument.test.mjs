/**
 * ── THE MEASURING INSTRUMENT WAS BLIND, AND NOTHING WAS PINNING IT ────────────────────────────────
 *
 * `scripts/closure.mjs` — the tool the whole node-ordering table is built from — keyed every
 * module-scope declaration on `statement.name?.text`. `FunctionDeclaration` has a `.name`.
 * `VariableStatement` does NOT: its names live on `declarationList.declarations[i].name`.
 *
 * Measured consequence, before this file existed: `classifyAgentCommand` reads SEVEN module-level
 * regex constants and the tool reported **8 declarations, none of them a constant**. The obvious plan
 * ("move the smallest closure first") would have carried the functions and left every regex behind.
 *
 * Two defects, one cause:
 *   ① every `const` / `let` was invisible, so closures were systematically UNDER-counted;
 *   ② `mutable` was computed only inside the variable branch — which never ran — so the plan's
 *      STOP CONDITION ("closure contains module-level mutable state ⇒ stop") was structurally
 *      unable to fire. A stop condition that cannot fire reads as "checked, nothing found".
 *
 * A threshold on the count (`declarations > 0`) would NOT have caught either one: the counts were
 * plausible. What catches them is asserting the closure's CONTENT — a specific constant must be a
 * member, and a known-shared `let` must be reported.
 *
 * ── WHEN THIS SKIPS ──────────────────────────────────────────────────────────────────────────────
 *
 * The tool needs the TypeScript compiler, which this package deliberately does not depend on
 * (`npm i --no-save typescript`). Without it the tool exits 2 rather than guessing, and this test
 * skips as RESOURCE — it never silently passes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOL = join(ROOT, 'scripts', 'closure.mjs')

/** Run the tool once; returns { output, exitCode }. */
function measure(target) {
  try {
    const output = execFileSync(process.execPath, [TOOL, target], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { output, exitCode: 0 }
  } catch (error) {
    return { output: `${error.stdout ?? ''}${error.stderr ?? ''}`, exitCode: error.status ?? 1 }
  }
}

const compilerMissing = (result) =>
  result.exitCode === 2 && /typescript NOT installed/u.test(result.output)

function requireCompiler(t) {
  const probe = measure('calculateAdaptiveDepth')
  if (compilerMissing(probe)) {
    t.skip('RESOURCE: typescript is not installed; closure.mjs exits 2 rather than guessing')
    return undefined
  }
  assert.equal(probe.exitCode, 0, `closure.mjs failed on the calibration target:\n${probe.output}`)
  return probe
}

test('closure: a module-level `const` IS a closure member (the tool was blind to every one of them)', (t) => {
  /**
   * ── WHY A CONST AND NOT A COUNT ───────────────────────────────────────────────────────────────
   *
   * Asserting `declarations >= 15` would be satisfied by any future symbol being added elsewhere.
   * Asserting that the SEVEN regex constants are members is asserting the instrument reads
   * variable declarations at all — the actual defect. Before the fix this reported 8 members and
   * every constant was absent; after it, 15.
   */
  if (requireCompiler(t) === undefined) return
  const { output } = measure('classifyAgentCommand')

  const constants = ['DESTRUCTIVE_VERB', 'ESCAPING_ROOT', 'RECURSIVE_FLAG', 'SEARCH_VERB',
    'SEGMENT_START', 'SYSTEM_DIR', 'UNCONFINABLE_VERB']
  const missing = constants.filter((name) => !new RegExp(`\\b${name} \\[const\\]`, 'u').test(output))
  assert.deepEqual(
    missing,
    [],
    'closure.mjs must count module-level `const` declarations as members. These are read by ' +
      'classifyAgentCommand and were absent from its closure, so "move the closure" would have left ' +
      'every regex behind:\n' + output,
  )
})

test('closure: module-level mutable state in a closure IS reported (the STOP CONDITION can fire)', (t) => {
  /**
   * ── THE STOP CONDITION HAD NEVER BEEN OBSERVED FIRING ────────────────────────────────────────
   *
   * `recoverGraftTransactions` reads `retiredStorePath`, `transferredStorePath`, `graftTargetsPath`,
   * `txnDirPath`, `leftoversStorePath`, `autoGraftSuppressedPath`, `storeCtx` — seven module-level
   * `let` bindings. Before the fix the tool reported `mutable: none` for it, i.e. the plan's
   * "closure contains module-level mutable state ⇒ stop" gate could never fire on the one target
   * that most obviously contains it (ARCHITECTURE TD-1: "那不是闭包，是共享状态").
   */
  if (requireCompiler(t) === undefined) return
  const { output } = measure('recoverGraftTransactions')

  const mutableLine = /mutable\s+: (.*)/u.exec(output)?.[1]?.trim()
  assert.notEqual(mutableLine, 'none', 'recoverGraftTransactions shares module-level `let` bindings; ' +
    'reporting none means the mutable-state STOP CONDITION cannot fire:\n' + output)
  for (const name of ['retiredStorePath', 'graftTargetsPath', 'storeCtx']) {
    assert.match(output, new RegExp(`${name} \\(let/var\\)`, 'u'), `${name} must be reported as mutable state`)
  }
})

test('closure: a closure with NO mutable state reports none (no false alarm)', (t) => {
  /** The other direction: a checker that always says "mutable" is as useless as one that never does. */
  if (requireCompiler(t) === undefined) return
  const { output } = measure('calculateAdaptiveDepth')
  const mutableLine = /mutable\s+: (.*)/u.exec(output)?.[1]?.trim()
  assert.equal(mutableLine, 'none', 'calculateAdaptiveDepth is a pure leaf; a mutable report is a false alarm:\n' + output)
})

test('closure: a `const` object mutated in place counts as mutable state, not as a constant', (t) => {
  /**
   * ── FOUND BY THE PROBE, NOT BY READING THE CODE ─────────────────────────────────────────────
   *
   * The first version of the fix tested `ts.isIdentifier(node.left)`. `reassignedConstant.n += 1`
   * has a PropertyAccessExpression on the left, so the test was false and an in-place-mutated
   * `const` object was reported as immutable. Measured with a fixture: expected mutable, tool said
   * `none`. The root identifier of the assignment target is what must be recorded.
   *
   * Pinned on a real symbol rather than on a fixture file, because a fixture under src/ would be
   * inlined into the shipped bundle by scripts/bundle.mjs.
   */
  if (requireCompiler(t) === undefined) return
  const { output } = measure('recoverGraftTransactions')
  // storeScope / draftsLoaded are reassigned; storeCtx is a `let` — either way the report must name a kind.
  assert.match(output, /\((?:let\/var|const)\)/u, 'each reported mutable binding must name its kind:\n' + output)
})
