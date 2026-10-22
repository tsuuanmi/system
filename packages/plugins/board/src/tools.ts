/**
 * The `board_*` MCP tools (reference/schemas.md#mcp-tools-board_-approvals_-resources_), client
 * scope. Each call's input and structured output are validated against
 * `schemas/mcp-board.v1.json` `$defs/<tool>-input` and `-output`; a refused input executes nothing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { type ArtifactRef, BoardError, type BoardTask, type CharterInput, type Project, type Subject, type TaskInput } from '@tsuuanmi/system-board-core'
import type { ToolContext, ToolHandler, ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import type { StoreBoard } from './index.ts'

export const BOARD_TOOLS = ['board_projects', 'board_charter', 'board_brief', 'board_tasks', 'board_task', 'board_propose', 'board_claim', 'board_update', 'board_complete', 'board_cancel'] as const
export type BoardTool = typeof BOARD_TOOLS[number]

const schemas = new SchemaRegistry()
/** The `$defs` name of a tool's input or output: underscores written as hyphens. */
const defOf = (tool: BoardTool, part: 'input' | 'output'): string => `${tool.replaceAll('_', '-')}-${part}`

// The vocabulary of schemas/common.v1.json, for the shapes clients see; Ajv checks the schema itself.
const id = () => zod.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
const shortText = () => zod.string().min(1).max(500)
const artifactRef = () => zod.string().regex(/^sha256:[0-9a-f]{64}$/)
const timestamp = () => zod.iso.datetime({ offset: true })
const projectState = () => zod.enum(['proposed', 'active', 'paused', 'closed'])
const taskState = () => zod.enum(['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval', 'done', 'cancelled'])
const actionClass = () => zod.enum(['read', 'workspace-write', 'merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change'])
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
}).describe('Version 1 for a new project, the current one plus 1 for an amendment; never carries its approval')
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
    projectId: id().optional().describe('An existing project\'s id to amend its charter (pivot), or a new project\'s; generated when absent'),
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
    writes: subject().optional(), budget: zod.array(budgetLine()).max(16).optional(), clientRequestId: zod.string().min(1).max(200).optional().describe('Retry-safe request key'),
  },
  board_claim: { taskId: id(), owner: id().describe('Who works on it, e.g. the lead\'s session id'), ttlSeconds: zod.number().int().min(30).max(3600).optional().describe('Lease length (default 900 s); renewed by board_update') },
  board_update: {
    taskId: id(), generation: generation().optional(),
    note: zod.string().min(1).max(2000).optional().describe('A progress line; not stored: results go through board_complete'),
    answers: zod.array(zod.strictObject({ question: zod.number().int().min(0).max(7), answer: zod.string().min(1).max(2000) })).min(1).max(8).optional()
      .describe('Answers to a waiting-for-input task\'s questions, by index; answering every one makes it ready again'),
  },
  board_complete: {
    taskId: id(), generation: generation(), artifacts: zod.array(artifactRef()).min(1).max(32), subject: subject(),
    files: zod.array(zod.string().min(1).max(1024)).max(512).optional(), next: zod.string().max(2000).optional(),
  },
  board_cancel: { taskId: id(), note: shortText().optional() },
}

const DESCRIPTIONS: Record<BoardTool, string> = {
  board_projects: 'List projects on the board, with their tasks per state; a page at a time.',
  board_charter: 'Found a project or amend its charter (with an existing projectId). The operator approves every charter version first: the project starts or changes course only then.',
  board_brief: 'One page for an agent new to a project: its intent, what is in progress, what waits, what is next, and what to read first.',
  board_tasks: 'List a project\'s tasks, filtered by state or milestone; a page at a time.',
  board_task: 'Read one task: its goal, acceptance criteria, state, holder, run, result, and why it waits.',
  board_propose: 'Propose a task. The board makes it ready once its dependencies are done and the autonomy policy allows its action class, or asks the operator first.',
  board_claim: 'Take a ready task\'s lease to work on it yourself; present the returned generation on every later write.',
  board_update: 'Renew your lease on a task you hold (with its generation), or answer a waiting task\'s questions (every one, by index).',
  board_complete: 'Submit a running task\'s result with its exact subject (a commit, or the result artifact): the task goes to review, never straight to done.',
  board_cancel: 'Cancel a task that is not running or in review; a pending approval request is withdrawn and the tasks that depend on it are cancelled.',
}

