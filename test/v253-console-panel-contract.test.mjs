/**
 * ── v253 (B4-0b-1 C-6): the graft console's contract, checked without a human clicking ──────────
 *
 * The audit's A-line: `client.js` was never reviewed. This panel is the user's only window into the
 * slicer (handoff state, the knobs, the derivation line), so its failure modes are product defects:
 *
 *   ① AUTO-RUNNABLE — `node --check` plus the features the panel claims;
 *   ② NO FAKE BUTTONS — every `h('button'` below must carry `onClick`. The observer panel had its
 *      button removed for structural reasons (D1–D3); a button that renders but cannot act is the
 *      same lie in the other direction, and it is exactly what this check pins;
 *   ③ READABLE ERROR STATE — the failure line names the reason and says what to do next;
 *   ④ ONE MEASUREMENT PER FACT — the derivation/knobs come from the Host payload, not recomputed from
 *      a second source in the browser.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')

test('v253 ①: client.js 语法可自动检查，且声称的功能都在', () => {
  const checked = spawnSync(process.execPath, ['--check', join(ROOT, 'client.js')], { encoding: 'utf8' })
  assert.equal(checked.status, 0, `node --check 失败：\n${checked.stderr}`)

  for (const feature of ['当前推导', '刷新', '开关', '只读']) {
    assert.ok(client.includes(feature), `面板缺少声称的功能「${feature}」`)
  }
})

test('v253 ②: 每个按钮都必须有 onClick —— 渲染得出来却点不动，是同一种谎', () => {
  /**
   * Measured at the source rather than by clicking: count `h('button'` occurrences and require an
   * `onClick` within the next ~600 characters (a button literal is a small object; 600 characters is
   * generous enough to cover a title/aria block and tight enough that an unrelated handler elsewhere
   * cannot satisfy it).
   */
  const markers = [...client.matchAll(/h\('button'/gu)]
  assert.ok(markers.length >= 3, `面板至少有三个按钮（刷新 / 开关 / 分段选择），实测 ${markers.length}`)
  const orphans = []
  for (const marker of markers) {
    const window = client.slice(marker.index ?? 0, (marker.index ?? 0) + 600)
    if (!/\bonClick\b/u.test(window)) orphans.push(marker.index)
  }
  assert.deepEqual(orphans, [], `这些 h('button' 没有 onClick（点了不会有任何反应）：${orphans.join(', ')}`)
})

test('v253 ③: 失败要说清楚「为什么」与「下一步」', () => {
  assert.ok(client.includes('面板无法调用宿主（'), '错误态必须有统一措辞')
  assert.match(client, /读取失败（原因见下方红卡）/u, '必须把「读失败」与「还没读」分开说')
  assert.match(client, /当前推导：读取中/u, '必须有「正在读」这一态，否则失败与进行中同形')
  assert.match(client, /等这一轮结束|重试|刷新/u, '必须给出下一步')
})

test('v253 ④: 读数来自宿主 payload，不在浏览器里算第二份', () => {
  /**
   * The single-fact rule from the dispatch. The panel talks to the Host through `host.call` /
   * `remote.commands.execute` and renders `JSON.parse(reply.text)`; it must not carry a second
   * derivation of the slicer's state (e.g. re-reading files or re-deriving the watermark).
   */
  assert.ok(
    client.includes("host.call('commands.execute'") || client.includes('host.call("commands.execute"'),
    '第一条通道必须是 host.call（v0.21 的实测结论：remote.commands 在部分宿主上根本不存在）',
  )
  assert.ok(client.includes('JSON.parse(reply.text)'), '读数必须是宿主返回的那份 JSON，不是本地拼出来的')
  /**
   * Only CODE that would produce a second measurement is forbidden; a sentence that names the Host's
   * source (`水位来自宿主 tokenMeter / provider usage`) is the opposite of a second computation — it
   * tells the reader where the number came from.
   */
  for (const forbidden of ['readFileSync', 'task-graph.json', 'pending-transfers.jsonl', 'memory_graph_read']) {
    assert.equal(client.includes(forbidden), false, `面板不许自己读存储/自己算（发现 ${forbidden}）—— 那会与 host 的读数分裂`)
  }
})