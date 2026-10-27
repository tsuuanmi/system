/**
 * The evaluation protocol's pure steps (docs/design/evaluations.md#an-evaluation), the same for
 * every provider: the schedule drawn from the seed, the checks of pins, seals, the judge, the
 * collectors, and each trial's route, the budget before a trial, and the arithmetic that feeds the
 * pinned analysis. None of them is a statistic.
 */
import { createHash } from 'node:crypto'
import type { Arm, BudgetLine, Environment, EvidencePartition, Experiment, ObjectiveContract, Unit } from '../experiments/index.ts'
import { environmentHash } from '../experiments/index.ts'
import type { AnalysisInput, ArmValues, Check, Collector, Measurement, Route, Trial, TrialSpec } from './index.ts'

/** The schedule's version: how the order is drawn from the seed. */
export const SCHEDULE_VERSION = '1' as const

/** The evaluation id of an experiment's revision: v1 evaluates each revision once. */
export const evaluationIdOf = (experimentId: string, revision: number): string => `${experimentId}:r${revision}`

/** A stream of numbers in [0, 1) drawn from the seed: the first 48 bits of sha256(version, seed, counter). */
function draws(seed: string): () => number {
  let counter = 0
  return () => createHash('sha256').update(`${SCHEDULE_VERSION}\u0000${seed}\u0000${counter++}`).digest().readUIntBE(0, 6) / 2 ** 48
}

/**
 * Every trial of an experiment, in the order they run (version 1): each case of the partitions used
 * (by partition, then id) at each repetition is one pair; the pairs are shuffled from the seed
 * (Fisher-Yates), and within each pair a draw from the seed puts one arm first, so the arms
 * interleave and neither always runs first. The same cases, repetitions, and seed give the same
 * schedule. A case id named twice is refused.
 */
