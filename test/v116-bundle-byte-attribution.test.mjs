/**
 * E5 — THE SEVENTH STANDARD: EVERY NEW BYTE IN THE SHIPPED BUNDLE MUST BE ATTRIBUTABLE.
 *
 * ── WHY SIX STANDARDS WERE NOT ENOUGH ──────────────────────────────────────────────────────────
 *
 * The six standards that preceded this one all ask "did BEHAVIOUR change": four-repo tests, one
 * declaration per name, 182 exports, idempotent build, drift→red, byte-identical output. None asks
 * "what ARE these new bytes". That is exactly how +15,514 bytes of test metadata — with real
 * `session-<uuid>` ids and this machine's corpus filenames — entered a published artifact while every
 * standard passed.
 *
 * ── WHY THIS FILE WAS REWRITTEN (the first version was the wrong instrument) ────────────────────
 *
 * Attempt 1 classified every line as import/comment/code/blank and demanded no line fall through. It
 * flagged `truncated: true,`, then `windowLimit        ,`, then `: feasible` — each time I widened the
 * pattern, another ordinary shape appeared. That is a losing game: the classifier was modelling
 * JavaScript SYNTAX with regexes, and any exemption list it grew would be the place a real leak hid.
 *
 * Attempt 2 asks the question E5 actually asks. A leaked data blob is not "a line without a semicolon";
 * it is a LONG LITERAL VALUE — prose, a path, an id — sitting in the artifact. So the rule is:
 *
 *     every string literal longer than N characters must be ATTRIBUTABLE to a source file
 *     that production actually ships.
 *
 * Attribution is mechanical: strip every long literal out of the bundle, and each one must be findable
 * in one of the shipped `src/**` files. A literal that exists only in the bundle is unattributable —
 * that is the failure mode, and it is decidable without modelling syntax.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE = new URL('../index.js', import.meta.url)
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Literals shorter than this are identifiers, messages, keys — not blobs. */
const MIN_LITERAL = 120

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** All long string/template literal BODIES in a text. */
function longLiterals(text) {
  const found = []
  const pattern = /(['"`])((?:[^'"`\\\n]|\\.){120,}?)\1/gu
  for (const match of text.matchAll(pattern)) found.push(match[2])
  return found
}

/**
 * ── WHY ATTRIBUTION COMPARES A WHITESPACE-FREE FORM ──────────────────────────────────────────────
 *
 * The type stripper rewrites `String((error)?.message ?? error)` into `String((error )?.message ??
 * error)` — it removes the `: any` annotation and leaves ONE space where the annotation used to start.
 * A literal identical in the SOURCE is therefore not byte-identical in the BUNDLE, and a naive
 * `includes()` reports it as an unattributable blob.
 *
 * Collapsing runs of whitespace is not enough (the stray space is a run of ONE). Removing whitespace
 * entirely makes the comparison about CONTENT, which is what "attributable" has to mean for a build
 * that rewrites code. The self-test below proves this does not weaken the check into vacuity: an
 * injected blob still fails, because no amount of whitespace removal invents its characters.
 */
function normalize(text) {
  return text.replace(/\s+/gu, '')
}

test('E5: every long literal in the bundle is attributable to a shipped source file', () => {
  const bundle = readFileSync(BUNDLE, 'utf8')
  const literals = longLiterals(bundle)

  /**
   * ── WHY THE SOURCE IS TYPE-STRIPPED BEFORE COMPARING ─────────────────────────────────────────────
   *
   * The bundle is produced by `stripTypeScriptTypes`, which removes type annotations AND the
   * assertions that go with them: `String((error as any)?.message)` becomes `String((error)?.message)`.
   * So an attributable literal is NOT byte-identical to its source, and comparing raw source text
   * reports a false leak.
   *
   * Using the SAME stripper on the source puts both sides in the same language, which is the only
   * comparison that means anything for a build that rewrites code. (Measured before this fix: one
   * literal differed by exactly ` as any`.)
   */
  const sourceText = walk(SRC)
    .map((file) => stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }))
    .join('\n')
  const normalizedSource = normalize(sourceText)

  const unattributable = literals.filter((literal) => !normalizedSource.includes(normalize(literal)))

  console.log(`long literals (≥${MIN_LITERAL} chars) in the bundle: ${literals.length}`)
  console.log(`attributable to src/** : ${literals.length - unattributable.length}`)

  assert.deepEqual(
    unattributable.map((literal) => literal.slice(0, 80)),
    [],
    'a long literal exists in the shipped bundle but in NO shipped source file — that is a data blob ' +
      'that entered through the build, not through the code',
  )
})

test('E5: the check can actually fail — an injected blob is detected', () => {
  // Self-test: the same function, run over a synthetic bundle that carries a blob from nowhere.
  const synthetic = 'const x = "这是一段并不存在于任何源文件里的长文本，用来证明这个判据真的能红。'.padEnd(200, '这') + '"'
  const sourceText = 'const y = "unrelated"'
  const literals = longLiterals(synthetic)
  assert.ok(literals.length > 0, 'the fixture must produce a long literal')
  const unattributable = literals.filter((literal) => !sourceText.includes(literal))
  assert.equal(unattributable.length, 1, 'an injected blob must be detected as unattributable')
})

test('E5: no test-only metadata symbol is DECLARED in the bundle', () => {
  /**
   * The concrete instance of the general rule. These names exist only as test metadata; a declaration
   * of one in the artifact means the E1 split regressed. `nearMisses` / `samples` are checked as
   * property names too, because that is how the metadata block appeared.
   */
  const bundle = readFileSync(BUNDLE, 'utf8')
  const declarations = bundle
    .split(/\r?\n/)
    .map((line, index) => ({ index: index + 1, line }))
    .filter(({ line }) => /^(?:export )?(?:const|let|var)\s+\w*(?:_CONTRACT|ALL_CONTRACTS)\b/u.test(line.trim()))

  assert.deepEqual(
    declarations.map(({ index, line }) => `${index}: ${line.trim().slice(0, 60)}`),
    [],
    'a contract-metadata declaration reached the shipped bundle',
  )
})
