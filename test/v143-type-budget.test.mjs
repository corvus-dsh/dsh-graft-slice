/**
 * ── v143: 增量类型预算 —— 不引入「一次全红」，只要求「不许变多」────────────────────────────────
 *
 * 这条门禁的存在理由是一条实测缺陷：第 4 步把 goal-extraction.ts 搬出去时漏了 5 个 export，
 * 而当时 **789 条测试全绿、build 成功、verify-pure-move IDENTICAL** —— 三道关都没拦住。
 * 原因不是它们不严，是它们看不见：
 *   · stripTypeScriptTypes 只删类型，不做符号检查；
 *   · 打包器把「import 一个不存在的成员」变成「同一作用域里名字恰好存在」；
 *   · verify-pure-move 只比内容行，import/export 行本就被排除。
 *
 * 本测试钉住四条判据，每一条都对应一个已实测的失败模式：
 *   ① 判据是「本次提交触及的文件」，不是「新文件」—— 因为纯位移会把源文件的错误原样带走；
 *   ② 触及文件不许变多（搬移型提交因此自然豁免为「不变」）；
 *   ③ 2459 是绝对判据，与触及面无关 —— 它是那个被证明会静默通过的失效模式；
 *   ④ 没有编译器时 exit 2，绝不静默通过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'type-budget.mjs')
const SOURCE = readFileSync(SCRIPT, 'utf8')

/** 运行脚本并把退出码与输出一起拿到（它按设计以非零退出表示违规）。 */
function run (args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/**
 * ── CI HAS NO COMPILER, AND THAT MUST BE A SKIP, NOT A FAILURE ────────────────────────────────────
 *
 * Measured on CI run #120: both Node jobs failed at step 12 (Test), because `type-budget.mjs` exits 2
 * when `typescript` is absent — by design, since a missing compiler is a RESOURCE condition and must
 * never read as a pass. But the tests that RUN it then failed, turning an honest "cannot measure" into
 * a red build on every push.
 *
 * `test/v142` already solved exactly this with `t.skip('RESOURCE: …')`. Same rule here.
 *
 * ── THE PROBE MUST BE THE MEASURING SUBCOMMAND, NOT `--self-test` ────────────────────────────────
 *
 * First draft probed with `--self-test`, which needs NO compiler (it uses fake data) — so it returned
 * 0 and the skip never triggered. Simulated with the scripts copied outside the workspace (where
 * `require('typescript')` cannot resolve): `--self-test` → 0, `--baseline` → 2, no args → 2.
 * The probe therefore has to be a subcommand that actually needs the compiler.
 */
const requireCompiler = (t) => {
  const { code, out } = run(['--baseline'])
  if (code === 0) return true
  if (/typescript is not installed|RESOURCE condition|compiler unavailable/u.test(out)) {
    t.skip('RESOURCE: typescript is not installed on this machine, so the budget cannot be measured')
    return false
  }
  assert.fail(`the budget failed for a reason other than a missing compiler:\n${out}`)
}

test('v143: the rule is INCREMENTAL — a touched file may not gain errors, an untouched one is out of scope', (t) => {
  /**
   * 这是本门禁最容易被「改松」的一处：一旦有人把判据改成「全树总量不变」，存量债会把门禁锁死；
   * 改成「全树必须为 0」就是用户明确否决的「一次全红」。
   * 所以自测里必须同时有「触及文件变多要红」与「未触及文件变多不许红」两条。
   *
   * 自测本身不需要编译器（它用假数据），所以这条在 CI 上也跑 —— 这是**唯一**一条在无编译器机器上
   * 仍然真实执行的 v143 断言，因此它承担了「判据本身没被改松」的全部责任。
   */
  const { code, out } = run(['--self-test'])
  assert.equal(code, 0, `the self-test must pass; got:\n${out}`)
  assert.match(out, /a touched file GAINED one — must fail/u)
  assert.match(out, /an UNTOUCHED file gained — must NOT fail/u)
  assert.match(out, /a touched file that had 0 now has 1 — must fail/u)
  assert.match(out, /SELF-TEST PASS/u)
})

test('v143: code 2459 is an ABSOLUTE rule, not a per-file budget', () => {
  /**
   * 与「触及文件不许变多」刻意不同：2459 代表的缺陷会静默通过所有其他门禁，
   * 所以它必须是「只要存在就红」，哪怕本次提交没触及那个文件。
   */
  assert.match(SOURCE, /MOVE_ONLY_CODE = 2459/u,
    'the move-only code must be named explicitly, not inlined')
  const { out } = run(['--self-test'])
  assert.match(out, /2459 is ABSOLUTE/u)

  // and the rule text must state why it is absolute rather than a budget
  assert.match(SOURCE, /静默通过所有其他门禁|silently pass|passed 789 tests/u,
    'the source must say WHY 2459 is absolute')
})

test('v143: on the real tree the budget holds, and the baseline table is the MEASURED one', (t) => {
  if (!requireCompiler(t)) return
  /**
   * ── 基线表必须来自 `--baseline`，不能手写 ────────────────────────────────────────────────────
   *
   * 实测教训：第一版我按「印象中的文件」手写了 17 行，把 `core/watermark.ts 3`、
   * `core/gateway-types.ts 3` 等也写了进去 —— 那几个错误本轮已经被修掉，实测是 0。
   * 手写的表偏松就是给未来增长预留空间，偏紧就是天天误报。两者都是「表不是测量」。
   *
   * 所以这条断言做真正的对照：`--baseline` 的实测输出必须与源码里的 BASELINE 表逐项相等。
   */
  const { code, out } = run(['--baseline'])
  assert.equal(code, 0, `--baseline must run; got:\n${out}`)

  const measured = new Map()
  for (const m of out.matchAll(/^\s+\['([^']+)', (\d+)\],/gmu)) measured.set(m[1], Number(m[2]))
  const total = Number(/total: (\d+)/u.exec(out)?.[1])
  assert.ok(measured.size > 0, 'the baseline output must list per-file counts, not just a total')
  assert.ok(total > 0, 'the tree must still have the documented residual errors')

  // the source table must equal the measured one — extra or missing rows are both defects
  const declared = new Map()
  const table = /const BASELINE = new Map\(\[([\s\S]*?)\]\)/u.exec(SOURCE)?.[1] ?? ''
  for (const m of table.matchAll(/\['([^']+)', (\d+)\]/gmu)) declared.set(m[1], Number(m[2]))

  assert.deepEqual([...declared.keys()].sort(), [...measured.keys()].sort(),
    'the frozen baseline must name exactly the files the compiler currently reports — ' +
    'run `node scripts/type-budget.mjs --baseline` and paste, never hand-write')
  for (const [file, n] of measured) {
    assert.equal(declared.get(file), n, `${file}: frozen ${declared.get(file)} but measured ${n}`)
  }

  const sum = [...declared.values()].reduce((s, n) => s + n, 0)
  assert.equal(sum, total, `per-file baseline sums to ${sum} but the compiler reports ${total}`)
})

test('v143: it exits 2 — not 0 — when the compiler is unavailable', () => {
  /**
   * CI 不装 typescript（package.json 无依赖），所以这条门禁在 CI 上**不生效**。
   * 这不是遗漏，是资源事实。写成「绿色」才是真正的漏洞 —— 那会让「没跑」看起来像「通过」。
   */
  assert.match(SOURCE, /process\.exit\(2\)/u, 'a resource failure must exit 2, never 0')
  assert.match(SOURCE, /RESOURCE condition, not a pass/u,
    'the script must say that missing compiler is a resource condition, not a pass')
})

test('v143: the gate is reachable — the script runs on the real tree and names the move-only code', (t) => {
  if (!requireCompiler(t)) return
  const { code, out } = run([])
  assert.equal(code, 0, `the budget must hold on the current tree; got:\n${out}`)
  assert.match(out, /2459 \(imported-but-not-exported\): 0/u)
  assert.match(out, /OK — every touched file is at or under its frozen baseline/u)
})
