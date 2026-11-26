/**
 * ── v376：`graftLogVisibility` 搬出后的独立性与三条判定 ──────────────────────────────────────────
 *
 * 这一簇把 `graftLogVisibility`（51 行）搬进 `src/core/log-visibility.ts`。它**不是导出的**
 * （只在 `apply()` 里被调用），所以新模块 `export` 它、`index.ts` 只 import **不 re-export** ——
 * 再导出会扩大公开面，那不叫纯移动。
 *
 * 判据四条：
 *   ① 新模块不反向 import `index.ts`；它的唯一自由符号 `graftTargets` 来自 `core/state.ts`
 *   ② **从源码模块**直接 import 可用（不是产物 —— 产物把 50 个模块内联进一个作用域）
 *   ③ `index.ts` **没有**把它加进导出面（这是「它本来就不公开」的证据，不是遗漏）
 *   ④ 三条判定的行为不变：空 sourceId ⇒ 拒绝；无调用方身份 ⇒ 放行但标 unattributed；
 *      自己的会话 ⇒ self
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSourceModules } from './source-module.mjs'

registerSourceModules()

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE = join(ROOT, 'src', 'core', 'log-visibility.ts')
const INDEX = join(ROOT, 'src', 'index.ts')

const moduleText = readFileSync(MODULE, 'utf8')
const indexText = readFileSync(INDEX, 'utf8')
const { graftLogVisibility } = await import('../src/core/log-visibility.ts')

test('v376 ①: the module imports only from core/, never back into index.ts', () => {
  const imports = moduleText.match(/from '[^']+'/gu) ?? []
  assert.ok(imports.some((line) => /state\.js'/u.test(line)),
    `① 必须从 state.js 取 graftTargets，实测 imports：${imports.join(', ')}`)
  const back = imports.filter((line) => /index(?:\.js)?'/u.test(line))
  assert.deepEqual(back, [], `① 不得反向 import index.ts：${back.join(', ')}`)
})

test('v376 ②: it loads from SOURCE and keeps its three decisions', () => {
  /** An empty source id is refused outright — it names nothing to read. */
  const empty = graftLogVisibility('caller', '')
  assert.equal(empty.ok, false, `② sourceSessionId 为空必须拒绝，实测 ${JSON.stringify(empty)}`)

  /**
   * No caller identity ⇒ ADMITTED but LABELLED `unattributed`. The user ruled on this: refusing
   * would switch the read-back feature off for every host that does not populate `exec.agent.id`.
   */
  const unattributed = graftLogVisibility('', 'someone-else')
  assert.equal(unattributed.ok, true, '② 无调用方身份必须放行（否则整条回读功能对那类宿主失效）')
  assert.equal(unattributed.attributed, false, '② 但必须标成 unattributed ——「没法核」不能被读成「核过了」')
  assert.equal(unattributed.reason, 'unattributed')

  /** Reading your OWN session is fine and attributed. */
  const self = graftLogVisibility('same-id', 'same-id')
  assert.equal(self.ok, true, '② 读自己的会话必须放行')
  assert.equal(self.attributed, true)
  assert.equal(self.reason, 'self')
})

test('v376 ②b: a session that is neither mine nor an ancestor is refused', () => {
  /**
   * `graftTargets` has no mark for this caller, so the ancestor walk ends immediately — the answer
   * must be a refusal that names BOTH sessions (otherwise the reader cannot tell which id was wrong).
   */
  const refused = graftLogVisibility('no-such-caller', 'someone-else')
  assert.equal(refused.ok, false, `②b 非本人非上游必须拒绝，实测 ${JSON.stringify(refused)}`)
  assert.ok(refused.reason.includes('no-such-caller') && refused.reason.includes('someone-else'),
    `②b 拒绝文案必须同时点名两个 id，实测：${refused.reason}`)
})

test('v376 ③: index.ts imports it but does NOT export it (it was never public)', () => {
  assert.ok(/import \{ graftLogVisibility \} from '\.\/core\/log-visibility\.js'/u.test(indexText),
    '③ index.ts 必须 import 它（否则 apply() 调不到）')
  /**
   * The negative half is the point: adding it to the export surface would widen the public API, and
   * that is not a pure move. `check-export-baseline` would also catch it, but this test names it.
   */
  assert.ok(!/export \{ graftLogVisibility \}/u.test(indexText),
    '③ 不得 re-export —— 它原本就不是公开面的一部分')
  assert.ok(!/export type \{[\s\S]{0,200}graftLogVisibility/u.test(indexText),
    '③ 类型导出里也不得有它')
})
