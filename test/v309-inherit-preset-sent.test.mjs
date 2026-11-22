/**
 * ── v309 / B4-B TD-26 (P1): graft 侧 —— 解析出来的值必须出现在发往 paradise 的参数里 ──────────────────
 *
 * 用户原话（派工单 §十六 TD-26）：**「`index.ts:8276` 的唯一用法是
 * `...(sourceAgentPreset === undefined ? {} : { inheritFrom: sourceId })` —— 判的是『有没有』，传的是
 * `sourceId`。」** 判据 ②：**「一条断言『值真的进了目标 header』，不是『函数收到了参数』。」**
 *
 * ── 为什么这条判据分两层，而不是一层端到端 ───────────────────────────────────────────────────────
 *
 * 「值真的进了目标 header」需要两个仓同时在场：graft 负责**解析并发送**，paradise 负责**写进 header**。
 * 端到端地测它，就意味着在 graft 的单测里搭一个能通过 `COLD_READ_MISMATCH` / seq 校验 / header 结构的
 * 假持久层 —— 而那条路径上的三次尝试，失败原因全都与被测的那件事无关（`PARADISE_WRITE_UNAVAILABLE`、
 * `session not found`、`cold-read event 0 has seq undefined`）。
 *
 * **一个为了让夹具通过而写的假宿主，测的是那个假宿主。** 所以拆成两层，每层在自己的仓里用真实运行的东西：
 *
 *   · 本文件（graft）：`sourceAgentPreset` 的**解析结果**出现在 `paradise.session.create` 的实参里；
 *   · `dsh-paradise/test/v288`：那个实参被写进目标 header 的 `meta.agentPreset`（读 header，不是读回执）。
 *
 * 两层合起来等价于端到端断言；分开写则每一层都跑在自己仓的真实宿主上。
 *
 * 本层用**源码级**判据（读 `src/index.ts`），因为要被证明的是「这个表达式把哪个变量传了出去」——
 * 那是一个关于代码的事实，不是一个关于运行的事实。同族先例：`v136` 的 import 边、`v130` 的模块上限。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SOURCE = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')

/** The `paradise.session.create({...})` argument list, as written. */
function createArgumentList() {
  const marker = 'paradise.session.create({'
  const start = SOURCE.indexOf(marker)
  assert.ok(start >= 0, 'the create call must exist')
  // Walk to the matching close brace: the argument object is multi-line.
  let depth = 0
  for (let i = start + marker.length - 1; i < SOURCE.length; i += 1) {
    const ch = SOURCE[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return SOURCE.slice(start + marker.length, i)
    }
  }
  assert.fail('the create argument list was never closed')
}

/**
 * Strip comments before matching.
 *
 * Measured: the `doesNotMatch` below fired on the OLD CODE QUOTED IN A COMMENT — the fix's own
 * explanation of what it replaced. A criterion that cannot tell prose from code punishes the
 * documentation that makes the fix reviewable, which is the opposite of what it is for.
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

test('v309 TD-26 ①: the RESOLVED preset is what is sent — not just its presence', () => {
  const args = codeOnly(createArgumentList())

  /**
   * The defect, verbatim: the value was tested and `sourceId` was sent.
   *
   *     ...(sourceAgentPreset === undefined ? {} : { inheritFrom: sourceId }),
   *
   * This assertion fails on exactly that source text, which is the point: it is the mechanical version of
   * the dispatch's observation.
   */
  assert.match(args, /inheritPreset\s*:\s*sourceAgentPreset/u,
    '发给 paradise 的 inheritPreset 必须是 sourceAgentPreset 本身；' +
      `实测参数列表：\n${args.slice(0, 600)}`)

  assert.doesNotMatch(args, /sourceAgentPreset === undefined \? \{\} : \{ inheritFrom: sourceId \}/u,
    '旧的「只判有没有」的写法必须已经不存在')

  // `inheritFrom` stays: it is the id-based runtime read, a different fact from the preset value.
  assert.match(args, /inheritFrom\s*:\s*sourceId/u,
    'inheritFrom 仍然传 id —— 两个参数是两件事，不是一件事的两种说法')
})

test('v309 TD-26 ③ (negative half): when nothing resolves, the argument is ABSENT', () => {
  const args = createArgumentList()
  /**
   * The spread must still be conditional. A fabricated empty string would look identical downstream
   * (paradise ignores `''`) while hiding that graft resolved nothing — the failure mode where 「absent」
   * and 「present but empty」 become one value.
   */
  assert.match(args, /sourceAgentPreset === undefined/u,
    '没有解析出 preset 时必须走「缺席」分支，而不是发一个空值')
  assert.match(args, /\?\s*\{\}/u, '缺席分支必须是空展开（不是空字符串）')
})
