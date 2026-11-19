/**
 * ── v248 (B4-0b-1 A6): "is this background work still running?" must have ONE answer ────────────
 *
 * The audit's B-3, measured: `extractOpenBackgroundWork` ended a subagent on `subagent/end`
 * (`src/index.ts:2939`), while `settledSince` recognised only `subagent-settled` / `subagent/settled`
 * (`core/pending-transfers.ts:104`). The two lists were written independently, and they disagreed on
 * exactly the subagent case:
 *
 *   · the ledger row kept `openSubagentIds`, so `isOwed` stayed true forever — the target was owed a
 *     result that could never arrive, and the tape promised a relay that would never come;
 *   · a `subagent/end` settle arriving AFTER the slice was invisible to the relay.
 *
 * The fix is one table (`SUBAGENT_SETTLE_EVENT_NAMES` + `JOB_SETTLE_EVENT_NAMES` + the open tables) and
 * two predicates both sides call. This file walks EVERY name in the tables through BOTH functions, so
 * adding a name on one side and forgetting the other cannot pass — the shape of the defect itself.
 *
 * ── why the table and not "the two functions agree on these three strings" ───────────────────────
 *
 * A hand-written list of expected names here would be a THIRD copy of the same knowledge: the day the
 * host adds a fourth shape, this test would keep passing while the relay went blind again. Walking the
 * real exported table means the test measures the source of truth, not a snapshot of it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { backgroundWorkInternals, extractOpenBackgroundWork, settledSince } from '../index.js'

/**
 * The table itself, read through the one object that exposes it. Walking the EXPORTED table is the
 * point: a hand-written copy of the names here would be a third truth, and it would keep passing the
 * day the host adds a fourth shape.
 */
const {
  JOB_OPEN_EVENT_NAMES,
  JOB_SETTLE_EVENT_NAMES,
  SUBAGENT_OPEN_EVENT_NAMES,
  SUBAGENT_SETTLE_EVENT_NAMES,
} = backgroundWorkInternals

let seq = 0
const nextSeq = () => (seq += 1)

const jobOpen = (jobId) => ({ type: JOB_OPEN_EVENT_NAMES[0], seq: nextSeq(), data: { jobId, label: `作业 ${jobId}` } })
const jobSettle = (jobId) => ({ type: JOB_SETTLE_EVENT_NAMES[0], seq: nextSeq(), data: { jobId, result: `${jobId} 完成` } })
const subOpen = (id) => ({ type: SUBAGENT_OPEN_EVENT_NAMES[0], seq: nextSeq(), data: { id, label: `子代理 ${id}` } })
/** The settle event is built from the TABLE's name so this file cannot drift from the code it tests. */
const subSettle = (name, id) => ({ type: name, seq: nextSeq(), data: { id, result: `${id} 完成` } })

test('v248 ①: 每一个「未完成」事件的结算名，抽取侧都认得 —— 表驱动，逐行', () => {
  for (const name of SUBAGENT_SETTLE_EVENT_NAMES) {
    const open = extractOpenBackgroundWork([subOpen('sa-1'), subSettle(name, 'sa-1')])
    assert.deepEqual(open.subagentIds, [], `${name} 必须结束这个子代理；实际仍开着 ${JSON.stringify(open.subagentIds)}`)
    assert.equal(open.subagents.length, 0, `${name} 之后不许再报一个未完成的子代理（它会把整行永久挂住）`)
  }
  for (const name of JOB_SETTLE_EVENT_NAMES) {
    const open = extractOpenBackgroundWork([jobOpen('j-1'), { type: name, seq: nextSeq(), data: { jobId: 'j-1' } }])
    assert.deepEqual(open.jobIds, [], `${name} 必须结束这个作业`)
  }
})