const summary = (t: BoardTask) => ({
  taskId: t.taskId, title: t.title, state: t.state, ...(t.milestone ? { milestone: t.milestone } : {}), ...(t.holder ? { holder: t.holder.owner } : {}),
  ...(t.run ? { runId: t.run.runId } : {}), ...(t.waiting ? { waitingFor: t.state === 'waiting-for-approval' ? 'approval' : 'input' } : {}), ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
})
/** The milestone being worked on: the first funded one, else the first planned. */
const currentMilestone = (p: Project) => (p.milestones.find((m) => m.state === 'funded') ?? p.milestones.find((m) => m.state === 'planned'))?.id
const clamp = (text: string, max: number): string => ([...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`)
const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

type Args = Record<string, unknown>
type Handler = (args: Args, context: ToolContext) => Promise<object>

/** The tools' behavior, over a board; exported so tests call it as a client would. */
export function handlers(board: StoreBoard, options: { leaseTtlSeconds: number }): Record<BoardTool, Handler> {
  return {
    board_projects: async (args) => {
      const { items, next } = board.projectPage({ ...(args.state ? { state: args.state as Project['state'] } : {}), ...pageOf(args) })
      return {
        projects: items.map((p) => ({ projectId: p.projectId, title: p.title, state: p.state, ...withMilestone(p), tasks: board.counts(p.projectId) })),
        ...(next ? { next } : {}),
      }
    },
    board_charter: async (args) => {
      const input = args as unknown as CharterInput & { clientRequestId?: string }
      const { clientRequestId, ...charter } = input
      const { project, approvalRequest } = await board.charterProject(charter, new Date(), clientRequestId)
      return { projectId: project.projectId, state: project.state, charterVersion: input.charter.version, approvalRequest }
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
    board_propose: async (args) => {
      const { clientRequestId, ...input } = args as unknown as TaskInput & { clientRequestId?: string }
      const task = board.proposeTask(input, new Date(), clientRequestId)
      return { taskId: task.taskId, state: task.state, revision: task.revision }
    },
    board_claim: async (args) => {
      const claim = await board.claim(String(args.taskId), String(args.owner), (typeof args.ttlSeconds === 'number' ? args.ttlSeconds : options.leaseTtlSeconds) * 1000)
      return { taskId: claim.taskId, state: 'claimed', generation: claim.generation, leaseExpiresAt: claim.leaseExpiresAt }
    },
    board_update: async (args) => {
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
        const task = await board.answer(taskId, ordered)
        return { taskId, state: task.state, revision: task.revision }
      }
      if (typeof args.generation !== 'number') throw new BoardError('invalid', 'board_update needs the generation you hold (to renew the lease) or answers')
      const claim = await board.heartbeat(taskId, args.generation)
      const task = (await board.task(taskId))!
      return { taskId, state: task.state, revision: task.revision, leaseExpiresAt: claim.leaseExpiresAt }
    },
    board_complete: async (args) => {
      const task = await board.submit(String(args.taskId), Number(args.generation), {
        artifacts: args.artifacts as ArtifactRef[], subject: args.subject as Subject,
        ...(args.files ? { files: args.files as string[] } : {}), ...(typeof args.next === 'string' ? { next: args.next } : {}),
      })
      return { taskId: task.taskId, state: 'review', revision: task.revision }
    },
    board_cancel: async (args, { scope }) => {
      // Who cancelled is who called: the operator's token, else the lead's (a client).
      const task = await board.cancel(String(args.taskId), scope === 'operator' ? 'operator' : 'lead', typeof args.note === 'string' ? args.note : undefined)
      return { taskId: task.taskId, state: 'cancelled', revision: task.revision }
    },
  }

  function pageOf(args: Args): { limit?: number; after?: string } {
    return { ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.after === 'string' ? { after: args.after } : {}) }
  }

  function withMilestone(p: Project): { milestone?: string } {
    const m = currentMilestone(p)
    return m ? { milestone: m } : {}
  }
}

/** Wrap a handler: validate the input first and the structured output last, and report a refusal as an MCP error. */
export function tool(name: BoardTool, handler: Handler): ToolHandler {
  return async (args, context) => {
    try {
      schemas.assertDef('mcp-board@1.0', defOf(name, 'input'), args)
    } catch (error) {
      return refused(`invalid input, nothing done: ${(error as Error).message}`)
    }
    let output: object
    try {
      output = await handler(args, context)
    } catch (error) {
      return refused(error instanceof BoardError ? `${error.failure}: ${error.message}` : `board: ${(error as Error).message}`)
    }
    try {
      schemas.assertDef('mcp-board@1.0', defOf(name, 'output'), output)
    } catch (error) {
      return refused(`board: ${name} made an output its schema refuses (a defect; the move itself is recorded): ${(error as Error).message}`)
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: { ...output } }
  }
}

/** Contribute the tools to `ctx.mcp` for the board's lifetime. */
export function registerTools(ctx: Context, board: StoreBoard, options: { leaseTtlSeconds: number }): void {
  const behavior = handlers(board, options)
  for (const name of BOARD_TOOLS) ctx.mcp.tool(name, { scope: 'client', description: DESCRIPTIONS[name], inputSchema: INPUTS[name] }, tool(name, behavior[name]))
}
