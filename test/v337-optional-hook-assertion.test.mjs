/**
 * ── v337 / A5：测试里用 `?.(` 调导出钩子，必须配一条「该钩子存在」的断言 ──────────────────────────
 *
 * 路径：**判据级**（扫 test/*.test.mjs 的源码，不是跑某个功能）。
 *
 * ── 事故（lead §四十二.4，同一形状的第二次）────────────────────────────────────────────────────
 *
 * `plugin.resetAdvisoryStateForTest?.()` —— 钩子在打包裁剪中被删掉，`?.()` **静默跳过**，
 * 于是 `v332 ③` 单独跑是绿的、进套件才红。判据在场、断言在场、绿灯在场，
 * **而被测的那个接缝不在**。
 *
 * 同一形状在 memory / observer 里出现过一次（`ctx.on?.(` 让事件数被数成 0），
 * 所以这不是一次性事故，是一个**语法级的藏身处**：可选调用把「不存在」变成「没发生」，
 * 两者在测试里看起来一样。
 *
 * ── 为什么不能一刀切禁 `?.(` ───────────────────────────────────────────────────────────────────
 *
 * 仓库里有一批**合法**的可选调用：`await realFlush?.(...args)` 里的 `realFlush` 是
 * `const realFlush = handle.flush` —— 一个**测试本地的变量**，不是包导出的钩子。
 * 宿主句柄没有 `flush` 是真实可能，可选调用在那里是正确的防御，不是藏身处。
 *
 * 所以判据的对象是明确的：**`plugin.<name>?.(` 与 `ctx.<name>?.(` 这类「调包/宿主暴露的钩子」
 * 的写法**。禁一个词与禁一个主张不是同一件事（v335 ② 的教训）。
 *
 * ── 判据（三条，两条负向）────────────────────────────────────────────────────────────────────
 *
 *   ① 正：扫到的每一处 `plugin.X?.(` / `ctx.X?.(`，同文件里都必须有 `X` 的**存在性断言**
 *      （`typeof … === 'function'`、`… !== undefined`、`assert.ok(… X …)` 之类）
 *   ② **负向** 扫描必须真的扫到东西 —— 一处都没有时这条判据说明「本仓没有可选钩子调用」，
 *      而不是「全都没问题」。空集不许当通过。
 *   ③ **负向** 判据本身可红：喂一段**没有**存在性断言的样例必须被判为违规
 *      （否则它只是「读了文件、点了头」）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = join(ROOT, 'test')

/**
 * Only OPTIONAL CALLS ON PACKAGE/HOST OBJECTS are in scope.
 *
 * `realFlush?.(` is deliberately NOT matched: `realFlush` is a bare local, and the prefix
 * requirement (`plugin.` / `ctx.`) is what separates "a hook that may be absent from the artifact"
 * from "a defensive call on a value the test itself owns".
 */
const OPTIONAL_HOOK_CALL = /\b(plugin|ctx)\.([A-Za-z_$][\w$]*)\?\.\(/gu

/** A statement that FAILS LOUDLY when the hook is missing — the point of the criterion. */
const hasExistenceAssertion = (source, hook) => {
  const escaped = hook.replace(/[$]/gu, '\\$')
  const patterns = [
    new RegExp(`typeof\\s+(?:plugin|ctx)\\.${escaped}\\s*===\\s*['"]function['"]`, 'u'),
    new RegExp(`typeof\\s+(?:plugin|ctx)\\.${escaped}\\s*!==\\s*['"]undefined['"]`, 'u'),
    new RegExp(`(?:plugin|ctx)\\.${escaped}\\s*!==\\s*undefined`, 'u'),
    new RegExp(`assert\\.(?:ok|equal|strictEqual)\\([^)]*\\b${escaped}\\b`, 'u'),
  ]
  return patterns.some((pattern) => pattern.test(source))
}

/** Every `plugin./ctx.` optional call in a file, with the hook name and line. */
function optionalHookCalls(source) {
  const out = []
  for (const match of source.matchAll(OPTIONAL_HOOK_CALL)) {
    /**
     * COMMENTS ARE EXEMPT, and not for convenience: the files that DOCUMENT this failure mode have to
     * quote the shape (`ctx.on?.(` is named in `lifecycle-dispose` and `v325` headers as the thing to
     * beware of). Measured on the first run: without this, ① failed on its own explanation plus three
     * header comments. Same distinction as `v336 ①` (「允许被提及、不许被采纳」).
     */
    const lineStart = source.lastIndexOf('\n', match.index) + 1
    const lineEnd = source.indexOf('\n', match.index)
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    const trimmed = line.trimStart()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    out.push({ hook: match[2], line: source.slice(0, match.index).split('\n').length })
  }
  return out
}

test('v337 ①: every optional hook call has a matching existence assertion', () => {
  const offences = []
  let scanned = 0
  for (const name of readdirSync(TEST_DIR).filter((entry) => entry.endsWith('.test.mjs')).sort()) {
    const source = readFileSync(join(TEST_DIR, name), 'utf8')
    for (const call of optionalHookCalls(source)) {
      scanned += 1
      if (!hasExistenceAssertion(source, call.hook)) {
        offences.push(`${name}:${call.line}  ${call.hook}?.( … ) 没有存在性断言`)
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    `① 这些可选调用会把「钩子不存在」伪装成「什么都没发生」：\n${offences.join('\n')}\n` +
      '修法：在同文件里加一条 typeof plugin.X === \'function\' 之类的断言；' +
      '或者——如果这个钩子本来就该常驻——去掉 ?. 让它红。',
  )
  /**
   * ② NEGATIVE HALF: an empty scan must SAY it is empty, not pass silently.
   *
   * If this repository ever stops using `plugin.X?.(`, criterion ① becomes vacuously true. That is
   * exactly the shape this batch keeps finding: a green that no longer measures anything. So the
   * count is asserted against zero explicitly and reported.
   */
  assert.ok(
    scanned > 0,
    '② 扫描到 0 处可选钩子调用 —— ① 此刻是空集通过，不能当作「全都没问题」。' +
      '若本仓确实改用别的写法，请把本判据换成新写法的判据，而不是留着一条永远绿的。',
  )
})

test('v337 ③ (negative): the checker can actually fail — a sample without the assertion is caught', () => {
  /**
   * This is the half that makes ① meaningful. A checker that reads files and nods has the same
   * defect as the code it was written to catch. The sample below is the exact v332 self-harm.
   */
  const offending = [
    "import test from 'node:test'",
    'test("x", () => {',
    '  plugin.resetAdvisoryStateForTest?.()',
    '})',
  ].join('\n')
  const calls = optionalHookCalls(offending)
  assert.equal(calls.length, 1, '③ 样例里的可选调用必须被扫到（扫不到就说明正则没工作）')
  assert.equal(
    hasExistenceAssertion(offending, calls[0].hook),
    false,
    '③ 没有存在性断言的样例必须被判为违规 —— 否则本判据只是「读了文件、点了头」',
  )

  const repaired = [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    'test("x", () => {',
    "  assert.equal(typeof plugin.resetAdvisoryStateForTest, 'function')",
    '  plugin.resetAdvisoryStateForTest?.()',
    '})',
  ].join('\n')
  assert.equal(
    hasExistenceAssertion(repaired, 'resetAdvisoryStateForTest'),
    true,
    '③ 补上存在性断言之后必须能判为合规（不然修法本身不被承认）',
  )
})
