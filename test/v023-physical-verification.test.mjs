/**
 * v0.23 P2 — THE CARD'S CLAIMS NEED A REFEREE.
 *
 * The ✅ column is assembled from the source conversation, which means it reports what
 * the model SAID it did. "git commit e8da8f6 成功" is a claim, and the board presented
 * it as a fact. A target that trusts it builds on a commit that may not exist, on a
 * tree twelve edits ahead of it, or in a directory that was never a repo.
 *
 * The fix is not to distrust the board — it is to give it an independent witness. The
 * handoff now runs a cheap read-only probe and prints the result as its own section,
 * labelled as MEASURED, so the two kinds of statement can never be confused.
 *
 * What these tests hold:
 *   1. `verifyWorkspace` measures real state and never throws, whatever it finds;
 *   2. it distinguishes "clean", "dirty" and "not a repo" — three different facts that
 *      a board must not present identically;
 *   3. the card renders the measurement, and says so plainly when it could not;
 *   4. the probe is injected, so `buildTape` stays a pure function over a log.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderTaskBoard, verifyWorkspace } from '../index.js'

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A throwaway git repo with one commit. Returns undefined if git is unavailable. */
function makeRepo() {
  const dir = tempDir('dsh-graft-verify-')
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  try {
    git(['init'])
    git(['config', 'user.email', 'probe@localhost'])
    git(['config', 'user.name', 'probe'])
    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'the measured commit subject'])
  } catch {
    return undefined
  }
  return { dir, git }
}

// ---------------------------------------------------------------------------
// 1. the probe measures, and never throws
// ---------------------------------------------------------------------------

test('v0.23 P2: a clean repo reports its HEAD and an empty working tree', (t) => {
  const repo = makeRepo()
  if (repo === undefined) return t.skip('git unavailable in this environment')

  const v = verifyWorkspace(repo.dir)
  assert.equal(v.unavailable, undefined, 'a real repo is measurable')
  assert.match(String(v.head), /^[0-9a-f]{7,}$/u, 'a short commit hash')
  assert.equal(v.subject, 'the measured commit subject', 'the subject is what a reader recognises')
  assert.deepEqual(v.dirty, { tracked: 0, untracked: 0 }, 'a freshly committed tree is clean')
  assert.equal(typeof v.entries, 'number')
  assert.equal(v.cwd, repo.dir)
})

test('v0.23 P2: uncommitted work is reported as DIRTY, not as clean', (t) => {
  const repo = makeRepo()
  if (repo === undefined) return t.skip('git unavailable in this environment')

  writeFileSync(join(repo.dir, 'a.txt'), 'changed\n', 'utf8')
  writeFileSync(join(repo.dir, 'fresh.txt'), 'new\n', 'utf8')
  const v = verifyWorkspace(repo.dir)
  assert.ok(v.dirty, 'a dirty tree must be reported')
  assert.equal(v.dirty.tracked, 1, 'the modified tracked file is counted')
  assert.equal(v.dirty.untracked, 1, 'the new untracked file is counted')
})

test('v0.23 P2: a non-repo directory is UNAVAILABLE, with a reason and no throw', () => {
  const dir = tempDir('dsh-graft-norepo-')
  writeFileSync(join(dir, 'x.txt'), 'x\n', 'utf8')
  let v
  assert.doesNotThrow(() => { v = verifyWorkspace(dir) }, 'a probe failure must never break a handoff')
  assert.equal(v.head, undefined, 'no HEAD is invented')
  assert.match(String(v.unavailable), /不是 git 仓库|没有任何提交/u)
  // The listing still works even when git does not: it is a separate question.
  assert.equal(v.entries, 1)
})

test('v0.23 P2: an empty cwd is refused rather than silently probing something else', () => {
  const v = verifyWorkspace('')
  assert.equal(v.head, undefined)
  assert.match(String(v.unavailable), /没有可用的工作目录/u)
  assert.equal(v.cwd, '(未记录)')
})

test('v0.23 P2: a NONEXISTENT directory yields unavailable, not an exception', () => {
  const missing = join(tempDir('dsh-graft-gone-'), 'no-such-subdir')
  assert.doesNotThrow(() => verifyWorkspace(missing))
  const v = verifyWorkspace(missing)
  assert.equal(v.head, undefined)
  assert.ok(v.unavailable !== undefined)
})

// ---------------------------------------------------------------------------
// 2. the card shows the measurement
// ---------------------------------------------------------------------------

function board(verification) {
  return renderTaskBoard({
    request: '把控制台修好',
    outcome: { text: 'git commit e8da8f6 成功', seq: 100 },
    pending: ['跑测试'],
    stopPoint: { turn: 3, boundarySeq: 100 },
    pointerCount: 5,
    discarded: { counts: {}, seqs: [] },
    ...(verification === undefined ? {} : { verification }),
  })
}

test('v0.23 P2: the card separates CLAIMED work from MEASURED state', (t) => {
  const repo = makeRepo()
  if (repo === undefined) return t.skip('git unavailable in this environment')

  const text = board(verifyWorkspace(repo.dir))
  assert.ok(text.includes('✅ 已完成'), 'the claim column is still there')
  assert.ok(text.includes('git commit e8da8f6 成功'), 'and still carries the claim verbatim')
  assert.ok(text.includes('物理验证'), 'the measured section is present and named')
  assert.ok(text.includes('git HEAD'), 'the actual HEAD is shown')
  assert.ok(text.includes('工作区：干净'), 'cleanliness is stated, not implied')
  // The two sections are ordered claim-then-measure, so a reader meets the referee
  // after the assertion it judges.
  assert.ok(text.indexOf('✅ 已完成') < text.indexOf('物理验证'))
})

test('v0.23 P2: dirty work is called out as invalidating the claim', (t) => {
  const repo = makeRepo()
  if (repo === undefined) return t.skip('git unavailable in this environment')

  writeFileSync(join(repo.dir, 'a.txt'), 'uncommitted\n', 'utf8')
  const text = board(verifyWorkspace(repo.dir))
  assert.ok(text.includes('有未提交改动'), 'the danger is named, not merely counted')
  assert.ok(text.includes('上面的结论可能基于磁盘上尚未提交的内容'), 'and its CONSEQUENCE is spelled out')
})

test('v0.23 P2: an unverifiable workspace says so, and warns the claim is unconfirmed', () => {
  const text = board(verifyWorkspace(tempDir('dsh-graft-nv-')))
  assert.ok(text.includes('未能验证'), 'the absence of a measurement is itself reported')
  assert.ok(text.includes('未经文件系统确认'), 'and the reader is told what that means for the ✅ column')
})

test('v0.23 P2: no probe supplied = no verification section, rather than a false one', () => {
  // `buildTape` may be called without a workspace (an offline render, a unit test).
  // Rendering "clean" there would be a fabrication; rendering nothing is honest.
  const text = board(undefined)
  assert.equal(text.includes('物理验证'), false, 'a card with no measurement claims none')
  assert.ok(text.includes('✅ 已完成'), 'and the rest of the board is unaffected')
})

test('v0.23 P2: the verification section never becomes the whole board', () => {
  // A probe that finds nothing must not swallow the four columns.
  const text = board({ cwd: 'X:\\nowhere', unavailable: '不是 git 仓库，或没有任何提交', at: Date.now() })
  for (const column of ['原始用户要求', '✅ 已完成', '🔄 进行中', '⏭️ 待开始']) {
    assert.ok(text.includes(column), `column ${column} survived a failed probe`)
  }
})
