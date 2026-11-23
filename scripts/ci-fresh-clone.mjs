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

/**
 * ── THE REGISTRY IS PINNED, IN-PROCESS, AND PRINTED (lead §三十二) ──────────────────────────────
 *
 * MEASURED MISTAKE: the first version ran `npm install` with whatever registry this machine is
 * configured for — `https://repo.harmonyos.com/npm/` — which does not carry `typescript@5.9.3`, so it
 * reported `404`. **CI does not use that registry**: `ci.yml` has no `registry-url`, `setup-node` sets
 * none, and no repository has an `.npmrc`. So the proxy was measuring a configuration nobody uses.
 *
 * "A tool that measures the wrong surface keeps producing the wrong red and the wrong green" — the same
 * family as `v322` (green storage layer, unwired tool) and `v329 ③` (a regex that matched `auto is ON`).
 *
 * So the registry is pinned for THIS PROCESS ONLY, and printed, because evidence has to be auditable:
 *
 *   · `--registry=` is passed to the install command; the user's npm config is never written.
 *   · The run announces which registry it used.
 *   · A registry that cannot be reached is reported as a NETWORK condition — NOT as "the tree is broken".
 */
const REGISTRY = 'https://registry.npmjs.org'

const install = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`], target)
console.log(`[ci-proxy] install registry: ${REGISTRY} (pinned for this process only; your npm config is untouched)`)

if (install.code !== 0) {
  /**
   * ── NETWORK vs TREE: two different verdicts, and collapsing them is the defect ─────────────────
   *
   * A 404 / ENOTFOUND / ECONNREFUSED says the REGISTRY is the problem. Reporting that as
   * 「the committed tree does not build」 would send the next reader to look for a code defect that does
   * not exist — exactly what the harmoyos 404 did last round.
   */
  const networkish = /(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|404 Not Found|network|socket hang up)/iu.test(install.out)
  if (networkish) {
    console.error(`[ci-proxy] NETWORK CONDITION — could not install from ${REGISTRY}. This is NOT a verdict about the tree.`)
    console.error(install.out.trim().split('\n').slice(-6).join('\n'))
    if (!keep) rmSync(temp, { recursive: true, force: true })
    process.exit(2)
  }
  console.error(`[ci-proxy] npm install failed (exit ${install.code}) — this is a PACKAGE/MANIFEST problem:\n${install.out.slice(-2000)}`)
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