/**
 * ── v306 / B4-B B11b (P0): 「按策略没试」不是「试了但失败」 ────────────────────────────────────────
 *
 * 用户原话（派工单 §十五 15.3）：**「窗口被读到了，但调用方把『按策略抑制』返回的 `undefined` 当成
 * 『graft 失败』⇒ 每步一次 retire → 回滚 → 一条 WARN。用户会看到『失败』，而其实什么都没试过；账本每步被
 * 写一次。」**
 *
 * B11 只修了 confirm 分支。force-cut（silent/auto 模式的强制切）照旧：先 retire、再调
 * `autoGraftIfNeeded`、把 `undefined` 当「produced no target」抛错 ⇒ 回滚 ⇒ 一条
 * `auto-graft failed and rolled back`。抑制窗口存在期间，**每一步**都这样。
 *
 * ── 为什么判据必须读过程（§〇 第 23 条，用户本轮自己踩到的那一条）─────────────────────────────────
 *
 * 「最终 `isRetired === false`」对**两种情况都绿**：回滚成功时终态本来就会恢复。那个判据看起来在测
 * churn，其实什么都没测。所以这里读三样**过程**证据：
 *
 *   ① 日志里有没有 `failed and rolled back`（用户的症状就是这一行）；
 *   ② 日志里有没有 `suppressed` / `withheld`（证明是「按策略没试」，不是「悄悄没做」）；
 *   ③ `.retired.json` 的**字节内容**有没有变（envelope 带 `at` 与 `pid`，每次写都不同 ⇒
 *      内容相同 = 没写过）。
 *
 * 判据（用户给的 4 条，全部实现）：
 *   ① 抑制窗口生效 ⇒ silent 路径不产生「失败」（无 `failed and rolled back`）
 *   ② 也不得写账本（字节不变）
 *   ③ 负向：窗口**不存在**时，同一水位仍然真的尝试并如实报告结果
 *   ④ 与 confirm 路径**共用同一个读取点**（结构判据，见 ④）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, clearGraftTargetsForTest, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const RETIRED = '.retired.json'

function boot({ suppressedFor = 0 } = {}) {
  resetRetiredSessions()
  clearGraftTargetsForTest()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v306-'))
  const sourceLog = makeSourceLog({ turns: 3 })
  if (suppressedFor > 0) {
    /**
     * Write the window BEFORE `apply`, because `apply` is what loads it (`loadAutoGraftSuppression`).
     * Measured mistake: applying twice to 「pick up」 the window hits `duplicate tool
     * graft_slice_and_inject` — a fresh `apply` is not a re-load, it re-registers.
     */
    writeFileSync(
      join(dir, '.auto-graft-suppressed.json'),
      JSON.stringify({ [sourceLog.session.id]: Date.now() + suppressedFor }),
      'utf8',
    )
  }
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    contextWindowTokens: 100,
    graftMode: 'silent',
  })
  return { ctx, dir, sourceLog }
}

/** The exact bytes of the ledger, so a rewrite is detectable even if the payload is identical. */
function ledgerBytes(dir) {
  const path = join(dir, RETIRED)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const step = (ctx, sourceLog) =>
  dispatchPreStep(ctx, { agent: { id: sourceLog.session.id }, messages: [] })

test('v306 B11b ①: while the window holds, the silent path reports NO failure', async () => {
  const { ctx, dir, sourceLog } = boot({ suppressedFor: 10 * 60_000 })

  const before = ledgerBytes(dir)
  await step(ctx, sourceLog)
  await step(ctx, sourceLog)
  await step(ctx, sourceLog)

  const warnings = ctx._logged.warn.join('\n')
  assert.doesNotMatch(
    warnings,
    /failed and rolled back|produced no target/u,
    `抑制期间不许出现「失败并回滚」：用户会以为真的试过。实测 WARN：\n${warnings}`,
  )

  /**
   * ② AND IT SAYS WHY — and it must be the FORCE-CUT path saying it.
   *
   * `autoGraftIfNeeded` also consults the window, so 「no failure」 alone cannot prove the force-cut
   * branch was fixed: with that branch disabled the inner reader still returns `undefined` and the
   * outer caller still throws. Measured exactly that — the first version of this criterion stayed
   * GREEN with the force-cut check commented out, because the inner guard produced the same silence
   * and the inner `undefined` still reached the throw. So the evidence is the branch's OWN line,
   * which only it prints.
   */
  const info = ctx._logged.info.join('\n')
  assert.match(info, /force-cut withheld for .*nothing was retired/u,
    `必须是「强制切这一条路径自己判定并跳过」，而不是内层守卫碰巧返回 undefined。实测 INFO：\n${info}`)

  // ② THE LEDGER WAS NOT REWRITTEN. Read the BYTES, not the final state: the envelope carries
  // `at` + `pid`, so any write to it changes this string even when the payload is identical.
  assert.equal(ledgerBytes(dir), before,
    '抑制期间账本不得被重写：每步一次 retire→回滚 会让 .retired.json 每步变一次内容')
})

test('v306 B11b ③ (negative half): with NO window the same watermark really tries and reports the truth', async () => {
  /**
   * Without this, ①② are satisfied by 「never attempt anything」 — a permanent mute dressed up as
   * policy. The window is absent here, so the attempt must happen and its outcome must be honest.
   */
  const { ctx, sourceLog } = boot()

  await step(ctx, sourceLog)
  const info = ctx._logged.info.join('\n')
  const warn = ctx._logged.warn.join('\n')

  assert.doesNotMatch(info, /withheld for .*: a suppression window is in force/u,
    '没有窗口时不得声称被抑制')
  // The session DOES attempt: either it migrates (and the receipt says so) or it fails and says so.
  const attempted = /auto-grafted|已自动迁移|auto-graft failed and rolled back/u.test(`${info}\n${warn}`)
  assert.equal(attempted, true,
    `没有窗口时同一水位必须真的尝试一次并如实报告；实测 INFO=${info}\nWARN=${warn}`)
})

test('v306 B11b ④: ONE read point — the suppression decision is a single function, not a second `if`', () => {
  /**
   * The structural half. The defect was never 「one branch forgot」: it was that the same rule had a
   * reader in `autoGraftIfNeeded` and another in the confirm branch, each with its own expiry. B11b
   * deleted the second one and made both modes call `isAutoGraftSuppressed`.
   *
   * This is asserted by name because the alternative — 「add the check to whichever branch is failing
   * today」 — is how a third reader appears next month.
   */
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // No reader may consult the map directly: that is the second-reader shape, and it is the one this
  // fix removed. One `.get(` — inside `autoGraftSuppression`.
  const directReads = source.split('autoGraftSuppressedUntil.get(').length - 1
  assert.equal(directReads, 1,
    `autoGraftSuppressedUntil.get( 只许出现在 autoGraftSuppression 里；实测 ${directReads} 处`)

  // And BOTH modes reach that one reader: `autoGraftIfNeeded` through `autoGraftSuppression`
  // (it needs the deadline for its log line), the force-cut branch through the boolean predicate.
  const viaReader = source.split('autoGraftSuppression(').length - 1
  assert.equal(viaReader >= 3, true,
    `autoGraftSuppression 应当被定义一次、被 autoGraftIfNeeded 与谓词各用一次；实测出现 ${viaReader} 次`)
})
