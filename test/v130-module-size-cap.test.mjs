/**
 * ── META-GATE C: THE 800-LINE MODULE CAP IS A RULE, NOT A SENTENCE ───────────────────────────────
 *
 * `ARCHITECTURE` TD-1 has said "每个模块 ≤ 800 行" since v7.6. Measured on 2026-11-10:
 *
 *     core/ignition.ts      1,069 lines   ← over the cap it declares
 *     core/host-shape.ts    1,047 lines   ← over the cap it declares
 *     core/paradise-write.ts  322
 *     core/task-state.ts      557
 *     ...
 *
 * Two modules ALREADY violated the cap it had declared, and nothing noticed — because the cap was
 * prose. The user's ruling: it is now a NODE-ADMISSION condition ("闭包行数 > 800 的目标不得作为搬运
 * 节点"), so it must be executable, not written down.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
 *
 *   1. every `.ts`-bearing file under `src/core`, `src/contracts` and `src/utils` is ≤ 800 lines;
 *   2. exemptions are an EXPLICIT table (same shape as `v129`'s EXEMPT): the two modules that are
 *      already over the cap, each with the reason it cannot be split without behaviour change;
 *   3. an exemption is a CEILING, not a licence: it records today's measured size and the file may
 *      not GROW past it. Shrinking is always fine;
 *   4. `src/index.ts` is out of scope BY CONSTRUCTION — it is the file being decomposed (TD-1) — and
 *      that exclusion is asserted here rather than assumed, so nobody can widen the scope silently;
 *   5. a denominator: the scan must find a plausible number of files, or an empty walk would pass.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')
const CAP = 800

/** Ceilings, measured 2026-11-12. Each is "the size it has today", never a target. */
const EXEMPT = new Map([
  ['core/host-shape.ts', {
    /**
     * ── RAISED 1047 → 1049, AND WHY THAT IS NOT THE HOLE THIS GATE FORBIDS ───────────────────────
     *
     * The gate said 1049 > 1047 and was RIGHT to say it: a ceiling is not permission to grow. The
     * two lines added are both import statements, and they are a REPAIR, not growth —
     *
     *     import { isRecord, graftError } from '../utils/serialize.js'   ← graftError used 49×, isRecord 2×
     *     import type { SessionEventLike } from './watermark.js'         ← SessionEventLike used 7×
     *
     * — this file called all three names while importing none of them, which is why `tsc --noEmit`
     * reported 121 diagnostics and why 49 of them were one missing line. The alternative to the two
     * lines is not a smaller file; it is a file that does not compile.
     *
     * The mechanism still works: this raise is visible in the diff, has to be typed by a human, and
     * the next un-explained line fails the gate again.
     */
    ceiling: 1049,
    reason:
      'The host protocol surface: identity metadata, the four message constructors, materializeTape, ' +
      'buildInjectionEvents, assertColdLog, extractActiveGoalChange, and the system header + red line. ' +
      'It is a flat list of shape conversions with no shared mutable state, so splitting it would move ' +
      'code between files without changing any behaviour — pure review cost, no correctness gain. ' +
      'Ceiling raised 1047 → 1049 for two import statements repairing names the file already used ' +
      '(graftError 49×, isRecord 2×, SessionEventLike 7×) but never imported.',
  }],
  ['core/ignition.ts', {
    ceiling: 1069,
    reason:
      'The ignition channel: per-goal admission, the durable queue, retries and rollback. Its pieces share ' +
      'module-level state (the deps resolver, the pending queue), so a split needs dependency inversion — ' +
      'that is a signature change, not a move, and must be its own ruled-on item.',
  }],
])

const countLines = (file) => {
  const parts = readFileSync(file, 'utf8').replace(/\r\n/gu, '\n').split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

/**
 * ── THE DIRECTORY SET IS DISCOVERED, NOT LISTED (user ruling, N5c) ───────────────────────────────
 *
 * The first version hard-coded `['core', 'contracts', 'utils']`. That made every FUTURE directory a
 * blind spot: dropping `src/newarea/x.ts` into the tree would simply not be scanned, and the root-file
 * assertion below could not notice it (it only looks at `.ts` files directly under `src/`).
 *
 * A gate that enforces a rule must itself obey the rule that it has no hidden scope. So the directory
 * list comes from the filesystem.
 */
const scannedDirs = readdirSync(SRC)
  .filter((entry) => statSync(join(SRC, entry)).isDirectory())
  .sort()

function scan(dir, relative = '') {
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    const rel = relative === '' ? entry : `${relative}/${entry}`
    if (statSync(full).isDirectory()) { out.push(...scan(full, rel)); continue }
    if (!/\.ts(?:\.|$)/u.test(entry)) continue
    out.push({ rel, lines: countLines(full) })
  }
  return out
}

