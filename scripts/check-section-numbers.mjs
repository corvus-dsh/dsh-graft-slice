#!/usr/bin/env node
/**
 * ── ONE DOCUMENT MUST NOT NUMBER THE SAME SECTION TWICE ───────────────────────────────────────
 *
 * MEASURED DEFECT (2026-11-26, S15/R2): `B4-B-派工单.md` carries TWO `## 六十四、` sections —
 * `:5736` (an acceptance review) and `:5862` (the execution record). `64.1`–`64.7` appear twice.
 *
 * And `check-doc-copies` was GREEN the whole time, correctly: 「the two copies are identical」 is a
 * true statement that answers a DIFFERENT question. Two identical copies can be identically wrong.
 *
 * ── WHY A REGEX ON `^## ` IS NOT ENOUGH ────────────────────────────────────────────────────────
 *
 * Measured while writing this gate: a naive `^##\s+([^\s]+)` yields `六十四、S13` and `六十四、S14` —
 * two different tokens, so the duplicate is INVISIBLE. The number must be extracted as the leading
 * Chinese/arabic numeral up to the first delimiter (`、`/`.`/space), then compared.
 *
 * That is the same lesson as this batch's other four: the identifier is a NUMBER, and the text after
 * it is a title that is EXPECTED to differ. Comparing whole headings can never find a duplicate that
 * was written by someone who thought they had the next number.
 *
 * ── WHAT IS CHECKED ─────────────────────────────────────────────────────────────────────────
 *
 *   ① top-level sections (`## N、`) have unique numbers
 *   ② subsections (`### N.M`) are unique WITHIN their parent section
 *   ③ the numbering is MONOTONIC — a section may not reuse a number lower than one already used
 *      (that is how `六十四` twice happens: the second author did not read the tail)
 *
 * Exit: 0 clean · 1 duplicates found · 2 file missing (`VACUOUS`, not a pass)
 *
 * Usage:
 *   node scripts/check-section-numbers.mjs [paths...]
 *   node scripts/check-section-numbers.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Chinese numeral → value, enough for 一..百 (these documents use at most three digits). */
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

export function chineseToNumber(text) {
  if (/^\d+$/u.test(text)) return Number(text)
  let total = 0
  let section = 0
  let hasAny = false
  for (const char of text) {
    if (CN_DIGITS[char] !== undefined) {
      section = CN_DIGITS[char]
      hasAny = true
      continue
    }
    if (char === '十') {
      /** 「十」 alone is 10; 「二十」是 20; 「二十四」是 24. */
      section = (section === 0 ? 1 : section) * 10
      total += section
      section = 0
      hasAny = true
      continue
    }
    if (char === '百') {
      section = (section === 0 ? 1 : section) * 100
      total += section
      section = 0
      hasAny = true
      continue
    }
    return undefined
  }
  return hasAny ? total + section : undefined
}

/** Pull `(number, title)` out of a heading line, or undefined when it is not numbered. */
export function sectionNumberOf(line) {
  const match = /^##\s+([^\s、.．,，]+)\s*[、.．,，]?\s*(.*)$/u.exec(line)
  if (match === null) return undefined
  const value = chineseToNumber(match[1])
  if (value === undefined) return undefined
  return { value, raw: match[1], title: match[2] }
}

/** Pull the sub-number out of a `### 64.1 …` heading. */
export function subsectionOf(line) {
  /**
   * ── A `b` SUFFIX IS A CONTINUATION, NOT A DUPLICATE ────────────────────────────────────────────
   *
   * Measured on the real document: `### 22.3` is followed by `### 22.3b`, and `### 44.4` by
   * `### 44.4b`. Those are the same numbered item continued after an interjection — the author's own
   * convention here, used consistently.
   *
   * The first version's `(\d+)\.(\d+)` stopped before the `b`, so `22.3b` collapsed onto `22.3` and
   * the gate reported two "duplicates" that are not duplicates. **A criterion that cannot tell a
   * continuation from a repeat will be switched off by the first person who uses the suffix** — and
   * then it stops finding the real duplicates too.
   *
   * So the suffix is captured and carried into the key: `22.3` and `22.3b` are different keys.
   */
  const match = /^###\s+(\d+)\.(\d+)([a-z]?)/u.exec(line)
  if (match === null) return undefined
  return { parent: Number(match[1]), child: Number(match[2]), suffix: match[3] ?? '' }
}

