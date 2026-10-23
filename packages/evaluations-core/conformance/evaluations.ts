/**
 * Conformance suite for `ctx.evaluations` (ADR-0037; docs/design/evaluations.md), and a fake engine
 * that passes it. `boot(world)` gives an engine over one durable state, beside a `ctx.experiments`
 * configured with the experiments suite's `VOCABULARY` and `ctx.artifacts`; `start()` (re)starts
 * the engine over that state. The `World` stands for what the engine reads and drives outside
 * itself: the live environment, the suite's partitions, what the candidate changes, and each
 * trial's run (in a store-backed engine, a board task served by a workflow run). The suite
 * registers its own collectors, and analyses with `SPAN`, a stand-in for the pinned statistics
 * library that is never shipped.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import {
  type ArtifactRef, type BudgetLine, type Environment, type ExactSubject, type Experiment, type ExperimentDraft, type HypothesisDraft, independenceProblems,
  type ObjectiveContract, type Partition, protocolHash,
} from '@tsuuanmi/system-experiments-core'
import { expect } from 'vitest'
import { operatorRecords, registrationOf } from '../../experiments-core/conformance/experiments.ts'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type AnalysisMethod, analysisInput, armVector, type ArmValues, canAfford, type Check, CHECKS, type Collection, type Collector, collectorProblems, evaluationIdOf,
  type Evaluation, type EvaluationEntry, Evaluations, EvaluationsError, type EvaluationsFailure, type Interval, judgeTouched, missingOf, pinProblems, requirementsOf,
  type Route, schedule, sealProblems, type Trial, trialInvalid, type TrialSpec, verdictDecision,
} from '../src/index.ts'

/** How a trial's run ended, as the world reports it: `pending` while it runs, `unknown` when nothing says (a run lost in a crash). */
export type RunEnd = { state: 'completed' | 'failed'; results: ArtifactRef[]; route: Route; usage: BudgetLine[] } | 'pending' | 'unknown'

/** Everything outside the engine that it reads or drives. */
export interface World {
  environment(): Omit<Environment, 'hash'>
  partitions(): Array<{ name: Partition; hash: ArtifactRef; cases: string[] }>
  /** What the candidate changes, by name (in a store-backed engine, from the candidate's diff against the baseline). */
  changes(candidate: ExactSubject): string[]
  /** Start a trial's run. */
  start(trial: TrialSpec & { evaluationId: string }): void
  /** How a started trial's run ended. */
  end(trial: TrialSpec & { evaluationId: string }): RunEnd
  /** The usage the ledger attributes to a run that produced the candidate. */
  provenance(runId: string): BudgetLine[]
  /** The pinned statistics library's methods, as the engine finds them. */
  readonly methods: AnalysisMethod[]
}
export type Boot = (world: World) => Promise<{ start: () => Promise<Context>; dispose: () => Promise<void> }>

/** The stand-in statistics library the suite's experiments pin: never shipped. */
export const CONFORMANCE_STATISTICS = { library: 'conformance.span', version: '1' } as const
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
const level = (v: ArmValues): number => ('values' in v ? mean(v.values) : v.numerator.reduce((a, b) => a + b, 0) / v.denominator.reduce((a, b) => a + b, 0))
const span = (xs: readonly number[]): Interval => ({ estimate: mean(xs), lower: Math.min(...xs), upper: Math.max(...xs) })
/** The span of the per-case values: deterministic, and enough to drive every branch of the verdict rule. Not a statistic. */
export const SPAN: AnalysisMethod[] = (['sign-flip', 'bootstrap', 'bayesian'] as const).map((kind) => ({
  kind, ...CONFORMANCE_STATISTICS,
  analyse: (input) => ({ difference: span(input.cases.map((c) => level(c.candidate) - level(c.baseline))), candidate: span(input.cases.map((c) => level(c.candidate))) }),
}))

