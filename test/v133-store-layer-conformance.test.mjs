/**
 * ── v133: DIFFERENTIAL CONFORMANCE — new subsystem vs the FROZEN OLD BEHAVIOUR (S3-P3) ───────────
 *
 * `test/fixtures/store-paths-golden.json` was produced by the OLD implementation before any switch
 * (P2). This file proves the new `core/store-layer.ts` reproduces it — case by case, path by path,
 * including all ELEVEN store locations, not just the directory.
 *
 * ── WHY ELEVEN AND NOT THE SEVEN THE GATE REPORTED ─────────────────────────────────────────────
 *
 * `closure.mjs` names seven module-level `let`s for `recoverGraftTransactions`; `drafts`, `prepared` and
 * `pendingIgnition` are simply outside that closure. But `configureRetiredStore` assigns ELEVEN in one
 * block, and P4 must switch all eleven — keeping three on the plugin directory while the rest move is a
 * half-switched store, which looks done and is not.
 *
 * ── THE FIELD NAMES DIFFER ON PURPOSE, AND THAT IS THE POINT ───────────────────────────────────
 *
 * The golden file uses the OLD variable names (`retiredStorePath`, …); the new layer uses its own
 * (`retired`, …). Mapping them here is an explicit table, so a future rename has to touch this file and
 * cannot silently "conform".
 *
 * ── WHY THIS TEST NEEDS NO REBUILD DESPITE IMPORTING BEHAVIOUR ────────────────────────────────
 *
 * It imports the layer from SOURCE (strip + mirrored emit, same as v132) and reads the golden file from
 * disk. The old implementation is not loaded at all — the golden file IS its recorded output. So the
 * ac72ed6 discipline ("mutate src → rebuild → test") does not apply: nothing here goes through a build.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(REPO, 'src', 'core', 'store-layer.ts')
const GOLDEN = join(REPO, 'test', 'fixtures', 'store-paths-golden.json')

/** Golden field → new-layer field. An explicit table, so a rename breaks HERE rather than silently. */
const FIELD_MAP = {
  retiredStorePath: 'retired',
  transferredStorePath: 'transferred',
  graftTargetsPath: 'graftTargets',
  txnDirPath: 'txnDir',
  constraintSectionsPath: 'constraintSections',
  pendingConstraintsPath: 'pendingConstraints',
  pendingIgnitionPath: 'pendingIgnition',
  draftsPath: 'drafts',
  preparedStorePath: 'prepared',
  leftoversStorePath: 'leftovers',
  autoGraftSuppressedPath: 'autoGraftSuppressed',
}

// Mirrored emit tree (same technique as v132: a lone file breaks the layer's relative import).
const EMIT_ROOT = mkdtempSync(join(tmpdir(), 'dsh-v133-'))
writeFileSync(join(EMIT_ROOT, 'package.json'), '{"type":"module"}\n', 'utf8')
const emit = (sourcePath, relativePath) => {
  const emitted = stripTypeScriptTypes(readFileSync(sourcePath, 'utf8'), { mode: 'strip' })
  const outPath = join(EMIT_ROOT, relativePath)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, emitted, 'utf8')
  for (const match of emitted.matchAll(/from\s+'(\.[^']+)'/gu)) {
    const specifier = match[1]
    if (!specifier.endsWith('.js')) continue
    emit(join(dirname(sourcePath), `${specifier.slice(0, -3)}.ts`), join(dirname(relativePath), specifier))
  }
  return outPath
}
const EMITTED = emit(SOURCE, join('core', 'store-layer.js'))
const layer = await import(pathToFileURL(EMITTED).href)

// The resolver reads the profile env vars; neutralise them once, before any case runs.
const SAVED_ENV = { DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR, DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE }
for (const name of Object.keys(SAVED_ENV)) delete process.env[name]

const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
const freshDir = () => mkdtempSync(join(tmpdir(), 'dsh-v133-dir-'))
const makeCtx = (rawPaths) => ({
  tools: { register: () => () => {} },
  sessions: { get: () => undefined, prepare: () => ({}) },
  sessionQuery: { readSession: async () => ({ session: { id: 'x' } }) },
  get: (name) => (name === 'paths' ? rawPaths : undefined),
  on: () => () => {},
})

/**
 * ── THE FALLBACK CASE CANNOT BE REPRODUCED WITH A TEMP DIRECTORY ────────────────────────────────
 *
 * Six of the seven golden cases name a directory the golden run CREATED and can be recreated here. The
 * seventh (`fallback-plugin-dir`) is the PLUGIN DIRECTORY itself — the package root — which the test
 * cannot move. For that case the assertion is therefore the DIRECTION, not the literal string: the new
 * layer must land on `fallbackDir`, and the value it is given must equal the directory of the built
 * artifact (the value the old code computed from `import.meta.url` before inlining).
 */
