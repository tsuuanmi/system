/**
 * The reviewer eval (docs/validation/experiments/reviewer-eval.md; T268, D93, after Anthropic's
 * "Solving code review": past changes that let a defect escape, each a commit pair (the defective
 * change and its fix) with the important finding a review of it must make, and clean changes that
 * must get none, are the set the reviewer runs on every change to the review template, its prompts,
 * or the reviewer's tier or model). The report is recall (escapes whose expected finding was made at
 * an important severity) and the false-important rate (clean changes that got an important finding).
 *
 * The reviewer is System's own: each case runs as the board's `review:1` does, on the same routing
 * (template `agent-review`: capabilities `review` and `local-data`, tier standard, the same reviewer
 * Workers and models), given the board reviewer's own instructions (`REVIEW_PROMPT`), the engine's
 * subject block with the case's diff (`subjectBlock`), and read with the engine's own parser
 * (`parseAssessment`). What it reviews is a change that introduces the defect: a commit against its
 * parent, the fix reverted against the fixed tree, or a recorded patch, each narrowed to the paths
 * the defect is in.
 *
 * The gate (`pnpm check`, `check:reviewer-eval`): the reviewer's fingerprint (its instructions, its
 * subject block, its parser, its steps' capabilities, tier, and conversation, and the set) must be the
 * one the last recorded run measured; a change to any of them fails the check until the eval is run
 * on it and recorded (`run --record`), no worse than the run before.
 *
 *   node --import tsx scripts/experiments/reviewer-eval.ts <command> …
 *     check                                          the set is well formed
 *     gate                                           the reviewer is the one the recorded run measured (exit 1 otherwise)
 *     resolve --repo <clone>                         each case's change as a diff, or why not
 *     input <caseId> --repo <clone>                  the review input of a case, as the reviewer is given it
 *     run --repo <clone> [--out <dir>] [--minutes <n>] [--execution <id>] [--min-recall <r>] [--max-false-important <r>] [--record]
 *                                                    System's reviewer on each case (MCP run agent-review at the board
 *                                                    reviewer's tier, then result), in a fresh execution (each case's run
 *                                                    key is its own; --execution resumes one); the report; --record writes
 *                                                    the gate's record when every case ran, no worse than the last record
 *     score <dir> [--min-recall <r>] [--max-false-important <r>]
 *                                                    the report from findings already written (<caseId>.json in <dir>)
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AGENT_REVIEW, ALGORITHM_DEVELOPMENT, REVIEW_PROMPT } from '../../packages/plugins/profile-software-development/src/index.ts'
import { parseAssessment, SEVERITIES, subjectBlock } from '../../packages/plugins/workflow/src/spec.ts'

export const RUNNER_VERSION = '4'
export const RECORDS = fileURLToPath(new URL('../../docs/validation/experiments/records', import.meta.url))
export const SET_FILE = 'reviewer-eval-set.v1.json'
export const GATE_FILE = 'reviewer-eval-gate.json'
/** The template the reviewer runs in: the board's `review:1` alone, on the same capabilities, tier, and Workers. */
export const REVIEW_TEMPLATE = 'agent-review'
/** The `run` tool's input bound (packages/plugins/workflow/src/tools.ts): a longer review input is not run. */
export const INPUT_MAX = 32_000

/**
 * What a case reviews, a change that introduces the defect, pinned (never a search):
 * - `rev`: a commit against its parent (the defective change itself, on its run branch when it never landed);
 * - `revertOf`: a fix reverted against the fixed tree, when the defect was a state of the code no
 *   single commit introduced (a sound baseline, and the change that takes the fix away);
 * - `patch`: a file of the records directory holding the change as a diff, when no commit ever held it.
 * `paths` narrows a git change to the files the defect is in (the change's other files are not the case).
 */
export type Change = { rev: string; paths?: string[] } | { revertOf: string; paths: string[] } | { patch: string }
export interface EvalCase {
  caseId: string
  kind: 'escape' | 'clean'
  task: string
  title: string
  /** What the change was asked to do, as its task said it: the reviewer is given this, never the defect. */
  request: string
  change: Change
  /** An escape's fix: the commit that fixed it. */
  fix: { rev: string } | null
  /** Where the change comes from, in words (a run's branch, a rebuilt fixture). */
  provenance?: string
  /** An escape's expected finding: a regular expression over its file's path, and one over its claim and evidence. */
  expected: { path: string; claim: string } | null
}
export interface EvalSet { setId: string; version: number; repository: string; important: string[]; cases: EvalCase[] }

