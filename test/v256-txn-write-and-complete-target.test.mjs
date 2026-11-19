/**
 * ── v256 (B4-0b-2 W1-2): a journal that cannot be written stops the slice; a COMPLETE target is
 * kept, not deleted ────────────────────────────────────────────────────────────────────────────────
 *
 * Two halves of one question: "what does recovery do when the bookkeeping disagrees with the work?"
 *
 * ① WRITE-AHEAD MUST BE DURABLE.
 *    `writeGraftTxn`'s catch used to swallow the failure with a comment saying "the journal must never
 *    change a migration's outcome". That is backwards: the journal's only job is to make a crash
 *    recoverable, so a journal that did not write means a crash becomes a phantom session. Measured
 *    shape of the defect: make the `.txn` directory unwritable ⇒ the migration still reserves an id,
 *    writes a target, and leaves NO record — the next start reports a clean start.
 *
 * ② A COMPLETE TARGET IS NOT GARBAGE.
 *    `TARGET_FLUSHED` means the tape was written AND flushed. Recovery treated every non-COMMITTED
 *    state identically: `markTargetBroken` (`[损坏]`) then `discardPartialTarget` (remove). A crash
 *    between flush and retirement therefore DESTROYED a fully written session and labelled it corrupt.
 *    Now such a target is KEPT, reported in `kept`, written to the leftover ledger, and left for a
 *    human. Only genuinely partial records (PREPARING / records carrying an error) still roll back.
 *
 * ── how "unwritable journal" is built without mocking fs ──────────────────────────────────────────
 *
 * `storePaths().txnDir` lives under the test's temp `dataDir`. Creating a FILE named `.txn` makes
 * `mkdirSync('.txn', {recursive:true})` throw EEXIST/ENOTDIR, and `writeJsonAtomic` cannot write into a
 * path that is a file. That is a real filesystem refusal, not a stub — the same shape as a full disk
 * for this code path.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, graftTxnOwner, recoverGraftTransactions, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold({ blockJournal = false } = {}) {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v256-'))
  if (blockJournal) {
    /** A FILE where the journal DIRECTORY must be: every mkdir/write under it fails, for real. */
    writeFileSync(join(dir, '.txn'), 'not a directory', 'utf8')
  }
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { dir, log, ctx, persistence }
}

test('v256 ①: 事务日志写不出来 ⇒ 迁移在预留 id 之前中止（不留孤儿目标、不退役源）', async () => {
  const { dir, log, ctx, persistence } = scaffold({ blockJournal: true })

  const outcome = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'journal-blocked-target' }, {})
    .then((value) => ({ ok: true, value }))
    .catch((error) => ({ ok: false, error }))

  /**
   * Either shape is acceptable as long as NOTHING was created: the tool may throw or return a failure
   * report. What must hold is the three "nothing happened" facts below.
   */
  if (outcome.ok) {
    assert.equal(outcome.value?.ok, false, `写不出日志时不许回成功；实测 ${JSON.stringify(outcome.value).slice(0, 300)}`)
    assert.match(JSON.stringify(outcome.value), /JOURNAL_WRITE_FAILED|journal/u, '必须点名是日志写失败，不是含糊的未知错误')
  } else {
    assert.match(String(outcome.error?.message ?? outcome.error), /journal|JOURNAL|txn/iu)
  }

  assert.equal(persistence.byId.get('journal-blocked-target'), undefined, '目标不许被创建')
  assert.equal(persistence.createCalls.length, 0, 'persistence.create 一次都不许跑（id 未被预留）')
  /** The source must still be usable: retirement is the last step and never ran. */
  const { resumeSession } = await import('../index.js')
  assert.equal(resumeSession(ctx, log.session.id).wasRetired, false, '源不许被退役')
  void dir
  resetRetiredSessions()
})

test('v256 ②: 手写 TARGET_FLUSHED + 目标存在 ⇒ 恢复后目标仍在，且被报告为「完整但未退休」', () => {
  resetRetiredSessions()
  const { dir, log, ctx, persistence } = scaffold()
  persistence.byId.set('complete-target', {
    header: { id: 'complete-target', title: '完整的目标' },
    events: [{ type: 'user/message', seq: 0, data: { text: 'hi' } }],
    flushed: true,
  })

  const txnDir = join(dir, '.txn')
  mkdirSync(txnDir, { recursive: true })
  writeFileSync(
    join(txnDir, `${encodeURIComponent(log.session.id)}.json`),
    JSON.stringify({
      sourceSessionId: log.session.id,
      targetSessionId: 'complete-target',
      state: 'TARGET_FLUSHED',
      stage: 'persistence.flush',
      updatedAt: new Date().toISOString(),
      owner: { pid: 999999, token: '999999-0', host: hostname(), leaseUntil: new Date().toISOString() },
    }),
    'utf8',
  )

  const result = recoverGraftTransactions(ctx)
  assert.equal(result.kept.length, 1, `必须报告「保留了一个完整目标」，实测 ${JSON.stringify(result)}`)
  assert.equal(result.kept[0].targetSessionId, 'complete-target')
  assert.equal(result.kept[0].state, 'TARGET_FLUSHED')
  assert.deepEqual(result.rolledBack, [], '一个完整目标不该走回滚路径')

  /** The artifact survives — this is the whole point. */
  assert.equal(persistence.byId.get('complete-target') !== undefined, true, '已写完的目标不许被恢复流程删除')
  /** And the journal record is consumed (reported through the leftover ledger instead). */
  assert.equal(readdirSync(txnDir).filter((name) => name.endsWith('.json')).length, 0, '记录被处理过，不许每轮重启都重报')
  assert.ok(
    ctx._logged.warn.some((line) => line.includes('保留') || line.includes('完整')),
    `必须在日志里说出来；实测 ${JSON.stringify(ctx._logged.warn.slice(-3))}`,
  )
  resetRetiredSessions()
})

test('v256 ③: 部分写入（PREPARING）仍然回滚并标记 —— ② 没有顺手放过真半成品', () => {
  resetRetiredSessions()
  const { dir, log, ctx, persistence } = scaffold()
  persistence.byId.set('partial-target', { header: { id: 'partial-target', title: '半成品' }, events: [] })

  const txnDir = join(dir, '.txn')
  mkdirSync(txnDir, { recursive: true })
  writeFileSync(
    join(txnDir, `${encodeURIComponent(log.session.id)}.json`),
    JSON.stringify({
      sourceSessionId: log.session.id,
      targetSessionId: 'partial-target',
      state: 'PREPARING',
      stage: 'paradise.create',
      updatedAt: new Date().toISOString(),
      owner: { pid: 999999, token: '999999-0', host: hostname(), leaseUntil: new Date().toISOString() },
    }),
    'utf8',
  )

  const result = recoverGraftTransactions(ctx)
  assert.deepEqual(result.rolledBack, [log.session.id])
  assert.deepEqual(result.kept, [], 'PREPARING 不是「完整」，不许被计入保留')
  assert.equal(existsSync(join(txnDir, `${encodeURIComponent(log.session.id)}.json`)), false)
  resetRetiredSessions()
})