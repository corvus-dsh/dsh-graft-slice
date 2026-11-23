#!/usr/bin/env node
/**
 * ── emit the taxonomy JSON from the TS contract (Phase A) ────────────────────────────────────────
 *
 * `src/contracts/content-taxonomy.v1.ts` is the ONE OWNER; `content-taxonomy.v1.json` is a PROJECTION of
 * it, committed so other tools and other repos can read the registry without a TS loader.
 *
 * WHY A PROJECTION AND NOT A SECOND REGISTRY. Two hand-maintained copies of 19 rows is exactly the disease
 * this phase exists to remove (a fact with several owners). A generated file can be stale, but it cannot
 * disagree silently: `check` mode diffs it against a fresh emission and fails on any drift.
 *
 * Usage:
 *   node scripts/emit-taxonomy.mjs           # write the JSON
 *   node scripts/emit-taxonomy.mjs --check   # exit 1 if the committed JSON is stale
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = join(ROOT, 'src', 'core', 'content-classifier.ts')
const TARGET = join(ROOT, 'src', 'contracts', 'content-taxonomy.v1.json')

const contract = await import(pathToFileURL(CONTRACT).href)

const projection = {
  contractVersion: contract.TAXONOMY_VERSION,
  /** 10 内容类（`self-authored` 不在这里 —— 它是 provenance）。 */
  contentClasses: contract.CONTENT_CLASSES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    continuation: entry.continuation,
    intoConstraintCandidates: entry.intoConstraintCandidates,
    basis: entry.basis,
  })),
  provenance: contract.PROVENANCE.map((entry) => ({ id: entry.id, meaning: entry.meaning })),
  sourceKinds: contract.SOURCE_KINDS.map((entry) => ({
    kind: entry.kind,
    contentClass: entry.contentClass,
    provenance: entry.provenance,
    note: entry.note,
  })),
  unknownPolicy: {
    className: contract.UNKNOWN_POLICY.className,
    flagUnclassified: contract.UNKNOWN_POLICY.flagUnclassified,
    preservePointer: contract.UNKNOWN_POLICY.preservePointer,
    warn: contract.UNKNOWN_POLICY.warn,
    basis: contract.UNKNOWN_POLICY.basis,
  },
}

const rendered = `${JSON.stringify(projection, null, 2)}\n`

if (process.argv.includes('--check')) {
  let committed
  try {
    committed = readFileSync(TARGET, 'utf8')
  } catch {
    console.error(`❌ ${TARGET} 不存在 —— 先跑 node scripts/emit-taxonomy.mjs`)
    process.exit(1)
  }
  if (committed !== rendered) {
    console.error('❌ 合同 JSON 与 TS 合同不一致：JSON 是被生成的投影，不要手改。')
    console.error('   修法：node scripts/emit-taxonomy.mjs')
    process.exit(1)
  }
  console.log('taxonomy: OK — the committed JSON is what the TS contract emits')
  process.exit(0)
}

writeFileSync(TARGET, rendered, 'utf8')
console.log(`wrote ${TARGET.replace(/\\/gu, '/')} (${projection.contentClasses.length} classes, ${projection.sourceKinds.length} kinds)`)