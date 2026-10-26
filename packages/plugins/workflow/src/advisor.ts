/**
 * The dispatch advisor (PROP-0015 J1, in shadow; docs/design/workflow-engine.md#the-dispatch-advisor-in-shadow):
 * the consumer side of the seam `ctx.dispatchAdvisor`, whose definition, vocabulary, and conformance
 * suite are in `@tsuuanmi/system-decision-core` (ADR-0037). For one dispatch choice an advisor is
 * given a snapshot of **features only** (D73: kind, template, step, the admitted candidates by alias
 * with their quota lines and recorded counts; never a task's title, goal, or any other text) and
 * answers, in one call, three typed probabilities per candidate (`dispatch-advice@1`): accepted, a
 * limit mid-task, and needs the operator, with the provider's model and version id.
 *
 * - **Shadow only.** Dispatch chooses its Worker by `quota-score@2` before the advisor is asked; the
 *   advice is recorded as a `route` decision (rule or model `advisor.dispatch`) that the `dispatch.choice`
 *   decision names as an input (INV-13), and nothing reads it to choose.
 * - **Fail closed, with a defined path.** An error, a timeout, a malformed answer, the call bound, or a
 *   provider without enough data is recorded as `unavailable` with why, and the choice proceeds as before.
 * - **Providers:** `none` (the default: off, nothing is asked); `local`, a regularized logistic regression
 *   fitted on System's own recorded dispatch outcomes, in this process (no data leaves the host),
 *   `insufficient data` until `minLabelled` labelled attempts exist; `model`, a configured model Worker
 *   (a metered entry of the models row, say) called through `ctx.workers` with a JSON schema, off
 *   unless configured.
 * - **Calibration:** each dispatched attempt whose outcome is reported records its labels
 *   (`workflow.dispatch.outcome`), so the report scores every question (Brier score) once outcomes exist.
 *
 * Nothing here names a vendor (INV-11): the model adapter names a Worker id from configuration.
 */
import {
  adviceProblem, type Advice, type Advisor, type AdvisorCandidate, type AdvisorCounts, type AdvisorFeatures, type AdvisorSignal, type AdvisorWindow, advisorStop, ALIASES,
  type CandidateAdvice, FEATURES_SCHEMA, MAX_CANDIDATES, messageOf, type Question, QUESTION_SET, QUESTIONS,
} from '@tsuuanmi/system-decision-core'
import { ADVICE_EVENT, ADVICE_OUTCOME_EVENT, ADVICE_SHADOW_ATTEMPTS, brierScores, contentId, type QuestionScore, type ScoredCandidate } from '@tsuuanmi/system-libs'
import type { ArtifactRef, WorkerExecution, WorkRequirement } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { newId } from './types.ts'

// The seam's vocabulary, defined in decision-core, as this package has exported it since contract 1.11.
export { adviceProblem, advisorStop, QUESTION_SET, QUESTIONS }
export type { Advice, Advisor, AdvisorCandidate, AdvisorCounts, AdvisorFeatures, AdvisorSignal, AdvisorWindow, CandidateAdvice, Question }
/** D74: dispatched attempts with outcomes the shadow period runs for before the advice may be shown (J2). */
export const SHADOW_ATTEMPTS = ADVICE_SHADOW_ATTEMPTS
/** The event a choice's advice decision is announced in. */
export const ADVISED_EVENT = ADVICE_EVENT
export { brierScores, type QuestionScore }
/** Candidates one snapshot holds at most (INV-9; PROP-0015 `advisor.maxCandidates`). */
export const MAX_ADVISED = MAX_CANDIDATES
/** Outcomes the local adapter fits on at most, the latest (INV-9). */
export const MAX_TRAINING = 2000

