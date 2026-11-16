/**
 * ── v216: TD-22 的三个历史误报样例 + 两个真根扫描（安全回归）────────────────────────────────────
 *
 * ── 这个文件记录的是一件事：TD-22 已经从「误报」变成「已修复」────────────────────────────────────
 *
 * TD-22（ARCHITECTURE.md:583）登记的是命令护栏的两类真实误报：
 *   ① 提交信息里的 `空格斜杠空格` 被 `ESCAPING_ROOT` 判成「扫根目录」；
 *   ② `|` 出现在**参数位**（模式串/管道）时被当作命令分段，搜索动词 + 分段内容被判成全局搜索。
 *
 * 登记当时（2026-11-10）三条样例实测全部 `destructive`。
 *
 * ── 实测现状（2026-11-16，本文件写下的那一刻）──────────────────────────────────────────────────
 *
 * 三条样例现在**全部 `safe`**，两条真根扫描**仍然 `destructive`**。
 * 也就是说 TD-22 的退出条件已经满足了：
 *   ① 误报样例从 destructive → safe            ✅ 已达成
 *   ② 真根扫描仍然 destructive                  ✅ 已达成
 *
 * 修复的形状在 `src/core/command-guard.ts:85-98`：`SEGMENT_START` + `verbInCommandPosition`
 * 把「动词」限定在**命令位**，参数位的同一个词只是数据。这正是 TD-22「修法方向」那一格
 * 写的方案（「分段逻辑应只在命令位判断搜索动词，与 v112 的 verbInCommandPosition 同一条思路」）。
 *
 * ── 为什么本文件仍然值得存在 ────────────────────────────────────────────────────────────────────
 *
 * 一个「已经修好」的缺陷，如果没有测试钉住，下一次重构会把它悄悄带回来 ——
 * 而带回来的方式恰恰是「某个人觉得按位置判断太复杂，改回全文匹配」，那时没有任何东西会红。
 *
 * 所以这里钉的是**修复后的行为**（三样例 safe + 两真根 destructive），
 * 而不是登记时的旧行为。**两者只差一个断言方向，但后者会让本文件从诞生那刻就是红的。**
 *
 * ── 关于 `t.todo`（我实测过它的语义，结论是不用）──────────────────────────────────────────────
 *
 * 本文件第一版曾打算用 `t.todo('B1.3 修好后应变为 safe')` 记录「现状是 destructive」。
 * 实测 node 24 的 `t.todo`：**其中的断言失败会被记为 `⚠ todo`，`fail` 计数不增加，
 * 整个文件 exit 0**。也就是说一旦套上 `t.todo`，这条断言**永远不会变红** ——
 * 它退化成一条注释，而注释不会在重构时拦住任何人。
 * 既然 TD-22 已经修好，这里用普通 `assert.equal` 断言**当前真实值**，让它能红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)

/** `classifyAgentCommand` 返回 `{ risk }`；这里只取 risk，其他字段不属于本文件的判据。 */
const riskOf = (command) => {
  const result = mod.classifyAgentCommand(command, ROOT)
  return typeof result === 'object' && result !== null ? result.risk : result
}

/**
 * TD-22 登记原文的三条样例，**逐字**取自 ARCHITECTURE.md:588-590。
 * 除样例①外，另两条在登记原文里带转义（`\|`），此处按「命令行里实际敲下去的样子」还原为 `|`。
 */
const FALSE_POSITIVES = [
  {
    id: '①',
    label: '`/` 作为分隔符（提交信息里的空格斜杠空格）',
    command: 'git commit -m "fix: 三仓同步 check-readme-counts / check-readme-tally / verify-bundle"',
    was: 'destructive',
    why: '当时命中 ESCAPING_ROOT 的斜杠分支；现在靠「斜杠必须带路径上下文」不再命中',
  },
  {
    id: '②',
    label: '带 `|` 的模式串（管道符被当作命令分段）',
    command: "Get-ChildItem -Filter '*.md' | Select-Object Name; Select-String -Path *.md -Pattern 'C2|backlog'",
    was: 'destructive',
    why: '当时管道符切段后，段内搜索动词被判成全局搜索；现在分段只在命令位判断动词',
  },
  {
    id: '③',
    label: '带 `|` 的 Select-String 模式',
    command: "Select-String -Pattern 'a|b'",
    was: 'destructive',
    why: '同一构造，两个独立会话都撞上；只在参数位出现分隔符时的稳定误判',
  },
]

/** 真正的根扫描：这两条在任何时候都不许变成 safe。 */
const REAL_ROOT_SWEEPS = [
  { label: 'rg /', command: 'rg /' },
  { label: 'Get-ChildItem -Recurse C:\\', command: 'Get-ChildItem -Recurse C:\\' },
]