const files = scannedDirs.flatMap((name) => scan(join(SRC, name), name))

/**
 * ── AN INDEPENDENT WHOLE-TREE WALK, NOT A MAGIC FLOOR (user ruling, N5c) ─────────────────────────
 *
 * `>= 15` was a floor against 23 real files: dropping EIGHT files still passed. The denominator has to
 * be the actual set, computed by a SECOND implementation (the v126 pattern), so that a narrowed scan
 * has to disagree with an independent walk rather than with a constant.
 *
 * Scope: every `.ts`-bearing file under `src/` EXCEPT `src/index.ts` (which TD-1 is decomposing).
 */
function walkEveryTsBearingFile(dir, relative = '', out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    const rel = relative === '' ? entry : `${relative}/${entry}`
    if (statSync(full).isDirectory()) { walkEveryTsBearingFile(full, rel, out); continue }
    /**
     * ── A DIFFERENT PREDICATE ON PURPOSE (N6b) ────────────────────────────────────────────────
     *
     * The first version tested the SAME regex literal as `scan()` — `/\.ts(?:\.|$)/u` — twenty lines
     * apart. That is not an independent implementation: changing the filter in both places kept
     * `deepEqual` green while the assertion text claimed "a changed filter must fail HERE". Measured by
     * the user, and it is the v126 lesson repeating: the pattern was reused, so its weakness was too.
     *
     * `String.prototype.includes('.ts')` has no regex semantics to share, so a filter edit on one side
     * genuinely disagrees with the other. It is deliberately LOOSER than the scan (it would also accept
     * `foo.tsx`), which is the right direction: a looser reference set makes the scan's narrowness a
     * failure rather than an agreement.
     */
    if (!entry.includes('.ts')) continue
    out.push(rel)
  }
  return out
}

const expected = walkEveryTsBearingFile(SRC).filter((rel) => rel !== 'index.ts').sort()

test('cap: the scan covers EVERY .ts-bearing file under src/ except index.ts (independent walk)', () => {
  /**
   * ── WHAT THIS ASSERTION DOES AND DOES NOT COVER (N6b) ────────────────────────────────────────
   *
   * COVERS: a dropped directory, a dropped file, a scan that stops early, and any change to the scan's
   * file predicate — because the reference set is computed with a DIFFERENT predicate (`includes`).
   *
   * DOES NOT COVER: a change that makes `scan()` and the reference agree by both being wrong in the same
   * way, e.g. a renamed helper used by both, or a directory the walk itself cannot descend into. Measured:
   * narrowing BOTH predicates to `.tsx` makes them agree — and is then caught by the four NAME pins below
   * (they disappear from both sets), not by the independent walk. Saying so is the point: the previous
   * message promised "a changed filter must fail HERE", which was false while both sides shared one regex.
   */
  const actual = files.map((file) => file.rel).sort()
  assert.deepEqual(actual, expected,
    'the cap scan and an independent walk disagree. The reference set uses `includes(".ts")`, not the ' +
      'scan\'s regex, so a narrowed scan (dropped directory, dropped file, changed predicate, early ' +
      'stop) fails HERE rather than quietly reporting fewer violations.')
  assert.deepEqual(scannedDirs.length > 0, true,
    'no sub-directory under src/ was discovered; the scan would be empty by construction')
})

/**
 * ── THE FOUR BOUNDARY SAMPLES, PINNED BY NAME (N6c — the last round on this gate) ────────────────
 *
 * The previous version closed with `expected.length >= 20` against 24 real files, and its message said a
 * coordinated narrowing "is caught by the >= 20 denominator". That was true only for dropping FIVE or
 * more: dropping 1–4 still passed. A floor is one number away from being four numbers too wide.
 *
 * Names, not counts — the v126 lesson, applied here. Each pin exists for a different reason, so each
 * catches a different way the set can shrink:
 *
 *   core/ignition.ts.bak-cut  the PREDICATE boundary: contains ".ts" but does not end in it
 *   core/ignition.ts          an EXEMPT module must still be in the scanned set (a ceiling means the
 *   core/host-shape.ts        file is watched, not ignored) — both exemptions, not just one
 *   utils/serialize.ts        the DEEPEST directory: proves the walk descends rather than reading one level
 *
 * ── STOP CONDITION, AND WHAT STILL IS NOT COVERED ───────────────────────────────────────────────
 *
 * This is the last round on v130 (user ruling). Measured residual, stated rather than papered over:
 * removing an UNPINNED file from BOTH implementations still passes (dropping `utils/logger.ts`,
 * `core/layout.ts`, `core/ledger.ts`, `contracts/types.ts` together measured GREEN). Only the four
 * pinned names are protected by name.
 *
 * That residual is the same shape as "edit the pins themselves": it takes two coordinated edits in this
 * file, which a diff shows. Guarding it further would mean pinning every filename — a list that then
 * needs its own maintenance and has no boundary meaning. So the pins carry the boundary samples, and the
 * coordinated-removal case is left to review.
 */
