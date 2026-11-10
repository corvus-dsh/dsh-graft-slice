import { classifyAgentCommand } from './command-guard.js'
import type { CommandRisk } from './command-guard.js'

export interface CommandVerdict {
  /** `deny` is enforced by the tool guard; `warn` is reported and allowed. */
  decision: 'deny' | 'warn'
  code: 'GLOBAL_SEARCH' | 'DESTRUCTIVE_COMMAND'
  reason: string
}

export type SafetyMode = 'strict' | 'balanced' | 'autonomous'

export type PolicyDecision = 'allow' | 'ask' | 'deny'

/**
 * The decision table, in one place.
 *
 * - `destructive` is denied in strict and balanced. In `autonomous` it becomes an
 *   ASK rather than an allow: a mode may lower the ceremony, but no mode silently
 *   executes an unbounded delete.
 * - `unknown` (a mutating verb we cannot prove is confined) is denied unless the
 *   operator chose `autonomous`. "Cannot prove it is fine" is not "fine".
 * - `safe` is allowed everywhere: a policy that blocks ordinary work is a policy
 *   that gets switched to `autonomous` and then protects nothing.
 */
export function policyDecision(risk: CommandRisk, mode: SafetyMode): PolicyDecision {
  if (risk === 'safe') return 'allow'
  if (risk === 'destructive') return mode === 'autonomous' ? 'ask' : 'deny'
  return mode === 'autonomous' ? 'allow' : 'deny'
}

/**
 * @deprecated v0.18: kept because callers and tests name it, and because `deny`
 * remains its only verdict. New code asks `classifyAgentCommand` and lets the
 * configured `safetyMode` decide.
 */
export function scanAgentCommand(command: string, workspace = ''): CommandVerdict | undefined {
  const assessment = classifyAgentCommand(command, workspace)
  if (assessment.risk !== 'destructive' || assessment.reason === undefined) return undefined
  return { decision: 'deny', code: assessment.code ?? 'DESTRUCTIVE_COMMAND', reason: assessment.reason }
}

export interface CommandPolicyVerdict {
  risk: CommandRisk
  decision: PolicyDecision
  code?: 'GLOBAL_SEARCH' | 'DESTRUCTIVE_COMMAND'
  /** Present whenever the decision is not `allow`: the message the agent sees. */
  reason?: string
}

/**
 * v0.18: classify, then decide — the two jobs the string matcher used to do at once.
 *
 * v0.19: `ask` is no longer expressed as a refusal.
 *
 * The live contract settles what v0.18 could only work around: `tools/pre-execute`
 * is a waterfall whose decision is
 * `{kind:'allow'} | {kind:'deny', reason} | {kind:'cancel'} | {kind:'ask', reason?, displayReason?}`,
 * and "missing approval support turns `ask` into denial" — fail-closed for free.
 * `tools.guard()`, by contrast, can only return a denial string.
 *
 * So the two decisions use the two channels they belong to: `deny` goes to the
 * guard (monotonic: no later guard can force-allow it), and `ask` goes to the
 * waterfall as a real approval prompt. Collapsing the two into "deny with an
 * instruction to ask the user" made the user do the plugin's job.
 */
export function evaluateCommandPolicy(
  command: string,
  workspace = '',
  mode: SafetyMode = 'balanced',
): CommandPolicyVerdict {
  const assessment = classifyAgentCommand(command, workspace)
  const decision = policyDecision(assessment.risk, mode)
  if (decision === 'allow') {
    return {
      risk: assessment.risk,
      decision,
      ...(assessment.code === undefined ? {} : { code: assessment.code }),
    }
  }
  if (decision === 'deny') {
    return {
      risk: assessment.risk,
      decision,
      ...(assessment.code === undefined ? {} : { code: assessment.code }),
      reason:
        assessment.reason ??
        `该命令无法被证明是安全的（risk=${assessment.risk}，safetyMode=${mode}），已拒绝执行。`,
    }
  }
  return {
    risk: assessment.risk,
    decision,
    ...(assessment.code === undefined ? {} : { code: assessment.code }),
    reason:
      `${assessment.reason ?? `该命令风险等级为 ${assessment.risk}。`}` +
      `（safetyMode=${mode}：此类命令不会被自动放行，需要用户当场确认。）`,
  }
}
