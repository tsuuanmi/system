import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  adjudication, type Adjudication, calibrate, casesOf, evaluate, type Finding, freeze, loadRecords, match, measure, type Measurement, missingPins, type Records, schedule,
  type TrialFiles, unbound,
} from './worker-agnosticism.ts'

const dir = fileURLToPath(new URL('../../docs/validation/experiments/records', import.meta.url))
const records = (): Records => structuredClone(loadRecords(dir))
const gate = (r: Records) => casesOf(r).find((c) => c.caseId === 'gate-59962e5')!
const collector = Buffer.from('collector v1')

/** The records with every pin the operator fills before the freeze. */
function pinned(): Records {
  const r = records()
  const seats = { baseline: [['worker:chatgpt-main/standard'], ['agent:agy-review']], candidate: [['agent:codex-review'], ['agent:agy-review']] }
  for (const arm of ['baseline', 'candidate'] as const) {
    r.experiment[arm].seats.forEach((s, i) => {
      s.workers = seats[arm][i]!
      s.family ??= 'site-a'
      s.model = `model-${arm}-${i}`
      s.observed = `observed-${arm}-${i}`
    })
  }
  r.experiment.environment.system = { version: '0.8.0', commit: 'a'.repeat(40) }
  r.suite.labelling.confirmedBy = { who: 'operator', at: '2026-10-24T09:00:00Z' }
  return r
}
const frozen = (): Records => freeze(pinned(), { blobAt: (commit) => casesOf(records()).find((c) => c.commit === commit)!.blob, armFile: (name) => Buffer.from(name), collector, at: new Date('2026-10-24T10:00:00Z') })

const finding = (id: string, line: number, extra: Partial<Finding> = {}): Finding => ({
  id, members: ['m1'], severity: 'blocking', kind: 'defect', claim: `claim ${id}`, evidence: 'shown',
  quote: { path: 'packages/plugins/agent-workers/src/gate.ts', line, text: 'a line', matched: line }, class: 'confirmed', reports: [{ member: 'm1', class: 'confirmed' }], ...extra,
})

/** A candidate-arm trial of the gate case: two members on the arm's Workers, a stall retried, four findings, 30 minutes. */
function trialFiles(over: { findings?: Finding[]; workers?: [string, string]; observed?: Record<string, string> | null; clean?: boolean | null; sameFamily?: boolean; usage?: null } = {}): TrialFiles {
  const [w1, w2] = over.workers ?? ['agent:codex-review', 'agent:agy-review']
  const step = (nodeId: string, worker: string) => ({ nodeId, state: 'COMPLETED', worker, decisions: [{ id: `d-${nodeId}`, type: 'egress', outcome: 'allow' }, { id: `r-${nodeId}`, type: 'route', outcome: worker }, ...(over.sameFamily && nodeId === 'review:m2:propose' ? [{ id: 'sf', type: 'admission', outcome: 'same-family' }] : [])] })
  const at = (minutes: number): string => new Date(Date.parse('2026-10-25T08:00:00Z') + minutes * 60_000).toISOString()
  return {
    note: { trialId: 'r1-candidate-gate-59962e5', runId: 'run_a', observed: over.observed === undefined ? { swapped: 'observed-candidate-0', fixed: 'observed-candidate-1' } : over.observed, workspaceClean: over.clean === undefined ? true : over.clean },
    explain: {
      runId: 'run_a',
      nodes: [
        { nodeId: 'source', state: 'COMPLETED', decisions: [{ id: 'src', type: 'acceptance', outcome: 'accept' }] },
        step('review:m1:propose', w1), step('review:m2:propose', w2), step('review:m1:ballot:1', w1), step('review:m2:ballot:1', w2),
        { nodeId: 'review', state: 'COMPLETED', decisions: [{ id: 'vote', type: 'vote', outcome: 'changes' }] },
      ],
    },
    events: [
      { seq: 1, at: at(0), type: 'workflow.run.started' },
      { seq: 2, at: at(1), type: 'workflow.node.started', nodeId: 'review:m1:propose' },
      { seq: 3, at: at(2), type: 'workflow.node.retry', nodeId: 'review:m1:propose', data: { kind: 'provider_stalled' } },
      { seq: 4, at: at(3), type: 'workflow.node.started', nodeId: 'review:m1:propose' },
      { seq: 5, at: at(3), type: 'workflow.node.started', nodeId: 'review:m2:propose' },
      { seq: 6, at: at(20), type: 'workflow.node.started', nodeId: 'review:m1:ballot:1' },
      { seq: 7, at: at(20), type: 'workflow.node.started', nodeId: 'review:m2:ballot:1' },
      { seq: 8, at: at(30), type: 'workflow.node.completed', nodeId: 'review' },
    ],
    decision: {
      outcome: { option: 'changes', detail: { method: 'blocking-finding' } },
      vote: {
        repository: { commit: '59962e50ea1c05eeb5e7350f654c0e345c201237' },
        findings: over.findings ?? [finding('F1', 51), finding('F2', 61), finding('F3', 240, { members: ['m2'], reports: [{ member: 'm2', class: 'confirmed' }] }), finding('F4', 300)],
      },
    },
    source: { outcome: { detail: { commit: '59962e50ea1c05eeb5e7350f654c0e345c201237', files: [{ path: 'packages/plugins/agent-workers/src/gate.ts', sha: '6a8d4f1ae86fb21cae8a29b58d07646076dd2ad9' }] } } },
    ...(over.usage === null ? {} : { usage: { totals: [{ pool: 'exp.agy', records: 2, turns: 5, costUsd: 0.0123, usage: { inputTokens: 1000, outputTokens: 100 } }] } }),
  }
}
const trial = { trialId: 'r1-candidate-gate-59962e5', round: 1, arm: 'candidate' as const, caseId: 'gate-59962e5' }

