/**
 * ── v134: THE GOLDEN FILE IS PROTECTED BY A MACHINE, NOT BY A SENTENCE (S3-P5) ────────────────────
 *
 * `ARCHITECTURE` says the golden file is ORACLE_ONLY and "must not be deleted". Measured: NOTHING
 * enforced that. Deleting `test/fixtures/store-paths-golden.json` left 741 tests green — v133 would
 * simply throw `ENOENT` at import time and, depending on the runner, that reads as a broken harness
 * rather than as "a protected artifact disappeared".
 *
 * This is the same story as "每个模块 ≤ 800 行": prose that nobody executes is not a constraint until it
 * becomes a gate. So this file is deliberately SMALL and has no dependency on v133: it checks the
 * artifact's own shape, and it reports a MISSING FILE as a named failure ("ORACLE MISSING") instead of
 * letting an ENOENT propagate.
 *
 * Deliberately NOT registered in `test/v103-seam-inventory.test.mjs`: that file models exported API
 * seams (functions), and a data fixture is not one. Putting it there would have been the wrong shape.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GOLDEN = join(REPO, 'test', 'fixtures', 'store-paths-golden.json')

/** 40 hex characters — the same shape git produces, so a placeholder cannot pass. */
const SHA40 = /^[0-9a-f]{40}$/u

test('v134 ①: the golden oracle EXISTS (a missing oracle is a named failure, not an ENOENT crash)', () => {
  /**
   * `assert.ok` with a NAMED message is the point: if this file is deleted, the failure must say
   * "ORACLE MISSING" and name the path, so the next reader knows a protected artifact went away rather
   * than assuming the test harness is broken.
   */
  assert.ok(
    existsSync(GOLDEN),
    `ORACLE MISSING — ${GOLDEN} does not exist. It is ORACLE_ONLY: it is the only artifact that proves ` +
      'the eleven store paths still match the pre-P4 behaviour. Restore it from git, or regenerate it with ' +
      '`node ../_scratch/p2b-golden.mjs` (never edit it by hand).',
  )
})

test('v134 ②: the oracle pins ELEVEN paths and at least SEVEN branch cases', () => {
  assert.ok(existsSync(GOLDEN), 'ORACLE MISSING — see v134 ①')
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))

  assert.equal(golden.pathCount, 11,
    `the oracle must pin eleven store locations (found pathCount=${golden.pathCount}). The closure gate ` +
      'reports seven; the old implementation assigned eleven, and a half-switched store is worse than ' +
      'an unswitched one.')

  assert.ok(Array.isArray(golden.cases), 'cases must be an array')
  assert.ok(golden.cases.length >= 7,
    `expected at least 7 branch cases, found ${golden.cases.length}. Seven cover all five resolver ` +
      'branches (config.dataDir, ctx.paths.data, DSH_PROFILE_DIR, DSH_HOME±profile, plugin-dir fallback).')
})

test('v134 ③: every case lists EXACTLY the eleven path suffixes', () => {
  assert.ok(existsSync(GOLDEN), 'ORACLE MISSING — see v134 ①')
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))

  const wrong = []
  for (const matrixCase of golden.cases) {
    const keys = matrixCase.pathSuffixes === undefined ? [] : Object.keys(matrixCase.pathSuffixes)
    if (keys.length !== 11) wrong.push(`${matrixCase.id}: ${keys.length} suffixes`)
  }
  assert.deepEqual(wrong, [],
    'every case must record all eleven suffixes — a case with fewer silently stops comparing those paths')

  // And the case ids must be unique: a duplicated id would make v133 compare the same case twice.
  const ids = golden.cases.map((matrixCase) => matrixCase.id)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  assert.deepEqual(duplicates, [], 'case ids must be unique')
})

test('v134 ④: the oracle records WHICH COMMIT produced it (40-hex sha, not a placeholder)', () => {
  assert.ok(existsSync(GOLDEN), 'ORACLE MISSING — see v134 ①')
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))

  assert.equal(typeof golden.sourceCommit, 'string', 'sourceCommit must be a string')
  assert.match(golden.sourceCommit, SHA40,
    `sourceCommit must be a 40-character hex sha (found "${golden.sourceCommit}"). Without it, a golden ` +
      'file cannot be traced to the code that produced it — "regenerate from the old implementation" ' +
      'becomes unfalsifiable.')
})

test('v134 ⑤: the two evidence strengths stay DISTINGUISHED (observation vs transcription)', () => {
  /**
   * `dir`/`resolvedDir` were OBSERVED (apply() writes `.layout.json`); `pathSuffixes` were TRANSCRIBED
   * from src/index.ts. Collapsing that distinction is how "the constants match the code" gets read as
   * "the old implementation was observed to behave this way". The comment must keep saying so.
   */
  assert.ok(existsSync(GOLDEN), 'ORACLE MISSING — see v134 ①')
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  const comment = Array.isArray(golden.$comment) ? golden.$comment.join('\n') : ''

  assert.match(comment, /BLACK-BOX OBSERVED|black-box/iu,
    'the oracle must state which half is observed behaviour')
  assert.match(comment, /TRANSCRIBED FROM SOURCE|transcribed/iu,
    'the oracle must state which half is transcribed from source, not observed')
  assert.match(comment, /ELEVEN|11/iu, 'the comment must state eleven paths, not "ten"')
})