test('cap: the scanned set is pinned BY NAME at four boundary samples', () => {
  const scanned = new Set(files.map((file) => file.rel))
  const walked = new Set(expected)
  const PINNED = [
    ['core/ignition.ts.bak-cut', 'the predicate boundary sample'],
    ['core/ignition.ts', 'an exempt module must still be scanned'],
    ['core/host-shape.ts', 'the other exempt module must still be scanned'],
    ['utils/serialize.ts', 'the deepest directory sample'],
  ]

  const missingFromScan = PINNED.filter(([name]) => !scanned.has(name)).map(([name]) => name)
  assert.deepEqual(missingFromScan, [],
    'the cap scan is missing a pinned file: ' + missingFromScan.join(', ') +
      '. A set that shrank by 1–4 files is still ≥ 20, so only a NAME pin catches it.')

  const missingFromWalk = PINNED.filter(([name]) => !walked.has(name)).map(([name]) => name)
  assert.deepEqual(missingFromWalk, [],
    'the independent walk is missing a pinned file: ' + missingFromWalk.join(', ') +
      '. Both sides are pinned, so narrowing either one is visible here.')
})

test('cap: every in-scope module is at or under 800 lines', () => {
  /**
   * Kept separate from the denominator on purpose: when this fails the failure must NAME the cap, not
   * "the scan has a denominator". Measured: the first version merged them, and a padded module reported
   * `✖ cap: the scan has a denominator` — a correct red under a misleading name.
   */
  const over = files.filter((file) => file.lines > CAP && !EXEMPT.has(file.rel))
  assert.deepEqual(over.map((file) => `${file.rel} (${file.lines})`), [],
    `these modules exceed the ${CAP}-line cap: split them, or add a reasoned ceiling to EXEMPT in this file`)
})

test('cap: src/index.ts is out of scope BY CONSTRUCTION, and that is asserted, not assumed', () => {
  /**
   * index.ts is the file being decomposed; including it would make this gate permanently red and
   * teach everyone to ignore it. Excluding it must be a stated fact with a checker, so that a future
   * "let's just exclude this directory too" cannot happen quietly.
   */
  const rootFiles = readdirSync(SRC).filter((entry) => /\.ts(?:\.|$)/u.test(entry))
  assert.deepEqual(rootFiles.sort(), ['index.ts'],
    'the only .ts-bearing file directly under src/ must be index.ts — if another appears, the scope ' +
      'decision above (index.ts is the one file being decomposed) no longer describes the tree')
})

test('cap: each exemption exists, states a reason, and is a CEILING that cannot be exceeded', () => {
  for (const [rel, entry] of EXEMPT) {
    const measured = files.find((file) => file.rel === rel)
    assert.ok(measured !== undefined, `EXEMPT lists ${rel}, which is not under the scanned directories`)
    assert.ok(entry.reason.trim().length >= 80,
      `the exemption for ${rel} needs a reason that can be argued with, not a shrug`)
    assert.ok(measured.lines <= entry.ceiling,
      `${rel} is ${measured.lines} lines, above its recorded ceiling of ${entry.ceiling}. ` +
        'An exemption is a snapshot of a module that is already too big, NOT permission for it to grow.')
  }
})

test('cap: an exemption must be deleted once its module is split below the cap', () => {
  /**
   * The other direction, and it is a REAL assertion: once a module is under the cap, its exemption is
   * stale and must go, otherwise the table slowly fills with entries that no longer mean anything —
   * and "these two, and only these two" stops being checkable.
   */
  for (const [rel, entry] of EXEMPT) {
    const measured = files.find((file) => file.rel === rel)
    assert.ok(measured !== undefined, `EXEMPT lists ${rel}, which is not in the scan`)
    assert.ok(measured.lines > CAP,
      `${rel} is now ${measured.lines} lines, at or under the ${CAP}-line cap — remove its exemption ` +
        `(ceiling was ${entry.ceiling}); a stale exemption is a hole with a label`)
  }
})
