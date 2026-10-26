/**
 * The workflow eval (docs/validation/experiments/workflow-eval.md): replay golden board tasks, each
 * pinned to its base commit, under a named process variant, at least twice each, offline from live
 * work (an eval clone of the repository, an eval board project, a budget cap of its own), grade each
 * replay's result with the task's own checks, and report per task and in total, with the tasks
 * whose outcome flipped between two variants. A trial is one replay of one task under one variant.
 * Deterministic: the same records and trial files give the same plan and the same report. A
 * stopgap until PROP-0011's store-backed evaluation engine exists (F4): it computes no statistic,
 * so a flip is a fact to look at, never a verdict.
 *
 *   node --import tsx scripts/experiments/workflow-eval.ts <command> …
 *     check                                                  the golden set and the variants are well formed
 *     calibrate <caseId> --repo <eval clone> --good <commit> --scratch <dir> [--keep]
 *                                                            the task's grader fails on its base and passes on a known-good result
 *     plan    <eval> --variants <a,b> --tasks <T1,T2,…> --repetitions <n> --seed <s>
 *             --cap <tokens>:<quota points>:<minutes> --reserve <tokens>:<quota points>:<minutes> [--project <id>] [--attempts <n>]
 *                                                            write <eval>/plan.json: the trials in the order they run
 *     next    <eval> --repo <eval clone>                     the next trial within the cap: pins the eval clone at its
 *                                                            base, writes its trial.json, prints the board task and the run
 *     export  <eval> <trialId> <runId>                       one attempt's records, read with the system CLI
 *     grade   <eval> <trialId> --repo <eval clone> --worktree <run worktree> [--keep]
 *                                                            the grader on the attempt's exact result, in a worktree of its own
 *     report  <eval> [--json]                                per task and in total, and the flips between variants
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contentId } from '../../packages/libs/src/index.ts'

export const RUNNER_VERSION = '1'
export const RECORDS = fileURLToPath(new URL('../../docs/validation/experiments/records', import.meta.url))
export const FILES = { set: 'workflow-golden-set.v1.json', variants: 'workflow-variants.v1.json' } as const

// --- the golden set and the variants ---

/**
 * One check of a task's grader, on the result's tree:
 * - `command`: a command line as the autonomy policy matches it (words split on single spaces; `{base}`
 *   stands for the task's base commit), run in the grading worktree; it passes on exit 0;
 * - `changed`: path prefixes the result must each change against the base (a file under each);
 * - `path` with `matches`: a regular expression (multiline) the file must match;
 * - `path` with `lacks`: one it must not match (a missing file lacks everything).
 */
export type GraderCheck =
  | { id: string; command: string }
  | { id: string; changed: string[] }
  | { id: string; path: string; matches: string }
  | { id: string; path: string; lacks: string }
export interface GoldenTask {
  caseId: string
  taskId: string
  title: string
  template: 'algorithm-development'
  /** The template variant the task's own runs used (`docs`, `tests`), or none. */
  templateVariant: 'docs' | 'tests' | null
  /** The commit the accepted attempt's worktree was cut from (the board's `git-head`). */
  base: string
  /** The board's record of the accepted result: what the replay is compared with. */
  accepted: { runId: string; attempts: number; tree: string; acceptedBy: string; landed: string | null }
  goal: string
  acceptance: { id: string; statement: string; check?: string }[]
  /** The task's own checks on the result: every one must pass for the trial to pass, and at least one must fail on the base. */
  grader: GraderCheck[]
  /** Optional hidden checks: the landed commit's paths (its tests), checked out over the result, then its commands run. */
  hidden: { commit: string; paths: string[]; commands: { id: string; command: string }[] } | null
}
export interface GoldenSet { setId: string; version: number; repository: string; setup: string[]; tasks: GoldenTask[] }
export interface Variant {
  id: string
  /** `ready`: it can be planned; `planned`: named, not yet runnable. */
  state: 'ready' | 'planned'
  template: string
  description: string
  /** The install configuration in force for its trials (a profile patch, kept with the eval), or none for the install as it is. */
  configuration: string | null
}
export interface Variants { version: number; variants: Variant[] }

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const write = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const HEX40 = /^[0-9a-f]{40}$/
const words = (line: string): string[] => line.split(' ')
const isCommand = (c: GraderCheck): c is { id: string; command: string } => 'command' in c

export function loadSet(dir = RECORDS): GoldenSet { return read(join(dir, FILES.set)) }
export function loadVariants(dir = RECORDS): Variants { return read(join(dir, FILES.variants)) }

