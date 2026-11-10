#!/usr/bin/env node
/**
 * Fact gate: every number and every "implemented / not implemented" claim in
 * the docs must match the code and the build.
 *
 * Why this exists: README accumulated six generations of hand-written status
 * text, and by v6.3 it still said "75 tests" while 95 were passing, and still
 * listed already-shipped features as unimplemented. Hand-maintained status text
 * drifts silently; a gate makes the drift a red light instead of a reader
 * trap.
 *
 * Exit code 0 = all facts agree. Exit code 1 = at least one claim is false.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { composeBundle } from './bundle.mjs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (name) => readFileSync(join(root, name), 'utf8')

const failures = []
const checks = []
function check(id, ok, detail) {
  checks.push({ id, ok, detail })
  if (!ok) failures.push({ id, detail })
}

const manifest = JSON.parse(read('manifest.json'))
const pkg = JSON.parse(read('package.json'))
const readme = read('README.md')
/**
 * README.en.md is deliberately NOT read by this gate.
 *
 * It is a FROZEN TRANSLATION: `check-readme-counts.mjs` forbids present-tense counts inside it, so any
 * assertion here that demanded today's numbers would fight that rule and leave only one way out —
 * editing a document whose purpose is to stay historical. It is still checked for one thing (no
 * present-tense claim), by that other script, where the rule belongs.
 */
const buildScript = read('scripts/build.mjs')
/**
 * ── `source` IS ALL OF src/, NOT JUST index.ts ────────────────────────────────────────────────────
 *
 * Measured on N2: moving the command policy layer into `core/command-policy.ts` made this gate report
 * **26 facts instead of 27** — the missing one was `docs: command guard documented`, whose marker is
 * `scanAgentCommand(`. The coverage loop is written as
 *
 *     if (!source.includes(marker)) continue
 *
 * so a marker that lives in a DIFFERENT file simply skipped its own check. Nothing failed; a check
 * quietly stopped existing. That is the same defect class as v126's file-set hole and v128's escaped
 * `# SKIP`: an input that shrinks reads as "nothing to report".
 *
 * Two changes, both measured:
 *   1. the scan covers every `.ts`-bearing file under src/ (same filter as the other gates);
 *   2. a marker found NOWHERE is a FAILURE, not a skip — deleting a feature must be a deliberate act
 *      that also removes the README fact, not something that happens by moving a function.
 */
const sourceFiles = (() => {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      let stat
      try { stat = readdirSync(full) } catch { stat = undefined }
      if (stat !== undefined) { walk(full); continue }
      if (/\.ts(?:\.|$)/u.test(entry)) out.push(full)
    }
  }
  walk(join(root, 'src'))
  return out
})()
const source = sourceFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
const built = read('index.js')

// 1. One version, everywhere ------------------------------------------------
check(
  'version: manifest == package.json',
  manifest.version === pkg.version,
  `manifest ${manifest.version} vs package.json ${pkg.version}`,
)
check(
  'version: engines declared in both',
  manifest.engines?.dsh === pkg.engines?.dsh && manifest.engines?.node === pkg.engines?.node,
  `manifest ${JSON.stringify(manifest.engines)} vs package.json ${JSON.stringify(pkg.engines)}`,
)

// 2. The shipped runtime is the current source ------------------------------
// A stale index.js has already happened once: the plugin loaded fine, so the
// only visible symptom was behaviour that matched no source line.
// v1.3: the composition moved into scripts/bundle.mjs (shared with build.mjs), so this
// gate must compare against THAT, not against a second inline copy.
const { output: expected, modules: inlinedModules } = composeBundle(root)
check(
  'build: bundle builder is the single source of truth',
  buildScript.includes('composeBundle'),
  buildScript.includes('composeBundle') ? 'build.mjs imports composeBundle' : 'build.mjs composes the bundle itself again',
)
check(
  'build: index.js is exactly composeBundle(src/)',
  built === expected,
  built === expected
    ? `${Buffer.byteLength(built)} bytes, byte-identical, ${inlinedModules.length} inlined module(s)`
    : `index.js ${Buffer.byteLength(built)} bytes vs expected ${Buffer.byteLength(expected)} bytes (run: node scripts/build.mjs)`,
)

