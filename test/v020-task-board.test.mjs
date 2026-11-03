/**
 * v0.20 — the TASK BOARD, and the ignition prompt that points at it.
 *
 * v0.19 distilled the tape correctly but rendered it as prose. A model reading
 * prose has to DERIVE the board — what is done, what is running, what has not
 * started — and that derivation is exactly where a resumed session drifts into
 * re-doing finished work.
 *
 * What these tests hold:
 *   1. the four columns exist, in reading order, with the right content;
 *   2. 进行中 is a real column (work started, not finished) and never collapsed
 *      into 待开始 or 已完成;
 *   3. an empty column is STATED, not omitted;
 *   4. the board points at the read-back tool, because it hands out seq numbers;
 *   5. the ignition prompt tells the target to ignore the old log's temporary
 *      errors and to execute the 待开始 column.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BOARD_TRAILER,
  DEFAULT_IGNITION_PROMPT,
  extractSemanticState,
  buildIgnitionPrompt,
  IGNITION_MARKER,
  INSTRUCTION_CARD_MAX_CHARS,
  normalizeConfig,
  renderInstructionCard,
  renderTaskBoard,
} from '../index.js'

const emptyDiscard = { errorBodies: 0, resolvedErrors: 0, narrationChars: 0, pointerLines: 0 }

function board(overrides = {}) {
  return renderTaskBoard({
    request: '把两个插件升级到 v0.20 并跑通全量测试',
    pending: ['提交并推送两个仓库'],
    stopPoint: { turn: 9, boundarySeq: 240 },
    sourceSessionId: 'session-source',
    pointerCount: 12,
    discarded: emptyDiscard,
    ...overrides,
  })
}

test('v0.20: the board has four labelled columns in reading order', () => {
  const text = board({
    outcome: { kind: 'commit', text: 'git commit abc1234 成功', seq: 88, tool: 'pwsh' },
    inProgress: '正在改 retrieve.ts 的任务对齐过滤',
  })
  assert.match(text, /^## 交接任务看板/u)
  const labels = ['原始用户要求', '✅ 已完成', '🔄 进行中', '⏭️ 待开始']
  const positions = labels.map((label) => text.indexOf(label))
  assert.ok(positions.every((at) => at >= 0), `missing column: ${JSON.stringify(positions)}`)
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'columns are out of order')

  assert.match(text, /\*\*原始用户要求\*\*：把两个插件升级到 v0\.20/u)
  assert.match(text, /✅ 已完成\*\*\n- git commit abc1234 成功（seq=88）/u)
  assert.match(text, /🔄 进行中\*\*\n- 正在改 retrieve\.ts/u)
  assert.match(text, /⏭️ 待开始\*\*\n- 提交并推送两个仓库/u)
})

test('v0.20: 进行中 is its own column, never folded into done or todo', () => {
  const text = board({ inProgress: '正在跑 graft 的全量测试' })
  const doing = text.slice(text.indexOf('🔄 进行中'), text.indexOf('⏭️ 待开始'))
  const todo = text.slice(text.indexOf('⏭️ 待开始'))
  assert.match(doing, /正在跑 graft 的全量测试/u)
  assert.doesNotMatch(todo, /正在跑 graft 的全量测试/u, 'in-flight work must not read as not-started')
  const done = text.slice(text.indexOf('✅ 已完成'), text.indexOf('🔄 进行中'))
  assert.doesNotMatch(done, /正在跑 graft 的全量测试/u, 'in-flight work must not read as finished')
})

test('v0.20: an empty column is stated, not omitted', () => {
  // The board helper carries one pending item, so 待开始 is non-empty by default.
  const text = board()
  // A missing column reads as "unknown"; an explicit "none" reads as a fact.
  assert.match(text, /✅ 已完成\*\*\n- 尚无已经验证完成的收尾动作/u)
  assert.match(text, /🔄 进行中\*\*\n- 无（断点落在一个已闭合的轮次之间）/u)
  assert.match(text, /⏭️ 待开始\*\*\n- 提交并推送两个仓库/u)

  // With no written plan either, the column still names an action — the board must
  // never be inert.
  const bare = board({ pending: [] })
  assert.match(bare, /⏭️ 待开始\*\*\n- 按上面的「原始用户要求」继续推进/u)
})

test('v0.20: the board hands out seqs, so it names the tool that opens them', () => {
  const text = board()
  assert.match(text, /graft_read_result\(sourceSessionId="session-source", seq=/u)
  assert.match(text, /graft_search_history/u)
  assert.match(text, /不要靠猜/u)
  // No pointers means nothing to read back, so the line must not appear.
  const bare = board({ pointerCount: 0, sourceSessionId: undefined })
  assert.doesNotMatch(bare, /graft_read_result/u)
})

test('v0.20: the blocker is one line with a seq and a do-not-chase-otherwise note', () => {
  const text = board({
    unresolvedError: { text: 'Cannot find module left-pad', seq: 41, tool: 'pwsh' },
  })
  assert.match(text, /唯一未决阻塞\*\*：pwsh 失败：Cannot find module left-pad（原文 seq=41/u)
  assert.match(text, /只有后续工作确实卡在它上面时才去读/u)
})

test('v0.20: the board tells the reader to ignore the old log and run the todo column', () => {
  const text = board()
  assert.ok(text.includes(BOARD_TRAILER), 'the trailer is the board contract')
  assert.match(text, /旧会话的历史执行日志和临时错误无需理会/u)
  assert.match(text, /请直接执行上面「⏭️ 待开始」里的待办项/u)
})

test('v0.20: the slimming disclosure counts what was actually dropped', () => {
  const text = board({
    discarded: { errorBodies: 2, resolvedErrors: 3, narrationChars: 812, pointerLines: 4 },
  })
  assert.match(text, /已按语义瘦身/u)
  assert.match(text, /3 条已解决的报错/u)
  assert.match(text, /2 段报错正文（只保留一行摘要）/u)
  assert.match(text, /812 字符中间叙述/u)
  assert.match(text, /4 行过程指针/u)
  // Nothing dropped => no disclosure line at all (a "丢弃 0 段" line trains the
  // reader to skip the one line that says slimming happened).
  assert.doesNotMatch(board(), /已按语义瘦身/u)
})

test('v0.20: the board stays inside its budget', () => {
  const text = board({
    request: '很长的需求'.repeat(200),
    pending: Array.from({ length: 20 }, (_value, index) => `第 ${index} 项待办事项，描述略长一些`),
    outcome: { kind: 'commit', text: 'git commit abc1234 成功', seq: 1, tool: 'pwsh' },
    inProgress: '正在进行中的工作描述'.repeat(50),
    discarded: { errorBodies: 9, resolvedErrors: 9, narrationChars: 9999, pointerLines: 9 },
  })
  assert.ok(text.length <= INSTRUCTION_CARD_MAX_CHARS, `board was ${text.length} chars`)
  // Truncation is DECLARED, never silent.
  if (text.includes('看板已到上限')) assert.match(text, /细节按 seq 回读/u)
})

test('v0.20: the ignition prompt names the board and relieves the old errors', () => {
  const prompt = buildIgnitionPrompt(normalizeConfig({}))
  assert.ok(prompt.startsWith(IGNITION_MARKER))
  assert.match(prompt, /旧会话的历史执行日志和临时错误无需理会/u)
  assert.match(prompt, /请直接执行看板中「⏭️ 待开始」里的待办项/u)
  assert.equal(DEFAULT_IGNITION_PROMPT, prompt, 'the default is what ships')
  // A custom prompt is still marked, and the safety text is the operator's choice.
  const custom = buildIgnitionPrompt(normalizeConfig({ ignitionPrompt: '继续' }))
  assert.ok(custom.startsWith(IGNITION_MARKER))
  assert.ok(custom.includes('继续'))
})

test('v0.20: renderInstructionCard IS the board — one renderer, no drift', () => {
  const card = renderInstructionCard({
    semantic: extractSemanticState([]),
    body: '',
    request: '跑通测试',
    pending: ['提交'],
    stopPoint: {},
    pointerCount: 0,
  })
  assert.match(card, /^## 交接任务看板/u)
  assert.match(card, /旧会话的历史执行日志和临时错误无需理会/u)
})
