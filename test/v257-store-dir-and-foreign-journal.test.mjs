/**
 * ── v257 (B4-0b-2 W1-3): one store, one spelling; and `.txn` deletes only what it could have written ──
 *
 * ① PATH NORMALISATION. An explicit `dataDir` used to be used VERBATIM. `/data`, `/data/`,
 *    `/x/../data` and a junction to `/data` were four strings for ONE directory — and every store file
 *    is keyed by string. Consequence: two windows configured with two spellings write two different
 *    `.retired.json` files and neither sees the other's retirements; a `.txn` written under one
 *    spelling is invisible to recovery run under the other.
 *
 * ② FOREIGN FILES IN `.txn`. The scan takes every `*.json` and `rmSync`s whatever it cannot parse. One
 *    foreign file dropped into that directory — a note, a backup, another tool's state — is destroyed
 *    by an activation that was only supposed to clean up after itself. The filename is the identity:
 *    the plugin writes `<encodeURIComponent(sourceSessionId)>.json`, so anything outside that alphabet
 *    was never ours; it is REPORTED (`journal-foreign`) and LEFT ALONE.
 *
 * ── why ① is asserted through the ENTRY POINT, not through `path.resolve` ─────────────────────────
 *
 * Calling `path.resolve` in the test would prove that Node has a `resolve`. The claim is that the
 * PLUGIN returns one directory for four spellings, so it is asserted on `graft_debug_status`'s own
 * `store` report — the same value the panel prints. `v132` already pins the internal function against
 * a golden diff; this pins the observable consequence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, recoverGraftTransactions, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold(dataDir) {
  resetRetiredSessions()
  const log = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dataDir } })
  apply(ctx, { dataDir })
  return { log, ctx }
}

/**
 * ── W1-3 ① as a STRING-IDENTITY claim, measured where the string is published ──────────────────────
 *
 * The first version of this test wrote a journal record and asserted that activation consumed it under
 * the noisy spelling. It passed — and it kept passing with `normaliseStoreDir` reduced to `return raw`.
 * That is the test telling the truth: `join()` already collapses the trailing separator, so FILE
 * REACHABILITY was never at risk from this. What was at risk is the STRING — the value used as a store
 * key, printed in logs, and written into `.layout.json` — and a claim about a string is unverifiable
 * unless the string is published. It is now published (`transactions.store.dir`), so the assertion can
 * finally be about the thing the fix changes.
 */
test('v257 ①: 四种写法必须解析成同一个 store 目录字符串（读 status 自己的 transactions.store.dir）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-v257-'))
  const plain = join(base, 'store')
  mkdirSync(plain, { recursive: true })

  const spellings = [plain, `${plain}/`, `${plain}\\`, join(base, 'noise', '..', 'store')]
  const seen = []
  for (const spelling of spellings) {
    resetRetiredSessions()
    const { ctx } = scaffold(spelling)
    const status = await ctx._tools.get('graft_debug_status').execute({})
    seen.push(String(status?.transactions?.store?.dir ?? ''))
  }

  assert.ok(seen.every((dir) => dir.length > 0), `status 必须发布解析后的目录；实测 ${JSON.stringify(seen)}`)
  assert.equal(new Set(seen).size, 1, `四种写法必须归一到同一个字符串，实测 ${JSON.stringify(seen)}`)
  assert.equal(seen[0].replace(/[\\/]+$/u, ''), plain.replace(/[\\/]+$/u, ''), '归一到那个目录本身')
  assert.doesNotMatch(seen[0], /[\\/]$/u, '归一结果不许带尾分隔符 —— 尾分隔符会进入日志、.layout.json 与比较')
  assert.equal(seen[0].includes('noise'), false, '含 `..` 的写法必须被解析掉')
})

/**
 * ①b: the BEHAVIOURAL half — a record in the canonical directory is consumed when the plugin mounts
 * with a noisy spelling. This is the "the two spellings really are one store" fact, kept separate from
 * ① because it survives the `return raw` can-red (measured), which is exactly why it cannot stand in
 * for ①.
 */
