/**
 * Decision seam definitions (the decision family: takes state and typed questions, returns typed
 * answers with probabilities; ADR-0036, ADR-0037). The first is the dispatch advisor
 * (`ctx.dispatchAdvisor`; PROP-0015 J1, docs/design/workflow-engine.md#the-dispatch-advisor-in-shadow),
 * asked in shadow at every dispatch choice. PROP-0002's `decisions` seam, typed decisions for intake
 * and routing, is planned here too.
 *
 * The dispatch advisor, for one dispatch choice, is given a snapshot of **features only** (D73: kind,
 * template, step, the admitted candidates by alias with their quota lines and recorded counts; never
 * a task's title, goal, or any other text) and answers, in one call, three typed probabilities per
 * candidate (`dispatch-advice@1`): accepted, a limit mid-task, and needs the operator, under the
 * provider's pinned model version; or `unavailable` with why. Nothing it answers changes the choice:
 * its consumer (the workflow engine's dispatch pass) records it beside the choice, as its input.
 *
 * Its providers: the abstract {@link DispatchAdvisor} owns the key, so a plugin may provide the seam;
 * the workflow engine's own `local` and `model` advisors answer the same call ({@link Advisor}) when
 * `dispatch.advisor.provider` names them. Every provider passes `conformance/dispatch-advisor.ts`.
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { ADVICE_QUESTION_SET, ADVICE_QUESTIONS, type AdviceQuestion } from '@tsuuanmi/system-libs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dispatchAdvisor: DispatchAdvisor
  }
}

/** The contract this definition and its suite are at (`conformance/dispatch-advisor.ts`). */
export const DISPATCH_ADVISOR_CONTRACT = '1.0'

/** The question set every provider answers (`modelAnswers[].questionSetVersion`). */
export const QUESTION_SET = ADVICE_QUESTION_SET
/** The feature snapshot's version. */
export const FEATURES_SCHEMA = 'dispatch-features@1'
/** The questions, per candidate alias: `accepted:<alias>`, `limit:<alias>`, `needs-operator:<alias>`. */
export const QUESTIONS = ADVICE_QUESTIONS
export type Question = AdviceQuestion
/** Candidates one snapshot holds at most (INV-9; PROP-0015 `advisor.maxCandidates`). */
export const MAX_CANDIDATES = 8
/** The candidates' aliases, in order: the chosen one is always `A`. */
export const ALIASES = 'ABCDEFGH'

/** One window of a candidate's account, as the quota score read it: numbers only. */
export interface AdvisorWindow {
  /** The window's length in seconds, when known. */
  seconds?: number
  known: boolean
  used?: number
  headroom?: number
  resetsInMinutes?: number
}

/** A candidate's recorded outcomes for this kind of work, at the time of the choice (from `workflow.dispatch.outcome`). */
export interface AdvisorCounts {
  attempts: number
  accepted: number
  limited: number
  operator: number
}

/** One admitted candidate, by alias: never its Worker id, account, or anything a person wrote. */
export interface AdvisorCandidate {
  alias: string
  tier: string
  tierRank: number
  quotaClass: string
  metered: boolean
  free: boolean
  load?: { running: number; slots: number }
  windows: AdvisorWindow[]
  counts: AdvisorCounts
}

/** What an advisor is given for one dispatch choice (`dispatch-features@1`). */
export interface AdvisorFeatures {
  schema: typeof FEATURES_SCHEMA
  questionSet: typeof QUESTION_SET
  /** The step's kind (ADR-0057), when it names one. */
  kind?: string
  template: string
  step: string
  reservePercent: number
  candidates: AdvisorCandidate[]
}

/** The three probabilities for one candidate. */
export interface CandidateAdvice {
  alias: string
  accepted: number
  limit: number
  needsOperator: number
}

/** An advisor's answer: every candidate's probabilities, or why there are none. */
export type Advice =
  | { status: 'advice'; provider: string; modelVersion: string; candidates: CandidateAdvice[] }
  | { status: 'unavailable'; provider: string; modelVersion?: string; reason: string }

/**
 * How an advisor learns that its call was stopped (its time is up). Deliberately not an
 * `AbortSignal`: an `EventTarget` reports a listener's throw as an uncaught exception on a later
 * tick, which no try/catch around the abort contains, so one advisor's faulty listener would end
 * the process. Here every listener is called inside a guard: one that throws or rejects is recorded
 * with the call and ignored. An advisor that needs an `AbortSignal` (for `fetch`, say) makes its own
 * controller and aborts it from {@link AdvisorSignal.onAbort}; that controller's listeners are its own.
 */
export interface AdvisorSignal {
  /** True once the call is stopped. */
  readonly aborted: boolean
  /** Call `listener` once when the call is stopped (soon after, if it already is); returns what removes it. */
  onAbort(listener: () => unknown): () => void
}

