/**
 * ── v334 / A4：`build.mjs` 的看门狗**设施**（lead §四十三.2 降级为文案与常量检查）──────────────
 *
 * 路径：**源码形状断言**（`assert.match(source, …)`）—— **本文件不覆盖「挂死时能否报出」**
 * （见下面的边界声明）。
 *
 * ── 边界：这条判据证明什么，不证明什么 ──────────────────────────────────────────────────────────
 *
 * 老板核出的事实：`build.mjs` 的看门狗检查点在 `composeBundle` **返回之后**，而灾难性回溯的定义
 * 就是**不返回**。所以它抓得到「慢但返回」，**抓不到「挂死」**。
 *
 * 我自己的注释里就写着 `cannot interrupt a single hanging call`，也知道正确答案
 * （排查顺序第 3 条：换成无界但有锚点的形式），**却把答案只写进了错误消息里**。
 *
 * > **看门狗的位置决定了它能看见什么。** 把超时检查放在「工作返回之后」，
 * > 就永远看不见「工作不返回」—— 而那正是它被造出来要抓的那一件事。
 *
 * 所以本文件**降级**为「文案与常量检查」（同 `v102` / `v322` 的处置），并在文件头写明它不覆盖
 * 挂死行为。**真正的「不炸」由 `v336 ③` 覆盖**：它构造 50 行 import 块喂 `composeBundle` 并要求
 * 1 秒内返回 —— 把旧正则放回去时它**卡了 190 秒**，这是「不返回」的确凿证据。
 *
 * 判据（四条，两条负向）：文案/常量/耗时输出/无第二个 build 脚本。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('v334 ①: the happy path prints elapsed time (「fast」 and 「skipped」 must differ)', () => {
  assert.match(source, /in \$\{Math\.round/u, '① 正常路径必须打印耗时')
  assert.match(source, /process\.exit\(1\)/u, '① 失败必须以非零退出')
})

test('v334 ② (negative): a timeout must NAME the likely cause, not just report 「timeout」', () => {
  /**
   * 「超时了」 sends the next reader to look at machine speed. The cause was a REGEX, and the message has
   * to say so plus the search order — otherwise CI hits the same hang and nobody knows where to look.
   */
  assert.match(source, /回溯/u, '② 必须点名「回溯」')
  assert.match(source, /排查顺序/u, '② 必须给出排查顺序')
  assert.match(source, /TIMEOUT/u, '② 超时必须以 TIMEOUT 字面报告，不许静默')
})

test('v334 ③ (negative): the stage is reported, so 「where it hung」 is answerable', () => {
  assert.match(source, /stage/u, '③ 必须报告挂在哪一段 —— 只说超时，读者无从下手')
  assert.match(source, /stage = 'composeBundle'/u, '③ 最危险的那一段必须被点名')
})

test('v334 ④: the ceiling is a verifiable constant, and no second build script exists', () => {
  assert.match(source, /BUDGET_MS\s*=\s*120_000/u, '④ 上限必须是可核验的常量 120_000')
  assert.equal(
    existsSync(join(ROOT, 'scripts', 'build-with-timeout.mjs')),
    false,
    '④ 不得再有第二个 build 脚本 —— 豁免名单只能有两个，第三条会被自己的守卫拒绝',
  )
  assert.match(String(manifest.scripts?.check ?? ''), /^node scripts\/build\.mjs/u, '④ check 的第一步仍是 build.mjs')
})