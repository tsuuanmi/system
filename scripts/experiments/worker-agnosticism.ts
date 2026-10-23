/**
 * The helper of the worker-agnosticism experiment (docs/validation/experiments/worker-agnosticism.md):
 * the trial schedule from the recorded seed, the freeze of the pre-registration, the export of a
 * trial's records through the `system` CLI, the collector, and the evaluation with its verdict.
 * Deterministic: the same records and trial files give the same output. A stopgap until PROP-0011's
 * evaluation engine and collectors exist (F4, F5): what it writes are plain JSON documents, to be
 * converted when F1's schemas land. It computes no statistic (F2 is pending): with fewer cases than
 * the protocol's minimum, no verdict but invalid, refuted, or inconclusive can follow anyway.
 *
 *   node --import tsx scripts/experiments/worker-agnosticism.ts <command> …
 *     schedule  <records>                               the trials, in the order they run
 *     freeze    <records> --repo <clone> --arms <dir>   pre-register: every hash filled, nothing missing
 *     export    <trials> <trialId> <runId>              a run's records, read with the system CLI
 *     collect   <records> <trials>                      each trial's measurements; the adjudication items
 *     evaluate  <records> <trials>                      the evaluation and its verdict
 *     calibrate <records> <seeding>                     the labels against the runs that seeded them
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contentId, sha256 } from '../../packages/libs/src/index.ts'

export const COLLECTOR_VERSION = '1'
export const FILES = {
  suite: 'review-suite.v1.json',
  contract: 'review-objective-contract.v1.json',
  hypothesis: 'review-worker-agnostic.hypothesis.json',
  experiment: 'review-worker-agnostic-1.experiment.json',
} as const

export type Arm = 'baseline' | 'candidate'
export const ARMS: readonly Arm[] = ['baseline', 'candidate']

/** A member step of the review team: its proposal, a ballot, or a debate turn (docs/design/teams.md). */
const MEMBER_STEP = /^review:(m\d+):(propose|ballot:\d+|debate:\d+)(:g\d+)?$/
/**
 * Failures that are the arm's own outcome: its Worker stalled, timed out, ran out of quota, was
 * overloaded, broke its session, or gave no answer acceptance took, escalation included. Any other
 * failure (a refused input, a configuration, egress, a restart) says nothing about the arm.
 */
const ARM_FAILURES = new Set(['provider_stalled', 'timeout', 'quota_exhausted', 'overloaded', 'session_broken', 'acceptance_rejected'])
const STALLS = new Set(['provider_stalled', 'timeout'])

export interface Label { id: string; kind: 'defect' | 'non-defect'; severity?: 'blocking' | 'warning'; summary: string; lines: number[]; test?: string }
export interface Case { caseId: string; commit: string; path: string; blob: string; focus: string[]; contamination: { invalid: string[]; flag: string[] }; labels: Label[] }
export interface Suite { suiteId: string; version: number; repository: string; request: string; partitions: Record<string, string[]>; labelling: { confirmedBy: unknown }; cases: Case[] }
export interface Seat { seat: string; source: string; workers: string[] | null; family: string | null; model: string | null; observed: string | null }
export interface ArmRecord { arm: Arm; subject: { type: string; ref: string; version: string | null }; configuration: string; seats: Seat[] }
export type Experiment = {
  experimentId: string
  state: string
  hypothesis: { id: string; ref: string | null }
  objectiveContract: { id: string; version: number; hash: string | null }
  baseline: ArmRecord
  candidate: ArmRecord
  suite: { id: string; version: number; partitions: { name: string; cases: number; hash: string | null }[]; used: string[] }
  environment: { system: { version: string | null; commit: string | null }; collector: { sha256: string | null }; hash: string | null } & Record<string, unknown>
  protocol: { minCases: number; repetitions: number } & Record<string, unknown>
  stopping: { trials: number } & Record<string, unknown>
  seed: string
  independence: { reviewers: Record<Arm, (string | null)[]> } & Record<string, unknown>
  identity: { version: string; hash: string | null }
  preregisteredAt?: string
} & Record<string, unknown>
export interface Records { suite: Suite; contract: Record<string, unknown>; hypothesis: Record<string, unknown> & { fingerprint: Record<string, unknown> }; experiment: Experiment }

