/**
 * Conformance suite for `ctx.experiments` (ADR-0037; docs/design/experiments.md), and a fake
 * provider that passes it. `boot()` gives a registry over one durable state, configured with
 * `VOCABULARY`: `start()` (re)starts it over that state and returns a context with
 * `ctx.experiments` and `ctx.artifacts`. The suite writes the operator's records itself (an
 * objective contract and a funding approval) and builds registrations from the examples in
 * `schemas/examples`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { contentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type ArtifactRef, COUNTED, type CurrentEnvironment, type Experiment, type ExperimentDraft, type ExperimentEntry, Experiments, ExperimentsError, firedPredicates,
  fingerprintOf, type Hypothesis, type HypothesisDraft, identityOf, type Lesson, type LessonView, type Link, type Lookup, type Match, type ObjectiveContract,
  type Producer, prepareRegistration, experimentRecord, type RecordedExperiment, type Registration, registrationDecision, registrationHash, lessonEvidenceProblems,
  type Vocabulary, type ExperimentState, type Outcome,
} from '../src/index.ts'

export type Boot = () => Promise<{ start: () => Promise<Context>; dispose: () => Promise<void> }>

/** The vocabulary every provider under this suite is configured with. */
export const VOCABULARY: Vocabulary = {
  mechanisms: [{ tag: 'worker-substitution', aliases: ['worker-swap'] }, { tag: 'prompt-change' }, { tag: 'routing-order' }],
  interventions: [{ tag: 'member-workers' }, { tag: 'brief-wording' }, { tag: 'tier-change' }],
}

