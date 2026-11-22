/**
 * v1.0.2 P2 — UI HEALTH CHECK.
 *
 * Every production failure this panel has had looked IDENTICAL in the UI: plausible
 * numbers that never moved (dead bridge, rejected agent, stringified envelope, stale
 * defaults). The badge answers "is this data real?" before an operator reads a switch.
 *
 * ── 19.4-E: THIS FILE IS A NAME-EXISTENCE CHECK, NOT A REACHABILITY ONE ────────────────────────────
 *
 * The lead measured what it did and did not prove, and the distinction is the reason this header
 * exists. The last assertion below used to read
 *
 *     assert.match(source, /degradedReason|宿主通道未连通|未能从宿主读取状态/u, 'the reason is surfaced')
 *
 * — three alternatives, ANY ONE of which satisfied it, matched against SOURCE TEXT. It passed while
 * 「宿主通道未连通」 was DEAD CODE: the failure path stores a `fallbackState(reason)` where
 * `degraded: true`, so `state === null` was never true once a fetch had failed, and the badge reported
 * 「降级」 (first failure) or 「正常」 (after a success) instead. A regex cannot see reachability; it can
 * only see whether a word was typed.
 *
 * So this file keeps the cheap, still-useful invariant — the level names exist and the badge is actually
 * rendered — and SAYS SO. The reachability half lives in `v319-health-badge-is-reachable.test.mjs`,
 * which renders the panel through three real timelines. **Do not read a green here as 「the badge is
 * correct」**; read it as 「the vocabulary and the render site are still there」.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

for (const [file, badgeClass] of [
  ['dsh-graft-slice/client.js', 'gc-badge'],
  ['dsh-memory/client.js', 'mc-badge'],
]) {
  test(`v1.0.2 health badge: ${file} states the three levels and never silently degrades`, () => {
    const source = readFileSync(join(here, '..', '..', file), 'utf8')
    assert.match(source, /const health =/u, 'the badge is computed during render')
    assert.match(source, /'red'/u, 'a dead channel has its own level')
    assert.match(source, /'green'/u, 'so does a healthy one')
    assert.match(source, new RegExp(`className: '${badgeClass}'`, 'u'), 'and it is actually rendered')
    /**
     * NAME EXISTENCE ONLY — see the header. Each level is asserted SEPARATELY on purpose: the old
     * `a|b|c` form could be satisfied by any one of them, so deleting two of the three still passed.
     * 「The word exists」 is all this can claim; `v319` claims reachability.
     */
    assert.match(source, /宿主通道未连通/u, 'the dead-channel wording exists (existence only)')
    assert.match(source, /宿主通道降级/u, 'the degraded wording exists (existence only)')
    assert.match(source, /degradedReason/u, 'the reason is surfaced somewhere (existence only)')
  })
}
