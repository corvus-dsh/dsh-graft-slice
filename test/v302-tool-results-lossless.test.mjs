/**
 * ── v302 (B4-B B0b)：每个注册工具的 `execute` 返回值都必须是**无损 JSON** ────────────────────────
 *
 * ── 为什么这一条存在 ─────────────────────────────────────────────────────────────────────────────
 *
 * B0 是一只具体的 bug（`graft_prepare` 带了一个自有 `undefined` 键）。但它不是「某处写错了」，
 * 而是**一整类**：四仓所有 tool 的返回值都走同一个宿主校验，而**没有任何本地门禁在测它**。
 * B0 是怎么被发现的？用户截图。
 *
 * 逐条事后修是这条路：修一处，等下一张截图。所以这里做的是**机械版**：对每个注册工具用最小合法参数
 * 调一次，把返回值逐节点扫一遍，任何不可无损表示的节点 ⇒ 红，并点名「工具名 + JSON 路径」。
 *
 * ── 判据（五条，三条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① 每个注册工具的返回值都是无损 JSON（`undefined` / `NaN` / `Infinity` / function / symbol / 环）
 *   ② **分母**：扫描到的工具数 ≥ 1，且每个注册工具要么被调用过、要么在 `UNCALLABLE` 表里带理由
 *      —— 否则「一个都没跑」也会绿
 *   ③ 负向：扫描器能红 —— 喂它一个自有 `undefined` 键必须被点名
 *   ④ 负向：扫描器**不**误报合法值（`null` / 0 / `false` / `''` / 空数组 / 空对象）
 *   ⑤ 负向：错误回执也要合法（工具拒绝时返回的 `{ ok:false, error }` 同样是宿主校验的对象）
 *
 * ── 为什么每个工具用**独立 host** ───────────────────────────────────────────────────────────────
 *
 * `graft_slice_and_inject` 会真的建会话并退休来源。共享一个 host 时，前一个工具的副作用会改变后一个
 * 工具的输入，于是这条测试开始测「顺序」而不是「返回值」。独立 host 让每个用例只依赖它自己的最小参数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, clearGraftTargetsForTest, resetParadiseWriteCache, resetRetiredSessions } from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

/**
 * THE HOST'S RULE, WRITTEN OUT.
 *
 * Returns the JSON paths that cannot be represented losslessly. It reports PATHS rather than a boolean
 * because 「invalid」 sends the reader looking; `$.handover.notes = undefined` does not.
 */
function losslessProblems(value, path = '$', seen = new Set()) {
  if (value === undefined) return [`${path} = undefined`]
  if (value === null) return []
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? [] : [`${path} = ${String(value)}（非有限数）`]
  if (type === 'string' || type === 'boolean' || type === 'bigint') return []
  if (type === 'function') return [`${path} = function`]
  if (type === 'symbol') return [`${path} = symbol`]
  if (seen.has(value)) return [`${path} = 循环引用`]
  seen.add(value)
  const problems = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...losslessProblems(item, `${path}[${index}]`, seen)))
  } else {
    // `Object.keys` sees OWN enumerable keys — an own `undefined` is exactly the case B0 shipped.
    for (const key of Object.keys(value)) {
      problems.push(...losslessProblems(value[key], `${path}.${key}`, seen))
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      problems.push(`${path}.${String(symbol)} = symbol 键`)
    }
  }
  seen.delete(value)
  return problems
}

function makeEnv() {
  /**
   * A FRESH `ctx` IS NOT A FRESH PLUGIN. `graftTargets`, the retired/transferred sets and the paradise
   * write cache are MODULE-LEVEL: they survive between `apply()` calls in one process. Measured: without
   * these resets, `graft_slice_and_inject` retires the source, and the next tool's `graft_prepare` on the
   * same source throws `SOURCE_ALREADY_MIGRATED` — a failure attributable to the FIXTURE, not the tool.
   */
  resetRetiredSessions()
  clearGraftTargetsForTest()
  resetParadiseWriteCache()
  const sourceLog = makeSourceLog({ turns: 2 })
  const ctx = makeCtx({ sourceLog, persistence: new FakePersistence(), currentAgentId: sourceLog.session.id })
  apply(ctx, {})
  return { ctx, sourceLog }
}

/**
 * EVERY REGISTERED TOOL, with the smallest arguments that reach its handler.
 *
 * `args` produces the call; `before` runs in the SAME fresh host first, for the two tools that need real
 * state to return a real receipt (`graft_commit` needs a prepared slice — inventing a fake preparedId
 * would only exercise the error path, which is the LESS valuable half).
 */