/** A finding of a review, as far as the eval reads it. */
export interface Finding { severity: string; path?: string; claim: string; evidence?: string }

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const HEX = /^[0-9a-f]{7,40}$/
const sha = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

export function loadSet(dir = RECORDS): EvalSet { return read(join(dir, SET_FILE)) }

const regexProblem = (where: string, pattern: string): string[] => {
  try {
    new RegExp(pattern, 'i')
    return []
  } catch {
    return [`${where}: ${pattern} is not a regular expression`]
  }
}
const pathProblem = (where: string, path: string): string[] =>
  !path || path.startsWith('/') || path.split('/').includes('..') ? [`${where}: ${path} is not a path inside the repository`] : []

/** Why the set cannot be used; empty when it can. `patchExists` says which patch files of the records directory exist. */
export function setProblems(set: EvalSet, patchExists: (path: string) => boolean = (p) => existsSync(join(RECORDS, p))): string[] {
  const problems: string[] = []
  if (!set.important.length) problems.push('no severity counts as important')
  // The engine's parser writes only these (ADR-0075): a severity it never writes would count no finding.
  for (const s of set.important) if (!(SEVERITIES as readonly string[]).includes(s)) problems.push(`severity ${s} is not one the engine's parser writes (${SEVERITIES.join(', ')})`)
  const seen = new Set<string>()
  for (const c of set.cases) {
    const at = `case ${c.caseId}`
    if (!/^[a-z0-9-]+$/.test(c.caseId)) problems.push(`${at}: an id is lowercase words joined by -`)
    if (seen.has(c.caseId)) problems.push(`${at}: a second case with this id`)
    seen.add(c.caseId)
    if (!c.request?.trim()) problems.push(`${at}: no request (what the change was asked to do)`)
    const ch = c.change as Partial<{ rev: string; revertOf: string; patch: string; paths: string[] }>
    const named = (['rev', 'revertOf', 'patch'] as const).filter((k) => ch[k] !== undefined)
    if (named.length !== 1) problems.push(`${at}: its change names one of rev, revertOf, or patch`)
    for (const k of ['rev', 'revertOf'] as const) if (ch[k] !== undefined && !HEX.test(ch[k])) problems.push(`${at}: ${k} ${ch[k]} is not a commit id`)
    if (ch.revertOf !== undefined && !ch.paths?.length) problems.push(`${at}: a reverted fix names the paths the defect is in`)
    if (ch.patch !== undefined && (pathProblem(at, ch.patch).length || !patchExists(ch.patch))) problems.push(`${at}: patch ${ch.patch} is not a file of the records directory`)
    for (const p of ch.paths ?? []) problems.push(...pathProblem(at, p))
    if (c.fix && !HEX.test(c.fix.rev)) problems.push(`${at}: fix rev ${c.fix.rev} is not a commit id`)
    if (c.kind === 'escape') {
      if (!c.fix) problems.push(`${at}: an escape names its fix`)
      if (!c.expected) problems.push(`${at}: an escape names the finding it expects`)
      else problems.push(...regexProblem(`${at} expected path`, c.expected.path), ...regexProblem(`${at} expected claim`, c.expected.claim))
    } else if (c.expected || c.fix) problems.push(`${at}: a clean case has no fix and expects no finding`)
  }
  if (!set.cases.some((c) => c.kind === 'escape')) problems.push('no escape case: recall cannot be measured')
  if (!set.cases.some((c) => c.kind === 'clean')) problems.push('no clean case: the false-important rate cannot be measured')
  return problems
}

// --- the change a case reviews ---

