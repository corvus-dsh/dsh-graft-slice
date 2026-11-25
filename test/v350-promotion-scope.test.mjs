/**
 * ── v350：S3 之后的**作用域事实**必须与清单一致 ────────────────────────────────────────────────
 *
 * S3 把 4 个体内声明提到模块级。这条判据钉住三件事，都用编译器算：
 *
 *   ① 那 4 个现在是**顶层**（`apply()` 的第一个直接子声明）——否则它们仍然不可 import，
 *      而「已提升」这句话就成了没被验证的断言；
 *   ② `apply()` 体内的嵌套声明数从 **9 降到 5**，且剩下的 5 个是**该剩下的**（它们各需 2–8 个
 *      外部名：`ctx` / `agentId` / `captureDraft` …，提升它们要改签名，不是纯移动）；
 *   ③ **负向**：模块级里不得出现重复的同名声明的可执行副本（提升的常见事故是「贴上去、忘了删」，
 *      以及「删了、贴了两次」——两个声明同名时 JS 不报错，后者静默生效）。
 *
 * ── 为什么不需要断言「行为不变」────────────────────────────────────────────────────────────────
 *
 * 行为不变由 `verify-pure-move` 与全量测试证明，且它是**本步的出口条件**，不是本判据能测的东西。
 * 一条判据去断言「行为没变」通常只会变成「跑一遍测试看它红不红」——那已经有测试在做了。
 * 这里只钉「位置这个事实」：它是编译器能直接给出的，也是把「已提升」从说法变成事实的唯一东西。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeTypeScript } from '../scripts/ts-compiler.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(ROOT, 'src', 'index.ts')
const MANIFEST = join(ROOT, 'docs', 'index-manifest.json')

const PROMOTED = ['isSteeringOnly', 'validateAppendIsLifecycleSafe', 'openStepOf', 'continuationTitle']
const STILL_NESTED = [
  'refineConstraintsInBackground',
  'captureDraft',
  'takeDraftMerge',
  'takePendingConstraintMessages',
  'appendTransitionCard',
]

const { ts } = await describeTypeScript()
assert.ok(ts !== undefined, 'v350 需要编译器：缩进不是作用域的证据（长期规则 24）')

const text = readFileSync(SOURCE, 'utf8')
const sourceFile = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const declarations = []
const visit = (node, owner) => {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    declarations.push({ name: node.name.text, top: owner === undefined, owner: owner ?? null })
    for (const child of node.body?.statements ?? []) visit(child, node.name.text)
    return
  }
  ts.forEachChild(node, (child) => visit(child, owner))
}
for (const statement of sourceFile.statements) visit(statement, undefined)

test('v350 ①: the four promoted declarations are top-level today', () => {
  for (const name of PROMOTED) {
    const entries = declarations.filter((declaration) => declaration.name === name)
    assert.equal(entries.length, 1, `① ${name} 必须恰好声明一次（实测 ${entries.length}）`)
    assert.equal(entries[0].top, true,
      `① ${name} 必须已提升到模块级；实测仍在 ${entries[0].owner} 体内 —— 那样它仍不可 import`)
  }
})

test('v350 ②: `apply()` keeps exactly the five declarations that really need its scope', () => {
  const nested = declarations.filter((declaration) => !declaration.top)
  assert.equal(nested.length, 5, `② apply() 体内应剩 5 个声明，实测 ${nested.length}：${nested.map((entry) => entry.name).join('、')}`)
  assert.deepEqual(nested.map((entry) => entry.name).sort(), [...STILL_NESTED].sort(),
    '② 剩下的必须正是那 5 个各需外部名的声明；换成别的名字说明有人提升了一个不该提升的（或漏了一个）')
  for (const entry of nested) {
    assert.equal(entry.owner, 'apply', `② ${entry.name} 应仍在 apply 体内，实测在 ${entry.owner}`)
  }
})

test('v350 ③ (negative half): no duplicate executable declaration of a promoted name', () => {
  /**
   * The two ways a promotion goes wrong both produce TWO declarations with one name: 「paste, forget to
   * delete」 and 「delete, paste twice」. JavaScript accepts that silently — the LAST one wins — so the
   * program keeps running while one copy is dead. The counts above catch the first case; this catches
   * both, and it fails loudly instead of letting a reader trust a dead declaration.
   */
  const seen = new Map()
  for (const declaration of declarations) {
    seen.set(declaration.name, (seen.get(declaration.name) ?? 0) + 1)
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1)
  assert.deepEqual(duplicated, [], `③ 同名声明出现多次（后者静默覆盖前者）：${duplicated.map(([name, count]) => `${name}×${count}`).join('、')}`)
})

test('v350 ④: the manifest records the promotion, so the numbers in it are not stale', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.equal(manifest.measured.nested, 5, '④ manifest 的嵌套数必须是 5')
  assert.equal(manifest.measured.functions, 185, '④ manifest 的顶层数必须是 185（S3 之后）')
  for (const name of PROMOTED) {
    const unit = manifest.units.find((candidate) => candidate.name === name)
    assert.ok(unit !== undefined, `④ ${name} 必须在清单里`)
    assert.equal(unit.top, true, `④ ${name} 在清单里必须 top=true`)
    assert.doesNotMatch(String(unit.why), /体内声明/u, `④ ${name} 已提升，why 不得再写「体内声明」`)
  }
  /** The five that remain nested must still say so — otherwise the label would hide a real obstacle. */
  for (const name of STILL_NESTED) {
    const unit = manifest.units.find((candidate) => candidate.name === name)
    assert.match(String(unit.why), /体内声明/u, `④ ${name} 仍在体内，why 必须继续说明这一点`)
  }
})
