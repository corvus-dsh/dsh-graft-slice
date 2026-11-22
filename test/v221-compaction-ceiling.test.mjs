/**
 * ── v221: 压缩上限 —— 切片必须先于宿主自动压缩 ───────────────────────────────────────────────
 *
 * 缺陷（2026-11-16，DSH 0.2.2-rc.1）：`dsh-compaction-basic` 默认 `auto: true`，其阈值
 *   `floor(min(W × 0.8, W − O − 65536))`
 * 在本 profile（W=1,048,576、O=256,000）等于 **69.34%** —— 低于 graft 的 70% 提示与 75% 切点。
 * 于是压缩在 graft 连预警都没发之前就压完了。修复不是调参，而是把 graft 的水位**几何地**
 * 压到宿主阈值之下（见 `src/core/compaction-guard.ts`）。
 *
 * 本文件把三条纪律钉死（前三条同时就是 can-red）：
 *   ① 假 loader 报 auto:true ⇒ effectiveHardAt 必须 < 压缩阈值，且 `logger.error` 被调用；
 *   ② 假 loader 报 auto:false ⇒ effectiveHardAt 保持用户配置（0.75），无 error；
 *   ③ O 不可读 ⇒ `source: 'conservative'`、hardAt = min(hardAt, 0.55)，且 reason **说出来**
 *      （RESOURCE / not a pass）—— 不许静默降级。
 *
 * 另加：loader 扫描（host/preset/group/disabled）、多后端取最早阈值、用户水位已更低时不抬高。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPACTION_CONSERVATIVE_HARD_AT,
  alertCompactionMounts,
  applyCompactionCeiling,
  readCompactionMounts,
} from '../src/core/compaction-guard.ts'

const W = 1_048_576
const O = 256_000
/**
 * ── USER-RULED 2026-11-22: THE CEILING IS THE TOOL'S THRESHOLD, NOT 「1 − O/W − headroom/W」 ────────
 *
 * This constant used to be `min(0.8, 1 − 256000/1048576 − 65536/1048576) = 0.6934`. The subtraction
 * charged every session for an output budget it had not WRITTEN: `O` is `maxTokens` for the next
 * completion, not space already consumed. On a small window it dominated — measured on a live panel, a
 * 200k session with O=64k produced a hard line of 0.55 and a warning line of 0.52, so sessions were cut
 * at 55% with no warning delivered, while the user's setting said 70% / 75%.
 *
 * The tool's own threshold is now the only ceiling. `O` and `headroom` still matter — to the tool's
 * computation of ITS threshold — but they no longer move graft's.
 */
const HOST_RATIO = 0.8

const loaderOf = (entries) => ({ entries: () => entries })

/** One `@deepseek-ai/dsh-agent-preset` row containing a compaction group with children. */
const presetOf = (id, compactionConfig) => ({
  id: `preset-${id}`,
  options: {
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id,
      order: 1,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona' },
        {
          id: 'compaction',
          name: 'cordis:group',
          group: true,
          isolate: { compaction: true, toolResultPruner: true },
          config: [
            {
              id: 'compaction-basic',
              name: '@deepseek-ai/dsh-compaction-basic',
              ...(compactionConfig === undefined ? {} : { config: compactionConfig }),
            },
            { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          ],
        },
      ],
    },
  },
})

const mountOfPreset = (compactionConfig) => readCompactionMounts({ loader: loaderOf([presetOf('cordis', compactionConfig)]) })

test('v221 ①: loader 扫描 —— host 与 preset 都看、disabled 跳过、config 被读出来', () => {
  const mounts = readCompactionMounts({
    loader: loaderOf([
      // the Web surface disables the host row: it must NOT count
      { id: 'compaction-basic', options: { name: '@deepseek-ai/dsh-compaction-basic' }, disabled: true },
      presetOf('cordis', { thresholdRatio: 0.7, headroomTokens: 1234 }),
    ]),
  })
  assert.deepEqual(mounts, [
    { where: 'preset:cordis', auto: true, thresholdRatio: 0.7, headroomTokens: 1234 },
  ])
  // a mounted (enabled) host row also counts — TUI / headless has no presets
  const host = readCompactionMounts({
    loader: loaderOf([{ id: 'compaction-basic', options: { name: '@deepseek-ai/dsh-compaction-basic' } }]),
  })
  assert.equal(host.length, 1)
  assert.equal(host[0].where, 'host')
  assert.equal(host[0].auto, true)
  assert.equal(host[0].thresholdRatio, 0.8) // the backend's own default
  assert.equal(host[0].headroomTokens, 65536)
  // unreadable loader is "unknown", not "absent": no mounts, caller keeps its watermarks
  assert.deepEqual(readCompactionMounts({}), [])
})