// 3. Declared tools are the registered tools --------------------------------
const declaredTools = [...(manifest.tools ?? [])].sort()
const registeredTools = [...new Set([...source.matchAll(/name: '(graft_[a-z_]+)'/gu)].map((m) => m[1]))].sort()
check(
  'manifest.tools == tools registered in src',
  JSON.stringify(declaredTools) === JSON.stringify(registeredTools),
  `manifest [${declaredTools}] vs src [${registeredTools}]`,
)

// 4. Every test-count claim equals the real count ---------------------------
function actualTestCount() {
  const files = readdirSync(join(root, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => join('test', name))
  const list = execFileSync('node', ['--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // v1.0.2: the suite's ✔-per-test report crossed execFileSync's default 1 MB cap, so
    // the checker threw ENOBUFS instead of reporting a count. The buffer is the checker's
    // problem, not the suite's.
    maxBuffer: 64 * 1024 * 1024,
  })
  const match = /tests (\d+)/u.exec(list)
  return match === null ? undefined : Number(match[1])
}
const count = actualTestCount()
check(
  'tests: suite reported a count',
  count !== undefined,
  count !== undefined ? `parsed tests ${count}` : 'could not parse "tests N" from node --test output',
)
if (count !== undefined) {
  const claims = []
  /**
   * ── README.en.md IS EXCLUDED, ON PURPOSE (2026-11-09) ──────────────────────────────────────────
   *
   * It used to be scanned here. That put two gates in direct conflict: README.en.md is now a FROZEN
   * TRANSLATION (its header says so, and `check-readme-counts.mjs` FACT 6 forbids present-tense counts
   * in it), while this loop demanded that every "N tests" in it match today's count. The result was a
   * red gate whose only exit was rewriting a document that exists to be historical.
   *
   * A gate must not force edits to a frozen record. The Chinese README is this repository's living
   * document and is fully covered; the English one is a snapshot with its own, narrower rule.
   */
  for (const [name, text] of [
    ['README.md', readme],
  ]) {
    for (const match of text.matchAll(/(\d+)\s*(?:个测试|tests?\b)/gu)) {
      // A dated snapshot section may quote the count of that build; it must
      // say so on the same line, or the number reads as the current one.
      const lineStart = text.lastIndexOf('\n', match.index) + 1
      const lineEnd = text.indexOf('\n', match.index)
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      if (/historical|历史/u.test(line)) continue
      claims.push({ name, value: Number(match[1]), at: match.index })
    }
  }
  const wrong = claims.filter((claim) => claim.value !== count && claim.value > 0)
  check(
    'tests: every documented count == real count',
    wrong.length === 0,
    wrong.length === 0
      ? `${count} tests, ${claims.length} claim(s) agree`
      : `real ${count}; stale claim(s): ${wrong.map((c) => `${c.name}:${c.value}`).join(', ')}`,
  )
}

// 5. No "not implemented" claim for a feature that is implemented ----------
// The check is written as: marker in source => stale sentence must be gone.
const shipped = [
  {
    feature: 'draft capture and takeover',
    marker: 'draftsPath',
    stale: '补丁一（草稿转发）与补丁二（异步约束提取）**尚未实现**',
  },
  {
    feature: 'asynchronous constraint extraction',
    marker: 'pendingConstraintsPath',
    stale: '异步约束提取）**尚未实现**',
  },
  {
    feature: 'code block pointering',
    marker: '[codeblock seq=',
    stale: '超长代码块指针化**尚未实现**',
  },
  {
    feature: 'tool availability downgrade',
    marker: 'describeUnavailableTool(',
    stale: '待补的降级项',
  },
]
for (const item of shipped) {
  const implemented = source.includes(item.marker)
  const claimsMissing = readme.includes(item.stale)
  check(
    `feature: ${item.feature}`,
    !(implemented && claimsMissing),
    implemented && claimsMissing
      ? `README still claims "${item.stale}"`
      : implemented
        ? 'source ships it, README no longer denies it'
        : 'source does not ship it',
  )
}

// 6. Implemented capabilities are at least named in the README --------------
const coverage = [
  ['boundary slicing', 'locateBoundary(', 'locateBoundary'],
  ['cold read-back verification', 'assertColdLog(', 'assertColdLog'],
  ['autoGraft state machine', 'autoGraftStates', 'autoGraft'],
  ['retirement interception', 'retireSource', 'retireSource'],
  ['runtime intent migration', 'extractRuntimeIntent(', 'extractRuntimeIntent'],
  ['safe harbor', 'checkSafeHarbor(', 'Safe Harbor'],
  ['adaptive depth', 'calculateAdaptiveDepth(', '自适应'],
  ['attachment pointers', 'extractAttachmentPointers(', '附件'],
  ['graft_read_result lineRange', 'lineRange', 'lineRange'],
  ['workspace file index', 'extractWorkspaceIndex(', '产物索引'],
  ['tool availability downgrade', 'describeUnavailableTool(', '工具可用性降级'],
  ['workspace red line', 'workspaceRedline(', '红线'],
  ['one-off action filter', 'isOneOffAction(', '一次性动作'],
  ['command guard', 'scanAgentCommand(', '命令'],
  ['lock reclamation', 'scanAndReclaimLocks(', '锁'],
  ['debug panel', 'collectDebugStatus(', '调试面板'],
]
/**
 * ── A MARKER THAT EXISTS NOWHERE IS A FAILURE, NOT A SKIP ────────────────────────────────────────
 *
 * `continue` used to mean "this feature is not shipped, so there is nothing to document". Measured, it
 * also meant "this feature moved to another file and its check silently vanished" (N2, 27 → 26 facts).
 * The two are indistinguishable from the inside, so the direction is now fail-loud: if a marker is
 * absent from ALL of src/, this gate says so and names it. Deleting a feature would then fail here and
 * force the README fact to be removed deliberately — which is the only way it should happen.
 */
for (const [name, marker, keyword] of coverage) {
  if (!source.includes(marker)) {
    check(
      `docs: ${name} documented`,
      false,
      `marker "${marker}" exists in NO file under src/ — either the feature was deleted (then remove ` +
        'this row deliberately) or the scan is looking in the wrong place. Silently skipping it would ' +
        'drop the check, which is how it disappeared when the command policy moved to core/',
    )
    continue
  }
  const documented = readme.includes(keyword)
  check(
    `docs: ${name} documented`,
    documented,
    documented ? `README mentions ${keyword}` : `README never mentions ${keyword}`,
  )
}

/**
 * ── META: A PASS-COUNT FLOOR, BECAUSE "0 FAIL" IS NOT "ALL CHECKS PRESENT" ────────────────────────
 *
 * Measured on N2: this gate reported **26 facts and 0 failures** after the command policy moved out of
 * index.ts. The missing check was not failing — it had stopped existing, because its marker was looked
 * for in one file only. That fix (scan all of src/, missing marker = FAILURE) closed THAT instance, but
 * the same shape can arrive by another route: delete a coverage row, delete a `check(...)` call, or
 * make a loop iterate over nothing. In all of those the output still reads `N facts agree`.
 *
 * A floor is the only assertion that notices a CHECK disappearing rather than a check failing. It is a
 * lower bound on purpose: adding facts is normal, losing one is the failure. `27` is today's measured
 * count (`node scripts/check-docs.mjs`), not a target.
 */
const FACT_FLOOR = 27
if (checks.length < FACT_FLOOR) {
  checks.push({
    id: 'meta: pass-count floor',
    ok: false,
    detail: `only ${checks.length} facts ran; the floor is ${FACT_FLOOR}. A check disappeared — that is ` +
      'not "0 failures", it is a smaller gate. Silence here reads as agreement.',
  })
}

// Report -------------------------------------------------------------------
for (const item of checks) {
  process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.id}  — ${item.detail}\n`)
}
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} false claim(s). Docs and code disagree.\n`)
  process.exit(1)
}
process.stdout.write(`\n${checks.length} facts agree.\n`)
