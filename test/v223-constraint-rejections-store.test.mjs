/**
 * ── v223：否决记录的持久化往返（B1-5 第 5 步）─────────────────────────────────────────────────────
 *
 * `test/v222` 的 ①⑤⑦ 把 records **当参数传进** `filterRejectedConstraints` —— 那让过滤逻辑可以
 * 单独测，但也意味着**没有任何一条断言覆盖「写进文件再读回来」这一段**。写坏了、读坏了、或者写入
 * 时丢了 workspace 字段，v222 全绿。
 *
 * 所以这里补一条独立的往返：reject → 写文件 → 读回 → filter 真的能过滤。断言分步写，
 * 失败消息要能区分「是过滤错了」还是「是读回错了」——否则一条红的测试等于两个未知。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)

const need = (name) => {
  const value = mod[name]
  assert.equal(typeof value, 'function', `${name} 尚未实现`)
  return value
}

test('store: reject → 写 → 读回 → filter 过滤（一条往返；分步断言以便定位是哪一段错了）', () => {
  const path = need('constraintRejectionPath')
  const append = need('appendConstraintRejection')
  const read = need('readConstraintRejections')
  const filter = need('filterRejectedConstraints')

  const dir = mkdtempSync(join(tmpdir(), 'graft-rejections-'))
  try {
    const file = path(dir)
    assert.equal(read(file).length, 0, '缺文件必须是空集合，不是错误（第一次 reject 才创建它）')

    const written = append(file, {
      text: '必须写测试',
      rejectedBy: 'session-1',
      generation: 5,
      // 故意写一个「另一种拼法」的 workspace：读回后仍必须与 d:/x 视为同一个
      workspace: 'D:\\x\\',
      reason: '不适用于本项目',
      at: '2026-11-17T00:00:00.000Z',
    })
    assert.equal(written.length, 1, 'append 必须返回追加后的完整集合')

    const readBack = read(file)
    assert.equal(readBack.length, 1, '读回 0 条 ⇒ 是「读/写」这一段错了，不是过滤')
    assert.equal(readBack[0].text, '必须写测试')
    assert.equal(readBack[0].workspace, 'D:\\x\\', 'workspace 字段不许在往返中丢失（丢了就退化成旧记录）')

    const sameWorkspace = filter([{ text: '必须写测试', index: 1, score: 10 }], { workspace: 'd:/x', records: readBack })
    assert.deepEqual(sameWorkspace.kept, [], '跨拼法必须命中：写进去的是 D:\\x\\，过滤用的是 d:/x')
    assert.deepEqual(sameWorkspace.rejected.map((c) => c.text), ['必须写测试'])

    const otherWorkspace = filter([{ text: '必须写测试', index: 1, score: 10 }], { workspace: 'D:\\y', records: readBack })
    assert.deepEqual(otherWorkspace.kept.map((c) => c.text), ['必须写测试'], '另一个 workspace 不受影响（项目级事实）')

    append(file, { text: '第二条', workspace: 'D:\\x', at: '2026-11-17T00:01:00.000Z' })
    assert.deepEqual(read(file).map((r) => r.text), ['必须写测试', '第二条'], '第二次 append 不许覆盖第一条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
