/**
 * The verdict rule (docs/design/evaluations.md#the-verdict-rule), deterministic and pinned by its
 * version: an evaluation classified against the thresholds its contract and experiment declared
 * before the first trial, as `invalid`, `refuted`, `supported`, or `inconclusive`, and the
 * `verdict` decision that records it. Intervals are read only at the horizon: v1 takes no interim
 * look. INCONCLUSIVE is never read as equivalence.
 */
import type { ArtifactRef, Direction, Experiment, ObjectiveContract, Outcome } from '@tsuuanmi/system-experiments-core'
import { OUTCOMES, protocolHash } from '@tsuuanmi/system-experiments-core'
import type { Check, EndReason, Evaluation, Interval } from './index.ts'
import { CHECKS } from './index.ts'

/** The decider of every `verdict` decision. */
export const VERDICT_RULE = { id: 'evaluations.verdict', version: '1' } as const

/** One judged metric: the interval held to its threshold, and what it showed. */
export interface MetricJudgement {
  metric: string
  role: 'primary' | 'guardrail'
  direction: Direction
  /**
   * The interval the threshold reads: the candidate's improvement over the baseline, oriented so
   * that larger is better (a metric that should decrease is negated); for a floor, the candidate's
   * own level as measured.
   */
  estimate: number
  lower: number
  upper: number
  /**
   * `minimum-practical-effect`: superiority clears when the improvement's lower bound is above it,
   * and is excluded when its upper bound is below it; `non-inferiority-margin`: clears when the
   * lower bound is above minus the margin, excluded when the upper bound is below it; `floor`: the
   * level's lower bound at or above it (its upper bound at or below it, for a metric that should
   * decrease), excluded when the whole interval is past it.
   */
  threshold: { kind: 'minimum-practical-effect' | 'non-inferiority-margin' | 'floor'; value: number }
  result: 'clears' | 'excluded' | 'undecided'
}

export interface Verdict {
  outcome: Outcome
  /** Why each outcome was or was not chosen: every candidate of the decision says why. */
  reasons: Record<Outcome, string[]>
  metrics: MetricJudgement[]
  failedChecks: Check[]
  brokenConstraints: string[]
}

/** Negation that never writes -0, which a record's canonical JSON would not keep. */
const neg = (x: number): number => (x === 0 ? 0 : -x)
const orient = (i: Interval, direction: Direction): Interval => (direction === 'increase' ? i : { estimate: neg(i.estimate), lower: neg(i.upper), upper: neg(i.lower) })

function margin(metric: string, role: MetricJudgement['role'], direction: Direction, difference: Interval, kind: 'minimum-practical-effect' | 'non-inferiority-margin', value: number): MetricJudgement {
  const d = orient(difference, direction)
  const bound = kind === 'minimum-practical-effect' ? value : neg(value)
  const result = d.lower > bound ? 'clears' : d.upper < bound ? 'excluded' : 'undecided'
  return { metric, role, direction, estimate: d.estimate, lower: d.lower, upper: d.upper, threshold: { kind, value }, result }
}

function floor(metric: string, direction: Direction, level: Interval, value: number): MetricJudgement {
  const result = direction === 'increase'
    ? (level.lower >= value ? 'clears' : level.upper < value ? 'excluded' : 'undecided')
    : (level.upper <= value ? 'clears' : level.lower > value ? 'excluded' : 'undecided')
  return { metric, role: 'guardrail', direction, estimate: level.estimate, lower: level.lower, upper: level.upper, threshold: { kind: 'floor', value }, result }
}

const words = (j: MetricJudgement): string => `${j.metric} [${j.lower}, ${j.upper}] against its ${j.threshold.kind} ${j.threshold.value}`

/**
 * The verdict of an evaluation (rule version 1):
 * - `invalid`: an integrity check failed or is not recorded (a pin, a seal, an arm, a family, a
 *   missing metric, a candidate that touched its judge, a lost trial), or a judged metric or a
 *   hard constraint of the contract has no result;
 * - `refuted`: a hard constraint broke; or, at the horizon, a guardrail is inferior beyond its
 *   margin or past its floor (its whole interval), or the primary's interval excludes the declared
 *   comparison;
 * - `supported`: at the horizon, every hard constraint held, every guardrail cleared, and the
 *   primary's interval clears the declared comparison;
 * - `inconclusive`: anything else, a horizon not reached (a spent budget) included.
 */
