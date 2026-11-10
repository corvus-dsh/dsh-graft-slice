import { join } from 'node:path'
import { splitSentences } from './task-state.js'
import { truncateEnd } from '../utils/serialize.js'

/**
 * The full sentence a tool pointer occupies, including any wrapper the
 * humanized form added. Removing only the inner `graft_read_result(...)` text
 * leaves dangling prose like "需要细节时用 ）", so the sentence goes as a unit.
 */
/**
 * v6.0: pointer sentences are first-person recollections, e.g.
 * "（回顾：刚才我已经调用 read_file 完成了这一步…读 seq=9）".
 * Matching the whole parenthetical keeps the tool name readable AND removes the
 * sentence cleanly from prose — matching only the inner call would leave a
 * dangling "…读 ）".
 */
/**
 * v7.0: every shape a tool pointer can take, including the downgraded one.
 *
 * `（历史记录：使用了当前环境不支持的工具 X…）` was missing. It is what
 * `describeUnavailableTool()` writes when the target lacks a tool (F3), and
 * without it the older-turn index counted ZERO pointers on any slice whose
 * tools had been downgraded — the index then claimed "no tools in this span"
 * while the tape was full of them. Measured on the real fixture with a
 * two-entry registry: pointerCount 342, olderPointerCount 0.
 */