type Json = Record<string, any>
const example = (name: string): Json => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as Json
const schemas = new SchemaRegistry()
const T0 = new Date('2026-11-02T09:00:00Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
const OPERATOR: Producer = { type: 'operator', ref: 'operator' }
const clone = <T>(value: T): T => structuredClone(value)

/** The objective contract of the examples, recorded by the operator; and an approved funding round. */
export function operatorRecords(ctx: Context, contract: Json = example('objective-contract.review')): { contract: ObjectiveContract; contractRef: ArtifactRef; funding: ArtifactRef } {
  const contractRef = ctx.artifacts.put({ kind: 'criteria', bodySchema: 'objective-contract@1.0', body: contract, classification: 'operator-shared', producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
  const funding = ctx.artifacts.put({
    kind: 'approval', bodySchema: 'approval@1.0', classification: 'operator-shared', producer: { type: 'operator', ref: 'operator' },
    body: { schema: 'approval@1.0', subject: { type: 'content', ref: 'project:proj-feedback-loop:milestone:experiments:funding', version: '1' }, verdict: 'approved', by: 'operator' },
  }).id as ArtifactRef
  return { contract: contract as ObjectiveContract, contractRef, funding }
}

/** A registration built from the examples, bound to the recorded contract and funding, with its experiment id. */
export function registrationOf(records: ReturnType<typeof operatorRecords>, experimentId: string, change: (h: HypothesisDraft, e: ExperimentDraft) => void = () => {}): Registration {
  const { schema: _, fingerprint: __, ...hypothesis } = clone(example('hypothesis.worker-agnosticism')) as Hypothesis
  const { schema: ___, hypothesis: ____, registry: _____, identity: ______, environment, ...rest } = clone(example('experiment.worker-agnosticism')) as Experiment
  const { hash: _______, ...env } = environment
  const experiment: ExperimentDraft = {
    ...rest, experimentId, environment: env,
    objectiveContract: { id: records.contract.contractId, version: records.contract.version, hash: contentId(records.contract) as ArtifactRef, ref: records.contractRef },
    budget: { ...rest.budget, funding: records.funding },
  }
  change(hypothesis, experiment)
  return { hypothesis, experiment, producer: OPERATOR }
}

const decisionOf = (ctx: Context, ref: ArtifactRef): Json => {
  const envelope = ctx.artifacts.get(ref)
  expect(envelope?.kind, 'a decision').toBe('decision')
  schemas.assertRecord(envelope!.body as { schema: string })
  const body = envelope!.body as Json
  expect(body.candidates.every((c: Json) => c.reasons.some((r: string) => r.trim() !== '')), 'every candidate says why').toBe(true)
  return body
}
const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
  } catch (error) {
    expect(error).toBeInstanceOf(ExperimentsError)
    return (error as ExperimentsError).failure
  }
  throw new Error('expected the call to be refused')
}
const counts = (ctx: Context): { artifacts: number; decisions: number } => ({
  artifacts: ctx.artifacts.list({ limit: 1000 }).length,
  decisions: ctx.artifacts.list({ kind: 'decision', limit: 1000 }).length,
})

/** A `verdict` decision about one experiment's evaluation, as the evaluation engine records it. */
export function recordVerdict(ctx: Context, entry: ExperimentEntry, evaluationId: string, evaluation: ArtifactRef, outcome: Outcome): ArtifactRef {
  const experiment = ctx.artifacts.get(entry.experiment)!.body as Experiment
  return ctx.artifacts.recordDecision({
    schema: 'decision@1.7', decisionType: 'verdict', question: `What is the verdict of evaluation ${evaluationId}?`,
    inputs: [evaluation, entry.experiment, experiment.objectiveContract.ref],
    candidates: (['supported', 'refuted', 'inconclusive', 'invalid'] as const).map((o) => ({ option: o, selected: o === outcome, reasons: [o === outcome ? 'the conformance suite says so' : 'not chosen'] })),
    decider: { type: 'rule', id: 'evaluations.verdict', version: '1' },
    outcome: { option: outcome, detail: { experimentId: entry.experimentId, revision: entry.revision, evaluationId } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'evaluations' } }).id as ArtifactRef
}

/** An `evaluation@1.0` record of one experiment, as the evaluation engine writes it. */
export function recordEvaluation(ctx: Context, entry: ExperimentEntry, evaluationId: string): ArtifactRef {
  const body = { ...clone(example('evaluation.inconclusive')), evaluationId, experiment: { id: entry.experimentId, revision: entry.revision, ref: entry.experiment, identity: entry.identity } }
  return ctx.artifacts.put({ kind: 'evidence', bodySchema: 'evaluation@1.0', body, inputs: [entry.experiment], classification: 'operator-shared', producer: { type: 'system', ref: 'evaluations' } }).id as ArtifactRef
}

/** Run an experiment through the engine's moves to `closed` with the given outcome. */
export async function closeWith(ctx: Context, entry: ExperimentEntry, outcome: Outcome, minute = 10): Promise<{ entry: ExperimentEntry; verdict: ArtifactRef }> {
  const evaluationId = `${entry.experimentId}:r${entry.revision}`
  await ctx.experiments.begin(entry.experimentId, evaluationId, at(minute))
  const evaluation = recordEvaluation(ctx, entry, evaluationId)
  await ctx.experiments.settle(entry.experimentId, { evaluationId, evaluation }, at(minute + 1))
  const verdict = recordVerdict(ctx, entry, evaluationId, evaluation, outcome)
  return { entry: await ctx.experiments.close(entry.experimentId, { evaluationId, verdict }, at(minute + 2)), verdict }
}

const scenario = (id: string, title: string, run: (start: () => Promise<Context>) => Promise<void>): Scenario<Boot> => ({
  id: `experiments.${id}`, since: '1.0', title,
  run: async (boot) => {
    const { start, dispose } = await boot()
    try {
      await run(start)
    } finally {
      await dispose()
    }
  },
})

/** The next version a candidate arm Worker shows: a changed model version. */
const newModel = (_: HypothesisDraft, e: ExperimentDraft): void => {
  e.environment.workers = e.environment.workers.map((w) => (w.arm === 'candidate' ? { ...w, observed: `${w.observed}-next` } : w))
}

export const experimentsSuite = defineSuite<Boot>({
  seam: 'experiments',
  contract: '1.0',
  scenarios: [
    scenario('novel-preregistered', 'pre-registers a novel experiment: records the hypothesis (criteria) and the experiment (plan) with the fingerprint, environment hash, and identity it computes, recorded first as a registration decision@1.7 whose every candidate says why (INV-13, INV-14)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const registration = registrationOf(records, 'exp-a')
      const looked = await ctx.experiments.lookup(registration)
      expect(looked).toMatchObject({ answer: 'NOVEL', outcome: 'preregistered', matches: [] })
      expect(counts(ctx).decisions).toBe(0)
      const entry = await ctx.experiments.register(registration, at(0))
      expect(entry).toMatchObject({ experimentId: 'exp-a', revision: 1, state: 'preregistered', answer: 'NOVEL', matches: [] })
      const hypothesis = ctx.artifacts.get(entry.hypothesis)!
      const experiment = ctx.artifacts.get(entry.experiment)!
      expect([hypothesis.kind, hypothesis.bodySchema, experiment.kind, experiment.bodySchema]).toEqual(['criteria', 'hypothesis@1.0', 'plan', 'experiment@1.0'])
      const h = hypothesis.body as Hypothesis
      const e = experiment.body as Experiment
      schemas.assertRecord(h)
      schemas.assertRecord(e)
      expect(h.fingerprint).toEqual(fingerprintOf(registration.hypothesis, VOCABULARY))
      expect(e.identity).toEqual(identityOf(e, h))
      expect([entry.identity, entry.fingerprint, looked.identity]).toEqual([e.identity.hash, h.fingerprint.hash, e.identity.hash])
      expect(e).toMatchObject({ hypothesis: { id: h.hypothesisId, ref: entry.hypothesis }, registry: { answer: 'NOVEL', cites: [], changed: [] } })
      expect(experiment.inputs).toEqual(expect.arrayContaining([entry.hypothesis, records.contractRef, records.funding]))
      const decision = decisionOf(ctx, entry.registration)
      expect(decision).toMatchObject({ schema: 'decision@1.7', decisionType: 'registration', decider: { type: 'rule', id: 'experiments.registry' }, outcome: { option: 'preregistered', detail: { experimentId: 'exp-a', revision: 1, answer: 'NOVEL', identity: entry.identity } }, deterministic: true })
      expect(decision.inputs).toEqual(expect.arrayContaining([entry.experiment, entry.hypothesis]))
      expect(await ctx.experiments.get('exp-a')).toEqual(entry)
      expect((await ctx.experiments.list()).map((x) => x.experimentId)).toEqual(['exp-a'])
    }),

    scenario('exact-repeat-refused', 'refuses an exact repeat, reworded, re-seeded, re-funded, or with a tag given by its alias, recorded as refused with the earlier experiment, its verdict, and its lessons returned; a refused registration never counts, and the earlier one is unchanged (PROP-0011 never redo blindly)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const first = await ctx.experiments.register(registrationOf(records, 'exp-a'), at(0))
      const repeat = registrationOf(records, 'exp-b', (h, e) => {
        h.hypothesisId = 'review-worker-agnostic-again'
        h.statement = 'Agent CLI members review as well as website members, per unit of cost.'
        h.mechanism = { tag: 'worker-swap', text: 'The same idea, worded otherwise, its mechanism named by an alias.' }
        e.seed = 'another-seed'
        e.budget = { ...e.budget, lines: e.budget.lines.map((l) => ({ ...l, amount: l.amount + 1 })) }
      })
      expect(await ctx.experiments.lookup(repeat)).toMatchObject({ answer: 'EXACT_REPEAT', outcome: 'refused', matches: [{ experimentId: 'exp-a', relation: 'exact' }] })
      const refused = await ctx.experiments.register(repeat, at(1))
      expect(refused).toMatchObject({ experimentId: 'exp-b', state: 'refused', answer: 'EXACT_REPEAT', identity: first.identity, matches: [{ experimentId: 'exp-a', revision: 1, ref: first.experiment, relation: 'exact' }] })
      expect(decisionOf(ctx, refused.registration)).toMatchObject({ outcome: { option: 'refused', detail: { answer: 'EXACT_REPEAT' } } })
      expect(await ctx.experiments.get('exp-a')).toEqual(first)
      // The earlier experiment closed with a verdict and a lesson: a repeat is returned all three.
      const { verdict } = await closeWith(ctx, first, 'inconclusive')
      const lesson = { ...clone(example('lesson.inconclusive')), evidence: { verdicts: [verdict], experiments: [{ id: 'exp-a', revision: 1, ref: first.experiment }] } } as Lesson
      const { ref } = await ctx.experiments.recordLesson(lesson, OPERATOR, at(20))
      const again = await ctx.experiments.register(registrationOf(records, 'exp-c'), at(21))
      expect(again.state).toBe('refused')
      expect(again.matches).toEqual([expect.objectContaining({ experimentId: 'exp-a', relation: 'exact', state: 'closed', verdict, outcome: 'inconclusive', lessons: [ref] })])
      expect((await ctx.experiments.list({ states: ['refused'] })).map((x) => x.experimentId).sort()).toEqual(['exp-b', 'exp-c'])
    }),

    scenario('context-changed', 'answers CONTEXT_CHANGED for an equal fingerprint whose records differ in a retry predicate, and pre-registers it only when it cites the earlier experiment, names a predicate the records confirm, and says why (PROP-0011)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const first = await ctx.experiments.register(registrationOf(records, 'exp-a'), at(0))
      const attempt = async (id: string, extra: Partial<Registration>): Promise<ExperimentEntry> => ctx.experiments.register({ ...registrationOf(records, id, newModel), ...extra }, at(1))
      const uncited = await attempt('exp-b', { changed: ['model-version'], why: 'a newer model' })
      expect(uncited).toMatchObject({ state: 'refused', answer: 'CONTEXT_CHANGED', matches: [{ experimentId: 'exp-a', relation: 'equal-fingerprint', changed: ['model-version'] }] })
      expect((await attempt('exp-c', { cites: ['exp-a'], why: 'a newer model' })).state).toBe('refused')
      expect((await attempt('exp-d', { cites: ['exp-a'], changed: ['suite-version'], why: 'a newer model' })).state).toBe('refused')
      expect((await attempt('exp-e', { cites: ['exp-a'], changed: ['model-version'] })).state).toBe('refused')
      const retry = await attempt('exp-f', { cites: ['exp-a'], changed: ['model-version'], why: 'the candidate arm shows a newer model since exp-a' })
      expect(retry).toMatchObject({ state: 'preregistered', answer: 'CONTEXT_CHANGED' })
      const recorded = ctx.artifacts.get(retry.experiment)!.body as Experiment
      expect(recorded.registry).toEqual({ answer: 'CONTEXT_CHANGED', cites: [{ experimentId: 'exp-a', revision: 1, ref: first.experiment }], changed: ['model-version'], why: 'the candidate arm shows a newer model since exp-a' })
      expect(ctx.artifacts.get(retry.experiment)!.inputs).toContain(first.experiment)
    }),

    scenario('related', 'answers RELATED for a shared target and mechanism, pre-registered only when it cites the related experiment; and refuses an equal fingerprint whose records show no changed predicate, cited or not (PROP-0011)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      await ctx.experiments.register(registrationOf(records, 'exp-a'), at(0))
      const wording = (h: HypothesisDraft): void => {
        h.intervention = { tag: 'brief-wording', text: 'The members\' briefs are worded otherwise.' }
      }
      expect(await ctx.experiments.register(registrationOf(records, 'exp-b', wording), at(1))).toMatchObject({ state: 'refused', answer: 'RELATED', matches: [{ experimentId: 'exp-a', relation: 'shared' }] })
      expect(await ctx.experiments.register({ ...registrationOf(records, 'exp-c', wording), cites: ['exp-a'] }, at(2))).toMatchObject({ state: 'preregistered', answer: 'RELATED' })
      const otherBaseline = (_: HypothesisDraft, e: ExperimentDraft): void => {
        e.baseline = { subject: { ...e.baseline.subject, version: `sha256:${'b'.repeat(64)}` } }
      }
      const same = await ctx.experiments.register({ ...registrationOf(records, 'exp-d', otherBaseline), cites: ['exp-a'] }, at(3))
      expect(same).toMatchObject({ state: 'refused', answer: 'RELATED', matches: [{ experimentId: 'exp-a', relation: 'equal-fingerprint', changed: [] }, { experimentId: 'exp-c', relation: 'shared' }] })
      const novel = registrationOf(records, 'exp-e', (h) => {
        h.target = { ...h.target, ref: 'brainstorm' }
        h.mechanism = { tag: 'prompt-change', text: 'Another prompt.' }
      })
      expect(await ctx.experiments.register(novel, at(4))).toMatchObject({ state: 'preregistered', answer: 'NOVEL', matches: [] })
    }),

    scenario('linked-by-hand', 'treats an experiment the hypothesis names, or one linked by hand by the lead or the operator to a match, as related: the registration must cite it (PROP-0011)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const unrelated = (target: string, mechanism: string) => (h: HypothesisDraft): void => {
        h.target = { ...h.target, ref: target }
        h.mechanism = { tag: mechanism, text: 'Another idea.' }
      }
      await ctx.experiments.register(registrationOf(records, 'exp-a', unrelated('brainstorm', 'prompt-change')), at(0))
      await ctx.experiments.register(registrationOf(records, 'exp-b', unrelated('research', 'routing-order')), at(1))
      const naming = registrationOf(records, 'exp-c', (h, e) => {
        unrelated('ask', 'routing-order')(h)
        h.priorEvidence = { ...h.priorEvidence, experiments: ['exp-a'] }
        e.seed = 'c'
      })
      expect(await ctx.experiments.register(naming, at(2))).toMatchObject({ state: 'refused', answer: 'RELATED', matches: [{ experimentId: 'exp-a', relation: 'linked' }] })
      expect(await failureOf(ctx.experiments.link({ a: 'exp-a', b: 'exp-a', by: 'lead', note: 'itself' }, at(3)))).toBe('invalid')
      expect(await failureOf(ctx.experiments.link({ a: 'exp-a', b: 'exp-unknown', by: 'lead', note: 'unknown' }, at(3)))).toBe('invalid')
      const link = await ctx.experiments.link({ a: 'exp-a', b: 'exp-b', by: 'operator', note: 'the same question, asked twice' }, at(3))
      expect(link).toEqual({ a: 'exp-a', b: 'exp-b', by: 'operator', note: 'the same question, asked twice', at: at(3).toISOString() })
      expect(await ctx.experiments.link({ a: 'exp-b', b: 'exp-a', by: 'lead', note: 'again' }, at(4))).toEqual(link)
      const linked = { ...registrationOf(records, 'exp-d', (h, e) => {
        unrelated('ask', 'routing-order')(h)
        h.priorEvidence = { ...h.priorEvidence, experiments: ['exp-a'] }
        e.seed = 'd'
      }), cites: ['exp-a'] }
      const refused = await ctx.experiments.register(linked, at(5))
      expect(refused).toMatchObject({ state: 'refused', matches: [{ experimentId: 'exp-a', relation: 'linked' }, { experimentId: 'exp-b', relation: 'linked' }] })
      expect(await ctx.experiments.register({ ...linked, experiment: { ...linked.experiment, experimentId: 'exp-e' }, cites: ['exp-a', 'exp-b'] }, at(6))).toMatchObject({ state: 'preregistered', answer: 'RELATED' })
    }),

    scenario('invalid-records-nothing', 'refuses as invalid, recording nothing, a registration that is no valid record, a tag outside the vocabulary, a contract the operator did not write or another hash, a protocol weaker than the contract\'s, an unfunded budget, dependent families, a citation of no pre-registered experiment, or a revision that supersedes nothing (INV-2, INV-14)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const before = counts(ctx)
      // Content-addressed: another producer of the operator's very contract would only find the operator's artifact.
      const workerContract = { ...records.contract, note: 'Written by a Worker.' }
      const notOperator = ctx.artifacts.put({ kind: 'criteria', bodySchema: 'objective-contract@1.0', body: workerContract, classification: 'operator-shared', producer: { type: 'worker', ref: 'w1' } }).id as ArtifactRef
      const rejected = ctx.artifacts.put({ kind: 'approval', bodySchema: 'approval@1.0', classification: 'operator-shared', producer: { type: 'operator', ref: 'operator' }, body: { schema: 'approval@1.0', subject: { type: 'content', ref: 'funding', version: '1' }, verdict: 'rejected', by: 'operator' } }).id as ArtifactRef
      const cases: Array<[string, Registration]> = [
        ['not a record', { ...registrationOf(records, 'x1'), hypothesis: { ...registrationOf(records, 'x1').hypothesis, statement: '' } }],
        ['unknown tag', registrationOf(records, 'x2', (h) => { h.mechanism = { tag: 'telepathy', text: 'x' } })],
        ['contract by a Worker', registrationOf(records, 'x3', (_, e) => { e.objectiveContract = { ...e.objectiveContract, ref: notOperator, hash: contentId(workerContract) as ArtifactRef } })],
        ['contract hash', registrationOf(records, 'x4', (_, e) => { e.objectiveContract = { ...e.objectiveContract, hash: `sha256:${'c'.repeat(64)}` } })],
        ['weaker protocol', registrationOf(records, 'x5', (_, e) => { e.protocol = { ...e.protocol, confidence: 0.8 } })],
        ['rejected funding', registrationOf(records, 'x6', (_, e) => { e.budget = { ...e.budget, funding: rejected } })],
        ['unknown funding', registrationOf(records, 'x7', (_, e) => { e.budget = { ...e.budget, funding: `sha256:${'d'.repeat(64)}` } })],
        ['dependent families', registrationOf(records, 'x8', (_, e) => { e.independence = { ...e.independence, reviewers: [e.independence.maker] } })],
        ['wrong horizon', registrationOf(records, 'x9', (_, e) => { e.stopping = { rule: 'fixed-horizon', trials: 10 } })],
        ['unknown citation', { ...registrationOf(records, 'x10'), cites: ['exp-none'] }],
        ['revision of nothing', registrationOf(records, 'x11', (_, e) => { e.revision = 2 })],
      ]
      for (const [why, registration] of cases) {
        expect(await failureOf(ctx.experiments.register(registration, at(1))), why).toBe('invalid')
        expect(await failureOf(ctx.experiments.lookup(registration)), why).toBe('invalid')
      }
      expect(counts(ctx)).toEqual({ artifacts: before.artifacts + 2, decisions: before.decisions })
      expect(ctx.artifacts.get(notOperator)?.producer.type).toBe('worker')
      expect(await ctx.experiments.list()).toEqual([])
    }),

    scenario('idempotent', 'returns the recorded entry for a registration retried with the same content, recording nothing more, and refuses the same revision with other content (INV-4)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const registration = registrationOf(records, 'exp-a')
      const entry = await ctx.experiments.register(registration, at(0))
      const before = counts(ctx)
      expect(await ctx.experiments.register(clone(registration), at(5))).toEqual(entry)
      expect(counts(ctx)).toEqual(before)
      expect(await failureOf(ctx.experiments.register(registrationOf(records, 'exp-a', (_, e) => { e.seed = 'other' }), at(6)))).toBe('invalid')
    }),

    scenario('supersede', 'supersedes a pre-registered revision with the next one, its own earlier revision never counting against it; refuses to supersede a running one; and leaves the earlier revision as it was when the next is refused (PROP-0011)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const first = await ctx.experiments.register(registrationOf(records, 'exp-a'), at(0))
      const second = await ctx.experiments.register(registrationOf(records, 'exp-a', (_, e) => {
        e.revision = 2
        e.protocol = { ...e.protocol, repetitions: 3 }
        e.stopping = { rule: 'fixed-horizon', trials: 12 }
      }), at(1))
      expect(second).toMatchObject({ experimentId: 'exp-a', revision: 2, state: 'preregistered', answer: 'NOVEL' })
      expect(ctx.artifacts.get(second.experiment)!.lineage.supersedes).toEqual([first.experiment])
      expect(decisionOf(ctx, second.registration)).toMatchObject({ outcome: { detail: { supersedes: 1 } } })
      expect(await ctx.experiments.get('exp-a', 1)).toMatchObject({ state: 'superseded', supersededBy: 2 })
      expect(await ctx.experiments.get('exp-a')).toEqual(second)
      // A third revision that exactly repeats another experiment is refused, and the second stays live.
      expect(await ctx.experiments.register({ ...registrationOf(records, 'exp-b', newModel), cites: ['exp-a'], changed: ['model-version'], why: 'a newer model' }, at(2))).toMatchObject({ state: 'preregistered' })
      const repeat = await ctx.experiments.register(registrationOf(records, 'exp-a', (h, e) => {
        newModel(h, e)
        e.revision = 3
      }), at(3))
      expect(repeat).toMatchObject({ revision: 3, state: 'refused', answer: 'EXACT_REPEAT', matches: [{ experimentId: 'exp-b', relation: 'exact' }] })
      expect(await ctx.experiments.get('exp-a', 2)).toMatchObject({ state: 'preregistered' })
      expect(await ctx.experiments.get('exp-a')).toMatchObject({ revision: 2, state: 'preregistered' })
      expect(await failureOf(ctx.experiments.register(registrationOf(records, 'exp-a', (_, e) => { e.revision = 3; e.seed = 'x' }), at(4)))).toBe('invalid')
      // A running revision is never superseded.
      await ctx.experiments.begin('exp-a', 'exp-a:r2', at(4))
      expect(await failureOf(ctx.experiments.register(registrationOf(records, 'exp-a', (_, e) => { e.revision = 4; e.seed = 'x' }), at(5)))).toBe('invalid')
    }),

    scenario('evaluation-moves', 'moves an experiment preregistered → running → evaluated → closed only for the one evaluation that holds it, bound to an evaluation record of its exact identity and a verdict decision about it; every other move is an invalid transition (INV-5, INV-15)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const entry = await ctx.experiments.register(registrationOf(records, 'exp-a'), at(0))
      expect(await failureOf(ctx.experiments.settle('exp-a', { evaluationId: 'e1', evaluation: entry.experiment }, at(1)))).toBe('invalid-transition')
      expect(await failureOf(ctx.experiments.begin('exp-none', 'e1', at(1)))).toBe('unknown-experiment')
      const running = await ctx.experiments.begin('exp-a', 'e1', at(1))
      expect(running).toMatchObject({ state: 'running', evaluationId: 'e1' })
      expect(await ctx.experiments.begin('exp-a', 'e1', at(2))).toEqual(running)
      expect(await failureOf(ctx.experiments.begin('exp-a', 'e2', at(2)))).toBe('invalid-transition')
      const evaluation = recordEvaluation(ctx, entry, 'e1')
      expect(await failureOf(ctx.experiments.settle('exp-a', { evaluationId: 'e2', evaluation }, at(3)))).toBe('invalid-transition')
      const other = recordEvaluation(ctx, { ...entry, identity: `sha256:${'e'.repeat(64)}` }, 'e1')
      expect(await failureOf(ctx.experiments.settle('exp-a', { evaluationId: 'e1', evaluation: other }, at(3)))).toBe('invalid')
      expect(await ctx.experiments.settle('exp-a', { evaluationId: 'e1', evaluation }, at(3))).toMatchObject({ state: 'evaluated', evaluation })
      expect(await failureOf(ctx.experiments.close('exp-a', { evaluationId: 'e1', verdict: evaluation }, at(4)))).toBe('invalid')
      const verdict = recordVerdict(ctx, entry, 'e1', evaluation, 'refuted')
      expect(await failureOf(ctx.experiments.close('exp-a', { evaluationId: 'e2', verdict }, at(4)))).toBe('invalid-transition')
      const closed = await ctx.experiments.close('exp-a', { evaluationId: 'e1', verdict }, at(4))
      expect(closed).toMatchObject({ state: 'closed', verdict, outcome: 'refuted' })
      expect(await failureOf(ctx.experiments.begin('exp-a', 'e1', at(5)))).toBe('invalid-transition')
    }),

    scenario('lessons', 'records a lesson only when its outcome equals every verdict it cites and each cited experiment is closed with one of them, and computes when it is read whether it applies: a predicate that fired, or that the current environment cannot confirm, makes it possibly stale (PROP-0011)', async (start) => {
      const ctx = await start()
      const records = operatorRecords(ctx)
      const entry = await ctx.experiments.register(registrationOf(records, 'exp-a'), at(0))
      const lesson = (verdict: ArtifactRef, extra: Partial<Lesson> = {}): Lesson => ({ ...clone(example('lesson.inconclusive')), evidence: { verdicts: [verdict], experiments: [{ id: 'exp-a', revision: 1, ref: entry.experiment }] }, ...extra }) as Lesson
      const early = recordVerdict(ctx, entry, 'exp-a:r1', entry.experiment, 'inconclusive')
      expect(await failureOf(ctx.experiments.recordLesson(lesson(early), OPERATOR, at(1)))).toBe('invalid')
      const { verdict } = await closeWith(ctx, entry, 'inconclusive')
      expect(await failureOf(ctx.experiments.recordLesson(lesson(verdict, { outcome: 'supported' }), OPERATOR, at(20)))).toBe('invalid')
      expect(await failureOf(ctx.experiments.recordLesson(lesson(entry.experiment), OPERATOR, at(20)))).toBe('invalid')
      expect(await failureOf(ctx.experiments.recordLesson({ ...lesson(verdict), claim: '' }, OPERATOR, at(20)))).toBe('invalid')
      const before = counts(ctx).artifacts
      const { ref } = await ctx.experiments.recordLesson(lesson(verdict), OPERATOR, at(20))
      expect(counts(ctx).artifacts).toBe(before + 1)
      expect(ctx.artifacts.get(ref)).toMatchObject({ kind: 'finding', bodySchema: 'lesson@1.0' })
      expect(ctx.artifacts.get(ref)!.inputs).toEqual(expect.arrayContaining([verdict, entry.experiment]))
      const recorded = ctx.artifacts.get(ref)!.body as Lesson
      const experiment = ctx.artifacts.get(entry.experiment)!.body as Experiment
      const current: CurrentEnvironment = {
        workers: experiment.environment.workers.map((w) => ({ family: w.family, ...(w.observed ? { observed: w.observed } : {}) })),
        objectives: [{ id: 'review-workflow', version: 1 }], suites: [{ id: 'review-suite', version: 1 }],
        collectors: experiment.environment.collectors, mechanisms: VOCABULARY.mechanisms.map((m) => m.tag), costModel: 'price-table:2026-10', now: '2026-12-01T00:00:00Z',
      }
      const read = async (env: CurrentEnvironment): Promise<{ applicable: LessonView[]; stale: LessonView[] }> => ctx.experiments.lessons({ experimentId: 'exp-a' }, env)
      expect(await read(current)).toEqual({ applicable: [{ ref, lesson: recorded, fired: [] }], stale: [] })
      const moved = { ...current, suites: [{ id: 'review-suite', version: 2 }] }
      expect(await read(moved)).toEqual({ applicable: [], stale: [{ ref, lesson: recorded, fired: [{ kind: 'suite-version', id: 'review-suite', version: 1 }] }] })
      expect((await read({ ...current, workers: current.workers.slice(1) })).stale[0]!.fired.map((p) => p.kind)).toEqual(['model-version'])
      expect((await read({ ...current, now: '2027-06-01T00:00:00Z' })).stale[0]!.fired).toEqual(firedPredicates(recorded, { ...current, now: '2027-06-01T00:00:00Z' }))
      expect(await ctx.experiments.lessons({ target: 'template:review' }, current)).toEqual({ applicable: [{ ref, lesson: recorded, fired: [] }], stale: [] })
      expect(await ctx.experiments.lessons({ target: 'template:brainstorm' }, current)).toEqual({ applicable: [], stale: [] })
    }),

    scenario('restart', 'keeps every revision, its state, the links, and the lessons across a restart: the registry\'s state is durable, and its answers after a restart are those before it (plugin rule 6)', async (start) => {
      let ctx = await start()
      const records = operatorRecords(ctx)
      const a = await ctx.experiments.register(registrationOf(records, 'exp-a'), at(0))
      await ctx.experiments.register(registrationOf(records, 'exp-b', (h) => { h.target = { ...h.target, ref: 'ask' }; h.mechanism = { tag: 'routing-order', text: 'x' } }), at(1))
      const link = await ctx.experiments.link({ a: 'exp-a', b: 'exp-b', by: 'lead', note: 'related by hand' }, at(2))
      await ctx.experiments.begin('exp-a', 'exp-a:r1', at(3))
      const before = await ctx.experiments.list()
      ctx = await start()
      expect(await ctx.experiments.list()).toEqual(before)
      expect(await ctx.experiments.link({ a: 'exp-a', b: 'exp-b', by: 'lead', note: 'again' }, at(4))).toEqual(link)
      expect(await ctx.experiments.get('exp-a')).toMatchObject({ state: 'running', evaluationId: 'exp-a:r1', experiment: a.experiment })
      expect((await ctx.experiments.register(registrationOf(records, 'exp-c'), at(5))).state).toBe('refused')
    }),
  ],
})