/** A git command's output in `repo`; throws when it fails. */
export type Git = (args: string[]) => string
export const gitIn = (repo: string): Git => (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/** The change a case reviews: its diff and the commit it applies to, or why it cannot be had (then the case is not run). */
export function changeOf(c: EvalCase, git: Git, records = RECORDS): { base: string; diff: string } | { why: string } {
  const commit = (rev: string): string | undefined => {
    try {
      return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).trim()
    } catch {
      return undefined
    }
  }
  const narrowed = (paths: string[] | undefined): string[] => (paths?.length ? ['--', ...paths] : [])
  const ch = c.change
  if ('patch' in ch) {
    const fix = c.fix ? commit(c.fix.rev) : undefined
    return { base: fix ? `${fix} (the patch is against the file as the fix left it)` : 'the patch', diff: readFileSync(join(records, ch.patch), 'utf8') }
  }
  const rev = 'rev' in ch ? ch.rev : ch.revertOf
  const at = commit(rev)
  if (!at) return { why: `${rev} is not a commit of this repository (fetch the run branch it is on)` }
  let diff: string
  let base: string
  if ('rev' in ch) {
    const parent = commit(`${at}^`)
    if (!parent) return { why: `${rev} has no parent to diff against` }
    base = parent
    diff = git(['diff', '--no-color', '--no-ext-diff', parent, at, ...narrowed(ch.paths)])
  } else {
    // The fix taken away: from the fixed tree back to the one before it, on the defect's paths only.
    base = at
    diff = git(['diff', '--no-color', '--no-ext-diff', at, `${at}^`, ...narrowed(ch.paths)])
  }
  if (!diff.trim()) return { why: `the change is empty on ${'paths' in ch && ch.paths?.length ? ch.paths.join(', ') : 'its paths'}: nothing to review` }
  return { base, diff }
}

/**
 * What System's reviewer is given for a case, as the board's `review:1` is: its own instructions,
 * the task, and the engine's subject block with the change.
 */
export function reviewInput(c: EvalCase, change: { base: string; diff: string }): string {
  return [
    REVIEW_PROMPT, '',
    `Task: ${c.request}`, '',
    subjectBlock(`reviewer-eval:${c.caseId}`, '(none: the change below is the whole subject; read only it)', change.base, change.diff, c.request),
  ].join('\n')
}

// --- System's reviewer ---

/** A call to one of the running host's MCP tools (the CLI's `callTool`). */
export type Call = (tool: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string; structured?: Record<string, unknown> | undefined }>
interface View {
  runId?: string; status?: string; answer?: string; blocked?: { kind?: string }; error?: { kind?: string; message?: string }
  nodes?: Array<{ nodeId?: string; worker?: string; minTier?: string; tier?: string; model?: string }>
}

const TIER_ORDER = ['economy', 'standard', 'frontier'] as const
type Tier = typeof TIER_ORDER[number]
/** What the eval must run: the board reviewer's `review:1` (of `algorithm-development`), its capabilities and minimum tier. */
export interface ReviewerConfig { capabilities: string[]; tier: Tier }
type Templates = typeof ALGORITHM_DEVELOPMENT
const reviewStep = (nodes: Templates) => nodes.find((n) => n.nodeId === 'review:1')

/** The board reviewer's configuration, as this tree defines it. */
export function boardReviewer(board: Templates = ALGORITHM_DEVELOPMENT): ReviewerConfig {
  const step = reviewStep(board)!
  return { capabilities: [...step.capabilities].sort(), tier: step.tier as Tier }
}

/**
 * Why {@link REVIEW_TEMPLATE} cannot run the board reviewer's configuration; empty when it can: its
 * `review:1` must ask for exactly the board step's capabilities (the same Workers), take the caller's
 * tier, and not ask for more than the board step's tier, so the eval, naming that tier, runs at it.
 */
export function configurationProblems(board: Templates = ALGORITHM_DEVELOPMENT, evalTemplate: Templates = AGENT_REVIEW): string[] {
  const want = boardReviewer(board)
  const step = reviewStep(evalTemplate)
  if (!step) return [`${REVIEW_TEMPLATE} has no review:1 step`]
  const problems: string[] = []
  const caps = [...step.capabilities].sort()
  if (caps.join(',') !== want.capabilities.join(',')) problems.push(`${REVIEW_TEMPLATE}'s review:1 asks for ${caps.join(', ')}, the board reviewer for ${want.capabilities.join(', ')}: change them together`)
  if (!step.callerTier) problems.push(`${REVIEW_TEMPLATE}'s review:1 does not take the caller's tier, so the eval cannot run it at the board reviewer's ${want.tier}`)
  if (TIER_ORDER.indexOf(step.tier as Tier) > TIER_ORDER.indexOf(want.tier)) problems.push(`${REVIEW_TEMPLATE}'s review:1 asks for ${step.tier}, above the board reviewer's ${want.tier}`)
  return problems
}