/**
 * The call every dispatch advisor answers: once per dispatch choice. An implementation answers every
 * candidate of `features` once, or says why it cannot; it may throw, and it should stop when `signal`
 * says the call is stopped. It never sees the Worker ids behind the aliases, and nothing it answers
 * changes the choice. Every provider passes the seam's conformance suite (`conformance/dispatch-advisor.ts`).
 */
export interface Advisor {
  /** The provider's id, recorded as `modelAnswers[].provider` (at most 64 characters). */
  readonly id: string
  advise(features: AdvisorFeatures, signal: AdvisorSignal): Promise<Advice>
}

/**
 * The seam: `ctx.dispatchAdvisor`, a dispatch advisor a plugin provides. While one is registered, the
 * dispatch pass asks it in place of the advisor `dispatch.advisor.provider` configures (workflow
 * contract 1.12), within the same time and hourly bounds, and records what it says, or that it
 * failed, beside the choice; nothing it says changes a choice.
 */
export abstract class DispatchAdvisor extends Service implements Advisor {
  constructor(ctx: Context) {
    super(ctx, 'dispatchAdvisor')
  }

  /** The provider's id, recorded as `modelAnswers[].provider` (at most 64 characters). */
  abstract readonly id: string

  /** One call per dispatch choice: advice on exactly the candidates of `features`, or unavailable with why. */
  abstract advise(features: AdvisorFeatures, signal: AdvisorSignal): Promise<Advice>
}

/**
 * A call's stop: the signal an advisor is given, and `stop`, which marks it stopped and calls every
 * listener inside a guard, returning what each one that threw said (a rejection is caught too). Its
 * failures can only be recorded: nothing an advisor registers runs where its throw could escape.
 */
export function advisorStop(): { signal: AdvisorSignal; stop: () => string[] } {
  let aborted = false
  const listeners = new Set<() => unknown>()
  const failures: string[] = []
  const call = (listener: () => unknown): void => {
    try {
      const result = listener() as unknown
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') Promise.resolve(result as PromiseLike<unknown>).catch((error: unknown) => void failures.push(messageOf(error)))
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  const signal: AdvisorSignal = Object.freeze({
    get aborted() {
      return aborted
    },
    onAbort(listener: () => unknown): () => void {
      if (typeof listener !== 'function') throw new TypeError('onAbort takes a function')
      if (aborted) {
        queueMicrotask(() => call(listener))
        return () => undefined
      }
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  })
  const stop = (): string[] => {
    if (!aborted) {
      aborted = true
      const all = [...listeners]
      listeners.clear()
      for (const listener of all) call(listener)
    }
    return [...failures]
  }
  return { signal, stop }
}

/** An error's message, bounded; never throws. */
export function messageOf(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 240)
  } catch {
    return 'an error that cannot be shown'
  }
}

const isProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/** Why an answer is not advice on exactly these candidates, or undefined when it is. */
export function adviceProblem(advice: unknown, features: AdvisorFeatures): string | undefined {
  if (!advice || typeof advice !== 'object') return 'the answer is not an object'
  const a = advice as { status?: unknown; provider?: unknown; reason?: unknown; modelVersion?: unknown; candidates?: unknown }
  if (a.provider !== undefined && (typeof a.provider !== 'string' || !a.provider)) return `the provider must be a non-empty string, not ${a.provider === null ? 'null' : typeof a.provider}`
  if (a.status === 'unavailable') {
    if (a.modelVersion !== undefined && (typeof a.modelVersion !== 'string' || !a.modelVersion)) return 'a model version, when given, must be a non-empty string'
    return typeof a.reason === 'string' && a.reason ? undefined : 'unavailable with no reason'
  }
  if (a.status !== 'advice') return `status ${JSON.stringify(a.status)} is neither advice nor unavailable`
  if (typeof a.modelVersion !== 'string' || !a.modelVersion || a.modelVersion.length > 64) return 'no model version (1 to 64 characters): an unpinned answer is not recorded as advice'
  if (!Array.isArray(a.candidates)) return 'no candidates'
  const answered = a.candidates as Array<Partial<CandidateAdvice> | null | undefined>
  const want = features.candidates.map((c) => c.alias)
  const got = answered.map((c) => String(c?.alias))
  if (got.length !== want.length || want.some((alias) => !got.includes(alias))) return `it answers ${got.join(', ') || 'no candidate'}, not exactly ${want.join(', ')}`
  for (const c of answered) {
    if (!isProbability(c?.accepted) || !isProbability(c?.limit) || !isProbability(c?.needsOperator)) return `candidate ${String(c?.alias)}: every probability must be a number from 0 to 1`
  }
  return undefined
}
