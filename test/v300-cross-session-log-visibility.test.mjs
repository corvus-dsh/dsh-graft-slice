/**
 * ── v300 (B4-B B8)：跨会话读日志必须属于「我自己的历史」──────────────────────────────────────────
 *
 * ── 缺陷（`src/index.ts` 的 `graft_read_result` / `graft_search_history`）────────────────────
 *
 * 两个工具的 `sourceSessionId` 是**调用方给的参数**，然后直接
 * `ctx.sessionQuery.readSession(id)`。`graft_read_result` 的描述自己写着：
 *
 *     「This bypasses cross-session tool authorization and reads the source log directly」
 *
 * 也就是说，任何拿到一个会话 id 的调用方，都能读到那个会话的**整份日志** —— 包括它自己的用户原话、
 * 工具输出、diff。派工单把这条列为 B8。
 *
 * ── 判定依据：graft 的 pair 记录 ────────────────────────────────────────────────────────────────
 *
 * 这一层已经知道唯一一种它有权使用的关系：目标会话的 mark 记着它是从哪个会话切片来的
 * （`GraftTargetMark.sourceSessionId`），而一条迁移链记录每一次跳转。于是「我能读 X 吗」由 graft 的
 * 记录回答，不由参数里的声明回答。允许集合只有两件：
 *
 *   - **自己**：本会话的历史当然是自己的；
 *   - **上游**：本会话是被 X 切出来的，或本会话的来源本身可递归到达。一个目标存在的**全部意义**就是
 *     接着一段更早的对话 —— 拒绝来源链等于让每一次切片都失效。
 *
 * 其余一律拒绝。派工单给了 `allowCrossSession: true` 这个软选项，**没有采纳**：调用方传一个布尔值
 * 自证清白，和 v2.1.0 删掉的 `skipConfirmation` 是同一件东西。
 *
 * ── 无身份时怎么办（用户裁定 2026-11-21：宽严分级）────────────────────────────────────────────
 *
 * 宿主不提供 `exec.agent.id` 时无法归因。实测：现有两处工具调用都传空 `exec`。**严格拒绝会让这两个
 * 工具在那样的宿主上整体失效**。所以：放行，但**点名** `logVisibility: 'unattributed'` —— 与 B6 的
 * `ownership: 'unattributed'` 同一处理：**「无法检查」必须作为它自己的状态可见**，不能塌缩成「检查过，没问题」。
 *
 * ── 判据（六条，三条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① 有身份、读**自己** ⇒ 放行，`logVisibility: 'self'`
 *   ② 有身份、读**上游来源** ⇒ 放行，`logVisibility: 'ancestor'`（否则每次切片的回读都断）
 *   ③ 有身份、读**无关会话** ⇒ 拒绝，且回执点名两个 id
 *   ④ 无身份 ⇒ 放行，但 `logVisibility: 'unattributed'` 且带说明（不许静默当成已核实）
 *   ⑤ 负向：拒绝时**没有真的读日志**（用计数探针证明，不是看返回文案）
 *   ⑥ 负向：`graft_search_history` 与 `graft_read_result` 必须**同一条规则**（只修一个等于没修）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/**
 * A host whose `readSession` COUNTS every call, so ⑤ can prove a refusal never touched the file.
 *
 * `makeCtx` is built with a real snapshot, then `sessionQuery.readSession` is wrapped — the plugin
 * resolves the service at call time, so the wrapper is what it sees.
 */
function setup(options = {}) {
  const sourceLog = makeSourceLog({ turns: 3, sourceSessionId: options.sourceSessionId ?? 'session-source' })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), currentAgentId: options.currentAgentId })
  apply(ctx, {})

  const reads = []
  const query = ctx.sessionQuery
  const original = query.readSession.bind(query)
  query.readSession = async (id) => {
    reads.push(id)
    return original(id)
  }
  return { ctx, reads, sourceLog }
}

const readTool = (ctx) => ctx._tools.get('graft_read_result')
const searchTool = (ctx) => ctx._tools.get('graft_search_history')

/** A seq that exists in the source log, so 「found」 is the only thing the visibility gate can change. */
function aResultSeq(sourceLog) {
  const event = sourceLog.events.find((candidate) => candidate.type === 'tool/result')
  return Number(event.seq)
}

test('v300 ①: 有身份、读自己的会话 ⇒ 放行，并报告 self', async () => {
  const { ctx, sourceLog } = setup({ currentAgentId: 'session-mine', sourceSessionId: 'session-mine' })
  const reply = await readTool(ctx).execute(
    { sourceSessionId: 'session-mine', seq: aResultSeq(sourceLog) },
    { agent: { id: 'session-mine' } },
  )

  assert.equal(reply.found, true, `自己的会话必须能读，实测 ${JSON.stringify(reply)}`)
  assert.equal(reply.logVisibility, 'self')
})

