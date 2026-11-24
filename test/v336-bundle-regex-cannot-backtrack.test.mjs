/**
 * ── v336 / A4b：换掉那个会爆炸的正则，而不是围住它（lead §四十三.4）──────────────────────────────
 *
 * 路径：**根因处**（`scripts/bundle.mjs`）+ **真实构造输入**（50 行 import 块喂 `composeBundle`）。
 *
 * ── 为什么 A4 不够 ──────────────────────────────────────────────────────────────────────────────
 *
 * A4 把看门狗放进了 `build.mjs`，但检查点是 `composeBundle` **返回之后**。而灾难性回溯的定义就是
 * **不返回** —— 所以看门狗抓的是「慢但返回」，抓不到「挂死」。
 *
 * 我在 A4 的注释里自己写着 `cannot interrupt a single hanging call`，也知道正确答案（排查顺序第 3 条：
 * 「换成无界但有锚点的形式」），**却把答案只写进了错误消息里**。
 *
 * > **看门狗的位置决定了它能看见什么。** 把超时检查放在「工作返回之后」，
 * > 就永远看不见「工作不返回」—— 而那正是它被造出来要抓的那一件事。
 *
 * 判据（三条，一条负向）：
 *   ① `bundle.mjs` 不得再出现 `{0,N}?` 配 `[^\n]*` 的形状（grep 级：那个组合就是回溯的配方）
 *   ② **负向** 正常构建仍通过，且 `index.js` **逐字节不变**（证明换正则没改坏产物）
 *   ③ **can-red 的反面**：构造 **50 行** import 块喂 `composeBundle` ⇒ **必须 1 秒内返回**
 *      —— 这一条才是真正测「不炸」的；A4 的四条都是源码形状断言，测不到
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = await import(pathToFileURL(join(ROOT, 'scripts', 'bundle.mjs')).href)

test('v336 ①: the catastrophic-backtracking SHAPE is gone from bundle.mjs', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8')
  /**
   * The shape, not one spelling: a lazy `{0,N}?` repeated over a `[^\n]*` item. That combination is what
   * backtracks; naming `LOCAL_BRACKETED` alone would let the next block-bounded regex slip in.
   *
   * COMMENTS ARE EXEMPT — and not for convenience: the module header has to be able to QUOTE the shape it
   * documents. Measured on the first run: without this, ① failed on its own explanation. Same distinction
   * as `v326 ⑤` (「允许被提及、不许被采纳」).
   */
  const codeOnly = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
    })
    .join('\n')

  const offenders = [...codeOnly.matchAll(/\{0,\d+\}\?/gu)].map((match) => {
    const lineStart = codeOnly.lastIndexOf('\n', match.index) + 1
    const lineEnd = codeOnly.indexOf('\n', match.index)
    return codeOnly.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
  })
  assert.deepEqual(offenders, [], `① 不得再有「数字上限 + 懒量词」的块匹配：\n${offenders.join('\n')}`)
})

test('v336 ② (negative): replacing the regex must not change a single byte of the artifact', () => {
  /**
   * A criterion about 「the regex is safer」 that silently changed the output would be a worse trade: the
   * shipped file IS the product. The hash is asserted against the committed `index.js`, which
   * `check-artifact-fresh` independently pins to the source.
   */
  const committed = readFileSync(join(ROOT, 'index.js'))
  const rebuilt = BUNDLE.composeBundle(ROOT).output
  assert.equal(
    createHash('sha256').update(committed).digest('hex'),
    createHash('sha256').update(rebuilt).digest('hex'),
    '② 换正则后产物必须逐字节相同 —— 否则「更安全」是用改坏产物换来的',
  )
})

test('v336 ③ (THE REAL ONE): a 50-line import block must return in under a second', () => {
  /**
   * This is what A4 could not do. The old `{0,40}?` regex did not merely miss a 50-line block — it
   * backtracked for every start position and **never returned**. So the criterion must FEED the shape and
   * assert the answer arrives.
   *
   * It builds a throwaway package with one 50-line import block and times `composeBundle` on it.
   */
  const root = mkdtempSync(join(tmpdir(), 'v336-bundle-'))
  try {
    const src = join(root, 'src')
    mkdirSync(join(src, 'core'), { recursive: true })

    /* A module with 50 named exports, then one module importing all 50 across 50 lines. */
    const names = Array.from({ length: 50 }, (_unused, index) => `export const value${index} = ${index}\n`).join('')
    writeFileSync(join(src, 'core', 'wide.ts'), names, 'utf8')
    const importLines = Array.from({ length: 50 }, (_unused, index) => `  value${index},`).join('\n')
    writeFileSync(
      join(src, 'core', 'consumer.ts'),
      `import {\n${importLines}\n} from './wide.js'\n\nexport const total = value0 + value49\n`,
      'utf8',
    )
    writeFileSync(
      join(src, 'index.ts'),
      `import { total } from './core/consumer.js'\n\nexport const answer = total\n`,
      'utf8',
    )

    const started = Date.now()
    const { output } = BUNDLE.composeBundle(root)
    const elapsed = Date.now() - started

    assert.ok(elapsed < 1000, `③ 50 行 import 块必须在 1 秒内返回；实测 ${elapsed}ms（这就是挂死的那次）`)
    assert.match(output, /value49/u, '③ 且那 50 个名字必须真的被内联 —— 快速返回一个漏掉内容的产物不算通过')
    assert.equal(output.includes("from './core/wide.js'"), false, '③ 相对 import 不得残留')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})