test('v257 ①b: 噪声写法下激活时的恢复仍消费记录（可达性，独立于字符串归一）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-v257-reach-'))
  const plain = join(base, 'store')
  mkdirSync(join(plain, '.txn'), { recursive: true })

  const sourceId = 'session-store-spelling'
  const record = {
    sourceSessionId: sourceId,
    targetSessionId: 'spelling-target',
    state: 'PREPARING',
    stage: 'paradise.create',
    updatedAt: new Date().toISOString(),
    owner: { pid: 999999, token: '999999-0', host: hostname(), leaseUntil: new Date().toISOString() },
  }
  const journalFile = join(plain, '.txn', `${encodeURIComponent(sourceId)}.json`)

  for (const spelling of [`${plain}/`, join(base, 'noise', '..', 'store')]) {
    writeFileSync(journalFile, JSON.stringify(record), 'utf8')
    resetRetiredSessions()
    const log = makeSourceLog({ turns: 1, sourceSessionId: sourceId })
    const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: spelling } })
    apply(ctx, { dataDir: spelling })
    const sawIt = ctx._logged.warn.some((line) => line.includes('transaction recovery') && line.includes('scanned 1'))
    assert.ok(sawIt, `写法 ${JSON.stringify(spelling)} 下激活必须看见记录；告警 ${JSON.stringify(ctx._logged.warn.slice(-3))}`)
    assert.equal(existsSync(journalFile), false, '记录被处理过就必须消失')
  }
  resetRetiredSessions()
})

test('v257 ②: `.txn` 里的外来文件 **不被删除** 且被报告（MEASUREMENT_BROKEN）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-v257-foreign-'))
  const { ctx } = scaffold(base)
  const txnDir = join(base, '.txn')
  mkdirSync(txnDir, { recursive: true })

  writeFileSync(join(txnDir, 'notes.txt'), 'someone else was here', 'utf8')
  writeFileSync(join(txnDir, 'my backup 1.json'), '{"why":"not ours"}', 'utf8')

  recoverGraftTransactions(ctx)

  assert.equal(existsSync(join(txnDir, 'notes.txt')), true, '外来 .txt 必须保留')
  assert.equal(existsSync(join(txnDir, 'my backup 1.json')), true, '外来 .json（名字不是我们写的形状）必须保留')
  assert.ok(
    ctx._logged.warn.some((line) => line.includes('不处理') || line.includes('MEASUREMENT_BROKEN')),
    `必须报告出来；实测 ${JSON.stringify(ctx._logged.warn.slice(-4))}`,
  )
  resetRetiredSessions()
})

test('v257 ③: 我们自己的名字 + 坏内容 ⇒ 报告后删除（「ours but torn」≠「not ours」）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-v257-torn-'))
  const { log, ctx } = scaffold(base)
  const txnDir = join(base, '.txn')
  mkdirSync(txnDir, { recursive: true })

  const ourName = `${encodeURIComponent(log.session.id)}.json`
  writeFileSync(join(txnDir, ourName), '{ not json', 'utf8')

  recoverGraftTransactions(ctx)
  assert.equal(existsSync(join(txnDir, ourName)), false, '我们自己的坏记录按 debris 处理（否则每轮重启都重读它）')
  assert.ok(
    ctx._logged.warn.some((line) => line.includes('解析') || line.includes('MEASUREMENT_BROKEN')),
    '但它必须先被报告',
  )
  assert.equal(readdirSync(txnDir).filter((name) => name.endsWith('.json')).length, 0)
  resetRetiredSessions()
})

test('v257 ④: 一条合法记录仍然被正常处理（② ③ 没有把主路径一起拦掉）', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-v257-good-'))
  const { log, ctx } = scaffold(base)
  const txnDir = join(base, '.txn')
  mkdirSync(txnDir, { recursive: true })
  writeFileSync(
    join(txnDir, `${encodeURIComponent(log.session.id)}.json`),
    JSON.stringify({
      sourceSessionId: log.session.id,
      targetSessionId: 'good-target',
      state: 'PREPARING',
      stage: 'paradise.create',
      updatedAt: new Date().toISOString(),
      owner: { pid: 999999, token: '999999-0', host: hostname(), leaseUntil: new Date().toISOString() },
    }),
    'utf8',
  )

  const result = recoverGraftTransactions(ctx)
  assert.deepEqual(result.rolledBack, [log.session.id], '合法记录必须照旧被回滚')
  resetRetiredSessions()
})