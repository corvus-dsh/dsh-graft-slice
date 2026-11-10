/**
 * N0b — THE HISTORICAL EVIDENCE FILE MUST NOT BE SWEPT AWAY BY A CLEANUP.
 *
 * ── WHAT THIS FILE IS, AND WHY IT NEEDS A GUARD ────────────────────────────────────────────────
 *
 * `src/core/ignition.ts.bak-cut` is a 31 KB backup taken before the v7.6 cut. It is tracked by git and
 * NOT ignored — and, critically, it is NOT in the packaging closure (`orderModules` only inlines files
 * reachable from `index.ts`), so it never ships. It is not code.
 *
 * It is EVIDENCE. Two reports cite it to prove that a `turn: 0` / `step: 0` bug in the ignition path
 * EXISTED BEFORE a particular edit:
 *
 *   REPORT-v7.7-paradise.md:272
 *     "| `src/core/ignition.ts.bak-cut`（v7.6 切割前的基线备份，2026-11-05 22:35）第 605–606 行
 *      已有 `turn: 0` / `step: 0` | 早于我本轮的第一次编辑（23:59） |"
 *   REPORT-v0.36-independence-bootstrap.md:219
 *     "4. 没改 ignition.ts.bak-cut —— 一个 31 KB 的备份残留，不在打包闭包里（`orderModules` 只内联从
 *      `index.ts` 可达的文件）。它是历史证据，不是代码。"
 *
 * Until this file existed, NOTHING guarded it. Any "tidy up stray files" pass — a `git clean`, a repo
 * sweep, an over-eager formatter — would delete it, and both reports would become dangling references
 * to a file that no longer exists. The reports would still be readable; their PROOF would be gone.
 *
 * ── WHY THE ASSERTION IS SHAPED THIS WAY ───────────────────────────────────────────────────────
 *
 * "The file exists" alone is too weak: a rewrite that truncates it would keep the test green while
 * destroying the evidence. So the two lines the reports actually cite are pinned BY CONTENT — if the
 * bug lines are removed or altered, the report's claim no longer refers to anything, and this test says
 * so rather than silently agreeing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BAK = fileURLToPath(new URL('../src/core/ignition.ts.bak-cut', import.meta.url))

test('N0b: the historical evidence file exists, is tracked-sized, and still contains the cited bug lines', () => {
  /**
   * ── DO NOT DELETE THIS FILE, AND DO NOT "CLEAN IT UP" ──────────────────────────────────────────
   *
   * If a future cleanup wants this file gone, it must ALSO update the two reports above, because they
   * cite its line numbers as proof. Deleting the file alone turns two reports into unfalsifiable
   * assertions — which is the exact failure mode this guard prevents.
   */
  assert.equal(
    existsSync(BAK),
    true,
    'src/core/ignition.ts.bak-cut is HISTORICAL EVIDENCE cited by REPORT-v7.7-paradise.md:272 and ' +
      'REPORT-v0.36-independence-bootstrap.md:219. Do not delete it in a cleanup — update those two ' +
      'reports first, in the same commit.',
  )

  // Size guard: a truncating rewrite keeps "exists" true while destroying the evidence.
  const size = statSync(BAK).size
  assert.ok(
    size > 20_000,
    `the evidence file is only ${size} bytes; it is expected to be ~31 KB. A truncation has occurred, ` +
      'and the line numbers cited by the two reports no longer mean what they say.',
  )

  const text = readFileSync(BAK, 'utf8')

  /**
   * The two lines the reports actually cite. Pinned by CONTENT, not by line number: a line number in a
   * test would rot the moment anything is inserted above it (the very lesson of rule 22 / rule 28 —
   * and `git blame` is the right tool for line numbers, not a test).
   */
  assert.match(
    text,
    /^\s*turn: 0,\s*$/mu,
    'the cited `turn: 0` line is gone — REPORT-v7.7-paradise.md:272 cites it as the pre-existing bug',
  )
  assert.match(
    text,
    /^\s*step: 0,\s*$/mu,
    'the cited `step: 0` line is gone — the same report cites it alongside `turn: 0`',
  )

  // The two must be ADJACENT, because the reports cite "第 605–606 行" as a PAIR.
  assert.match(
    text,
    /^\s*turn: 0,\s*\n\s*step: 0,\s*$/mu,
    'the `turn: 0` / `step: 0` PAIR is no longer adjacent; the reports cite lines 605-606 as one fact',
  )
})

test('N0b: the evidence file is NOT in the packaging closure (it must never ship)', (t) => {
  /**
   * The other half of the report's claim: "不在打包闭包里（`orderModules` 只内联从 `index.ts` 可达的文件）".
   * If this file ever became reachable from `index.ts`, it would be inlined into the published bundle —
   * a 31 KB backup of stale code shipped to users.
   *
   * `v114-bundle-no-local-data` guards the artifact against leaking local data; this guards the
   * SOURCE GRAPH, which is the earlier and cheaper place to catch it.
   */
  const bundle = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(
    bundle,
    /bak-cut/u,
    'the backup file reached the shipped bundle — it must stay outside the closure from src/index.ts',
  )

  const header = bundle.split('\n')[1] ?? ''
  assert.doesNotMatch(header, /bak-cut/u, `the inlined-module list names the backup: ${header.slice(0, 120)}`)
  t.diagnostic('backup file is absent from the artifact and from the inlined-module header')
})
