/**
 * ── v333 / A3：临时诊断出口不得留下（lead §四十一）────────────────────────────────────────────────
 *
 * 路径：**源码形状断言**（`src/` 全树 + 打包产物）。
 *
 * ── 为什么需要一条专门判据 ──────────────────────────────────────────────────────────────────────
 *
 * 方案 A 的收敛条件写着「用完即删」。但**没有「删掉它」的判据，它一定会留下来** —— 本批已经见过
 * 一次同类（`void reservedOutputTokens` 那种「接受并忽略」的输入，留了整整一个版本）。
 *
 * 临时设施的危险不是它占地方，是**它会被当成常设能力**：下一个人看到 `GRAFT_DEBUG_PRE_STEP`，
 * 会以为这是产品的一个调试开关，于是开始依赖它的输出格式。
 *
 * 判据（三条，两条负向）：
 *   ① `src/` 全树不得出现 `GRAFT_DEBUG_PRE_STEP`
 *   ② **负向** 打包产物 `index.js` 也不得出现（`src/` 干净但 bundle 陈旧 = 它还在跑）
 *   ③ **负向** `core/pre-step-diagnostic.ts` 不得存在（删了调用、留了文件，等于留了口子）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = 'GRAFT_DEBUG_PRE_STEP'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

test('v333 ①: the diagnostic marker is GONE from src/', () => {
  const offenders = walk(join(ROOT, 'src')).filter((file) => readFileSync(file, 'utf8').includes(MARKER))
  assert.deepEqual(
    offenders.map((file) => relative(ROOT, file).replace(/\\/gu, '/')),
    [],
    '① 临时诊断出口必须删掉 —— 留着它，下一位读者会把它当成产品开关',
  )
})

test('v333 ② (negative): the shipped bundle must not carry it either', () => {
  const bundle = join(ROOT, 'index.js')
  if (!existsSync(bundle)) return
  assert.equal(
    readFileSync(bundle, 'utf8').includes(MARKER),
    false,
    '② `src/` 干净但 bundle 陈旧 —— 那说明它还在跑，只是源头删了',
  )
})

test('v333 ③ (negative): the diagnostic MODULE is deleted, not just unlinked', () => {
  assert.equal(
    existsSync(join(ROOT, 'src', 'core', 'pre-step-diagnostic.ts')),
    false,
    '③ 删了调用但留了文件，等于留了一个没人管的口子；它必须整个消失',
  )
})