test('v216-TD22 ①: 三个历史误报样例现在都是 safe（TD-22 已修复，记录新行为）', () => {
  const stillDestructive = FALSE_POSITIVES
    .filter((s) => riskOf(s.command) === 'destructive')
    .map((s) => `${s.id} ${s.label}（登记时 was=${s.was}）`)

  assert.deepEqual(stillDestructive, [],
    `这些样例仍被判 destructive —— TD-22 的修复退化了：\n  ${stillDestructive.join('\n  ')}\n`
    + '修复的形状在 src/core/command-guard.ts 的 SEGMENT_START + verbInCommandPosition：'
    + '动词只在命令位才算动词，参数位的同一个词是数据。')
})

test('v216-TD22 ②: 两个真根扫描现在仍然是 destructive（这条现在就该绿）', () => {
  /**
   * 这条是 TD-22 退出条件的另一半，也是「修 A 不能破 B」的对照。
   *
   * 单独成一条而不是并进 ①，是因为失败时的含义完全不同：
   *   ① 红 = 误报回来了（可用性退化）
   *   ② 红 = **漏报回来了**（安全退化）
   * 后者比前者严重，它必须有自己的名字。
   */
  const notDestructive = REAL_ROOT_SWEEPS
    .filter((s) => riskOf(s.command) !== 'destructive')
    .map((s) => `${s.label} → 实测 ${riskOf(s.command)}`)

  assert.deepEqual(notDestructive, [],
    `这些真正的根扫描不再被判 destructive —— 这是安全退化，比误报更严重：\n  ${notDestructive.join('\n  ')}`)
})

test('v216-TD22 ③ can-red: 把判据换成恒返回 safe 的空实现 ⇒ ② 必须红', () => {
  /**
   * 通则：「如果代码坏了，这条会红吗？」
   *
   * 做法：`deadClassifier` 永远返回 `{ risk: 'safe' }`（模拟护栏彻底失效），
   * 断言 ② 的判据在它之下必然失败。若在空实现下 ② 仍然「通过」，
   * 说明 ② 测的不是分类结果，而是别的东西。
   */
  const deadClassifier = () => ({ risk: 'safe' })
  const riskOfDead = (cmd) => deadClassifier(cmd).risk

  const survivors = REAL_ROOT_SWEEPS.filter((s) => riskOfDead(s.command) === 'destructive')
  assert.equal(survivors.length, 0,
    '前提确认：空实现下两条真根扫描都应变成 safe（否则这条 can-red 没有构造出「判据失效」）')

  const wouldRed = REAL_ROOT_SWEEPS.filter((s) => riskOfDead(s.command) !== 'destructive')
  assert.equal(wouldRed.length, REAL_ROOT_SWEEPS.length,
    `空实现下 ② 必须为 ${REAL_ROOT_SWEEPS.length} 条全部报错；实测只报 ${wouldRed.length} 条 —— `
    + '说明 ② 的判据不是「分类结果是否为 destructive」')

  // 并且真判据此刻必须给出相反结论（证明两者真的不同）
  const realNotDestructive = REAL_ROOT_SWEEPS.filter((s) => riskOf(s.command) !== 'destructive')
  assert.deepEqual(realNotDestructive, [], '真判据下两条真根扫描必须仍是 destructive')
})

test('v216-TD22 ④: 判据对「同词不同位」敏感 —— 命令位的 rg / 是 destructive，参数位的 "/" 不是', () => {
  /**
   * 这是 TD-22 修复的**机制**本身，而不是它的三个症状。
   *
   * 一组最小对照：同一个 `rg`、同一个 `/`，只改它出现在哪。
   * 若这条红，说明修复被换成了「对某些字符串打特例」，
   * 而那样的修复在下一条新样例上会立刻失效。
   */
  const pairs = [
    { command: 'rg /', expected: 'destructive', why: 'rg 在命令位、/ 是它的参数 → 真根扫描' },
    { command: 'git commit -m "a / b"', expected: 'not-destructive', why: '/ 在引号内的参数位 → 分隔符，不是根' },
    { command: "Select-String -Pattern 'a|b'", expected: 'not-destructive', why: '| 在参数字符串内 → 数据' },
  ]

  for (const { command, expected, why } of pairs) {
    const risk = riskOf(command)
    if (expected === 'destructive') {
      assert.equal(risk, 'destructive', `「${command}」应为 destructive（${why}），实测 ${risk}`)
    } else {
      assert.notEqual(risk, 'destructive', `「${command}」不应是 destructive（${why}），实测 ${risk}`)
    }
  }
})