describe('the worker-agnosticism records', () => {
  it('label every case of the used partition with sorted line lists, a severity on every defect, and no known non-defect line on a defect label', () => {
    const r = records()
    const cases = casesOf(r)
    expect(cases.map((c) => c.caseId)).toEqual(['gate-59962e5', 'queue-4dd2d3c'])
    for (const c of cases) {
      expect(new Set(c.labels.map((l) => l.id)).size).toBe(c.labels.length)
      for (const l of c.labels) {
        expect(l.lines.length).toBeGreaterThan(0)
        expect([...l.lines].sort((a, b) => a - b)).toEqual(l.lines)
        if (l.kind === 'defect') expect(['blocking', 'warning']).toContain(l.severity)
      }
      const defectLines = new Set(c.labels.filter((l) => l.kind === 'defect').flatMap((l) => l.lines))
      expect(c.labels.filter((l) => l.kind === 'non-defect').flatMap((l) => l.lines).filter((n) => defectLines.has(n))).toEqual([])
    }
    expect(cases.flatMap((c) => c.labels).filter((l) => l.severity === 'blocking').map((l) => l.id)).toEqual(['G1', 'G2', 'G4', 'Q1', 'Q3', 'Q4'])
  })

  it('schedules every case in every arm once per round, in blocks of one arm, the same way every time', () => {
    const r = records()
    const trials = schedule(r)
    expect(trials).toEqual(schedule(records()))
    expect(trials).toHaveLength(r.experiment.stopping.trials)
    expect(new Set(trials.map((t) => t.trialId)).size).toBe(trials.length)
    for (const round of [1, 2, 3]) {
      const arms = trials.filter((t) => t.round === round).map((t) => t.arm)
      expect(arms).toHaveLength(4)
      expect(arms[0]).toBe(arms[1])
      expect(arms[2]).toBe(arms[3])
      expect(arms[1]).not.toBe(arms[2])
    }
    for (const arm of ['baseline', 'candidate']) {
      for (const c of ['gate-59962e5', 'queue-4dd2d3c']) expect(trials.filter((t) => t.arm === arm && t.caseId === c)).toHaveLength(3)
    }
  })
})

describe('matching a finding to the labels', () => {
  it('identifies a label by a confirmed quote on its lines, asks for a pick on shared lines, and counts a known non-defect\'s lines as false positives', () => {
    const c = gate(records())
    expect(match(c, finding('F1', 51))).toEqual({ finding: 'F1', outcome: 'identified', labels: ['G1'] })
    expect(match(c, finding('F2', 61))).toEqual({ finding: 'F2', outcome: 'pick', labels: ['G1', 'G2'] })
    expect(match(c, finding('F3', 240))).toEqual({ finding: 'F3', outcome: 'non-defect', labels: ['N1'] })
    expect(match(c, finding('F4', 300))).toEqual({ finding: 'F4', outcome: 'unmatched', labels: [] })
  })

  it('never matches a quote that was not confirmed, one in another file, or a suggestion; uses the cited line when no match is recorded', () => {
    const c = gate(records())
    expect(match(c, finding('F1', 51, { class: 'needs-verification' })).outcome).toBe('unmatched')
    expect(match(c, finding('F1', 51, { quote: { path: 'README.md', line: 51, text: 'x', matched: 51 } })).outcome).toBe('unmatched')
    expect(match(c, finding('F1', 51, { kind: 'suggestion' })).outcome).toBe('suggestion')
    expect(match(c, finding('F1', 0, { quote: { path: c.path, line: 230, text: 'x' } }))).toEqual({ finding: 'F1', outcome: 'identified', labels: ['G4'] })
  })

  it('calibrates the labels against a seeding run: who identified each, and which only a pick could', () => {
    const rows = calibrate(gate(records()), [finding('F1', 51), finding('F2', 69), finding('F3', 61), finding('F4', 240)])
    expect(rows).toEqual([
      { label: 'G1', by: ['F1'], candidateOf: ['F3'] },
      { label: 'G2', by: ['F2'], candidateOf: ['F3'] },
      { label: 'G3', by: [], candidateOf: [] },
      { label: 'G4', by: [], candidateOf: [] },
      { label: 'N1', by: ['F4'], candidateOf: [] },
    ])
  })
})

