/**
 * ── N1 + N2 + N3 一次接线：compaction observer ────────────────────────────────────────────────────
 *
 * 路径：**装配层**（`index.ts` 的 pre-step，见接线步骤）+ **纯函数模块**（本文件）。
 *
 * ── 为什么三件事必须一次做（lead §三十）────────────────────────────────────────────────────────
 *
 * 只做 N1（advisory）与替换、不做 N3（记账），会留下「机制在、投递不在」的中间态 —— 而那正是
 * `v322` 的形状（门禁写好了、工具层不转发字段、四条判据全绿而用户那条路走不到）。
 *
 *   N1  宽限期内只**说事实**（水位 / 压缩线），不邀请切片 —— 邀请切片正是「切→种子大→再切」的循环口
 *   N2  宽限期**让位**给压缩风险，但**必须过闸**：`turnsSinceBirth >= 1`。
 *       「种子大 ⇒ 一出生就被切」正是宽限期当初要防的事；不加闸就是用一个已知的循环换一个压缩风险。
 *   N3  记住「压缩赢过」这件事（`suppressedByChain`），否则下一位读者会把「没预警」归因到预警门坏了
 *
 * ── 本模块只做判定，不做 IO ─────────────────────────────────────────────────────────────────────
 *
 * 它返回**该做什么**，由装配层执行（写审计、注入消息、作废宽限期）。这样它可以被单测完整覆盖，
 * 而装配层只剩接线 —— 与 `applyCompactionCeiling` 同一形状。
 */

export interface CompactionObserveInput {
  /** 这个会话是否处在 graft 目标宽限期内。 */
  readonly chainProtected: boolean
  /** 宽限期还剩几轮。 */
  readonly graceTurnsRemaining: number
  /** 这一代自从出生以来完成了多少个 turn（0 = 还没工作过）。 */
  readonly turnsSinceBirth: number
  /** 当前水位比例。 */
  readonly ratio: number
  /** 生效中的预警线。 */
  readonly warnAt: number
  /** 生效中的强切线。 */
  readonly hardAt: number
  /** 宿主压缩线；`undefined` = 读不到。 */
  readonly compactionLine: number | undefined
}

export type CompactionObserveAction =
  /** 什么都不做（未越线，或不归本模块管）。 */
  | { kind: 'none'; reason: string }
  /**
   * N1：只读提示。**不改几何**、**不邀请切片**。
   * 携带 `message`，装配层负责灌进 pre-step 的消息数组。
   */
  | { kind: 'advisory'; message: string; ratio: number; warnAt: number; compactionLine: number | undefined; suppressedByChain: true }
  /**
   * N2：宽限期让位。装配层据此把 `graceTurnsRemaining` 作废（`invalidateGrace`），
   * 下一轮走正常路径。`audit` 写进 `graft-seed-too-large` 或 `grace-yielded`。
   */
  | {
      kind: 'yield'
      reason: 'worked-then-crossed'
      ratio: number
      hardAt: number
      audit: { kind: 'grace-yielded'; turnsSinceBirth: number }
    }
  /**
   * N2 的闸：种子本身太大，一出生就越线 —— **不许靠反复切片消化**，报 RESOURCE。
   */
  | {
      kind: 'seed-too-large'
      ratio: number
      hardAt: number
      audit: { kind: 'graft-seed-too-large'; turnsSinceBirth: number }
    }

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`

/**
 * ── 判定顺序是有理由的，不是随手排的 ────────────────────────────────────────────────────────────
 *
 * 1. 不越过 `warnAt` ⇒ 无事可做。**先判它**，否则下面每一条都会在低水位被误触发。
 * 2. 不在宽限期 ⇒ `none`：正常路径有自己的 nudge / 强切机制，本模块不介入。
 * 3. 在宽限期且已越过 `hardAt` **且未工作过** ⇒ `seed-too-large`：这一代还没长出自己的压力，
 *    越线只可能来自继承的种子。**切它只会生出一个同样大的新种子。**
 * 4. 在宽限期且已工作过 ⇒ `yield`：这一代自己长出来的压力构成让位理由。
 * 5. 其余（越过 warnAt 但未到 hardAt）⇒ `advisory`。
 */
export function observeCompaction(input: CompactionObserveInput): CompactionObserveAction {
  if (!(input.ratio >= input.warnAt)) {
    return { kind: 'none', reason: 'below-warn' }
  }
  if (!input.chainProtected) {
    return { kind: 'none', reason: 'not-in-grace' }
  }

  const line =
    input.compactionLine === undefined
      ? '宿主压缩线未知（读不到），无法保证它晚于本次交接'
      : `宿主压缩线在 ${pct(input.compactionLine)}，当前水位已是 ${pct(input.ratio)}`

  /**
   * ── N2 的闸：一出生就越过 hardAt ⇒ 种子太大，**不是这一代的错** ────────────────────────────────
   *
   * 宽限期存在的理由写在 `index.ts:12466`：「不许被**它继承的种子磁带**带来的压力强切」。
   * 所以「种子大 ⇒ 一出生就越线」绝不能成为切它的理由 —— 那会切出一个同样大的新种子，无限循环。
   */
  if (input.ratio >= input.hardAt && input.turnsSinceBirth < 1) {
    return {
      kind: 'seed-too-large',
      ratio: Number(input.ratio.toFixed(4)),
      hardAt: Number(input.hardAt.toFixed(4)),
      audit: { kind: 'graft-seed-too-large', turnsSinceBirth: input.turnsSinceBirth },
    }
  }

  /** N2：工作过一轮之后再越线 ⇒ 这一代自己的压力，允许让位。 */
  if (input.ratio >= input.hardAt && input.turnsSinceBirth >= 1) {
    return {
      kind: 'yield',
      reason: 'worked-then-crossed',
      ratio: Number(input.ratio.toFixed(4)),
      hardAt: Number(input.hardAt.toFixed(4)),
      audit: { kind: 'grace-yielded', turnsSinceBirth: input.turnsSinceBirth },
    }
  }

  /**
   * N1：只陈述事实。**文案刻意不提「切片 / 交接 / 转生」中的任何一个动词** ——
   * 它要读者知道**情况**，不是要读者**做动作**。真正的让位由上面的闸决定。
   *
   * `suppressedByChain: true` 是 N3 的那一笔账：它让审计能回答
   * 「为什么 70% 没有预警」= 「另一个开关关了它」，而不是「预警门坏了」。
   */
  return {
    kind: 'advisory',
    message:
      `[graft 只读提示] 本会话处在宽限期（还剩 ${input.graceTurnsRemaining} 轮），graft 不会发送切片提示，` +
      `但压缩不受宽限期保护：${line}。这不是叫你立刻做什么，只是让你知道「没有提示」不等于「一切正常」`,
    ratio: Number(input.ratio.toFixed(4)),
    warnAt: Number(input.warnAt.toFixed(4)),
    compactionLine: input.compactionLine === undefined ? undefined : Number(input.compactionLine.toFixed(4)),
    suppressedByChain: true,
  }
}