/**
 * v0.18 module 1 — RISK is evidence, POLICY is the operator's table.
 *
 * The audit's point: `scanAgentCommand` was doing two jobs at once. It decided
 * what a command IS (a regex job, and regexes are fine at it) and whether to block
 * it (a policy job, which belongs in one table someone can read and change).
 *
 * These tests hold the split: the classifier is asserted on RISK alone, the table
 * on the mapping, and the tool guard on the fact that the CONFIGURED mode is what
 * the running system obeys.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  apply,
  classifyAgentCommand,
  evaluateCommandPolicy,
  normalizeConfig,
  policyDecision,
  resetRetiredSessions,
} from '../index.js'
import { makeCtx, makeSourceLog } from './fake-harness.mjs'

const WORKSPACE = 'D:\\持久层能力架构'
const GLOBAL_SEARCH = `rg pattern ${'/'}`
const RECURSIVE_DELETE_ROOT = ['Remove-Item', '-Recurse', 'C:\\'].join(' ')
const RECURSIVE_DELETE_UNPLACED = ['Remove-Item', '-Recurse', 'build'].join(' ')

test('v0.18: the classifier reports RISK and never a decision', () => {
  assert.equal(classifyAgentCommand('git status', WORKSPACE).risk, 'safe')
  assert.equal(classifyAgentCommand('npm test', WORKSPACE).risk, 'safe')
  assert.equal(classifyAgentCommand(GLOBAL_SEARCH, WORKSPACE).risk, 'destructive')
  assert.equal(classifyAgentCommand(GLOBAL_SEARCH, WORKSPACE).code, 'GLOBAL_SEARCH')
  assert.equal(classifyAgentCommand(RECURSIVE_DELETE_ROOT, WORKSPACE).risk, 'destructive')
  assert.equal(classifyAgentCommand(RECURSIVE_DELETE_ROOT, WORKSPACE).code, 'DESTRUCTIVE_COMMAND')
  // An unbounded verb whose target cannot be placed: risk is `unknown`, not `safe`.
  const unplaced = classifyAgentCommand(RECURSIVE_DELETE_UNPLACED, '')
  assert.equal(unplaced.risk, 'unknown')
  // Nothing in the assessment is a verdict.
  assert.equal('decision' in classifyAgentCommand('git status', WORKSPACE), false)
})

test('v0.18: the decision table is exactly what the modes promise', () => {
  assert.equal(policyDecision('safe', 'strict'), 'allow')
  assert.equal(policyDecision('safe', 'balanced'), 'allow')
  assert.equal(policyDecision('safe', 'autonomous'), 'allow')

  assert.equal(policyDecision('unknown', 'strict'), 'deny')
  assert.equal(policyDecision('unknown', 'balanced'), 'deny')
  assert.equal(policyDecision('unknown', 'autonomous'), 'allow')

  assert.equal(policyDecision('destructive', 'strict'), 'deny')
  assert.equal(policyDecision('destructive', 'balanced'), 'deny')
  // Autonomous lowers the ceremony, never the visibility: an unbounded delete still
  // does not execute silently.
  assert.equal(policyDecision('destructive', 'autonomous'), 'ask')
})

test('v0.18: an `ask` is a refusal that names the confirmation step', () => {
  const verdict = evaluateCommandPolicy(GLOBAL_SEARCH, WORKSPACE, 'autonomous')
  assert.equal(verdict.decision, 'ask')
  assert.equal(verdict.risk, 'destructive')
  assert.match(String(verdict.reason), /ASK（safetyMode=autonomous）/u)
  assert.match(String(verdict.reason), /用户/u)
  assert.match(String(verdict.reason), /GLOBAL_SEARCH/u)

  const allowed = evaluateCommandPolicy('git status', WORKSPACE, 'strict')
  assert.equal(allowed.decision, 'allow')
  assert.equal(allowed.reason, undefined, 'an allow carries no message at all')
})

test('v0.18: safetyMode defaults to balanced and refuses a value outside the table', () => {
  assert.equal(normalizeConfig({}).safetyMode, 'balanced')
  assert.equal(normalizeConfig({ safetyMode: 'strict' }).safetyMode, 'strict')
  assert.equal(normalizeConfig({ safetyMode: 'autonomous' }).safetyMode, 'autonomous')
  // An unknown mode is not silently accepted as one of the three: it normalises to
  // the default, which is the mode that refuses the most without blocking work.
  assert.equal(normalizeConfig({ safetyMode: 'yolo' }).safetyMode, 'balanced')
})

test('v0.18: the tool guard obeys the CONFIGURED mode (strict denies, autonomous asks)', () => {
  const log = makeSourceLog({ turns: 3 })
  const strictCtx = makeCtx({ sourceLog: log })
  resetRetiredSessions()
  apply(strictCtx, { safetyMode: 'strict' })
  const strictVerdict = strictCtx.tools._runGuards({
    name: 'pwsh',
    arguments: { command: GLOBAL_SEARCH },
    agent: { id: log.session.id },
  })
  assert.match(String(strictVerdict), /GLOBAL_SEARCH/u, 'a destructive command is denied under strict')

  const freeCtx = makeCtx({ sourceLog: log })
  resetRetiredSessions()
  apply(freeCtx, { safetyMode: 'autonomous' })
  const askVerdict = freeCtx.tools._runGuards({
    name: 'pwsh',
    arguments: { command: GLOBAL_SEARCH },
    agent: { id: log.session.id },
  })
  assert.match(String(askVerdict), /ASK（safetyMode=autonomous）/u)
  // ...and ordinary work still runs in every mode.
  assert.equal(
    freeCtx.tools._runGuards({ name: 'pwsh', arguments: { command: 'npm test' }, agent: { id: log.session.id } }),
    undefined,
  )
})

test('v0.18: the denial is MONOTONIC — a later permissive guard cannot undo it', () => {
  // Why this is the enforcement point and `tools/pre-execute` is not: the live
  // contract says a guard runs after that waterfall and "no guard can force-allow a
  // call another guard denied", while a waterfall is overridable by construction.
  // This test holds that property against the fake host's guard chain.
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  resetRetiredSessions()
  apply(ctx, { safetyMode: 'autonomous' })
  ctx.tools.guard(() => undefined)
  const verdict = ctx.tools._runGuards({
    name: 'pwsh',
    arguments: { command: GLOBAL_SEARCH },
    agent: { id: log.session.id },
  })
  assert.match(String(verdict), /ASK（safetyMode=autonomous）/u)
})

test('v0.18: the audit line distinguishes what was blocked from what was asked', () => {
  const log = makeSourceLog({ turns: 3 })
  const ctx = makeCtx({ sourceLog: log })
  resetRetiredSessions()
  apply(ctx, { safetyMode: 'autonomous' })
  ctx.tools._runGuards({ name: 'pwsh', arguments: { command: GLOBAL_SEARCH }, agent: { id: log.session.id } })
  const audit = readFileSync(join(ctx.pathsData, '.graft-audit.jsonl'), 'utf8')
  assert.match(audit, /"kind":"command-asked"/u)
  assert.match(audit, /safetyMode=autonomous/u)
  assert.doesNotMatch(audit, /"kind":"command-blocked"/u, 'an ask is not recorded as a block')
})
