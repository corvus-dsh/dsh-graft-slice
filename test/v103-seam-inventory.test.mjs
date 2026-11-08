/**
 * THE SEAM INVENTORY, LOCKED — and one name that must NOT be treated as a seam.
 *
 * ── WHY A SUBSET LOCK HERE (批次 3 第 1 组, 2026-11-08) ─────────────────────────────────────────
 *
 * `dsh-graft-slice/index.js` exports 185 names. Pinning all of them would be an unreadable list that
 * nobody would maintain, so the rule is PROPORTIONATE AND STATED:
 *
 *   - the FULL surface is pinned where it is small enough to read (dsh-observer: 16, dsh-memory: 31);
 *   - the SEAM-SHAPED subset is pinned where the entry is a monolith (this repo).
 *
 * The property enforced is identical in both cases: a test seam cannot appear by accident, and a
 * production-sounding name given to a test-only export is refused by the convention check below.
 *
 * ── THE EVIDENCE FOR EACH VERDICT (measured 2026-11-08, four repos + scripts + config + docs) ────
 *
 * Ten names below are TEST-ONLY: no reference in this repo's `src/`, no script, no config, no sibling
 * repository. `getTransferredSessions` alone is imported by FOURTEEN test files, which is exactly why
 * it is pinned instead of renamed: the seam is load-bearing for the suite even though it is not API.
 *
 * `scanAgentCommand` is the counter-example that makes this file worth reading. It LOOKS test-only and
 * is NOT: `scripts/check-docs.mjs` imports it and README names it. Removing it as "just a test export"
 * would break the documentation gate. It is recorded here as REFERENCED so the next person does not
 * have to rediscover that.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as entry from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/** Test-only seams (no consumer outside the suite). */
const TEST_ONLY_SEAMS = [
  'clearGraftTargetsForTest',
  'extractGoalForTest',
  'extractWorkspaceState',
  'getGraftTargets',
  'getIgnitionAdmissions',
  'getPendingIgnitions',
  'getRetiredSessions',
  'getTransferredSessions',
  'hasIgnitionAdmission',
  'markIgnitionAdmission',
]

/** Seams with no consumer at all: 批次 3 第 2 组 removes them, and MUST edit this file when it does. */
const DEAD_SEAMS_PENDING_REMOVAL = ['debugLastLockCleanup', 'debugLastRecovery', 'debugStorePaths']

/** Referenced by scripts/docs, NOT by production code — and therefore NOT a seam to fold or delete. */
const REFERENCED_NOT_A_SEAM = ['scanAgentCommand']

const seamShaped = (name) =>
  /ForTest$/u.test(name) || /Internals$/u.test(name) || /^debug/u.test(name) || /CacheStats$/u.test(name) || /^clear[A-Z]/u.test(name) || /^reset[A-Z]/u.test(name) || /^invalidate[A-Z]/u.test(name)

test('every seam-SHAPED export is registered (the convention cannot smuggle one in)', () => {
  const registered = [...TEST_ONLY_SEAMS, ...DEAD_SEAMS_PENDING_REMOVAL, 'resetRetiredSessions', 'resetParadiseWriteCache']
  const unregistered = Object.keys(entry).filter((name) => seamShaped(name) && !registered.includes(name))
  assert.deepEqual(
    unregistered,
    [],
    `unregistered seam-shaped export(s): ${unregistered.join(', ')}. Register them here with their ` +
      'evidence, or fold them into an existing internals object — a seam that arrives unnoticed is ' +
      'the failure this test exists for.',
  )
})

test('every test-only seam is still exported, and still callable', () => {
  for (const name of [...TEST_ONLY_SEAMS, ...DEAD_SEAMS_PENDING_REMOVAL]) {
    assert.equal(typeof entry[name], 'function', `${name} is pinned as a seam but is no longer exported`)
  }
})

test('a REFERENCED name is NOT pinned as a seam — the distinction has to stay real', () => {
  /**
   * This is the assertion that protects the docs gate. If someone "cleans up" by adding
   * `scanAgentCommand` to the seam list above, this fails and points at the real consumers.
   */
  for (const name of REFERENCED_NOT_A_SEAM) {
    assert.equal(
      typeof entry[name],
      'function',
      `${name} must stay exported: scripts/check-docs.mjs imports it and README names it`,
    )
    assert.ok(
      !TEST_ONLY_SEAMS.includes(name),
      `${name} is NOT test-only — see scripts/check-docs.mjs before folding or deleting it`,
    )
  }
})

test('the boundary is DOCUMENTED in the source, and the document names the seams', () => {
  assert.match(source, /THE TEST-SEAM SURFACE/u, 'the boundary block must stay in src/index.ts')
  assert.match(source, /THEY ARE NOT PUBLIC API/u, 'and it must keep saying what these are')
  assert.match(source, /test\/v103-seam-inventory\.test\.mjs/u, 'and point at this file')
  assert.match(
    source,
    /scanAgentCommand.*NOT ONE OF THEM|IS NOT ONE OF THEM/u,
    'the docs-gate counter-example must stay recorded: it is the reason this file is not just a list',
  )
  for (const name of [...TEST_ONLY_SEAMS, ...DEAD_SEAMS_PENDING_REMOVAL]) {
    assert.ok(source.includes(name), `the boundary block must name ${name}`)
  }
})
