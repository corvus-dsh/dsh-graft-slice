/**
 * ── v144: 依赖图的完整性 —— ACYCLIC 不能建立在不认识的边上 ────────────────────────────────────────
 *
 * 用户发现（2026-11-12）：`check-cycles.mjs` 打印
 *
 *     unresolved: 1
 *     contracts\model-wording.contracts.ts -> ./model-wording.ts
 *     ACYCLIC — no dependency cycle
 *
 * 两行并列出现。**如果那条未解析的边恰好是环的一部分，ACYCLIC 就是错的** ——
 * 而它看起来是绿的。这是「仪器测的不是它以为的东西」最恶劣的一种：结论覆盖的范围比声明的小。
 *
 * 根因：解析器只剥离 `.js`，于是 `./model-wording.ts` 变成 `model-wording.ts.ts`，解析失败。
 * 那个 `.ts` 是**刻意的**（该文件被测试直接加载，Node 不做 `.js`→`.ts` 重写），
 * 所以它不是异常，而是这个仓库的一种合法 import 形状 —— 解析器本来就该认识。
 *
 * 修法两件事：
 *   ① 解析器认识 `.ts` 扩展名（边数 63 → 64，那条边真的进了图）；
 *   ② **未解析的边从「脚注」升级为「失败」** —— 部分图上的环检查什么也证明不了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'check-cycles.mjs')
const SOURCE = readFileSync(SCRIPT, 'utf8')

const run = () => {
  try {
    const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('v144: on the real tree every relative import resolves — unresolved must be 0', () => {
  /**
   * 这条断言是 ⑤ 的直接落实：门禁的绿色结论必须覆盖它看见的每一条边。
   * 断言 unresolved === 0，而不是「<= 某个数」：一条都不许有。
   */
  const { code, out } = run()
  assert.equal(code, 0, `the cycle check must be green; got:\n${out}`)
  assert.match(out, /unresolved: 0/u,
    `every relative import must resolve to a file; got:\n${out}`)
  assert.match(out, /every relative import resolved to a file/u,
    'the ACYCLIC line must state that the graph was COMPLETE, not just that no cycle was found')
})

test('v144: the resolver understands a `.ts` specifier (that shape is deliberate here)', () => {
  /**
   * `src/contracts/model-wording.contracts.ts` imports `./model-wording.ts` on purpose:
   * the test loads the `.ts` file directly, and Node does not rewrite `.js` → `.ts`.
   * Measured the other way: with `.js` the type checker is happy but the test dies with
   * ERR_MODULE_NOT_FOUND. So the resolver has to accept `.ts`, or the graph is permanently partial.
   */
  assert.match(SOURCE, /replace\(\/\\\.\(\?:js\|ts\)\$\/u/u,
    'the resolver must strip either extension before appending .ts')
  assert.match(SOURCE, /DELIBERATE|deliberate|刻意/u,
    'the source must record that the `.ts` specifier is deliberate, not a typo')
})

test('v144: an unresolved edge is a FAILURE, not a footnote — and that is proven by injection', () => {
  /**
   * 只断言 `unresolved === 0` 是不够的：如果脚本永远打印 0，它也会通过。
   * 所以这里真的制造一条解析不到的边，确认 exit 1。
   *
   * ── 注入必须发生在**副本**里，不能碰真实 src/ ─────────────────────────────────────────────────
   *
   * 实测：第一版直接改 `src/core/layout.ts` 再在 `finally` 里恢复。Node 的测试运行器**并行跑文件**，
   * 于是别的测试在这段窗口里读到一棵坏树 —— 整套测试间歇性地报 “v144 失败”，而 v144 单跑是绿的。
   * **会改真实树的测试 = 会让别的测试失败的测试。**
   *
   * 症状为什么总落在 v144 自己头上：`node --test` 每次只把"某个文件失败"报出来，而失败的判定取决于
   * 谁恰好在那几毫秒里扫了 src/。所以真正的受害者可能是**任何一个**读树的测试
   * （`check-cycles` / `closure` / `build` / 计数门禁），只是 v144 的名字被印出来了。
   *
   * 同一缺陷当时还有两处（2026-11-12 一并修掉）：
   *   · `test/v141-who-references.test.mjs` 把 `__v141-probe.ts` 写进真实 `src/core/`
   *     → 现用 `GRAFT_WHO_REFS_SRC` 指向副本；
   *   · `test/v138-move-gate.test.mjs` 把 `__v138-c4-probe.ts` 写进真实 `src/core/`
   *     → 现用 `GRAFT_MOVE_GATE_SRC` 指向副本（并转发给 closure.mjs 的 `GRAFT_CLOSURE_SRC`）。
   *   加上 `scripts/calibrate-who-references.mjs` 自带沙箱，现在**没有任何测试或仪器往真实 src/ 写**。
   *
   * 判据不是"单跑绿"，是"整套并行连跑 5 次全绿"—— 单跑绿恰恰是这个缺陷的原始症状。
   *
   * 现在：把 src/ 复制到临时目录，在副本里注入，用 `GRAFT_CHECK_CYCLES_SRC` 指向它。
   * 真实树全程不被触碰，副本用完即删。
   */
  assert.equal(run().code, 0, 'precondition: the real tree must be green')

  const sandbox = mkdtempSync(join(tmpdir(), 'v144-'))
  const copied = join(sandbox, 'src')
  try {
    cpSync(join(ROOT, 'src'), copied, { recursive: true })
    const target = join(copied, 'core', 'layout.ts')
    const before = readFileSync(target, 'utf8')
    writeFileSync(target, "import { __nothing } from './__does-not-exist.js'\n" + before, 'utf8')

    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GRAFT_CHECK_CYCLES_SRC: copied },
      })
    } catch (error) {
      code = error.status ?? 1
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    assert.equal(code, 1, `an unresolvable import must fail the check; got:\n${out}`)
    assert.match(out, /graph is incomplete|proves nothing/u,
      'the failure must say WHY a partial graph is useless, not just that something is missing')
    assert.match(out, /__does-not-exist/u, 'the failure must name the offending specifier')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }

  // and the real tree was never touched
  assert.equal(run().code, 0, 'the real tree must be green after the sandbox run')
})
