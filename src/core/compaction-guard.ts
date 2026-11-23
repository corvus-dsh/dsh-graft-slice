/**
 * ── v0.37: THE COMPACTION CEILING —— 切片必须先于宿主压缩 ─────────────────────────────────────
 *
 * 实测（2026-11-16，DSH 0.2.2-rc.1）：宿主 `@deepseek-ai/dsh-compaction-basic` 默认
 * `auto: true`，在每个 `agent/pre-step` 用
 *
 *     threshold = floor(min(W × thresholdRatio, W − O − headroomTokens))
 *
 * 判定是否压缩。对本 profile（W=1,048,576、O=256,000、headroom=65,536）它等于
 * **69.34%**；而 graft 的旧水位是 warn 70% / hard 75% —— 压缩在 graft 连预警都还没发
 * 之前就压完了。用户说的「设计里不触发压缩，到水位切片」从来没有被实现过：
 * 唯一写到它的地方是一句注释（`index.ts` 的 "runs with auto: false"），而那是假陈述。
 *
 * 所以「切片永远先于压缩」不能靠配置自觉（用户可能永远不改 profile；新 profile 默认
 * 又是 auto:true）。它必须变成**几何事实**：先算出宿主的有效压缩阈值，再把 graft 的
 * hardAt/warnAt 压到它下面。
 *
 * 三条纪律：
 *   1. 能算出阈值时必须算：W 来自 `tokenMeter` 的 contextWindow；O 来自 session
 *      request header（或 adapter 的 defaultMaxTokens）；thresholdRatio / headroomTokens
 *      **从 loader 里 compaction-basic 那一行的 config 读**，不硬编码用户可改的值。
 *   2. 算不出来时必须**报 RESOURCE 并落到保守值 0.55**，不许拿 0.75 假装没事。
 *   3. 保守值 0.55 的适用边界是显式的：`1 − O/W − 0.0625 ≥ 0.55 ⇔ O ≤ 0.3875W`。
 *      超过这个 O，0.55 也不够 —— 那种情况只能靠配置层关掉 auto（见 docs/compaction-ceiling.md）。
 *
 * 本模块零 import：它被 `test/v221-compaction-ceiling.test.mjs` 直接以 `.ts` 加载
 * （Node 不走 `.js`→`.ts` 重写），与 `content-classifier` 同一种加载约束。
 */

/** `dsh-compaction-basic` 自己的默认值；只在 loader 里读不到那一行 config 时使用。 */
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8
export const DEFAULT_COMPACTION_HEADROOM_TOKENS = 65_536
/** 切片必须早于压缩：hardAt 比压缩阈值低 0.02，warnAt 再比 hardAt 低 0.03。 */
export const COMPACTION_HARD_MARGIN = 0.02
export const COMPACTION_WARN_MARGIN = 0.03
/** O 不可读时的保守 hardAt：只要 O ≤ 0.3875W，它仍然先于压缩。 */
export const COMPACTION_CONSERVATIVE_HARD_AT = 0.55

export const COMPACTION_BASIC = '@deepseek-ai/dsh-compaction-basic'
const AGENT_PRESET = '@deepseek-ai/dsh-agent-preset'

/** 一个实际挂载的 compaction-basic 后端（host 行或某个 agent preset 里的行）。 */
export interface CompactionMount {
  /** `'host'` 或 `preset:<id>`；用于报警与 debug_status。 */
  where: string
  auto: boolean
  thresholdRatio: number
  headroomTokens: number
}

/** 压缩上限的裁决结果；`graft_debug_status.compaction` 原样返回它。 */
export interface CompactionCeiling {
  present: boolean
  auto: boolean
  /** 宿主有效压缩阈值比；`conservative` 时缺席（因为算不出来）。 */
  thresholdRatio?: number
  source: 'computed' | 'conservative' | 'off'
  effectiveHardAt: number
  effectiveWarnAt: number
  reason: string
}

/** 最小 logger 面；与 cordis 的 logger 结构兼容。 */
export interface LoggerLike {
  error?: (message: string) => void
  warn?: (message: string) => void
}

const isRecordLike = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const configOf = (row: any): Record<string, any> => (isRecordLike(row?.config) ? row.config : {})

