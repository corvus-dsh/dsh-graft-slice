/**
 * v0.14 GUARD RAILS — the defences, asserted on the artefacts they produce.
 *
 * The failure these cover is not "the plugin mis-sliced a log". It is the model on
 * the other side of a migration: told nothing about where its workspace ends, free
 * to run any command, and free to slice itself again the moment it was created.
 * So every test here asserts a REFUSAL or an injection, never an intention.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply,
  collectDebugStatus,
  collectMemoryStoreStatus,
  isProcessAlive,
  scanAgentCommand,
  scanAndReclaimLocks,
} from '../index.js'
import { dispatchPreStep, makeCtx, makeSourceLog } from './fake-harness.mjs'

const BENIGN_COMMANDS = [
  'rg TODO src/',
  'Get-ChildItem -Recurse .\\src | Select-Object Name',
  'Remove-Item -Recurse .\\build',
  "Get-Content 'C:\\Users\\me\\.dsh\\profiles\\desktop\\cordis.patch.yml'",
  'npm test',
]

// ---------------------------------------------------------------------------
// D1: global search
// ---------------------------------------------------------------------------

test('v0.14 D1: the guard denies every root-wide search and leaves ordinary work alone', () => {
  for (const command of [
    'rg pattern /',
    'grep -r TODO /',
    'Get-ChildItem -Path C:\\ -Recurse -Force',
    'Get-ChildItem -Recurse $env:LOCALAPPDATA\\dsh-sbx',
    "Get-ChildItem 'C:\\Users\\me\\.dsh' -Recurse",
    'Select-String -Path AppData\\**\\*.log -Pattern error',
    'dir /s C:\\',
  ]) {
    const verdict = scanAgentCommand(command, 'D:\\持久层能力架构')
    assert.equal(verdict?.decision, 'deny', `expected a denial for: ${command}`)
    assert.equal(verdict?.code, 'GLOBAL_SEARCH')
    assert.match(String(verdict?.reason), /GLOBAL_SEARCH/u)
    assert.match(String(verdict?.reason), /工作区/u, 'the denial states the boundary it enforced')
  }
  for (const command of BENIGN_COMMANDS) {
    assert.equal(scanAgentCommand(command, 'D:\\持久层能力架构'), undefined, `expected an allow for: ${command}`)
  }
})

test('v0.14 D1: the denial is actionable — it names the alternative, not just the ban', () => {
  const verdict = scanAgentCommand('rg foo /', 'D:\\持久层能力架构')
  assert.match(String(verdict?.reason), /ls \/ dir/u)
  assert.match(String(verdict?.reason), /询问用户/u)
  assert.match(String(verdict?.reason), /不要换写法重试/u)
})

// ---------------------------------------------------------------------------
// D6: destructive commands
// ---------------------------------------------------------------------------

test('v0.14 D6: recursive deletion is denied when it escapes the workspace', () => {
  const workspace = 'D:\\持久层能力架构'
  for (const command of [
    'rm -rf /',
    'rm -rf ~',
    'Remove-Item -Recurse -Force C:\\',
    'Remove-Item -Recurse $env:USERPROFILE\\Documents',
    'Remove-Item -Recurse D:\\other-project',
    'del /s /q C:\\',
  ]) {
    const verdict = scanAgentCommand(command, workspace)
    assert.equal(verdict?.decision, 'deny', `expected a denial for: ${command}`)
    assert.equal(verdict?.code, 'DESTRUCTIVE_COMMAND')
  }
})

test('v0.14 D6: confined work is NOT blocked (a guard that blocks ordinary work gets switched off)', () => {
  const workspace = 'D:\\持久层能力架构'
  assert.equal(scanAgentCommand('Remove-Item -Recurse .\\build', workspace), undefined)
  assert.equal(scanAgentCommand('Remove-Item -Recurse -Force D:\\持久层能力架构\\dsh-memory\\lib', workspace), undefined)
  assert.equal(scanAgentCommand('rm -rf node_modules', workspace), undefined)
  assert.equal(scanAgentCommand('Remove-Item .\\dist\\bundle.js', workspace), undefined)
  // With no workspace to judge against, only an obvious root/system target denies:
  // "cannot prove it is outside" must not become "block the user's other project".
  assert.equal(scanAgentCommand('Remove-Item -Recurse D:\\other-project', ''), undefined)
  assert.equal(scanAgentCommand('Remove-Item -Recurse C:\\', '')?.decision, 'deny')
})

test('v0.14 D1/D6: the guard is wired into the tool layer and only for command tools', () => {
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  assert.ok(ctx.tools.guards.length >= 1, 'a guard is registered at activation')

  const denied = ctx.tools._runGuards({ name: 'pwsh', arguments: { command: 'rg secret /' }, agent: { id: log.session.id } })
  assert.match(String(denied), /GLOBAL_SEARCH/u)

  const destructive = ctx.tools._runGuards({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse C:\\' }, agent: { id: log.session.id } })
  assert.match(String(destructive), /DESTRUCTIVE_COMMAND/u)

  assert.equal(
    ctx.tools._runGuards({ name: 'read', arguments: { file_path: '/etc/hosts' }, agent: { id: log.session.id } }),
    undefined,
    'a non-command tool is never scanned: its arguments are not a command line',
  )
  assert.equal(
    ctx.tools._runGuards({ name: 'pwsh', arguments: { command: 'Get-ChildItem -Recurse .\\src' }, agent: { id: log.session.id } }),
    undefined,
    'the workspace itself stays searchable',
  )
})

test('v0.14 D1: commandGuard:false disarms the tool layer (the switch is not decorative)', () => {
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, { commandGuard: false })
  assert.equal(ctx.tools.guards.length, 0)
  assert.equal(
    scanAgentCommand('rg x /', 'D:\\持久层能力架构')?.decision,
    'deny',
    'the scanner itself is unchanged; only its enforcement is off',
  )
})

test('v0.14: a denied command leaves an audit line that names what was blocked', () => {
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  ctx.tools._runGuards({ name: 'pwsh', arguments: { command: 'rg secret /' }, agent: { id: log.session.id } })
  const audit = readFileSync(join(ctx.pathsData, '.graft-audit.jsonl'), 'utf8')
  assert.match(audit, /"kind":"command-blocked"/u)
  assert.match(audit, /GLOBAL_SEARCH/u)
})

// ---------------------------------------------------------------------------
// D1: the warning reaches the model, in two channels
// ---------------------------------------------------------------------------

test('v0.14 D1: the red line is a system-prompt section AND a one-shot pre-step message', async () => {
  const log = makeSourceLog({ turns: 3, cwd: 'D:\\持久层能力架构' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})

  const section = ctx.systemPrompt._render('graft:guard', { session: { id: log.session.id } })
  assert.match(section, /红线（最高优先级/u)
  assert.match(section, /D:\\持久层能力架构/u)
  assert.match(section, /rm -rf/u)

  const payload = { agent: { id: log.session.id }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
  const first = await dispatchPreStep(ctx, payload)
  const text = JSON.stringify(first)
  assert.match(text, /最高优先级/u)
  assert.match(text, /rg \//u)

  const second = await dispatchPreStep(ctx, payload)
  assert.doesNotMatch(
    JSON.stringify(second),
    /最高优先级/u,
    'a standing rule repeated every step is a rule the reader learns to skip',
  )
})

// ---------------------------------------------------------------------------
// D2: chain guard
// ---------------------------------------------------------------------------

test('v0.14 D2: the target is injected with its graft_generation and the re-graft discipline', async () => {
  const log = makeSourceLog({ turns: 5, sourceSessionId: 'session-chain-source' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-chain-target' }, {})
  assert.equal(report.ok, true)
  assert.equal(report.generation, 1, 'a first-hop target is generation 1')

  const stored = ctx._persistence.read('session-chain-target')
  const goal = stored.events.find((event) => event.type === 'user/message')
  const goalText = goal.data.content[0].text
  assert.match(goalText, /graft_generation: 1/u)
  assert.match(goalText, /第 1 代迁移产物/u)
  assert.match(goalText, /不得再触发切片/u)
  assert.match(goalText, /完成前 2 轮/u)
})

test('v0.14 D2: a fresh target is not cut even at the hard cutoff, and the nudge is withheld', async () => {
  const log = makeSourceLog({ turns: 5, sourceSessionId: 'session-chain-source-2' })
  const ctx = makeCtx({ sourceLog: log })
  // The host's own measurement: 90k of a 100k window is far past both lines.
  ctx.tokenMeter = { measure: () => ({ totalTokens: 90_000 }) }
  apply(ctx, {
    autoGraft: true,
    autoGraftAtRatio: 0.05,
    modelDrivenGraft: true,
    modelDrivenGraftAtRatio: 0.01,
    contextWindowTokens: 100_000,
  })

  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-chain-target-2' }, {})
  assert.equal(report.ok, true)

  // The dangerous shape: a target whose seeded tape already sits above the cutoff.
  // One completed turn, so it is still inside the two-turn grace window.
  const firstEnd = log.events.findIndex((event) => event.type === 'turn/end')
  const seeded = log.events.slice(0, firstEnd + 1)
  ctx.sessions.live.set('session-chain-target-2', {
    id: 'session-chain-target-2',
    header: { cwd: log.session.cwd },
    snapshotEvents: () => seeded,
  })

  const payload = {
    agent: { id: 'session-chain-target-2' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }],
  }
  const decision = await dispatchPreStep(ctx, payload)
  assert.equal(decision.kind, 'enter', 'inside the grace window the target keeps working instead of being cut')
  assert.doesNotMatch(JSON.stringify(decision), /graft_prepare/u, 'the model-driven nudge is withheld too')
  const audit = readFileSync(join(ctx.pathsData, '.graft-audit.jsonl'), 'utf8')
  assert.doesNotMatch(audit, /"kind":"force-graft"/u, 'no forced graft happened')

  // After the grace turns elapse the session is ordinary again: the same pressure
  // now routes it through the normal path instead of being silently ignored.
  ctx.sessions.live.set('session-chain-target-2', {
    id: 'session-chain-target-2',
    header: { cwd: log.session.cwd },
    snapshotEvents: () => log.events,
  })
  const later = await dispatchPreStep(ctx, { ...payload, messages: [{ role: 'user', content: [{ type: 'text', text: '再来一轮' }] }] })
  assert.notEqual(JSON.stringify(later), JSON.stringify(decision), 'past the grace window the chain guard stops intervening')
})

// ---------------------------------------------------------------------------
// D5: process-level lock reclamation
// ---------------------------------------------------------------------------

test('v0.14 D5: a dead owner is reclaimed, a live owner is never touched', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  const dead = join(root, 'dead.json.lock')
  const live = join(root, 'live.json.lock')
  const unknown = join(root, 'unknown.json.lock')
  for (const dir of [dead, live, unknown]) mkdirSync(dir, { recursive: true })
  // 2147483646 cannot be a live pid on any platform we ship.
  writeFileSync(join(dead, 'owner'), JSON.stringify({ token: 't', pid: 2147483646, at: Date.now() }), 'utf8')
  writeFileSync(join(live, 'owner'), JSON.stringify({ token: 't', pid: process.pid, at: Date.now() }), 'utf8')
  assert.equal(isProcessAlive(2147483646), false)
  assert.equal(isProcessAlive(process.pid), true)

  const report = scanAndReclaimLocks([root])
  const byLabel = new Map(report.map((entry) => [entry.label, entry]))
  assert.equal(byLabel.get('dead.json')?.action, 'reclaimed')
  assert.equal(byLabel.get('live.json')?.action, 'kept')
  assert.equal(byLabel.get('unknown.json')?.action, 'kept-unknown')
  assert.equal(existsSync(dead), false, 'the dead lock directory is gone')
  assert.equal(existsSync(live), true, 'a live holder keeps its lock')
  assert.equal(existsSync(unknown), true, 'a fresh lock with no owner is left alone')
})

test('v0.14 D5: an abandoned ownerless lock is reclaimed only once it is older than the stale window', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  const orphan = join(root, 'orphan.json.lock')
  mkdirSync(orphan, { recursive: true })
  const old = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(orphan, old, old)
  const dry = scanAndReclaimLocks([root], true)
  assert.equal(dry[0]?.action, 'reclaimed', 'dryRun still CLASSIFIES it')
  assert.equal(existsSync(orphan), true, 'dryRun removes nothing')
  const wet = scanAndReclaimLocks([root])
  assert.equal(wet[0]?.action, 'reclaimed')
  assert.equal(existsSync(orphan), false)
})

test('v0.14 D5: activation sweeps dead locks before it reads any state', () => {
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  const stateDir = ctx.pathsData
  const dead = join(stateDir, '.retired.json.lock')
  mkdirSync(dead, { recursive: true })
  writeFileSync(join(dead, 'owner'), JSON.stringify({ token: 't', pid: 2147483646, at: Date.now() }), 'utf8')
  apply(ctx, {})
  assert.equal(existsSync(dead), false, 'the dead lock is gone after activation')
  const audit = readFileSync(join(stateDir, '.graft-audit.jsonl'), 'utf8')
  assert.match(audit, /"kind":"lock-reclaimed"/u)
})

// ---------------------------------------------------------------------------
// The debug panel (graft_debug_status)
// ---------------------------------------------------------------------------

test('v0.14: the debug panel reports the watermark, both distances, and the chain state', () => {
  const status = collectDebugStatus({
    section: 'all',
    settings: { modelDrivenGraftAtRatio: 0.7, autoGraftAtRatio: 0.75, contextWindowTokens: 0 },
    watermark: { tokens: 60_000, contextWindow: 100_000, ratio: 0.6, source: 'tokenMeter' },
    generation: 2,
    graceTurnsRemaining: 1,
    retired: ['a', 'b'],
    transferred: [{ id: 'a', newSessionId: 'b', at: 1 }],
    targets: [{ id: 'b', generation: 1, sourceSessionId: 'a', createdAt: 0 }],
    txns: [{ name: 'x.json', state: 'PREPARED' }],
    locks: [{ path: 'p', label: 'p', pid: 1, alive: true, ageMs: 5, action: 'kept' }],
    lockCleanup: [{ path: 'q', label: 'q', pid: 2, alive: false, ageMs: 9, action: 'reclaimed' }],
  })
  const watermark = status.watermark
  assert.equal(watermark.percent, 60)
  assert.equal(watermark.toWarnRatio, 0.1)
  assert.equal(watermark.toWarnTokens, 10_000)
  assert.equal(watermark.toHardTokens, 15_000)
  assert.equal(watermark.state, 'below-warn-line')
  assert.equal(status.chain.generation, 2)
  assert.equal(status.chain.graceTurnsRemaining, 1)
  assert.equal(status.chain.reGraftBlocked, true)
  assert.deepEqual(status.locks.reclaimedAtActivation, ['q'])
  assert.equal(status.transactions.retiredCount, 2)
  assert.equal(status.transactions.graftTargetsCount, 1)
  assert.deepEqual(status.transactions.pending, [{ name: 'x.json', state: 'PREPARED' }])
  assert.equal(status.memory.available, false, 'no memory paths passed = an honest "unavailable"')

  const over = collectDebugStatus({
    section: 'watermark',
    settings: { modelDrivenGraftAtRatio: 0.7, autoGraftAtRatio: 0.75, contextWindowTokens: 0 },
    watermark: { tokens: 80_000, contextWindow: 100_000, ratio: 0.8, source: 'usage' },
  })
  assert.equal(over.watermark.state, 'over-hard-cutoff')
  assert.equal(over.watermark.toWarnTokens, 0, 'past the line the distance floors at zero')
  assert.equal(over.transactions, undefined, 'a section request returns only its own panel')
})

test('v0.14: the memory panel separates same-workspace records from dirty ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memstatus-'))
  const memoryDir = join(root, 'memory')
  const skillsDir = join(root, 'skills')
  mkdirSync(memoryDir, { recursive: true })
  const skill = (name, scope, workspace) => {
    mkdirSync(join(skillsDir, name), { recursive: true })
    writeFileSync(
      join(skillsDir, name, 'SKILL.md'),
      ['---', `name: ${name}`, `scope: ${scope}`, ...(workspace === '' ? [] : [`workspace: ${workspace}`]), '---', '', '# t'].join('\n'),
      'utf8',
    )
  }
  skill('mine', 'workspace', 'D:/项目A')
  skill('theirs', 'project', 'D:/项目B')
  skill('legacy', 'project', '')
  skill('shared', 'global', 'D:/项目B')
  writeFileSync(
    join(memoryDir, 'negatives.jsonl'),
    [
      JSON.stringify({ symptom: 'mine', workspace: 'D:/项目A' }),
      JSON.stringify({ symptom: 'theirs', workspace: 'D:/项目B' }),
      JSON.stringify({ symptom: 'legacy' }),
    ].join('\n') + '\n',
    'utf8',
  )

  const inventory = collectMemoryStoreStatus(memoryDir, skillsDir)
  assert.equal(inventory.counts.skills, 4)
  assert.equal(inventory.counts.negatives, 3)
  assert.equal(inventory.workspace, undefined, 'no workspace asked = a plain inventory')

  const dirty = collectMemoryStoreStatus(memoryDir, skillsDir, 'D:\\项目A')
  assert.equal(dirty.workspace, 'd:/项目a')
  assert.equal(dirty.skillsInWorkspace.matched, 2, 'a local skill and a global one')
  assert.equal(dirty.skillsInWorkspace.dirty, 2, 'a foreign skill and an unscoped one')
  assert.equal(dirty.skillsInWorkspace.unscoped, 1)
  assert.equal(dirty.negativeRecords.matched, 1)
  assert.equal(dirty.negativeRecords.foreign, 1)
  assert.equal(dirty.negativeRecords.unscoped, 1)
  assert.equal(dirty.negativeRecords.dirty.length, 2)
})

test('v0.14: graft_debug_status is registered and answers for the calling session', async () => {
  const log = makeSourceLog({ turns: 3, sourceSessionId: 'session-debug-source', cwd: 'D:\\debug-ws' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const tool = ctx._tools.get('graft_debug_status')
  assert.ok(tool !== undefined, 'the debug tool is registered')

  const locksOnly = await tool.execute(
    { section: 'locks' },
    { agent: { id: log.session.id }, callId: 'c1', name: 'graft_debug_status', arguments: {}, signal: undefined },
  )
  assert.equal(locksOnly.ok, true)
  assert.equal(locksOnly.section, 'locks')
  assert.equal(typeof locksOnly.transactions.retiredCount, 'number')
  assert.equal(locksOnly.watermark, undefined, 'a locks-only request does not measure tokens')

  const all = await tool.execute(
    { workspace: 'D:\\debug-ws' },
    { agent: { id: log.session.id }, callId: 'c2', name: 'graft_debug_status', arguments: {}, signal: undefined },
  )
  assert.ok(all.watermark !== undefined)
  assert.ok(all.chain !== undefined)
  assert.ok(all.memory !== undefined)
  assert.equal(all.memory.available, true)
})

test('v0.14: the debug panel inspects locks without reclaiming them', async () => {
  const log = makeSourceLog({ turns: 3, sourceSessionId: 'session-debug-source-2' })
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  // A live-owned lock created AFTER activation: the sweep already ran, so only the
  // panel could remove it — and it must not.
  const probe = join(ctx.pathsData, 'probe.json.lock')
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'owner'), JSON.stringify({ token: 't', pid: process.pid, at: Date.now() }), 'utf8')
  const tool = ctx._tools.get('graft_debug_status')
  const status = await tool.execute({ section: 'locks' }, { agent: { id: log.session.id } })
  assert.ok(Array.isArray(status.locks.held))
  assert.ok(status.locks.held.some((entry) => entry.label === 'probe.json'))
  assert.equal(existsSync(probe), true, 'a diagnostic must not mutate state')
})

test('v0.14: the CLI reads the same panels from disk, without a host', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-cli-state-'))
  const memoryDir = mkdtempSync(join(tmpdir(), 'dsh-cli-mem-'))
  const skillsDir = mkdtempSync(join(tmpdir(), 'dsh-cli-skills-'))
  writeFileSync(join(stateDir, '.retired.json'), JSON.stringify(['s1', 's2']), 'utf8')
  writeFileSync(join(stateDir, '.graft-targets.json'), JSON.stringify({ t1: { sourceSessionId: 's1', createdAt: 1, generation: 2 } }), 'utf8')
  writeFileSync(join(stateDir, '.transferred.json'), JSON.stringify({ s1: { newSessionId: 't1', at: 1, reason: 'r' } }), 'utf8')
  // A dead lock: the CLI's sweep is dryRun, so it reports it and leaves it alone.
  const dead = join(stateDir, 'dead.json.lock')
  mkdirSync(dead, { recursive: true })
  writeFileSync(join(dead, 'owner'), JSON.stringify({ token: 't', pid: 2147483646, at: Date.now() }), 'utf8')

  const out = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/debug-status.mjs', import.meta.url)),
      '--data', stateDir,
      '--memory', memoryDir,
      '--skills', skillsDir,
      '--json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const parsed = JSON.parse(out)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.transactions.retiredCount, 2)
  assert.equal(parsed.transactions.graftTargetsCount, 1)
  assert.equal(parsed.transactions.transferredCount, 1)
  assert.equal(parsed.locks.held.length, 1)
  assert.equal(parsed.locks.held[0].pid, 2147483646)
  assert.equal(parsed.watermark.available, false, 'no session asked: an honest unavailable, not a fabricated number')
  assert.equal(parsed.memory.available, true)
  assert.equal(existsSync(dead), true, 'the CLI is read-only')
})

test('v0.14: the CLI watermark comes from real provider usage in a session log', async () => {
  const { watermarkFromLog } = await import('../scripts/debug-status.mjs')
  const events = [
    { type: 'request/context', data: { contextWindow: 200_000 } },
    { type: 'assistant/message', data: { usage: { inputTokens: 150_000 } } },
    { type: 'assistant/message', data: { usage: { totalTokens: 160_000 } } },
  ]
  const watermark = watermarkFromLog({ events })
  assert.equal(watermark.source, 'usage')
  assert.equal(watermark.tokens, 160_000, 'the LAST usage figure wins')
  assert.equal(watermark.contextWindow, 200_000)
  assert.equal(watermark.ratio, 0.8)
  // No usage at all: undefined rather than an invented estimate. A watermark that
  // disagrees with the host's meter is worse than no watermark.
  assert.equal(watermarkFromLog({ events: [{ type: 'request/context', data: { contextWindow: 200_000 } }] }), undefined)
})
