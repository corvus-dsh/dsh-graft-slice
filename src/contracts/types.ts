/**
 * ── S1b-2: THE MODEL-WORDING CONTRACTS ───────────────────────────────────────────────────────────
 *
 * Every regex in this file parses ENGLISH OR CHINESE PROSE that a MODEL wrote. That is why they are
 * separated from the mechanical ones (paths, whitespace, markdown stripping): a path pattern and a
 * "is this a standing rule?" pattern fail in completely different ways.
 *
 * ── WHAT A CONTRACT IS, AND WHAT IT IS NOT ──────────────────────────────────────────────────────
 *
 * A contract here is:
 *   - a NAMED pattern, so tests and logs can refer to it by name instead of by line number;
 *   - a stated INTENT in one sentence, so the next reader knows what question it answers;
 *   - SAMPLES taken from REAL session logs (never invented), so the pattern is pinned to text that
 *     actually occurs;
 *   - NEAR MISSES — text that looks like a hit but must NOT match — each tagged with where it came
 *     from, because a near miss I invented proves nothing.
 *
 * A contract is NOT a promise that the pattern is right. Two of the four below are explicitly
 * labelled HEURISTIC with a known boundary written in their comment. Marking a method's limit is more
 * honest than pretending a wider word list would fix it.
 *
 * ── NO LINE NUMBERS, EVER ──────────────────────────────────────────────────────────────────────
 *
 * Every entry here is located by NAME. The first attempt at this inventory used line numbers
 * (`pick(1319)`, `pick(2865)`) and two of them had already drifted to 1318 / 2880, so the harvest
 * silently reported "0 hits" for patterns that were right there. A line number is a fact about a
 * moment; a name survives the edit that moves it.
 */
export interface WordingPattern {
  /** Stable name. Tests, logs and the harvest scripts all refer to a contract by this. */
  readonly name: string
  /** The pattern itself. */
  readonly re: RegExp
  /**
   * What this pattern is FOR, in one sentence, phrased as the question it answers.
   * Written so that "should this be applied here?" is answerable without reading the regex.
   */
  readonly intent: string
  /**
   * Verbatim text from a REAL session log, with the log id and seq, so it can be re-found.
   * At least two; a single sample cannot distinguish "this pattern" from "this one sentence".
   */
  readonly samples: readonly PatternSample[]
  /**
   * Text that resembles a hit and must NOT match. Each one states WHERE it came from:
   * a real misfire found while scanning the logs, or a construction with a stated reason.
   */
  readonly nearMisses: readonly PatternNearMiss[]
  /**
   * Anything a reader must know before trusting the pattern: a known boundary, a deliberate
   * exclusion, a reason the vocabulary is not being narrowed. This field is why the contracts exist.
   */
  readonly caveat?: string
}

export interface PatternSample {
  readonly text: string
  /** Which persisted log this came from (directory + session id), or `fixture:<file>`. */
  readonly source: string
  /** The event seq inside that log, so the text can be located again. */
  readonly seq: number
}

export interface PatternNearMiss {
  readonly text: string
  /**
   * `real-misfire` — the pattern DOES match this in the logs, and that is wrong.
   * `real-nearby`  — this text occurs in the logs and the pattern does NOT match it, which is the
   *                  boundary we intend.
   * `synthetic`    — no occurrence exists in the corpus; the reason is stated.
   */
  readonly kind: 'real-misfire' | 'real-nearby' | 'synthetic'
  readonly why: string
}
