/**
 * ── v273 (B4-0b-2 W1-11b / W1-11c): the separator gate must be TESTED, and its claim must match it ──
 *
 * ── W1-11b: the gate had no behavioural test ──────────────────────────────────────────────────
 *
 * `v129` registers `check-test-separators.mjs` as a `GATE` and nothing else in `test/` referenced it. Its
 * own `--self-test` exercises `PATTERNS` against literal strings — it never runs `walk(TEST)` and never
 * looks at the exit code. Reproduced: replacing the body of `walk` with `return []` left `--self-test`
 * GREEN and the gate at `OK — 0 suspicious line(s)`. A gate that has gone blind and says so cheerfully is
 * worse than no gate: the report line is the evidence people cite.
 *
 * So this file builds a THROWAWAY SKELETON — `<tmp>/scripts/check-test-separators.mjs` plus
 * `<tmp>/test/*.mjs` — and runs the real script there. `ROOT` is derived from the script's own location,
 * so the copy naturally scopes itself to the skeleton; no new parameter is needed on the gate.
 *
 * ── W1-11c: the claim was wider than the implementation ─────────────────────────────────────
 *
 * The gate's name says 「禁止手写路径分隔符」. What it actually detects is three shapes of
 * **`\` used as a CONCATENATION separator**. A `\\` inside a literal — `join(dir, 'sub\\file')` — is also a
 * hand-written separator, and it is NOT caught, because `\\` is indistinguishable from an escaped
 * backslash in a Windows path literal (`'D:\\w'`) or a regex (`/\\/gu`).
 *
 * Measured: 9 such lines exist in this repo's tests and ALL are legitimate inputs. A heuristic that
 * flags them would be red on day one, and 「误报的检查器一周内被关掉」 is a lesson this batch already
 * recorded. So the honest move is the TD-23 one: **narrow the claim and pin the limit as a case**.
 *
 *   · ⑤ asserts the known limit does NOT fire (and says why it must not);
 *   · the gate's header, this file and the commit message say 「拼接分隔符（三种形态）」, not 「手写分隔符」.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const GATE_REL = 'scripts/check-test-separators.mjs'

/**
 * Build a skeleton: the REAL gate at `<tmp>/scripts/`, and whatever test files the caller writes at
 * `<tmp>/test/`. The gate resolves `ROOT` from `import.meta.url`, so the copy scans the skeleton only —
 * which is what makes "inject a defect and observe" safe.
 */
function gateOnSkeleton(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v273-'))
  mkdirSync(join(root, 'test'), { recursive: true })
  cpSync(join(REPO, GATE_REL), join(root, GATE_REL), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    const target = join(root, 'test', name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  try {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [join(root, GATE_REL)], { encoding: 'utf8', cwd: root }),
      }
    } catch (error) {
      return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The v257 shape, verbatim: a sibling path written by hand. */
const V257 = [
  "import { join } from 'node:path'",
  "const plain = join('a')",
  'const sameDir = `${plain}\\`',
  'void sameDir',
  '',
].join('\n')

test('v273 ①: the dumped-in v257 shape REALLY fails the gate (exit 1 and the file is named)', () => {
  const result = gateOnSkeleton({ 'injected.test.mjs': V257 })
  assert.equal(result.code, 1, `the injected file must be RED; got exit ${result.code}:\n${result.out.slice(0, 500)}`)
  assert.match(result.out, /injected\.test\.mjs/u, `the gate must name the offending file; got:\n${result.out.slice(0, 500)}`)
  assert.match(result.out, /template-then-backslash/u, 'and the shape it matched')
})

test('v273 ②: a clean skeleton passes (① is not "always red")', () => {
  const result = gateOnSkeleton({
    'clean.test.mjs': ["import { join } from 'node:path'", "const p = join('a', 'b')", 'void p', ''].join('\n'),
  })
  assert.equal(result.code, 0, `a clean tree must pass; got:\n${result.out.slice(0, 500)}`)
  assert.match(result.out, /OK/u)
})

test('v273 ③: an EMPTY test directory is still green, and reports zero (the walker is not vacuous-looking)', () => {
  /**
   * This is the shape the blindness produced: `walk` returning `[]` made the gate print
   * 「OK — 0 suspicious line(s)」. Zero findings on an empty tree is CORRECT — the point of ⑥ is that the
   * check must fail when it should, not that it must always find something. ③ and ⑥ together are what
   * distinguish "nothing to find" from "cannot see".
   */
  const result = gateOnSkeleton({})
  assert.equal(result.code, 0)
  assert.match(result.out, /0 suspicious/u)
})

test('v273 ④: the walker is exercised — a defect in a SUBDIRECTORY is found too', () => {
  /**
   * `walk` recurses. ① only proves the top level; if the recursion broke, a defect one level down would
   * be invisible while every other assertion still passed. The gate's own `walk` does not create
   * subdirectories today, but the skeleton does — and the recursion is what a refactor is most likely to
   * break.
   */
  const result = gateOnSkeleton({ 'nested/deep/injected.test.mjs': V257 })
  assert.equal(result.code, 1, `a nested defect must be found; got exit ${result.code}:\n${result.out.slice(0, 500)}`)
  assert.match(result.out, /nested\/deep\/injected\.test\.mjs|nested\\deep\\injected\.test\.mjs/u)
})

test('v273 ⑤: KNOWN LIMIT — `join(dir, "sub\\\\file")` is NOT flagged, and must not be', () => {
  /**
   * ── W1-11c: THE DECLARED LIMIT, PINNED AS A CASE ─────────────────────────────────────────────
   *
   * `join(dir, 'sub\\file')` writes a separator by hand. The gate does not catch it, and this test asserts
   * that it does not — because catching it would require distinguishing it from `'D:\\work\\demo'` (a
   * Windows path literal) and `/\\/gu` (a regex escape), which are the SAME three characters in source.
   *
   * Measured: 9 such lines exist in this repo's tests and every one is a legitimate input. A heuristic
   * that flags them is red on day one — and the recorded lesson is that a checker which cries wolf gets
   * switched off. So the claim is narrowed to 「拼接分隔符（三种形态）」 instead of 「手写分隔符」, and this
   * case is the receipt.
   *
   * This is the same honesty as TD-23's `security-known-limit`: state the boundary, prove the boundary is
   * where you say it is, and do not let the name imply more.
   */
  const result = gateOnSkeleton({
    'limit.test.mjs': [
      "import { join } from 'node:path'",
      "const p = join(dir, 'sub\\\\file')",
      'void p',
      '',
    ].join('\n'),
  })
  assert.equal(result.code, 0, `the known limit must NOT fire; got:\n${result.out.slice(0, 500)}`)
  /** And ① still fires in the same run's terms — the limit is about `\\`, not about the gate being off. */
  const withReal = gateOnSkeleton({ 'both.test.mjs': `${V257}\nimport { join as j2 } from 'node:path'\nconst q = j2(dir, 'sub\\\\file')\nvoid q\n` })
  assert.equal(withReal.code, 1, 'the same file containing BOTH must still be RED (the `\\\\` does not mask the `\\`)')
})