export function verdictOf(contract: ObjectiveContract, experiment: Pick<Experiment, 'comparison'>, evaluation: Pick<Evaluation, 'integrity' | 'hardConstraints' | 'horizonReached' | 'analysis' | 'ended'>): Verdict {
  const reasons: Record<Outcome, string[]> = { supported: [], refuted: [], inconclusive: [], invalid: [] }
  const recorded = new Map(evaluation.integrity.checks.map((c) => [c.check, c]))
  const failures = CHECKS.flatMap((check) => {
    const c = recorded.get(check)
    if (!c) return [{ check, why: `the ${check} check is not recorded` }]
    return c.passed ? [] : [{ check, why: `the ${check} check failed${c.detail ? `: ${c.detail}` : ''}` }]
  })
  const held = new Map(evaluation.hardConstraints.map((h) => [h.id, h.held]))
  for (const c of contract.hardConstraints.filter((x) => !held.has(x.id))) failures.push({ check: 'metrics', why: `the hard constraint ${c.id} has no result` })
  const broken = contract.hardConstraints.filter((c) => held.get(c.id) === false).map((c) => c.id)
  const metrics: MetricJudgement[] = []
  const analysed = new Map(evaluation.analysis.map((a) => [a.metric, a]))
  const reading = failures.length === 0 && broken.length === 0 && evaluation.horizonReached
  if (reading) {
    const { primary } = contract
    const p = analysed.get(primary.metric)
    if (!p) failures.push({ check: 'metrics', why: `the primary metric ${primary.metric} has no analysis` })
    else if (experiment.comparison.type === 'superiority') metrics.push(margin(primary.metric, 'primary', primary.direction, p.difference, 'minimum-practical-effect', primary.minimumPracticalEffect))
    else metrics.push(margin(primary.metric, 'primary', primary.direction, p.difference, 'non-inferiority-margin', experiment.comparison.margin))
    for (const g of contract.guardrails) {
      const a = analysed.get(g.metric)
      if (!a || (g.floor !== undefined && !a.candidate)) failures.push({ check: 'metrics', why: `the guardrail ${g.metric} has no analysis${a ? ' of the candidate\'s level' : ''}` })
      else if (g.floor !== undefined) metrics.push(floor(g.metric, g.direction, a.candidate!, g.floor))
      else metrics.push(margin(g.metric, 'guardrail', g.direction, a.difference, 'non-inferiority-margin', g.nonInferiorityMargin!))
    }
  }
  const excluded = metrics.filter((m) => m.result === 'excluded')
  const short = metrics.filter((m) => m.result !== 'clears')
  const ended = (reason: EndReason): string => ({ horizon: 'its horizon', budget: 'its budget spent', integrity: 'an integrity breach', 'hard-constraint': 'a broken hard constraint' })[reason]
  let outcome: Outcome
  if (failures.length) {
    outcome = 'invalid'
    reasons.invalid.push(...failures.map((f) => f.why))
  } else if (broken.length) {
    outcome = 'refuted'
    reasons.refuted.push(...broken.map((id) => `the hard constraint ${id} broke`))
  } else if (!evaluation.horizonReached) {
    outcome = 'inconclusive'
    reasons.inconclusive.push(`its horizon was not reached (it ended on ${ended(evaluation.ended.reason)}): v1 reads no interval before the horizon`)
  } else if (excluded.length) {
    outcome = 'refuted'
    reasons.refuted.push(...excluded.map((m) => `${m.role === 'primary' ? 'the primary' : 'the guardrail'} ${words(m)} is wholly past it`))
  } else if (!short.length) {
    outcome = 'supported'
    reasons.supported.push(`at the horizon every hard constraint held and every interval clears its threshold: ${metrics.map(words).join('; ')}`)
  } else {
    outcome = 'inconclusive'
    reasons.inconclusive.push(...short.map((m) => `${words(m)} neither clears nor excludes it`))
  }
  const decided = `it is ${outcome}: ${reasons[outcome][0]}`
  for (const o of OUTCOMES.filter((x) => x !== outcome)) {
    if (o === 'invalid') reasons.invalid.push(`every integrity check passed (${CHECKS.join(', ')}) and every needed result is recorded`)
    else if (outcome === 'invalid') reasons[o].push(`not read: ${decided}`)
    else if (o === 'refuted') reasons.refuted.push(evaluation.horizonReached ? 'no hard constraint broke, and no interval is wholly past its threshold' : 'no hard constraint broke, and before the horizon no interval is read')
    else if (o === 'supported') reasons.supported.push(outcome === 'refuted' ? decided : evaluation.horizonReached ? `not every interval clears its threshold: ${short.map(words).join('; ')}` : 'its horizon was not reached')
    else reasons.inconclusive.push(decided)
  }
  return { outcome, reasons, metrics, failedChecks: [...new Set(failures.map((f) => f.check))], brokenConstraints: broken }
}

