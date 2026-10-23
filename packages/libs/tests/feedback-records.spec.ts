// The feedback loop's records (PROP-0011, ADR-0044) refuse what their protocols forbid. Each case
// starts from a valid example in schemas/examples and breaks one rule.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SchemaRegistry } from '../src/index.ts'

const registry = new SchemaRegistry()
type Json = Record<string, any>
const example = (name: string): Json => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as Json
const valid = (tag: string, value: unknown): boolean => {
  try {
    registry.assert(tag, value)
    return true
  } catch {
    return false
  }
}
const without = (value: Json, key: string): Json => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key))

describe('objective-contract@1.0', () => {
  const contract = example('objective-contract.review')
  const tag = 'objective-contract@1.0'

  it('compares by constrained dominance only: no weights, and no other comparison (PROP-0011)', () => {
    expect(valid(tag, contract)).toBe(true)
    expect(valid(tag, { ...contract, weights: { 'defects-per-cost': 1 } })).toBe(false)
    expect(valid(tag, { ...contract, comparison: 'weighted-score' })).toBe(false)
  })

  it('always holds the invariants, egress, and the autonomy policy as hard constraints (INV-2, INV-12)', () => {
    for (const id of ['invariants', 'egress', 'autonomy-policy']) {
      const rest = contract.hardConstraints.filter((c: Json) => c.id !== id)
      expect(valid(tag, { ...contract, hardConstraints: [...rest, { id: 'extra', statement: 'more', validator: 'x' }] }), id).toBe(false)
    }
  })

  it('holds each guardrail to a non-inferiority margin or an absolute floor, never both or neither', () => {
    const [guard] = contract.guardrails as Json[]
    expect(valid(tag, { ...contract, guardrails: [{ ...guard, nonInferiorityMargin: 1 }] })).toBe(false)
    expect(valid(tag, { ...contract, guardrails: [without(guard!, 'floor')] })).toBe(false)
    expect(valid(tag, { ...contract, guardrails: [] })).toBe(true)
  })

  it('names where each metric comes from: a collector, the ledger in one of its units, or a ratio of two others', () => {
    const [collected, ledger, ratio] = contract.metrics as Json[]
    expect(valid(tag, { ...contract, metrics: [without(collected!, 'collector')] })).toBe(false)
    expect(valid(tag, { ...contract, metrics: [{ ...collected, ledgerUnit: 'usd' }] })).toBe(false)
    expect(valid(tag, { ...contract, metrics: [{ ...ledger, ledgerUnit: 'credits' }] })).toBe(false)
    expect(valid(tag, { ...contract, metrics: [without(ratio!, 'denominator')] })).toBe(false)
  })

  it('names one method per metric in advance, a bootstrap with its resamples and a posterior with its prior', () => {
    const methods = contract.protocol.methods as Json[]
    expect(valid(tag, { ...contract, protocol: { ...contract.protocol, methods: [{ metric: 'stalls', kind: 'bayesian' }] } })).toBe(false)
    expect(valid(tag, { ...contract, protocol: { ...contract.protocol, methods: [{ metric: 'stalls', kind: 'bayesian', prior: { family: 'beta', alpha: 1, beta: 1 } }] } })).toBe(true)
    expect(valid(tag, { ...contract, protocol: { ...contract.protocol, methods: [without(methods[0]!, 'resamples')] } })).toBe(false)
    expect(valid(tag, { ...contract, protocol: { ...contract.protocol, partitions: ['development'] } })).toBe(false)
  })
})

describe('hypothesis@1.0', () => {
  const hypothesis = example('hypothesis.worker-agnosticism')
  const tag = 'hypothesis@1.0'

  it('carries its fingerprint at version 1, and its tags from the vocabulary\'s form', () => {
    expect(valid(tag, hypothesis)).toBe(true)
    expect(valid(tag, without(hypothesis, 'fingerprint'))).toBe(false)
    expect(valid(tag, { ...hypothesis, fingerprint: { ...hypothesis.fingerprint, version: '2' } })).toBe(false)
    expect(valid(tag, { ...hypothesis, mechanism: { ...hypothesis.mechanism, tag: 'Worker Swap' } })).toBe(false)
  })

  it('names the artifact it came from, unless the operator stated it', () => {
    expect(valid(tag, { ...hypothesis, source: { kind: 'research' } })).toBe(false)
    expect(valid(tag, { ...hypothesis, source: { kind: 'research', ref: hypothesis.fingerprint.hash } })).toBe(true)
  })
})

