/**
 * v0.17: host noise must not cross into a migrated session.
 *
 * The audit finding: a tape carried the machine's own paths — `C:\Users\<user>\
 * AppData\...`, `/home/...`, `/tmp/...` — and the output of a filesystem sweep of
 * a drive root. The workspace red line tells a model not to go there; this stops
 * the tape from *showing* it the way, and from teaching it that the profile
 * directory is part of its workspace.
 *
 * The two rules are asserted separately, because the interesting half is the one
 * that must NOT drop: a paragraph that mentions a host path AND project work has
 * to keep the work.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FOLDED_OUTPUT_MARKER,
  HOST_NOISE_MARKER,
  HOST_PATH_MARKER,
  apply,
  stripHostNoise,
} from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const CWD = 'D:\\workspace'

test('v0.17: a paragraph made only of host paths is replaced by a marker, never silently dropped', () => {
  const text = [
    '## 构建日志',
    '',
    'C:\\Users\\xxx\\AppData\\Roaming\\dsh-desktop\\logs\\main.log: 17:22 挂载失败',
    '',
    '这时我把 build.mjs 里的 banner 修好了。',
  ].join('\n')
  const cleaned = stripHostNoise(text, CWD)
  assert.doesNotMatch(cleaned, /C:\\Users/u)
  assert.doesNotMatch(cleaned, /AppData/u)
  assert.match(cleaned, /宿主环境噪音，已过滤/u, 'the reader learns something was elided')
  assert.match(cleaned, /build\.mjs/u, 'unrelated paragraphs are untouched')
})

test('v0.17: a paragraph with host noise AND project work keeps the work, redacting only the tokens', () => {
  const text = '我改了 D:\\workspace\\dsh-memory\\src\\store.ts，日志落在 C:\\Users\\xxx\\AppData\\Local\\Temp\\x.log'
  const cleaned = stripHostNoise(text, CWD)
  assert.match(cleaned, /dsh-memory\\src\\store\.ts/u, 'the project path survives — dropping it would lose real work')
  assert.doesNotMatch(cleaned, /C:\\Users/u)
  assert.match(cleaned, /宿主路径已过滤/u)
  assert.doesNotMatch(cleaned, /宿主环境噪音/u, 'this paragraph was not replaced wholesale')
})

test('v0.17: the other host shapes are recognised too', () => {
  for (const noise of [
    '/home/xxx/.cache/pip/log.txt',
    '/tmp/dsh-1234/session.json',
    '%APPDATA%\\dsh-desktop\\logs',
    '$env:LOCALAPPDATA\\Temp\\x',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
  ]) {
    const cleaned = stripHostNoise(`无关段落一\n\n${noise}: 出事\n\n无关段落二`, CWD)
    assert.doesNotMatch(cleaned, /\/home\/|\/tmp\/|%APPDATA%|\$env:LOCALAPPDATA|C:\\Windows/u, `leaked: ${noise}`)
    assert.match(cleaned, /宿主环境噪音，已过滤/u)
  }
})

test('v0.17: a drive-root sweep is folded, but a workspace search is left alone', () => {
  const sweep = [
    'PS> Get-ChildItem -Path C:\\ -Recurse -Force | Select-Object FullName',
    'Directory: C:\\',
    'Mode  LastWriteTime  Name',
  ].join('\n')
  const folded = stripHostNoise(`前面的结论\n\n${sweep}\n\n后面的结论`, CWD)
  assert.match(folded, /命令输出已折叠/u)
  assert.doesNotMatch(folded, /Get-ChildItem/u, 'the sweep command line is gone too')
  assert.match(folded, /前面的结论/u)
  assert.match(folded, /后面的结论/u)

  const local = 'PS> rg TODO src/ --line-number\nsrc/index.ts:42: TODO fix'
  assert.equal(stripHostNoise(local, CWD), local, 'a search inside the workspace is ordinary work')

  const sweepWithProject = 'Get-ChildItem -Path C:\\ -Recurse | Select-String D:\\workspace\\src\\index.ts'
  const kept = stripHostNoise(sweepWithProject, CWD)
  /**
   * `CWD` is `D:\workspace`, so the assertion names the SAME string the fixture uses. It used to spell the
   * author's real directory; the rule being tested is "a path inside the project is kept", not "this exact
   * directory name survives".
   */
  assert.match(kept, /workspace/u, 'when the sweep names a file INSIDE this project, the finding is kept')
  assert.doesNotMatch(kept, /C:\\/u, 'and the root it was sweeping is still redacted')
  // A bare project NAME is not a project path: the rule is about paths, and the
  // output of a whole-volume sweep is worthless either way.
  assert.equal(stripHostNoise('Get-ChildItem -Path C:\\ -Recurse | Select-String workspace', CWD), FOLDED_OUTPUT_MARKER)
})