test('v221 ② can-red: auto:true ⇒ 有效 hardAt 必须低于压缩阈值，logger.error 被点名', () => {
  const mounts = mountOfPreset(undefined)
  const errors = []
  const alerted = alertCompactionMounts(mounts, { error: (message) => errors.push(message) })
  assert.equal(alerted, true, 'auto:true 必须报警')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /AUTO-COMPACTION IS ON/u)
  assert.match(errors[0], /preset:cordis/u)

  const out = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, mounts, W, O)
  assert.equal(out.compaction.source, 'computed')
  assert.equal(out.compaction.auto, true)
  assert.equal(out.compaction.thresholdRatio, HOST_RATIO)
  /**
   * With the tool's threshold at 0.8 the ceiling no longer constrains this session: `0.75` (the user's
   * setting) is already below it, so the effective hard line IS the configured one. That is the whole
   * point of the ruling — a big window keeps a real 75% instead of being pulled down by its output
   * reservation. The negative direction is the next assertion.
   */
  assert.equal(out.hardAt, 0.75, '压缩阈值 0.8 时，用户的 0.75 生效 —— 不再被输出预留拉低')
  assert.ok(out.hardAt <= out.compaction.thresholdRatio, '切片仍然严格不晚于压缩')
  assert.ok(out.warnAt < out.hardAt, 'warn 必须早于 hard')
})

test('v221 ②b: the ceiling STILL wins when the tool compacts earlier than the user asked', () => {
  /**
   * The remaining half of the geometric guarantee, and the one that must not be lost: if the tool's own
   * threshold is BELOW the configured hard line, that tool wins and the slice moves earlier. Removing the
   * `1 − O/W` subtraction must not turn this into 「always use the setting」.
   */
  const mounts = [{
    name: 'compaction-basic',
    where: 'host',
    auto: true,
    thresholdRatio: 0.6,
    headroomTokens: 65536,
  }]
  const out = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, mounts, W, O)
  assert.equal(out.compaction.thresholdRatio, 0.6)
  assert.equal(out.hardAt, 0.58, '压缩阈值 0.6 ⇒ hardAt 0.58（阈值 − 0.02），即使设置是 0.75')
  assert.ok(out.hardAt < 0.6, '切片必须早于压缩')
})

test('v221 ③ can-red: auto:false ⇒ 水位保持用户配置，且不报警', () => {
  const mounts = mountOfPreset({ auto: false })
  const errors = []
  const alerted = alertCompactionMounts(mounts, { error: (message) => errors.push(message) })
  assert.equal(alerted, false)
  assert.equal(errors.length, 0)

  const out = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, mounts, W, O)
  assert.equal(out.compaction.source, 'off')
  assert.equal(out.compaction.auto, false)
  assert.equal(out.hardAt, 0.75)
  assert.equal(out.warnAt, 0.7)
  assert.equal(out.compaction.thresholdRatio, undefined)
})

/**
 * ── 17.4-C: THIS CRITERION WAS REWRITTEN, AND IT HAD TO BE ───────────────────────────────────────
 *
 * It used to assert 「O 不可读 ⇒ conservative 0.55，reason 里必须有 `O=unreadable`」. That is precisely the
 * behaviour 17.4-C removes: `O` is the output budget for the NEXT completion, it no longer participates in
 * `1 − O/W − headroom/W` (7502ba8), and leaving it in the GUARD made it a dead input whose only remaining
 * effect was to force the conservative constant whenever it could not be read.
 *
 * The lead's screenshot is the evidence: `W=1M, O unreadable ⇒ hardAt 0.55, warnAt 0.52` — the 「提示线
 * 52% · 强制线 55%」 screen, reappearing after my arithmetic fix because the guard still consulted O.
 *
 * Kept from the old version: the property that a RESOURCE degradation must SAY it is one. A `conservative`
 * verdict that reads like a normal computation is the failure this criterion always guarded against.
 *
 * `v221 ⑤` is untouched and still pins the opposite half: `W` unreadable ⇒ `conservative`. The two
 * unreadable inputs must NOT collapse into one verdict.
 */
