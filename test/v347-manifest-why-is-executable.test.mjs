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
 * ── 五形态（S1 之后；前三种是**关于单元的事实**，后两种是**顺序**）────────────────────────────────
 *
 *   `体内声明（须先提升到模块级，非纯移动）`                    —— 声明在别的函数体内
 *   `容器（不搬动；随簇搬动只增加 import）`                      —— 只有 `apply`
 *   `依赖 apply() 赋值的模块级状态 <名>（不可搬；搬迁须先注入）`  —— 读模块级 `let/var`
 *   `与 <成员> 同簇（必须一起搬）`                               —— 调用了本文件另一个单元
 *   `无前置（搬动后容器只多一行 import）`                        —— 今天就能单独搬
 *
 * ── ④⑤ 两条是 S1 新增的，都用**编译器**算 ──────────────────────────────────────────────────────
 *
 *   ④ 任何标 `无前置` 的单元**不得**读模块级 `let/var` —— 那种单元搬走要成环（它读的状态由 `apply()`
 *     赋值，而 `apply()` 留在 `index.ts`）。用 AST 找标识符，不用正则：变量名可能出现在字符串、
 *     注释或属性名里。
 *   ⑤ 任何标 `无前置` 的单元**不得**调用本文件里另一个单元 —— 那正是「必须同簇」的定义。
 *
 * 用正则判这两条，会把「注释里提到」当成「读了」，判据就会变松（§四十六的同一课）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describeTypeScript } from '../scripts/ts-compiler.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MANIFEST = join(ROOT, 'docs', 'index-manifest.json')
const SOURCE = join(ROOT, 'src', 'index.ts')

export const FRESH = '无前置（搬动后容器只多一行 import）'
export const CONTAINER = '容器（不搬动；随簇搬动只增加 import）'
export const IN_BODY = '体内声明（须先提升到模块级，非纯移动）'
export const CLUSTER_OF = (head) => `与 ${head} 同簇（必须一起搬）`
const CLUSTER_SHAPE = /^与 (\S+) 同簇（必须一起搬）$/u

/**
 * Judge one `why` against the rules. Exported so the negative half exercises the SAME rules the
 * positive half enforces — a second implementation in the test would be a second source of truth.
 */
export function judgeWhy (unit, unitsByName) {
  const problems = []
  const why = String(unit.why ?? '')

  if (/必须先搬/u.test(why)) {
    problems.push(`${unit.name}: 「必须先搬」是不可满足的指令形态（apply / (module scope) 都不是可搬对象）`)
  }
  if (why === FRESH) {
    /**
     * Measured by the can-red: the first version returned here WITHOUT looking at `top`, so a nested
     * declaration relabelled 「无前置」 passed every rule — the one fact the label must never contradict
     * was the one fact not checked. A unit declared inside another function cannot be imported at all,
     * so 无前置 is not merely optimistic about it; it is false.
     */
    if (unit.top !== true) {
      problems.push(`${unit.name}: 标了「无前置」但 top=${String(unit.top)} —— 体内声明今天根本不能被 import`)
    }
    return problems
  }
  if (why === IN_BODY) {
    if (unit.top !== false) problems.push(`${unit.name}: 标了体内声明，但 top=${String(unit.top)} —— 事实与标签不符`)
    return problems
  }
  if (why === CONTAINER) {
    if (unit.name !== 'apply') problems.push(`${unit.name}: 只有容器 apply 可以写「容器（不搬动…）」`)
    return problems
  }
  if (/^依赖 apply\(\) 赋值的模块级状态 \S+（不可搬；搬迁须先注入）$/u.test(why)) {
    if (unit.top !== true) problems.push(`${unit.name}: 体内声明不可能读模块级可变状态，标签与事实不符`)
    return problems
  }

  const cluster = CLUSTER_SHAPE.exec(why)
  if (cluster === null) {
    problems.push(`${unit.name}: why 不是允许的形态之一：${JSON.stringify(why)}`)
    return problems
  }
  const head = cluster[1]
  if (!unitsByName.has(head)) {
    problems.push(`${unit.name}: 点名的簇成员 ${head} 不是本清单里的单元 —— 编出来的名字无法执行`)
  } else if (head === unit.name) {
    problems.push(`${unit.name}: 「与 ${head} 同簇」点的是它自己 —— 这句话什么也没说`)
  } else if (head === 'apply') {
    problems.push(`${unit.name}: 容器 apply 不搬动，不能作为「一起搬」的对象`)
  }
  return problems
}