/** The advisor's settings (`dispatch.advisor`). */
export interface AdvisorConfig {
  /** `none` (default): no advisor, the features still recorded; `local`: logistic regression on this host; `model`: the configured model Worker. */
  provider?: 'none' | 'local' | 'model'
  /** Milliseconds one call may take, then it is recorded as unavailable (100 to 120000, default 2000). */
  timeoutMs?: number
  /** Calls in any hour at most (1 to 10000, default 120); past it, unavailable (INV-9). */
  maxPerHour?: number
  /** Labelled dispatched attempts the local adapter needs before it answers (10 to {@link MAX_TRAINING}, the examples it keeps; default 30). */
  minLabelled?: number
  /** The local adapter's L2 penalty (0.001 to 1000, default 1). */
  l2?: number
  /** The model Worker the `model` adapter calls (a `model:<id>` Worker of the models row) and its output bound. */
  model?: { worker: string; maxTokens?: number }
}

export interface AdvisorSettings {
  provider: 'none' | 'local' | 'model'
  timeoutMs: number
  maxPerHour: number
  minLabelled: number
  l2: number
  model?: { worker: string; maxTokens: number }
}

const NUMBERS: Record<'timeoutMs' | 'maxPerHour' | 'minLabelled', readonly [number, number, number]> = { timeoutMs: [100, 120_000, 2000], maxPerHour: [1, 10_000, 120], minLabelled: [10, MAX_TRAINING, 30] }

/** Every problem of `dispatch.advisor`, by path; empty when it loads. */
export function advisorProblems(given: unknown): string[] {
  if (given === undefined) return []
  if (given === null || typeof given !== 'object' || Array.isArray(given)) return ['dispatch.advisor must be an object']
  const a = given as Record<string, unknown>
  const problems: string[] = []
  if (a['provider'] !== undefined && !['none', 'local', 'model'].includes(a['provider'] as string)) problems.push(`dispatch.advisor.provider must be none, local, or model, not ${JSON.stringify(a['provider'])}`)
  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    const value = a[key]
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < min || (value as number) > max)) problems.push(`dispatch.advisor.${key} must be a whole number from ${min} to ${max}, not ${JSON.stringify(value)}`)
  }
  if (a['l2'] !== undefined && (typeof a['l2'] !== 'number' || !(a['l2'] >= 0.001 && a['l2'] <= 1000))) problems.push(`dispatch.advisor.l2 must be a number from 0.001 to 1000, not ${JSON.stringify(a['l2'])}`)
  const model = a['model'] as Record<string, unknown> | undefined
  if (model !== undefined) {
    if (model === null || typeof model !== 'object' || Array.isArray(model)) problems.push('dispatch.advisor.model must be an object {worker, maxTokens}')
    else {
      if (typeof model['worker'] !== 'string' || !/^\S{1,200}$/.test(model['worker'])) problems.push('dispatch.advisor.model.worker must be a Worker id (1 to 200 characters, no whitespace)')
      if (model['maxTokens'] !== undefined && (!Number.isInteger(model['maxTokens']) || (model['maxTokens'] as number) < 64 || (model['maxTokens'] as number) > 8192)) problems.push(`dispatch.advisor.model.maxTokens must be a whole number from 64 to 8192, not ${JSON.stringify(model['maxTokens'])}`)
      for (const key of Object.keys(model)) if (!['worker', 'maxTokens'].includes(key)) problems.push(`dispatch.advisor.model.${key} is not an option (worker, maxTokens)`)
    }
  }
  if (a['provider'] === 'model' && model === undefined) problems.push('dispatch.advisor.provider model needs dispatch.advisor.model.worker: the model Worker to ask')
  const known = new Set(['provider', 'l2', 'model', ...Object.keys(NUMBERS)])
  for (const key of Object.keys(a)) if (!known.has(key)) problems.push(`dispatch.advisor.${key} is not an option (${[...known].join(', ')})`)
  return problems
}

