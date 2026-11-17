#!/usr/bin/env node
/**
 * ── THE EXPORT BASELINE MUST ALREADY BE COMMITTED ────────────────────────────────────────────────
 *
 * `.export-surface.json` is a COMMITTED file: it is the reviewed record of the export contract.
 * `verify-bundle.mjs` refreshes it when the surface changes, so a declared change must land in the
 * SAME commit. If CI refreshed it silently, the next clone would inherit a contract nobody reviewed.
 *
 * ── WHY THIS IS A SCRIPT AND NOT FOUR LINES OF SHELL IN ci.yml ───────────────────────────────────
 *
 * The rule was written inline in the workflow (`if [ -n "$(git status --porcelain …)" ]`). Inline
 * shell can only run in the workflow, so the rule was unreachable from `npm run check` — which is
 * what a developer actually runs before committing. Measured 2026-11-17: `npm run check` covered 11
 * of the 16 CI steps, and this was one of the five it could not run at all (see
 * `docs/gate-failure-forms.md` ⑯: a gate wired only into CI has a failure period equal to the gap
 * between two CI runs, and the developer never sees the red).
 *
 * One implementation, two callers (the workflow step and `npm run check`), same argument list.
 *
 * Exit: 0 = the baseline is committed and current; 1 = `verify-bundle.mjs` rewrote it and the new
 * bytes are not in the index.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const BASELINE = '.export-surface.json'

const dirty = execFileSync('git', ['status', '--porcelain', '--', BASELINE], {
  cwd: REPO,
  encoding: 'utf8',
})

if (dirty.trim() === '') {
  console.log(`ok: ${BASELINE} is committed and current`)
  process.exit(0)
}

console.error(`::error::verify-bundle.mjs rewrote ${BASELINE}.`
  + ' Commit the new baseline: it is part of the export contract.')
try {
  console.error(execFileSync('git', ['--no-pager', 'diff', '--', BASELINE], { cwd: REPO, encoding: 'utf8' }))
} catch {
  // A diff that cannot be printed must not hide the failure — the exit code already says it.
}
process.exit(1)