/** The fake's durable state: what a store-backed provider keeps in its tables, kept by the caller across restarts. */
export interface FakeState {
  entries: ExperimentEntry[]
  records: Map<string, { experiment: Experiment; hypothesis: Hypothesis; registration: ArtifactRef }>
  links: Link[]
  lessons: Array<{ ref: ArtifactRef; lesson: Lesson }>
}
export const emptyState = (): FakeState => ({ entries: [], records: new Map(), links: [], lessons: [] })
export interface FakeConfig { vocabulary: Vocabulary; state: FakeState }

const key = (experimentId: string, revision: number): string => `${experimentId}\u0000${revision}`
const invalid = (message: string): ExperimentsError => new ExperimentsError('invalid', message)

/**
 * A fake `ctx.experiments` over a state its caller keeps across restarts. It applies the same pure
 * rule as every provider (`prepareRegistration`, `registrationDecision`, `lessonEvidenceProblems`,
 * `firedPredicates`), records through `ctx.artifacts` before it changes its state, and reads the
 * operator's contract and funding approval from the artifacts.
 */
export class FakeExperiments extends Experiments {
  static inject = ['artifacts']
  private readonly vocabulary: Vocabulary
  private readonly state: FakeState

  constructor(ctx: Context, config: FakeConfig) {
    super(ctx)
    this.vocabulary = config.vocabulary
    this.state = config.state
  }

