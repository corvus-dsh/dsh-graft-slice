/**
 * v0.9.5 — the export-surface gate must REFUSE and REFUSE TO HEAL.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE GATE'S OWN OUTPUT
 *
 * Two properties matter and neither is visible in a green run:
 *
 *   1. an UNDECLARED surface change must exit 1 (the gate must actually fail);
 *   2. that same run must NOT rewrite `.export-surface.json`.
 *
 * The second is the subtle one. A gate that refreshes the baseline and THEN reports the failure
 * looks correct on the run that caught the problem, and is green on every run after it — the change
 * became the new normal without anyone approving it. That is the "先刷新再报错" failure mode, and it
 * is indistinguishable from success unless you inspect the file.
 *
 * Both properties are asserted against a THROWAWAY copy of the repository, so the real baseline is
 * never at risk — and so the test can corrupt a baseline on purpose.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SURFACE = '.export-surface.json'

/**
 * Copy the repo without the parts that are irrelevant to packaging checks.
 *
 * `package.json.files` promises `src/index.ts`, `locale/*.json`, `icon.svg`, `RELEASE_NOTES.md`,
 * `ANALYSIS-BRIEF.md` and `ARCHITECTURE.md` — and `verify-bundle` has a check for that. Omitting them
 * makes an UNRELATED check fail and buries the one under test (measured: the first draft of this
 * helper did exactly that and every case reported 27/28).
 */
function cloneRepo() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-surface-'))
  cpSync(REPO, root, {
    recursive: true,
    filter: (src) => {
      const rel = src.replace(/\\/gu, '/').slice(REPO.length + 1)
      if (rel === '') return true
      if (/^(\.git|node_modules|test|test-concurrency)(\/|$)/u.test(rel)) return false
      if (/^\.(retired|transferred|graft-targets|graft-prepared)\.json$/u.test(rel)) return false
      if (/^(\.txn|\.graft-audit\.jsonl)(\/|$)/u.test(rel)) return false
      return true
    },
  })
  return root
}

function runGate(root, commitMessage = '') {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/verify-bundle.mjs'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: { ...process.env, GRAFT_COMMIT_MESSAGE: commitMessage },
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Drop one export from the recorded baseline, simulating "the bundle gained a name". */
function desyncBaseline(root) {
  const path = join(root, SURFACE)
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  const dropped = baseline.exports[0]
  baseline.exports = baseline.exports.filter((name) => name !== dropped)
  baseline.count = baseline.exports.length
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  return { path, dropped }
}

test('v0.9.5: an undeclared surface change exits 1 AND leaves the baseline untouched', () => {
  const root = cloneRepo()
  const { path, dropped } = desyncBaseline(root)
  const before = readFileSync(path, 'utf8')

  const { code, out } = runGate(root)

  assert.equal(code, 1, `an undeclared change must fail; output:\n${out}`)
  assert.match(out, /export surface/u)
  assert.match(out, new RegExp(dropped.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  // THE PROPERTY THAT MATTERS: a refused baseline must not become the new normal.
  assert.equal(
    readFileSync(path, 'utf8'),
    before,
    'the gate rewrote the baseline while refusing it — the next run would look clean',
  )
})

test('v0.9.5: the same change, declared with [export-change], passes and refreshes', () => {
  const root = cloneRepo()
  const { path } = desyncBaseline(root)
  const before = readFileSync(path, 'utf8')

  const { code, out } = runGate(root, 'chore: intentional surface change [export-change]')

  assert.equal(code, 0, `a declared change must pass; output:\n${out}`)
  assert.match(out, /\[declared\]/u)
  // The baseline is refreshed ONLY on the declared path, which is what makes the gate usable.
  assert.notEqual(readFileSync(path, 'utf8'), before, 'a declared change must refresh the baseline')
  const refreshed = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(refreshed.count, refreshed.exports.length)
})

test('v0.9.5: a baseline whose count disagrees with its own list is RED, not silently normalised', () => {
  // The gate reads `exports`. `count` is redundant — so a first version ignored it entirely and a
  // baseline saying count=999 passed with exit 0. An ignored field invites someone to "update the
  // count" and believe they changed the contract.
  const root = cloneRepo()
  const path = join(root, SURFACE)
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  baseline.count = 999
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  const before = readFileSync(path, 'utf8')

  const { code, out } = runGate(root)

  assert.equal(code, 1, `an inconsistent baseline must fail; output:\n${out}`)
  assert.match(out, /baseline is self-consistent/u)
  assert.equal(readFileSync(path, 'utf8'), before, 'a refused baseline must not be repaired by the gate')
})