describe('experiment@1.0', () => {
  const experiment = example('experiment.worker-agnosticism')
  const tag = 'experiment@1.0'

  it('supersedes the revision before it from revision 2 on, and nothing at revision 1', () => {
    expect(valid(tag, experiment)).toBe(true)
    expect(valid(tag, { ...experiment, supersedes: experiment.hypothesis.ref })).toBe(false)
    expect(valid(tag, { ...experiment, revision: 2 })).toBe(false)
    expect(valid(tag, { ...experiment, revision: 2, supersedes: experiment.hypothesis.ref })).toBe(true)
  })

  it('binds both arms to exact subjects, with their versions (INV-5)', () => {
    expect(valid(tag, { ...experiment, candidate: { ...experiment.candidate, subject: without(experiment.candidate.subject, 'version') } })).toBe(false)
    expect(valid(tag, { ...experiment, baseline: { subject: without(experiment.baseline.subject, 'version') } })).toBe(false)
  })

  it('declares a margin for a non-inferiority comparison only', () => {
    expect(valid(tag, { ...experiment, comparison: { type: 'non-inferiority' } })).toBe(false)
    expect(valid(tag, { ...experiment, comparison: { type: 'superiority', margin: 1 } })).toBe(false)
    expect(valid(tag, { ...experiment, comparison: { type: 'superiority' } })).toBe(true)
  })

  it('records the registry\'s answer and the exact identity at version 1, and never uses the development partition as evidence', () => {
    expect(valid(tag, { ...experiment, registry: { ...experiment.registry, answer: 'DUPLICATE' } })).toBe(false)
    expect(valid(tag, { ...experiment, registry: { ...experiment.registry, changed: ['the weather'] } })).toBe(false)
    expect(valid(tag, without(experiment, 'identity'))).toBe(false)
    expect(valid(tag, { ...experiment, identity: { ...experiment.identity, version: '2' } })).toBe(false)
    expect(valid(tag, { ...experiment, suite: { ...experiment.suite, used: ['development'] } })).toBe(false)
  })

  it('has a fixed horizon, a funded budget, and the families of maker and reviewers (INV-9)', () => {
    expect(valid(tag, { ...experiment, stopping: { rule: 'sequential', trials: 8 } })).toBe(false)
    expect(valid(tag, { ...experiment, budget: without(experiment.budget, 'funding') })).toBe(false)
    expect(valid(tag, { ...experiment, independence: { ...experiment.independence, reviewers: [] } })).toBe(false)
  })
})

describe('evaluation@1.0', () => {
  const evaluation = example('evaluation.inconclusive')
  const tag = 'evaluation@1.0'

  it('records every one of the seven integrity checks, and why each trial lacks a value', () => {
    expect(valid(tag, evaluation)).toBe(true)
    expect(valid(tag, { ...evaluation, integrity: { ...evaluation.integrity, checks: evaluation.integrity.checks.slice(1) } })).toBe(false)
    expect(valid(tag, { ...evaluation, integrity: { ...evaluation.integrity, missing: [{ trial: 0, metric: 'latency' }] } })).toBe(false)
  })

  it('binds to the experiment\'s exact identity, and keeps every trial, a lost one included (INV-4, INV-5)', () => {
    expect(valid(tag, { ...evaluation, experiment: without(evaluation.experiment, 'identity') })).toBe(false)
    const [first, ...rest] = evaluation.trials as Json[]
    expect(valid(tag, { ...evaluation, trials: [{ ...first, state: 'lost', results: [], measurements: [] }, ...rest] })).toBe(true)
    expect(valid(tag, { ...evaluation, trials: [{ ...first, state: 'started' }, ...rest] })).toBe(false)
  })

  it('takes cost from the ledger\'s units, by phase, sunk or projected (never a model\'s report)', () => {
    const line = evaluation.cost.lines[0] as Json
    expect(valid(tag, { ...evaluation, cost: { lines: [{ ...line, phase: 'guesswork' }] } })).toBe(false)
    expect(valid(tag, { ...evaluation, cost: { lines: [{ ...line, unit: 'credits' }] } })).toBe(false)
    expect(valid(tag, { ...evaluation, cost: { lines: [{ ...line, kind: 'projected', phase: 'operations' }] } })).toBe(true)
  })
})

describe('lesson@1.0', () => {
  const lesson = example('lesson.inconclusive')
  const tag = 'lesson@1.0'

  it('cites at least one verdict and its experiment, and carries an outcome of the verdict\'s vocabulary', () => {
    expect(valid(tag, lesson)).toBe(true)
    expect(valid(tag, { ...lesson, evidence: { ...lesson.evidence, verdicts: [] } })).toBe(false)
    expect(valid(tag, { ...lesson, outcome: 'equivalent' })).toBe(false)
  })

  it('is invalidated by typed predicates, never by a stored status', () => {
    expect(valid(tag, { ...lesson, invalidatedBy: [] })).toBe(false)
    expect(valid(tag, { ...lesson, applies: true })).toBe(false)
    expect(valid(tag, { ...lesson, invalidatedBy: [{ kind: 'model-version', family: 'codex' }] })).toBe(false)
    expect(valid(tag, { ...lesson, invalidatedBy: [{ kind: 'suite-version', id: 'review-suite', version: '1' }] })).toBe(false)
    expect(valid(tag, { ...lesson, invalidatedBy: [{ kind: 'expiry', at: '2027-05-01T00:00:00Z', tag: 'x' }] })).toBe(false)
  })
})

describe('decision@1.7', () => {
  it('adds the registry\'s registration and the engine\'s verdict decisions, refused before 1.7 (INV-13, INV-14)', () => {
    for (const name of ['decision.registration', 'decision.verdict']) {
      const decision = example(name)
      expect(valid('decision@1.7', decision), name).toBe(true)
      expect(valid('decision@1.7', { ...decision, schema: 'decision@1.6' }), name).toBe(false)
    }
    expect(valid('decision@1.7', { ...example('decision.lifecycle'), schema: 'decision@1.7' })).toBe(false)
  })
})
