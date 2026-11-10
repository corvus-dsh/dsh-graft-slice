/**
 * ── TD-17 退出条件 ②：`UNCONFINABLE_VERB` 的成员必须配「无害但含该词」的反例 ──────────────────────
 *
 * `UNCONFINABLE_VERB` 拦的是「没有『限制在工作区内』这个版本的命令」——磁盘格式化、分区表、
 * 关机。它的判据是词族匹配，而词族匹配的第一类事故就是**误拦提到这个词的正常命令**：
 * 读一份文档、搜一个词、跑一个名字里带它的测试。
 *
 * 这正是 `format` 当初的错（TD-17 根因一）：`Format-Table` 是渲染 cmdlet，被判成「格式化磁盘」。
 * `UNCONFINABLE_VERB` 修了那个实例，但**修实例不等于防住这一类**——只要没有反例，下一个成员
 * 就会重犯。
 *
 * 所以本文件把「无害但含该词」钉成断言。注意它与 `v112-command-guard-minimal-pair.test.mjs` 的
 * 分工：那个测的是「format / -Force 的误判与漏判」，本文件测的是「词族匹配不得吃掉提及」——
 * 后者是前者的**宿主类**，会随成员增加而扩大。
 *
 * ── 为什么「提及 vs 执行」的判断依赖位置而不是词 ────────────────────────────────────────────────
 *
 * `rg "diskpart" docs/` 与 `diskpart` 含同一个词，差别是**它在不在命令位**。
 * 所以这里逐条给出「词在 argument / 引号 / 文件名 / 注释里」的四种无害形态，
 * 以及每种形态对应的真危险形态。任一侧塌掉，测试红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateCommandPolicy } from '../index.js'

const WORKSPACE = 'C:\\review\\workspace'

const judge = (command) => evaluateCommandPolicy(command, WORKSPACE, 'balanced')

/**
 * 无害：该词出现在 argument、引号、文件名、注释或测试名里 —— 命令本身是读/搜/跑。
 * 每一条都必须 ALLOW；任何一条被拒，说明词族匹配吃掉了「提及」。
 */
const MENTIONS = [
  { note: 'the word is the rg PATTERN', command: 'rg "diskpart" docs/' },
  { note: 'the word is the grep PATTERN', command: 'grep -r "format-volume" .' },
  { note: 'the word is a Select-String PATTERN', command: 'Get-Content README.md | Select-String "mkfs"' },
  { note: 'the word is in a filename GLOB', command: "Get-ChildItem -Filter '*diskpart*'" },
  { note: 'the word is a git log --grep VALUE', command: 'git log --grep="shutdown"' },
  { note: 'the word is inside echo output', command: 'echo "do not run diskpart"' },
  { note: 'the word is in a code comment passed to node', command: 'node -e "// diskpart is dangerous"' },
  { note: 'the word is part of a FILENAME being read', command: "Get-Item 'clear-disk-notes.md'" },
  { note: 'the word is part of a TEST filename', command: 'node --test test/mkfs-guard.test.mjs' },
]

/** 执行：该词在命令位 —— 每条都必须 DENY。 */
const EXECUTIONS = [
  { note: 'Format-Volume by drive letter', command: 'Format-Volume -DriveLetter D' },
  { note: 'bare diskpart', command: 'diskpart' },
  { note: 'diskpart with a script', command: 'diskpart /s script.txt' },
  { note: 'Clear-Disk', command: 'Clear-Disk -Number 1 -RemoveData' },
  { note: 'mkfs', command: 'mkfs.ext4 /dev/sda1' },
  { note: 'shutdown', command: 'shutdown /s /t 0' },
  { note: 'Stop-Computer', command: 'Stop-Computer -Force' },
  { note: 'cmd.exe format', command: 'format D: /q' },
]

test('TD-17 ②: naming an unconfinable command is NOT running it', () => {
  const rejected = MENTIONS.filter((item) => judge(item.command).decision !== 'allow')
  assert.deepEqual(
    rejected.map((item) => `${item.note} → ${item.command}`),
    [],
    'a command that merely MENTIONS an unconfinable verb must be allowed; ' +
      'the guard judges position, not vocabulary (this is the class that made `format` misfire)',
  )
})

test('TD-17 ②: every unconfinable verb is still refused where it counts', () => {
  const allowed = EXECUTIONS.filter((item) => judge(item.command).decision === 'allow')
  assert.deepEqual(
    allowed.map((item) => `${item.note} → ${item.command}`),
    [],
    'loosening the mention case must not loosen the execution case',
  )
})

test('TD-17 ② self-test: the mention/execution split is POSITION, not the word', () => {
  /**
   * A pair that differs ONLY in where the word sits. If this pair ever returns the same verdict,
   * the rule has collapsed back into vocabulary matching — which is the defect, not the fix.
   */
  const mention = judge('rg "diskpart" docs/')
  const execution = judge('diskpart')
  assert.notEqual(
    mention.decision,
    execution.decision,
    'the same word in a pattern and in command position must not get the same verdict',
  )
  assert.equal(mention.decision, 'allow')
  assert.notEqual(execution.decision, 'allow')
})

test('TD-17 ②: the `format` cmdlet family is not the `format` disk command', () => {
  /** TD-17 根因一, kept as a named regression: these are PowerShell RENDER cmds. */
  for (const command of [
    "Get-ChildItem -Force 'C:\\review\\workspace' | Format-Table",
    "Get-ChildItem -Recurse -File 'C:\\review\\workspace' | Format-List",
    "Get-Date -Format 'yyyy-MM-dd'",
  ]) {
    assert.equal(judge(command).decision, 'allow', `render cmdlet rejected: ${command}`)
  }
})
