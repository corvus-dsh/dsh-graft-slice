/**
 * ── v347：`index-manifest.json` 的 `why` 必须是**可执行的顺序**，不是不可满足的指令 ──────────────
 *
 * 实测（lead §五十七.2）：旧 `why` 里 48 条写「必须先搬 apply」、56 条写「必须先搬 (module scope)」，
 * 合计 **104 / 191**。而 `apply` 是**容器**（注册面，永远不搬），`(module scope)` 不是可搬对象。
 * 更糟的是真实规则**相反**：`verify-pure-move.mjs` 的内容行定义**排除 import/export 行**，所以搬走
 * `apply` 调用的单元，`apply` 只多一行 import，多重集不变，判据照样 `IDENTICAL`。
 *
 * > **把不可满足的前提印成指令，比没有清单更坏**：读它的人会先去找「怎么搬 apply」，然后停在那里。
 *
 * 允许的三种形态（前两种是裁定给的，第三种是容器的唯一真话）：
 *
 *   `无前置（搬动后容器只多一行 import）`   —— 今天就能单独搬
 *   `与 <簇首> 同簇（必须一起搬）`          —— 它在调用闭包里，跟簇一起走
 *   `容器（不搬动；随簇搬动只增加 import）` —— 只有 `apply` 能这样写
 *
 * 判据（可机检、不需要重算调用图）：
 *
 *   ① 每个 `why` 必须是上面三种形态之一；
 *   ② 容器形态只允许出现在 `apply` 上；
 *   ③ `与 X 同簇` 里的 **X 必须是清单里的单元，且 X 自己也叫这个名字**（簇首自我点名）；
 *      同一个簇名至少被 2 个单元使用（只有自己一个的「簇」应该写 `无前置`）；
 *   ④ 任何 `why` 里不得再出现「必须先搬」（那是被删掉的那种指令）。
 *
 * ③ 是让这张表**能被审**却不必重算图的那一条：如果一个 `why` 编了一个名字，那个名字若不是单元、
 * 或它自己写着 `无前置`，判据立刻红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MANIFEST = join(ROOT, 'docs', 'index-manifest.json')

export const FRESH = '无前置（搬动后容器只多一行 import）'
export const CONTAINER = '容器（不搬动；随簇搬动只增加 import）'
export const CLUSTER_OF = (head) => `与 ${head} 同簇（必须一起搬）`
const CLUSTER_SHAPE = /^与 (\S+) 同簇（必须一起搬）$/u

/**
 * Judge one `why` against the rules. Exported so the negative half exercises the SAME rules the
 * positive half enforces — a second implementation in the test would be a second source of truth.
 *
 * `unitsByName` maps name → unit, for the cluster-head check.
 */
export function judgeWhy (unit, unitsByName, labelCount) {
  const problems = []
  const why = String(unit.why ?? '')

  if (/必须先搬/u.test(why)) {
    problems.push(`${unit.name}: 「必须先搬」是不可满足的指令形态（apply / (module scope) 都不是可搬对象）`)
  }

  if (why === FRESH) return problems
  if (why === CONTAINER) {
    if (unit.name !== 'apply') problems.push(`${unit.name}: 只有容器 apply 可以写「容器（不搬动…）」，其它单元必须是前两种形态之一`)
    return problems
  }

  const cluster = CLUSTER_SHAPE.exec(why)
  if (cluster === null) {
    problems.push(`${unit.name}: why 不是允许的三种形态之一：${JSON.stringify(why)}`)
    return problems
  }

  const head = cluster[1]
  const headUnit = unitsByName.get(head)
  if (headUnit === undefined) {
    problems.push(`${unit.name}: 点名的簇成员 ${head} 不是本清单里的单元 —— 编出来的名字无法执行`)
  } else if (head === unit.name) {
    problems.push(`${unit.name}: 「与 ${head} 同簇」点的是它自己 —— 这句话什么也没说`)
  } else if (head === 'apply') {
    problems.push(`${unit.name}: 容器 apply 不搬动，不能作为「一起搬」的对象`)
  }
  return problems
}

