/**
 * ── v313 / USER-REPORTED (P0): 转生控制台的读取必须并发，否则它先于宿主超时 ────────────────────────
 *
 * 用户截图：转生面板红卡「读取转生控制台超时（3000ms 内宿主没有响应）」，而同一宿主上的记忆面板立刻
 * 回答。面板随后回落到插件默认值，**于是每个开关都显示为关** —— 读者由此得出「插件坏了」的结论。
 *
 * 根因：`consoleState` 对每个会话**串行**做 `readTokenWatermark` + `governedWatermarks`（后者要读
 * 文件：压缩挂载点、输出预留）。15 个会话就是 30+ 次 await，客户端预算是 3 秒。
 *
 * 判据（写在「可测的过程」上，不写在「面板有没有红卡」上）：
 *   ① 一个慢会话**不再拖住**其它会话的结果 —— 总耗时接近最慢的那个，而不是它们的和；
 *   ② 负向：并发化**不得**改变行的内容与顺序（顺序按 `sessions.list()` 还原）；
 *   ③ 客户端预算与后端成本匹配：读取预算 ≥ 5s（记忆面板同一宿主用 5s 能答，3s 先失败）。
 *
 * 为什么 ① 用「和 vs 最大」而不是一个绝对毫秒数：绝对阈值会随机器变化，而**串行与并发的区别**不是
 * 「快多少」，是「随会话数线性增长还是不变」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

test('v313 ①: the console measures sessions CONCURRENTLY, not one after another', () => {
  /**
   * Source-level, because the property is about the SHAPE of the awaits: `await` inside a `for` loop is
   * serial no matter how fast each step is, and no amount of timing on a small fixture would distinguish
   * it from a concurrent implementation.
   *
   * This is the same family as `v136` (import edges) and `v309` (which variable is sent): a fact about
   * the code, asserted as a fact about the code.
   */
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const start = source.indexOf('const consoleState = async')
  assert.ok(start >= 0, 'consoleState must exist')
  const body = source.slice(start, start + 8000)

  assert.match(body, /Promise\.all\(\s*agents\.map\(/u,
    '会话测量必须走 Promise.all —— 串行 await 在会话数上是线性的，这正是超时的来源')
  assert.doesNotMatch(body, /for \(const agent of sessions\.list\(\)[\s\S]{0,400}?await readTokenWatermark/u,
    '旧的「for … await readTokenWatermark」串行循环必须已经不存在')
})

test('v313 ② (negative half): concurrency must NOT reorder or rewrite the rows', () => {
  /**
   * A `Promise.all` over a list resolves in list order, but a careless rewrite could sort by completion
   * time or drop the index. The rows feed a panel whose rows were previously in `sessions.list()` order,
   * so 「same values, different order」 would be a silent regression a timing test could never see.
   */
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const start = source.indexOf('const consoleState = async')
  const body = source.slice(start, start + 8000)
  assert.match(body, /for \(const \{ sessionId, watermark, rowThresholds/u,
    '结果必须按承诺的顺序（agents.map 的顺序）逐项消费，而不是按完成顺序')
  assert.match(body, /\.map\(\(agent\) => \(typeof agent\?\.id === 'string' \? agent\.id : ''\)\)/u,
    '会话 id 列表必须先取出再并发 —— 并发期间不再调用 sessions.list()')
})

test('v313 ③: THE BUDGET STAYS AT 3s — the fix is concurrency, not a longer patience', () => {
  /**
   * I first wrote this criterion as 「budget ≥ 5s」 and it was WRONG: `v029` pins `<= 3_000ms` for BOTH
   * panels, with the reason in its own name — 「gives the Host THREE seconds, not twelve」, i.e. short
   * enough that the panel reads as responsive. Raising graft's budget would have satisfied my criterion
   * by relaxing the rule memory is still held to: fixing the test instead of the thing.
   *
   * What this asserts now is the OPPOSITE, and it guards the real risk — that a later reader sees
   * 「console timed out」 and reaches for the number again. The cost was on the HOST side (a serial loop),
   * and that is where it was fixed.
   */
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const match = /withTimeout\(bridge\.state\(target\), ([\d_]+)/u.exec(client)
  assert.ok(match !== null, 'the console read must still go through withTimeout (it is not a silent hang)')
  const budget = Number(match[1].replace(/_/gu, ''))
  assert.equal(budget <= 3_000, true,
    `读取预算必须 <= 3000ms（v029 对两个面板都钉了这条：短到读起来像「有响应」）；实测 ${budget}ms`)
  assert.equal(budget >= 1_000, true, `并且要够一次健康的往返；实测 ${budget}ms`)
})
