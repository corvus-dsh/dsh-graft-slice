import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Delete the OLD write block (prepare → persistence.create → append → flush → close → local rollback)
 * now that `paradise.session.create` has replaced it.
 *
 * WHY A SCRIPT: the block is ~113 lines in the middle of a 12 700-line function. A hand edit risks
 * cutting one line too many — and the failure mode of that is a runtime `undefined` inside the
 * migration, not a type error, because the bundle is one scope.
 *
 * The caller has checked both boundaries by hand (they are printed before and after).
 */
const path = 'src/index.ts'
const lines = readFileSync(path, 'utf8').split('\n')
const [startArg, endArg] = process.argv.slice(2)
const start = Number(startArg)
const end = Number(endArg)

const first = lines[start - 1]
const last = lines[end - 1]
const before = lines[start - 2]
const after = lines[end]

console.log(`about to delete ${start}..${end}`)
console.log(`  before: ${before?.trim().slice(0, 80)}`)
console.log(`  first:  ${first?.trim().slice(0, 80)}`)
console.log(`  last:   ${last?.trim().slice(0, 80)}`)
console.log(`  after:  ${after?.trim().slice(0, 80)}`)

const next = lines.slice(0, start - 1).concat(lines.slice(end))
writeFileSync(path, next.join('\n'), 'utf8')
console.log(`index.ts: ${lines.length} -> ${next.length}`)