/** One eval execution's run key for a case: fresh per execution, so a new run is never an old one's result; the same within it, so a retry is. */
export const executionKey = (execution: string, caseId: string): string => `reviewer-eval:${execution}:${caseId}`

/**
 * The findings an assessment holds, as the eval reads them: its severity as the engine's parser reads
 * it (an important finding without file, line, and evidence is a nit, ADR-0075), its title and detail
 * as the claim, its evidence, its file as the path. What `review:1` reports, before any verification.
 */
export function findingsOfAssessment(answer: string): Finding[] | string {
  const parsed = parseAssessment(answer)
  if (!parsed.ok) return `the reviewer's answer is not an assessment: ${parsed.reason}`
  return parsed.assessment.findings.map((f) => ({
    severity: f.severity, claim: f.detail ? `${f.title}: ${f.detail}` : f.title, ...(f.evidence ? { evidence: f.evidence } : {}), ...(f.file ? { path: f.file } : {}),
  }))
}

/**
 * Run one case on System's reviewer: MCP `run` of {@link REVIEW_TEMPLATE} at the board reviewer's
 * tier with the review input, then `result` until it ends, at most `minutes`; its findings, and what
 * served it (Worker, tier, model), or why there are none: a refused, failed, stopped, or unfinished
 * run; a step the host served at another minimum tier than the board reviewer's (it does not serve
 * this configuration); an answer that is no assessment.
 */
export async function reviewOnSystem(call: Call, input: string, key: string, reviewer: ReviewerConfig, minutes = 30): Promise<{ findings: Finding[]; workers: string[] } | string> {
  if (input.length > INPUT_MAX) return `the review input is ${input.length} characters, over the run tool's ${INPUT_MAX}: narrow the case's paths`
  const started = await call('run', { template: REVIEW_TEMPLATE, input, tier: reviewer.tier, classification: 'operator-shared', clientRequestId: key, waitSeconds: 55 })
  if (started.isError) return `the run was refused: ${started.text.slice(0, 300)}`
  let view = (started.structured ?? {}) as View
  if (!view.runId) return 'the run tool returned no run'
  for (let polls = Math.ceil((minutes * 60) / 55); view.status === 'running' && !view.blocked && polls > 0; polls -= 1) {
    const next = await call('result', { runId: view.runId, waitSeconds: 55 })
    if (next.isError) return `the result of ${view.runId} could not be read: ${next.text.slice(0, 300)}`
    view = (next.structured ?? {}) as View
  }
  if (view.blocked) return `${view.runId} waits on the operator (${view.blocked.kind ?? 'blocked'}): approve or stop it, then run the case again`
  if (view.status !== 'completed') return `${view.runId} ${view.status === 'running' ? `did not finish within ${minutes} minutes` : `ended ${view.status ?? 'unknown'}${view.error ? `: ${view.error.kind ?? ''} ${view.error.message ?? ''}` : ''}`}`
  // The host must have served the configuration asked for: the review step, at the board reviewer's minimum tier, on a Worker.
  const step = (view.nodes ?? []).find((n) => n.nodeId === 'review:1')
  if (!step?.worker) return `${view.runId}: the host served no review:1 step on a Worker`
  if (step.minTier !== reviewer.tier) return `${view.runId}: the host served review:1 at minimum tier ${String(step.minTier)}, not the board reviewer's ${reviewer.tier}: it does not serve this reviewer configuration (restart it on this build)`
  const findings = findingsOfAssessment(view.answer ?? '')
  if (typeof findings === 'string') return `${view.runId}: ${findings}`
  return { findings, workers: [`${step.worker} at ${step.tier ?? 'an unknown tier'} on ${step.model ?? 'an unknown model'}`] }
}

// --- judging ---

export interface Verdict {
  caseId: string
  kind: EvalCase['kind']
  /** Findings at an important severity. */
  important: Finding[]
  /** An escape: an important finding names the expected file (when it names one) and the expected claim. */
  found: boolean | null
  /** A clean case: it got an important finding. */
  falseImportant: boolean | null
}

