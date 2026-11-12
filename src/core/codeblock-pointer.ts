/**
 * v5.2: a fenced block large enough to blow the tape budget.
 *
 * The first ten lines are kept inline so the reader still sees what the block
 * is; the rest is recoverable through `graft_read_result({seq, lineRange})`.
 */
export interface CodeBlockPointer {
  seq: number
  startLine: number
  endLine: number
  preview: string
  pointer: string
}

const CODEBLOCK_MAX_LINES = 200
const CODEBLOCK_MAX_CHARS = 8000
const CODEBLOCK_PREVIEW_LINES = 10

export function lineCount(text: string): number {
  let count = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

function firstLines(text: string, count: number): string {
  const lines: string[] = []
  let start = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text.charCodeAt(index) !== 10) continue
    lines.push(text.slice(start, index))
    start = index + 1
    if (lines.length >= count) break
  }
  return lines.join('\n')
}

/**
 * Replace oversized fenced code blocks with a readable pointer.
 *
 * Only text the assistant wrote directly is considered. A block produced by
 * `write_file`/`edit` already has a tool pointer, and rewriting it here would
 * duplicate that indirection.
 *
 * Line numbers in the pointer are ABSOLUTE within the assistant message, so
 * the same numbers can be handed straight to `graft_read_result.lineRange`.
 * A block starting on message line 12 reports `lines=12-313`, not `1-302`;
 * relative numbering silently shifts every later read.
 */
export function pointerizeCodeBlocks(
  text: string,
  seq: number,
  sourceSessionId = '<sourceSessionId>',
): { text: string; pointers: CodeBlockPointer[] } {
  const pointers: CodeBlockPointer[] = []
  if (text.length === 0) return { text, pointers }
  const pattern = /```[^\n]*\n([\s\S]*?)```/gu
  const output = text.replace(pattern, (match: string, body: string, offset: number) => {
    // `body` keeps the newline that precedes the closing fence; that newline
    // terminates the last content line rather than starting a new one, so the
    // content line count must drop it. Counting it would report one extra line
    // and shift every later read.
    const content = body.endsWith('\n') ? body.slice(0, -1) : body
    const bodyLines = lineCount(content)
    if (bodyLines <= CODEBLOCK_MAX_LINES && match.length <= CODEBLOCK_MAX_CHARS) return match
    // The message line on which this block's body starts.
    const bodyStartLine = lineCount(text.slice(0, offset + (match.indexOf('\n') + 1)))
    const bodyEndLine = bodyStartLine + bodyLines - 1
    const preview = firstLines(content, CODEBLOCK_PREVIEW_LINES)
    const pointer =
      `[codeblock seq=${seq} lines=${bodyStartLine}-${bodyEndLine} preview]\n${preview}\n` +
      `…[${Math.max(0, bodyLines - CODEBLOCK_PREVIEW_LINES)} more lines; call ` +
      `graft_read_result({"sourceSessionId":"${sourceSessionId}","seq":${seq},` +
      `"lineRange":{"start":${bodyStartLine},"end":${bodyEndLine}}})]`
    pointers.push({ seq, startLine: bodyStartLine, endLine: bodyEndLine, preview, pointer })
    return pointer
  })
  return { text: output, pointers }
}
