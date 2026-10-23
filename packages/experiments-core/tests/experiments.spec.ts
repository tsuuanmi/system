import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { contentId } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it } from 'vitest'
import { runSuite } from '../../libs/conformance/runner.ts'
import { emptyState, experimentsSuite, FakeExperiments, VOCABULARY } from '../conformance/experiments.ts'
import {
  admit, answerOf, changedPredicates, contractProblems, environmentHash, EXPERIMENTS_CONTRACT, ExperimentsError, fingerprintOf, firedPredicates, identityOf,
  independenceProblems, lessonEvidenceProblems, protocolHash, protocolProblems, vocabularyHash, vocabularyProblems,
  type CurrentEnvironment, type Experiment, type Hypothesis, type Lesson, type ObjectiveContract, type RecordedExperiment,
} from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037).
runSuite(experimentsSuite, {
  name: 'the fake provider',
  contract: EXPERIMENTS_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-experiments-'))
    const ctx = new Context()
    const kernel = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {})]
    await Promise.all(kernel)
    const state = emptyState()
    let registry: ReturnType<Context['plugin']> | undefined
    return {
      start: async () => {
        await registry?.dispose()
        registry = ctx.plugin(FakeExperiments, { vocabulary: VOCABULARY, state })
        await registry
        return ctx
      },
      dispose: async () => {
        await registry?.dispose()
        for (const fiber of kernel.reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})

type Json = Record<string, any>
const example = <T = Json>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as T
const hypothesis = example<Hypothesis>('hypothesis.worker-agnosticism')
const experiment = example<Experiment>('experiment.worker-agnosticism')
const contract = example<ObjectiveContract>('objective-contract.review')
const vocabulary = { mechanisms: [{ tag: 'worker-substitution', aliases: ['worker-swap'] }, { tag: 'prompt-change' }], interventions: [{ tag: 'member-workers' }, { tag: 'brief-wording' }] }

describe('the two keys, pinned (version 1)', () => {
  it('reproduces the fingerprint, the environment hash, the identity, and the protocol hash the examples record, so a change of either function shows here first', () => {
    expect(fingerprintOf(hypothesis, vocabulary)).toEqual(hypothesis.fingerprint)
    expect(hypothesis.fingerprint.hash).toBe('sha256:e0cebe240cc7d131819188c47d03d3ed9a45e478801c15fd88d16d34b44f546a')
    expect(environmentHash(experiment.environment)).toBe(experiment.environment.hash)
    expect(experiment.environment.hash).toBe('sha256:6215d1717962c3c6be69d0a015ba9983237ae0d9b48c011acefed1fa57c61a95')
    expect(identityOf(experiment, hypothesis)).toEqual(experiment.identity)
    expect(experiment.identity.hash).toBe('sha256:555cbafe58fbebcf61026293cbd984fa2d5c4baf7f7859c30dec52dd067d0849')
    expect(experiment.objectiveContract.hash).toBe(contentId(contract))
    expect(protocolHash(experiment.protocol)).toBe(example('decision.verdict').decider.hash)
    expect(vocabularyHash(vocabulary)).toBe(example('decision.registration').decider.hash)
  })

  it('normalizes the fingerprint from the vocabulary: an alias is its tag, an unknown tag is refused', () => {
    const alias = fingerprintOf({ ...hypothesis, mechanism: { tag: 'worker-swap', text: 'other words' } }, vocabulary)
    expect(alias).toEqual(hypothesis.fingerprint)
    expect(() => fingerprintOf({ ...hypothesis, intervention: { tag: 'telepathy', text: 'x' } }, vocabulary)).toThrow(ExperimentsError)
    expect(fingerprintOf({ ...hypothesis, expectedEffect: { metric: 'stalls', direction: 'decrease' } }, vocabulary).hash).not.toBe(hypothesis.fingerprint.hash)
  })

  it('reads no prose, id, budget, or seed into the identity, and every pin into it, in any order of the sets', () => {
    const reworded: Experiment = { ...experiment, experimentId: 'other', seed: 'x', budget: { ...experiment.budget, lines: [] }, candidate: { ...experiment.candidate, label: 'other', provenance: { runs: ['run-1'] } } }
    const rewordedHypothesis: Hypothesis = { ...hypothesis, statement: 'reworded', context: { ...hypothesis.context, text: 'reworded' } }
    const same = identityOf(reworded, rewordedHypothesis)
    expect(same).toEqual(experiment.identity)
    const reordered = { ...experiment, environment: { ...experiment.environment, workers: [...experiment.environment.workers].reverse(), collectors: [...experiment.environment.collectors].reverse() } }
    expect(identityOf(reordered, hypothesis)).toEqual(experiment.identity)
    const pins: Array<Partial<Experiment>> = [
      { candidate: { ...experiment.candidate, subject: { ...experiment.candidate.subject, version: 'v2' } } },
      { baseline: { subject: { ...experiment.baseline.subject, version: 'v2' } } },
      { comparison: { type: 'superiority' } },
      { objectiveContract: { ...experiment.objectiveContract, version: 2 } },
      { suite: { ...experiment.suite, version: 2 } },
      { environment: { ...experiment.environment, costModel: 'price-table:2026-11' } },
      { protocol: { ...experiment.protocol, repetitions: 3 } },
      { stopping: { rule: 'fixed-horizon', trials: 12 } },
      { independence: { ...experiment.independence, reviewers: ['gemini-web'] } },
    ]
    for (const pin of pins) expect(identityOf({ ...experiment, ...pin }, hypothesis).hash, Object.keys(pin)[0]).not.toBe(experiment.identity.hash)
    expect(identityOf(experiment, { ...hypothesis, target: { ...hypothesis.target, version: '2' } }).hash).not.toBe(experiment.identity.hash)
  })
})

describe('the vocabulary', () => {
  it('refuses a tag that is not one, and a word that names two terms', () => {
    expect(vocabularyProblems(vocabulary)).toEqual([])
    expect(vocabularyProblems({ ...vocabulary, mechanisms: [] })).toEqual(['mechanisms: the vocabulary needs at least one term'])
    expect(vocabularyProblems({ ...vocabulary, mechanisms: [{ tag: 'Worker Swap' }] })[0]).toMatch(/is not a vocabulary tag/)
    expect(vocabularyProblems({ ...vocabulary, mechanisms: [{ tag: 'a', aliases: ['b'] }, { tag: 'b' }] })).toEqual(['mechanisms: b names both a and b'])
  })
})

describe('the registry\'s answer', () => {
  const recorded = (id: string, change: (e: Experiment, h: Hypothesis) => void = () => {}, state: RecordedExperiment['state'] = 'closed'): RecordedExperiment => {
    const e = structuredClone(experiment)
    const h = structuredClone(hypothesis)
    change(e, h)
    e.identity = identityOf(e, h)
    return { experimentId: id, revision: 1, ref: `sha256:${contentId(id).slice(7)}`, state, experiment: e, hypothesis: h }
  }
  const answering = { experimentId: 'new', identity: experiment.identity.hash, hypothesis, experiment }

  it('finds an exact repeat only among pre-registered experiments that were not replaced, never its own revisions', () => {
    expect(answerOf(answering, [recorded('a')], []).answer).toBe('EXACT_REPEAT')
    expect(answerOf(answering, [recorded('a', () => {}, 'refused'), recorded('b', () => {}, 'superseded')], []).answer).toBe('NOVEL')
    expect(answerOf({ ...answering, experimentId: 'a' }, [recorded('a')], []).answer).toBe('NOVEL')
  })

  it('answers CONTEXT_CHANGED only when a predicate changed against every equal fingerprint, and RELATED otherwise', () => {
    const older = recorded('a', (e) => { e.environment = { ...e.environment, costModel: 'price-table:2026-09' } })
    const same = recorded('b', (e) => { e.baseline = { subject: { ...e.baseline.subject, version: 'v0' } } })
    expect(answerOf(answering, [older], [])).toEqual({ answer: 'CONTEXT_CHANGED', matches: [expect.objectContaining({ experimentId: 'a', relation: 'equal-fingerprint', changed: ['cost-structure'] })] })
    expect(answerOf(answering, [older, same], []).answer).toBe('RELATED')
  })

  it('names every retry predicate that changed in the records, in a fixed order', () => {
    const later = structuredClone(experiment)
    later.environment = { ...later.environment, workload: 'other', costModel: 'other', collectors: [...later.environment.collectors, { id: 'new', version: '1' }], workers: later.environment.workers.map((w) => ({ ...w, observed: 'v9' })) }
    later.objectiveContract = { ...later.objectiveContract, version: 2 }
    later.suite = { ...later.suite, version: 2 }
    const otherMechanism = { ...hypothesis, fingerprint: { ...hypothesis.fingerprint, mechanism: 'prompt-change' } }
    expect(changedPredicates({ experiment, hypothesis }, { experiment: later, hypothesis: otherMechanism })).toEqual(['model-version', 'workload', 'objective-version', 'suite-version', 'mechanism', 'measurement-defect', 'cost-structure'])
    expect(changedPredicates({ experiment, hypothesis }, { experiment, hypothesis })).toEqual([])
  })

  it('relates a shared target and mechanism, an experiment the hypothesis names, and one linked by hand to a match (one hop)', () => {
    const shared = recorded('a', (_, h) => { h.fingerprint = { ...h.fingerprint, intervention: 'brief-wording', hash: `sha256:${'1'.repeat(64)}` } })
    const far = recorded('b', (_, h) => { h.fingerprint = { ...h.fingerprint, target: 'template:ask', hash: `sha256:${'2'.repeat(64)}` } })
    const farther = recorded('c', (_, h) => { h.fingerprint = { ...h.fingerprint, target: 'template:brainstorm', hash: `sha256:${'3'.repeat(64)}` } })
    const novel = { ...answering, identity: `sha256:${'9'.repeat(64)}` as const }
    expect(answerOf(novel, [shared, far, farther], [{ a: 'a', b: 'b' }, { a: 'b', b: 'c' }]).matches.map((m) => [m.experimentId, m.relation])).toEqual([['a', 'shared'], ['b', 'linked']])
    const naming = { ...novel, hypothesis: { ...hypothesis, priorEvidence: { ...hypothesis.priorEvidence, experiments: ['c'] } } }
    expect(answerOf(naming, [far, farther], []).matches.map((m) => [m.experimentId, m.relation])).toEqual([['c', 'linked']])
  })

  it('pre-registers only what cites every match and names only predicates the records confirm', () => {
    const match = (relation: 'exact' | 'equal-fingerprint' | 'shared', changed: Array<'model-version' | 'workload'> = []) => ({ experimentId: 'a', revision: 1, ref: experiment.hypothesis.ref, relation, changed })
    expect(admit({ answer: 'NOVEL', matches: [] }, { cites: [], changed: [] }).outcome).toBe('preregistered')
    expect(admit({ answer: 'NOVEL', matches: [] }, { cites: [], changed: ['workload'] })).toMatchObject({ outcome: 'refused', reasons: { refused: ['it names workload as changed, which no record confirms'] } })
    expect(admit({ answer: 'EXACT_REPEAT', matches: [match('exact')] }, { cites: ['a'], changed: [] }).outcome).toBe('refused')
    expect(admit({ answer: 'RELATED', matches: [match('shared')] }, { cites: [], changed: [] }).outcome).toBe('refused')
    expect(admit({ answer: 'RELATED', matches: [match('shared')] }, { cites: ['a'], changed: [] }).outcome).toBe('preregistered')
    expect(admit({ answer: 'RELATED', matches: [match('equal-fingerprint')] }, { cites: ['a'], changed: [] }).outcome).toBe('refused')
    const changed = { answer: 'CONTEXT_CHANGED' as const, matches: [match('equal-fingerprint', ['model-version'])] }
    expect(admit(changed, { cites: ['a'], changed: ['model-version'], why: 'a newer model' }).outcome).toBe('preregistered')
    expect(admit(changed, { cites: ['a'], changed: ['model-version'], why: ' ' }).outcome).toBe('refused')
    expect(admit(changed, { cites: ['a'], changed: [], why: 'x' }).outcome).toBe('refused')
    for (const outcome of [admit(changed, { cites: [], changed: [] }), admit(changed, { cites: ['a'], changed: ['model-version'], why: 'x' })]) {
      expect(outcome.reasons.preregistered.length && outcome.reasons.refused.length, 'both candidates say why').toBeTruthy()
    }
  })
})

describe('the checks of a registration', () => {
  it('finds nothing wrong with the example contract, and every reference it cannot resolve in a broken one', () => {
    expect(contractProblems(contract)).toEqual([])
    const broken: ObjectiveContract = {
      ...contract,
      metrics: [...contract.metrics, { id: 'nested', unit: 'x', source: 'ratio', numerator: 'defects-per-cost', denominator: 'ghost' }],
      guardrails: [...contract.guardrails, { metric: 'defects-per-cost', direction: 'increase', nonInferiorityMargin: 1 }],
      protocol: { ...contract.protocol, methods: contract.protocol.methods.filter((m) => m.metric !== 'stalls') },
    }
    expect(contractProblems(broken)).toEqual(expect.arrayContaining([
      'the ratio nested reads defects-per-cost, which is itself a ratio', 'the ratio nested reads ghost, which is not one of the contract\'s metrics',
      'the metric stalls is judged but has no method', 'the primary metric is also a guardrail',
    ]))
  })

  it('holds an experiment\'s protocol to at least the contract\'s', () => {
    expect(protocolProblems(experiment.protocol, contract.protocol)).toEqual([])
    expect(protocolProblems({ ...contract.protocol, confidence: 0.95, minCases: 4, repetitions: 3 }, contract.protocol)).toEqual([])
    const weaker = { ...contract.protocol, repetitions: 1, methods: [{ metric: 'defects-per-cost', kind: 'sign-flip' as const }, { metric: 'latency', kind: 'sign-flip' as const }] }
    expect(protocolProblems(weaker, contract.protocol)).toEqual(expect.arrayContaining([
      'its 1 repetitions are fewer than the contract\'s 2', 'its method for defects-per-cost is sign-flip, not the contract\'s bootstrap', 'it has no method for stalls',
      'it adds a method for latency, which the contract does not name',
    ]))
  })

  it('keeps maker, reviewers, and validators of different families, and no validator of an arm\'s family', () => {
    const workers = experiment.environment.workers
    expect(independenceProblems(experiment.independence, workers)).toEqual([])
    expect(independenceProblems({ maker: 'a', reviewers: ['a'], validators: ['a'] }, workers)).toEqual(['a reviewer is of the maker\'s family', 'a validator is of the maker\'s family', 'a validator is of a reviewer\'s family'])
    expect(independenceProblems({ maker: 'a', reviewers: ['b'], validators: ['codex'] }, workers)).toEqual(['a validator is of a family one of the arms runs on'])
  })
})

describe('lessons', () => {
  const lesson = example<Lesson>('lesson.inconclusive')
  const current: CurrentEnvironment = {
    workers: experiment.environment.workers.map((w) => ({ family: w.family, observed: w.observed! })),
    objectives: [{ id: 'review-workflow', version: 1 }], suites: [{ id: 'review-suite', version: 1 }], collectors: experiment.environment.collectors,
    mechanisms: ['worker-substitution'], costModel: 'price-table:2026-10', now: '2026-12-01T00:00:00Z',
  }

  it('applies only while every predicate is checkably unchanged', () => {
    expect(firedPredicates(lesson, current)).toEqual([])
    expect(firedPredicates({ invalidatedBy: [{ kind: 'mechanism', tag: 'worker-substitution' }, { kind: 'cost-structure', costModel: 'price-table:2026-10' }] }, current)).toEqual([])
    expect(firedPredicates({ invalidatedBy: [{ kind: 'mechanism', tag: 'prompt-change' }] }, current)).toEqual([{ kind: 'mechanism', tag: 'prompt-change' }])
    expect(firedPredicates(lesson, { ...current, workers: current.workers.map((w) => (w.family === 'codex' ? { family: 'codex', observed: 'cli-2026-11' } : w)) })).toEqual([{ kind: 'model-version', family: 'codex', observed: 'cli-2026-10' }])
    expect(firedPredicates(lesson, { ...current, workers: current.workers.map((w) => (w.family === 'codex' ? { family: 'codex' } : w)) })).toEqual([{ kind: 'model-version', family: 'codex', observed: 'cli-2026-10' }])
    expect(firedPredicates(lesson, { ...current, collectors: [] }).map((p) => p.kind)).toEqual(['measurement-defect'])
    expect(firedPredicates(lesson, { ...current, now: '2027-05-01T00:00:00Z' }).map((p) => p.kind)).toEqual(['expiry'])
  })

  it('holds a lesson to the outcome of every verdict it cites, and to closed experiments it cites with them', () => {
    const [verdict] = lesson.evidence.verdicts
    const [cited] = lesson.evidence.experiments
    const records = {
      verdict: (ref: string) => (ref === verdict ? { outcome: 'inconclusive' as const, experimentId: cited!.id, revision: 1 } : undefined),
      experiment: (id: string, revision: number) => (id === cited!.id && revision === 1 ? { ref: cited!.ref, state: 'closed' as const, verdict: verdict! } : undefined),
    }
    expect(lessonEvidenceProblems(lesson, records)).toEqual([])
    expect(lessonEvidenceProblems({ ...lesson, outcome: 'supported' }, records)).toEqual([`the verdict ${verdict} is inconclusive, not the lesson's supported`])
    expect(lessonEvidenceProblems(lesson, { ...records, experiment: () => ({ ref: cited!.ref, state: 'evaluated' as const }) })).toEqual([`experiment ${cited!.id} revision 1 is evaluated: a lesson cites closed experiments only`])
    expect(lessonEvidenceProblems(lesson, { ...records, verdict: () => undefined })).toEqual([`it cites ${verdict}, which is no recorded verdict`])
  })
})
