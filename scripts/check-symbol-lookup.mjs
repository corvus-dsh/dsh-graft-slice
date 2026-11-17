#!/usr/bin/env node
/**
 * ── EXACT IDENTIFIER REFERENCES, NEVER SUBSTRING MATCHES ─────────────────────────────────────────
 *
 * Observed twice: `includes('GraftSource')` also matched `GraftSourceShape` and
 * `pendingGraftSources`, which produced "referenced by 5 core/ modules" — a confident, wrong
 * statement. `who-references.mjs` fixes the classifier; this file runs it on a symbol whose answer is
 * known (`buildTape` has exactly one declaration), so the classifier is exercised on every run.
 *
 * ── WHY THE ASSERTION LIVES HERE INSTEAD OF IN THE WORKFLOW ──────────────────────────────────────
 *
 * It used to be a three-line `node -e` in ci.yml that wrote `/tmp/refs.json` and parsed it. Two
 * problems, both measured:
 *
 *   1. `/tmp` does not exist on Windows, so the step could not be reproduced locally at all;
 *   2. because it lived only in the workflow, `npm run check` never ran it — five CI steps were
 *      unreachable from the developer's command (see `docs/gate-failure-forms.md` ⑯).
 *
 * Also: `who-references.mjs` is an INSTRUMENT (it measures and exits 0). The assertion is what makes
 * the measurement a gate, and that distinction is lost when the assertion hides inside a shell step.
 *
 * Exit: 0 = exactly one DECL for the probe symbol; 1 = anything else (including a parse failure).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
/** The probe: a symbol with exactly one declaration in this repository. */
const PROBE = 'buildTape'

let raw
try {
  raw = execFileSync(process.execPath, ['scripts/who-references.mjs', '--json', PROBE], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
} catch (error) {
  console.error(`::error::who-references.mjs failed for the probe symbol \`${PROBE}\`: ${error.message}`)
  process.exit(1)
}

let refs
try {
  refs = JSON.parse(raw)
} catch (error) {
  console.error(`::error::who-references.mjs --json did not produce JSON (${error.message}).`
    + ' The instrument changed shape and this assertion can no longer read it.')
  process.exit(1)
}

if (!Array.isArray(refs)) {
  console.error('::error::who-references.mjs --json returned a non-array; the assertion below assumes rows')
  process.exit(1)
}

const decl = refs.filter((row) => row.kind === 'DECL')
if (decl.length !== 1) {
  console.error(`::error::expected exactly one DECL for \`${PROBE}\`, got ${decl.length}`)
  for (const row of decl.slice(0, 5)) console.error(`  DECL ${row.file ?? '?'}: ${String(row.line ?? '').slice(0, 120)}`)
  process.exit(1)
}

console.log(`ok: exactly one DECL for \`${PROBE}\` (${refs.length} reference row(s) total)`)