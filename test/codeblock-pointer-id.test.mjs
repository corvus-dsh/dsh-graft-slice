import test from 'node:test'
import assert from 'node:assert/strict'

import { pointerizeCodeBlocks } from '../index.js'

const FENCE = '```'

function bigBlock(lines) {
  return `${FENCE}js\n${Array.from({ length: lines }, (_, i) => `const v${i} = ${i};`).join('\n')}\n${FENCE}`
}

test('codeblock: the pointer carries the real source session id', () => {
  const result = pointerizeCodeBlocks(bigBlock(250), 42, 'session-real-src')
  assert.equal(result.pointers.length, 1)
  assert.equal(result.text.includes('session-real-src'), true)
  assert.equal(
    result.text.includes('<sourceSessionId>'),
    false,
    'a placeholder id forces the model to guess and was a real E2E failure',
  )
})

test('codeblock: falls back to the placeholder when no source id is supplied', () => {
  const result = pointerizeCodeBlocks(bigBlock(250), 42)
  assert.equal(result.text.includes('<sourceSessionId>'), true)
})
