/**
 * ── v132: THE STORE LAYER IN ISOLATION (S3-P1) ───────────────────────────────────────────────────
 *
 * `src/core/store-layer.ts` is deliberately NOT wired into `index.ts` yet. That makes it testable only
 * by loading the module itself — and it is TypeScript, so this file strips the types with the same
 * Node API the build uses (`stripTypeScriptTypes`, `mode: 'strip'`), writes a temporary `.mjs`, and
 * imports THAT. No bundling, no index.js, no host.
 *
 * The five cases are the ones the layer must get right BEFORE anything switches to it:
 *
 *   ① no `config.dataDir`      → the host's `ctx.paths.data` decides
 *   ② explicit `config.dataDir` → WINS over the host path (the priority is a behaviour, not a detail)
 *   ③ two applications with different inputs → each gets its OWN directory (no caching)
 *   ④ identical inputs          → identical paths (stability, not just "a directory exists")
 *   ⑤ two profiles alternating  → neither writes into / inherits the other's directory
 *
 * ⑤ is the isolation guarantee the old resolver's docblock says it exists to protect: `retired` decides
 * which sessions a pre-step gate refuses, so one profile reading another's file blocks a real session.
 *
 * ── NO REBUILD NEEDED HERE (and why that is not a loophole) ─────────────────────────────────────
 *
 * The can-red discipline in ARCHITECTURE ("mutate src → rebuild → test") exists because tests that
 * import `../index.js` run against a BUILD. This file imports the module's source directly, so a source
 * mutation is visible immediately — the same reason v127/v130 are exempt. The exemption is stated here
 * so nobody later "fixes" this test by routing it through a build that does not contain the module.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

/**
 * ── RESOLVE THE MODULE RELATIVE TO THIS FILE, NEVER BY ABSOLUTE PATH ─────────────────────────────
 *
 * The first version hard-coded `D:/持久层能力架构/dsh-graft-slice/src/core/store-layer.ts`. It passed
 * locally and **failed on CI** with
 *
 *     ENOENT: no such file or directory, open 'D:/鎸佷箙灞傝兘鍔涙灦鏋?dsh-graft-slice/src/core/store-layer.ts'
 *
 * — the checkout lives at `/home/runner/work/dsh-graft-slice/dsh-graft-slice`, and the Chinese path
 * was also mangled by the log encoding. A test that only works on the author's disk is not a test.
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(REPO, 'src', 'core', 'store-layer.ts')

/**
 * ── EMIT A MIRRORED TREE, NOT A LONE FILE (this took two failed attempts) ───────────────────────
 *
 * `store-layer.ts` has TWO runtime imports that survive type stripping:
 *
 *     import { join } from 'node:path'
 *     import { isRecord } from '../utils/serialize.js'
 *
 * The first attempt wrote the stripped module into `os.tmpdir()`, so `../utils/serialize.js` resolved
 * to `%TEMP%/utils/serialize.js` → ERR_MODULE_NOT_FOUND. The second wrote it into `src/core/`, where
 * the path is right but the SOURCE TREE CONTAINS `.ts`, NOT `.js` → still ERR_MODULE_NOT_FOUND:
 *
 *     Cannot find module '…/src/utils/serialize.js'
 *
 * So the only correct approach is to MIRROR the real graph: every `.ts` the emitted module reaches at
 * runtime is stripped into a parallel tree under a temp root that has `{"type":"module"}`, preserving
 * relative paths. `utils/serialize.ts` has zero imports (measured), so the walk stops there.
 */
const EMIT_ROOT = mkdtempSync(join(tmpdir(), 'dsh-store-layer-'))
writeFileSync(join(EMIT_ROOT, 'package.json'), '{"type":"module"}\n', 'utf8')

const emit = (sourcePath, relativePath) => {
  const text = readFileSync(sourcePath, 'utf8')
  const emitted = stripTypeScriptTypes(text, { mode: 'strip' })
  const outPath = join(EMIT_ROOT, relativePath)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, emitted, 'utf8')

  // Recurse over RELATIVE runtime specifiers only (`node:` ones are left to the runtime).
  for (const match of emitted.matchAll(/from\s+'(\.[^']+)'/gu)) {
    const specifier = match[1]
    if (!specifier.endsWith('.js')) continue
    const targetRelative = join(dirname(relativePath), specifier)
    const targetSource = join(dirname(sourcePath), `${specifier.slice(0, -'.js'.length)}.ts`)
    emit(targetSource, targetRelative)
  }
  return outPath
}

