/**
 * The Client half's registration id must BE THE PACKAGE NAME.
 *
 * The Host keys every web boot-graph row by `package.json` `name`; the browser loader looks the row
 * up by that exact id. After the `@corvus-dsh/*` rename, `client.js` kept the short id, so boot
 * reported `loaded without registering "@corvus-dsh/dsh-graft-slice"` and the fallback re-execution
 * crashed on `duplicate factory registration`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))

test('client bundle registers the package name, not the short alias', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
  const registered = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/u.exec(code)
  assert.ok(registered !== null, 'client.js must call __ModuleLoader__.load({ id, factory })')
  assert.equal(
    registered[1],
    pkg.name,
    `the boot graph keys this package as "${pkg.name}"; a different id is "loaded without registering"`,
  )
  assert.equal(pkg.dsh?.client?.platform, 'web', 'the package must still declare a web client half')
})