  private recorded(): RecordedExperiment[] {
    return this.state.entries.map((e) => {
      const r = this.state.records.get(key(e.experimentId, e.revision))!
      return { experimentId: e.experimentId, revision: e.revision, ref: e.experiment, state: e.state, experiment: r.experiment, hypothesis: r.hypothesis }
    })
  }

  /** The operator's contract a registration names: a `criteria` artifact the operator wrote, holding a valid contract. */
  private contract(ref: unknown): ObjectiveContract {
    const envelope = typeof ref === 'string' ? this.ctx.artifacts.get(ref) : undefined
    if (!envelope || envelope.bodySchema !== 'objective-contract@1.0' || envelope.kind !== 'criteria') throw invalid('its objective contract is no recorded objective-contract artifact')
    if (envelope.producer.type !== 'operator') throw invalid('its objective contract was not written by the operator')
    return envelope.body as ObjectiveContract
  }

  /** The funding round's approval: an `approval@1.0` the operator gave. */
  private funding(ref: unknown): void {
    const envelope = typeof ref === 'string' ? this.ctx.artifacts.get(ref) : undefined
    const body = envelope?.body as { schema?: string; verdict?: string; by?: string } | undefined
    if (envelope?.kind !== 'approval' || body?.schema !== 'approval@1.0' || body.verdict !== 'approved' || body.by !== 'operator') throw invalid('its budget names no funding round the operator approved')
  }