const EMITTED = emit(SOURCE, join('core', 'store-layer.js'))

/**
 * ── THE ENVIRONMENT IS AN INPUT, SO NEUTRALISE IT ONCE, UP FRONT ───────────────────────────────
 *
 * `resolveStoreDir` reads `DSH_PROFILE_DIR` / `DSH_HOME` / `DSH_PROFILE`. Those are SET on developer
 * machines (measured: `DSH_PROFILE_DIR` is present here), so any assertion about the fallback or about
 * "the array must not be taken" depends on the ambient shell unless they are cleared.
 *
 * This has to happen BEFORE the tests run and stay cleared, not inside one test: a `delete` performed
 * after the module loads is still visible to later calls, but doing it per-test made the ordering
 * fragile — measured: the control case failed because a previous test's `finally` had restored them.
 */
const SAVED_ENV = {
  DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
  DSH_HOME: process.env.DSH_HOME,
  DSH_PROFILE: process.env.DSH_PROFILE,
}
for (const name of Object.keys(SAVED_ENV)) delete process.env[name]

/**
 * Import the mirrored tree. `stripTypeScriptTypes(mode:'strip')` is the same call the build makes, so
 * what loads here is the same code the bundle will contain (minus inlining).
 */
const layer = await import(pathToFileURL(EMITTED).href)

const freshDir = () => mkdtempSync(join(tmpdir(), 'dsh-store-dir-'))
const makeCtx = (dataDir) => ({
  tools: { register: () => () => {} },
  sessions: { get: () => undefined, prepare: () => ({}) },
  sessionQuery: { readSession: async () => ({ session: { id: 'x' } }) },
  get: (name) => (name === 'paths' ? { data: dataDir } : undefined),
  on: () => () => {},
})

/**
 * A context whose `ctx.get('paths')` returns EXACTLY what is passed — no `{ data: … }` wrapping.
 *
 * Needed by test ⑦, and the first draft got this wrong: it called `makeCtx({ data: hostDir })`, which
 * wraps again into `{ data: { data: hostDir } }` — a record whose `.data` is not a string, so the
 * resolver fell through and the control case failed for a reason that had nothing to do with arrays.
 * A test helper that silently changes the shape it is asked to provide is the same class of defect as
 * everything else in this project's "instrument ≠ reality" list.
 */
const makeCtxWithRawPaths = (rawPaths) => ({
  tools: { register: () => () => {} },
  sessions: { get: () => undefined, prepare: () => ({}) },
  sessionQuery: { readSession: async () => ({ session: { id: 'x' } }) },
  get: (name) => (name === 'paths' ? rawPaths : undefined),
  on: () => () => {},
})

test('v132 ①: without config.dataDir the host path decides', () => {
  const hostDir = freshDir()
  const built = layer.createStoreLayer(makeCtx(hostDir), { fallbackDir: freshDir() })
  assert.equal(built.paths.dir, hostDir, 'the layer must read ctx.paths.data when no explicit dataDir is given')
  assert.equal(built.paths.scope, 'paths.data')
})

test('v132 ②: an explicit config.dataDir WINS over the host path', () => {
  const hostDir = freshDir()
  const configDir = freshDir()
  const built = layer.createStoreLayer(makeCtx(hostDir), { dataDir: configDir, fallbackDir: freshDir() })
  assert.equal(built.paths.dir, configDir, 'config.dataDir must win — flipping this moves every profile\'s stores')
  assert.equal(built.paths.scope, 'config.dataDir')
})

test('v132 ③: two applications with different inputs get DIFFERENT directories (no caching)', () => {
  const first = freshDir()
  const second = freshDir()
  const a = layer.createStoreLayer(makeCtx(first), { fallbackDir: freshDir() })
  const b = layer.createStoreLayer(makeCtx(second), { fallbackDir: freshDir() })
  assert.equal(a.paths.dir, first)
  assert.equal(b.paths.dir, second, 'a module-level cache would hand the second profile the first directory')
})

