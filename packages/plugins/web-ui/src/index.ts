/**
 * The operator's web UI (REQ-HOST "Web UI: status, watch"): runs, their steps, and each
 * step's decision chain, plus the operator's approve, deciding vote on a tie, stop, and continue;
 * and, when `ctx.approvals` is present, the approval queue by batch with the operator's verdicts
 * (docs/design/approvals.md), and the autonomy policy in force, its history, and the operator's
 * proposed changes, each asked in that queue (docs/design/approvals.md#a-policy-change); and, when
 * `ctx.board` is present, the board's tasks in review with the operator's acceptance, and its
 * projects with the operator's pause, resume, and close (docs/design/board.md). It is served on the
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
import { assertSafeBind, guardRequest, LOOPBACK_HOSTS, readJsonBody, scopeToken, tokenFile } from '@tsuuanmi/system-gateway-core'
import { type ApprovalRequest, ApprovalsError, type AutonomyPolicy, type Subject, type Verdict } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import { type ArtifactRef, BoardError, type BoardTask, type Project, type TaskState } from '@tsuuanmi/system-board-core'
import { dshHome, registerSecretPath } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-workflow'
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
/** Policy changes the page lists, newest first. */
export const POLICY_HISTORY = 20
/** Verdicts one call takes at most, as `approvals_decide` does (a batch holds at most 50). */
export const MAX_VERDICTS = 50
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const SUBJECT_TYPES: ReadonlyArray<Subject['type']> = ['content', 'git-head', 'pull-request', 'artifact', 'external']
/** A task's states before it is done or cancelled: what a pause holds or lets go on, and what a close cancels or is refused by. */
export const OPEN_STATES: readonly TaskState[] = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval']

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
      return json(res, 200, { reviews: listed })
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
      for (const project of await board.projects()) listed.push(projectOf(project, await board.tasks({ projectId: project.projectId, states: [...OPEN_STATES] })))
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

  const api = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const refused = refuse(req)
    if (refused) return json(res, refused[0], { error: refused[1] })
    if (path === 'approvals' || path.startsWith('approvals/')) return queue(req, res, path)
    if (path === 'policy' || path.startsWith('policy/')) return policy(req, res, path)
    if (path === 'reviews' || path.startsWith('reviews/')) return reviews(req, res, path)
    if (path === 'projects' || path.startsWith('projects/')) return projects(req, res, path)
    const workflow = ctx.workflow
    if (req.method === 'GET' && path === 'runs') return json(res, 200, { runs: workflow.usage(100) })
    const match = /^runs\/([A-Za-z0-9_-]{1,100})(?:\/(approve|vote|stop|continue))?$/.exec(path)
    if (!match) return json(res, 404, { error: 'not found' })
    const [, runId, action] = match as unknown as [string, string, string | undefined]
    if (!action && req.method === 'GET') {
      const run = workflow.get(runId)
      return run ? json(res, 200, { run, explain: workflow.explain(runId) }) : json(res, 404, { error: `unknown run ${runId}` })
    }
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
