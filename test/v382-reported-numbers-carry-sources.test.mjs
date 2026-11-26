/**
 * ── v382：关键数字必须带来源（N5 / S16，前身是 R3）────────────────────────────────────────────────
 *
 * **连续三轮**，报告里都出现过「不是从文件读出来的数字」：
 *
 *   · `paradise 509 / 509`  —— 实际 508（有一条红的）
 *   · `地板 6,762`           —— 文档写 6,732，而 6,732 是对的
 *   · `第 3/4 簇`            —— `git log --diff-filter=A` 说 3 和 4，报告写 4 和 5
 *
 * 前两次是重跑抓到的，第三次是读 git 抓到的。**共同缺陷不是算术，是那个数字没有写明出处，
 * 于是没有人能低成本地核对它。**
 *
 * ── 为什么只覆盖四类数字 ────────────────────────────────────────────────────────────────────────
 *
 * 要求报告里**每个**数字都带来源，第一段就会红，然后被关掉 —— 本仓已记录过这个失效模式多次。
 * 所以只覆盖真正造成过损失的四类：测试数 / 行数 / 地板与上限 / 簇序号。
 *
 * ── 判据四条 ──────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 门禁接进 `npm run check` 与 `ci.yml`，并在 v129 里分类（存在但没人跑 = 注释）
 *   ② `--self-test` 双向：坏的必须被抓到（≥3），**好的必须零误报**
 *   ③ 在本仓自己的文档上跑：`ARCHITECTURE.md` 必须零未引用的关键数字
 *   ④ **负向**：缺文件 ⇒ `exit 2` + `VACUOUS`（不是 exit 0）
 *
 * ② 的「零误报」那一半是关键：一条会对诚实句子报红的判据，会被第一个维护者关掉，
 * 于是它连真的无出处数字也不再报了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = join(ROOT, 'scripts', 'check-reported-numbers.mjs')
const ARCH = join(ROOT, 'ARCHITECTURE.md')

const runGate = (args) => {
  try {
    const out = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('v382 ①: the gate is wired into `npm run check` AND `ci.yml`', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(String(pkg.scripts.check).includes('check-reported-numbers.mjs'),
    '① 必须在 npm run check 的步骤链里')

  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.ok(ci.includes('check-reported-numbers.mjs'),
    '① 必须在 ci.yml 里 —— 存在但 CI 从不跑的门禁是注释（v129 抓到过两次）')

  const v129 = readFileSync(join(ROOT, 'test', 'v129-gate-coverage.test.mjs'), 'utf8')
  assert.ok(v129.includes("['check-reported-numbers.mjs', 'GATE']"),
    '① 必须在 v129 的 KINDS 表里分类 —— 未分类的脚本是一条没人做过的决定')
})

test('v382 ②: the self-test is TWO-SIDED — it catches uncited AND leaves cited lines alone', () => {
  const result = runGate(['--self-test'])
  assert.equal(result.code, 0, `② self-test 必须通过，实测：${result.out}`)
  assert.ok(/uncited in the bad sample: [3-9]/u.test(result.out),
    `② 坏样本必须抓到 ≥3 处，实测：${result.out}`)
  assert.ok(/uncited in the good sample: 0/u.test(result.out),
    `② 好样本必须**零误报** —— 会对诚实句子报红的判据会被关掉，实测：${result.out}`)
})

test('v382 ③: this repo\'s own ARCHITECTURE.md has no uncited key numbers', () => {
  assert.ok(existsSync(ARCH), `③ 文件必须存在：${ARCH}`)
  const result = runGate([ARCH])
  assert.equal(result.code, 0,
    `③ ARCHITECTURE.md 的关键数字必须都有出处，实测：\n${result.out.slice(0, 1200)}`)
})

test('v382 ④ (negative): a MISSING file is exit 2 + VACUOUS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v382-missing-'))
  try {
    const result = runGate([join(dir, 'no-such-report.md')])
    assert.equal(result.code, 2, `④ 缺文件必须 exit 2，实测 exit=${result.code}\n${result.out}`)
    assert.ok(/VACUOUS/u.test(result.out), `④ 必须自报 VACUOUS，实测：${result.out}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v382 ⑤ (negative): an uncited test count in a real file is refused, and named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v382-uncited-'))
  try {
    const path = join(dir, 'report.md')
    /** Exactly the shape that was wrong three rounds in a row. */
    writeFileSync(path, [
      '# 验收报告',
      '',
      'paradise 509 / 509 全绿，index.ts 14,067 行，这是第 5 簇。',
      '',
    ].join('\n'), 'utf8')

    const result = runGate([path])
    assert.equal(result.code, 1, `⑤ 无出处的数字必须 exit 1，实测 exit=${result.code}\n${result.out}`)
    assert.ok(/no stated source/u.test(result.out), `⑤ 必须说清是「没有出处」，实测：${result.out}`)
    assert.ok(/L3/u.test(result.out), `⑤ 必须点名行号，实测：${result.out}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