/** Net benefit over a stated horizon (N·s − C), with conservative bounds: never part of the verdict, shown with a promotion request. */
export interface NetBenefit {
  /** s: the saving per eligible task, at the lower bound of its interval. */
  saving: number
  /** N: the eligible volume over the horizon, projected low from the ledger's history. */
  volume: number
  horizon: string
  /** The experiment's cost (sunk) and the deployment's (at its upper bound). */
  experimentCost: number
  deploymentCost: number
  /** N·s less the deployment cost: whether operating the change pays for itself from now on. */
  forward: number
  /** N·s less the experiment's and the deployment's cost: whether the whole loop paid for itself. */
  full: number
}

export function netBenefit(input: Omit<NetBenefit, 'forward' | 'full'>): NetBenefit {
  const gain = input.volume * input.saving
  return { ...input, forward: gain - input.deploymentCost, full: gain - input.experimentCost - input.deploymentCost }
}

/** The body of a `verdict` decision (`decision@1.7`), as a provider records it through `ctx.artifacts.recordDecision`. */
export interface VerdictDecision {
  schema: 'decision@1.7'
  decisionType: 'verdict'
  question: string
  inputs: ArtifactRef[]
  candidates: Array<{ option: Outcome; selected: boolean; reasons: string[] }>
  decider: { type: 'rule'; id: typeof VERDICT_RULE.id; version: typeof VERDICT_RULE.version; hash: ArtifactRef }
  outcome: {
    option: Outcome
    detail: {
      experimentId: string
      revision: number
      evaluationId: string
      identity: ArtifactRef
      comparison: Experiment['comparison']
      horizonReached: boolean
      ended: EndReason
      metrics: MetricJudgement[]
      hardConstraints: Array<{ id: string; held: boolean }>
      failedChecks: Check[]
      netBenefit?: NetBenefit
    }
  }
  deterministic: true
  rationale: string
}

/**
 * The `verdict` decision of an evaluation: its inputs the evaluation, the experiment, and the
 * contract; its decider the rule, hashed with the experiment's protocol.
 */
export function verdictDecision(contract: ObjectiveContract, experiment: Pick<Experiment, 'experimentId' | 'revision' | 'comparison' | 'protocol' | 'identity'>, evaluation: Evaluation, refs: { evaluation: ArtifactRef; experiment: ArtifactRef; contract: ArtifactRef }, benefit?: NetBenefit): VerdictDecision {
  const verdict = verdictOf(contract, experiment, evaluation)
  return {
    schema: 'decision@1.7',
    decisionType: 'verdict',
    question: `What is the verdict of evaluation ${evaluation.evaluationId} of experiment ${experiment.experimentId} revision ${experiment.revision}?`,
    inputs: [...new Set([refs.evaluation, refs.experiment, refs.contract])],
    candidates: OUTCOMES.map((o) => ({ option: o, selected: o === verdict.outcome, reasons: verdict.reasons[o] })),
    decider: { type: 'rule', id: VERDICT_RULE.id, version: VERDICT_RULE.version, hash: protocolHash(experiment.protocol) },
    outcome: {
      option: verdict.outcome,
      detail: {
        experimentId: experiment.experimentId, revision: experiment.revision, evaluationId: evaluation.evaluationId, identity: experiment.identity.hash,
        comparison: experiment.comparison, horizonReached: evaluation.horizonReached, ended: evaluation.ended.reason, metrics: verdict.metrics,
        hardConstraints: evaluation.hardConstraints.map((h) => ({ id: h.id, held: h.held })), failedChecks: verdict.failedChecks,
        ...(benefit ? { netBenefit: benefit } : {}),
      },
    },
    deterministic: true,
    rationale: 'The verdict follows from the thresholds pre-registered in the contract and the experiment, read once at the horizon; INCONCLUSIVE is never equivalence (PROP-0011).',
  }
}