test('v221 ④ (rewritten by 17.4-C): O unreadable but W readable ⇒ COMPUTED, not conservative', () => {
  const mounts = mountOfPreset(undefined)
  const out = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, mounts, W, undefined)
  assert.equal(out.compaction.source, 'computed',
    'O 不可读但 W 可读 ⇒ 必须 computed —— O 已不参与任何计算，不该再决定能不能算')
  assert.equal(out.compaction.thresholdRatio, 0.8, 'stays the tool’s own threshold')
  assert.equal(out.hardAt, 0.75, '用户的 0.75 生效（不被 O 拖到 0.55）')
  assert.equal(out.warnAt, 0.7, 'warn 也不再被压到 0.52')
  assert.doesNotMatch(out.compaction.reason, /O=/u,
    'reason 里不得再出现 O= —— 它陈述的输入已不参与')
})

test('v221 ④b: O unreadable must NOT lose the RESOURCE wording when W is ALSO unreadable', () => {
  /**
   * The negative half of ④, and the half that would be lost by a careless 「just delete the O checks」
   * change: when nothing is computable, the ceiling must STILL announce itself as a RESOURCE condition.
   * Without this, ④ could be satisfied by a code path that never says 「degraded」 at all.
   */
  const mounts = mountOfPreset(undefined)
  const out = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, mounts, 0, undefined)
  assert.equal(out.compaction.source, 'conservative')
  assert.equal(out.hardAt, COMPACTION_CONSERVATIVE_HARD_AT)
  assert.match(out.compaction.reason, /RESOURCE/u)
  assert.match(out.compaction.reason, /not a pass/u)
  assert.match(out.compaction.reason, /W=unknown/u)
  assert.doesNotMatch(out.compaction.reason, /O=/u, 'O 无论在哪种结局里都不该被点名')
})

test('v221 ⑤: W 也不可读时同样落到 conservative（不是「W=0 所以安全」）', () => {
  const mounts = mountOfPreset(undefined)
  const out = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, mounts, 0, O)
  assert.equal(out.compaction.source, 'conservative')
  assert.equal(out.hardAt, 0.55)
  assert.match(out.compaction.reason, /W=unknown/u)
})

test('v221 ⑥: 多个后端取最早的那个阈值（config 是 per-mount 的，不硬编码）', () => {
  /**
   * REWRITTEN for the user's ruling: the discriminator is now the mounts' OWN `thresholdRatio`, because
   * `headroomTokens` no longer moves graft's ceiling. The property under test is unchanged — 「the slice
   * respects the EARLIEST compression」 — only the knob that expresses 「earlier」 changed.
   *
   * The old version distinguished the two mounts with `headroomTokens: 200_000`, which only produced a
   * difference through the `1 − O/W − headroom/W` subtraction that was removed.
   */
  const mounts = readCompactionMounts({
    loader: loaderOf([
      presetOf('cordis', undefined), // backend default 0.8
      presetOf('ptc', { thresholdRatio: 0.62 }),
    ]),
  })
  assert.equal(mounts.length, 2)
  const out = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, mounts, W, O)
  assert.equal(out.compaction.source, 'computed')
  assert.equal(out.compaction.thresholdRatio, 0.62, '最早的那个压缩阈值胜出')
  assert.equal(out.hardAt, 0.6, 'hardAt = 0.62 − 0.02，即使设置是 0.75')
  assert.ok(out.hardAt < out.compaction.thresholdRatio, '切片仍然严格早于压缩')
})

test('v221 ⑦: 用户水位已经更低时不抬高；没有后端时原样返回', () => {
  const mounts = mountOfPreset(undefined)
  const low = applyCompactionCeiling({ warnAt: 0.4, hardAt: 0.5 }, mounts, W, O)
  assert.equal(low.hardAt, 0.5, 'min() 不能把用户更低的切点抬高')
  assert.equal(low.warnAt, 0.4)

  const none = applyCompactionCeiling({ warnAt: 0.7, hardAt: 0.75 }, [], W, O)
  assert.equal(none.compaction.source, 'off')
  assert.equal(none.compaction.present, false)
  assert.equal(none.hardAt, 0.75)
})

test('v221 ⑧: stableCtx 形状（无 .loader 属性、只有 get("loader")）也必须读到挂载点', () => {
  /**
   * `stableCtx` is `{ ...ctx, get(...) }`. Spreading a cordis context does NOT copy
   * service properties, so `.loader` is undefined there while `get('loader')` works.
   * Reading only the property silently produced "no backend" — the exact failure this
   * test pins: without this, the ceiling never applies on the hot path.
   */
  const mounts = readCompactionMounts({
    get: (name) => (name === 'loader' ? loaderOf([presetOf('cordis', undefined)]) : undefined),
  })
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].where, 'preset:cordis')
  assert.equal(mounts[0].auto, true)
})