/** Why the golden set or the variants cannot be used; empty when they can. */
export function setProblems(set: GoldenSet, variants: Variants): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const line = (where: string, text: string): void => {
    if (!text || words(text).some((w) => !w)) problems.push(`${where}: "${text}" is not words split on single spaces`)
  }
  const relative = (where: string, path: string): void => {
    if (!path || path.startsWith('/') || path.split('/').includes('..')) problems.push(`${where}: ${path} is not a path inside the repository`)
  }
  for (const s of set.setup) line('setup', s)
  for (const t of set.tasks) {
    const at = `task ${t.caseId}`
    if (seen.has(t.caseId)) problems.push(`${at}: a second task with this case id`)
    seen.add(t.caseId)
    if (!HEX40.test(t.base)) problems.push(`${at}: base ${t.base} is not a full commit id`)
    if (t.template !== 'algorithm-development') problems.push(`${at}: template ${t.template as string} is not replayed (algorithm-development only)`)
    if (!t.goal.trim()) problems.push(`${at}: no goal`)
    if (!t.acceptance.length) problems.push(`${at}: no acceptance criterion`)
    if (!t.accepted.runId || !t.accepted.tree) problems.push(`${at}: the accepted result is not named`)
    // A grader made of commands alone passes on the base itself when the base is green: some check
    // must be about this task's change.
    if (!t.grader.some((c) => !isCommand(c)) && !t.hidden) problems.push(`${at}: its grader is commands only, which pass on an unchanged base: add a changed, matches, or lacks check, or hidden checks`)
    const ids = new Set<string>()
    for (const c of [...t.grader, ...(t.hidden?.commands ?? [])]) {
      if (ids.has(c.id)) problems.push(`${at}: grader id ${c.id} twice`)
      ids.add(c.id)
      const where = `${at} grader ${c.id}`
      if ('command' in c) line(where, c.command)
      else if ('changed' in c) {
        if (!c.changed.length) problems.push(`${where}: names no path`)
        for (const p of c.changed) relative(where, p)
      } else {
        relative(where, c.path)
        const pattern = 'matches' in c ? c.matches : c.lacks
        try {
          new RegExp(pattern, 'm')
        } catch {
          problems.push(`${where}: ${pattern} is not a regular expression`)
        }
      }
    }
    if (t.hidden) {
      if (!HEX40.test(t.hidden.commit)) problems.push(`${at}: hidden commit ${t.hidden.commit} is not a full commit id`)
      if (!t.hidden.paths.length || !t.hidden.commands.length) problems.push(`${at}: hidden checks name no path or no command`)
      for (const p of t.hidden.paths) relative(`${at} hidden`, p)
    }
  }
  const vids = new Set<string>()
  for (const v of variants.variants) {
    if (vids.has(v.id)) problems.push(`variant ${v.id}: named twice`)
    vids.add(v.id)
    if (!/^[a-z0-9-]+$/.test(v.id)) problems.push(`variant ${v.id}: an id is lowercase words joined by -`)
  }
  return problems
}

// --- plan ---

export interface Amounts { tokens: number; quotaPoints: number; minutes: number }
export interface Trial { trialId: string; caseId: string; variant: string; repetition: number }
export interface Plan {
  record: 'workflow-eval-plan'
  runner: string
  evalId: string
  /** The eval's own board project: its tasks and approvals are the trials', never live work's. */
  project: string
  set: { id: string; version: number; hash: string }
  variants: { id: string; hash: string }[]
  cases: string[]
  repetitions: number
  /** Attempts each trial's board task gets (default 1: a trial is one attempt). */
  attempts: number
  seed: string
  setup: string[]
  /** What every trial together may draw; no trial starts unless what was recorded plus `reserve` stays within it. */
  cap: Amounts
  /** What one trial reserves before it starts. */
  reserve: Amounts
  trials: Trial[]
  createdAt: string
}
export interface PlanOptions { evalId: string; project?: string; variants: string[]; cases: string[]; repetitions: number; attempts?: number; seed: string; cap: Amounts; reserve: Amounts; at: Date }

const AMOUNTS = ['tokens', 'quotaPoints', 'minutes'] as const

/**
 * The trials in the order they run: one round per repetition; in each round the variants in the
 * order the seed gives, each a block (one configuration in force per block), and within a block the
 * tasks in the order the seed gives.
 */
export function plan(set: GoldenSet, variants: Variants, o: PlanOptions): Plan {
  const problems = setProblems(set, variants)
  if (!Number.isInteger(o.repetitions) || o.repetitions < 2) problems.push(`${o.repetitions} repetition(s): every task runs at least twice per variant, or a flip cannot be told from noise`)
  if (!o.variants.length) problems.push('no variant named')
  if (new Set(o.variants).size !== o.variants.length) problems.push('a variant named twice')
  for (const id of o.variants) {
    const v = variants.variants.find((x) => x.id === id)
    if (!v) problems.push(`variant ${id} is not in ${FILES.variants}`)
    else if (v.state !== 'ready') problems.push(`variant ${id} is ${v.state}, not ready: it cannot be replayed yet`)
  }
  if (!o.cases.length) problems.push('no task named')
  if (new Set(o.cases).size !== o.cases.length) problems.push('a task named twice')
  for (const c of o.cases) if (!set.tasks.some((t) => t.caseId === c)) problems.push(`task ${c} is not in the golden set`)
  const attempts = o.attempts ?? 1
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) problems.push(`attempts ${attempts}: 1 to 10`)
  for (const key of AMOUNTS) {
    if (!(o.cap[key] > 0) || !(o.reserve[key] > 0)) problems.push(`the cap and the reserve need a positive ${key}`)
    else if (o.reserve[key] > o.cap[key]) problems.push(`one trial reserves more ${key} than the cap holds`)
  }
  if (!o.seed) problems.push('no seed')
  if (!/^[a-z0-9-]+$/.test(o.evalId)) problems.push(`eval id ${o.evalId}: lowercase words joined by -`)
  if (problems.length) throw new Error(`not planned:\n${problems.join('\n')}`)
  const rank = (key: string): string => contentId({ seed: o.seed, key })
  const by = (key: (v: string) => string) => (a: string, b: string): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
  const trials: Trial[] = []
  for (let repetition = 1; repetition <= o.repetitions; repetition += 1) {
    for (const variant of [...o.variants].sort(by((v) => rank(`r${repetition}:variant:${v}`)))) {
      for (const caseId of [...o.cases].sort(by((c) => rank(`r${repetition}:${variant}:case:${c}`)))) {
        trials.push({ trialId: `r${repetition}-${variant}-${caseId}`, caseId, variant, repetition })
      }
    }
  }
  return {
    record: 'workflow-eval-plan', runner: RUNNER_VERSION, evalId: o.evalId, project: o.project ?? `eval-${o.evalId}`,
    set: { id: set.setId, version: set.version, hash: contentId(set) },
    variants: o.variants.map((id) => ({ id, hash: contentId(variants.variants.find((v) => v.id === id)!) })),
    cases: [...o.cases], repetitions: o.repetitions, attempts, seed: o.seed, setup: [...set.setup], cap: o.cap, reserve: o.reserve, trials,
    createdAt: o.at.toISOString(),
  }
}

