/**
 * ── v341 / P1：判据必须只依赖它自己构造的输入（lead §四十七.4）──────────────────────────────────
 *
 * 路径：**共享辅助**（`test/vacuous-repo.mjs`）+ **判据**（本文件，扫 `test/*.mjs` 的源码文本）。
 *
 * ── 一个缺陷类，七次出现 ──────────────────────────────────────────────────────────────────────
 *
 *   缺陷                     结论取决于
 *   ----------------------   --------------------------------------
 *   `v136` 脏树开关          **别人的测试**
 *   D1 红线被吞              **走哪个分支**
 *   `v277` 哈希窗口          **同步跑到哪一步**
 *   缓存复用失败观测          **一次已过去的运行**
 *   `v329 ③` 的 `/O/u`       **注释里有个字母**
 *   `v339 ③` 假绿            **它自己的说明文字**
 *   §44 三环误判             **我没读的判定器**
 *
 * > **判据必须只依赖它自己构造的输入。**
 * > **部分依赖比完全依赖更难发现**：完全依赖会稳定红，部分依赖会**时红时绿**，
 * > 于是被当成「偶发」记录，然后再没人管。
 *
 * ── 判据（四条，两条负向）──────────────────────────────────────────────────────────────────────
 *   ① 辅助存在且能构造出一个**真实**的临时 git 仓库（不是 mock：被测脚本会 shell out 到 git）
 *   ② **负向** `test/*.mjs` 不得在 `execFileSync('git', …)` 里读**本工作树**
 *      —— 允许显式传 `cwd: sandbox.root`
 *   ③ **负向** 判据自身可红：喂一段读本树的样例必须被判定为违规
 *   ④ 报告扫描结果（空集不许当通过）
 *
 * ── 本条判据自身遵守它刚建立的那条规矩 ────────────────────────────────────────────────────────
 * ② 是源码文本断言，所以它**必须**走 `stripComments()`。否则它会被自己的说明注释绊倒
 * —— 本文件上面就引用了 `git status --porcelain -- src` 作为反例。
 * **新判据要立刻用上刚建的工具，否则新工具只为旧判据服务。**
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-assertion.mjs'
import { withVacuousRepo } from './vacuous-repo.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = join(ROOT, 'test')

/**
 * ── NAMED EXEMPTIONS, WITH THE REASONING IN THE DATA ────────────────────────────────────────────
 *
 * Loosening the rule for everyone is how a criterion gets switched off. An exemption here is one
 * line, names the exact call site, and has to survive re-reading.
 *
 * `v136-import-edges.test.mjs`  →  it compares THIS tree against `--against <ref>`; the diff IS the
 *   test's input, so a sandbox would have to reproduce an entire real move to mean anything. The
 *   `git status` there only decides whether a new edge is labelled `created` — a presentation
 *   detail — while every ASSERTION is made against `git show <ref>:<file>`, i.e. committed content
 *   that cannot move under concurrency. The cost is stated at the call site.
 */
const EXEMPT = new Map([
  ['v136-import-edges.test.mjs', '本树 diff 就是它的输入；断言只落在 git show <ref>:…，不受并发影响'],
])

/**
 * ── THE SHAPE IS NARROWER THAN "USES GIT" ────────────────────────────────────────────────────────
 *
 * First version of this checker flagged every `execFileSync('git', …)` without a sandbox cwd. Six
 * hits, of which only ONE was the defect — and flagging the other five would have been a criterion
 * that punishes correct code:
 *
 *   `git show <ref>:<file>`   reads COMMITTED content. Whether the working tree is dirty cannot
 *                             change its answer, so it is a stable input. Fine.
 *   `git log -- <path>`       reads history. Same reasoning. Fine.
 *   `git status --porcelain`  asks 「is the tree dirty RIGHT NOW」 — a GLOBAL, MUTABLE fact owned by
 *                             whichever test happens to be running. **This is the defect.**
 *
 * So the rule is about USING THE VERDICT, not about the command: a criterion may consult git's own
 * history freely; it may not let its ASSERTION depend on the current state of a tree it does not own.
 * The narrow rule is what makes the criterion honest — a broad one would be switched off by the
 * first person who needed `git show`.
 */
