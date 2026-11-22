/**
 * ── v304 / B4-B B11 (P1): 失败之后不许立刻问同一句话 ──────────────────────────────────────────────
 *
 * 用户原话（派工单 §十四 B11）：**「一次 confirmed graft 失败后，同一水位不得立即重问；失败路径写抑制窗口，
 * 与 `resumeSession` 同一条机制（不新造一套）；抑制窗口过后，确认仍可被再次提出。」**
 *
 * 被修的两处，缺一处都不成立：
 *
 *   ① `src/index.ts` 的 confirm 失败 `catch` 只回滚内存/磁盘，**不写** `autoGraftSuppressedUntil`，
 *      而正常 `resumeSession` 必写。于是 `pendingConfirms` 已被消费、水位没变、下一 step 又满足条件。
 *   ② **更关键的一处**：真正「问」的地方是 pre-step 的 confirm 分支，它**从来不读**抑制窗口 ——
 *      `autoGraftIfNeeded` 读了，但问句不在那里。只修 ① 会得到一个「规则写了、没人执行」的窗口，
 *      正是本批反复出现的形状。
 *
 * 判据：
 *   ① 一次 confirmed graft 失败后，同一水位**不得**立即重问（连续两次 pre-step，第二次不产生新提示）
 *   ② 失败路径的窗口落在**与 `resumeSession` 同一个**持久化文件里（不是新造一套）
 *   ③ 负向：窗口过后，确认**仍可**被再次提出（不许「确认永久失效」）
 *
 * 失败注入是真实的：`create()` 抛错（模拟「磁盘满 / 目标已存在」），不是 mock 掉 graft 本身。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, clearGraftTargetsForTest, resetRetiredSessions } from '../index.js'
import { dispatchPreStep, FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const SUPPRESSION_FILE = '.auto-graft-suppressed.json'
const ASK = /是否由系统进行无缝迁移/u

/** A persistence whose NEXT `create()` fails — the failure is inside the graft, not beside it. */
class FailingCreatePersistence extends FakePersistence {
  constructor() {
    super()
    this.failNextCreate = true
  }

  async create(header, options) {
    if (this.failNextCreate) {
      this.failNextCreate = false
      throw new Error('injected: cannot create the target')
    }
    return super.create(header, options)
  }
}

function scaffold(persistence = new FakePersistence()) {
  resetRetiredSessions()
  clearGraftTargetsForTest()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-graft-b11-'))
  const sourceLog = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog, persistence, paths: { data: dir } })
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.75,
    contextWindowTokens: 100,
    graftMode: 'confirm',
  })
  return { ctx, dir, sourceLog }
}

const confirmTurn = (ctx, sourceLog, text) =>
  dispatchPreStep(ctx, {
    agent: { id: sourceLog.session.id },
    messages:
      text === undefined
        ? []
        : [{ id: 'm-confirm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
  })

test('v304 B11 ①: a FAILED confirmed graft is not followed by the SAME question on the same watermark', async () => {
  const { ctx, dir, sourceLog } = scaffold(new FailingCreatePersistence())

  // The watermark asks first — this is the flow the user actually sees.
  const first = await confirmTurn(ctx, sourceLog, undefined)
  assert.equal(first?.kind, 'reject')
  assert.match(first.reason, ASK)

  // The user agrees; the graft then fails for real (create() throws).
  const second = await confirmTurn(ctx, sourceLog, '确认')
  assert.doesNotMatch(String(second?.reason ?? ''), ASK,
    `the failed attempt must not itself re-ask; got: ${String(second?.reason)}`)

  // ① THE SECOND STEP AT THE SAME WATERMARK MUST NOT ASK AGAIN.
  const third = await confirmTurn(ctx, sourceLog, undefined)
  assert.equal(third, undefined,
    `the same watermark must not be asked twice in a row; got: ${JSON.stringify(third)}`)

  // ② AND THE WINDOW IS THE SHARED STORE — the same file `graft_resume_session` writes.
  assert.equal(existsSync(join(dir, SUPPRESSION_FILE)), true,
    `${SUPPRESSION_FILE} must exist: a memory-only window dies on restart and the question returns`)
  const persisted = JSON.parse(readFileSync(join(dir, SUPPRESSION_FILE), 'utf8'))
  const until = persisted[sourceLog.session.id]
  assert.equal(typeof until, 'number', 'the window must be persisted per session')
  assert.ok(until > Date.now() + 60_000, `the window must be in the future; got ${until - Date.now()}ms`)
  /**
   * AND IT MUST BE BOUNDED. Measured: the first version of this test only expired the window through
   * `resetRetiredSessions`, so setting the deadline to `now + 365 days` stayed GREEN — the test proved
   * 「the window can be lifted」 but not 「the window ends」. An unbounded suppression is 「确认」 turned
   * into 「永不再问」, which is the failure ③ exists to prevent, so the duration is asserted here.
   */
  assert.ok(until - Date.now() <= 60 * 60_000,
    `the window must be bounded; got ${Math.round((until - Date.now()) / 60_000)} minute(s)`)

  resetRetiredSessions()
})

test('v304 B11 ③ (negative half): after the window is over, the confirmation CAN be asked again', async () => {
  /**
   * Without this, ① is satisfied by 「the confirmation never comes back」 — a permanent mute is not a
   * fix, it is a slower version of the same dead end.
   */
  const { ctx, sourceLog } = scaffold(new FailingCreatePersistence())

  assert.match((await confirmTurn(ctx, sourceLog, undefined)).reason, ASK)
  await confirmTurn(ctx, sourceLog, '确认')
  assert.equal(await confirmTurn(ctx, sourceLog, undefined), undefined, 'suppressed while the window holds')

  // Expire the window exactly the way the process does on a clean activation: the map is rebuilt from
  // the store, and `resetRetiredSessions` is the documented state reset that drops the grace.
  resetRetiredSessions()

  const after = await confirmTurn(ctx, sourceLog, undefined)
  assert.equal(after?.kind, 'reject', 'once the window is over the watermark must be able to ask again')
  assert.match(after.reason, ASK)

  resetRetiredSessions()
})

test('v304 B11 ②b: a SUCCESSFUL confirmed graft is NOT suppressed (the window is for failures only)', async () => {
  /**
   * The window is written in a `catch`. If it were written on the success path too, every migration
   * would leave behind a window nobody needs — and the next real question would be silently withheld.
   * This is the negative half of ②: it must be absent when nothing failed.
   */
  const { ctx, dir, sourceLog } = scaffold(new FakePersistence())

  assert.match((await confirmTurn(ctx, sourceLog, undefined)).reason, ASK)
  const done = await confirmTurn(ctx, sourceLog, '确认')
  assert.match(String(done?.reason ?? ''), /已按确认迁移至新会话/u,
    `the confirmed graft must succeed in this fixture; got: ${String(done?.reason)}`)

  const persisted = existsSync(join(dir, SUPPRESSION_FILE))
    ? JSON.parse(readFileSync(join(dir, SUPPRESSION_FILE), 'utf8'))
    : {}
  assert.equal(persisted[sourceLog.session.id], undefined,
    'a successful migration must not leave a suppression window behind')

  resetRetiredSessions()
})