const ratioOf = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback

const headroomOf = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const roundTo4 = (value: number): number => Number(value.toFixed(4))

function addMount(out: CompactionMount[], where: string, row: any): void {
  if (!isRecordLike(row)) return
  if (row.disabled === true) return
  const config = configOf(row)
  out.push({
    where,
    auto: config.auto !== false,
    thresholdRatio: ratioOf(config.thresholdRatio, DEFAULT_COMPACTION_THRESHOLD_RATIO),
    headroomTokens: headroomOf(config.headroomTokens, DEFAULT_COMPACTION_HEADROOM_TOKENS),
  })
}

/** Walk one preset's declarative plugin list; groups own children instead of a plugin. */
function addPresetRows(out: CompactionMount[], rows: unknown, where: string): void {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (!isRecordLike(row)) continue
    if (row.group === true) {
      addPresetRows(out, row.config, where)
      continue
    }
    if (row.name === COMPACTION_BASIC) addMount(out, where, row)
  }
}

/**
 * 扫 loader 的声明插件树，返回所有 compaction-basic 挂载点。
 *
 * 两个位置都要看：host 行（TUI / headless 的 base bundle）与每个 `@deepseek-ai/dsh-agent-preset`
 * 行里的 `config.plugins`（Web/Desktop 的 agent plane）。`disabled: true` 的行跳过 —— Web 正是
 * 用 disabled 把 host 行关掉、再让每个 preset 各挂一份。
 *
 * 读不到 loader 时返回空数组。空数组的语义是「没发现后端」，不是「确认没有后端」；
 * 调用方因此保持原水位。这一点写在 `applyCompactionCeiling` 的 off 分支里。
 */
export function readCompactionMounts(ctxLike: any): CompactionMount[] {
  const out: CompactionMount[] = []
  try {
    /**
     * `stableCtx` is `{ ...ctx, get(...) }` — spreading a cordis context does NOT copy
     * service properties such as `loader`. So the loader must be resolved the same way
     * every other late-bound service is: property first, then `ctx.get('loader')`.
     */
    const direct = ctxLike?.loader
    const loader = direct !== undefined
      ? direct
      : typeof ctxLike?.get === 'function'
        ? ctxLike.get('loader')
        : undefined
    if (loader === undefined || typeof loader.entries !== 'function') return out
    for (const entry of loader.entries()) {
      const name = entry?.options?.name
      const disabled = entry?.disabled === true || entry?.options?.disabled === true
      if (name === COMPACTION_BASIC) {
        if (!disabled) addMount(out, 'host', entry)
        continue
      }
      if (name === AGENT_PRESET) {
        const presetId =
          typeof entry?.options?.config?.id === 'string' ? entry.options.config.id : entry?.id ?? 'preset'
        addPresetRows(out, entry?.options?.config?.plugins, `preset:${presetId}`)
      }
    }
  } catch {
    // A loader that cannot be read is "unknown", not "absent".
  }
  return out
}

/**
 * 激活时的报警：auto 开着就用 `error`（不是 `warn`）点名，并给出关闭方法。
 * 返回是否真的报了（测试用它证红/证静默）。
 */
export function alertCompactionMounts(mounts: readonly CompactionMount[], logger: LoggerLike | undefined): boolean {
  const auto = mounts.filter((mount) => mount.auto)
  if (auto.length === 0) return false
  const where = auto
    .map((mount) => `${mount.where} (thresholdRatio ${mount.thresholdRatio}, headroom ${mount.headroomTokens})`)
    .join('; ')
  logger?.error?.(
    `[dsh-graft-slice] AUTO-COMPACTION IS ON: ${where}. ` +
      'graft 会把每个会话的切片 hardAt 自动压到宿主压缩阈值之下，保证切片先于压缩；' +
      '若要彻底关闭压缩，在 profile patch 的 preset config 里给 compaction-basic 加 auto:false（需重启）。' +
      ' 当前会话的有效阈值见 graft_debug_status.compaction。',
  )
  return true
}