/** A finding of a review team's vote decision (`vote.findings`, docs/design/teams.md#the-record). */
export interface Finding {
  id: string
  members?: string[]
  severity?: string
  kind?: string
  claim?: string
  evidence?: string
  quote?: { path?: string; line?: number; text?: string; matched?: number }
  class?: string
  reports?: { member: string; class?: string }[]
}
/** A decision as `system explain --json` lists it under a node. */
export interface Explained { id: string; type: string; outcome: string }
export interface Explanation { runId: string; specHash?: string; nodes: { nodeId: string; state: string; worker?: string; decisions: Explained[] }[] }
export interface EventLine { seq: number; at: string; type: string; nodeId?: string; data?: Record<string, unknown> }
/** What the operator records for a trial beside the exported records (`trial.json`). */
export interface TrialNote { trialId: string; runId: string; observed: Record<string, string> | null; workspaceClean: boolean | null; notes?: string }
/** A pool's totals as MCP `resources_usage` gives them for the trial's run (`usage.json`). */
export interface PoolTotal { pool: string; records: number; turns?: number; costUsd?: number; usage?: { inputTokens?: number; outputTokens?: number } }
export interface TrialFiles {
  note: TrialNote
  explain: Explanation
  events: EventLine[]
  decision?: { vote?: { findings?: Finding[]; repository?: { commit?: string } }; outcome?: { option?: string; detail?: { method?: string } } }
  source?: { outcome?: { detail?: { commit?: string; files?: { path: string; sha: string }[] } } }
  usage?: { totals?: PoolTotal[] }
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const write = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

export function loadRecords(dir: string): Records {
  return { suite: read(join(dir, FILES.suite)), contract: read(join(dir, FILES.contract)), hypothesis: read(join(dir, FILES.hypothesis)), experiment: read(join(dir, FILES.experiment)) }
}

/** The cases of the partitions the experiment uses, in the suite's order. */
export function casesOf(records: Records): Case[] {
  const ids = new Set(records.experiment.suite.used.flatMap((p) => records.suite.partitions[p] ?? []))
  return records.suite.cases.filter((c) => ids.has(c.caseId))
}

// --- schedule ---

export interface Trial { trialId: string; round: number; arm: Arm; caseId: string }

/**
 * The trials in the order they run: one round per repetition; in each round the two arms in the
 * order the seed gives, and within an arm's block its cases in the order the seed gives. One
 * configuration per block, since an arm's Workers are fixed by the operator's configuration.
 */
export function schedule(records: Records): Trial[] {
  const { seed, protocol, stopping } = records.experiment
  const rank = (key: string): string => sha256(`${seed}:${key}`)
  const by = (key: (v: string) => string) => (a: string, b: string): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
  const cases = casesOf(records).map((c) => c.caseId)
  const trials: Trial[] = []
  for (let round = 1; round <= protocol.repetitions; round += 1) {
    for (const arm of [...ARMS].sort(by((a) => rank(`round:${round}:arm:${a}`))) as Arm[]) {
      for (const caseId of [...cases].sort(by((c) => rank(`round:${round}:arm:${arm}:case:${c}`)))) {
        trials.push({ trialId: `r${round}-${arm}-${caseId}`, round, arm, caseId })
      }
    }
  }
  if (trials.length !== stopping.trials) throw new Error(`the protocol gives ${trials.length} trials, the stopping rule ${stopping.trials}: the record contradicts itself`)
  return trials
}

// --- freeze ---

/** The pins the operator fills before the freeze: each path that is still empty. */
export function missingPins(records: Records): string[] {
  const missing: string[] = []
  const empty = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  for (const arm of ARMS) {
    records.experiment[arm].seats.forEach((seat, i) => {
      for (const key of ['workers', 'family', 'model', 'observed'] as const) if (empty(seat[key])) missing.push(`${arm}.seats[${i}].${key}`)
    })
  }
  for (const key of ['version', 'commit'] as const) if (empty(records.experiment.environment.system[key])) missing.push(`environment.system.${key}`)
  const confirmed = records.suite.labelling.confirmedBy as { who?: unknown; at?: unknown } | null
  if (!confirmed || empty(confirmed.who) || empty(confirmed.at)) missing.push('suite labelling.confirmedBy (who, at)')
  return missing
}

/** What the experiment's identity is the hash of (PROP-0011 "two keys"): everything that defines the trial, nothing that records it. */
export function identityOf(e: Experiment): string {
  const { hypothesis, objectiveContract, comparison, baseline, candidate, suite, environment, protocol, stopping, seed } = e
  return contentId({ hypothesis, objectiveContract, comparison, baseline, candidate, suite, environment, protocol, stopping, seed })
}

/** The hashes a frozen experiment binds: recomputed by the freeze, and checked again before trials are collected or evaluated. */
export function bindings(records: Records): { fingerprint: string; hypothesis: string; contract: string; partitions: Record<string, string> } {
  const { version, target, mechanism, intervention, effect } = records.hypothesis.fingerprint
  const fingerprint = contentId({ version, target, mechanism, intervention, effect })
  const hypothesis = contentId({ ...records.hypothesis, fingerprint: { ...records.hypothesis.fingerprint, hash: fingerprint } })
  const partitions = Object.fromEntries(records.experiment.suite.partitions.map((p) => {
    const ids = new Set(records.suite.partitions[p.name] ?? [])
    return [p.name, contentId({ suite: records.suite.suiteId, version: records.suite.version, request: records.suite.request, cases: records.suite.cases.filter((c) => ids.has(c.caseId)) })]
  }))
  return { fingerprint, hypothesis, contract: contentId(records.contract), partitions }
}

/**
 * Pre-register: refuse while a pin is missing, a label's file is not the blob at its commit, or an
 * arm's configuration file is absent; else fill every hash, set the reviewers' families from the
 * seats, and move the experiment to `preregistered`. Nothing in it may change afterwards.
 */
export function freeze(records: Records, input: { blobAt: (commit: string, path: string) => string; armFile: (name: string) => Buffer; collector: Buffer; at: Date }): Records {
  const e = records.experiment
  if (e.state !== 'proposed') throw new Error(`experiment ${e.experimentId} is ${e.state}, not proposed: a frozen experiment is never frozen again (a change is a new revision)`)
  const problems = missingPins(records).map((p) => `missing ${p}`)
  for (const c of casesOf(records)) {
    const blob = input.blobAt(c.commit, c.path)
    if (blob !== c.blob) problems.push(`case ${c.caseId}: ${c.path} at ${c.commit} is blob ${blob}, the labels are for ${c.blob}`)
  }
  if (problems.length) throw new Error(`not frozen:\n${problems.join('\n')}`)
  const b = bindings(records)
  const hypothesis = { ...records.hypothesis, fingerprint: { ...records.hypothesis.fingerprint, hash: b.fingerprint } }
  const frozen: Experiment = {
    ...e,
    hypothesis: { ...e.hypothesis, ref: b.hypothesis },
    objectiveContract: { ...e.objectiveContract, hash: b.contract },
    suite: { ...e.suite, partitions: e.suite.partitions.map((p) => ({ ...p, hash: b.partitions[p.name] ?? null })) },
    baseline: { ...e.baseline, subject: { ...e.baseline.subject, version: sha256(input.armFile(e.baseline.configuration)) } },
    candidate: { ...e.candidate, subject: { ...e.candidate.subject, version: sha256(input.armFile(e.candidate.configuration)) } },
    independence: { ...e.independence, reviewers: { baseline: e.baseline.seats.map((s) => s.family), candidate: e.candidate.seats.map((s) => s.family) } },
  }
  const environment = { ...frozen.environment, collector: { ...frozen.environment.collector, sha256: sha256(input.collector) }, hash: null }
  frozen.environment = { ...environment, hash: contentId({ ...environment, hash: undefined }) }
  frozen.identity = { ...frozen.identity, hash: identityOf(frozen) }
  frozen.state = 'preregistered'
  frozen.preregisteredAt = input.at.toISOString()
  return { ...records, hypothesis, experiment: frozen }
}

/** Why the records no longer bind what was frozen (edited since, or never frozen); empty when they do. */
export function unbound(records: Records, collector: Buffer): string[] {
  const e = records.experiment
  if (e.state !== 'preregistered' || !e.identity.hash) return [`experiment ${e.experimentId} is ${e.state}: freeze it before any trial is collected`]
  const b = bindings(records)
  const problems: string[] = []
  if (records.hypothesis.fingerprint.hash !== b.fingerprint || e.hypothesis.ref !== b.hypothesis) problems.push('the hypothesis changed since the freeze')
  if (e.objectiveContract.hash !== b.contract) problems.push('the objective contract changed since the freeze')
  for (const p of e.suite.partitions) if (p.hash !== b.partitions[p.name]) problems.push(`the suite's ${p.name} partition changed since the freeze`)
  if (e.environment.collector.sha256 !== sha256(collector)) problems.push('this collector is not the one the experiment pinned')
  if (e.environment.hash !== contentId({ ...e.environment, hash: undefined })) problems.push('the environment changed since the freeze')
  if (e.identity.hash !== identityOf(e)) problems.push('the experiment changed since the freeze')
  return problems
}

// --- matching ---

export type MatchOutcome = 'identified' | 'pick' | 'non-defect' | 'unmatched' | 'suggestion'
export interface Match { finding: string; outcome: MatchOutcome; labels: string[] }

/** Where a finding lands in a case's labels, by the suite's matching rule (version 1). */
export function match(c: Case, f: Finding): Match {
  if (f.kind === 'suggestion') return { finding: f.id, outcome: 'suggestion', labels: [] }
  const line = f.class === 'confirmed' && f.quote?.path === c.path ? f.quote.matched ?? f.quote.line : undefined
  if (line === undefined) return { finding: f.id, outcome: 'unmatched', labels: [] }
  const defects = c.labels.filter((l) => l.kind === 'defect' && l.lines.includes(line)).map((l) => l.id)
  if (defects.length) return { finding: f.id, outcome: defects.length === 1 ? 'identified' : 'pick', labels: defects }
  const known = c.labels.filter((l) => l.kind === 'non-defect' && l.lines.includes(line)).map((l) => l.id)
  return known.length ? { finding: f.id, outcome: 'non-defect', labels: known } : { finding: f.id, outcome: 'unmatched', labels: [] }
}

// --- collect ---

export interface Measurement {
  trialId: string
  round: number
  arm: Arm
  caseId: string
  runId: string
  collector: string
  integrity: string[]
  hardConstraints: string[]
  flags: { text: string; finding: string }[]
  outcome: string
  members: { member: string; worker: string | null; seat: string | null }[]
  defectFindings: number
  confirmed: number
  matches: Match[]
  perMember: { member: string; reports: number; confirmed: number; identified: string[] }[]
  steps: number
  stalls: number
  latencyMinutes: number | null
  /** The resource ledger's totals per pool for the run: what each Worker source recorded, none for a source that records nothing. */
  usage: PoolTotal[] | null
}

/** Every text a finding carries, for the contamination check. */
const textOf = (f: Finding): string => [f.claim, f.evidence, f.quote?.text].filter((t): t is string => typeof t === 'string').join('\n')

/** The collector: one trial's measurements and integrity, from its exported records and the operator's note. */
export function measure(records: Records, trial: Trial, files: TrialFiles): Measurement {
  const c = casesOf(records).find((k) => k.caseId === trial.caseId)!
  const arm = records.experiment[trial.arm]
  const integrity: string[] = []
  const hardConstraints: string[] = []
  const { note, explain, events } = files
  if (note.runId !== explain.runId) integrity.push(`the trial names run ${note.runId}, its records run ${explain.runId}`)

  // Drift: each seat's observed model and version, as the operator recorded it before the block.
  for (const seat of arm.seats) {
    const seen = note.observed?.[seat.seat]
    if (seen === undefined) integrity.push(`no observed version recorded for seat ${seat.seat}`)
    else if (seen !== seat.observed) integrity.push(`seat ${seat.seat} showed ${seen}, the experiment pinned ${seat.observed}`)
  }
  // The read-only members' workspaces: a hard constraint, checked by the operator.
  if (note.workspaceClean === null || note.workspaceClean === undefined) integrity.push('the operator\'s check of the members\' workspaces is not recorded')
  else if (!note.workspaceClean) hardConstraints.push('an agent member\'s workspace changed during the trial')

  // Arm routing: every member step on a Worker of the arm, one seat per member, no same-family admission.
  const seatOf = (worker: string | undefined): Seat | undefined => arm.seats.find((s) => worker !== undefined && (s.workers ?? []).includes(worker))
  const steps = explain.nodes.filter((n) => MEMBER_STEP.test(n.nodeId))
  for (const n of steps) {
    if (n.worker && !seatOf(n.worker)) integrity.push(`${n.nodeId} ran on ${n.worker}, outside the ${trial.arm} arm`)
    if (n.decisions.some((d) => d.outcome === 'same-family' || d.outcome === 'same-family-shared-account')) integrity.push(`${n.nodeId} was admitted on the same provider family`)
    if (n.worker && !n.decisions.some((d) => d.type === 'egress')) integrity.push(`${n.nodeId} has no egress decision`)
  }
  const proposals = steps.filter((n) => n.nodeId.endsWith(':propose'))
  const members = proposals.map((n) => ({ member: MEMBER_STEP.exec(n.nodeId)![1]!, worker: n.worker ?? null, seat: seatOf(n.worker)?.seat ?? null }))
  if (members.every((m) => m.seat) && new Set(members.map((m) => m.seat)).size !== members.length) integrity.push('two members sat in one seat')

  // The subject: the case's commit, and its file as the blob the labels are for.
  const detail = files.source?.outcome?.detail
  if (!detail) integrity.push('the source step\'s decision is missing')
  else {
    if (detail.commit !== c.commit) integrity.push(`the source was read at ${detail.commit}, the case is ${c.commit}`)
    if (!(detail.files ?? []).some((f) => f.path === c.path && f.sha === c.blob)) integrity.push(`${c.path} was not shown as blob ${c.blob}`)
  }

  // How the run ended: the team's decision, or a failure that is the arm's own.
  const failed = events.filter((ev) => ev.type === 'workflow.node.failed')
  const foreign = failed.filter((ev) => !ARM_FAILURES.has(String(ev.data?.kind)) || !MEMBER_STEP.test(ev.nodeId ?? ''))
  for (const ev of foreign) integrity.push(`${ev.nodeId ?? 'a node'} failed as ${String(ev.data?.kind)}, which is not an outcome of the arm`)
  const decided = files.decision?.outcome?.detail?.method
  const outcome = decided ?? (failed.length ? `failed: ${[...new Set(failed.map((ev) => String(ev.data?.kind)))].join(', ')}` : 'unfinished')
  if (outcome === 'unfinished') integrity.push('the run reached no decision and recorded no failure')

  const findings = files.decision?.vote?.findings ?? []
  const flags: { text: string; finding: string }[] = []
  for (const f of findings) {
    const text = textOf(f)
    for (const s of c.contamination.invalid) if (text.includes(s)) integrity.push(`finding ${f.id} names ${s}, the fix`)
    for (const s of c.contamination.flag) if (text.includes(s)) flags.push({ text: s, finding: f.id })
  }
  if (files.decision?.vote?.repository?.commit !== undefined && files.decision.vote.repository.commit !== c.commit) integrity.push('the team reviewed another commit')

  const matches = findings.map((f) => match(c, f))
  const defects = findings.filter((f) => f.kind !== 'suggestion')
  const perMember = members.map(({ member }) => {
    const reports = defects.flatMap((f) => (f.reports ?? []).filter((r) => r.member === member).map((r) => ({ f, r })))
    const identified = reports.filter(({ r }) => r.class === 'confirmed').flatMap(({ f }) => {
      const m = matches.find((x) => x.finding === f.id)!
      return m.outcome === 'identified' ? m.labels : []
    })
    return { member, reports: reports.length, confirmed: reports.filter(({ r }) => r.class === 'confirmed').length, identified: [...new Set(identified)].sort() }
  })

  const started = events.find((ev) => ev.type === 'workflow.run.started')
  const ended = events.find((ev) => ev.type === 'workflow.node.completed' && ev.nodeId === 'review') ?? (decided ? undefined : events.at(-1))
  const latencyMinutes = started && ended ? Math.round((Date.parse(ended.at) - Date.parse(started.at)) / 600) / 100 : null
  if (latencyMinutes === null) integrity.push('the run\'s start or end is not in its events')
  if (!files.usage) integrity.push('the ledger\'s usage of the run is not exported (usage.json)')
  return {
    trialId: trial.trialId, round: trial.round, arm: trial.arm, caseId: trial.caseId, runId: note.runId, collector: COLLECTOR_VERSION,
    integrity, hardConstraints, flags, outcome, members,
    defectFindings: defects.length, confirmed: defects.filter((f) => f.class === 'confirmed').length,
    matches, perMember,
    steps: events.filter((ev) => ev.type === 'workflow.node.started' && MEMBER_STEP.test(ev.nodeId ?? '')).length,
    // A stall the engine retried counts as much as one that failed the step.
    stalls: events.filter((ev) => (ev.type === 'workflow.node.retry' || ev.type === 'workflow.node.failed') && STALLS.has(String(ev.data?.kind)) && MEMBER_STEP.test(ev.nodeId ?? '')).length,
    latencyMinutes,
    usage: files.usage ? files.usage.totals ?? [] : null,
  }
}

export type Verdict = string | null
export interface AdjudicationItem { key: string; trialId: string; finding: string; kind: 'pick' | 'unmatched'; options: string[]; claim: string; quote: Finding['quote'] | null; verdict: Verdict; by: string | null; family: string | null; minutes: number | null }
export interface ContaminationFlag { key: string; trialId: string; finding: string; text: string; verdict: 'cites-fix' | 'does-not' | null; by: string | null }
export interface Adjudication { items: AdjudicationItem[]; flags: ContaminationFlag[] }

/** The adjudication items of the measured trials, keeping every verdict already given. */
export function adjudication(measurements: Measurement[], findingsOf: (trialId: string) => Finding[], previous?: Adjudication): Adjudication {
  const kept = new Map((previous?.items ?? []).map((i) => [i.key, i]))
  const keptFlags = new Map((previous?.flags ?? []).map((f) => [f.key, f]))
  const items: AdjudicationItem[] = []
  const flags: ContaminationFlag[] = []
  for (const m of measurements) {
    const findings = findingsOf(m.trialId)
    for (const x of m.matches.filter((x) => x.outcome === 'pick' || x.outcome === 'unmatched')) {
      const f = findings.find((y) => y.id === x.finding)!
      const key = `${m.trialId}/${x.finding}`
      const options = [...x.labels, 'not-a-defect', 'defect-unlabelled', 'unsure']
      const before = kept.get(key)
      items.push({
        key, trialId: m.trialId, finding: x.finding, kind: x.outcome as 'pick' | 'unmatched', options, claim: f.claim ?? '', quote: f.quote ?? null,
        verdict: before?.verdict ?? null, by: before?.by ?? null, family: before?.family ?? null, minutes: before?.minutes ?? null,
      })
    }
    for (const fl of m.flags) {
      const key = `${m.trialId}/${fl.finding}/${fl.text}`
      const before = keptFlags.get(key)
      flags.push({ key, trialId: m.trialId, finding: fl.finding, text: fl.text, verdict: before?.verdict ?? null, by: before?.by ?? null })
    }
  }
  return { items, flags }
}

// --- evaluate ---

interface Bound { min: number; max: number }
export interface ArmSummary {
  trials: number
  steps: number
  defectsPerCost: Bound | null
  blockingRecall: Bound | null
  falsePositivesPerTrial: Bound | null
  quoteValidity: number | null
  latencyMedianMinutes: number | null
  stallsPerTrial: number | null
  identifiedBySeat: Record<string, Record<string, number>>
  /** Summed per pool, in the ledger's own units; a pool no trial recorded is absent. */
  usage: Record<string, { records: number; turns: number; costUsd: number; inputTokens: number; outputTokens: number }>
}
export interface Evaluation {
  record: 'evaluation'
  experiment: { id: string; identity: string | null }
  collector: string
  trials: (Measurement & { resolved: { identified: Bound & { labels: string[] }; blocking: Bound & { present: number }; falsePositives: Bound; novel: number } })[]
  missing: string[]
  arms: Record<Arm, ArmSummary>
  paired: { caseId: string; metric: string; baseline: number | null; candidate: number | null; difference: number | null }[]
  analysis: string
  adjudication: { items: number; pending: number; minutes: number; by: string[] }
  integrity: { trial: string; problems: string[] }[]
}
export interface VerdictRecord { record: 'verdict'; decisionType: 'verdict'; experiment: string; identity: string | null; evaluation: string; candidates: { option: string; selected: boolean; reasons: string[] }[]; decider: { type: 'rule'; id: string; version: string }; outcome: string }

const median = (values: number[]): number | null => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null)
const bound = (min: number, max: number, of: number): Bound | null => (of > 0 ? { min: ratio(min, of)!, max: ratio(max, of)! } : null)

