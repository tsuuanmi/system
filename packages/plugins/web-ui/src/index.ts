/**
 * The operator's web UI (REQ-HOST "Web UI: status, watch"): runs, their steps, and each
 * step's decision chain, plus the operator's approve, deciding vote on a tie, stop, and continue;
 * and, when `ctx.approvals` is present, the approval queue by batch with the operator's verdicts
 * (docs/design/approvals.md), and the autonomy policy in force, its history, and the operator's
 * proposed changes, each asked in that queue (docs/design/approvals.md#a-policy-change); and, when
 * `ctx.board` is present, the board's tasks in review with the operator's acceptance, and its
 * projects with the operator's pause, resume, and close, and a ready task's start (docs/design/board.md); and the roster of every
 * Worker (docs/design/roster.md). It is served on the
 * DSH webserver under `/ui`, which is loopback-only:
 * - the page and script carry no data, under a strict content security policy;
 * - the token arrives in the URL fragment (never sent to a server), and the script sends it as
 *   a bearer token to `/ui/api`;
 * - the API accepts a loopback host only, no foreign Origin, and the operator token in constant time.
 * @module @tsuuanmi/system-web-ui
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { assertSafeBind, canTakeStep, guardRequest, LOOPBACK_HOSTS, readJsonBody, readRoster, type RosterServices, scopeToken, tokenFile } from '@tsuuanmi/system-gateway-core'
import { ALWAYS_ASK, type ApprovalRequest, ApprovalsError, type AutonomyPolicy, type Subject, type Verdict } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import { type ArtifactRef, BoardError, type BoardTask, type Project, type TaskState } from '@tsuuanmi/system-board-core'
import { dshHome, registerSecretPath } from '@tsuuanmi/system-libs'
import type { TaskLanding, TemplateStep } from '@tsuuanmi/system-workflow'
import type { CapabilityDescriptor } from '@tsuuanmi/system-workers-core'
import { APP_CSS, APP_JS, PAGE } from './assets.ts'

export interface Config {
  /** Directory of the scope token files (default `<DSH_HOME>/system`); the UI takes `operator.token` (ADR-0023). */
  tokenDir?: string
  allowedHosts?: string[]
}

export const name = 'web-ui'
export const inject = ['webServer', 'workflow']
export const Config: z<Config> = z.object({
  tokenDir: z.string().description('Directory of the scope token files (default <DSH_HOME>/system); the UI takes operator.token'),
  allowedHosts: z.array(z.string()).default([...LOOPBACK_HOSTS]).description('Host names the UI answers'),
}) as unknown as z<Config>

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const MAX_BODY = 16_384
/** A proposed policy record is larger than a verdict: up to 64 rules and 200 commands of 200 characters. */
const MAX_POLICY_BODY = 131_072
/** Items of each part of "since you last looked", the latest first; pages of events one read goes through, newest first; running runs the live view shows. */
export const ACTIVITY_SHOWN = 50
const ACTIVITY_PAGES = 5
const ACTIVITY_STATES: TaskState[] = ['done', 'review', 'waiting-for-input', 'waiting-for-approval', 'cancelled']
export const LIVE_RUNS = 50
/**
 * Runs "Waiting for you" lists at most, and runs of each state one count reads at most (INV-9): as many
 * as the page's list of runs reads on each refresh; past them the count says it is partial.
 */
export const WAITING_RUNS = 50
const WAITING_READ = 100
/** Workers named per step of a start's preview, free and busy each. */
export const LIKELY_WORKERS = 8
/** Accepted results on their way into the repository that the reviews list, the latest first. */
export const ACCEPTED_SHOWN = 20
const LANDING_OPEN: ReadonlySet<string> = new Set(['watch', 'commit', 'committed', 'asked', 'merging'])
/** Reviewers' verdicts a run's review read lists at most, newest first, and the characters of its report. */
export const REVIEW_VERDICTS = 20
export const REVIEW_REPORT_CHARS = 32_000
/** Verdicts a run's review read counts at most: past them, `more` is at least what it says. */
export const REVIEW_VERDICTS_COUNTED = 100
/** Policy changes the page lists, newest first. */
export const POLICY_HISTORY = 20
/** Verdicts one call takes at most, as `approvals_decide` does (a batch holds at most 50). */
export const MAX_VERDICTS = 50
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const SUBJECT_TYPES: ReadonlyArray<Subject['type']> = ['content', 'git-head', 'pull-request', 'artifact', 'external']
/** A task's states before it is done or cancelled: what a pause holds or lets go on, and what a close cancels or is refused by. */
const OPEN_STATES: readonly TaskState[] = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval']

/**
 * What the activity and the live view read of the event log (`ctx.eventLog`, contract 1.1): the newest
 * entries first, before a cursor, so a read takes the latest of a run or a type and never the log forward.
 */
interface EventReads {
  query(filter: { type?: string; runId?: string; nodeId?: string; since?: string; beforeSeq?: number; order: 'desc'; limit: number }): Array<{ seq: number; at: string; type: string; nodeId?: string; data?: unknown }>
}

