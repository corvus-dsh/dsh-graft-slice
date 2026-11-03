#!/usr/bin/env node
/**
 * v7.8 E2E: three independent projects, concurrently.
 *
 *   node scripts/e2e-multiproject.mjs
 *
 * Each project (A/B/C) runs in its own PROCESS with its own dataDir and performs,
 * at the same time as the others:
 *
 *   1. GRAFT at 73% — model-driven nudge, then a self-slice (real plugin code).
 *   2. MEMORY harvest of that session — fake LLM, real store, real verifier.
 *   3. LOCK LEASE — hold a lock past the renewal interval and prove the lease
 *      timestamp advanced while held.
 *   4. SCENE ROUTING — the harvested skill (database) must NOT activate for a UI
 *      query, and must activate for a database query.
 *
 * The parent asserts cross-project isolation: each project's skills cite their
 * OWN session id (no evidence mix-up) and each project's ledger contains only its
 * own source.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = pathToFileURL(join(repoRoot, 'index.js')).href
const harness = pathToFileURL(join(repoRoot, 'test', 'fake-harness.mjs')).href
const memoryLib = pathToFileURL(join(repoRoot, '..', 'dsh-memory', 'lib')).href

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}
const root = typeof arg('root') === 'string' ? arg('root') : join(repoRoot, '..', '_battle', `e2e-${Date.now()}`)
mkdirSync(root, { recursive: true })

const childSource = `
import { apply, buildInjectionPlan, acquireFileLock } from ${JSON.stringify(entry)};
import { dispatchPreStep, makeCtx, makeSourceLog } from ${JSON.stringify(harness)};
const store = await import(${JSON.stringify(`${memoryLib}/store.js`)});
const retrieveLib = await import(${JSON.stringify(`${memoryLib}/retrieve.js`)});
const memoryIndex = await import(${JSON.stringify(`${memoryLib}/index.js`)});
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [projectRoot, sessionId, startAt] = process.argv.slice(2);
const wait = Math.max(0, Number(startAt) - Date.now());
await new Promise((resolve) => setTimeout(resolve, wait));

const graftData = join(projectRoot, 'graft');
mkdirSync(graftData, { recursive: true });

// ---- 1. graft at 73% with a written artifact in the tape ----
const log = makeSourceLog({ turns: 7, sourceSessionId: sessionId });
const endIndex = log.events.findLastIndex((event) => event.type === 'turn/end');
const endSeq = log.events[endIndex].seq;
log.events.splice(
  endIndex,
  0,
  { type: 'tool/call', seq: endSeq - 0.2, data: { name: 'write', callId: 'w-art', arguments: JSON.stringify({ file_path: 'D:\\\\proj\\\\' + sessionId + '.py' }) } },
  { type: 'tool/result', seq: endSeq - 0.1, data: { message: { source: { callId: 'w-art' }, content: [{ type: 'text', text: 'written' }] } } },
);
const ctx = makeCtx({ sourceLog: log, paths: { data: graftData } });
apply(ctx, {
  dataDir: graftData,
  autoGraft: true,
  autoGraftAtRatio: 0.75,
  modelDrivenGraft: true,
  modelDrivenGraftAtRatio: 0.7,
  contextWindowTokens: 2600,
  recentTurns: 2,
  retireSource: true,
  verifyReadBack: true,
});
const decision = await dispatchPreStep(ctx, {
  agent: { id: sessionId }, turn: 1, step: 1,
  messages: [{ role: 'user', content: [{ type: 'text', text: '继续实现。' }] }],
});
const nudged = JSON.stringify(decision).includes('当前上下文水位已达');
const report = await ctx._tools.get('graft_slice_and_inject').execute({ sourceSessionId: sessionId, newSessionId: sessionId + '-target' }, {});
const targetStored = ctx._persistence.read(sessionId + '-target');
const targetText = JSON.stringify(targetStored ?? {});
const artifactReused = targetText.includes('已完成节点产物');
const bootstrap = targetText.includes('你刚刚完成了一次自我切片');

// ---- 2. memory harvest of the same session (fake LLM, real verifier/store) ----
const memoryDir = join(projectRoot, 'memory');
const skillsDir = join(projectRoot, 'skills');
const harvestData = join(projectRoot, 'memory-harvest');
mkdirSync(harvestData, { recursive: true });
writeFileSync(join(harvestData, '.retired.json'), JSON.stringify([sessionId]), 'utf8');
const successSeq = endSeq - 0.1;
const memTools = new Map();
const memoryCtx = {
  paths: { data: memoryDir },
  tools: { register: (definition) => memTools.set(definition.name, definition) },
  sessionQuery: { readSession: async () => log },
  get: (name) => (name === 'llm'
    ? { async *stream() {
        yield { type: 'text-delta', text: JSON.stringify({
          facts: [{ text: '数据库连接返回了结果', seq: successSeq, scene: 'database' }],
          experiences: [],
          negatives: [],
          skills: [{
            name: 'db-shape-' + sessionId,
            title: '数据库连接形态',
            description: '数据库连接与查询。',
            when_to_use: '当需要连接数据库并查询时',
            scope: 'project',
            scene: 'database',
            aliases: ['连数据库'],
            steps: ['建立连接', '执行查询'],
            verify: ['返回预期结果'],
            evidence: [successSeq],
          }],
        }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } }
    : undefined),
};
memoryIndex.apply(memoryCtx, { graftDataDir: harvestData, memoryDir, skillsDir, extractor: 'llm', autoApprove: true });
const harvestReport = await memTools.get('memory_harvest').execute({});
const harvestedStatus = harvestReport.harvested[0]?.skills?.[0]?.status ?? 'none';

// ---- 3. lock lease across the renewal interval ----
const leaseTarget = join(projectRoot, 'lease.txt');
const release = acquireFileLock(leaseTarget, { leaseMs: 100, staleMs: 5000, silent: true });
const ownerPath = join(leaseTarget + '.lock', 'owner');
const first = JSON.parse(readFileSync(ownerPath, 'utf8'));
await new Promise((resolve) => setTimeout(resolve, 180));
const renewed = JSON.parse(readFileSync(ownerPath, 'utf8'));
release();
const leaseRenewed = renewed.at > first.at && renewed.token === first.token;

// ---- 4. scene routing against the harvested store ----
const dbQuery = retrieveLib.retrieve(memoryDir, skillsDir, '数据库连接 查询', { threshold: 0.1 });
const uiQuery = retrieveLib.retrieve(memoryDir, skillsDir, '界面 组件 样式', { threshold: 0.1 });
const sceneDb = dbQuery.skill !== undefined;
const sceneUiLeak = uiQuery.skill !== undefined;

const skillText = (() => { try { return readFileSync(join(skillsDir, 'db-shape-' + sessionId, 'SKILL.md'), 'utf8') } catch { return '' } })();
const evidenceOwn = skillText.includes(sessionId + '@');

process.stdout.write(JSON.stringify({
  sessionId, nudged, sliced: report.ok === true, bootstrap, artifactReused,
  leaseRenewed, sceneDb, sceneUiLeak, evidenceOwn, harvestedStatus,
}) + '\\n');
`

const startAt = Date.now() + 1200
const projects = ['project-a', 'project-b', 'project-c'].map((name, index) => ({
  name,
  root: join(root, name),
  sessionId: `session-${name}`,
}))

const run = (project) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, '.child.mjs'), project.root, project.sessionId, String(startAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('exit', (code) => {
      const line = out.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      let parsed
      try { parsed = line === undefined ? undefined : JSON.parse(line) } catch { parsed = undefined }
      resolve({ project, code, parsed, err: err.trim().split(/\r?\n/u).slice(-8).join(' | ') })
    })
  })

writeFileSync(join(root, '.child.mjs'), childSource, 'utf8')
const results = await Promise.all(projects.map(run))

let failures = 0
const check = (ok, detail) => {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${detail}\n`)
}
process.stdout.write(`\n[e2e] root: ${relative(process.cwd(), root) || root}\n`)
for (const { project, code, parsed, err } of results) {
  process.stdout.write(`  ${project.name} exit=${code} ${parsed === undefined ? `stderr=${err}` : JSON.stringify(parsed)}\n`)
}
const ok = (key) => results.every((item) => item.parsed?.[key] === true)
check(results.every((item) => item.code === 0 && item.parsed !== undefined), 'all three project processes finished cleanly')
check(ok('nudged'), 'all three hit the 70% model-driven nudge')
check(ok('sliced'), 'all three completed their own self-slice')
check(ok('bootstrap'), 'all three targets carry the self-continuation bootstrap')
check(ok('artifactReused'), 'all three targets name the written artifact for reuse')
check(ok('leaseRenewed'), 'lock leases renewed while held in all three')
check(ok('sceneDb'), 'scene routing activates the database skill for a database query')
check(results.every((item) => item.parsed?.sceneUiLeak === false), 'scene routing hides the database skill from a UI query')

for (const project of projects) {
  let retired = []
  try { retired = JSON.parse(readFileSync(join(project.root, 'graft', '.retired.json'), 'utf8')) } catch {}
  check(
    retired.length === 1 && retired[0] === project.sessionId,
    `${project.name} ledger contains exactly its own source (${retired.join(',') || 'none'})`,
  )
  const audit = (() => {
    try { return readFileSync(join(project.root, 'graft', '.graft-audit.jsonl'), 'utf8') } catch { return '' }
  })()
  check(audit.includes('model-nudge'), `${project.name} audit recorded the nudge`)
}

check(results.every((item) => item.parsed?.evidenceOwn === true), 'every skill cites its own session id in evidence (no cross-project mix-up)')
process.stdout.write(`\n[e2e] ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)