/** Why the plan no longer binds the records it was made from; empty when it does. */
export function planDrift(p: Plan, set: GoldenSet, variants: Variants): string[] {
  const problems: string[] = []
  if (p.set.hash !== contentId(set)) problems.push(`the golden set changed since the plan (${p.set.hash}): a changed set is a new version and a new eval`)
  for (const v of p.variants) {
    const now = variants.variants.find((x) => x.id === v.id)
    if (!now || contentId(now) !== v.hash) problems.push(`variant ${v.id} changed since the plan`)
  }
  return problems
}

// --- a trial's files ---

/** What `next` records for a trial before its run starts (`trial.json`); `export` appends each attempt's run. */
export interface TrialNote { trialId: string; caseId: string; variant: string; repetition: number; base: string; preparedAt: string; runs: string[] }
/** A line of `system events --json` (docs/reference/cli.md). */
export interface EventLine { seq: number; at: string; type: string; runId?: string; nodeId?: string; data?: Record<string, unknown> }
export interface Explanation { runId: string; nodes: { nodeId: string; state: string; worker?: string }[] }
/** A pool's totals as MCP `resources_usage` gives them for a run (`usage.json`). */
export interface PoolTotal { pool: string; records: number; usage?: { inputTokens?: number; outputTokens?: number } }
/** A `quota-draw@1.0` body (docs/reference/schemas.md#quota-draw), one per agent run of the attempt (`draws.json`). */
export interface QuotaDraw { workflowRunId: string; windows: { window: string; draw?: number; state: string }[] }
/** An approval request as MCP `approvals_list` gives it (`approvals.json`: every state, the eval project's). */
export interface Approval { requestId: string; state: string; action: { class: string }; requester: { runId?: string; taskId?: string } }
export interface RunFiles { explain: Explanation; events: EventLine[]; usage?: { totals?: PoolTotal[] }; draws?: QuotaDraw[] }
/** One grader check's outcome: a command's exit code, duration, and the end of its output; a file check's finding. */
export interface CheckResult { id: string; what: string; passed: boolean; exit: number | null; seconds: number; tail: string }
/** What `grade` records (`grade.json`). */
export interface Grade {
  trialId: string
  runId: string
  result: { commit: string; tree: string }
  /** Whether the result descends from the task's base commit: a replay cut from elsewhere is invalid. */
  fromBase: boolean
  setup: CheckResult[]
  checks: CheckResult[]
  hidden: CheckResult[] | null
}
export interface TrialFiles { note: TrialNote; runs: RunFiles[]; approvals?: Approval[]; grade?: Grade }

export function readTrial(dir: string): TrialFiles {
  const note = read<TrialNote>(join(dir, 'trial.json'))
  const runs = note.runs.map((runId) => {
    const at = join(dir, 'runs', runId)
    const files: RunFiles = { explain: read(join(at, 'explain.json')), events: read(join(at, 'events.json')) }
    if (existsSync(join(at, 'usage.json'))) files.usage = read(join(at, 'usage.json'))
    if (existsSync(join(at, 'draws.json'))) files.draws = read(join(at, 'draws.json'))
    return files
  })
  const files: TrialFiles = { note, runs }
  if (existsSync(join(dir, 'approvals.json'))) files.approvals = read(join(dir, 'approvals.json'))
  if (existsSync(join(dir, 'grade.json'))) files.grade = read(join(dir, 'grade.json'))
  return files
}

// --- measure ---

/** A remediation cycle the review grew: its fix step (docs/design/workflow-engine.md#remediation-on-the-approval-queue). */
const FIX_STEP = /^review:\d+:fix:\d+$/
const ENDS = new Set(['workflow.run.completed', 'workflow.run.failed'])

