/**
 * ── v249 (B4-0b-1 A5): one row may watch several ids, and EACH result must be relayed ──────────
 *
 * The audit's B-2, measured: `markTransfersDelivered` stamped `deliveredAt` on every row whose
 * watched ids appeared among the delivered keys (`src/index.ts:5131-5138`), and `isOwed` only looked
 * at whether that stamp existed (`core/pending-transfers.ts:174`). A row watching job-1 and job-2
 * therefore went silent for good the moment job-1 was relayed — while the tape had already promised
 * the target that 「这些结果不会再有第二次通知」.
 *
 * The fix moves idempotency from the ROW to the RESULT: `deliveredKeys: string[]` holds the exact
 * `deliveryKey`s (`kind:id:settledSeq`) each row has spoken about, and `isOwed(entry, settled)` asks
 * the per-result question.
 *
 * ── why the real pre-step listener ───────────────────────────────────────────────────────────────
 *
 * These tests push `job/settled` events into the source log and drive the registered
 * `agent/pre-step` waterfall for the TARGET session, then read the injected messages. A test that
 * called `isOwed` directly would prove the predicate's arithmetic; this proves the pipeline stamps
 * and reads through that predicate. (The can-red for this batch is one edit at the stamp site, and
 * it must be visible HERE.)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const LEDGER = 'pending-transfers.jsonl'
const TARGET = 'target-a'

function env() {
  resetRetiredSessions()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v249-'))
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: root } })
  apply(ctx, { dataDir: root })
  return { root, log, ctx }
}

const lastSeq = (log) => Number(log.events.at(-1)?.seq ?? 0)

/** One ledger row watching BOTH jobs — the case the audit reported. */
function writeRow(root, log, jobIds) {
  appendFileSync(
    join(root, LEDGER),
    `${JSON.stringify({
      targetSessionId: TARGET,
      sourceSessionId: log.session.id,
      watchJobIds: jobIds,
      watchSubagentIds: [],
      sinceSeq: lastSeq(log),
      createdAt: Date.now(),
    })}\n`,
    'utf8',
  )
}

/** Drive the REAL registered pre-step waterfall for the target and keep the relay messages. */
async function preStep(ctx) {
  const produced = []
  for (const listener of ctx._listeners.get('agent/pre-step') ?? []) {
    produced.push(
      await listener({ agent: { id: TARGET }, messages: [], turn: 1, step: 1 }, () => ({ kind: 'enter', messages: [] })),
    )
  }
  return produced
    .flatMap((result) => (result !== null && typeof result === 'object' && Array.isArray(result.messages) ? result.messages : []))
    .filter((message) => JSON.stringify(message).includes('先前会话的后台结果已回来'))
}

const textsOf = (messages) => messages.map((message) => JSON.stringify(message)).join('\n')

test('v249 ①: 一行盯两个作业，先后结束 ⇒ 转述两次（旧版第二次永久静默）', async () => {
  const { root, log, ctx } = env()
  writeRow(root, log, ['job-1', 'job-2'])

  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-1', summary: '第一个作业完成' } })
  const first = await preStep(ctx)
  assert.equal(first.length, 1, '第一个作业结束必须转述')
  assert.match(textsOf(first), /第一个作业完成/u)

  /** The row has now "spoken" — under the old stamp, job-2 was dead from this moment. */
  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-2', summary: '第二个作业完成' } })
  const second = await preStep(ctx)
  assert.equal(second.length, 1, '第二个作业结束也必须转述 —— 一行说过一次不等于它盯的每个结果都说过')
  assert.match(textsOf(second), /第二个作业完成/u)
  assert.doesNotMatch(textsOf(second), /第一个作业完成/u, '已经转述过的不许再来一次')

  /** Nothing new ⇒ silence, not a repeat. */
  assert.deepEqual(await preStep(ctx), [], '没有新结果时不许重复播报')
})

test('v249 ②: 同一作业在新 seq 再结束 ⇒ 再转述一次（deliveryKey 的注释就是这句话）', async () => {
  const { root, log, ctx } = env()
  writeRow(root, log, ['job-r'])

  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-r', summary: '第一次运行' } })
  assert.equal((await preStep(ctx)).length, 1)

  /** The host RETRIED the job and it settled again at a new seq: that is new information. */
  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-r', summary: '重跑之后的结果' } })
  const again = await preStep(ctx)
  assert.equal(again.length, 1, '新 seq 是新结果，必须能再转述 —— 否则重跑的结果被吞掉')
  assert.match(textsOf(again), /重跑之后的结果/u)
  assert.doesNotMatch(textsOf(again), /第一次运行/u)
})

test('v249 ③: 同一 (id, seq) 重放 ⇒ 不重复（幂等键含 seq，不含文案）', async () => {
  const { root, log, ctx } = env()
  writeRow(root, log, ['job-i'])

  const settle = { type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-i', summary: '只该说一次' } }
  log.events.push(settle)
  assert.equal((await preStep(ctx)).length, 1)

  /** The host repeats the SAME event (same seq) — the delivery key is identical. */
  log.events.push({ ...settle, data: { ...settle.data, summary: '只该说一次（换了措辞）' } })
  assert.deepEqual(await preStep(ctx), [], '同一个 (id, seq) 换了措辞仍然是同一条结果，不许再说一次')
})

test('v249 ④: 台账记的是「哪些结果已交付」的键集合，不是整行的章', async () => {
  const { root, log, ctx } = env()
  writeRow(root, log, ['job-a', 'job-b'])

  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-a', summary: 'a 完成' } })
  await preStep(ctx)

  const rows = readFileSync(join(root, LEDGER), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
  const latest = rows.at(-1)
  assert.ok(Array.isArray(latest.deliveredKeys) && latest.deliveredKeys.length === 1,
    `必须记下恰好一个交付键，实测 ${JSON.stringify(latest.deliveredKeys)}`)
  assert.match(String(latest.deliveredKeys[0]), /^job:job-a:\d+$/u)
  assert.equal(
    latest.deliveredKeys.some((key) => key.includes('job-b')),
    false,
    'job-b 还没发生任何事，它的键不许被顺手写进去',
  )
})