/** One case's verdict on the findings of its review. */
export function judge(c: EvalCase, findings: readonly Finding[], important: readonly string[]): Verdict {
  const heavy = findings.filter((f) => important.includes(f.severity))
  if (c.kind === 'clean') return { caseId: c.caseId, kind: c.kind, important: heavy, found: null, falseImportant: heavy.length > 0 }
  const want = c.expected!
  const path = new RegExp(want.path, 'i')
  const claim = new RegExp(want.claim, 'i')
  const found = heavy.some((f) => (f.path === undefined || path.test(f.path)) && claim.test(`${f.claim}\n${f.evidence ?? ''}`))
  return { caseId: c.caseId, kind: c.kind, important: heavy, found, falseImportant: null }
}

export interface Report {
  record: 'reviewer-eval-report'
  setId: string
  version: number
  important: string[]
  verdicts: Verdict[]
  /** Cases left out, each with why (the change not had, the review failed): in neither count. */
  notRun: { caseId: string; why: string }[]
  /** Escapes whose expected finding was made, of those run; null when none ran, never 0. */
  recall: { found: number; of: number; rate: number | null }
  /** Clean changes that got an important finding, of those run; null when none ran, never 0. */
  falseImportant: { cases: number; of: number; rate: number | null }
  analysis: string
}

const rate = (n: number, of: number): number | null => (of ? Math.round((n / of) * 1000) / 1000 : null)

/** The report: recall and false-important rate over the cases that ran, the others listed, never counted. */
export function score(set: EvalSet, results: Readonly<Record<string, readonly Finding[] | string>>): Report {
  const verdicts: Verdict[] = []
  const notRun: Report['notRun'] = []
  for (const c of set.cases) {
    const got = results[c.caseId]
    if (got === undefined) notRun.push({ caseId: c.caseId, why: 'no review of it was given' })
    else if (typeof got === 'string') notRun.push({ caseId: c.caseId, why: got })
    else verdicts.push(judge(c, got, set.important))
  }
  const escapes = verdicts.filter((v) => v.kind === 'escape')
  const clean = verdicts.filter((v) => v.kind === 'clean')
  const found = escapes.filter((v) => v.found).length
  const wrong = clean.filter((v) => v.falseImportant).length
  return {
    record: 'reviewer-eval-report', setId: set.setId, version: set.version, important: [...set.important], verdicts, notRun,
    recall: { found, of: escapes.length, rate: rate(found, escapes.length) },
    falseImportant: { cases: wrong, of: clean.length, rate: rate(wrong, clean.length) },
    analysis: 'descriptive: counts over the cases that ran; an escape is found when an important finding names its expected file and claim; extra important findings on an escape are listed, never counted as false; no interval is computed, and a handful of cases is a regression check, not a measure of the reviewer',
  }
}

/** Why a report is below a bar; empty when it meets it (a bar on a rate that is null, none measured, is not met). */
export function belowBar(r: Report, bar: { minRecall?: number; maxFalseImportant?: number }): string[] {
  const problems: string[] = []
  if (bar.minRecall !== undefined && (r.recall.rate === null || r.recall.rate < bar.minRecall)) problems.push(`recall ${r.recall.rate === null ? 'not measured' : `${r.recall.found}/${r.recall.of}`} is below ${bar.minRecall}`)
  if (bar.maxFalseImportant !== undefined && (r.falseImportant.rate === null || r.falseImportant.rate > bar.maxFalseImportant)) {
    problems.push(`false-important rate ${r.falseImportant.rate === null ? 'not measured' : `${r.falseImportant.cases}/${r.falseImportant.of}`} is above ${bar.maxFalseImportant}`)
  }
  return problems
}

export function renderReport(r: Report): string {
  const pct = (n: number | null): string => (n === null ? 'not measured' : `${Math.round(n * 100)}%`)
  const lines = [
    `# Reviewer eval ${r.setId} v${r.version}`, '',
    `Recall: ${r.recall.found}/${r.recall.of} (${pct(r.recall.rate)}); false-important rate: ${r.falseImportant.cases}/${r.falseImportant.of} (${pct(r.falseImportant.rate)}); important = ${r.important.join(', ')}.`, '',
    '| Case | Kind | Result | Important findings |', '|---|---|---|---|',
  ]
  for (const v of r.verdicts) lines.push(`| ${v.caseId} | ${v.kind} | ${v.kind === 'escape' ? (v.found ? 'found' : 'MISSED') : v.falseImportant ? 'FALSE IMPORTANT' : 'clean'} | ${v.important.length} |`)
  if (r.notRun.length) lines.push('', '## Not run (in neither count)', '', ...r.notRun.map((n) => `- ${n.caseId}: ${n.why}`))
  lines.push('', r.analysis, '')
  return lines.join('\n')
}

