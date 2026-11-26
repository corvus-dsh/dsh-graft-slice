#!/usr/bin/env node
/**
 * ── TWO COPIES OF ONE DOCUMENT MUST NOT DIVERGE ───────────────────────────────────────────────
 *
 * MEASURED DEFECT (2026-11-26, S14): `D:\持久层能力架构\B4-B-派工单.md` and
 * `报告\B4-B-派工单.md` are two copies of the SAME document. A whole section (§六十三) was written to
 * one and not the other — 239,060 vs 242,748 bytes, the difference starting exactly at the new
 * section. The previous round had REPORTED 「两份 sha 一致」, and that report was true when written;
 * it stopped being true the moment the next section was appended to one side.
 *
 * 「我核过一致」是一次核对，不是一个门禁。This file is the gate.
 *
 * ── WHY exit 2 AND NOT exit 0 WHEN A COPY IS MISSING ─────────────────────────────────────────
 *
 * A missing copy is not 「they agree」 — it is 「there is nothing to compare」. Exiting 0 there would
 * make the gate green on the one machine where the check never ran (the §〇 34 shape: two different
 * causes, one indistinguishable output). So:
 *
 *   both present + identical   → exit 0
 *   both present + differ      → exit 1, and say WHICH side is longer and WHERE they first differ
 *   one or both missing        → exit 2 + `VACUOUS`, naming the path that is absent
 *
 * ── WHY THE MESSAGE POINTS AT THE FIRST DIVERGING LINE ──────────────────────────────────────
 *
 * 「文件不同」sends the reader to diff 431 KB by hand. The first differing line number plus both
 * sides of it is the whole diagnosis in two lines.
 *
 * Usage:
 *   node scripts/check-doc-copies.mjs
 *   node scripts/check-doc-copies.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** The copy pairs, relative to the WORKSPACE (this repo is one level below it). */
const WORKSPACE = resolve(REPO, '..')

/**
 * Every pair that must stay identical, with why it is duplicated at all.
 *
 * A pair earns its place here only if BOTH copies are real reading surfaces: the workspace root one
 * is what a human opens, the `报告\` one is what gets archived with the reports.
 */
export const PAIRS = [
  {
    name: 'B4-B 派工单',
    a: join(WORKSPACE, 'B4-B-派工单.md'),
    b: join(WORKSPACE, '报告', 'B4-B-派工单.md'),
  },
]

/** Compare two texts; return `undefined` when identical, else the first divergence. */
export function firstDifference(left, right) {
  if (left === right) return undefined
  const a = left.split('\n')
  const b = right.split('\n')
  const limit = Math.min(a.length, b.length)
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) {
      return { line: i + 1, a: a[i].slice(0, 160), b: b[i].slice(0, 160), aLines: a.length, bLines: b.length }
    }
  }
  /** One is a prefix of the other — the longer side has the extra tail. */
  const longer = a.length > b.length ? 'a' : 'b'
  const extra = (longer === 'a' ? a : b).slice(limit, limit + 2).join(' / ')
  return { line: limit + 1, a: longer === 'a' ? extra : '(ends here)', b: longer === 'b' ? extra : '(ends here)', aLines: a.length, bLines: b.length }
}

function main() {
  if (process.argv.includes('--self-test')) {
    /**
     * A gate that cannot go red is a comment. Three cases, each measured rather than asserted:
     * identical ⇒ undefined; one-line difference ⇒ that line; prefix difference ⇒ the boundary.
     */
    const same = firstDifference('a\nb\n', 'a\nb\n')
    const differ = firstDifference('a\nB\nc\n', 'a\nX\nc\n')
    const prefix = firstDifference('a\nb\n', 'a\nb\nc\n')
    const ok = same === undefined && differ?.line === 2 && prefix?.line === 3
    console.log(`check-doc-copies self-test: ${ok ? 'PASS' : 'FAIL'} ` +
      `(same=${String(same)} differ@${String(differ?.line)} prefix@${String(prefix?.line)})`)
    return ok ? 0 : 1
  }

  let failures = 0
  let vacuous = 0

  for (const pair of PAIRS) {
    const missing = [pair.a, pair.b].filter((path) => !existsSync(path))
    if (missing.length > 0) {
      console.log(`VACUOUS — ${pair.name}: ${missing.length} of 2 copy(ies) missing, nothing was compared`)
      for (const path of missing) console.log(`  missing: ${path}`)
      vacuous += 1
      continue
    }
    const left = readFileSync(pair.a, 'utf8')
    const right = readFileSync(pair.b, 'utf8')
    const difference = firstDifference(left, right)
    if (difference === undefined) {
      console.log(`ok — ${pair.name}: two copies are byte-identical (${left.length} chars)`)
      continue
    }
    failures += 1
    console.log(`FAIL — ${pair.name}: the two copies have diverged`)
    console.log(`  a: ${pair.a} (${difference.aLines} lines)`)
    console.log(`  b: ${pair.b} (${difference.bLines} lines)`)
    console.log(`  first difference at line ${difference.line}:`)
    console.log(`    a: ${difference.a}`)
    console.log(`    b: ${difference.b}`)
  }

  if (vacuous > 0) {
    console.log(`\ncheck-doc-copies: ${vacuous} pair(s) could not be compared — that is NOT a pass`)
    return 2
  }
  if (failures > 0) {
    console.log(`\ncheck-doc-copies: ${failures} pair(s) diverged — copy the newer side over the older one`)
    return 1
  }
  console.log(`\ncheck-doc-copies: ${PAIRS.length} pair(s) identical`)
  return 0
}

process.exitCode = main()