const CALLS = {
  graft_slice_and_inject: {
    args: (env) => ({ sourceSessionId: env.sourceLog.session.id, newSessionId: 'session-b0b-target' }),
  },
  graft_resume_session: { args: () => ({ sessionId: 'session-not-retired' }) },
  graft_prepare: { args: () => ({}) },
  graft_commit: {
    /** The REAL sequence: prepare, then commit what it produced. */
    before: async (env) => {
      const prepared = await env.ctx._tools.get('graft_prepare').execute({}, { agent: { id: env.sourceLog.session.id } })
      assert.equal(typeof prepared.preparedId, 'string', 'B0b 的前置 prepare 必须成功，否则 commit 只测到错误路径')
      return { preparedId: prepared.preparedId, digest: prepared.digest }
    },
    args: (_env, carried) => ({ preparedId: carried.preparedId, digest: carried.digest }),
  },
  graft_search_history: { args: (env) => ({ sourceSessionId: env.sourceLog.session.id, query: 'session' }) },
  graft_read_result: { args: (env) => ({ sourceSessionId: env.sourceLog.session.id, seq: 1 }) },
  graft_update_goal: { args: () => ({ goal: '一个目标' }) },
  /**
   * `graft_constraint` refuses text that does not read like a RULE (measured: 「这条约束是一句完整的话。」
   * throws INVALID_ARGUMENT). A bare imperative is rejected too — actively-declared constraints are
   * injected unconditionally, so the shape judge is what the tool is FOR. The minimal legal call is a
   * real rule, not a shorter string.
   */
  graft_constraint: { args: () => ({ action: 'add', text: '绝对不能删除用户的原始日志。' }) },
  graft_debug_status: { args: () => ({}) },
}

const UNCALLABLE = new Map()

test('v302 ①: 每个注册工具的返回值都是无损 JSON', async () => {
  const { ctx, sourceLog } = makeEnv()
  const names = [...ctx._tools.keys()]
  assert.ok(names.length > 0, '没有注册任何工具 —— 分母为 0，这条测试什么也没证明')

  const failures = []
  let exercised = 0

  for (const name of names) {
    assert.equal(
      UNCALLABLE.has(name),
      false,
      `${name} 被列为不可调用，但它现在就注册着 —— 请给它最小合法参数，或说明它为什么还不该被注册`,
    )
    const spec = CALLS[name]
    assert.ok(
      typeof spec === 'object' && spec !== null && typeof spec.args === 'function',
      `${name} 在 CALLS 表里没有条目。新工具必须在这里登记最小合法参数，否则这条门禁会漏掉它。`,
    )

    /**
     * A FRESH HOST PER TOOL. `graft_slice_and_inject` really creates a session and RETIRES its source;
     * `graft_commit` consumes its prepared entry. On a shared host the second tool's input depends on the
     * first tool's side effect, which makes this test measure ORDER instead of return values. Measured
     * before this was fixed: sharing one host left 3 of 9 tools throwing, and the throws were attributable
     * to the sharing, not to the tools.
     */
    const env = makeEnv()

    let value
    try {
      const carried = typeof spec.before === 'function' ? await spec.before(env) : undefined
      value = await env.ctx._tools.get(name).execute(spec.args(env, carried), { agent: { id: env.sourceLog.session.id } })
    } catch (error) {
      /**
       * A THROW IS NOT A LOSSLESS VIOLATION — the host handles it on another path — but it must not be
       * silently counted as coverage either, so it is reported with the message.
       */
      failures.push(`${name} 抛出异常（没有返回值可查）：${String(error?.message ?? error)}`)
      continue
    }
    exercised += 1
    const problems = losslessProblems(value)
    if (problems.length > 0) failures.push(`${name} ⇒ ${problems.join('; ')}`)
  }

  // ② THE DENOMINATOR: every registered tool must have been exercised (or explicitly excused).
  /**
   * The failures are printed WITH the denominator on purpose. My first version asserted the count first,
   * so a 7/9 failure said 「见上面的异常列表」 and the list was never shown — the test hid its own cause,
   * which is the same class of defect as the gate it exists for.
   */
  assert.equal(
    exercised,
    names.length,
    `只实际调用了 ${exercised}/${names.length} 个工具。异常：\n${failures.join('\n') || '(无)'}`,
  )
  // ⑤ error receipts are validated by the same host rule, so they are held to the same standard.
  assert.deepEqual(failures, [], `以下工具的返回值不是无损 JSON：\n${failures.join('\n')}`)
})

test('v302 ③: 负向 —— 扫描器能红，且点名 JSON 路径', () => {
  const withUndefinedKey = { ok: true, handover: undefined }
  const problems = losslessProblems(withUndefinedKey)
  assert.deepEqual(problems, ['$.handover = undefined'], '自有 undefined 键必须被点名到路径')

  assert.deepEqual(losslessProblems({ ok: true, nested: { a: undefined } }), ['$.nested.a = undefined'])
  assert.deepEqual(losslessProblems([1, undefined]), ['$[1] = undefined'])
  assert.deepEqual(losslessProblems({ ok: true, n: NaN }), ['$.n = NaN（非有限数）'])
  assert.deepEqual(losslessProblems({ ok: true, n: Infinity }), ['$.n = Infinity（非有限数）'])
})

test('v302 ④: 负向 —— 合法值不许误报（否则这条门禁会被关掉）', () => {
  /**
   * A gate that cries wolf about ordinary values gets switched off, and then it protects nothing. So the
   * legal shapes are pinned: `null` is legal (it is not `undefined`), and 0 / false / '' are VALUES.
   */
  assert.deepEqual(losslessProblems({ ok: true, a: null, b: 0, c: false, d: '', e: [], f: {} }), [])
  assert.deepEqual(losslessProblems([]), [])
  assert.deepEqual(losslessProblems('text'), [])
  // The same object reached twice is not a cycle.
  const shared = { x: 1 }
  assert.deepEqual(losslessProblems({ a: shared, b: shared }), [])
})
