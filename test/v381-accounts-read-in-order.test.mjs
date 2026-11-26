/**
 * ── v381：账目段必须与阅读顺序一致（N6 / S16）────────────────────────────────────────────────────
 *
 * 病（实测 2026-11-26）：四段账目是 **4、3、2、1**。每段都只报自己的增量，所以读者从上往下看到的
 * 起点序列是 `14,137 → 14,203 → 14,253 → 14,324` —— **像时间倒流**。
 *
 * 这与我上一轮**自己定下**的章节编号判准是同一条：**唯一还不够，必须与阅读顺序一致**。
 * 章节编号照做了，账目段没有 —— 同一面镜子，同一天，两次。
 *
 * 判据：
 *   ① 段落按簇号升序排列（不是「集合相等」，是**序列相等**）
 *   ② 每段必须写出它的**两端**（`从 A 到 B` 或 `A → B`）：只有一端的账，读者要自己减
 *   ③ **负向**：倒序 ⇒ 红并点名第一处逆序
 *   ④ **负向**：某段只写一端 ⇒ 红
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARCH = join(ROOT, 'ARCHITECTURE.md')
const arch = readFileSync(ARCH, 'utf8')

/** The account paragraphs, in file order. */
export function paragraphsInOrder(text) {
  const lines = text.split('\n')
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/段一\s*·\s*第\s*\d+\s*簇的行数账/u.test(lines[i])) continue
    let end = i + 1
    while (end < lines.length && lines[end].trim() !== '' && !/第\s*\d+\s*簇的行数账/u.test(lines[end])) end += 1
    found.push({
      number: Number(/第\s*(\d+)\s*簇/u.exec(lines[i])[1]),
      line: i + 1,
      body: lines.slice(i, end).join('\n'),
    })
  }
  return found
}

/**
 * Judge the ORDER of a sequence of cluster numbers.
 *
 * Exported so the negative half exercises the same rule — a second implementation would be a second
 * source of truth.
 */
export function judgeOrder(numbers) {
  const problems = []
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] < numbers[i - 1]) {
      problems.push(`第 ${numbers[i]} 簇排在第 ${numbers[i - 1]} 簇之后（阅读顺序与编号相反）`)
    }
  }
  return problems
}

test('v381 ①: the account paragraphs read in ASCENDING cluster order', () => {
  const paragraphs = paragraphsInOrder(arch)
  assert.ok(paragraphs.length >= 2, `① 必须有多段账可比较，实测 ${paragraphs.length} 段`)

  const numbers = paragraphs.map((paragraph) => paragraph.number)
  const problems = judgeOrder(numbers)
  assert.deepEqual(problems, [],
    `① 账目段必须正序，实测顺序 ${numbers.join(' → ')}：\n  ${problems.join('\n  ')}`)

  /** And it must be the COMPLETE run, not merely sorted (a gap is N4's job, but cheap to state here). */
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b),
    `① 排序后必须与原序列相同，实测 ${numbers.join(' → ')}`)
})

test('v381 ②: every paragraph states BOTH ends of its own move', () => {
  /**
   * 「净 −72」 只给一端：读者要自己去减。写出两端（`14,324 → 14,252`）才是可读的账。
   */
  const paragraphs = paragraphsInOrder(arch)
  const missing = []
  for (const paragraph of paragraphs) {
    const bothEnds = /[\d,]+\s*(?:→|->)\s*[\d,]+/u.test(paragraph.body) ||
      /从\s*[\d,]+\s*到\s*[\d,]+/u.test(paragraph.body)
    if (!bothEnds) missing.push(`L${paragraph.line} 第 ${paragraph.number} 簇`)
  }
  assert.deepEqual(missing, [],
    `② 这些账目段只写了一端（读者要自己减）：${missing.join(', ')}`)
})

test('v381 ③ (negative): a DESCENDING sequence is refused, and names the first inversion', () => {
  const problems = judgeOrder([4, 3, 2, 1])
  assert.equal(problems.length, 3, `③ 四段倒序应报 3 处逆序，实测 ${problems.length}`)
  assert.ok(problems[0].includes('第 3 簇') && problems[0].includes('第 4 簇'),
    `③ 第一处逆序必须点名两个簇号，实测：${problems[0]}`)
})

test('v381 ④ (negative): a paragraph with only ONE end is refused', () => {
  /** Reproduce the actual historical text: it gave「净 −72」but not the pair. */
  const symptom = '**段一 · 第 2 簇的行数账**：搬 51 行；净 −50。差额 1 行 = import。'
  const bothEnds = /[\d,]+\s*(?:→|->)\s*[\d,]+/u.test(symptom) || /从\s*[\d,]+\s*到\s*[\d,]+/u.test(symptom)
  assert.equal(bothEnds, false, '④ 这段合成文本必须只有一端（否则测不到）')
})