/** Resolve a trial's matches with the adjudication: identified labels and false positives, as bounds while items are pending. */
function resolve(c: Case, m: Measurement, items: Map<string, AdjudicationItem>): Evaluation['trials'][number]['resolved'] {
  const ids = new Set(m.matches.filter((x) => x.outcome === 'identified').flatMap((x) => x.labels))
  let falsePositives = m.matches.filter((x) => x.outcome === 'non-defect').length
  // Unsure or not yet adjudicated: a false positive at most, or one of its candidate labels at most.
  let open = 0
  let novel = 0
  const candidates = new Set<string>()
  for (const x of m.matches.filter((y) => y.outcome === 'pick' || y.outcome === 'unmatched')) {
    const verdict = items.get(`${m.trialId}/${x.finding}`)?.verdict ?? null
    if (verdict !== null && x.labels.includes(verdict)) ids.add(verdict)
    else if (verdict === 'not-a-defect') falsePositives += 1
    else if (verdict === 'defect-unlabelled') novel += 1
    else if (verdict === 'unsure' || verdict === null) {
      open += 1
      for (const l of x.labels) candidates.add(l)
    } else throw new Error(`adjudication ${m.trialId}/${x.finding}: ${verdict} is not one of its options`)
  }
  const extra = [...candidates].filter((l) => !ids.has(l)).length
  const blocking = c.labels.filter((l) => l.kind === 'defect' && l.severity === 'blocking').map((l) => l.id)
  const blockingExtra = [...candidates].filter((l) => !ids.has(l) && blocking.includes(l)).length
  return {
    identified: { min: ids.size, max: ids.size + extra, labels: [...ids].sort() },
    blocking: { min: blocking.filter((l) => ids.has(l)).length, max: blocking.filter((l) => ids.has(l)).length + blockingExtra, present: blocking.length },
    falsePositives: { min: falsePositives, max: falsePositives + open },
    novel,
  }
}