const PLUGIN_DIR_OF_BUNDLE = REPO


test('v133: the golden file records ELEVEN paths per case (the gate reported seven)', () => {
  assert.equal(golden.pathCount, 11, 'the golden file must pin all eleven store locations')
  for (const matrixCase of golden.cases) {
    assert.equal(Object.keys(matrixCase.pathSuffixes).length, 11, `${matrixCase.id} must list eleven suffixes`)
    assert.deepEqual(Object.keys(matrixCase.pathSuffixes).sort(), Object.keys(FIELD_MAP).sort(),
      `${matrixCase.id}: the recorded fields and the mapping table must name the same set`)
  }
})

for (const matrixCase of golden.cases) {
  test(`v133: the new layer reproduces the golden case "${matrixCase.id}"`, () => {
    /**
     * Rebuild the same INPUT the golden run used:
     *   `env`             — which DSH_* variables were present (restored in `test.after`);
     *   `hostPaths`       — whether `ctx.get('paths')` yields a data dir;
     *   `configDataDir`   — whether an explicit config.dataDir was supplied.
     * The 4 environment cases added after review are exactly what makes branches 3/4/5 comparable.
     */
    const savedEnv = Object.fromEntries(Object.keys(matrixCase.env).map((key) => [key, process.env[key]]))
    const allKeys = ['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_PROFILE']
    for (const key of allKeys) delete process.env[key]
    for (const [key, value] of Object.entries(matrixCase.env)) process.env[key] = value

    try {
      const hostDir = freshDir()
      const configDir = freshDir()
      const config = {
        ...(matrixCase.configDataDir ? { dataDir: configDir } : {}),
        fallbackDir: PLUGIN_DIR_OF_BUNDLE,
      }
      const built = layer.createStoreLayer(
        makeCtx(matrixCase.hostPaths ? { data: hostDir } : undefined),
        config,
      )

      // Expected directory, by the branch the golden recorded.
      const EXPECTED_DIR = {
        host: hostDir,
        config: configDir,
        'profile-env': join(process.env.DSH_PROFILE_DIR ?? '', 'data', 'dsh-graft-slice'),
        'home-profile': join(process.env.DSH_HOME ?? '', 'profiles', process.env.DSH_PROFILE ?? '', 'data', 'dsh-graft-slice'),
        'home-plugin-data': join(process.env.DSH_HOME ?? '', 'plugin-data', 'data', 'dsh-graft-slice'),
        'plugin-dir': PLUGIN_DIR_OF_BUNDLE,
      }
      const expectedDir = EXPECTED_DIR[matrixCase.resolvedDir]
      assert.equal(built.paths.dir, expectedDir,
        `${matrixCase.id}: expected dir from "${matrixCase.resolvedDir}", got ${built.paths.dir}`)

      // Every one of the ELEVEN paths, by suffix.
      const mismatches = []
      for (const [goldenField, newField] of Object.entries(FIELD_MAP)) {
        const expectedSuffix = matrixCase.pathSuffixes[goldenField]
        const expected = join(expectedDir, expectedSuffix)
        if (built.paths[newField] !== expected) {
          mismatches.push(`${goldenField} → ${newField}: expected ${expected}, got ${built.paths[newField]}`)
        }
      }
      assert.deepEqual(mismatches, [], `${matrixCase.id}: path mismatches against the golden file`)
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

test('v133: all SEVEN branches of the resolver are covered by the golden file', () => {
  /**
   * The first golden file had three cases and covered branches 1-2 only. Branches 3, 4a, 4b and 5 were
   * untested — and branch 5 is the one whose SOURCE changed in the new layer (the plugin directory is
   * now passed in by the caller). Without these cases, a mistake there after P4 changes nothing red.
   */
  const covered = new Set(golden.cases.map((matrixCase) => matrixCase.resolvedDir))
  for (const branch of ['host', 'config', 'profile-env', 'home-profile', 'home-plugin-data', 'plugin-dir']) {
    assert.ok(covered.has(branch), `no golden case covers branch "${branch}"`)
  }
  assert.ok(golden.cases.length >= 7, `expected at least 7 cases, found ${golden.cases.length}`)
})

test('v133 meta: the mapping table covers every field the golden file records', () => {
  const recorded = new Set()
  for (const matrixCase of golden.cases) for (const key of Object.keys(matrixCase.pathSuffixes)) recorded.add(key)
  const unmapped = [...recorded].filter((key) => FIELD_MAP[key] === undefined)
  assert.deepEqual(unmapped, [], 'a golden field with no mapping would be silently uncompared')
})

test.after(() => {
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try { rmSync(EMIT_ROOT, { recursive: true, force: true }) } catch { /* best effort */ }
})