test('v347 ①: every `why` is an executable ordering or a stated fact, and no prerequisite is the container', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const units = manifest.units
  assert.ok(Array.isArray(units) && units.length >= 100, `manifest must list the measured units, got ${units.length}`)

  const unitsByName = new Map(units.map((unit) => [unit.name, unit]))
  const problems = []
  const counts = { fresh: 0, clustered: 0, container: 0, inBody: 0, mutable: 0 }
  for (const unit of units) {
    problems.push(...judgeWhy(unit, unitsByName))
    if (unit.why === FRESH) counts.fresh += 1
    else if (unit.why === CONTAINER) counts.container += 1
    else if (unit.why === IN_BODY) counts.inBody += 1
    else if (/^依赖 apply\(\)/u.test(String(unit.why))) counts.mutable += 1
    else counts.clustered += 1
  }

  /** Every shape must be in use (except the container, which is exactly one) or a fact is being hidden. */
  assert.ok(counts.fresh > 0, 'expected at least one unit to be movable today')
  assert.ok(counts.clustered > 0, 'expected at least one unit to belong to a cluster')
  assert.equal(counts.container, 1, `exactly one unit is the container, measured ${counts.container}`)
  assert.ok(counts.inBody >= 1, 'the 9 in-body declarations must be labelled as such')
  assert.ok(counts.mutable >= 1, 'the units reading apply()-assigned state must be labelled as such')
  assert.equal(units.filter((unit) => /必须先搬/u.test(String(unit.why))).length, 0,
    'no `why` may still say 「必须先搬」 — apply and (module scope) are not movable objects')

  assert.deepEqual(problems, [], `manifest reasons that cannot be executed:\n  ${problems.join('\n  ')}`)
  console.log(`v347: ${units.length} units — ${counts.fresh} 无前置 · ${counts.clustered} 同簇 · ` +
    `${counts.inBody} 体内声明 · ${counts.mutable} 依赖 apply 状态 · ${counts.container} 容器`)
})

test('v347 ② (negative half): the judge can say NO to each shape it forbids', () => {
  const units = [
    { name: 'apply', why: CONTAINER, top: true },
    { name: 'leader', why: CLUSTER_OF('leader'), top: true },
    { name: 'member', why: CLUSTER_OF('leader'), top: true },
    { name: 'leaf', why: FRESH, top: true },
    { name: 'inner', why: IN_BODY, top: false },
  ]
  const byName = new Map(units.map((unit) => [unit.name, unit]))

  /** The measured old form: an unsatisfiable prerequisite. */
  const old = judgeWhy({ name: 'leaf', why: '它的引用者仍在 index.ts —— 搬它必须先搬 apply', top: true }, byName)
  assert.equal(old.length > 0, true, 'the old 「必须先搬 apply」 form must be rejected')

  const moduleScope = judgeWhy({ name: 'leaf', why: '它的引用者仍在 index.ts —— 搬它必须先搬 (module scope)', top: true }, byName)
  assert.equal(moduleScope.length > 0, true, '(module scope) as a prerequisite must be rejected too')

  /** Free text that reads like a reason but states no order. */
  const prose = judgeWhy({ name: 'leaf', why: '它是入口（apply / 注册面），搬动等于改注册形状', top: true }, byName)
  assert.equal(prose.length > 0, true, 'a sentence that is not one of the shapes must be rejected')

  /** Container shape is for the container only. */
  const wrongContainer = judgeWhy({ name: 'leaf', why: CONTAINER, top: true }, byName)
  assert.equal(wrongContainer.length > 0, true, 'only `apply` may be labelled 容器')

  /** The fact shapes must agree with the `top` flag — a label that contradicts the AST is worse than none. */
  const lyingBody = judgeWhy({ name: 'leaf', why: IN_BODY, top: true }, byName)
  assert.equal(lyingBody.length > 0, true, '体内声明 on a top-level unit must be rejected')

  /** An invented cluster member. */
  const invented = judgeWhy({ name: 'leaf', why: CLUSTER_OF('notAUnit'), top: true }, byName)
  assert.equal(invented.length > 0, true, 'a cluster member that is not a unit must be rejected')

  /** Naming itself says nothing. */
  const selfNamed = judgeWhy({ name: 'leaf', why: CLUSTER_OF('leaf'), top: true }, byName)
  assert.equal(selfNamed.length > 0, true, '「与 <自己> 同簇」must be rejected — it states no order')

  /** The container never travels, so it cannot be what you travel WITH. */
  const withContainer = judgeWhy({ name: 'leaf', why: CLUSTER_OF('apply'), top: true }, byName)
  assert.equal(withContainer.length > 0, true, 'naming apply as the thing to travel with must be rejected')

  /** And the compliant shapes pass with no complaint. */
  assert.deepEqual(judgeWhy({ name: 'leaf', why: FRESH, top: true }, byName), [], '无前置 must pass')
  assert.deepEqual(judgeWhy({ name: 'member', why: CLUSTER_OF('leader'), top: true }, byName), [], 'a member naming its peer must pass')
  assert.deepEqual(judgeWhy({ name: 'apply', why: CONTAINER, top: true }, byName), [], 'the container must pass')
  assert.deepEqual(judgeWhy({ name: 'inner', why: IN_BODY, top: false }, byName), [], '体内声明 must pass')
})

