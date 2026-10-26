/**
 * Dispatch (PROP-0014 D1 and D2, ADR-0064; docs/design/workflow-engine.md#dispatch-starting-ready-work-by-itself):
 * the engine starts ready board tasks on free Workers chosen by quota, under the action class
 * `dispatch`, within recorded bounds.
 *
 * - **A pass** reads the board, the Workers, the ledger, the queue, and its own rows again, every
 *   `dispatch.sweepSeconds` and once at start: a restart is a pass, not a replay (INV-4). It takes the
 *   ready tasks of active projects that name a template the engine serves, oldest first. One
 *   allowance of `maxPerPass` a pass covers its settlement and its selection: each run admitted and
 *   each request newly opened is charged to it.
 * - **The Worker** of a task's writing step is chosen by `quotaScoreOf` (`quota-score@2`) among the
 *   Workers routing admits (`ctx.workers.candidates`, nothing reserved): the first free one. An unknown
 *   or stale reading, or a metered pool, is never free (INV-2, D65). It is chosen within the
 *   restriction routing will apply to that step (INV-6): when the attempt resumes the session of the
 *   one before it, that session's Worker, and when that Worker is not free the task is not started
 *   now ("waits for its session's Worker"). A start whose chosen Worker the step's restriction leaves
 *   out by the time it starts is refused before it takes the task, spending no attempt (T215).
 * - **The policy** for `dispatch` decides: `ask` opens one request bound to the task, its attempt, and
 *   the Worker (INV-5), recorded on a row before it is asked and adopted after a crash; an attempt the
 *   operator approved through the board's gate starts without a second button (D62); `auto` starts it
 *   with no request at all (D2), its `autonomy` decision the policy's word; `notify` does the same and
 *   records a notice (`workflow.dispatch.notice`, which the notifier tells); `forbid` starts nothing.
 * - **An approval** starts exactly that attempt on exactly that Worker, through the engine's own start
 *   (claim as the run, run first, then work), while the task is still ready at that attempt and the
 *   Worker still free, within `approvedHoldMinutes`; otherwise it is used for nothing, recorded. A row
 *   a crash left `starting` with no run admitted is checked again alike (INV-4). The step runs on
 *   that Worker or on none: refused at routing, it waits for it within the hold, then fails (engine.ts).
 * - **Bounds** (INV-9) count the rows of runs not finished and of asks open or approved, per project,
 *   account, repository, and in all, so approvals never exceed them; the starts of the last rolling hour,
 *   in all and per project (D2); a subject a task writes is held by one task at a time (INV-15).
 * - **Pauses** are the operator's, entirely or per project (D2), each a `gate` decision on a durable row.
 * - **Every start choice is a decision** (INV-13): `dispatch.select`, `dispatch.choice`, the policy's
 *   `autonomy`, and on D62 a `gate`; the run's `workflow.task-admission` names them.
 *
 * Everything is reached through seams: `ctx.board`, `ctx.workers`, `ctx.resources`, `ctx.approvals`.
 * Nothing here names a vendor, model, or tool (INV-11).
 */
import { type ApprovalRequest, ApprovalsError, type AutonomyVerdict, type Classification } from '@tsuuanmi/system-approvals-core'
import type { Board, BoardTask, Project, Subject } from '@tsuuanmi/system-board-core'
import { contentId, QUOTA_SCORE, type QuotaCandidate, type QuotaPool, quotaScoreOf, type QuotaSettings, type ScoredCandidate, windowName } from '@tsuuanmi/system-libs'
import type { PoolState } from '@tsuuanmi/system-resources-core'
import { type ArtifactRef, type Candidates, TIERS } from '@tsuuanmi/system-workers-core'
import {
  ADVISED_EVENT, type AdviceDetail, type Advisor, adviseInShadow, advisorProblems, advisorSettings, type AdvisorSettings, type CandidateFacts, featuresOf, LocalAdvisor, ModelAdvisor,
  modelAnswersOf, OutcomeHistory, QUESTION_SET, type ShadowAdvice,
} from './advisor.ts'
import type { Engine } from './engine.ts'
import { lookTierAtRisk } from './risk.ts'
import { type ResolvedNode, resolve } from './spec.ts'
import { admittedRestriction } from './teams.ts'
import { type Config, type DispatchConfig, newId, now, type TaskDispatch, WorkflowFailure } from './types.ts'

/** The rules a dispatch decision names (decision@1 `decider.id`), version 1. */
const SELECT = { type: 'rule', id: 'dispatch.select', version: '1' } as const
const CHOICE = { type: 'rule', id: 'dispatch.choice', version: '1' } as const
const APPROVAL = { type: 'rule', id: 'dispatch.approval', version: '1' } as const
const PAUSE = { type: 'operator', id: 'dispatch.pause', version: '1' } as const
/** The advisor's decision when it gave no advice (PROP-0015 J1); with advice, the decider is the model. */
const ADVISOR = { type: 'rule', id: 'advisor.dispatch', version: '1' } as const
const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }
/** Ready tasks one pass looks at, oldest first (INV-9; a decision lists at most 255 candidates). */
export const MAX_LOOKED = 128
/** Live asks one pass settles, oldest first (INV-9). */
const MAX_SETTLED = 64
/** Reasons one decision candidate gives at most (`decision@1`). */
const MAX_REASONS = 32
/** Candidates one decision lists at most (`decision@1`). */
const MAX_CANDIDATES = 255
/** The tasks the last pass keeps reasons for, shown by the status (INV-9). */
const MAX_REPORTED = 64
const LIVE = ['asking', 'asked', 'approved', 'starting'] as const
/** Starts the status lists as started by itself: those of the last 24 h, newest first (INV-9). */
const MAX_STARTED = 32
const HOUR_MS = 3_600_000
/** A project id a pause names (`common@1` id, at most 128 characters). */
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const projectKey = (projectId: string): string => `project:${projectId}`
/** A pause in words: all dispatch, or one project's. */
const pausedText = (p: { projectId?: string; since: string }): string => `the operator paused dispatch${p.projectId ? ` in project ${p.projectId}` : ''} at ${p.since}`

/** A dispatch's settings in force: the configuration's, each default filled from what `maxActiveRuns` leaves room for. */
export interface DispatchSettings {
  enabled: boolean
  sweepSeconds: number
  maxPerPass: number
  maxRunning: number
  maxRunningPerProject: number
  maxRunningPerAccount: number
  maxRunningPerRepository: number
  leaveRunsFree: number
  maxOpenAsks: number
  approvedHoldMinutes: number
  /** Starts in any rolling hour, in all and per project (D2). */
  maxPerHour: number
  maxPerHourPerProject: number
  /** The engine's own `maxActiveRuns`, which `leaveRunsFree` and `maxRunning` are bounded by. */
  maxActiveRuns: number
  /** The advisor asked in shadow at every choice (PROP-0015 J1; ./advisor.ts). */
  advisor: AdvisorSettings
}

const RANGES: Record<Exclude<keyof DispatchConfig, 'enabled' | 'maxRunning' | 'leaveRunsFree' | 'maxPerHourPerProject' | 'advisor'>, readonly [number, number, number]> = {
  sweepSeconds: [10, 3600, 60], maxPerPass: [1, 16, 2], maxRunningPerProject: [1, 16, 2], maxRunningPerAccount: [1, 16, 1],
  maxRunningPerRepository: [1, 16, 4], maxOpenAsks: [1, 32, 4], approvedHoldMinutes: [1, 240, 30], maxPerHour: [0, 120, 6],
}

/**
 * Every problem of the dispatch settings, by path (`dispatch.<key>`); empty when they load. A
 * configured value outside its range is a problem; `leaveRunsFree` is at most `maxActiveRuns − 1`, and
 * `maxRunning` at most `maxActiveRuns − leaveRunsFree`.
 */
export function dispatchProblems(config: Config): string[] {
  const given = config.dispatch ?? {}
  const problems: string[] = []
  const whole = (key: string, value: unknown, min: number, max: number): void => {
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < min || (value as number) > max)) problems.push(`dispatch.${key} must be a whole number from ${min} to ${max}, not ${JSON.stringify(value)}`)
  }
  if (given.enabled !== undefined && typeof given.enabled !== 'boolean') problems.push('dispatch.enabled must be true or false')
  for (const [key, [min, max]] of Object.entries(RANGES)) whole(key, given[key as keyof typeof RANGES], min, max)
  const active = config.maxActiveRuns ?? 16
  whole('leaveRunsFree', given.leaveRunsFree, 0, active - 1)
  const leave = given.leaveRunsFree ?? Math.min(4, active - 1)
  if (Number.isInteger(leave) && leave >= 0 && leave < active) whole('maxRunning', given.maxRunning, 1, active - leave)
  const hour = given.maxPerHour ?? RANGES.maxPerHour[2]
  if (Number.isInteger(hour) && hour >= 0 && hour <= RANGES.maxPerHour[1]) whole('maxPerHourPerProject', given.maxPerHourPerProject, 0, hour)
  problems.push(...advisorProblems(given.advisor))
  const known = new Set(['enabled', 'leaveRunsFree', 'maxRunning', 'maxPerHourPerProject', 'advisor', ...Object.keys(RANGES)])
  for (const key of Object.keys(given)) if (!known.has(key)) problems.push(`dispatch.${key} is not an option (${[...known].join(', ')})`)
  return problems
}

/** The settings in force, or a throw naming every problem with its path: a row with one is refused (INV-2). */
export function dispatchSettings(config: Config): DispatchSettings {
  const problems = dispatchProblems(config)
  if (problems.length) throw new Error(`workflow: ${problems.join('; ')}`)
  const given = config.dispatch ?? {}
  const active = config.maxActiveRuns ?? 16
  const leave = given.leaveRunsFree ?? Math.min(4, active - 1)
  const pick = (key: keyof typeof RANGES): number => given[key] ?? RANGES[key][2]
  return {
    enabled: given.enabled ?? true, sweepSeconds: pick('sweepSeconds'), maxPerPass: pick('maxPerPass'), maxRunning: given.maxRunning ?? Math.min(8, active - leave),
    maxRunningPerProject: pick('maxRunningPerProject'), maxRunningPerAccount: pick('maxRunningPerAccount'), maxRunningPerRepository: pick('maxRunningPerRepository'),
    leaveRunsFree: leave, maxOpenAsks: pick('maxOpenAsks'), approvedHoldMinutes: pick('approvedHoldMinutes'), maxPerHour: pick('maxPerHour'),
    maxPerHourPerProject: given.maxPerHourPerProject ?? Math.min(3, pick('maxPerHour')), maxActiveRuns: active, advisor: advisorSettings(given.advisor),
  }
}

type AskState = 'asking' | 'asked' | 'approved' | 'starting' | 'started' | 'closed'

