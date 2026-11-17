/**
 * ── v225：`verify-bundle.mjs` 的 export-change 声明必须本地可达 ──────────────────────────────────
 *
 * ── 实测缺陷（2026-11-17）──────────────────────────────────────────────────────────────────────
 *
 * 判据自己的失败消息写着「add [export-change] to the commit message if intended」，
 * 但它读的只有环境变量：
 *
 *     process.env.GRAFT_COMMIT_MESSAGE ?? ''     ← 由 workflow 设置
 *     process.env.GITHUB_HEAD_COMMIT_MESSAGE     ← 同上
 *
 * 于是：开发者**照着它的话做了**（提交信息里写了 `[export-change]`），再跑 `npm run check`，
 * 仍然红 —— 而本地没有任何文档说要设哪个环境变量。唯一能让本地链变绿的办法是手工导出 CI 变量，
 * 没人会发现这种事。
 *
 * 结果就是 ⑯ 的形态：一条只在 CI 里能被满足的门禁，本地必然红。开发者学会的是「跳过这一步」。
 *
 * ── 修法与判据 ──────────────────────────────────────────────────────────────────────────────────
 *
 * 环境变量仍然优先（CI 上它才是权威副本：squash 之后 merge commit 的信息不是作者写的那条），
 * 之后回退到 `git log -1 --pretty=%B` —— 提交之后，信息就在手边。
 *
 * 本文件用**真的子进程**验三件事，而不是读源码找字符串（读源码只能证明字符串存在）：
 *   ① 提交信息里有 `[export-change]` ⇒ 未声明的导出面变化被判为 declared（exit 0）
 *   ② 提交信息里没有 ⇒ 仍然 FAIL（回退不能把判据弄哑）
 *   ③ 环境变量仍然优先（CI 的实际形态）
 *
 * 做法：在临时目录里 `git init` 一个满足门禁其余 26 项检查的小仓库，造一次导出面变化，
 * 分别以三种方式提交。这样连「本地 git 环境」这一层也验到了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(REPO, 'scripts', 'verify-bundle.mjs')

/**
 * The entry the gate loads must export `apply`/`activate` — it imports the file for real. So every
 * fixture entry is built from this one place: a test that rewrote `index.js` by hand forgot those two
 * exports and made 26/28 checks fail for a reason unrelated to the declaration under test.
 */
const entryWith = (...names) =>
  [...names].map((name) => `export const ${name} = ${JSON.stringify(name)}`).join('\n') +
  '\nexport function apply() {}\nexport const activate = apply\n'

/** 最小可跑的插件目录：verify-bundle 会读 package.json / manifest.json / 入口文件，并真的 import 它。 */
function makeFixture(dir, entrySource) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@corvus-dsh/dsh-graft-slice',
        version: '0.0.0',
        type: 'module',
        main: 'index.js',
        exports: { '.': './index.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        engines: { node: '>=20', dsh: '>=0.2.1-rc.5' },
        repository: { type: 'git', url: 'git+https://github.com/corvus-dsh/dsh-graft-slice.git' },
        homepage: 'https://github.com/corvus-dsh/dsh-graft-slice#readme',
        bugs: { url: 'https://github.com/corvus-dsh/dsh-graft-slice/issues' },
        /**
         * 只列 fixture 真正有的文件。真实包的 `files` 有 11 个模式（含 `client.js`、`locale/*.json`、
         * `icon.svg` 等），照抄会让「every files pattern resolves」失败 —— 那是**夹具的**缺陷，
         * 不是被判据检出的缺陷。⑭ 的附注说的就是这个：受控实验必须能区分这两者。
         */
        files: ['index.js', 'manifest.json', 'cordis.patch.yml', 'LICENSE'],
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        name: '@corvus-dsh/dsh-graft-slice',
        version: '0.0.0',
        // `engines.dsh` must agree in BOTH files: that is a real check, so the fixture must satisfy it
        // or every run fails for a reason that has nothing to do with the declaration under test.
        engines: { dsh: '>=0.2.1-rc.5' },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    "- insert:\n    - id: dsh-graft-slice\n      name: '@corvus-dsh/dsh-graft-slice'\n      config:\n        recentTurns: 5\n",
  )
  writeFileSync(join(dir, 'LICENSE'), 'MIT\n')
  // The entry must export apply/activate: the gate loads it for real.
  writeFileSync(join(dir, 'index.js'), entrySource)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(dir, 'scripts', 'verify-bundle.mjs'))
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
}

