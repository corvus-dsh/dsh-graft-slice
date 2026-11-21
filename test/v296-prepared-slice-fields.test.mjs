/**
 * ── v296 (B4-B B1b)：`PreparedSlice` 的每个字段都必须被 `loadPrepared` 重建 ───────────────────────
 *
 * ── 这条门禁为什么存在：同一个缺陷发生了两次 ──────────────────────────────────────────────────
 *
 *   v7.4  · `chunks`   —— review 存了 chunk 正文，loader 重建时没带上 ⇒ commit 拿空的 `before` 比，
 *                         把每一个稳定块都报成「变了」，拒绝一次有效的提交。
 *   B4-B  · `handover` —— 模型批准的内容。prepare 写进了磁盘、写盘路径也收到了参数、**loader 把它丢了**
 *                         ⇒ 目标会话一个字符都没拿到。
 *
 * 两次之间，loader 自己的注释里已经写下了这句警告：
 *
 *     // v7.4: chunks must survive the round-trip. This loader rebuilds the entry
 *     // field by field, so a field missing from this list is silently dropped
 *
 * **而 `handover` 仍然漏了。** 注释不是检查：它必须被「正在加字段的那个人、在他并没有编辑的那个文件里」
 * 读到，才起作用。
 *
 * ── 判据（四条）────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 本仓：interface 的每个字段都在重建块里（spawn 门禁，断言 exit 0）
 *   ② 分母：两边解析出的名字数都必须 ≥5，否则就是解析器坏了而不是代码对了
 *   ③ 检测器能红：把 `handover` 从重建块里删掉 ⇒ 点名 `handover`
 *   ④ **历史案例也抓得到**：把 `chunks` 删掉 ⇒ 点名 `chunks`（这条证明它不只修当前这一处）
 *
 * 第 ④ 条是这条门禁价值的核心：一个只为刚发生的那个 bug 而写的检查，不能证明它覆盖了同类。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'check-prepared-slice-fields.mjs')

test('v296 ①: `PreparedSlice` 的每个字段都被 loadPrepared 重建', () => {
  const result = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `有字段会被 loadPrepared 丢掉：\n${result.stdout}${result.stderr}\n` +
      '接口里有、重建块里没有的字段 = 写进磁盘、回程时扔掉。这个缺陷已发生两次（chunks / handover）。',
  )
  assert.match(result.stdout, /prepared-slice-fields: OK/u)
})

test('v296 ②: 分母 —— 两边解析出的名字数都必须 ≥5', () => {
  const result = spawnSync(process.execPath, [GATE, '--json'], { cwd: ROOT, encoding: 'utf8' })
  const report = JSON.parse(result.stdout)
  assert.ok(report.fields.length >= 5, `只解析出 ${report.fields.length} 个字段，解析器可能坏了`)
  assert.ok(report.keys.length >= 5, `只解析出 ${report.keys.length} 个重建键，解析器可能坏了`)
  assert.deepEqual(report.dropped, [], '出现了会被丢掉的字段')
  /**
   * And the two sets line up: 19 fields, 19 keys. Asserting the count is what makes 「两边都解析对了」
   * a checkable claim rather than an assumption.
   */
  assert.equal(report.keys.length, report.fields.length, '字段数与重建键数应当相等')
})

test('v296 ③ & ④: 删掉 `handover` 与删掉 `chunks` 都必须被点名', () => {
  return import(new URL('../scripts/check-prepared-slice-fields.mjs', import.meta.url).href).then((mod) => {
    /**
     * The parser is driven with SYNTHETIC sources, not by mutating the repository: two can-reds on the
     * real tree were run by hand (measured: both name the field), and repeating that here would leave
     * the working tree dirty on any failure.
     *
     * The synthetic pair reproduces the defect in the smallest form that has it: an interface with a
     * field, and a reconstruction block without it.
     */
    const stateSource = [
      'export interface PreparedSlice {',
      '  preparedId: string',
      '  digest: string',
      '  handover?: { pending?: readonly string[] }',
      '  chunks?: Array<{ kind: string; text: string }>',
      '}',
      '',
    ].join('\n')

    const indexFull = [
      'preparedSlices.set(id, {',
      '  preparedId: id,',
      '  digest: value.digest,',
      '  handover: value.handover,',
      '  chunks: value.chunks,',
      '})',
      '',
    ].join('\n')

    const indexMissingHandover = indexFull.replace('  handover: value.handover,\n', '')
    const indexMissingChunks = indexFull.replace('  chunks: value.chunks,\n', '')

    const fields = mod.interfaceFields(stateSource)
    assert.deepEqual(fields, ['preparedId', 'digest', 'handover', 'chunks'], `字段解析错了：${JSON.stringify(fields)}`)

    assert.deepEqual(mod.droppedFields(fields, mod.reconstructionKeys(indexFull)), [], '完整时不应报任何缺失')

    assert.deepEqual(
      mod.droppedFields(fields, mod.reconstructionKeys(indexMissingHandover)),
      ['handover'],
      '删掉 handover 必须点名 handover',
    )
    assert.deepEqual(
      mod.droppedFields(fields, mod.reconstructionKeys(indexMissingChunks)),
      ['chunks'],
      '删掉 chunks 必须点名 chunks —— 这条证明它不只覆盖刚发生的那个 bug',
    )
  })
})

test('v296 ⑤: 嵌套对象类型的成员不算 PreparedSlice 的字段', () => {
  /**
   * `handover?: { pending?, notes? }` declares ONE field with a nested shape. A parser that counted
   * `pending`/`notes` as fields of `PreparedSlice` would demand them in the reconstruction block and
   * report two phantom failures — a false RED, which is how a gate gets deleted.
   */
  return import(new URL('../scripts/check-prepared-slice-fields.mjs', import.meta.url).href).then((mod) => {
    const source = [
      'export interface PreparedSlice {',
      '  preparedId: string',
      '  handover?: {',
      '    pending?: readonly string[]',
      '    notes?: readonly string[]',
      '  }',
      '  handoverSupplied?: boolean',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(
      mod.interfaceFields(source),
      ['preparedId', 'handover', 'handoverSupplied'],
      '嵌套形状只算一个字段 —— pending/notes 不是 PreparedSlice 的字段',
    )
  })
})