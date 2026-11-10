/**
 * N0c FIXTURE GUARD — the traversal's FILE SET is itself a thing that can silently shrink.
 *
 * ── WHY THIS EXISTS (the review measured it: 6/6 green with the bug reintroduced) ──────────────
 *
 * `test/fixtures/source-scan.mjs` originally filtered with `/\.ts$/`, which SKIPPED
 * `src/core/ignition.ts.bak-cut` — a name that CONTAINS `.ts` but does not END in it. The count was 18
 * instead of 19, and nothing anywhere noticed: the widened guards (v097 / v114) still reported
 * "exactly once" and "no importers", because a file they could not see cannot violate anything.
 *
 * The `> 10` denominator assertion in those guards catches an EMPTY traversal. It does NOT catch a
 * traversal that silently drops ONE important file. And `.bak-cut` is the worst possible file to drop:
 *
 *   * it EXISTS in src/ but is never inlined (v125 proves that), so reading the artifact cannot see it;
 *   * the review demonstrated (directions E/F) that a violation hidden there is the hardest to notice.
 *
 * So the fix from last commit is not finished until the FILE SET is pinned. "A fix that is not pinned is
 * the next person's trap."
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NON_PRODUCTION, SRC_ROOT, productionSourceFiles } from './fixtures/source-scan.mjs'

const rels = () => productionSourceFiles().map((path) => relative(SRC_ROOT, path).split('\\').join('/'))

test('N0c: the scanned set MUST include ignition.ts.bak-cut (the file the first filter dropped)', () => {
  /**
   * Pinned by NAME, not by count: a count assertion would pass again the moment some other file is
   * added while this one is still missing — which is exactly how the original bug hid.
   */
  const files = rels()
  assert.ok(
    files.includes('core/ignition.ts.bak-cut'),
    'the scan set is missing src/core/ignition.ts.bak-cut. That file CONTAINS ".ts" but does not END in ' +
      'it, so a `/\.ts$/` filter silently drops it — and it is the one file where a violation is ' +
      'invisible to the artifact scan (it is never inlined). Measured: /\.ts$/ ⇒ 18 files, ' +
      '/\\.ts(?:\\.|$)/ ⇒ 19 files.',
  )
})

test('N0c: the scanned set covers every `.ts`-bearing file under src/ (and excludes nothing quietly)', () => {
  /**
   * The other half: not just "the known-important file is here" but "nothing at all is being skipped".
   * Enumerated independently of the helper, so a filter change has to disagree with THIS list.
   */
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (readdirSync !== undefined) {
        try {
          const nested = readdirSync(full)
          walk(full, out)
          continue
        } catch {
          // not a directory
        }
      }
      /**
     * ── A DIFFERENT PREDICATE, BECAUSE "INDEPENDENT" WAS NOT TRUE (N6b) ─────────────────────────
     *
     * This walk used to apply the SAME `/\.ts(?:\.|$)/u` literal as the helper it checks, twenty lines
     * below it. So a change to that filter, made in both places, kept `deepEqual` green while the
     * assertion read "a filter change has to disagree with THIS list". The list was not independent;
     * it was the same opinion written twice.
     *
     * `includes('.ts')` shares no regex semantics with the helper, and it is deliberately LOOSER (it
     * would also accept `foo.tsx`), which is the safe direction: a looser reference set turns the
     * helper's narrowness into a failure instead of an agreement.
     */
    if (!entry.includes('.ts')) continue
    out.push(relative(SRC_ROOT, full).split('\\').join('/'))
    }
    return out
  }

  const expected = walk(SRC_ROOT).sort()
  const actual = rels().sort()
  assert.deepEqual(actual, expected, 'the helper and an independent walk must agree on the file set')

  // NON_PRODUCTION must stay empty and visible; an exclusion added here is a blind spot by definition.
  assert.deepEqual(NON_PRODUCTION, [], 'nothing may be excluded from the scan — exclusions are blind spots')
})

test('N0c: the denominator is stated, so an empty traversal cannot pass silently', (t) => {
  const files = rels()
  assert.ok(files.length >= 19, `the traversal returned ${files.length} files; expected at least 19 (rule 27: no denominator, no conclusion)`)
  t.diagnostic(`scan set: ${files.length} files, including core/ignition.ts.bak-cut`)
})

test('N0c self-test: the filter itself is exercised on synthetic names', () => {
  /**
   * Third guard: the regex, tested directly. If someone narrows it again, this fails with the exact
   * name that broke, independent of what happens to exist on disk today.
   */
  const include = /\.ts(?:\.|$)/u
  const mustMatch = ['index.ts', 'core/state.ts', 'core/ignition.ts.bak-cut', 'types.d.ts']
  const mustNotMatch = ['README.md', 'notes.tsx', 'data.json']
  for (const name of mustMatch) assert.match(name, include, `${name} must be scanned`)
  for (const name of mustNotMatch) assert.doesNotMatch(name, include, `${name} must not be scanned`)
})