// --- the gate ---

/** Answers the parser's part of the fingerprint is read on: a full one, one without evidence, an `assessment@1.0` one, malformed ones. */
const PARSER_SAMPLES = [
  '```json\n{"subject": "s", "verdict": "changes-requested", "findings": [{"severity": "important", "title": "t", "file": "a.ts", "line": 3, "evidence": "e", "class": "c"}, {"severity": "important", "title": "u"}, {"severity": "pre-existing", "title": "p", "file": "b.ts", "line": 1, "evidence": "e"}, {"severity": "nit", "title": "n"}]}\n```',
  '```json\n{"subject": "s", "verdict": "changes-requested", "findings": [{"severity": "blocking", "title": "t", "detail": "d", "file": "a.ts"}, {"severity": "info", "title": "i"}]}\n```',
  'Some words first.\n```json\n{"subject": "s", "verdict": "approve", "findings": []}\n```',
  '{"subject": "s", "verdict": "approve", "findings": [{"severity": "major", "title": "x"}]}',
  'no assessment',
]

/**
 * What the reviewer is made of, as this repository defines it, each part hashed: the board reviewer's
 * instructions, the subject block the engine appends (rendered on a fixed sample), the parser that
 * reads its answer, the capabilities, tier, and conversation of its steps (`review:1` of
 * `algorithm-development` and of `agent-review`), the set, and this runner. The Workers and models a
 * deployment routes it to are configuration, not code: a run records the ones that served it.
 */
export function fingerprintParts(setText = readFileSync(join(RECORDS, SET_FILE), 'utf8')): Record<string, string> {
  const step = (nodes: typeof ALGORITHM_DEVELOPMENT) => {
    const n = nodes.find((x) => x.nodeId === 'review:1')!
    return JSON.stringify({ capabilities: n.capabilities, tier: n.tier, conversation: n.conversation, prompt: n.prompt, acceptance: n.acceptance })
  }
  return {
    instructions: sha(REVIEW_PROMPT),
    subjectBlock: sha(subjectBlock('S', 'W', 'H', 'D', 'R')),
    // The parser by what it reads from fixed answers, not by its source text, which a toolchain may print differently.
    parser: sha(JSON.stringify(PARSER_SAMPLES.map((s) => parseAssessment(s)))),
    boardStep: sha(step(ALGORITHM_DEVELOPMENT)),
    evalStep: sha(step(AGENT_REVIEW)),
    set: sha(setText),
    runner: sha(RUNNER_VERSION),
  }
}
export const fingerprintOf = (parts: Record<string, string>): string => sha(JSON.stringify(Object.entries(parts).sort(([a], [b]) => (a < b ? -1 : 1))))

/** The gate's record: the reviewer the last recorded run measured, and what it measured (none before the first). */
export interface GateRecord {
  record: 'reviewer-eval-gate'
  fingerprint: string
  parts: Record<string, string>
  /** The measured run: its execution (each case's run key), when, what it measured, and what served it (Worker, tier, model). */
  run: { execution: string; at: string; reviewer: ReviewerConfig; recall: Report['recall']; falseImportant: Report['falseImportant']; workers: string[] } | null
  note?: string
}

/**
 * Why the reviewer is not the one recorded (each part that changed), why the eval could not run the
 * board reviewer's configuration, or why the record cannot stand; empty when none holds.
 */
/** What changed in the reviewer since the record's parts (reported, before a measured run, by the gate). */
export function driftOf(record: GateRecord, parts: Record<string, string>): string[] {
  return Object.keys({ ...parts, ...record.parts }).filter((k) => parts[k] !== record.parts[k]).sort()
}

export function gateProblems(record: GateRecord | undefined, parts: Record<string, string>, configuration: string[] = configurationProblems()): string[] {
  const unrunnable = configuration.map((p) => `the eval cannot run the board reviewer's configuration: ${p}`)
  if (!record) return [`no ${GATE_FILE}: the reviewer has never been recorded`, ...unrunnable]
  const changed = Object.keys({ ...parts, ...record.parts }).filter((k) => parts[k] !== record.parts[k]).sort()
  // Before the first measured run the record pins nothing a run showed, and the first run needs the
  // changed reviewer live: drift is reported (driftOf), never a failure, until a run is recorded.
  if (!record.run) return unrunnable
  const problems = [...changed.map((k) => `the reviewer's ${k} changed since the recorded run`), ...unrunnable]
  if (!changed.length && record.fingerprint !== fingerprintOf(parts)) problems.push('the record\'s fingerprint is not its parts\' fingerprint')
  return problems
}

