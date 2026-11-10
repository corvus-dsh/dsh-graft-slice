/**
 * ── CONSTRAINT SHAPE: is this text a SENTENCE, or is it a FRAGMENT of something else? ───────────
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT ANOTHER WORD LIST ────────────────────────────────────────
 *
 * The constraint extractor decides "is this a standing rule?" by looking for words: 必须 / never /
 * `if` / `only`, plus an action verb, minus a question mark. That judgement is blind to the fact that
 * a text can be a JSON fragment, a table row, or a list of words that a report is DISCUSSING.
 *
 * Measured on the corpus: a single user message that pasted a *report about the constraint extractor*
 * put seven items into the inherited block, and five of them were structural fragments:
 *
 *     - 必须、禁止、绝对、不能、不得、不许、务必                    ← the extractor's own keyword list
 *     - must / never / forbidden / required / cannot / do not    ← the same list, English row
 *     "绝对约束（后续所有轮次都不能违反）：",                        ← a JSON array element
 *     "1. 绝对不能 import re，也不能以任何方式使用正则表达式。        ← a JSON string cut mid-line
 *     | 2 | 4 | Information | Never include my name in … |       ← a markdown table row
 *
 * Every one of those CONTAINS constraint vocabulary — a report about constraints is made of it. So a
 * word-based gate cannot see the problem, and in fact **the report scores higher than a real rule**:
 * `isRedline` rewards ≤160 chars plus emphasis words, which a keyword list satisfies perfectly.
 *
 * ── WHAT THIS FUNCTION JUDGES, AND WHAT IT REFUSES TO JUDGE ─────────────────────────────────────
 *
 * It answers ONE question: **is this a standalone human sentence?** It does NOT judge importance,
 * truth, or whether the statement is a rule. Those stay where they were.
 *
 * The distinction matters for the repair: a fragment can be recognised from its SHAPE (leading `|`,
 * quoting on one side only, a bulleted list with no句内标点, separators outnumbering words) without
 * knowing anything about what it means. That is why this can be added as a FILTER in front of the
 * existing pipeline rather than rewriting the pipeline.
 *
 * ── EVERY RULE HAS A nearMiss, AND THE nearMiss IS LOAD-BEARING ─────────────────────────────────
 *
 * A shape rule that kills a real constraint is worse than no rule: the user's rule silently
 * disappears. So each rule ships with text it must NOT reject, taken from real constraints (for
 * example `绝对约束：禁止在没有备份的情况下删除任何脚本。` — a colon inside a sentence, which S4 must
 * ignore). The tests assert both directions.
 *
 * ── WHERE IT IS CALLED ──────────────────────────────────────────────────────────────────────────
 *
 * Four sites, all funnel through this one function (never a re-implementation):
 *   - the extraction loop (new text must not enter the candidate pool);
 *   - `isRedline` (the prompt-slot entry ticket must be as strict as extraction);
 *   - the inheritance path (text read back from an earlier generation must be re-checked);
 *   - session acceptance and the section ledger (existing damage must not be re-injected).
 *
 * Silently dropping is forbidden: every rejection produces a `ShapeVerdict` carrying a `code`, so the
 * caller can record WHO was dropped and WHY.
 */

/** Why a text was rejected. Stable strings: they appear in logs and in tests. */
export type ShapeCode = 'S1_JSON' | 'S2_TABLE' | 'S3_WORDLIST' | 'S4_LABEL' | 'S5_META' | 'S6_SEPARATORS'

export interface ShapeVerdict {
  /** True when the text is NOT a standalone sentence. */
  broken: boolean
  /** Present only when `broken`. */
  code?: ShapeCode
  /**
   * One short clause saying what was seen. Not a log line — it is what a `droppedByShape` record
   * quotes, so it must name the STRUCTURE (`leading |`, `list of words`), never a judgement
   * (`low quality`).
   */
  why?: string
}

const OK: ShapeVerdict = { broken: false }

/**
 * Punctuation that makes a text PROSE rather than a list of terms.
 *
 * ── WHY `、` IS NOT IN THIS SET (measured, first version was wrong) ─────────────────────────────
 *
 * The first version included the ideographic comma `、`, and the rule therefore FAILED to reject
 * `- 必须、禁止、绝对、不能、不得、不许、务必` — the exact fragment it exists for. `、` is a
 * SEPARATOR between terms, i.e. it is the *signature* of a term list, not evidence of a sentence.
 *
 * What makes prose is punctuation that joins CLAUSES: `，` `,` and the sentence enders. So the split is:
 *   - clause punctuation → prose (`,`, `，`, sentence enders)
 *   - term separators    → a list (`、`, `/`, `|`)
 */
const CLAUSE_PUNCT = /[。！？；，,.!?;]/u
/** The punctuation that actually ENDS a sentence (a comma alone does not make prose). */
const TERMINAL_PUNCT = /[。！？.!?]/u

