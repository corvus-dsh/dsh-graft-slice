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
import { execFileSync } from 'node:child_process'
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
   * ── v0.39 (B2-T4b): THE DECLARATION MUST BE BOUND TO THE ARTIFACT BEING MEASURED ───────────────
   *
   * THE VULNERABILITY, REPRODUCED 2026-11-18 with HEAD=a5e9fc9 (which carries `[export-change]`):
   *
   *   1. append one export to `src/index.ts`, `node scripts/build.mjs`
   *   2. `node scripts/verify-bundle.mjs`
   *      ⇒ "export surface matches the recorded baseline, or is declared — 201 -> 202; added:
   *         v238UndeclaredProbe [declared]"   ⇒ 28/28, exit 0
   *      ⇒ and `.export-surface.json` was REWRITTEN to hold that undeclared export.
   *
   * Nothing was declared for that change. `git log -1` saw `[export-change]` on the PREVIOUS commit
   * and this script treated it as covering the working tree. The damage here is worse than in
   * `dsh-observer`: the waived run does not merely pass — it RECORDS the undeclared change as the new
   * contract, so the next run says "unchanged" and no trace of it remains anywhere.
   *
   * ROOT CAUSE. `git log -1` is the declaration on the LATEST COMMIT; `surface` is `Object.keys()` of
   * the built `index.js` — the WORKING TREE's artifact. After committing and then continuing to edit,
   * those point at different things:
   *
   *   CI (right after a push)   → HEAD == the pushed commit, tree clean → the declaration APPLIES
   *   local, commit-then-edit   → HEAD == the OLD commit, tree dirty    → it DOES NOT
   *
   * THE RULE. Environment variables always count (they are set for THIS run — the only thing a CI
   * checkout can offer, since no author message is in reach there). A commit-message declaration
   * counts ONLY when the tree is clean over the paths that PRODUCE the measured artifact.
   *
   * WHY NOT BAN COMMIT-MESSAGE DECLARATIONS: committing then running `npm run check` is the ordinary
   * local path; banning it sends developers back to "export a CI variable by hand" — the dead end
   * this file's own note at :248-258 records, which produces a gate people learn to skip (⑯).
   *
   * WHY NOT "SKIP WHEN `src/` CHANGED": that rule goes mute exactly where it matters, because an
   * accidental artifact rebuild normally rides along with a `src/` change.
   */
  const MEASURED_PATHS = ['src', 'index.js']
  /**
   * ── WHY THIS FILTERS `git status` INSTEAD OF PASSING A PATHSPEC ──────────────────────────────
   *
   * `git status --porcelain -- src index.js` ERRORS (exit 128) when `src` matches nothing, which is
   * the ordinary shape of a minimal fixture — and possibly of a future layout where the source moved.
   * A catch that reads "cannot ask ⇒ not clean" would then refuse every commit-message declaration in
   * such a repository, which is the same dead end this gate was fixed to escape.
   *
   * So ask git for the whole status and filter by path HERE. `src` matches the directory and anything
   * under it; `index.js` matches exactly. Rename lines (`R  old -> new`) are judged by their TARGET,
   * because that is where the file is.
   */
  const isMeasuredPath = (path) => path === 'index.js' || path === 'src' || path.startsWith('src/')
  /**
   * The dirty lines over the measured paths — the EVIDENCE, kept as a list.
   *
   * It used to be reduced to a boolean, which made two quite different situations print the same
   * sentence: "the tree is clean" and "we could not ask git at all" (a non-checkout). A4/B-6 want the
   * list itself, because `GRAFT_ACCEPT_DIRTY_TREE=1` is a waiver a human signs — the waiver has to say
   * WHAT it waived, not merely that something was waived.
   */
  const dirtyOverMeasuredPaths = (() => {
    try {
      const out = String(
        execFileSync('git', ['status', '--porcelain'], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim()
      if (out.length === 0) return []
      const dirty = []
      for (const line of out.split('\n')) {
        const body = line.slice(3)
        const target = body.includes(' -> ') ? body.split(' -> ').pop() : body
        const path = target.replace(/^"|"$/gu, '')
        if (isMeasuredPath(path)) dirty.push(line.trim())
      }
      return dirty
    } catch {
      /** Cannot ask at all (not a git checkout) ⇒ cannot claim clean. Fail closed. */
      return ['<git status unavailable — cannot claim a clean tree>']
    }
  })()
  const treeCleanOverMeasuredPaths = dirtyOverMeasuredPaths.length === 0
  const headCommit = (() => {
    try {
      const raw = String(
        execFileSync('git', ['--no-pager', 'log', '-1', '--pretty=%h%x09%s'], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim()
      const [sha, subject = ''] = raw.split('\t')
      return { sha, subject }
    } catch {
      return { sha: '', subject: '' }
    }
  })()
  const commitMessage = (() => {
    try {
      return execFileSync('git', ['--no-pager', 'log', '-1', '--pretty=%B'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return ''
    }
  })()
  const envMessage = `${process.env.GRAFT_COMMIT_MESSAGE ?? ''}\n${process.env.GITHUB_HEAD_COMMIT_MESSAGE ?? ''}`
  /**
   * ── B4-0b-1 A8 (user ruling, 2026-11-19): AN ENV DECLARATION MUST ALSO BIND THE MEASURED TREE ──
   *
   * `fromEnvironment` used to count unconditionally. The argument for that was "CI sets it for this
   * run", which is true — and irrelevant: the environment variable says *a declaration exists for
   * this run*, not *the artifact being measured is the declared one*. With a dirty tree, the measured
   * `index.js` is a rebuild nobody committed, so the declaration is about some other artifact.
   *
   * The ruling was "是" (yes, bind it), with one escape hatch: `GRAFT_ACCEPT_DIRTY_TREE=1` waives the
   * binding EXPLICITLY. Both outcomes name themselves in the output, and a waived run records the
   * dirty list, because a waiver that does not say what it waived is a blank cheque.
   */
  const acceptDirtyTree = String(process.env.GRAFT_ACCEPT_DIRTY_TREE ?? '') === '1'
  const envDeclares = /\[export-change\]/u.test(envMessage)
  const fromEnvironment = envDeclares && (treeCleanOverMeasuredPaths || acceptDirtyTree)
  /** A commit-message declaration is honoured ONLY when the measured artifact IS that commit's. */
  const fromCommit = treeCleanOverMeasuredPaths && /\[export-change\]/u.test(String(commitMessage))
  const declared = fromEnvironment || fromCommit

  /** Where the waiver came from — printed, so a reader can tell it covers the change they see. */
  const declarationSource = fromEnvironment
    ? acceptDirtyTree && !treeCleanOverMeasuredPaths
      ? `ENVIRONMENT VARIABLE (GRAFT_COMMIT_MESSAGE / GITHUB_HEAD_COMMIT_MESSAGE) — dirty tree ACCEPTED via GRAFT_ACCEPT_DIRTY_TREE=1: ${dirtyOverMeasuredPaths.join('; ')}`
      : 'ENVIRONMENT VARIABLE (GRAFT_COMMIT_MESSAGE / GITHUB_HEAD_COMMIT_MESSAGE) — set for this run, tree clean over ' +
        MEASURED_PATHS.join(', ')
    : fromCommit
      ? `COMMIT ${headCommit.sha} "${headCommit.subject}" (tree clean over ${MEASURED_PATHS.join(', ')})`
      : undefined

  if (baseline === undefined || !Array.isArray(baseline.exports)) {
    // First run: record, do not judge. Writing a baseline is not a change to the contract.
    writeFileSync(
      SURFACE_FILE,
      `${JSON.stringify({ exports: surface, count: surface.length, note: 'baseline recorded by verify-bundle.mjs' }, null, 2)}\n`,
      'utf8',
    )
    check('export surface: baseline recorded', true, `${surface.length} exports (first run)`)
  } else if (baseline.count !== baseline.exports.length) {
    /**
     * A FIELD THE GATE IGNORES IS A FIELD THAT CAN LIE.
     *
     * `count` is redundant (`exports.length` is the truth), and the first version of this check read
     * only `exports` — so editing `count` to 999 changed nothing and still exited 0. That is worse
     * than not having the field: it invites someone to "update the count" and believe they changed
     * the contract, and it lets an inconsistent file survive review.
     *
     * Measured in `_scratch/prove-surface-gate.mjs` CASE 3 before this branch existed: count=999,
     * names identical ⇒ exit 0, file untouched. Now it is RED, and the baseline is NOT rewritten —
     * a corrupted baseline must be fixed by hand, not silently normalised by the gate that just
     * refused it.
     */
    check(
      'export surface: baseline is self-consistent',
      false,
      `.export-surface.json says count=${baseline.count} but lists ${baseline.exports.length} exports — ` +
        'fix the file by hand (the gate will not rewrite a baseline it just refused)',
    )
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
        (declared
          ? ` [declared] source: ${declarationSource}`
          : ' — add [export-change] to the commit message if intended' +
            (!treeCleanOverMeasuredPaths && /\[export-change\]/u.test(String(commitMessage))
              ? ` (note: commit ${headCommit.sha} declares [export-change], but the tree is DIRTY over ` +
                `${MEASURED_PATHS.join(', ')} — that declaration does not cover uncommitted edits)`
              : ''))
    check('export surface matches the recorded baseline, or is declared', same || declared, detail)
    if (!same && declared) {
      /**
       * Refresh the baseline only when the change was declared — and, since B2-T4b, only when the
       * declaration actually covers THIS measurement (see `fromCommit`). An undeclared change must
       * keep failing until someone looks at it, not silently become the new normal.
       *
       * A8: a run that waived a dirty tree records the dirty list in the note. The waiver is a human
       * decision, and the file it rewrites is the durable record of it.
       */
      const note =
        `baseline updated by a declared [export-change] (${declarationSource})` +
        (!treeCleanOverMeasuredPaths ? ` — dirty tree was accepted: ${dirtyOverMeasuredPaths.join('; ')}` : '')
      writeFileSync(
        SURFACE_FILE,
        `${JSON.stringify({ exports: surface, count: surface.length, note }, null, 2)}\n`,
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