/**
 * The record a run may write: only when every case ran, and no worse than the last recorded run
 * (recall not lower, false-important rate not higher); else why not.
 */
export function nextRecord(previous: GateRecord | undefined, parts: Record<string, string>, r: Report, served: { execution: string; reviewer: ReviewerConfig; workers: string[] }, at: Date): GateRecord | { refused: string[] } {
  const { execution, reviewer, workers } = served
  const refused: string[] = []
  if (r.notRun.length) refused.push(`${r.notRun.length} case(s) did not run (${r.notRun.map((n) => n.caseId).join(', ')}): a recorded run runs every case`)
  // A record names a measurement of its own: never an earlier execution's runs presented again.
  if (previous?.run && previous.run.execution === execution) refused.push(`execution ${execution} is the one already recorded: a new record is a new execution`)
  const last = previous?.run
  if (last && r.recall.rate !== null && last.recall.rate !== null && r.recall.rate < last.recall.rate) refused.push(`recall fell from ${last.recall.found}/${last.recall.of} to ${r.recall.found}/${r.recall.of}`)
  if (last && r.falseImportant.rate !== null && last.falseImportant.rate !== null && r.falseImportant.rate > last.falseImportant.rate) refused.push(`the false-important rate rose from ${last.falseImportant.cases}/${last.falseImportant.of} to ${r.falseImportant.cases}/${r.falseImportant.of}`)
  if (refused.length) return { refused }
  return { record: 'reviewer-eval-gate', fingerprint: fingerprintOf(parts), parts, run: { execution, at: at.toISOString(), reviewer, recall: r.recall, falseImportant: r.falseImportant, workers: [...workers].sort() } }
}

// --- the command line ---