/** Entries a newest-first read gave, checked to be newest first: a log that read them in another order is refused, never shown as the latest (INV-2). */
function newestFirst<E extends { seq: number }>(entries: E[]): E[] {
  for (let i = 1; i < entries.length; i++) if (entries[i]!.seq >= entries[i - 1]!.seq) throw new Error('it did not read newest first (event log contract 1.1)')
  return entries
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const noteOf = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : undefined

/**
 * One verdict as the page sent it, with the exact subject the page showed (INV-5), or why it is
 * refused. A verdict with no note of its own takes the call's `note`.
 */
function verdictOf(value: unknown, note: string | undefined): Verdict | string {
  if (!isObject(value)) return 'a verdict is {requestId, subject, verdict, note?}'
  const { requestId, verdict } = value
  if (typeof requestId !== 'string' || !ID.test(requestId)) return 'requestId is not a request id'
  if (verdict !== 'approved' && verdict !== 'rejected') return 'verdict must be approved or rejected'
  const subject = subjectOf(value.subject)
  if (!subject) return 'subject must be the exact subject the page showed'
  const own = noteOf(value.note) ?? note
  return { requestId, subject, verdict, ...(own ? { note: own } : {}) }
}

/** A subject as the page sent it back, or undefined when it is not one. */
function subjectOf(subject: unknown): Subject | undefined {
  if (!isObject(subject) || !SUBJECT_TYPES.includes(subject.type as Subject['type']) || typeof subject.ref !== 'string' || !subject.ref || subject.ref.length > 512
    || (subject.version !== undefined && (typeof subject.version !== 'string' || subject.version.length > 128))) return undefined
  return { type: subject.type as Subject['type'], ref: subject.ref, ...(subject.version !== undefined ? { version: subject.version as string } : {}) }
}

const sameSubject = (a: Subject, b: Subject): boolean => a.type === b.type && a.ref === b.ref && a.version === b.version

/** A task in review as the page shows it: what it is, its exact result, what is still pending, and until when the operator has it. */
export function reviewOf(task: BoardTask, project: { projectId: string; title: string } | undefined): Record<string, unknown> {
  const result = task.result!
  return {
    taskId: task.taskId, title: task.title, goal: task.goal, actionClass: task.actionClass, acceptance: task.acceptance, attempts: task.attempts,
    project: project ?? { projectId: task.projectId }, subject: result.subject, artifacts: result.artifacts, ...(result.digest ? { digest: result.digest } : {}),
    ...(result.files ? { files: result.files } : {}), pendingChecks: task.waiting?.pendingChecks ?? [], run: task.run,
    heldFor: task.waiting?.reason === 'operator-review' ? 'operator' : 'reviewer',
    ...(task.waiting ? { since: task.waiting.since, expiresAt: task.waiting.expiresAt } : task.holder ? { expiresAt: task.holder.leaseExpiresAt } : {}),
    ...(task.lastDecision ? { lastDecision: task.lastDecision } : {}),
  }
}

/**
 * A project as the board page shows it: its state and the revision a move binds to, its charter
 * and a pending amendment, its open tasks per state (what a close would cancel, or what refuses
 * it), and its closure.
 */
export function projectOf(project: Project, open: readonly BoardTask[]): Record<string, unknown> {
  const counts = Object.fromEntries(OPEN_STATES.map((s) => [s, 0])) as Record<TaskState, number>
  for (const task of open) counts[task.state] += 1
  return {
    projectId: project.projectId, title: project.title, state: project.state, revision: project.revision,
    charter: { version: project.charter.version, intent: project.charter.intent }, ...(project.proposedCharter ? { amendment: project.proposedCharter.version } : {}),
    open: counts, ...(project.closure ? { closure: project.closure } : {}), ...(project.lastDecision ? { lastDecision: project.lastDecision } : {}),
    createdAt: project.createdAt, ...(project.updatedAt ? { updatedAt: project.updatedAt } : {}),
  }
}

/** Tasks a project's board lists per state at most, the most recently changed first; the rest are counted. */
export const CARDS_PER_STATE = 50
const ALL_STATES: readonly TaskState[] = [...OPEN_STATES, 'done', 'cancelled']

/**
 * A project's tasks as the board's cards show them, per state the most recently changed first, at
 * most {@link CARDS_PER_STATE} each (`more` counts the rest): what it is, its run, its lease's
 * holder, and what it waits on (an approval request the page links to its card).
 */
export function cardsOf(tasks: readonly BoardTask[], landingOf: (runId: string) => TaskLanding | undefined = () => undefined): { tasks: Array<Record<string, unknown>>; more: Partial<Record<TaskState, number>> } {
  const out: Array<Record<string, unknown>> = []
  const more: Partial<Record<TaskState, number>> = {}
  const changed = (t: BoardTask): string => t.updatedAt ?? t.createdAt
  for (const state of ALL_STATES) {
    const of = tasks.filter((t) => t.state === state).sort((a, b) => (changed(a) < changed(b) ? 1 : changed(a) > changed(b) ? -1 : 0))
    if (of.length > CARDS_PER_STATE) more[state] = of.length - CARDS_PER_STATE
    for (const t of of.slice(0, CARDS_PER_STATE)) {
      out.push({
        taskId: t.taskId, title: t.title, state: t.state, actionClass: t.actionClass, revision: t.revision, ...(t.template ? { template: t.template } : {}),
        attempts: { count: t.attempts.count, max: t.attempts.max }, createdAt: t.createdAt, ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
        ...(t.run ? { run: { runId: t.run.runId, startedAt: t.run.startedAt } } : {}),
        ...(t.holder ? { holder: { owner: t.holder.owner, leaseExpiresAt: t.holder.leaseExpiresAt } } : {}),
        ...(t.waiting ? { waiting: { reason: t.waiting.reason, ...(t.waiting.approvalRequest ? { approvalRequest: t.waiting.approvalRequest } : {}), since: t.waiting.since, expiresAt: t.waiting.expiresAt } } : {}),
        ...(t.state === 'done' && t.run ? landingCard(landingOf(t.run.runId)) : {}),
      })
    }
  }
  return { tasks: out, more }
}

/**
 * Where a done task's accepted result stands on its way into the repository (ADR-0060), as its card
 * shows it: the merge request it waits on, the merge commit, or why it was not merged. Nothing when
 * there is nothing to land.
 */
function landingCard(landing: TaskLanding | undefined): Record<string, unknown> {
  if (!landing || landing.state === 'none') return {}
  return {
    landing: {
      state: landing.state, ...(landing.branch ? { branch: landing.branch } : {}), ...(landing.base ? { base: landing.base.branch } : {}),
      ...(landing.head ? { head: landing.head } : {}), ...(landing.requestId ? { requestId: landing.requestId } : {}), ...(landing.commit ? { commit: landing.commit } : {}),
      ...(landing.reason && (landing.state === 'refused' || landing.state === 'rejected') ? { reason: landing.reason } : {}),
    },
  }
}

/** Open and batched requests in listing order (by batch, then expiry), grouped by batch; the unbatched last. */
export function byBatch(requests: readonly ApprovalRequest[]): Array<{ batchId?: string; requests: ApprovalRequest[] }> {
  const groups: Array<{ batchId?: string; requests: ApprovalRequest[] }> = []
  for (const request of requests) {
    const last = groups.at(-1)
    if (last && last.batchId === request.batchId) last.requests.push(request)
    else groups.push({ ...(request.batchId ? { batchId: request.batchId } : {}), requests: [request] })
  }
  return groups
}

export function apply(ctx: Context, config: Config = {}): void {
  const operator = scopeToken(config.tokenDir ?? join(dshHome(), 'system'), 'operator')
  // Agent Workers never read the operator token, wherever tokenDir puts it (ADR-0024).
  ctx.effect(() => registerSecretPath(tokenFile(config.tokenDir ?? join(dshHome(), 'system'), 'operator')))
  const hosts = config.allowedHosts ?? LOOPBACK_HOSTS

  const send = (res: ServerResponse, status: number, body: string, type: string): void => {
    res.writeHead(status, {
      'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    }).end(body)
  }
  const json = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')

  /** Loopback host, no foreign Origin, the bearer token: or the reason it is refused. */
  const refuse = (req: IncomingMessage): [number, string] | undefined => {
    const verdict = guardRequest(req, { tokens: { operator }, allowedHosts: hosts, sameOrigin: true })
    return verdict.ok ? undefined : [verdict.status, verdict.reason]
  }

  const readJson = async (req: IncomingMessage, maxBytes: number = MAX_BODY): Promise<Record<string, unknown>> => {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('a JSON body is required'), { status: 415 })
    const value = (await readJsonBody(req, maxBytes)) ?? {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Object.assign(new Error('a JSON object is required'), { status: 400 })
    return value as Record<string, unknown>
  }

  /**
   * The approval queue, when `ctx.approvals` is present (else 503): `GET approvals` lists open and
   * batched requests by batch; `POST approvals/decide` takes the operator's verdicts, each on the
   * exact subject the page showed. With `batchId`, every verdict must be for a request of that
   * batch, or nothing is decided. The UI is the operator's channel (ADR-0023): its verdicts go to
   * `ctx.approvals.decide` as the operator's (INV-6), at the wall clock.
   */
  const queue = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const approvals = ctx.get('approvals')
    if (!approvals) return json(res, 503, { error: 'the approval queue is not running' })
    if (path === 'approvals') return req.method === 'GET' ? json(res, 200, { batches: byBatch(await approvals.list()) }) : json(res, 405, { error: 'method not allowed' })
    if (path !== 'approvals/decide') return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      const list = body.verdicts
      if (!Array.isArray(list) || !list.length || list.length > MAX_VERDICTS) return json(res, 400, { error: `verdicts must be a list of 1 to ${MAX_VERDICTS}` })
      const note = noteOf(body.note)
      const verdicts: Verdict[] = []
      for (const [i, value] of list.entries()) {
        const verdict = verdictOf(value, note)
        if (typeof verdict === 'string') return json(res, 400, { error: `verdict ${i}: ${verdict}; nothing was decided` })
        verdicts.push(verdict)
      }
      if (body.batchId !== undefined) {
        if (typeof body.batchId !== 'string' || !ID.test(body.batchId)) return json(res, 400, { error: 'batchId is not a batch id' })
        // A batch verdict counts only for the requests of the batch the page showed.
        for (const v of verdicts) {
          if ((await approvals.get(v.requestId))?.batchId !== body.batchId) return json(res, 409, { error: `${v.requestId} is not in batch ${body.batchId}; nothing was decided` })
        }
      }
      return json(res, 200, { results: await approvals.decide(verdicts, new Date()) })
    } catch (error) {
      const status = error instanceof ApprovalsError ? 400 : (error as { status?: number }).status ?? 409
      return json(res, status, { error: (error as Error).message })
    }
  }

  /**
   * The autonomy policy, when `ctx.approvals` is present (else 503): `GET policy` gives the set in
   * force (its hash and source), every policy of it with the effective modes of the studio and of
   * each project, and, from a queue at contract 1.1, the latest changes; `POST policy/propose`
   * takes the operator's proposed record (INV-6) and answers with the change and the
   * `policy-change` request that asks for it in the queue, where only the operator's approval
   * applies it. A queue at contract 1.0 takes no change (`501`): its policy changes by
   * configuration and a restart.
   */
  const policy = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const approvals = ctx.get('approvals')
    if (!approvals) return json(res, 503, { error: 'the approval queue is not running' })
    if (path === 'policy') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const studio = await approvals.policy()
      const projects = await Promise.all((studio.set?.projects ?? []).map(async (projectId) => ({ projectId, ...(await approvals.policy(projectId)) })))
      return json(res, 200, {
        ...(studio.set ? { set: studio.set } : {}),
        policies: [...studio.policies, ...projects.flatMap((p) => p.policies.slice(1))],
        effective: [{ effective: studio.effective }, ...projects.map((p) => ({ projectId: p.projectId, effective: p.effective }))],
        proposals: typeof approvals.proposePolicy === 'function',
        // The classes that always ask, whatever a rule says: the page shows them fixed at ask.
        alwaysAsk: [...ALWAYS_ASK],
        ...(approvals.policyChanges ? { changes: await approvals.policyChanges({ limit: POLICY_HISTORY }) } : {}),
      })
    }
    if (path !== 'policy/propose') return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    if (!approvals.proposePolicy) return json(res, 501, { error: 'this approval queue takes policy changes by configuration and a restart only' })
    try {
      const body = await readJson(req, MAX_POLICY_BODY)
      if (typeof body.policy !== 'object' || body.policy === null || Array.isArray(body.policy)) return json(res, 400, { error: 'policy must be one autonomy-policy@1.0 record' })
      const note = noteOf(body.note)
      return json(res, 200, await approvals.proposePolicy({ policy: body.policy as AutonomyPolicy, ...(note ? { note } : {}) }, new Date()))
    } catch (error) {
      if (error instanceof ApprovalsError) return json(res, error.failure === 'not-asked' ? 409 : 400, { error: `${error.failure}: ${error.message}` })
      return json(res, (error as { status?: number }).status ?? 409, { error: (error as Error).message })
    }
  }

  /**
   * The board's tasks in review, when `ctx.board` is present (else 503): `GET reviews` lists them,
   * those held for the operator first; `POST reviews/<taskId>/decide` takes the operator's
   * acceptance or rejection of the exact result the page showed (its subject, INV-5). The verdict is
   * an `acceptance` decision made by the operator, through this channel only (INV-6): its decider
   * and producer are the operator's, it names the task and the result's subject, and every result
   * artifact is among its inputs, as the board requires; then `ctx.board.accept` applies it.
   */
  const reviews = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const board = ctx.get('board')
    const artifacts = ctx.get('artifacts')
    if (!board || !artifacts) return json(res, 503, { error: 'the board is not running' })
    if (path === 'reviews') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const listed: Array<Record<string, unknown>> = []
      for (const project of await board.projects()) {
        for (const task of await board.tasks({ projectId: project.projectId, states: ['review'] })) listed.push(reviewOf(task, { projectId: project.projectId, title: project.title }))
      }
      listed.sort((a, b) => (a.heldFor === b.heldFor ? String(a.expiresAt ?? '').localeCompare(String(b.expiresAt ?? '')) : a.heldFor === 'operator' ? -1 : 1))
      // The results accepted and still on their way into the repository (ADR-0060), the latest first: a verdict's consequence stays in sight.
      const accepted: Array<{ at: string; entry: Record<string, unknown> }> = []
      for (const project of await board.projects()) {
        for (const task of await board.tasks({ projectId: project.projectId, states: ['done'] })) {
          const landing = task.run ? ctx.workflow.landing(task.run.runId) : undefined
          if (landing && LANDING_OPEN.has(landing.state)) accepted.push({ at: task.updatedAt ?? task.createdAt, entry: { taskId: task.taskId, title: task.title, project: { projectId: project.projectId, title: project.title }, run: task.run, landing: landingCard(landing).landing } })
        }
      }
      accepted.sort((a, b) => b.at.localeCompare(a.at))
      return json(res, 200, { reviews: listed, accepted: accepted.slice(0, ACCEPTED_SHOWN).map((a) => a.entry) })
    }
    const match = /^reviews\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/decide$/.exec(path)
    if (!match) return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const taskId = match[1]!
    try {
      const body = await readJson(req)
      if (body.verdict !== 'accept' && body.verdict !== 'reject') return json(res, 400, { error: 'verdict must be accept or reject' })
      const subject = subjectOf(body.subject)
      if (!subject) return json(res, 400, { error: 'subject must be the exact subject of the result the page showed' })
      const note = noteOf(body.note)
      const task = await board.task(taskId)
      if (!task) return json(res, 404, { error: `unknown task ${taskId}` })
      if (task.state !== 'review' || !task.result) return json(res, 409, { error: `task ${taskId} is ${task.state}, not in review; nothing was decided` })
      // The verdict binds to the result the operator was shown: a result changed since is refused (INV-5).
      if (!sameSubject(subject, task.result.subject)) return json(res, 409, { error: `task ${taskId}'s result is on another subject than the page showed; nothing was decided` })
      const option = body.verdict
      const other = option === 'accept' ? 'reject' : 'accept'
      const decision = artifacts.recordDecision({
        decisionType: 'acceptance',
        question: `Does the operator accept the result of board task ${taskId}, attempt ${task.attempts.count}?`,
        inputs: [...task.result.artifacts, ...(task.result.digest ? [task.result.digest] : [])],
        candidates: [
          { option, selected: true, reasons: [`the operator ${option}s the result on ${task.result.subject.type} ${task.result.subject.ref}${task.result.subject.version ? ` at ${task.result.subject.version}` : ''}, on the web UI${note ? `: ${note}` : ''}`] },
          { option: other, selected: false, reasons: [`not ${other}: the operator chose ${option}`] },
        ],
        decider: { type: 'operator', id: 'operator.review', version: '1' },
        outcome: { option, detail: { taskId, subject: task.result.subject } },
        ...(note ? { rationale: note } : {}),
        deterministic: false,
      }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
      return json(res, 200, { task: await board.accept(taskId, decision, new Date()), decision })
    } catch (error) {
      if (error instanceof BoardError) return json(res, error.failure === 'unknown-task' ? 404 : 409, { error: `${error.failure}: ${error.message}` })
      return json(res, (error as { status?: number }).status ?? 409, { error: (error as Error).message })
    }
  }

  /**
   * The board's projects, when `ctx.board` is present (else 503): `GET projects` lists them, the
   * closed ones last, each with its open tasks per state; `POST projects/<projectId>/pause`,
   * `resume`, and `close` make the operator's project moves
   * (docs/design/board.md#the-operators-project-moves), each bound to the project's revision the
   * page showed: a project changed since is refused and nothing moves. The UI is the operator's
   * channel (INV-6), so the moves go to `ctx.board` from here, at the wall clock; the board
   * records each one's `board` decision (INV-13).
   */
  const projects = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const board = ctx.get('board')
    if (!board) return json(res, 503, { error: 'the board is not running' })
    if (path === 'projects') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const listed: Array<Record<string, unknown>> = []
      for (const project of await board.projects()) {
        const tasks = await board.tasks({ projectId: project.projectId, states: [...ALL_STATES] })
        listed.push({ ...projectOf(project, tasks.filter((t) => OPEN_STATES.includes(t.state))), ...cardsOf(tasks, (runId) => ctx.workflow.landing(runId)) })
      }
      // A stable sort: in creation order, the closed ones last.
      listed.sort((a, b) => Number(a.state === 'closed') - Number(b.state === 'closed'))
      return json(res, 200, { projects: listed })
    }
    const match = /^projects\/([^/]+)\/(pause|resume|close)$/.exec(path)
    if (!match) return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    let projectId: string
    try {
      // A project id may hold a slash: the page sends it encoded.
      projectId = decodeURIComponent(match[1]!)
    } catch {
      return json(res, 400, { error: 'not a project id' })
    }
    if (!ID.test(projectId)) return json(res, 400, { error: 'not a project id' })
    const move = match[2] as 'pause' | 'resume' | 'close'
    try {
      const body = await readJson(req)
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) return json(res, 400, { error: 'revision must be the project revision the page showed' })
      if (move === 'close' && body.outcome !== 'achieved' && body.outcome !== 'stopped') return json(res, 400, { error: 'outcome must be achieved or stopped' })
      const shown = await board.project(projectId)
      if (!shown) return json(res, 404, { error: `unknown project ${projectId}` })
      // The move binds to the project the operator confirmed: one changed since is refused (INV-5).
      if (shown.revision !== body.revision) return json(res, 409, { error: `project ${projectId} changed since the page showed it (revision ${shown.revision}, not ${String(body.revision)}); nothing was done` })
      const at = new Date()
      const moved = move === 'pause' ? await board.pause(projectId, at)
        : move === 'resume' ? await board.resume(projectId, at)
        : await board.close(projectId, body.outcome as 'achieved' | 'stopped', at)
      return json(res, 200, { project: moved, decision: moved.lastDecision })
    } catch (error) {
      if (error instanceof BoardError) return json(res, error.failure === 'unknown-project' ? 404 : 409, { error: `${error.failure}: ${error.message}` })
      return json(res, (error as { status?: number }).status ?? 409, { error: (error as Error).message })
    }
  }

  /**
   * The operator starts a ready board task's run (`tasks/<taskId>/start`), when `ctx.board` is
   * present (else 503), the way the lead does with MCP `run` and `task`: `GET` says what would run
   * (the task's template, step by step, and the Worker each step needs), `POST {revision, template}`
   * starts it with `ctx.workflow.start` for that task, the run claiming the ready task itself. The
   * start binds to the task and template the page showed (INV-5): a task changed since, no longer
   * ready, or naming no template or another one is refused (`409`) and nothing starts. A refusal
   * by the engine (a paused project, a spent budget, an overloaded host) is `409` with its reason.
   * A run the engine admitted and the board did not answer for is no refusal: `202` `{pending}`
   * names it, which starts once the board shows it recorded (T127).
   */
  const tasks = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const board = ctx.get('board')
    if (!board) return json(res, 503, { error: 'the board is not running' })
    const match = /^tasks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\/start$/.exec(path)
    if (!match) return json(res, 404, { error: 'not found' })
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const taskId = match[1]!
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined
      if (body && (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0)) return json(res, 400, { error: 'revision must be the task revision the page showed' })
      if (body && (typeof body.template !== 'string' || !body.template)) return json(res, 400, { error: 'template must be the template the page showed' })
      const task = await board.task(taskId)
      if (!task) return json(res, 404, { error: `unknown task ${taskId}` })
      if (task.state !== 'ready') return json(res, 409, { error: `task ${taskId} is ${task.state}, not ready: nothing was started` })
      if (!task.template) return json(res, 409, { error: `task ${taskId} names no template, so it cannot start from here: the lead starts it with a template it chooses (MCP run with task); nothing was started` })
      const steps = ctx.workflow.templateSteps(task.template)
      if (!steps) return json(res, 409, { error: `task ${taskId} names template ${task.template}, which is not served now (${ctx.workflow.refusedTemplates().find((t) => t.name === task.template)?.reason ?? 'no such template'}); nothing was started` })
      if (!body) return json(res, 200, { task: { taskId, title: task.title, revision: task.revision, template: task.template, attempts: task.attempts }, steps: await likelyWorkers(steps) })
      // The start binds to the task the operator confirmed: one changed since is refused (INV-5).
      if (task.revision !== body.revision) return json(res, 409, { error: `task ${taskId} changed since the page showed it (revision ${task.revision}, not ${String(body.revision)}); nothing was started` })
      if (task.template !== body.template) return json(res, 409, { error: `task ${taskId} runs template ${task.template}, not ${String(body.template)}; nothing was started` })
      // The task's own words are the run's input, as the requested change; a repeated press starts no second run.
      const run = await ctx.workflow.start({ template: task.template, input: `${task.title}\n\n${task.goal}`.slice(0, 32_000), task: { taskId, revision: task.revision }, clientRequestId: `web-ui:start:${taskId}:${task.revision}` })
      return json(res, 200, { run })
    } catch (error) {
      // Admitted all the same: it starts once the board shows it recorded, so never said as nothing started.
      const pending = (error as { runId?: unknown }).runId
      if (typeof pending === 'string') return json(res, 202, { pending: { runId: pending, reason: (error as Error).message } })
      return json(res, (error as { status?: number }).status ?? 409, { error: (error as Error).message })
    }
  }

  /**
   * Which Workers could likely take each step now (T124), for the operator to read before a start:
   * a Worker whose descriptor proves every capability the step needs (an offer of no scope), at the
   * step's tier or above, that takes its kind of work; \`free\` when it takes work now (ready, or busy
   * with a slot free), else \`busy\`. Read from \`ctx.workers.list()\`; it routes nothing and records
   * no decision: routing decides when the run starts. Each step without a registry gets \`unknown\`.
   */
  const likelyWorkers = async (steps: TemplateStep[]): Promise<Array<TemplateStep & { workers: { free: string[]; busy: string[] } | { unknown: string } }>> => {
    const registry = ctx.get('workers' as never) as { list(): Promise<CapabilityDescriptor[]> } | undefined
    let listed: CapabilityDescriptor[] | string
    try {
      listed = registry ? await registry.list() : 'the Worker registry (ctx.workers) is not mounted'
    } catch (error) {
      listed = `the Workers could not be read: ${(error as Error).message.slice(0, 200)}`
    }
    return steps.map((step) => {
      if (typeof listed === 'string') return { ...step, workers: { unknown: listed } }
      if (step.source) return { ...step, workers: { free: [], busy: [] } }
      // The same test capacity now tells a ready task's likely Worker by (gateway-core `canTakeStep`).
      const able = listed.filter((d) => canTakeStep(d, step))
      const free = (d: CapabilityDescriptor): boolean => d.state === 'ready' || (d.state === 'busy' && !!d.load && d.load.running < d.load.slots)
      const ids = (list: CapabilityDescriptor[]): string[] => list.map((d) => d.worker).sort().slice(0, LIKELY_WORKERS)
      return { ...step, workers: { free: ids(able.filter(free)), busy: ids(able.filter((d) => !free(d) && (d.state === 'busy' || d.state === 'quota-exhausted'))) } }
    })
  }

  /**
   * What happened since a time (\`GET activity?since=<ISO time>\`, T124), for Home's "since you last
   * looked": the runs that ended since (completed or failed), the board tasks that moved since into a
   * state the operator cares about (done, in review, waiting, cancelled) or whose accepted result
   * moved on its way in, and the approval requests that expired unanswered (\`approvals.resolved\`
   * events). Each part is read newest first and bounded per request: at most {@link ACTIVITY_SHOWN},
   * with \`more\` when it holds more than it shows or than it read (T127); one that cannot be read is
   * \`{unknown}\` with why, never empty (INV-2).
   */
  const activity = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since') ?? ''
    const since = new Date(raw)
    if (!raw || Number.isNaN(since.getTime())) return json(res, 400, { error: 'since must be an ISO time' })
    const at = since.toISOString()
    const shown = <T>(list: T[], more = false): { value: T[]; more?: true } => ({ value: list.slice(0, ACTIVITY_SHOWN), ...(more || list.length > ACTIVITY_SHOWN ? { more: true as const } : {}) })
    let runs: Record<string, unknown>
    try {
      // By state and when it changed, not among the latest started: a long run that ended since is found.
      runs = shown(ctx.workflow.usage(ACTIVITY_SHOWN + 1, { status: ['completed', 'failed'], changedSince: at }).map((r) => ({
        runId: r.runId, template: r.template, status: r.status, at: r.updatedAt, ...(r.task ? { taskId: r.task.taskId } : {}), ...(r.error ? { error: r.error.message.slice(0, 300) } : {}),
      })))
    } catch (error) {
      runs = { unknown: `the runs could not be read: ${(error as Error).message.slice(0, 200)}` }
    }
    const board = ctx.get('board')
    let tasks: Record<string, unknown>
    if (!board) tasks = { unknown: 'the board is not running' }
    else {
      try {
        const moved: Array<Record<string, unknown> & { at: string }> = []
        for (const project of await board.projects()) {
          for (const task of await board.tasks({ projectId: project.projectId, states: ACTIVITY_STATES })) {
            const landing = task.state === 'done' && task.run ? ctx.workflow.landing(task.run.runId) : undefined
            const changed = task.updatedAt ?? task.createdAt
            const landed = landing && landing.state !== 'none' && landing.at > at ? landing.at : undefined
            if (changed <= at && !landed) continue
            moved.push({ taskId: task.taskId, title: task.title, project: { projectId: project.projectId, title: project.title }, state: task.state, at: landed && landed > changed ? landed : changed,
              ...(task.waiting ? { waiting: { reason: task.waiting.reason, ...(task.waiting.approvalRequest ? { approvalRequest: task.waiting.approvalRequest } : {}) } } : {}),
              ...(task.run ? { run: { runId: task.run.runId } } : {}), ...landingCard(landing) })
          }
        }
        tasks = shown(moved.sort((a, b) => b.at.localeCompare(a.at)))
      } catch (error) {
        tasks = { unknown: `the board could not be read: ${(error as Error).message.slice(0, 200)}` }
      }
    }
    const eventLog = ctx.get('eventLog' as never) as EventReads | undefined
    const approvals = ctx.get('approvals')
    let expired: Record<string, unknown>
    if (!eventLog) expired = { unknown: 'the event log (ctx.eventLog) is not mounted' }
    else {
      try {
        // Newest first, a bounded number of pages: the latest that expired, never the oldest.
        const found: Array<{ requestId: string; at: string; summary?: string }> = []
        let before: number | undefined
        let read = false
        for (let page = 0; page < ACTIVITY_PAGES && found.length <= ACTIVITY_SHOWN; page++) {
          const entries = newestFirst(eventLog.query({ type: 'approvals.resolved', since: at, order: 'desc', limit: 1000, ...(before !== undefined ? { beforeSeq: before } : {}) }))
          for (const e of entries) {
            const data = e.data as { requestId?: unknown; cause?: unknown } | undefined
            if (data?.cause === 'expired' && typeof data.requestId === 'string') found.push({ requestId: data.requestId, at: e.at })
          }
          read = entries.length < 1000
          if (read) break
          before = entries.at(-1)!.seq
        }
        const part = shown(found, !read && found.length <= ACTIVITY_SHOWN)
        for (const item of part.value) {
          const request = await approvals?.get(item.requestId).catch(() => undefined)
          if (request) item.summary = request.action.summary
        }
        expired = part
      } catch (error) {
        expired = { unknown: `the event log could not be read: ${(error as Error).message.slice(0, 200)}` }
      }
    }
    return json(res, 200, { since: at, asOf: new Date().toISOString(), runs, tasks, expired })
  }

  /**
   * The running runs as they move (\`GET runs/live\`, T124): each running step, its Worker, when its
   * attempt started, the run's last event and when, and whether the Worker's source says it stalled
   * (\`ctx.workers.liveness\`, its own bound). A read only, bounded per request (T127): the running
   * runs by state, however long ago they started, at most {@link LIVE_RUNS} with \`more\` past them;
   * each run's latest event and each step's start read newest first, one entry each; a read that
   * fails is \`{unknown}\` with why, never a failed reply.
   */
  const live = async (res: ServerResponse): Promise<void> => {
    const eventLog = ctx.get('eventLog' as never) as EventReads | undefined
    const registry = ctx.get('workers' as never) as { liveness?: () => Promise<{ runs: Array<{ runId?: string; state: string; since: string }> }> } | undefined
    let stalled: Map<string, string> | string = new Map()
    if (registry?.liveness) {
      try {
        for (const r of (await registry.liveness()).runs) if (r.runId && r.state === 'stalled') (stalled as Map<string, string>).set(r.runId, r.since)
      } catch (error) {
        stalled = `the Workers' liveness could not be read: ${(error as Error).message.slice(0, 200)}`
      }
    } else stalled = 'no Worker source tells liveness'
    let running: ReturnType<typeof ctx.workflow.usage>
    try {
      // By state, not among the latest started: a run that has been running for hours is still live.
      running = ctx.workflow.usage(LIVE_RUNS + 1, { status: ['running'] })
    } catch (error) {
      return json(res, 200, { asOf: new Date().toISOString(), runs: { unknown: `the running runs could not be read: ${(error as Error).message.slice(0, 200)}` } })
    }
    /** The newest entry a read gives, or why there is none to give. */
    const newest = (filter: Omit<Parameters<EventReads['query']>[0], 'order' | 'limit'>): { entry?: ReturnType<EventReads['query']>[number] } | { unknown: string } => {
      if (!eventLog) return { unknown: 'the event log (ctx.eventLog) is not mounted' }
      try {
        const [entry] = newestFirst(eventLog.query({ ...filter, order: 'desc', limit: 1 }))
        return entry ? { entry } : {}
      } catch (error) {
        return { unknown: `the event log could not be read: ${(error as Error).message.slice(0, 200)}` }
      }
    }
    const runs = running.slice(0, LIVE_RUNS).map((r) => {
      const steps = r.nodes.filter((n) => n.state === 'RUNNING').map((n) => {
        // When its attempt started: the step's latest start, if it is this attempt's.
        const started = newest({ type: 'workflow.node.started', runId: r.runId, nodeId: n.nodeId })
        const since = 'entry' in started && started.entry && (started.entry.data as { attempt?: unknown } | undefined)?.attempt === n.attempt ? started.entry.at : undefined
        return { nodeId: n.nodeId, attempt: n.attempt, ...(n.worker ? { worker: n.worker } : {}), ...(since ? { since } : {}) }
      })
      const last = newest({ runId: r.runId })
      return {
        runId: r.runId, template: r.template, startedAt: r.createdAt, ...(r.task ? { taskId: r.task.taskId } : {}), steps,
        lastEvent: 'unknown' in last ? last : last.entry ? { value: { type: last.entry.type, at: last.entry.at, ...(last.entry.nodeId ? { nodeId: last.entry.nodeId } : {}) } } : { unknown: 'no event of it was recorded' },
        stalled: typeof stalled === 'string' ? { unknown: stalled } : { value: stalled.has(r.runId) ? { since: stalled.get(r.runId)! } : null },
      }
    })
    return json(res, 200, { asOf: new Date().toISOString(), runs: { value: runs, ...(running.length > LIVE_RUNS ? { more: true } : {}) } })
  }

  /**
   * What waits for the operator now (\`GET waiting?since=<ISO time>\`, T127): the one count the window's
   * title gives on every page and Home's "Waiting for you" lists, of what the operator can act on only:
   * - the approval requests open for a verdict (every tool call, fix, merge, or task approval a run or
   *   the board waits on is one of them);
   * - the reviews held for the operator (\`operator-review\`), not those a run's reviewer still holds;
   * - the runs that wait for the operator's own move and ask no request (a tie's deciding vote, a plan's
   *   approval), whenever they started; and the runs outside the board that failed since \`since\`, when
   *   the operator last marked Home as seen, which they may continue (a board task's run is not: the
   *   board decides its next attempt).
   * Each part is read by state, bounded; one that cannot be read is \`{unknown}\` with why, and \`count\`
   * then says \`partial\`, never a smaller count read as all (INV-2). A queue or board the composition
   * does not mount holds nothing that waits: 0, as the page shows it not running.
   */
  const waiting = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since')
    const since = raw === null ? undefined : new Date(raw)
    if (since && Number.isNaN(since.getTime())) return json(res, 400, { error: 'since must be an ISO time' })
    const why = (what: string, error: unknown): { unknown: string } => ({ unknown: `${what} could not be read: ${(error as Error).message.slice(0, 200)}` })
    const approvals = ctx.get('approvals')
    let requests: { value: number } | { unknown: string }
    try {
      // A queue the composition does not mount holds no request (the page shows it as not running).
      requests = { value: approvals ? (await approvals.list()).length : 0 }
    } catch (error) {
      requests = why('the approval queue', error)
    }
    const board = ctx.get('board')
    let reviews: { value: number; firstExpires?: string } | { unknown: string }
    // A board the composition does not mount holds no review.
    if (!board) reviews = { value: 0 }
    else {
      try {
        const held: string[] = []
        for (const project of await board.projects()) {
          for (const task of await board.tasks({ projectId: project.projectId, states: ['review'] })) if (task.waiting?.reason === 'operator-review') held.push(task.waiting.expiresAt)
        }
        held.sort()
        reviews = { value: held.length, ...(held[0] ? { firstExpires: held[0] } : {}) }
      } catch (error) {
        reviews = why('the board', error)
      }
    }
    let runs: { value: unknown[]; more?: true } | { unknown: string }
    try {
      const running = ctx.workflow.usage(WAITING_READ, { status: ['running'] })
      const failed = ctx.workflow.usage(WAITING_READ, { status: ['failed'], ...(since ? { changedSince: since.toISOString() } : {}) })
      const look = [...running.filter((r) => r.blocked && !('approvalRequest' in r.blocked && r.blocked.approvalRequest)), ...failed.filter((r) => !r.task)]
      runs = { value: look.slice(0, WAITING_RUNS), ...(look.length > WAITING_RUNS || running.length === WAITING_READ || failed.length === WAITING_READ ? { more: true as const } : {}) }
    } catch (error) {
      runs = why('the runs', error)
    }
    const parts = [requests, reviews, runs]
    const count = (('value' in requests) ? requests.value : 0) + (('value' in reviews) ? reviews.value : 0) + (('value' in runs) ? runs.value.length : 0)
    const partial = parts.some((p) => 'unknown' in p) || ('more' in runs && runs.more === true)
    return json(res, 200, { asOf: new Date().toISOString(), ...(since ? { since: since.toISOString() } : {}), requests, reviews, runs, count, ...(partial ? { partial: true } : {}) })
  }

  /**
   * The roster (docs/design/roster.md): `GET roster` gives every Worker in one read model, projected
   * on read from the services mounted, each one absent read as unknown with why, and its `now`,
   * capacity now (docs/design/roster.md#capacity-now), which the Workers page's "Right now" renders
   * as it is. The page is the operator's, so it shows account labels.
   */
  const roster = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const services: RosterServices = {
      workers: ctx.get('workers' as never) as RosterServices['workers'],
      accounts: ctx.get('accounts' as never) as RosterServices['accounts'],
      agentWorkers: ctx.get('agentWorkers' as never) as RosterServices['agentWorkers'],
      resources: ctx.get('resources' as never) as RosterServices['resources'],
      eventLog: ctx.get('eventLog' as never) as RosterServices['eventLog'],
      workflow: ctx.workflow as unknown as RosterServices['workflow'],
      board: ctx.get('board') as RosterServices['board'],
    }
    try {
      return json(res, 200, await readRoster(services, { scope: 'operator' }))
    } catch (error) {
      return json(res, 500, { error: `the roster could not be made: ${(error as Error).message.slice(0, 500)}` })
    }
  }

  /**
   * What the operator reads before a review verdict (`GET runs/<runId>/review`, T122): the run's
   * change in its worktrees, read only through `ctx.workers.changes` (each file with its lines and its
   * diff, bounded, from the source that holds the worktree); each reviewer's verdict on it (its
   * `assessment` artifacts, newest first, with how many more); the run's report (its last step's
   * answer, such as a validation's); and where its accepted result stands on its way into the
   * repository. A part that cannot be read is `{unknown}` with why, never empty (INV-2): a run whose
   * result names the workspace an agent worked in, whose change no source read, is not a run that
   * changed nothing.
   */
  const review = async (res: ServerResponse, runId: string): Promise<void> => {
    const run = ctx.workflow.get(runId)
    if (!run) return json(res, 404, { error: `unknown run ${runId}` })
    const artifacts = ctx.get('artifacts')
    const workers = ctx.get('workers' as never) as { changes?: (runId: string) => Promise<{ changes: unknown[]; unread: Array<{ source: string; detail: string }> }> } | undefined
    let change: Record<string, unknown>
    if (!workers) change = { unknown: 'the Worker registry (ctx.workers) is not mounted' }
    else if (typeof workers.changes !== 'function') change = { unknown: 'the Worker registry cannot read a run\'s change' }
    else {
      try {
        const read = await workers.changes(runId)
        if (read.changes.length || read.unread.length) change = { value: read }
        else if (!artifacts) change = { unknown: 'no Worker source read a change of this run, and whether its result names a workspace cannot be read (ctx.artifacts is not mounted)' }
        else {
          // Each result of the run, its last and each step's, once: an agent's names the workspace it worked in.
          const results = [...new Set([run.result, ...run.nodes.map((n) => n.result)].filter((r): r is NonNullable<typeof r> => r !== undefined))]
          const workspace = results.map((r) => artifacts.get(r)?.body as { schema?: unknown; workspace?: unknown } | undefined)
            .find((b) => typeof b?.schema === 'string' && b.schema.startsWith('agent-result@') && typeof b.workspace === 'string')?.workspace as string | undefined
          change = workspace === undefined ? { value: read } : { unknown: `no Worker source read the change in ${workspace}, the workspace the run's result names, so what it changed is not known` }
        }
      } catch (error) {
        change = { unknown: `the change could not be read: ${(error as Error).message.slice(0, 300)}` }
      }
    }
    let assessments: Record<string, unknown>
    if (!artifacts) assessments = { unknown: 'the artifact store (ctx.artifacts) is not mounted' }
    else {
      const listed = artifacts.list({ kind: 'assessment', runId, newest: true, limit: REVIEW_VERDICTS_COUNTED })
      assessments = {
        value: listed.slice(0, REVIEW_VERDICTS).map((a) => {
          const body = a.body as { verdict: string; findings: unknown[]; reviewer?: string }
          return { nodeId: a.nodeId, createdAt: a.createdAt, verdict: body.verdict, findings: body.findings, ...(body.reviewer ? { reviewer: body.reviewer } : {}) }
        }),
        more: Math.max(0, listed.length - REVIEW_VERDICTS),
        ...(listed.length === REVIEW_VERDICTS_COUNTED ? { moreAtLeast: true } : {}),
      }
    }
    const last = [...run.nodes].reverse().find((n) => n.result)
    const text = run.answer
    const report = text !== undefined && last ? { nodeId: last.nodeId, text: text.slice(0, REVIEW_REPORT_CHARS), ...(text.length > REVIEW_REPORT_CHARS ? { truncated: true } : {}) } : undefined
    const landing = ctx.workflow.landing(runId)
    return json(res, 200, { runId, change, assessments, ...(report ? { report } : {}), ...(landing && landing.state !== 'none' ? { landing: landingCard(landing).landing } : {}) })
  }

  const api = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const refused = refuse(req)
    if (refused) return json(res, refused[0], { error: refused[1] })
    if (path === 'roster') return roster(req, res)
    if (path === 'approvals' || path.startsWith('approvals/')) return queue(req, res, path)
    if (path === 'policy' || path.startsWith('policy/')) return policy(req, res, path)
    if (path === 'reviews' || path.startsWith('reviews/')) return reviews(req, res, path)
    if (path === 'projects' || path.startsWith('projects/')) return projects(req, res, path)
    if (path.startsWith('tasks/')) return tasks(req, res, path)
    if (path === 'activity') return activity(req, res)
    if (path === 'waiting') return waiting(req, res)
    if (path === 'runs/live') return req.method === 'GET' ? live(res) : json(res, 405, { error: 'method not allowed' })
    // Dispatch (ADR-0064): the starts System proposes, for Home's "Waiting for your go"; their verdicts go
    // through the approval queue (approvals/decide), each on its request's exact subject.
    if (path === 'dispatch') return req.method === 'GET' ? json(res, 200, ctx.workflow.dispatchStatus()) : json(res, 405, { error: 'method not allowed' })
    const workflow = ctx.workflow
    if (req.method === 'GET' && path === 'runs') return json(res, 200, { runs: workflow.usage(100) })
    const match = /^runs\/([A-Za-z0-9_-]{1,100})(?:\/(approve|vote|stop|continue|review))?$/.exec(path)
    if (!match) return json(res, 404, { error: 'not found' })
    const [, runId, action] = match as unknown as [string, string, string | undefined]
    if (!action && req.method === 'GET') {
      const run = workflow.get(runId)
      return run ? json(res, 200, { run, explain: workflow.explain(runId) }) : json(res, 404, { error: `unknown run ${runId}` })
    }
    if (action === 'review') return req.method === 'GET' ? review(res, runId) : json(res, 405, { error: 'method not allowed' })
    if (!action || req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    try {
      const body = await readJson(req)
      if (action === 'approve') {
        if (body.verdict !== 'approved' && body.verdict !== 'rejected') return json(res, 400, { error: 'verdict must be approved or rejected' })
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 2000) : undefined
        // The plan the page showed: the engine decides only that one (INV-5).
        const plan = typeof body.plan === 'string' && /^sha256:[0-9a-f]+$/.test(body.plan) ? body.plan : undefined
        return json(res, 200, { run: workflow.approve(runId, { verdict: body.verdict, ...(note ? { note } : {}), ...(plan ? { plan } : {}) }) })
      }
      if (action === 'vote') {
        // The tie the page showed: the engine decides only that one. The UI is the operator's (ADR-0023).
        const decision = typeof body.decision === 'string' && /^sha256:[0-9a-f]+$/.test(body.decision) ? body.decision : undefined
        const option = typeof body.option === 'string' && /^[A-Za-z0-9-]{1,16}$/.test(body.option) ? body.option : undefined
        const rationale = typeof body.rationale === 'string' ? body.rationale.trim().slice(0, 2000) : ''
        if (!decision || !option || !rationale) return json(res, 400, { error: 'a vote needs the tie decision, an option, and a rationale' })
        return json(res, 200, { run: workflow.vote(runId, { decision, option, rationale, by: 'operator' }) })
      }
      if (action === 'stop') return json(res, 200, { run: await workflow.stop(runId, typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined) })
      return json(res, 200, { run: workflow.continue(runId, typeof body.nodeId === 'string' ? body.nodeId : undefined) })
    } catch (error) {
      const status = (error as { status?: number }).status ?? 409
      return json(res, status, { error: (error as Error).message })
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/ui\/?/, '')
    if (path.startsWith('api/')) return api(req, res, path.slice(4))
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain')
    if (path === '' ) return send(res, 200, PAGE, 'text/html; charset=utf-8')
    if (path === 'app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8')
    if (path === 'app.css') return send(res, 200, APP_CSS, 'text/css; charset=utf-8')
    return send(res, 404, 'not found', 'text/plain')
  }

  ctx.effect(() => {
    // The token must not travel in clear text over a network (QA-5): no route on such a bind.
    assertSafeBind({ protocol: ctx.webServer.protocol, host: ctx.webServer.host })
    return ctx.webServer.register({ kind: 'prefix', path: '/ui', handler })
  })
}
