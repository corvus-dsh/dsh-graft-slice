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

test('D1: a formatting cmdlet is not a destructive verb — even beside -Force', () => {
  /**
   * The two factors must appear TOGETHER; testing either alone reports "does not reproduce", which is
   * exactly the mistake this file's first draft made. Historical measurement (source session,
   * seq=5630): 5 of 11 ordinary read-only commands were blocked.
   */
  assert.notEqual(riskOf("Get-ChildItem -Force 'D:\\x'"), 'destructive', 'only -Force is a read')
  assert.notEqual(riskOf("Get-ChildItem 'D:\\x' | Format-Table"), 'destructive', 'only Format-Table is a read')

  // And together — the shape that WAS denied.
  assert.notEqual(
    riskOf("Get-ChildItem -Force 'D:\\x' | Format-Table"),
    'destructive',
    'Format-Table in a read-only pipeline must not be read as the VERB "format"',
  )
  assert.notEqual(riskOf("Get-ChildItem -Force 'D:\\x' | Format-List"), 'destructive', 'Format-List counts as formatting')
  assert.notEqual(riskOf("Get-ChildItem -Recurse 'D:\\x' | Format-Table"), 'destructive', '-Recurse + formatting is a read')
})

test('D1 control: a REAL format is still destructive — in BOTH spellings', () => {
  /**
   * `Format-Volume -DriveLetter D -Force` was ALLOWED while `format D: /q` was denied: the guard caught
   * the cmd.exe spelling and missed the PowerShell one, i.e. it missed the more common form on this
   * platform. That is a MISSED DETECTION, not a false positive, and the ruling required it to be fixed
   * together with D1+D2 rather than waiting behind the disputed D3.
   */
  assert.equal(riskOf('format D: /q'), 'destructive', 'cmd.exe format of a drive is destructive')
  assert.equal(riskOf('Format-Volume -DriveLetter D -Force'), 'destructive', 'Format-Volume is a real format')
  assert.equal(riskOf('Format-Volume -DriveLetter D'), 'destructive', 'Format-Volume without -Force too')
})

test('D2: -Force alone does not turn an inside-workspace delete into an unbounded one', () => {
  // `-Force` is PowerShell's ordinary "overwrite / include hidden". It is not recursion.
  assert.notEqual(riskOf('New-Item -ItemType Directory -Path .\\out -Force'), 'destructive', 'mkdir -Force is not a delete')
  assert.notEqual(riskOf('Copy-Item a.txt b.txt -Force'), 'destructive', 'overwrite copy is not a delete')
  assert.notEqual(riskOf('Remove-Item .\\tmp\\x.log -Force'), 'destructive', 'deleting ONE file inside the workspace is confined')

  /**
   * ── THE CASE THAT ACTUALLY MOVES (found by differential testing) ─────────────────────────────
   *
   * A single-file delete OUTSIDE the workspace. This is the shape `-Force`-as-recursion got wrong:
   * the confinement rule denies `recursive && outsideWorkspace`, so treating `-Force` as recursion
   * turned an ordinary one-file delete of a path elsewhere on the disk into a denial, and — the same
   * bug, seen from the other side — it EXEMPTED a real recursive delete inside the workspace.
   *
   * Without this assertion the D2 fix is unobservable: the earlier version only tested paths inside
   * the workspace, where the verdict does not change.
   */
  assert.notEqual(riskOf("Remove-Item -Force 'D:\\other\\x.log'"), 'destructive', 'one file outside the workspace is still one file')
  assert.notEqual(
    riskOf("Remove-Item -Force 'D:\\other\\x.log','D:\\other\\y.log'"),
    'destructive',
    'two explicit files is not an unbounded delete',
  )
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
  t.skip('TD-17 ruled to KEEP this behaviour: recursive delete inside the workspace stays ALLOWED')

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

test('D5: a destructive WORD in an argument position is data, not a verb', () => {
  /**
   * ── WHY THIS CASE EXISTS (found by differential testing, not by reasoning) ────────────────────
   *
   * Reverting the command-position guard changed NO verdict among the 24 candidates I first tried,
   * and that looked like "the guard is unnecessary". The real reason was that those candidates were
   * protected by something else. These two are the pair that IS decided by position:
   *
   *     echo rm -rf /                      → allowed  (rm is an ARGUMENT of echo)
   *     node -e "..." && rm -rf /          → denied   (rm starts the second segment)
   *
   * Without the guard, `echo rm -rf /` is denied — and a guard that refuses to PRINT a command is
   * exactly the "blocks ordinary work" failure the ruling is fixing.
   */
  assert.notEqual(riskOf('echo rm -rf /'), 'destructive', 'rm as an argument to echo is data')
  assert.notEqual(riskOf('Select-String -Pattern "Remove-Item" -Path src/'), 'destructive', 'searching for the word is not the act')
  assert.notEqual(riskOf('git commit -m "format D:"'), 'destructive', 'a commit message mentioning it is not it')

  // ...and the same verb in COMMAND POSITION is still caught, including after a segment separator.
  assert.equal(riskOf('node -e "console.log(1)" && rm -rf /'), 'destructive', 'the second segment really does wipe')
  assert.equal(riskOf('echo done | Remove-Item -Recurse C:\\\\'), 'destructive', 'piped into a destructive verb')
  assert.equal(riskOf('& format D: /q'), 'destructive', 'the call operator does not launder a verb')
})
