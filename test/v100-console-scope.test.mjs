/**
 * v1.0.0 P0 — THE CONSOLE'S HELPERS MUST OUTLIVE THE EFFECT THAT USES THEM.
 *
 * The reported failure, verbatim off the live page:
 *
 *   错误详情：{"message":"withTimeout is not defined","via":"remote.commands.execute"}
 *   以上开关显示的是插件默认值，不是宿主的真实配置。点击「刷新」重试。
 *
 * `withTimeout` was declared inside `React.useEffect`, while `write` — the toggle
 * handler — is a COMPONENT-scope closure. The effect could see the helper; the
 * handler could not, so every knob click threw a ReferenceError and no switch was
 * ever written. Nothing else in the suite could catch it: the Host half is fine,
 * and the Client half is never executed by `node --test`.
 *
 * This is a static assertion on purpose. It pins the invariant that actually broke
 * ("the helper is declared at factory scope, before any effect") without pretending
 * to be a renderer.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

test('v1.0.0 console: withTimeout is factory-scoped, so the toggle handlers resolve it', () => {
  const declarations = [...bundle.matchAll(/^\s*const withTimeout\s*=/gmu)]
  assert.equal(declarations.length, 1, 'exactly one definition, so there is no shadowing copy to drift')

  const declarationAt = bundle.indexOf('const withTimeout')
  const firstEffectAt = bundle.indexOf('React.useEffect(')
  const firstWriteAt = bundle.indexOf('const write = async')
  assert.ok(firstEffectAt > 0, 'the fetch effect is present')
  assert.ok(firstWriteAt > 0, 'the toggle handler is present')
  assert.ok(
    declarationAt < firstEffectAt,
    'the helper is declared BEFORE the first effect — a definition inside that effect is invisible to `write`',
  )
  assert.ok(declarationAt < firstWriteAt, 'and before the handler that calls it')

  // The handler must actually use it; otherwise this guard passes for the wrong reason.
  const writeBody = bundle.slice(firstWriteAt, firstWriteAt + 4000)
  assert.match(writeBody, /withTimeout\(bridge\.set/u, 'the write path still goes through the bounded helper')
})

/**
 * v1.0.1 P0 — the SECOND half of the same story.
 *
 * The bridge assumed `commands.execute` resolves to `{ result: { kind, text } }`.
 * It resolves to a CommandExecution `{ kind, text }`. The fallback that swallowed the
 * mismatch was literally `return { ok: true, text: JSON.stringify(settled) }`, which
 * turned the envelope itself into panel state — hence "0 memories", "(未知)" workspace,
 * and toggles that could never flip while the Host had already persisted the write.
 */
test('v1.0.1 console: the command envelope is unwrapped, never stringified as state', () => {
  assert.match(bundle, /const execution = unwrapExecution\(settled\)/u, 'the reply goes through the unwrapper')
  assert.doesNotMatch(
    bundle,
    /ok: true, text: JSON\.stringify\(settled\)/u,
    'the old "stringify whatever came back and call it success" fallback must be gone',
  )
  assert.match(bundle, /无法识别的返回形状/u, 'an unrecognised shape is an ERROR, not state')

  // The unwrapper lives INSIDE makeBridge (only the bridge uses it, and the bridge is
  // lifted out of the bundle by test/v022-console-bridge.mjs — a factory-scope copy
  // would be out of scope in that harness).
  const bridgeAt = bundle.indexOf('function makeBridge(')
  const unwrapAt = bundle.indexOf('const unwrapExecution = (value) =>')
  const callAt = bundle.indexOf('const execution = unwrapExecution(settled)')
  assert.ok(bridgeAt > 0 && unwrapAt > 0 && callAt > 0, 'bridge, unwrapper and call site all present')
  assert.ok(unwrapAt > bridgeAt, 'the unwrapper is inside makeBridge')
  assert.ok(unwrapAt < callAt, 'and is defined before the call that uses it')
})
