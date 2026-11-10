/**
 * ── PREREQUISITE EVIDENCE FOR DEPENDENCY INVERSION (v131) ────────────────────────────────────────
 *
 * The first planned inversion is `recoverGraftTransactions`: its closure reads SEVEN module-level
 * `let`s (`retiredStorePath` / `transferredStorePath` / `graftTargetsPath` / `txnDirPath` /
 * `storeCtx` / `leftoversStorePath` / `autoGraftSuppressedPath`), all assigned in one place —
 * `configureRetiredStore(ctx, settings)` (`src/index.ts` L5300..5345) — via
 * `resolveStoreDir(ctx, settings.dataDir)`.
 *
 * Passing those values in as a parameter is ONLY safe if the resolution is:
 *
 *   1. **PRIORITISED the same way it is today** — an explicit `config.dataDir` must beat the host's
 *      `paths.data`, not the other way round (reversing them would silently move every profile's
 *      retirement stores);
 *   2. **RE-COMPUTED on each application**, not cached from the first one (a cached value would make a
 *      second profile write into the first profile's directory — the isolation failure the resolver's
 *      own docblock says it exists to prevent);
 *   3. **STABLE for identical inputs** — applying twice with the same inputs must not drift.
 *
 * If any of these fails, parameterisation WOULD change behaviour, and the inversion is not allowed to
 * start. That is why this file exists before the first line of that change, and why it touches no
 * source and no existing assertion: it observes the ONE thing the resolver is required to guarantee —
 * which directory the plugin stamps at activation (`.layout.json`, written inside it, not in the repo).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const freshDir = () => mkdtempSync(join(tmpdir(), 'dsh-graft-storedir-'))
const layoutOf = (dir) => {
  const path = join(dir, '.layout.json')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

test('v131: with no config.dataDir, the store dir comes from the host (`ctx.paths.data`)', () => {
  /**
   * This is the branch that matters for the inversion: in production nobody sets `config.dataDir`,
   * so the value arrives from the host. If parameterisation only wired the config branch, every
   * profile would fall back to the plugin directory — shared by every profile, exactly what the
   * resolver's docblock forbids.
   */
  const hostDir = freshDir()
  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: hostDir } })
  apply(ctx, {})

  assert.ok(layoutOf(hostDir) !== undefined,
    `expected the plugin to stamp ${hostDir}/.layout.json (host-provided paths.data). ` +
      'If this fails, the resolver did not use ctx.paths.data and the inversion must not wire that branch.')
})

test('v131: an explicit config.dataDir WINS over the host path (priority must not flip)', () => {
  const hostDir = freshDir()
  const configDir = freshDir()
  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: hostDir } })
  apply(ctx, { dataDir: configDir })

  assert.ok(layoutOf(configDir) !== undefined,
    `config.dataDir must win: expected a stamp in ${configDir}`)
  assert.equal(layoutOf(hostDir), undefined,
    `the host directory ${hostDir} must NOT be stamped when config.dataDir is set — ` +
      'reversing this priority would move every profile\'s retirement stores')
})

test('v131: the store dir is RE-COMPUTED per application (two profiles do not share a directory)', () => {
  /**
   * A cached resolution would pass the "same dir twice" test and fail this one: the second profile
   * would keep writing into the first profile's directory.
   */
  const firstDir = freshDir()
  const secondDir = freshDir()

  const firstCtx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: firstDir } })
  apply(firstCtx, {})
  const secondCtx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: secondDir } })
  apply(secondCtx, {})

  assert.ok(layoutOf(firstDir) !== undefined, 'first profile must be stamped')
  assert.ok(layoutOf(secondDir) !== undefined,
    'second profile must be stamped in its OWN directory — a cached resolution would have reused the first')
})

test('v131: identical inputs produce an identical stamp (stability, not just "a file exists")', () => {
  const dir = freshDir()

  apply(makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: dir } }), {})
  const first = layoutOf(dir)
  apply(makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: dir } }), {})
  const second = layoutOf(dir)

  assert.ok(first !== undefined && second !== undefined, 'both applications must have stamped the directory')
  assert.equal(second, first,
    'the layout stamp must be byte-identical across two applications with the same inputs — ' +
      'drift here would mean the resolved paths are not a pure function of the inputs')
})