/**
 * S1 — a JSON fragment.
 *
 * Detected by QUOTING SYMMETRY, never by content: a text that opens with `"` but does not close with
 * one is a fragment of a JSON string; one that also ends in `",` is a JSON array element.
 *
 * ── THE THIRD BRANCH WAS UNANCHORED, AND IT ATE REAL CONSTRAINTS (measured, reported to me) ──────
 *
 * The original non-anchored branch was `":\s*"` — matched ANYWHERE. So a Chinese sentence that merely
 * QUOTES a JSON key/value was judged a fragment:
 *
 *     必须 在提交前确认 engines 里 "node": ">=22" 这一项没有降低。     → LOST (S1_JSON)
 *     禁止 把 "kind": "plugin" 这种标记换成 user，那会伪造人类来源。  → LOST (S1_JSON)
 *
 * The same rule without the quotes was KEPT, which is the tell: the rule was reacting to punctuation
 * INSIDE a sentence rather than to the sentence being a fragment. As this file's own header says, a
 * shape rule that kills a real constraint is worse than no rule.
 *
 * ── WHY THE DISCRIMINATOR IS DENSITY, NOT PRESENCE ───────────────────────────────────────────────
 *
 * "Contains `": "`" is true of both a rule that mentions a key and a quoted payload. Measured on the
 * 8258-text window: only 9 texts are rejected exclusively by this branch, and ALL of them are a report
 * or log line quoting a JSON payload — none is a standalone rule. So the branch keeps its power by
 * requiring the JSON quoting to DOMINATE the text, which is the shape difference between
 * "payload pasted into a message" and "sentence that happens to quote a key".
 *
 * nearMiss (and the regression tripwire): `必须 确认 "node": ">=22" 未降低。` — it contains the
 * branch-triggering shape AND is prose, so it fails the density test and is kept. The PREVIOUS near
 * miss had no colon at all, never reached this branch, and therefore could not have caught the defect.
 */