/** The evaluation of every collected trial, and its verdict by the pre-registered rule (descriptive only: F2 pending). */
export function evaluate(records: Records, measurements: Measurement[], adj: Adjudication): { evaluation: Evaluation; verdict: VerdictRecord } {
  const open = adj.flags.filter((f) => f.verdict === null)
  if (open.length) throw new Error(`contamination flags without a verdict: ${open.map((f) => f.key).join(', ')}; the operator records cites-fix or does-not for each`)
  const cases = new Map(casesOf(records).map((c) => [c.caseId, c]))
  const items = new Map(adj.items.map((i) => [i.key, i]))
  const planned = schedule(records)
  const byId = new Map(measurements.map((m) => [m.trialId, m]))
  const missing = planned.filter((t) => !byId.has(t.trialId)).map((t) => t.trialId)
  const trials = planned.filter((t) => byId.has(t.trialId)).map((t) => {
    const m = byId.get(t.trialId)!
    const cited = adj.flags.filter((f) => f.trialId === m.trialId && f.verdict === 'cites-fix').map((f) => `finding ${f.finding} cites the fix (${f.text}), as the operator judged`)
    return { ...m, integrity: [...m.integrity, ...cited], resolved: resolve(cases.get(m.caseId)!, m, items) }
  })
  const valid = trials.filter((t) => !t.integrity.length)
  const summary = (arm: Arm): ArmSummary => {
    const ts = valid.filter((t) => t.arm === arm)
    const sum = (f: (t: (typeof ts)[number]) => number): number => ts.reduce((a, t) => a + f(t), 0)
    const steps = sum((t) => t.steps)
    const identifiedBySeat: Record<string, Record<string, number>> = {}
    for (const t of ts) {
      for (const p of t.perMember) {
        const seat = t.members.find((x) => x.member === p.member)?.seat ?? 'unknown'
        identifiedBySeat[seat] ??= {}
        for (const l of p.identified) identifiedBySeat[seat][l] = (identifiedBySeat[seat][l] ?? 0) + 1
      }
    }
    const latencies = ts.map((t) => t.latencyMinutes).filter((v): v is number => v !== null)
    const usage: ArmSummary['usage'] = {}
    for (const p of ts.flatMap((t) => t.usage ?? [])) {
      const u = (usage[p.pool] ??= { records: 0, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 })
      u.records += p.records
      u.turns += p.turns ?? 0
      u.costUsd = Math.round((u.costUsd + (p.costUsd ?? 0)) * 1_000_000) / 1_000_000
      u.inputTokens += p.usage?.inputTokens ?? 0
      u.outputTokens += p.usage?.outputTokens ?? 0
    }
    return {
      trials: ts.length,
      steps,
      defectsPerCost: bound(sum((t) => t.resolved.identified.min), sum((t) => t.resolved.identified.max), steps),
      blockingRecall: bound(sum((t) => t.resolved.blocking.min), sum((t) => t.resolved.blocking.max), sum((t) => t.resolved.blocking.present)),
      falsePositivesPerTrial: bound(sum((t) => t.resolved.falsePositives.min), sum((t) => t.resolved.falsePositives.max), ts.length),
      quoteValidity: ratio(sum((t) => t.confirmed), sum((t) => t.defectFindings)),
      latencyMedianMinutes: median(latencies),
      stallsPerTrial: ratio(sum((t) => t.stalls), ts.length),
      identifiedBySeat,
      usage,
    }
  }
  const arms = { baseline: summary('baseline'), candidate: summary('candidate') }
  const mean = (values: number[]): number | null => (values.length ? Math.round((values.reduce((a, v) => a + v, 0) / values.length) * 10000) / 10000 : null)
  const metrics: [string, (t: (typeof valid)[number]) => number | null][] = [
    ['identified (min)', (t) => t.resolved.identified.min],
    ['blocking identified (min)', (t) => t.resolved.blocking.min],
    ['false positives (min)', (t) => t.resolved.falsePositives.min],
    ['latency minutes', (t) => t.latencyMinutes],
    ['stalls', (t) => t.stalls],
  ]
  const paired = [...cases.keys()].flatMap((caseId) => metrics.map(([metric, f]) => {
    const of = (arm: Arm): number | null => mean(valid.filter((t) => t.caseId === caseId && t.arm === arm).map(f).filter((v): v is number => v !== null))
    const [b, c] = [of('baseline'), of('candidate')]
    return { caseId, metric, baseline: b, candidate: c, difference: b !== null && c !== null ? Math.round((c - b) * 10000) / 10000 : null }
  }))
  const integrity = trials.filter((t) => t.integrity.length).map((t) => ({ trial: t.trialId, problems: t.integrity }))
  const evaluation: Evaluation = {
    record: 'evaluation',
    experiment: { id: records.experiment.experimentId, identity: records.experiment.identity.hash },
    collector: COLLECTOR_VERSION,
    trials, missing, arms, paired,
    analysis: 'descriptive: point estimates per arm (ratios of sums over trials, bounds while adjudication is pending) and per-case paired differences; no interval or test is computed (F2 pending)',
    adjudication: {
      items: adj.items.length,
      pending: adj.items.filter((i) => i.verdict === null).length,
      minutes: adj.items.reduce((a, i) => a + (i.minutes ?? 0), 0),
      by: [...new Set(adj.items.map((i) => (i.by ? `${i.by} (${i.family ?? 'family not recorded'})` : undefined)).filter((v): v is string => !!v))].sort(),
    },
    integrity,
  }
  // The verdict rule (PROP-0011): invalid, then refuted, then supported, else inconclusive.
  const reasons = {
    invalid: integrity.map((i) => `${i.trial}: ${i.problems.join('; ')}`),
    refuted: valid.flatMap((t) => t.hardConstraints.map((h) => `${t.trialId}: ${h}`)),
    inconclusive: [
      ...(cases.size < records.experiment.protocol.minCases ? [`${cases.size} case(s), fewer than the protocol's ${records.experiment.protocol.minCases}: no metric can support or refute`] : []),
      ...(missing.length ? [`the horizon is not reached: ${missing.length} trial(s) not run`] : []),
      'no statistic is computed until the statistics library is chosen (F2)',
    ],
  }
  const outcome = reasons.invalid.length ? 'invalid' : reasons.refuted.length ? 'refuted' : 'inconclusive'
  const verdict: VerdictRecord = {
    record: 'verdict', decisionType: 'verdict', experiment: records.experiment.experimentId, identity: records.experiment.identity.hash, evaluation: contentId(evaluation),
    candidates: [
      { option: 'invalid', selected: outcome === 'invalid', reasons: reasons.invalid.length ? reasons.invalid : ['every integrity check held'] },
      { option: 'refuted', selected: outcome === 'refuted', reasons: reasons.refuted.length ? reasons.refuted : ['no hard constraint broke; no metric is tested (F2 pending)'] },
      { option: 'supported', selected: false, reasons: ['not reachable here: no interval clears the declared comparison without a statistic (F2 pending) and the protocol\'s minimum cases'] },
      { option: 'inconclusive', selected: outcome === 'inconclusive', reasons: reasons.inconclusive },
    ],
    decider: { type: 'rule', id: 'evaluations.verdict', version: `script-${COLLECTOR_VERSION}` },
    outcome,
  }
  return { evaluation, verdict }
}

