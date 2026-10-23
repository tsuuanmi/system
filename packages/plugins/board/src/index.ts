/**
 * `ctx.board`: the store-backed provider of the work state machine seam (docs/design/board.md).
 * Projects and board tasks are `project@1.0` and `board-task@1.x` records in the store, validated
 * before every write and after every read. Each move is one store transaction with the decision
 * it names (INV-13); a task's holder is a `ctx.leases` lease on `board-task:<taskId>`, whose
 * generation fences every write the holder makes (INV-4, INV-15). Approvals go through
 * `ctx.approvals` only: the board never decides one. `sweep(at)` is the only time-driven path.
 * @module @tsuuanmi/system-board
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type ApprovalRequest, type AutonomyVerdict, type Check, type Mode, type NewRequest, waitSeconds } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import {
  type ActionClass, type ArtifactRef, Board, BoardError, type BoardTask, type BudgetLine, type CancelReason, type Charter, type CharterInput, type Claim, fundingVersion, type Project, type ProjectState, renderTasks, type RunOutcome, type Subject,
  type TaskInput, type TaskState, TERMINAL, type Unit, type WaitReason,
} from '@tsuuanmi/system-board-core'
import type {} from '@tsuuanmi/system-gateway-core'
import { contentId, SchemaError, SchemaRegistry } from '@tsuuanmi/system-libs'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import type {} from '@tsuuanmi/system-store'
import { registerTools } from './tools.ts'

export interface Config {
  /**
   * The most approved funding may raise one of a task's budget lines, over all its raises, in
   * percent of the amount the task declared (default 100: at most double it; 0 raises none). A
   * `budget-spent` ask past it opens no request, and an approval is applied only within it (INV-9).
   */
  fundingMaxPercent?: number
  /** How long a wait for input lasts before it cancels the task, in seconds (default 7 days). */
  inputExpirySeconds?: number
  /** Lease length when a claim names none (`board_claim` without `ttlSeconds`), in seconds (default 600, the leases' own default cap); `leases.maxTtlMs` caps it. */
  leaseTtlSeconds?: number
  /** Attempts a task gets when its proposal names none (default 3, at most 10). */
  maxAttempts?: number
  /** The most items one page of `board_projects` or `board_tasks` holds (default 100, the tools' own maximum). */
  pageBound?: number
  /** The most tasks the `TASKS.md` projection lists, open ones first (default 200). */
  projectionMaxTasks?: number
  /** How often the board sweeps on its own, in seconds, and once at start (a restart is a sweep); 0: only when called (default 60). */
  sweepSeconds?: number
}

/** A page of a listing, and the cursor of the next one (absent on the last). */
export interface Page<T> { items: T[]; next?: string }

/** Tasks per state. */
export type Counts = Record<TaskState, number>

export const TASK_STATES: readonly TaskState[] = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval', 'done', 'cancelled']
const OPEN: readonly TaskState[] = TASK_STATES.filter((s) => !TERMINAL.includes(s))
const CANCELLABLE: readonly TaskState[] = ['proposed', 'ready', 'claimed', 'waiting-for-input', 'waiting-for-approval']
/** Tasks the sweep reads per statement; a protocol constant, not a deployment value. */
const SWEEP_PAGE = 500
/** Characters of an answer to a task's question (the `board_update` input's bound). */
const ANSWER_MAX = 2000
const DEFAULT_PAGE = 20
/** Lines a funding ask names at most, and the largest amount a budget line holds (`common@1` `budgetLine`). */
const FUNDING_LINES = 16
const AMOUNT_MAX = 1e12
const UNITS: readonly Unit[] = ['tokens', 'usd', 'turns', 'runs', 'minutes']

const MIGRATIONS = [{
  version: 1,
  sql: `CREATE TABLE board_projects (
    project_id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL,
    charter_request TEXT, charter_version INTEGER,
    CHECK ((charter_request IS NULL) = (charter_version IS NULL))
  );
  CREATE INDEX board_projects_state ON board_projects (state, created_at, project_id);
  CREATE INDEX board_projects_listing ON board_projects (created_at, project_id);
  CREATE INDEX board_projects_charter ON board_projects (charter_request) WHERE charter_request IS NOT NULL;
  CREATE TABLE board_tasks (
    seq INTEGER PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES board_projects (project_id),
    state TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL,
    writes TEXT, lease_token TEXT, lease_ttl_ms INTEGER,
    CHECK ((lease_token IS NULL) = (lease_ttl_ms IS NULL))
  );
  CREATE INDEX board_tasks_project ON board_tasks (project_id, state, created_at, task_id);
  CREATE INDEX board_tasks_listing ON board_tasks (project_id, created_at, task_id);
  CREATE INDEX board_tasks_open ON board_tasks (state, seq);
  CREATE UNIQUE INDEX board_tasks_writes ON board_tasks (writes) WHERE writes IS NOT NULL;
  CREATE TABLE board_client_requests (
    client_request_id TEXT PRIMARY KEY, tool TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT, approval_request TEXT, created_at TEXT NOT NULL
  );`,
}, {
  // When a pending charter request expires, so the board applies the expiry itself when the queue
  // never resolves it or no longer knows it (INV-9); the version a retried board_charter asked about.
  version: 2,
  sql: `ALTER TABLE board_projects ADD COLUMN charter_expires_at TEXT;
  ALTER TABLE board_client_requests ADD COLUMN charter_version INTEGER;`,
}]

type Changes<T> = { [K in keyof T]?: T[K] | undefined }
/** A task as stored: its record and the holder's lease token, which never leaves the store. */
interface Stored { task: BoardTask; token?: string; ttlMs?: number }
/** A project as stored: its record and its pending charter request, with the version it asks about and when it expires. */
interface StoredProject { project: Project; request?: string; version?: number; expiresAt?: string }
/** An `acceptance` decision bound to a task's result: its outcome, whether the operator made it, and the checks it reports. */
interface Acceptance { option: 'accept' | 'reject'; operator: boolean; checks?: Partial<Record<Check, boolean>> }
/** The policy's verdict for a task's next attempt, and the approval request it opened on ask. */
interface NextAttempt { verdict: AutonomyVerdict; request?: ApprovalRequest }
/** An accepting decision only the operator's can replace now: the verdict, the checks still pending, and how long the operator has. */
interface Held { verdict: AutonomyVerdict; pendingChecks: Check[]; seconds: number }
/** A `board_client_requests` row: what a retry-safe call made. */
interface PriorRequest { project_id: string; task_id: string | null; approval_request: string | null; charter_version: number | null }
/** A charter request settled by the sweep: the project as it now is, and the tasks it cancelled. */
interface Settled { project: Project; cancelled: BoardTask[] }
/** What a move changes; `lease` is set when it takes or renews the holder's lease. */
interface Move { changes: Changes<BoardTask>; lease?: { token: string; ttlMs: number } }
/** Why a decision went one way: the chosen move, and why the task (or project) did not stay where it was. */
interface Why {
  from: string; to: string; why: string; whyNot: string; inputs?: ArtifactRef[]; detail?: Record<string, unknown>
  /** The move it declined, when that is not staying where it was (`from`): the rejected candidate. */
  instead?: string
  /** Further candidates it declined, each with why not. */
  also?: Array<{ option: string; whyNot: string }>
  /** The question, when the default (from → to, or to → instead) does not say it. */
  question?: string
}

/** The checks a policy rule can require (`autonomy-policy@1.0`). */
const CHECKS: readonly Check[] = ['tests', 'typecheck', 'lint', 'schema', 'quote-check', 'review']
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const resourceOf = (taskId: string): string => `board-task:${taskId}`
const charterRef = (projectId: string, version: number): string => `project:${projectId}:charter:${version}`
/** The charter's subject version: the sha256 of its canonical JSON without its approval (reference/schemas.md#project). */
const charterHash = (charter: Charter): string => {
  const { approval: _, ...content } = charter
  return contentId(content)
}
/** The key of the subject an open task writes; one open task per key (INV-15). */
const writesKey = (subject: Subject | undefined): string | null => (subject ? JSON.stringify([subject.type, subject.ref]) : null)
/** Whether the task may make another attempt: `attempts.count` never exceeds `attempts.max`. */
const attemptLeft = (task: BoardTask): boolean => task.attempts.count < task.attempts.max
/** The earlier of two instants, either of which may be unknown. */
const earliest = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined || Date.parse(a) <= Date.parse(b) ? a : b)
const sameSubject = (a: Subject, b: Subject): boolean => a.type === b.type && a.ref === b.ref && a.version === b.version
/** An amount at the ledger's precision, a millionth. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6
const samePoolUnit = (a: BudgetLine, b: BudgetLine): boolean => a.pool === b.pool && a.unit === b.unit
/** Budget lines in words: `+4 usd of max.programmatic, +1 runs of max.programmatic`. */
const linesText = (lines: readonly BudgetLine[], sign = ''): string => lines.map((l) => `${sign}${l.amount} ${l.unit} of ${l.pool}`).join(', ')
/** `budget` with each of `lines` added to every line of its pool and unit. */
const raised = (budget: readonly BudgetLine[], lines: readonly BudgetLine[]): BudgetLine[] =>
  budget.map((b) => ({ ...b, amount: round6(b.amount + lines.filter((l) => samePoolUnit(l, b)).reduce((n, l) => n + l.amount, 0)) }))
/** What the task's applied raises added to its pool and unit so far. */
const raisedSoFar = (task: BoardTask, line: BudgetLine): number =>
  round6((task.funding ?? []).flatMap((f) => f.lines).filter((l) => samePoolUnit(l, line)).reduce((n, l) => n + l.amount, 0))
/** At most `max` characters (code points), cut on a whole one. */
const clamp = (text: string, max: number): string => {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}
const newId = (prefix: string): string => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12)}`
/** An id derived from a client's request key, so a retry of the same call names the same record. */
const derivedId = (prefix: string, key: string): string => `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
const encodeCursor = (createdAt: string, id: string): string => Buffer.from(JSON.stringify([createdAt, id])).toString('base64url')
const decodeCursor = (cursor: string): [string, string] => {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string')) return value as [string, string]
  } catch {
    // refused below
  }
  throw new BoardError('invalid', 'not a cursor this board gave out')
}

/** Apply `changes` to a copy of `record` (an undefined value removes the field) as its next revision at `at`. */
function changed<T extends Project | BoardTask>(record: T, at: Date, changes: Changes<T>): T {
  const next = structuredClone(record) as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  next['revision'] = record.revision + 1
  next['updatedAt'] = at.toISOString()
  return next as unknown as T
}

export class StoreBoard extends Board {
  static inject = ['store', 'artifacts', 'leases', 'approvals']
  static Config: z<Config> = z.object({
    fundingMaxPercent: z.natural().max(1000).default(100).description('The most approved funding may raise a task\'s budget line in all, in percent of what the task declared; an ask past it opens no request'),
    inputExpirySeconds: z.natural().min(60).max(90 * 24 * 3600).default(7 * 24 * 3600).description('How long a wait for input lasts before it cancels the task, in seconds'),
    leaseTtlSeconds: z.natural().min(30).max(3600).default(600).description('Lease length when a claim names none, in seconds (leases.maxTtlMs caps it)'),
    maxAttempts: z.natural().min(1).max(10).default(3).description('Attempts a task gets when its proposal names none'),
    pageBound: z.natural().min(1).max(100).default(100).description('The most items one page of board_projects or board_tasks holds'),
    projectionMaxTasks: z.natural().min(1).max(10_000).default(200).description('The most tasks the TASKS.md projection lists, open ones first'),
    sweepSeconds: z.natural().max(3600).default(60).description('Seconds between the board\'s own sweeps, and one at start; 0 sweeps only when called'),
  })