export interface Measurement {
  trialId: string
  caseId: string
  variant: string
  repetition: number
  runs: string[]
  /** Every grader check (and hidden check) passed on the trial's last result. */
  passed: boolean | null
  /** Passed on the trial's first attempt, which completed with no remediation cycle. */
  passedFirstTime: boolean | null
  attempts: number
  reviewCycles: number
  /** Approval requests the trial's runs put to the lead or the operator, every class, answered or not. */
  touches: number
  touchesByClass: Record<string, number>
  /** Input plus output tokens the ledger counted; null when a run's usage was not exported. */
  tokens: number | null
  /** Percentage points drawn from accounts' windows (clean and confounded draws); null when a run's draws were not exported. */
  quotaPoints: number | null
  /** From each run's start to its last end, summed over the trial's runs. */
  minutes: number | null
  /** Runs that ended failed, with the failure's kind. */
  failed: string[]
  /** Why the trial cannot be counted: it is reported, never scored. */
  integrity: string[]
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** One trial's measurements, from its exported records and its grade. */
export function measure(p: Plan, set: GoldenSet, files: TrialFiles): Measurement {
  const { note } = files
  const trial = p.trials.find((t) => t.trialId === note.trialId)
  const task = set.tasks.find((t) => t.caseId === note.caseId)
  const integrity: string[] = []
  if (!trial) integrity.push(`trial ${note.trialId} is not in the plan`)
  else if (trial.caseId !== note.caseId || trial.variant !== note.variant || trial.repetition !== note.repetition) integrity.push(`trial ${note.trialId} records another task, variant, or repetition than the plan`)
  if (!task) integrity.push(`task ${note.caseId} is not in the golden set`)
  else if (note.base !== task.base) integrity.push(`the eval clone was pinned at ${note.base}, the task's base is ${task.base}`)
  if (!files.runs.length) integrity.push('no run exported')
  if (files.runs.length > p.attempts) integrity.push(`${files.runs.length} runs, more than the plan's ${p.attempts} attempt(s)`)
  files.runs.forEach((r, i) => {
    if (r.explain.runId !== note.runs[i]) integrity.push(`run ${note.runs[i] ?? '?'}: its records are run ${r.explain.runId}`)
  })

  const cycles = (r: RunFiles | undefined): number => r?.explain.nodes.filter((n) => FIX_STEP.test(n.nodeId)).length ?? 0
  const reviewCycles = files.runs.reduce((a, r) => a + cycles(r), 0)

  // Touches: the approval requests a run of the trial put to the queue.
  const ours = new Set(note.runs)
  const asked = (files.approvals ?? []).filter((a) => a.requester.runId !== undefined && ours.has(a.requester.runId))
  if (!files.approvals) integrity.push('the approval requests are not exported (approvals.json)')
  const touchesByClass: Record<string, number> = {}
  for (const a of asked) touchesByClass[a.action.class] = (touchesByClass[a.action.class] ?? 0) + 1

  let tokens: number | null = 0
  let quotaPoints: number | null = 0
  let minutes: number | null = 0
  const failed: string[] = []
  for (const r of files.runs) {
    if (!r.usage) tokens = null
    else if (tokens !== null) tokens += (r.usage.totals ?? []).reduce((a, t) => a + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0), 0)
    if (!r.draws) quotaPoints = null
    else {
      for (const d of r.draws) {
        if (d.workflowRunId !== r.explain.runId) integrity.push(`a quota draw of run ${d.workflowRunId} is filed under run ${r.explain.runId}`)
        for (const w of d.windows) if (quotaPoints !== null && (w.state === 'clean' || w.state === 'confounded') && typeof w.draw === 'number') quotaPoints += w.draw
      }
    }
    const started = r.events.find((e) => e.type === 'workflow.run.started')
    const ended = r.events.filter((e) => ENDS.has(e.type)).at(-1)
    if (!started || !ended) {
      minutes = null
      integrity.push(`run ${r.explain.runId} has no ${started ? 'end' : 'start'} in its events: it was exported before it ended`)
    } else if (minutes !== null) minutes += (Date.parse(ended.at) - Date.parse(started.at)) / 60_000
    if (ended?.type === 'workflow.run.failed') failed.push(`${r.explain.runId}: ${String(ended.data?.kind ?? 'failed')}`)
  }
  if (files.runs.some((r) => !r.usage)) integrity.push('a run\'s usage is not exported (usage.json)')

  const g = files.grade
  let passed: boolean | null = null
  if (!g) integrity.push('the trial is not graded (grade.json)')
  else {
    if (g.runId !== note.runs.at(-1)) integrity.push(`graded run ${g.runId}, the trial's last run is ${note.runs.at(-1) ?? 'none'}`)
    if (!g.fromBase) integrity.push(`the graded result does not descend from the base ${note.base}: the run's worktree was cut from elsewhere`)
    if (g.setup.some((s) => !s.passed)) integrity.push(`the grader's setup failed (${g.setup.filter((s) => !s.passed).map((s) => s.what).join('; ')}): the result was not graded`)
    else {
      const want = [...(task?.grader ?? []), ...(task?.hidden?.commands ?? [])].map((c) => c.id)
      const ran = [...g.checks, ...(g.hidden ?? [])]
      const missing = want.filter((id) => !ran.some((c) => c.id === id))
      if (missing.length) integrity.push(`grader check(s) not run: ${missing.join(', ')}`)
      else passed = ran.every((c) => c.passed)
    }
  }
  const first = files.runs[0]
  const firstFailed = first ? failed.some((f) => f.startsWith(`${first.explain.runId}:`)) : true
  return {
    trialId: note.trialId, caseId: note.caseId, variant: note.variant, repetition: note.repetition, runs: [...note.runs],
    passed, passedFirstTime: passed === null ? null : passed && files.runs.length === 1 && cycles(first) === 0 && !firstFailed,
    attempts: files.runs.length, reviewCycles, touches: asked.length, touchesByClass,
    tokens, quotaPoints: quotaPoints === null ? null : round2(quotaPoints), minutes: minutes === null ? null : round2(minutes), failed, integrity,
  }
}

// --- the budget cap ---

/** What the measured trials drew so far; a trial whose amount is unknown counts as its whole reserve, never as 0. */
export function spent(p: Plan, measured: Measurement[]): Amounts {
  const sum = (f: (m: Measurement) => number | null, reserve: number): number => round2(measured.reduce((a, m) => a + (f(m) ?? reserve), 0))
  return { tokens: sum((m) => m.tokens, p.reserve.tokens), quotaPoints: sum((m) => m.quotaPoints, p.reserve.quotaPoints), minutes: sum((m) => m.minutes, p.reserve.minutes) }
}

/**
 * The next trial to run, or why none may start: a trial is prepared and not yet graded (trials run
 * one at a time, since a run's worktree is cut from the eval clone's HEAD); every trial ran; or what
 * was drawn plus the next reservation passes the cap.
 */
export function nextTrial(p: Plan, prepared: string[], graded: Measurement[]): { trial: Trial } | { refused: string } {
  const open = prepared.filter((id) => !graded.some((m) => m.trialId === id))
  if (open.length) return { refused: `trial ${open.join(', ')} is prepared and not graded: grade it before the next one` }
  const trial = p.trials.find((t) => !prepared.includes(t.trialId))
  if (!trial) return { refused: 'every trial of the plan ran' }
  const used = spent(p, graded)
  const over = AMOUNTS.filter((k) => used[k] + p.reserve[k] > p.cap[k])
  if (over.length) return { refused: `the cap is reached: ${over.map((k) => `${k} ${used[k]} drawn + ${p.reserve[k]} reserved > ${p.cap[k]}`).join('; ')}; ${p.trials.length - prepared.length} trial(s) not run` }
  return { trial }
}