  private enrich(matches: Match[]): Match[] {
    return matches.map((m) => {
      const entry = this.state.entries.find((e) => e.experimentId === m.experimentId && e.revision === m.revision)
      const lessons = this.state.lessons.filter((l) => l.lesson.evidence.experiments.some((x) => x.id === m.experimentId && x.revision === m.revision)).map((l) => l.ref)
      return { ...m, ...(entry?.verdict ? { verdict: entry.verdict, outcome: entry.outcome! } : {}), lessons }
    })
  }

  private prepare(registration: Registration) {
    const experiment = registration?.experiment as Partial<ExperimentDraft> | undefined
    const contract = this.contract(experiment?.objectiveContract?.ref)
    this.funding(experiment?.budget?.funding)
    return prepareRegistration(registration, { vocabulary: this.vocabulary, contract, recorded: this.recorded(), links: this.state.links })
  }

  async lookup(registration: Registration): Promise<Lookup> {
    const prepared = this.prepare(registration)
    return {
      answer: prepared.answer.answer, identity: prepared.identity.hash, fingerprint: prepared.hypothesis.fingerprint, matches: this.enrich(prepared.answer.matches),
      outcome: prepared.admission.outcome, reasons: prepared.admission.reasons[prepared.admission.outcome],
    }
  }

