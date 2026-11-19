/**
 * ── v250 (B4-0a①): 插件通知绝不许冒充「用户说的话」 ──────────────────────────────────────────
 *
 * 用户的**第一条硬约束**就是这一条：「绝对禁止用 user/message 的壳子去装 developer 的灵魂」。
 * B4 审计发现它在这三个站点被违反了（都是**消息**、都携带**指令**）：
 *
 *   · `src/index.ts` 继承约束：`[系统提示] 这个会话从旧会话继承了以下长期约束，请在整个会话中遵守：`
 *     → 曾写 `source: { kind: 'user' }`
 *   · `src/index.ts` 草稿合并：`[系统提示：用户在上一个会话被拦截前，正在输入：「…」]`
 *     → 曾写 `source: { kind: 'user' }`
 *   · `src/core/ignition.ts` 回滚通知：`[dsh-graft-slice 回滚] …` → 曾写 `source: { kind: 'user' }`
 *
 * ── 为什么这比「措辞不好」严重 ──────────────────────────────────────────────────────────────
 *
 * `isHumanAuthored(source)` 只认 `kind === 'user'`（`core/message-source.ts`）。被标成 user 之后，
 * 下一条切片的 `userTexts` 会把它当**人类回合**收进去，于是下一代带子里它出现在【用户…】下 ——
 * 而它是一段插件写的指令。**每代放大一次**，且读者无从分辨。
 *
 * ── 宿主约束 ≠ 红线违背（必须分清，否则「修」会把 285 个会话弄坏） ────────────────────────────
 *
 * `session/title` 的 `source.kind: 'user'` 是**宿主强制**的（空 refs 只有 `kind:'user'` 能加载，
 * `core/host-shape.ts` 记着「写 fallback 让 285 个会话打不开」）。它不是消息，也不携带注入文本，
 * 所以本文件对 `session/title` **放行**。`role: 'user'` 本身也不改：宿主只要求 developer 角色配
 * `developer/message` 事件，没要求插件冒充人类 —— **归属**由 `source.kind` 说，不由 `role` 说。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply,
  buildTape,
  GRAFT_REPLAY_SOURCE_KIND,
  isGraftAuthored,
  isHumanAuthored,
  locateBoundary,
  resetRetiredSessions,
  rollbackFailedIgnition,
  ROLLBACK_NOTICE_MARKER,
  takeRollbackNotice,
} from '../index.js'
import { FakePersistence, makeCtx, makeSourceLog } from './fake-harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** Every `.ts` under `src/`, recursively. */
function allModules(dir = SRC, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...allModules(join(dir, entry.name), rel))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

const MARKERS = ['[系统提示', '[dsh-graft-slice']

// ── ① 静态判据：携带指令的 user 消息，来源不许是 'user' ──────────────────────────────────────

test('v250 ①: 静态扫描 —— 凡 `source: { kind: \'user\' }` 的**消息**，其邻近文本不得含插件提示前缀', () => {
  const offenders = []
  for (const rel of allModules()) {
    const text = readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/gu, '\n')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (!/source: \{ kind: 'user' \}/u.test(line)) return
      /**
       * 40 lines of context backwards. Narrow on purpose: it is enough to see the message text this
       * object belongs to, and small enough that a neighbouring legitimate site (a `session/title`
       * append a few screens above) cannot mask a real offender.
       */
      const context = lines.slice(Math.max(0, index - 40), index + 1).join('\n')
      /** `session/title` is HOST-CONSTRAINED, not plugin-authored: it is not a message and carries
       *  no instruction. Excluded by the same evidence the audit used. */
      if (/'session\/title'/u.test(context)) return
      const marker = MARKERS.find((needle) => context.includes(needle))
      if (marker === undefined) return
      offenders.push(`${rel}:${index + 1} 携带 ${marker} 却标了 source.kind='user'`)
    })
  }
  assert.deepEqual(offenders, [], `插件通知不许冒充用户：\n  ${offenders.join('\n  ')}`)
})