/** The board task a trial's attempt serves, in the eval's own project (MCP `board_propose`). */
export function boardTask(p: Plan, task: GoldenTask, trial: Trial): Record<string, unknown> {
  return {
    projectId: p.project,
    title: `${p.evalId} ${trial.trialId}: ${task.title}`.slice(0, 200),
    goal: task.goal,
    acceptance: task.acceptance,
    actionClass: 'workspace-write',
    template: task.template,
    maxAttempts: p.attempts,
    clientRequestId: `${p.evalId}:${trial.trialId}`,
  }
}

// --- report ---

export interface Metric { sum: number; unknown: number }
export type Outcome = 'pass' | 'fail' | 'mixed' | 'none'
export interface Tally {
  variant: string
  trials: number
  passed: number
  passedFirstTime: number
  reviewCycles: number
  touches: number
  tokens: Metric
  quotaPoints: Metric
  minutes: Metric
}
/** `outcome`: `pass` when every counted trial passed, `fail` when none did, `mixed` when some did, `none` when none was counted. */
export interface Row extends Tally { caseId: string; outcome: Outcome }
export interface Flip { caseId: string; from: { variant: string; outcome: Outcome; passed: number; of: number }; to: { variant: string; outcome: Outcome; passed: number; of: number }; direction: 'gained' | 'lost' | 'changed' }
export interface Report {
  record: 'workflow-eval-report'
  runner: string
  evalId: string
  set: Plan['set']
  variants: string[]
  rows: Row[]
  /** Per variant over every task, with how many of its tasks were mixed. */
  totals: (Tally & { mixed: number })[]
  flips: Flip[]
  missing: string[]
  integrity: { trial: string; problems: string[] }[]
  analysis: string
}

const metric = (values: (number | null)[]): Metric => ({ sum: round2(values.reduce<number>((a, v) => a + (v ?? 0), 0)), unknown: values.filter((v) => v === null).length })

function tally(variant: string, ms: Measurement[]): Tally {
  return {
    variant, trials: ms.length, passed: ms.filter((m) => m.passed).length, passedFirstTime: ms.filter((m) => m.passedFirstTime).length,
    reviewCycles: ms.reduce((a, m) => a + m.reviewCycles, 0), touches: ms.reduce((a, m) => a + m.touches, 0),
    tokens: metric(ms.map((m) => m.tokens)), quotaPoints: metric(ms.map((m) => m.quotaPoints)), minutes: metric(ms.map((m) => m.minutes)),
  }
}
const outcomeOf = (t: Tally): Outcome => (!t.trials ? 'none' : t.passed === t.trials ? 'pass' : t.passed === 0 ? 'fail' : 'mixed')

/**
 * The report: per task and variant, per variant in total, and each task whose outcome differs
 * between the first planned variant (the baseline of every comparison) and another (a flip). A
 * trial with an integrity problem is listed, never counted.
 */
export function report(p: Plan, measured: Measurement[]): Report {
  const byId = new Map(measured.map((m) => [m.trialId, m]))
  const missing = p.trials.filter((t) => !byId.has(t.trialId)).map((t) => t.trialId)
  const found = p.trials.map((t) => byId.get(t.trialId)).filter((m): m is Measurement => m !== undefined)
  const counted = found.filter((m) => !m.integrity.length)
  const variants = p.variants.map((v) => v.id)
  const rows: Row[] = p.cases.flatMap((caseId) => variants.map((v) => {
    const t = tally(v, counted.filter((m) => m.caseId === caseId && m.variant === v))
    return { caseId, ...t, outcome: outcomeOf(t) }
  }))
  const totals = variants.map((v) => ({ ...tally(v, counted.filter((m) => m.variant === v)), mixed: rows.filter((x) => x.variant === v && x.outcome === 'mixed').length }))
  const flips: Flip[] = []
  const [baseline, ...others] = variants
  for (const caseId of p.cases) {
    const from = rows.find((r) => r.caseId === caseId && r.variant === baseline)
    for (const v of others) {
      const to = rows.find((r) => r.caseId === caseId && r.variant === v)
      if (!from || !to || from.outcome === 'none' || to.outcome === 'none' || from.outcome === to.outcome) continue
      const direction = from.outcome === 'fail' && to.outcome === 'pass' ? 'gained' : from.outcome === 'pass' && to.outcome === 'fail' ? 'lost' : 'changed'
      flips.push({ caseId, from: { variant: from.variant, outcome: from.outcome, passed: from.passed, of: from.trials }, to: { variant: to.variant, outcome: to.outcome, passed: to.passed, of: to.trials }, direction })
    }
  }
  return {
    record: 'workflow-eval-report', runner: RUNNER_VERSION, evalId: p.evalId, set: p.set, variants, rows, totals, flips, missing,
    integrity: found.filter((m) => m.integrity.length).map((m) => ({ trial: m.trialId, problems: m.integrity })),
    analysis: 'descriptive: counts and sums over counted trials, per task and variant and in total; a flip is a task whose outcome (every trial passed, none did, or some did) differs from the first variant\'s; no interval or test is computed, and a mixed outcome is noise to look at, never a win',
  }
}

const shown = (m: Metric): string => (m.unknown ? `${m.sum} (+${m.unknown} unknown)` : String(m.sum))

