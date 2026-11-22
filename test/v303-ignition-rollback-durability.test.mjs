/**
 * ── v303 / B4-B B10 (P0): 失败窗口里的「内存 vs 磁盘」不能各说各话 ──────────────────────────────────
 *
 * 用户原话（派工单 §十四 B10）：**「落盘失败 ⇒ 内存回滚 + 报错，且该错误出现在回执/报告里；`sourceRestored
 * === false` 时必须保留 pending 重试。」**
 *
 * 被修的缺陷（`index.ts:8846` + `core/ignition.ts` 的 rollback 路径）：
 *
 *     state().retired.delete(sourceId)          // 内存先说「已恢复」
 *     state().retired.delete(...)
 *     out.sourceRestored = unRetireDurably(...) // 磁盘说「还是 retired」（写失败）
 *     pendingIgnitions.delete(newId)            // 队列也删了
 *
 * 结果：**源会话在内存里可用、在磁盘上仍冻结，而且没有任何东西还能重试** —— 这正是 `rollbackFailedIgnition`
 * 存在要消灭的「双盲」，被它自己的一层调用方重新造出来。`sourceRestored` 当时算得是对的，却只进了日志。
 *
 * 判据写在**最坏的那一半**上，并配负向半边：
 *   ① 写盘失败 ⇒ 内存**不**清（与磁盘一致）+ 回执里有那句错误（不是只进日志）
 *   ② 写盘失败 ⇒ pending 保留（内存 + 磁盘队列都在）⇒ 重启后还能重试
 *   ③ 负向：写盘成功 ⇒ `sourceRestored === true`，且**读磁盘**确认已不再 retired，队列清空
 *   ④ 再负向：保留下来的一次重试**真的能成功**（证明这里不是「一律拒绝」/「一律报错」）
 *
 * 注入「落盘失败」的方式是真实的：把 `.retired.json` 换成一个**目录**，于是 `writeLedgerAtomic` 必然
 * EISDIR。失败的正是写盘本身，不是某个 mock 分支。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  clearGraftTargetsForTest,
  getPendingIgnitions,
  IGNITION_MAX_ATTEMPTS,
  isRetired,
  loadPendingIgnitions,
  normalizeConfig,
  readLedgerPayload,
  refreshMigrationLedgers,
  resetRetiredSessions,
  resumePendingIgnitions,
} from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const SOURCE = 'session-b10-source'
const TARGET = 'session-b10-target'

function scaffold() {
  resetRetiredSessions()
  clearGraftTargetsForTest()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-b10-'))
  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  // The state a restart finds: the ledger retires the source, and the queue spent its budget.
  writeFileSync(join(dir, '.retired.json'), JSON.stringify([SOURCE]), 'utf8')
  writeFileSync(join(dir, '.transferred.json'), JSON.stringify({}), 'utf8')
  writeFileSync(
    join(dir, '.graft-pending-ignition.json'),
    JSON.stringify([{ targetId: TARGET, sourceSessionId: SOURCE, at: Date.now() - 60_000, attempts: IGNITION_MAX_ATTEMPTS }]),
    'utf8',
  )
  refreshMigrationLedgers()
  loadPendingIgnitions(ctx)
  assert.equal(isRetired(SOURCE), true, 'fixture: memory retires the source before the rollback')
  return { ctx, dir }
}

/** Make the very next ledger write fail, for real: the payload path is a directory. */
function blockLedgerWrites(dir) {
  rmSync(join(dir, '.retired.json'), { force: true })
  mkdirSync(join(dir, '.retired.json'))
}

test('v303 B10 ①: a FAILED durable un-retire leaves memory agreeing with disk, and says so in the RECEIPT', async () => {
  const { ctx, dir } = scaffold()
  blockLedgerWrites(dir)

  const results = await resumePendingIgnitions(ctx, normalizeConfig({}))
  assert.equal(results.length, 1)
  const rollback = results[0].rollback
  assert.ok(rollback !== undefined, 'the rollback must be reported')
  assert.equal(rollback.sourceRestored, false, 'the write failed, so the source was NOT durably restored')

  // ① MEMORY DID NOT RUN AHEAD OF DISK. This is the defect: the old code deleted from memory first.
  assert.equal(isRetired(SOURCE), true,
    'memory must still retire the source: a failed write cannot leave the process believing it was restored')

  // ① THE ERROR IS IN THE RETURN VALUE, not only in a log file nobody reads.
  assert.match(String(rollback.reason), /durable un-retire FAILED/u,
    `the receipt must carry the write failure; got: ${String(rollback.reason)}`)
  assert.match(String(rollback.reason), new RegExp(SOURCE, 'u'), 'the receipt must name the session')

  resetRetiredSessions()
})

