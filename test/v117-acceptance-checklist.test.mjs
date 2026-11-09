/**
 * THE ACCEPTANCE CHECKLIST AS A TEST — the instruction's §七 items that are cheap and stable.
 *
 * Each item here is one the instruction says must be able to go RED, so each is stated as a property
 * of the shipped build rather than as a transcript of a probe run.
 *
 * Deliberately NOT included: the guard (D-family) items. Those describe a proposal that is registered
 * as TD-17 and waits for a ruling; asserting the fixed behaviour here would be a failing test for code
 * that is not shipped. Their CURRENT numbers are printed by `_acceptance.mjs` and quoted in the report.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { renderTaskBoard } from '../index.js'
import { shapeOfConstraint } from '../src/core/constraint-shape.ts'

const REAL_SEVEN = [
  '绝对禁止用 user/message 的壳子去装 developer 的灵魂。',
  "若 harvest 改走 session event，必须遵守红线 2/3（role:'user' + [系统提示] 前缀）。",
  '- 必须、禁止、绝对、不能、不得、不许、务必',
  '- must / never / forbidden / required / cannot / do not',
  '"绝对约束（后续所有轮次都不能违反）：",',
  '"1. 绝对不能 import re，也不能以任何方式使用正则表达式。',
  '| 2 | 4 | Information | Never include my name in your replies or in any tool call. |',
]

test('inheritance: the 7 live fragments reduce to the 2 genuine rules, and every rejection has a code', () => {
  const kept = REAL_SEVEN.filter((text) => !shapeOfConstraint(text).broken)
  const rejected = REAL_SEVEN.map((text) => shapeOfConstraint(text)).filter((verdict) => verdict.broken)

  assert.equal(kept.length, 2, `expected the 2 genuine rules to survive, got ${kept.length}`)
  assert.equal(rejected.length, 5, 'expected the 5 structural fragments to be rejected')
  // "不许静默丢弃": a rejection without a code is a silent drop.
  for (const verdict of rejected) {
    assert.equal(typeof verdict.code, 'string', 'every rejection must carry a stable code')
    assert.equal(typeof verdict.why, 'string', 'every rejection must say what structure was seen')
  }
})

test('inheritance: the control sentence is still accepted (a rule that kills it is the wrong rule)', () => {
  const control = '绝对约束：禁止在没有备份的情况下删除任何脚本，这条永远有效。'
  assert.equal(shapeOfConstraint(control).broken, false)
})

test('inheritance: a long real request is not mistaken for a fragment', () => {
  const request =
    '阶段 6 请把看板五处缺陷修掉：报告不该被当成要求，一处数字不该有两个名词，截断必须留下标记，' +
    '重复的列要显式说明而不是删掉，已完成的交付不能被渲染成「尚无」。'
  assert.equal(shapeOfConstraint(request).broken, false)
})

test('board: the requirement and 进行中 no longer duplicate each other', () => {
  const report = '这是 dsh 的报告：\n三项验收交付完毕。\n## 一、更正\n我自己实测确认。'
  const text = renderTaskBoard({
    request: report,
    inProgress: report,
    pending: ['x'],
    hasWrittenPlan: true,
    stopPoint: { turn: 9, boundarySeq: 811 },
    sourceSessionId: 'src',
    pointerCount: 811,
    discarded: { text: [], excluded: [] },
  })
  const lines = text.split('\n')
  const heading = lines.findIndex((line) => line.includes('进行中'))
  const body = (lines.slice(heading + 1).find((line) => line.trim().startsWith('-')) ?? '').replace(/^-\s*/u, '')
  assert.doesNotMatch(body, /^这是 dsh 的报告/u, 'the duplicate column must be named as a duplicate, not reprinted')
})

test('board: the two pointer counts carry two names', () => {
  const text = renderTaskBoard({
    request: '正常要求',
    pending: ['x'],
    stopPoint: { turn: 1, boundarySeq: 5 },
    sourceSessionId: 'src',
    pointerCount: 811,
    discarded: { text: [], excluded: [] },
  })
  assert.match(text, /本索引列出可回读指针\s*811\s*处/u)
  assert.match(text, /另有用户原话可按 seq 回读/u, 'the second count must be named, or the reader cannot tell them apart')
})

test('bundle: no real session ids, no contract metadata (E1 regression guard)', () => {
  const bundle = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal((bundle.match(/session-[0-9a-f]{8}/gu) ?? []).length, 0, 'a real session id reached the artifact')
  assert.doesNotMatch(bundle, /\bnearMisses\b|\bALL_CONTRACTS\b/u, 'contract metadata reached the artifact')
})

test('bundle: shapeOfConstraint is declared exactly once', () => {
  const bundle = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const declarations = (bundle.match(/^function shapeOfConstraint\(/gmu) ?? []).length
  assert.equal(declarations, 1, 'one predicate, one declaration — a second copy is how the two-answers defect returns')
})
