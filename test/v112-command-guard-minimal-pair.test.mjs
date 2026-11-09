/**
 * D-FAMILY REGRESSION SUITE — the command guard's two confusions, measured as a minimal pair.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 *
 * `DESTRUCTIVE_VERB` contains the bare word `format`, so it matches **`Format-Table`** and
 * `Format-List` — PowerShell *formatting* cmdlets used in read-only pipelines. And `RECURSIVE_FLAG`
 * contains `-Force`, which PowerShell uses for ordinary overwrite/mkdir as well as for unbounded
 * deletes. Combined, a plain listing is denied as an unbounded delete:
 *
 *     Get-ChildItem -Force 'D:\x'                     → safe
 *     Get-ChildItem 'D:\x' | Format-Table              → safe
 *     Get-ChildItem -Force 'D:\x' | Format-Table       → DENIED   ← the false positive
 *
 * Measured live in the source session (seq=5630): **5 of 11 ordinary reads were blocked**, and the
 * user's report was that reading its own repository was being refused. A guard that blocks ordinary
 * work is a guard that gets switched off — and then protects nothing.
 *
 * ── WHY A MINIMAL PAIR AND NOT A LIST OF COMMANDS ───────────────────────────────────────────────
 *
 * I first tested the two factors SEPARATELY, both came back `safe`, and I nearly reported "this does
 * not reproduce". The trigger needs both. So the cases below always change exactly ONE factor, which
 * is what makes them diagnose rather than merely fail.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyAgentCommand } from '../index.js'

const WORKSPACE = 'D:\\持久层能力架构'
const riskOf = (command) => classifyAgentCommand(command, WORKSPACE).risk

test('D1: a formatting cmdlet is not a destructive verb — even beside -Force', (t) => {
  /**
   * ── SKIPPED: PENDING TD-16. The defect is REAL and REPRODUCED; the fix is not shipped. ─────────
   *
   * Measured on the current build:
   *     Get-ChildItem -Force 'D:\x'                 → safe
   *     Get-ChildItem 'D:\x' | Format-Table          → safe
   *     Get-ChildItem -Force 'D:\x' | Format-Table   → DENY   ← ordinary read refused
   *
   * The two factors must appear TOGETHER; testing either alone reports "does not reproduce", which is
   * exactly the mistake this file's first draft made. Historical measurement (source session,
   * seq=5630): 5 of 11 ordinary read-only commands were blocked.
   *
   * The sandbox proved the fix costs nothing: D1+D2 → 639/640 green with zero existing regressions.
   * It is skipped here only because production is frozen pending the ruling.
   */
  t.skip('pending TD-16 ruling: Format-Table beside -Force is currently DENIED')
})

test('D1 control: a REAL format is still destructive', (t) => {
  /**
   * ── SKIPPED: PENDING TD-16, AND THE REASON IS ITSELF A FINDING ─────────────────────────────────
   *
   * `format D: /q` is denied TODAY, but `Format-Volume -DriveLetter D -Force` is ALLOWED — the guard
   * catches the cmd.exe spelling and misses the PowerShell one. That is a HOLE, not a false positive:
   * the more common form on this platform is the one that gets through.
   *
   * The sandbox fix closes it with an `UNCONFINABLE_VERB` class (verbs with no workspace-scoped form),
   * denied before the confinement question is asked. Until the ruling, the hole stands — asserting the
   * fixed behaviour here would just be a failing test for code that is not shipped.
   */
  t.skip('pending TD-16 ruling: Format-Volume is currently ALLOWED (cmd.exe `format D:` is denied)')

  // What holds today and must keep holding after any fix.
  assert.equal(riskOf('format D: /q'), 'destructive', 'cmd.exe format of a drive is destructive')
})

test('D2: -Force alone does not turn an inside-workspace delete into an unbounded one', () => {
  // `-Force` is PowerShell's ordinary "overwrite / include hidden". It is not recursion.
  assert.notEqual(riskOf('New-Item -ItemType Directory -Path .\\out -Force'), 'destructive', 'mkdir -Force is not a delete')
  assert.notEqual(riskOf('Copy-Item a.txt b.txt -Force'), 'destructive', 'overwrite copy is not a delete')
  assert.notEqual(riskOf('Remove-Item .\\tmp\\x.log -Force'), 'destructive', 'deleting ONE file inside the workspace is confined')
})

test('D2 control: a recursive delete is still destructive wherever it points', (t) => {
  /**
   * ── SKIPPED: THIS ASSERTS A PROPOSAL, NOT SHIPPED BEHAVIOUR (see TD-16) ─────────────────────────
   *
   * The direction that matters: `Remove-Item -Recurse -Force <inside workspace>`. A recursive delete
   * INSIDE the workspace is exactly what the red line forbids — "需要清理时把目标限制在当前工作区内"
   * describes where the TARGET may be, not a licence to recurse through it.
   *
   * But the existing design says the opposite with a good reason ("a guard that blocks ordinary work
   * gets switched off") and three shipped tests assert it. The user's ruling was: keep production
   * untouched, verify the fix in a sandbox, and put the effect in the report for a later decision.
   *
   * Measured in the sandbox: D1+D2 alone → 639/640 green, zero existing regressions.
   * D1+D2+D3 (this case) → 637/640, three existing assertions fail.
   *
   * So this assertion documents the PROPOSED behaviour and is skipped until TD-16 is ruled on. It is
   * not deleted: a deleted test is an argument nobody can re-open.
   */
  t.skip('pending TD-16 ruling: recursive delete inside the workspace is currently ALLOWED')

  // The controls that DO hold today, asserted unconditionally below.
  assert.equal(riskOf('Remove-Item -Recurse C:\\'), 'destructive', 'recursive delete of a drive root')
  assert.equal(riskOf('rm -rf /'), 'destructive', 'classic root wipe')
})

test('D3: ordinary read-only work is never denied', () => {
  const ordinary = [
    'Get-ChildItem -Recurse . | Format-Table Name,Length',
    'Get-ChildItem -Force . | Format-Table Name',
    'Get-Process | Format-Table Name,Id',
    'git status --porcelain | Format-Table',
    'git log --oneline -5',
    'node --test test/*.test.mjs',
    'rg "format" src/',
  ]
  for (const command of ordinary) {
    assert.notEqual(riskOf(command), 'destructive', `ordinary read denied: ${command}`)
  }
})

test('D4: the global-search rule is untouched by this change', () => {
  // The two rules must stay separable: relaxing the destructive-verb rule must not relax the sweep rule.
  assert.equal(riskOf("Get-ChildItem -Recurse 'C:\\'"), 'destructive', 'sweeping a drive root is still a GLOBAL_SEARCH')
  assert.equal(riskOf('rg / src'), 'destructive', 'searching from the filesystem root is still a GLOBAL_SEARCH')
  assert.equal(riskOf('Get-ChildItem -Recurse src/'), 'safe', 'recursing through a relative path is ordinary work')
})