/** The report as Markdown, for the eval's record. */
export function renderReport(r: Report): string {
  const lines = [`# Workflow eval ${r.evalId}`, '', `Golden set ${r.set.id} v${r.set.version} (${r.set.hash}); variants ${r.variants.join(', ')}; runner ${r.runner}.`, '', '## Per task', '',
    '| Task | Variant | Passed | First time | Outcome | Review cycles | Touches | Tokens | Quota (pp) | Minutes |', '|---|---|---|---|---|---|---|---|---|---|']
  for (const x of r.rows) lines.push(`| ${x.caseId} | ${x.variant} | ${x.passed}/${x.trials} | ${x.passedFirstTime}/${x.trials} | ${x.outcome} | ${x.reviewCycles} | ${x.touches} | ${shown(x.tokens)} | ${shown(x.quotaPoints)} | ${shown(x.minutes)} |`)
  lines.push('', '## In total', '', '| Variant | Passed | First time | Mixed tasks | Review cycles | Touches | Tokens | Quota (pp) | Minutes |', '|---|---|---|---|---|---|---|---|---|')
  for (const t of r.totals) lines.push(`| ${t.variant} | ${t.passed}/${t.trials} | ${t.passedFirstTime}/${t.trials} | ${t.mixed} | ${t.reviewCycles} | ${t.touches} | ${shown(t.tokens)} | ${shown(t.quotaPoints)} | ${shown(t.minutes)} |`)
  lines.push('', '## Flips', '')
  if (!r.flips.length) lines.push(r.variants.length < 2 ? 'One variant: nothing to compare.' : 'No task flipped.')
  for (const f of r.flips) lines.push(`- ${f.caseId}: ${f.direction}, ${f.from.variant} ${f.from.outcome} (${f.from.passed}/${f.from.of}) → ${f.to.variant} ${f.to.outcome} (${f.to.passed}/${f.to.of})`)
  if (r.missing.length) lines.push('', '## Not run', '', r.missing.join(', '))
  if (r.integrity.length) {
    lines.push('', '## Not counted', '')
    for (const i of r.integrity) lines.push(`- ${i.trial}: ${i.problems.join('; ')}`)
  }
  lines.push('', r.analysis, '')
  return lines.join('\n')
}

// --- grade ---

/** How `grade` runs a command: its argv, directory, and extra environment; its exit code (null when it did not start), duration, and output. */
export type Exec = (argv: string[], cwd: string, env?: Record<string, string>) => { exit: number | null; seconds: number; output: string }
/** How `grade` reads a file of the grading worktree; undefined when it is absent. */
export type ReadFile = (path: string) => string | undefined

const realExec: Exec = (argv, cwd, env) => {
  const started = process.hrtime.bigint()
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } })
  return { exit: r.status, seconds: Number(process.hrtime.bigint() - started) / 1e9, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}
const realRead = (root: string): ReadFile => (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined)
const tailOf = (text: string): string => text.split('\n').filter((l) => l.trim()).slice(-20).join('\n').slice(-4000)

/** A file check of the grader, on the changed paths and the files of the result. */
export function fileCheck(c: Exclude<GraderCheck, { command: string }>, changed: string[], readFile: ReadFile): CheckResult {
  const result = (what: string, passed: boolean, tail: string): CheckResult => ({ id: c.id, what, passed, exit: null, seconds: 0, tail })
  if ('changed' in c) {
    const untouched = c.changed.filter((prefix) => !changed.some((f) => f === prefix || f.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)))
    return result(`changes ${c.changed.join(', ')}`, !untouched.length, untouched.length ? `not changed: ${untouched.join(', ')}` : '')
  }
  const text = readFile(c.path)
  if ('matches' in c) return result(`${c.path} matches /${c.matches}/m`, text !== undefined && new RegExp(c.matches, 'm').test(text), text === undefined ? `${c.path} is absent` : '')
  return result(`${c.path} lacks /${c.lacks}/m`, text === undefined || !new RegExp(c.lacks, 'm').test(text), '')
}

/**
 * Check one commit out in a worktree of the eval's own and run the task's grader there: the setup,
 * every check, then the hidden checks over the landed commit's paths. The worktree is removed after,
 * unless `keep`.
 */