export function schedule(cases: ReadonlyArray<{ id: string; partition: EvidencePartition }>, repetitions: number, seed: string): TrialSpec[] {
  const ids = cases.map((c) => c.id)
  if (new Set(ids).size !== ids.length) throw new TypeError('schedule: a case is named twice')
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new TypeError('schedule: repetitions must be a positive integer')
  const ordered = [...cases].sort((a, b) => (a.partition !== b.partition ? (a.partition < b.partition ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const pairs: Array<{ case: string; partition: EvidencePartition; repetition: number }> = []
  for (const c of ordered) for (let repetition = 1; repetition <= repetitions; repetition++) pairs.push({ case: c.id, partition: c.partition, repetition })
  const next = draws(seed)
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!]
  }
  const trials: Array<Omit<TrialSpec, 'index'>> = []
  for (const pair of pairs) {
    const first: Arm = next() < 0.5 ? 'baseline' : 'candidate'
    trials.push({ ...pair, arm: first }, { ...pair, arm: first === 'baseline' ? 'candidate' : 'baseline' })
  }
  return trials.map((t, index) => ({ index, ...t }))
}

const keyed = <T>(items: readonly T[], key: (item: T) => string): Map<string, T> => new Map(items.map((i) => [key(i), i]))

/**
 * What differs between the pinned environment and the live one, named; empty when they are the
 * same (their hashes equal). Any difference refuses a start, and, met before a trial, ends the
 * evaluation as an integrity breach.
 */
export function pinProblems(pinned: Environment, live: Omit<Environment, 'hash'>): string[] {
  if (environmentHash(live) === pinned.hash && environmentHash(pinned) === pinned.hash) return []
  const problems: string[] = []
  if (environmentHash(pinned) !== pinned.hash) problems.push('the pinned environment does not match its own hash')
  if (pinned.composition !== live.composition) problems.push('the composition changed')
  const plugins = keyed(live.plugins, (p) => p.name)
  for (const p of pinned.plugins) {
    const now = plugins.get(p.name)
    if (!now) problems.push(`plugin ${p.name} is gone`)
    else if (now.version !== p.version || now.manifestDigest !== p.manifestDigest) problems.push(`plugin ${p.name} is at ${now.version}, not the pinned ${p.version}, or its manifest changed`)
  }
  for (const p of live.plugins.filter((x) => !pinned.plugins.some((y) => y.name === x.name))) problems.push(`plugin ${p.name} was added`)
  const workers = keyed(live.workers, (w) => `${w.arm}\u0000${w.worker}`)
  for (const w of pinned.workers) {
    const now = workers.get(`${w.arm}\u0000${w.worker}`)
    if (!now) problems.push(`Worker ${w.worker} of the ${w.arm} arm is gone`)
    else if (now.family !== w.family || now.descriptor !== w.descriptor || now.observed !== w.observed) problems.push(`Worker ${w.worker} of the ${w.arm} arm changed (its family, descriptor, or the model version it shows)`)
  }
  for (const w of live.workers.filter((x) => !pinned.workers.some((y) => y.arm === x.arm && y.worker === x.worker))) problems.push(`Worker ${w.worker} joined the ${w.arm} arm`)
  const templates = keyed(live.templates, (t) => t.name)
  for (const t of pinned.templates) if (templates.get(t.name)?.specHash !== t.specHash) problems.push(`template ${t.name} changed`)
  const collectors = keyed(live.collectors, (c) => c.id)
  for (const c of pinned.collectors) if (collectors.get(c.id)?.version !== c.version) problems.push(`collector ${c.id} is not at the pinned ${c.version}`)
  if (live.statistics.library !== pinned.statistics.library || live.statistics.version !== pinned.statistics.version) problems.push(`the statistics library is not the pinned ${pinned.statistics.library} ${pinned.statistics.version}`)
  if ((live.workload ?? null) !== (pinned.workload ?? null)) problems.push('the workload changed')
  if ((live.costModel ?? null) !== (pinned.costModel ?? null)) problems.push('the cost model changed')
  if (!problems.length) problems.push('the environment differs from the pinned one')
  return problems
}

/** Each pinned partition whose live hash differs or that is gone: a broken seal. */
export function sealProblems(suite: Experiment['suite'], live: ReadonlyArray<{ name: string; hash: string }>): string[] {
  return suite.partitions.filter((p) => live.find((l) => l.name === p.name)?.hash !== p.hash).map((p) => `the ${p.name} partition of suite ${suite.id} is not sealed at its pinned hash`)
}

/**
 * The changes of a candidate that touch its judge: a change names a judge item (its contract, its
 * suite, a collector, or the `evaluations` provider) when it equals it or lies under it.
 */
export function judgeTouched(changes: readonly string[], judge: readonly string[]): string[] {
  return changes.filter((c) => judge.some((j) => c === j || c.startsWith(`${j}/`)))
}

/** What every trial must be measured for: each collected metric's collector, each cost metric's ledger unit, each ratio's parts, and each hard constraint's validator. */
export interface Requirements {
  collected: Map<string, string>
  ledger: Map<string, Unit>
  ratios: Map<string, { numerator: string; denominator: string }>
  constraints: Map<string, string>
}

export function requirementsOf(contract: ObjectiveContract): Requirements {
  const collected = new Map<string, string>()
  const ledger = new Map<string, Unit>()
  const ratios = new Map<string, { numerator: string; denominator: string }>()
  for (const m of contract.metrics) {
    if (m.source === 'collector') collected.set(m.id, m.collector!)
    else if (m.source === 'ledger') ledger.set(m.id, m.ledgerUnit!)
    else ratios.set(m.id, { numerator: m.numerator!, denominator: m.denominator! })
  }
  return { collected, ledger, ratios, constraints: new Map(contract.hardConstraints.map((c) => [c.id, c.validator])) }
}

/**
 * Why the registered collectors cannot measure an experiment: a collected metric or a hard
 * constraint whose collector is not registered, is not at the pinned version, or does not declare
 * it (`unmeasurable`); and a model-based collector of a family the experiment does not declare as a
 * validator's, or of the maker's, a reviewer's, or an arm's family (`dependent`).
 */
export function collectorProblems(contract: ObjectiveContract, experiment: Pick<Experiment, 'environment' | 'independence'>, collectors: readonly Collector[]): { unmeasurable: string[]; dependent: string[] } {
  const unmeasurable: string[] = []
  const dependent: string[] = []
  const required = requirementsOf(contract)
  const pinned = keyed(experiment.environment.collectors, (c) => c.id)
  const used = new Set<string>()
  const need = (what: string, id: string, name: string, declared: (c: Collector) => boolean): void => {
    const c = collectors.find((x) => x.id === id)
    used.add(id)
    if (!c) unmeasurable.push(`${what} ${name} needs collector ${id}, which is not registered`)
    else if (pinned.get(id)?.version !== c.version) unmeasurable.push(`collector ${id} is at ${c.version}, not the pinned ${pinned.get(id)?.version ?? '(none pinned)'}`)
    else if (!declared(c)) unmeasurable.push(`collector ${id} does not measure ${what} ${name}`)
  }
  for (const [metric, id] of required.collected) need('metric', id, metric, (c) => c.metrics.includes(metric))
  for (const [constraint, id] of required.constraints) need('hard constraint', id, constraint, (c) => (c.constraints ?? []).includes(constraint))
  const arms = new Set(experiment.environment.workers.map((w) => w.family))
  const { maker, reviewers, validators } = experiment.independence
  for (const c of collectors.filter((x) => used.has(x.id) && x.family !== undefined)) {
    const family = c.family!
    if (!validators.includes(family)) dependent.push(`collector ${c.id} is model-based, of a family the experiment does not declare as a validator's`)
    if (family === maker || reviewers.includes(family) || arms.has(family)) dependent.push(`collector ${c.id} is of the maker's, a reviewer's, or an arm's family`)
  }
  return { unmeasurable, dependent }
}

/**
 * Why one trial is invalid, and the integrity check it fails, or undefined: it fell back to one
 * family (`families`); it ran on a Worker or a family outside its arm (`arms`); or a Worker showed
 * another model version than the pinned one, or none where one is pinned (`pins`).
 */
export function trialInvalid(route: Route, arm: Arm, environment: Environment): { check: Check; why: string } | undefined {
  if (route.sameFamily) return { check: 'families', why: 'it fell back to one provider family' }
  const own = environment.workers.filter((w) => w.arm === arm)
  const outside = route.workers.filter((w) => !own.some((o) => o.worker === w))
  if (outside.length || route.workers.length === 0) return { check: 'arms', why: outside.length ? `it ran on ${outside.join(', ')}, outside the ${arm} arm` : 'its run names no Worker' }
  const families = new Set(own.map((o) => o.family))
  const strange = route.families.filter((f) => !families.has(f))
  if (strange.length) return { check: 'arms', why: `it ran on a family outside the ${arm} arm` }
  for (const w of own.filter((o) => o.observed !== undefined && route.workers.includes(o.worker))) {
    const shown = route.observed?.[w.worker]
    if (shown !== w.observed) return { check: 'pins', why: shown === undefined ? `${w.worker} showed no model version; ${w.observed} is pinned` : `${w.worker} showed ${shown}, not the pinned ${w.observed}` }
  }
  return undefined
}

/** Whether the budget still covers one more trial: for each line a trial reserves, what was spent plus the reservation stays within the line. */
export function canAfford(spent: readonly BudgetLine[], perTrial: readonly BudgetLine[], lines: readonly BudgetLine[]): boolean {
  const sum = (items: readonly BudgetLine[], pool: string, unit: Unit): number => items.filter((l) => l.pool === pool && l.unit === unit).reduce((n, l) => n + l.amount, 0)
  return perTrial.every((r) => sum(spent, r.pool, r.unit) + r.amount <= sum(lines, r.pool, r.unit))
}

const valueOf = (trial: Pick<Trial, 'measurements'>, metric: string): number | undefined => trial.measurements.find((m) => m.metric === metric)?.value
const measured = (trials: readonly Trial[]): Trial[] => trials.filter((t) => t.state === 'completed' || t.state === 'failed')

/**
 * One metric's input to its method: per case, each arm's values over its measured repetitions, or a
 * ratio's numerator and denominator values. A case is paired only when both arms measured it.
 */
export function analysisInput(metric: string, contract: ObjectiveContract, experiment: Pick<Experiment, 'protocol' | 'seed'>, trials: readonly Trial[]): AnalysisInput {
  const method = experiment.protocol.methods.find((m) => m.metric === metric)
  if (!method) throw new TypeError(`analysisInput: the protocol has no method for ${metric}`)
  const ratio = requirementsOf(contract).ratios.get(metric)
  const of = (arm: Arm, c: string): ArmValues => {
    const rows = measured(trials).filter((t) => t.case === c && t.arm === arm)
    const values = (name: string): number[] => rows.map((t) => valueOf(t, name)).filter((v): v is number => v !== undefined)
    return ratio ? { numerator: values(ratio.numerator), denominator: values(ratio.denominator) } : { values: values(metric) }
  }
  const size = (v: ArmValues): number => ('values' in v ? v.values.length : Math.min(v.numerator.length, v.denominator.length))
  const cases = [...new Set(trials.map((t) => t.case))].sort()
    .map((c) => ({ case: c, baseline: of('baseline', c), candidate: of('candidate', c) }))
    .filter((c) => size(c.baseline) > 0 && size(c.candidate) > 0)
  return { metric, method, confidence: experiment.protocol.confidence, seed: experiment.seed, ratio: ratio !== undefined, cases }
}

/**
 * The metric vector of one arm: for each metric of the contract, the mean over cases of each
 * case's mean over repetitions, or for a ratio the ratio of its parts' sums over the arm's trials;
 * descriptive only, never the evidence the verdict reads.
 */
export function armVector(arm: Arm, contract: ObjectiveContract, trials: readonly Trial[]): Array<{ metric: string; value: number; cases: number }> {
  const rows = measured(trials).filter((t) => t.arm === arm)
  const required = requirementsOf(contract)
  const out: Array<{ metric: string; value: number; cases: number }> = []
  for (const m of contract.metrics) {
    const ratio = required.ratios.get(m.id)
    if (ratio) {
      const sum = (name: string): number => rows.reduce((n, t) => n + (valueOf(t, name) ?? 0), 0)
      const denominator = sum(ratio.denominator)
      if (denominator !== 0) out.push({ metric: m.id, value: sum(ratio.numerator) / denominator, cases: new Set(rows.map((t) => t.case)).size })
      continue
    }
    const perCase = [...new Set(rows.map((t) => t.case))].map((c) => rows.filter((t) => t.case === c).map((t) => valueOf(t, m.id)).filter((v): v is number => v !== undefined))
      .filter((v) => v.length > 0).map((v) => v.reduce((a, b) => a + b, 0) / v.length)
    if (perCase.length) out.push({ metric: m.id, value: perCase.reduce((a, b) => a + b, 0) / perCase.length, cases: perCase.length })
  }
  return out
}

/** The measurements a trial lacks against the requirements, each with why; empty when it has every one. */
export function missingOf(trial: Pick<Trial, 'index' | 'measurements'>, required: Requirements, constraints: ReadonlyMap<string, boolean>, why: (metric: string) => string): Array<{ trial: number; metric: string; why: string }> {
  const have = new Set(trial.measurements.map((m: Measurement) => m.metric))
  return [
    ...[...required.collected.keys(), ...required.ledger.keys()].filter((m) => !have.has(m)).map((metric) => ({ trial: trial.index, metric, why: why(metric) })),
    ...[...required.constraints.keys()].filter((c) => !constraints.has(c)).map((metric) => ({ trial: trial.index, metric, why: why(metric) })),
  ]
}
