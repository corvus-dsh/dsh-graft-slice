import { graftTargets } from './state.js'

export function graftLogVisibility(
  callerSessionId: string,
  claimedSourceId: string,
): { ok: true; attributed: false; reason: 'unattributed'; detail: string } | { ok: true; attributed: true; reason: 'self' | 'ancestor'; detail: string } | { ok: false; reason: string; detail: string } {
  if (claimedSourceId.length === 0) return { ok: false, reason: 'sourceSessionId is empty', detail: '' }
  /**
   * ── THE UNATTRIBUTABLE CASE, AND WHY IT PASSES — 用户裁定 2026-11-21 ─────────────────────────
   *
   * A host that does not populate `exec.agent.id` cannot say who is calling. Refusing there would
   * switch the read-back feature off for that host entirely — measured: both existing tool-path tests
   * call `execute(args, {})`, which is exactly that shape, and the dispatched `graft_read_result`
   * would stop working for every legitimate reader on such a host.
   *
   * So it is ADMITTED and LABELLED, never silently equivalent to 「verified」: the result carries
   * `logVisibility: 'unattributed'` and the text says the ownership was not checked. That is the same
   * trade as the confirmation gate's `ownership: 'unattributed'` (B4-B B6), for the same reason —
   * 「cannot check」 must be visible as its own state rather than collapsed into 「checked and fine」.
   *
   * What it does NOT do is pretend the id was validated: the caller still had to name it, and the
   * refusal text below is what a host WITH an identity gets.
   */
  if (callerSessionId.length === 0) {
    return {
      ok: true,
      attributed: false,
      reason: 'unattributed',
      detail: '宿主未提供调用方身份（exec.agent.id 缺失），无法证明这个会话 id 属于本会话；已放行，但归属未核实。',
    }
  }
  if (claimedSourceId === callerSessionId) return { ok: true, attributed: true, reason: 'self', detail: '' }

  const MAX_HOPS = 32
  let current = callerSessionId
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const mark = graftTargets.get(current)
    if (mark === undefined) break
    const parent = typeof mark.sourceSessionId === 'string' ? mark.sourceSessionId : ''
    if (parent.length === 0) break
    if (parent === claimedSourceId) return { ok: true, attributed: true, reason: 'ancestor', detail: '' }
    current = parent
  }
  return {
    ok: false,
    reason:
      `拒绝读会话 ${claimedSourceId} 的日志：它不是本会话（${callerSessionId}）` +
      '自己的会话，也不是本会话的切片来源链上的任何一个。graft 的读取只覆盖「我自己的历史」与' +
      '「我的上游」——一份别人的会话日志里有它自己的用户原话与工具输出，不是本项目可以代读的东西。' +
      '要在那个会话里回读，请在那个会话里调用。',
    detail: '',
  }
}
