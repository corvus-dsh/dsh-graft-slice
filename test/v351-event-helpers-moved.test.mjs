/**
 * ── v351：S4 之后的**位置事实**——四个纯函数在独立模块里，且 `index.ts` 只多一行 import ────────────
 *
 * 纯移动的验收有两个，缺一不可：
 *
 *   ① **内容多重集不变** —— 由 `verify-pure-move --against HEAD` 报 `IDENTICAL`（本判据不重复它，
 *      它已经在 `npm run check` 的前置步骤里跑了）；
 *   ② **位置真的变了** —— 新模块里存在这四个声明、`index.ts` 里不再有它们的**声明**，且 `index.ts`
 *      只因此多一行 import。①只是「没改内容」，②才是「搬了」。
 *
 * 判据：
 *   ① 新模块的四个函数都是 `export`，且 `index.ts` 里没有同名 `function` 声明；
 *   ② 新模块**不 import 任何东西**（只用自己的形参 ⇒ 没有 import ⇒ 没有环）；
 *   ③ **负向** 新模块不得含内容行以外的东西 —— 标题注释会让它变成「非纯移动」；
 *   ④ 新模块有自己的测试（「拆完就能单独测这个模块」的最便宜验证）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-assertion.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INDEX = join(ROOT, 'src', 'index.ts')
const MODULE = join(ROOT, 'src', 'registration', 'event-helpers.ts')

const MOVED = ['isSteeringOnly', 'validateAppendIsLifecycleSafe', 'openStepOf', 'continuationTitle']

const moduleText = readFileSync(MODULE, 'utf8')
const moduleCode = stripComments(moduleText)
const indexCode = stripComments(readFileSync(INDEX, 'utf8'))

test('v351 ①: the four live in the new module and are gone from index.ts', () => {
  for (const name of MOVED) {
    assert.match(moduleCode, new RegExp(`export function ${name}\\(`, 'u'),
      `① ${name} 必须在新模块里以 export function 的形式存在`)
    assert.doesNotMatch(indexCode, new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'mu'),
      `① ${name} 的声明必须已从 index.ts 移除 —— 两个副本会让后者静默覆盖前者`)
  }
})

test('v351 ②: the new module imports NOTHING, which is why it cannot create a cycle', () => {
  const imports = [...moduleCode.matchAll(/^import .*$/gmu)].map((match) => match[0])
  assert.deepEqual(imports, [], `② 新模块不得 import —— 它是环的入口。实测：\n  ${imports.join('\n  ')}`)
})

test('v351 ③ (negative half): every line in the new module came from the moved blocks', () => {
  /**
   * The claim "these lines were moved, not written" cannot be checked against the CURRENT `index.ts` —
   * the moved lines are, by definition, no longer there (measured: 55 lines "appeared" that way, every
   * one of them a body line of a moved function). It has to be checked against the tree the move STARTED
   * from, which is what `verify-pure-move --against HEAD` uses too.
   *
   * ── Why this is NOT `HEAD` (measured 2026-11-25, S4's own commit) ────────────────────────────────
   *
   * The first version read `git show HEAD:src/index.ts`. It was correct for exactly as long as the move
   * was uncommitted, and became **the opposite of correct** the moment S4 was committed: HEAD then IS the
   * post-move tree, so every moved line "appeared" and the criterion reddened on the very commit it was
   * written to accept. A baseline named by a moving pointer is not a baseline.
   *
   * So the revision is DERIVED from the history of the module itself: the parent of the commit that
   * ADDED it. That is the tree the move started from, by construction, and it stays correct after the
   * commit, after a rebase, and for the next module moved the same way. Before the module is committed
   * (the move is still in the working tree) git reports no adding commit, and `HEAD` is that tree.
   *
   * That makes the assertion the same fact `verify-pure-move` prints as `IDENTICAL`, expressed as "no
   * line is new" rather than "the multiset size is equal": two readings of one property, and this one
   * names the offending line when it fails.
   */
  const addingCommits = execFileSync(
    'git',
    ['log', '--diff-filter=A', '--format=%H', '--', 'src/registration/event-helpers.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  ).split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const introducing = addingCommits.pop()
  const baselineRev = introducing === undefined ? 'HEAD' : `${introducing}^`
  const before = execFileSync('git', ['show', `${baselineRev}:src/index.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const beforeCount = new Map()
  for (const line of before.split('\n').map((text) => text.trimEnd())) {
    beforeCount.set(line, (beforeCount.get(line) ?? 0) + 1)
  }

  /**
   * ── COMMENTS ARE NOT STRIPPED HERE, AND THAT IS THE WHOLE POINT ───────────────────────────────
   *
   * Measured by the can-red: adding a JSDoc header to the new module left this criterion GREEN, because
   * `stripComments` removed it before the comparison — and `verify-pure-move` counts comments as CONTENT
   * lines (a comment is a line that is not empty and does not start with `import `/`export `). So the one
   * new thing that makes a move non-pure was exactly the thing being filtered out.
   *
   * The general lesson is §四十六's, inverted: strip comments when the question is about CODE; do NOT
   * strip them when the question is about LINES. This criterion asks 「这一行以前存在吗」, so every line
   * counts, comments included — the moved blocks carry their original comments, which is correct because
   * those lines were already there.
   */
  const moduleContent = moduleText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  const appeared = []
  for (const line of moduleContent) {
    /** `export function …` is the plumbing of a move, not content (same rule `verify-pure-move` uses). */
    if (/^export /u.test(line)) continue
    const available = beforeCount.get(line) ?? 0
    if (available === 0) {
      appeared.push(line)
      continue
    }
    /** Consume it: the multiset rule is what makes "moved it and left a copy" visible. */
    beforeCount.set(line, available - 1)
  }

  assert.deepEqual(appeared, [],
    `③ 这些行在新模块里出现，但 ${baselineRev} 的 index.ts 里没有（＝新增内容，不是搬动）：\n  ${appeared.slice(0, 10).join('\n  ')}`)
})

test('v351 ④: the module has behaviour tests of its own', () => {
  /**
   * 「拆完就能单独测这个模块」是这次拆解的目的之一。这条判据不断言行为（v352 在做），它断言**存在性**：
   * 如果没有一条测试覆盖这四个函数的行为，「可独立测试」就只是说法。
   *
   * ── 为什么测不了 `src/registration/event-helpers.js` ────────────────────────────────────────────
   *
   * 实测：本仓的测试一律 `import … from '../index.js'`（**构建产物**），因为 Node 不能直接跑 `.ts`。
   * 所以「不经 index.ts 就能测」在这里不可能——而那不是缺陷，是构建形态。**独立性真正的载体是 ②**：
   * 新模块不 import 任何东西，因此它不依赖 `index.ts`，搬去哪儿都能跑。
   *
   * 把这条判据写成「测试必须 import src 路径」，会逼着下一个人去做一件 Node 不支持的事——那正是
   * 「宽一格的判据会惩罚正确代码」的样子。所以它断言的是：行为测试存在、且覆盖了四个名字。
   */
  const behaviour = readFileSync(join(ROOT, 'test', 'v352-event-helpers-behaviour.test.mjs'), 'utf8')
  assert.match(behaviour, /from '\.\.\/index\.js'/u,
    '④ 行为测试必须从构建产物 import（本仓唯一的测试加载方式）')
  for (const name of MOVED) {
    assert.ok(behaviour.includes(name), `④ 行为测试必须覆盖 ${name}`)
  }
})