const schemas = new SchemaRegistry()
const T0 = new Date('2026-11-02T09:00:00Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
type Values = { metrics: Record<string, number>; constraints: Record<string, boolean>; contaminated?: string }

/** A trial that does well on both arms: the candidate's defects per cost above the baseline's, every guardrail clear, every constraint held. */
const good = (t: TrialSpec): Values => ({
  metrics: { 'defects-found': t.arm === 'candidate' ? 6 : 4, 'blocking-recall': 1, 'false-positives': 1, 'quote-validity': 1, latency: 10, stalls: 0 },
  constraints: { invariants: true, egress: true, 'autonomy-policy': true },
})

/** What a scenario changes of the world's behaviour. */
interface Knobs {
  values?: (t: TrialSpec) => Values
  usage?: (t: TrialSpec) => BudgetLine[]
  route?: (t: TrialSpec, route: Route) => Route
  end?: (t: TrialSpec) => 'completed' | 'failed' | 'pending' | 'unknown'
  /** A collector that throws on a trial. */
  throws?: (t: TrialSpec, collector: string) => boolean
  changes?: string[]
}

/** A scenario's world over one experiment's draft: its pinned environment live, its partitions sealed, its trials scripted by the knobs. */
class ScriptedWorld implements World {
  started: Array<TrialSpec & { evaluationId: string }> = []
  env: Omit<Environment, 'hash'>
  seals: Array<{ name: Partition; hash: ArtifactRef; cases: string[] }>
  methods = SPAN
  /** Called when a trial's run ends, before the engine reads it: a scenario changes the world there. */
  onEnd: (t: TrialSpec) => void = () => {}

  constructor(draft: ExperimentDraft, readonly knobs: Knobs = {}) {
    this.env = structuredClone(draft.environment)
    this.seals = draft.suite.partitions.map((p) => ({ name: p.name, hash: p.hash, cases: Array.from({ length: p.cases }, (_, i) => `${p.name}-case-${i + 1}`) }))
  }

  environment(): Omit<Environment, 'hash'> {
    return structuredClone(this.env)
  }

  partitions(): Array<{ name: Partition; hash: ArtifactRef; cases: string[] }> {
    return structuredClone(this.seals)
  }

  changes(): string[] {
    return this.knobs.changes ?? ['packages/plugins/profile-software-development/src/review.ts']
  }

  start(trial: TrialSpec & { evaluationId: string }): void {
    this.started.push(trial)
  }

  end(trial: TrialSpec & { evaluationId: string }): RunEnd {
    const how = this.knobs.end?.(trial) ?? 'completed'
    if (how === 'pending' || how === 'unknown') return how
    this.onEnd(trial)
    const own = this.env.workers.filter((w) => w.arm === trial.arm)
    const route: Route = { workers: own.map((w) => w.worker), families: own.map((w) => w.family), sameFamily: false, observed: Object.fromEntries(own.filter((w) => w.observed).map((w) => [w.worker, w.observed!])) }
    const usage = this.knobs.usage?.(trial) ?? [{ pool: trial.arm === 'candidate' ? 'agents.codex' : 'web.chatgpt', unit: 'usd', amount: 2 }]
    return { state: how, results: [], route: this.knobs.route?.(trial, route) ?? route, usage }
  }

  provenance(): BudgetLine[] {
    return []
  }

  /** The collectors the contract needs, reading this world's script. */
  collectors(contract: ObjectiveContract): Collector[] {
    const required = requirementsOf(contract)
    const ids = new Set([...required.collected.values(), ...required.constraints.values()])
    return [...ids].map((id): Collector => ({
      id, version: '1.0.0',
      metrics: [...required.collected].filter(([, c]) => c === id).map(([m]) => m),
      constraints: [...required.constraints].filter(([, c]) => c === id).map(([k]) => k),
      measure: (trial): Collection => {
        if (this.knobs.throws?.(trial.trial, id)) throw new Error(`collector ${id} failed on trial ${trial.trial.index}`)
        const v = (this.knobs.values ?? good)(trial.trial)
        return {
          metrics: Object.fromEntries([...required.collected].filter(([m, c]) => c === id && m in v.metrics).map(([m]) => [m, v.metrics[m]!])),
          constraints: Object.fromEntries([...required.constraints].filter(([k, c]) => c === id && k in v.constraints).map(([k]) => [k, v.constraints[k]!])),
          ...(v.contaminated && id === 'review.defect-match' ? { contaminated: v.contaminated } : {}),
        }
      },
    }))
  }
}

/**
 * Boot an engine over a world of the suite's experiment (`exp-a`, pre-registered and pinned to the
 * stand-in statistics), with the world's collectors registered; `knobs` script the trials and
 * `change` the registration.
 */
async function evaluate(boot: Boot, knobs: Knobs = {}, change: (h: HypothesisDraft, e: ExperimentDraft) => void = () => {}) {
  let world: ScriptedWorld | undefined
  const proxy: World = {
    environment: () => world!.environment(), partitions: () => world!.partitions(), changes: () => world!.changes(), start: (t) => world!.start(t),
    end: (t) => world!.end(t), provenance: () => world!.provenance(), get methods() { return world!.methods },
  }
  const { start, dispose } = await boot(proxy)
  const ctx = await start()
  const records = operatorRecords(ctx)
  const registration = registrationOf(records, 'exp-a', (h, e) => {
    e.environment.statistics = { ...CONFORMANCE_STATISTICS }
    change(h, e)
  })
  const entry = await ctx.experiments.register(registration, at(0))
  expect(entry.state, 'the suite\'s experiment is pre-registered').toBe('preregistered')
  world = new ScriptedWorld(registration.experiment, knobs)
  const register = (c: Context): Map<string, () => void> => new Map(world!.collectors(records.contract).map((x) => [x.id, c.evaluations.collector(x)]))
  const run = {
    ctx, world, dispose, records, entry, experiment: ctx.artifacts.get(entry.experiment)!.body as Experiment, disposers: register(ctx),
    restart: async (): Promise<Context> => {
      const c = await start()
      run.disposers = register(c)
      return c
    },
  }
  return run
}

const failureOf = async (call: Promise<unknown>): Promise<EvaluationsFailure> => {
  try {
    await call
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluationsError)
    return (error as EvaluationsError).failure
  }
  throw new Error('expected the call to be refused')
}

/** Run an evaluation to its end, sweeping until it closes (bounded). */
async function runToEnd(ctx: Context, experimentId = 'exp-a'): Promise<EvaluationEntry> {
  const started = await ctx.evaluations.start(experimentId, at(1))
  for (let minute = 2; minute < 200; minute++) {
    await ctx.evaluations.sweep(at(minute))
    const now = await ctx.evaluations.get(started.evaluationId)
    if (now?.state === 'closed') return now
  }
  throw new Error('the evaluation did not close')
}