// ── ② 行为判据：三个生产者各自的来源 ────────────────────────────────────────────────────────

test(`v250 ②: 回滚通知**经生产路径**送达，source.kind 是插件 kind，且仍被 isGraftAuthored 认出`, async () => {
  resetRetiredSessions()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v250-rollback-'))
  const log = makeSourceLog({ turns: 1 })
  const ctx = makeCtx({ sourceLog: log, persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir, igniteTarget: false })

  /** 没有回滚就没有通知 —— 先钉住「拿不到就说拿不到」。 */
  assert.equal(
    takeRollbackNotice('agent-under-test', GRAFT_REPLAY_SOURCE_KIND),
    undefined,
    '没有被拦截的点火就没有通知',
  )

  /**
   * ── 必须走**生产路径**，不许在测试里自己把常量传进去 ────────────────────────────────────────────
   *
   * 第一版是「排一次回滚，然后自己调 `takeRollbackNotice(id, GRAFT_REPLAY_SOURCE_KIND)`」。它能证明
   * 函数怎么处理**收到**的 kind，却证明不了 `index.ts` 那个调用点**传了**什么：把调用点改成 `'user'`
   * 之后四条全绿（本轮实测）。那正是「测试全绿、生产路径没接」的形状，与 v243 那条同族。
   *
   * 所以这里只做一件事：真的排一条回滚，然后**驱动真实注册的 `agent/pre-step` 监听器**，看它投影出
   * 来的那条消息署名给谁。调用点传错常量，这里立刻红。
   */
  await rollbackFailedIgnition(ctx, log.session.id, 'v250-rollback-target', 'no channel')

  const listeners = ctx._listeners.get('agent/pre-step') ?? []
  assert.ok(listeners.length > 0, 'pre-step 监听器必须已注册')
  const dispatch = async () => {
    const produced = []
    for (const listener of listeners) {
      produced.push(
        await listener({ agent: { id: log.session.id }, messages: [], turn: 1, step: 1 }, () => ({ kind: 'enter', messages: [] })),
      )
    }
    return produced
      .flatMap((result) => (result !== null && typeof result === 'object' && Array.isArray(result.messages) ? result.messages : []))
      .filter((message) => JSON.stringify(message).includes(ROLLBACK_NOTICE_MARKER))
  }

  const delivered = await dispatch()
  assert.ok(
    delivered.length > 0,
    '回滚通知必须真的经 pre-step 送达 —— 否则这条测试测的是一个空集合',
  )
  for (const message of delivered) {
    assert.equal(message.source?.kind, GRAFT_REPLAY_SOURCE_KIND, '生产路径必须把来源署名成插件')
    assert.equal(isGraftAuthored(message.source), true, '插件消息必须被认作插件写的')
    assert.equal(isHumanAuthored(message.source), false, '绝不能被认作人类说的')
  }
  /** TAKE 语义：同一个 source 只送一次，否则每步都会重提「刚才失败了」。 */
  assert.deepEqual(await dispatch(), [], '第二次 pre-step 不许再送一条')

  /** 静态兜底：生产者不得硬编码 'user'，来源必须由调用方注入。 */
  const source = readFileSync(join(SRC, 'core', 'ignition.ts'), 'utf8')
  const producer = source.slice(
    source.indexOf('export function takeRollbackNotice'),
    source.indexOf('export const ROLLBACK_NOTICE_MARKER'),
  )
  assert.doesNotMatch(producer, /kind: 'user'/u, '回滚通知不许写成 source.kind=user')
  assert.match(producer, /source: \{ kind: graftSourceKind \}/u, '来源必须由调用方注入')
  resetRetiredSessions()
})

