/**
 * ── v275 (B4-0b-2 W6-2): 转述到达率 —— 分母是「欠着的结果」，分子是「真的说出口的结果」─────────────
 *
 * ── WHY THIS SAMPLE IS CONSTRUCTED, AND WHY THAT IS THE HONEST THING TO SAY ────────────────────
 *
 * Five real handoff boards were measured and every one of them had a ZERO denominator: no background
 * job was running at slice time, so there was nothing to relay. A rate over zero owed results is not
 * "100%" and it is not "unknown" — it is undefined, and 「未测」 was the honest word for it.
 *
 * But a mechanism that is never exercised is not known to work, so this file CONSTRUCTS the sample:
 * a source log carrying `job/registered` for job-1 and job-2, a ledger row watching both, a settle
 * for each, and the REAL registered `agent/pre-step` waterfall driven twice. That is the same
 * pipeline v249 uses; what is new here is that the SHAPE of the sample is the two-job case and that
 * the numbers are reported as numerator/denominator rather than as a percentage.
 *
 * ── 判据（四条） ────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 到达率 = 2/2 —— 两个作业各 settle 一次，各被转述一次；分子分母都打印出来
 *   ② 重放同一 (id, seq) 不重复 —— 到达率的分母不因重放而增大，也不会让分子虚增
 *   ③ 新 seq 再报一次（A5 回归）—— 重跑是新信息，到达率再次 1/1
 *   ④ 报告里给分母与分子 —— 本测试断言的是两个数，不是一个百分比
 *
 * ── 第 ④ 条为什么写成断言 ──────────────────────────────────────────────────────────────────────
 *
 * 「到达率 100%」 在 0/0 时也成立（除零之后被人写成 1），在 1/1 时也成立。两个完全不同的样本给
 * 同一个读数，这个读数就不携带信息。所以这里断言的是一对整数，`2/2` 与 `1/1` 是两个不同的答案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const LEDGER = 'pending-transfers.jsonl'
const TARGET = 'target-arrival'

function env() {
  resetRetiredSessions()
  const root = mkdtempSync(join(tmpdir(), 'dsh-v275-'))
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: root } })
  apply(ctx, { dataDir: root })
  return { root, log, ctx }
}

const lastSeq = (log) => Number(log.events.at(-1)?.seq ?? 0)

/** The slice-time row: two background jobs registered BEFORE the boundary, both watched. */
function writeTwoJobRow(root, log) {
  log.events.push({ type: 'job/registered', seq: lastSeq(log) + 1, data: { jobId: 'job-1', label: '第一个作业' } })
  log.events.push({ type: 'job/registered', seq: lastSeq(log) + 1, data: { jobId: 'job-2', label: '第二个作业' } })
  appendFileSync(
    join(root, LEDGER),
    `${JSON.stringify({
      targetSessionId: TARGET,
      sourceSessionId: log.session.id,
      watchJobIds: ['job-1', 'job-2'],
      watchSubagentIds: [],
      sinceSeq: lastSeq(log),
      createdAt: Date.now(),
    })}\n`,
    'utf8',
  )
}

/**
 * Drive the real registered pre-step waterfall and return ONLY the relay messages.
 *
 * A relay is recognised by its own sentence, and the caller counts MESSAGES — that is what a target
 * session would actually receive. Counting something else (an entry in the ledger, a call to
 * `isOwed`) would measure the bookkeeping rather than the arrival.
 */
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

/**
 * How many of the WATCHED results are named by the relay messages.
 *
 * `denominator` is what the ledger owes; `numerator` is what actually reached the target, counted by
 * looking for each job's own id in the delivered text. Two integers, always reported together.
 */
function arrive(messages, watched) {
  const text = messages.map((message) => JSON.stringify(message)).join('\n')
  const arrived = watched.filter((id) => text.includes(id))
  return { numerator: arrived.length, denominator: watched.length, arrived }
}