/** The evaluation's record and verdict, checked as every provider must write them. */
function recordsOf(ctx: Context, entry: EvaluationEntry, experiment: Experiment): { evaluation: Evaluation; verdict: Record<string, any> } {
  const envelope = ctx.artifacts.get(entry.evaluation!)!
  expect(envelope).toMatchObject({ kind: 'evidence', bodySchema: 'evaluation@1.0' })
  const evaluation = envelope.body as Evaluation
  schemas.assertRecord(evaluation)
  expect(envelope.inputs).toContain(evaluation.experiment.ref)
  expect(evaluation.experiment).toEqual({ id: experiment.experimentId, revision: experiment.revision, ref: evaluation.experiment.ref, identity: experiment.identity.hash })
  expect(evaluation.integrity.checks.map((c) => c.check)).toEqual([...CHECKS])
  const verdict = ctx.artifacts.get(entry.verdict!)!.body as Record<string, any>
  schemas.assertRecord(verdict as { schema: string })
  expect(verdict).toMatchObject({ schema: 'decision@1.7', decisionType: 'verdict', decider: { type: 'rule', id: 'evaluations.verdict', version: '1', hash: protocolHash(experiment.protocol) }, outcome: { option: entry.outcome }, deterministic: true })
  expect(verdict.inputs).toEqual(expect.arrayContaining([entry.evaluation, evaluation.experiment.ref, experiment.objectiveContract.ref]))
  expect(verdict.candidates.every((c: { reasons: string[] }) => c.reasons.some((r) => r.trim() !== '')), 'every candidate says why').toBe(true)
  return { evaluation, verdict }
}

const scenario = (id: string, title: string, run: (boot: Boot) => Promise<void>): Scenario<Boot> => ({ id: `evaluations.${id}`, since: '1.0', title, run })

/** One integrity case: the knobs (or a change of the world mid-run) that break it, and the check it fails. */
async function integrity(boot: Boot, check: Check, knobs: Knobs, during: (world: ScriptedWorld) => void = () => {}): Promise<void> {
  const run = await evaluate(boot, knobs)
  try {
    during(run.world)
    const entry = await runToEnd(run.ctx)
    expect(entry, check).toMatchObject({ state: 'closed', outcome: 'invalid', ended: { reason: 'integrity' } })
    const { evaluation, verdict } = recordsOf(run.ctx, entry, run.experiment)
    expect(evaluation.integrity.checks.find((c) => c.check === check), check).toMatchObject({ passed: false })
    expect(evaluation.analysis, check).toEqual([])
    expect(verdict.outcome.detail.failedChecks, check).toContain(check)
    expect(evaluation.trials.some((t) => t.state === 'skipped'), `${check}: an integrity breach ends it at once`).toBe(true)
    expect((await run.ctx.experiments.get('exp-a'))!.outcome, check).toBe('invalid')
  } finally {
    await run.dispose()
  }
}

