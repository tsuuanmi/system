/**
 * The `approvals_*` MCP tools (reference/schemas.md#mcp-tools-board_-approvals_-resources_).
 * `approvals_list`, `approvals_get`, and `approvals_policy` are client scope; `approvals_decide` and
 * `approvals_policy_propose` are operator scope, because a verdict or a policy change comes only
 * from the operator's channel (INV-6). Each call's input and structured output are validated
 * against `schemas/mcp-approvals.v1.json` (1.2) `$defs/<tool>-input` and `-output`; a refused input
 * executes nothing, and a tool that changes the queue checks the output it would give inside the
 * store transaction that records the change, before it commits, so an output its schema refuses (a
 * defect) leaves the queue as it was.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ApprovalsError, type AutonomyPolicy, type RequestState, type Verdict, type VerdictResult } from '@tsuuanmi/system-approvals-core'
import { outline, reply, type ToolContext, type ToolHandler, type ToolScope, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import type { StoreApprovals } from './index.ts'

export const APPROVAL_TOOLS = ['approvals_list', 'approvals_get', 'approvals_decide', 'approvals_policy', 'approvals_policy_propose'] as const
export type ApprovalTool = typeof APPROVAL_TOOLS[number]

/** Who may call each tool: verdicts and policy changes are the operator's alone (INV-6). */
export const SCOPES: Record<ApprovalTool, ToolScope> = { approvals_list: 'client', approvals_get: 'client', approvals_decide: 'operator', approvals_policy: 'client', approvals_policy_propose: 'operator' }

const schemas = new SchemaRegistry()
/** The `$defs` name of a tool's input or output: underscores written as hyphens. */
const defOf = (tool: ApprovalTool, part: 'input' | 'output'): string => `${tool.replaceAll('_', '-')}-${part}`

// The vocabulary of schemas/common.v1.json, for the shapes clients see; Ajv checks the schema itself.
const id = () => zod.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
const requestState = () => zod.enum(['open', 'batched', 'approved', 'rejected'])
const subject = () => zod.strictObject({ type: zod.enum(['content', 'git-head', 'pull-request', 'artifact', 'external']), ref: zod.string().min(1).max(512), version: zod.string().max(128).optional() })

/** Input shapes, matching `$defs/<tool>-input`. */
export const INPUTS: Record<ApprovalTool, ToolSpec['inputSchema']> = {
  approvals_list: {
    states: zod.array(requestState()).min(1).max(4).optional().describe('Default: open and batched'),
    batchId: id().optional(), projectId: id().optional(),
    limit: zod.number().int().min(1).max(100).optional().describe('Page size (default 20)'),
    after: zod.string().min(1).max(200).optional().describe('The `next` cursor of the previous page'),
  },
  approvals_get: { requestId: id() },
  approvals_decide: {
    verdicts: zod.array(zod.strictObject({
      requestId: id(),
      subject: subject().describe('The exact subject the operator saw; a request whose subject changed since is refused (INV-5)'),
      verdict: zod.enum(['approved', 'rejected']),
      note: zod.string().max(2000).optional(),
    })).min(1).max(50),
  },
  approvals_policy: { projectId: id().optional().describe('The project whose policy narrows the studio\'s') },
  approvals_policy_propose: {
    policy: zod.record(zod.string(), zod.unknown()).describe('One autonomy-policy@1.0 record: a policy of the set at a higher version, or a policy for a project that has none'),
    note: zod.string().max(2000).optional().describe('Why, shown with the request'),
  },
}

const DESCRIPTIONS: Record<ApprovalTool, string> = {
  approvals_list: 'List approval requests (default: open and batched), by batch then expiry; a page at a time.',
  approvals_get: 'Read one approval request: its exact subject, action, requester, policy decision, expiry, and resolution.',
  approvals_decide: 'Verdicts for up to 50 requests, each bound to the exact subject shown. A refused verdict (unknown, resolved, expired, a changed subject, or failed) leaves its request unchanged; the others still apply. A project\'s lead token (decider lead:<project>) may give verdicts only on that project\'s commands and dispatch starts, and merges into its listed dev branches; any other verdict refuses the whole call.',
  approvals_policy: 'The studio autonomy policy, the project\'s when it has one, the effective mode per action class, and the policy set in force.',
  approvals_policy_propose: 'Propose one autonomy policy record. The set it makes must load; it is asked as a policy-change approval on its exact hash and applies only once the operator approves it in the queue.',
}

const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