/** The settings in force; call after {@link advisorProblems} found none. */
export function advisorSettings(given: AdvisorConfig | undefined): AdvisorSettings {
  const a = given ?? {}
  return {
    provider: a.provider ?? 'none', timeoutMs: a.timeoutMs ?? NUMBERS.timeoutMs[2], maxPerHour: a.maxPerHour ?? NUMBERS.maxPerHour[2], minLabelled: a.minLabelled ?? NUMBERS.minLabelled[2], l2: a.l2 ?? 1,
    ...(a.model ? { model: { worker: a.model.worker, maxTokens: a.model.maxTokens ?? 1024 } } : {}),
  }
}

// --- the features ---

/** What dispatch knows of one scored candidate, beside its score: never text. */
export interface CandidateFacts {
  scored: ScoredCandidate
  tier: string
  tierRank: number
  quotaClass: string
  metered: boolean
  load?: { running: number; slots: number }
  /** The key its recorded counts are kept under (its account, or its Worker id); never sent. */
  countsKey: string
}

/**
 * The snapshot for one choice, and which Worker each alias stands for (kept on the decision, never
 * sent). The chosen Worker is `A`, then the other admitted candidates in the score's order, at most
 * {@link MAX_ADVISED}. Only numbers, enumerations, and the template's own names go in; a task's
 * title and goal are not parameters, so they cannot.
 */
export function featuresOf(input: { kind?: string; template: string; step: string; reservePercent: number; chosen: string; candidates: CandidateFacts[]; counts: (key: string, kind: string | undefined) => AdvisorCounts }): { features: AdvisorFeatures; aliases: Record<string, string> } {
  const admitted = input.candidates.filter((c) => c.scored.admitted)
  const ordered = [...admitted.filter((c) => c.scored.worker === input.chosen), ...admitted.filter((c) => c.scored.worker !== input.chosen)].slice(0, MAX_ADVISED)
  const aliases: Record<string, string> = {}
  const candidates = ordered.map((c, i): AdvisorCandidate => {
    const alias = ALIASES[i]!
    aliases[alias] = c.scored.worker
    const windows = (c.scored.quota?.pools ?? []).flatMap((p) => p.windows).slice(0, 8).map((w): AdvisorWindow => ({
      known: w.known, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}), ...(w.used !== undefined ? { used: w.used } : {}),
      ...(w.headroom !== undefined ? { headroom: w.headroom } : {}), ...(w.resetsInMinutes !== undefined ? { resetsInMinutes: w.resetsInMinutes } : {}),
    }))
    return {
      alias, tier: c.tier, tierRank: c.tierRank, quotaClass: c.quotaClass, metered: c.metered, free: c.scored.free,
      ...(c.load ? { load: { running: c.load.running, slots: c.load.slots } } : {}), windows, counts: input.counts(c.countsKey, input.kind),
    }
  })
  return {
    features: { schema: FEATURES_SCHEMA, questionSet: QUESTION_SET, ...(input.kind !== undefined ? { kind: input.kind } : {}), template: input.template, step: input.step, reservePercent: input.reservePercent, candidates },
    aliases,
  }
}

// --- the local adapter: a regularized logistic regression ---

/** One labelled dispatched attempt: the chosen candidate's features then, and what came of it. */
export interface Labelled {
  candidate: AdvisorCandidate
  reservePercent: number
  labels: Record<Question, 0 | 1>
}

/** The numeric features of a candidate, each in about [0, 1]; the first is the intercept. */
export function vectorOf(c: AdvisorCandidate): number[] {
  const known = c.windows.filter((w) => w.known && w.headroom !== undefined)
  const headroom = known.length ? Math.min(...known.map((w) => w.headroom!)) / 100 : 0
  const used = c.windows.some((w) => w.used !== undefined) ? Math.max(...c.windows.filter((w) => w.used !== undefined).map((w) => w.used!)) / 100 : 1
  const resets = c.windows.filter((w) => w.resetsInMinutes !== undefined && w.seconds)
  const soonest = resets.length ? Math.min(1, Math.min(...resets.map((w) => (w.resetsInMinutes! * 60) / w.seconds!))) : 1
  const rate = (k: number): number => (k + 1) / (c.counts.attempts + 2)
  return [
    1, c.tierRank / 2, c.metered ? 1 : 0, c.free ? 1 : 0, headroom, used, c.windows.some((w) => !w.known) || !c.windows.length ? 1 : 0, soonest,
    c.load && c.load.slots > 0 ? Math.min(1, c.load.running / c.load.slots) : 0,
    rate(c.counts.accepted), rate(c.counts.limited), rate(c.counts.operator), Math.min(1, Math.log1p(c.counts.attempts) / 5),
  ]
}

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))