export const evaluationsSuite = defineSuite<Boot>({
  seam: 'evaluations',
  contract: '1.0',
  scenarios: [
    scenario('supported', 'runs a pre-registered experiment as paired trials in the order its seed draws, each started once, measured by the registered collectors and the ledger, analysed once at the horizon, and closed with a supported verdict decision@1.7 citing its evaluation, experiment, and contract (INV-4, INV-13)', async (boot) => {
      const run = await evaluate(boot)
      try {
        const started = await run.ctx.evaluations.start('exp-a', at(1))
        const cases = run.world.seals.flatMap((p) => p.cases.map((id) => ({ id, partition: p.name as 'regression' })))
        expect(started).toMatchObject({ evaluationId: evaluationIdOf('exp-a', 1), experimentId: 'exp-a', revision: 1, state: 'running' })
        expect(started.trials.map((t) => ({ index: t.index, case: t.case, partition: t.partition, arm: t.arm, repetition: t.repetition }))).toEqual(schedule(cases, run.experiment.protocol.repetitions, run.experiment.seed))
        expect(await run.ctx.evaluations.start('exp-a', at(2))).toEqual(started)
        expect(await run.ctx.experiments.get('exp-a')).toMatchObject({ state: 'running', evaluationId: started.evaluationId })
        const entry = await runToEnd(run.ctx)
        expect(entry).toMatchObject({ state: 'closed', outcome: 'supported', ended: { reason: 'horizon' } })
        expect(run.world.started.map((t) => t.index)).toEqual(started.trials.map((t) => t.index))
        const { evaluation, verdict } = recordsOf(run.ctx, entry, run.experiment)
        expect(evaluation).toMatchObject({ horizonReached: true, ended: { reason: 'horizon' } })
        expect(evaluation.trials.every((t) => t.state === 'completed' && t.measurements.length === 7)).toBe(true)
        expect(evaluation.trials[0]!.measurements.find((m) => m.metric === 'usage')).toEqual({ metric: 'usage', value: 2, source: 'ledger' })
        expect(evaluation.trials[0]!.measurements.find((m) => m.metric === 'latency')).toEqual({ metric: 'latency', value: 10, source: 'trial.latency@1.0.0' })
        expect(evaluation.analysis.map((a) => a.metric).sort()).toEqual(run.experiment.protocol.methods.map((m) => m.metric).sort())
        expect(evaluation.analysis.find((a) => a.metric === 'defects-per-cost')).toMatchObject({ method: { library: CONFORMANCE_STATISTICS.library }, difference: { lower: 1, upper: 1 } })
        expect(evaluation.cost.lines).toEqual(expect.arrayContaining([{ pool: 'agents.codex', unit: 'usd', amount: 8, phase: 'evaluation', kind: 'sunk' }]))
        expect(verdict.outcome.detail).toMatchObject({ experimentId: 'exp-a', revision: 1, evaluationId: started.evaluationId, horizonReached: true, failedChecks: [] })
        expect(await run.ctx.experiments.get('exp-a')).toMatchObject({ state: 'closed', outcome: 'supported', verdict: entry.verdict, evaluation: entry.evaluation })
        expect((await run.ctx.evaluations.list({ experimentId: 'exp-a' })).map((e) => e.evaluationId)).toEqual([started.evaluationId])
        expect(await run.ctx.evaluations.sweep(at(300))).toEqual([])
        expect(await failureOf(run.ctx.evaluations.start('exp-a', at(301)))).toBe('not-preregistered')
      } finally {
        await run.dispose()
      }
    }),

    scenario('refuted-and-inconclusive', 'classifies by the pre-registered thresholds only: a guardrail wholly past its floor is refuted, and an interval that neither clears nor excludes its threshold is inconclusive, never equivalence (PROP-0011 verdict rule)', async (boot) => {
      const cases: Array<[Knobs['values'], 'refuted' | 'inconclusive']> = [
        [(t) => ({ ...good(t), metrics: { ...good(t).metrics, 'blocking-recall': t.arm === 'candidate' ? 0.5 : 1 } }), 'refuted'],
        [(t) => ({ ...good(t), metrics: { ...good(t).metrics, 'defects-found': t.arm === 'baseline' ? 4 : t.case.endsWith('-1') ? 6 : 2 } }), 'inconclusive'],
      ]
      for (const [values, outcome] of cases) {
        const run = await evaluate(boot, values ? { values } : {})
        try {
          const entry = await runToEnd(run.ctx)
          expect(entry, outcome).toMatchObject({ outcome, ended: { reason: 'horizon' } })
          expect(recordsOf(run.ctx, entry, run.experiment).verdict.outcome.detail.horizonReached).toBe(true)
        } finally {
          await run.dispose()
        }
      }
    }),

    scenario('budget-ends', 'starts no trial its funded budget cannot cover: the evaluation ends on its budget with the rest skipped, and is at most inconclusive, its intervals unread before the horizon (INV-9)', async (boot) => {
      const run = await evaluate(boot, { usage: () => [{ pool: 'agents.codex', unit: 'usd', amount: 10 }] })
      try {
        const entry = await runToEnd(run.ctx)
        expect(entry).toMatchObject({ outcome: 'inconclusive', ended: { reason: 'budget' } })
        const { evaluation } = recordsOf(run.ctx, entry, run.experiment)
        expect(evaluation.trials.filter((t) => t.state === 'completed')).toHaveLength(4)
        expect(evaluation.trials.filter((t) => t.state === 'skipped')).toHaveLength(4)
        expect(run.world.started).toHaveLength(4)
        expect(evaluation).toMatchObject({ horizonReached: false, analysis: [] })
      } finally {
        await run.dispose()
      }
    }),

    scenario('hard-constraint', 'ends an evaluation at the first broken hard constraint, refuted, naming the trial it broke in (PROP-0011)', async (boot) => {
      const run = await evaluate(boot, { values: (t) => ({ ...good(t), constraints: { ...good(t).constraints, egress: t.index !== 2 } }) })
      try {
        const entry = await runToEnd(run.ctx)
        expect(entry).toMatchObject({ outcome: 'refuted', ended: { reason: 'hard-constraint' } })
        const { evaluation, verdict } = recordsOf(run.ctx, entry, run.experiment)
        expect(evaluation.hardConstraints.find((h) => h.id === 'egress')).toEqual({ id: 'egress', held: false, broken: [2] })
        expect(run.world.started).toHaveLength(3)
        expect(verdict.outcome.detail.hardConstraints).toEqual(expect.arrayContaining([{ id: 'egress', held: false }]))
      } finally {
        await run.dispose()
      }
    }),

    scenario('integrity-invalid', 'makes the evaluation invalid, ended at once, for a trial that fell back to one family, ran outside its arm, showed another model version, lacks a metric, or was contaminated, and for a pin or a seal that changed mid-run (INV-2, INV-5, ADR-0029)', async (boot) => {
      await integrity(boot, 'families', { route: (t, r) => (t.index === 1 ? { ...r, sameFamily: true } : r) })
      await integrity(boot, 'arms', { route: (t, r) => (t.index === 1 ? { ...r, workers: [...r.workers, 'website:somewhere-else'] } : r) })
      await integrity(boot, 'pins', { route: (t, r) => (t.index === 1 ? { ...r, observed: Object.fromEntries(Object.keys(r.observed ?? {}).map((w) => [w, 'another'])) } : r) })
      await integrity(boot, 'metrics', { throws: (t, c) => t.index === 1 && c === 'trial.latency' })
      await integrity(boot, 'judge', { values: (t) => ({ ...good(t), ...(t.index === 1 ? { contaminated: 'its answer cites the fix' } : {}) }) })
      await integrity(boot, 'pins', {}, (world) => {
        world.onEnd = (t) => {
          if (t.index === 1) world.env = { ...world.env, composition: `sha256:${'f'.repeat(64)}` }
        }
      })
      await integrity(boot, 'seal', {}, (world) => {
        world.onEnd = (t) => {
          if (t.index === 1) world.seals = world.seals.map((p) => ({ ...p, hash: `sha256:${'a'.repeat(64)}` }))
        }
      })
    }),

    scenario('restart-reconciles', 'reconciles after a restart: a trial that started and whose run ended is measured once, and one whose outcome is unknown is lost, never started again, which makes the evaluation invalid (INV-4)', async (boot) => {
      let ended = false
      const run = await evaluate(boot, { end: (t) => (t.index === 0 && !ended ? 'pending' : 'completed') })
      try {
        await run.ctx.evaluations.start('exp-a', at(1))
        await run.ctx.evaluations.sweep(at(2))
        expect(run.world.started.map((t) => t.index)).toEqual([0])
        ended = true
        const entry = await runToEnd(await run.restart())
        expect(entry.outcome).toBe('supported')
        expect(run.world.started.map((t) => t.index)).toEqual(entry.trials.map((t) => t.index))
      } finally {
        await run.dispose()
      }
      let lost = false
      const again = await evaluate(boot, { end: (t) => (t.index !== 0 ? 'completed' : lost ? 'unknown' : 'pending') })
      try {
        await again.ctx.evaluations.start('exp-a', at(1))
        await again.ctx.evaluations.sweep(at(2))
        lost = true
        const ctx = await again.restart()
        const entry = await runToEnd(ctx)
        expect(entry).toMatchObject({ outcome: 'invalid', ended: { reason: 'integrity' } })
        expect(again.world.started.map((t) => t.index)).toEqual([0])
        const { evaluation } = recordsOf(ctx, entry, again.experiment)
        expect(evaluation.trials[0]).toMatchObject({ index: 0, state: 'lost' })
        expect(evaluation.integrity.checks.find((c) => c.check === 'trials')).toMatchObject({ passed: false })
      } finally {
        await again.dispose()
      }
    }),

    scenario('refuses-to-start', 'starts nothing, recording nothing, for an experiment that is unknown or not pre-registered, whose pins or seals changed, whose candidate touches its judge, or whose pinned statistics library is not there; the experiment stays pre-registered (INV-2)', async (boot) => {
      const cases: Array<[EvaluationsFailure, Knobs, (world: ScriptedWorld) => void]> = [
        ['pins-changed', {}, (w) => { w.env = { ...w.env, workers: w.env.workers.map((x) => ({ ...x, observed: 'newer' })) } }],
        ['seal-broken', {}, (w) => { w.seals = [] }],
        ['touches-judge', { changes: ['review.defect-match/src/index.ts'] }, () => {}],
        ['touches-judge', { changes: ['review-suite'] }, () => {}],
        ['unavailable', {}, (w) => { w.methods = [] }],
      ]
      for (const [failure, knobs, change] of cases) {
        const run = await evaluate(boot, knobs)
        try {
          change(run.world)
          const before = run.ctx.artifacts.list({ limit: 1000 }).length
          expect(await failureOf(run.ctx.evaluations.start('exp-a', at(1))), failure).toBe(failure)
          expect(await failureOf(run.ctx.evaluations.start('exp-none', at(1)))).toBe('unknown-experiment')
          expect(run.world.started).toEqual([])
          expect(run.ctx.artifacts.list({ limit: 1000 })).toHaveLength(before)
          expect(await run.ctx.evaluations.list()).toEqual([])
          expect(await run.ctx.experiments.get('exp-a')).toMatchObject({ state: 'preregistered' })
        } finally {
          await run.dispose()
        }
      }
    }),

    scenario('collectors', 'takes each collector for as long as it is registered and refuses a second with its id; refuses to start without a collector the contract needs at the pinned version, or with a model-based collector whose family the experiment does not declare as a validator\'s (ADR-0036 verification family)', async (boot) => {
      const run = await evaluate(boot)
      try {
        const latency = run.world.collectors(run.records.contract).find((c) => c.id === 'trial.latency')!
        expect(() => run.ctx.evaluations.collector(latency)).toThrow()
        run.disposers.get('trial.latency')!()
        expect(await failureOf(run.ctx.evaluations.start('exp-a', at(1)))).toBe('unmeasurable')
        const newer = run.ctx.evaluations.collector({ ...latency, version: '1.0.1' })
        expect(await failureOf(run.ctx.evaluations.start('exp-a', at(1)))).toBe('unmeasurable')
        newer()
        const judge = run.ctx.evaluations.collector({ ...latency, family: 'judge-family' })
        expect(await failureOf(run.ctx.evaluations.start('exp-a', at(1)))).toBe('not-independent')
        judge()
        expect(run.world.started).toEqual([])
      } finally {
        await run.dispose()
      }
      const declared = await evaluate(boot, {}, (_, e) => { e.independence = { ...e.independence, validators: ['judge-family'] } })
      try {
        declared.disposers.get('trial.latency')!()
        const latency = declared.world.collectors(declared.records.contract).find((c) => c.id === 'trial.latency')!
        declared.ctx.evaluations.collector({ ...latency, family: 'judge-family' })
        expect(await declared.ctx.evaluations.start('exp-a', at(1))).toMatchObject({ state: 'running' })
      } finally {
        await declared.dispose()
      }
    }),
  ],
})