export const POINTER_SENTENCE_PATTERN =
  /（回顾：[^）]*）|（注：[^）]*）|（历史记录：[^）]*）|\[tool name=[^\]]*seq=\d+[^\]]*\]|^-\s*[^\s(（]+\(seq=\d+(?:,\d+!?)*\)(?:\s*\(unavailable here\))?|前面提到的那些细节都还留着[^\n]*|如果上面提到的细节不够[^\n]*/gmu

export function proseWithoutPointers(text: string): string {
  return text.replace(POINTER_SENTENCE_PATTERN, ' ').replace(/[ \t]{2,}/gu, ' ').trim()
}

export function stripLeadingLabel(text: string): string {
  return text.replace(/^(当前假设|假设|已排除|排除|下一步|接下来)\s*[：:]\s*/u, '').trim()
}

/** v7.7: `splitSentences` moved to `src/core/task-state.ts` — same body, imported below. */
export function pickSentence(sentences: string[], pattern: RegExp, fallback: string): string {
  for (const sentence of sentences) {
    if (pattern.test(sentence)) return stripLeadingLabel(sentence)
  }
  return fallback
}

/**
 * v7.4 P4-2: the shape of a plan sentence is in its FIRST characters.
 *
 * Matching a keyword anywhere is what produced "我接下来需要 源码里还有一行注释
 * 直接声明该设计（L4799）：*\"Since retireSource runs later…\"*" — the word
 * "runs" satisfied the old /run/ test inside a quotation, so a citation became
 * the next action. A real plan announces itself: 下一步 / 接下来 / 待办 / next.
 */
export const PLAN_LEAD_PATTERN =
  /^\s*(?:[-*•]\s*)?(?:下一步|接下来|随后|待办|接着|然后|现在先|现在需要|还需要|需要先|next\b|then\b)/iu

/**
 * v7.0 (borrowed from dsh-rollover-snapshot): stop untrusted text from forging structure.
 *
 * `verbatimConversation` in rollover-snapshot renders user text with
 * `neutralizeHeadings()` for a measured reason: a user message can contain
 * "## Handoff" or "### 接下来", and a replay that quotes it verbatim lets that
 * text become a *section of our own layout*. The reader then cannot tell where
 * our structure ends and their text begins — the same false-certainty failure,
 * moved from truncation to forgery.
 *
 * The graft tape is a different shape (role-prefixed replay lines, not Markdown
 * sections), so the attack surface is narrower, but the same rule applies: a
 * quoted line must never look like a header of the surrounding document.
 *
 * Escaping only the structural lines, never the whole block, is deliberate —
 * escaping everything is what turned a real checkpoint's own table of contents
 * into \\`\\## 你与用户说的\\`, which reads as damage on every crossing.
 */
export const FORGED_HEADING = /^\s{0,3}(?:#{1,6}\s|<\/?h[1-6][^>]*>)/iu

export const FORGED_FENCE = /^\s{0,3}(?:```|~~~)/u

export const FORGED_RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u

export function neutralizeStructure(text: string): string {
  const lines = text.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/u)
  let inFence = false
  return lines
    .map((line) => {
      if (FORGED_FENCE.test(line)) {
        inFence = !inFence
        // A fence inside quoted text must not open a block in our layout.
        return `\\${line.trimStart()}`
      }
      if (inFence) return line
      if (FORGED_HEADING.test(line) || FORGED_RULE.test(line)) {
        return `\\${line.trimStart()}`
      }
      return line
    })
    .join('\n')
}

/**
 * v6.2: PendingState is built from the todo list first, prose second.
 *
 * Free-text extraction produced garbage on a real log. A test name like
 * "An expired token is rejected and removed from sessions" matched the
 * "已排除" regex, and a markdown heading "## Tests" matched "接下来", so the
 * injected state read: "我刚刚排除了 An expired token …。接下来我需要 ## Tests。"
 * That is worse than saying nothing.
 *
 * The model's own todo_write is authoritative: the first unchecked item IS the
 * next action. Prose is only a fallback, and it refuses markdown structure,
 * test names, and anything that is not a sentence.
 */
export const MARKDOWN_NOISE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|`{3}|~{3})/u

export const TEST_NAME_NOISE = /\b(test_|tests?_\w|unittest|pytest|assert|Ran \d+ tests?)/iu

/** Strip a leading label such as "下一步：" so the clause reads naturally. */
export function stripLabel(value: string): string {
  return value
    .replace(/^\s*[-*•]?\s*(当前假设|假设|已排除|排除|下一步|接下来|结论|判断)\s*[：:]\s*/u, '')
    .replace(/^\s*[-*•]\s*/u, '')
    .trim()
}

export function looksLikeProsePlan(sentence: string): boolean {
  const text = sentence.trim()
  if (text.length < 8 || text.length > 300) return false
  if (MARKDOWN_NOISE.test(text)) return false
  if (TEST_NAME_NOISE.test(text)) return false
  // A sentence needs some natural-language shape, not just an identifier.
  if (!/[\u4e00-\u9fff]/u.test(text) && !/\s/u.test(text)) return false
  return true
}

/**
 * v7.0 P9: the natural-language close that replaced the removed wake directive.
 *
 * Declared before its user so the module has no use-before-definition risk even
 * when a bundler hoists differently.
 */
export const CONTINUE_NUDGE = '直接接着刚才的工作继续即可。'

/**
 * v7.3: name the retrieval path at the end of the pending state.
 *
 * The read-back index lists ~24 recent pointers. A reader that wants something
 * older needs to know a search exists — otherwise "the index does not mention it"
 * reads as "it is not there", and the model re-runs the command instead. Naming
 * the tool costs one sentence and turns a dead end into a two-step lookup.
 */
export const SEARCH_HINT =
  '如果有不确定的报错或历史代码，请使用 graft_search_history 搜索，再用 graft_read_result 查看原文。'

/**
 * v7.0: a one-line, concrete account of what the LAST step actually touched.
 *
 * Why this exists — the "zero replay" trade-off:
 *
 * Once the tape drops to 0-1 turns, the target no longer reads the last exchange.
 * Everything it knows about the immediate situation comes from the structured
 * blocks. A pending state that only says "I need to continue pushing <goal>"
 * gives it the task but not the scene: which file was open, which function was
 * being changed, what the failure actually said. The model then re-explores to
 * rebuild that scene, which is exactly the cost the tape was supposed to avoid.
 *
 * So this extracts the three facts that make a scene: the most recent file
 * touched, the most recent tool that produced an error, and the error's own
 * words. All three come from the log, so they are facts, not paraphrase.
 */
export interface LastStepScene {
  file?: string
  action?: string
  failingTool?: string
  errorText?: string
  /** v7.2: the seq of the failing tool/result, so the error can be traced back. */
  errorSeq?: number
  /** v7.2: the failing result's full text (bounded), for inline display. */
  errorBody?: string
  /** v7.2: whether `errorBody` had to be cut. */
  errorTruncated?: boolean
}

/**
 * v7.0: render the scene as one sentence of first-person recall.
 *
 * Stated as memory ("I was just…"), not as a label, because a label invites the
 * model to treat it as an instruction; a recollection invites it to continue.
 */
/**
 * v7.2: render the scene, then inline the failure's own text.
 *
 * The one-line summary names what failed; the body below is what it SAID. Both
 * are needed for continuous debugging: the summary tells the reader where to
 * look, the body saves it the round trip. Without the body, "the last pwsh call
 * failed" is a fact the model must spend a tool call to expand — on every single
 * migration, which is exactly when it can least afford one.
 *
 * The body is fenced so a stack trace containing markdown cannot restructure the
 * pending state, and labelled with its seq so the reader can still reach the
 * original if the 2000-char cut removed the part it needed.
 */
export function renderLastStepScene(scene: LastStepScene): string {
  const parts: string[] = []
  if (scene.file !== undefined) {
    const verb = scene.action === 'write' ? '写' : '改'
    parts.push(`最后一步我在${verb} ${scene.file}`)
  }
  if (scene.failingTool !== undefined) {
    const detail = scene.errorText === undefined || scene.errorText.length === 0 ? '' : `，报错是「${scene.errorText}」`
    parts.push(`最后跑的 ${scene.failingTool} 失败了${detail}`)
  }
  const summary = parts.length === 0 ? '' : `${parts.join('；')}。`
  if (scene.errorBody === undefined || scene.errorBody.length === 0) return summary
  const body = neutralizeStructure(scene.errorBody)
  const cut = scene.errorTruncated === true ? '\n…[已截断]' : ''
  const header =
    scene.errorSeq === undefined
      ? '最后一条报错原文：'
      : `最后一条报错原文（seq=${scene.errorSeq}）：`
  const block = `${header}\n${body}${cut}`
  // The caller joins the scene with the following line, so the block must end
  // with its own terminator. Without it the error's last line ran straight into
  // "我接下来需要…", and a stack trace's final frame read as part of the plan.
  const terminated = /[。.!！?？:：\n]$/u.test(block) ? block : `${block}。`
  return summary.length === 0 ? terminated : `${summary}\n\n${terminated}`
}

/**
 * v7.4b (硬约束 4): the breakpoint outranks the todo list when they disagree.
 *
 * The pending state opens with `openTodos[0]` because a written plan is the
 * most authoritative statement of intent — but a todo list is a snapshot taken
 * BEFORE the cut, and the open turn after it may already have performed the
 * first item. Measured on `handoff-demo`: the list said
 * "用 graft_prepare 真机体检…" while the carryover ended with
 * `graft_prepare(seq=14965)` and the model's own "提交" line. A reader that
 * trusts the list re-issues a side-effecting tool that already ran — for
 * `graft_commit` that is a second migration of the same session.
 *
 * So: when the open-turn tail names the tool the first open todo names, say so
 * instead of hiding it. The instruction stays; the doubt is attached to it.
 */
export function staleTodoHint(
  openTodo: string | undefined,
  lastOpenCall: { readonly tool: string; readonly seq: number } | undefined,
): string | undefined {
  if (openTodo === undefined || lastOpenCall === undefined) return undefined
  const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '')
  const tool = squash(lastOpenCall.tool)
  if (tool.length === 0 || !squash(openTodo).includes(tool)) return undefined
  return `断点前我刚发出过 ${lastOpenCall.tool}(seq=${lastOpenCall.seq})，这一项可能已经做完了——先核对它的结果，不要直接重跑。`
}

export function buildPendingState(
  lastTurnText: string,
  goal: string,
  sourceSessionId: string | undefined,
  pointerCount: number,
  openTodos: readonly string[] = [],
  scene: LastStepScene = {},
  lastOpenCall?: { readonly tool: string; readonly seq: number },
  todoFreshness?: { readonly todoSeq?: number; readonly newerSuccesses: number },
  /**
   * v0.32 P1: a todo_write exists even when it has no open items.
   *
   * The fallback below reads the last turn's prose, which is a different claim
   * from "the model's written list is finished". On a long session that prose can
   * still name an older plan, and the board presented it as the next action. A
   * finished written plan must be stated as finished, not recycled.
   */
  hasWrittenPlan = false,
): string {
  const lines: string[] = []

  // v7.0: the scene comes FIRST when the tape is short.
  //
  // With zero or one replayed turn, this line is the only thing that says where
  // the work physically stopped. Putting it after the goal would bury the one
  // concrete fact under the most abstract one.
  const sceneText = renderLastStepScene(scene)
  if (sceneText.length > 0) lines.push(sceneText)

  if (openTodos.length > 0) {
    // Authoritative path: the model already wrote down what remains.
    const next = openTodos[0].replace(/\s+/gu, ' ').trim()
    lines.push(`我接下来需要立刻执行：${truncateEnd(next, 260).text}。`)
    const stale = staleTodoHint(next, lastOpenCall)
    if (stale !== undefined) lines.push(stale)
    if (openTodos.length > 1) {
      const rest = openTodos
        .slice(1, 4)
        .map((item) => truncateEnd(item.replace(/\s+/gu, ' ').trim(), 120).text)
      lines.push(`再往后还有：${rest.join('；')}。`)
    }
    // v7.5: a list written before N successful calls is a CLAIM, not the current state.
    //
    // Measured on a live handoff: the pending said "立刻执行：推送 v0.8.0（等确认）" while the
    // push had already happened. The list was stale; nothing on screen said so.
    if (todoFreshness !== undefined && todoFreshness.newerSuccesses >= 3 && todoFreshness.todoSeq !== undefined) {
      lines.push(
        `（清单写于 seq=${todoFreshness.todoSeq}，之后又有 ${todoFreshness.newerSuccesses} 次成功的工具调用——` +
          '某项可能已完成，先核对再重跑。）',
      )
    }
  } else if (hasWrittenPlan) {
    // v0.32 P1: the model's latest write exists and has nothing open. Say that.
    // Falling through to prose here is how an older "P1-1/P1-2"-style plan got
    // presented as the current next action.
    lines.push('我写的待办清单已全部完成；接下来按「这个会话的任务」做最后验证与收尾。')
  } else {
    // Fallback: prose, but only sentences that survive the noise filter.
    const prose = proseWithoutPointers(lastTurnText)
    const sentences = splitSentences(prose)
    const excluded = pickSentence(
      sentences,
      /(排除|放弃|不再|否决|ruled out|rejected|not viable|dead end|does not work)/iu,
      '',
    )
    // v7.4 P4-2: anchor the plan pattern at the SENTENCE LEAD.
    //
    // The old pattern matched the substring anywhere, so an English aside like
    // "since retireSource runs later" scored as a plan and the pending state read
    // "我接下来需要 源码里还有一行注释直接声明该设计（L4799）…". A plan sentence
    // announces itself at the front; a citation or an aside does not.
    const next = pickSentence(sentences, PLAN_LEAD_PATTERN, '')
    const excludedText = looksLikeProsePlan(excluded) ? stripLabel(excluded) : ''
    const nextText = looksLikeProsePlan(next) ? stripLabel(next) : ''
    if (excludedText.length > 0) lines.push(`我刚刚排除了 ${truncateEnd(excludedText, 260).text}。`)
    if (nextText.length > 0) {
      // v7.4 P4-2: a conditional is a PRECONDITION, not an action.
      //
      // "我接下来需要 如果 X 就 Y。" glues an if-clause onto a declarative frame:
      // ungrammatical, and — worse — it reads as an order to do X now. The
      // natural form foregrounds the action and demotes the condition:
      // "我接下来需要继续推进，前提是 …".
      const cut = truncateEnd(nextText, 260).text
      if (/^(?:如果|若|假如|假设|要是|除非|一旦)/u.test(cut)) {
        lines.push(
          `我接下来需要继续推进，前提是 ${cut.replace(/^(?:如果|若|假如|假设|要是|除非|一旦)\s*/u, '')}。`,
        )
      } else {
        lines.push(`我接下来需要 ${cut}。`)
      }
    } else {
      // v7.0: do NOT quote the goal here.
      //
      // The goal is multi-anchor since P2 (up to three joined messages, with
      // newlines). Wrapping it in 「…」 produced a wall of quoted text that read
      // as damaged prose and repeated what the goal message already says. The
      // goal lives one message above; this line only has to point at it.
      // v7.3.1: point at the goal by its honest label.
      //
      // The goal is the session's task, which may already be substantially done.
      // This line only fires when the model left NO open todo, so "continue the
      // task" is the only available next action — but it must name the same label
      // the goal message uses, or the reference dangles.
      lines.push('我接下来需要按上面「这个会话的任务」继续推进，并验证结果。')
    }
  }

  // v7.2: join with newlines, not with ''.
  //
  // The concatenation was fine while every line was a short sentence. Since the
  // scene can now carry a multi-line error body, `join('')` ran the stack trace's
  // last frame straight into the next sentence ("at test.ts:3我接下来需要…"),
  // which reads as one broken line and makes the plan look like part of the error.
  let text = lines.join('\n')
  if (sourceSessionId !== undefined && pointerCount > 0) {
    text += `\n\n前面提到的那些细节都还留着。如果哪一步需要原文，我就用 graft_read_result，sourceSessionId 传 ${sourceSessionId}，seq 传回忆句里写的编号。`
  }
  // v7.0 P9: the directive became a sentence in the assistant's own voice.
  //
  // A separate "系统强制指令" block told the reader it was looking at a system
  // document. The same intent, phrased as the last beat of an inner monologue,
  // keeps the recency position inside the conversation instead of outside it.
  if (text.length > 0) text += `\n\n${SEARCH_HINT}\n${CONTINUE_NUDGE}`
  return text
}
