#!/usr/bin/env node
/**
 * ── KEY NUMBERS MUST CARRY THEIR SOURCE (N5 / S16, previously R3) ───────────────────────────────
 *
 * THREE TIMES IN A ROW a report quoted a number that was not read from a file:
 *
 *   · `paradise 509 / 509`   — actually 508 (a test was red)
 *   · `地板 6,762`            — the document said 6,732, and 6,732 was right
 *   · `第 3/4 簇`             — `git log --diff-filter=A` says 3 and 4, the report said 4 and 5
 *
 * The first two were caught by re-running; the third by reading git. **The common defect is not the
 * arithmetic — it is that the number had no stated origin, so nobody could check it cheaply.**
 *
 * ── WHY ONLY FOUR KINDS OF NUMBER ─────────────────────────────────────────────────────────────
 *
 * A rule that demands a source for EVERY number in a report would be red on its first paragraph and
 * would be switched off — this repository has recorded that failure mode repeatedly. So this gate
 * covers the four where being wrong has actually caused damage:
 *
 *   1. test counts          `N / M` or `N tests`
 *   2. line counts          `index.ts` … `14,067 行`
 *   3. floors / ceilings    `地板` / `ceiling` … `6,708`
 *   4. cluster ordinals     `第 N 簇`
 *
 * Each occurrence must sit on a line that ALSO names its evidence: a command (`node --test`,
 * `npm run check`, `git log`, `index-ratchet`), or an explicit provenance marker (`来源：` /
 * `measured` / `实测`).
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Only the file(s) passed on the command line. This is not a linter for the whole workspace — it is
 * pointed at a report by whoever wants it checked, the same way `check-doc-copies` is.
 *
 * Usage:
 *   node scripts/check-reported-numbers.mjs <report.md> [...]
 *   node scripts/check-reported-numbers.mjs --self-test
 *
 * Exit: 0 all cited · 1 some uncited · 2 nothing to measure (`VACUOUS`, not a pass)
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The four kinds, each with the shape that makes it a CLAIM rather than prose. */
export const KINDS = [
  {
    name: 'test-count',
    pattern: /\b\d{2,5}\s*\/\s*\d{2,5}\b|\b\d{2,5}\s*(?:个)?tests?\b/gu,
  },
  {
    name: 'line-count',
    pattern: /\b\d{1,3}(?:,\d{3})+\s*行|\b\d{1,3}(?:,\d{3})+\s*lines\b/gu,
  },
  {
    name: 'floor-or-ceiling',
    pattern: /(?:地板|ceiling|下限)[^\n]{0,40}?\d{1,3}(?:,\d{3})+/gu,
  },
  {
    name: 'cluster-ordinal',
    pattern: /第\s*\d+\s*簇/gu,
  },
]

/**
 * A line cites its evidence when it names the instrument that produced the number, or carries an
 * explicit provenance marker.
 *
 * `实测` is accepted because it is this project's own word for 「I ran it」, used consistently since
 * the first audit; requiring a literal command would reject honest sentences like 「实测 508/509」.
 */
export const EVIDENCE = /node\s+--test|npm\s+run\s+check|git\s+log|index-ratchet|check-[a-z-]+\.mjs|来源[:：]|measured|实测|measuredAndCited/iu

/**
 * ── TWO KINDS OF LINE ARE NOT CLAIMS ABOUT TODAY, AND MUST NOT BE DEMANDED A SOURCE ────────────
 *
 * Measured on the first real run (8 hits, and MOST were false positives):
 *
 *   1. **A DATED line** — `（**当时**：…1,462 行闭包口径）`, `historical`, `v7.6 登记`. These say
 *      「this was true at a stated moment」. Demanding today's instrument would either fail an honest
 *      historical record or push someone to delete the date.
 *   2. **An account paragraph** — `段一 · 第 N 簇的行数账：搬 77 行 … index.ts 14,324 → 14,252`.
 *      Its numbers are the paragraph's own subject; the paragraph IS the evidence (the move is in
 *      git). `v378`/`v381` already hold those numbers to an exact, gap-naming standard.
 *
 * A criterion that fires on those would be red on correct documents — the 「宽一格的判据会惩罚正确
 * 代码」 shape this repo has recorded repeatedly. So both are exempt, explicitly and with a reason.
 */