// --- calibrate ---

/** Each label of a case against the findings of the run that seeded it: who identified it, or why none did. */
export function calibrate(c: Case, findings: Finding[]): { label: string; by: string[]; candidateOf: string[] }[] {
  const matches = findings.map((f) => match(c, f))
  return c.labels.map((l) => ({
    label: l.id,
    by: matches.filter((m) => (m.outcome === 'identified' || m.outcome === 'non-defect') && m.labels.includes(l.id)).map((m) => m.finding),
    candidateOf: matches.filter((m) => m.outcome === 'pick' && m.labels.includes(l.id)).map((m) => m.finding),
  }))
}

// --- files and the system CLI ---

/** Run the operator's `system` CLI (operator scope); its JSON output. */
function system(args: string[]): unknown {
  return JSON.parse(execFileSync('system', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
}

/** A whole artifact body, read window by window. */
function artifactBody(id: string): unknown {
  let text = ''
  for (let offset = 0; ;) {
    const window = system(['artifact', '--json', '--max', '200000', '--offset', String(offset), id]) as { state: string; content?: string; text?: string; truncated?: boolean; chars?: number }
    if (window.state !== 'stored' || window.content !== 'json' || typeof window.text !== 'string') throw new Error(`artifact ${id} is ${window.state}${window.content ? `, ${window.content}` : ''}: not a stored JSON body`)
    text += window.text
    if (!window.truncated) return JSON.parse(text)
    offset = [...text].length
  }
}

/** Export one run's records into `<trials>/<trialId>/`: explain, the team's vote decision, the source decision, the events. */
export function exportTrial(trials: string, trialId: string, runId: string): string {
  const dir = join(trials, trialId)
  mkdirSync(dir, { recursive: true })
  const explain = system(['explain', '--json', runId]) as Explanation
  const decisionOf = (nodeId: string, type: string): string | undefined => explain.nodes.find((n) => n.nodeId === nodeId)?.decisions.filter((d) => d.type === type).at(-1)?.id
  const vote = decisionOf('review', 'vote')
  const source = decisionOf('source', 'acceptance')
  const events: EventLine[] = []
  for (let after = 0; ;) {
    const page = system(['events', '--json', '--run', runId, '--limit', '1000', '--after', String(after)]) as { events: EventLine[]; next: number }
    if (!page.events.length) break
    events.push(...page.events)
    after = page.next
  }
  write(join(dir, 'explain.json'), explain)
  write(join(dir, 'events.json'), events)
  if (vote) write(join(dir, 'decision.json'), artifactBody(vote))
  if (source) write(join(dir, 'source.json'), artifactBody(source))
  const note = join(dir, 'trial.json')
  if (!existsSync(note)) write(note, { trialId, runId, observed: null, workspaceClean: null, notes: '' } satisfies TrialNote)
  return dir
}

/** A trial's files: the decisions are absent when the run failed before them; `usage.json` is the operator's MCP `resources_usage` output for the run. */
export function readTrial(dir: string): TrialFiles {
  const files: TrialFiles = { note: read(join(dir, 'trial.json')), explain: read(join(dir, 'explain.json')), events: read(join(dir, 'events.json')) }
  if (existsSync(join(dir, 'decision.json'))) files.decision = read(join(dir, 'decision.json'))
  if (existsSync(join(dir, 'source.json'))) files.source = read(join(dir, 'source.json'))
  if (existsSync(join(dir, 'usage.json'))) files.usage = read(join(dir, 'usage.json'))
  return files
}

function main(argv: string[]): number {
  const [command, ...args] = argv
  const flag = (name: string): string => {
    const at = args.indexOf(name)
    if (at < 0 || !args[at + 1]) throw new Error(`${command} needs ${name} <value>`)
    return args[at + 1]!
  }
  const self = readFileSync(fileURLToPath(import.meta.url))
  switch (command) {
    case 'schedule': {
      console.log(JSON.stringify(schedule(loadRecords(args[0]!)), null, 2))
      return 0
    }
    case 'freeze': {
      const dir = args[0]!
      const repo = flag('--repo')
      const arms = flag('--arms')
      const frozen = freeze(loadRecords(dir), {
        blobAt: (commit, path) => execFileSync('git', ['-C', repo, 'rev-parse', `${commit}:${path}`], { encoding: 'utf8' }).trim(),
        armFile: (name) => readFileSync(join(arms, name)),
        collector: self,
        at: new Date(),
      })
      write(join(dir, FILES.hypothesis), frozen.hypothesis)
      write(join(dir, FILES.experiment), frozen.experiment)
      console.log(`frozen: ${frozen.experiment.experimentId}, identity ${frozen.experiment.identity.hash}`)
      return 0
    }
    case 'export': {
      const [trials, trialId, runId] = args
      if (!trials || !trialId || !runId) throw new Error('export <trials> <trialId> <runId>')
      console.log(`exported ${exportTrial(trials, trialId, runId)}; record observed and workspaceClean in its trial.json`)
      return 0
    }
    case 'collect': {
      const [dir, trials] = args as [string, string]
      const records = loadRecords(dir)
      const problems = unbound(records, self)
      if (problems.length) throw new Error(`not collected:\n${problems.join('\n')}`)
      const present = schedule(records).filter((t) => existsSync(join(trials, t.trialId, 'trial.json')))
      const measurements = present.map((t) => measure(records, t, readTrial(join(trials, t.trialId))))
      for (const m of measurements) write(join(trials, m.trialId, 'measurement.json'), m)
      const file = join(trials, 'adjudication.json')
      const adj = adjudication(measurements, (id) => readTrial(join(trials, id)).decision?.vote?.findings ?? [], existsSync(file) ? read<Adjudication>(file) : undefined)
      write(file, adj)
      console.log(`collected ${measurements.length} trial(s); ${adj.items.filter((i) => i.verdict === null).length} adjudication item(s) and ${adj.flags.filter((f) => f.verdict === null).length} contamination flag(s) wait in ${file}`)
      return 0
    }
    case 'evaluate': {
      const [dir, trials] = args as [string, string]
      const records = loadRecords(dir)
      const problems = unbound(records, self)
      if (problems.length) throw new Error(`not evaluated:\n${problems.join('\n')}`)
      const measurements = readdirSync(trials).filter((d) => existsSync(join(trials, d, 'measurement.json'))).map((d) => read<Measurement>(join(trials, d, 'measurement.json')))
      const { evaluation, verdict } = evaluate(records, measurements, read(join(trials, 'adjudication.json')))
      write(join(trials, 'evaluation.json'), evaluation)
      write(join(trials, 'verdict.json'), verdict)
      console.log(`verdict: ${verdict.outcome}\n${verdict.candidates.find((c) => c.selected)!.reasons.join('\n')}`)
      return 0
    }
    case 'calibrate': {
      const [dir, seeding] = args as [string, string]
      let unfound = 0
      for (const c of casesOf(loadRecords(dir))) {
        if (!existsSync(join(seeding, c.caseId, 'decision.json'))) throw new Error(`no seeding run exported for ${c.caseId}: export it into ${join(seeding, c.caseId)}`)
        const findings = readTrial(join(seeding, c.caseId)).decision?.vote?.findings ?? []
        for (const row of calibrate(c, findings)) {
          const found = row.by.length ? `identified by ${row.by.join(', ')}` : row.candidateOf.length ? `a candidate of ${row.candidateOf.join(', ')} (shared lines)` : 'NOT FOUND'
          if (!row.by.length && !row.candidateOf.length) unfound += 1
          console.log(`${c.caseId} ${row.label}: ${found}`)
        }
        for (const m of findings.map((f) => match(c, f)).filter((x) => x.outcome === 'unmatched')) console.log(`${c.caseId} ${m.finding}: on no label's lines`)
      }
      return unfound ? 1 : 0
    }
    default:
      console.error('usage: worker-agnosticism.ts schedule|freeze|export|collect|evaluate|calibrate … (see the file\'s header)')
      return 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
