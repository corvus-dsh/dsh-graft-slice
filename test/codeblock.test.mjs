import test from 'node:test'
import assert from 'node:assert/strict'

import { pointerizeCodeBlocks, sliceLines } from '../index.js'

const FENCE = '```'

function bigBlock(lines) {
  return `${FENCE}js\n${Array.from({ length: lines }, (_, i) => `const v${i} = ${i};`).join('\n')}\n${FENCE}`
}

test('codeblock: keeps a small block untouched', () => {
  const text = `before\n${FENCE}js\nconst a = 1;\n${FENCE}\nafter`
  const result = pointerizeCodeBlocks(text, 42)
  assert.equal(result.text, text)
  assert.equal(result.pointers.length, 0)
})

test('codeblock: pointerizes a block over the line limit', () => {
  const result = pointerizeCodeBlocks(bigBlock(250), 42)
  assert.equal(result.pointers.length, 1)
  const pointer = result.pointers[0]
  assert.equal(pointer.seq, 42)
  // The message is ```` ```js ```` + 250 lines + ```` ``` ````; the body starts
  // on message line 2, so the pointer must use absolute message lines.
  assert.equal(pointer.startLine, 2)
  assert.equal(pointer.endLine, 251)
  assert.match(result.text, /\[codeblock seq=42 lines=2-251 preview\]/)
  assert.match(result.text, /graft_read_result/)
  // The preview is the first ten lines, and the bulk is gone from the tape.
  assert.equal(pointer.preview.split('\n').length, 10)
  assert.equal(result.text.includes('const v200'), false)
  assert.equal(result.text.includes('const v3 = 3;'), true)
})

test('codeblock: pointer line numbers stay absolute after a prose prefix', () => {
  const text = `line one\nline two\n\n${bigBlock(250)}`
  const result = pointerizeCodeBlocks(text, 9)
  const pointer = result.pointers[0]
  // 3 prose lines, then the fence line, so the body starts on message line 5.
  assert.equal(pointer.startLine, 5)
  assert.equal(result.text.includes(`lines=5-254`), true)
})

test('codeblock: pointerizes a block over the char limit even when short', () => {
  const wide = `${FENCE}txt\n${'x'.repeat(9000)}\n${FENCE}`
  const result = pointerizeCodeBlocks(wide, 7)
  assert.equal(result.pointers.length, 1)
  // One content line, sitting on message line 2 (line 1 is the fence).
  assert.match(result.text, /\[codeblock seq=7 lines=2-2 preview\]/)
})

test('codeblock: leaves non-fenced prose alone', () => {
  const text = 'plain prose without fences, long but not code'
  assert.equal(pointerizeCodeBlocks(text, 1).pointers.length, 0)
})

test('codeblock: sliceLines returns a 1-based inclusive window', () => {
  const body = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n')
  assert.equal(sliceLines(body, 2, 4), ['l2', 'l3', 'l4'].join('\n'))
  assert.equal(sliceLines(body, 1, 1), 'l1')
  assert.equal(sliceLines(body, 4, 99), ['l4', 'l5'].join('\n'))
  assert.equal(sliceLines(body, 9, 12), '')
})
