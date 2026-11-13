/**
 * ── v145: 模块登记表必须是**双向一致**的 ────────────────────────────────────────────────────────
 *
 * 用户 2026-11-13 裁定（门禁 A）：「模块登记表」要成为一张能被机器核对的事实表，
 * 而不是一张会腐坏的散文表。
 *
 * 为什么必须是双向的：
 *   · 只查「表里的文件是否存在」→ 新模块可以悄悄不进表（这正是「屎山」的形状：代码在长，图不动）；
 *   · 只查「磁盘上的文件是否进表」→ 表里可以留着一个已删除模块的行，读者按表找文件找不到。
 * 两个方向都查，才叫登记表。
 *
 * 附带的第三个方向：**依赖列必须指向真实存在的模块** —— 表的这一列是给人看方向用的，
 * 指向一个不存在的文件时，读者不会发现，因为它看起来就像别的行。
 *
 * 表的格式（`ARCHITECTURE.md` 的 `### TD-1a` 一节）：
 *
 *     | 模块 | 职责（一句话） | 导出 | 依赖（本地模块） |
 *     |---|---|---|---|
 *     | `core/watermark.ts` | 水位与 token 估算 | `textOfMessage` 等 22 项 | `utils/serialize.ts` |
 *
 * 依赖列写 `—` 表示没有本地依赖；多依赖用逗号分隔。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARCH = join(ROOT, 'ARCHITECTURE.md')

/** 登记表覆盖的范围。扩到别的目录时，这里加一行，测试会自动要求那里的模块也进表。 */
const COVERED_DIRS = ['src/core']

const ROW = /^\|\s*`((?:src\/)?[a-z0-9-]+\/[a-z0-9-]+\.ts)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/gmu

const readRows = () => {
  const text = readFileSync(ARCH, 'utf8')
  const section = /### TD-1a[^\n]*\n([\s\S]*?)(?=\n### |\n## |$)/u.exec(text)
  assert.ok(section !== null, 'ARCHITECTURE.md must carry the module registry under a "### TD-1a" heading')
  const rows = []
  for (const m of section[1].matchAll(ROW)) {
    rows.push({
      module: m[1].startsWith('src/') ? m[1] : `src/${m[1]}`,
      duty: m[2].trim(),
      exports: m[3].trim(),
      deps: m[4].trim(),
    })
  }
  return rows
}

const modulesOnDisk = () => {
  const out = []
  for (const dir of COVERED_DIRS) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.ts')) out.push(`${dir}/${f}`)
    }
  }
  return out.sort()
}

test('v145: every module on disk is registered, and every registered module exists', () => {
  const rows = readRows()
  const onDisk = modulesOnDisk()
  const registered = new Set(rows.map((r) => r.module))

  const missing = onDisk.filter((m) => !registered.has(m))
  assert.deepEqual(missing, [],
    `${missing.length} module(s) under ${COVERED_DIRS.join(', ')} are NOT in the registry:\n  ${missing.join('\n  ')}\n` +
    'Add a row for each: | `dir/file.ts` | one-sentence duty | exports | local deps |')

  const stale = [...registered].filter((m) => !existsSync(join(ROOT, m)))
  assert.deepEqual(stale, [],
    `the registry names ${stale.length} file(s) that do not exist:\n  ${stale.join('\n  ')}`)

  const duplicated = [...registered].filter((m) => rows.filter((r) => r.module === m).length > 1)
  assert.deepEqual(duplicated, [], `duplicated registry row(s): ${duplicated.join(', ')}`)
})

test('v145: every registered row is filled in, and its dependency column points at real modules', () => {
  const rows = readRows()
  assert.ok(rows.length > 0, 'the registry must have rows')

  for (const row of rows) {
    assert.ok(row.duty.length > 0, `${row.module}: the duty cell is empty`)
    assert.ok(row.duty.length <= 80, `${row.module}: the duty must be ONE sentence (<= 80 chars), got ${row.duty.length}`)
    assert.ok(row.exports.length > 0, `${row.module}: the exports cell is empty`)

    if (row.deps === '—' || row.deps === '-') continue
    const deps = row.deps.split(',').map((d) => d.trim().replace(/^`|`$/gu, '')).filter((d) => d.length > 0)
    for (const dep of deps) {
      // 表里按仓库内习惯写相对路径（`core/x.ts` / `utils/x.ts`）；测试自己补 `src/` 前缀。
      const abs = join(ROOT, dep.startsWith('src/') ? dep : join('src', dep))
      assert.ok(existsSync(abs),
        `${row.module}: dependency column names "${dep}", which does not exist — a row pointing at a missing file reads like every other row`)
    }
  }
})

test('v145: dependency direction stays acyclic when read from the registry alone', () => {
  // 表里的依赖列必须能独立支撑「无环」这个说法 —— 否则它只是装饰。
  const rows = readRows()
  const edges = new Map()
  for (const row of rows) {
    const deps = row.deps === '—' || row.deps === '-'
      ? []
      : row.deps.split(',').map((d) => d.trim().replace(/^`|`$/gu, '')).filter((d) => d.length > 0)
    edges.set(row.module, deps.filter((d) => d.startsWith('src/')))
  }

  const state = new Map()
  const cycle = []
  const visit = (node, path) => {
    if (state.get(node) === 'done') return
    if (state.get(node) === 'open') { cycle.push([...path, node].join(' -> ')); return }
    state.set(node, 'open')
    for (const next of edges.get(node) ?? []) visit(next, [...path, node])
    state.set(node, 'done')
  }
  for (const node of edges.keys()) visit(node, [])

  assert.deepEqual(cycle, [], `the registry's dependency column contains a cycle:\n  ${cycle.join('\n  ')}`)
})
