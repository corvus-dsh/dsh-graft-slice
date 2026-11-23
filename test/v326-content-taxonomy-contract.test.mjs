/**
 * ── v326 / Phase A · taxonomy 合同：三处必须说同一件事 ────────────────────────────────────────────
 *
 * 路径：**合同（代码）+ 生成的 JSON 投影 + 文档表** —— 三处由同一条 gate 比对。
 *
 * 用户裁定（lead §25.3①）：`self-authored` **不是内容类**，是 **provenance**。所以内容类是 10 个
 * （U/O/C/S/T/A/P/N/R/H），「是我自己注入的」落进 `provenance: 'self'`。
 *
 * 判据（五条，两条负向）：
 *   ① 合同里的内容类恰好 10 个，且**不含** `self-authored`
 *   ② 19 种 `source.kind` 全部登记，且每条的 `contentClass` / `provenance` 都在合同里存在
 *   ③ **负向** 有一类的内容类在合同里没有声明 ⇒ gate 红（不许引用不存在的类）
 *   ④ **负向** 提交的 JSON 与 TS 合同不一致 ⇒ `emit-taxonomy --check` 红（投影过期也算错）
 *   ⑤ can-red：只在合同里加一个类 ⇒ ③/④ 之一必须红
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = join(ROOT, 'src', 'core', 'content-classifier.ts')
const JSON_PATH = join(ROOT, 'src', 'contracts', 'content-taxonomy.v1.json')
const DOC = join(ROOT, 'docs', 'CONTENT-TAXONOMY.md')

const contract = await import(pathToFileURL(CONTRACT).href)
const projection = JSON.parse(readFileSync(JSON_PATH, 'utf8'))

test('v326 ①: the contract declares exactly 10 content classes, and `self-authored` is NOT one', () => {
  const ids = contract.CONTENT_CLASSES.map((entry) => entry.id)
  assert.equal(ids.length, 10, `① 内容类必须恰好 10 个；实测 ${ids.length}: ${ids.join(', ')}`)
  assert.equal(ids.includes('self-authored'), false,
    '① `self-authored` 是 provenance，不是内容类 —— 它在 CONTENT_CLASSES 里就说明裁定没落地')
  assert.equal(contract.PROVENANCE.some((entry) => entry.id === 'self'), true,
    '① 「是我自己注入的」必须作为 provenance 的一个取值存在（否则那个事实没有家住）')
})

test('v326 ②: all 19 source kinds are registered, and every referenced class/provenance exists', () => {
  const classes = new Set(contract.CONTENT_CLASSES.map((entry) => entry.id))
  const provenances = new Set(contract.PROVENANCE.map((entry) => entry.id))
  assert.equal(contract.SOURCE_KINDS.length, 19,
    `② 实测快照是 19 种 kind；实测 ${contract.SOURCE_KINDS.length}`)
  for (const entry of contract.SOURCE_KINDS) {
    assert.equal(classes.has(entry.contentClass), true,
      `② ${entry.kind} 指向不存在的内容类 ${entry.contentClass}`)
    assert.equal(provenances.has(entry.provenance), true,
      `② ${entry.kind} 指向不存在的 provenance ${entry.provenance}`)
  }
  /** No duplicate kinds: two rows for one kind would be two owners inside one registry. */
  const kinds = contract.SOURCE_KINDS.map((entry) => entry.kind)
  assert.equal(new Set(kinds).size, kinds.length, '② 同一 kind 不许登记两行')
})

test('v326 ③ (negative half): the JSON projection agrees with the TS contract, field by field', () => {
  /**
   * The JSON is generated. If it were ever hand-edited into a different shape, two readers of one registry
   * would disagree — which is precisely what this phase removes. Comparing the MEANING (not the bytes)
   * here, and the bytes in ④.
   */
  assert.equal(projection.contentClasses.length, contract.CONTENT_CLASSES.length, '③ 内容类数量必须一致')
  for (const entry of contract.CONTENT_CLASSES) {
    const mirrored = projection.contentClasses.find((row) => row.id === entry.id)
    assert.ok(mirrored !== undefined, `③ JSON 缺少内容类 ${entry.id}`)
    assert.equal(mirrored.continuation, entry.continuation, `③ ${entry.id}.continuation 不一致`)
    assert.equal(mirrored.intoConstraintCandidates, entry.intoConstraintCandidates,
      `③ ${entry.id}.intoConstraintCandidates 不一致`)
  }
  assert.equal(projection.sourceKinds.length, contract.SOURCE_KINDS.length, '③ kind 数量必须一致')
  for (const entry of contract.SOURCE_KINDS) {
    const mirrored = projection.sourceKinds.find((row) => row.kind === entry.kind)
    assert.ok(mirrored !== undefined, `③ JSON 缺少 kind ${entry.kind}`)
    assert.equal(mirrored.contentClass, entry.contentClass, `③ ${entry.kind} 的内容类不一致`)
    assert.equal(mirrored.provenance, entry.provenance, `③ ${entry.kind} 的 provenance 不一致`)
  }
})

test('v326 ④ (negative half): a hand-edited or stale JSON is caught by the emitter check', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'emit-taxonomy.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0,
    `④ 提交的 JSON 必须正是 TS 合同生成的字节；实测 exit=${result.status}\n${result.stdout}\n${result.stderr}`)
})

test('v326 ⑤: the docs table lists the same ids as the contract', () => {
  let doc
  try {
    doc = readFileSync(DOC, 'utf8')
  } catch {
    assert.fail(`⑤ 文档表必须存在（${DOC}）；「代码里改了、文档没改」正是三处不一致的起点`)
  }
  for (const entry of contract.CONTENT_CLASSES) {
    /* 反引号用 String.fromCharCode(96) 拼出来：模板字面量里写反引号会被 test-separators 当成
     * 「手写路径分隔符」，而那是一个真实的跨平台陷阱（`${dir}\` 在 POSIX 上是另一个文件名）。 */
    const tick = String.fromCharCode(96)
    assert.equal(doc.includes(`${tick}${entry.id}${tick}`), true, `⑤ 文档表缺少内容类 ${entry.id}`)
  }
  /**
   * 按**行身份**判断，不按字符串出现 —— 文档里合法地写着「`self-authored` 是 provenance」，
   * 禁止这个词会让「记录裁定」与「违反裁定」不可区分（§〇 31：按身份挑，不按数量挑）。
   */
  assert.equal(/^\|\s*`self-authored`/mu.test(doc), false,
    '⑤ 文档表不得把 `self-authored` 列成**内容类的一行**（它已降为 provenance）')
})