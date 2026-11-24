/**
 * ── N2 的判据要问的两件事（lead §二十九）─────────────────────────────────────────────────────────
 *
 * 这两个函数**曾经写在 `index.ts` 里**，被 `v327` 的棘轮当场拦下（14874 → 14898 行、191 → 193 函数）。
 * 棘轮的话是对的：**「只减不增」意味着新增判定要有自己的住处**，不能塞进那个正在被分解的文件。
 *
 * `turnsInGeneration`：这一代**自己**完成了多少轮，是「继承的种子压力」与「这一代长出来的压力」的分界。
 * `invalidateGrace`：作废宽限期。它是 **chain 的事实**（宽限属于 chain），所以调用方只登记**请求**，
 * 由 chain 侧执行 —— 「何时作废」归 compaction，「怎么作废」归 chain。
 */

export interface SessionEventLike {
  readonly type?: string
}

/** 这一代自己完成了多少轮；读不到会话时返回 0（**不是**「可以切」，是「没有证据证明工作过」）。 */
export function turnsInGeneration(
  events: readonly SessionEventLike[] | undefined,
): number {
  if (events === undefined) return 0
  return events.filter((event) => event.type === 'turn/end').length
}

/**
 * 登记一次「作废宽限期」的请求。
 *
 * 存**请求**而不是直接改 chain 的 mark：让 compaction 只说「何时该作废」，
 * 而「作废长什么样」留在 chain 侧。两个所有者各管一半，才不会被顺手改掉另一方的数据。
 */
export function requestGraceInvalidation(
  requests: Map<string, string>,
  sessionId: string,
  reason: string,
): void {
  requests.set(sessionId, reason)
}