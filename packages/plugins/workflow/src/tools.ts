/** The engine's MCP tools (`ctx.mcp`): starting runs, fetching results, and the operator's actions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-gateway-core'
import type { Classification, Tier } from '@tsuuanmi/system-workers-core'
import { z as zod } from 'zod'
import type { Workflow } from './index.ts'
import { DEFAULT_TEMPLATES } from './spec.ts'
import type { RunView } from './types.ts'

/** Contribute the tools on `c` (the context holding `ctx.mcp`); `ctx` explains artifact ids. */
export function registerTools(c: Context, w: Workflow, ctx: Context): void {
  const shape = (view: RunView) => ({ content: [{ type: 'text' as const, text: view.status === 'completed' ? view.answer ?? '' : JSON.stringify(view) }], structuredContent: { ...view } })
  const json = (value: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { ...value } })
  const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] })
  const waitSeconds = zod.number().int().min(0).max(55).optional().describe('How long to wait for the run to finish before returning (default 45 s)')
  const classification = zod.enum(['public', 'operator-shared', 'local-private']).optional()
    .describe('Data classification of the input; local-private content never leaves the machine (INV-12)')
  const clientRequestId = zod.string().max(200).optional().describe('Retry-safe request key')
  c.mcp.tool('ask', {
    description: 'Ask a website Worker (separate chat quota). Waits up to waitSeconds; otherwise returns a runId for `result`.',
    inputSchema: {
      prompt: zod.string().min(1).max(32_000),
      sessionId: zod.string().max(200).optional().describe('Continue an existing persistent session'),
      persist: zod.boolean().optional().describe('Start a persistent session (a normal conversation)'),
      tier: zod.enum(['economy', 'standard', 'frontier']).optional().describe('Minimum intelligence tier; the lowest admitted tier at or above it runs'),
      classification, clientRequestId, waitSeconds,
    },
  }, async (args) => {
    try {
      const run = w.start({
        template: 'ask', input: String(args.prompt), sessionId: args.sessionId as string | undefined, persist: args.persist as boolean | undefined,
        tier: args.tier as Tier | undefined, classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
      })
      return shape(await w.wait(run.runId, ((args.waitSeconds as number | undefined) ?? 45) * 1000))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('research', {
    description: 'Research a question with the research profile: testable hypotheses, a cited literature review (web search), an evidence table, an independent critique, and conclusions per hypothesis. Returns at once with a runId; poll `result` (runs take minutes). Deep research alone, then a compaction: `run` with template deep-research.',
    inputSchema: {
      question: zod.string().min(1).max(32_000),
      classification, clientRequestId,
    },
  }, async (args) => {
    try {
      return shape(w.start({
        template: 'research', input: String(args.question),
        classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
      }))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('run', {
    description: `Start a workflow template by name (built in: ${Object.keys(DEFAULT_TEMPLATES).sort().join(', ')}; profiles add more, such as develop); its steps are routed by capability to website or local agent Workers. Waits up to waitSeconds; otherwise returns a runId for \`result\`.`,
    inputSchema: {
      template: zod.string().max(100),
      input: zod.string().min(1).max(32_000),
      sessionId: zod.string().max(200).optional().describe('Continue an existing session'),
      persist: zod.boolean().optional().describe('Start a persistent session'),
      tier: zod.enum(['economy', 'standard', 'frontier']).optional().describe('Minimum tier for the steps that take the caller\'s tier'),
      classification, clientRequestId, waitSeconds,
    },
  }, async (args) => {
    try {
      const run = w.start({
        template: String(args.template), input: String(args.input), sessionId: args.sessionId as string | undefined, persist: args.persist as boolean | undefined,
        tier: args.tier as Tier | undefined, classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
      })
      return shape(await w.wait(run.runId, ((args.waitSeconds as number | undefined) ?? 45) * 1000))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('approve', {
    description: 'Approve or reject the plan a run is waiting on (an operator decision, bound to that exact plan).',
    inputSchema: {
      runId: zod.string().max(200),
      verdict: zod.enum(['approved', 'rejected']),
      note: zod.string().max(2000).optional(),
      plan: zod.string().max(200).optional().describe('The plan artifact you read; required when several plans wait'),
    },
  }, async (args) => {
    try {
      return shape(w.approve(String(args.runId), { verdict: args.verdict as 'approved' | 'rejected', ...(args.note ? { note: String(args.note) } : {}), ...(args.plan ? { plan: String(args.plan) } : {}) }))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('stop', {
    description: 'Stop a run: running work is cancelled, nothing else starts, nothing is resent (an operator decision).',
    inputSchema: { runId: zod.string().max(200), reason: zod.string().max(500).optional() },
  }, async (args) => {
    try {
      return shape(await w.stop(String(args.runId), args.reason ? String(args.reason) : undefined))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('drain', {
    description: 'Drain the host before a stop or upgrade: admit no new run, and report the runs still executing. Call again to poll.',
    inputSchema: {},
  }, async () => json(w.drain()))
  c.mcp.tool('resume', {
    description: 'Admit new runs again after a drain.',
    inputSchema: {},
  }, async () => json(w.resume()))
  c.mcp.tool('continue', {
    description: 'Continue a failed run: reopen its one failed node (or a stopped run\'s nodes) as a new attempt (an operator decision).',
    inputSchema: { runId: zod.string().max(200), nodeId: zod.string().max(200).optional() },
  }, async (args) => {
    try {
      return shape(w.continue(String(args.runId), args.nodeId ? String(args.nodeId) : undefined))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('delete', {
    description: 'Delete a finished run: without updatedAt, preview; with the preview\'s updatedAt, delete. Artifacts stay.',
    inputSchema: { runId: zod.string().max(200), updatedAt: zod.string().max(40).optional() },
  }, async (args) => {
    try {
      return json(w.delete(String(args.runId), args.updatedAt ? String(args.updatedAt) : undefined))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('supersede', {
    description: 'Replace a completed step\'s result with a corrected one; everything downstream runs again (lineage invalidation, an operator action).',
    inputSchema: { runId: zod.string().max(200), nodeId: zod.string().max(200), text: zod.string().min(1).max(4_000_000), note: zod.string().max(2000).optional() },
  }, async (args) => {
    try {
      return shape(w.supersede(String(args.runId), String(args.nodeId), { text: String(args.text), ...(args.note ? { note: String(args.note) } : {}) }))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('result', {
    description: 'Fetch a run started by `ask` or `research`; waits up to waitSeconds for it to finish.',
    inputSchema: { runId: zod.string().max(200), waitSeconds },
  }, async (args) => {
    try {
      return shape(await w.wait(String(args.runId), ((args.waitSeconds as number | undefined) ?? 45) * 1000))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('usage', {
    description: 'Recent runs and, per step, which Worker, tier, and quota class served it.',
    inputSchema: { limit: zod.number().int().min(1).max(500).optional() },
  }, async (args) => json({ runs: w.usage((args.limit as number | undefined) ?? 50) }))
  c.mcp.tool('explain', {
    description: 'The decision chain behind a run (egress, tier, route, acceptance per step), or the inputs of any artifact id.',
    inputSchema: { id: zod.string().max(200) },
  }, async (args) => {
    const id = String(args.id)
    const explained = w.explain(id) ?? ctx.artifacts.explain(id)
    return explained ? json(explained) : failure(new Error(`nothing is known about ${id}`))
  })
}
