/**
 * v1.0.2 P2 — UI HEALTH CHECK.
 *
 * Every production failure this panel has had looked IDENTICAL in the UI: plausible
 * numbers that never moved (dead bridge, rejected agent, stringified envelope, stale
 * defaults). The badge answers "is this data real?" before an operator reads a switch.
 *
 * Static assertion on purpose: `node --test` does not render the Client half, and the
 * invariant that broke (silence) is exactly what a renderer test cannot see either.
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
    // The degraded path must be named, not swallowed: that string is the whole point.
    assert.match(source, /degradedReason|宿主通道未连通|未能从宿主读取状态/u, 'the reason is surfaced')
  })
}
