/**
 * ── v238 (B2-T4b): graft 侧的声明绑定 —— 这里更重，因为声明会**重写基线** ─────────────────────
 *
 * observer 的同形漏洞（v237 ①）只是「放行一次」。graft 的声明分支会写 `.export-surface.json`：
 *
 *     if (!same && declared) writeFileSync(SURFACE_FILE, …'baseline updated by a declared [export-change]')
 *
 * 所以后果是**把未声明的导出改动写进基线** —— 下一次跑时 `same === true`，没有任何地方留下
 * 「这次改动需要被看」的痕迹。门禁不只没拦住，它把证据抹掉了。
 *
 * 根因与 observer 相同：`git log -1` 是「最新提交的声明」，而这里量的是**工作树的产物**。
 * 提交后继续改，两者不同指。
 *
 * ── 测试手法：`git worktree`，不是 mock ───────────────────────────────────────────────────────
 *
 * `verify-bundle.mjs` 从自己的路径推出 ROOT，并检查 28 项（package.json / manifest / patch /
 * 产物 / 导出面 …）。在临时目录里手搭一个「像仓库」的目录会让另外 27 项全红，于是无论声明生效与否
 * exit 都是 1 —— 那样的测试证明不了任何事。
 *
 * 所以这里用 `git worktree add --detach <tmp> HEAD`：一个真实、干净、能通过 28/28 的检出。
 * 在它里面改、构建、跑真脚本。测的是**真的门禁**，不是我以为的门禁。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = 'scripts/verify-bundle.mjs'
const BASELINE = '.export-surface.json'

/** The paths whose cleanliness decides whether a commit-message declaration applies. */
const MEASURED_PATHS = ['src', 'index.js']

function gitIn(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/**
 * A fresh, clean, detached worktree of HEAD — the only fixture that can still pass the other 27 checks.
 *
 * ── WHY THE GATE SCRIPT IS OVERWRITTEN WITH THE WORKING-TREE COPY ──────────────────────────────
 *
 * A worktree checks out COMMITTED code, so it would run the gate as it was at HEAD. That is the wrong
 * subject: this test exists to hold the CURRENT script to the rule, and if it ran HEAD's copy it would
 * pass forever after the fix and catch nothing afterwards.
 *
 * The script lives under `scripts/`, which is NOT in `MEASURED_PATHS` — so overwriting it does not
 * disturb the cleanliness question the test is asking.
 */
function worktree() {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-v238-')), 'wt')
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

/** Add one export to the real entry file and rebuild, so the surface really differs. */
function addExportAndBuild(root, name) {
  const entry = join(root, 'src', 'index.ts')
  appendFileSync(entry, `\nexport const ${name} = 1\n`, 'utf8')
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, encoding: 'utf8', stdio: 'ignore' })
}

