#!/usr/bin/env node
/**
 * ── check-stability-registration: 事前登记不得被事后倒改（lead §四十二.5）──────────────────────────
 *
 * `v2.3` §15.18.4 的纪律是「指标不得事后倒改」。老板在 §28.7 写的「连续 3 代」违反了它 ——
 * 那是**自己造的数**，而且**在结果之后才定**。
 *
 * 所以「稳」的定义必须**先写死、后观察**，并且**可验证它没被改过**。
 *
 * ── 为什么是 contentHash 而不是日期 ─────────────────────────────────────────────────────────────
 *
 * 老板原话：**「只写日期事后仍可改。要求写 contentHash 并配判据断言它不变；改哈希这个动作本身是记录。」**
 *
 * 日期只证明「它有个日期」。哈希证明「这段文字没动过」—— 而如果它真的需要改（例如报告更新了 L0 的定义），
 * **改哈希是显式动作**：它出现在 diff 里，评审能看见。**被看见的修改是可接受的，悄悄改的才是问题。**
 *
 * Usage:
 *   node scripts/check-stability-registration.mjs            # verify
 *   node scripts/check-stability-registration.mjs --update   # re-hash after a REVIEWED edit
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOC = join(ROOT, 'docs', 'STABILITY-REGISTRATION.md')
const LOCK = join(ROOT, 'docs', 'stability-registration.hash')

if (!existsSync(DOC)) {
  console.error('stability-registration: FAILED — docs/STABILITY-REGISTRATION.md 不存在')
  process.exit(1)
}

const text = readFileSync(DOC, 'utf8')
const digest = createHash('sha256').update(text).digest('hex')

if (process.argv.includes('--update')) {
  writeFileSync(LOCK, `${digest}\n`, 'utf8')
  console.log(`stability-registration: hash updated to ${digest.slice(0, 16)}… — this edit is now part of the record`)
  process.exit(0)
}

if (!existsSync(LOCK)) {
  console.error('stability-registration: FAILED — 缺少锁定哈希，先跑 --update 并**审阅 diff**')
  process.exit(1)
}

const recorded = readFileSync(LOCK, 'utf8').trim()
if (recorded !== digest) {
  console.error('stability-registration: FAILED — 事前登记被改过。')
  console.error(`  登记时的哈希：${recorded.slice(0, 16)}…`)
  console.error(`  当前的哈希  ：${digest.slice(0, 16)}…`)
  console.error('')
  console.error('  这正是 v2.3 §15.18.4 要防的事：**指标不得事后倒改**。')
  console.error('  若这次修改是正当的（例如报告更新了 L0 的定义），跑：')
  console.error('    node scripts/check-stability-registration.mjs --update')
  console.error('  并且把那次修改写进提交说明 —— **改哈希这个动作本身就是记录**。')
  process.exit(1)
}

/** The registered facts must still be THERE — a hash over an emptied file would also match. */
for (const required of ['2 小时', '六类', '出现 1 次', '逻辑会话', '代价', '不对称']) {
  if (!text.includes(required)) {
    console.error(`stability-registration: FAILED — 登记文本缺少必要内容「${required}」`)
    process.exit(1)
  }
}

console.log(`stability-registration: OK — 事务前登记未改动（${digest.slice(0, 16)}…），窗口 2 小时、六类工作负载、一次即判`)