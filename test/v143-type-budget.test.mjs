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
const TYPE_CHECK = join(ROOT, 'scripts', 'type-check.mjs')
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

test('v143: environment defects are counted SEPARATELY from code defects', (t) => {
  /**
   * ── 用户裁定：33 条缺 @types/node 的诊断与代码无关，必须单列 ────────────────────────────────
   *
   * 判据是诊断在说什么，不是「我记得哪几个 code」：
   *   2307 解析不到 node 内置模块的类型声明
   *   2580 找不到 node 全局 process
   * 两者都只在 package.json 声明 @types/node 之后才消失，**改代码永远改不掉**。
   *
   * 为什么非要分开：混在一张表里，下一个读表的人会想把 61 清到 0，而其中 33 条的修法不是改代码 ——
   * 与之前「196 里 33 条是环境问题」那次混乱同一个坑。
   *
   * 为什么预算表也必须用同一套判据：否则「某文件被触及后数字变了」会反映一个与本提交无关的原因。
   */
  if (!requireCompiler(t)) return

  const out = execFileSync(process.execPath, [TYPE_CHECK], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  assert.match(out, /CODE HEALTH: (\d+) diagnostic/u, 'the summary must state a code-health count')
  assert.match(out, /ENVIRONMENT: (\d+) diagnostic/u, 'the summary must state an environment count separately')
  assert.match(out, /NOT code defects, @types\/node would retire them/u,
    'the environment line must say they are not code defects and how they would go away')
  assert.match(out, /do NOT "fix" these by editing code/u,
    'the summary must warn against "fixing" them in code')

  const codeHealth = Number(/CODE HEALTH: (\d+)/u.exec(out)?.[1])
  const environment = Number(/ENVIRONMENT: (\d+)/u.exec(out)?.[1])
  const artifact = Number(/COMPILER ARTIFACT: (\d+)/u.exec(out)?.[1] ?? '0')
  const total = Number(/type-check: (\d+) diagnostic/u.exec(out)?.[1])

  /**
   * ── 三类互斥，合起来才是全部 ────────────────────────────────────────────────────────────────────
   *
   * 早先这条断言写的是 `code + environment === total`，加了「编译器产物」这一类之后它必然失败 ——
   * 而失败的原因是**分类变细了**，不是有诊断丢了。这正是「断言的主语写错」那一族：
   * 要钉的是「每条诊断恰好落进一类」，不是「只有两类」。
   */
  assert.equal(codeHealth + environment + artifact, total,
    `code (${codeHealth}) + environment (${environment}) + compiler artifact (${artifact}) ` +
    `must equal the total (${total}) — every diagnosis belongs to exactly one bucket`)
  assert.ok(environment > 0, 'the environment bucket must not be silently empty')
  assert.match(out, /strict:true reports 0 here/u,
    'the compiler artifact must state that a STRICTER setting reports nothing here — ' +
    'otherwise a reader concludes the code is wrong')

  /**
   * 预算的 `--baseline` 必须用同一口径：它的 code total 要等于 type-check 的 CODE HEALTH，
   * 而不是全部诊断数。两个工具各说各话是最容易漏的一类不一致。
   */
  const { out: budgetOut } = run(['--baseline'])
  const budgetCodeTotal = Number(/code total: (\d+)/u.exec(budgetOut)?.[1])
  assert.equal(budgetCodeTotal, codeHealth,
    `type-budget's baseline (${budgetCodeTotal}) must match type-check's CODE HEALTH (${codeHealth})`)
})

test('v143: the CI step exists, and when it cannot measure the LOG SAYS SO', () => {
  /**
   * ── 「A GATE NOBODY RUNS IS A COMMENT」这次不许第三次成立 ─────────────────────────────────────
   *
   * 用户裁定（2026-11-12）：先把 v143 接进 CI，不要先清存量。理由是这不是理论：
   * `check-cycles` 写死了 `D:/` 路径，**本机每次过、CI 每次红**，因为它当时没进 CI（#118）。
   * v143 之前处于同一状态 —— 15 条清完，但下一个人的改动把错误从 15 涨到 20，CI 不会红。
   *
   * 两个错误处置方式，都必须被这条测试挡住：
   *   ① 给 CI 装 typescript → 15 条错误变成每次 push 全红，正是用户否决的「CI 永远红」；
   *   ② 缺编译器时静默 `exit 0` → 没跑的东西看起来像通过了。
   *
   * 正确：报告 RESOURCE 并 exit 0，**但日志必须说这次没检查**。
   */
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

  assert.match(ci, /node scripts\/type-budget\.mjs/u,
    'ci.yml must actually run the budget — a gate nobody runs is a comment')

  const step = /- name: Incremental type budget[\s\S]*?(?=\n {6}- name:|\n {2}[\w-]+:|\s*$)/u.exec(ci)?.[0] ?? ''
  assert.ok(step.length > 0, 'the budget step must be findable in ci.yml')

  // ① must NOT install the compiler just to make the gate绿
  assert.doesNotMatch(step, /npm (?:install|i) .*typescript/u,
    'the step must not install typescript — that turns the gate into an always-red build')

  // ② the RESOURCE branch must be honest, not silent
  assert.match(step, /-eq 2/u, 'the step must branch on exit 2 (the RESOURCE condition)')
  assert.match(step, /NOT CHECKED/u, 'the log must say the check did NOT happen')
  assert.match(step, /not a pass/u, 'the log must say this is not a pass')
  assert.match(step, /was NOT verified/u, 'the log must name the consequence: the baseline was not verified')

  // ③ a real failure must still propagate (not be swallowed by the RESOURCE branch)
  assert.match(step, /exit "\$code"/u, 'a non-zero, non-2 exit must propagate so CI can fail')
})

test('v143: the baseline number declares its SCOPE — 15 is not "type health"', (t) => {
  /**
   * ── 用户裁定（2026-11-12）：基线 15 是 strict:false 口径，不是类型健康度 ───────────────────────
   *
   * `strict: false` 容忍隐式 any、不做 null/undefined 检查、容忍双变。所以：
   *   · 「15」= 宽松模式下有几个错，**不是**「还剩几个错」；
   *   · 「清到 0」只意味着「连宽松检查都过了」，**不意味着类型安全**。
   *
   * 实测同一份 src/ 只改 strict：false → 49，true → 58（9 条隐式 any + 1 条 null 检查只在 true 出现）。
   *
   * 不切 strict:true（会 58 条一次全红）。但这句警告必须在**输出里**，不能只在注释里：
   * 注释只有改脚本的人读，跑门禁的人只看输出。
   */
  if (!requireCompiler(t)) return

  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /宽松模式下的可见缺陷，不是「类型健康度」/u,
    'the BASELINE comment must say what the number measures')
  assert.match(source, /strict: false → 49 条[\s\S]{0,80}strict: true → 58 条/u,
    'the comment must carry the measured strict delta, not a remembered one')

  const { out } = run([])
  assert.match(out, /measured under strict:false/u,
    'the RUN OUTPUT must declare the scope — the comment is not enough')
  assert.match(out, /not "type health"/u,
    'the output must say the number is not a health metric')
  assert.match(out, /strict:true reports 58/u,
    'the output must name what a stricter setting would report')
  assert.match(out, /not "types are correct"/u,
    'the output must say reaching 0 does not mean the types are correct')
})

test('v143: the gate is reachable — the script runs on the real tree and names the move-only code', (t) => {
  if (!requireCompiler(t)) return
  const { code, out } = run([])
  assert.equal(code, 0, `the budget must hold on the current tree; got:\n${out}`)
  assert.match(out, /2459 \(imported-but-not-exported\): 0/u)
  assert.match(out, /OK — every touched file is at or under its frozen baseline/u)
})