describe('freezing the pre-registration', () => {
  it('refuses while a pin is missing, naming each, as the records stand now', () => {
    const r = records()
    expect(missingPins(r)).toEqual(expect.arrayContaining(['baseline.seats[0].workers', 'baseline.seats[0].family', 'candidate.seats[0].model', 'environment.system.commit', 'suite labelling.confirmedBy (who, at)']))
    expect(() => freeze(r, { blobAt: () => '', armFile: () => Buffer.from(''), collector, at: new Date() })).toThrow(/missing baseline\.seats\[0\]\.workers/)
  })

  it('refuses a case whose file at its commit is not the blob its labels are for', () => {
    expect(() => freeze(pinned(), { blobAt: () => 'b'.repeat(40), armFile: (n) => Buffer.from(n), collector, at: new Date() })).toThrow(/case gate-59962e5: .* is blob b{40}/)
  })

  it('fills every hash once, binds the records, and refuses a second freeze or any later change', () => {
    const f = frozen()
    expect(f.experiment.state).toBe('preregistered')
    expect(f.experiment.identity.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(f.experiment.baseline.subject.version).toMatch(/^sha256:/)
    expect(f.experiment.independence.reviewers).toEqual({ baseline: ['site-a', 'antigravity-cli'], candidate: ['codex-sdk', 'antigravity-cli'] })
    expect(unbound(f, collector)).toEqual([])
    expect(() => freeze(f, { blobAt: () => '', armFile: () => Buffer.from(''), collector, at: new Date() })).toThrow(/is preregistered, not proposed/)
    const edited = structuredClone(f)
    edited.suite.request += ' Also look at the tests.'
    expect(unbound(edited, collector)).toEqual(["the suite's regression partition changed since the freeze"])
    expect(unbound(f, Buffer.from('collector v2'))).toEqual(['this collector is not the one the experiment pinned'])
    const margin = structuredClone(f)
    margin.experiment.comparison = { ...(margin.experiment.comparison as object), margin: { value: 0.5, scale: 'ratio' } }
    expect(unbound(margin, collector)).toEqual(['the experiment changed since the freeze'])
    expect(unbound(records(), collector)).toEqual(['experiment review-worker-agnostic-1 is proposed: freeze it before any trial is collected'])
  })
})

describe('collecting a trial', () => {
  it('measures the identified labels, the member steps, the stalls retried, and the latency from the run\'s records', () => {
    const m = measure(frozen(), trial, trialFiles())
    expect(m.integrity).toEqual([])
    expect(m.hardConstraints).toEqual([])
    expect(m.outcome).toBe('blocking-finding')
    expect(m.members).toEqual([{ member: 'm1', worker: 'agent:codex-review', seat: 'swapped' }, { member: 'm2', worker: 'agent:agy-review', seat: 'fixed' }])
    expect(m.matches.map((x) => x.outcome)).toEqual(['identified', 'pick', 'non-defect', 'unmatched'])
    expect(m.perMember).toEqual([{ member: 'm1', reports: 3, confirmed: 3, identified: ['G1'] }, { member: 'm2', reports: 1, confirmed: 1, identified: [] }])
    expect([m.steps, m.stalls, m.latencyMinutes, m.defectFindings, m.confirmed]).toEqual([5, 1, 30, 4, 4])
  })

  it('names each integrity breach: a Worker outside the arm, a same-family admission, a drifted version, the fix named, a workspace check not recorded', () => {
    expect(measure(frozen(), trial, trialFiles({ workers: ['worker:chatgpt-main/standard', 'agent:agy-review'] })).integrity).toEqual([
      'review:m1:propose ran on worker:chatgpt-main/standard, outside the candidate arm', 'review:m1:ballot:1 ran on worker:chatgpt-main/standard, outside the candidate arm',
    ])
    expect(measure(frozen(), trial, trialFiles({ sameFamily: true })).integrity).toEqual(['review:m2:propose was admitted on the same provider family'])
    expect(measure(frozen(), trial, trialFiles({ observed: { swapped: 'observed-candidate-0', fixed: 'newer' } })).integrity).toEqual(['seat fixed showed newer, the experiment pinned observed-candidate-1'])
    expect(measure(frozen(), trial, trialFiles({ findings: [finding('F1', 51, { evidence: 'as ef015fb fixed it' })] })).integrity).toEqual(['finding F1 names ef015fb, the fix'])
    expect(measure(frozen(), trial, trialFiles({ clean: null })).integrity).toEqual(['the operator\'s check of the members\' workspaces is not recorded'])
    expect(measure(frozen(), trial, trialFiles({ usage: null })).integrity).toEqual(['the ledger\'s usage of the run is not exported (usage.json)'])
    expect(measure(frozen(), trial, trialFiles({ clean: false })).hardConstraints).toEqual(['an agent member\'s workspace changed during the trial'])
    expect(measure(frozen(), trial, trialFiles({ findings: [finding('F1', 51, { claim: 'realLocation would fix it' })] })).flags).toEqual([{ text: 'realLocation', finding: 'F1' }])
  })
})

describe('evaluating', () => {
  const findingsOf = (): Finding[] => trialFiles().decision!.vote!.findings!
  const run = (m: Measurement[], adj: Adjudication) => evaluate(frozen(), m, adj)

  it('is inconclusive with two cases and the horizon not reached, and keeps unadjudicated findings as bounds', () => {
    const m = measure(frozen(), trial, trialFiles())
    const adj = adjudication([m], findingsOf)
    expect(adj.items.map((i) => [i.key, i.kind, i.options])).toEqual([
      ['r1-candidate-gate-59962e5/F2', 'pick', ['G1', 'G2', 'not-a-defect', 'defect-unlabelled', 'unsure']],
      ['r1-candidate-gate-59962e5/F4', 'unmatched', ['not-a-defect', 'defect-unlabelled', 'unsure']],
    ])
    const { evaluation, verdict } = run([m], adj)
    expect(verdict.outcome).toBe('inconclusive')
    expect(verdict.candidates.find((c) => c.selected)!.reasons).toEqual([
      "2 case(s), fewer than the protocol's 5: no metric can support or refute", 'the horizon is not reached: 11 trial(s) not run', 'no statistic is computed until the statistics library is chosen (F2)',
    ])
    expect(evaluation.trials[0]!.resolved).toEqual({ identified: { min: 1, max: 2, labels: ['G1'] }, blocking: { min: 1, max: 2, present: 3 }, falsePositives: { min: 1, max: 3 }, novel: 0 })
    expect(evaluation.arms.candidate.defectsPerCost).toEqual({ min: 0.2, max: 0.4 })
    expect(evaluation.arms.candidate.usage).toEqual({ 'exp.agy': { records: 2, turns: 5, costUsd: 0.0123, inputTokens: 1000, outputTokens: 100 } })
    expect(evaluation.arms.baseline.trials).toBe(0)
  })

  it('applies the adjudication, keeping every verdict given when trials are collected again', () => {
    const m = measure(frozen(), trial, trialFiles())
    const first = adjudication([m], findingsOf)
    first.items[0]!.verdict = 'G2'
    first.items[1]!.verdict = 'not-a-defect'
    const again = adjudication([m], findingsOf, first)
    expect(again.items.map((i) => i.verdict)).toEqual(['G2', 'not-a-defect'])
    expect(run([m], again).evaluation.trials[0]!.resolved).toEqual({ identified: { min: 2, max: 2, labels: ['G1', 'G2'] }, blocking: { min: 2, max: 2, present: 3 }, falsePositives: { min: 2, max: 2 }, novel: 0 })
    again.items[0]!.verdict = 'G3'
    expect(() => run([m], again)).toThrow(/G3 is not one of its options/)
  })

  it('is invalid on an integrity breach, refuted on a broken hard constraint, and refuses while a contamination flag waits', () => {
    const breach = measure(frozen(), trial, trialFiles({ sameFamily: true }))
    expect(run([breach], adjudication([breach], findingsOf)).verdict.outcome).toBe('invalid')
    const broken = measure(frozen(), trial, trialFiles({ clean: false }))
    expect(run([broken], adjudication([broken], findingsOf)).verdict.outcome).toBe('refuted')
    const flagged = measure(frozen(), trial, trialFiles({ findings: [finding('F1', 51, { claim: 'realLocation would fix it' })] }))
    const adj = adjudication([flagged], () => [finding('F1', 51, { claim: 'realLocation would fix it' })])
    expect(() => run([flagged], adj)).toThrow(/contamination flags without a verdict/)
    adj.flags[0]!.verdict = 'cites-fix'
    expect(run([flagged], adj).verdict.outcome).toBe('invalid')
  })
})
