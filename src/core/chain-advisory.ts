/**
 * ── N1 · chain 的宽限期只该保护「不被自己再切一次」，不该替宿主沉默（lead §二十九） ──────────────
 *
 * MEASURED（M0）：被压缩的会话 `chain.reGraftBlocked: true`、`graceTurnsRemaining: 2`。
 * `index.ts:12477-12479` 的注释自述「withhold the nudge and the forced cut for a protected target」——
 * 于是宽限期内 graft **一句话都不说**，而宿主不知道宽限期，照常压缩。
 *
 * 用户裁定：**两个保护必须分开**。被自己再切一次至少还有一份交接；被宿主压掉什么都没有。
 *
 * ── 这条 advisory 的边界（写在这里，因为它是本函数唯一的危险点）────────────────────────────────
 *
 * 它**只读**：不改阈值、不改几何、不触发任何切片。
 * 它**不得邀请切片**：宽限期内邀请切片正是那条循环（切 → 种子大 → 再切）。所以文案里不许出现
 * 「请交接」「尽早切片」这类动词，只说事实：**宿主可能先压缩，而当前会话不会收到 graft 的切片提示。**
 *
 * 一个「只读但邀请切片」的 advisory 比没有更坏：它把循环的入口伪装成一条提示。
 */

export interface ChainAdvisoryInput {
  /** 这个会话是否处在 graft 目标宽限期内。 */
  readonly chainProtected: boolean
  /** 当前水位比例。 */
  readonly ratio: number
  /** 生效中的预警线。 */
  readonly warnAt: number
  /** 宿主压缩线（`CompactionCeiling.thresholdRatio`）；`undefined` = 读不到。 */
  readonly compactionLine: number | undefined
}

export interface ChainAdvisory {
  readonly kind: 'chain-compaction-advisory'
  readonly ratio: number
  readonly warnAt: number
  readonly compactionLine: number | undefined
  /** 只陈述事实，不包含任何邀请动作的动词。 */
  readonly message: string
}

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`

export function chainCompactionAdvisory(input: ChainAdvisoryInput): ChainAdvisory | undefined {
  if (!input.chainProtected) return undefined
  if (!(input.ratio >= input.warnAt)) return undefined

  const line =
    input.compactionLine === undefined
      ? '宿主压缩线未知（读不到），因此无法保证它晚于本次交接'
      : `宿主压缩线在 ${pct(input.compactionLine)}，而当前水位已是 ${pct(input.ratio)}`

  return {
    kind: 'chain-compaction-advisory',
    ratio: Number(input.ratio.toFixed(4)),
    warnAt: Number(input.warnAt.toFixed(4)),
    compactionLine: input.compactionLine === undefined ? undefined : Number(input.compactionLine.toFixed(4)),
    /**
     * 刻意不提「切片 / 交接 / 转生」中的任何一个动词。它要读者知道**情况**，不是要读者**做动作**。
     * 真正的让位由 N2 的闸决定（工作过一轮之后才允许），不由这句提示决定。
     */
    message:
      `[graft 只读提示] 本会话处在宽限期，graft 不会发送切片提示，但压缩不受宽限期保护：` +
      `${line}。这不是叫你立刻做什么，只是让你知道「没有提示」不等于「一切正常」。`,
  }
}