test('v300 ②: 有身份、读上游来源 ⇒ 放行并报告 ancestor（否则每次切片的回读都断）', async () => {
  /**
   * The lineage is established the way the product establishes it: make `session-target` a TARGET of
   * `session-source` with a real slice. Building the relationship by hand would test my own fixture.
   */
  const { ctx, sourceLog } = setup({ currentAgentId: 'session-target', sourceSessionId: 'session-source' })
  const sliced = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: 'session-source', newSessionId: 'session-target' }, { agent: { id: 'session-source' } })
  assert.equal(sliced.ok, true, `切片本身必须成功，实测 ${JSON.stringify(sliced.error ?? sliced.stage ?? {})}`)

  const reply = await readTool(ctx).execute(
    { sourceSessionId: 'session-source', seq: aResultSeq(sourceLog) },
    { agent: { id: 'session-target' } },
  )

  assert.notEqual(reply.found, false, `上游来源必须能读，实测 ${JSON.stringify(reply).slice(0, 300)}`)
  assert.equal(reply.logVisibility, 'ancestor')
})

test('v300 ③: 有身份、读无关会话 ⇒ 拒绝，且点名两个 id', async () => {
  const { ctx, sourceLog } = setup({ currentAgentId: 'session-mine', sourceSessionId: 'session-stranger' })
  const reply = await readTool(ctx).execute(
    { sourceSessionId: 'session-stranger', seq: aResultSeq(sourceLog) },
    { agent: { id: 'session-mine' } },
  )

  assert.equal(reply.found, false, '无关会话不许读到')
  const text = String(reply.text ?? '')
  assert.match(text, /拒绝/u, `必须说明是拒绝，实测：${text}`)
  assert.match(text, /session-stranger/u, '必须点名被请求的会话')
  assert.match(text, /session-mine/u, '必须点名本会话')
})

test('v300 ④: 无身份 ⇒ 放行，但必须点名 unattributed（不许静默当成已核实）', async () => {
  const { ctx, sourceLog } = setup({ currentAgentId: 'session-mine', sourceSessionId: 'session-stranger' })
  const reply = await readTool(ctx).execute({ sourceSessionId: 'session-stranger', seq: aResultSeq(sourceLog) }, {})

  assert.equal(reply.found, true, `无身份时放行（用户裁定），实测 ${JSON.stringify(reply).slice(0, 240)}`)
  assert.equal(reply.logVisibility, 'unattributed', '但必须把「没核实」写进回执')
  assert.match(String(reply.logVisibilityNote ?? ''), /无法证明|未核实/u, '并且说清未核实的是什么')
})

test('v300 ⑤: 负向 —— 拒绝时没有真的去读日志', async () => {
  /**
   * The refusal could satisfy ③ by reading first and then throwing the result away. This case is the
   * one that notices: the probe counts `readSession` calls.
   *
   * A FRESH HOST, AND A COUNT OF `'session-stranger'` READS ONLY. An earlier version compared the
   * TOTAL delta and saw 1, which took three probes to explain: ② really slices, and a slice legitimately
   * reads its source log — on a host shared between cases, that read can land between the baseline and
   * the assertion and be attributed to the refusing call. Counting the specific id under test cannot be
   * polluted by work on any other id, which makes the case correct regardless of ordering instead of
   * correct only in the current order.
   */
  const { ctx, reads } = setup({ currentAgentId: 'session-mine', sourceSessionId: 'session-stranger' })
  const readsOfStranger = () => reads.filter((id) => id === 'session-stranger').length
  const before = readsOfStranger()
  await readTool(ctx).execute({ sourceSessionId: 'session-stranger', seq: 1 }, { agent: { id: 'session-mine' } })
  await searchTool(ctx).execute({ sourceSessionId: 'session-stranger', query: 'x' }, { agent: { id: 'session-mine' } })

  assert.equal(
    readsOfStranger(),
    before,
    `拒绝路径不许调用 readSession(session-stranger)，实测多读了 ${readsOfStranger() - before} 次`,
  )
})

test('v300 ⑥: 负向 —— 两个工具必须同一条规则（只修一个等于没修）', async () => {
  const { ctx } = setup({ currentAgentId: 'session-mine', sourceSessionId: 'session-stranger' })

  const read = await readTool(ctx).execute({ sourceSessionId: 'session-stranger', seq: 1 }, { agent: { id: 'session-mine' } })
  const search = await searchTool(ctx).execute(
    { sourceSessionId: 'session-stranger', query: 'x' },
    { agent: { id: 'session-mine' } },
  )

  assert.equal(read.found, false, 'read_result 必须拒绝')
  assert.equal(search.found, false, 'search_history 必须同样拒绝')
  assert.match(String(search.error ?? ''), /拒绝/u, `search 的拒绝要说明原因，实测 ${JSON.stringify(search).slice(0, 200)}`)
})
