import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it } from 'vitest'
import { emptyState as emptyRegistry, FakeExperiments, VOCABULARY } from '../conformance/experiments.ts'
import { runSuite } from '../../libs/conformance/runner.ts'
import { emptyState, evaluationsSuite, FakeEvaluations } from '../conformance/evaluations.ts'
import {
  canAfford, CHECKS, collectorProblems, type Environment, type Evaluation, EVALUATIONS_CONTRACT, type Experiment, type ObjectiveContract, judgeTouched, netBenefit, pinProblems, schedule, sealProblems, trialInvalid,
  verdictDecision, verdictOf,
} from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037), over the experiments fake.
runSuite(evaluationsSuite, {
  name: 'the fake provider',
  contract: EVALUATIONS_CONTRACT,
  boot: async (world) => {
    const dir = mkdtempSync(join(tmpdir(), 'system-evaluations-'))
    const ctx = new Context()
    const kernel = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(FakeExperiments, { vocabulary: VOCABULARY, state: emptyRegistry() })]
    await Promise.all(kernel)
    const state = emptyState()
    let engine: ReturnType<Context['plugin']> | undefined
    return {
      start: async () => {
        await engine?.dispose()
        engine = ctx.plugin(FakeEvaluations, { world, state })
        await engine
        return ctx
      },
      dispose: async () => {
        await engine?.dispose()
        for (const fiber of kernel.reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})

type Json = Record<string, any>
const example = <T = Json>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as T
const contract = example<ObjectiveContract>('objective-contract.review')
const experiment = example<Experiment>('experiment.worker-agnosticism')
const evaluation = example<Evaluation>('evaluation.inconclusive')

describe('the schedule (version 1)', () => {
  const cases = [{ id: 'b', partition: 'regression' as const }, { id: 'a', partition: 'regression' as const }, { id: 'h', partition: 'held-out' as const }]

  it('is every case at every repetition in both arms, paired and interleaved, the same for the same seed and pinned by it', () => {
    const trials = schedule(cases, 2, 'seed-1')
    expect(trials).toHaveLength(12)
    expect(trials.map((t) => t.index)).toEqual([...Array(12).keys()])
    for (let i = 0; i < trials.length; i += 2) {
      const [x, y] = [trials[i]!, trials[i + 1]!]
      expect([x.case, x.repetition]).toEqual([y.case, y.repetition])
      expect(new Set([x.arm, y.arm])).toEqual(new Set(['baseline', 'candidate']))
    }
    expect(schedule([...cases].reverse(), 2, 'seed-1')).toEqual(trials)
    expect(schedule(cases, 2, 'seed-2')).not.toEqual(trials)
    expect(trials.filter((t) => t.arm === 'baseline').map((t) => t.index % 2), 'neither arm always runs first').toContain(0)
    expect(trials.filter((t) => t.arm === 'baseline').map((t) => t.index % 2)).toContain(1)
    // The example records this very order: a change of the drawing shows here first.
    const example = schedule([{ id: 'self-build.gate-59962e5', partition: 'regression' }, { id: 'self-build.queue-4dd2d3c', partition: 'regression' }], 2, 'f7-2026-10-23')
    expect(example.map(({ case: c, arm, repetition }) => ({ case: c, arm, repetition }))).toEqual(evaluation.trials.map(({ case: c, arm, repetition }) => ({ case: c, arm, repetition })))
  })

  it('refuses a case named twice and a repetition count that is not a positive integer', () => {
    expect(() => schedule([...cases, cases[0]!], 1, 's')).toThrow(TypeError)
    expect(() => schedule(cases, 0, 's')).toThrow(TypeError)
  })
})

describe('the integrity checks', () => {
  const { hash: _, ...live } = experiment.environment
  it('names what differs between the pinned environment and the live one, and nothing when they are the same', () => {
    expect(pinProblems(experiment.environment, live)).toEqual([])
    expect(pinProblems(experiment.environment, { ...live, composition: `sha256:${'f'.repeat(64)}` })).toEqual(['the composition changed'])
    const moved: Omit<Environment, 'hash'> = { ...live, workers: live.workers.map((w) => (w.family === 'codex' ? { ...w, observed: 'newer' } : w)), statistics: { library: 'x', version: '2' } }
    expect(pinProblems(experiment.environment, moved)).toEqual(['Worker agents:codex-review of the candidate arm changed (its family, descriptor, or the model version it shows)', 'the statistics library is not the pinned statistics-f2 1.0.0'])
    expect(pinProblems({ ...experiment.environment, hash: `sha256:${'0'.repeat(64)}` }, live)[0]).toBe('the pinned environment does not match its own hash')
  })

  it('breaks a seal on a changed or missing partition hash', () => {
    const [p] = experiment.suite.partitions
    expect(sealProblems(experiment.suite, [{ name: p!.name, hash: p!.hash }])).toEqual([])
    expect(sealProblems(experiment.suite, [{ name: p!.name, hash: `sha256:${'a'.repeat(64)}` }])).toHaveLength(1)
    expect(sealProblems(experiment.suite, [])).toHaveLength(1)
  })

  it('finds a candidate change that names or lies under a judge item, and only those', () => {
    expect(judgeTouched(['review-suite', 'collectors/x/y.ts', 'collectors/xy.ts', 'src/a.ts'], ['review-suite', 'collectors/x'])).toEqual(['review-suite', 'collectors/x/y.ts'])
  })

  it('makes a trial invalid for a same-family fallback, a Worker or family outside its arm, or a model version other than the pinned one', () => {
    const own = experiment.environment.workers.filter((w) => w.arm === 'candidate')
    const route = { workers: own.map((w) => w.worker), families: own.map((w) => w.family), sameFamily: false, observed: Object.fromEntries(own.map((w) => [w.worker, w.observed!])) }
    expect(trialInvalid(route, 'candidate', experiment.environment)).toBeUndefined()
    expect(trialInvalid({ ...route, sameFamily: true }, 'candidate', experiment.environment)?.check).toBe('families')
    expect(trialInvalid(route, 'baseline', experiment.environment)?.check).toBe('arms')
    expect(trialInvalid({ ...route, families: [...route.families, 'chatgpt-web'] }, 'candidate', experiment.environment)?.check).toBe('arms')
    expect(trialInvalid({ ...route, workers: [] }, 'candidate', experiment.environment)?.check).toBe('arms')
    expect(trialInvalid({ ...route, observed: {} }, 'candidate', experiment.environment)).toMatchObject({ check: 'pins', why: expect.stringMatching(/showed no model version/) })
  })

  it('needs every collector at its pinned version, and a model-based one of a declared validator\'s family only', () => {
    const collector = (id: string, extra: Json = {}) => ({ id, version: '1.0.0', metrics: contract.metrics.filter((m) => m.collector === id).map((m) => m.id), constraints: contract.hardConstraints.filter((c) => c.validator === id).map((c) => c.id), measure: () => ({}), ...extra })
    const all = [...new Set([...contract.metrics.flatMap((m) => (m.collector ? [m.collector] : [])), ...contract.hardConstraints.map((c) => c.validator)])].map((id) => collector(id))
    expect(collectorProblems(contract, experiment, all)).toEqual({ unmeasurable: [], dependent: [] })
    expect(collectorProblems(contract, experiment, all.filter((c) => c.id !== 'trial.stalls')).unmeasurable).toEqual(['metric stalls needs collector trial.stalls, which is not registered'])
    expect(collectorProblems(contract, experiment, all.map((c) => (c.id === 'trial.stalls' ? { ...c, metrics: [] } : c))).unmeasurable).toEqual(['collector trial.stalls does not measure metric stalls'])
    const judged = all.map((c) => (c.id === 'trial.stalls' ? { ...c, family: 'codex' } : c))
    expect(collectorProblems(contract, experiment, judged).dependent).toHaveLength(2)
  })

  it('starts a trial only while every line it reserves stays within the budget', () => {
    const lines = [{ pool: 'p', unit: 'usd' as const, amount: 10 }]
    const perTrial = [{ pool: 'p', unit: 'usd' as const, amount: 4 }]
    expect(canAfford([{ pool: 'p', unit: 'usd', amount: 6 }], perTrial, lines)).toBe(true)
    expect(canAfford([{ pool: 'p', unit: 'usd', amount: 6.5 }], perTrial, lines)).toBe(false)
    expect(canAfford([], [{ pool: 'q', unit: 'usd', amount: 1 }], lines)).toBe(false)
  })
})

describe('the verdict rule (version 1)', () => {
  const at = (difference: [number, number], candidate?: [number, number]) => ({ difference: { estimate: (difference[0] + difference[1]) / 2, lower: difference[0], upper: difference[1] }, ...(candidate ? { candidate: { estimate: candidate[0], lower: candidate[0], upper: candidate[1] } } : {}) })
  const analysed = (overrides: Record<string, ReturnType<typeof at>> = {}): Evaluation['analysis'] => {
    const base: Record<string, ReturnType<typeof at>> = {
      'defects-per-cost': at([0.1, 1]), 'blocking-recall': at([0, 0], [0.8, 1]), 'false-positives': at([-1, 0.5]), 'quote-validity': at([-0.05, 0.05]), stalls: at([-0.2, 0.1]),
    }
    return Object.entries({ ...base, ...overrides }).map(([metric, a]) => ({ metric, method: { kind: 'sign-flip' as const, library: 'l', version: '1' }, cases: 2, ...a }))
  }
  const judged = (analysis: Evaluation['analysis'], extra: Partial<Evaluation> = {}, comparison: Experiment['comparison'] = experiment.comparison) => verdictOf(contract, { comparison }, { ...evaluation, analysis, ...extra })

  it('reproduces the example verdict, inconclusive, from the example evaluation', () => {
    const decision = verdictDecision(contract, experiment, evaluation, { evaluation: example('decision.verdict').inputs[0], experiment: example('decision.verdict').inputs[1], contract: example('decision.verdict').inputs[2] })
    expect(decision).toEqual(example('decision.verdict'))
  })

  it('supports only when every guardrail clears and the primary clears its comparison, at the horizon', () => {
    expect(judged(analysed()).outcome).toBe('supported')
    expect(judged(analysed(), { horizonReached: false, ended: { reason: 'budget', at: evaluation.ended.at } })).toMatchObject({ outcome: 'inconclusive', reasons: { inconclusive: [expect.stringMatching(/horizon was not reached/)] } })
  })

  it('reads a superiority comparison against the minimum practical effect, so a tiny effect with high confidence fails it', () => {
    const tiny = analysed({ 'defects-per-cost': at([0.1, 0.2]) })
    expect(judged(tiny, {}, { type: 'superiority' })).toMatchObject({ outcome: 'refuted', metrics: expect.arrayContaining([expect.objectContaining({ metric: 'defects-per-cost', threshold: { kind: 'minimum-practical-effect', value: 0.5 }, result: 'excluded' })]) })
    expect(judged(analysed({ 'defects-per-cost': at([0.6, 2]) }), {}, { type: 'superiority' }).outcome).toBe('supported')
    expect(judged(analysed({ 'defects-per-cost': at([0.4, 2]) }), {}, { type: 'superiority' }).outcome).toBe('inconclusive')
    expect(judged(analysed({ 'defects-per-cost': at([-1, -0.6]) })).outcome).toBe('refuted')
  })

  it('orients a metric that should decrease, and holds a floor to the candidate\'s own level', () => {
    expect(judged(analysed({ 'false-positives': at([1.1, 3]) })).outcome).toBe('refuted')
    expect(judged(analysed({ 'false-positives': at([-3, -1.1]) })).outcome).toBe('supported')
    expect(judged(analysed({ 'blocking-recall': at([0, 0], [0.5, 0.7]) })).outcome).toBe('refuted')
    expect(judged(analysed({ 'blocking-recall': at([0, 0], [0.7, 0.9]) })).outcome).toBe('inconclusive')
  })

  it('is refuted by a broken hard constraint even before the horizon, and invalid for any failed, missing, or unrecorded check or result', () => {
    const broken = evaluation.hardConstraints.map((h) => (h.id === 'egress' ? { ...h, held: false, broken: [3] } : h))
    expect(judged(analysed(), { hardConstraints: broken, horizonReached: false, ended: { reason: 'hard-constraint', at: evaluation.ended.at } })).toMatchObject({ outcome: 'refuted', brokenConstraints: ['egress'] })
    for (const check of CHECKS) {
      const checks = evaluation.integrity.checks.map((c) => (c.check === check ? { ...c, passed: false } : c))
      expect(judged(analysed(), { integrity: { ...evaluation.integrity, checks } }), check).toMatchObject({ outcome: 'invalid', failedChecks: [check] })
    }
    expect(judged(analysed(), { integrity: { ...evaluation.integrity, checks: evaluation.integrity.checks.slice(1) } }).outcome).toBe('invalid')
    expect(judged(analysed(), { hardConstraints: evaluation.hardConstraints.slice(1) }).outcome).toBe('invalid')
    expect(judged(analysed().filter((a) => a.metric !== 'stalls')).outcome).toBe('invalid')
    expect(judged(analysed().map((a) => (a.metric === 'blocking-recall' ? { ...a, candidate: undefined } as never : a))).outcome).toBe('invalid')
  })

  it('gives every candidate of the decision a reason, whatever the outcome', () => {
    for (const verdict of [judged(analysed()), judged(analysed({ 'defects-per-cost': at([-2, -1]) })), judged(evaluation.analysis), judged(analysed(), { horizonReached: false })]) {
      expect(Object.values(verdict.reasons).every((r) => r.length > 0 && r.every((x) => x.trim() !== ''))).toBe(true)
    }
  })

  it('computes net benefit with conservative bounds, forward and full', () => {
    expect(netBenefit({ saving: 0.5, volume: 100, horizon: 'P90D', experimentCost: 20, deploymentCost: 5 })).toMatchObject({ forward: 45, full: 25 })
  })
})
