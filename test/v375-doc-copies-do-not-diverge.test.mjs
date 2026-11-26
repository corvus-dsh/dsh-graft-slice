/**
 * ── v375：两份副本的分叉必须能被门禁看见（S14 / 副本门禁）────────────────────────────────────────
 *
 * 病（实测 2026-11-26）：`B4-B-派工单.md` 与 `报告\B4-B-派工单.md` 是同一份文档的两份副本。
 * 一整节（§六十三）写进了其中一份、没写进另一份 —— 239,060 vs 242,748 字节，
 * 差异恰好从新那一节开始。**上一轮报告过「两份 sha 一致」，那句话在写下时是真的；
 * 下一节只写进一份的那一刻，它就不再真了。**
 *
 * 「我核过一致」是一次核对，不是一个门禁。
 *
 * 判据要证的正是「门禁式」而不是「核对式」：**三种退出码各自可达**，尤其
 * **缺一份 ⇒ exit 2 + `VACUOUS`**。若缺一份也返回 0，那台机器上这门禁从未运行却是绿的 ——
 * 正是 §〇 34「两个不同原因给出相同输出」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = join(ROOT, 'scripts', 'check-doc-copies.mjs')

const runGate = (args = []) => {
  try {
    const out = execFileSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('v375 ①: the gate is wired into `npm run check` (a gate nobody runs is a comment)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(String(pkg.scripts.check).includes('check-doc-copies.mjs'),
    '① check-doc-copies 必须在 npm run check 的步骤链里')
})

test('v375 ②: the two real copies currently agree', () => {
  const result = runGate()
  assert.equal(result.code, 0, `② 两份副本必须一致，实测 exit=${result.code}\n${result.out}`)
  assert.ok(/byte-identical/u.test(result.out),
    `② 输出必须说清「逐字节相同」而不是只给 exit 0，实测：${result.out}`)
})

test('v375 ③: the self-test proves the comparison can say NO', () => {
  /**
   * 判据本体（`firstDifference`）若永远返回 undefined，①② 都会绿而门禁什么也没测。
   * self-test 是它对外的可证伪声明：同文 ⇒ undefined；一处不同 ⇒ 点名那一行；前缀 ⇒ 边界行。
   */
  const result = runGate(['--self-test'])
  assert.equal(result.code, 0, `③ self-test 必须通过，实测：${result.out}`)
  assert.ok(/PASS/u.test(result.out), `③ self-test 必须自报 PASS，实测：${result.out}`)
})

test('v375 ④ (negative): a MISSING copy is exit 2 + VACUOUS — never a green run', () => {
  /**
   * 这一条是整条判据的重点。缺一份时若返回 0，「我这台机器上没有 报告\ 目录」就会成为
   * 一条永远绿的门禁 —— 而它检查的东西一次都没被检查过。
   *
   * 做法：把 GATE 复制进一个临时骨架，只放一份副本（另一份缺失），然后跑它。
   * **这一步不能改真仓库的目录结构**，否则测完要复原，而复原失败会留下假绿。
   */
  const dir = mkdtempSync(join(tmpdir(), 'v375-missing-'))
  try {
    /** Reproduce the gate's expected layout: <workspace>/<repo>/scripts/gate, workspace root has one copy. */
    const workspace = join(dir, 'ws')
    const repo = join(workspace, 'dsh-graft-slice')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(join(workspace, 'B4-B-派工单.md'), 'section one\n', 'utf8')
    /** `报告\` intentionally NOT created ⇒ the b-side copy is missing. */

    execFileSync(process.execPath, ['-e', `
      const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
      const { join } = require('node:path')
      const source = readFileSync(${JSON.stringify(GATE)}, 'utf8')
      mkdirSync(${JSON.stringify(join(repo, 'scripts'))}, { recursive: true })
      writeFileSync(${JSON.stringify(join(repo, 'scripts', 'check-doc-copies.mjs'))}, source)
    `], { cwd: repo })

    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [join(repo, 'scripts', 'check-doc-copies.mjs')], { cwd: repo, encoding: 'utf8' })
    } catch (error) {
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`
      code = error.status ?? 1
    }

    assert.equal(code, 2, `④ 缺一份必须 exit 2，实测 exit=${code}\n${out}`)
    assert.ok(/VACUOUS/u.test(out), `④ 必须自报 VACUOUS（缺一份不是「一致」），实测：${out.slice(0, 300)}`)
    assert.ok(/missing:/u.test(out), `④ 必须点名缺的那个路径，实测：${out.slice(0, 300)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v375 ⑤ (negative): a one-line divergence is exit 1 and names the line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v375-differ-'))
  try {
    const workspace = join(dir, 'ws')
    const repo = join(workspace, 'dsh-graft-slice')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    mkdirSync(join(workspace, '报告'), { recursive: true })
    writeFileSync(join(workspace, 'B4-B-派工单.md'), 'one\ntwo\nthree\n', 'utf8')
    writeFileSync(join(workspace, '报告', 'B4-B-派工单.md'), 'one\nCHANGED\nthree\n', 'utf8')
    writeFileSync(join(repo, 'scripts', 'check-doc-copies.mjs'), readFileSync(GATE, 'utf8'), 'utf8')

    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [join(repo, 'scripts', 'check-doc-copies.mjs')], { cwd: repo, encoding: 'utf8' })
    } catch (error) {
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`
      code = error.status ?? 1
    }

    assert.equal(code, 1, `⑤ 不一致必须 exit 1，实测 exit=${code}\n${out}`)
    assert.ok(/first difference at line 2/u.test(out),
      `⑤ 必须点名第 2 行 —— 只说「文件不同」会让人去手工 diff 431KB，实测：${out.slice(0, 320)}`)
    assert.ok(out.includes('CHANGED'), `⑤ 必须把两侧那一行都打出来，实测：${out.slice(0, 320)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
