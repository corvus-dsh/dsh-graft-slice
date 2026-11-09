#!/usr/bin/env node
/**
 * Bundle contract check — what the loader and the ecosystem audit actually read.
 *
 * WHY THIS EXISTS
 *
 * `dsh plugin add` discovers a bundle ONLY through `dsh.bundle.patch`; a package
 * that declares just `main`/`exports` is installed as a plain dependency and
 * silently ignored. The other two high-frequency failures are `files` missing the
 * patch file (install succeeds, mount fails) and CommonJS/ESM mismatch. All three
 * are metadata mistakes that no runtime test would catch — this script does.
 *
 * It also validates the patch file's shape: entries must reference the PACKAGE
 * NAME, never a relative path (a relative path only works on the author's disk).
 *
 * Usage: node scripts/verify-bundle.mjs     (exit 1 on any failed check)
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

function expandFiles(patterns) {
  const missing = []
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const dir = pattern.slice(0, pattern.lastIndexOf('/'))
      const suffix = pattern.slice(pattern.lastIndexOf('*') + 1)
      const full = join(ROOT, dir)
      const has = existsSync(full) && readdirSync(full).some((entry) => entry.endsWith(suffix))
      if (!has) missing.push(pattern)
      continue
    }
    if (!existsSync(join(ROOT, pattern))) missing.push(pattern)
  }
  return missing
}

const pkgPath = join(ROOT, 'package.json')
if (!existsSync(pkgPath)) {
  process.stdout.write('✖ package.json missing\n')
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const manifestPath = join(ROOT, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined

// --- 1. bundle declaration -------------------------------------------------
const patchRel = pkg.dsh?.bundle?.patch
check(
  'dsh.bundle.patch declared',
  typeof patchRel === 'string' && patchRel.length > 0,
  patchRel === undefined ? 'missing dsh.bundle.patch — dsh plugin add would ignore this package' : patchRel,
)
check('bundle patch path is relative', typeof patchRel === 'string' && patchRel.startsWith('./'), patchRel)
const patchAbs = typeof patchRel === 'string' ? join(ROOT, patchRel) : undefined
check('bundle patch exists', patchAbs !== undefined && existsSync(patchAbs), patchRel)

// --- 2. entry + module format ---------------------------------------------
check('type === "module"', pkg.type === 'module', pkg.type ?? '(unset)')
check('main entry exists', typeof pkg.main === 'string' && existsSync(join(ROOT, pkg.main)), pkg.main)
check('exports["."] declared', typeof pkg.exports?.['.'] === 'string', JSON.stringify(pkg.exports?.['.'] ?? null))

const entryUrl = pathToFileURL(join(ROOT, pkg.main ?? 'index.js')).href
const mod = await import(entryUrl).catch((error) => ({ __error: String(error?.message ?? error) }))
check(
  'entry exports apply(ctx, config)',
  typeof mod.apply === 'function',
  mod.__error ?? typeof mod.apply,
)
check(
  'entry exports activate (alias)',
  typeof mod.activate === 'function',
  mod.__error ?? typeof mod.activate,
)

// --- 3. files whitelist ----------------------------------------------------
const files = Array.isArray(pkg.files) ? pkg.files : []
check('files lists the patch file', files.some((entry) => entry === patchRel?.replace(/^\.\//u, '')), patchRel)
check('files lists the build artifact', files.includes(pkg.main ?? 'index.js'), pkg.main ?? 'index.js')
check('files lists manifest.json', files.includes('manifest.json'), 'manifest.json')
check('files lists LICENSE', files.includes('LICENSE'), 'LICENSE')
const missing = expandFiles(files)
check('every files pattern resolves', missing.length === 0, missing.length === 0 ? `${files.length} patterns` : `missing: ${missing.join(', ')}`)

// --- 4. manifest agreement -------------------------------------------------
check('manifest name == package name', manifest?.name === pkg.name, `${manifest?.name} vs ${pkg.name}`)
check('manifest version == package version', manifest?.version === pkg.version, `${manifest?.version} vs ${pkg.version}`)
check('engines.dsh declared in both', typeof pkg.engines?.dsh === 'string' && manifest?.engines?.dsh === pkg.engines.dsh, pkg.engines?.dsh)
check('engines.dsh admits rc.5', String(pkg.engines?.dsh ?? '').includes('0.2.1-rc.5'), pkg.engines?.dsh)
check('node engine declared', typeof pkg.engines?.node === 'string', pkg.engines?.node)

// --- 5. source attribution (NO_GITHUB_SOURCE guard) -----------------------
const repoUrl = String(pkg.repository?.url ?? '')
check('repository is a real GitHub URL', /github\.com[/:]corvus-dsh\/dsh-graft-slice/u.test(repoUrl), repoUrl)
check('repository has no placeholder', !/REPLACE_WITH|TODO|example/iu.test(repoUrl), repoUrl)
check('homepage points at the repo', String(pkg.homepage ?? '').includes('corvus-dsh/dsh-graft-slice'), pkg.homepage)
check('bugs points at the repo issues', String(pkg.bugs?.url ?? '').includes('corvus-dsh/dsh-graft-slice/issues'), pkg.bugs?.url)

// --- 6. cordis.patch.yml shape --------------------------------------------
let patchText = ''
try {
  patchText = readFileSync(patchAbs, 'utf8')
} catch {
  patchText = ''
}
const lines = patchText.split(/\r?\n/u)

/**
 * A YAML inline scalar, as the Loader's own parser would deliver it.
 *
 * ── WHY THIS EXISTS (2026-11-08) ────────────────────────────────────────────────────────────────
 *
 * `name: '@corvus-dsh/dsh-graft-slice'` is VALID YAML, and quoting it is the normal way to keep a
 * leading `@` from being read as a tag. The Loader parses it with a real YAML parser, so the plugin
 * loaded correctly — while THIS checker compared the raw slice of the line (`'@corvus-dsh/...'`,
 * quotes included) against `pkg.name` and reported `patch references the package name, not a path`
 * as a failure. The patch was right and the gate was wrong.
 *
 * The ruling was explicit: fix the CHECKER, never the shipped patch. A gate that misreads valid input
 * is the defect to repair; editing the artifact to satisfy a broken comparison would spread the bug
 * into the thing users install.
 *
 * Scope: inline scalars only, which is all this file reads — single/double quotes, the two YAML
 * quote escapes, and a trailing comment. A full YAML parse is not worth a dependency here.
 */