  private readonly schemas = new SchemaRegistry()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx)
    ctx.store.migrate('board', MIGRATIONS)
    ctx.effect(() => {
      const seconds = config.sweepSeconds ?? 60
      if (!seconds) return () => {}
      let sweeping: Promise<unknown> | undefined
      const tick = (): void => {
        if (sweeping) return
        sweeping = this.sweep(new Date())
          .catch((error: unknown) => {
            ctx.logger.warn('board: a sweep failed')
            ctx.logger.warn(error)
          })
          .finally(() => { sweeping = undefined })
      }
      // A restart is a sweep (INV-4): what fell due while the board was down moves first.
      const first = setTimeout(tick, 0)
      const every = setInterval(tick, seconds * 1000)
      first.unref()
      every.unref()
      return async () => {
        clearTimeout(first)
        clearInterval(every)
        await sweeping
      }
    })
    ctx.inject(['mcp'], (c) => registerTools(c, this, { leaseTtlSeconds: config.leaseTtlSeconds ?? 600 }))
  }

  // --- reads ---

  async project(projectId: string) {
    return this.readProject(projectId)?.project
  }

  async projects(filter: { state?: ProjectState } = {}) {
    const rows = (filter.state === undefined
      ? this.ctx.store.db.prepare('SELECT project_id, record FROM board_projects ORDER BY created_at, project_id').all()
      : this.ctx.store.db.prepare('SELECT project_id, record FROM board_projects WHERE state = ? ORDER BY created_at, project_id').all(filter.state)) as Array<{ project_id: string; record: string }>
    return rows.map((r) => this.loadProject(r.project_id, r.record))
  }

  async task(taskId: string) {
    return this.readTask(taskId)?.task
  }

  async tasks(filter: { projectId: string; states?: TaskState[] }) {
    const states = filter.states ?? TASK_STATES
    if (!states.length) return []
    const rows = this.ctx.store.db.prepare(`SELECT task_id, record FROM board_tasks WHERE project_id = ? AND state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, task_id`)
      .all(filter.projectId, ...states) as Array<{ task_id: string; record: string }>
    return rows.map((r) => this.loadTask(r.task_id, r.record))
  }

  /** One page of projects in creation order, at most `limit` (default 20) and never more than `pageBound`. */
  projectPage(filter: { state?: ProjectState; limit?: number; after?: string } = {}): Page<Project> {
    const limit = this.limitOf(filter.limit)
    const [createdAt, id] = filter.after === undefined ? ['', ''] : decodeCursor(filter.after)
    const rows = this.ctx.store.db.prepare(`SELECT project_id, created_at, record FROM board_projects
      WHERE (? IS NULL OR state = ?) AND (created_at > ? OR (created_at = ? AND project_id > ?)) ORDER BY created_at, project_id LIMIT ?`)
      .all(filter.state ?? null, filter.state ?? null, createdAt, createdAt, id, limit + 1) as Array<{ project_id: string; created_at: string; record: string }>
    const items = rows.slice(0, limit).map((r) => this.loadProject(r.project_id, r.record))
    const last = rows.length > limit ? rows[limit - 1]! : undefined
    return { items, ...(last ? { next: encodeCursor(last.created_at, last.project_id) } : {}) }
  }

  /** One page of a project's tasks in creation order, at most `limit` (default 20) and never more than `pageBound`. */
  taskPage(filter: { projectId: string; states?: TaskState[]; milestone?: string; limit?: number; after?: string }): Page<BoardTask> {
    const limit = this.limitOf(filter.limit)
    const states = filter.states ?? TASK_STATES
    const [createdAt, id] = filter.after === undefined ? ['', ''] : decodeCursor(filter.after)
    if (!states.length) return { items: [] }
    const rows = this.ctx.store.db.prepare(`SELECT task_id, created_at, record FROM board_tasks
      WHERE project_id = ? AND state IN (${states.map(() => '?').join(', ')}) AND (? IS NULL OR json_extract(record, '$.milestone') = ?)
        AND (created_at > ? OR (created_at = ? AND task_id > ?)) ORDER BY created_at, task_id LIMIT ?`)
      .all(filter.projectId, ...states, filter.milestone ?? null, filter.milestone ?? null, createdAt, createdAt, id, limit + 1) as Array<{ task_id: string; created_at: string; record: string }>
    const items = rows.slice(0, limit).map((r) => this.loadTask(r.task_id, r.record))
    const last = rows.length > limit ? rows[limit - 1]! : undefined
    return { items, ...(last ? { next: encodeCursor(last.created_at, last.task_id) } : {}) }
  }

  /** A project's tasks in `state` most recently moved first, at most `limit`. */
  latest(projectId: string, state: TaskState, limit: number): BoardTask[] {
    const rows = this.ctx.store.db.prepare(`SELECT task_id, record FROM board_tasks WHERE project_id = ? AND state = ?
      ORDER BY json_extract(record, '$.updatedAt') DESC, task_id LIMIT ?`).all(projectId, state, Math.max(0, Math.floor(limit))) as Array<{ task_id: string; record: string }>
    return rows.map((r) => this.loadTask(r.task_id, r.record))
  }

  /** A project's tasks per state. */
  counts(projectId: string): Counts {
    const counts = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Counts
    for (const row of this.ctx.store.db.prepare('SELECT state, COUNT(*) AS n FROM board_tasks WHERE project_id = ? GROUP BY state').all(projectId) as Array<{ state: TaskState; n: number }>) {
      counts[row.state] = Number(row.n)
    }
    return counts
  }

  /**
   * The project's board as Markdown, for native agents without MCP: a projection of the store,
   * deterministic for the same records, never read back. At most `projectionMaxTasks` tasks.
   */
  async tasksMarkdown(projectId: string): Promise<string> {
    const project = this.projectOf(projectId).project
    return renderTasks(project, await this.tasks({ projectId }), this.config.projectionMaxTasks ?? 200)
  }

  // --- projects ---

  async charter(input: CharterInput, at: Date = new Date()) {
    const { project, approvalRequest } = await this.charterProject(input, at)
    return { project, approvalRequest }
  }

  /**
   * Found a project or amend its charter (`charter`), retry-safe under `clientRequestId`: a call
   * with a key already used returns what that call made, with the charter version it asked about,
   * and changes nothing. Founding under a key derives the project's id from it, so a retry after a
   * crash between asking and recording asks about the same subject and adopts that request (M2).
   */
  async charterProject(input: CharterInput, at: Date = new Date(), clientRequestId?: string): Promise<{ project: Project; approvalRequest: string; charterVersion: number }> {
    const prior = clientRequestId === undefined ? undefined : this.priorRequest(clientRequestId, 'board_charter', input.projectId)
    if (prior) return this.priorCharter(prior)
    if (input.charter.approval !== undefined) throw new BoardError('invalid', 'a charter never carries its approval in: the operator gives it')
    const existing = input.projectId === undefined ? undefined : this.readProject(input.projectId)
    // A founding call declares milestones only as planned: funding one is the operator's decision, which a charter approval does not cover (M3).
    if (!existing && (input.milestones ?? []).some((m) => m.state !== 'planned' || m.funding !== undefined)) {
      throw new BoardError('invalid', 'a new project\'s milestones are planned, with no funding: a milestone is funded by its own approval')
    }
    const projectId = input.projectId ?? (clientRequestId !== undefined ? derivedId('proj', clientRequestId) : newId('proj'))
    const version = existing ? existing.project.charter.version + 1 : 1
    if (input.charter.version !== version) throw new BoardError('invalid', `the charter version must be ${version}`)
    if (existing && existing.project.state !== 'active' && existing.project.state !== 'paused') throw new BoardError('invalid-transition', `${projectId} is ${existing.project.state}: only an active or paused project amends its charter`)
    if (existing?.request) throw new BoardError('invalid-transition', `${projectId}: amendment ${existing.version} still waits for the operator (approval request ${existing.request})`)
    // Validated before anything is asked: an invalid charter opens no request.
    const draft: Project = existing
      ? changed(existing.project, at, { proposedCharter: input.charter })
      : {
        schema: 'project@1.0', projectId, title: input.title, state: 'proposed', charter: input.charter, milestones: input.milestones ?? [],
        ...(input.template ? { template: input.template } : {}), ...(input.classification ? { classification: input.classification } : {}),
        createdAt: at.toISOString(), revision: 0,
      }
    this.validProject(draft)
    const verdict = await this.ctx.approvals.check({ class: 'charter', projectId })
    if (verdict.mode !== 'ask') throw new BoardError('invalid', `a charter is always put to the operator; the policy says ${verdict.mode}`)
    const request = await this.ask({
      subject: { type: 'content', ref: charterRef(projectId, version), version: charterHash(input.charter) },
      action: { class: 'charter', summary: clamp(`${existing ? 'Amend' : 'Found'} ${draft.title}: ${input.charter.intent}`, 500) },
      requester: { component: 'board', projectId }, verdict, classification: draft.classification ?? 'operator-shared',
    }, at)
    try {
      return this.ctx.store.transaction((db) => {
        const again = clientRequestId === undefined ? undefined : this.priorRequest(clientRequestId, 'board_charter', input.projectId)
        if (again) return this.priorCharter(again)
        let project: Project
        if (existing) {
          const now = this.projectOf(projectId)
          if (now.project.revision !== existing.project.revision || now.request) throw new BoardError('conflict', `${projectId} changed while its charter was being asked about`)
          project = this.writeProject(now.project, draft, { request: request.requestId, version, expiresAt: request.expiresAt })
        } else {
          if (this.readProject(projectId)) throw new BoardError('conflict', `${projectId} already exists`)
          // Founding is the move — → proposed; the `autonomy` decision that asked is its decision.
          project = { ...draft, lastDecision: request.policy.decision }
          this.validProject(project)
          db.prepare('INSERT INTO board_projects (project_id, state, created_at, revision, record, charter_request, charter_version, charter_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(projectId, project.state, project.createdAt, project.revision, JSON.stringify(project), request.requestId, version, request.expiresAt)
        }
        if (clientRequestId !== undefined) this.recordRequest(clientRequestId, 'board_charter', projectId, undefined, request.requestId, at, version)
        return { project, approvalRequest: request.requestId, charterVersion: version }
      })
    } catch (error) {
      await this.withdrawUnheld(request.requestId, at)
      throw error
    }
  }

  // Pausing, resuming, and closing are the operator's project moves (docs/design/board.md#the-operators-project-moves).

  async pause(projectId: string, at: Date = new Date()) {
    return this.ctx.store.transaction(() => {
      const { project } = this.projectOf(projectId)
      if (project.state !== 'active') throw new BoardError('invalid-transition', `${projectId} is ${project.state}, not active`)
      return this.writeProject(project, changed(project, at, {
        state: 'paused', lastDecision: this.decision(project, undefined, {
          from: 'active', to: 'paused',
          why: 'paused: until it is resumed no task is claimed or started and no proposed task is put to the policy; a running attempt goes on to its outcome, and every wait keeps its expiry',
          whyNot: 'the operator paused it',
        }, at),
      }))
    })
  }

  async resume(projectId: string, at: Date = new Date()) {
    return this.ctx.store.transaction(() => {
      const { project } = this.projectOf(projectId)
      if (project.state !== 'paused') throw new BoardError('invalid-transition', `${projectId} is ${project.state}, not paused`)
      return this.writeProject(project, changed(project, at, {
        state: 'active', lastDecision: this.decision(project, undefined, {
          from: 'paused', to: 'active',
          why: 'resumed: its approved charter still holds; its proposed tasks go through the gate on the next sweep, and its ready tasks may be claimed again',
          whyNot: 'the operator resumed it',
        }, at),
      }))
    })
  }

  async close(projectId: string, outcome: 'achieved' | 'stopped', at: Date = new Date()) {
    return (await this.closeProject(projectId, outcome, at)).project
  }

  /** Close a project (`close`), and say how many open tasks the close cancelled (`board_close` reports it). */
  async closeProject(projectId: string, outcome: 'achieved' | 'stopped', at: Date = new Date()): Promise<{ project: Project; cancelled: number }> {
    if (outcome !== 'achieved' && outcome !== 'stopped') throw new BoardError('invalid', `a project closes as achieved or stopped, not ${String(outcome)}`)
    const before = this.projectOf(projectId)
    if (before.project.state !== 'active' && before.project.state !== 'paused') throw new BoardError('invalid-transition', `${projectId} is ${before.project.state}`)
    const open = await this.tasks({ projectId, states: [...OPEN] })
    if (open.some((t) => t.state === 'running' || t.state === 'review')) throw new BoardError('invalid-transition', `${projectId} has a task running or in review`)
    // With the queue unavailable nothing closes (rule 7): what waits on it is read before anything moves.
    await this.reachable([...open.flatMap((t) => (t.waiting?.approvalRequest ? [t.waiting.approvalRequest] : [])), ...(before.request ? [before.request] : [])])
    const { project, released, cancelled } = this.ctx.store.transaction(() => {
      const now = this.projectOf(projectId)
      if (now.project.revision !== before.project.revision) throw new BoardError('conflict', `${projectId} changed while it was being closed`)
      const { cancelled, released } = this.cancelOpen(now.project, at)
      const decision = this.decision(now.project, undefined, {
        from: now.project.state, to: 'closed', why: `closed as ${outcome}`, whyNot: `the operator closed it; ${cancelled} open task(s) cancelled`,
        detail: { outcome, cancelled },
      }, at)
      const closed = this.writeProject(now.project, changed(now.project, at, {
        state: 'closed', closure: { outcome, decision, at: at.toISOString() }, lastDecision: decision, proposedCharter: undefined,
      }), null)
      return { project: closed, released: [...released, ...(now.request ? [now.request] : [])], cancelled }
    })
    // Withdrawn only once the move committed (S7): a crash or a failed transaction leaves every wait as it was.
    await this.withdrawAll(released, at)
    return { project, cancelled }
  }

  /**
   * Cancel every open task of `project` (`project-closed`) inside the caller's transaction; refused
   * while one runs or is in review. Returns how many it cancelled and the requests they waited on,
   * which the caller withdraws once the transaction committed.
   */
  private cancelOpen(project: Project, at: Date): { cancelled: number; released: string[] } {
    const released: string[] = []
    let cancelled = 0
    for (const t of this.ctx.store.db.prepare(`SELECT task_id FROM board_tasks WHERE project_id = ? AND state IN (${OPEN.map(() => '?').join(', ')}) ORDER BY seq`).all(project.projectId, ...OPEN) as Array<{ task_id: string }>) {
      const current = this.taskOf(t.task_id)
      if (current.task.state === 'running' || current.task.state === 'review') throw new BoardError('invalid-transition', `${project.projectId} has a task running or in review`)
      if (current.task.waiting?.approvalRequest) released.push(current.task.waiting.approvalRequest)
      this.commit(current, this.cancelMove(project, current.task, 'project-closed', at), at)
      cancelled += 1
    }
    return { cancelled, released }
  }

  // --- tasks ---

  async propose(input: TaskInput, at: Date = new Date()) {
    return this.proposeTask(input, at)
  }

  /** Propose a task (`propose`), retry-safe under `clientRequestId`: a key already used returns the task it made. */
  proposeTask(input: TaskInput, at: Date = new Date(), clientRequestId?: string): BoardTask {
    return this.ctx.store.transaction((db) => {
      const prior = clientRequestId === undefined ? undefined : this.priorRequest(clientRequestId, 'board_propose', input.projectId)
      if (prior) return this.taskOf(prior.task_id!).task
      const { project } = this.projectOf(input.projectId)
      if (project.state === 'closed') throw new BoardError('invalid-transition', `${input.projectId} is closed`)
      for (const dep of input.dependsOn ?? []) {
        if (this.readTask(dep)?.task.projectId !== input.projectId) throw new BoardError('invalid', `dependency ${dep} is not a task of ${input.projectId}`)
      }
      if (input.milestone !== undefined && !project.milestones.some((m) => m.id === input.milestone)) throw new BoardError('invalid', `${input.projectId} has no milestone ${input.milestone}`)
      const max = input.maxAttempts ?? this.config.maxAttempts ?? 3
      if (!Number.isInteger(max) || max < 1 || max > 10) throw new BoardError('invalid', 'maxAttempts is a whole number from 1 to 10')
      const writes = writesKey(input.writes)
      if (writes && db.prepare('SELECT 1 FROM board_tasks WHERE writes = ?').get(writes)) throw new BoardError('conflict', `another open task writes ${input.writes!.type} ${input.writes!.ref} (INV-15)`)
      const task: BoardTask = {
        schema: 'board-task@1.0', taskId: newId('task'), projectId: input.projectId, title: input.title, goal: input.goal,
        acceptance: input.acceptance, dependsOn: input.dependsOn ?? [], actionClass: input.actionClass, state: 'proposed',
        attempts: { count: 0, max }, createdAt: at.toISOString(), revision: 0,
        ...(input.milestone !== undefined ? { milestone: input.milestone } : {}), ...(input.template !== undefined ? { template: input.template } : {}),
        ...(input.writes ? { writes: input.writes } : {}), ...(input.budget ? { budget: input.budget } : {}),
      }
      this.validTask(task)
      db.prepare('INSERT INTO board_tasks (task_id, project_id, state, created_at, revision, record, writes) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(task.taskId, task.projectId, task.state, task.createdAt, task.revision, JSON.stringify(task), writes)
      if (clientRequestId !== undefined) this.recordRequest(clientRequestId, 'board_propose', task.projectId, task.taskId, undefined, at)
      return task
    })
  }

  async claim(taskId: string, owner: string, ttlMs: number, at: Date = new Date()): Promise<Claim> {
    return this.ctx.store.transaction(() => {
      const current = this.taskOf(taskId)
      this.expectState(current.task, 'ready')
      const { project } = this.projectOf(current.task.projectId)
      if (project.state !== 'active') throw new BoardError('invalid-transition', `${project.projectId} is ${project.state}, not active`)
      let lease: Lease | undefined
      try {
        lease = this.ctx.leases.acquire(resourceOf(taskId), ttlMs, owner, at.getTime())
      } catch (error) {
        // A TTL that is not a positive whole number, or an owner that is not an id.
        if (error instanceof RangeError || error instanceof SchemaError) throw new BoardError('invalid', error.message)
        throw error
      }
      if (!lease) throw new BoardError('conflict', `the lease on ${resourceOf(taskId)} is held outside the board`)
      const leaseExpiresAt = new Date(lease.expiresAt).toISOString()
      this.commit(current, {
        changes: {
          state: 'claimed', holder: { owner, generation: lease.generation, leaseExpiresAt },
          lastDecision: this.decision(project, current.task, {
            from: 'ready', to: 'claimed', why: `${owner} took lease generation ${lease.generation} until ${leaseExpiresAt}`, whyNot: 'a ready task of an active project, free to claim',
            detail: { owner, generation: lease.generation },
          }, at),
        },
        lease: { token: lease.token, ttlMs },
      }, at)
      return { taskId, generation: lease.generation, leaseExpiresAt }
    })
  }

  async renew(taskId: string, generation: number, ttlMs: number, at: Date = new Date()): Promise<Claim> {
    return this.ctx.store.transaction(() => {
      const current = this.taskOf(taskId)
      const lease = this.holding(current, generation, at)
      let renewed: Lease
      try {
        renewed = this.ctx.leases.renew(lease, ttlMs, at.getTime())
      } catch (error) {
        if (error instanceof LeaseLost) throw new BoardError('stale-generation', `${taskId}: generation ${generation} no longer holds it (${error.message})`)
        if (error instanceof RangeError) throw new BoardError('invalid', error.message)
        throw error
      }
      const leaseExpiresAt = new Date(renewed.expiresAt).toISOString()
      // A renewal moves nothing: no decision, the holder's lease only.
      this.commit(current, { changes: { holder: { ...current.task.holder!, leaseExpiresAt } }, lease: { token: renewed.token, ttlMs } }, at)
      return { taskId, generation, leaseExpiresAt }
    })
  }

  /** Renew the holder's lease for as long as it was claimed (`board_update`). */
  async heartbeat(taskId: string, generation: number, at: Date = new Date()): Promise<Claim> {
    const stored = this.taskOf(taskId)
    this.holding(stored, generation, at)
    return this.renew(taskId, generation, stored.ttlMs!, at)
  }

  async start(taskId: string, generation: number, run: { runId: string; brief?: ArtifactRef }, at: Date = new Date()) {
    return this.ctx.store.transaction(() => {
      const current = this.taskOf(taskId)
      this.fenced(current, generation, at)
      this.expectState(current.task, 'claimed')
      const { task } = current
      const { project } = this.projectOf(task.projectId)
      // Fail-closed rule 1: no task starts outside an active project.
      if (project.state !== 'active') throw new BoardError('invalid-transition', `${project.projectId} is ${project.state}, not active: nothing starts`)
      if (task.attempts.count >= task.attempts.max) throw new BoardError('invalid-transition', `${taskId} has used its ${task.attempts.max} attempt(s)`)
      if (run.brief !== undefined && !this.ctx.artifacts.get(run.brief)) throw new BoardError('invalid', `brief ${run.brief} is not a stored artifact`)
      return this.commit(current, {
        changes: {
          state: 'running', run: { runId: run.runId, ...(run.brief !== undefined ? { brief: run.brief } : {}), startedAt: at.toISOString() },
          attempts: { ...task.attempts, count: task.attempts.count + 1 }, result: undefined,
          lastDecision: this.decision(project, task, {
            from: 'claimed', to: 'running', why: `run ${run.runId} recorded before it starts, as attempt ${task.attempts.count + 1} of ${task.attempts.max}`,
            whyNot: `the holder of generation ${generation} starts it`, inputs: run.brief !== undefined ? [run.brief] : [], detail: { runId: run.runId, attempt: task.attempts.count + 1 },
          }, at),
        },
      }, at)
    })
  }

  async submit(taskId: string, generation: number, result: { artifacts: ArtifactRef[]; digest?: ArtifactRef; subject: Subject; files?: string[]; next?: string }, at: Date = new Date()) {
    return this.ctx.store.transaction(() => {
      const current = this.taskOf(taskId)
      this.fenced(current, generation, at)
      this.expectState(current.task, 'running')
      this.knownResult(result)
      this.writesWhatItHolds(current.task, result.subject)
      const { project } = this.projectOf(current.task.projectId)
      return this.commit(current, {
        changes: {
          state: 'review', result,
          lastDecision: this.decision(project, current.task, {
            from: 'running', to: 'review', why: `result recorded on ${result.subject.type} ${result.subject.ref}${result.subject.version ? ` at ${result.subject.version}` : ''}`,
            whyNot: 'a result is reviewed before it is done, never done directly', inputs: [...result.artifacts, ...(result.digest ? [result.digest] : [])],
          }, at),
        },
      }, at)
    })
  }

  async accept(taskId: string, acceptance: ArtifactRef, at: Date = new Date()) {
    const before = this.taskOf(taskId).task
    this.expectState(before, 'review')
    const read = this.readAcceptance(before, before.result!, acceptance)
    const held = await this.held(before, read)
    if (held) {
      if (before.waiting?.reason === 'operator-review') {
        throw new BoardError('invalid', `${acceptance} is not the operator's, and the class's required checks have not passed (autonomy decision ${held.verdict.decision}): the review is the operator's`)
      }
      return this.commitLater(before, at, undefined, (current) => this.holdMove(current.task, current.task.result!, acceptance, held, at))
    }
    const next = read.option === 'reject' && attemptLeft(before) ? await this.nextAttempt(before, at) : undefined
    return this.committing(next, at, () => this.commitLater(before, at, undefined, (current) => this.acceptanceMove(current.task, current.task.result!, acceptance, read, next, at)))
  }

  async reconcileRun(taskId: string, runId: string, outcome: RunOutcome, at: Date = new Date()) {
    const before = this.taskOf(taskId).task
    if (!(before.state === 'running' || (before.state === 'waiting-for-approval' && before.waiting?.reason === 'reconciliation-failed'))) {
      throw new BoardError('invalid-transition', `${taskId} is ${before.state}, not waiting on a run`)
    }
    if (before.run?.runId !== runId) throw new BoardError('invalid', `${taskId} recorded run ${before.run?.runId ?? '(none)'}, not ${runId}`)
    if (outcome.status !== 'completed' && outcome.status !== 'failed') throw new BoardError('invalid', 'a run is reported completed or failed; an unknown outcome is never reported')
    // Checked before anything moves, so a report that is refused changes nothing.
    let read: Acceptance | undefined
    let held: Held | undefined
    if (outcome.status === 'completed') {
      this.writesWhatItHolds(before, outcome.result.subject)
      read = this.readAcceptance(before, outcome.result, outcome.acceptance)
      held = await this.held(before, read)
    }
    const pending = before.waiting?.approvalRequest
    await this.reachable(pending ? [pending] : [])
    const next = (outcome.status === 'failed' || read!.option === 'reject') && attemptLeft(before) ? await this.nextAttempt(before, at) : undefined
    const moved = await this.committing(next, at, () => this.commitLater(before, at, undefined, (current) => {
      if (outcome.status === 'completed') return held ? this.holdMove(current.task, outcome.result, outcome.acceptance, held, at) : this.acceptanceMove(current.task, outcome.result, outcome.acceptance, read!, next, at)
      const { task } = current
      const { project } = this.projectOf(task.projectId)
      const why = `run ${runId} failed, as its owner reconciled it: attempt ${task.attempts.count} of ${task.attempts.max}`
      if (next) return this.nextAttemptMove(project, task, next, { why, detail: { runId, outcome: 'failed' } }, at)
      const decision = this.decision(project, task, {
        from: task.state, to: 'waiting-for-input', why, whyNot: 'the run\'s owner reported its outcome, so nothing waits on it', detail: { runId, outcome: 'failed' },
      }, at)
      return { changes: { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('retries-spent', at), lastDecision: decision } }
    }))
    // The move commits first and the request is withdrawn after (S7): a crash between them leaves an
    // open request nothing waits on, which expires on its own; the accepted result is kept.
    if (pending) await this.withdrawUnheld(pending, at)
    return moved
  }

  async block(taskId: string, generation: number, wait: { reason: 'budget-spent' | 'reconciliation-failed' | 'question'; questions?: string[]; funding?: BudgetLine[] }, at: Date = new Date()) {
    if (wait.funding !== undefined && wait.reason !== 'budget-spent') throw new BoardError('invalid', `only a budget-spent block asks for funding, not a ${String(wait.reason)} one`)
    if (wait.reason === 'question') {
      return this.ctx.store.transaction(() => {
        const current = this.taskOf(taskId)
        this.fenced(current, generation, at)
        this.expectState(current.task, 'running')
        if (!wait.questions?.length) throw new BoardError('invalid', 'a question wait names its questions')
        const { project } = this.projectOf(current.task.projectId)
        return this.commit(current, {
          changes: {
            state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('question', at, wait.questions),
            lastDecision: this.decision(project, current.task, {
              from: 'running', to: 'waiting-for-input', why: `the holder asked ${wait.questions.length} question(s) it cannot go on without`,
              whyNot: 'running on would guess at what only the lead or the operator can answer', detail: { questions: wait.questions },
            }, at),
          },
        }, at)
      })
    }
    if (wait.reason !== 'budget-spent' && wait.reason !== 'reconciliation-failed') throw new BoardError('invalid', `a task blocks on budget-spent, reconciliation-failed, or question, not ${String(wait.reason)}`)
    const before = this.taskOf(taskId)
    this.holding(before, generation, at)
    this.expectState(before.task, 'running')
    const funding = wait.funding === undefined ? undefined : this.fundingAsk(before.task, wait.funding)
    const past = funding && this.pastBound(before.task, funding)
    if (past) return this.commitLater(before.task, at, generation, (c) => this.pastBoundMove(c.task, funding!, past, at))
    return this.gate(before.task, wait.reason === 'budget-spent' ? 'funding' : 'remediation', wait.reason, at, generation, funding)
  }

  /**
   * The lines a `budget-spent` block asks for, as stored: 1 to {@link FUNDING_LINES} budget lines,
   * each of a pool and unit the task's budget has, once, with an amount above zero; `invalid`
   * otherwise, and nothing changes.
   */
  private fundingAsk(task: BoardTask, funding: unknown): BudgetLine[] {
    if (!Array.isArray(funding) || funding.length < 1 || funding.length > FUNDING_LINES) throw new BoardError('invalid', `a funding ask names 1 to ${FUNDING_LINES} budget lines`)
    const lines: BudgetLine[] = []
    for (const line of funding as unknown[]) {
      if (!isObject(line) || typeof line['pool'] !== 'string' || !UNITS.includes(line['unit'] as Unit) || typeof line['amount'] !== 'number' || !Number.isFinite(line['amount']) || line['amount'] <= 0 || line['amount'] > AMOUNT_MAX) {
        throw new BoardError('invalid', `${JSON.stringify(line)} is not a budget line to add (pool, unit of ${UNITS.join(', ')}, amount above 0 and at most ${AMOUNT_MAX})`)
      }
      const asked: BudgetLine = { pool: line['pool'], unit: line['unit'] as Unit, amount: line['amount'] }
      if (!task.budget?.some((b) => samePoolUnit(b, asked))) throw new BoardError('invalid', `${task.taskId} has no budget line of ${asked.unit} of ${asked.pool} to raise`)
      if (lines.some((l) => samePoolUnit(l, asked))) throw new BoardError('invalid', `a funding ask names ${asked.unit} of ${asked.pool} once`)
      lines.push(asked)
    }
    return lines
  }

  /**
   * Why adding `lines` would take the task's budget past the bound (INV-9), or undefined: no line
   * grows, over all its raises, by more than `fundingMaxPercent` of the amount the task declared
   * (its amount less what raises added), nor past the largest amount a line holds.
   */
  private pastBound(task: BoardTask, lines: readonly BudgetLine[]): string | undefined {
    const percent = this.config.fundingMaxPercent ?? 100
    for (const ask of lines) {
      const so = raisedSoFar(task, ask)
      for (const line of (task.budget ?? []).filter((b) => samePoolUnit(b, ask))) {
        const declared = round6(line.amount - so)
        const most = round6((declared * percent) / 100)
        if (round6(so + ask.amount) > most) {
          return `${ask.unit} of ${ask.pool} was declared ${declared}, raised ${so} so far, and ${ask.amount} more would raise it past ${most} in all (fundingMaxPercent ${percent})`
        }
        if (line.amount + ask.amount > AMOUNT_MAX) return `${ask.unit} of ${ask.pool} would exceed ${AMOUNT_MAX}`
      }
    }
    return undefined
  }

  /**
   * A funding ask past the bound: no request is opened, since no approval could apply it, so the
   * spent run goes on only with a person, as when the policy does not ask: the task waits for
   * input (`rejected`), and the work is proposed again if wanted (INV-9).
   */
  private pastBoundMove(task: BoardTask, funding: BudgetLine[], past: string, at: Date): Move {
    return {
      changes: {
        state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('rejected', at),
        lastDecision: this.decision(this.projectOf(task.projectId).project, task, {
          from: 'running', to: 'waiting-for-input', instead: 'waiting-for-approval',
          question: `Is task ${task.taskId}'s spent budget put to the operator with the funding its run asks for (${linesText(funding, '+')})?`,
          why: `budget-spent: ${past}, so no request is opened; a run past its budget goes on only with a person, so it waits for input`,
          whyNot: `asked about only within the bound per task (fundingMaxPercent ${this.config.fundingMaxPercent ?? 100}): no approval could apply this ask (INV-9)`,
          detail: { reason: 'budget-spent', actionClass: 'funding', funding, fundingMaxPercent: this.config.fundingMaxPercent ?? 100 },
        }, at),
      },
    }
  }

  async answer(taskId: string, answers: string[], at: Date = new Date()) {
    const before = this.taskOf(taskId).task
    this.expectState(before, 'waiting-for-input')
    const questions = before.waiting?.questions ?? []
    if (before.waiting?.reason !== 'question' || answers.length !== questions.length) {
      throw new BoardError('invalid', `answer every question of a question wait (${questions.length}); a ${before.waiting?.reason ?? 'missing'} wait takes no answers and only expires`)
    }
    if (answers.some((a) => typeof a !== 'string' || a.length === 0 || [...a].length > ANSWER_MAX)) throw new BoardError('invalid', `an answer is 1 to ${ANSWER_MAX} characters`)
    // The next run is another attempt, so the policy is asked again (S9).
    const next = attemptLeft(before) ? await this.nextAttempt(before, at) : undefined
    return this.committing(next, at, () => this.commitLater(before, at, undefined, (current) => {
      const { task } = current
      const { project } = this.projectOf(task.projectId)
      // The answers are the decision's detail, so the next attempt's brief can point to them.
      const detail = { questions, answers, ...(task.run ? { runId: task.run.runId } : {}) }
      const why = `every one of its ${questions.length} question(s) answered`
      if (next) return this.nextAttemptMove(project, task, next, { why, detail }, at)
      // A ready task with no attempt left could never start and would never expire (INV-9): it waits for input, which expires.
      return {
        changes: {
          state: 'waiting-for-input', waiting: this.inputWait('retries-spent', at), run: undefined,
          lastDecision: this.decision(project, task, {
            from: 'waiting-for-input', to: 'waiting-for-input', instead: 'ready',
            why: `${why}, but all ${task.attempts.max} attempt(s) are spent: it waits for input (retries-spent), which expires`,
            whyNot: `no attempt is left to start (${task.attempts.count} of ${task.attempts.max}), and a ready task never expires`,
            detail: { ...detail, reason: 'retries-spent' },
          }, at),
        },
      }
    }))
  }

  async cancel(taskId: string, reason: 'operator' | 'lead' | 'superseded', note?: string, at: Date = new Date()) {
    if (reason !== 'operator' && reason !== 'lead' && reason !== 'superseded') throw new BoardError('invalid', `a task is cancelled by the operator, the lead, or as superseded, not ${String(reason)}`)
    if (note !== undefined && (note.length === 0 || [...note].length > 500)) throw new BoardError('invalid', 'a cancellation note is 1 to 500 characters')
    const before = this.taskOf(taskId).task
    this.expectState(before, ...CANCELLABLE)
    const pending = before.waiting?.approvalRequest
    await this.reachable(pending ? [pending] : [])
    const cancelled = this.commitLater(before, at, undefined, (current) => this.cancelMove(this.projectOf(current.task.projectId).project, current.task, reason, at, undefined, note))
    // Withdrawn after the move committed (S7), as in reconcileRun.
    if (pending) await this.withdrawUnheld(pending, at)
    return cancelled
  }

  /**
   * Attach the digest of the task's current result, once (contract 1.1): a stored `digest@1.0`
   * report of exactly the result's artifacts. Never while the reviewer holds the review, since its
   * acceptance binds to the whole result, digest included; a review held for the operator takes
   * one. Nothing moves and no decision is made: the digest's settling decision records it.
   */
  async attachDigest(taskId: string, digest: ArtifactRef, at: Date = new Date()) {
    return this.ctx.store.transaction(() => {
      const current = this.taskOf(taskId)
      const { task } = current
      if (!task.result) throw new BoardError('invalid-transition', `${taskId} has no result to digest`)
      if (task.result.digest === digest) return task
      if (task.result.digest) throw new BoardError('invalid-transition', `${taskId}'s result already has digest ${task.result.digest}`)
      if (task.state === 'review' && task.waiting?.reason !== 'operator-review') {
        throw new BoardError('invalid-transition', `${taskId}'s reviewer holds the review: a digest attached now would change what the acceptance being made binds to`)
      }
      const envelope = this.ctx.artifacts.get(digest)
      const sources = envelope?.kind === 'report' && envelope.bodySchema === 'digest@1.0' ? (envelope.body as { sources?: unknown }).sources : undefined
      if (!Array.isArray(sources)) throw new BoardError('invalid', `${digest} is not a stored digest@1.0 report`)
      const artifacts = task.result.artifacts
      if (sources.length !== artifacts.length || artifacts.some((a) => !sources.includes(a))) {
        throw new BoardError('invalid', `${digest} digests ${sources.length} artifact(s), not exactly the ${artifacts.length} of ${taskId}'s result`)
      }
      return this.commit(current, { changes: { result: { ...task.result, digest } } }, at)
    })
  }

  async sweep(at: Date) {
    const tasks = new Map<string, BoardTask>()
    const projects = new Map<string, Project>()
    for (const { project_id } of this.ctx.store.db.prepare('SELECT project_id FROM board_projects WHERE charter_request IS NOT NULL ORDER BY created_at, project_id').all() as Array<{ project_id: string }>) {
      try {
        const moved = await this.settleCharter(project_id, at)
        if (moved) projects.set(moved.project.projectId, moved.project)
        for (const t of moved?.cancelled ?? []) tasks.set(t.taskId, t)
      } catch (error) {
        this.skipped(`the charter of ${project_id}`, error)
      }
    }
    // In insertion order, so a dependency moves before the tasks that depend on it.
    let after = 0
    for (;;) {
      const page = this.ctx.store.db.prepare(`SELECT seq, task_id FROM board_tasks WHERE seq > ? AND state IN (${OPEN.map(() => '?').join(', ')}) ORDER BY seq LIMIT ${SWEEP_PAGE}`)
        .all(after, ...OPEN) as Array<{ seq: number; task_id: string }>
      for (const { task_id } of page) {
        try {
          const moved = await this.sweepTask(task_id, at)
          if (moved) tasks.set(moved.taskId, moved)
        } catch (error) {
          this.skipped(task_id, error)
        }
      }
      if (page.length < SWEEP_PAGE) break
      after = Number(page.at(-1)!.seq)
    }
    return { tasks: [...tasks.values()], projects: [...projects.values()] }
  }

  // --- the sweep's moves ---

  /**
   * An approved charter takes effect; a refused first charter abandons its project, cancelling its
   * open tasks in the same transaction, and a refused amendment is dropped. A charter request the
   * queue never resolved, or no longer knows, is refused by the board itself once it expired
   * (INV-9): that decides nothing and starts nothing. One the queue withdrew on a policy change is
   * put to the policy again ({@link regateCharter}).
   */
  private async settleCharter(projectId: string, at: Date): Promise<Settled | undefined> {
    const before = this.projectOf(projectId)
    if (!before.request) return undefined
    const request = await this.ctx.approvals.get(before.request)
    // A request the queue withdrew on a policy change gets no verdict: the charter is put to the policy again.
    if (this.withdrawnByPolicy(request)) return this.regateCharter(before, request!, at)
    // Otherwise only the board withdraws a request, and only once nothing waits on it: a withdrawn one is not a verdict.
    const resolution = request?.resolution && request.resolution.cause !== 'withdrawn' ? request.resolution : undefined
    if (!resolution) {
      const due = earliest(before.expiresAt, request?.expiresAt)
      if (due === undefined || Date.parse(due) > at.getTime()) {
        if (!request) this.ctx.logger.warn(`board: the approval queue does not know ${before.request}, the charter request of ${projectId}; it waits until ${due ?? 'an expiry the board does not know'}`)
        return undefined
      }
      return this.expireCharter(before, request, due, at)
    }
    const settled = this.ctx.store.transaction((): (Settled & { released: string[] }) | undefined => {
      const now = this.projectOf(projectId)
      if (now.request !== before.request) return undefined
      const { project } = now
      const pending = project.state === 'proposed' ? project.charter : project.proposedCharter
      // INV-5: the verdict counts only for the exact charter it was asked about.
      const bound = pending !== undefined && pending.version === now.version && request!.subject.ref === charterRef(projectId, pending.version) && request!.subject.version === charterHash(pending)
      if (request!.state === 'approved' && !bound) this.ctx.logger.warn(`board: ${request!.requestId} does not bind the stored charter of ${projectId}; it is not applied`)
      const approval = request!.state === 'approved' && bound ? resolution.approval : undefined
      if (project.state === 'proposed') {
        if (approval) return { project: this.writeProject(project, changed(project, at, { state: 'active', charter: { ...project.charter, approval }, lastDecision: resolution.decision }), null), released: [], cancelled: [] }
        return this.abandon(project, resolution.decision, at)
      }
      if (project.state === 'closed' || !project.proposedCharter) {
        this.writeProject(project, undefined, null)
        return undefined
      }
      return {
        project: this.writeProject(project, changed(project, at, approval
          ? { charter: { ...project.proposedCharter, approval }, proposedCharter: undefined, lastDecision: resolution.decision }
          : { proposedCharter: undefined, lastDecision: resolution.decision }), null),
        released: [], cancelled: [],
      }
    })
    if (!settled) return undefined
    await this.withdrawAll(settled.released, at)
    return { project: settled.project, cancelled: settled.cancelled }
  }

  /** Close a proposed project as abandoned with `decision`, and cancel its open tasks, in the caller's transaction. */
  private abandon(project: Project, decision: ArtifactRef, at: Date): Settled & { released: string[] } {
    const open = (this.ctx.store.db.prepare(`SELECT task_id FROM board_tasks WHERE project_id = ? AND state IN (${OPEN.map(() => '?').join(', ')}) ORDER BY seq`).all(project.projectId, ...OPEN) as Array<{ task_id: string }>).map((r) => r.task_id)
    const { released } = this.cancelOpen(project, at)
    const closed = this.writeProject(project, changed(project, at, { state: 'closed', closure: { outcome: 'abandoned', decision, at: at.toISOString() }, lastDecision: decision }), null)
    return { project: closed, released, cancelled: open.map((id) => this.taskOf(id).task) }
  }

  /** The board's own refusal of a charter request that expired unresolved: a first charter abandons its project, an amendment is dropped. */
  private async expireCharter(before: StoredProject, request: ApprovalRequest | undefined, due: string, at: Date): Promise<Settled | undefined> {
    const requestId = before.request!
    const why = `its charter request ${requestId} expired at ${due} with no verdict${request ? '' : ' (the approval queue does not know it)'}`
    const settled = this.ctx.store.transaction((): (Settled & { released: string[] }) | undefined => {
      const now = this.projectOf(before.project.projectId)
      if (now.request !== requestId) return undefined
      const { project } = now
      if (project.state === 'proposed') {
        const decision = this.decision(project, undefined, {
          from: 'proposed', to: 'closed', why: `abandoned: ${why}`, whyNot: 'an unanswered charter is denied: nothing starts without an approved charter (INV-9)',
          inputs: request ? [request.policy.decision] : [], detail: { outcome: 'abandoned', approvalRequest: requestId, cause: 'expired' },
        }, at)
        return this.abandon(project, decision, at)
      }
      if (project.state === 'closed' || !project.proposedCharter) {
        this.writeProject(project, undefined, null)
        return undefined
      }
      const decision = this.decision(project, undefined, {
        from: 'amendment-pending', to: 'amendment-dropped', why: `amendment ${project.proposedCharter.version} dropped: ${why}`,
        whyNot: 'an unanswered amendment is denied, and the approved charter stays (INV-9)', inputs: request ? [request.policy.decision] : [],
        detail: { approvalRequest: requestId, version: project.proposedCharter.version, cause: 'expired' },
      }, at)
      return { project: this.writeProject(project, changed(project, at, { proposedCharter: undefined, lastDecision: decision }), null), released: [], cancelled: [] }
    })
    if (!settled) return undefined
    await this.withdrawAll([...settled.released, ...(request && !request.resolution ? [requestId] : [])], at)
    return { project: settled.project, cancelled: settled.cancelled }
  }

  private async sweepTask(taskId: string, at: Date): Promise<BoardTask | undefined> {
    const current = this.readTask(taskId)
    if (!current) return undefined
    const { task } = current
    switch (task.state) {
      case 'proposed': {
        const deps = task.dependsOn.map((d) => this.taskOf(d).task)
        if (deps.some((d) => d.state === 'cancelled')) {
          return this.commitLater(task, at, undefined, (c) => this.cancelMove(this.projectOf(task.projectId).project, c.task, 'dependency-cancelled', at))
        }
        const ripe = (): boolean => this.projectOf(task.projectId).project.state === 'active' && task.dependsOn.every((d) => this.taskOf(d).task.state === 'done')
        if (!ripe()) return undefined
        const verdict = await this.ctx.approvals.check({ class: task.actionClass, projectId: task.projectId })
        if (verdict.mode === 'ask') return this.waitForApproval(task, task.actionClass, 'approval-needed', verdict, at)
        return this.commitLater(task, at, undefined, (c) => {
          const { project } = this.projectOf(task.projectId)
          if (verdict.mode === 'forbid') return this.cancelMove(project, c.task, 'forbidden', at, verdict.decision)
          if (!ripe()) return undefined
          return this.readyMove(project, c.task, verdict, at, `every dependency is done and the policy gives ${task.actionClass} ${verdict.mode}`)
        })
      }
      case 'claimed':
        if (!this.lost(current, at)) return undefined
        return this.commitLater(task, at, undefined, (c) => ({
          changes: {
            state: 'ready', holder: undefined,
            lastDecision: this.decision(this.projectOf(task.projectId).project, c.task, {
              from: 'claimed', to: 'ready', why: `lease generation ${c.task.holder!.generation} lapsed before any run started`, whyNot: 'no run was recorded, so nothing is lost by releasing it',
              detail: { generation: c.task.holder!.generation },
            }, at),
          },
        }))
      case 'running':
        // The run's outcome is unknown here; its owner may still report it (reconcileRun), which withdraws the request (INV-4).
        if (!this.lost(current, at)) return undefined
        return this.gate(task, 'remediation', 'reconciliation-failed', at)
      case 'review':
        // A review held for the operator is bounded by its wait, the policy's for the class (INV-9).
        if (task.waiting?.reason === 'operator-review') {
          if (Date.parse(task.waiting.expiresAt) > at.getTime()) return undefined
          return this.commitLater(task, at, undefined, (c) => ({
            changes: {
              state: 'waiting-for-input', waiting: this.inputWait('review-expired', at),
              lastDecision: this.decision(this.projectOf(task.projectId).project, c.task, {
                from: 'review', to: 'waiting-for-input', why: `the operator gave no acceptance decision by ${c.task.waiting!.expiresAt}, the policy's wait for ${c.task.actionClass}`,
                whyNot: 'the board never accepts by default, and every wait for a person expires (INV-9)', detail: { reason: 'review-expired', heldFor: 'operator' },
              }, at),
            },
          }))
        }
        // Review is bounded: no acceptance decision came while the reviewer held the task (INV-9).
        if (!this.lost(current, at)) return undefined
        return this.commitLater(task, at, undefined, (c) => ({
          changes: {
            state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('review-expired', at),
            lastDecision: this.decision(this.projectOf(task.projectId).project, c.task, {
              from: 'review', to: 'waiting-for-input', why: `the reviewer's lease (generation ${c.task.holder!.generation}) lapsed with no acceptance decision`,
              whyNot: 'review is bounded by the reviewer\'s lease, and the board never accepts by default', detail: { reason: 'review-expired' },
            }, at),
          },
        }))
      case 'waiting-for-approval': {
        const requestId = task.waiting!.approvalRequest!
        const request = await this.ctx.approvals.get(requestId)
        // A request the queue withdrew on a policy change gets no verdict: the wait's gate runs again under the policy now.
        if (this.withdrawnByPolicy(request)) return this.regate(task, request!, at)
        // Otherwise only the board withdraws a request, and only once nothing waits on it: a task still
        // waiting on one it withdrew is a crash between the two (S7), so it keeps waiting for its owner's report.
        const resolution = request?.resolution && request.resolution.cause !== 'withdrawn' ? request.resolution : undefined
        if (!resolution) {
          // The board applies the wait's expiry itself when the queue has not (INV-9): it starts nothing and decides nothing.
          const due = earliest(task.waiting!.expiresAt, request?.expiresAt)!
          if (Date.parse(due) > at.getTime()) {
            if (!request) this.ctx.logger.warn(`board: the approval queue does not know ${requestId}, which ${taskId} waits on; it waits until ${due}`)
            return undefined
          }
          const moved = this.commitLater(task, at, undefined, (c) => ({
            changes: {
              state: 'waiting-for-input', waiting: this.inputWait('rejected', at),
              lastDecision: this.decision(this.projectOf(task.projectId).project, c.task, {
                from: 'waiting-for-approval', to: 'waiting-for-input',
                why: `its approval wait expired at ${due} with no verdict${request ? '' : ` (the approval queue does not know ${requestId})`}`,
                whyNot: 'an expired approval wait never starts work: it counts as rejected (INV-9)', inputs: request ? [request.policy.decision] : [],
                detail: { reason: 'rejected', approvalRequest: requestId, cause: 'expired' },
              }, at),
            },
          }))
          if (request && !request.resolution) await this.withdrawUnheld(requestId, at)
          return moved
        }
        // An approval counts only from the board's own request for this task (INV-5).
        const approved = request!.state === 'approved' && request!.requester.component === 'board' && request!.requester.taskId === taskId
        const funding = task.waiting!.reason === 'budget-spent' ? task.waiting!.funding : undefined
        // An approved funding ask raises exactly its lines, recorded, before the next attempt goes through the gate.
        if (approved && funding && attemptLeft(task)) return this.fund(task, funding, request!, at)
        // Going on after a spent budget or a lost run is another attempt: the policy is asked about the task's class again (S9).
        if (approved && task.waiting!.reason !== 'approval-needed' && attemptLeft(task)) {
          const next = await this.nextAttempt(task, at)
          return this.committing(next, at, () => this.commitLater(task, at, undefined, (c) => this.nextAttemptMove(this.projectOf(task.projectId).project, c.task, next, {
            decision: resolution.decision, why: `the operator approved going on after ${task.waiting!.reason} (request ${requestId})`,
          }, at)))
        }
        return this.commitLater(task, at, undefined, (c) => {
          if (!approved) return { changes: { state: 'waiting-for-input', waiting: this.inputWait('rejected', at), lastDecision: resolution.decision } }
          // attempts.count never exceeds attempts.max: an approval to go on with no attempt left starts nothing (INV-9).
          if (c.task.attempts.count >= c.task.attempts.max) return { changes: { state: 'waiting-for-input', waiting: this.inputWait('retries-spent', at), lastDecision: resolution.decision } }
          return { changes: { state: 'ready', waiting: undefined, run: undefined, lastDecision: resolution.decision } }
        })
      }
      case 'waiting-for-input':
        if (Date.parse(task.waiting!.expiresAt) > at.getTime()) return undefined
        return this.commitLater(task, at, undefined, (c) => this.cancelMove(this.projectOf(task.projectId).project, c.task, 'input-expired', at))
      default:
        return undefined
    }
  }

  /**
   * The operator approved a spent budget's funding ask. Only when the request binds to exactly the
   * lines the wait asked for (INV-5) and they still fit the bound per task (INV-9), the board adds
   * them to the budget, with a `board` decision naming the approval, and in the same transaction
   * the next attempt goes through the gate, that decision its cause: a crash anywhere before the
   * commit leaves the task waiting on the approved request, and the next sweep does it all again,
   * adopting the request the gate opened (INV-4). Otherwise nothing is raised, and the task waits
   * for input (`rejected`), since the ledger would refuse the next attempt again.
   */
  private async fund(task: BoardTask, funding: BudgetLine[], request: ApprovalRequest, at: Date): Promise<BoardTask | undefined> {
    const unbound = request.subject.version !== fundingVersion(contentId(funding))
    const past = unbound ? `its subject (${request.subject.version ?? 'no version'}) does not bind the lines the task asked for` : this.pastBound(task, funding)
    if (past) {
      return this.commitLater(task, at, undefined, (c) => ({
        changes: {
          state: 'waiting-for-input', waiting: this.inputWait('rejected', at),
          lastDecision: this.decision(this.projectOf(task.projectId).project, c.task, {
            from: 'waiting-for-approval', to: 'waiting-for-input', instead: 'funded',
            why: `the operator approved ${request.requestId}, but ${past}: nothing is raised, and the ledger would refuse the next attempt again, so it waits for input`,
            whyNot: unbound ? 'an approval counts only for the exact lines it was asked on (INV-5)' : `a raise past the bound per task (fundingMaxPercent ${this.config.fundingMaxPercent ?? 100}) is never applied (INV-9)`,
            inputs: [request.resolution!.decision], detail: { reason: 'rejected', approvalRequest: request.requestId, funding, cause: unbound ? 'unbound' : 'past-bound' },
          }, at),
        },
      }))
    }
    const next = await this.nextAttempt(task, at)
    return this.committing(next, at, () => this.commitLater(task, at, undefined, (c) => this.fundedMove(c.task, funding, request, next, at)))
  }

  /** The raise and the next attempt's move, in one: the budget plus exactly `funding`, the raise recorded, then the gate's outcome, whose decision names the raise's. */
  private fundedMove(task: BoardTask, funding: BudgetLine[], request: ApprovalRequest, next: NextAttempt, at: Date): Move {
    const { project } = this.projectOf(task.projectId)
    const resolution = request.resolution!
    const budget = raised(task.budget ?? [], funding)
    const decision = this.decision(project, task, {
      from: 'budget-spent', to: 'funded',
      question: `Is the budget of task ${task.taskId} of ${project.projectId} raised by the lines the operator approved on ${request.requestId}?`,
      why: `the operator approved ${request.requestId} on exactly ${linesText(funding, '+')} (approval ${resolution.approval}): the budget becomes ${linesText(budget)} before attempt ${task.attempts.count + 1} goes through the gate`,
      whyNot: 'an approved funding request raises exactly the lines it names, and no other move changes a task\'s budget',
      inputs: [resolution.decision, resolution.approval!],
      detail: { reason: 'budget-spent', approvalRequest: request.requestId, approval: resolution.approval, funding, budget },
    }, at)
    const raises = [...(task.funding ?? []), { lines: funding, approval: resolution.approval!, decision, at: at.toISOString() }]
    const move = this.nextAttemptMove(project, { ...task, budget, funding: raises }, next, {
      decision, why: `the operator approved going on after budget-spent (request ${request.requestId}), its budget raised by ${linesText(funding, '+')}`,
    }, at)
    return { changes: { schema: 'board-task@1.1', budget, funding: raises, ...move.changes } }
  }

  /**
   * Put a running task to the operator after a spent budget or a lost run (`funding`,
   * `remediation`): one approval request whatever the policy's mode, since such a run is never
   * readied or cancelled by the policy alone (INV-4, rule 3). The queue takes a request only on an
   * `ask` verdict, so under any other (forbid, and also auto or notify) the task waits for input
   * (`rejected`) instead: it never runs again without a person, and is not cancelled while its
   * run may still be live; the wait expires in turn. A holder's call presents its `generation`
   * again when the move commits. A spent budget's `funding` ask goes into the request's subject.
   */
  private async gate(task: BoardTask, actionClass: ActionClass, reason: 'budget-spent' | 'reconciliation-failed', at: Date, generation?: number, funding?: BudgetLine[]): Promise<BoardTask> {
    const verdict = await this.ctx.approvals.check({ class: actionClass, projectId: task.projectId })
    if (verdict.mode === 'ask') return this.waitForApproval(task, actionClass, reason, verdict, at, generation, funding)
    return this.commitLater(task, at, generation, (c) => ({
      changes: {
        state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('rejected', at),
        lastDecision: this.decision(this.projectOf(task.projectId).project, c.task, {
          from: 'running', to: 'waiting-for-input',
          why: `${reason}: the policy gives ${actionClass} ${verdict.mode}, under which no approval request can be opened, so the run goes on only with a person`,
          whyNot: verdict.mode === 'forbid' ? 'kept running, or cancelled while its run may still be live: neither, as the policy forbids going on'
            : `readied on ${verdict.mode}: a ${reason === 'budget-spent' ? 'run past its budget' : 'lost run'} never starts again without an operator's approval (INV-4)`,
          inputs: [verdict.decision], detail: { reason, actionClass, mode: verdict.mode, ...(funding ? { funding } : {}) },
        }, at),
      },
    }))
  }

  /**
   * Whether the queue withdrew `request` because the policy changed: cause `withdrawn`, and its
   * `approval` decision's decider is the rule `approvals.policy`. The board's own withdrawals
   * (`approvals.withdraw`) are not: those end a wait the board already moved (S7).
   */
  private withdrawnByPolicy(request: ApprovalRequest | undefined): boolean {
    if (request?.resolution?.cause !== 'withdrawn') return false
    const body = this.ctx.artifacts.get(request.resolution.decision)?.body as { decisionType?: string; decider?: { type?: string; id?: string } } | undefined
    return body?.decisionType === 'approval' && body.decider?.type === 'rule' && body.decider.id === 'approvals.policy'
  }

  /**
   * A task's request the queue withdrew on a policy change: no verdict will come, so the board runs
   * the wait's gate again under the policy loaded now, as a fresh gate. An `approval-needed` wait
   * becomes ready on auto or notify, waits on a new request on the same exact subject on ask
   * (adopting an open one), and is cancelled on forbid. A spent budget or a lost run goes on only
   * with a person, as {@link gate} says: a new request on ask, else a wait for input (`rejected`).
   */
  private async regate(task: BoardTask, withdrawn: ApprovalRequest, at: Date): Promise<BoardTask> {
    const reason = task.waiting!.reason as 'approval-needed' | 'budget-spent' | 'reconciliation-failed'
    const actionClass: ActionClass = reason === 'budget-spent' ? 'funding' : reason === 'reconciliation-failed' ? 'remediation' : task.actionClass
    const verdict = await this.ctx.approvals.check({ class: actionClass, projectId: task.projectId })
    // A spent budget's funding ask is asked again as it was: the same lines, the same subject.
    const request = verdict.mode === 'ask' ? await this.ask(this.taskRequest(task, actionClass, reason, verdict, task.waiting!.funding), at) : undefined
    try {
      return this.commitLater(task, at, undefined, (c) => this.regateMove(c.task, reason, actionClass, verdict, request, withdrawn, at))
    } catch (error) {
      if (request) await this.withdrawUnheld(request.requestId, at)
      throw error
    }
  }

  /** The move {@link regate} makes, with a `board` decision that names the withdrawal and the `autonomy` decision, and says why of every outcome the wait has. */
  private regateMove(task: BoardTask, reason: 'approval-needed' | 'budget-spent' | 'reconciliation-failed', actionClass: ActionClass, verdict: AutonomyVerdict, request: ApprovalRequest | undefined, withdrawn: ApprovalRequest, at: Date): Move {
    const { project } = this.projectOf(task.projectId)
    const outcomes: Array<{ option: TaskState; modes: Mode[]; why: string }> = reason === 'approval-needed'
      ? [
        { option: 'ready', modes: ['auto', 'notify'], why: 'it needs no person' },
        { option: 'waiting-for-approval', modes: ['ask'], why: `the operator is asked again, on a new request${request ? ` (${request.requestId})` : ''} on the same subject` },
        { option: 'cancelled', modes: ['forbid'], why: 'no attempt may run' },
      ]
      : [
        { option: 'waiting-for-approval', modes: ['ask'], why: `the operator is asked again, on a new request${request ? ` (${request.requestId})` : ''} on the same subject` },
        { option: 'waiting-for-input', modes: ['auto', 'notify', 'forbid'], why: `a ${reason === 'budget-spent' ? 'run past its budget' : 'lost run'} goes on only with an operator's approval (INV-4), and the queue takes a request only on ask` },
      ]
    const chosen = outcomes.find((o) => o.modes.includes(verdict.mode))!
    const declined = outcomes.filter((o) => o !== chosen)
    const pending = chosen.option === 'ready' ? verdict.failedChecks ?? [] : []
    const decision = this.decision(project, task, {
      from: task.state, to: chosen.option, instead: declined[0]!.option,
      question: `Where does task ${task.taskId} of ${project.projectId} go now that a policy change withdrew ${withdrawn.requestId}, the request its ${reason} wait was on?`,
      why: `a policy change withdrew ${withdrawn.requestId}, so no verdict will come; the policy now gives ${actionClass} ${verdict.mode}: ${chosen.why}${pending.length ? `; its required checks (${pending.join(', ')}) have not run yet and bind at acceptance` : ''}`,
      whyNot: `only on ${declined[0]!.modes.join(' or ')}, and the policy gives ${actionClass} ${verdict.mode}`,
      also: declined.slice(1).map((o) => ({ option: o.option, whyNot: `only on ${o.modes.join(' or ')}, and the policy gives ${actionClass} ${verdict.mode}` })),
      inputs: [withdrawn.resolution!.decision, verdict.decision],
      detail: {
        reason, actionClass, mode: verdict.mode, withdrawn: withdrawn.requestId, ...(request ? { approvalRequest: request.requestId } : {}), ...(pending.length ? { pendingChecks: pending } : {}),
        ...(task.waiting?.funding ? { funding: task.waiting.funding } : {}),
      },
    }, at)
    switch (chosen.option) {
      case 'ready': return { changes: { state: 'ready', holder: undefined, run: undefined, waiting: undefined, lastDecision: decision } }
      case 'cancelled': return this.cancelMove(project, task, 'forbidden', at, decision)
      case 'waiting-for-input': return { changes: { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('rejected', at), lastDecision: decision } }
      default: return { changes: { waiting: { reason, approvalRequest: request!.requestId, ...(task.waiting?.funding ? { funding: task.waiting.funding } : {}), since: at.toISOString(), expiresAt: request!.expiresAt }, lastDecision: decision } }
    }
  }

  /**
   * A charter request the queue withdrew on a policy change: no verdict will come, so the board
   * puts the same charter version to the policy again, as `charter` did. On ask, a new request on
   * the same exact subject (adopting an open one) that the project waits on; on any other verdict
   * no request can be opened, so nothing can approve it: a first charter abandons its project
   * (its open tasks cancelled), an amendment is dropped, as when refused.
   */
  private async regateCharter(before: StoredProject, withdrawn: ApprovalRequest, at: Date): Promise<Settled | undefined> {
    const { project } = before
    const projectId = project.projectId
    const founding = project.state === 'proposed'
    const pending = founding ? project.charter : project.proposedCharter
    const verdict = await this.ctx.approvals.check({ class: 'charter', projectId })
    const request = verdict.mode === 'ask' && pending !== undefined && project.state !== 'closed'
      ? await this.ask({
        subject: { type: 'content', ref: charterRef(projectId, pending.version), version: charterHash(pending) },
        action: { class: 'charter', summary: clamp(`${founding ? 'Found' : 'Amend'} ${project.title}: ${pending.intent}`, 500) },
        requester: { component: 'board', projectId }, verdict, classification: project.classification ?? 'operator-shared',
      }, at)
      : undefined
    let settled: (Settled & { released: string[] }) | undefined
    try {
      settled = this.ctx.store.transaction((): (Settled & { released: string[] }) | undefined => {
        const now = this.projectOf(projectId)
        if (now.request !== before.request) return undefined
        if (now.project.revision !== project.revision) throw new BoardError('conflict', `${projectId} changed while its charter was put to the policy again`)
        const charter = founding ? now.project.charter : now.project.proposedCharter
        if (now.project.state === 'closed' || !charter || charter.version !== now.version) {
          this.writeProject(now.project, undefined, null)
          return undefined
        }
        const [asked, refused] = founding ? ['proposed', 'closed'] : ['amendment-pending', 'amendment-dropped']
        const what = founding ? `the first charter of ${projectId}` : `amendment ${charter.version} of ${projectId}`
        const move = {
          question: `What becomes of ${what} now that a policy change withdrew ${withdrawn.requestId}, the request it waited on?`,
          inputs: [withdrawn.resolution!.decision, verdict.decision],
          detail: { withdrawn: withdrawn.requestId, version: charter.version, mode: verdict.mode, ...(request ? { approvalRequest: request.requestId } : {}), ...(founding && !request ? { outcome: 'abandoned' } : {}) },
        }
        if (request) {
          const decision = this.decision(now.project, undefined, {
            ...move, from: asked, to: asked, instead: refused,
            why: `a policy change withdrew ${withdrawn.requestId}, so no verdict will come; the policy still asks about charter: a new request ${request.requestId} on the same charter version`,
            whyNot: 'a charter is refused only by the operator\'s verdict or its expiry, and the policy still asks, so the operator is asked again',
          }, at)
          return { project: this.writeProject(now.project, changed(now.project, at, { lastDecision: decision }), { request: request.requestId, version: charter.version, expiresAt: request.expiresAt }), released: [], cancelled: [] }
        }
        const decision = this.decision(now.project, undefined, {
          ...move, from: asked, to: refused, instead: asked,
          why: `a policy change withdrew ${withdrawn.requestId}, so no verdict will come; the policy now gives charter ${verdict.mode}, under which no request can be opened, so nothing can approve it`,
          whyNot: `asked again only on ask, and the policy gives charter ${verdict.mode}`,
        }, at)
        if (founding) return this.abandon(now.project, decision, at)
        return { project: this.writeProject(now.project, changed(now.project, at, { proposedCharter: undefined, lastDecision: decision }), null), released: [], cancelled: [] }
      })
    } catch (error) {
      if (request) await this.withdrawUnheld(request.requestId, at)
      throw error
    }
    if (!settled) {
      if (request) await this.withdrawUnheld(request.requestId, at)
      return undefined
    }
    await this.withdrawAll(settled.released, at)
    return { project: settled.project, cancelled: settled.cancelled }
  }

  /**
   * The request that puts `task` to the operator, on `board-task:<id>:attempt:<n>` with the wait's
   * reason, where n is the attempts it already made: one request, and one approval, per attempt. A
   * spent budget's `funding` ask is its subject's version ({@link fundingVersion}), so the verdict
   * binds to exactly those lines (INV-5), and its summary and consequences name them.
   */
  private taskRequest(task: BoardTask, actionClass: ActionClass, reason: 'approval-needed' | 'budget-spent' | 'reconciliation-failed', verdict: AutonomyVerdict, funding?: BudgetLine[]): NewRequest {
    const { project } = this.projectOf(task.projectId)
    const asked = reason === 'budget-spent' ? funding : undefined
    return {
      subject: { type: 'content', ref: `board-task:${task.taskId}:attempt:${task.attempts.count}`, version: asked ? fundingVersion(contentId(asked)) : reason },
      action: {
        class: actionClass,
        summary: clamp(asked ? `${reason}: ${task.title}; raise its budget by ${linesText(asked, '+')}` : `${reason}: ${task.title}`, 500),
        ...(asked ? { consequences: clamp(this.fundingConsequences(task, asked), 2000) } : {}),
      },
      requester: { component: 'board', projectId: task.projectId, taskId: task.taskId, ...(task.run ? { runId: task.run.runId } : {}) },
      verdict, classification: project.classification ?? 'operator-shared',
    }
  }

  /** What approving a funding ask does, and what denying it does, as the operator reads it in the queue. */
  private fundingConsequences(task: BoardTask, funding: readonly BudgetLine[]): string {
    const budget = task.budget ?? []
    const denied = `Denied or unanswered: the budget stays ${linesText(budget)}, and the task waits for input (rejected) until it is cancelled.`
    if (!attemptLeft(task)) return `Approved: nothing is raised, since all ${task.attempts.max} attempt(s) are used; the task waits for input (retries-spent). ${denied}`
    return `Approved: the board adds exactly ${linesText(funding, '+')} to the task's budget, which becomes ${linesText(raised(budget, funding))}, and attempt ${task.attempts.count + 1} of ${task.attempts.max} goes through the autonomy policy for ${task.actionClass}. ${denied}`
  }

  /**
   * The policy's verdict on the task's class for its next attempt, and the request it opened when
   * the verdict asks (S9): every return to ready for a new attempt goes through the gate again, so
   * one approval never covers a later attempt.
   */
  private async nextAttempt(task: BoardTask, at: Date): Promise<NextAttempt> {
    const verdict = await this.ctx.approvals.check({ class: task.actionClass, projectId: task.projectId })
    if (verdict.mode !== 'ask') return { verdict }
    return { verdict, request: await this.ask(this.taskRequest(task, task.actionClass, 'approval-needed', verdict), at) }
  }

  /** Run `commit`; when it fails, withdraw the request `next` opened for it, unless something already waits on it. */
  private async committing<T>(next: NextAttempt | undefined, at: Date, commit: () => T): Promise<T> {
    try {
      return commit()
    } catch (error) {
      if (next?.request) await this.withdrawUnheld(next.request.requestId, at)
      throw error
    }
  }

  /**
   * The move back for a new attempt, by the verdict {@link nextAttempt} got: ready on auto or
   * notify, waiting for the operator's approval (`approval-needed`) on ask, cancelled on forbid.
   * Its `board` decision names the decision that caused it (if any) and the `autonomy` decision.
   */
  private nextAttemptMove(project: Project, task: BoardTask, next: NextAttempt, cause: { decision?: ArtifactRef; why: string; detail?: Record<string, unknown> }, at: Date): Move {
    const { verdict, request } = next
    const inputs = [...(cause.decision ? [cause.decision] : []), verdict.decision]
    const attempt = task.attempts.count + 1
    if (verdict.mode === 'forbid') {
      return this.cancelMove(project, task, 'forbidden', at, this.decision(project, task, {
        from: task.state, to: 'cancelled', why: `${cause.why}; the policy now forbids ${task.actionClass}, so no attempt ${attempt} runs`,
        whyNot: `another attempt would run an action the policy forbids (autonomy decision ${verdict.decision})`, inputs, detail: { ...cause.detail, reason: 'forbidden' },
      }, at))
    }
    if (request) {
      return {
        changes: {
          state: 'waiting-for-approval', holder: undefined, run: undefined, result: undefined,
          waiting: { reason: 'approval-needed', approvalRequest: request.requestId, since: at.toISOString(), expiresAt: request.expiresAt },
          lastDecision: this.decision(project, task, {
            from: task.state, to: 'waiting-for-approval', why: `${cause.why}; the policy asks about ${task.actionClass} before attempt ${attempt}`,
            whyNot: 'an approval covers one attempt only, never a later one', inputs, detail: { ...cause.detail, approvalRequest: request.requestId, attempt },
          }, at),
        },
      }
    }
    return this.readyMove(project, task, verdict, at, `${cause.why}; the policy gives ${task.actionClass} ${verdict.mode} for attempt ${attempt}`, { inputs: cause.decision ? [cause.decision] : [], ...(cause.detail ? { detail: cause.detail } : {}) })
  }

  /** Put the task to the operator: one request on `board-task:<id>:attempt:<n>`, which its wait follows, keeping a spent budget's funding ask. */
  private async waitForApproval(task: BoardTask, actionClass: ActionClass, reason: 'approval-needed' | 'budget-spent' | 'reconciliation-failed', verdict: AutonomyVerdict, at: Date, generation?: number, funding?: BudgetLine[]): Promise<BoardTask> {
    const request = await this.ask(this.taskRequest(task, actionClass, reason, verdict, funding), at)
    try {
      return this.commitLater(task, at, generation, () => ({
        changes: {
          state: 'waiting-for-approval', holder: undefined, ...(funding ? { schema: 'board-task@1.1' as const } : {}),
          waiting: { reason, approvalRequest: request.requestId, ...(funding ? { funding } : {}), since: at.toISOString(), expiresAt: request.expiresAt }, lastDecision: request.policy.decision,
        },
      }))
    } catch (error) {
      await this.withdrawUnheld(request.requestId, at)
      throw error
    }
  }

  /**
   * Open a request, or adopt the board's own request on the same exact subject that is open or
   * already approved: one a crash left between asking and committing, so a retried move asks the
   * operator once, and an approval given while the board was down still applies (INV-4, M2). The
   * subject is per attempt and per charter version, so an approval never adopts across them.
   */
  private async ask(request: NewRequest, at: Date): Promise<ApprovalRequest> {
    const open = await this.ctx.approvals.list({ states: ['open', 'batched', 'approved'], ...(request.requester.projectId ? { projectId: request.requester.projectId } : {}) })
    const orphan = open.find((r) => r.requester.component === 'board' && r.requester.taskId === request.requester.taskId
      && r.action.class === request.action.class && sameSubject(r.subject, request.subject))
    return orphan ?? this.ctx.approvals.request(request, at)
  }

  /**
   * Read each request before a move that will withdraw it commits, so that with the queue
   * unavailable the move fails and nothing moves (rule 7). Unknown ones are fine: nothing to withdraw.
   */
  private async reachable(requestIds: string[]): Promise<void> {
    for (const requestId of requestIds) await this.ctx.approvals.get(requestId)
  }

  private async withdrawAll(requestIds: string[], at: Date): Promise<void> {
    for (const requestId of requestIds) await this.withdrawUnheld(requestId, at)
  }

  /**
   * Withdraw a request nothing waits on: one a move ended (after that move committed), or one a move
   * opened (or adopted) but could not commit, unless a stored project or task waits on it: a
   * concurrent move adopted it first. If this fails, it expires on its own.
   */
  private async withdrawUnheld(requestId: string, at: Date): Promise<void> {
    const held = this.ctx.store.db.prepare('SELECT 1 FROM board_projects WHERE charter_request = ?').get(requestId)
      ?? this.ctx.store.db.prepare("SELECT 1 FROM board_tasks WHERE state = 'waiting-for-approval' AND json_extract(record, '$.waiting.approvalRequest') = ?").get(requestId)
    if (held) return
    try {
      await this.ctx.approvals.withdraw(requestId, at)
    } catch (error) {
      this.ctx.logger.warn(`board: could not withdraw ${requestId}; it expires on its own`)
      this.ctx.logger.warn(error)
    }
  }

  private skipped(what: string, error: unknown): void {
    // A conflict is another writer's move: the next sweep sees the new state.
    if (error instanceof BoardError && error.failure === 'conflict') return
    this.ctx.logger.warn(`board: the sweep left ${what} as it was`)
    this.ctx.logger.warn(error)
  }

  // --- moves ---

  /** Ready on an auto or notify verdict; its required checks that have not run yet bind at acceptance (S3), so they are recorded as pending. */
  private readyMove(project: Project, task: BoardTask, verdict: AutonomyVerdict, at: Date, why: string, cause: { inputs?: ArtifactRef[]; detail?: Record<string, unknown> } = {}): Move {
    const pending = verdict.failedChecks ?? []
    return {
      changes: {
        state: 'ready', holder: undefined, run: undefined, waiting: undefined,
        lastDecision: this.decision(project, task, {
          from: task.state, to: 'ready', why: pending.length ? `${why}; its required checks (${pending.join(', ')}) have not run yet and bind at acceptance` : why,
          whyNot: `the autonomy decision ${verdict.decision} says ${verdict.mode}, which needs no person`,
          inputs: [...(cause.inputs ?? []), verdict.decision], detail: { ...cause.detail, actionClass: task.actionClass, mode: verdict.mode, ...(pending.length ? { pendingChecks: pending } : {}) },
        }, at),
      },
    }
  }

  private cancelMove(project: Project, task: BoardTask, reason: CancelReason, at: Date, decision?: ArtifactRef, note?: string): Move {
    const why: Record<CancelReason, string> = {
      operator: 'the operator cancelled it', lead: 'the lead cancelled it', superseded: 'another task supersedes it', 'project-closed': `${project.projectId} closed`,
      'input-expired': `its wait for input expired at ${task.waiting?.expiresAt ?? at.toISOString()}`, forbidden: `the policy forbids ${task.actionClass}`,
      'dependency-cancelled': 'a task it depends on was cancelled, so it can never become ready',
    }
    return {
      changes: {
        state: 'cancelled', holder: undefined, waiting: undefined, cancellation: { reason, ...(note !== undefined ? { note } : {}), at: at.toISOString() },
        lastDecision: decision ?? this.decision(project, task, {
          from: task.state, to: 'cancelled', why: why[reason], whyNot: reason === 'input-expired' ? 'an expired wait never starts work (INV-9)' : `${task.state} is not running or in review, so it may stop here`,
          detail: { reason, ...(note !== undefined ? { note } : {}) },
        }, at),
      },
    }
  }

  /**
   * Read an `acceptance` decision on `result`, refused (`invalid`) unless it binds to this task's
   * exact result (rule 5, INV-5): an `acceptance` decision whose `outcome.detail` names the task
   * (`taskId`) and the result's exact subject (`subject`, version included), whose inputs hold every
   * artifact of the result (and its digest), and whose outcome is `accept` or `reject`. The checks
   * it reports are `outcome.detail.checks`; it is the operator's when both its decider and its
   * envelope's producer are the operator.
   */
  private readAcceptance(task: BoardTask, result: NonNullable<BoardTask['result']>, acceptance: ArtifactRef): Acceptance {
    this.knownResult(result)
    const envelope = this.ctx.artifacts.get(acceptance)
    const body = envelope?.kind === 'decision'
      ? envelope.body as { decisionType?: string; inputs?: string[]; decider?: { type?: string }; outcome?: { option?: string; detail?: Record<string, unknown> } }
      : undefined
    if (body?.decisionType !== 'acceptance') throw new BoardError('invalid', `${acceptance} is not an acceptance decision`)
    const detail = body.outcome?.detail ?? {}
    if (detail['taskId'] !== task.taskId) throw new BoardError('invalid', `${acceptance} does not name task ${task.taskId} (outcome.detail.taskId)`)
    const subject = detail['subject'] as Subject | undefined
    if (!isObject(subject) || !sameSubject(subject, result.subject)) {
      throw new BoardError('invalid', `${acceptance} does not name the result's exact subject ${result.subject.type} ${result.subject.ref}${result.subject.version ? ` at ${result.subject.version}` : ''} (outcome.detail.subject)`)
    }
    const missing = [...result.artifacts, ...(result.digest ? [result.digest] : [])].filter((a) => !body.inputs?.includes(a))
    if (missing.length) throw new BoardError('invalid', `${acceptance} does not decide on the whole result: ${missing.join(', ')} not among its inputs`)
    const option = body.outcome?.option
    if (option !== 'accept' && option !== 'reject') throw new BoardError('invalid', `${acceptance} decides ${String(option)}, neither accept nor reject`)
    const checks = detail['checks']
    if (checks !== undefined && (!isObject(checks) || Object.entries(checks).some(([k, v]) => !CHECKS.includes(k as Check) || typeof v !== 'boolean'))) {
      throw new BoardError('invalid', `${acceptance} reports checks that are not ${CHECKS.join(', ')} with true or false (outcome.detail.checks)`)
    }
    return {
      option, operator: body.decider?.type === 'operator' && envelope!.producer.type === 'operator',
      ...(checks !== undefined ? { checks: checks as Partial<Record<Check, boolean>> } : {}),
    }
  }

  /**
   * Required checks bind at acceptance, not at readiness (S3): an accepting decision that is not
   * the operator's applies only when the policy, given the checks the decision reports, leaves none
   * of the task's class's required checks failed, and does not forbid the class. Otherwise only the
   * operator's acceptance accepts the result now, and the review is held for the operator, for the
   * policy's wait for the class (undefined when the decision applies); a reject applies either way.
   */
  private async held(task: BoardTask, read: Acceptance): Promise<Held | undefined> {
    if (read.option !== 'accept' || read.operator) return undefined
    const verdict = await this.ctx.approvals.check({ class: task.actionClass, projectId: task.projectId, ...(read.checks ? { checks: read.checks } : {}) })
    if (verdict.mode !== 'forbid' && !verdict.failedChecks?.length) return undefined
    const { policies } = await this.ctx.approvals.policy(task.projectId)
    return { verdict, pendingChecks: verdict.mode === 'forbid' ? [] : verdict.failedChecks!, seconds: waitSeconds(policies, task.actionClass) }
  }

  /**
   * The review held for the operator: the result recorded, the lease released, and a wait of the
   * policy's length for the class, which ends `review-expired` (INV-9). Only the operator's
   * acceptance accepts it now; a rejection, or an accepting decision with the checks passed, still
   * applies. A `board` decision naming the acceptance and the autonomy verdict records it.
   */
  private holdMove(task: BoardTask, result: NonNullable<BoardTask['result']>, acceptance: ArtifactRef, held: Held, at: Date): Move {
    const { project } = this.projectOf(task.projectId)
    const expiresAt = new Date(at.getTime() + held.seconds * 1000).toISOString()
    const why = held.verdict.mode === 'forbid' ? `the policy forbids ${task.actionClass}` : `required check(s) ${held.pendingChecks.join(', ')} not passed`
    return {
      changes: {
        state: 'review', result, holder: undefined,
        waiting: { reason: 'operator-review', pendingChecks: held.pendingChecks, since: at.toISOString(), expiresAt },
        lastDecision: this.decision(project, task, {
          from: task.state, to: 'operator-review',
          why: `${acceptance} is not the operator's and ${why} (autonomy decision ${held.verdict.decision}): only the operator's acceptance accepts the result, until ${expiresAt}, the policy's wait for ${task.actionClass}`,
          whyNot: task.state === 'review'
            ? 'the board never accepts by default, and the reviewer\'s lease would end the operator\'s review when the run that holds it ends'
            : 'the run\'s owner reported a result the board never accepts by default',
          inputs: [acceptance, held.verdict.decision], detail: { reason: 'operator-review', pendingChecks: held.pendingChecks, expiresAt },
        }, at),
      },
    }
  }

  /** The move an `acceptance` decision read by {@link readAcceptance} makes: done when it accepts, else another attempt or a wait for input. */
  private acceptanceMove(task: BoardTask, result: NonNullable<BoardTask['result']>, acceptance: ArtifactRef, read: Acceptance, next: NextAttempt | undefined, at: Date): Move {
    if (read.option === 'accept') return { changes: { state: 'done', result: { ...result, acceptance }, holder: undefined, waiting: undefined, lastDecision: acceptance } }
    if (attemptLeft(task)) {
      return this.nextAttemptMove(this.projectOf(task.projectId).project, task, next!, {
        decision: acceptance, why: `the acceptance decision ${acceptance} rejected attempt ${task.attempts.count} of ${task.attempts.max}`,
      }, at)
    }
    return { changes: { state: 'waiting-for-input', holder: undefined, result, waiting: this.inputWait('retries-spent', at), lastDecision: acceptance } }
  }

  private inputWait(reason: WaitReason, at: Date, questions?: string[]): NonNullable<BoardTask['waiting']> {
    const seconds = this.config.inputExpirySeconds ?? 7 * 24 * 3600
    return { reason, ...(questions ? { questions } : {}), since: at.toISOString(), expiresAt: new Date(at.getTime() + seconds * 1000).toISOString() }
  }

  /** Record a `board` decision on a move the board makes: every candidate says why it was or was not chosen. */
  private decision(project: Project, task: BoardTask | undefined, move: Why, at: Date): ArtifactRef {
    const subject = task ? `task ${task.taskId} of ${project.projectId}` : `project ${project.projectId}`
    return this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'board', inputs: move.inputs ?? [],
      question: move.question ?? (move.instead ? `Does ${subject} go from ${move.from} to ${move.instead} or to ${move.to}?` : `Does ${subject} move from ${move.from} to ${move.to}?`),
      candidates: [
        { option: move.to, selected: true, reasons: [move.why] },
        move.instead ? { option: move.instead, selected: false, reasons: [`not ${move.instead}: ${move.whyNot}`] } : { option: move.from, selected: false, reasons: [`not kept ${move.from}: ${move.whyNot}`] },
        ...(move.also ?? []).map((o) => ({ option: o.option, selected: false, reasons: [`not ${o.option}: ${o.whyNot}`] })),
      ],
      decider: { type: 'rule', id: 'board.transition', version: '1' },
      outcome: { option: move.to, detail: { projectId: project.projectId, ...(task ? { taskId: task.taskId } : {}), from: move.from, at: at.toISOString(), ...move.detail } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'board' }, classification: project.classification ?? 'operator-shared' }).id as ArtifactRef
  }

  // --- the store ---

  /** Commit a move to the task as stored; its revision must be the one read (else `conflict`). A holder that goes releases its lease. */
  private commit(current: Stored, move: Move, at: Date): BoardTask {
    const next = changed(current.task, at, move.changes)
    this.validTask(next)
    const lease = next.holder ? move.lease ?? (current.token !== undefined ? { token: current.token, ttlMs: current.ttlMs! } : undefined) : undefined
    if (next.holder && !lease) throw new Error(`board: ${next.taskId} has a holder but no lease`)
    if (!next.holder && current.task.holder) {
      const held = this.leaseOf(current)
      if (held) this.ctx.leases.release(held)
    }
    const changes = this.ctx.store.db.prepare('UPDATE board_tasks SET state = ?, revision = ?, record = ?, writes = ?, lease_token = ?, lease_ttl_ms = ? WHERE task_id = ? AND revision = ?')
      .run(next.state, next.revision, JSON.stringify(next), TERMINAL.includes(next.state) ? null : writesKey(next.writes), lease?.token ?? null, lease?.ttlMs ?? null, next.taskId, current.task.revision).changes
    if (Number(changes) !== 1) throw new BoardError('conflict', `${next.taskId} changed under this move`)
    return next
  }

  /**
   * Commit a move decided before an await (on the approval queue): refused (`conflict`) when the
   * task changed meanwhile; a holder's write presents its generation again. `move` may decide that
   * nothing moves after all (undefined), and then nothing is written.
   */
  private commitLater(before: BoardTask, at: Date, generation: number | undefined, move: (current: Stored) => Move): BoardTask
  private commitLater(before: BoardTask, at: Date, generation: number | undefined, move: (current: Stored) => Move | undefined): BoardTask | undefined
  private commitLater(before: BoardTask, at: Date, generation: number | undefined, move: (current: Stored) => Move | undefined): BoardTask | undefined {
    return this.ctx.store.transaction(() => {
      const current = this.taskOf(before.taskId)
      if (current.task.revision !== before.revision) throw new BoardError('conflict', `${before.taskId} changed while the board waited on the approval queue`)
      if (generation !== undefined) this.fenced(current, generation, at)
      const next = move(current)
      return next ? this.commit(current, next, at) : undefined
    })
  }

  /** Write a project's next revision (revision-checked); `pending` sets or clears (null) its charter request, undefined keeps it. */
  private writeProject(before: Project, next: Project | undefined, pending?: { request: string; version: number; expiresAt: string } | null): Project {
    const record = next ?? before
    if (next) this.validProject(next)
    const keep = pending === undefined ? 1 : 0
    const changes = this.ctx.store.db.prepare(`UPDATE board_projects SET state = ?, revision = ?, record = ?,
      charter_request = CASE WHEN ? THEN charter_request ELSE ? END, charter_version = CASE WHEN ? THEN charter_version ELSE ? END,
      charter_expires_at = CASE WHEN ? THEN charter_expires_at ELSE ? END
      WHERE project_id = ? AND revision = ?`)
      .run(record.state, record.revision, JSON.stringify(record), keep, pending?.request ?? null, keep, pending?.version ?? null, keep, pending?.expiresAt ?? null, record.projectId, before.revision).changes
    if (Number(changes) !== 1) throw new BoardError('conflict', `${record.projectId} changed under this move`)
    return record
  }

  private readTask(taskId: string): Stored | undefined {
    const row = this.ctx.store.db.prepare('SELECT record, lease_token, lease_ttl_ms FROM board_tasks WHERE task_id = ?').get(taskId) as { record: string; lease_token: string | null; lease_ttl_ms: number | null } | undefined
    if (!row) return undefined
    return { task: this.loadTask(taskId, row.record), ...(row.lease_token !== null ? { token: row.lease_token, ttlMs: Number(row.lease_ttl_ms) } : {}) }
  }

  private taskOf(taskId: string): Stored {
    const stored = this.readTask(taskId)
    if (!stored) throw new BoardError('unknown-task', `no task ${taskId}`)
    return stored
  }

  private readProject(projectId: string): StoredProject | undefined {
    const row = this.ctx.store.db.prepare('SELECT record, charter_request, charter_version, charter_expires_at FROM board_projects WHERE project_id = ?').get(projectId) as
      { record: string; charter_request: string | null; charter_version: number | null; charter_expires_at: string | null } | undefined
    if (!row) return undefined
    return {
      project: this.loadProject(projectId, row.record),
      ...(row.charter_request !== null ? { request: row.charter_request, version: Number(row.charter_version) } : {}),
      ...(row.charter_request !== null && row.charter_expires_at !== null ? { expiresAt: row.charter_expires_at } : {}),
    }
  }

  private projectOf(projectId: string): StoredProject {
    const stored = this.readProject(projectId)
    if (!stored) throw new BoardError('unknown-project', `no project ${projectId}`)
    return stored
  }

  /** A stored record is validated when it is read too: one that fails is never acted on (reference/schemas.md#validation-points). */
  private loadTask(taskId: string, json: string): BoardTask {
    const task = JSON.parse(json) as BoardTask
    try {
      this.schemas.assertRecord(task)
    } catch (error) {
      throw new Error(`board: the stored task ${taskId} is not a valid board-task@1.0 and is not used: ${(error as Error).message}`)
    }
    return task
  }

  private loadProject(projectId: string, json: string): Project {
    const project = JSON.parse(json) as Project
    try {
      this.schemas.assertRecord(project)
    } catch (error) {
      throw new Error(`board: the stored project ${projectId} is not a valid project@1.0 and is not used: ${(error as Error).message}`)
    }
    return project
  }

  private validTask(task: BoardTask): void {
    this.valid(task)
  }

  private validProject(project: Project): void {
    this.valid(project)
  }

  private valid(record: Project | BoardTask): void {
    try {
      this.schemas.assertRecord(record)
    } catch (error) {
      if (error instanceof SchemaError) throw new BoardError('invalid', error.message)
      throw error
    }
  }

  private priorRequest(clientRequestId: string, tool: 'board_charter' | 'board_propose', projectId: string | undefined): PriorRequest | undefined {
    const row = this.ctx.store.db.prepare('SELECT tool, project_id, task_id, approval_request, charter_version FROM board_client_requests WHERE client_request_id = ?').get(clientRequestId) as (PriorRequest & { tool: string }) | undefined
    if (!row) return undefined
    if (row.tool !== tool || (projectId !== undefined && row.project_id !== projectId)) throw new BoardError('conflict', `client request ${clientRequestId} was used for another call`)
    return row
  }

  private recordRequest(clientRequestId: string, tool: 'board_charter' | 'board_propose', projectId: string, taskId: string | undefined, approvalRequest: string | undefined, at: Date, charterVersion?: number): void {
    this.ctx.store.db.prepare('INSERT INTO board_client_requests (client_request_id, tool, project_id, task_id, approval_request, created_at, charter_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(clientRequestId, tool, projectId, taskId ?? null, approvalRequest ?? null, at.toISOString(), charterVersion ?? null)
  }

  /** What a board_charter call already made returns on a retry: the project as it now is, the request, and the version that call asked about (M6). */
  private priorCharter(prior: PriorRequest): { project: Project; approvalRequest: string; charterVersion: number } {
    const stored = this.projectOf(prior.project_id)
    // A key recorded before migration 2 has no version: the pending one while its request still waits, else the charter's.
    const charterVersion = prior.charter_version !== null ? Number(prior.charter_version)
      : stored.request === prior.approval_request && stored.version !== undefined ? stored.version : stored.project.charter.version
    return { project: stored.project, approvalRequest: prior.approval_request!, charterVersion }
  }

  // --- leases ---

  private leaseOf(stored: Stored): Lease | undefined {
    const holder = stored.task.holder
    if (!holder || stored.token === undefined) return undefined
    return { schema: 'lease@1.0', resource: resourceOf(stored.task.taskId), owner: holder.owner, token: stored.token, generation: holder.generation, expiresAt: Date.parse(holder.leaseExpiresAt) }
  }

  /** The holder's lease when `generation` holds the task at `at`, as the record says; else `stale-generation`. */
  private holding(stored: Stored, generation: number, at: Date): Lease {
    const lease = this.leaseOf(stored)
    if (!lease || lease.generation !== generation || lease.expiresAt <= at.getTime()) {
      throw new BoardError('stale-generation', `${stored.task.taskId}: generation ${generation} does not hold it`)
    }
    return lease
  }

  /** {@link holding}, and the lease's own fence inside the committing transaction (INV-4). */
  private fenced(stored: Stored, generation: number, at: Date): void {
    const lease = this.holding(stored, generation, at)
    try {
      this.ctx.leases.fence(lease, at.getTime())
    } catch (error) {
      if (error instanceof StaleGeneration || error instanceof LeaseLost) throw new BoardError('stale-generation', `${stored.task.taskId}: ${error.message}`)
      throw error
    }
  }

  /** Whether the holder's lease is gone at `at`: lapsed, or no longer the lease on the task's resource. */
  private lost(stored: Stored, at: Date): boolean {
    const lease = this.leaseOf(stored)
    if (!lease || lease.expiresAt <= at.getTime()) return true
    const held = this.ctx.leases.current(lease.resource)
    return !held || held.token !== lease.token || held.generation !== lease.generation || held.expiresAt <= at.getTime()
  }

  // --- checks ---

  private expectState(task: BoardTask, ...states: TaskState[]): void {
    if (!states.includes(task.state)) throw new BoardError('invalid-transition', `${task.taskId} is ${task.state}, not ${states.join(' or ')}`)
  }

  /** A task that writes a subject leaves a result on that subject (type and ref), at its new version (INV-15, M4). */
  private writesWhatItHolds(task: BoardTask, subject: Subject): void {
    if (task.writes && (subject.type !== task.writes.type || subject.ref !== task.writes.ref)) {
      throw new BoardError('invalid', `${task.taskId} writes ${task.writes.type} ${task.writes.ref}, so its result is on that subject, not ${subject.type} ${subject.ref}`)
    }
  }

  private knownResult(result: { artifacts: ArtifactRef[]; digest?: ArtifactRef }): void {
    for (const ref of [...result.artifacts, ...(result.digest ? [result.digest] : [])]) {
      if (!this.ctx.artifacts.get(ref)) throw new BoardError('invalid', `result artifact ${ref} is unknown`)
    }
  }

  private limitOf(limit: number | undefined): number {
    const bound = this.config.pageBound ?? 100
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new BoardError('invalid', 'a page size is a whole number from 1')
    return Math.min(limit ?? DEFAULT_PAGE, bound)
  }
}

export default StoreBoard