test('v303 B10 ②: a failed rollback KEEPS the pending entry, so a restart can still retry it', async () => {
  const { ctx, dir } = scaffold()
  blockLedgerWrites(dir)

  const results = await resumePendingIgnitions(ctx, normalizeConfig({}))
  assert.equal(results[0].rollback?.pendingRetained, true,
    'the receipt must state that the retry was retained')

  // ② IN MEMORY...
  assert.equal(getPendingIgnitions().has(TARGET), true,
    'the queue entry is the only record that this migration still needs undoing — it must survive')

  // ...AND ON DISK, which is what a restart reads.
  const queue = JSON.parse(readFileSync(join(dir, '.graft-pending-ignition.json'), 'utf8'))
  assert.equal(Array.isArray(queue) && queue.some((entry) => entry.targetId === TARGET), true,
    'the durable queue must still carry the target: an in-memory-only retention dies on restart')

  // AND THE RETRY IS REACHABLE AFTER A RESTART: the ledger was never rewritten, so a fresh process
  // reads "retired" + "queued" — exactly the state that can still be fixed.
  rmSync(join(dir, '.retired.json'), { recursive: true, force: true })
  writeFileSync(join(dir, '.retired.json'), JSON.stringify([SOURCE]), 'utf8')
  resetRetiredSessions()
  const again = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), paths: { data: dir } })
  refreshMigrationLedgers()
  loadPendingIgnitions(again)
  assert.equal(isRetired(SOURCE), true, 'a restart still sees the source retired')
  assert.equal(getPendingIgnitions().has(TARGET), true, 'a restart still sees the migration queued')

  resetRetiredSessions()
})

test('v303 B10 ③ (negative half): a SUCCESSFUL rollback restores memory AND the disk, and drains the queue', async () => {
  const { ctx, dir } = scaffold()

  const results = await resumePendingIgnitions(ctx, normalizeConfig({}))
  assert.equal(results[0].ok, false)
  const rollback = results[0].rollback
  assert.equal(rollback?.sourceRestored, true, 'the un-retire must land')
  assert.equal(rollback?.pendingRetained, false, 'nothing to retain when the rollback landed')

  assert.equal(isRetired(SOURCE), false, 'memory no longer retires the source')

  // READ THE DISK, not the memory: this is the half that survives a restart.
  const retiredOnDisk = readLedgerPayload(join(dir, '.retired.json'))
  assert.equal(Array.isArray(retiredOnDisk), true)
  assert.equal(retiredOnDisk.includes(SOURCE), false, '.retired.json must no longer list the source')

  // ...and the entry is drained, so the rollback cannot fire twice.
  assert.equal(getPendingIgnitions().has(TARGET), false)
  const queue = JSON.parse(readFileSync(join(dir, '.graft-pending-ignition.json'), 'utf8'))
  assert.equal(Array.isArray(queue) && queue.some((entry) => entry.targetId === TARGET), false,
    'the durable queue must be drained on success')

  resetRetiredSessions()
})

test('v303 B10 ④ (negative half): the retained retry actually SUCCEEDS once the write can land', async () => {
  /**
   * Without this, ①② could both be satisfied by "never restore anything" — the failure would be
   * reported forever and the source would stay frozen. The retention is only a fix if the retry
   * converges.
   */
  const { ctx, dir } = scaffold()
  blockLedgerWrites(dir)

  const first = await resumePendingIgnitions(ctx, normalizeConfig({}))
  assert.equal(first[0].rollback?.sourceRestored, false)
  assert.equal(getPendingIgnitions().has(TARGET), true)

  // Unblock the write and retry exactly as the next activation would.
  rmSync(join(dir, '.retired.json'), { recursive: true, force: true })
  writeFileSync(join(dir, '.retired.json'), JSON.stringify([SOURCE]), 'utf8')

  const second = await resumePendingIgnitions(ctx, normalizeConfig({}))
  assert.equal(second[0].rollback?.sourceRestored, true, 'the retained retry must be able to succeed')
  assert.equal(isRetired(SOURCE), false)
  assert.equal(getPendingIgnitions().has(TARGET), false)
  const retiredOnDisk = readLedgerPayload(join(dir, '.retired.json'))
  assert.equal(retiredOnDisk.includes(SOURCE), false, 'the retry reached the disk, not just memory')

  resetRetiredSessions()
})