/** One evaluation as the fake keeps it. */
interface Run {
  entry: EvaluationEntry
  trials: Trial[]
  broken: Map<string, number[]>
  failures: Map<Check, string>
  missing: Array<{ trial: number; metric: string; why: string }>
  usage: BudgetLine[]
}
/** The fake's durable state, kept by its caller across restarts. */
export interface FakeState { evaluations: Map<string, Run> }
export const emptyState = (): FakeState => ({ evaluations: new Map() })
/** `name` is the provider's own name, part of every candidate's judge. */
export interface FakeConfig { world: World; state: FakeState; name?: string }

/**
 * A fake `ctx.evaluations` over a `World`, its state in a map its caller keeps across restarts. It
 * applies the same pure protocol as every provider (`schedule`, `pinProblems`, `sealProblems`,
 * `judgeTouched`, `collectorProblems`, `trialInvalid`, `canAfford`, `verdictDecision`), records a
 * trial as started before its run starts, never starts one twice, and drives the experiment's
 * state through `ctx.experiments`.
 */
export class FakeEvaluations extends Evaluations {
  static inject = ['artifacts', 'experiments']
  private readonly world: World
  private readonly state: FakeState
  private readonly providerName: string
  private readonly registered = new Map<string, Collector>()

  constructor(ctx: Context, config: FakeConfig) {
    super(ctx)
    this.world = config.world
    this.state = config.state
    this.providerName = config.name ?? 'evaluations'
  }

