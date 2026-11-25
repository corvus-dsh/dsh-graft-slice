import { autoGraftInFlight, autoGraftStates, autoGraftSuppressedUntil, constraintsApplied, constraintsInFlight, constraintsReasserted, deferredOverflowTargets, forcedCutMarks, graftTargets, guardReasserted, ignitionAdmissions, leftoverTargets, modelDrivenNudgeTurns, nudgeDeliveredAt, nudgeSamples, overflowRetries, pendingConfirms, pendingGraftSources, pendingIgnitions, planNudgeStates, preparedSlices, resetCompactionAdvisoryStateForTest, retiredSessions, rollbackNoticed, rollbackNotices, targetConstraintSections, taskBoundaryDeferrals, transferredSessions, transitionCards, watermarkEscalated, watermarkEscalations } from './state.js'
import { watermarkCache } from './watermark.js'

/** Clear the in-memory retired set. Intended for tests and explicit operator resets. */
export function resetRetiredSessions(): void {
  retiredSessions.clear()
  transferredSessions.clear()
  autoGraftInFlight.clear()
  autoGraftStates.clear()
  transitionCards.clear()
  graftTargets.clear()
  leftoverTargets.clear()
  // v7.0: these are per-session state too. Leaving them behind makes a reset
  // partial, so a later test (or an operator's explicit reset) sees a session
  // that is still marked as "already overflowed" or "already redirected".
  overflowRetries.clear()
  deferredOverflowTargets.clear()
  pendingConfirms.clear()
  pendingGraftSources.clear()
  constraintsApplied.clear()
  constraintsInFlight.clear()
  targetConstraintSections.clear()
  constraintsReasserted.clear()
  guardReasserted.clear()
  watermarkCache.clear()
  taskBoundaryDeferrals.clear()
  // v7.6: the per-turn nudge mark is session state too; a reset that kept it
  // would silence the 70% warning for the first turn of the next test.
  modelDrivenNudgeTurns.clear()
  /**
   * v1.0.0 P0: the PLAN-NUDGE state is session state for the same reason — and it was the
   * one collection this reset forgot. A stale entry would carry `turns`/`lastNudgeTurn`
   * from a finished session into whatever session next reuses the id, so the next plan
   * reminder could be silently suppressed (or fired far too early). The map also now has a
   * cap of its own; both exits are documented in `core/state.ts`.
   */
  planNudgeStates.clear()
  // v7.9: the escalation/forced-cut marks are session state; a stale mark would
  // inject "水位告急" into an unrelated session and mislabel a planned handover.
  watermarkEscalations.clear()
  watermarkEscalated.clear()
  forcedCutMarks.clear()
  // W0-2: the two layer-3/layer-2 facts are session state for the same reason — a stale
  // `nudgeDeliveredAt` would make an unrelated session's forced cut claim 「预警已送达」, and a stale
  // sample ring would let one test's tool results predict the next test's growth.
  nudgeDeliveredAt.clear()
  nudgeSamples.clear()
  /**
   * W1-4b: the staged reviews are session state too, and this reset had forgotten them.
   *
   * Measured while writing `v261`: a test (or an operator's explicit reset) that ran after a
   * `graft_prepare` still saw that review — so a "fresh" activation could commit a slice prepared against
   * a previous world, and a tampered entry on disk was masked by the stale clean copy in memory. Same
   * family as the plan-nudge gap noted below: a per-session map the reset does not clear makes the reset
   * partial, and a partial reset is a state that lies.
   */
  preparedSlices.clear()
  // v0.21: the ignition queue and the rollback notice ledger are session state too.
  // A reset that kept them would (a) leave a stale "already noticed" mark that
  // suppresses the next rollback's notice, and (b) leave a queued ignition that
  // fires against a session the reset just un-retired.
  pendingIgnitions.clear()
  rollbackNoticed.clear()
  /**
   * v7.8: the QUEUE must be cleared with the ledger. A queued notice that outlived its reset would be
   * delivered into whatever session next reuses that id — a stale "your migration failed" arriving in
   * an unrelated conversation is worse than not arriving at all.
   */
  rollbackNotices.clear()
  // v0.22: the per-target admission marks are session state too. A reset that kept
  // them would make the next attempt on a reused target id a silent no-op.
  ignitionAdmissions.clear()
  // v7.4: a reset must also drop the resume grace, or a test that resumes a
  // session poisons every later test that expects the watermark to fire.
  autoGraftSuppressedUntil.clear()
  // N1: advisory + dedupe state is session state too (v332 ③).
  resetCompactionAdvisoryStateForTest()
}
