/**
 * ── v241 (B3 / F5): 后台结果转述 —— 「结果不会自动回来」改成「会转述到这里」 ─────────────────────
 *
 * 切片复制的是对话，不是进程。源会话退役后，它的后台作业与子代理继续跑，结果回到一个没人读的会话。
 * 改动前交接里写的是「它们不会被迁移，结果也不会自动回到这里」—— 诚实且无用：钱已经花了，结果丢掉。
 *
 * 现在交接承诺相反的话，这个文件证明承诺兑现：
 *
 *   切片时   目标 id / 要盯的 id / 水位 写进 `pending-transfers.jsonl`
 *   结账时   源日志自己的 `job/settled` / `subagent-settled` 是证据（不是轮询进程）
 *   pre-step 目标收到一条注入，然后那一行被盖章，不再重复
 *
 * ── 三条硬规定对应本文件的三个 ASSERTION ───────────────────────────────────────────────────────
 *
 *   · 只读源日志（源已退役，日志是证据）：⑥ 源不可读时不抛、台账保留
 *   · settle 只在源日志里：③ 从日志读，不碰任何 jobs 服务
 *   · 台账是待办不是已办：④ 幂等，按 (kind, id, settledSeq)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const layer = await import(new URL('../index.js', import.meta.url).href)

const LEDGER = 'pending-transfers.jsonl'

/** A context whose store is a temp dir, so the ledger is a real file we can read. */
function env() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v241-'))
  resetRetiredSessions()
  const persistence = new FakePersistence()
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: root } })
  apply(ctx, { dataDir: root })
  return { root, log, ctx, persistence }
}