test('v347 ①: every `why` is an executable ordering, and no prerequisite is the container', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const units = manifest.units
  assert.ok(Array.isArray(units) && units.length >= 100, `manifest must list the measured units, got ${units.length}`)

  const unitsByName = new Map(units.map((unit) => [unit.name, unit]))
  const labelCount = new Map()
  for (const unit of units) labelCount.set(String(unit.why), (labelCount.get(String(unit.why)) ?? 0) + 1)

  const problems = []
  let fresh = 0
  let clustered = 0
  let container = 0
  for (const unit of units) {
    problems.push(...judgeWhy(unit, unitsByName, labelCount))
    if (unit.why === FRESH) fresh += 1
    else if (unit.why === CONTAINER) container += 1
    else clustered += 1
  }

  /** Both movable shapes must be in use, and the container must be named exactly once. */
  assert.ok(fresh > 0, 'expected at least one unit to be movable today')
  assert.ok(clustered > 0, 'expected at least one unit to belong to a cluster')
  assert.equal(container, 1, `exactly one unit is the container, measured ${container}`)
  /** The old unsatisfiable text must be gone entirely — that is the change this criterion exists for. */
  assert.equal(units.filter((unit) => /必须先搬/u.test(String(unit.why))).length, 0,
    'no `why` may still say 「必须先搬」 — apply and (module scope) are not movable objects')

  assert.deepEqual(problems, [], `manifest reasons that cannot be executed:\n  ${problems.join('\n  ')}`)
  console.log(`v347: ${units.length} units — ${fresh} 无前置 · ${clustered} 同簇 · ${container} 容器; ` +
    `${new Set(units.filter((unit) => CLUSTER_SHAPE.test(String(unit.why))).map((unit) => unit.why)).size} cluster(s)`)
})

test('v347 ② (negative half): the judge can say NO to each shape it forbids', () => {
  const units = [
    { name: 'apply', why: CONTAINER },
    { name: 'leader', why: CLUSTER_OF('leader') },
    { name: 'member', why: CLUSTER_OF('leader') },
    { name: 'leaf', why: FRESH },
  ]
  const byName = new Map(units.map((unit) => [unit.name, unit]))
  const count = new Map()
  for (const unit of units) count.set(unit.why, (count.get(unit.why) ?? 0) + 1)

  /** The measured old form: an unsatisfiable prerequisite. */
  const old = judgeWhy({ name: 'leaf', why: '它的引用者仍在 index.ts —— 搬它必须先搬 apply' }, byName, count)
  assert.equal(old.length > 0, true, 'the old 「必须先搬 apply」 form must be rejected')

  const moduleScope = judgeWhy({ name: 'leaf', why: '它的引用者仍在 index.ts —— 搬它必须先搬 (module scope)' }, byName, count)
  assert.equal(moduleScope.length > 0, true, '(module scope) as a prerequisite must be rejected too')

  /** Free text that reads like a reason but states no order. */
  const prose = judgeWhy({ name: 'leaf', why: '它是入口（apply / 注册面），搬动等于改注册形状' }, byName, count)
  assert.equal(prose.length > 0, true, 'a sentence that is not one of the three shapes must be rejected')

  /** Container shape is for the container only. */
  const wrongContainer = judgeWhy({ name: 'leaf', why: CONTAINER }, byName, count)
  assert.equal(wrongContainer.length > 0, true, 'only `apply` may be labelled 容器')

  /** An invented cluster member. */
  const invented = judgeWhy({ name: 'leaf', why: CLUSTER_OF('notAUnit') }, byName, count)
  assert.equal(invented.length > 0, true, 'a cluster member that is not a unit must be rejected')

  /** Naming itself says nothing. */
  const selfNamed = judgeWhy({ name: 'leaf', why: CLUSTER_OF('leaf') }, byName, count)
  assert.equal(selfNamed.length > 0, true, '「与 <自己> 同簇」must be rejected — it states no order')

  /** The container never travels, so it cannot be what you travel WITH. */
  const withContainer = judgeWhy({ name: 'leaf', why: CLUSTER_OF('apply') }, byName, count)
  assert.equal(withContainer.length > 0, true, 'naming apply as the thing to travel with must be rejected')

  /** And the compliant shapes pass with no complaint. */
  assert.deepEqual(judgeWhy({ name: 'leaf', why: FRESH }, byName, count), [], '无前置 must pass')
  assert.deepEqual(judgeWhy({ name: 'member', why: CLUSTER_OF('leader') }, byName, count), [], 'a member naming its head must pass')
  assert.deepEqual(judgeWhy({ name: 'apply', why: CONTAINER }, byName, count), [], 'the container must pass')
})
