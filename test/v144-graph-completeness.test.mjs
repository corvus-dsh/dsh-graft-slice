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
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
   * 所以这里真的制造一条解析不到的边，确认 exit 1，然后恢复。
   * 恢复必须被验证 —— 一个留下注入的测试比没有测试更糟。
   */
  const target = join(ROOT, 'src', 'core', 'layout.ts')
  const before = readFileSync(target, 'utf8')
  assert.equal(run().code, 0, 'precondition: the tree must be green before the injection')

  try {
    writeFileSync(target, "import { __nothing } from './__does-not-exist.js'\n" + before, 'utf8')
    const { code, out } = run()
    assert.equal(code, 1, `an unresolvable import must fail the check; got:\n${out}`)
    assert.match(out, /graph is incomplete|proves nothing/u,
      'the failure must say WHY a partial graph is useless, not just that something is missing')
    assert.match(out, /__does-not-exist/u, 'the failure must name the offending specifier')
  } finally {
    writeFileSync(target, before, 'utf8')
  }

  assert.equal(run().code, 0, 'the restore must leave the tree green')
})
