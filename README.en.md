# dsh-graft-slice

Log slicing and minimal injection for DeepSeek Harness. It cuts a finished source session at its last `turn/end`, then creates a zero-inheritance, cold-resumable handoff session. No fork, no SQLite, no standalone `tool/result` injection.

Target runtime: DSH **0.2.1-rc.5** (the installed desktop build).

## Two required corrections to spec v2.1

1. **Skeleton is `turn: 1` / `step: 1`, not `0`.** DSH's v4 relationship validator starts at 1 and throws `turn/start does not open the expected turn` for 0. Verified with the real `@deepseek-ai/dsh-session-format-v3-to-v4` validator: `synthetic-1-1 PASS`, `synthetic-0-0 FAIL`.
2. **Use `sessions.prepare` + `sessionPersistence.create` + `handle.append/flush`, not `sessions.create` + `sessions.flush`.** `create()` publishes a live session; a later `agents.resume()` fails with `session "<id>" already exists`, and `sessions.flush()` rejects a detached session. The durable path is the same one `AgentLoop.create()` uses. `inheritedEventCount` remains 0 and `fork()` is never called.

## What it does

- `graft_slice_and_inject({ sourceSessionId, newSessionId })`:
  - Phase 1: `ctx.sessionQuery.readSession`, locate the last `turn/end`, refuse an open turn, extract a producer-owned assistant source (fallback `plugin:graft`).
  - Phase 2: keep assistant text only; turn tool calls/results into inline pointer text; keep the last 5 turns verbatim, summarize older turns; extract goal and a first-person pending state.
  - Phase 3: open a `turn/1 step/1` skeleton, inject a protected `system/message` as the first surface node, inject the goal seed as `user/message` with `surfaceOp:'append'`, inject summary/tape/pending as `assistant/message` with `stream: []` and no `sourceEventSeqs`, close the skeleton. The system head is required: without it, the resumed agent's `system/message` is rejected on the next cold read with `system/message requires a protected first surface head`.
  - Phase 4: persist through `sessionPersistence`, cold-read and validate the artifact, retire the source in memory, and expose `{ kind: 'reject' }` through `agent/pre-step`.
- `graft_read_result({ sourceSessionId, seq })`: reads a v4 `tool/result` payload from the source log (also accepts the v3 nested `tool-result` shape).

## v0.10.0 concurrent handoff safety

Two sessions can now hit the watermark at the same time without erasing each other.
Every state file (`retired`, `transferred`, `prepared`, target marks, resume grace,
constraint sections) is written under a `mkdir`-based lock, and the write **merges**
with the file on disk instead of overwriting it; removals must be explicit. Each
source also takes a per-session lock, so the second commit sees
`SOURCE_ALREADY_MIGRATED` instead of creating a second target.

`.graft-audit.jsonl` records `model-nudge` / `force-graft` / `lock-wait` / `lock-stale`
— the durable proof that a nudge fired (pre-step messages never reach the log).

`node scripts/duel-model-driven.mjs` runs four real processes against one dataDir
(A/B self-slice at 73%, C/D force-graft at 76%) and fails unless all four sources are
retired, all four targets carry the bootstrap, and no lock times out.

## v0.9.0 Model-Driven handoff

The 75% cutoff is a physical interruption when the model is mid-implementation. Default is now a
5% margin: at **70%** pre-step injects one quiet hint per turn — call `graft_prepare` to inspect the
handoff, then `graft_slice_and_inject` when you judge the task needs a new stage. At **75%** the
system still force-migrates if the hint was ignored.

```yaml
modelDrivenGraft: true        # default true
modelDrivenGraftAtRatio: 0.70 # must stay below autoGraftAtRatio
autoGraft: true
autoGraftAtRatio: 0.75        # the fallback cutoff
```

