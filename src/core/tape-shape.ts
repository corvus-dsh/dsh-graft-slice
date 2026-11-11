export interface GraftSource {
  kind: string
  provider?: string
  model?: string
}

export interface GraftTapeTurn {
  turn: number
  text: string
  assistantMessages: number
  pointers: number
  firstSeq: number
  lastSeq: number
  /** v7.0: verbatim user messages that opened this turn, newest last. */
  userTexts?: string[]
  /** v7.0: assistant text for this turn, already pointer-annotated. */
  assistantText?: string
  /** v7.0: rendered replay block; falls back to `text` when absent. */
  replay?: string
}

export interface GraftBoundary {
  boundarySeq: number
  lastTurn: number
  turnCount: number
  lastTurnReason: string
}

export interface GraftTape {
  boundary: GraftBoundary
  sourceTemplate: GraftSource
  turns: GraftTapeTurn[]
  goal: string
  goalSource: 'user' | 'fallback-user' | 'assistant' | 'placeholder'
  phase: string
  pendingStateText: string
  pointerCount: number
  /** v0.19: the semantic state the instruction card was built from (evidence). */
  semantic?: SemanticState
  /** v7.0 P5: replays found in the source log and refused (present only when > 0). */
  replayedMessagesSkipped?: number
}