function isJsonFragment(text: string): boolean {
  const trimmed = text.trim()
  const startsQuoted = trimmed.startsWith('"') || trimmed.startsWith('["') || trimmed.startsWith('{"')
  if (!startsQuoted) {
    // Anchored shapes: a bare `": [` / `",` at the edges is a JSON fragment however short it is.
    if (/^":\s*[[{]|",\s*$/u.test(trimmed)) return true
    /**
     * The in-line `": "` shape, kept but no longer absolute: it counts only when the JSON punctuation
     * is what the text is MADE OF. `quoteRuns` counts every `": "` run; `proseRuns` counts clause
     * punctuation. A rule sentence has prose runs and few quote runs; a pasted payload has the reverse.
     */
    if (/":\s*"/u.test(trimmed)) {
      const quoteRuns = (trimmed.match(/":\s*"/gu) ?? []).length
      const proseRuns = (trimmed.match(/[，。；！？：]/gu) ?? []).length
      // A payload dominates: at least two key/value runs, or more quote runs than clause punctuation.
      if (quoteRuns >= 2 || quoteRuns > proseRuns) return true
      return false
    }
    return false
  }
  const endsQuoted = trimmed.endsWith('"') || trimmed.endsWith('",') || trimmed.endsWith('":')
  /**
   * ── S1b: A VERSION NUMBER IS NOT A SENTENCE ENDING (found while fixing S1a) ────────────────────
   *
   * This branch decides "legitimate prose in quotes?" by asking whether the inner text ends in
   * terminal punctuation — and `TERMINAL_PUNCT` includes `.`, so `{"name": "x", "version": "1.0.0",`
   * was treated as finished prose because of the dots in `1.0.0`. A JSON OBJECT FRAGMENT therefore
   * entered the candidate pool — the opposite direction from S1a, which dropped real rules.
   *
   * The discriminator cannot be "contains a dot": `1.0.0` inside a real sentence is normal. What
   * separates them is where the dot sits. A dot between digits is part of a NUMBER, not a full stop;
   * a sentence ends at punctuation that is not flanked by digits.
   */
  if (endsQuoted) {
    const inner = trimmed.replace(/^"/u, '').replace(/"[",:]?$/u, '')
    const sentenceEnded = /[。！？!?]|(?<![0-9])\.(?![0-9])/u.test(inner)
    return !sentenceEnded
  }
  return true
}

/**
 * S2 — a markdown table row.
 *
 * A row starts or ends with `|`. nearMiss: `禁止 用 | 拼接路径。` — a pipe inside a sentence.
 */
function isTableRow(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('|') && !trimmed.endsWith('|')) return false
  // `|` in a real sentence has prose around it; a table row is mostly pipes and cell padding.
  const pipes = (trimmed.match(/\|/gu) ?? []).length
  return pipes >= 2
}

/**
 * S3 — a bulleted LIST OF TERMS: a list marker, no sentence punctuation, and many separated items.
 *
 * This is the shape of a keyword table pasted into a message. nearMiss:
 * `- 必须先跑全量测试再提交，数字不变才算完成。` — a real rule written as a bullet: it has a comma
 * and a full stop, so it is prose.
 */
function isWordList(text: string): boolean {
  const trimmed = text.trim()
  if (!/^[-*•]\s+/u.test(trimmed)) return false
  const body = trimmed.replace(/^[-*•]\s+/u, '')
  if (CLAUSE_PUNCT.test(body)) return false
  const segments = body.split(/[、/｜|,]/u).map((part) => part.trim()).filter((part) => part.length > 0)
  return segments.length >= 4
}

/**
 * S4 — a bare LABEL: ends in a colon, is short, and carries no sentence punctuation.
 *
 * This is `绝对约束（后续所有轮次都不能违反）：` — a heading that introduces something else, not a
 * statement. nearMiss: `绝对约束：禁止在没有备份的情况下删除任何脚本。` — a colon mid-sentence, and
 * the text ends with a full stop.
 */
function isBareLabel(text: string): boolean {
  const trimmed = text.trim().replace(/[",]+\s*$/u, '')
  if (!/[：:]\s*$/u.test(trimmed)) return false
  if (trimmed.length >= 30) return false
  return !CLAUSE_PUNCT.test(trimmed.replace(/[：:]\s*$/u, ''))
}

/**
 * S5 — the text is TALKING ABOUT constraints rather than BEING one.
 *
 * This is the only rule keyed on vocabulary, and the vocabulary is deliberately about META-DESCRIPTION
 * (`关键词表`, `按句提取`, `新增报告字段`, `extractConstraints`), not about constraint words. A report
 * describing an extractor must name these things.
 *
 * ── THE nearMiss THAT CORRECTED THIS RULE (measured) ───────────────────────────────────────────
 *
 * The first version fired whenever a meta phrase appeared and the text lacked terminal punctuation OR
 * was short. It rejected:
 *
 *     我要求你 按句提取 这段日志里的错误行，然后按顺序贴出来。
 *
 * which is a REAL INSTRUCTION ("extract the error lines sentence by sentence") that happens to use a
 * meta-sounding phrase. Killing it is exactly the failure mode this rule is supposed to avoid.
 *
 * So the discriminator is no longer "does it mention the mechanism" but "is it ABOUT the mechanism":
 * a report ANNOUNCES its subject at the start (`这是一份…报告`, `报告显示`, `以下是…结果`) or is a bare
 * noun phrase. A real instruction addresses the reader or starts with a verb.
 */
const META_DESCRIPTION =
  /(关键词表|关键词列表|按句提取|抽取规则|提取规则|新增报告字段|报告字段|extractConstraints|constraint extract\w*|wording pattern|nearMiss|droppedBy)/iu

/** A report announces its subject in its opening characters. An instruction does not. */
const REPORT_ANNOUNCER =
  /^(?:这是|以下是|下面是|报告|测试报告|分析|结论|摘要|摘要：|一、|二、|\d+[.、]\s*(?:结论|报告))|(?:报告|测试|分析)(?:显示|表明|结果|结论)/u

/** An instruction addresses the reader or opens with a verb. */
const INSTRUCTION_OPENING =
  /^(?:请|你|你们|我要求|我让|需要|必须|禁止|不要|务必|记得|注意|先|再|然后|把|将|用|按|write|use|do|run|check|make|ensure|please)/iu

function isMetaDescription(text: string): boolean {
  if (!META_DESCRIPTION.test(text)) return false
  const trimmed = text.trim()
  // A real instruction survives regardless of the meta word.
  if (INSTRUCTION_OPENING.test(trimmed)) return false
  // A report announces itself, or is a bare noun phrase with no verb-like opening.
  return REPORT_ANNOUNCER.test(trimmed) || (!CLAUSE_PUNCT.test(trimmed) && trimmed.length < 40)
}

/**
 * S6 — separator density: the text is mostly punctuation, i.e. a table or a term list.
 *
 * nearMiss: `禁止 rm -rf /、Remove-Item -Recurse 指向盘符根目录。` — comma-dense but a full sentence.
 */
function isSeparatorDense(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length <= 12) return false
  if (TERMINAL_PUNCT.test(trimmed)) return false
  const separators = (trimmed.match(/[、/｜|,，:：]/gu) ?? []).length
  return separators / trimmed.length > 0.3
}

/**
 * Judge one candidate. Order matters: the cheapest structural tests run first, and the first hit wins
 * so the recorded `code` is stable across runs (a text must not change its code because a later rule
 * was reordered).
 */
export function shapeOfConstraint(text: string): ShapeVerdict {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) return { broken: true, code: 'S4_LABEL', why: 'empty text' }

  if (isTableRow(trimmed)) return { broken: true, code: 'S2_TABLE', why: 'markdown table row (leading/trailing |)' }
  if (isJsonFragment(trimmed)) return { broken: true, code: 'S1_JSON', why: 'JSON fragment (unbalanced quoting or ",)' }
  if (isWordList(trimmed)) return { broken: true, code: 'S3_WORDLIST', why: 'bulleted term list (no sentence punctuation, ≥4 segments)' }
  if (isBareLabel(trimmed)) return { broken: true, code: 'S4_LABEL', why: 'bare label (ends in : and carries no statement)' }
  if (isMetaDescription(trimmed)) return { broken: true, code: 'S5_META', why: 'meta-description of a constraint mechanism, not a rule' }
  if (isSeparatorDense(trimmed)) return { broken: true, code: 'S6_SEPARATORS', why: 'separators outnumber content (>30% of characters)' }

  return OK
}
