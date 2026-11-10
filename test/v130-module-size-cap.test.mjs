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

/** Ceilings, measured 2026-11-10. Each is "the size it has today", never a target. */
const EXEMPT = new Map([
  ['core/host-shape.ts', {
    ceiling: 1047,
    reason:
      'The host protocol surface: identity metadata, the four message constructors, materializeTape, ' +
      'buildInjectionEvents, assertColdLog, extractActiveGoalChange, and the system header + red line. ' +
      'It is a flat list of shape conversions with no shared mutable state, so splitting it would move ' +
      'code between files without changing any behaviour — pure review cost, no correctness gain.',
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
    if (/\.ts(?:\.|$)/u.test(entry)) out.push(rel)
  }
  return out
}

const expected = walkEveryTsBearingFile(SRC).filter((rel) => rel !== 'index.ts').sort()

test('cap: the scan covers EVERY .ts-bearing file under src/ except index.ts (independent walk)', () => {
  const actual = files.map((file) => file.rel).sort()
  assert.deepEqual(actual, expected,
    'the cap scan and an independent whole-tree walk disagree. A narrowed scan (a dropped directory, a ' +
      'dropped file, a changed filter) must fail HERE rather than quietly reporting fewer violations.')
  assert.ok(expected.length >= 20,
    `the independent walk found only ${expected.length} files — the tree, not the gate, has shrunk`)
  assert.deepEqual(scannedDirs.length > 0, true,
    'no sub-directory under src/ was discovered; the scan would be empty by construction')
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