/** Solve `a x = b` by Gaussian elimination with partial pivoting; `a` is symmetric positive definite here. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    const row = m[col]!
    m[col] = m[pivot]!
    m[pivot] = row
    const p = m[col]![col]!
    if (Math.abs(p) < 1e-12) continue
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / p
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!
    }
  }
  const x = Array.from({ length: n }, () => 0)
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!
    x[r] = Math.abs(m[r]![r]!) < 1e-12 ? 0 : s / m[r]![r]!
  }
  return x
}

/**
 * The weights of an L2-regularized logistic regression (the intercept not penalized), by Newton's
 * method: deterministic, the same examples give the same weights.
 */
export function fitLogistic(x: readonly number[][], y: readonly number[], l2: number, iterations = 25): number[] {
  const d = x[0]?.length ?? 0
  let w = Array.from({ length: d }, () => 0)
  for (let it = 0; it < iterations; it++) {
    const grad = w.map((wj, j) => (j === 0 ? 0 : l2 * wj))
    const hess = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? (i === 0 ? 1e-6 : l2) : 0)))
    for (let n = 0; n < x.length; n++) {
      const xi = x[n]!
      const p = sigmoid(xi.reduce((s, v, j) => s + v * w[j]!, 0))
      const r = p * (1 - p)
      for (let j = 0; j < d; j++) {
        grad[j]! += (p - y[n]!) * xi[j]!
        for (let k = 0; k < d; k++) hess[j]![k]! += r * xi[j]! * xi[k]!
      }
    }
    const step = solve(hess, grad)
    w = w.map((wj, j) => wj - step[j]!)
    if (step.every((s) => Math.abs(s) < 1e-9)) break
  }
  return w
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * The local adapter: one logistic regression per question, fitted on the labelled dispatched
 * attempts `history` gives, in this process. With fewer than `minLabelled`, it answers
 * `insufficient data`. Its model version names the fit (the examples' count and the weights' hash).
 */
export class LocalAdvisor implements Advisor {
  readonly id = 'local-logistic'
  private fitted: { n: number; key: string; weights: Record<Question, number[]>; version: string } | undefined

  constructor(private readonly history: () => Labelled[], private readonly minLabelled: number, private readonly l2: number) {}

  async advise(features: AdvisorFeatures): Promise<Advice> {
    const examples = this.history()
    if (examples.length < this.minLabelled) return { status: 'unavailable', provider: this.id, reason: `insufficient data: ${examples.length} of the ${this.minLabelled} labelled dispatched attempts it needs (dispatch.advisor.minLabelled)` }
    const key = contentId(examples.map((e) => [vectorOf(e.candidate), e.labels]))
    if (this.fitted?.key !== key) {
      const x = examples.map((e) => vectorOf(e.candidate))
      const weights = Object.fromEntries(QUESTIONS.map((q) => [q, fitLogistic(x, examples.map((e) => e.labels[q]), this.l2).map(round)])) as Record<Question, number[]>
      this.fitted = { n: examples.length, key, weights, version: `logistic-l2@1:n${examples.length}:${contentId({ weights, l2: this.l2 }).slice(7, 23)}` }
    }
    const { weights, version } = this.fitted
    const p = (q: Question, v: number[]): number => round(sigmoid(v.reduce((s, x, j) => s + x * weights[q][j]!, 0)))
    return {
      status: 'advice', provider: this.id, modelVersion: version,
      candidates: features.candidates.map((c) => {
        const v = vectorOf(c)
        return { alias: c.alias, accepted: p('accepted', v), limit: p('limit', v), needsOperator: p('needs-operator', v) }
      }),
    }
  }
}