  collector(collector: Collector): () => void {
    if (this.registered.has(collector.id)) throw new TypeError(`a collector ${collector.id} is already registered`)
    this.registered.set(collector.id, collector)
    return () => {
      if (this.registered.get(collector.id) === collector) this.registered.delete(collector.id)
    }
  }

  private records(experimentRef: ArtifactRef): { experiment: Experiment; contract: ObjectiveContract } {
    const experiment = this.ctx.artifacts.get(experimentRef)!.body as Experiment
    return { experiment, contract: this.ctx.artifacts.get(experiment.objectiveContract.ref)!.body as ObjectiveContract }
  }

  private method(experiment: Experiment, kind: string): AnalysisMethod | undefined {
    const { library, version } = experiment.environment.statistics
    return this.world.methods.find((m) => m.kind === kind && m.library === library && m.version === version)
  }

  async start(experimentId: string, at = new Date()): Promise<EvaluationEntry> {
    const current = await this.ctx.experiments.get(experimentId)
    if (!current) throw new EvaluationsError('unknown-experiment', `no experiment ${experimentId}`)
    const evaluationId = evaluationIdOf(experimentId, current.revision)
    const known = this.state.evaluations.get(evaluationId)
    if (known && current.state === 'running' && current.evaluationId === evaluationId) return structuredClone(known.entry)
    if (current.state !== 'preregistered') throw new EvaluationsError('not-preregistered', `experiment ${experimentId} revision ${current.revision} is ${current.state}, not pre-registered`)
    const { experiment, contract } = this.records(current.experiment)
    const refuse = (failure: EvaluationsFailure, problems: string[]): void => {
      if (problems.length) throw new EvaluationsError(failure, `experiment ${experimentId} cannot start: ${problems.join('; ')}`)
    }
    let live: Omit<Environment, 'hash'>
    let partitions: ReturnType<World['partitions']>
    try {
      live = this.world.environment()
      partitions = this.world.partitions()
    } catch (error) {
      throw new EvaluationsError('unavailable', `the live environment or the suite cannot be read: ${(error as Error).message}`)
    }
    refuse('pins-changed', pinProblems(experiment.environment, live))
    refuse('seal-broken', sealProblems(experiment.suite, partitions))
    const required = requirementsOf(contract)
    const judge = [contract.contractId, experiment.suite.id, ...new Set([...required.collected.values(), ...required.constraints.values()]), this.providerName]
    refuse('touches-judge', judgeTouched(this.world.changes(experiment.candidate.subject), judge).map((c) => `the candidate changes ${c}, part of its judge`))
    const collectors = collectorProblems(contract, experiment, [...this.registered.values()])
    refuse('not-independent', [...independenceProblems(experiment.independence, experiment.environment.workers), ...collectors.dependent])
    refuse('unmeasurable', collectors.unmeasurable)
    refuse('unavailable', experiment.protocol.methods.filter((m) => !this.method(experiment, m.kind)).map((m) => `the pinned statistics library has no ${m.kind} method for ${m.metric}`))
    const used: string[] = experiment.suite.used
    const cases = partitions.filter((p) => used.includes(p.name)).flatMap((p) => p.cases.map((id) => ({ id, partition: p.name as 'regression' | 'held-out' })))
    const trials = schedule(cases, experiment.protocol.repetitions, experiment.seed)
    refuse('unavailable', trials.length === experiment.stopping.trials ? [] : [`the suite's cases make ${trials.length} trials, not the ${experiment.stopping.trials} pre-registered`])
    await this.ctx.experiments.begin(experimentId, evaluationId, at)
    const now = at.toISOString()
    const entry: EvaluationEntry = { evaluationId, experimentId, revision: current.revision, state: 'running', trials: trials.map((t) => ({ ...t, state: 'scheduled' })), startedAt: now, updatedAt: now }
    this.state.evaluations.set(evaluationId, { entry, trials: trials.map((t) => ({ ...t, state: 'scheduled', results: [], measurements: [] })), broken: new Map(), failures: new Map(), missing: [], usage: [] })
    return structuredClone(entry)
  }