function yamlScalar(raw) {
  let value = String(raw).trim()
  // Only a comment preceded by whitespace is a comment; `a#b` is a scalar in YAML.
  value = value.replace(/\s+#.*$/u, '').trim()
  const quoted = /^(['"])([\s\S]*)\1$/u.exec(value)
  if (quoted === null) return value
  if (quoted[1] === "'") return quoted[2].replace(/''/gu, "'")
  return quoted[2].replace(/\\(["\\])/gu, '$1')
}

const entries = []
let current = null
let inInsert = false
for (const raw of lines) {
  const line = raw.replace(/\s+$/u, '')
  if (line.trim().length === 0 || line.trim().startsWith('#')) continue
  if (/^-\s+insert:\s*$/u.test(line)) {
    inInsert = true
    continue
  }
  if (!inInsert) continue
  const idMatch = /^\s+-\s+id:\s*(.+)$/u.exec(line)
  if (idMatch) {
    current = { id: yamlScalar(idMatch[1]), name: undefined, config: false }
    entries.push(current)
    continue
  }
  const nameMatch = /^\s+name:\s*(.+)$/u.exec(line)
  if (nameMatch && current !== null) {
    current.name = yamlScalar(nameMatch[1])
    continue
  }
  if (/^\s+config:\s*$/u.test(line) && current !== null) current.config = true
}
/**
 * Is this a FILESYSTEM PATH rather than a package name?
 *
 * ── WHY THE OLD TEST COULD NEVER PASS (2026-11-08) ──────────────────────────────────────────────
 *
 * The check was `/[/\\]/.test(name)` — "a package name contains no slash". That was written before the
 * packages moved under a SCOPE, and a scoped name contains a slash BY DEFINITION:
 * `@corvus-dsh/dsh-graft-slice`. So the gate reported a failure on a patch that was correct, and the
 * quotation was only the first of its two reasons for saying so.
 *
 * The intent was always "the row names a PACKAGE, not a path". What actually distinguishes them:
 * a scoped name starts with `@` and has exactly one slash, the scope separator; a path starts with a
 * dot, a separator, or a drive letter, or contains a backslash at all.
 */
function looksLikeFilesystemPath(value) {
  const name = String(value)
  if (/^[.]/u.test(name)) return true // ./x, ../x
  if (/^[/\\]/u.test(name)) return true // /x, \x
  if (/^[A-Za-z]:[\\/]/u.test(name)) return true // C:\x, C:/x
  if (name.includes('\\')) return true // any backslash at all
  if (!name.includes('/')) return false
  return !/^@[^/]+\/[^/]+$/u.test(name) // a slash is allowed only as the scope separator
}

check('patch declares at least one insert entry', entries.length > 0, `${entries.length} entr(ies)`)
check(
  'patch references the package name, not a path',
  entries.length > 0 && entries.every((entry) => entry.name === pkg.name && !looksLikeFilesystemPath(entry.name ?? '')),
  entries.map((entry) => entry.name ?? '(no name)').join(', '),
)
check(
  'patch entry ids are unique',
  new Set(entries.map((entry) => entry.id)).size === entries.length,
  entries.map((entry) => entry.id).join(', '),
)
check(
  'patch carries no absolute local path',
  !/[A-Za-z]:[\\/]/u.test(patchText),
  'patch text scanned',
)

// --- 6b. the EXPORT SURFACE is a compatibility contract --------------------
/**
 * ── WHY THE EXPORT COUNT NEEDS A GATE AT ALL ─────────────────────────────────────────────────────
 *
 * Measured incident: G5 moved three functions out of `index.ts` into `core/task-state.ts` and, to
 * make the split compile, re-exported `splitSentences` along with them. That symbol had been a
 * PRIVATE helper; the bundle went from 180 exports to 181 and **every one of the 604 tests still
 * passed**, because nothing in the suite imports a function it never knew about.
 *
 * A widened export surface is not cosmetic. `exports` is the only thing downstream plugins, the
 * client bundle and any ecosystem audit can depend on; once shipped, a name cannot be withdrawn
 * without a breaking change. So the count is checked against a recorded baseline, and any change
 * must be declared in the commit message with `[export-change]`.
 *
 * WHY A COUNT AND NOT A NAME LIST: names would drift on every legitimate addition and the gate would
 * be switched off within a week. A count catches the accident that actually happened (a private
 * helper leaking into the surface) and stays quiet for the intentional case (a new tool), because the
 * intentional case costs one word in the commit message.
 *
 * WHY THE BASELINE IS A FILE: the check must work in CI, where there is no previous run to compare
 * against. `.export-surface.json` is committed, so the question "did this change?" has an answer on a
 * fresh clone.
 */
const SURFACE_FILE = join(ROOT, '.export-surface.json')
const surface = mod.__error === undefined ? Object.keys(mod).sort() : undefined
if (surface !== undefined && !surface.includes('default')) {
  let baseline
  try {
    baseline = JSON.parse(readFileSync(SURFACE_FILE, 'utf8'))
  } catch {
    baseline = undefined
  }

  /**
   * The declaration may live in the commit message OR in an env var, because CI checks out with no
   * message in reach (`git log` is shallow there, and a squashed PR has a different one). The env var
   * is what the workflow sets from the head commit's subject.
   */
  const declared = /\[export-change\]/u.test(
    `${process.env.GRAFT_COMMIT_MESSAGE ?? ''}\n${process.env.GITHUB_HEAD_COMMIT_MESSAGE ?? ''}`,
  )

  if (baseline === undefined || !Array.isArray(baseline.exports)) {
    // First run: record, do not judge. Writing a baseline is not a change to the contract.
    writeFileSync(
      SURFACE_FILE,
      `${JSON.stringify({ exports: surface, count: surface.length, note: 'baseline recorded by verify-bundle.mjs' }, null, 2)}\n`,
      'utf8',
    )
    check('export surface: baseline recorded', true, `${surface.length} exports (first run)`)
  } else {
    const previous = baseline.exports
    const added = surface.filter((name) => !previous.includes(name))
    const removed = previous.filter((name) => !surface.includes(name))
    const same = added.length === 0 && removed.length === 0
    const detail = same
      ? `${surface.length} exports, unchanged`
      : `${previous.length} -> ${surface.length}` +
        (added.length > 0 ? `; added: ${added.join(', ')}` : '') +
        (removed.length > 0 ? `; removed: ${removed.join(', ')}` : '') +
        (declared ? ' [declared]' : ' — add [export-change] to the commit message if intended')
    check('export surface matches the recorded baseline, or is declared', same || declared, detail)
    if (!same && declared) {
      // Refresh the baseline only when the change was declared: an undeclared change must keep
      // failing until someone looks at it, not silently become the new normal.
      writeFileSync(
        SURFACE_FILE,
        `${JSON.stringify({ exports: surface, count: surface.length, note: 'baseline updated by a declared [export-change]' }, null, 2)}\n`,
        'utf8',
      )
    }
  }
}

// --- 7. shipped file hygiene (desensitization) ----------------------------
const sensitive = [/C:\\Users\\[^<]/u, /\/Users\/[a-z]/iu, /ghp_[A-Za-z0-9]{20,}/u, /github_pat_[A-Za-z0-9_]{20,}/u, /sk-[A-Za-z0-9]{20,}/u]
const offenders = []
for (const rel of ['README.md', 'README.en.md', 'ANALYSIS-BRIEF.md', 'RELEASE_NOTES.md', 'package.json', 'cordis.patch.yml', pkg.main]) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) continue
  const text = readFileSync(full, 'utf8')
  if (sensitive.some((pattern) => pattern.test(text))) offenders.push(rel)
}
check('shipped docs carry no local paths or tokens', offenders.length === 0, offenders.length === 0 ? 'clean' : offenders.join(', '))

// --- report ---------------------------------------------------------------
const failed = results.filter((result) => !result.ok)
for (const result of results) {
  process.stdout.write(`${result.ok ? '✔' : '✖'} ${result.name} — ${result.detail}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
if (failed.length > 0) {
  process.stdout.write('\n在装有 dsh CLI 的机器上再跑一次真机安装验证：\n')
  process.stdout.write('  dsh plugin --profile verify add .\n  dsh --profile verify --dump-config\n')
  process.exitCode = 1
}