/** One start the pass chose (`workflow_dispatch`), from its choice until its run started or it closed. */
interface AskRow {
  ask_id: string
  task_id: string
  /** The attempts the task had made when it was chosen (`n` of `dispatch:<task>:attempt:<n>`). */
  attempt: number
  project_id: string
  state: AskState
  worker: string
  account: string | null
  repository: string | null
  node_id: string
  version: string
  request_id: string | null
  run_id: string | null
  /** JSON {@link AskChoice}. */
  choice: string
  /** JSON {@link AskOutcome}, once closed. */
  outcome: string | null
  approved_at: string | null
  /** How it may start (D2): `ask` (the operator's go on its request), `board` (D62), `auto`, or `notify` (the policy's word, no request). */
  mode: DispatchMode
  /** When its run started, which the hourly bound counts. */
  started_at: string | null
  created_at: string
  updated_at: string
}

/** How a dispatched start was let start. */
export type DispatchMode = 'ask' | 'board' | 'auto' | 'notify'

/** A window of the chosen Worker's account, as Home shows it beside a proposed start. */
export interface DispatchWindow {
  pool: string
  window: string
  name: string
  seconds?: number
  used?: number
  headroom?: number
  reserve: number
  resets?: string
  observedAt?: string
}

/** What chose a start, kept on its row. */
interface AskChoice {
  template: string
  title: string
  /** The decisions, in order: select, choice, autonomy, then the approval (the queue's, or the board approval's gate). */
  decisions: ArtifactRef[]
  /** The policy's verdict, for the request (asked again after a crash). */
  verdict?: AutonomyVerdict
  /** Why that Worker, in one line (the score's). */
  why: string
  windows: DispatchWindow[]
  classification: Classification
  summary: string
  consequences: string
  /** D62: the board's own approved request for this attempt. */
  board?: { requestId: string; approval: ArtifactRef }
  /** The advisor's shadow decision on this choice (PROP-0015 J1), an input of the choice; never read to choose. */
  advice?: ArtifactRef
  /** The writing step's kind (ADR-0057), which its outcome is counted under. */
  kind?: string
}

/** Why an ask closed with no run, or that its run started. */
interface AskOutcome {
  status: 'started' | 'denied' | 'expired' | 'withdrawn' | 'policy-changed' | 'moved-on' | 'hold-expired' | 'unbound' | 'refused' | 'paused' | 'unknown-request' | 'not-asked'
  reason: string
  at: string
}

/** The operator's pause of dispatch, entirely or of one project (D2), kept on its durable row. */
export interface DispatchPause {
  /** The project paused; absent on a pause of all dispatch. */
  projectId?: string
  since: string
  reason?: string
  /** The operator's `gate` decision (rule `dispatch.pause`). */
  decision: ArtifactRef
}

/** What the last pass did: when, what it took, and each ready task it looked at with why. */
export interface DispatchPassView {
  at: string
  /** `ran`, or why it took nothing at all: `off`, `paused`, or `waiting` (a seam it needs is missing or failed). */
  state: 'ran' | 'off' | 'paused' | 'waiting'
  reason?: string
  /** What it took: `asked` for the operator's go; on an attempt already approved through the board's gate (D62), or under `auto` or `notify` (D2), `started`, or `approved` while its Worker is not free yet. */
  took: Array<{ askId: string; taskId: string; worker: string; how: 'asked' | 'started' | 'approved' }>
  tasks: Array<{ taskId: string; projectId: string; title: string; reason: string }>
  /** Ready tasks past the ones listed. */
  more: number
}

/** A start dispatch made (Home's *Started by itself*): its task, Worker, why that Worker, how it was let start, and its run's state now. */
export interface DispatchStarted {
  askId: string
  taskId: string
  title: string
  projectId: string
  attempt: number
  worker: string
  runId: string
  /** `running`, `completed`, `failed`, or `cancelled`; `unknown` when the run is no longer kept. */
  runStatus: string
  mode: DispatchMode
  why: string
  startedAt: string
  /** Under `notify`: the notice was recorded. */
  notice?: true
}

/** Dispatch as `dispatch_status`, Home, and `system dispatch` show it. */
export interface DispatchStatus {
  enabled: boolean
  settings: DispatchSettings
  paused?: DispatchPause
  /** The projects the operator paused dispatch in (D2), each with its own pause. */
  pausedProjects: DispatchPause[]
  lastPass?: DispatchPassView
  /** Each bound and how much of it is used now, counted from the engine's rows. */
  bounds: {
    running: { used: number; max: number }
    openAsks: { used: number; max: number }
    projects: Array<{ projectId: string; used: number; max: number }>
    accounts: Array<{ account: string; used: number; max: number }>
    repositories: Array<{ repository: string; used: number; max: number }>
    /** Active runs now, against what dispatch may fill (`maxActiveRuns − leaveRunsFree`). */
    engine: { active: number; max: number }
    /** Starts in the last rolling hour (D2), in all and per project. */
    hour: { used: number; max: number }
    hourProjects: Array<{ projectId: string; used: number; max: number }>
  }
  /** What dispatch started in the last 24 h, newest first, at most 32 (Home's *Started by itself*). */
  started: DispatchStarted[]
  /** The starts chosen and not yet started or closed: asking, asked (waiting for your go), approved (waiting for its Worker), starting. */
  asks: Array<{
    askId: string; taskId: string; title: string; projectId: string; attempt: number; state: AskState; worker: string; account?: string; repository?: string
    requestId?: string; why: string; windows: DispatchWindow[]; approvedAt?: string; decisions: ArtifactRef[]; createdAt: string
  }>
}

/** What one pass did, for its caller (the timer, a test, the tools). */
export interface DispatchPass extends DispatchPassView {}

/** The live counts the bounds read: rows of runs not finished and of asks open or approved. */
interface Counts {
  running: number
  open: number
  pending: number
  projects: Map<string, number>
  accounts: Map<string, number>
  repositories: Map<string, number>
  /** Subjects a live ask or a dispatched run not finished writes, with its task. */
  subjects: Map<string, string>
}

/**
 * What one pass may still start or ask (`maxPerPass`), shared by its settlement and its selection:
 * charged by each run admitted and each request newly opened, never by a row left waiting.
 */
interface Allowance {
  left: number
}

const subjectKey = (s: Subject): string => `${s.type}\0${s.ref}`
const bump = (map: Map<string, number>, key: string | null | undefined, by = 1): void => {
  if (key) map.set(key, (map.get(key) ?? 0) + by)
}
const bounded = (reasons: string[]): string[] => (reasons.length <= MAX_REASONS ? reasons : [...reasons.slice(0, MAX_REASONS - 1), `and ${reasons.length - MAX_REASONS + 1} more`])
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/** The dispatcher of one engine: its pass, its pause, and its status, all from the store and the seams. */
export class Dispatcher {
  readonly settings: DispatchSettings
  private passing: Promise<DispatchPass> | undefined
  /** The recorded outcomes the advisor's counts and the local adapter read. */
  readonly history: OutcomeHistory
  /** The advisor `dispatch.advisor.provider` names; undefined for `none`. */
  private readonly configured: Advisor | undefined
  /** Another provider set through `setDispatchAdvisor` ({@link setAdvisor}), in place of every other. */
  private swapped: Advisor | undefined
  /** When the advisor was asked in the last hour (INV-9: `dispatch.advisor.maxPerHour`). */
  private calls: number[] = []

  constructor(private readonly e: Engine) {
    this.settings = dispatchSettings(e.config)
    this.history = new OutcomeHistory(e)
    const a = this.settings.advisor
    this.configured = a.provider === 'local' ? new LocalAdvisor(() => this.history.training(), a.minLabelled, a.l2)
      : a.provider === 'model' && a.model ? new ModelAdvisor(e, a.model.worker, a.model.maxTokens) : undefined
  }

  /**
   * The thin path to the advisor seam (contract 1.11): `advisor` answers in place of the provider of
   * `ctx.dispatchAdvisor` and of the configured one, until set back with undefined. Its advice is
   * recorded in shadow like any other, and changes no choice.
   */
  setAdvisor(advisor: Advisor | undefined): void {
    this.swapped = advisor
  }

  /**
   * The advisor in force, asked at each choice (PROP-0015 J1): one set through {@link setAdvisor};
   * else the provider of the seam `ctx.dispatchAdvisor`, while a plugin registers one (contract 1.12);
   * else the one `dispatch.advisor.provider` names; else none.
   */
  private advisor(): Advisor | undefined {
    return this.swapped ?? this.e.ctx.get('dispatchAdvisor') ?? this.configured
  }

