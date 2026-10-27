import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type AnalysisMethod as EngineMethod, analysisInput, type Evaluation, type Experiment, METHODS, type ObjectiveContract, type PairedCases, signFlipInterval, signFlipMethod,
  STATISTICS, StatisticsError, type Trial, UNBOUNDED, verdictOf,
} from '../src/index.ts'

const example = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as T
const review = example<ObjectiveContract>('objective-contract.review')
const experiment = example<Experiment>('experiment.worker-agnosticism')
const evaluation = example<Evaluation>('evaluation.inconclusive')

const method = signFlipMethod()
const cases = (...pairs: Array<[number[], number[]]>): PairedCases['cases'] => pairs.map(([candidate, baseline], i) => ({ case: `c${i + 1}`, candidate: { values: candidate }, baseline: { values: baseline } }))
const failure = (f: () => unknown): string | undefined => {
  try {
    f()
  } catch (e) {
    if (e instanceof StatisticsError) return e.failure
    throw e
  }
  return undefined
}

describe('the sign-flip method', () => {
  it('is the evaluation engine\'s analysis method of kind sign-flip, named by the library and version an experiment pins', () => {
    const engine: readonly EngineMethod[] = METHODS
    expect(engine.map((m) => [m.kind, m.library, m.version])).toEqual([['sign-flip', '@tsuuanmi/system-statistics', '1']])
    expect({ library: method.library, version: method.version }).toEqual(STATISTICS)
  })

  it('pairs each case\'s mean over its repetitions, and gives the exact interval of the mean difference at the protocol\'s confidence', () => {
    const input: PairedCases = { confidence: 0.9, ratio: false, cases: cases([[3, 5], [2, 2]], [[1], [0]], [[4, 4, 1], [1, 2]], [[0, 2], [1, 1]], [[6], [2]], [[2, 3], [3, 3]]) }
    const result = method.analyse(input)
    const exact = signFlipInterval([4, 1, 3, 1, 6, 2.5], [2, 0, 1.5, 1, 2, 3], 0.9)
    expect(result.difference).toEqual({ estimate: exact.estimate, lower: exact.lower, upper: exact.upper })
    expect(exact.rank).toBe(3)
    expect(result.difference.lower).toBeLessThan(exact.exact.lower)
  })

  it('gives the candidate\'s own level no interval, since a test on paired differences says nothing about one arm', () => {
    const result = method.analyse({ confidence: 0.9, ratio: false, cases: cases([[1], [0]], [[0.5, 1], [0]], [[1], [1]], [[1], [0]], [[0.75], [0.5]], [[1], [0]]) })
    expect(result.candidate).toEqual({ estimate: (0.75 + 0.75 + 1 + 1 + 1 + 1) / 6, lower: -UNBOUNDED, upper: UNBOUNDED })
  })

  it('writes an unbounded interval, one case or too few for the confidence, as the largest finite numbers, since a record is JSON', () => {
    for (const input of [cases([[2], [1]]), cases([[2], [1]], [[3], [1]], [[4], [1]], [[5], [1]])]) {
      const { difference } = method.analyse({ confidence: 0.9, ratio: false, cases: input })
      expect([difference.lower, difference.upper]).toEqual([-Number.MAX_VALUE, Number.MAX_VALUE])
      expect(JSON.parse(JSON.stringify(difference))).toEqual(difference)
    }
  })

  it('refuses, giving no interval a verdict could pass on: unverified goldens, a ratio metric, no case, more than 20, an arm without a value (INV-2)', () => {
    const six = cases([[1], [0]], [[2], [0]], [[3], [0]], [[4], [0]], [[5], [0]], [[6], [0]])
    expect(failure(() => signFlipMethod({ verified: false }).analyse({ confidence: 0.9, ratio: false, cases: six }))).toBe('unverified')
    expect(failure(() => method.analyse({ confidence: 0.9, ratio: true, cases: six }))).toBe('ratio')
    expect(failure(() => method.analyse({ confidence: 0.9, ratio: false, cases: [{ case: 'c1', candidate: { numerator: [1], denominator: [2] }, baseline: { numerator: [1], denominator: [3] } }] }))).toBe('ratio')
    expect(failure(() => method.analyse({ confidence: 0.9, ratio: false, cases: [] }))).toBe('unpaired')
    expect(failure(() => method.analyse({ confidence: 0.9, ratio: false, cases: cases(...Array.from({ length: 21 }, (_, i): [number[], number[]] => [[i], [0]])) }))).toBe('too-many-pairs')
    expect(failure(() => method.analyse({ confidence: 0.9, ratio: false, cases: [...six, { case: 'c7', candidate: { values: [] }, baseline: { values: [1] } }] }))).toBe('unpaired')
    expect(failure(() => method.analyse({ confidence: 0.4, ratio: false, cases: six }))).toBe('confidence')
    expect(failure(() => method.analyse({ confidence: 0.9, ratio: false, cases: cases([[1.5e308, 1.5e308], [0]], [[1], [0]]) }))).toBe('not-finite')
  })
})