// --- the model adapter: a configured model Worker, with a JSON schema ---

/** The JSON schema the model's answer must follow, given in its prompt. */
export const ANSWER_SCHEMA = {
  type: 'object', required: ['candidates'], additionalProperties: false,
  properties: {
    candidates: {
      type: 'array', maxItems: MAX_ADVISED,
      items: {
        type: 'object', required: ['alias', 'accepted', 'limit', 'needsOperator'], additionalProperties: false,
        properties: {
          alias: { type: 'string', maxLength: 1 },
          accepted: { type: 'number', minimum: 0, maximum: 1, description: 'P(the attempt is accepted on this candidate, without the operator)' },
          limit: { type: 'number', minimum: 0, maximum: 1, description: 'P(a quota window of its account closes while the attempt runs)' },
          needsOperator: { type: 'number', minimum: 0, maximum: 1, description: 'P(the attempt waits on the operator: a review held, a question, a spent budget)' },
        },
      },
    },
  },
} as const

/** The prompt the model adapter sends: the instructions, the schema, and the features; nothing else. */
export function modelPrompt(features: AdvisorFeatures): string {
  return [
    'You estimate, for one dispatch choice of a software work orchestrator, three probabilities for every candidate Worker (by alias).',
    'Answer with one JSON object only, no prose and no code fence, valid against this JSON schema:',
    JSON.stringify(ANSWER_SCHEMA),
    'Answer every alias of the features exactly once. The features (quota windows in percent; counts are this candidate\'s recorded dispatched attempts of this kind):',
    JSON.stringify(features),
  ].join('\n')
}