  /**
   * A Worker's quota window ended a step before it landed anything (T272b): the account is recorded
   * as exhausted until `until`, so no pass chooses it for that window again, and the task is not
   * taken again before then. Both are rows of `workflow_dispatch_control` (as the steps hold is), so
   * a restart keeps them (INV-4); a later reset replaces an earlier one, never the reverse.
   */
  exhaust(loss: { until: string; basis: string; account?: string; window?: string; taskId?: string }): void {
    const until = Date.parse(loss.until)
    this.e.ctx.store.transaction((db) => {
      const put = (id: string, value: { until: number; window?: string; basis: string }): void => {
        const old = this.closedRow(id)
        if (old && old.until >= value.until) return
        db.prepare('INSERT OR IGNORE INTO workflow_dispatch_control (id, updated_at) VALUES (?, ?)').run(id, now())
        db.prepare('UPDATE workflow_dispatch_control SET paused = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(value), now(), id)
      }
      if (loss.account) put(`quota-account:${loss.account}`, { until, basis: loss.basis, ...(loss.window ? { window: loss.window } : {}) })
      if (loss.taskId) put(`quota-task:${loss.taskId}`, { until, basis: loss.basis })
    })
  }

  /** A quota closure's row, as stored: until when (epoch ms), the window, and how the reset was known. */
  private closedRow(id: string): { until: number; window?: string; basis: string } | undefined {
    const row = this.e.ctx.store.db.prepare('SELECT paused FROM workflow_dispatch_control WHERE id = ?').get(id) as { paused: string | null } | undefined
    return row?.paused ? JSON.parse(row.paused) as { until: number; window?: string; basis: string } : undefined
  }

  /** Wait for a pass in flight, for a stop. */
  async close(): Promise<void> {
    await this.passing?.catch(() => undefined)
  }

  /**
   * One pass at `at` (a test seam; the timer passes the wall clock): settle the live asks, then take
   * ready tasks. One pass at a time in this process; a call while one runs returns that one.
   */
  sweep(at: Date = new Date()): Promise<DispatchPass> {
    if (this.passing) return this.passing
    // Never a rejection (the timer does not await it): a pass that throws starts nothing, logged.
    const running = this.pass(at).catch((error: unknown): DispatchPass => {
      this.e.ctx.logger.warn(`workflow: a dispatch pass failed and started nothing; the next pass tries again: ${errorText(error)}`)
      return { at: at.toISOString(), state: 'waiting', reason: `the pass failed: ${errorText(error)}`, took: [], tasks: [], more: 0 }
    }).finally(() => {
      if (this.passing === running) this.passing = undefined
    })
    this.passing = running
    return running
  }

  // --- the pause ---

  /**
   * The operator pauses dispatch entirely, or with `projectId` only in that project (D2; INV-6: from the
   * operator's channel only). Its open asks there are withdrawn at the next pass.
   */
  pause(reason?: string, projectId?: string): DispatchStatus {
    if (projectId !== undefined && !PROJECT_ID.test(projectId)) throw new Error('workflow: a project id is 1 to 128 letters, digits, and . _ : / -')
    if (this.pausedNow(projectId)) return this.status()
    const why = reason?.trim() ? reason.trim().slice(0, 500) : undefined
    const where = projectId ? ` in project ${projectId}` : ''
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `Does the operator pause dispatch${where}, so System asks for and starts no ready task${where} by itself?`, inputs: [],
      candidates: [
        { option: 'pause', selected: true, reasons: [`the operator paused dispatch${where}${why ? `: ${why}` : ''}`, `nothing${where} is asked or started by dispatch until it is resumed; open asks are withdrawn; the lead's and the operator's own starts go on`] },
        { option: 'run', selected: false, reasons: ['not run: the operator paused it'] },
      ],
      decider: PAUSE, outcome: { option: 'pause', detail: { ...(why ? { reason: why } : {}), ...(projectId ? { projectId } : {}) } }, ...(why ? { rationale: why } : {}), deterministic: false,
    }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
    const pause: DispatchPause = { ...(projectId ? { projectId } : {}), since: now(), ...(why ? { reason: why } : {}), decision }
    const id = projectId ? projectKey(projectId) : 'global'
    this.e.ctx.store.transaction((db) => {
      this.control(db, id)
      db.prepare('UPDATE workflow_dispatch_control SET paused = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(pause), now(), id)
      this.e.ctx.eventLog.append({ type: 'workflow.dispatch.paused', decision, data: { since: pause.since, ...(projectId ? { projectId } : {}) } })
    })
    return this.status()
  }

  /** The operator resumes dispatch, or with `projectId` dispatch in that project (D2). */
  resume(projectId?: string): DispatchStatus {
    const paused = this.pausedNow(projectId)
    if (!paused) return this.status()
    const where = projectId ? ` in project ${projectId}` : ''
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `Does the operator resume dispatch${where}?`, inputs: [paused.decision],
      candidates: [
        { option: 'run', selected: true, reasons: [`the operator resumed dispatch${where}, paused since ${paused.since}`] },
        { option: 'pause', selected: false, reasons: ['not pause: the operator resumed it'] },
      ],
      decider: PAUSE, outcome: { option: 'run', detail: { pausedSince: paused.since, ...(projectId ? { projectId } : {}) } }, deterministic: false,
    }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
    this.e.ctx.store.transaction((db) => {
      db.prepare('UPDATE workflow_dispatch_control SET paused = NULL, updated_at = ? WHERE id = ?').run(now(), projectId ? projectKey(projectId) : 'global')
      this.e.ctx.eventLog.append({ type: 'workflow.dispatch.resumed', decision, data: { pausedSince: paused.since, ...(projectId ? { projectId } : {}) } })
    })
    return this.status()
  }

  /** The pause of all dispatch, or with `projectId` that project's own. */
  private pausedNow(projectId?: string): DispatchPause | undefined {
    const row = this.e.ctx.store.db.prepare('SELECT paused FROM workflow_dispatch_control WHERE id = ?').get(projectId ? projectKey(projectId) : 'global') as { paused: string | null } | undefined
    return row?.paused ? JSON.parse(row.paused) as DispatchPause : undefined
  }

  /** Every project's own pause, by project. */
  private projectPauses(): Map<string, DispatchPause> {
    const rows = this.e.ctx.store.db.prepare("SELECT paused FROM workflow_dispatch_control WHERE id LIKE 'project:%' AND paused IS NOT NULL ORDER BY id").all() as Array<{ paused: string }>
    return new Map(rows.map((r) => JSON.parse(r.paused) as DispatchPause).filter((p) => p.projectId).map((p): [string, DispatchPause] => [p.projectId!, p]))
  }

  private control(db = this.e.ctx.store.db, id = 'global'): void {
    db.prepare('INSERT OR IGNORE INTO workflow_dispatch_control (id, updated_at) VALUES (?, ?)').run(id, now())
  }

  /**
   * The starts of the rolling hour before `at`, in all and per project, from the rows (INV-4: a restart
   * counts the same). With `pending`, the rows approved or starting count too: they are about to start.
   */
  private hourly(at: Date, pending: boolean): { total: number; projects: Map<string, number> } {
    const since = new Date(at.getTime() - HOUR_MS).toISOString()
    const rows = this.e.ctx.store.db.prepare(`SELECT project_id FROM workflow_dispatch WHERE (state = 'started' AND started_at > ?)${pending ? " OR state IN ('approved', 'starting')" : ''}`).all(since) as Array<{ project_id: string }>
    const projects = new Map<string, number>()
    for (const r of rows) bump(projects, r.project_id)
    return { total: rows.length, projects }
  }

  /** Why the hour leaves no room for one more start in `projectId`, or undefined. */
  private hourFull(hour: { total: number; projects: Map<string, number> }, projectId: string): string | undefined {
    const s = this.settings
    if (hour.total >= s.maxPerHour) return `${hour.total} start(s) in the last hour already (dispatch.maxPerHour ${s.maxPerHour})`
    const mine = hour.projects.get(projectId) ?? 0
    if (mine >= s.maxPerHourPerProject) return `project ${projectId} had ${mine} start(s) in the last hour already (dispatch.maxPerHourPerProject ${s.maxPerHourPerProject})`
    return undefined
  }

  // --- the status ---

  /** Where dispatch stands, from the engine's rows only (a restart shows the same). */
  status(): DispatchStatus {
    const db = this.e.ctx.store.db
    const control = db.prepare("SELECT paused, last_pass FROM workflow_dispatch_control WHERE id = 'global'").get() as { paused: string | null; last_pass: string | null } | undefined
    const counts = this.counts()
    const s = this.settings
    const live = db.prepare(`SELECT * FROM workflow_dispatch WHERE state IN (${LIVE.map(() => '?').join(', ')}) ORDER BY created_at, ask_id`).all(...LIVE) as unknown as AskRow[]
    const at = new Date()
    const hour = this.hourly(at, false)
    const started = db.prepare(`SELECT d.*, r.status AS run_status FROM workflow_dispatch d LEFT JOIN workflow_runs r ON r.run_id = d.run_id
      WHERE d.state = 'started' AND d.started_at > ? ORDER BY d.started_at DESC, d.ask_id LIMIT ?`).all(new Date(at.getTime() - 24 * HOUR_MS).toISOString(), MAX_STARTED) as unknown as Array<AskRow & { run_status: string | null }>
    return {
      enabled: s.enabled, settings: s,
      ...(control?.paused ? { paused: JSON.parse(control.paused) as DispatchPause } : {}),
      pausedProjects: [...this.projectPauses().values()],
      ...(control?.last_pass ? { lastPass: JSON.parse(control.last_pass) as DispatchPassView } : {}),
      bounds: {
        running: { used: counts.running, max: s.maxRunning }, openAsks: { used: counts.open, max: s.maxOpenAsks },
        projects: [...counts.projects].sort().map(([projectId, used]) => ({ projectId, used, max: s.maxRunningPerProject })),
        accounts: [...counts.accounts].sort().map(([account, used]) => ({ account, used, max: s.maxRunningPerAccount })),
        repositories: [...counts.repositories].sort().map(([repository, used]) => ({ repository, used, max: s.maxRunningPerRepository })),
        engine: { active: this.active(), max: s.maxActiveRuns - s.leaveRunsFree },
        hour: { used: hour.total, max: s.maxPerHour },
        hourProjects: [...hour.projects].sort().map(([projectId, used]) => ({ projectId, used, max: s.maxPerHourPerProject })),
      },
      started: started.map((row): DispatchStarted => {
        const choice = JSON.parse(row.choice) as AskChoice
        return {
          askId: row.ask_id, taskId: row.task_id, title: choice.title, projectId: row.project_id, attempt: row.attempt + 1, worker: row.worker, runId: row.run_id!,
          runStatus: row.run_status ?? 'unknown', mode: row.mode, why: choice.why, startedAt: row.started_at!, ...(row.mode === 'notify' ? { notice: true as const } : {}),
        }
      }),
      asks: live.map((row) => {
        const choice = JSON.parse(row.choice) as AskChoice
        return {
          askId: row.ask_id, taskId: row.task_id, title: choice.title, projectId: row.project_id, attempt: row.attempt + 1, state: row.state, worker: row.worker,
          ...(row.account ? { account: row.account } : {}), ...(row.repository ? { repository: row.repository } : {}), ...(row.request_id ? { requestId: row.request_id } : {}),
          why: choice.why, windows: choice.windows, ...(row.approved_at ? { approvedAt: row.approved_at } : {}), decisions: choice.decisions, createdAt: row.created_at,
        }
      }),
    }
  }

