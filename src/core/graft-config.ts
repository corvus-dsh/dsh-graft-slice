/** Per-row configuration. All fields are optional; defaults are conservative. */
export interface GraftConfig {
  /** Number of trailing turns kept verbatim. Default 5 (used only when adaptiveDepth is off). */
  recentTurns?: number
  /**
   * v2.2.0 (audit F1): whether the operator EXPLICITLY set `recentTurns`.
   *
   * WHY A SEPARATE FLAG. `normalizeConfig` fills absent fields with defaults, so by the time the tape
   * is built, `recentTurns: 5` is indistinguishable from "the operator asked for 5". The adaptive path
   * used that ambiguity to overwrite the value unconditionally, which made the documented
   * `recentTurns` configuration a no-op. Measured: the same source sliced with recentTurns = 1, 2 and
   * 5 produced byte-identical tapes, because `adaptive.depth` replaced all three.
   *
   * A default is a FALLBACK, not an instruction. "Nobody said" and "somebody said 5" must not
   * collapse into one value, so the distinction is recorded here instead of being re-derived later.
   *
   * NOT a public knob for callers: they set `recentTurns`; this is filled in by `normalizeConfig`.
   */
  recentTurnsExplicit?: boolean
  /**
   * v6.3: choose the retained-turn count from the source's own shape.
   * Debug-heavy sessions keep more verbatim turns; prose-heavy ones keep fewer
   * so the target has room to generate. Default true.
   */
  adaptiveDepth?: boolean
  /** Lower bound for adaptive depth. Default 3. */
  adaptiveDepthMin?: number
  /** Upper bound for adaptive depth. Default 8. */
  adaptiveDepthMax?: number
  /** Maximum characters kept for one recent turn; 0 disables the cap. Default 0. */
  maxTurnChars?: number
  /** Maximum characters kept across all tape chunks; 0 disables the cap. Default 0. */
  maxTotalChars?: number
  /** Maximum characters per older-turn summary. Default 600. */
  oldTurnSummaryChars?: number
  /** Add the source session to the in-memory retired set on success. Default true. */
  retireSource?: boolean
  /** Re-read the new session through sessionQuery and validate it. Default true. */
  verifyReadBack?: boolean
  /** Skeleton turn number. Default 1 (DSH 0.2.1-rc.5 requires 1). */
  skeletonTurn?: number
  /** Skeleton step number. Default 1 (DSH 0.2.1-rc.5 requires 1). */
  skeletonStep?: number
  /** v4.0: automatically graft when the turn-stopping token watermark is reached. */
  autoGraft?: boolean
  /** v4.0: watermark ratio, default 0.75. */
  autoGraftAtRatio?: number
  /**
   * v7.6 (Model-Driven): let the MODEL decide to hand over before the system does.
   *
   * At `modelDrivenGraftAtRatio` (default 0.70) pre-step injects ONE quiet nudge
   * per turn, leaving a 5% safety margin: the model can finish the sentence or
   * tool call it is in, then call `graft_prepare` / `graft_slice_and_inject`
   * itself. The system still force-grafts at `autoGraftAtRatio` (default 0.75)
   * when the model ignores the nudge — the hard cutoff stays the fallback.
   *
   * Default true: a forced kill mid-thought is the failure mode this removes.
   */
  modelDrivenGraft?: boolean
  /**
   * v7.6: nudge watermark, default 0.70.
   *
   * Keep it strictly below `autoGraftAtRatio`; the gap is the model's safety
   * margin. A value at/above the hard cutoff leaves no window and the nudge can
   * never fire (no clamping: silent correction would hide the misconfiguration).
   */
  modelDrivenGraftAtRatio?: number
  /** v4.0: fallback context window when request/context does not publish one. */
  contextWindowTokens?: number
  /** v4.0: target-id prefix for automatically generated sessions. */
  autoGraftIdPrefix?: string
  /** Optional test allowlist; empty means all sessions. */
  autoGraftSessionIds?: string[]
  /**
   * v0.13 GUARD: inject the workspace boundary (see `workspaceRedline`).
   *
   * Default true. A migrated target is handed ONE working directory; without an
   * explicit boundary, "the file is not here" turns into an unbounded widening
   * search — the profile directory, AppData, the drive roots — and a confident
   * summary of a filesystem that was only listed. The red line travels in both the
   * migration system prompt and the durable goal user/message.
   *
   * It is a switch only so a differential test can prove the guard is what
   * changed the behaviour. Localization tests and log diffs will notice it.
   */
  workspaceRedline?: boolean
  /**
   * v0.14 GUARD: intercept command execution at the TOOL layer.
   *
   * Default true. A red line in the prompt is a request; a tool guard is a
   * refusal. Measured live: a session that could not find a file widened the
   * search to the drive roots regardless of what the prompt said, because the
   * prompt is advisory and the tool layer is not. The guard denies before
   * dispatch (via `ctx.tools.guard`), so the command never runs.
   *
   * Denied: root-wide searches (`rg /`, `Get-ChildItem C:\ -Recurse`, anything
   * aimed at AppData / the user profile / a drive root) and recursive deletion
   * that escapes the session workspace or names a system root. Confined work —
   * a search inside the workspace, a recursive delete of a build directory — is
   * untouched: a guard that blocks ordinary work gets switched off.
   */
  commandGuard?: boolean
  /**
   * v0.18: which DECISION TABLE the command policy uses. Default `balanced`.
   *
   *   strict      unknown and destructive are refused outright
   *   balanced    destructive refused; unknown (a mutating verb we cannot place) refused
   *   autonomous  unknown allowed; destructive still ASKS rather than running silently
   *
   * The mode changes no classifier — only what the operator wants done about a
   * given risk, which is the whole point of separating the two.
   */
  safetyMode?: SafetyMode
  /**
   * v0.18: where the migration thresholds come from. Default `dynamic`.
   *
   * `fixed` uses `modelDrivenGraftAtRatio` / `autoGraftAtRatio` verbatim (the old
   * behaviour, kept for a differential test). `dynamic` derives them from the
   * window and the estimated cost of the handoff itself — see
   * `calculateSafeWatermark`. Migrating at 90% of a window that a graft needs 12%
   * of is not "late", it is impossible.
   */
  watermarkMode?: 'fixed' | 'dynamic'
  /** v0.18: measured turns used to predict growth. Default 6. */
  growthSampleTurns?: number
  /** v0.18: how many turns of growth headroom `dynamic` reserves. Default 2. */
  growthReserveTurns?: number
  /**
   * v0.18: tokens a completed turn adds, used by the growth prediction.
   *
   * Default 1200 (measured on this project: a turn with two tool calls and their
   * results). The figure is a RATE, not a measurement of this session, because a
   * session near its ceiling has no cheap way to prove its own future slope —
   * the honest move is to name the assumption and let the operator correct it.
   */
  growthTokensPerTurn?: number
  /**
   * v0.18: total characters the HARD CONSTRAINTS block may occupy. Default 8000.
   *
   * The block is a hard-preservation contract: if the qualified rules do not fit
   * here, the migration ABORTS (`GRAFT_ABORTED`) instead of shipping a shortened
   * rule set. Raising this is the operator's way of saying "this task has more
   * standing rules than a default task".
   */
  constraintBudgetChars?: number
  /**
   * v0.19: PHYSICAL IGNITION. Default true.
   *
   * After the target is durable (`flush()`) and the retirement transaction has
   * committed, call `sessionController.prompt(...)` once so the new session starts
   * working on its own. Off exists for the differential test and for an operator
   * who wants to inspect a target before it runs.
   */
  igniteTarget?: boolean
  /** v0.19: how the ignition prompt is admitted. Default `queue`. */
  ignitionMode?: 'queue' | 'steer'
  /** v0.19: custom ignition text; the marker is prepended when it is missing. */
  ignitionPrompt?: string
  /**
   * v0.14: where `dsh-memory` keeps its store, read-only, for the debug panel.
   *
   * The two plugins never import each other; the panel simply reads the same
   * files the memory plugin writes. Empty = `<state dir>/.dsh-memory`.
   */
  memoryDir?: string
  /** v0.14: where SKILL.md files live. Empty = `~/.agents/skills`. */
  skillsDir?: string
  /**
   * v6.3: 'silent' migrates immediately at the watermark (default).
   * 'confirm' asks the user first and only migrates after they agree.
   */
  graftMode?: 'silent' | 'confirm'
  /** v6.3: how long a confirm prompt stays valid. Default 10 minutes. */
  confirmTtlMs?: number
  /** Test/diagnostic: keep the host event loop alive briefly after an auto turn. Default 0. */
  autoGraftKeepAliveMs?: number
  /**
   * v7.0 C2: completed turns a freshly created target is immune to auto-graft.
   *
   * Default 2. A target seeded with a large tape can already sit above
   * `autoGraftAtRatio` on its very first request, which would graft it again
   * before the user types anything — and repeat indefinitely. Zero disables the
   * guard (not recommended).
   */
  graftTargetGraceTurns?: number
  /**
   * v7.3: how many times a graft may be postponed waiting for a task boundary.
   *
   * Default 1. The probe defers when the model left todos open or the last tool
   * call failed — cutting there hands the target a half-finished task. The wait
   * is capped because a permanently red test must not pin the session forever;
   * zero disables the probe entirely.
   */
  taskBoundaryMaxDeferTurns?: number
  /**
   * v0.9.3: how long an unanswered `tool/call` may hold the harbour closed, in milliseconds.
   *
   * THE BUG THIS CLOSES is not a deadlock — `turn-stopping` and `pendingGraftSources` keep firing while
   * the user is active. It is what happens after the session goes QUIET: nothing re-triggers the check, so
   * a session whose tool call never returned sits above the watermark permanently and never migrates.
   *
   * Default **600000** (10 minutes). **`0` or `Infinity` disables the limit** and restores the previous
   * "a dangling call holds the harbour forever" behaviour exactly, for anyone who wants it.
   */
  harborOpenCallMaxAgeMs?: number
  /**
   * v0.9.4: whether a completed graft should move the UI focus to the new session.
   *
   * ── WHY THE DEFAULT IS `'never'`, AND WHY THE SWITCH EXISTS WITHOUT DOING ANYTHING YET ────────
   *
   * Focus transfer lives ONLY in `dsh-observer/client.js` today (8 `openSession` occurrences; graft's
   * own client has 0). When observer is installed — and it is optional — hatching a main moves the UI
   * there. Grafter's automatic slice has no such call, and that is CORRECT for the automatic path:
   * a background migration must not steal focus from what the user is doing.
   *
   * But with observer absent, a manual slice leaves the user with nothing pointing at the result. The
   * honest fix is an OPT-IN, not a default: auto slices never jump, manual ones may.
   *
   * **`'always'` IS NOT WIRED YET** — stated here and in README rather than shipping a switch that
   * silently does nothing. See ARCHITECTURE.md TD-10 for the intended shape and the exit condition.
   */
  focusAfterGraft?: 'never' | 'always' | 'manual-only'
  /**
   * v0.9.5 (TD-11): whether `graft_prepare` may accept a hand-written handover.
   *
   * ── A SWITCH THAT DOES NOTHING YET, DECLARED ON PURPOSE ──────────────────────────────────────
   *
   * The handoff is TWO-STAGE (`graft_prepare` → review → `graft_commit`), but only the first half of
   * "check and correct the handoff before committing" was ever built: `graft_commit` takes
   * `preparedId` + `digest` and nothing else, so stage two can AGREE with the extracted content and
   * cannot EDIT it. `graft_prepare`'s parameter list has no content field either
   * (`additionalProperties: false`, three properties).
   *
   * That is a gap, not a fault — and it is the quiet kind: nothing errors, the card simply describes
   * the PREVIOUS turn's todo list because that is the only thing there is to extract from.
   *
   * **NOTHING IS WIRED TO THIS FIELD.** It parses, it round-trips through the config, and it changes
   * no behaviour at either value. The intended semantics, when it is built:
   *   - `true`  → `graft_prepare` accepts an optional `handover: { goal?, pending?, constraints?, notes? }`
   *                that OVERRIDES the extracted fields, and the review marks those sections as
   *                "provided by the model";
   *   - the `digest` MUST include `handover`, or "the user approved THIS version" stops meaning
   *                anything (the digest is the fingerprint of what was reviewed).
   *
   * Declared now, with this comment and ARCHITECTURE.md TD-11, so that shipping an inert switch is a
   * documented decision rather than a surprise — the same standard `focusAfterGraft` is held to.
   */
  handoverEditable?: boolean
  /**
   * v7.4 (decision 2): let the TASK STATE, not just the conversation shape, pick
   * the replay tier. Off by default.
   *
   * Measured on this project: a target that replays 1 turn reaches `plugin_manager`
   * in 3 calls and finishes in 9 steps, while a zero-replay target spends 19 file
   * reads rediscovering *how* to verify and finishes in 42. The difference is
   * whether the last turn's method is visible.
   *
   * So when the work is visibly unfinished — an open todo, or a failed last call —
   * one turn is worth its cost. When the work is at a clean stopping point, zero
   * replay is cheaper and the read-back index still holds every pointer.
   *
   * Default `false` because the rule is supported by ONE paired observation
   * (n=1), not a distribution. An operator opts in; the plugin does not decide on
   * that little evidence.
   */
  autoAdaptiveTier?: boolean
  /**
   * v7.4 P4-3: announce persisted, cold FORK sessions to the client sidebar.
   *
   * A fork is written by `sessions.fork` and is never published, so the host's
   * `session/created` -> `api-session/added` path never fires for it. The
   * session is loadable and resumable but invisible, which reads to the user as
   * "my sample disappeared". Default true: the announcement is idempotent and
   * only covers sessions the plugin did not create itself.
   */
  registerArchivedForks?: boolean
  /**
   * Explicit directory for the plugin's own state files.
   *
   * The desktop host does NOT export DSH_PROFILE_DIR/DSH_HOME to the Electron
   * main process — those exist only inside the tool sandbox. Guessing a profile
   * from the environment therefore silently falls back to the plugin directory,
   * which every profile shares. Set this per profile in cordis.patch.yml.
   */
  dataDir?: string
  /** Optional provider/model for the one-shot LLM constraint extractor. */
  constraintProvider?: string
  constraintModel?: string
}
