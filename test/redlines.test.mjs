import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)

function read(relative) {
  return readFileSync(new URL(relative, root), 'utf8')
}

test('package and manifest declare the plugin identity and permissions', () => {
  const pkg = JSON.parse(read('package.json'))
  const manifest = JSON.parse(read('manifest.json'))
  /**
   * v2.1.0: THE NAME IS SCOPED. The assertion used to hard-code `'dsh-graft-slice'`, which encoded
   * "the package is unscoped" rather than "the package is identifiable". The registry rejects the
   * bare name, so the package moved to `@corvus-dsh/dsh-graft-slice` — and this line broke even
   * though nothing about the plugin changed.
   *
   * The rule being guarded is AGREEMENT between package.json and manifest.json, not a literal.
   */
  assert.match(pkg.name, /^(@[a-z0-9-]+\/)?dsh-graft-slice$/u, 'the package keeps its dsh-graft-slice identity')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.name, pkg.name)
  assert.equal(manifest.version, pkg.version)
  assert.deepEqual(manifest.permissions, ['session:read', 'session:write'])
  // v7.3 adds the search tool, which is what makes the read-back design usable:
  // before it, a target could only read a seq it already knew.
  // v7.4 adds the two-phase pair: prepare (read-only review) + commit (verified write).
  // v0.14 adds the debug panel (watermark / locks / transactions / memory store).
  // v1.0.2 adds goal evolution: the model may rewrite the goal it acts on, with a trail.
  assert.deepEqual(manifest.tools, [
    'graft_prepare',
    'graft_commit',
    'graft_slice_and_inject',
    'graft_search_history',
    'graft_read_result',
    'graft_resume_session',
    'graft_update_goal',
    'graft_debug_status',
  ])
  assert.deepEqual(manifest.hooks, ['agent/pre-step', 'agent/turn-stopping'])
})

test('cordis patch inserts the plugin row', () => {
  const patch = read('cordis.patch.yml')
  const pkg = JSON.parse(read('package.json'))
  assert.match(patch, /insert:/)
  assert.match(patch, /id:\s*dsh-graft-slice/)
  /**
   * THE PATCH `name` MUST BE THE PACKAGE `name`, VERBATIM.
   *
   * That is the actual contract: the loader resolves `name` as a module path, so a mismatch means
   * the plugin installs and then fails to load. Asserting the literal `dsh-graft-slice` was a proxy
   * for that rule which broke the moment the package was scoped.
   */
  assert.ok(
    patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: ${pkg.name}`),
    `cordis.patch.yml must name the package exactly as package.json does (${pkg.name})`,
  )
  assert.match(patch, /skeletonTurn:\s*1/)
  assert.match(patch, /skeletonStep:\s*1/)
})

test('the runtime contains no SQLite dependency and no external imports', () => {
  const runtime = read('index.js')
  assert.equal(/sqlite|better-sqlite3/iu.test(runtime), false)
  const imports = [...runtime.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gmu)].map((match) => match[1])
  const external = imports.filter((specifier) => !specifier.startsWith('node:'))
  assert.deepEqual(external, [], 'index.js may only import Node built-ins')
})

test('the runtime never calls sessions.fork and never fires a standalone tool/result append', () => {
  const runtime = read('index.js')
  const code = runtime
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
  assert.equal(/ctx\.sessions\.fork\s*\(/u.test(code), false)
  assert.equal(/\.fork\s*\(\s*source/iu.test(code), false)
  // The only append call sites are typed helpers; a literal append of
  // tool/result would be a red-line violation.
  assert.equal(/append\(\s*['"]tool\/result['"]/u.test(code), false)
})

test('the assistant builder writes stream [] and append surface metadata', () => {
  const runtime = read('index.js')
  assert.match(runtime, /stream:\s*\[\]/u)
  assert.match(runtime, /surfaceOp:\s*['"]append['"]/u)
  assert.equal(/sourceEventSeqs:\s*\[\]/u.test(runtime), false)
})

test('the generated runtime is valid JavaScript and exports apply/activate', () => {
  const runtimePath = new URL('index.js', root)
  assert.equal(existsSync(runtimePath), true)
  execFileSync(process.execPath, ['--check', fileURLToPath(runtimePath)], { stdio: 'pipe' })
  return import('../index.js').then((module) => {
    assert.equal(typeof module.apply, 'function')
    assert.equal(typeof module.activate, 'function')
    assert.deepEqual(module.inject, ['tools', 'sessions', 'sessionQuery', 'sessionPersistence'])
    assert.equal(module.name, 'dsh-graft-slice')
  })
})

test('display metadata and icon are present', () => {
  const en = JSON.parse(read('locale/en.json'))
  const zh = JSON.parse(read('locale/zh.json'))
  assert.equal(typeof en.meta.title, 'string')
  assert.equal(typeof en.meta.description, 'string')
  assert.equal(typeof zh.meta.title, 'string')
  assert.equal(read('icon.svg').startsWith('<svg'), true)
})
