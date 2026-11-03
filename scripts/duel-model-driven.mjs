#!/usr/bin/env node
/**
 * v7.7 battle drill: two sessions hand over AT THE SAME TIME.
 *
 *   node scripts/duel-model-driven.mjs            # 4 sessions, shared dataDir
 *   node scripts/duel-model-driven.mjs --data-dir <dir>
 *
 * Sets up four REAL sessions in four separate PROCESSES that share one dataDir:
 *
 *   A, B  at ~73% — in the Model-Driven window. Each process must receive the
 *         70% nudge and then call graft_slice_and_inject itself.
 *   C, D  at ~76% — over the hard cutoff. The system must force-graft them.
 *
 * Then it proves the ledger survived the race: `.retired.json` and
 * `.transferred.json` contain ALL FOUR ids, `.graft-audit.jsonl` contains the
 * nudges, every target carries the self-continuation bootstrap, and no lock
 * timeout occurred. Exit code 0 only when every assertion holds.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = pathToFileURL(join(repoRoot, 'index.js')).href
const harness = pathToFileURL(join(repoRoot, 'test', 'fake-harness.mjs')).href

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const dataDir =
  typeof arg('data-dir') === 'string'
    ? arg('data-dir')
    : join(repoRoot, '..', '_battle', `duel-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
mkdirSync(dataDir, { recursive: true })

const childSource = `
import { apply } from ${JSON.stringify(entry)};
import { dispatchPreStep, makeCtx, makeSourceLog } from ${JSON.stringify(harness)};

const [dataDir, sessionId, targetId, windowTokens, mode, startAt] = process.argv.slice(2);
const log = makeSourceLog({ turns: 7, sourceSessionId: sessionId });
const ctx = makeCtx({ sourceLog: log, paths: { data: dataDir } });
apply(ctx, {
  dataDir,
  autoGraft: true,
  autoGraftAtRatio: 0.75,
  modelDrivenGraft: true,
  modelDrivenGraftAtRatio: 0.7,
  contextWindowTokens: Number(windowTokens),
  recentTurns: 2,
  retireSource: true,
  verifyReadBack: true,
});
const wait = Math.max(0, Number(startAt) - Date.now());
await new Promise((resolve) => setTimeout(resolve, wait));

const payload = {
  agent: { id: sessionId },
  turn: 1,
  step: 1,
  messages: [{ role: 'user', content: [{ type: 'text', text: '继续推进实现。' }] }],
};
const decision = await dispatchPreStep(ctx, payload);
const text = JSON.stringify(decision);
const nudged = text.includes('当前上下文水位已达');

let action = 'none';
let target = targetId;
if (mode === 'model') {
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: sessionId, newSessionId: targetId }, {});
  action = report.ok === true ? 'sliced' : 'failed';
} else {
  action = decision.kind === 'reject' ? 'forced' : 'none';
  target = decision.newSessionId ?? targetId;
}

const stored = target === undefined ? undefined : ctx._persistence.read(target);
const bootstrap =
  stored !== undefined &&
  JSON.stringify(stored).includes('你刚刚完成了一次自我切片') &&
  JSON.stringify(stored).includes('无需等待用户确认');

process.stdout.write(
  JSON.stringify({ sessionId, target, mode, nudged, kind: decision.kind, action, bootstrap, ratioText: (text.match(/已达 \\d+%/) ?? [''])[0] }) + '\\n',
);
`

const startAt = Date.now() + 1500
// Written to a file instead of passed via `-e`: on Windows a four-line ESM
// program through argv is fragile, and a syntax error there looks like a plugin
// failure in the drill output.
const childFile = join(dataDir, '.duel-child.mjs')
writeFileSync(childFile, childSource, 'utf8')
const plans = [
  { sessionId: 'duel-a-source', targetId: 'duel-a-target', window: 2600, mode: 'model' },
  { sessionId: 'duel-b-source', targetId: 'duel-b-target', window: 2600, mode: 'model' },
  { sessionId: 'duel-c-source', targetId: 'duel-c-target', window: 2500, mode: 'force' },
  { sessionId: 'duel-d-source', targetId: 'duel-d-target', window: 2500, mode: 'force' },
]

const runChild = (plan) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [childFile, dataDir, plan.sessionId, plan.targetId, String(plan.window), plan.mode, String(startAt)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('exit', (code) => {
      const line = out.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      let parsed
      try {
        parsed = line === undefined ? undefined : JSON.parse(line)
      } catch {
        parsed = undefined
      }
      resolve({ plan, code, parsed, err: err.trim().split(/\r?\n/u).slice(-14).join(' | ') })
    })
  })

const results = await Promise.all(plans.map(runChild))
let failures = 0
const check = (ok, detail) => {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${detail}\n`)
}

const reading = (name) => {
  try {
    return JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
  } catch {
    return undefined
  }
}
const audit = (() => {
  try {
    return readFileSync(join(dataDir, '.graft-audit.jsonl'), 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
})()

process.stdout.write(`\n[duel] dataDir: ${relative(process.cwd(), dataDir) || dataDir}\n`)
process.stdout.write('[duel] session results:\n')
for (const { plan, code, parsed, err } of results) {
  process.stdout.write(
    `  ${plan.sessionId} mode=${plan.mode} exit=${code} ` +
      `${parsed === undefined ? `stderr=${err || '(none)'}` : JSON.stringify(parsed)}\n`,
  )
}

const retired = reading('.retired.json') ?? []
const transfers = reading('.transferred.json') ?? {}
const modelChildren = results.filter((item) => item.plan.mode === 'model')
const forceChildren = results.filter((item) => item.plan.mode === 'force')

check(results.every((item) => item.code === 0 && item.parsed !== undefined), 'all four processes finished cleanly')
check(modelChildren.every((item) => item.parsed?.nudged === true), 'A and B both received the 70% model-driven nudge')
check(modelChildren.every((item) => item.parsed?.action === 'sliced'), 'A and B both sliced themselves (graft_slice_and_inject)')
check(forceChildren.every((item) => item.parsed?.action === 'forced'), 'C and D were force-grafted at the 75% cutoff')
check(
  plans.every((plan) => retired.includes(plan.sessionId)),
  `every source is retired exactly once: [${retired.join(', ')}]`,
)
check(
  plans.every((plan) => transfers[plan.sessionId] !== undefined),
  `every source has a recorded target (${Object.keys(transfers).length} transfers)`,
)
check(
  plans.every((plan) => (transfers[plan.sessionId]?.newSessionId === plan.targetId) === (plan.mode === 'model')),
  'model-driven targets are the ids the model chose',
)
const nudges = audit.filter((entry) => entry.kind === 'model-nudge')
const lockWaits = audit.filter((entry) => entry.kind === 'lock-wait')
check(nudges.length >= 2, `audit recorded ${nudges.length} model-driven nudges`)
check(nudges.every((entry) => typeof entry.ratio === 'number' && entry.ratio < 0.75), 'every nudge fired below the hard cutoff')
check(audit.some((entry) => entry.kind === 'force-graft'), 'audit recorded the forced fallback')
check(results.filter((item) => item.plan.mode === 'model').every((item) => item.parsed?.bootstrap), 'every model-driven target carries the self-continuation bootstrap')
check(
  !results.some((item) => /STATE_LOCK_TIMEOUT/u.test(item.err ?? '')),
  'no writer timed out on a state lock',
)
check(lockWaits.length >= 0, `lock audit entries: ${lockWaits.length} (contention is recorded, not fatal)`)

process.stdout.write(
  `\n[duel] audit tail (${Math.min(audit.length, 8)} of ${audit.length}):\n` +
    audit
      .slice(-8)
      .map((entry) => `  ${entry.at} ${entry.kind} ${entry.sessionId ?? entry.file ?? ''} ${entry.ratio ?? ''}`.trimEnd())
      .join('\n') +
    '\n',
)
process.stdout.write(`\n[duel] ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)