  async register(registration: Registration, at = new Date()): Promise<ExperimentEntry> {
    const draft = registration?.experiment
    const existing = draft && this.state.entries.find((e) => e.experimentId === draft.experimentId && e.revision === draft.revision)
    if (existing) {
      if (this.state.records.get(key(existing.experimentId, existing.revision))!.registration === registrationHash(registration)) return existing
      throw invalid(`experiment ${existing.experimentId} revision ${existing.revision} is already recorded with other content: a change is a new revision`)
    }
    if (!registration.producer || !['node', 'system', 'operator'].includes(registration.producer.type)) throw invalid('a registration names its producer: a workflow node, the system, or the operator')
    const prepared = this.prepare(registration)
    const classification = registration.classification ?? 'operator-shared'
    const h = prepared.hypothesis
    const hypothesis = this.ctx.artifacts.put({
      kind: 'criteria', bodySchema: 'hypothesis@1.0', body: h, classification, producer: registration.producer,
      inputs: [...h.priorEvidence.lessons, ...h.priorEvidence.research, ...(h.source.ref ? [h.source.ref] : [])],
    }).id as ArtifactRef
    const record = experimentRecord(registration, prepared, hypothesis)
    const experiment = this.ctx.artifacts.put({
      kind: 'plan', bodySchema: 'experiment@1.0', body: record, classification, producer: registration.producer, subject: record.candidate.subject,
      inputs: [hypothesis, record.objectiveContract.ref, record.budget.funding, ...record.registry.cites.map((c) => c.ref)],
      ...(prepared.previous ? { lineage: { supersedes: [prepared.previous.ref] } } : {}),
    }).id as ArtifactRef
    const decision = this.ctx.artifacts.recordDecision(registrationDecision(registration, prepared, { experiment, hypothesis }, this.vocabulary), { producer: { type: 'system', ref: 'experiments' } }).id as ArtifactRef
    const now = at.toISOString()
    const entry: ExperimentEntry = {
      experimentId: record.experimentId, revision: record.revision, state: prepared.admission.outcome, experiment, hypothesis,
      identity: record.identity.hash, fingerprint: h.fingerprint.hash, answer: prepared.answer.answer, registration: decision,
      matches: this.enrich(prepared.answer.matches), createdAt: now, updatedAt: now,
    }
    if (prepared.admission.outcome === 'preregistered' && prepared.previous) {
      const previous = this.state.entries.find((e) => e.experimentId === record.experimentId && e.revision === prepared.previous!.revision)!
      Object.assign(previous, { state: 'superseded', supersededBy: record.revision, updatedAt: now })
    }
    this.state.records.set(key(record.experimentId, record.revision), { experiment: record, hypothesis: h, registration: registrationHash(registration) })
    this.state.entries.push(entry)
    return structuredClone(entry)
  }