test('v0.17 ACCEPTANCE: a sliced log carrying AppData produces no such path in the target', async () => {
  const log = makeSourceLog({ turns: 4, sourceSessionId: 'session-noise-source', cwd: CWD })
  const HOST_PATH = 'C:\\Users\\xxx\\AppData\\Roaming\\dsh-desktop\\logs\\main.log'
  // Put the noise where it actually came from in the audit: a tool result and an
  // assistant conclusion.
  const assistant = log.events.find((event) => event.type === 'assistant/message')
  assistant.data.message.content[0].text += `\n\n日志在 ${HOST_PATH}：挂载失败，看起来是沙箱拒绝。`
  const toolResult = log.events.find((event) => event.type === 'tool/result')
  toolResult.data.message.content[0].text = `PS> Get-ChildItem -Path C:\\ -Recurse\n${HOST_PATH}`

  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  const report = await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-noise-target' }, {})
  assert.equal(report.ok, true)

  const stored = ctx._persistence.read('session-noise-target')
  const everything = JSON.stringify(stored.events)
  // The assertion targets the PATH, not the word: the workspace red line itself
  // legitimately says "…针对 C 盘、AppData 或全局根目录的搜索…", and the guard is not
  // noise. What must not survive is a resolvable host location.
  assert.doesNotMatch(everything, /C:\\\\+Users/u, 'no host profile path in the injected target')
  assert.doesNotMatch(everything, /AppData\\\\+/u, 'no AppData path either')
  assert.doesNotMatch(everything, /dsh-desktop\\\\+logs/u)
  assert.match(everything, /宿主环境噪音，已过滤|宿主路径已过滤|命令输出已折叠/u, 'and the elision is declared')

  // The pending state specifically, which is what the audit named.
  const pending = stored.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => JSON.stringify(event.data))
    .join('\n')
  assert.doesNotMatch(pending, /C:\\\\+Users/u)
  assert.doesNotMatch(pending, /AppData\\\\+/u)
})

test('v0.17: the workspace index is filtered too (a host path there would claim to be a deliverable)', async () => {
  const log = makeSourceLog({ turns: 3, sourceSessionId: 'session-noise-source-2', cwd: CWD })
  const writeCall = log.events.find((event) => event.type === 'tool/call' && event.data?.name === 'write')
  if (writeCall !== undefined) {
    writeCall.data.arguments = JSON.stringify({ file_path: 'C:\\Users\\xxx\\AppData\\Roaming\\dsh-desktop\\notes.md' })
  }
  const ctx = makeCtx({ sourceLog: log })
  apply(ctx, {})
  await ctx._tools
    .get('graft_slice_and_inject')
    .execute({ sourceSessionId: log.session.id, newSessionId: 'session-noise-target-2' }, {})
  const stored = ctx._persistence.read('session-noise-target-2')
  const everything = JSON.stringify(stored.events)
  assert.doesNotMatch(everything, /C:\\\\+Users/u)
  assert.doesNotMatch(everything, /AppData\\\\+/u)
  assert.doesNotMatch(everything, /notes\.md/u, 'the host-path "deliverable" is gone rather than listed')
})

void HOST_NOISE_MARKER
void HOST_PATH_MARKER
void FOLDED_OUTPUT_MARKER
