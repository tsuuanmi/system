/**
 * The `board_*` MCP tools (reference/schemas.md#mcp-tools-board_-approvals_-resources_). The
 * lead's are client scope; `board_pause`, `board_resume`, and `board_close` are operator scope,
 * because a project's state moves only from the operator's channel (INV-6). `board_escape` and
 * `board_breaker_reset` (the auto-accept circuit breaker, D93) are the lead's or the operator's, and
 * the caller's token says which it was. Each call's input and
 * structured output are validated against `schemas/mcp-board.v1.json` (1.3) `$defs/<tool>-input`
 * and `-output`; a refused input executes nothing, and a tool that changes the board checks the
 * output it would give inside the move's store transaction, before it commits, so an output its
 * schema refuses (a defect) leaves the board as it was. No tool starts, submits, accepts, blocks, or
 * reconciles a task: the workflow run that serves an attempt does, as its owner (MCP `run` with
 * `task`), so one attempt has one writer (INV-15).
 */
import type { Context } from '@deepseek-ai/cordis'
import { BoardError, type BoardTask, type Breaker, type CharterInput, type Claim, type Escape, type Project, type TaskInput } from '@tsuuanmi/system-board-core'
import { outline, reply, type ToolContext, type ToolHandler, type ToolScope, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import type { Chartered, Checked, Closed, Renewed, StoreBoard } from './index.ts'

export const BOARD_TOOLS = ['board_projects', 'board_charter', 'board_brief', 'board_tasks', 'board_task', 'board_propose', 'board_claim', 'board_update', 'board_cancel', 'board_pause', 'board_resume', 'board_close', 'board_escape', 'board_breakers', 'board_breaker_reset'] as const
type BoardTool = typeof BOARD_TOOLS[number]

/**
 * Who may call each tool: pausing, resuming, and closing a project are the operator's moves (INV-6).
 * An escape and a breaker's reset are the lead's or the operator's: who it was is the caller's token.
 */
const SCOPES: Record<BoardTool, ToolScope> = {
  board_projects: 'client', board_charter: 'client', board_brief: 'client', board_tasks: 'client', board_task: 'client', board_propose: 'client', board_claim: 'client',
  board_update: 'client', board_cancel: 'client', board_pause: 'operator', board_resume: 'operator', board_close: 'operator',
  board_escape: 'client', board_breakers: 'client', board_breaker_reset: 'client',
}

const schemas = new SchemaRegistry()
/** The tools' schema: 1.1 adds the operator's project moves, 1.2 `board_propose`'s `maxAttempts`, 1.3 the circuit breaker's tools. */
const MCP_BOARD = 'mcp-board@1.3'
/** The `$defs` name of a tool's input or output: underscores written as hyphens. */
const defOf = (tool: BoardTool, part: 'input' | 'output'): string => `${tool.replaceAll('_', '-')}-${part}`

// The vocabulary of schemas/common.v1.json, for the shapes clients see; Ajv checks the schema itself.
const id = () => zod.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
const shortText = () => zod.string().min(1).max(500)
const artifactRef = () => zod.string().regex(/^sha256:[0-9a-f]{64}$/)
const timestamp = () => zod.iso.datetime({ offset: true })
const projectState = () => zod.enum(['proposed', 'active', 'paused', 'closed'])
const taskState = () => zod.enum(['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval', 'done', 'cancelled'])
const actionClass = () => zod.enum(['read', 'workspace-write', 'merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change', 'promotion', 'dispatch'])
const subject = () => zod.strictObject({ type: zod.enum(['content', 'git-head', 'pull-request', 'artifact', 'external']), ref: zod.string().min(1).max(512), version: zod.string().max(128).optional() })
const budgetLine = () => zod.strictObject({ pool: id(), unit: zod.enum(['tokens', 'usd', 'turns', 'runs', 'minutes']), amount: zod.number().min(0).max(1e12) })
const charter = () => zod.strictObject({
  version: zod.number().int().min(1).max(1000),
  intent: zod.string().min(1).max(4000),
  criteria: zod.array(zod.strictObject({
    id: id(), statement: shortText(),
    measure: zod.strictObject({ kind: zod.enum(['accepted-results', 'tests', 'benchmark', 'metric', 'operator']), target: zod.number().optional(), comparison: zod.enum(['at-least', 'at-most']).optional(), unit: zod.string().min(1).max(32).optional() }),
  })).min(1).max(32),
  constraints: zod.strictObject({ deadline: timestamp().optional(), egressPolicy: id().optional(), notes: zod.array(shortText()).max(16).optional() }),
  stopRules: zod.array(zod.strictObject({ id: id(), condition: shortText(), action: zod.enum(['stop', 'pivot', 'pause']) })).min(1).max(16),
  budget: zod.strictObject({
    pools: zod.array(budgetLine()).min(1).max(16),
    attention: zod.strictObject({ maxBatchesPerDay: zod.number().int().min(0).max(100).optional(), maxInterruptionsPerDay: zod.number().int().min(0).max(100).optional() }).optional(),
  }),
}).describe('Version 1 for a new project, the current one plus 1 for an amendment')
const milestone = () => zod.strictObject({
  id: id(), title: zod.string().min(1).max(200), criteria: zod.array(id()).max(32).optional(), state: zod.enum(['planned', 'funded', 'done', 'dropped']),
  due: timestamp().optional(), budget: zod.array(budgetLine()).max(16).optional(), funding: artifactRef().optional(),
})
const page = { limit: zod.number().int().min(1).max(100).optional().describe('Page size (default 20)'), after: zod.string().min(1).max(200).optional().describe('The `next` cursor of the previous page') }
const generation = () => zod.number().int().min(1).describe('The lease generation the caller holds (a fence, INV-4)')

/** Input shapes, matching `$defs/<tool>-input`. */
export const INPUTS: Record<BoardTool, ToolSpec['inputSchema']> = {
  board_projects: { state: projectState().optional(), ...page },
  board_charter: {
    projectId: id().optional().describe('An existing project\'s id to amend (pivot), or a new one\'s; when absent, generated (from clientRequestId when given, so a retry names the same project)'),
    title: zod.string().min(1).max(200), template: id().optional(), classification: zod.enum(['public', 'operator-shared', 'local-private']).optional(),
    charter: charter(), milestones: zod.array(milestone()).max(64).optional(), clientRequestId: zod.string().min(1).max(200).optional().describe('Retry-safe request key'),
  },
  board_brief: { projectId: id() },
  board_tasks: { projectId: id(), states: zod.array(taskState()).min(1).max(9).optional(), milestone: id().optional(), ...page },
  board_task: { taskId: id() },
  board_propose: {
    projectId: id(), title: zod.string().min(1).max(200), goal: zod.string().min(1).max(4000),
    acceptance: zod.array(zod.strictObject({ id: id(), statement: shortText(), check: zod.enum(['tests', 'typecheck', 'lint', 'schema', 'quote-check', 'review', 'operator']).optional() })).min(1).max(32),
    dependsOn: zod.array(id()).max(64).optional(), actionClass: actionClass(), milestone: id().optional(), template: id().optional(),
    writes: subject().optional(), budget: zod.array(budgetLine()).max(16).optional(),
    maxAttempts: zod.number().int().min(1).max(10).optional().describe('Attempts the task gets (default: the board\'s for its template, else its maxAttempts, 3); each run that serves it is one, a rejected review included'),
    clientRequestId: zod.string().min(1).max(200).optional().describe('Retry-safe request key'),
  },
  board_claim: { taskId: id(), owner: id().describe('Who works on it, e.g. the lead\'s session id'), ttlSeconds: zod.number().int().min(30).max(3600).optional().describe('Lease length (default 600); board_update renews it') },
  board_update: {
    taskId: id(), generation: generation().optional(),
    note: zod.string().min(1).max(2000).optional().describe('A progress line, not stored: the run that serves the task gives its result'),
    // The shape of an answer is said once, on the array, which the generated reference shows (T99 D7).
    answers: zod.array(zod.strictObject({ question: zod.number().int().min(0).max(7), answer: zod.string().min(1).max(2000) })).min(1).max(8).optional()
      .describe('Answers to a question wait, each item {question, answer}: question is the question\'s index from 0 in the task\'s waiting.questions (board_task), answer your text; every question once, e.g. [{"question": 0, "answer": "Use the v2 API"}]. Answering every one sends the task through the gate for its next attempt'),
  },
  board_cancel: { taskId: id(), note: shortText().optional() },
  board_pause: { projectId: id() },
  board_resume: { projectId: id() },
  board_close: { projectId: id(), outcome: zod.enum(['achieved', 'stopped']).describe('achieved: its criteria are met; stopped: it ends without them') },
  board_escape: {
    taskId: id().describe('The done task whose auto-accepted result held the defect'),
    note: zod.string().min(1).max(1000).describe('What escaped, and where it was found'),
    foundAt: timestamp().optional().describe('When it was found (default now); never in the future'),
  },
  board_breakers: { projectId: id().optional().describe('One project\'s breakers; every project\'s when absent') },
  board_breaker_reset: { projectId: id(), branch: zod.string().min(1).max(200).describe('The landing branch auto-accept turns on again for') },
}

const DESCRIPTIONS: Record<BoardTool, string> = {
  board_projects: 'List projects on the board, with their tasks per state; a page at a time.',
  board_charter: 'Found a project or amend its charter (with an existing projectId). The operator approves every charter version first: the project starts or changes course only then.',
  board_brief: 'One page for an agent new to a project: its intent, what is in progress, what waits, what is next, and what to read first.',
  board_tasks: 'List a project\'s tasks, filtered by state or milestone; a page at a time.',
  board_task: 'Read one task: its goal, acceptance criteria, state, holder, run, result, and why it waits.',
  board_propose: 'Propose a task. The board makes it ready once its dependencies are done and the autonomy policy allows its action class, or asks the operator first.',
  board_claim: 'Take a ready task\'s lease (ready to claimed), capped by leases.maxTtlMs; the output gives its expiry and generation. Then start its attempt with the `run` tool, naming the task with this owner as holder and this generation: the run is recorded on the board before any step runs, keeps the lease, and submits and accepts its own result. A claim no run starts lapses back to ready.',
  board_update: 'Renew your lease on a task you hold (with its generation), or answer a waiting task\'s questions. Once a run serves the task, the run renews the lease. Only a question wait takes answers: a rejected, retries-spent, or review-expired wait takes none and expires to cancelled.',
  board_cancel: 'Cancel a task that is not running or in review; a pending approval request is withdrawn and the tasks that depend on it are cancelled.',
  board_pause: 'Pause an active project: until it is resumed no task of it is claimed or started and no proposed task is put to the policy; a running attempt goes on to its outcome, and every wait keeps its expiry. Recorded as a board decision.',
  board_resume: 'Resume a paused project: its proposed tasks go through the gate on the board\'s next sweep, and its ready tasks may be claimed again. Recorded as a board decision.',
  board_close: 'Close an active or paused project as achieved or stopped; refused while one of its tasks runs or is in review. Its open tasks are cancelled (project-closed), the approval requests they and a pending amendment waited on are withdrawn, and the project takes no task again. Recorded as a board decision.',
  board_escape: 'Record a defect found after a result the auto-accept rule accepted (a done task whose last decision is rule board.auto-accept), once per task, as the caller (the operator, else the lead). At the line (board.autoAccept.breaker, default 2 escapes in 7 days) for the result\'s project and landing branch, auto-accept turns off for them: a board decision names every escape counted, and results are held for the operator until the operator or the lead turns it on again with board_breaker_reset. system metrics reads the escapes as escaped defects.',
  board_breakers: 'List where the auto-accept circuit breaker turned auto-accept off: per project and landing branch, the escapes it counted, its decision, and whether the line holds now (fewer escapes than the line in its window). A breaker never resets by itself.',
  board_breaker_reset: 'Turn auto-accept on again for a project and landing branch whose breaker tripped, as the caller (the operator, else the lead): only once the line holds (fewer escapes than the line within its window now), refused otherwise. Recorded as a board decision naming the trip\'s.',
}

const summary = (t: BoardTask) => ({
  taskId: t.taskId, title: t.title, state: t.state, ...(t.milestone ? { milestone: t.milestone } : {}), ...(t.holder ? { holder: t.holder.owner } : {}),
  ...(t.run ? { runId: t.run.runId } : {}), ...(t.waiting ? { waitingFor: t.state === 'waiting-for-approval' ? 'approval' : t.state === 'review' ? 'operator' : 'input' } : {}), ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
})
/** A breaker as the tools give it (`$defs/breaker`): its escapes by task, when found, and what was noted; the count now and whether the line holds. */
const breakerOut = (b: Breaker) => ({
  breakerId: b.breakerId, projectId: b.projectId, branch: b.branch, state: b.state, line: b.line, trippedAt: b.trippedAt, decision: b.decision,
  escapes: b.escapes.map((e) => ({ taskId: e.taskId, foundAt: e.foundAt, note: e.note })),
  ...(b.now ? { counted: b.now.counted, lineHolds: b.now.lineHolds } : {}),
  ...(b.reset ? { reset: b.reset } : {}),
})
/** The milestone being worked on: the first funded one, else the first planned. */
const currentMilestone = (p: Project) => (p.milestones.find((m) => m.state === 'funded') ?? p.milestones.find((m) => m.state === 'planned'))?.id
const clamp = (text: string, max: number): string => ([...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`)
const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })
/** The host lists and serves an operator tool to the operator only; a project move from any other caller is never taken (INV-6). */
const operatorOnly = (scope: ToolScope, move: string): void => {
  if (scope !== 'operator') throw new BoardError('invalid', `only the operator ${move} a project`)
}

type Args = Record<string, unknown>
/**
 * Checks the output a call would give: a tool that changes the board passes it, through what it
 * builds that output from, into the move, which runs it before it commits.
 */
type OutputCheck = (output: object) => void
type Handler = (args: Args, context: ToolContext, check: OutputCheck) => Promise<object>

/** The output a call would give, refused by its schema before its move committed. */
class RefusedOutput extends Error {}

/** `check` on the output `out` builds from what a move returns. */
const sees = <T>(check: OutputCheck, out: (value: T) => object): Checked<T> => (value) => check(out(value))

/** The tools' behavior, over a board. */
function handlers(board: StoreBoard, options: { leaseTtlSeconds: number }): Record<BoardTool, Handler> {
  return {
    board_projects: async (args) => {
      const { items, next } = board.projectPage({ ...(args.state ? { state: args.state as Project['state'] } : {}), ...pageOf(args) })
      return {
        projects: items.map((p) => ({ projectId: p.projectId, title: p.title, state: p.state, ...withMilestone(p), tasks: board.counts(p.projectId) })),
        ...(next ? { next } : {}),
      }
    },
    board_charter: async (args, _context, check) => {
      const input = args as unknown as CharterInput & { clientRequestId?: string }
      const { clientRequestId, ...charter } = input
      const out = ({ project, approvalRequest, charterVersion }: Chartered) => ({ projectId: project.projectId, state: project.state, charterVersion, approvalRequest })
      return out(await board.charterProject(charter, new Date(), clientRequestId, sees(check, out)))
    },
    board_brief: async (args) => {
      const projectId = String(args.projectId)
      const project = await board.project(projectId)
      if (!project) throw new BoardError('unknown-project', `no project ${projectId}`)
      const list = (states: BoardTask['state'][], limit: number) => (limit > 0 ? board.taskPage({ projectId, states, limit }).items.map(summary) : [])
      const ready = list(['ready'], 20)
      const readFirst = [
        ...(project.closure?.lessons ? [{ ref: project.closure.lessons, why: 'lessons of the closed project' }] : []),
        ...board.latest(projectId, 'done', 16).flatMap((t) => (t.result ? [{ ref: t.result.digest ?? t.result.artifacts[0]!, why: clamp(`the accepted result of ${t.taskId}: ${t.title}`, 500) }] : [])),
      ].slice(0, 16)
      const notes = project.charter.constraints.notes ?? []
      return {
        projectId, title: project.title, intent: project.charter.intent, state: project.state, ...withMilestone(project), tasks: board.counts(projectId),
        inProgress: list(['claimed', 'running', 'review'], 20), waiting: list(['waiting-for-input', 'waiting-for-approval'], 20),
        next: [...ready, ...list(['proposed'], 20 - ready.length)], readFirst, ...(notes.length ? { conventions: notes } : {}),
      }
    },
    board_tasks: async (args) => {
      const { items, next } = board.taskPage({
        projectId: String(args.projectId), ...(args.states ? { states: args.states as BoardTask['state'][] } : {}), ...(args.milestone ? { milestone: String(args.milestone) } : {}), ...pageOf(args),
      })
      if (!items.length && !(await board.project(String(args.projectId)))) throw new BoardError('unknown-project', `no project ${String(args.projectId)}`)
      return { tasks: items.map(summary), ...(next ? { next } : {}) }
    },
    board_task: async (args) => {
      const task = await board.task(String(args.taskId))
      if (!task) throw new BoardError('unknown-task', `no task ${String(args.taskId)}`)
      return { task }
    },
    board_propose: async (args, _context, check) => {
      const { clientRequestId, ...input } = args as unknown as TaskInput & { clientRequestId?: string }
      return moved(board.proposeTask(input, new Date(), clientRequestId, sees(check, moved)))
    },
    board_claim: async (args, _context, check) => {
      const out = (claim: Claim) => ({ taskId: claim.taskId, state: 'claimed', generation: claim.generation, leaseExpiresAt: claim.leaseExpiresAt })
      return out(await board.claim(String(args.taskId), String(args.owner), (typeof args.ttlSeconds === 'number' ? args.ttlSeconds : options.leaseTtlSeconds) * 1000, new Date(), sees(check, out)))
    },
    board_update: async (args, _context, check) => {
      const taskId = String(args.taskId)
      const answers = args.answers as Array<{ question: number; answer: string }> | undefined
      if (answers && args.generation !== undefined) throw new BoardError('invalid', 'board_update renews a lease (generation) or answers questions (answers), not both')
      if (answers) {
        const ordered: string[] = []
        for (const { question, answer } of answers) {
          if (ordered[question] !== undefined) throw new BoardError('invalid', `question ${question} is answered twice`)
          ordered[question] = answer
        }
        if (ordered.length !== answers.length) throw new BoardError('invalid', 'answer the questions by index, from 0, each once')
        return moved(await board.answer(taskId, ordered, new Date(), sees(check, moved)))
      }
      if (typeof args.generation !== 'number') throw new BoardError('invalid', 'board_update needs the generation you hold (to renew the lease) or answers')
      const out = ({ task, leaseExpiresAt }: Renewed) => ({ taskId, state: task.state, revision: task.revision, leaseExpiresAt })
      let renewed: Renewed | undefined
      await board.heartbeat(taskId, args.generation, new Date(), (value) => {
        check(out(value))
        renewed = value
      })
      return out(renewed!)
    },
    board_cancel: async (args, { scope }, check) => {
      // Who cancelled is who called: the operator's token, else the lead's (a client).
      const out = (task: BoardTask) => ({ taskId: task.taskId, state: 'cancelled', revision: task.revision })
      return out(await board.cancel(String(args.taskId), scope === 'operator' ? 'operator' : 'lead', typeof args.note === 'string' ? args.note : undefined, new Date(), sees(check, out)))
    },
    board_pause: async (args, { scope }, check) => {
      operatorOnly(scope, 'pauses')
      const out = (project: Project) => ({ projectId: project.projectId, state: 'paused', revision: project.revision, decision: project.lastDecision })
      return out(await board.pause(String(args.projectId), new Date(), sees(check, out)))
    },
    board_resume: async (args, { scope }, check) => {
      operatorOnly(scope, 'resumes')
      const out = (project: Project) => ({ projectId: project.projectId, state: 'active', revision: project.revision, decision: project.lastDecision })
      return out(await board.resume(String(args.projectId), new Date(), sees(check, out)))
    },
    board_close: async (args, { scope }, check) => {
      operatorOnly(scope, 'closes')
      const out = ({ project, cancelled }: Closed) => ({ projectId: project.projectId, state: 'closed', outcome: project.closure!.outcome, revision: project.revision, decision: project.closure!.decision, cancelled })
      return out(await board.closeProject(String(args.projectId), args.outcome as 'achieved' | 'stopped', new Date(), sees(check, out)))
    },
    board_escape: async (args, { scope }, check) => {
      // Who recorded it is who called: the operator's token, else the lead's (a client).
      const out = ({ escape, breaker }: { escape: Escape; breaker?: Breaker }) => ({
        escapeId: escape.escapeId, taskId: escape.taskId, projectId: escape.projectId, branch: escape.branch, foundAt: escape.foundAt, recordedBy: escape.recordedBy,
        ...(breaker ? { breaker: breakerOut(breaker) } : {}),
      })
      const input = { taskId: String(args.taskId), by: scope === 'operator' ? 'operator' as const : 'lead' as const, note: String(args.note), ...(typeof args.foundAt === 'string' ? { foundAt: new Date(args.foundAt).toISOString() } : {}) }
      return out(await board.recordEscape(input, new Date(), sees(check, out)))
    },
    board_breakers: async (args) => ({ breakers: (await board.breakers(typeof args.projectId === 'string' ? args.projectId : undefined, new Date())).map(breakerOut) }),
    board_breaker_reset: async (args, { scope }, check) => breakerOut(await board.resetBreaker(String(args.projectId), String(args.branch), scope === 'operator' ? 'operator' : 'lead', new Date(), sees(check, breakerOut))),
  }

  /** A task's output after a move: its id, state, and revision. */
  function moved(task: BoardTask): object {
    return { taskId: task.taskId, state: task.state, revision: task.revision }
  }

  function pageOf(args: Args): { limit?: number; after?: string } {
    return { ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.after === 'string' ? { after: args.after } : {}) }
  }

  function withMilestone(p: Project): { milestone?: string } {
    const m = currentMilestone(p)
    return m ? { milestone: m } : {}
  }
}

/**
 * Wrap a handler: validate the input first; give it the check of its output, which a tool that
 * changes the board runs before its move commits; validate the structured output once more last
 * (all a read needs); and report a refusal as an MCP error.
 */
function tool(name: BoardTool, handler: Handler): ToolHandler {
  return async (args, context) => {
    try {
      schemas.assertDef(MCP_BOARD, defOf(name, 'input'), args)
    } catch (error) {
      return refused(`invalid input, nothing done: ${(error as Error).message}`)
    }
    const check: OutputCheck = (output) => {
      try {
        schemas.assertDef(MCP_BOARD, defOf(name, 'output'), output)
      } catch (error) {
        throw new RefusedOutput((error as Error).message)
      }
    }
    let output: object
    try {
      output = await handler(args, context, check)
    } catch (error) {
      if (error instanceof RefusedOutput) return refused(`board: ${name} would make an output its schema refuses (a defect), so nothing changed: ${error.message}`)
      return refused(error instanceof BoardError ? `${error.failure}: ${error.message}` : `board: ${(error as Error).message}`)
    }
    try {
      schemas.assertDef(MCP_BOARD, defOf(name, 'output'), output)
    } catch (error) {
      return refused(`board: ${name} made an output its schema refuses (a defect): ${(error as Error).message}`)
    }
    return reply(output, outline(output))
  }
}

/** Contribute the tools to `ctx.mcp` for the board's lifetime. */
export function registerTools(ctx: Context, board: StoreBoard, options: { leaseTtlSeconds: number }): void {
  const behavior = handlers(board, options)
  for (const name of BOARD_TOOLS) ctx.mcp.tool(name, { scope: SCOPES[name], description: DESCRIPTIONS[name], inputSchema: INPUTS[name] }, tool(name, behavior[name]))
}