const VOLATILE_GIT = /\bstatus\b|\bstash\b|['"]diff['"]/u

function offendingGitCalls(source) {
  const code = stripComments(source)
  const offenders = []
  let total = 0
  for (const match of code.matchAll(/execFileSync\(\s*['"]git['"]\s*,\s*\[([\s\S]{0,400}?)\]\s*,\s*\{([\s\S]{0,300}?)\}/gu)) {
    total += 1
    const args = match[1]
    /** Only the volatile subcommands matter; `show` / `log` / `rev-parse` are stable inputs. */
    if (!VOLATILE_GIT.test(args)) continue
    const options = match[2]
    /**
     * `cwd: ROOT` / `cwd: here` / a MISSING cwd all mean "this working tree". A sandbox pins
     * `cwd: repo.root`, a bare `cwd` variable (the caller decided), `sandbox`, or a mkdtemp path.
     */
    const pinnedToThisTree = /cwd\s*:\s*(?:ROOT|here|REPO|TEST_DIR)\b/u.test(options)
    const noCwd = !/cwd\s*:/u.test(options)
    if (pinnedToThisTree || noCwd) {
      offenders.push({ at: match.index, options: options.trim().slice(0, 80) })
    }
  }
  return { offenders, total }
}

test('v341 ①: the helper builds a REAL throwaway git repo (the thing under test shells out to git)', async () => {
  await withVacuousRepo(async (repo) => {
    repo.write('src/a.ts', 'export const a = 1\n')
    const sha = repo.commit('baseline')
    assert.match(sha, /^[0-9a-f]{40}$/u, '① 必须产出真实 commit sha —— mock 会让「shell out 到 git」测不到')
    assert.equal(repo.isDirty('src'), false, '① 刚提交的树必须是干净的（vacuous 场景的前提）')
    repo.write('src/a.ts', 'export const a = 2\n')
    assert.equal(repo.isDirty('src'), true, '① 改写之后必须被判定为脏（否则判据永远测 vacuous）')
  })
})

test('v341 ② (negative): no test may read THIS working tree through git', () => {
  /**
   * Scans every `test/*.mjs`. A git call inside a sandbox is fine; one against `ROOT`/`here`/no cwd
   * is the race — measured when `v136x` went green alone and red in the suite.
   */
  const offenders = []
  let scanned = 0
  let gitCalls = 0
  for (const name of readdirSync(TEST_DIR).filter((n) => n.endsWith('.mjs')).sort()) {
    const source = readFileSync(join(TEST_DIR, name), 'utf8')
    if (!/execFileSync\(\s*['"]git['"]/u.test(source)) continue
    scanned += 1
    const { offenders: found, total } = offendingGitCalls(source)
    gitCalls += total
    if (EXEMPT.has(name)) continue
    for (const entry of found) {
      const line = source.slice(0, entry.at).split('\n').length
      offenders.push(`${name}:${line}  execFileSync('git', …) 未指定沙箱 cwd —— 它读的是本工作树（${entry.options}）`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `② 这些判据的结论取决于「别人的测试此刻有没有弄脏工作树」：\n${offenders.join('\n')}\n` +
      '修法：用 test/vacuous-repo.mjs 的 VacuousRepo / withVacuousRepo，在一次性仓库里构造场景。',
  )
  assert.ok(scanned > 0, '④ 扫描到 0 个用 git 的测试文件 —— 「什么都没扫」不是通过')
  assert.ok(gitCalls > 0, '④ 扫描到 0 次 execFileSync(\'git\') 调用 —— 同上')
})

test('v341 ③ (negative): the checker can actually fail — a sample reading ROOT is caught', () => {
  /**
   * The self-harm this half prevents: ② could be written so loosely that it matches nothing, then
   * report a green that measured nothing. The sample below is the exact `v136x` shape.
   */
  const bad = [
    'const status = execFileSync(\'git\', [\'status\', \'--porcelain\'], { cwd: ROOT, encoding: \'utf8\' })',
  ].join('\n')
  const badResult = offendingGitCalls(bad)
  assert.equal(badResult.offenders.length, 1, '③ cwd: ROOT 必须被判为违规（它就是本工作树）')

  const good = [
    'const out = holder.git([\'status\', \'--porcelain\'])',
    'const direct = execFileSync(\'git\', [\'rev-parse\', \'HEAD\'], { cwd: repo.root, encoding: \'utf8\' })',
  ].join('\n')
  assert.equal(offendingGitCalls(good).offenders.length, 0, '③ 沙箱 cwd 必须被放行，否则修法不被承认')
})