function runGate(root, env = {}) {
  const result = spawnSync(process.execPath, [GATE], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GRAFT_COMMIT_MESSAGE: '', GITHUB_HEAD_COMMIT_MESSAGE: '', ...env },
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const baselineText = (root) => readFileSync(join(root, BASELINE), 'utf8')

// ── ① 复现漏洞：HEAD 带声明，工作树另有未声明改动 ⇒ 必须红，且基线不许被改写 ─────────────────

test('v238 ①: HEAD 带声明、工作树另有未声明改动 ⇒ exit 1，且 .export-surface.json 不被改写', () => {
  const root = worktree()
  try {
    /** HEAD (a5e9fc9) carries `[export-change]`; this change is NOT declared anywhere. */
    const before = baselineText(root)
    addExportAndBuild(root, 'v238UndeclaredProbe')
    const { code, out } = runGate(root)
    assert.equal(code, 1, `脏工作树 ⇒ 提交信息的声明不适用，必须 exit 1；实测 exit=${code}\n${out.slice(-900)}`)
    /**
     * THE DAMAGE SPECIFIC TO THIS REPO: a waived run does not merely pass — it RECORDS the undeclared
     * change as the new contract. After that, every later run says "unchanged" and nobody ever sees it.
     */
    assert.equal(baselineText(root), before, '未声明的改动不许被写进基线 —— 那会把证据抹掉')
    assert.doesNotMatch(out, /baseline updated by a declared/u)
  } finally {
    cleanup(root)
  }
})

// ── ② 环境变量声明总是算数，并点名来源 ──────────────────────────────────────────────────────

test('v238 ②: 同样的脏工作树，但用环境变量声明 + GRAFT_ACCEPT_DIRTY_TREE=1 ⇒ exit 0，点名「环境变量」与「接受了脏树」', () => {
  const root = worktree()
  try {
    addExportAndBuild(root, 'v238EnvProbe')
    /**
     * ── B4-0b-1 A8 CHANGED THIS CASE, ON THE USER'S RULING ──────────────────────────────────────
     *
     * The environment variable says "a declaration exists for this run" — it does NOT say "the
     * artifact being measured is the declared one". With a dirty tree the measured `index.js` is a
     * rebuild nobody committed, so the declaration is about some other artifact. The ruling was 「是」
     * (bind it), with one explicit escape hatch. This case now exercises the escape hatch, which is
     * the only remaining way an env declaration can cover a dirty tree.
     */
    const { code, out } = runGate(root, {
      GRAFT_COMMIT_MESSAGE: 'feat: x\n\n[export-change]',
      GRAFT_ACCEPT_DIRTY_TREE: '1',
    })
    assert.equal(code, 0, `显式接受脏树时环境变量必须生效；实测 exit=${code}\n${out.slice(-700)}`)
    assert.match(out, /环境变量|environment/iu, `必须点名声明来自环境变量：${out.slice(-700)}`)
    assert.match(out, /dirty tree ACCEPTED/iu, `必须点名这次豁免了脏树：${out.slice(-700)}`)
  } finally {
    cleanup(root)
  }
})

test('v238 ②b: 同样的脏工作树，环境变量声明**不算数** —— 除非显式豁免（A8 的核心判据）', () => {
  const root = worktree()
  try {
    addExportAndBuild(root, 'v238EnvUnboundProbe')
    const before = baselineText(root)
    const { code, out } = runGate(root, { GRAFT_COMMIT_MESSAGE: 'feat: x\n\n[export-change]' })
    assert.equal(code, 1, `脏树上的环境变量声明不许算数；实测 exit=${code}\n${out.slice(-700)}`)
    assert.equal(baselineText(root), before, '拒绝时基线必须逐字节不变')
  } finally {
    cleanup(root)
  }
})

// ── ③ 工作树干净 + HEAD 带声明 ⇒ 算数，且点名该提交 ─────────────────────────────────────────

test('v238 ③: 工作树干净、HEAD 带声明 ⇒ exit 0，点名该提交的 sha 与标题', () => {
  const root = worktree()
  try {
    /**
     * The realistic shape this branch exists for: the author declared `[export-change]`, committed the
     * source, but did NOT commit the regenerated baseline (the shipped `T3`/`T4` commits hit exactly
     * this). Tree is CLEAN, so the declaration is bound to the artifact being measured.
     */
    addExportAndBuild(root, 'v238CommittedProbe')
    const sha = gitIn(root, 'rev-parse', 'HEAD')
    const subject = process.env.V238_SUBJECT ?? ''
    gitIn(root, 'add', ...MEASURED_PATHS)
    gitIn(root, 'commit', '-q', '-m', 'feat: 声明了新导出（故意不提交基线）\n\n[export-change]')
    const headSha = gitIn(root, 'rev-parse', '--short', 'HEAD')
    const headSubject = gitIn(root, 'log', '-1', '--pretty=%s')

    const { code, out } = runGate(root)
    assert.equal(code, 0, `干净工作树下提交信息的声明有效；实测 exit=${code}\n${out.slice(-900)}`)
    assert.ok(out.includes(headSha), `必须点名是哪个提交（${headSha}）：${out.slice(-900)}`)
    assert.ok(out.includes(headSubject), `必须点名该提交的标题（${headSubject}）：${out.slice(-900)}`)
    /** And the baseline WAS refreshed this time — a declared change becomes the record. */
    assert.match(baselineText(root), /v238CommittedProbe/u, '声明生效时基线必须被刷新')
    void sha
    void subject
  } finally {
    cleanup(root)
  }
})

// ── ④ 导出面没变 ⇒ 正常通过，且不打印任何放行 ──────────────────────────────────────────────

test('v238 ④: 导出面没变 ⇒ exit 0，且不出现放行字样（没得放行就不许说放行）', () => {
  const root = worktree()
  try {
    const { code, out } = runGate(root)
    assert.equal(code, 0, `干净且未改动 ⇒ 28/28；实测 exit=${code}\n${out.slice(-600)}`)
    assert.doesNotMatch(out, /\[declared\]/u, '没改动就不该出现 [declared] 标记')
  } finally {
    cleanup(root)
  }
})

/** 「干净」只看被测量的路径：无关文件不许撤销一个已声明的提交。 */
test('v238 ④b: 「干净」只看 src / index.js —— 临时日志不算脏', () => {
  const root = worktree()
  try {
    addExportAndBuild(root, 'v238NoiseProbe')
    gitIn(root, 'add', ...MEASURED_PATHS)
    gitIn(root, 'commit', '-q', '-m', 'feat: 声明\n\n[export-change]')
    /**
     * A stray file OUTSIDE the measured paths must not revoke the declaration.
     *
     * NOT named `*.log`: this repository ignores `*.log`, and an ignored file never appears in
     * `git status` — the assertion "the whole status sees it" would fail for a reason that has nothing
     * to do with the rule under test (and the proof would be vacuous rather than wrong).
     */
    execFileSync(process.execPath, ['-e', "require('fs').writeFileSync('scratch-noise.txt','noise')"], { cwd: root })
    assert.ok(existsSync(join(root, 'scratch-noise.txt')), '那个文件必须真的存在，否则这条结论是空的')
    const status = gitIn(root, 'status', '--porcelain')
    assert.ok(status.includes('scratch-noise.txt'), '整体 status 必须看到它（证明「脏」是真的）')
    assert.equal(gitIn(root, 'status', '--porcelain', '--', ...MEASURED_PATHS), '', '但它不在被测量路径上')
    /** Baseline is dirty right after the declared run above; that is the RECORD, not the measurement. */
    const { code } = runGate(root)
    assert.equal(code, 0, '结论：一个临时日志不该撤销一个已声明的功能提交')
  } finally {
    cleanup(root)
  }
})