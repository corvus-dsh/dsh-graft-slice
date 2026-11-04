#!/usr/bin/env node
/**
 * Build index.js from src/*.ts with Node's built-in type stripper.
 *
 * The composition itself lives in `scripts/bundle.mjs` so this script and
 * `scripts/check-docs.mjs` cannot disagree about what the shipped file should be.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { composeBundle } from './bundle.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { output, modules } = composeBundle(root)
writeFileSync(join(root, 'index.js'), output, 'utf8')
process.stdout.write(
  `built index.js (${Buffer.byteLength(output)} bytes, ${modules.length} inlined module(s))\n`,
)