  /** The runs that execute now (not only waiting on a person), as the engine's own bound counts them. */
  private active(): number {
    const { total, waiting } = this.e.ctx.store.db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(
        EXISTS (SELECT 1 FROM workflow_nodes n WHERE n.run_id = r.run_id AND n.state = 'BLOCKED')
        AND NOT EXISTS (SELECT 1 FROM workflow_nodes n WHERE n.run_id = r.run_id AND n.state IN ('READY', 'RUNNING'))), 0) AS waiting
      FROM workflow_runs r WHERE r.status = 'running'`).get() as { total: number; waiting: number }
    return total - waiting
  }

  /**
   * The bounds' counts, from the rows (INV-4: a restart counts the same): dispatched runs not finished,
   * and asks open, approved, or starting, which would be runs; per project, account, and repository;
   * the subjects they write. `except` leaves one ask out (it is being started).
   */
  private counts(except?: string): Counts {
    const rows = this.e.ctx.store.db.prepare(`SELECT d.*, t.writes AS writes FROM workflow_dispatch d
      LEFT JOIN workflow_runs r ON r.run_id = d.run_id LEFT JOIN workflow_tasks t ON t.run_id = d.run_id
      WHERE d.state IN ('asking', 'asked', 'approved', 'starting') OR (d.state = 'started' AND r.status = 'running')`).all() as unknown as Array<AskRow & { writes: string | null }>
    const counts: Counts = { running: 0, open: 0, pending: 0, projects: new Map(), accounts: new Map(), repositories: new Map(), subjects: new Map() }
    for (const row of rows) {
      if (row.ask_id === except) continue
      counts.running += 1
      if (row.state === 'asking' || row.state === 'asked') counts.open += 1
      if (row.state === 'approved' || row.state === 'starting') counts.pending += 1
      bump(counts.projects, row.project_id)
      bump(counts.accounts, row.account ?? `worker:${row.worker}`)
      bump(counts.repositories, row.repository)
      const writes = row.writes ? JSON.parse(row.writes) as Subject : (JSON.parse(row.choice) as AskChoice & { writes?: Subject }).writes
      if (writes) counts.subjects.set(subjectKey(writes), row.task_id)
    }
    return counts
  }

  // --- the pass ---

  private async pass(at: Date): Promise<DispatchPass> {
    const view: DispatchPass = { at: at.toISOString(), state: 'ran', took: [], tasks: [], more: 0 }
    if (!this.settings.enabled) return { ...view, state: 'off', reason: 'dispatch.enabled is false: nothing is asked or started' }
    if (this.e.stopped.signal.aborted) return { ...view, state: 'waiting', reason: 'the engine is stopping' }
    const board = this.e.board
    if (!board) return this.keep({ ...view, state: 'waiting', reason: 'no board is loaded (ctx.board): nothing is dispatched' })
    // One allowance for the whole pass: settlement's starts and selection's starts and new asks all count against it.
    const allowance: Allowance = { left: this.settings.maxPerPass }
    try {
      await this.settle(board, at, allowance)
    } catch (error) {
      this.e.ctx.logger.warn(`workflow: dispatch could not settle its asks; the next pass tries again: ${errorText(error)}`)
    }
    const paused = this.pausedNow()
    if (paused) return this.keep({ ...view, state: 'paused', reason: `${pausedText(paused)}${paused.reason ? `: ${paused.reason}` : ''} (decision ${paused.decision})` })
    if (this.e.draining) return this.keep({ ...view, state: 'waiting', reason: 'the host is draining: no run is admitted' })
    const approvals = this.e.ctx.get('approvals')
    const resources = this.e.ctx.get('resources')
    const missing = !approvals ? 'no approval queue is loaded (ctx.approvals): nothing is dispatched (board rule 7)'
      : !resources ? 'no resource ledger is loaded (ctx.resources): no Worker can be shown free'
        : !resources.quota ? 'the resource ledger gives no quota settings (contract 1.2): no reserve can be kept, so no Worker is free'
          : !this.e.ctx.workers.candidates ? 'the router cannot list candidates (ctx.workers.candidates): no Worker can be shown free' : undefined
    if (missing) return this.keep({ ...view, state: 'waiting', reason: missing })
    try {
      return this.keep(await this.select(board, at, view, allowance))
    } catch (error) {
      return this.keep({ ...view, state: 'waiting', reason: `the pass failed and starts nothing; the next pass tries again: ${errorText(error)}` })
    }
  }

  /** Keep the pass as the last one (its reasons for each task), on the durable row. */
  private keep(view: DispatchPass): DispatchPass {
    try {
      this.e.ctx.store.transaction((db) => {
        this.control(db)
        db.prepare("UPDATE workflow_dispatch_control SET last_pass = ?, updated_at = ? WHERE id = 'global'").run(JSON.stringify(view), now())
      })
    } catch (error) {
      this.e.ctx.logger.warn(`workflow: dispatch could not keep its last pass: ${errorText(error)}`)
    }
    return view
  }

  /** Take the ready tasks of active projects, oldest first, within the bounds. */
  private async select(board: Board, at: Date, view: DispatchPass, allowance: Allowance): Promise<DispatchPass> {
    const s = this.settings
    const projects = await board.projects()
    const ready: Array<{ task: BoardTask; project: Project }> = []
    // Subjects held by a task claimed, running, or in review, in any project not closed (board rule 6).
    const holders = new Map<string, string>()
    for (const project of projects.filter((p) => p.state !== 'closed')) {
      for (const task of await board.tasks({ projectId: project.projectId, states: ['ready', 'claimed', 'running', 'review'] })) {
        if (task.state === 'ready') {
          if (project.state === 'active') ready.push({ task, project })
        } else if (task.writes) holders.set(subjectKey(task.writes), task.taskId)
      }
    }
    ready.sort((a, b) => (a.task.createdAt < b.task.createdAt ? -1 : a.task.createdAt > b.task.createdAt ? 1 : a.task.taskId < b.task.taskId ? -1 : a.task.taskId > b.task.taskId ? 1 : 0))
    const looked = ready.slice(0, MAX_LOOKED)
    view.more = ready.length - looked.length
    if (!looked.length) return view
    const counts = this.counts()
    const engineRoom = s.maxActiveRuns - s.leaveRunsFree
    const reasons = new Map<string, string>()
    const taken = new Map<string, ArtifactRef>()
    const pools = await this.pools(at)
    const settings = this.e.ctx.get('resources')!.quota!()
    const verdicts = new Map<string, AutonomyVerdict | { error: string }>()
    const looks = new Map<string, Candidates | { error: string }>()
    const projectPaused = this.projectPauses()
    // The starts of the last hour, and those approved about to start (D2).
    const hour = this.hourly(at, true)
    for (const [index, { task, project }] of looked.entries()) {
      const n = task.attempts.count
      const why = (reason: string): void => {
        reasons.set(task.taskId, reason)
      }
      const live = this.liveAsk(task.taskId, n)
      if (live) {
        why(live.state === 'approved' ? `approved, waiting for ${live.worker} to be free (ask ${live.ask_id})` : `an ask for attempt ${n + 1} is ${live.state === 'starting' ? 'starting its run' : `open (ask ${live.ask_id}${live.request_id ? `, request ${live.request_id}` : ''})`}`)
        continue
      }
      const held = projectPaused.get(project.projectId)
      if (held) {
        why(`you paused dispatch in project ${project.projectId} at ${held.since}${held.reason ? `: ${held.reason}` : ''} (decision ${held.decision}); the lead and you still start its tasks by hand`)
        continue
      }
      const until = this.closedRow(`quota-task:${task.taskId}`)?.until
      if (until !== undefined && until > at.getTime()) {
        why(`a Worker's quota ran out under its last attempt, which was not spent: it is not taken before ${new Date(until).toISOString()}`)
        continue
      }
      const denied = this.denied(task.taskId, n)
      if (denied) {
        why(`dispatch does not ask again for attempt ${n + 1}: ${denied}; the lead or you may still start it by hand`)
        continue
      }
      if (!task.template) {
        why('it names no template, so dispatch cannot start it (the lead starts it with a template it chooses)')
        continue
      }
      if (!Object.hasOwn(this.e.templates, task.template)) {
        why(`it names template ${task.template}, which the engine does not serve now${this.e.refused.has(task.template) ? ` (refused at load: ${this.e.refused.get(task.template)})` : ''}`)
        continue
      }
      if (allowance.left <= 0) {
        why(`this pass took its ${s.maxPerPass} (dispatch.maxPerPass); a later pass looks again`)
        continue
      }
      const full = this.hourFull(hour, project.projectId)
      if (full) {
        why(`${full}: dispatch starts nothing more until the hour leaves room (INV-9)`)
        continue
      }
      if (counts.running >= s.maxRunning) {
        why(`${counts.running} dispatched run(s) and ask(s) already (dispatch.maxRunning ${s.maxRunning})`)
        continue
      }
      if ((counts.projects.get(project.projectId) ?? 0) >= s.maxRunningPerProject) {
        why(`project ${project.projectId} has ${counts.projects.get(project.projectId)} dispatched run(s) and ask(s) (dispatch.maxRunningPerProject ${s.maxRunningPerProject})`)
        continue
      }
      const engineActive = this.active() + counts.pending
      if (engineActive >= engineRoom) {
        why(`${engineActive} run(s) execute or are about to; dispatch fills at most ${engineRoom} (maxActiveRuns ${s.maxActiveRuns} less dispatch.leaveRunsFree ${s.leaveRunsFree}, kept for the lead's and your own starts)`)
        continue
      }
      if (task.writes) {
        const holder = holders.get(subjectKey(task.writes)) ?? counts.subjects.get(subjectKey(task.writes))
        if (holder && holder !== task.taskId) {
          why(`task ${holder} holds the subject it writes (${task.writes.type} ${task.writes.ref}): one task at a time writes a subject (board rule 6, INV-15)`)
          continue
        }
      }
      // The run's writing step, and the requirement the engine would route it with (INV-6).
      const step = this.writingStep(task.template)
      if ('problem' in step) {
        why(step.problem)
        continue
      }
      const classification = project.classification ?? this.e.ctx.egress.defaultClassification
      const own = this.e.requirementOf(step.node, step.node.session.persist === true, classification)
      // At the tier the engine will route it at: its task's risk tier may set it (ADR-0073; looked at only, the engine records it).
      const atRisk = await lookTierAtRisk(this.e, { taskId: task.taskId, projectId: project.projectId }, step.node, own)
      // Its tier unknown, it is not scored at its template's (INV-2).
      if (atRisk && 'problem' in atRisk) {
        why(atRisk.problem)
        continue
      }
      const requirement = atRisk?.requirement ?? own
      // The restriction routing will apply to that step (INV-6): the session its run would resume
      // stays on its Worker, and any other the engine derives. The Worker is chosen within it.
      const bound = await this.restrictionOf(task, task.template, step.node.nodeId, classification)
      if ('problem' in bound) {
        why(bound.problem)
        continue
      }
      const key = JSON.stringify(requirement)
      if (!looks.has(key)) looks.set(key, await this.e.ctx.workers.candidates!(requirement, { producer: 'workflow' }).catch((error: unknown) => ({ error: errorText(error) })))
      const look = looks.get(key)!
      if ('error' in look) {
        why(`the Workers could not be read, so none can be shown free: ${look.error}`)
        continue
      }
      const scored = this.score(look, pools, settings, counts, at, bound.restrict)
      if (!scored.score.chosen && bound.session && bound.restrict) {
        // Its run would resume a session that stays on its Worker: only that Worker takes it, and the
        // task is not started now rather than on a Worker its step could never route to.
        const mine = scored.score.candidates.filter((c) => bound.restrict!.workers.includes(c.worker)).slice(0, 4)
        const lines = mine.map((c) => `${c.worker}: ${c.reasons.filter((r) => r.startsWith('not free: ') || r.startsWith('refused by routing: ')).map((r) => r.replace(/^not free: /, '')).join(', ') || 'not listed'}`)
        why(`waits for its session's Worker: step ${step.node.nodeId} continues session ${bound.session}, and ${bound.restrict.reason} (${bound.restrict.workers.join(', ')}), which is not free now${lines.length ? `; ${lines.join('; ')}` : ''}; no other Worker takes it`.slice(0, 2000))
        continue
      }
      if (!scored.score.chosen) {
        // Each of the first admitted Workers, with every reason it is not free (bounded: the decision of a take lists them all).
        const lines = scored.score.candidates.filter((c) => c.admitted).slice(0, 4).map((c) => `${c.worker}: ${c.reasons.filter((r) => r.startsWith('not free: ')).map((r) => r.slice(10)).join(', ')}`)
        why(`no Worker is free for step ${step.node.nodeId} (${scored.score.candidates.filter((c) => c.admitted).length} admitted${lines.length ? `; ${lines.join('; ')}` : ''})`.slice(0, 2000))
        continue
      }
      // The policy, once per project per pass (its `autonomy` decision is the choice's input).
      if (!verdicts.has(project.projectId)) verdicts.set(project.projectId, await this.e.ctx.get('approvals')!.check({ class: 'dispatch', projectId: project.projectId }).catch((error: unknown) => ({ error: errorText(error) })))
      const verdict = verdicts.get(project.projectId)!
      if ('error' in verdict) {
        why(`the approval queue could not judge dispatch in project ${project.projectId}: ${verdict.error}`)
        continue
      }
      if (verdict.mode === 'forbid') {
        why(`the policy forbids dispatch in project ${project.projectId} (decision ${verdict.decision}); the lead and you still start its tasks by hand`)
        continue
      }
      const byBoard = await this.boardApproval(task)
      // D2: under auto or notify the policy's verdict is the go; nothing is asked (no request, no queue entry).
      const self = byBoard ? undefined : verdict.mode === 'auto' || verdict.mode === 'notify' ? verdict.mode : undefined
      const mode: DispatchMode = byBoard ? 'board' : self ?? 'ask'
      if (mode === 'ask' && counts.open >= s.maxOpenAsks) {
        why(`${counts.open} ask(s) already wait for your go (dispatch.maxOpenAsks ${s.maxOpenAsks})`)
        continue
      }
      // Taken: the decisions first (INV-13), then the row, then the ask or the start.
      const chosen = scored.score.candidates.find((c) => c.worker === scored.score.chosen)!
      const others = looked.map(({ task: t }, i) => {
        if (t.taskId === task.taskId) return { option: t.taskId, selected: true, reasons: [this.takenWhy(task, n, chosen, mode, project.projectId)] }
        const earlier = taken.get(t.taskId)
        return {
          option: t.taskId, selected: false,
          reasons: [earlier ? `taken by this pass already (decision ${earlier})` : i > index ? `after ${task.taskId} in the order (the oldest ready task first)` : reasons.get(t.taskId) ?? `after ${task.taskId} in the order`],
        }
      })
      const select = this.e.ctx.artifacts.recordDecision({
        decisionType: 'admission',
        question: `Which ready board task does dispatch take next (pass at ${view.at}, ${s.maxPerPass - allowance.left + 1} of at most ${s.maxPerPass}, settlement's starts counted)?`,
        inputs: [],
        candidates: others.slice(0, MAX_CANDIDATES),
        decider: SELECT,
        outcome: { option: task.taskId, detail: { taskId: task.taskId, projectId: project.projectId, attempt: n, order: 'age' } },
        deterministic: true,
      }, PRODUCER).id as ArtifactRef
      // The advisor, in shadow (PROP-0015 J1): asked after the choice is made, recorded as its input, never read to choose.
      const advice = await this.advise(task, n, task.template, step.node, scored, settings, select, look)
      const choice = this.choiceDecision(task, n, step.node.nodeId, scored, select, verdict, look, settings, advice)
      const decisions = [select, choice.decision, verdict.decision]
      let approval: ArtifactRef | undefined
      if (byBoard) {
        approval = this.e.ctx.artifacts.recordDecision({
          decisionType: 'gate',
          question: `Does the operator's approval of attempt ${n + 1} of board task ${task.taskId} through the board's gate count as its dispatch approval?`,
          inputs: [byBoard.decision, ...(byBoard.approval ? [byBoard.approval] : []), choice.decision],
          candidates: [
            { option: 'board-approval', selected: true, reasons: [`the operator approved attempt ${n + 1} on the board's request ${byBoard.requestId} (approval ${byBoard.approval}), which counts as its dispatch approval (D62)`, `it starts on ${chosen.worker} without a second button`] },
            { option: 'ask', selected: false, reasons: [`not ask: the operator already said attempt ${n + 1} may run (D62)`] },
          ],
          decider: APPROVAL,
          outcome: { option: 'board-approval', detail: { taskId: task.taskId, attempt: n, requestId: byBoard.requestId, worker: chosen.worker } },
          deterministic: true,
        }, PRODUCER).id as ArtifactRef
        decisions.push(approval)
      }
      const askId = newId('dsp')
      const go = mode !== 'ask'
      const row: AskRow = {
        ask_id: askId, task_id: task.taskId, attempt: n, project_id: project.projectId, state: go ? 'approved' : 'asking', worker: chosen.worker,
        account: scored.accountOf.get(chosen.worker) ?? null, repository: scored.repositoryOf.get(chosen.worker) ?? null, node_id: step.node.nodeId, version: choice.version,
        request_id: null, run_id: null, outcome: null, approved_at: go ? now() : null, mode, started_at: null, created_at: now(), updated_at: now(),
        choice: JSON.stringify({
          template: task.template, title: task.title, decisions, verdict, why: chosen.line, windows: choice.windows, classification,
          summary: choice.summary, consequences: choice.consequences, ...(task.writes ? { writes: task.writes } : {}),
          ...(advice ? { advice } : {}), ...(step.node.kind !== undefined ? { kind: step.node.kind } : {}),
          ...(byBoard ? { board: { requestId: byBoard.requestId, approval: byBoard.approval ?? byBoard.decision } } : {}),
        } satisfies AskChoice & { writes?: Subject }),
      }
      try {
        this.e.ctx.store.transaction((db) => {
          db.prepare(`INSERT INTO workflow_dispatch (ask_id, task_id, attempt, project_id, state, worker, account, repository, node_id, version, request_id, run_id, choice, outcome, approved_at, mode, started_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL, ?, ?)`)
            .run(row.ask_id, row.task_id, row.attempt, row.project_id, row.state, row.worker, row.account, row.repository, row.node_id, row.version, row.choice, row.approved_at, row.mode, row.created_at, row.updated_at)
          this.e.ctx.eventLog.append({ type: 'workflow.dispatch.chosen', decision: choice.decision, data: { askId, taskId: task.taskId, attempt: n, worker: chosen.worker, how: byBoard ? 'board-approval' : mode } })
        })
      } catch (error) {
        // Another pass (another process) holds a live ask for this attempt: it is that one's.
        why(`another pass holds an ask for attempt ${n + 1}: ${errorText(error)}`)
        continue
      }
      taken.set(task.taskId, select)
      counts.running += 1
      bump(counts.projects, project.projectId)
      bump(counts.accounts, row.account ?? `worker:${row.worker}`)
      bump(counts.repositories, row.repository)
      if (task.writes) counts.subjects.set(subjectKey(task.writes), task.taskId)
      if (go) {
        counts.pending += 1
        // About to start: it counts in the hour from now (started, or approved and waiting for its Worker).
        hour.total += 1
        bump(hour.projects, project.projectId)
        // Its start counts against the pass's allowance (tryStart charges it once a run is admitted).
        await this.tryStart(board, this.ask(askId)!, at, undefined, allowance)
        const started = this.ask(askId)?.state === 'started'
        // Started, it is a running run now, which the engine's own count holds.
        if (started) counts.pending -= 1
        const how = byBoard ? 'approved through the board\'s gate (D62)' : `started by itself: the policy gives dispatch ${mode} in project ${project.projectId}, so nothing is asked${mode === 'notify' ? ', and a notice is recorded' : ''}`
        why(`taken: attempt ${n + 1} on ${chosen.worker}, ${how}${started ? '; its run started' : '; it starts once its Worker is free'}`)
        view.took.push({ askId, taskId: task.taskId, worker: chosen.worker, how: started ? 'started' : 'approved' })
      } else {
        counts.open += 1
        why(`taken: asks for your go to start attempt ${n + 1} on ${chosen.worker}`)
        view.took.push({ askId, taskId: task.taskId, worker: chosen.worker, how: 'asked' })
        // A request newly opened is charged inside request(), before its row's record.
        await this.request(this.ask(askId)!, allowance)
      }
    }
    view.tasks = looked.slice(0, MAX_REPORTED).map(({ task, project }) => ({ taskId: task.taskId, projectId: project.projectId, title: task.title, reason: reasons.get(task.taskId) ?? 'not looked at' }))
    view.more += Math.max(0, looked.length - MAX_REPORTED)
    return view
  }

  private takenWhy(task: BoardTask, n: number, chosen: ScoredCandidate, mode: DispatchMode, projectId: string): string {
    const how = mode === 'board' ? `; attempt ${n + 1} was approved through the board's gate (D62)`
      : mode === 'ask' ? '' : `; the policy gives dispatch ${mode} in project ${projectId}, so it starts with nothing asked (PROP-0014 D2)`
    return `the oldest ready task within every bound, its writing step's Worker ${chosen.worker} free (${chosen.line})${how}`
  }

  /**
   * The run's writing step: its first Worker step that proves `develop`, else its first Worker step
   * (a team's tally and decision, a review's source, and a gate run no Worker).
   */
  private writingStep(template: string): { node: ResolvedNode } | { problem: string } {
    let spec
    try {
      spec = resolve(template, this.e.templates[template]!, {})
    } catch (error) {
      return { problem: `template ${template} does not resolve: ${errorText(error)}` }
    }
    const workers = spec.nodes.filter((n) => (n.executor ?? 'worker') === 'worker')
    const node = workers.find((n) => n.capabilities.includes('develop')) ?? workers[0]
    return node ? { node } : { problem: `template ${template} has no Worker step, so no Worker can be chosen for it` }
  }

  /**
   * The restriction routing will apply to the first execution of a task's writing step `nodeId`,
   * were its run started now (INV-6; ADR-0064): its template resolved with the session the run would
   * resume (`TaskRuns.resumes`), as the start resolves it, then the engine's own `restriction`.
   * `session` names that session; a `problem` is why the step could not be routed at all.
   */
  private async restrictionOf(task: BoardTask, template: string, nodeId: string, classification: Classification): Promise<{ restrict?: { workers: string[]; reason: string }; session?: string } | { problem: string }> {
    let spec
    try {
      spec = resolve(template, this.e.templates[template]!, {})
      const session = await this.e.tasks.resumes(task, template, spec.nodes)
      if (session) spec = resolve(template, this.e.templates[template]!, { sessionId: session })
      const node = spec.nodes.find((n) => n.nodeId === nodeId)
      if (!node) return {}
      const bound = await admittedRestriction(this.e, `dispatch:${task.taskId}`, node, classification)
      if ('problem' in bound) return { problem: `step ${nodeId} could not be routed if it started now: ${bound.problem}` }
      return { ...(bound.restrict ? { restrict: bound.restrict } : {}), ...(session ? { session } : {}) }
    } catch (error) {
      return { problem: `the Workers step ${nodeId} may take could not be told, so none is chosen: ${errorText(error)}` }
    }
  }

  /** Every pool on the ledger by account, or why they could not be read (then no Worker is free). */
  private async pools(at: Date): Promise<Map<string, PoolState[]> | { unknown: string }> {
    try {
      const pools = await this.e.ctx.get('resources')!.pools({}, at)
      const by = new Map<string, PoolState[]>()
      for (const p of pools) by.set(p.account, [...(by.get(p.account) ?? []), p])
      return by
    } catch (error) {
      return { unknown: `the resource ledger could not be read: ${errorText(error)}` }
    }
  }

  /**
   * The score of the candidates for one requirement, with what the caller knows of each Worker. A
   * Worker outside `restrict` (the restriction routing will apply to the step, INV-6) is refused, as
   * routing would refuse it, so it is never chosen.
   */
  private score(look: Candidates, pools: Map<string, PoolState[]> | { unknown: string }, settings: QuotaSettings, counts: Counts, at: Date, restrict?: { workers: string[]; reason: string }): { score: ReturnType<typeof quotaScoreOf>; inputs: QuotaCandidate[]; accountOf: Map<string, string>; repositoryOf: Map<string, string> } {
    const s = this.settings
    const accountOf = new Map<string, string>()
    const repositoryOf = new Map<string, string>()
    const running = this.runningSteps()
    const rank = (list: readonly string[], value: string): number => (list.includes(value) ? list.indexOf(value) : list.length)
    const inputs = look.workers.map((c): QuotaCandidate => {
      const w = c.worker
      const account = w.account?.id
      if (account) accountOf.set(w.worker, account)
      const sandbox = this.e.ctx.workers.source(c.source)?.sandbox?.(w.worker)
      const repository = sandbox?.mode === 'workspace-write' ? sandbox.workspace : undefined
      if (repository) repositoryOf.set(w.worker, repository)
      // A Worker that offers several tiers is scored at the one routing would serve it at, by that tier's pools (ADR-0073).
      const tier = c.tier ?? w.tier
      const only = w.tiers?.find((o) => o.tier === tier)?.pools
      const accountPools = !account ? undefined : 'unknown' in pools ? { unknown: pools.unknown as string }
        : ((pools as Map<string, PoolState[]>).get(account) ?? []).filter((p) => only === undefined || only.includes(p.pool))
      const busy: string[] = []
      if (w.state !== 'ready') busy.push(w.state === 'busy' && w.load ? `busy ${w.load.running} of ${w.load.slots}` : `state ${w.state}`)
      else if (!w.load) busy.push('its source reports no load, so it cannot be shown free')
      else if (w.load.running + w.load.queued + w.load.pending >= s.maxRunningPerAccount) busy.push(`load ${w.load.running} of ${w.load.slots}${w.load.queued ? `, ${w.load.queued} queued` : ''}${w.load.pending ? `, ${w.load.pending} pending` : ''} (dispatch.maxRunningPerAccount ${s.maxRunningPerAccount})`)
      const step = running.get(w.worker)
      if (step) busy.push(`step ${step.node} of run ${step.run} runs on it`)
      const out = account ? this.closedRow(`quota-account:${account}`) : undefined
      if (out && out.until > at.getTime()) busy.push(`its account's ${out.window ? `${out.window} window` : 'quota window'} ended a step, and is closed until ${new Date(out.until).toISOString()}`)
      const used = counts.accounts.get(account ?? `worker:${w.worker}`) ?? 0
      if (used >= s.maxRunningPerAccount) busy.push(`its account has ${used} dispatched run(s) or ask(s) (dispatch.maxRunningPerAccount ${s.maxRunningPerAccount})`)
      const inRepo = repository ? counts.repositories.get(repository) ?? 0 : 0
      if (repository && inRepo >= s.maxRunningPerRepository) busy.push(`repository ${repository} has ${inRepo} dispatched run(s) or ask(s) (dispatch.maxRunningPerRepository ${s.maxRunningPerRepository}, D64)`)
      const metered = w.quotaClass === 'metered' || (Array.isArray(accountPools) && accountPools.some((p) => p.kind === 'api-key'))
      const refused = [...c.failed.map((f) => f.reason), ...(restrict && !restrict.workers.includes(w.worker) ? [`outside the Workers this step may take: ${restrict.reason}`] : [])]
      return {
        worker: w.worker, ...(refused.length ? { refused } : {}), tier, tierRank: TIERS.indexOf(tier), quotaClass: w.quotaClass,
        quotaRank: rank(look.order.quota, w.quotaClass), metered, ...(w.load ? { load: w.load } : {}), priorityRank: rank(look.order.priority, w.worker),
        pools: accountPools as readonly QuotaPool[] | { unknown: string } | undefined, ...(busy.length ? { busy } : {}),
      }
    })
    return { score: quotaScoreOf(inputs, settings, at), inputs, accountOf, repositoryOf }
  }

  /** The Workers a step of a running run runs on now, as the engine's rows say. */
  private runningSteps(): Map<string, { run: string; node: string }> {
    const rows = this.e.ctx.store.db.prepare(`SELECT n.worker, n.run_id, n.node_id FROM workflow_nodes n JOIN workflow_runs r ON r.run_id = n.run_id
      WHERE r.status = 'running' AND n.state = 'RUNNING' AND n.worker IS NOT NULL ORDER BY n.run_id, n.node_id`).all() as Array<{ worker: string; run_id: string; node_id: string }>
    const out = new Map<string, { run: string; node: string }>()
    for (const r of rows) if (!out.has(r.worker)) out.set(r.worker, { run: r.run_id, node: r.node_id })
    return out
  }

  /**
   * Ask the advisor in shadow (PROP-0015 J1) about a choice already made, and record what it said as
   * a `route` decision (`advisor.dispatch`): every candidate's three probabilities (`modelAnswers`),
   * or why there are none (`unavailable`). The snapshot holds features only (D73). Never throws:
   * whatever fails leaves the choice as it was, with no advice recorded at worst.
   */
  private async advise(task: BoardTask, n: number, template: string, node: ResolvedNode, scored: ReturnType<Dispatcher['score']>, settings: QuotaSettings, select: ArtifactRef, look: Candidates): Promise<ArtifactRef | undefined> {
    try {
      const s = this.settings.advisor
      this.history.refresh()
      const byWorker = new Map(scored.inputs.map((i) => [i.worker, i]))
      const facts = scored.score.candidates.flatMap((c): CandidateFacts[] => {
        const i = byWorker.get(c.worker)
        if (!i) return []
        return [{ scored: c, tier: i.tier, tierRank: i.tierRank, quotaClass: i.quotaClass, metered: i.metered, ...(i.load ? { load: { running: i.load.running, slots: i.load.slots } } : {}), countsKey: scored.accountOf.get(c.worker) ?? `worker:${c.worker}` }]
      })
      const chosen = scored.score.chosen!
      const { features, aliases } = featuresOf({
        ...(node.kind !== undefined ? { kind: node.kind } : {}), template, step: node.nodeId, reservePercent: settings.reservePercent, chosen, candidates: facts,
        counts: (key, kind) => this.history.countsOf(key, kind),
      })
      const advisor = this.advisor()
      const hourAgo = Date.now() - 3_600_000
      this.calls = this.calls.filter((t) => t > hourAgo)
      let shadow: ShadowAdvice
      if (!advisor) shadow = { advice: { status: 'unavailable', provider: 'none', reason: 'no advisor: dispatch.advisor.provider is none' }, elapsedMs: 0 }
      else if (this.calls.length >= s.maxPerHour) shadow = { advice: { status: 'unavailable', provider: advisor.id.slice(0, 64), reason: `the advisor was asked ${this.calls.length} times in the last hour (dispatch.advisor.maxPerHour ${s.maxPerHour})` }, elapsedMs: 0 }
      else {
        this.calls.push(Date.now())
        shadow = await adviseInShadow(advisor, features, s.timeoutMs)
      }
      const { advice } = shadow
      const detail: AdviceDetail = {
        shadow: true, status: advice.status, provider: advice.provider, ...(advice.modelVersion ? { modelVersion: advice.modelVersion } : {}),
        ...(advice.status === 'unavailable' ? { reason: advice.reason.slice(0, 500) } : {}), elapsedMs: shadow.elapsedMs, aliases, chosen: 'A', features,
      }
      const pct = (p: number): string => `${Math.round(p * 100)} %`
      const question = `What does the advisor say, in shadow, of the candidates for step ${node.nodeId} of board task ${task.taskId}, attempt ${n + 1} (${QUESTION_SET}; recorded only, the choice is dispatch.choice's)?`
      const decision = advice.status === 'advice'
        ? this.e.ctx.artifacts.recordDecision({
          decisionType: 'route', question, inputs: [select, look.requirement],
          candidates: [
            { option: 'advice', selected: true, reasons: bounded([`shadow: ${advice.provider} ${advice.modelVersion} answered in ${shadow.elapsedMs} ms; it changes no choice`, ...advice.candidates.map((c) => `${c.alias}${c.alias === 'A' ? ' (chosen)' : ''}: accepted ${pct(c.accepted)}, limit mid-task ${pct(c.limit)}, needs the operator ${pct(c.needsOperator)}`)]) },
            { option: 'unavailable', selected: false, reasons: ['not unavailable: the advisor answered every candidate'] },
          ],
          decider: { type: 'model', id: 'advisor.dispatch', version: advice.modelVersion }, modelAnswers: modelAnswersOf(advice),
          outcome: { option: 'advice', detail: detail as unknown as Record<string, unknown> }, deterministic: false,
        }, PRODUCER).id as ArtifactRef
        : this.e.ctx.artifacts.recordDecision({
          decisionType: 'route', question, inputs: [select, look.requirement],
          candidates: [
            { option: 'unavailable', selected: true, reasons: [`advice unavailable (${advice.provider}): ${advice.reason}`.slice(0, 300), 'the choice stands as dispatch.choice made it'] },
            { option: 'advice', selected: false, reasons: ['not advice: the advisor gave none'] },
          ],
          decider: ADVISOR, outcome: { option: 'unavailable', detail: detail as unknown as Record<string, unknown> }, deterministic: true,
        }, PRODUCER).id as ArtifactRef
      this.e.ctx.eventLog.append({ type: ADVISED_EVENT, decision, data: { taskId: task.taskId, attempt: n, status: advice.status, provider: advice.provider, ...(advice.modelVersion ? { modelVersion: advice.modelVersion } : {}), elapsedMs: shadow.elapsedMs } })
      return decision
    } catch (error) {
      this.e.ctx.logger.warn(`workflow: the dispatch advice could not be recorded; the choice stands: ${errorText(error)}`)
      return undefined
    }
  }

  /** The `dispatch.choice` decision, the request's version, and what Home shows of the chosen Worker's windows. */
  private choiceDecision(task: BoardTask, n: number, nodeId: string, scored: ReturnType<Dispatcher['score']>, select: ArtifactRef, verdict: AutonomyVerdict, look: Candidates, settings: QuotaSettings, advice: ArtifactRef | undefined) {
    const { score, inputs } = scored
    const worker = score.chosen!
    const chosen = score.candidates.find((c) => c.worker === worker)!
    // The version names exactly this choice (INV-5): the Worker and every input the score read.
    const version = `${QUOTA_SCORE}:${contentId({ worker, requirement: look.requirement, settings, candidates: inputs })}`
    const windows: DispatchWindow[] = (chosen.quota?.pools ?? []).flatMap((p) => p.windows.map((w) => ({
      pool: w.pool, window: w.window, name: windowName(w), ...(w.seconds !== undefined ? { seconds: w.seconds } : {}), ...(w.used !== undefined ? { used: w.used } : {}),
      ...(w.headroom !== undefined ? { headroom: w.headroom } : {}), reserve: settings.reservePercent, ...(w.resets ? { resets: w.resets } : {}), ...(w.observedAt ? { observedAt: w.observedAt } : {}),
    })))
    const listed = score.candidates.map((c) => ({ option: c.worker, selected: c.worker === worker, reasons: bounded(c.reasons) }))
    const unheard = look.unheard.map((u) => ({ option: `source ${u.source}`, selected: false, reasons: [u.reason] }))
    const all = [...listed, ...unheard]
    // At most 255 candidates (decision@1): the chosen one, those first in the order, and how many more.
    const rest = all.filter((c) => !c.selected)
    const head = rest.slice(0, MAX_CANDIDATES - 2)
    const candidates = all.length <= MAX_CANDIDATES ? all : [all.find((c) => c.selected)!, ...head,
      { option: `${rest.length - head.length} more`, selected: false, reasons: ['not listed: a decision lists at most 255 candidates; each of them ranks after those listed, or routing refused it'] }]
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'route',
      question: `Which Worker takes step ${nodeId} of board task ${task.taskId}, attempt ${n + 1}, if System starts it (${QUOTA_SCORE})?`,
      inputs: [select, look.requirement, verdict.decision, ...(advice ? [advice] : [])],
      candidates,
      decider: { ...CHOICE, hash: contentId(settings) },
      outcome: { option: worker, detail: { taskId: task.taskId, attempt: n, nodeId, score: QUOTA_SCORE, settings, version, ...(scored.accountOf.get(worker) ? { account: scored.accountOf.get(worker) } : {}), ...(scored.repositoryOf.get(worker) ? { repository: scored.repositoryOf.get(worker) } : {}), windows } },
      deterministic: true,
    }, PRODUCER).id as ArtifactRef
    const quotaText = windows.length ? windows.map((w) => `${w.name}: used ${w.used ?? '?'} %, headroom ${w.headroom ?? '?'} above the ${w.reserve} % reserve${w.resets ? `, resets ${w.resets}` : ''}`).join('; ') : 'no window'
    const summary = `Start attempt ${n + 1} of "${task.title}" (task ${task.taskId}, project ${task.projectId}) on ${worker}: ${quotaText}`.slice(0, 500)
    const consequences = [
      `Approved: System starts attempt ${n + 1} of task ${task.taskId} with template ${task.template}, its step ${nodeId} on ${worker} first, at its next pass, while the task is still ready at that attempt and ${worker} still free, waiting at most ${this.settings.approvedHoldMinutes} min for it; otherwise the approval is used for nothing and dispatch chooses again.`,
      `Why ${worker}: ${chosen.line}. The choice: decision ${decision}.`,
      'Denied, or unanswered by its expiry: nothing starts, and dispatch does not ask again for this attempt; the lead or you may still start it by hand.',
      'The run is like any other: it is briefed, gated, and checked as a run the lead starts, and nothing lands without your merge approval.',
    ].join(' ').slice(0, 2000)
    return { decision, version, windows, summary, consequences }
  }

  /**
   * D62: the operator's approval of the board's own request for this attempt (`board-task:<id>:attempt:<n>`),
   * which made the task ready: its `lastDecision` is that request's `approval` decision, approved by an
   * operator verdict. Anything else, or anything that cannot be read, is no such approval (INV-2).
   */
  private async boardApproval(task: BoardTask): Promise<{ requestId: string; decision: ArtifactRef; approval?: ArtifactRef } | undefined> {
    if (!task.lastDecision) return undefined
    const body = this.e.ctx.artifacts.get(task.lastDecision)?.body as { decisionType?: string; outcome?: { option?: string; detail?: { requestId?: unknown } } } | undefined
    if (body?.decisionType !== 'approval' || body.outcome?.option !== 'approved' || typeof body.outcome.detail?.requestId !== 'string') return undefined
    const request = await this.e.ctx.get('approvals')?.get(body.outcome.detail.requestId).catch(() => undefined)
    const bound = request && request.state === 'approved' && request.requester.component === 'board' && request.requester.taskId === task.taskId
      && request.subject.ref === `board-task:${task.taskId}:attempt:${task.attempts.count}` && request.action.class === task.actionClass
      && request.resolution?.cause === 'verdict' && request.resolution.decision === task.lastDecision && request.resolution.approval !== undefined
    return bound ? { requestId: request.requestId, decision: task.lastDecision, approval: request.resolution!.approval! } : undefined
  }

  // --- the asks ---

  private ask(askId: string): AskRow | undefined {
    return this.e.ctx.store.db.prepare('SELECT * FROM workflow_dispatch WHERE ask_id = ?').get(askId) as AskRow | undefined
  }

  private liveAsk(taskId: string, attempt: number): AskRow | undefined {
    return this.e.ctx.store.db.prepare(`SELECT * FROM workflow_dispatch WHERE task_id = ? AND attempt = ? AND state IN ('asking', 'asked', 'approved', 'starting')`).get(taskId, attempt) as AskRow | undefined
  }

  /** Why dispatch asks no more for this attempt: the operator denied it, or let it expire. */
  private denied(taskId: string, attempt: number): string | undefined {
    const row = this.e.ctx.store.db.prepare(`SELECT request_id, outcome FROM workflow_dispatch WHERE task_id = ? AND attempt = ? AND state = 'closed'
      AND json_extract(outcome, '$.status') IN ('denied', 'expired') ORDER BY updated_at DESC LIMIT 1`).get(taskId, attempt) as { request_id: string | null; outcome: string } | undefined
    if (!row) return undefined
    const outcome = JSON.parse(row.outcome) as AskOutcome
    return outcome.status === 'denied' ? `you denied it (request ${row.request_id})` : `its request ${row.request_id} expired unanswered, which counts as denied`
  }

  private move(row: AskRow, state: AskState, changes: Partial<Pick<AskRow, 'request_id' | 'run_id' | 'approved_at' | 'choice'>> & { outcome?: AskOutcome } = {}): void {
    const at = now()
    this.e.ctx.store.transaction((db) => {
      db.prepare(`UPDATE workflow_dispatch SET state = ?, request_id = COALESCE(?, request_id), run_id = COALESCE(?, run_id), approved_at = COALESCE(?, approved_at),
        choice = COALESCE(?, choice), outcome = COALESCE(?, outcome), started_at = COALESCE(?, started_at), updated_at = ? WHERE ask_id = ?`)
        .run(state, changes.request_id ?? null, changes.run_id ?? null, changes.approved_at ?? null, changes.choice ?? null, changes.outcome ? JSON.stringify(changes.outcome) : null,
          state === 'started' ? at : null, at, row.ask_id)
      if (state === 'closed' || state === 'started') {
        this.e.ctx.eventLog.append({ type: `workflow.dispatch.${state}`, data: { askId: row.ask_id, taskId: row.task_id, attempt: row.attempt, worker: row.worker, mode: row.mode, ...(changes.run_id ? { runId: changes.run_id } : {}), ...(changes.outcome ? { status: changes.outcome.status, reason: changes.outcome.reason } : {}) } })
      }
      // Under notify (D2), the start is told: one notice, recorded with the start itself, which the notifier reads.
      if (state === 'started' && row.mode === 'notify') {
        this.e.ctx.eventLog.append({
          type: 'workflow.dispatch.notice', ...(changes.run_id ? { runId: changes.run_id } : {}),
          data: { askId: row.ask_id, taskId: row.task_id, projectId: row.project_id, attempt: row.attempt + 1, worker: row.worker, ...(changes.run_id ? { runId: changes.run_id } : {}) },
        })
      }
    })
  }

  private closeAsk(row: AskRow, status: AskOutcome['status'], reason: string): void {
    this.move(row, 'closed', { outcome: { status, reason: reason.slice(0, 500), at: now() } })
  }

  /** The request's subject, exactly (INV-5). */
  private subjectOf(row: AskRow): Subject {
    return { type: 'content', ref: `dispatch:${row.task_id}:attempt:${row.attempt}`, version: row.version }
  }

  /**
   * Ask the queue for a row's start: adopt an open request on its subject first (a crash between the
   * request and the row's record asks once, INV-4), else request one with the verdict that said ask.
   * A request newly opened is charged to the pass's allowance as soon as the queue opens it, before
   * the row's record, so a record that fails still spends it (one adopted was charged when opened).
   */
  private async request(row: AskRow, allowance: Allowance): Promise<'opened' | 'adopted' | 'not-asked' | undefined> {
    const choice = JSON.parse(row.choice) as AskChoice
    const subject = this.subjectOf(row)
    const approvals = this.e.ctx.get('approvals')
    if (!approvals) return undefined
    const open = (await approvals.list({ projectId: row.project_id })).filter((r) => r.requester.component === 'workflow' && r.requester.taskId === row.task_id && r.subject.ref === subject.ref && r.action.class === 'dispatch')
    const mine = open.find((r) => r.subject.version === row.version)
    if (mine) {
      this.move(row, 'asked', { request_id: mine.requestId })
      return 'adopted'
    }
    // A request on another choice for this attempt belongs to no live ask (one closed whose withdrawal
    // failed): it is withdrawn, so the operator is never shown two starts of one attempt.
    for (const stale of open) await approvals.withdraw(stale.requestId)
    try {
      const created = await approvals.request({
        subject, action: { class: 'dispatch', summary: choice.summary, consequences: choice.consequences, refs: [choice.decisions[1]!] },
        requester: { component: 'workflow', taskId: row.task_id, projectId: row.project_id }, verdict: choice.verdict!, classification: choice.classification,
      })
      allowance.left -= 1
      this.move(row, 'asked', { request_id: created.requestId })
      return 'opened'
    } catch (error) {
      // Any other failure (a crash, a store that failed) leaves the row asking: the next pass adopts the
      // request, if one was made, or asks again (INV-4).
      if (!(error instanceof ApprovalsError)) throw error
      // The policy no longer asks (changed since the verdict), or the request is invalid: nothing is asked.
      this.closeAsk(row, 'not-asked', `the approval queue did not take the request: ${errorText(error)}`)
      return 'not-asked'
    }
  }

  /** Settle the live asks, oldest first: adopt or ask, read the queue's verdicts, start approved ones, withdraw stale ones. */
  private async settle(board: Board, at: Date, allowance: Allowance): Promise<void> {
    const rows = this.e.ctx.store.db.prepare(`SELECT * FROM workflow_dispatch WHERE state IN ('asking', 'asked', 'approved', 'starting') ORDER BY updated_at, ask_id LIMIT ?`).all(MAX_SETTLED) as unknown as AskRow[]
    const paused = this.pausedNow()
    const projects = this.projectPauses()
    for (const row of rows) {
      if (this.e.stopped.signal.aborted) return
      try {
        await this.settleOne(board, row, at, paused ?? projects.get(row.project_id), allowance)
      } catch (error) {
        this.e.ctx.logger.warn(`workflow: dispatch ask ${row.ask_id} could not be settled; the next pass tries again: ${errorText(error)}`)
      }
    }
  }

  private async settleOne(board: Board, row: AskRow, at: Date, paused: DispatchPause | undefined, allowance: Allowance): Promise<void> {
    const approvals = this.e.ctx.get('approvals')
    if (row.state === 'asking') {
      if (paused) return this.closeAsk(row, 'paused', `${pausedText(paused)} before it was asked`)
      // A request it opens counts against this pass's maxPerPass; one adopted was counted when it was opened.
      if (allowance.left <= 0) return
      await this.request(row, allowance)
      return
    }
    // Approved, or starting with no run admitted yet (a crash): revalidated alike before any start.
    if (row.state === 'starting' || row.state === 'approved') return this.tryStart(board, row, at, paused, allowance)
    // Asked: the queue's word on it.
    if (!approvals) return
    const request = await approvals.get(row.request_id!)
    if (!request) return this.closeAsk(row, 'unknown-request', `the approval queue does not know request ${row.request_id}; nothing starts on it`)
    if (request.state === 'open' || request.state === 'batched') {
      const moved = await this.movedOn(board, row)
      const why = paused ? `${pausedText(paused)}` : moved
      if (!why) return
      await approvals.withdraw(request.requestId).catch((error: unknown) => this.e.ctx.logger.warn(`workflow: dispatch could not withdraw request ${request.requestId}; it expires on its own: ${errorText(error)}`))
      return this.closeAsk(row, paused ? 'paused' : 'moved-on', `${why}: request ${request.requestId} withdrawn`)
    }
    if (request.state === 'approved') {
      if (!this.binds(request, row)) return this.closeAsk(row, 'unbound', `request ${request.requestId} was approved, but not exactly as asked (subject, requester, class, or verdict): an approval binds only the exact start it was asked on (INV-5)`)
      const choice = JSON.parse(row.choice) as AskChoice
      this.move(row, 'approved', { approved_at: request.resolution!.at, choice: JSON.stringify({ ...choice, decisions: [...choice.decisions, request.resolution!.decision] }) })
      return this.tryStart(board, this.ask(row.ask_id)!, at, paused, allowance)
    }
    const resolution = request.resolution
    if (resolution?.cause === 'verdict') return this.closeAsk(row, 'denied', `the operator denied request ${request.requestId}`)
    if (resolution?.cause === 'expired') return this.closeAsk(row, 'expired', `request ${request.requestId} expired unanswered`)
    const decider = (this.e.ctx.artifacts.get(resolution?.decision as ArtifactRef)?.body as { decider?: { id?: string } } | undefined)?.decider?.id
    if (decider === 'approvals.policy') return this.closeAsk(row, 'policy-changed', `request ${request.requestId} was withdrawn on a policy change; the next pass puts the task to the policy in force`)
    return this.closeAsk(row, 'withdrawn', `request ${request.requestId} was withdrawn`)
  }

  /** Whether an approved request is exactly the start the row asked for (INV-5). */
  private binds(request: ApprovalRequest, row: AskRow): boolean {
    const subject = this.subjectOf(row)
    return request.subject.type === subject.type && request.subject.ref === subject.ref && request.subject.version === subject.version
      && request.requester.component === 'workflow' && request.requester.taskId === row.task_id && request.action.class === 'dispatch'
      && request.resolution?.cause === 'verdict' && request.resolution.approval !== undefined
  }

  /** Why the task no longer waits on this ask: it moved on, or its attempt did; undefined while it is still ready at that attempt. */
  private async movedOn(board: Board, row: AskRow): Promise<string | undefined> {
    const task = await board.task(row.task_id)
    if (!task) return `task ${row.task_id} is unknown to the board`
    if (task.state !== 'ready') return `task ${row.task_id} is ${task.state} now${task.run ? ` (run ${task.run.runId})` : ''}`
    if (task.attempts.count !== row.attempt) return `task ${row.task_id} is at attempt ${task.attempts.count + 1} now, not ${row.attempt + 1}`
    const project = await board.project(task.projectId)
    if (project?.state !== 'active') return `project ${task.projectId} is ${project?.state ?? 'unknown'} now`
    return undefined
  }

  /**
   * Start an approved row's run, exactly that attempt on exactly that Worker: a run already admitted
   * for it is adopted first (INV-4); otherwise, whether the row is approved or was left starting by a
   * crash, only while dispatch is not paused there, the task is still ready at that attempt, the hold
   * has not passed, the Worker is still admitted and free, the bounds leave room, and the pass's
   * allowance is not spent. Paused, past the hold, or once the task moved on, the approval is used for
   * nothing; otherwise it waits, approved, for a later pass.
   */
  private async tryStart(board: Board, row: AskRow, at: Date, paused: DispatchPause | undefined, allowance: Allowance): Promise<void> {
    // A start a crash interrupted after the engine admitted its run: that run is this ask's (INV-4).
    const admitted = this.e.ctx.store.db.prepare("SELECT run_id FROM workflow_tasks WHERE json_extract(dispatch, '$.askId') = ?").get(row.ask_id) as { run_id: string } | undefined
    if (admitted) return this.move(row, 'started', { run_id: admitted.run_id, outcome: { status: 'started', reason: `run ${admitted.run_id} serves attempt ${row.attempt + 1}`, at: now() } })
    // No run was admitted: whatever the row's state (approved, or starting when a crash came before
    // the admission), everything is checked again before one is (INV-4).
    const moved = await this.movedOn(board, row)
    if (moved) return this.closeAsk(row, 'moved-on', `${moved}; the approval is used for nothing`)
    if (paused) return this.closeAsk(row, 'paused', `${pausedText(paused)}; the approval is used for nothing`)
    // The hold first: an approval older than it starts nothing, even on a free Worker.
    const since = row.approved_at ?? row.created_at
    if (at.getTime() - Date.parse(since) > this.settings.approvedHoldMinutes * 60_000) {
      return this.closeAsk(row, 'hold-expired', `approved at ${since}, more than ${this.settings.approvedHoldMinutes} min before it could start (dispatch.approvedHoldMinutes): the approval is used for nothing, and dispatch chooses again`)
    }
    const waiting = await this.notStartable(row, at)
    // Not startable now, or this pass has started and asked all it may: it waits, approved, for a later pass.
    if (waiting || allowance.left <= 0) {
      if (row.state === 'starting') this.move(row, 'approved')
      return
    }
    const choice = JSON.parse(row.choice) as AskChoice
    if (row.state !== 'starting') this.move(row, 'starting')
    const task = await board.task(row.task_id)
    if (!task || task.state !== 'ready' || task.attempts.count !== row.attempt) return this.closeAsk(row, 'moved-on', 'the task moved on before its run started; the approval is used for nothing')
    const dispatch: TaskDispatch = { askId: row.ask_id, decisions: choice.decisions, prefer: { node: row.node_id, worker: row.worker, decision: choice.decisions[1]! } }
    try {
      const run = await this.e.tasks.start({
        template: choice.template, input: `${task.title}\n\n${task.goal}`.slice(0, 32_000), task: { taskId: task.taskId, revision: task.revision }, clientRequestId: `dispatch:${row.ask_id}`,
      }, { dispatch })
      allowance.left -= 1
      this.move(row, 'started', { run_id: run.runId, outcome: { status: 'started', reason: `run ${run.runId} serves attempt ${row.attempt + 1}`, at: now() } })
    } catch (error) {
      const pending = (error as { runId?: unknown }).runId
      if (typeof pending === 'string') {
        // Admitted all the same: it starts once the board shows it recorded.
        allowance.left -= 1
        this.move(row, 'started', { run_id: pending, outcome: { status: 'started', reason: `run ${pending} was admitted; the board had not answered its start yet`, at: now() } })
        return
      }
      if (error instanceof WorkflowFailure && error.kind === 'overloaded') {
        // The engine is full or draining: the row waits, within its hold, for a later pass.
        this.move(row, 'approved')
        return
      }
      this.closeAsk(row, 'refused', `the engine refused the start: ${errorText(error)}`)
    }
  }

  /** Why an approved row cannot start now (its Worker not admitted or not free, the engine full), or undefined when it can. */
  private async notStartable(row: AskRow, at: Date): Promise<string | undefined> {
    const s = this.settings
    const pending = this.counts(row.ask_id).pending
    if (this.e.draining) return 'the host is draining'
    if (this.active() + pending >= s.maxActiveRuns - s.leaveRunsFree) return `the engine is full (maxActiveRuns less dispatch.leaveRunsFree)`
    // The hour counts the starts made, never the rows still waiting, so two approved starts never hold each other back (D2).
    const full = this.hourFull(this.hourly(at, false), row.project_id)
    if (full) return full
    const resources = this.e.ctx.get('resources')
    if (!resources?.quota || !this.e.ctx.workers.candidates) return 'no Worker can be shown free (the ledger or the router cannot tell)'
    const choice = JSON.parse(row.choice) as AskChoice
    const step = this.writingStep(choice.template)
    if ('problem' in step) return step.problem
    const own = this.e.requirementOf(step.node, step.node.session.persist === true, choice.classification)
    const atRisk = await lookTierAtRisk(this.e, { taskId: row.task_id, projectId: row.project_id }, step.node, own)
    if (atRisk && 'problem' in atRisk) return atRisk.problem
    const requirement = atRisk?.requirement ?? own
    const look = await this.e.ctx.workers.candidates(requirement, { producer: 'workflow' })
    const scored = this.score(look, await this.pools(at), resources.quota(), this.counts(row.ask_id), at)
    const mine = scored.score.candidates.find((c) => c.worker === row.worker)
    if (!mine) return `${row.worker} is not listed now`
    if (!mine.admitted) return `${row.worker} is not admitted now (${mine.reasons.join('; ')})`
    if (!mine.free) return `${row.worker} is not free now (${mine.reasons.filter((r) => r.startsWith('not free: ')).map((r) => r.slice(10)).join('; ')})`
    return undefined
  }
}