const git = (dir, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })

function runGate(dir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'verify-bundle.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // 清掉 CI 的两个变量：本测试要验的正是「没有它们时本地怎么办」。
      env: { ...process.env, GRAFT_COMMIT_MESSAGE: '', GITHUB_HEAD_COMMIT_MESSAGE: '', ...env },
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('① 提交信息含 [export-change] ⇒ 本地未声明的导出面变化被判为 declared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-bundle-declared-'))
  try {
    makeFixture(dir, entryWith('alpha'))
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    // 第一次提交：baseline 由首跑记录，不参与判定。
    git(dir, 'commit', '-q', '-m', 'chore: baseline')
    const first = runGate(dir)
    assert.equal(first.code, 0, `首跑记录 baseline 必须 exit 0。实测输出：\n${first.out}`)
    const baseline = JSON.parse(readFileSync(join(dir, '.export-surface.json'), 'utf8'))
    assert.deepEqual(baseline.exports, ['activate', 'alpha', 'apply'], 'baseline 记录的是排序后的导出面')

    writeFileSync(join(dir, 'index.js'), entryWith('alpha', 'beta'))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'feat: add beta [export-change]')

    const result = runGate(dir)
    assert.match(result.out, /\[declared\]/u, `提交信息里的声明必须被读到。实测输出：\n${result.out}`)
    assert.equal(result.code, 0, '声明之后本地 check 必须能通过（否则开发者只能手工导环境变量）')
    const refreshed = JSON.parse(readFileSync(join(dir, '.export-surface.json'), 'utf8'))
    assert.deepEqual(refreshed.exports, ['activate', 'alpha', 'apply', 'beta'], '声明之后 baseline 被刷新到新导出面')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('② 提交信息不含 [export-change] ⇒ 仍然 FAIL（回退不能把判据弄哑）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-bundle-undeclared-'))
  try {
    makeFixture(dir, entryWith('alpha'))
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'chore: baseline')
    assert.equal(runGate(dir).code, 0, '首跑必须 exit 0')

    writeFileSync(join(dir, 'index.js'), entryWith('alpha', 'gamma'))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'feat: add gamma quietly')

    const result = runGate(dir)
    assert.equal(result.code, 1, '没有声明就必须红 —— 否则「加了导出没人看」重新变成默认')
    assert.match(result.out, /add \[export-change\]/u, '失败消息仍要指出正确做法')
    const untouched = JSON.parse(readFileSync(join(dir, '.export-surface.json'), 'utf8'))
    assert.deepEqual(untouched.exports, ['activate', 'alpha', 'apply'], '未声明的变化不许悄悄成为新基线')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③ 环境变量仍然优先于 git log（CI 上它才是权威副本）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-bundle-envfirst-'))
  try {
    makeFixture(dir, entryWith('alpha'))
    git(dir, 'init', '-q')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'chore: baseline')
    assert.equal(runGate(dir).code, 0, '首跑必须 exit 0')

    writeFileSync(join(dir, 'index.js'), entryWith('alpha', 'delta'))
    git(dir, 'add', '-A')
    // 提交信息里**没有**声明……
    git(dir, 'commit', '-q', '-m', 'feat: add delta quietly')

    // ……但 workflow 注入的变量里有（这正是 CI 的实际形态）。
    const result = runGate(dir, { GRAFT_COMMIT_MESSAGE: 'feat: add delta [export-change]' })
    assert.equal(result.code, 0, `环境变量里的声明必须生效。实测：\n${result.out}`)
    assert.match(result.out, /\[declared\]/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
