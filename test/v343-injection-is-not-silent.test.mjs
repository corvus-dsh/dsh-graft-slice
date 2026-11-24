/**
 * ── v343：为可测性开的接缝必须自述，并且拒绝无意义的取值 ──────────────────────────────────────
 *
 * 背景（lead §五十.3）：`verify-pure-move.mjs` 加了 `GRAFT_PURE_MOVE_REPO`，让测试把仪器指向
 * 一次性仓库。**但那个接缝不打印它用了哪棵树、也不校验取值。**
 *
 * 为什么这件事比它修的那个 bug 更严重：
 *
 *   本仓所有判据都在打「结论不要取决于它不控制的东西」。**这个变量是反向的**——它让
 *   **被检查的对象**可以被外部换掉，而门禁不知道。一次「被指向空目录因此通过」与一次
 *   「自己通过」打印出来的形状完全相同，所以**光看输出分不出真绿和改道绿**。
 *
 *   > 一个没有日志的注入点，等于给了「让门禁通过」一条**不需要改代码**的路。
 *
 * 四条判据，其中两条负向：
 *
 *   ① 未注入 ⇒ **不得**出现 injected 行（一行永远存在的说明等于没有说明）
 *   ② 注入合法沙箱 ⇒ 打印含该沙箱**绝对路径**的一行
 *   ③ 注入不存在的路径 ⇒ 非零，并**点名环境变量**（不是一条 ENOENT 栈）
 *   ④ 注入存在的非 git 目录 ⇒ 非零，并点名环境变量
 *
 * ④ 的实测理由：`git diff --quiet` 在非仓目录上是 exit 128，而 VACUOUS 判定**故意**把
 * 「非 0」读成「存在差异」（exit 1 = 有差异）。于是工具会先宣布「有一棵树可以比」，
 * 再去比一棵它读不了树——**错的不是后面那个 throw，而是前面那个结论。**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PURE_MOVE = join(ROOT, 'scripts', 'verify-pure-move.mjs')

/** Run the tool with a chosen `GRAFT_PURE_MOVE_REPO` value (undefined = not injected at all). */
const runPureMove = (injected) => {
  const env = { ...process.env }
  if (injected === undefined) delete env.GRAFT_PURE_MOVE_REPO
  else env.GRAFT_PURE_MOVE_REPO = injected
  /**
   * BOTH streams, and `out` is the concatenation. The announcement goes to STDERR on purpose:
   * measured, printing it on stdout broke `move-gate.mjs --json` and turned ten of v138's eleven
   * tests red with `SyntaxError: Unexpected token 'm'`. stdout is the tool's PRODUCT; 「哪棵树被测量」
   * is a diagnostic about the product. A criterion may read both channels, so nothing is lost.
   */
  const result = spawnSync(process.execPath, [PURE_MOVE], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { code: result.status ?? 1, stdout, stderr, out: `${stdout}${stderr}` }
}

/** A throwaway git repo with one committed module — the ONLY kind of value the switch may accept. */
const makeSandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'v343-inject-'))
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  run(['init', '-q'])
  run(['config', 'user.email', 'v343@example.invalid'])
  run(['config', 'user.name', 'v343'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'baseline'])
  return dir
}

test('v343 ① (negative half): an UNinjected run must not claim an injected input', () => {
  /**
   * This half is what makes ② mean something. A line printed unconditionally would satisfy ②
   * while telling the reader nothing — the report would say "injected" on every run, including
   * the ones that measured this repository. A statement about the input must be able to be FALSE.
   */
  const { out } = runPureMove(undefined)
  assert.doesNotMatch(out, /injected via GRAFT_PURE_MOVE_REPO/u,
    `a run with no GRAFT_PURE_MOVE_REPO must not print an injection line:\n${out}`)
})

test('v343 ②: an injected run NAMES the repository it measured, with the absolute path', () => {
  const sandbox = makeSandbox()
  try {
    const expected = resolve(sandbox)
    const { code, out } = runPureMove(sandbox)
    /**
     * The tree has no diff, so the answer is the documented VACUOUS exit 2 — that is not the point
     * here. The point is that the FIRST thing the report says is which tree produced it.
     */
    assert.equal(code, 2, `an injected, diff-less tree still exits 2 (VACUOUS), got ${code}:\n${out}`)
    assert.ok(out.includes(`pure-move: repository = ${expected} (injected via GRAFT_PURE_MOVE_REPO)`),
      `the report must name the injected repository and the variable, verbatim; expected the line to contain ` +
      `"${expected}" and "(injected via GRAFT_PURE_MOVE_REPO)":\n${out}`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('v343 ③ (negative half): a NONEXISTENT injected path is refused BY NAME, not by a stack trace', () => {
  /**
   * Measured before the fix: this exited 1 with a raw `ENOENT ... scandir` stack coming out of
   * `readdirSync`. Non-zero either way — but the message named a syscall and a path, never the
   * variable, so a reader who set it had nothing to search for. A refusal that does not name the
   * switch it refused is a refusal the reader will misattribute to the repository.
   */
  const missing = join(tmpdir(), `v343-does-not-exist-${process.pid}-${Date.now()}`)
  const { code, out } = runPureMove(missing)
  assert.notEqual(code, 0, `a nonexistent repository must not be accepted:\n${out}`)
  assert.match(out, /GRAFT_PURE_MOVE_REPO/u, `the refusal must name the variable:\n${out}`)
  assert.match(out, /does not exist/u, `the refusal must say WHAT is wrong:\n${out}`)
  assert.doesNotMatch(out, /IDENTICAL/u, `a refused run must never print a verdict:\n${out}`)
})

test('v343 ④ (negative half): an EXISTING directory that is not a git repository is refused too', () => {
  /**
   * This is the case that motivated the check. A plain directory passes the existence test, and
   * `git diff --quiet` on it exits 128 — which the VACUOUS rule interprets as "differences exist"
   * (exit 1 means changed). So the tool would first assert there IS something to compare, in a tree
   * whose history it cannot read. Refusing up front is the only honest answer.
   */
  const plain = mkdtempSync(join(tmpdir(), 'v343-not-a-repo-'))
  try {
    mkdirSync(join(plain, 'src'), { recursive: true })
    writeFileSync(join(plain, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    const { code, out } = runPureMove(plain)
    assert.notEqual(code, 0, `a directory without .git must not be accepted:\n${out}`)
    assert.match(out, /GRAFT_PURE_MOVE_REPO/u, `the refusal must name the variable:\n${out}`)
    assert.match(out, /not a git repository/u, `the refusal must say what is missing:\n${out}`)
    assert.doesNotMatch(out, /IDENTICAL|VACUOUS/u, `a refused run must never print a verdict:\n${out}`)
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})