/**
 * 算宿主压缩阈值，并把 graft 的水位压到它之下。
 *
 * - `source: 'computed'`：W 与 O 都可读 ⇒ `hardAt = min(用户 hardAt, 阈值 − 0.02)`。
 * - `source: 'conservative'`：W 或 O 不可读 ⇒ `hardAt = min(用户 hardAt, 0.55)`，reason 里明说
 *   「这是 RESOURCE condition，不是通过」。
 * - `source: 'off'`：没有 auto 打开的 compaction 后端 ⇒ 水位原样返回。
 *
 * @param thresholds 基线水位（用户配置 + 动态推导之后的那一对）。
 * @param mounts `readCompactionMounts` 的结果。
 * @param contextWindow W；0/NaN 视为不可读。
 * @param reservedOutputTokens O；undefined 视为不可读。
 */
export function applyCompactionCeiling(
  thresholds: { warnAt: number; hardAt: number },
  mounts: readonly CompactionMount[],
  contextWindow: number,
  reservedOutputTokens: number | undefined,
): { warnAt: number; hardAt: number; compaction: CompactionCeiling } {
  const autoMounts = mounts.filter((mount) => mount.auto)
  if (autoMounts.length === 0) {
    return {
      warnAt: thresholds.warnAt,
      hardAt: thresholds.hardAt,
      compaction: {
        present: mounts.length > 0,
        auto: false,
        source: 'off',
        effectiveHardAt: thresholds.hardAt,
        effectiveWarnAt: thresholds.warnAt,
        reason:
          mounts.length === 0
            ? 'no compaction backend mounted'
            : 'every mounted compaction backend has auto:false',
      },
    }
  }

  const windowLimit = Number(contextWindow)
  /**
   * `reservedOutputTokens` is now an UNUSED parameter, kept deliberately rather than deleted.
   *
   * 17.4-C removed `O` from both the arithmetic (7502ba8) and the computability guard (this change). It
   * stays in the signature because every caller passes it and the protocol still carries the fact — but
   * nothing here reads it, and saying so is better than leaving a reader to wonder why a parameter is
   * accepted and ignored.
   *
   * It is NOT re-exported to the ceiling object either: `CompactionCeiling` never published it, so the
   * panel never displayed it, so there is no reader to break.
   */
  /* N5: `reservedOutputTokens` is READ again (see the host-formula block below). The former
   * `void reservedOutputTokens` marked an input that was accepted and ignored — the exact
   * 「producer emits, delivery drops」 shape this batch removes. */
  /**
   * ── 17.4-C (P0, lead-measured): `O` NO LONGER DECIDES WHETHER THE CEILING IS COMPUTABLE ──────────
   *
   * MEASURED BY THE LEAD, and it is the residue of my own `7502ba8`:
   *
   *     A. W=1M, O=64000 readable   computed      hardAt=0.75  warnAt=0.70   ← equals the setting
   *     B. W=1M, O UNREADABLE       conservative  hardAt=0.55  warnAt=0.52   ← the screenshotted screen
   *     C. W=1M, O=0 readable       computed      hardAt=0.75  warnAt=0.70
   *
   * I removed `O` from the ARITHMETIC (`1 − O/W − headroom/W`) but left it in the GUARD. So `O` became a
   * pure dead input whose only remaining effect was to knock the whole derivation down to the
   * conservative constant whenever it could not be read — the 55.00% / 52.00% that reappeared after the
   * restart, digit for digit.
   *
   * WHY REMOVING IT IS SAFE, stated as the reasoning rather than as a preference: the ceiling exists to
   * answer 「when does the compaction TOOL act」, and that answer is `mount.thresholdRatio`. `O` is the
   * budget for the next completion; it says nothing about when compaction fires. A session whose output
   * budget cannot be read is still perfectly able to know its compaction threshold.
   *
   * WHAT FAILS CLOSED INSTEAD: `W`. Without a window there is no ratio to compare anything against, so
   * `W` unreadable still lands on `conservative` — and `v221 ⑤` keeps pinning exactly that. The two
   * unreadable inputs must not collapse into one verdict.
   */
  const computable = Number.isFinite(windowLimit) && windowLimit > 0

  let thresholdRatio: number | undefined
  /** N5: `O` unreadable is its own cause and must be named, not folded into `W` unreadable. */
  let oUnreadable = false
  if (computable) {
    /**
     * ── USER-RULED (P0): THE CEILING IS THE COMPACTION THRESHOLD, NOT 「WINDOW MINUS OUTPUT」 ───────
     *
     * WHAT IT USED TO BE:
     *
     *     thresholdRatio = min(
     *       mount.thresholdRatio,                                   // the tool's own line
     *       1 − O/W − headroom/W,                                    // ← THE DEFECT
     *     )
     *     hardAt = thresholdRatio − 0.02
     *
     * where `O` is the session's `maxTokens` (its OUTPUT reservation). The intent was 「the slice must
     * happen before the window physically runs out」, which is right. The arithmetic was not: `O` is a
     * budget for the NEXT completion, not space already consumed, so subtracting it from the CEILING
     * charged every session for an output it had not written yet.
     *
     * Measured consequence on a real panel: a session with W=200k and O=64k produced
     * `1 − 0.32 − 0.04 = 0.64`, then `hardAt = 0.64 − 0.02 = 0.62` — and with `deriveWarnAt`'s margin the
     * warning line landed at 0.52. Rows read 「提示线 52% · 强制线 55%」 while the user's setting said
     * 70% / 75%, and a session was cut at 55% having never been warned. The user reported exactly this
     * as 「模型未到 70% 水位没有预警就被强切」.
     *
     * WHAT IT IS NOW: the compaction TOOL's own threshold is the ceiling, and nothing else is. The
     * slice still wins the race (that is the whole point of this module) — it wins it against the line
     * the tool will actually compact at, which is the only line that matters. `O` and `headroom` no
     * longer move graft's threshold; they remain part of the tool's own reported threshold.
     *
     * STATED CONSEQUENCE, deliberately accepted by the user: if the compaction tool's threshold is BELOW
     * the configured 0.70, that tool wins and the slice moves earlier. The alternative — ignoring it —
     * is the silently-compacted handoff v0.37 was written to prevent.
     */
    /**
     * ── N5 (P0, lead §二十八): THE HOST'S FORMULA HAS THREE INPUTS AND WE USED ONE ────────────────
     *
     * This module's own header (`:7`) states the host formula verbatim:
     *
     *     threshold = floor(min(W × thresholdRatio, W − O − headroomTokens))
     *
     * The line below used to take only the FIRST arm of that `min`, because 17.4-C `void`-ed `O` and
     * `headroomTokens` was collected only to be printed in an alert sentence. So the ceiling answered
     * 「what did the config say」 and not 「when does the host actually refuse more input」.
     *
     * MEASURED on the user's profile: W=1048576, O=256000, B=65536 ⇒ `(1048576−256000−65536)/1048576 =
     * 0.69336`. The host compacts at **69.34%**, while graft warned at **70.00%** — it was 0.66 points
     * BEHIND, always, so the warning could never arrive before compaction. 1M window ⇒ 6,963 tokens.
     *
     * WHY 17.4-C's REASONING WAS RIGHT AND ITS CONCLUSION WRONG: `O` is the next completion's budget, so
     * subtracting it from 「how much room is left」 would be charging for unwritten output. But the
     * ceiling has never answered 「how much room is left」 — it answers 「when does the host declare the
     * window full」, and the host's own formula subtracts both `O` and `B`. Removing them here did not
     * remove them there; it only made our line 10.66 points later than the host's.
     *
     * `B` comes from the mount row (already parsed); `O` comes from the caller (`readReservedOutputTokens`).
     * BOTH were already in hand — this is the 「producer emits, delivery drops」 shape again.
     */
    const hostArm = (() => {
      const mountRatio = Math.min(...autoMounts.map((mount) => mount.thresholdRatio))
      const headroom = Math.max(0, ...autoMounts.map((mount) => mount.headroomTokens))
      /** `O` unreadable must NOT be treated as 0 — that silently restores the 0.8 we just left. */
      if (reservedOutputTokens === undefined || !Number.isFinite(reservedOutputTokens) || reservedOutputTokens < 0) {
        return { arm: mountRatio, oUnreadable: true as const }
      }
      const byWindow = 1 - (reservedOutputTokens + headroom) / windowLimit
      return { arm: Math.min(mountRatio, byWindow), oUnreadable: false as const, byWindow, mountRatio, headroom }
    })()

    if (hostArm.oUnreadable) {
      /**
       * FALL TO `conservative` RATHER THAN PRETENDING: module rule `:22` says 「算不出来时必须报 RESOURCE
       * 并落 0.55，不许拿 0.75 假装没事」. Treating an unreadable `O` as 0 is exactly that pretense, and
       * it is what 17.4-C was trying to fix from the wrong end.
       */
      thresholdRatio = undefined
      oUnreadable = true
    } else {
      thresholdRatio = hostArm.arm
      thresholdRatio = Math.max(0.01, Math.min(0.99, thresholdRatio))
    }
  }

  const conservative = thresholdRatio === undefined
  const hardTarget = conservative ? COMPACTION_CONSERVATIVE_HARD_AT : (thresholdRatio as number) - COMPACTION_HARD_MARGIN
  const hardAt = roundTo4(Math.max(0.02, Math.min(thresholds.hardAt, hardTarget)))
  const warnAt = roundTo4(Math.max(0.01, Math.min(thresholds.warnAt, hardAt - COMPACTION_WARN_MARGIN)))

  const where = autoMounts.map((mount) => mount.where).join(', ')
  const compaction: CompactionCeiling = {
    present: true,
    auto: true,
    ...(conservative ? {} : { thresholdRatio: roundTo4(thresholdRatio as number) }),
    source: conservative ? 'conservative' : 'computed',
    effectiveHardAt: hardAt,
    effectiveWarnAt: warnAt,
    reason: conservative
      ? /**
         * 17.4-C 判据④: `O=` is GONE from this sentence, because the input it names no longer participates.
         *
         * A reason string that lists an input the derivation does not read is worse than no reason: a
         * reader debugging 「why 0.55」 would go looking at the output reservation, find it irrelevant, and
         * conclude the message is unreliable — while the actual cause (`W` unreadable) is stated two
         * clauses earlier and gets skimmed past.
         */
        `RESOURCE — compaction-basic auto is ON (${where}) but the host threshold is not computable ` +
        `(W=${Number.isFinite(windowLimit) && windowLimit > 0 ? windowLimit : 'unknown'}); ` +
        `${oUnreadable ? 'O (output reservation) unreadable ⇒ treated as UNKNOWN, not as 0; ' : ''}` +
        `conservative hardAt ${COMPACTION_CONSERVATIVE_HARD_AT} used so the slice still wins. ` +
        'This is a RESOURCE condition, not a pass.'
      : `compaction-basic auto is ON (${where}); host threshold ${roundTo4(thresholdRatio as number)}; ` +
        `${hardAtSentence(roundTo4(thresholds.hardAt), hardAt)} so the slice wins.`,
  }
  return { warnAt, hardAt, compaction }
}

/**
 * ── N4a: 「lowered from 0.75 to 0.75」 IS A SENTENCE THAT SAYS NOTHING (lead §二十七) ────────────
 *
 * MEASURED on a live profile: `thresholdReason` read
 *
 *     hardAt lowered from 0.75 to 0.75 so the slice wins
 *
 * The host threshold was 0.8, so `0.8 − 0.02 = 0.78` is ABOVE our 0.75 and **nothing was lowered** —
 * yet the sentence announced an adjustment, in the past tense, with a rationale attached. A reader
 * debugging 「why didn't the cut land at 75%」 reads that line as evidence that something moved.
 *
 * So the verb is now chosen from the arithmetic: only a real decrease may say `lowered`. Same family as
 * `source: 'off'` meaning both 「confirmed none」 and 「could not see」 — the field exists, the fact does not.
 */
export function hardAtSentence(from: number, to: number): string {
  if (to < from) return `hardAt lowered from ${from} to ${to}`
  if (to === from) return `hardAt unchanged at ${to}`
  /** Raising our own cut-off under a compaction ceiling would be a defect, so it says so out loud. */
  return `hardAt RAISED from ${from} to ${to} (unexpected under a ceiling)`
}
