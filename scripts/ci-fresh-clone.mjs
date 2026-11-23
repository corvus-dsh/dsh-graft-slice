#!/usr/bin/env node
/**
 * ── LOCAL CI PROXY: run `npm run check` on a FRESH CLONE, with no inherited node_modules ────────
 *
 * WHY (lead §三十.3): CI is unobserved (403). A green `npm run check` in the working tree proves the
 * local environment is consistent — **not** that a fresh machine can build it. The failures that only
 * exist in the second case are the expensive ones: a file that is gitignored but required, a script
 * that reads the working tree instead of HEAD, an artifact that is only fresh because someone built it
 * locally, a `node_modules` dependency that is not declared.
 *
 * WHAT IT DOES, in order:
 *
 *   1. `git clone <local repo> <temp>` — a LOCAL clone, so this does not need the network, and it
 *      captures **what is committed** rather than the working tree (which is the whole point).
 *   2. delete `node_modules` if the clone has one (a `.gitignore`d dependency must be re-installed).
 *   3. `npm install --ignore-scripts` — install scripts are refused because this is a verification run,
 *      not a build environment: a postinstall that mutates the tree would invalidate the measurement.
 *   4. `npm run check`, capturing exit code and the last lines of output.
 *
 * WHAT IT DOES NOT CLAIM: this is a PROXY. It cannot prove GitHub's runners can do it (different OS,
 * different Node patch, network-restricted registry). 「本地全新克隆通过」与「CI 通过」是两件事，
 * 报告里必须分开写。
 *
 * Usage:
 *   node scripts/ci-fresh-clone.mjs                 # check this repo
 *   node scripts/ci-fresh-clone.mjs --repo dsh-memory
 *   node scripts/ci-fresh-clone.mjs --keep          # keep the temp dir for inspection
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const repoFlag = args.indexOf('--repo')
const repo = repoFlag >= 0 ? args[repoFlag + 1] : basenameOf(REPO_ROOT)
const keep = args.includes('--keep')

function basenameOf(path) {
  const parts = resolve(path).split(/[\\/]/u)
  return parts[parts.length - 1]
}

const source = join(WORKSPACE, repo)
if (!existsSync(source)) {
  console.error(`no such repo: ${source}`)
  process.exit(2)
}

const temp = mkdtempSync(join(tmpdir(), `ci-proxy-${repo}-`))
const target = join(temp, 'clone')

const run = (command, commandArgs, cwd) => {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

console.log(`[ci-proxy] ${repo} → ${target}`)

/* 1. A LOCAL clone: no network, and it copies COMMITTED content only. */
const clone = run('git', ['clone', '--depth', '1', '--quiet', source, target], WORKSPACE)
if (clone.code !== 0) {
  console.error(`[ci-proxy] clone failed:\n${clone.out}`)
  rmSync(temp, { recursive: true, force: true })
  process.exit(1)
}

/* 2. Any node_modules in the clone is ignored content; it must not be inherited. */
const modules = join(target, 'node_modules')
if (existsSync(modules)) {
  rmSync(modules, { recursive: true, force: true })
  console.log('[ci-proxy] removed inherited node_modules')
}

/* 3. Install without running scripts — this is a measurement, not a build environment. */
const install = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], target)
if (install.code !== 0) {
  console.error(`[ci-proxy] npm install failed (exit ${install.code}):\n${install.out.slice(-2000)}`)
  if (!keep) rmSync(temp, { recursive: true, force: true })
  process.exit(1)
}

/* 4. The real question. */
const check = run('npm', ['run', 'check'], target)
const tail = check.out.trim().split('\n').slice(-6).join('\n')
console.log(`[ci-proxy] npm run check → exit ${check.code}`)
console.log(tail)

if (!keep) rmSync(temp, { recursive: true, force: true })
else console.log(`[ci-proxy] kept: ${target}`)

console.log(
  check.code === 0
    ? '[ci-proxy] PASS — a fresh clone with no inherited node_modules passes the full check chain. This is a LOCAL proxy: it says nothing about GitHub runners.'
    : '[ci-proxy] FAIL — the committed tree does not build in a clean environment. This IS a real finding even though CI was never observed.',
)
process.exit(check.code === 0 ? 0 : 1)