/**
 * Calibration of the dispatch advisor's probabilities (PROP-0015 J1): the questions it answers per
 * candidate (`dispatch-advice@1`), the event-log entries a dispatch choice's advice and its outcome are
 * recorded in, and the Brier score of each question. One implementation, read by the workflow engine
 * (which records them) and by the report (which scores them).
 */

/** The questions the advisor answers per candidate alias: `accepted:<alias>`, `limit:<alias>`, `needs-operator:<alias>`. */
export const ADVICE_QUESTIONS = ['accepted', 'limit', 'needs-operator'] as const
export type AdviceQuestion = typeof ADVICE_QUESTIONS[number]
/** The question set's version (`modelAnswers[].questionSetVersion`). */
export const ADVICE_QUESTION_SET = 'dispatch-advice@1'
/** Recorded at every dispatch choice: the advisor's decision on it, advice or unavailable. */
export const ADVICE_EVENT = 'workflow.dispatch.advised'
/** Recorded once a dispatched attempt's run reported its task: its labels, and the advice decision of its choice. */
export const ADVICE_OUTCOME_EVENT = 'workflow.dispatch.outcome'
/** D74: dispatched attempts with outcomes the advice runs in shadow for before it may be shown (J2). */
export const ADVICE_SHADOW_ATTEMPTS = 100

/** One question's calibration over the attempts scored. */
export interface QuestionScore {
  question: AdviceQuestion
  /** Attempts scored: those advised whose outcome is known. */
  scored: number
  /** The mean of (p − outcome)²: 0 is best, 0.25 is always answering 0.5. */
  brier: number
  /** The share of the outcomes that were yes. */
  rate: number
  /** The Brier score of always answering that share (in sample): the baseline the advice must beat. */
  baseline: number
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6

/** The Brier score of each question over (probability, outcome) pairs, in the questions' order; none for a question with no pair. */
export function brierScores(pairs: ReadonlyArray<{ question: AdviceQuestion; p: number; y: 0 | 1 }>): QuestionScore[] {
  return ADVICE_QUESTIONS.flatMap((question) => {
    const mine = pairs.filter((x) => x.question === question)
    if (!mine.length) return []
    const rate = mine.reduce((s, x) => s + x.y, 0) / mine.length
    const brier = mine.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / mine.length
    const baseline = mine.reduce((s, x) => s + (rate - x.y) ** 2, 0) / mine.length
    return [{ question, scored: mine.length, brier: round(brier), rate: round(rate), baseline: round(baseline) }]
  })
}