describe('the sign-flip method under the verdict rule', () => {
  // A contract whose every judged metric is a per-case mean the sign-flip method analyses: the
  // review contract with its primary on defects found and its recall floor left out.
  const contract: ObjectiveContract = {
    ...review,
    primary: { metric: 'defects-found', direction: 'increase', minimumPracticalEffect: 0.5 },
    guardrails: review.guardrails.filter((g) => g.floor === undefined),
    protocol: { ...review.protocol, methods: ['defects-found', 'false-positives', 'quote-validity', 'stalls'].map((metric) => ({ metric, kind: 'sign-flip' as const })) },
  }
  type Values = Record<'defects-found' | 'false-positives' | 'quote-validity' | 'stalls' | 'blocking-recall', number>
  const trials = (count: number, values: (arm: 'baseline' | 'candidate', c: number, repetition: number) => Values): Trial[] => {
    const out: Trial[] = []
    for (let c = 1; c <= count; c++) {
      for (const arm of ['baseline', 'candidate'] as const) {
        for (let repetition = 1; repetition <= 2; repetition++) {
          const measurements = Object.entries(values(arm, c, repetition)).map(([metric, value]) => ({ metric, value, source: 'test' }))
          out.push({ index: out.length, case: `regression-case-${c}`, partition: 'regression', arm, repetition, state: 'completed', results: [], measurements })
        }
      }
    }
    return out
  }
  // The candidate finds one to two more defects per case and is level on every guardrail.
  const better = (arm: 'baseline' | 'candidate', c: number, repetition: number): Values => ({
    'defects-found': 3 + (c % 3) + (arm === 'candidate' ? 1 + ((c + repetition) % 2) : 0), 'false-positives': c % 2, 'quote-validity': 0.9, stalls: 0, 'blocking-recall': 1,
  })
  const verdict = (judged: ObjectiveContract, run: Trial[], comparison: Experiment['comparison'] = experiment.comparison) => {
    const analysis = judged.protocol.methods.map((m) => {
      const input = analysisInput(m.metric, judged, { protocol: judged.protocol, seed: experiment.seed }, run)
      const result = METHODS.find((x) => x.kind === m.kind)!.analyse(input)
      return { metric: m.metric, method: { kind: m.kind, library: STATISTICS.library, version: STATISTICS.version }, cases: input.cases.length, ...result }
    })
    return verdictOf(judged, { comparison }, { ...evaluation, analysis })
  }

  it('supports at the horizon only when the primary and every guardrail clear, read from the library\'s intervals', () => {
    expect(verdict(contract, trials(8, better))).toMatchObject({ outcome: 'supported', failedChecks: [] })
    expect(verdict(contract, trials(8, better), { type: 'superiority' })).toMatchObject({ outcome: 'supported' })
    const late = verdictOf(contract, experiment, { ...evaluation, horizonReached: false, ended: { reason: 'budget', at: evaluation.ended.at }, analysis: [] })
    expect(late.outcome).toBe('inconclusive')
  })

  it('is inconclusive with too few cases for a bounded interval, as the first experiment\'s two seeded cases are', () => {
    expect(verdict(contract, trials(2, better))).toMatchObject({ outcome: 'inconclusive', metrics: expect.arrayContaining([expect.objectContaining({ metric: 'defects-found', result: 'undecided', lower: -Number.MAX_VALUE })]) })
    expect(verdict(contract, trials(4, better)).outcome).toBe('inconclusive')
  })

  it('refutes when one guardrail\'s whole interval is past its margin, whatever the others show', () => {
    const noisy = (arm: 'baseline' | 'candidate', c: number, repetition: number): Values => ({ ...better(arm, c, repetition), 'false-positives': (c % 2) + (arm === 'candidate' ? 3 : 0) })
    expect(verdict(contract, trials(8, noisy))).toMatchObject({ outcome: 'refuted', metrics: expect.arrayContaining([expect.objectContaining({ metric: 'false-positives', result: 'excluded' })]) })
  })

  it('never supports a floor read from the method, and never analyses a ratio: such a contract cannot pass on it (INV-2)', () => {
    const floored: ObjectiveContract = { ...contract, guardrails: review.guardrails.filter((g) => g.floor !== undefined).concat(contract.guardrails), protocol: { ...contract.protocol, methods: [...contract.protocol.methods, { metric: 'blocking-recall', kind: 'sign-flip' }] } }
    expect(verdict(floored, trials(8, better))).toMatchObject({ outcome: 'inconclusive', metrics: expect.arrayContaining([expect.objectContaining({ metric: 'blocking-recall', threshold: { kind: 'floor', value: 0.75 }, result: 'undecided' })]) })
    const ratio: ObjectiveContract = { ...contract, protocol: { ...contract.protocol, methods: [...contract.protocol.methods, { metric: 'defects-per-cost', kind: 'sign-flip' }] } }
    const run = trials(8, (arm, c, r) => ({ ...better(arm, c, r), usage: 1000 } as Values))
    expect(failure(() => verdict(ratio, run))).toBe('ratio')
  })
})
