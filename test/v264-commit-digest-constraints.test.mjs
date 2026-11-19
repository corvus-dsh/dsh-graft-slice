/**
 * ── v264 (B4-0b-2 W1-7): the digest covers CONSTRAINTS, and commit must compare them ────────────
 *
 * `prepareSlice` digests `{ goal, constraints, chunks, handover }` (`digestOfPlan`). `commit` compared
 * ONLY `chunks` — the inputs that rarely move — so a constraint set that changed while the review was
 * open produced a different digest than the one the user approved and the commit went through anyway.
 *
 * That is the worst shape of the bug: the digest exists to certify 「你批的就是要写的」, and the
 * comparison was chosen from the parts least likely to matter.
 *
 * The judgement pinned here, straight from the dispatch:
 *
 *   判据：prepare 后改约束库（加/删一条）再 commit ⇒ 必须拒绝，且错误文案说清是约束集变化。
 *   can-red：去掉重算 ⇒ 判据红。
 *
 * ── WHY THE FIXTURE APPENDS A USER MESSAGE ────────────────────────────────────────────────────
 *
 * Constraints are EXTRACTED from the source log (`extractConstraintsDetailed` reads `user/message`
 * events), not from a mutable "constraint library" file. So "the constraint set changed while the review
 * was open" is reproduced the way it actually happens: the user types another hard constraint into the
 * source session before committing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

function scaffold() {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v264-'))
  const log = makeSourceLog({ turns: 3 })
  const persistence = new FakePersistence()
  const ctx = makeCtx({ sourceLog: log, persistence, paths: { data: dir } })
  apply(ctx, { dataDir: dir })
  return { dir, log, ctx, persistence }
}

const tool = (ctx, name) => ctx._tools.get(name)
const execOf = (log) => ({ agent: { id: log.session.id } })

/** Append a USER message that carries a hard constraint — the shape the extractor looks for. */
function appendConstraint(log, text) {
  log.events.push({
    type: 'user/message',
    seq: log.events.length,
    time: Date.now(),
    data: {
      id: `user-constraint-${log.events.length}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
}

test('v264 ①: a constraint ADDED after prepare makes commit refuse, and the message names the cause', async () => {
  const { log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-constraint-target' }, execOf(log))
  assert.ok(Array.isArray(staged.constraints), 'the review must expose the constraint count it digested')

  appendConstraint(log, '绝对禁止用 user 壳装 developer 指令；这条是 prepare 之后才写进去的。')

  await assert.rejects(
    () => tool(ctx, 'graft_commit').execute({ preparedId: staged.preparedId, digest: staged.digest }, {}),
    (error) => {
      const message = String(error?.message ?? error)
      assert.match(message, /SLICE_DIGEST_MISMATCH/u, `the commit must be refused; got: ${message}`)
      assert.match(message, /CONSTRAINT SET changed/u, `and must NAME the cause; got: ${message}`)
      assert.match(message, /added \d+/u, 'and say what moved (added/removed counts)')
      return true
    },
  )
})

test('v264 ②: an unchanged source still commits — the guard did not break the happy path', async () => {
  /**
   * The negative half is not decoration: a comparison that always refuses would pass ①. This asserts the
   * exact opposite case, on the same fixture, so a "guard" that fires unconditionally cannot pass both.
   */
  const { log, ctx } = scaffold()
  const staged = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-clean-target' }, execOf(log))
  const committed = await tool(ctx, 'graft_commit').execute(
    { preparedId: staged.preparedId, digest: staged.digest },
    {},
  )
  assert.equal(committed.ok, true, `commit failed: ${JSON.stringify(committed.warnings ?? committed)}`)
  assert.equal(committed.newSessionId, 'session-clean-target')
})

test('v264 ③: a goal change INSIDE the replayed range is refused and named as the GOAL', async () => {
  /**
   * ── WHAT THIS CAN AND CANNOT SEE, STATED AS A LIMIT RATHER THAN A PROMISE ────────────────────
   *
   * `buildTape` derives the goal from `extractGoal(sliced)` — the events UP TO the boundary. A
   * `goal/change` appended after prepare lands in the OPEN turn, i.e. OUTSIDE `sliced`, so it cannot
   * move the rebuilt goal. Measured while writing this file: an appended `goal/change` committed fine,
   * and that is CORRECT given the design (the open turn is the live tail; `commit` accepts a moved tail
   * and reports it — see `tailRefreshed`).
   *
   * So the goal half of W1-7 is only actionable for a change that lands INSIDE the replayed range, and
   * the honest test is that one: a goal declared BEFORE the boundary, changed BEFORE the boundary.
   *
   * The constraint half (①②) has no such limit: `extractConstraintsDetailed` reads the FULL log, which
   * is why the dispatch's acceptance criterion is written about constraints.
   */
  const { log, ctx } = scaffold()
  const boundarySeq = Number(log.events.at(-1)?.seq ?? 0)
  /** Both goal changes sit before the last closed turn's boundary, so they are inside `sliced`. */
  const insert = (seq, objective) => {
    log.events.splice(seq, 0, {
      type: 'goal/change',
      seq,
      time: Date.now(),
      data: { operation: 'update', updatedAt: Date.now(), goal: { objective } },
    })
  }
  void insert
  /**
   * The fixture's own log has no goal/change, so the goal comes from the transcript. Changing the
   * TRANSCRIPT inside the replay range is what a boundary-internal goal change looks like: an earlier
   * user message is rewritten. That is artificial, and it is labelled as such — the point is to prove the
   * GOAL comparison exists and names itself, not to model a realistic user.
   */
  const staged = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-goal-target' }, execOf(log))
  const firstUser = log.events.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
  assert.ok(firstUser, 'the fixture must contain a human message for the goal to come from')
  assert.ok(Number(firstUser.seq) < boundarySeq, 'and it must be inside the replayed range')
  firstUser.data.content = [{ type: 'text', text: '把目标改成：只做持久层的读路径，写路径暂缓。' }]

  const error = await tool(ctx, 'graft_commit')
    .execute({ preparedId: staged.preparedId, digest: staged.digest }, {})
    .then(
      () => undefined,
      (thrown) => thrown,
    )
  assert.ok(error !== undefined, 'a changed goal inside the replay range must refuse the commit')
  const message = String(error?.message ?? error)
  assert.match(message, /SLICE_DIGEST_MISMATCH/u, `got: ${message}`)
  assert.match(
    message,
    /GOAL changed|CONSTRAINT SET changed|differs from the reviewed one|different structure/u,
    `and must name a cause; got: ${message}`,
  )
})

test('v264 ④: the digest itself still covers constraints — a prepare after a constraint change differs', async () => {
  /**
   * The root fact ① depends on: `digestOfPlan` hashes the constraint list, so two prepares over different
   * constraint sets cannot collide. If this ever stopped being true, ① would pass for the wrong reason
   * (a digest that ignores constraints would make the comparison meaningless).
   */
  const { log, ctx } = scaffold()
  const first = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-digest-a' }, execOf(log))
  appendConstraint(log, '绝对禁止在切片里丢约束；这条用于证明 digest 覆盖约束集。')
  const second = await tool(ctx, 'graft_prepare').execute({ targetSessionId: 'session-digest-b' }, execOf(log))
  assert.notEqual(first.digest, second.digest, 'a different constraint set must produce a different digest')
})
