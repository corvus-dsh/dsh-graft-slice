/**
 * N0c — TRAVERSE ALL PRODUCTION SOURCE, NOT A HAND-WRITTEN LIST.
 *
 * ── WHAT THIS FIXES ────────────────────────────────────────────────────────────────────────────
 *
 * Two shipped guards were scoped to ONE file or to a HARD-CODED list:
 *
 *   v097  counts `openings.length === 1` in `src/index.ts` only.
 *         A second copy of the imperative list pasted into ANY other source file keeps it green —
 *         and that second copy is exactly how the 46.7% truncation happened.
 *   v114  checks four named files for `model-wording.contracts` imports.
 *         Every new module extracted from index.ts is a fifth file nobody checks. The guarantee is
 *         "production does not depend on the metadata module", but the code only said "these four do
 *         not". Scope narrower than the claim — the same defect shape as rule 31.
 *
 * ── WHY ALL OF `src/**` AND NOT THE ARTIFACT ────────────────────────────────────────────────────
 *
 * The ruling's rule: "must exist" assertions may read the artifact OR all of src; "must NOT exist" and
 * "exactly once" assertions MUST traverse all of `src/**`. The reason is concrete and already proven in
 * this repo: `src/core/ignition.ts.bak-cut` EXISTS in src but is NOT inlined into `index.js` (proven by
 * `v125`). Reading only the artifact would therefore miss a duplicate or a forbidden import placed in a
 * file that is not reachable from the entry point.
 *
 * ── WHY THESE HELPERS EXIST INSTEAD OF INLINE LOOPS ────────────────────────────────────────────
 *
 * A traversal written inline in a test tends to grow a filter ("skip *.bak-cut", "skip tests") the first
 * time it fails for an unrelated reason — and that filter is where a real violation then hides. One
 * implementation, one definition of "production source", used by every guard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path to `src/` for this package.
 *
 * `../../` because this helper lives in `test/fixtures/` — one level deeper than `test/`. Getting this
 * wrong fails loudly (`ENOENT ... test/src/`), which is the right failure: a traversal that silently
 * found zero files would make every guard below vacuously green — the exact empty-set failure this
 * project has already been bitten by twice (rule 27).
 */
export const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url))

/**
 * Files that are NOT production code but live under src/.
 *
 * DELIBERATELY EMPTY, and kept as an explicit, visible list rather than an inline condition: the moment
 * someone needs an exclusion, it must appear HERE, in the diff, with a reason — not as a quiet
 * `if (!file.endsWith(...))` inside a loop that a reviewer skims.
 *
 * Note that `ignition.ts.bak-cut` is NOT excluded: it is tracked evidence, and a forbidden import or a
 * duplicated list inside it is still a fact about the tree. Excluding it would recreate the blind spot
 * this file exists to remove.
 */
export const NON_PRODUCTION = []

/**
 * Every production source file under `src/`, as absolute paths, deterministically ordered.
 *
 * ── WHY THE FILTER IS "\`.ts\` ANYWHERE" AND NOT "\`.ts\$" ─────────────────────────────────────────────
 *
 * The first version used `/\.ts$/` and therefore SKIPPED `src/core/ignition.ts.bak-cut` — a file whose
 * name contains `.ts` but does not END in it. That is precisely the blind spot this traversal exists to
 * close: a duplicated list or a forbidden import inside that file would have been invisible, and the
 * guard would report "exactly once" while a second copy sat in the tree.
 *
 * Measured: 18 files matched `/\.ts$/`; 19 match the `.ts`-containing rule (the extra one is the
 * `.bak-cut`). The wider rule is the correct one for a SCAN — it answers "what text exists under src/",
 * not "what would the bundler inline".
 */
export function productionSourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) { walk(full); continue }
      // `.ts` anywhere in the name: covers `x.ts`, `x.ts.bak-cut`, `x.d.ts`.
      if (!/\.ts(?:\.|$)/u.test(entry)) continue
      if (NON_PRODUCTION.includes(entry)) continue
      out.push(full)
    }
  }
  walk(SRC_ROOT)
  return out
}

/** Every production source file, as `{ path, rel, text }`. */
export function productionSources() {
  return productionSourceFiles().map((path) => ({
    path,
    rel: relative(SRC_ROOT, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }))
}

/**
 * Count matches of `pattern` across ALL production source, returning per-file tallies.
 *
 * `pattern` must carry the `g` flag; it is cloned per file so `lastIndex` cannot leak between files
 * (a classic source of "it works on the first file only" bugs).
 */
export function countAcrossSource(pattern) {
  const results = []
  for (const { rel, text } of productionSources()) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const re = new RegExp(pattern.source, flags)
    const matches = [...text.matchAll(re)]
    if (matches.length > 0) results.push({ rel, count: matches.length })
  }
  return results
}

/** Files (relative to src/) whose text matches `pattern`. */
export function sourceFilesMatching(pattern) {
  return countAcrossSource(pattern).map((entry) => entry.rel)
}