const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  if (!args[at + 1]) throw new Error(`${name} needs a value`)
  return args[at + 1]
}
const bar = (args: string[]): { minRecall?: number; maxFalseImportant?: number } => {
  const min = flag(args, '--min-recall')
  const max = flag(args, '--max-false-important')
  return { ...(min !== undefined ? { minRecall: Number(min) } : {}), ...(max !== undefined ? { maxFalseImportant: Number(max) } : {}) }
}
const gatePath = join(RECORDS, GATE_FILE)
const readGate = (): GateRecord | undefined => (existsSync(gatePath) ? read<GateRecord>(gatePath) : undefined)

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  const set = loadSet()
  const problems = setProblems(set)
  if (problems.length && command !== 'check') throw new Error(`the set cannot be used:\n${problems.join('\n')}`)
  switch (command) {
    case 'check': {
      console.log(problems.length ? problems.join('\n') : `ok: ${set.cases.filter((c) => c.kind === 'escape').length} escape(s), ${set.cases.filter((c) => c.kind === 'clean').length} clean change(s)`)
      return problems.length ? 1 : 0
    }
    case 'gate': {
      const parts = fingerprintParts()
      const record = readGate()
      const failed = gateProblems(record, parts)
      if (!failed.length) {
        const drift = record!.run ? [] : driftOf(record!, parts)
        console.log(record!.run
          ? `reviewer eval: the reviewer is the one recorded (${record!.fingerprint}), measured ${record!.run.at}: recall ${record!.run.recall.found}/${record!.run.recall.of}, false-important ${record!.run.falseImportant.cases}/${record!.run.falseImportant.of}`
          : `reviewer eval: not yet measured; the gate holds from the first recorded run${drift.length ? ` (changed since ${record!.fingerprint}: ${drift.join(', ')}; now ${fingerprintOf(parts)})` : ` (${record!.fingerprint})`}`)
        return 0
      }
      console.log([
        'reviewer eval: the review template, its prompts, or the reviewer\'s tier changed, so the reviewer eval must run on it before the change is kept:',
        ...failed.map((p) => `  ${p}`),
        `  now: ${fingerprintOf(parts)} ${JSON.stringify(parts)}`,
        '  run: node --import tsx scripts/experiments/reviewer-eval.ts run --repo <a clone with the run branches> --record',
        '  (docs/operations/runbooks.md#run-the-reviewer-eval)',
      ].join('\n'))
      return 1
    }
    case 'resolve': {
      const git = gitIn(resolve(flag(args, '--repo') ?? '.'))
      for (const c of set.cases) {
        const got = changeOf(c, git)
        console.log(`${c.caseId}: ${'why' in got ? `not run: ${got.why}` : `${got.diff.split('\n').length} diff line(s) against ${got.base}; review input ${reviewInput(c, got).length} characters`}`)
      }
      return 0
    }
    case 'input': {
      const c = set.cases.find((x) => x.caseId === args[0])
      if (!c) throw new Error(`input <caseId>: ${args[0] ?? 'none'} is not in the set`)
      const got = changeOf(c, gitIn(resolve(flag(args, '--repo') ?? '.')))
      if ('why' in got) throw new Error(`${c.caseId}: ${got.why}`)
      process.stdout.write(reviewInput(c, got))
      return 0
    }
    case 'run': {
      const git = gitIn(resolve(flag(args, '--repo') ?? '.'))
      const out = flag(args, '--out')
      if (out) mkdirSync(resolve(out), { recursive: true })
      const minutes = Number(flag(args, '--minutes') ?? 30)
      const unrunnable = configurationProblems()
      if (unrunnable.length) throw new Error(`the eval cannot run the board reviewer's configuration:\n${unrunnable.join('\n')}`)
      const reviewer = boardReviewer()
      // Each execution's runs are its own: a fresh id, unless --execution resumes one whose runs did not all finish.
      const execution = flag(args, '--execution') ?? randomUUID()
      console.log(`execution ${execution}: the board reviewer's review:1 (${reviewer.capabilities.join(', ')}, tier ${reviewer.tier})`)
      // The host's MCP endpoint, as the CLI reaches it: loaded only here, so the gate and the tests need no host.
      const { callTool } = await import('../../packages/cli/src/index.ts')
      const parts = fingerprintParts()
      const results: Record<string, Finding[] | string> = {}
      const workers = new Set<string>()
      for (const c of set.cases) {
        const got = changeOf(c, git)
        if ('why' in got) {
          results[c.caseId] = `the change is not had: ${got.why}`
          continue
        }
        const reviewed = await reviewOnSystem(callTool, reviewInput(c, got), executionKey(execution, c.caseId), reviewer, minutes)
        if (typeof reviewed === 'string') {
          results[c.caseId] = reviewed
          continue
        }
        results[c.caseId] = reviewed.findings
        for (const w of reviewed.workers) workers.add(w)
        if (out) writeFileSync(join(resolve(out), `${c.caseId}.json`), `${JSON.stringify({ findings: reviewed.findings, workers: reviewed.workers }, null, 2)}\n`)
      }
      const r = score(set, results)
      console.log(renderReport(r))
      console.log(`served by: ${[...workers].sort().join(', ') || 'no Worker'}`)
      const below = belowBar(r, bar(args))
      if (below.length) console.log(`below the bar:\n${below.join('\n')}`)
      if (args.includes('--record')) {
        const next = nextRecord(readGate(), parts, r, { execution, reviewer, workers: [...workers] }, new Date())
        if ('refused' in next) {
          console.log(`not recorded:\n${next.refused.join('\n')}`)
          return 1
        }
        writeFileSync(gatePath, `${JSON.stringify(next, null, 2)}\n`)
        console.log(`recorded ${GATE_FILE}: ${next.fingerprint}`)
      }
      return below.length ? 1 : 0
    }
    case 'score': {
      const dir = resolve(args[0] ?? '')
      const results: Record<string, Finding[] | string> = {}
      for (const c of set.cases) if (existsSync(join(dir, `${c.caseId}.json`))) results[c.caseId] = read<{ findings: Finding[] }>(join(dir, `${c.caseId}.json`)).findings
      const r = score(set, results)
      console.log(renderReport(r))
      const below = belowBar(r, bar(args))
      if (below.length) console.log(`below the bar:\n${below.join('\n')}`)
      return below.length ? 1 : 0
    }
    default:
      console.error('usage: reviewer-eval.ts check|gate|resolve|input|run|score … (see the file\'s header)')
      return 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    console.error((error as Error).message)
    process.exit(1)
  })
}
