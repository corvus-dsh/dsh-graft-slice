/**
 * ── THE ONE COMPILER LOADER ────────────────────────────────────────────────────────────────────
 *
 * `closure.mjs` had the resolver and it was the only one. `index-ratchet.mjs` had none — it measured
 * function spans by counting braces, so the same unit got two different sizes depending on which tool
 * you asked (measured: `buildInjectionPlan` = 39 lines by braces, 931 by the compiler; `autoGraftIfNeeded`
 * = 24 vs 229; 14 units off by more than three lines). Two rulers for one thing is the defect this
 * whole batch keeps re-finding, and the fix is not "make the second ruler better" — it is **one ruler**.
 *
 * So the loader lives here and both scripts import it. Nothing else may `import('typescript')`:
 * `v348` refuses a second resolver, because the moment there are two, they can disagree about whether a
 * compiler exists at all.
 *
 * ── WHY THE PATH IS PRINTED, NOT ASSUMED ───────────────────────────────────────────────────────
 *
 * This package declares no `typescript` dependency (measured: `dependencies` empty, `devDependencies`
 * has it). `import('typescript')` resolves UPWARDS — on this machine to `D:/持久层能力架构/node_modules`,
 * i.e. the workspace root. A fresh clone with no workspace install finds nothing. A number like "181" is
 * only reproducible if the reader can see WHICH compiler produced it, so every caller prints the version
 * and the resolved path.
 */

let cached

/** The compiler module, or `undefined` when this machine has none. Cached: resolution is not free. */
export async function loadTypeScript () {
  if (cached !== undefined) return cached.ts
  cached = { ts: undefined, path: undefined, version: undefined }
  for (const name of ['typescript', 'typescript/lib/typescript.js']) {
    try {
      const ts = await import(name)
      let path
      try {
        path = import.meta.resolve('typescript')
      } catch {
        path = undefined
      }
      cached = { ts, path, version: ts.version }
      return ts
    } catch {
      /* next */
    }
  }
  return undefined
}

/** `{ ts, path, version }`, all `undefined` when the compiler cannot be found. */
export async function describeTypeScript () {
  const ts = await loadTypeScript()
  if (ts === undefined) return { ts: undefined, path: undefined, version: undefined }
  return { ts, path: cached.path, version: cached.version }
}

/**
 * A line number (1-based) for a source position. `getLineAndCharacterOfPosition` is per-file, so this
 * remembers the file it was created for rather than trusting callers to pass the right one.
 */
export function lineIndex (ts, sourceFile) {
  return (position) => sourceFile.getLineAndCharacterOfPosition(position).line + 1
}