test('v275 ①: 两个作业各 settle 一次 ⇒ 到达率 2/2（两个数都断言，不是一个百分比）', async () => {
  const { root, log, ctx } = env()
  writeTwoJobRow(root, log)

  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-1', summary: '第一个作业完成' } })
  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-2', summary: '第二个作业完成' } })

  const first = await preStep(ctx)
  assert.equal(first.length, 1, `两个结果应合成一条转述消息，实测 ${first.length} 条`)

  const ratio = arrive(first, ['job-1', 'job-2'])
  assert.deepEqual(
    { numerator: ratio.numerator, denominator: ratio.denominator },
    { numerator: 2, denominator: 2 },
    `到达率必须是 2/2，实测 ${ratio.numerator}/${ratio.denominator}（到了的：${ratio.arrived.join(',') || '无'}）`,
  )
  const text = first.map((message) => JSON.stringify(message)).join('\n')
  assert.match(text, /第一个作业完成/u)
  assert.match(text, /第二个作业完成/u)
})

test('v275 ②: 重放同一 (id, seq) ⇒ 分母不增、分子不增（到达率停在同一对整数上）', async () => {
  const { root, log, ctx } = env()
  writeTwoJobRow(root, log)

  const settle = (id, summary) => ({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: id, summary } })
  log.events.push(settle('job-1', '完成一'))
  log.events.push(settle('job-2', '完成二'))

  const first = await preStep(ctx)
  assert.deepEqual(arrive(first, ['job-1', 'job-2']).numerator, 2)

  /**
   * The host repeats the SAME two events (same seq, reworded). Nothing new arrived, so the relay must
   * be silent — and the rate must not move. A replayed event that re-counted would inflate BOTH
   * numbers, which is the one way a rate can look healthy while the mechanism is broken.
   */
  const replay = log.events.filter((event) => event.type === 'job/settled').map((event) => ({ ...event, data: { ...event.data, summary: `${event.data.summary}（重放）` } }))
  log.events.push(...replay)

  const again = await preStep(ctx)
  assert.deepEqual(again, [], '同一个 (id, seq) 重放不许再播报一次')
  assert.deepEqual(
    arrive(again, ['job-1', 'job-2']),
    { numerator: 0, denominator: 2, arrived: [] },
    '重放之后本轮新到达的必须是 0/2 —— 分母不因重放增大，分子也不许虚增',
  )
})

test('v275 ③: 同一作业在新 seq 再结束 ⇒ 再到达一次（A5 回归；1/1 而不是 0/1）', async () => {
  const { root, log, ctx } = env()
  writeTwoJobRow(root, log)

  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-1', summary: '第一次运行' } })
  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-2', summary: '第一次运行二' } })
  assert.equal(arrive(await preStep(ctx), ['job-1', 'job-2']).numerator, 2)

  /** job-1 is retried by the host and settles again at a NEW seq: that is news, not a repeat. */
  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-1', summary: '重跑之后的结果' } })
  const again = await preStep(ctx)
  assert.equal(again.length, 1, '新 seq 是新结果，必须能再转述')

  const ratio = arrive(again, ['job-1'])
  assert.deepEqual(
    { numerator: ratio.numerator, denominator: ratio.denominator },
    { numerator: 1, denominator: 1 },
    `重跑必须再到达一次（1/1），实测 ${ratio.numerator}/${ratio.denominator}`,
  )
  const text = again.map((message) => JSON.stringify(message)).join('\n')
  assert.match(text, /重跑之后的结果/u)
  assert.doesNotMatch(text, /第一次运行/u, '已经说过的结果不许随重跑再来一次')
})

test('v275 ④: 台账最终记下两个交付键 —— 分母不是「这一行说过话」，是「两个结果都说过」', async () => {
  const { root, log, ctx } = env()
  writeTwoJobRow(root, log)

  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-1', summary: '一' } })
  log.events.push({ type: 'job/settled', seq: lastSeq(log) + 1, data: { jobId: 'job-2', summary: '二' } })
  await preStep(ctx)

  const rows = readFileSync(join(root, LEDGER), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
  const latest = rows.at(-1)
  assert.ok(
    Array.isArray(latest.deliveredKeys) && latest.deliveredKeys.length === 2,
    `必须记下两个交付键，实测 ${JSON.stringify(latest.deliveredKeys)}`,
  )
  assert.match(String(latest.deliveredKeys[0]), /^job:job-1:\d+$/u)
  assert.match(String(latest.deliveredKeys[1]), /^job:job-2:\d+$/u)
})