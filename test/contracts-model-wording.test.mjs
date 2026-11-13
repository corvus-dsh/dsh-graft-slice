/**
 * ── THE CONTRACTS ARE PINNED TO REAL TEXT ────────────────────────────────────────────────────────
 *
 * A `samples` array of invented sentences proves nothing: it tests whether I can write a string that
 * matches a regex I just wrote. So every sample is asserted against the real corpus the review
 * supplied (`测试用真实日志/` → `_scratch/real-texts.json`, 9153 text blocks from 86 logs).
 *
 * The same applies to near misses, and the assertion is sharper there:
 *   - `real-misfire` must ACTUALLY MATCH the pattern (the whole point is that it misfires);
 *   - `real-nearby`  must ACTUALLY NOT MATCH (the whole point is that the boundary holds);
 *   - `synthetic`    is rejected outright by this suite — there are none, and adding one has to be a
 *                    deliberate act that changes this test, not a quiet addition.
 *
 * ── WHY THE CORPUS IS OPTIONAL ───────────────────────────────────────────────────────────────────
 *
 * `_scratch/real-texts.json` is a 9153-block extract of the review's logs and is NOT shipped with the
 * plugin (it is working material, not a fixture). On a bare checkout — CI, a published tarball — the
 * corpus is absent, so the provenance checks skip with a loud message rather than passing silently.
 * The pattern-shape checks (sample matches, near miss behaves) run everywhere, because they need only
 * the contract itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The metadata now lives in `model-wording.contracts.ts` (E1): `bundle.mjs` inlines whole FILES, so
 * keeping the metadata beside the regexes meant every `samples` entry — real `session-<uuid>` ids,
 * `.jsonl.zstd` filenames — was inlined into the PUBLISHED bundle. Measured before the split: 2 session
 * ids, 5 corpus filenames, 8 `auto-graft-*` names.
 *
 * This test imports the metadata file directly (Node strips the types), which is exactly the property
 * being asserted elsewhere: production cannot reach it, tests can.
 */
import { ALL_CONTRACTS } from '../src/contracts/model-wording.contracts.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const CORPUS = resolve(REPO, '..', '_scratch', 'real-texts.json')
const CONTRACTS = ALL_CONTRACTS

/**
 * ── 脱敏后的样本仍必须可溯源 ────────────────────────────────────────────────────────────────────
 *
 * 2026-11-13：契约样本里的作者磁盘路径被泛化成 `<workspace>` 占位（脱敏要求），
 * 但「样本能在真实语料里逐字找到」这条**出处**约束不能因此取消 —— 取消了，样本就重新变成
 * 「我编的句子」。
 *
 * 所以比较前对**两侧**做同一个归一：把 `<盘符>:\第一段` 掩成 `<workspace>`。
 * 这样被掩掉的只有「谁的磁盘」这一信息，句子的其余部分仍必须逐字相同。
 */
const maskDrivePrefix = (text) => text.replace(/\b[A-Za-z]:\\[^\\\s]+/gu, '<workspace>')

const corpus = existsSync(CORPUS)
  ? JSON.parse(readFileSync(CORPUS, 'utf8')).map((entry) => entry.text)
  : undefined

test('every contract has a name, an intent, and at least one sample and one near miss', () => {
  for (const contract of CONTRACTS) {
    assert.ok(contract.name.length > 0, 'a contract needs a name')
    assert.ok(contract.intent.length > 10, `${contract.name}: intent must say what question it answers`)
    assert.ok(contract.samples.length >= 1, `${contract.name}: needs at least one sample`)
    assert.ok(contract.nearMisses.length >= 1, `${contract.name}: a contract with no near miss cannot be wrong`)
    for (const sample of contract.samples) {
      assert.ok(sample.source.length > 0, `${contract.name}: a sample must name its log`)
      assert.equal(typeof sample.seq, 'number', `${contract.name}: a sample must carry its seq`)
    }
    for (const near of contract.nearMisses) {
      assert.ok(
        near.kind === 'real-misfire' || near.kind === 'real-nearby',
        `${contract.name}: near misses must be real (got "${near.kind}"); an invented one proves nothing`,
      )
      assert.ok(near.why.length > 10, `${contract.name}: a near miss must say WHY it is one`)
    }
  }
})

test('every sample MATCHES its own contract', () => {
  for (const contract of CONTRACTS) {
    for (const sample of contract.samples) {
      const lines = sample.text.split(/\r?\n/u)
      const matched = lines.some((line) => contract.re.test(line))
      assert.equal(
        matched,
        true,
        `${contract.name}: sample does not match its own pattern — seq=${sample.seq} ${JSON.stringify(sample.text.slice(0, 80))}`,
      )
    }
  }
})

test('every real-misfire ACTUALLY misfires, and every real-nearby ACTUALLY does not', () => {
  for (const contract of CONTRACTS) {
    for (const near of contract.nearMisses) {
      const lines = near.text.split(/\r?\n/u)
      const matched = lines.some((line) => contract.re.test(line))
      if (near.kind === 'real-misfire') {
        assert.equal(
          matched,
          true,
          `${contract.name}: a real-misfire must match (that is what makes it a misfire) — ${JSON.stringify(near.text.slice(0, 80))}`,
        )
      } else {
        assert.equal(
          matched,
          false,
          `${contract.name}: a real-nearby must NOT match (that is the boundary being asserted) — ${JSON.stringify(near.text.slice(0, 80))}`,
        )
      }
    }
  }
})

test('every sample can be found in the real corpus (when the corpus is present)', (t) => {
  if (corpus === undefined) {
    t.skip(`corpus absent at ${CORPUS} — provenance unverified in this checkout (not a pass)`)
    return
  }
  const haystack = maskDrivePrefix(corpus.join('\n'))
  for (const contract of CONTRACTS) {
    for (const sample of contract.samples) {
      // Compare on a distinctive slice: the corpus stores raw blocks, the contract stores excerpts.
      const needle = maskDrivePrefix(sample.text.slice(0, 40).replace(/\s+/gu, ' ').trim())
      const found =
        haystack.includes(needle) ||
        corpus.some((block) => maskDrivePrefix(block.replace(/\s+/gu, ' ')).includes(needle))
      assert.equal(
        found,
        true,
        `${contract.name}: sample not found in the real corpus — seq=${sample.seq} ${JSON.stringify(needle)}`,
      )
    }
  }
})

test('every real-misfire can be found in the real corpus too', (t) => {
  if (corpus === undefined) {
    t.skip(`corpus absent at ${CORPUS} — misfire provenance unverified in this checkout (not a pass)`)
    return
  }
  const haystack = maskDrivePrefix(corpus.join('\n').replace(/\s+/gu, ' '))
  for (const contract of CONTRACTS) {
    for (const near of contract.nearMisses) {
      const needle = maskDrivePrefix(near.text.slice(0, 40).replace(/\s+/gu, ' ').trim())
      assert.equal(
        haystack.includes(needle),
        true,
        `${contract.name}: near miss not found in the real corpus — ${JSON.stringify(needle)}`,
      )
    }
  }
})
