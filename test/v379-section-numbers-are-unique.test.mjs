/**
 * ── v379：一份文档不许把同一节编号两次（R2 / S15）────────────────────────────────────────────────
 *
 * 病（实测 2026-11-26）：`B4-B-派工单.md` 有**两个 `## 六十四、`** —— `:5736` 一份验收、`:5862` 一份
 * 执行记录，`64.1`–`64.7` 各重复一遍。而 `check-doc-copies` 一直报绿 —— **它是对的，也是不够的**：
 * 「两份副本一样吗」与「这份文档有没有自己说两遍」是两个问题。**两份一致的文档可以一起错。**
 *
 * ── 为什么现成的 `^##\s+([^\s]+)` 发现不了它 ──────────────────────────────────────────────────
 *
 * 实测：那个正则会得到 `六十四、S13` 与 `六十四、S14` —— **两个不同的 token**，于是重复隐形。
 * 编号要按**前缀数字**取（到第一个 `、`/`.`/空格为止），因为编号后面的标题本来就该不同。
 *
 * ── 判据五条 ──────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 门禁接进 `npm run check`（没人跑的门禁是注释）
 *   ② `--self-test` 证明它能红：两个「六十四、不同标题」必须被找到、重复子节必须被找到、干净文档必须静默
 *   ③ 真实的派工单：节编号唯一且单调
 *   ④ **负向**：缺文件 ⇒ `exit 2` + `VACUOUS`（不是 exit 0）
 *   ⑤ **负向**：`b` 后缀是**续节**不是重复（`22.3` 与 `22.3b` 必须被当成两条）
 *
 * ⑤ 尤其重要：第一版判据把 `### 22.3b` 读成 `### 22.3`，于是报了 2 处**不存在的**重复。
 * **一条分不清「续节」与「重复」的判据，会被第一个用后缀的人关掉 —— 然后它连真的重复也不再找了。**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = join(ROOT, 'scripts', 'check-section-numbers.mjs')
const ORDER = resolve(ROOT, '..', 'B4-B-派工单.md')

const runGate = (args) => {
  try {
    const out = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('v379 ①: the gate is wired into `npm run check`', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(String(pkg.scripts.check).includes('check-section-numbers.mjs'),
    '① check-section-numbers 必须在 check 的步骤链里')
})

test('v379 ②: the self-test proves it can say NO', () => {
  const result = runGate(['--self-test'])
  assert.equal(result.code, 0, `② self-test 必须通过，实测：${result.out}`)
  assert.ok(/PASS/u.test(result.out), `② 必须自报 PASS，实测：${result.out}`)
  assert.ok(/duplicate sections found: 1/u.test(result.out),
    `② 必须真的找到那一个重复节（两个「六十四」不同标题），实测：${result.out}`)
})

test('v379 ③: the real dispatch order has unique, monotonic section numbers', () => {
  assert.ok(existsSync(ORDER), `③ 派工单必须存在：${ORDER}`)
  const result = runGate([ORDER])
  assert.equal(result.code, 0, `③ 派工单的编号必须唯一且单调，实测：${result.out}`)
  assert.ok(/all unique and monotonic/u.test(result.out),
    `③ 输出必须明确说「唯一且单调」，实测：${result.out}`)
})

test('v379 ④ (negative): a MISSING file is exit 2 + VACUOUS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v379-missing-'))
  try {
    const absent = join(dir, 'no-such-doc.md')
    const result = runGate([absent])
    assert.equal(result.code, 2, `④ 缺文件必须 exit 2，实测 exit=${result.code}\n${result.out}`)
    assert.ok(/VACUOUS/u.test(result.out), `④ 必须自报 VACUOUS，实测：${result.out}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v379 ⑤ (negative): a `b` suffix is a CONTINUATION, not a duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v379-suffix-'))
  try {
    const path = join(dir, 'doc.md')
    writeFileSync(path, [
      '## 一、A',
      '### 1.1 first',
      '### 1.1b the same item continued',
      '',
      '## 二、B',
      '### 2.1 x',
      '',
    ].join('\n'), 'utf8')
    const result = runGate([path])
    assert.equal(result.code, 0,
      `⑤ 「1.1」与「1.1b」是续节，不是重复 —— 判据必须接受它，实测 exit=${result.code}\n${result.out}`)

    /** But TWO identical `1.1b` must still be caught: the suffix is a distinguishing KEY, not a bypass. */
    writeFileSync(path, [
      '## 一、A',
      '### 1.1b first',
      '### 1.1b again',
      '',
    ].join('\n'), 'utf8')
    const duplicate = runGate([path])
    assert.equal(duplicate.code, 1,
      `⑤ 两个相同的「1.1b」必须仍然被抓到，实测 exit=${duplicate.code}\n${duplicate.out}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