export const DATED = /当时|historical|历史|v\d+\.\d+|起(?:为)?|登记时为/u
export const ACCOUNT = /段一\s*·\s*第\s*\d+\s*簇的行数账/u

/** Every claim on `text` that lacks a cited source. */
export function uncitedClaims(text) {
  const problems = []
  const lines = text.split('\n')
  /** Track fenced blocks: a block of pasted output is itself the evidence. */
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (/^\s*\|/u.test(line)) continue
    if (DATED.test(line)) continue
    if (ACCOUNT.test(line)) continue

    const cited = EVIDENCE.test(line)
    for (const kind of KINDS) {
      kind.pattern.lastIndex = 0
      const match = kind.pattern.exec(line)
      if (match === null) continue
      if (!cited) problems.push({ line: i + 1, kind: kind.name, text: match[0], raw: line.trim().slice(0, 120) })
      break
    }
  }
  return problems
}

function main() {
  const args = process.argv.slice(2)

  if (args.includes('--self-test')) {
    /** A criterion that cannot say NO is a comment — and it must ALSO accept a cited line. */
    const bad = [
      '# 报告',
      'paradise 509 / 509 全绿。',
      'index.ts 14,067 行。',
      '这是第 5 簇。',
    ].join('\n')
    const good = [
      '# 报告',
      '`npm run check` 输出：509 / 509（命令见下）。',
      '`node scripts/index-ratchet.mjs`：14,067 行。',
      '`git log --diff-filter=A` 显示第 3 簇（1325286）。',
    ].join('\n')

    const badFound = uncitedClaims(bad)
    const goodFound = uncitedClaims(good)
    const ok = badFound.length >= 3 && goodFound.length === 0
    console.log(`check-reported-numbers self-test: ${ok ? 'PASS' : 'FAIL'}`)
    console.log(`  uncited in the bad sample: ${badFound.length} (expected >= 3)`)
    console.log(`  uncited in the good sample: ${goodFound.length} (expected 0)`)
    if (!ok) {
      for (const problem of goodFound) console.log(`    false positive: L${problem.line} ${problem.kind} ${problem.text}`)
    }
    return ok ? 0 : 1
  }

  const paths = args.filter((arg) => !arg.startsWith('--'))
  if (paths.length === 0) {
    console.error('usage: node scripts/check-reported-numbers.mjs <report.md> [...]')
    console.error('This gate needs a denominator: no file means nothing was checked.')
    return 2
  }

  const missing = paths.filter((path) => !existsSync(resolve(path)))
  if (missing.length > 0) {
    console.log('VACUOUS — these path(s) do not exist, so nothing was checked:')
    for (const path of missing) console.log(`  missing: ${path}`)
    return 2
  }

  let failures = 0
  for (const path of paths) {
    const problems = uncitedClaims(readFileSync(resolve(path), 'utf8'))
    if (problems.length === 0) {
      console.log(`ok — ${path}: every key number names its source`)
      continue
    }
    failures += 1
    console.log(`FAIL — ${path}: ${problems.length} number(s) with no stated source`)
    for (const problem of problems.slice(0, 12)) {
      console.log(`  L${problem.line} [${problem.kind}] ${problem.text}`)
      console.log(`      ${problem.raw}`)
    }
    if (problems.length > 12) console.log(`  … and ${problems.length - 12} more`)
  }

  if (failures > 0) {
    console.log(`\ncheck-reported-numbers: ${failures} file(s) with uncited numbers`)
    return 1
  }
  console.log(`\ncheck-reported-numbers: ${paths.length} file(s) clean`)
  return 0
}

process.exitCode = main()