test('v132 ④: identical inputs produce identical paths (stability, not just existence)', () => {
  const hostDir = freshDir()
  const fallbackDir = freshDir()
  const a = layer.createStoreLayer(makeCtx(hostDir), { fallbackDir })
  const b = layer.createStoreLayer(makeCtx(hostDir), { fallbackDir })
  assert.deepEqual(b.paths, a.paths, 'same inputs must resolve to the same path set')
  assert.equal(a.paths.retired, join(hostDir, '.retired.json'))
  assert.equal(a.paths.txnDir, join(hostDir, '.txn'))
})

test('v132 ⑤: two profiles alternating do not inherit each other\'s directory', () => {
  const alpha = freshDir()
  const beta = freshDir()
  const alphaLayer = layer.createStoreLayer(makeCtx(alpha), { fallbackDir: freshDir() })
  const betaLayer = layer.createStoreLayer(makeCtx(beta), { fallbackDir: freshDir() })

  // Alternate the order to catch anything order-dependent (a memo, a memoised env read).
  for (const expected of [alpha, beta, alpha, beta]) {
    const built = expected === alpha ? alphaLayer : betaLayer
    assert.equal(built.paths.dir, expected)
  }
  assert.notEqual(alphaLayer.paths.retired, betaLayer.paths.retired,
    'two profiles must never share a retired store — that file decides which sessions are refused')
})

test('v132: the layer is FROZEN (a path set that can be edited is not a constant)', () => {
  const built = layer.createStoreLayer(makeCtx(freshDir()), { fallbackDir: freshDir() })
  assert.equal(Object.isFrozen(built), true, 'the layer itself must be frozen')
  assert.equal(Object.isFrozen(built.paths), true, 'the path set must be frozen')
  assert.throws(() => { 'use strict'; built.paths.dir = 'elsewhere' }, TypeError,
    'assigning to a frozen path set must throw in strict mode')
})

test('v132 ⑦: an ARRAY from the host does not count as a record (isRecord semantics)', () => {
  /**
   * ── FOUND BY READING THE OLD BRANCH, NOT BY A FAILING TEST ──────────────────────────────────────
   *
   * The first version tested `paths !== null && typeof paths === 'object'`, which accepts an array.
   * The implementation this will be diffed against uses `isRecord`:
   *
   *     typeof value === 'object' && value !== null && !Array.isArray(value)
   *
   * Arrays CAN carry a `.data` property, so the loose test would take `paths.data` where the old code
   * falls through. That is a divergence on exactly the input that decides which sessions a pre-step
   * gate refuses — so it is asserted here even though the old code makes it unreachable today.
   *
   * ── WHY THIS ASSERTS `scope` AND NOT THE RESULTING DIRECTORY ─────────────────────────────────
   *
   * The first draft also asserted `paths.dir === fallbackDir`. It failed — because the machine running
   * the tests has `DSH_PROFILE_DIR` / `DSH_HOME` set, and branches 3/4 legitimately win over the
   * fallback. The claim being tested is "an array is not a record", and `scope` states it exactly,
   * without making the test depend on the ambient environment.
   */
  const hostDir = freshDir()
  const arrayWithData = Object.assign([], { data: hostDir })

  // `SAVED_ENV` was neutralised once at the top of this file, so both halves are environment-independent.
  // (Doing it per-test was fragile: a previous test's restore put the variables back.)
  const recordLayer = layer.createStoreLayer(makeCtxWithRawPaths({ data: hostDir }), { fallbackDir: freshDir() })
  assert.equal(recordLayer.paths.scope, 'paths.data', 'a real record IS taken')
  assert.equal(recordLayer.paths.dir, hostDir)

  const arrayLayer = layer.createStoreLayer(makeCtxWithRawPaths(arrayWithData), { fallbackDir: freshDir() })
  assert.notEqual(arrayLayer.paths.scope, 'paths.data',
    'an ARRAY is not a record — it must fall through instead of reading paths.data')
  assert.notEqual(arrayLayer.paths.dir, hostDir)
})