/** The JSON object in a model's text: the whole text, or its first `{` to its last `}`. */
function jsonIn(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('the answer holds no JSON object')
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

/**
 * The model adapter: one call to the configured model Worker (`model:<id>`) through `ctx.workers`,
 * routed with only that Worker allowed, so routing's checks, the Worker's egress check on the exact
 * prompt (INV-12), its bounds, and its usage record all apply as for any call. Metered: off unless
 * `dispatch.advisor.provider` is `model`.
 */
export class ModelAdvisor implements Advisor {
  readonly id = 'model-worker'

  constructor(private readonly e: Engine, private readonly worker: string, private readonly maxTokens: number) {}

  async advise(features: AdvisorFeatures, signal: AdvisorSignal): Promise<Advice> {
    const workers = this.e.ctx.workers
    const requirement: WorkRequirement = {
      schema: 'work-requirement@1.0', objective: 'Estimate dispatch outcome probabilities from features (PROP-0015 J1, shadow)', capabilities: ['reason'],
      data: { classification: this.e.ctx.egress.defaultClassification, refs: [] }, egressPolicy: 'egress.classification-and-secrets',
      tier: { min: 'economy', source: 'default' }, budget: { maxTokens: this.maxTokens }, acceptance: { contract: 'acceptance.answer', maxEscalations: 0 },
    }
    const prompt = modelPrompt(features)
    if (signal.aborted) throw new Error('the call was stopped before routing')
    const admitted = await workers.route(requirement, { restrict: { workers: [this.worker], reason: 'the dispatch advisor asks only its configured model Worker (dispatch.advisor.model.worker)' }, input: { chars: prompt.length }, producer: 'workflow' })
    const source = workers.source(admitted.source)
    if (!source) {
      admitted.release()
      throw new Error(`source ${admitted.source} of ${this.worker} is not registered`)
    }
    // Stopped while routing (the timeout passed): nothing is started, so no metered call outlives it.
    if (signal.aborted) {
      admitted.release()
      throw new Error('the call was stopped while routing; nothing was started')
    }
    const execution = ((): WorkerExecution => {
      try {
        return source.start({ key: `advisor:${newId('adv')}`, worker: admitted.worker.worker, prompt, requirement, decisions: admitted.decisions })
      } finally {
        admitted.release()
      }
    })()
    const id = execution.id
    // Cancelling is best effort and contained: a cancel that throws or rejects is ignored, so a timeout
    // never becomes an uncaught exception or an unhandled rejection; the answer is already `unavailable`.
    const stop = (): void => {
      try {
        const cancelled = source.cancel?.(id) as unknown
        if (cancelled && typeof (cancelled as PromiseLike<unknown>).then === 'function') {
          Promise.resolve(cancelled as PromiseLike<unknown>).catch(() => undefined)
        }
      } catch {
        // contained: see above
      }
    }
    // Stopped before the listener was added, it is still called (soon after), so the execution is cancelled.
    const removeStop = signal.onAbort(stop)
    try {
      let done = execution
      while (done.status !== 'completed' && done.status !== 'failed' && !signal.aborted) done = await source.wait(id, 250)
      if (signal.aborted) throw new Error('the call was stopped')
      if (done.status === 'failed') return { status: 'unavailable', provider: this.id, reason: `the model call failed: ${done.error?.kind ?? 'unknown'}: ${(done.error?.message ?? '').slice(0, 200)}` }
      const body = this.e.ctx.artifacts.get(done.result!)?.body as { model?: unknown; text?: unknown } | undefined
      if (typeof body?.text !== 'string') return { status: 'unavailable', provider: this.id, reason: 'the model call stored no answer text' }
      const parsed = jsonIn(body.text) as { candidates?: unknown }
      // The model/version that produced the answer, from the Worker result; a Worker alias is not one.
      if (typeof body.model !== 'string' || !body.model.trim()) return { status: 'unavailable', provider: this.id, reason: 'the model call named no model version: an unpinned answer is not recorded as advice' }
      const modelVersion = body.model.slice(0, 64)
      return { status: 'advice', provider: this.id, modelVersion, candidates: parsed.candidates as CandidateAdvice[] }
    } finally {
      removeStop()
    }
  }
}

// --- the shadow call ---

/** What one shadow call came to, for the decision that records it. */
export interface ShadowAdvice {
  advice: Advice
  elapsedMs: number
}

/**
 * Ask `advisor` once, within `timeoutMs`: never throws. Whatever goes wrong (a throw, a timeout, an
 * answer that is not advice on exactly these candidates) comes back as `unavailable`, with why.
 */
export async function adviseInShadow(advisor: Advisor, features: AdvisorFeatures, timeoutMs: number): Promise<ShadowAdvice> {
  const started = Date.now()
  const { signal, stop } = advisorStop()
  const fallback = String(advisor.id || 'advisor').slice(0, 64)
  const failed = (why: string): Advice => ({ status: 'unavailable', provider: fallback, reason: why.slice(0, 300) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Advice>((resolve) => {
    timer = setTimeout(() => {
      // The advisor's listeners run inside stop()'s guard: one that throws is recorded here, never uncaught.
      const failures = stop()
      resolve(failed(`timeout: no answer within ${timeoutMs} ms (dispatch.advisor.timeoutMs)${failures.length ? `; its stop listener failed, ignored: ${failures[0]}` : ''}`))
    }, timeoutMs)
  })
  // A frozen copy: an advisor cannot reach dispatch's own objects.
  const given = deepFreeze(structuredClone(features))
  const asked = Promise.resolve().then(() => advisor.advise(given, signal)).then(
    (advice): Advice => {
      // Validated and rebuilt from its known fields only; anything that throws here is a malformed answer too.
      try {
        const problem = adviceProblem(advice, features)
        return problem ? failed(`malformed answer: ${problem}`) : normalized(advice, fallback)
      } catch (error) {
        return failed(`malformed answer: ${messageOf(error)}`)
      }
    },
    (error: unknown): Advice => failed(`error: ${messageOf(error)}`),
  )
  try {
    const advice = await Promise.race([asked, timeout])
    return { advice, elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** A validated answer rebuilt from its known fields, its provider bounded (64 characters). */
function normalized(advice: Advice, fallback: string): Advice {
  const provider = (advice.provider || fallback).slice(0, 64)
  if (advice.status === 'unavailable') return { status: 'unavailable', provider, ...(advice.modelVersion ? { modelVersion: advice.modelVersion.slice(0, 64) } : {}), reason: advice.reason.slice(0, 300) }
  return {
    status: 'advice', provider, modelVersion: advice.modelVersion,
    candidates: advice.candidates.map((c) => ({ alias: c.alias, accepted: c.accepted, limit: c.limit, needsOperator: c.needsOperator })),
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** The `modelAnswers` of an advice: one yes/no answer per question and candidate. */
export function modelAnswersOf(advice: Extract<Advice, { status: 'advice' }>): Array<{ provider: string; modelVersion: string; questionSetVersion: string; questionId: string; type: 'yes-no'; probability: number }> {
  return advice.candidates.flatMap((c) => ([['accepted', c.accepted], ['limit', c.limit], ['needs-operator', c.needsOperator]] as const).map(([q, probability]) => ({
    provider: advice.provider, modelVersion: advice.modelVersion, questionSetVersion: QUESTION_SET, questionId: `${q}:${c.alias}`, type: 'yes-no' as const, probability,
  })))
}

/** The advice decision's outcome detail, as dispatch records it and the trainer and the report read it back. */
export interface AdviceDetail {
  shadow: true
  status: Advice['status']
  provider: string
  modelVersion?: string
  reason?: string
  elapsedMs: number
  /** Which Worker each alias stands for: kept here, never sent. */
  aliases: Record<string, string>
  chosen: string
  features: AdvisorFeatures
}

// --- outcomes: the labels, and what the local adapter learns from ---

/** The event a dispatched attempt's labels are recorded in, once its run reported its task. */
export const OUTCOME_EVENT = ADVICE_OUTCOME_EVENT
/** The reported statuses an attempt is labelled on; any other (not started, moved on, refused, reconciled) is not an outcome of the choice. */
const LABELLED = new Set(['accepted', 'rejected', 'review', 'blocked'])

/** The `workflow.dispatch.outcome` entry's data. */
export interface OutcomeData {
  askId: string
  taskId: string
  attempt: number
  runId: string
  worker: string
  countsKey: string
  kind?: string
  status: string
  /** The advice decision of the choice, when one was recorded. */
  advice?: ArtifactRef
  /** The chosen Worker's alias in it (always `A`). */
  alias?: string
  labels: Record<Question, 0 | 1>
}

/**
 * The labels of a dispatched run that reported its task, recorded as `workflow.dispatch.outcome`
 * inside the transaction that reports it (so a restart records it once):
 * - `accepted`: the run's own acceptance accepted the result (status `accepted`);
 * - `limit`: a step of the run met a quota limit (it waited for a limit, or failed or retried on `quota_exhausted`);
 * - `needs-operator`: the attempt waits on the operator (a review held for the operator, a blocked task, or a step's questions).
 * Attempts reported otherwise (not started, moved on, refused, reconciled) are not labelled.
 */
export function recordOutcome(e: Engine, run: { run_id: string; task_id: string }, status: string): void {
  if (!LABELLED.has(status)) return
  const row = e.ctx.store.db.prepare('SELECT run_id, task_id, dispatch, question FROM workflow_tasks WHERE run_id = ?').get(run.run_id) as { run_id: string; task_id: string; dispatch: string | null; question: string | null } | undefined
  if (!row?.dispatch) return
  const dispatch = JSON.parse(row.dispatch) as { askId?: string }
  if (!dispatch.askId) return
  const ask = e.ctx.store.db.prepare('SELECT attempt, worker, account, choice FROM workflow_dispatch WHERE ask_id = ?').get(dispatch.askId) as { attempt: number; worker: string; account: string | null; choice: string } | undefined
  if (!ask) return
  const choice = JSON.parse(ask.choice) as { advice?: ArtifactRef; kind?: string }
  const events = (type: string) => e.ctx.eventLog.query({ type, runId: row.run_id, limit: 500 })
  const limited = events('workflow.node.waiting').length > 0
    || [...events('workflow.node.failed'), ...events('workflow.node.retry')].some((x) => x.data?.['kind'] === 'quota_exhausted')
  const data: OutcomeData = {
    askId: dispatch.askId, taskId: row.task_id, attempt: ask.attempt, runId: row.run_id, worker: ask.worker, countsKey: ask.account ?? `worker:${ask.worker}`,
    ...(choice.kind !== undefined ? { kind: choice.kind } : {}), status, ...(choice.advice ? { advice: choice.advice, alias: 'A' } : {}),
    labels: { accepted: status === 'accepted' ? 1 : 0, limit: limited ? 1 : 0, 'needs-operator': status === 'review' || status === 'blocked' || !!row.question ? 1 : 0 },
  }
  e.ctx.eventLog.append({ type: OUTCOME_EVENT, runId: row.run_id, data: data as unknown as Record<string, unknown> })
}

/**
 * The recorded outcomes, read from the event log as they are appended (one pass reads only the new
 * ones): the counts per account (or Worker) and kind that each snapshot carries, and the labelled
 * examples the local adapter fits on, the latest {@link MAX_TRAINING}.
 */
export class OutcomeHistory {
  private afterSeq = 0
  private readonly counts = new Map<string, AdvisorCounts>()
  private readonly examples: Labelled[] = []
  /** Every labelled dispatched attempt read, advised or not: the shadow period's progress (D74). */
  labelled = 0

  constructor(private readonly e: Engine) {}

  /** Read the outcomes appended since the last read (bounded pages, INV-9). */
  refresh(): void {
    for (let pages = 0; pages < 100; pages++) {
      const page = this.e.ctx.eventLog.query({ type: OUTCOME_EVENT, afterSeq: this.afterSeq, limit: 500 })
      for (const entry of page) {
        this.afterSeq = entry.seq
        const data = entry.data as unknown as OutcomeData | undefined
        if (!data?.labels) continue
        this.labelled += 1
        const key = `${data.countsKey}\0${data.kind ?? ''}`
        const c = this.counts.get(key) ?? { attempts: 0, accepted: 0, limited: 0, operator: 0 }
        this.counts.set(key, { attempts: c.attempts + 1, accepted: c.accepted + data.labels.accepted, limited: c.limited + data.labels.limit, operator: c.operator + data.labels['needs-operator'] })
        const detail = data.advice ? (this.e.ctx.artifacts.get(data.advice)?.body as { outcome?: { detail?: AdviceDetail } } | undefined)?.outcome?.detail : undefined
        const candidate = detail?.features?.candidates?.find((x) => x.alias === (data.alias ?? 'A'))
        if (candidate) {
          this.examples.push({ candidate, reservePercent: detail!.features.reservePercent, labels: data.labels })
          if (this.examples.length > MAX_TRAINING) this.examples.splice(0, this.examples.length - MAX_TRAINING)
        }
      }
      if (page.length < 500) return
    }
  }

  countsOf(key: string, kind: string | undefined): AdvisorCounts {
    return { ...(this.counts.get(`${key}\0${kind ?? ''}`) ?? { attempts: 0, accepted: 0, limited: 0, operator: 0 }) }
  }

  training(): Labelled[] {
    this.refresh()
    return [...this.examples]
  }
}
