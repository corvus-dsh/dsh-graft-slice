/**
 * ── v251 (B4-0b-1 A8): an ENVIRONMENT declaration must also bind the artifact being measured ────
 *
 * The audit's B-6 / A8: `verify-bundle.mjs` treated `GRAFT_COMMIT_MESSAGE` as a declaration no matter
 * what the working tree looked like, and a declared run REWRITES `.export-surface.json`. With a dirty
 * tree the measured `index.js` is a rebuild nobody committed, so the declaration describes some other
 * artifact — and the gate absorbed that uncommitted change into the baseline, permanently.
 *
 * USER RULING (2026-11-19): 「是」 — bind it, with one explicit escape hatch:
 * `GRAFT_ACCEPT_DIRTY_TREE=1`. A waiver that does not say WHAT it waived is a blank cheque, so both the
 * passing line and the rewritten baseline name the dirty paths.
 *
 * ── fixture ──────────────────────────────────────────────────────────────────────────────────────
 *
 * A detached `git worktree` of HEAD (a real checkout, so the other 27 checks still pass), with THIS
 * working tree's gate script copied over it — the script under `scripts/` is not one of the measured
 * paths, so overwriting it does not disturb the cleanliness question. Then one export is appended and
 * the bundle rebuilt, which is exactly the "uncommitted export change" the gate must catch.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = 'scripts/verify-bundle.mjs'
const BASELINE = '.export-surface.json'

function gitIn(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function worktree() {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-v251-')), 'wt')
  gitIn(REPO, 'worktree', 'add', '--detach', path, 'HEAD')
  copyFileSync(join(REPO, GATE), join(path, GATE))
  return path
}

function cleanup(path) {
  try {
    gitIn(REPO, 'worktree', 'remove', '--force', path)
  } catch {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {}
  }
}

function addExportAndBuild(root, name) {
  appendFileSync(join(root, 'src', 'index.ts'), `\nexport const ${name} = 1\n`, 'utf8')
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8', stdio: 'ignore' })
}

function runGate(root, env = {}) {
  const result = spawnSync(process.execPath, [GATE], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GRAFT_COMMIT_MESSAGE: '',
      GITHUB_HEAD_COMMIT_MESSAGE: '',
      GRAFT_ACCEPT_DIRTY_TREE: '',
      ...env,
    },
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const baselineText = (root) => readFileSync(join(root, BASELINE), 'utf8')

test('v251 ①: 环境变量声明 + 脏工作树 + 无 GRAFT_ACCEPT_DIRTY_TREE ⇒ FAIL，基线字节不变', () => {
  const root = worktree()
  try {
    addExportAndBuild(root, 'v251UndeclaredEnvProbe')
    const before = baselineText(root)

    const { code, out } = runGate(root, { GRAFT_COMMIT_MESSAGE: 'ci: 假提交信息 [export-change]' })
    assert.equal(code, 1, `脏树上的环境变量声明不许算数；输出：\n${out}`)
    assert.match(out, /export surface matches the recorded baseline, or is declared/u)
    assert.equal(baselineText(root), before, '拒绝的时候基线必须逐字节不变 —— 它是最容易被顺手改写的证据')
    assert.ok(!out.includes('v251UndeclaredEnvProbe [declared]'), out)
  } finally {
    cleanup(root)
  }
})

test('v251 ②: 显式 GRAFT_ACCEPT_DIRTY_TREE=1 ⇒ 放行，且输出与基线都写明「接受了哪几处脏」', () => {
  const root = worktree()
  try {
    addExportAndBuild(root, 'v251AcceptedProbe')
    const { code, out } = runGate(root, {
      GRAFT_COMMIT_MESSAGE: 'ci: 假提交信息 [export-change]',
      GRAFT_ACCEPT_DIRTY_TREE: '1',
    })
    assert.equal(code, 0, `显式豁免必须放行；输出：\n${out}`)
    assert.match(out, /\[declared\]/u)
    assert.match(out, /GRAFT_ACCEPT_DIRTY_TREE=1/u, '输出必须点名这是显式豁免，而不是「干净树」')
    assert.match(out, /dirty tree ACCEPTED/iu, '放行语要写明「接受了脏树」，不是含糊的「已声明」')

    const text = baselineText(root)
    assert.match(text, /v251AcceptedProbe/u, '放行之后基线要记录这次导出')
    assert.match(text, /dirty tree was accepted/u, '基线自己也要留一句「这次豁免了脏树」')
    assert.match(text, /M src\/index\.ts|M index\.js/u, `基线必须列出被接受的脏路径，实测注释：${text}`)
  } finally {
    cleanup(root)
  }
})

test('v251 ③: 干净树 + 环境变量 ⇒ 放行（与修前一致，不许把这条路也堵死）', () => {
  const root = worktree()
  try {
    /** No edit at all: the surface matches the baseline, and a declaration is merely present. */
    const { code, out } = runGate(root, { GRAFT_COMMIT_MESSAGE: 'ci: [export-change]' })
    assert.equal(code, 0, `干净树上必须放行；输出：\n${out}`)
    assert.match(out, /28\/28 checks passed/u)
  } finally {
    cleanup(root)
  }
})