  async sweep(at: Date): Promise<EvaluationEntry[]> {
    const moved: EvaluationEntry[] = []
    for (const run of this.state.evaluations.values()) {
      const before = JSON.stringify(run.entry)
      if (run.entry.state === 'running') await this.advance(run, at)
      if (run.entry.ended && run.entry.state !== 'closed') await this.decide(run, at)
      if (JSON.stringify(run.entry) !== before) moved.push(structuredClone(run.entry))
    }
    return moved
  }

  /** Reconcile what started before, then run trials until one is pending or the evaluation ends. */
  private async advance(run: Run, at: Date): Promise<void> {
    const current = (await this.ctx.experiments.get(run.entry.experimentId, run.entry.revision))!
    const { experiment, contract } = this.records(current.experiment)
    const required = requirementsOf(contract)
    const evaluationId = run.entry.evaluationId
    const sync = (t: Trial): void => {
      Object.assign(run.entry.trials[t.index]!, { state: t.state, ...(t.invalid ? { invalid: t.invalid } : {}) })
      run.entry.updatedAt = at.toISOString()
    }
    const fail = (check: Check, why: string): void => {
      if (!run.failures.has(check)) run.failures.set(check, why)
    }
    const measure = async (t: Trial, how: Exclude<RunEnd, 'pending' | 'unknown'>): Promise<void> => {
      Object.assign(t, { state: how.state, results: how.results, route: how.route })
      run.usage.push(...how.usage)
      const constraints = new Map<string, boolean>()
      const why = new Map<string, string>()
      for (const id of new Set([...required.collected.values(), ...required.constraints.values()])) {
        const c = this.registered.get(id)
        let got: Collection
        try {
          if (!c) throw new Error(`collector ${id} is not registered`)
          got = await c.measure({ experimentId: experiment.experimentId, revision: experiment.revision, evaluationId, trial: t, state: how.state, results: how.results, route: how.route }, (ref) => this.ctx.artifacts.get(ref)?.body)
        } catch (error) {
          for (const [name, owner] of [...required.collected, ...required.constraints]) if (owner === id) why.set(name, (error as Error).message.slice(0, 400))
          continue
        }
        for (const [metric, value] of Object.entries(got.metrics ?? {})) {
          if (required.collected.get(metric) === id && Number.isFinite(value)) t.measurements.push({ metric, value, source: `${c.id}@${c.version}` })
        }
        for (const [constraint, held] of Object.entries(got.constraints ?? {})) if (required.constraints.get(constraint) === id) constraints.set(constraint, held)
        if (got.contaminated && !t.invalid) {
          t.invalid = `contaminated: ${got.contaminated}`.slice(0, 500)
          fail('judge', `trial ${t.index}: ${got.contaminated}`)
        }
      }
      for (const [metric, unit] of required.ledger) t.measurements.push({ metric, value: how.usage.filter((l) => l.unit === unit).reduce((n, l) => n + l.amount, 0), source: 'ledger' })
      const missing = missingOf(t, required, constraints, (name) => why.get(name) ?? 'its collector returned no value')
      run.missing.push(...missing)
      if (missing.length) fail('metrics', `trial ${t.index} lacks ${missing.map((m) => m.metric).join(', ')}`)
      const invalid = trialInvalid(how.route, t.arm, experiment.environment)
      if (invalid && !t.invalid) {
        t.invalid = invalid.why
        fail(invalid.check, `trial ${t.index}: ${invalid.why}`)
      }
      for (const [id, held] of constraints) if (!held) run.broken.set(id, [...(run.broken.get(id) ?? []), t.index])
      sync(t)
    }
    const lose = (t: Trial): void => {
      t.state = 'lost'
      sync(t)
      fail('trials', `trial ${t.index} started and its outcome is unknown: it is never run again`)
    }
    for (const t of run.trials.filter((x) => x.state === 'started')) {
      const how = this.world.end({ ...t, evaluationId })
      if (how === 'pending') return
      if (how === 'unknown') lose(t)
      else await measure(t, how)
    }
    const end = (reason: NonNullable<EvaluationEntry['ended']>['reason'], detail?: string): void => {
      for (const t of run.trials.filter((x) => x.state === 'scheduled')) {
        t.state = 'skipped'
        sync(t)
      }
      run.entry.ended = { reason, at: at.toISOString(), ...(detail ? { detail: detail.slice(0, 1000) } : {}) }
      run.entry.updatedAt = at.toISOString()
    }
    for (;;) {
      if (run.failures.size) return end('integrity', [...run.failures.values()][0])
      if (run.broken.size) return end('hard-constraint', `${[...run.broken.keys()].join(', ')} broke`)
      const next = run.trials.find((t) => t.state === 'scheduled')
      if (!next) return end('horizon')
      const pins = pinProblems(experiment.environment, this.world.environment())
      if (pins.length) {
        fail('pins', pins[0]!)
        continue
      }
      const seal = sealProblems(experiment.suite, this.world.partitions())
      if (seal.length) {
        fail('seal', seal[0]!)
        continue
      }
      if (!canAfford(run.usage, experiment.budget.perTrial, experiment.budget.lines)) return end('budget', 'the funded budget cannot cover the next trial')
      next.state = 'started'
      sync(next)
      this.world.start({ ...next, evaluationId })
      const how = this.world.end({ ...next, evaluationId })
      if (how === 'pending') return
      if (how === 'unknown') lose(next)
      else await measure(next, how)
    }
  }

