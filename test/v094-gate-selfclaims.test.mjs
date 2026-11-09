/**
 * v0.9.4 — a documentation gate must check EVERY claim, not the first one it finds.
 *
 * THE BACKDOOR THIS PINS
 *
 * `check-readme-counts.mjs` used to take the FIRST self-equal `N/N` pair per line and compare only
 * that one. So a README could state the correct number in the status table at the top and a stale
 * number in the body below, and the gate stayed green — the body claim was never compared to
 * anything.
 *
 * That is not hypothetical: it is how this repository shipped `README.md:416 = 604` alongside
 * `README.md:808 = 598` and `:1475 = 598`, and how `dsh-memory` shipped `418` next to two `415`s.
 * The gate that was supposed to catch stale documentation had a one-line blind spot shaped exactly
 * like the real mistake.
 *
 * WHY THE TEST RUNS THE GATE IN A TEMP DIRECTORY: the rule under test is "which claims does this
 * document have", so the document has to be constructed. Running the real script against a
 * synthesized repository is the only way to prove the red is caused by the README and not by
 * anything else in this one.
 *
 * THE COMPLICATION THE RULE MUST SURVIVE: a line may legitimately carry another repository's count
 * (`| graft **604/604**、memory **418/418** |`). Requiring that to equal THIS repo's count would be a
 * false failure, and a false failure is how gates get switched off. So the third test pins the skip.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
/** The real gate, not a copy: a test of a re-implementation proves nothing. */
const GATE = join(REPO, 'scripts', 'check-readme-counts.mjs')

/**
 * Build a throwaway repository whose test script "reports" `pass 604`, so the gate's measured
 * count is deterministic and no real suite has to run.
 *
 * ── WHY A SCRIPT FILE AND NOT `node -e "…"` ──────────────────────────────────────────────────────
 *
 * The first version wrote `scripts.test = 'node -e "console.log(\'pass 604\')"'` and passed on
 * Windows, where the command runs through `cmd.exe`. On Linux CI it runs through `sh -c`, where
 * those nested quotes do not mean what they mean in cmd — and **Node 22 failed while Node 24
 * passed**, which is exactly the kind of quote-handling difference that is invisible on the
 * developer's machine.
 *
 * Writing a small `.mjs` file and invoking `node <file>` has no quoting at all, so the gate is
 * tested for what it does rather than for how the shell parses a string.
 */
function fakeRepo({ readme, name = '@corvus-dsh/dsh-graft-slice', passCount = 604 }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
  writeFileSync(join(root, 'fake-suite.mjs'), `console.log('pass ${passCount}')\n`, 'utf8')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name,
      version: '0.9.2-beta.1',
      scripts: { test: 'node fake-suite.mjs' },
    }),
    'utf8',
  )
  writeFileSync(join(root, 'README.md'), readme, 'utf8')
  return root
}

function runGate(root) {
  try {
    const stdout = execFileSync(process.execPath, [GATE], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('v0.9.4: TWO self-equal claims on ONE line are BOTH checked (the actual backdoor)', () => {
  // ── THE SHAPE THAT MATTERED, FOUND BY MEASURING RATHER THAN ASSUMING ─────────────────────────────
  //
  // The obvious guess was "top correct, body wrong", split across lines. Measured against the HEAD
  // gate, that shape was ALREADY RED — the old rule iterated per LINE, so a stale claim on its own
  // line was caught. A test built on that guess would have passed before the fix and proved nothing.
  //
  // The old rule's actual hole was `/\d+\s*\/\s*\d+/u.exec(line)`: ONE match per line. So a line
  // carrying two self-equal pairs had its SECOND pair silently unchecked. Measured on the HEAD gate:
  // this exact document exited 0.
  //
  // This is a real shape in this repository, not a contrivance: `README.md:416` is
  // `| graft **604/604**、memory **418/418** |` — two pairs on one line. The second one happens to be
  // another repository's, which is why it is skipped rather than asserted; but the rule that decides
  // "checked or skipped" must look at every pair, or the next stale number added to that line is
  // invisible.
  const root = fakeRepo({
    readme: '| 全量测试 | **604/604**（上一轮正文仍写 **598/598**） |\n',
  })

  const { code, out } = runGate(root)
  assert.equal(code, 1, `the second pair on a line must be checked; output was:\n${out}`)
  assert.match(out, /声明测试数 598\/598/u, 'the stale second pair must be named')
  // The correct first pair is still reported as correct — this is not "fail the line".
  assert.match(out, /L1 测试数 604\/604 与实测一致/u)
})

test('v0.9.4: top correct, body wrong is RED (every claim, not just the first found)', () => {
  // The case requested in review. Worth keeping even though the HEAD gate also caught THIS shape:
  // it pins the property "one corrected occurrence cannot silence another", which the same-line
  // test above cannot express.
  const root = fakeRepo({
    readme: [
      '| 项 | 结果 |',
      '|---|---|',
      '| 全量测试 | graft **604/604** |',
      '',
      '后面还有一段正文：',
      '',
      '| 早期结果 | 598/598 |',
      '',
      '```bash',
      '# 2) 598 / 598',
      'node --test',
      '```',
    ].join('\n'),
  })

  const { code, out } = runGate(root)
  assert.equal(code, 1, `the stale body claims must fail the gate; output was:\n${out}`)
  assert.match(out, /598/u, 'the failure must name the stale number')
  const reported = [...out.matchAll(/声明测试数 598/gu)].length
  assert.equal(reported, 2, `both stale claims must be reported (got ${reported}):\n${out}`)
})

test('v0.9.4: a README whose every claim is current is GREEN', () => {
  const root = fakeRepo({
    readme: ['| 全量测试 | graft **604/604** |', '', '| `test/*.test.mjs` | 604 个测试 |', '', '# 2) 604 个测试'].join('\n'),
  })
  const { code, out } = runGate(root)
  assert.equal(code, 0, `an all-current README must pass; output was:\n${out}`)
})

test('v0.9.4: another repository\'s count on the same line is skipped, not failed', () => {
  // `memory 418/418` in graft's README is a true statement about memory. Demanding it equal 604
  // would be a false failure — and a false failure on a CORRECT number is how a gate gets disabled.
  const root = fakeRepo({
    readme: ['| 全量测试 | graft **604/604**、memory **418/418** |'].join('\n'),
  })
  const { code, out } = runGate(root)
  assert.equal(code, 0, `a foreign repo's count must not fail this repo's gate; output was:\n${out}`)
  assert.match(out, /属于其他仓/u, 'the skip must be stated, not silent')
})

test('v0.9.4: an UNQUALIFIED claim is this repository\'s claim', () => {
  // No repository word before the pair: there is nothing else it could mean, so it is asserted.
  // This is the shape of both `dsh-memory` occurrences that went stale.
  const root = fakeRepo({
    readme: ['| 测试 | **598 / 598** |'].join('\n'),
  })
  const { code, out } = runGate(root)
  assert.equal(code, 1, `an unqualified stale claim must fail; output was:\n${out}`)
  assert.match(out, /598/u)
})