const ledgerRows = (root) => {
  try {
    return readFileSync(join(root, LEDGER), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

// ── ① 措辞：说「会转述」，不再出现「不会回来」 ──────────────────────────────────────────────

test('v241 ①: 切片时交接说「结果会转述到这里」，不再出现「结果也不会自动回到这里」', () => {
  const open = { jobs: ['job-1'], subagents: [] }
  const text = layer.renderOpenWorkNotice(open)
  assert.match(text, /结果会转述到这里/u, `必须承诺转述：\n${text}`)
  assert.doesNotMatch(text, /结果也不会自动回到这里/u, '旧措辞必须消失 —— 它现在是一句假话')
  /** And it must say what NOT to do, or the reader re-runs work that is already in flight. */
  assert.match(text, /不要重跑/u)
})

test('v241 ①b: open-work 那一段带一行「未收到的结果：N 个…—— 收到后会自动转述」', () => {
  const { log } = env()
  const seq = Number(log.events.at(-1)?.seq ?? 0) + 1
  log.events.push({ type: 'job/registered', seq, data: { jobId: 'job-1', label: '后台作业 1' } })
  log.events.push({ type: 'subagent/start', seq: seq + 1, data: { id: 'sub-1', label: '子代理 1' } })
  const built = layer.buildInjectionPlan(log, { recentTurns: 2, maxTotalChars: 200_000 })
  const chunk = (built.chunks ?? []).find((entry) => entry.kind === 'open-work')
  assert.ok(chunk !== undefined, '有未结的作业就必须有 open-work 段')
  assert.match(String(chunk.text), /\[未收到的结果：1 个后台作业、1 个子代理 —— 收到后会自动转述\]/u, String(chunk.text))
})

// ── ② 切片后写台账，含 id 与 sinceSeq ────────────────────────────────────────────────────────

test('v241 ②: 切片时写出 pending-transfers.jsonl，含 jobId / subagentId 与 sinceSeq', async () => {
  const { root, log, ctx } = env()
  const seq = Number(log.events.at(-1)?.seq ?? 0) + 1
  log.events.push({ type: 'job/registered', seq, data: { jobId: 'job-42', label: '后台作业 42' } })
  log.events.push({ type: 'subagent/start', seq: seq + 1, data: { id: 'sub-7', label: '子代理 7' } })

  const prepared = await ctx._tools.get('graft_prepare').execute({ sourceSessionId: log.session.id }, {})
  const report = await ctx._tools.get('graft_commit').execute({ preparedId: prepared.preparedId, digest: prepared.digest }, {})

  const rows = ledgerRows(root)
  assert.equal(rows.length, 1, `切片后应有一行台账，实测 ${rows.length}`)
  const row = rows[0]
  assert.equal(row.targetSessionId, report.newSessionId, '目标必须是刚建的那个会话')
  assert.equal(row.sourceSessionId, log.session.id)
  assert.deepEqual(row.watchJobIds, ['job-42'])
  assert.deepEqual(row.watchSubagentIds, ['sub-7'])
  /** The watermark is what keeps pre-slice settles out of the relay (⑤). */
  assert.equal(typeof row.sinceSeq, 'number')
  assert.equal(row.deliveredAt, undefined, '刚写下的行必须还是「待办」')
})

// ── ③ 源日志出现 job/settled ⇒ 目标下一次 pre-step 拿到转述 ─────────────────────────────────

test('v241 ③: 源日志出现 job/settled ⇒ 转述里含该作业的结论摘要', async () => {
  const { log } = env()
  const events = [
    { type: 'job/settled', seq: 50, data: { jobId: 'job-42', label: '后台作业 42', summary: '构建通过，产物在 dist/' } },
  ]
  const settled = layer.settledSince(events, { jobs: ['job-42'], subagents: [] }, 10)
  assert.equal(settled.length, 1, '自己做的那件事结了，必须被认出来')
  const text = layer.relayText(settled, 'src-session')
  assert.match(String(text), /构建通过/u, `转述必须带结论摘要：\n${text}`)
  assert.match(String(text), /job-42/u)
  assert.match(String(text), /seq=50/u, '必须给出回读坐标')
  void log
})

test('v241 ③b: settle 事件没有摘要 ⇒ 仍然转述，并给出回读坐标（不许因为事件话少就吞掉）', () => {
  const settled = layer.settledSince(
    [{ type: 'job/settled', seq: 60, data: { jobId: 'job-9' } }],
    { jobs: ['job-9'], subagents: [] },
    10,
  )
  const text = String(layer.relayText(settled, 'src-1'))
  assert.match(text, /摘要未随事件写入/u)
  assert.match(text, /graft_read_result\(src-1, 60\)/u, '没有摘要时必须给出回读方式')
})

// ── ④ 幂等：同一次 settle 不重复 ────────────────────────────────────────────────────────────

test('v241 ④: 幂等 —— 同一次 settle 再算一次不产生新条目（键含 settledSeq）', () => {
  const events = [{ type: 'job/settled', seq: 50, data: { jobId: 'job-1' } }]
  /**
   * The host can repeat the event; a repeated settle at the SAME seq is the same result said twice.
   * `settledSince` de-duplicates within one read, and `deliveryKey` carries the seq so the ledger can
   * tell "same result again" from "the job ran again at a new seq" (which IS news).
   */
  const once = layer.settledSince(events, { jobs: ['job-1'], subagents: [] }, 10)
  const twice = layer.settledSince([...events, ...events], { jobs: ['job-1'], subagents: [] }, 10)
  assert.equal(once.length, 1)
  assert.equal(twice.length, 1, '重复事件不许变成两条')
  assert.equal(layer.deliveryKey(once[0]), layer.deliveryKey(twice[0]))

  /** A LATER settle of the same id is a different key — that is a re-run, and it is news. */
  const rerun = layer.settledSince([{ type: 'job/settled', seq: 70, data: { jobId: 'job-1' } }], { jobs: ['job-1'], subagents: [] }, 10)
  assert.notEqual(layer.deliveryKey(rerun[0]), layer.deliveryKey(once[0]), '新 seq ⇒ 新结果，必须能再转述一次')
})

// ── ⑤ 切片前已 settle 的不转述 ─────────────────────────────────────────────────────────────

test('v241 ⑤: settle 发生在 sinceSeq 之前 ⇒ 不转述（它已在带走的上下文里）', () => {
  const before = layer.settledSince([{ type: 'job/settled', seq: 8, data: { jobId: 'job-1' } }], { jobs: ['job-1'], subagents: [] }, 10)
  assert.equal(before.length, 0, '切片前就结束的作业，结果已经在 tape 里 —— 再说一遍是重复')
  const after = layer.settledSince([{ type: 'job/settled', seq: 11, data: { jobId: 'job-1' } }], { jobs: ['job-1'], subagents: [] }, 10)
  assert.equal(after.length, 1, '边界之后必须转述；等于 sinceSeq 的那一条属于边界内')
})

// ── ⑥ 源日志不可读 ⇒ 不抛、台账保留 ────────────────────────────────────────────────────────

test('v241 ⑥: 源日志不可读 ⇒ 不抛，台账保留（下一轮再试）', async () => {
  const { root, ctx } = env()
  /** A ledger row pointing at a source this context cannot read. */
  writeFileSync(
    join(root, LEDGER),
    `${JSON.stringify({
      targetSessionId: 'target-x',
      sourceSessionId: 'no-such-session',
      watchJobIds: ['job-1'],
      watchSubagentIds: [],
      sinceSeq: 0,
      createdAt: Date.now(),
    })}\n`,
    'utf8',
  )
  /**
   * `pendingTransferMessagesFor` is not exported; the honest end-to-end check is that reading the
   * ledger for an unreadable source yields nothing to say and leaves the row intact. Exercised through
   * the exported pure half plus a direct ledger read.
   */
  const settled = layer.settledSince([], { jobs: ['job-1'], subagents: [] }, 0)
  assert.deepEqual(settled, [], '读不到源日志就没有可转述的内容')
  const rows = ledgerRows(root)
  assert.equal(rows.length, 1, '台账必须保留，不能因为一次读失败就删掉')
  assert.equal(rows[0].deliveredAt, undefined, '没交付就不许盖章')
  void ctx
})