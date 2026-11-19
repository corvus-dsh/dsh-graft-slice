/**
 * ── v252 (B4-0b-1 A7): a capability the description claims must have a producer in `src/` ────────
 *
 * The audit's B-4: `package.json:5` said 「Can carry memory context into the new session」. `src/` has
 * `renderMemoryContext` and exactly one consumer (`index.ts:4761`) — and its own comment admits
 * 「shipped with a renderer and no producer」. Nothing in this repository ever builds a
 * `MemoryContextInput`; `system_meta_memory` (the wrapper the rule requires) has ZERO hits in the
 * whole tree. So the package advertised a capability that could only be exercised by a caller that
 * does not exist.
 *
 * ── the choice, made explicitly ─────────────────────────────────────────────────────────────────
 *
 * B4-0b-1 A7 offers two ways out: (a) really wire it to `dsh-memory` via the tools service, or
 * (b) downgrade the claim and pin the downgrade. This batch took (b): (a) needs a cross-plugin call
 * at prepare time, a new async failure mode, a prepared-record schema change and its own budget
 * conversation — that is its own ruled-on item, not a rider on a ten-item batch. The dispatch allows
 * (b) as long as it is 做实, which is what this file does:
 *
 *   ① the description no longer claims transport — it says 「render if the caller supplies it」;
 *   ② the claim is MECHANICAL: any phrase in the description that promises memory context must be
 *      backed by a producer call in `src/`, and today there is none, so the wording must not promise;
 *   ③ the day someone wires `memory_search` in, ② flips and the description may promise again —
 *      the check is a measurement, not a snapshot of my opinion.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')

function everySource(dir = SRC, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...everySource(join(dir, entry.name), rel))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

const sourceText = everySource()
  .map((rel) => readFileSync(join(SRC, rel), 'utf8'))
  .join('\n')

/**
 * "A producer exists" means: something in `src/` CALLS a memory plugin tool.
 *
 * `renderMemoryContext(memoryContext)` does not count — that is the formatter consuming a value it
 * was handed. The question is whether anything ever asks dsh-memory for hits.
 */
const hasMemoryProducer = /execute\s*\(\s*\{[^}]*name:\s*'memory_(search|contribute|stats|harvest)'/u.test(sourceText)
  || /name:\s*'memory_search'/u.test(sourceText)

test('v252 ①: 包描述不再宣称「能把记忆上下文带进新会话」（没有生产者就不许这么写）', () => {
  const description = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).description ?? '')
  assert.equal(
    hasMemoryProducer,
    false,
    '如果这条红了，说明 src/ 里出现了 memory_* 的调用 —— 那是好事：把描述改回「能带」再删掉本条断言之前的限制',
  )
  assert.doesNotMatch(description, /Can carry memory context/u,
    '描述不许声称「会把记忆上下文带进新会话」——渲染器存在，生产者不存在')
  assert.match(description, /NOT wired to dsh-memory/u,
    '降级声称必须写在描述里，让 npm 页面上就能看到，而不是只写在仓库文档里')
})

test('v252 ②: 渲染器仍然可用，且它的输入契约没被降级声称顺手删掉', () => {
  /**
   * Downgrading the CLAIM must not delete the CAPABILITY. `renderMemoryContext` + the `memory-context`
   * chunk stay: the moment a producer appears, nothing but the description has to change.
   */
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
  assert.match(index, /export function renderMemoryContext/u)
  assert.match(index, /kind: 'memory-context'/u, 'chunk 种类必须还在 —— 否则接上生产者时七段顺序要重排')
  assert.match(index, /memoryContext\?: MemoryContextInput/u)
})

test('v252 ③: 空集合 ⇒ 不产块（「没查到」与「没查」必须是两句话）', async () => {
  const { renderMemoryContext } = await import('../index.js')
  assert.equal(renderMemoryContext({}), undefined)
  assert.equal(renderMemoryContext({ skills: [], negatives: [], facts: [] }), undefined)
  const text = renderMemoryContext({ facts: [{ title: '一个事实' }] })
  assert.match(String(text), /一个事实/u)
})