test('v248 ②: 同一个名字，结算侧也必须认得（否则转述永远等不到）', () => {
  for (const name of SUBAGENT_SETTLE_EVENT_NAMES) {
    const events = [subSettle(name, 'sa-2')]
    const sinceSeq = events[0].seq - 1
    const settled = settledSince(events, { jobs: [], subagents: ['sa-2'] }, sinceSeq)
    assert.equal(settled.length, 1, `结算侧认不出 ${name} ⇒ 这一行永远欠着；实测 ${JSON.stringify(settled)}`)
    assert.equal(settled[0].kind, 'subagent')
    assert.equal(settled[0].id, 'sa-2')
    assert.match(String(settled[0].summary), /完成/u, '摘要也要取到')
  }
  for (const name of JOB_SETTLE_EVENT_NAMES) {
    const events = [{ type: name, seq: nextSeq(), data: { jobId: 'j-2', result: 'ok' } }]
    const settled = settledSince(events, { jobs: ['j-2'], subagents: [] }, events[0].seq - 1)
    assert.equal(settled.length, 1, `结算侧认不出 ${name}`)
    assert.equal(settled[0].kind, 'job')
  }
})

test('v248 ③: 抽取侧与结算侧对「同一个名字」给同一个答案（配对判据）', () => {
  /**
   * The pairing is the point: for every settle name, the extractor must stop watching that id AND the
   * relay must report it. Either half alone can be "fixed" by editing one list — only both together
   * close the defect.
   */
  for (const name of [...JOB_SETTLE_EVENT_NAMES, ...SUBAGENT_SETTLE_EVENT_NAMES]) {
    const kind = JOB_SETTLE_EVENT_NAMES.includes(name) ? 'job' : 'subagent'
    const id = kind === 'job' ? 'paired-job' : 'paired-sub'
    const open = kind === 'job' ? jobOpen(id) : subOpen(id)
    const settle = { type: name, seq: nextSeq(), data: kind === 'job' ? { jobId: id } : { id } }
    const remaining = extractOpenBackgroundWork([open, settle])
    const stillOpen = kind === 'job' ? remaining.jobIds : remaining.subagentIds
    assert.equal(stillOpen.length, 0, `${name}：抽取侧仍认为它开着`)

    const settled = settledSince([settle], kind === 'job' ? { jobs: [id], subagents: [] } : { jobs: [], subagents: [id] }, settle.seq - 1)
    assert.equal(settled.length, 1, `${name}：结算侧没认出来`)
  }
})

test('v248 ⑤: 宿主的四个事件名清单被逐字钉住 —— 表驱动要配一张字面清单，否则删名字不会红', () => {
  /**
   * ── WHY A LITERAL LIST IS ALSO REQUIRED ────────────────────────────────────────────────────────
   *
   * ①–④ walk the EXPORTED table, which is the right way to prove the two sides agree — but it
   * cannot notice a name being DELETED from the table, because the walk shrinks with it (measured:
   * removing `subagent/end` left ①–④ all green). A table-driven test and a literal list answer two
   * different questions:
   *
   *   · the walk asks "do the two readers agree on every name we claim to know?" — consistency;
   *   · this list asks "do we still know every shape the HOST emits?" — completeness.
   *
   * So this literal is an INVENTORY OF HOST SHAPES, deliberately not derived from the code. It may
   * only change when the host actually adds or renames an event, and that change is the moment
   * someone must also check the relay still sees it.
   */
  assert.deepEqual([...backgroundWorkInternals.JOB_OPEN_EVENT_NAMES].sort(), ['job/registered'])
  assert.deepEqual([...backgroundWorkInternals.JOB_SETTLE_EVENT_NAMES].sort(), ['job/settled'])
  assert.deepEqual([...backgroundWorkInternals.SUBAGENT_OPEN_EVENT_NAMES].sort(), ['subagent/start'])
  assert.deepEqual(
    [...backgroundWorkInternals.SUBAGENT_SETTLE_EVENT_NAMES].sort(),
    ['subagent-settled', 'subagent/end', 'subagent/settled'].sort(),
    '宿主这三种「子代理结束」形状都出现过；少一种就会有一半子代理永远挂在欠账里',
  )
})

test('v248 ④: 只认表里的名字 —— 一个不认识的事件名不许被当成结算（宁缺不假）', () => {
  const events = [{ type: 'subagent/finished', seq: nextSeq(), data: { id: 'sa-3', result: 'x' } }]
  assert.deepEqual(settledSince(events, { jobs: [], subagents: ['sa-3'] }, events[0].seq - 1), [],
    '不在表里的名字不许被猜成结算 —— 猜错会把「还开着」塞进带子当「已完成」')
  assert.deepEqual(extractOpenBackgroundWork([subOpen('sa-3'), ...events]).subagentIds, ['sa-3'])
})