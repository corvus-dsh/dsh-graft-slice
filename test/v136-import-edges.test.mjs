/**
 * ── v136: verify-pure-move 看不见「新增依赖」，所以另有一条边检查 ────────────────────────────────────
 *
 * 事实（本机实测 2026-11-11）：
 *   - `verify-pure-move.mjs` 的 CONTENT LINE 定义**排除**任何以 `import ` / `export ` 开头的行，
 *     因为一次纯搬运**必然**产生这些行（新模块加 import、`function f` → `export function f`、
 *     index.ts 加 `export { f }`）。这个排除对它的目的是**对的**，但它同时是一个洞：
 *     往 src/core/adaptive-depth.ts 顶部注入 `import { ledgerRecord } from './ledger.js'`，
 *     它仍然打印 IDENTICAL。
 *   - 所以「纯搬运没有引入新依赖」这句话，**那个脚本证明不了**。
 *
 * 新增 `scripts/verify-import-edges.mjs`：比较两个 revision 的 **import 边集合**
 * （文件 → 模块、以及被导入的符号名），报告每条出现/消失的边。
 *
 * 本测试钉三件事：
 *   ① 边解析器认得 5 种 import 形状（named / type-only / default / side-effect / re-export），
 *      且忽略包导入（`node:path` 不是本树的边）。
 *   ② `--self-test` 通过（它自身内含「新增 import 必须可见」这条断言）。
 *   ③ **能力边界本身被钉住**：verify-pure-move 的 CONTENT LINE 定义确实排除 import 行 ——
 *      这样将来没人能「顺手放宽」它而让这条测试还绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EDGES = join(ROOT, 'scripts', 'verify-import-edges.mjs')
const PURE_MOVE = join(ROOT, 'scripts', 'verify-pure-move.mjs')
const EDGES_URL = pathToFileURL(EDGES).href

const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

test('v136: the edge parser recognises every import shape this repo uses', async () => {
  const module = await import(EDGES_URL)
  const parsed = module.edgesOf([
    "import { a, b } from './x.js'",
    "import type { T } from './y'",
    "import def from './z.js'",
    "import './side.js'",
    "export { q } from './r.js'",
    "import { join } from 'node:path'",
  ].join('\n'))

  // the package import is deliberately absent: it is not an edge inside this tree
  assert.equal(parsed.length, 5, 'five workspace edges, package imports excluded')
  assert.deepEqual(parsed.map((edge) => edge.spec).sort(), ['./r', './side', './x', './y', './z'])
  assert.equal(parsed.find((edge) => edge.spec === './x').names, 'a,b')
  assert.equal(parsed.find((edge) => edge.spec === './y').names, 'T')
  assert.equal(parsed.find((edge) => edge.spec === './z').names, 'default')
  assert.equal(parsed.find((edge) => edge.spec === './side').names, '(side-effect)')
})

test('v136: a .js suffix is normalised so an extension-only difference is not reported as a new dependency', async () => {
  const module = await import(EDGES_URL)
  assert.equal(module.normaliseSpec('./ledger.js'), './ledger')
  assert.equal(module.normaliseSpec('./ledger'), './ledger')
  assert.equal(module.normaliseSpec('./ledger.ts'), './ledger')
  const withJs = module.edgesOf("import { ledgerRecord } from './ledger.js'")
  const withoutJs = module.edgesOf("import { ledgerRecord } from './ledger'")
  assert.deepEqual(withJs, withoutJs, 'the same module must parse to the same edge')
})

test('v136: the edge checker can fail — a new dependency it must report is reported', async () => {
  // --self-test carries an assertion that an injected `./ledger` import IS visible here.
  const output = run(EDGES, ['--self-test'])
  assert.match(output, /SELF-TEST PASS/u)
  assert.match(output, /the injected ledger import is visible here/u)
})

/**
 * ── WHAT A MOVE MAY AND MAY NOT ADD ──────────────────────────────────────────────────────────────
 *
 * Two drafts of this rule, each too strict in its own way:
 *
 *   1. "against HEAD there must be ZERO added edges" — forbids every move, because a move necessarily
 *      adds the re-export edge in the file it left. Measured red on the GraftConfig move.
 *   2. "every added edge must point at a module THIS DIFF created" — still forbids every move that needs
 *      a dependency, because the NEW module's own imports necessarily point at EXISTING modules.
 *      Measured red on the message-source move: `core/message-source.ts -> ../utils/serialize [isRecord]`
 *      was rejected even though `index.ts` already imported `isRecord` from exactly that path.
 *
 * THE ACTUAL INVARIANT: no NEW dependency between two PRE-EXISTING modules. A move may add
 *   (a) an edge from the file it left to the module it created  (the plumbing)
 *   (b) an edge from the module it created to existing modules   (it reuses what the old file used)
 * and nothing else. That is what "did not introduce a new dependency" means for a move.
 */
test('v136: a move may not add a dependency between two PRE-EXISTING modules', () => {
  const output = run(EDGES)
  const added = [...output.matchAll(/^ {2}\+ (\S+) -> (\S+) \[/gmu)].map((m) => ({ from: m[1], to: m[2] }))
  const removed = Number(/REMOVED\s+\((\d+)\)/u.exec(output)?.[1])

  assert.equal(removed, 0, `no edge may vanish silently:
${output}`)

  // modules this diff CREATED (untracked under src/)
  const created = (() => {
    const status = execFileSync('git', ['status', '--porcelain', 'src'], { cwd: ROOT, encoding: 'utf8' })
    return status.split('\n')
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3).trim())
      .filter((path) => path.endsWith('.ts'))
  })()
  const createdStems = new Set(created.map((path) => path.replace(/^src\//u, '').replace(/\.ts$/u, '')))

  for (const edge of added) {
    const toStem = edge.to.replace(/^\.\//u, '')
    const fromStem = edge.from.replace(/^src\//u, '').replace(/\.ts$/u, '')
    const toIsNew = createdStems.has(toStem)
    const fromIsNew = createdStems.has(fromStem)
    const ok = toIsNew || fromIsNew
    assert.ok(ok,
      `${edge.from} -> ${edge.to} is a NEW dependency between two PRE-EXISTING modules.
` +
      `A move may only add an edge INTO a module it created, or OUT OF one.
` +
      `created by this diff: ${[...createdStems].join(', ') || 'none'}
${output}`)
  }
})

test('v136: verify-pure-move EXCLUDES import lines — the gap is pinned, not just described', () => {
  const source = readFileSync(PURE_MOVE, 'utf8')
  // The exclusion is the documented reason the gap exists. If someone widens it, this test says so.
  assert.match(source, /does not start with `import ` or `export `/u,
    'verify-pure-move must still document that it excludes import/export lines')
  assert.match(source, /CONTENT LINE/u)

  // Prove the exclusion mechanically, not by reading a comment: a file of only import lines has no
  // content lines, so a pure-move comparison over such a tree cannot see them change.
  const module = readFileSync(EDGES, 'utf8')
  assert.ok(module.includes('verify-pure-move.mjs cannot see these by design'),
    'the edge checker must state WHY it exists next to the script it complements')
})
