/**
 * ── v334 / A4：`build` 不得无声挂死（lead §四十二.3）────────────────────────────────────────────
 *
 * 路径：**check 链的第一步本身**（`scripts/build.mjs`）—— 不是新脚本、不是新 CI 步骤。
 *
 * ── 事故 ──────────────────────────────────────────────────────────────────────────────────────
 *
 * `bundle.mjs` 的 `LOCAL_BRACKETED` 用 `(?:[ \t]+[^\n]*\n){0,40}?` 限制 import 块高 40 行。
 * 一个块长到 **42 行**后正则失配，懒量词配 `[^\n]*` 触发**灾难性回溯**：
 *
 *     node scripts/build.mjs  →  无限挂起，零输出
 *
 * 它是 `npm run check` 的**第一步**：挂在这里，后面每一条门禁都变成「未验证」。
 *
 * ── 为什么把看门狗放进 build.mjs，而不是另写一个包装脚本 ─────────────────────────────────────────
 *
 * 第一版写成了 `build-with-timeout.mjs` 并接进 `check` 链。`check-check-parity` 立刻指出它没有 CI 步骤，
 * 而我把 `NOT_REQUIRED_IN_CI` 扩到三项时，**它自己的守卫又拒绝了**：
 *
 *     build-with-timeout.mjs is in NOT_REQUIRED_IN_CI but is not a build step —
 *     the exemption list may only hold the two build scripts
 *
 * **那条守卫是对的**：一份豁免名单如果能为每个新脚本各加一行，它就不再是名单，而是「目前所有脚本」。
 * 所以正确做法是把超时放进 `build.mjs` 自身 —— 一处改动，`check` 与 `ci.yml` 都不用动。
 *
 * 判据（四条，三条负向）：
 *   ① 正常路径 exit 0，并打印**耗时**（否则「很快」与「被跳过」不可区分）
 *   ② **负向** 超时时输出点名「回溯」与三步排查顺序 —— 不许只说「超时了」
 *   ③ **负向** 不得再出现第二个 build 脚本（豁免名单只能有两个）
 *   ④ 上限是 120 s 的可核验常量
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