export function auditDocument(text) {
  const lines = text.split('\n')
  const problems = []
  const seenSections = new Map()
  let currentSection
  let lastValue = 0
  const seenSubs = new Map()

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const section = sectionNumberOf(line)
    if (section !== undefined) {
      currentSection = section.value
      if (seenSections.has(section.value)) {
        problems.push(`§${section.raw} 出现在 L${seenSections.get(section.value)}，又出现在 L${i + 1}（编号重复）`)
      } else {
        seenSections.set(section.value, i + 1)
      }
      /**
       * Monotonicity: the documents are append-only, so a number that goes BACKWARDS means the author
       * did not read the tail — which is exactly how the duplicate arose.
       */
      if (section.value < lastValue) {
        problems.push(`§${section.raw}（L${i + 1}）的编号小于前一个 §${lastValue} —— 追加时必须先读尾部`)
      }
      lastValue = Math.max(lastValue, section.value)
      continue
    }

    const sub = subsectionOf(line)
    if (sub !== undefined && currentSection !== undefined) {
      const key = `${sub.parent}.${sub.child}${sub.suffix}`
      if (seenSubs.has(key)) {
        problems.push(`${key} 出现在 L${seenSubs.get(key)}，又出现在 L${i + 1}（子节重复）`)
      } else {
        seenSubs.set(key, i + 1)
      }
    }
  }

  return { sections: seenSections.size, problems }
}

function main() {
  const args = process.argv.slice(2)

  if (args.includes('--self-test')) {
    /**
     * The three shapes this gate exists for, each measured rather than asserted:
     *   · two `## 六十四、…` with DIFFERENT titles  ⇒ must be found (the naive regex misses it)
     *   · a subsection repeated under one parent      ⇒ must be found
     *   · a clean document                            ⇒ must be silent
     */
    const duplicateSections = '## 六十三、A\n### 63.1 x\n\n## 六十四、B\n### 64.1 y\n\n## 六十四、C\n### 64.1 z\n'
    const duplicateSubs = '## 一、A\n### 1.1 x\n### 1.1 y\n'
    const clean = '## 一、A\n### 1.1 x\n\n## 二、B\n### 2.1 y\n'

    const found = auditDocument(duplicateSections).problems
    const subsFound = auditDocument(duplicateSubs).problems
    const cleanFound = auditDocument(clean).problems

    const ok = found.some((line) => line.includes('编号重复')) &&
      found.some((line) => line.includes('子节重复')) &&
      subsFound.length > 0 &&
      cleanFound.length === 0

    console.log(`check-section-numbers self-test: ${ok ? 'PASS' : 'FAIL'}`)
    console.log(`  duplicate sections found: ${found.filter((l) => l.includes('编号重复')).length}`)
    console.log(`  duplicate subsections found: ${found.filter((l) => l.includes('子节重复')).length}`)
    console.log(`  clean document problems: ${cleanFound.length}`)
    return ok ? 0 : 1
  }

  const paths = args.filter((arg) => !arg.startsWith('--'))
  if (paths.length === 0) {
    console.error('usage: node scripts/check-section-numbers.mjs <file.md> [...]')
    console.error('This gate needs a denominator: no files means nothing was compared.')
    return 2
  }

  const missing = paths.filter((path) => !existsSync(resolve(path)))
  if (missing.length > 0) {
    console.log('VACUOUS — these path(s) do not exist, so nothing was compared:')
    for (const path of missing) console.log(`  missing: ${path}`)
    return 2
  }

  let failures = 0
  for (const path of paths) {
    const { sections, problems } = auditDocument(readFileSync(resolve(path), 'utf8'))
    if (sections === 0) {
      console.log(`VACUOUS — ${path}: no numbered section found, nothing was compared`)
      failures += 1
      continue
    }
    if (problems.length === 0) {
      console.log(`ok — ${path}: ${sections} numbered section(s), all unique and monotonic`)
      continue
    }
    failures += 1
    console.log(`FAIL — ${path}: ${problems.length} numbering problem(s)`)
    for (const problem of problems) console.log(`  ${problem}`)
  }

  if (failures > 0) {
    console.log(`\ncheck-section-numbers: ${failures} file(s) with problems`)
    return 1
  }
  console.log(`\ncheck-section-numbers: ${paths.length} file(s) clean`)
  return 0
}

process.exitCode = main()
