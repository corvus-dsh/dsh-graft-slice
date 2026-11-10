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
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'

const SOURCE = 'D:/持久层能力架构/dsh-graft-slice/src/core/store-layer.ts'
const OUT_DIR = mkdtempSync(join(tmpdir(), 'dsh-store-layer-'))
const OUT_FILE = join(OUT_DIR, 'store-layer.mjs')

/**
 * Load the layer from source once. `mode: 'strip'` is what the build uses; the module's only type
 * import is `import type`, which stripping removes — so the emitted file has no imports beyond
 * `node:path`, exactly as in the bundle.
 */
const layer = await (async () => {
  const source = readFileSync(SOURCE, 'utf8')
  const emitted = stripTypeScriptTypes(source, { mode: 'strip' })
  writeFileSync(OUT_FILE, emitted, 'utf8')
  return import(pathToFileURL(OUT_FILE).href)
})()

const freshDir = () => mkdtempSync(join(tmpdir(), 'dsh-store-dir-'))
const makeCtx = (dataDir) => ({
  tools: { register: () => () => {} },
  sessions: { get: () => undefined, prepare: () => ({}) },
  sessionQuery: { readSession: async () => ({ session: { id: 'x' } }) },
  get: (name) => (name === 'paths' ? { data: dataDir } : undefined),
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

// Cleanup: the temporary emitted module, not the fixture directories (they are per-test temp dirs).
test.after(() => {
  try { rmSync(OUT_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
})