test('v250 ②b: 继承约束与草稿合并的注入事件，来源不是 user（走真实 pre-step 路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v250-pre-'))
  writeFileSync(
    join(dir, '.pending-constraints.json'),
    JSON.stringify([{ targetId: 'agent-redline', sourceSessionId: 'src', constraints: ['绝对不能在没备份的情况下删除账本文件。'], extractedAt: 1 }], null, 2),
    'utf8',
  )
  const ctx = makeCtx({ sourceLog: makeSourceLog({ turns: 2 }), persistence: new FakePersistence(), paths: { data: dir } })
  apply(ctx, { dataDir: dir })

  const listeners = ctx._listeners.get('agent/pre-step') ?? []
  assert.ok(listeners.length > 0, 'pre-step 监听器必须已注册')
  const produced = []
  for (const listener of listeners) {
    const result = await listener({ agent: { id: 'agent-redline' }, messages: [], turn: 1, step: 1 }, () => ({ kind: 'enter', messages: [] }))
    produced.push(result)
  }
  const serialized = JSON.stringify(produced)
  assert.ok(serialized.includes('绝对不能在没备份'), `约束必须送达（否则这条测试测的是空）：${serialized.slice(0, 400)}`)

  /** The message that carries the inherited constraints must NOT claim a human source. */
  const messages = produced
    .flatMap((result) => (result !== null && typeof result === 'object' && Array.isArray(result.messages) ? result.messages : []))
    .filter((message) => JSON.stringify(message).includes('这个会话从旧会话继承了以下长期约束'))
  assert.ok(messages.length > 0, `必须找到那条继承约束消息：${serialized.slice(0, 400)}`)
  for (const message of messages) {
    assert.notEqual(message.source?.kind, 'user', `继承约束不许标成用户写的：${JSON.stringify(message.source)}`)
    assert.equal(isHumanAuthored(message.source), false, 'isHumanAuthored 必须为 false —— 它决定了下一代会不会重放')
    assert.equal(isGraftAuthored(message.source), true, '必须能被认出是本插件写的')
  }
})

// ── ③ 跨代判据：带子里不许出现这条指令的【用户】行 ──────────────────────────────────────────

test('v250 ③: 标了插件来源的提示消息，下一代的带子里不会成为【用户】文本（反过来会）', () => {
  /**
   * `buildTape` collects USER turns with `isHumanAuthored`-equivalent filtering. The pair of tapes
   * below is the whole argument: the SAME message text, two source kinds, two outcomes. Without the
   * second half this test would pass for any filtering at all — including one that drops real user
   * turns, which would be a far worse bug than the one being fixed.
   */
  const MARKER_TEXT = '[系统提示] 这个会话从旧会话继承了以下长期约束，请在整个会话中遵守：1. 绝对不能在没备份的情况下删除账本文件。'

  /**
   * The SAME log, with the SAME text on a user/message, differing ONLY in `data.source.kind` —
   * which is where `buildTape` reads attribution (`typeof event.data?.source?.kind`). Turning a real
   * user turn into a plugin-authored one is the exact shape the fix produces in the wild.
   */
  const build = (kind) => {
    const log = makeSourceLog({ turns: 2 })
    const userEvent = log.events.find((event) => event.type === 'user/message')
    assert.ok(userEvent !== undefined, '夹具必须有一条 user/message，否则这条测试测不到归属')
    userEvent.data = {
      ...userEvent.data,
      source: { kind },
      /** The payload's own shape: `data.content` is what `textOfMessage` reads. */
      content: [{ type: 'text', text: MARKER_TEXT }],
    }
    const boundary = locateBoundary(log.events)
    return buildTape(log.events, boundary, {}, 'session-source')
  }

  const asPlugin = JSON.stringify(build('plugin:graft-replay'))
  assert.equal(asPlugin.includes(MARKER_TEXT), false,
    '插件署名的提示不许出现在下一代带子里 —— 它会被当成【用户】原话重放')

  const asUser = JSON.stringify(build('user'))
  assert.ok(asUser.includes(MARKER_TEXT),
    '对照组：标成 user 时它确实进带子 —— 否则这条测试证明的不是「来源决定去留」')
})