export function gradeCommit(input: { setup: string[]; task: GoldenTask; repo: string; commit: string; at: string; keep?: boolean; exec?: Exec; readFile?: ReadFile }): Pick<Grade, 'fromBase' | 'setup' | 'checks' | 'hidden'> {
  const exec = input.exec ?? realExec
  const { task, repo, commit, at } = input
  const readFile = input.readFile ?? realRead(at)
  const git = (args: string[], cwd: string): string => {
    const r = exec(['git', ...args], cwd)
    if (r.exit !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} exited ${String(r.exit)}: ${tailOf(r.output)}`)
    return r.output.trim()
  }
  const fromBase = exec(['git', 'merge-base', '--is-ancestor', task.base, commit], repo).exit === 0
  const changed = git(['diff', '--name-only', '--no-renames', task.base, commit], repo).split('\n').filter(Boolean)
  git(['worktree', 'add', '--detach', at, commit], repo)
  const run = (id: string, command: string): CheckResult => {
    const argv = words(command.replaceAll('{base}', task.base))
    const r = exec(argv, at)
    return { id, what: argv.join(' '), passed: r.exit === 0, exit: r.exit, seconds: round2(r.seconds), tail: tailOf(r.output) }
  }
  try {
    const setup = input.setup.map((s, i) => run(`setup-${i + 1}`, s))
    if (setup.some((s) => !s.passed)) return { fromBase, setup, checks: [], hidden: null }
    // The file checks first, on the result as the run left it, before a grader command writes the tree.
    const files = task.grader.filter((c) => !isCommand(c)).map((c) => fileCheck(c as Exclude<GraderCheck, { command: string }>, changed, readFile))
    const commands = task.grader.filter(isCommand).map((c) => run(c.id, c.command))
    const checks = task.grader.map((c) => [...files, ...commands].find((r) => r.id === c.id)!)
    let hidden: CheckResult[] | null = null
    if (task.hidden) {
      git(['checkout', task.hidden.commit, '--', ...task.hidden.paths], at)
      hidden = task.hidden.commands.map((c) => run(c.id, c.command))
    }
    return { fromBase, setup, checks, hidden }
  } finally {
    if (!input.keep) git(['worktree', 'remove', '--force', at], repo)
  }
}

/**
 * Grade one attempt's exact result: snapshot the run's worktree as a commit through a private index
 * (the worktree, its index, and its branch are left as they are), then grade that commit.
 */
export function grade(input: { p: Plan; task: GoldenTask; note: TrialNote; repo: string; worktree: string; dir: string; keep?: boolean; exec?: Exec; readFile?: ReadFile }): Grade {
  const exec = input.exec ?? realExec
  const { note, worktree, dir } = input
  const runId = note.runs.at(-1)
  if (!runId) throw new Error(`trial ${note.trialId} has no exported run: export it first`)
  const env = {
    GIT_INDEX_FILE: join(dir, 'grade.index'),
    GIT_AUTHOR_NAME: 'workflow-eval', GIT_AUTHOR_EMAIL: 'workflow-eval@localhost', GIT_COMMITTER_NAME: 'workflow-eval', GIT_COMMITTER_EMAIL: 'workflow-eval@localhost',
  }
  const git = (args: string[]): string => {
    const r = exec(['git', ...args], worktree, env)
    if (r.exit !== 0) throw new Error(`git ${args.join(' ')} in ${worktree} exited ${String(r.exit)}: ${tailOf(r.output)}`)
    return r.output.trim()
  }
  git(['read-tree', 'HEAD'])
  git(['add', '--all'])
  const tree = git(['write-tree'])
  const commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', `workflow eval ${input.p.evalId} ${note.trialId}: the result of ${runId}`])
  const graded = gradeCommit({ setup: input.p.setup, task: input.task, repo: input.repo, commit, at: join(dir, 'grade'), exec, ...(input.keep ? { keep: true } : {}), ...(input.readFile ? { readFile: input.readFile } : {}) })
  return { trialId: note.trialId, runId, result: { commit, tree }, ...graded }
}

/** Whether a grader can tell: it must fail on the base and pass on a known-good result (the landed commit, or one after it). */
export function calibration(base: Pick<Grade, 'setup' | 'checks' | 'hidden'>, good: Pick<Grade, 'setup' | 'checks' | 'hidden'>): string[] {
  const all = (g: Pick<Grade, 'setup' | 'checks' | 'hidden'>): CheckResult[] => [...g.setup, ...g.checks, ...(g.hidden ?? [])]
  const problems: string[] = []
  if (base.setup.some((s) => !s.passed) || good.setup.some((s) => !s.passed)) problems.push('the setup failed: nothing was graded')
  else {
    if (all(base).every((c) => c.passed)) problems.push('every check passes on the base: the grader cannot tell a replay that changed nothing')
    const failing = all(good).filter((c) => !c.passed).map((c) => c.id)
    if (failing.length) problems.push(`on the known-good result ${failing.join(', ')} fail(s): the grader would fail the accepted change`)
  }
  return problems
}

// --- files and the system CLI ---

function system(args: string[]): unknown {
  return JSON.parse(execFileSync('system', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }))
}

/** Export one attempt's records into `<eval>/trials/<trialId>/runs/<runId>/` and add the run to the trial. */
export function exportRun(evalDir: string, trialId: string, runId: string): string {
  const trialDir = join(evalDir, 'trials', trialId)
  const notePath = join(trialDir, 'trial.json')
  if (!existsSync(notePath)) throw new Error(`trial ${trialId} was not prepared: run next first`)
  const dir = join(trialDir, 'runs', runId)
  mkdirSync(dir, { recursive: true })
  const events: EventLine[] = []
  for (let after = 0; ;) {
    const page = system(['events', '--json', '--run', runId, '--limit', '1000', '--after', String(after)]) as { events: EventLine[]; next: number }
    if (!page.events.length) break
    events.push(...page.events)
    after = page.next
  }
  write(join(dir, 'explain.json'), system(['explain', '--json', runId]))
  write(join(dir, 'events.json'), events)
  const note = read<TrialNote>(notePath)
  if (!note.runs.includes(runId)) write(notePath, { ...note, runs: [...note.runs, runId] })
  return dir
}

function measuredIn(evalDir: string, p: Plan, set: GoldenSet): Measurement[] {
  const trials = join(evalDir, 'trials')
  if (!existsSync(trials)) return []
  return readdirSync(trials).filter((d) => existsSync(join(trials, d, 'grade.json'))).map((d) => measure(p, set, readTrial(join(trials, d))))
}

const amounts = (text: string): Amounts => {
  const [tokens, quotaPoints, minutes] = text.split(':').map(Number)
  return { tokens: tokens ?? NaN, quotaPoints: quotaPoints ?? NaN, minutes: minutes ?? NaN }
}
const lineOf = (c: CheckResult): string => `${c.passed ? 'pass' : 'FAIL'} ${c.id}: ${c.what}${c.exit === null ? '' : ` (exit ${c.exit}, ${c.seconds} s)`}${c.passed || !c.tail ? '' : `\n  ${c.tail.split('\n').join('\n  ')}`}`

function main(argv: string[]): number {
  const [command, ...args] = argv
  const flag = (name: string): string => {
    const at = args.indexOf(name)
    if (at < 0 || !args[at + 1]) throw new Error(`${command ?? ''} needs ${name} <value>`)
    return args[at + 1]!
  }
  const set = loadSet()
  const variants = loadVariants()
  const evalDir = args[0] ? resolve(args[0]) : ''
  const loadPlan = (): Plan => {
    const p = read<Plan>(join(evalDir, 'plan.json'))
    const drift = planDrift(p, set, variants)
    if (drift.length) throw new Error(`the plan no longer binds the records:\n${drift.join('\n')}`)
    return p
  }
  switch (command) {
    case 'check': {
      const problems = setProblems(set, variants)
      console.log(problems.length ? problems.join('\n') : `ok: ${set.tasks.length} task(s), ${variants.variants.length} variant(s)`)
      return problems.length ? 1 : 0
    }
    case 'calibrate': {
      const task = set.tasks.find((t) => t.caseId === args[0])
      if (!task) throw new Error(`calibrate <caseId>: ${args[0] ?? 'none'} is not in the golden set`)
      const repo = resolve(flag('--repo'))
      const scratch = resolve(flag('--scratch'))
      const keep = args.includes('--keep') ? { keep: true } : {}
      const base = gradeCommit({ setup: set.setup, task, repo, commit: task.base, at: join(scratch, `${task.caseId}-base`), ...keep })
      const good = gradeCommit({ setup: set.setup, task, repo, commit: flag('--good'), at: join(scratch, `${task.caseId}-good`), ...keep })
      console.log(['on the base:', ...[...base.setup, ...base.checks, ...(base.hidden ?? [])].map(lineOf), 'on the known-good result:', ...[...good.setup, ...good.checks, ...(good.hidden ?? [])].map(lineOf)].join('\n'))
      const problems = calibration(base, good)
      console.log(problems.length ? `not calibrated:\n${problems.join('\n')}` : `calibrated: ${task.caseId}'s grader fails on its base and passes on the known-good result`)
      return problems.length ? 1 : 0
    }
    case 'plan': {
      if (existsSync(join(evalDir, 'plan.json'))) throw new Error(`${evalDir} already has a plan: a changed plan is a new eval`)
      const p = plan(set, variants, {
        evalId: evalDir.split('/').at(-1) ?? '', variants: flag('--variants').split(','), cases: flag('--tasks').split(','),
        repetitions: Number(flag('--repetitions')), seed: flag('--seed'), cap: amounts(flag('--cap')), reserve: amounts(flag('--reserve')), at: new Date(),
        ...(args.includes('--attempts') ? { attempts: Number(flag('--attempts')) } : {}), ...(args.includes('--project') ? { project: flag('--project') } : {}),
      })
      mkdirSync(evalDir, { recursive: true })
      write(join(evalDir, 'plan.json'), p)
      console.log(`planned ${p.trials.length} trial(s) in ${evalDir}; board project ${p.project}`)
      return 0
    }
    case 'next': {
      const p = loadPlan()
      const repo = resolve(flag('--repo'))
      const trials = join(evalDir, 'trials')
      const prepared = existsSync(trials) ? readdirSync(trials).filter((d) => existsSync(join(trials, d, 'trial.json'))) : []
      const next = nextTrial(p, prepared, measuredIn(evalDir, p, set))
      if ('refused' in next) {
        console.log(next.refused)
        return 1
      }
      const { trial } = next
      const task = set.tasks.find((t) => t.caseId === trial.caseId)!
      if (execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error(`the eval clone ${repo} holds uncommitted changes: it is the eval's own, never live work's`)
      execFileSync('git', ['-C', repo, 'checkout', '--detach', task.base], { stdio: 'inherit' })
      mkdirSync(join(trials, trial.trialId), { recursive: true })
      write(join(trials, trial.trialId, 'trial.json'), { ...trial, base: task.base, preparedAt: new Date().toISOString(), runs: [] } satisfies TrialNote)
      const v = variants.variants.find((x) => x.id === trial.variant)!
      console.log([
        `trial ${trial.trialId}: ${task.caseId} under ${v.id}, repetition ${trial.repetition}; the eval clone is at ${task.base}`,
        `configuration in force: ${v.configuration ?? 'the install as it is'}`,
        'board task (MCP board_propose):',
        JSON.stringify(boardTask(p, task, trial), null, 2),
        `then: system run ${task.template}${task.templateVariant ? ` --variant ${task.templateVariant}` : ''} --task <taskId> -   (the goal as the input, on stdin)`,
        `after each attempt: workflow-eval.ts export ${evalDir} ${trial.trialId} <runId>`,
      ].join('\n'))
      return 0
    }
    case 'export': {
      const [, trialId, runId] = args
      if (!trialId || !runId) throw new Error('export <eval> <trialId> <runId>')
      console.log(`exported ${exportRun(evalDir, trialId, runId)}; add usage.json (MCP resources_usage) and draws.json (its quota-draw records) beside it, and the trial's approvals.json`)
      return 0
    }
    case 'grade': {
      const p = loadPlan()
      const trialId = args[1]
      if (!trialId) throw new Error('grade <eval> <trialId> --repo <eval clone> --worktree <run worktree>')
      const dir = join(evalDir, 'trials', trialId)
      const note = read<TrialNote>(join(dir, 'trial.json'))
      const task = set.tasks.find((t) => t.caseId === note.caseId)!
      const g = grade({ p, task, note, repo: resolve(flag('--repo')), worktree: resolve(flag('--worktree')), dir, ...(args.includes('--keep') ? { keep: true } : {}) })
      write(join(dir, 'grade.json'), g)
      console.log([...g.setup, ...g.checks, ...(g.hidden ?? [])].map(lineOf).join('\n'))
      return 0
    }
    case 'report': {
      const p = loadPlan()
      const r = report(p, measuredIn(evalDir, p, set))
      write(join(evalDir, 'report.json'), r)
      writeFileSync(join(evalDir, 'report.md'), renderReport(r))
      console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : renderReport(r))
      return 0
    }
    default:
      console.error('usage: workflow-eval.ts check|calibrate|plan|next|export|grade|report … (see the file\'s header)')
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
