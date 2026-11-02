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
cd 'D:\鎸佷箙灞傝兘鍔涙灦鏋刓dsh-graft-slice'
node scripts/build.mjs                 # requires Node >= 22.6 (type stripping); runtime needs >= 20
node --test test/*.test.mjs            # 255 tests
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
plugin_manager(action: "install_bundle", target: "D:\\鎸佷箙灞傝兘鍔涙灦鏋刓\dsh-graft-slice")
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

