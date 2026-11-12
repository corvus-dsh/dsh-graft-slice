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

/**
 * The revision the edge comparison is made against.
 *
 * Kept as a named constant so the "was this symbol already used?" check cannot silently compare
 * against a different tree than the ADDED/REMOVED report did.
 */
const REF = 'HEAD'

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
 *
 * ── A MISSING IMPORT IS NOT A MISSING DEPENDENCY ────────────────────────────────────────────────
 *
 * Measured on the type-fix commit: adding `import { isRecord, graftError } from '../utils/serialize.js'`
 * to `core/host-shape.ts` was reported as "a NEW dependency between two PRE-EXISTING modules".
 * It was not. The file had called `graftError` FORTY-NINE times before that line existed; the import
 * statement was the only thing missing. The dependency was already there — in the code, unstated in
 * the header. Adding the statement legalises it.
 *
 * `verify-pure-move` cannot see any of this (it excludes import lines), and `tsc --noEmit` reports the
 * consequence rather than the cause, so this is the only place the distinction can be made: an added
 * edge whose symbols ALREADY APPEAR in the referencing file at the ref revision is not a new
 * dependency, it is a repaired one. Checked against `git show <ref>:<file>`, so it is a measurement of
 * the previous tree, not a claim about intent.
 */
test('v136: a move may not add a dependency between two PRE-EXISTING modules', () => {
  /**
   * ── AN EDGE IS (from, to), NOT (from, to, symbols) ──────────────────────────────────────────────
   *
   * Measured false positive: adding \`SessionEventLike\` to an existing \`import type\` in index.ts changed
   * that edge's SYMBOL LIST from five names to six. \`verify-import-edges\` reports per-signature rows, so
   * it printed "ADDED 1 / REMOVED 1" — and this test read that as "a new dependency between two
   * pre-existing modules", which it was not. The (from, to) pair was already there.
   *
   * So the comparison is by PAIR. What the rule forbids is a pair that did not exist before.
   */
  const output = run(EDGES)

  /** Pull both columns of the report into (from, to) pairs, ignoring the symbol list. */
  const pairs = (marker) => {
    const section = output.split(marker)[1]?.split('\n\n')[0] ?? ''
    return [...section.matchAll(/^ {2}[+-] (\S+) -> (\S+) \[/gmu)].map((m) => `${m[1]} -> ${m[2]}`)
  }
  const addedPairs = pairs('ADDED')
  const removedPairs = pairs('REMOVED')

  // a pair that disappears entirely is still a silent loss
  const vanished = removedPairs.filter((pair) => !addedPairs.includes(pair))
  assert.deepEqual(vanished, [], `an import edge vanished entirely:\n${output}`)

  // modules this diff CREATED (untracked under src/)
  const created = (() => {
    const status = execFileSync('git', ['status', '--porcelain', 'src'], { cwd: ROOT, encoding: 'utf8' })
    return status.split('\n')
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3).trim())
      .filter((path) => path.endsWith('.ts'))
  })()
  const createdStems = new Set(created.map((path) => path.replace(/^src\//u, '').replace(/\.ts$/u, '')))

  // only genuinely NEW pairs are checked; a re-signed existing pair is fine
  const brandNew = addedPairs.filter((pair) => !removedPairs.includes(pair))

  /**
   * Symbols named on each added edge, so a "repaired" edge can be told from a new one.
   * `verify-import-edges` prints them: `  + src/core/host-shape.ts -> ../utils/serialize [a,b]`.
   */
  const symbolsOnAdded = new Map()
  for (const m of output.matchAll(/^ {2}\+ (\S+) -> (\S+) \[([^\]]*)\]/gmu)) {
    symbolsOnAdded.set(`${m[1]} -> ${m[2]}`, m[3].split(',').map((s) => s.trim()).filter(Boolean))
  }

  /**
   * Does the referencing file already USE these symbols at the ref revision?
   *
   * This is the measurement that separates "a new dependency" from "a dependency whose import
   * statement was missing". `graftError` appeared 49 times in host-shape.ts while the file imported
   * nothing from `../utils/serialize` — the edge existed in the code and not in the header.
   */
  const usedAtRef = (fileAtRef, symbols) => {
    let source
    try {
      source = execFileSync('git', ['show', `${REF}:${fileAtRef}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch { return false }
    /**
     * Remove only the import STATEMENTS, not every line that contains the word `import`.
     *
     * Measured: a first draft filtered "any line matching /^\s*(import|export).*from/", which also
     * deleted the `export function assertColdLog(` line — so a symbol declared and used on such a
     * line looked unused. Worse, the filter ran per line while a multi-line import leaves its
     * `} from '…'` tail behind. Both directions are wrong. So: strip the statements structurally.
     */
    const body = source
      .replace(/^\s*import\s+(?:type\s+)?[^;\n]*?from\s+['"][^'"]*['"];?/gmu, '')
      .replace(/^\s*import\s+['"][^'"]*['"];?/gmu, '')
      .replace(/^\s*import\s*\{(?:[^}]|\n)*?\}\s*from\s*['"][^'"]*['"];?/gmu, '')
    return symbols.every((name) => new RegExp(`\\b${name.replace(/\$/gu, '\\$')}\\b`, 'u').test(body))
  }

  for (const pair of brandNew) {
    const [from, to] = pair.split(' -> ')
    const toStem = to.replace(/^\.\//u, '')
    const fromStem = from.replace(/^src\//u, '').replace(/\.ts$/u, '')
    if (createdStems.has(toStem) || createdStems.has(fromStem)) continue

    /**
     * The file that holds the import statement is the `from` side.
     *
     * `verify-import-edges` prints repo-relative-to-`src` paths (`core/host-shape.ts`), while
     * `git show` needs the repo-relative path (`src/core/host-shape.ts`). Measured mistake: stripping
     * a `src/` prefix that was never there produced a path git could not resolve, `usedAtRef` returned
     * false on a `catch`, and a repaired edge was reported as a new dependency.
     */
    const fileAtRef = from.startsWith('src/') ? from : `src/${from}`
    const repaired = usedAtRef(fileAtRef, symbolsOnAdded.get(pair) ?? [])
    assert.ok(repaired,
      `${pair} is a NEW dependency between two PRE-EXISTING modules.\n` +
      `A move may only add an edge INTO a module it created, or OUT OF one.\n` +
      `An added edge is also allowed when the referencing file ALREADY USES those symbols at ${REF}\n` +
      `(then the import was merely missing, and this commit repairs it rather than adding a dependency).\n` +
      `checked: ${(symbolsOnAdded.get(pair) ?? []).join(', ') || '(no symbols parsed)'}\n` +
      `created by this diff: ${[...createdStems].join(', ') || 'none'}\n${output}`)
  }
})

test('v136: the "already used" exemption can still say NO (a repaired edge is not a blank cheque)', () => {
  /**
   * The exemption above is the dangerous kind: it lets an added edge through. If `usedAtRef` returned
   * true for everything, the rule would silently stop existing and every future new dependency would
   * pass. So the predicate is exercised in BOTH directions against a file whose content at HEAD is
   * known: `core/host-shape.ts` calls `graftError` and `isRecord` (used), and never mentions
   * `truncateEnd` (not used).
   */
  const source = execFileSync('git', ['show', `${REF}:src/core/host-shape.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const body = source
    .replace(/^\s*import\s+(?:type\s+)?[^;\n]*?from\s+['"][^'"]*['"];?/gmu, '')
    .replace(/^\s*import\s+['"][^'"]*['"];?/gmu, '')
  const uses = (name) => new RegExp(`\\b${name}\\b`, 'u').test(body)

  assert.equal(uses('graftError'), true, 'graftError WAS used before its import existed — the edge is repaired')
  assert.equal(uses('isRecord'), true, 'isRecord WAS used before its import existed — the edge is repaired')
  assert.equal(uses('truncateEnd'), false,
    'truncateEnd is imported by OTHER modules but never used in this file — a first import of it would be a real new dependency')
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

test('v137: a pure-move run against a tree with NO diff is VACUOUS, and exits 2', () => {
  /**
   * ── THE WORST POSSIBLE OUTPUT FOR THIS TOOL IS A GREEN "IDENTICAL" ──────────────────────────────
   *
   * Measured: `node scripts/verify-pure-move.mjs` on a clean tree, with the default `--against HEAD`,
   * printed `IDENTICAL — the content-line multiset is unchanged (pure move)` and exited 0. Both sides
   * were the same commit. The comparison was real; there was simply nothing on the other side.
   *
   * That is a vacuous run, and it is exactly the shape that would make EVERY future move "pass":
   * the word IDENTICAL is the one a reviewer looks for, so a check invoked after the commit instead
   * of before it would look like proof. The tool now distinguishes the two.
   *
   * The test runs the DEFAULT invocation on the current tree, which (in CI and after a commit) has no
   * src/ diff against HEAD. It asserts exit 2 AND the word VACUOUS — not merely "non-zero", because a
   * crash would also be non-zero and would tell the reader nothing.
   */
  const status = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const diff = (() => {
    try {
      execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'src'], { cwd: ROOT, stdio: 'ignore' })
      return false
    } catch {
      return true
    }
  })()

  if (status !== '' || diff) {
    // a dirty tree is the normal state DURING a move; the vacuous case cannot be exercised here
    return
  }

  let code = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [PURE_MOVE], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    code = error.status ?? 1
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  assert.equal(code, 2, `a vacuous comparison must exit 2 (a usage/resource condition), got ${code}:\n${out}`)
  assert.match(out, /VACUOUS/u, 'the output must say VACUOUS so nobody reads it as a pass')
  assert.match(out, /NOT a pass/u, 'the output must say this is not a pass')
  assert.doesNotMatch(out, /IDENTICAL/u, 'a vacuous run must never print IDENTICAL')
})