  async get(experimentId: string, revision?: number): Promise<ExperimentEntry | undefined> {
    const own = this.state.entries.filter((e) => e.experimentId === experimentId && (revision === undefined || e.revision === revision)).sort((a, b) => b.revision - a.revision)
    const found = own.find((e) => COUNTED.includes(e.state)) ?? own[0]
    return found && structuredClone(found)
  }

  async list(filter: { states?: ExperimentState[]; target?: string; limit?: number } = {}): Promise<ExperimentEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
    return this.state.entries
      .filter((e) => !filter.states || filter.states.includes(e.state))
      .filter((e) => !filter.target || this.state.records.get(key(e.experimentId, e.revision))!.hypothesis.fingerprint.target === filter.target)
      .map((e, i) => ({ e, i })).sort((a, b) => b.i - a.i).slice(0, limit).map(({ e }) => structuredClone(e))
  }

  async link(link: Omit<Link, 'at'>, at = new Date()): Promise<Link> {
    if (!link || !['lead', 'operator'].includes(link.by)) throw invalid('a link is made by the lead or the operator')
    if (typeof link.note !== 'string' || !link.note.trim() || link.note.length > 500) throw invalid('a link says why, in at most 500 characters')
    if (link.a === link.b) throw invalid('an experiment is not linked to itself')
    for (const id of [link.a, link.b]) if (!this.state.entries.some((e) => e.experimentId === id && COUNTED.includes(e.state))) throw invalid(`${id} is no pre-registered experiment`)
    const existing = this.state.links.find((l) => (l.a === link.a && l.b === link.b) || (l.a === link.b && l.b === link.a))
    if (existing) return { ...existing }
    const made: Link = { a: link.a, b: link.b, by: link.by, note: link.note, at: at.toISOString() }
    this.state.links.push(made)
    return { ...made }
  }

  /** The live revision of an experiment (neither refused nor superseded), the one the engine's moves apply to. */
  private current(experimentId: string): ExperimentEntry {
    const own = this.state.entries.filter((e) => e.experimentId === experimentId)
    if (!own.length) throw new ExperimentsError('unknown-experiment', `no experiment ${experimentId}`)
    const live = own.filter((e) => COUNTED.includes(e.state)).sort((a, b) => b.revision - a.revision)[0]
    if (!live) throw new ExperimentsError('invalid-transition', `experiment ${experimentId} has no pre-registered revision`)
    return live
  }

  private move(entry: ExperimentEntry, from: ExperimentState, evaluationId: string): void {
    if (entry.state !== from || (from !== 'preregistered' && entry.evaluationId !== evaluationId)) {
      throw new ExperimentsError('invalid-transition', `experiment ${entry.experimentId} revision ${entry.revision} is ${entry.state}${entry.evaluationId ? ` under ${entry.evaluationId}` : ''}, not ${from}${from === 'preregistered' ? '' : ` under ${evaluationId}`}`)
    }
  }

  async begin(experimentId: string, evaluationId: string, at = new Date()): Promise<ExperimentEntry> {
    const entry = this.current(experimentId)
    if (entry.state === 'running' && entry.evaluationId === evaluationId) return structuredClone(entry)
    this.move(entry, 'preregistered', evaluationId)
    Object.assign(entry, { state: 'running', evaluationId, updatedAt: at.toISOString() })
    return structuredClone(entry)
  }

  async settle(experimentId: string, evaluated: { evaluationId: string; evaluation: ArtifactRef }, at = new Date()): Promise<ExperimentEntry> {
    const entry = this.current(experimentId)
    this.move(entry, 'running', evaluated.evaluationId)
    const envelope = this.ctx.artifacts.get(evaluated.evaluation)
    const body = envelope?.body as { schema?: string; evaluationId?: string; experiment?: { id: string; revision: number; ref: string; identity: string } } | undefined
    if (envelope?.kind !== 'evidence' || body?.schema !== 'evaluation@1.0' || body.evaluationId !== evaluated.evaluationId
      || body.experiment?.id !== entry.experimentId || body.experiment.revision !== entry.revision || body.experiment.ref !== entry.experiment || body.experiment.identity !== entry.identity) {
      throw invalid(`${evaluated.evaluation} is no evaluation ${evaluated.evaluationId} of experiment ${entry.experimentId} revision ${entry.revision} at its identity`)
    }
    Object.assign(entry, { state: 'evaluated', evaluation: evaluated.evaluation, updatedAt: at.toISOString() })
    return structuredClone(entry)
  }

  async close(experimentId: string, closed: { evaluationId: string; verdict: ArtifactRef }, at = new Date()): Promise<ExperimentEntry> {
    const entry = this.current(experimentId)
    this.move(entry, 'evaluated', closed.evaluationId)
    const verdict = this.verdictOf(closed.verdict)
    if (!verdict || verdict.experimentId !== entry.experimentId || verdict.revision !== entry.revision || verdict.evaluationId !== closed.evaluationId || !verdict.inputs.includes(entry.evaluation!)) {
      throw invalid(`${closed.verdict} is no verdict on evaluation ${closed.evaluationId} of experiment ${entry.experimentId} revision ${entry.revision}`)
    }
    Object.assign(entry, { state: 'closed', verdict: closed.verdict, outcome: verdict.outcome, updatedAt: at.toISOString() })
    return structuredClone(entry)
  }

  private verdictOf(ref: ArtifactRef): { outcome: Outcome; experimentId: string; revision: number; evaluationId: string; inputs: string[] } | undefined {
    const body = this.ctx.artifacts.get(ref)?.body as { decisionType?: string; inputs?: string[]; outcome?: { option: Outcome; detail?: { experimentId?: string; revision?: number; evaluationId?: string } } } | undefined
    if (body?.decisionType !== 'verdict' || !body.outcome?.detail) return undefined
    const { experimentId, revision, evaluationId } = body.outcome.detail
    if (typeof experimentId !== 'string' || typeof revision !== 'number' || typeof evaluationId !== 'string') return undefined
    return { outcome: body.outcome.option, experimentId, revision, evaluationId, inputs: body.inputs ?? [] }
  }

  async recordLesson(lesson: Lesson, producer: Producer): Promise<{ ref: ArtifactRef }> {
    try {
      schemas.assert('lesson@1.0', lesson)
    } catch (error) {
      throw invalid(`the lesson is not a valid record: ${(error as Error).message}`)
    }
    const problems = lessonEvidenceProblems(lesson, {
      verdict: (ref) => this.verdictOf(ref),
      experiment: (id, revision) => {
        const entry = this.state.entries.find((e) => e.experimentId === id && e.revision === revision)
        return entry && { ref: entry.experiment, state: entry.state, ...(entry.verdict ? { verdict: entry.verdict } : {}) }
      },
    })
    if (lesson.supersedes && !this.state.lessons.some((l) => l.ref === lesson.supersedes)) problems.push(`it supersedes ${lesson.supersedes}, which is no recorded lesson`)
    if (problems.length) throw invalid(`the lesson is refused: ${problems.join('; ')}`)
    const ref = this.ctx.artifacts.put({
      kind: 'finding', bodySchema: 'lesson@1.0', body: lesson, classification: 'operator-shared', producer,
      inputs: [...lesson.evidence.verdicts, ...lesson.evidence.experiments.map((e) => e.ref)],
      ...(lesson.supersedes ? { lineage: { supersedes: [lesson.supersedes] } } : {}),
    }).id as ArtifactRef
    if (!this.state.lessons.some((l) => l.ref === ref)) this.state.lessons.push({ ref, lesson: structuredClone(lesson) })
    return { ref }
  }

  async lessons(filter: { experimentId?: string; target?: string }, current: CurrentEnvironment): Promise<{ applicable: LessonView[]; stale: LessonView[] }> {
    const about = (lesson: Lesson): boolean => lesson.evidence.experiments.some((x) => {
      if (filter.experimentId !== undefined && x.id !== filter.experimentId) return false
      if (filter.target !== undefined && this.state.records.get(key(x.id, x.revision))?.hypothesis.fingerprint.target !== filter.target) return false
      return true
    })
    const views = this.state.lessons.filter((l) => about(l.lesson)).map((l): LessonView => ({ ref: l.ref, lesson: structuredClone(l.lesson), fired: firedPredicates(l.lesson, current) }))
    return { applicable: views.filter((v) => v.fired.length === 0), stale: views.filter((v) => v.fired.length > 0) }
  }
}