  /** Write the ended evaluation's record (`evaluated`), then its verdict (`closed`): each recorded before the experiment moves. */
  private async decide(run: Run, at: Date): Promise<void> {
    const current = (await this.ctx.experiments.get(run.entry.experimentId, run.entry.revision))!
    const { experiment, contract } = this.records(current.experiment)
    if (!run.entry.evaluation) {
      const evaluation = this.ctx.artifacts.put({
        kind: 'evidence', bodySchema: 'evaluation@1.0', body: this.record(run, experiment, contract, current.experiment), classification: 'operator-shared',
        producer: { type: 'system', ref: 'evaluations' }, subject: experiment.candidate.subject, inputs: [current.experiment, ...new Set(run.trials.flatMap((t) => t.results))],
      }).id as ArtifactRef
      await this.ctx.experiments.settle(run.entry.experimentId, { evaluationId: run.entry.evaluationId, evaluation }, at)
      Object.assign(run.entry, { state: 'evaluated', evaluation, updatedAt: at.toISOString() })
    }
    const evaluation = this.ctx.artifacts.get(run.entry.evaluation!)!.body as Evaluation
    const decision = verdictDecision(contract, experiment, evaluation, { evaluation: run.entry.evaluation!, experiment: current.experiment, contract: experiment.objectiveContract.ref })
    const verdict = this.ctx.artifacts.recordDecision(decision, { producer: { type: 'system', ref: 'evaluations' } }).id as ArtifactRef
    await this.ctx.experiments.close(run.entry.experimentId, { evaluationId: run.entry.evaluationId, verdict }, at)
    Object.assign(run.entry, { state: 'closed', verdict, outcome: decision.outcome.option, updatedAt: at.toISOString() })
  }

  private record(run: Run, experiment: Experiment, contract: ObjectiveContract, experimentRef: ArtifactRef): Evaluation {
    const horizonReached = run.entry.ended!.reason === 'horizon'
    const sums = new Map<string, BudgetLine>()
    for (const l of run.usage) {
      const k = `${l.pool}\u0000${l.unit}`
      sums.set(k, { ...l, amount: (sums.get(k)?.amount ?? 0) + l.amount })
    }
    const provenance = experiment.candidate.provenance.runs.flatMap((r) => this.world.provenance(r))
    return {
      schema: 'evaluation@1.0',
      evaluationId: run.entry.evaluationId,
      experiment: { id: experiment.experimentId, revision: experiment.revision, ref: experimentRef, identity: experiment.identity.hash },
      startedAt: run.entry.startedAt,
      ended: run.entry.ended!,
      horizonReached,
      trials: run.trials.map((t) => structuredClone(t) as Evaluation['trials'][number]),
      arms: (['baseline', 'candidate'] as const).map((arm) => ({ arm, metrics: armVector(arm, contract, run.trials) })),
      analysis: horizonReached && run.failures.size === 0 ? experiment.protocol.methods.map((m) => {
        const method = this.method(experiment, m.kind)!
        const input = analysisInput(m.metric, contract, experiment, run.trials)
        const result = method.analyse(input)
        return { metric: m.metric, method: { kind: m.kind, library: method.library, version: method.version }, cases: input.cases.length, difference: result.difference, candidate: result.candidate }
      }) : [],
      hardConstraints: contract.hardConstraints.map((c) => ({ id: c.id, held: !run.broken.has(c.id), broken: run.broken.get(c.id) ?? [] })),
      cost: {
        lines: [
          ...[...sums.values()].map((l) => ({ ...l, phase: 'evaluation' as const, kind: 'sunk' as const })),
          ...provenance.map((l) => ({ ...l, phase: 'implementation' as const, kind: 'sunk' as const })),
        ],
      },
      integrity: { checks: CHECKS.map((check) => (run.failures.has(check) ? { check, passed: false, detail: run.failures.get(check)!.slice(0, 1000) } : { check, passed: true })), missing: run.missing },
    }
  }

  async get(evaluationId: string): Promise<EvaluationEntry | undefined> {
    const run = this.state.evaluations.get(evaluationId)
    return run && structuredClone(run.entry)
  }

  async list(filter: { experimentId?: string; states?: Array<EvaluationEntry['state']>; limit?: number } = {}): Promise<EvaluationEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
    return [...this.state.evaluations.values()].map((r) => r.entry)
      .filter((e) => (filter.experimentId === undefined || e.experimentId === filter.experimentId) && (!filter.states || filter.states.includes(e.state)))
      .reverse().slice(0, limit).map((e) => structuredClone(e))
  }
}