test('v347 ③ (negative half): a `无前置` unit must not CALL another unit of this file', async () => {
  /**
   * This is 「必须同簇」的定义，反过来用。判据用**编译器**算调用，不数括号也不做正则：正则会把注释里
   * 提到的名字、字符串里的名字、以及 `obj.f()` 的成员调用都算进来（前两种是误报，第三种是不同的东西）。
   */
  const { ts } = await describeTypeScript()
  assert.ok(ts !== undefined, '③ 需要编译器：没有它，这条判据只能猜')

  const sourceFile = ts.createSourceFile(SOURCE, readFileSync(SOURCE, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const byName = new Map()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) byName.set(statement.name.text, statement)
  }
  const callsOf = (node) => {
    const found = new Set()
    const walk = (child) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && byName.has(child.expression.text)) {
        found.add(child.expression.text)
      }
      ts.forEachChild(child, walk)
    }
    if (node.body !== undefined) walk(node.body)
    return [...found]
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const offenders = []
  for (const unit of manifest.units) {
    if (unit.why !== FRESH) continue
    const node = byName.get(unit.name)
    if (node === undefined) continue
    const calls = callsOf(node).filter((name) => name !== unit.name)
    if (calls.length > 0) offenders.push(`${unit.name}: 标了「无前置」却调用 ${calls.join('、')} —— 它必须同簇搬`)
  }
  assert.deepEqual(offenders, [], `③ 「无前置」必须真的没有前置：\n  ${offenders.join('\n  ')}`)
})

test('v347 ④ (negative half): a `无前置` unit must not read module-level `let`/`var`', async () => {
  /**
   * 模块级可变状态没有 import 通道：`let storeLayer` 由 `apply()` 赋值，而 `apply()` 留在 `index.ts`。
   * 一个读它的单元搬出去，要么 import 回去（成环），要么读到 `undefined`（静默错误）。两者都不可接受，
   * 所以这种单元不能标「无前置」。
   */
  const { ts } = await describeTypeScript()
  assert.ok(ts !== undefined, '④ 需要编译器')

  const text = readFileSync(SOURCE, 'utf8')
  const sourceFile = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const mutables = new Set()
  const byName = new Map()
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) mutables.add(declaration.name.text)
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) byName.set(statement.name.text, statement)
  }
  assert.ok(mutables.size > 0, '④ 本文件必须有模块级 let/var，否则这条判据在测空气')

  const readsOf = (node) => {
    const found = new Set()
    const walk = (child) => {
      if (ts.isIdentifier(child) && mutables.has(child.text)) {
        const parent = child.parent
        const isDeclarationName = parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === child
        if (!isDeclarationName) found.add(child.text)
      }
      ts.forEachChild(child, walk)
    }
    if (node.body !== undefined) walk(node.body)
    return [...found]
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const offenders = []
  for (const unit of manifest.units) {
    if (unit.why !== FRESH) continue
    const node = byName.get(unit.name)
    if (node === undefined) continue
    const reads = readsOf(node)
    if (reads.length > 0) offenders.push(`${unit.name}: 标了「无前置」却读模块级可变状态 ${reads.join('、')}`)
  }
  assert.deepEqual(offenders, [], `④ 读 apply() 赋值状态的单元不可搬：\n  ${offenders.join('\n  ')}`)

  /** The label must exist for exactly those units — a fact nobody states is a fact nobody checks. */
  const labelled = manifest.units.filter((unit) => /^依赖 apply\(\)/u.test(String(unit.why))).map((unit) => unit.name)
  assert.ok(labelled.includes('storePaths'), `④ storePaths 读 storeLayer，必须被点名；实测标了：${labelled.join('、')}`)
})