type Args = Record<string, unknown>
/** Checks the output a call would give: a tool that changes the queue runs it before its change commits. */
export type OutputCheck = (output: object) => void
type Handler = (args: Args, context: ToolContext, check: OutputCheck) => Promise<object>

/** The output a call would give, refused by its schema before its change committed. */
class RefusedOutput extends Error {}

/** `approvals_decide`'s output from the verdicts' results. */
const decided = (results: VerdictResult[]) => ({ results: results.map((r) => ({ requestId: r.requestId, state: r.state, ...(r.approval ? { approval: r.approval } : {}), ...(r.refused ? { refused: r.refused } : {}) })) })

/** The tools' behavior, over a queue; exported so tests call it as a client would. */
export function handlers(approvals: StoreApprovals): Record<ApprovalTool, Handler> {
  return {
    approvals_list: async (args) => approvals.page(
      { ...(args.states ? { states: args.states as RequestState[] } : {}), ...(typeof args.batchId === 'string' ? { batchId: args.batchId } : {}), ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}) },
      { ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.after === 'string' ? { after: args.after } : {}) },
    ),
    approvals_get: async (args) => {
      const request = await approvals.get(String(args.requestId))
      if (!request) throw new ApprovalsError('unknown-request', `no approval request ${String(args.requestId)}`)
      return { request }
    },
    approvals_decide: async (args, { scope, lead }, check) => {
      // The host lists and serves this tool to the operator, and to a project's lead (ADR-0076), which the queue holds to
      // its closed list of rights; a verdict from any other caller is never taken (INV-6).
      if (scope !== 'operator') {
        if (lead === undefined) throw new ApprovalsError('invalid', 'verdicts come only from the operator')
        return decided(await approvals.decideAsLead(lead, args.verdicts as Verdict[], new Date(), (results) => check(decided(results))))
      }
      return decided(await approvals.decide(args.verdicts as Verdict[], new Date(), (results) => check(decided(results))))
    },
    approvals_policy: async (args) => approvals.policy(typeof args.projectId === 'string' ? args.projectId : undefined),
    approvals_policy_propose: async (args, { scope }, check) => {
      // Listed and served to the operator only; a policy change from any other caller is never taken (INV-6).
      if (scope !== 'operator') throw new ApprovalsError('invalid', 'policy changes come only from the operator')
      return approvals.proposePolicy({ policy: args.policy as AutonomyPolicy, ...(typeof args.note === 'string' ? { note: args.note } : {}) }, new Date(), check)
    },
  }
}

/**
 * Wrap a handler: validate the input first; give it the check of its output, which a tool that
 * changes the queue runs before its change commits; validate the structured output once more last
 * (all a read needs); and report a refusal as an MCP error.
 */
export function tool(name: ApprovalTool, handler: Handler): ToolHandler {
  return async (args, context) => {
    try {
      schemas.assertDef('mcp-approvals@1.2', defOf(name, 'input'), args)
    } catch (error) {
      return refused(`invalid input, nothing done: ${(error as Error).message}`)
    }
    const check: OutputCheck = (output) => {
      try {
        schemas.assertDef('mcp-approvals@1.2', defOf(name, 'output'), output)
      } catch (error) {
        throw new RefusedOutput((error as Error).message)
      }
    }
    let output: object
    try {
      output = await handler(args, context, check)
    } catch (error) {
      if (error instanceof RefusedOutput) return refused(`approvals: ${name} would make an output its schema refuses (a defect), so nothing changed: ${error.message}`)
      return refused(error instanceof ApprovalsError ? `${error.failure}: ${error.message}` : `approvals: ${(error as Error).message}`)
    }
    try {
      schemas.assertDef('mcp-approvals@1.2', defOf(name, 'output'), output)
    } catch (error) {
      return refused(`approvals: ${name} made an output its schema refuses (a defect): ${(error as Error).message}`)
    }
    return reply(output, outline(output))
  }
}

/** Contribute the tools to `ctx.mcp` for the queue's lifetime. */
export function registerTools(ctx: Context, approvals: StoreApprovals): void {
  const behavior = handlers(approvals)
  // `approvals_decide` is the one operator tool a project's lead may call too: the closed list of rights is the queue's (ADR-0076).
  for (const name of APPROVAL_TOOLS) ctx.mcp.tool(name, { scope: SCOPES[name], ...(name === 'approvals_decide' ? { lead: true as const } : {}), description: DESCRIPTIONS[name], inputSchema: INPUTS[name] }, tool(name, behavior[name]))
}
