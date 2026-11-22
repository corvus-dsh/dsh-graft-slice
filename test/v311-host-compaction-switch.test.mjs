/**
 * ── v311 / USER-REQUESTED (P0): 宿主自动压缩必须能从面板关掉，而且真的写对了行 ────────────────────
 *
 * 用户原话：**「在转生面板里加入开启/关闭宿主自动压缩功能按钮，但保留会话内调用压缩功能的能力。」**
 *
 * 在此之前，改 `compaction-basic` 的 `auto` 只有一条路：**改 profile patch 然后重启** ——
 * 正是 console 当初被造出来要消灭的那种死胡同。面板会警告「压缩开着」，然后不给任何去处。
 *
 * ── 这条判据真正防的是什么 ───────────────────────────────────────────────────────────────────────
 *
 * 不是「按钮有没有」，而是**写对了行没有**。`hostAutoCompaction` 是 console 里唯一一个不属于 graft
 * 配置的键；如果它走 `withConsoleSetting`（那条路径 spread graft 自己的行），就会写一个**成功回执**
 * 而**改变任何有意义的东西都没有** —— 与本批反复出现的那类缺陷完全同形。
 *
 * 判据：
 *   ① 写入落在 `compaction-basic` 那一行/那个 child 上，`auto` 变成目标值；
 *   ② 该 child 的**其它配置键原样保留**（不改不该改的）；
 *   ③ 负向：**不能**写到 graft 自己的行上（那条路必须不被走）；
 *   ④ 负向：取不到 configEditor / 找不到压缩行时**如实报错**，不静默成功。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, CONSOLE_HOST_COMPACTION_KEY, parseConsoleSetting, resetRetiredSessions } from '../index.js'

const COMPACTION = '@deepseek-ai/dsh-compaction-basic'

/** A configEditor that records every edit, and a loader that reports the given rows. */
function harness(rows) {
  const edits = []
  const editor = {
    entries: () => rows,
    async edit(entry, builder) {
      const current = entry?.options?.config ?? {}
      const next = builder(current)
      edits.push({ entry, next })
      entry.options = { ...(entry.options ?? {}), config: next }
    },
  }
  const tools = new Map()
  const commands = new Map()
  const commandService = { register: (definition) => commands.set(definition.name, definition) }
  const ctx = {
    get(name) {
      if (name === 'configEditor') return editor
      /**
       * `registerConsole` resolves the command service through `ctx.get('commands')` — NOT `ctx.commands`
       * (a spread cordis context does not carry service properties). A fixture that only sets
       * `ctx.commands` gets the 「ctx.commands unavailable」 warning and NO registered commands, which is
       * what the first version of this harness did: every write assertion then failed on a missing
       * command rather than on a wrong write.
       */
      if (name === 'commands') return commandService
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    tools: { register: (definition) => tools.set(definition.name, definition) },
    commands: commandService,
  }
  resetRetiredSessions()
  apply(ctx, {})
  return { ctx, edits, tools, commands }
}

/** The preset row shape `readCompactionMounts` walks: a group whose children carry plugin configs. */
function presetRow() {
  return {
    patchId: '@deepseek-ai/dsh-agent-preset',
    options: {
      config: {
        group: {
          children: [
            { name: '@deepseek-ai/dsh-session', config: { keep: 'me' } },
            { name: COMPACTION, config: { auto: true, thresholdRatio: 0.8, headroomTokens: 65536 } },
          ],
        },
      },
    },
  }
}

test('v311 ①: turning host auto-compaction OFF writes `auto:false` into the COMPACTION child', async () => {
  const row = presetRow()
  const { commands } = harness([row])

  // The console command is the shared implementation the panel's switch calls.
  const consoleCommand = commands.get('graft-console-set')
  assert.ok(consoleCommand !== undefined, 'graft-console-set 必须注册（面板与斜杠命令共用同一实现）')
  const result = await consoleCommand.handler({ rawInput: `${CONSOLE_HOST_COMPACTION_KEY} false` })

  const payload = typeof result === 'string' ? result : JSON.stringify(result)
  assert.match(payload, /已关闭宿主自动压缩|ok/iu,
    `回执必须说明做了什么；实测 ${payload.slice(0, 300)}`)

  const children = row.options.config.group.children
  const compaction = children.find((child) => child.name === COMPACTION)
  assert.equal(compaction.config.auto, false, 'auto 必须变成 false')
})

test('v311 ②: the sibling keys of that config are preserved verbatim', async () => {
  /**
   * A matching override REPLACES the whole config, so a builder that returned `{ auto: false }` alone would
   * silently drop `thresholdRatio` / `headroomTokens` — the values the ceiling is computed from. That is a
   * 「fixed the switch, broke the geometry」 failure and it would not show up until someone's window shrank.
   */
  const row = presetRow()
  const { commands } = harness([row])
  await commands.get('graft-console-set').handler({ rawInput: `${CONSOLE_HOST_COMPACTION_KEY} false` })

  const compaction = row.options.config.group.children.find((child) => child.name === COMPACTION)
  assert.equal(compaction.config.thresholdRatio, 0.8, 'thresholdRatio 必须原样保留')
  assert.equal(compaction.config.headroomTokens, 65536, 'headroomTokens 必须原样保留')

  // ...and the非-compaction sibling is untouched too.
  const session = row.options.config.group.children.find((child) => child.name === '@deepseek-ai/dsh-session')
  assert.deepEqual(session.config, { keep: 'me' }, '同组其它 child 必须原样保留')
})

test("v311 ③ (negative half): graft's OWN config row is never the write target", async () => {
  /**
   * The failure this rules out: `hostAutoCompaction` routed through `withConsoleSetting` would spread
   * graft's row and write `hostAutoCompaction: false` there — a receipt saying 「saved」, a compaction
   * plugin still auto-compacting, and a `graft_debug_status.config` carrying a key graft never reads.
   */
  const graftRow = { patchId: 'dsh-graft-slice', options: { config: { autoGraft: true } } }
  const row = presetRow()
  const { commands, edits } = harness([graftRow, row])
  await commands.get('graft-console-set').handler({ rawInput: `${CONSOLE_HOST_COMPACTION_KEY} false` })

  const touchedGraft = edits.some((edit) => edit.entry === graftRow)
  assert.equal(touchedGraft, false, 'graft 自己的配置行不得被这个键写入')
  assert.equal(graftRow.options.config.hostAutoCompaction, undefined,
    'graft 行上不得出现 hostAutoCompaction 键')
  assert.equal(graftRow.options.config.autoGraft, true, '而且不能顺手改掉别的键')
})

test('v311 ④: `hostAutoCompaction` parses as a boolean and rejects anything else', () => {
  const ok = parseConsoleSetting(`${CONSOLE_HOST_COMPACTION_KEY} true`)
  assert.equal(ok.setting?.value, true)
  const bad = parseConsoleSetting(`${CONSOLE_HOST_COMPACTION_KEY} 0.5`)
  assert.match(String(bad.error), /只接受 true \/ false/u, `非布尔值必须被拒；实测 ${JSON.stringify(bad)}`)
})

test('v311 ④b (negative half): no compaction row ⇒ an HONEST failure, not a silent success', async () => {
  /**
   * A host without the compaction plugin has nothing to switch. Returning success there would tell the
   * operator a change happened that could not have — the shape this batch keeps removing.
   */
  const { commands } = harness([{ patchId: 'dsh-graft-slice', options: { config: {} } }])
  const result = await commands.get('graft-console-set').handler({ rawInput: `${CONSOLE_HOST_COMPACTION_KEY} false` })
  const payload = typeof result === 'string' ? result : JSON.stringify(result)
  assert.match(payload, /找不到|不可用|失败/u, `必须如实报错；实测 ${payload.slice(0, 300)}`)
})