The hint rides the pre-step `messages` channel (no log write, no step number consumed), at most once
per turn. Every target's pending state now ends with
`[系统提示] 你刚刚完成了一次自我切片。请直接接着“当前任务”继续执行，无需等待用户确认。`
so a grafted session continues instead of waiting for the user; turning `modelDrivenGraft` off removes
both the hint and that bootstrap line.

## v0.15.0: version alignment, and the joint defence with memory

Both plugins now ship as **v0.15.0** (`package.json`, `manifest.json` and the READMEs agree). The number
covers two releases made together: the seven guard rails plus `graft_debug_status` on this side (see
v0.14.0 below), and bi-temporal memory on the `dsh-memory` side — `valid_at` / `invalid_at` /
`superseded_by`, supersede adjudication with a mutual link and an audit ledger, and provenance tiers
(`human` / `tool` / `inferred`) where anything the agent concluded carries `[来源：工具推断，请核实]`
in the hint. `graft` decides where the model is and what it may do; `memory` decides which conclusions
may enter the session and when they stop counting.

## v0.14.0: seven defences and a debug panel

v0.13 added two guard rails as *requests*; v0.14 enforces them at the **tool layer** and
closes three failure modes that only appear on a real machine.

| # | Defence | Where | Behaviour |
|---|---|---|---|
| D1 | global-search ban | `tools.guard` + a system-prompt section + a one-shot pre-step message | `rg /`, `Get-ChildItem C:\ -Recurse`, anything aimed at a drive root / `AppData` / the profile is **refused before dispatch**; searches inside the workspace still work |
| D2 | no slice loops | unconditional `isProtectedGraftTarget` + nudge suppression + injected `graft_generation` | a fresh target cannot be re-grafted for `graftTargetGraceTurns` (2) turns by ANY automatic path, including the 75% fallback, and the nudge no longer invites it to slice itself |
| D3 | memory workspace isolation | `workspace:` recorded at write time, pool-level gate at read time | foreign workspaces and unscoped records are never injected (`scope: global` excepted) |
| D4 | memory anti-pollution | `threat.ts` re-scans **before injection** | `ignore previous instructions` / `忽略以上指令` / `forget everything…` are dropped, including in body text the hint never renders |
| D5 | process-level lock reclamation | `scanAndReclaimLocks()` at activation | liveness is decided by the **owner PID**; a dead writer's `.lock` directory is reclaimed and audited, a live holder is never touched |
| D6 | destructive-command ban | the same scanner as D1 | `rm -rf /`, `Remove-Item -Recurse C:\`, recursive deletes that escape the workspace are denied; `Remove-Item -Recurse .\build` is not |
| D7 | one-off constraint filter | `extractConstraints` + the LLM constraint prompt | "立刻删除 <ws>\repair-log.cjs" never becomes a HARD CONSTRAINT |

Why D1/D6 *deny* rather than *warn*: the measured failure was a session that could not find
a file and widened the search to the drive roots, turn after turn. A prompt line is advice —
the model may read it, agree, and still run `rg` over the whole disk. `ctx.tools.guard()` is
a monotonic deny: a matching call returns a reason before dispatch, and no other guard can
turn it back into an allow. The criteria stay deliberately narrow — a search-level verb plus
an escaping target is denied, while reading one specific `C:\...` path is not, because a
guard that blocks ordinary work gets switched off.

Why the chain guard did not already work: `graftTargetGraceTurns` existed, but it was nested
inside `ignoreTransferGuard !== true`, and BOTH automatic callers pass
`ignoreTransferGuard: true`. Bypassing the retired/transferred refusal is not permission to
bypass the fresh-target refusal; only an explicit `forceSlice` is, and no automatic path
sets it.

### `graft_debug_status`

`watermark` (tokens, window, percent, source, distance to the 70% and 75% lines), `locks`
(held `.lock` entries with owner pid/liveness/age, unfinished `.txn` migrations, retired and
transferred counts, graft targets with their generation) and `memory` (skills / negatives /
facts / experiences / queue, plus same-workspace vs foreign vs unscoped counts when a
`workspace` is supplied). The same panels are available without a host:

```powershell
node scripts/debug-status.mjs --data <state-dir> --session <sessionId> --workspace <path>
```

The CLI sweeps locks in `dryRun` and only reads: a diagnostic must never mutate state. Its
watermark comes from real provider usage in the log, and reports `unavailable` rather than
inventing a number that would disagree with the host's own meter.

## v0.13.0: two guard rails

Both are on by default. They exist because automatic migration fails in two ways that
have nothing to do with slicing: the migrated model does not know where "here" ends, and
a rule that was only ever true once gets carried forward as if it were permanent.

**1. Workspace red line (`workspaceRedline`, default true).** A migrated session asked
about a file it could not find widened the search instead — profile directory, `AppData`,
then the drive roots — and summarised a filesystem it had only listed. The tape names
exactly one working directory, so the guard states it and says what to do instead:

> 【红线警告】your working directory is strictly `<cwd>`. Root-wide searches
> (`rg /`, `C:\`, `AppData`) are forbidden; when a file is missing, look with `ls`/`dir`
> inside the current directory, or ask the user. Do not retry a rejected path with a
> different spelling and do not widen the search.

`<cwd>` is interpolated from the session log header, never from model output, and the
block is injected in BOTH the migration system prompt and the durable goal
`user/message` — the host overwrites surface node 0 on the target's first live step, so a
guard that lives only in the system head is dead before the model reads it.

**2. One-off action filter (`extractConstraints` + the LLM constraint prompt).** A user
message that said "立刻删除 D:\...\repair-log.cjs" was kept as a standing rule, and the
migrated target still carried it as a HARD CONSTRAINT long after the file was gone. A
sentence that names one concrete artifact and one mutating verb, with no cue that governs
the act itself (禁止/绝不/每次/never/always/only…), is a task step: dropped. The exemption
window is deliberately narrow (12 chars) because the polluted sentence contains "绝不" too,
about a different act. The regex path and the model prompt carry the same exclusion.

## Red lines

- no `ctx.sessions.fork()`
- the first surface node is always `system/message` (protected head)
- skeleton events carry no `surfaceOp`
- `system/message`, `user/message`, and `assistant/message` always carry `surfaceOp:'append'`
- `assistant/message` always has `stream: []` and no `sourceEventSeqs`
- no standalone `tool/result` append
- open turn refused before any write
- retirement is an in-memory `agent/pre-step` reject; the source log is not written

## Test and demo

```powershell
cd '<plugin-dir>'
node scripts/build.mjs                 # requires Node >= 22.6 (type stripping); runtime needs >= 20
node --test test/*.test.mjs            # 327 tests
node scripts/check-docs.mjs            # docs vs code: version, build freshness, tool list, test count, feature status
node scripts/demo.mjs                  # real persisted log + fake host, never writes the real store
node scripts/scan-real-logs.mjs        # read-only scan of every local persisted log
# optional: point at an extracted node_modules containing the real DSH format packages
# $env:DSH_VALIDATOR_NODE_MODULES = "...\node_modules"; node scripts/validate-real-format.mjs
```

## v5.2 crash postmortem and architecture fix

- Outage cause: the detached target was pushed into the live store via `sessions.enter()` / `sessions.announce()`, and the target received forged `request/header` + permission events copied from the source. On restart DSH restored those half-live sessions and crashed; safe mode failed as well.
- Both mechanisms are removed. Targets stay detached: `prepare 鈫抪ersistence.create 鈫抋ppend 鈫抐lush 鈫抍lose 鈫抴orkspace attach`.
- Runtime state (model, tools, permissions) is rebuilt by the target's own agent loop; only `agentPreset` is inherited. No log-level impersonation.
- `stableCtx.get()` now falls back to the live context, which fixed the late-bound `workspaceRegistry` that made the autoGraft path skip workspace attach.
- Isolated verification: a new target auto-attached to its workspace without editing `workspace.json`; two consecutive restarts resumed it with `exit=0`; skeleton has no `surfaceOp`; seeded `assistant/message` has `stream: []`; no `sourceEventSeqs`.

## v5.2 runtime-intent migration (what the DSH sources actually support)

The post-crash lesson is not "runtime state cannot migrate" but "migrate the durable intent DSH itself folds, never forge a request".

| Event | Projection | Migrate? |
|---|---|---|
| `model/selection` | `modelSelection` (`lastUsed` / `pending`) | yes 鈥攊t is the user's choice |
| `permission/preset` | `permissions.preset` | yes |
| `sandbox/mode` | `permissions.sandbox` | yes |
| `approval/policy` | `permissions.approval` | yes |
| `request/header` | one model call's epoch header | never |
| `sessions.enter` / `announce` | live-store lifecycle | never (plugin code) |

`extractRuntimeIntent()` reads these four from the **full** source log; `buildInjectionEvents()` writes them into the target seed **after** `turn/end`, which is where DSH itself writes them, all `surface: false`.

The autoGraft snapshot truncates at the last `turn/end` (to avoid slicing an open turn), and the knobs live just past it 鈥攕o autoGraft extracts the intent from the complete event list separately.

Verification (isolated headless):

```text
src  session-lab6-src      model/selection = deepseek-account/deepseek-flash
tgt  lab6-mvxlqnqw-e8rqvu  ... turn/end, permission/preset, sandbox/mode,
                                approval/policy, model/selection
                           v4 validator PASS, two restarts exit=0
```

Decisive check 鈥攆olding the target log with DSH's own `applyModelSelectionProjection`:

```text
lastUsed = { provider: qodercn, model: dfmodel }                  (this run's profile default)
pending  = { provider: deepseek-account, model: deepseek-flash }  (migrated intent)
next     = deepseek-account / deepseek-flash
```

So the target resumes on the source route even though the profile default differs. Caveat: a one-shot headless run injects the profile default through `agentOptions` and bypasses the projection; the desktop path reads `pending` via `api-session-controller.selectionFor()`.

## v5.1 E2E snapshot

- autoGraft uses one pre-step state machine (`idle | grafting | done`) with forced transfer/retire before target creation.
- COMPINT 15 A/B model probes: A 15/15, B 15/15; every A run triggered compaction.
- RULER 5 full-auto: A 4/5, B 5/5; exactly one target per source; old source rejects.
- Task Status 5-todo: after auth/db completed, B correctly reports remaining api/ui/test.
- Snapshot version 5.1.0; its suite passed (historical, see the count below).

Observed on this machine:

```text
43 tests passed   # v5.1 snapshot, historical 鈥攖he current suite is 95
317 real logs parsed; 299 plan-ok; 16 open-turn; 2 no-closed-turn; 0 other failures
sealed sandbox activation PASS (sandbox_verify, clean profile)
real v4 validator: synthetic-1-1 PASS, real-log PASS, plugin:graft fallback PASS, 0/0 FAIL as expected
```

## Install

```text
plugin_manager(action: "install_bundle", target: "<path-to-dsh-graft-slice>")
```

Then call:

```text
graft_slice_and_inject({ sourceSessionId: "session-鈥? newSessionId: "session-graft-鈥?})
```

Refresh the Web UI session list and resume the new session. Set `retireSource: false` in `cordis.patch.yml` if the source must remain live.

## Notes

- `manifest.json` permissions are declarative; DSH 0.2.1-rc.5 does not enforce per-plugin permission manifests. Real capability comes from injected services.
- The retired set is process memory only. Cross-restart retirement needs a sidecar registry (out of scope for this pure-log phase).
- `graft_read_result` intentionally bypasses cross-session tool authorization per the spec; restrict it with a tool guard in untrusted compositions.
- The source must have an absolute `cwd`. The new session copies it as an exact string; no normalize/symlink equivalence.

