/**
 * ── v140: 硬编码行号清单必须被钉住，否则它会随下一次搬移重新长出来 ──────────────────────────────
 *
 * 起因（用户 2026-11-11 要求「要有一张清单，不是逐个撞」）：
 *   两次搬移各撞了 2 处坐标断言的失效 —— −288（GraftConfig）与 −16（文本工具）。
 *   每次都只修了「恰好红了的那两个」，下一次搬移再撞下两个。
 *
 * 已扫出的全部（排除注释后，用 scripts/audit-line-numbers.mjs）：
 *
 * | 位置 | 内容 | 判定 | 处置 |
 * |---|---|---|---|
 * | v135:148 | `--block src/core/adaptive-depth.ts 17 141` | **脆弱**（该文件行数会变） | 改为查找整个文件的声明范围 |
 * | v135:224 | `--block src/index.ts 1 5` | 安全（测「纯注释区间 outside = 0」，任何文件开头都成立） | 保留，注明依据 |
 * | v135:233 | `--block src/index.ts 999999 1000000` | 安全（**越界输入**，不是地址） | 保留，注明依据 |
 *
 * 本测试钉住这三条现状：允许清单内的硬编码存在，但**新增一条就红**。
 * 这样下一个搬移的人会看到一份清单 + 一条「为什么不许再加」的理由，
 * 而不是在 CI 里逐个撞。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const AUDIT = join(ROOT, 'scripts', 'audit-line-numbers.mjs')

/** The audit's own output, parsed. Comments are already excluded by the script. */
const audit = () => {
  const out = execFileSync(process.execPath, [AUDIT], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const fragile = []
  // The section header itself contains "===", so splitting on "===" eats the header. Split on the
  // NEXT "===" marker instead, which starts with a newline and the literal `=== ` at column 0.
  const start = out.indexOf('=== FRAGILE')
  if (start < 0) return fragile
  const afterHeader = out.indexOf('\n', start) + 1
  const nextSection = out.indexOf('\n=== ', afterHeader)
  const section = out.slice(afterHeader, nextSection < 0 ? undefined : nextSection)
  for (const line of section.split('\n')) {
    // columns are space-separated: "<file>:<line>   <what>   "<source>""
    // `what` may itself contain spaces (`--block src/index.ts 1..5`), so split on the quoted tail first
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('(')) continue
    const quoteAt = trimmed.lastIndexOf(' "')
    if (quoteAt < 0) continue
    const head = trimmed.slice(0, quoteAt).trim()
    const whereMatch = /^(\S+\.test\.mjs:\d+)\s+(.*)$/u.exec(head)
    if (whereMatch === null) continue
    fragile.push({ where: whereMatch[1], what: whereMatch[2].trim() })
  }
  return fragile
}

test('v140: the FRAGILE line-number list is exactly the reviewed set', () => {
  const fragile = audit()

  /**
   * Reviewed 2026-11-11. Every entry here is either (a) not a source address, or (b) deliberately left
   * literal because its CONTENT is the subject, not its place:
   *
   *   v135: `--block src/index.ts 1 5`          — a comment-only header; asserts outside == 0
   *   v135: `--block src/index.ts 999999 …`     — an out-of-range INPUT; asserts no crash
   *
   * Anything else must be removed or upgraded to a lookup. Adding an entry is a decision, not an
   * accident, so this test forces it to be made here.
   */
  const REVIEWED = [
    { where: 'v135-subblock-closure.test.mjs', what: '--block src/index.ts 1..5' },
    { where: 'v135-subblock-closure.test.mjs', what: '--block src/index.ts 999999..1000000' },
  ]

  const unexpected = fragile.filter((entry) => !REVIEWED.some((allowed) =>
    entry.where.startsWith(allowed.where) && entry.what === allowed.what))

  assert.deepEqual(unexpected, [],
    `${unexpected.length} NEW hardcoded source address(es) appeared. A move will invalidate them the way ` +
    `−288 and −16 did. Either locate the range at runtime, or add it to REVIEWED with the reason it is ` +
    `not really an address.\n` +
    unexpected.map((entry) => `  ${entry.where}  ${entry.what}`).join('\n'))

  // and the denominator: the audit must actually be looking at something
  assert.ok(fragile.length > 0,
    'the audit found no hardcoded addresses at all — either they were all removed (then delete this ' +
    'test) or the detector stopped matching')
})

test('v140: the one genuinely fragile range is now LOCATED, not remembered', () => {
  /**
   * `--block src/core/adaptive-depth.ts 17 141` was the only entry whose file can change size. It is now
   * derived from the file. This pins that the lookup exists — a regression to literal numbers would show
   * up here even if the numbers happened to still be correct.
   */
  const v135 = readFileSync(join(ROOT, 'test', 'v135-subblock-closure.test.mjs'), 'utf8')
  assert.match(v135, /const adaptiveDepthRange = \(\(\) => \{/u,
    'the adaptive-depth range must be derived from the file')
  assert.doesNotMatch(v135, /--block', 'src\/core\/adaptive-depth\.ts', '17'/u,
    'the literal 17 must be gone')
  assert.match(v135, /String\(adaptiveDepthRange\.start\), String\(adaptiveDepthRange\.end\)/u,
    'and the derived bounds must be what is passed to the tool')
})

test('v140: the two safe ranges are documented as safe where they stand', () => {
  /**
   * A reviewer who sees `'1', '5'` next to `'999999', '1000000'` should not have to rediscover why they
   * are fine. The reasons live next to them, and this test keeps them there.
   */
  const v135 = readFileSync(join(ROOT, 'test', 'v135-subblock-closure.test.mjs'), 'utf8')
  assert.match(v135, /comment-only range reports no dependencies/u)
  assert.match(v135, /OUT-OF-RANGE INPUT, not an address/u)
  assert.match(v135, /comment-only range reports no dependencies/u, 'the 1..5 range must say what it is')
})
