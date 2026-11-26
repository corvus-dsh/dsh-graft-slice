/**
 * ── v380：约束溯源的**一整族**搬出（纯移动，零 import 回环）────────────────────────────────────
 *
 * 这一簇把三个单元一起搬进 `src/core/constraint-provenance.ts`：
 *   `ConstraintProvenance`（接口）/ `findConstraintProvenance`（查找）/ `renderConstraintProvenance`（渲染）
 *
 * 它们是一族：渲染器接收查找器返回的接口，而 `index.ts` 里没有别的地方用这两个符号。
 * **一起搬**才使这次移动零回环 —— 接口若留下，新模块就要 `import type … from '../index.js'`，
 * 而上一簇已经实测过 `build.mjs` 拒绝那个形状。
 *
 * 判据四条：
 *   ① 新模块只从 core/ 取依赖，不反向 import `index.ts`
 *   ② **从源码模块**直接 import 可用，且「继承的溯源行」这条关键分支行为不变
 *   ③ `index.ts` 仍导出查找器与接口（它们是公开面），渲染器**不**再导出（它原本就不是）
 *   ④ 渲染文案必须**诚实**：一代时说「上一代」，多代时说出具体第几代
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE = join(ROOT, 'src', 'core', 'constraint-provenance.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')

const { findConstraintProvenance, renderConstraintProvenance } = await import('../src/core/constraint-provenance.ts')

/**
 * A graft-authored `user/message` carrying a HARD CONSTRAINTS block.
 *
 * The shape is MEASURED, not guessed: `isGraftAuthored` reads `source.kind` directly and accepts
 * `plugin:graft-replay` (`host-shape.ts`) or anything starting with `plugin:graft`. My first fixture
 * nested it as `{ kind: 'plugin', plugin: 'graft-replay' }`, which `isGraftAuthored` correctly rejects —
 * so `findConstraintProvenance` returned `undefined` and the test looked like a product bug.
 * **A fixture built from memory measures the fixture.**
 */
const blockEvent = (seq, text) => ({
  seq,
  type: 'user/message',
  data: { source: { kind: 'plugin:graft-replay' }, content: [{ type: 'text', text }] },
})

test('v380 ①: the family moved together — no back-import into index.ts', () => {
  const imports = moduleText.match(/from '[^']+'/gu) ?? []
  const back = imports.filter((line) => /index(?:\.js)?'/u.test(line))
  assert.deepEqual(back, [], `① 不得反向 import index.ts：${back.join(', ')}`)
  /** All three units must be in the new module, or the move split a family. */
  for (const name of ['ConstraintProvenance', 'findConstraintProvenance', 'renderConstraintProvenance']) {
    assert.ok(moduleText.includes(name), `① 新模块必须包含 ${name}`)
  }
})

test('v380 ②: an INHERITED provenance line is passed through, not re-derived', () => {
  /**
   * The load-bearing branch: if the oldest constraints block ALREADY names its true origin, that line
   * wins — otherwise the anchor would say 「上一代」 no matter how deep the chain is.
   */
  const withInherited = [
    blockEvent(10, 'HARD CONSTRAINTS\n\n[系统提示] 核心约束最早记录在第 23 代会话（auto-graft-abc，seq=3）'),
    blockEvent(20, 'HARD CONSTRAINTS\n\nsomething else'),
  ]
  const inherited = findConstraintProvenance(withInherited, 'src-session', 1)
  assert.deepEqual(inherited, { generationsBack: 24, seq: 3, sessionId: 'auto-graft-abc' },
    `② 继承的溯源行必须被透传并 +1 代，实测 ${JSON.stringify(inherited)}`)

  /** Without such a line, the answer is one generation back from the OLDEST block. */
  const plain = findConstraintProvenance([blockEvent(30, 'HARD CONSTRAINTS\n\nplain')], 'src-session', 1)
  assert.deepEqual(plain, { generationsBack: 1, seq: 30, sessionId: 'src-session' },
    `② 无继承行时必须取最早那块并报一代，实测 ${JSON.stringify(plain)}`)

  /** No constraints block at all ⇒ undefined, not a fabricated answer. */
  assert.equal(findConstraintProvenance([], 'src-session', 1), undefined,
    '② 没有约束块时必须返回 undefined —— 不许编一个出处')
})

test('v380 ③: index.ts re-exports the finder and the type, but NOT the renderer', () => {
  assert.ok(/export \{ findConstraintProvenance \}/u.test(indexText),
    '③ 查找器是公开面，必须再导出')
  assert.ok(/export type \{ ConstraintProvenance \}/u.test(indexText),
    '③ 接口是公开面，必须再导出')
  assert.ok(!/export \{ renderConstraintProvenance \}/u.test(indexText),
    '③ 渲染器原本就不是公开面，再导出会扩大导出面（不是纯移动）')
})

test('v380 ④: the rendered sentence is honest about the distance', () => {
  const one = renderConstraintProvenance({ generationsBack: 1, seq: 7, sessionId: 'abc' })
  assert.ok(one.includes('上一代会话'), `④ 一代时必须说「上一代」，实测：${one}`)
  assert.ok(one.includes('seq=7') && one.includes('abc'), `④ 必须给出 seq 与会话 id，实测：${one}`)

  const deep = renderConstraintProvenance({ generationsBack: 24, seq: 3, sessionId: 'x' })
  assert.ok(deep.includes('第 24 代会话'), `④ 多代时必须说出具体代数，实测：${deep}`)
  assert.ok(!deep.includes('上一代'), `④ 多代时不许再说「上一代」—— 那会把 24 代说成 1 代`)
})
