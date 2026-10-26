/**
 * The engine's MCP tools (`ctx.mcp`): starting runs and reading them (the `client` scope), and the
 * operator's actions, which declare no scope and so are the operator's alone (ADR-0023).
 */
import type { Context } from '@deepseek-ai/cordis'
import { outline, reply, type ToolContext } from '@tsuuanmi/system-gateway-core'
import type { Classification, LivenessQuery, Tier } from '@tsuuanmi/system-workers-core'
import { z as zod } from 'zod'
import type { Workflow } from './index.ts'
import { DEFAULT_TEMPLATES } from './spec.ts'
import type { Explanation, RunView, TaskClaim } from './types.ts'
import { usageView } from './views.ts'

/**
 * The runs `usage` lists when no limit is asked (at most 500): the recent work a lead looks at, in a
 * few kilobytes (a step's view is about 200 bytes); `limit` asks for more.
 */
export const USAGE_LIMIT = 10

/** Where a run that has not completed stands, in one line: what it waits for, why it failed, or how far it is. */
export function standing(view: RunView): string {
  const head = `${view.runId} (${view.template}) ${view.status}`
  if (view.status === 'failed') return `${head}${view.error ? `: ${view.error.kind}: ${view.error.message}` : ''}`
  if (view.blocked?.kind === 'tie') return `${head}: waits for your vote on ${view.blocked.decision} (${view.blocked.options.map((o) => o.option).join(', ')}) until ${view.blocked.until}`
  if (view.blocked?.kind === 'gate') return `${head}: waits for ${view.blocked.approvalRequest ? `the verdict on ${view.blocked.approvalRequest}` : `the operator's approval of ${view.blocked.plan}`}`
  if (view.blocked?.kind === 'tool-call') return `${head}: step ${view.blocked.nodeId}'s Worker stopped at a tool call that waits for the operator's verdict on ${view.blocked.approvalRequest} until ${view.blocked.until}; approved, the step goes on in the same session`
  const done = view.nodes.filter((n) => n.state === 'COMPLETED').length
  return `${head}: ${done} of ${view.nodes.length} step${view.nodes.length === 1 ? '' : 's'} completed; poll result with its runId`
}

/** Contribute the tools on `c` (the context holding `ctx.mcp`); `ctx` explains artifact ids. */
export function registerTools(c: Context, w: Workflow, ctx: Context): void {
  // The run is the structured content; its text is the answer of a completed run, else a line on where it stands.
  const shape = (view: RunView) => reply(view, view.status === 'completed' ? view.answer ?? '' : standing(view))
  const json = (value: object) => reply(value, outline(value))
  const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] })
  // A lead's token reaches only its own project (T285, ADR-0076): what it names is checked against the token's project, and another's is refused whole.
  const refuseOther = (lead: string, what: string, of: string | undefined): Error => new Error(`the lead token of project ${lead} reaches only project ${lead}; ${what} belongs to ${of === undefined ? 'no project (or is unknown)' : `project ${of}`}, so nothing was done`)
  const ownRun = async (lead: string | undefined, runId: string): Promise<void> => {
    if (lead === undefined) return
    const of = await w.projectOfRun(runId)
    if (of !== lead) throw refuseOther(lead, `run ${runId}`, of)
  }
  const ownTask = async (lead: string | undefined, taskId: string): Promise<void> => {
    if (lead === undefined) return
    const of = await w.projectOfTask(taskId)
    if (of !== lead) throw refuseOther(lead, `board task ${taskId}`, of)
  }
  // The lead a call came from, if any: a caller in the same process may call a handler with no context (an operator's own call).
  const leadOf = (context: ToolContext | undefined): string | undefined => context?.lead
  const tagged = (lead: string | undefined): { projectId?: string } => (lead === undefined ? {} : { projectId: lead })
  // A start may return a run a retry key already started: a lead gets it back only when it is its own project's.
  const ownStart = async (lead: string | undefined, run: RunView): Promise<RunView> => {
    await ownRun(lead, run.runId)
    return run
  }
  const waitSeconds = zod.number().int().min(0).max(55).optional().describe('Seconds to wait for the run to finish (default 45)')
  const classification = zod.enum(['public', 'operator-shared', 'local-private']).optional()
    .describe('The input\'s classification; local-private never leaves the machine')
  const clientRequestId = zod.string().max(200).optional().describe('Retry-safe request key')
  c.mcp.tool('ask', {
    scope: 'client',
    description: 'Ask one Worker, routed by capability, tier, and quota order. Waits up to waitSeconds; otherwise returns a runId for `result`.',
    inputSchema: {
      prompt: zod.string().min(1).max(32_000),
      sessionId: zod.string().max(200).optional().describe('Continue an existing persistent session'),
      persist: zod.boolean().optional().describe('Start a persistent session (a normal conversation)'),
      tier: zod.enum(['economy', 'standard', 'frontier']).optional().describe('Minimum intelligence tier; the lowest admitted tier at or above it runs'),
      classification, clientRequestId, waitSeconds,
    },
  }, async (args, context) => {
    const lead = leadOf(context)
    try {
      const run = await ownStart(lead, w.start({
        ...tagged(lead), template: 'ask', input: String(args.prompt), sessionId: args.sessionId as string | undefined, persist: args.persist as boolean | undefined,
        tier: args.tier as Tier | undefined, classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
      }))
      return shape(await w.wait(run.runId, ((args.waitSeconds as number | undefined) ?? 45) * 1000))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('research', {
    scope: 'client',
    description: 'Research a question: testable hypotheses, two cited literature reviews on two provider families (web search, or Deep research with `deep`), one evidence table from both, a critique on another family, and conclusions per hypothesis, where the reviews agree and differ. Returns a runId at once; poll `result` (minutes; with `deep`, up to an hour).',
    inputSchema: {
      question: zod.string().min(1).max(32_000),
      deep: zod.boolean().optional().describe('Use the providers\' Deep research'),
      classification, clientRequestId,
    },
  }, async (args, context) => {
    const lead = leadOf(context)
    try {
      return shape(await ownStart(lead, w.start({
        ...tagged(lead), template: 'research', input: String(args.question), ...(args.deep ? { variant: 'deep' } : {}),
        classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
      })))
    } catch (error) {
      return failure(error)
    }
  })
  const team = (template: 'brainstorm' | 'review', description: string, field: string, about: string, extra: Record<string, zod.ZodType> = {}): void => {
    c.mcp.tool(template, {
      scope: 'client',
      description,
      inputSchema: { [field]: zod.string().min(1).max(200_000).describe(about), ...extra, classification, clientRequestId },
    }, async (args, context) => {
      const lead = leadOf(context)
      try {
        const repository = args.repository as { url: string; ref?: string } | undefined
        const focus = args.focus as string[] | undefined
        return shape(await ownStart(lead, w.start({
          ...tagged(lead), template, input: String(args[field]), classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
          ...(repository ? { repository: { url: repository.url, ...(repository.ref ? { ref: repository.ref } : {}), ...(focus?.length ? { focus } : {}) } } : {}),
        })))
      } catch (error) {
        return failure(error)
      }
    })
  }
  // A team's answer and outcome, as both team tools say them.
  const outcome = 'Returns a runId at once; poll `result`. The answer starts with a line `outcome: …; method: …; winner: …; decision: …`. The outcome is advice to you: it approves and authorizes nothing.'
  team('brainstorm', `Ask a team to recommend an answer, one member per provider family: each proposes on its own, then all vote by sealed ballot; a split gets one debate and a re-vote, a tie comes back to you (\`vote\`). ${outcome}`, 'question', 'The question and its context: options, constraints, what has been decided')
  team('review', `Review as a team, one member per provider family: text you give (an approach, a design, a diff) or a public repository at one pinned commit. Each finding quotes \`path:line\` and the line's text, every quote checked against what the members read. A confirmed blocking finding decides changes; otherwise all vote pass or changes by sealed ballot, a split gets one debate, a tie comes back to you (\`vote\`). ${outcome}`, 'material',
    'What to review and the criteria it must meet; with `repository`, what to look for in it', {
      repository: zod.object({ url: zod.string().max(2000).describe('https URL of a public repository on an allowed host (default github.com)'), ref: zod.string().max(200).optional().describe('Branch, tag, or commit SHA (default: its HEAD)') })
        .optional().describe('A public repository to review, read at one pinned commit'),
      focus: zod.array(zod.string().max(500)).max(20).optional().describe('Paths or globs of the repository to read first'),
    })
  c.mcp.tool('vote', {
    scope: 'client',
    description: 'Break a team\'s tie: the deciding vote, bound to the exact tie decision the run shows in `blocked`, with your rationale.',
    inputSchema: {
      runId: zod.string().max(200),
      decision: zod.string().max(200).describe('The tie decision from the run\'s blocked view'),
      option: zod.string().max(16).describe('One of the tie\'s options, or inconclusive'),
      rationale: zod.string().min(1).max(2000),
    },
  }, async (args, { scope, lead }) => {
    try {
      // The decider is whoever's token it was: a client's vote is the caller's, never the operator's; a lead's is lead:<project> (ADR-0076).
      const by = scope === 'operator' ? 'operator' : 'client'
      await ownRun(lead, String(args.runId))
      const view = w.vote(String(args.runId), { decision: String(args.decision), option: String(args.option), rationale: String(args.rationale), by, ...(lead !== undefined ? { lead } : {}) })
      return shape(await w.wait(view.runId, 10_000))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('run', {
    scope: 'client',
    description: `Start a workflow template by name (built in: ${Object.keys(DEFAULT_TEMPLATES).sort().join(', ')}; profiles add more, such as research), its steps routed by capability. With \`task\`, the run serves one attempt of that board task: it is recorded on the board before any step runs, renews the lease while it lives, and submits its own result and acceptance, or its failure; a task not ready or a stale claim refuses the run, nothing started. Waits up to waitSeconds; otherwise returns a runId for \`result\`.`,
    inputSchema: {
      template: zod.string().max(100),
      input: zod.string().min(1).max(32_000),
      variant: zod.string().max(100).optional().describe('A variant the template defines (research: deep)'),
      sessionId: zod.string().max(200).optional().describe('Continue an existing session'),
      persist: zod.boolean().optional().describe('Start a persistent session'),
      tier: zod.enum(['economy', 'standard', 'frontier']).optional().describe('Minimum tier for the steps that take the caller\'s tier'),
      task: zod.object({
        taskId: zod.string().max(200),
        holder: zod.string().max(200).optional().describe('The owner your board_claim named, to hand your claim to the run (with generation)'),
        generation: zod.number().int().min(1).optional().describe('The generation board_claim returned (with holder)'),
        fresh: zod.boolean().optional().describe('Start from HEAD, not from the change the previous attempt left (as when review rejected its approach)'),
      }).optional().describe('Run for this board task, one attempt of it: without holder and generation the run claims the ready task itself'),
      classification, clientRequestId, waitSeconds,
    },
  }, async (args, context) => {
    const lead = leadOf(context)
    try {
      const input = {
        ...tagged(lead), template: String(args.template), input: String(args.input), variant: args.variant as string | undefined, sessionId: args.sessionId as string | undefined, persist: args.persist as boolean | undefined,
        tier: args.tier as Tier | undefined, classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
      }
      const task = args.task as TaskClaim | undefined
      if (task) await ownTask(lead, task.taskId)
      const run = await ownStart(lead, task ? await w.start({ ...input, task }) : w.start(input))
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
  c.mcp.tool('hold_steps', {
    description: 'Before a stop: each running run finishes its step in flight and starts no next one until released (release: true) or the host restarts. Returns the hold and the steps in flight.',
    inputSchema: { reason: zod.string().max(500).optional(), release: zod.boolean().optional() },
  }, async (args) => json(args.release ? w.releaseSteps() : w.holdSteps(args.reason ? String(args.reason) : undefined)))
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
    description: 'Replace a completed step\'s result with a corrected one; everything downstream runs again, and a planner downstream plans again, retiring its old plan (a planner\'s replacement must be a valid plan). Lineage invalidation.',
    inputSchema: { runId: zod.string().max(200), nodeId: zod.string().max(200), text: zod.string().min(1).max(4_000_000), note: zod.string().max(2000).optional() },
  }, async (args) => {
    try {
      return shape(await w.supersede(String(args.runId), String(args.nodeId), { text: String(args.text), ...(args.note ? { note: String(args.note) } : {}) }))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('result', {
    scope: 'client',
    description: 'Fetch a run (ask, research, brainstorm, review, or run); waits up to waitSeconds for it to finish or to wait on you (a tie\'s `blocked`).',
    inputSchema: { runId: zod.string().max(200), waitSeconds },
  }, async (args, context) => {
    const lead = leadOf(context)
    try {
      await ownRun(lead, String(args.runId))
      return shape(await w.wait(String(args.runId), ((args.waitSeconds as number | undefined) ?? 45) * 1000))
    } catch (error) {
      return failure(error)
    }
  })
  c.mcp.tool('usage', {
    scope: 'client',
    description: 'Recent runs and, per step, the Worker, tier, and quota class that served it, the tokens a model Worker reports, and usage the ledger could not count (usageUnknown, with why); and what agent runs drew from their accounts\' windows (draws: per kind and window, and per kind, template step, and window, the clean draws counted with their median and p90 in percentage points, and the entries left out by why). A run\'s answer, results, and errors are in `result`.',
    inputSchema: { limit: zod.number().int().min(1).max(500).optional().describe(`Runs, the most recent first (default ${USAGE_LIMIT})`) },
  }, async (args, context) => {
    const lead = leadOf(context)
    const limit = (args.limit as number | undefined) ?? USAGE_LIMIT
    let listed = w.usage(lead === undefined ? limit : 500)
    if (lead !== undefined) {
      // A lead sees the runs of its own project only.
      const own: typeof listed = []
      for (const run of listed) if ((await w.projectOfRun(run.runId)) === lead) own.push(run)
      listed = own.slice(0, limit)
    }
    const runs = listed.map(usageView)
    const steps = runs.reduce((n, r) => n + r.nodes.length, 0)
    // What agent runs drew (PROP-0015 E2), only once any draw is recorded.
    const draws = w.draws()
    return reply({ runs, ...(draws ? { draws } : {}) }, `${runs.length} recent run${runs.length === 1 ? '' : 's'}, ${steps} step${steps === 1 ? '' : 's'}${draws ? `; ${draws.records} quota draw${draws.records === 1 ? '' : 's'} by kind and window` : ''}`)
  })
  // A board task's dossier (ADR-0070): read by anyone who may read runs. It is appended to only by a
  // step's own Worker, through the tool its source binds to that step (never here, where a caller
  // would name the step and be recorded as its Worker), and by the engine's evidence.
  c.mcp.tool('dossier_read', {
    scope: 'client',
    description: 'A board task\'s dossier (by taskId, or a runId serving it): its append-only entries whole, oldest first from `from`.',
    inputSchema: {
      taskId: zod.string().max(200).optional(), runId: zod.string().max(200).optional(),
      from: zod.number().int().min(1).optional(), limit: zod.number().int().min(1).max(50).optional(),
    },
  }, async (args, context) => {
    const lead = leadOf(context)
    try {
      if (lead !== undefined) {
        if (typeof args.runId !== 'string' && typeof args.taskId !== 'string') throw new Error(`the lead token of project ${lead} reads a dossier of its own project only: name its taskId or a runId of it`)
        if (typeof args.runId === 'string') await ownRun(lead, args.runId)
        if (typeof args.taskId === 'string') await ownTask(lead, args.taskId)
      }
      const page = w.dossier({ taskId: args.taskId as string | undefined, runId: args.runId as string | undefined, from: args.from as number | undefined, limit: args.limit as number | undefined })
      return reply(page, `${page.entries.length} of ${page.total} entries of ${page.taskId}'s dossier${page.next ? `; next from ${page.next}` : ''}`)
    } catch (error) {
      return failure(error)
    }
  })
  // Dispatch (ADR-0064): the lead reads where it stands to plan; only the operator pauses or resumes it.
  c.mcp.tool('dispatch_status', {
    scope: 'client',
    description: 'Dispatch: whether System starts ready board tasks on free Workers by itself, its pauses, the last pass with its reason for each ready task, each bound and its use, the starts waiting for the operator\'s go, and those it made.',
    inputSchema: {},
  }, async () => json(w.dispatchStatus()))
  c.mcp.tool('dispatch_pause', {
    description: 'Pause dispatch, or one project\'s (projectId): System asks for and starts no ready task by itself until resumed; its open asks are withdrawn (an operator decision, kept across restarts).',
    inputSchema: { reason: zod.string().max(500).optional(), projectId: zod.string().min(1).max(128).optional() },
  }, async (args) => json(w.pauseDispatch(args.reason ? String(args.reason) : undefined, args.projectId ? String(args.projectId) : undefined)))
  c.mcp.tool('dispatch_resume', {
    description: 'Resume dispatch, or one project\'s, after a pause (an operator decision).',
    inputSchema: { projectId: zod.string().min(1).max(128).optional() },
  }, async (args) => json(w.resumeDispatch(args.projectId ? String(args.projectId) : undefined)))
  c.mcp.tool('explain', {
    scope: 'client',
    description: 'The decision chain behind a run (its own decisions, such as a board task\'s admission, result subject, acceptance, and report; then egress, tier, route, and acceptance per step) and its executions whose liveness needs a look (verdict, why, what to do); or any artifact id\'s inputs; or such an execution by its id.',
    inputSchema: { id: zod.string().max(200) },
  }, async (args, context) => {
    const lead = leadOf(context)
    const id = String(args.id)
    const run = w.explain(id)
    if (run) {
      try {
        await ownRun(lead, id)
      } catch (error) {
        return failure(error)
      }
      const told = await livenessOf(ctx, { runId: id })
      return json(told?.liveness.length || told?.livenessUnread ? { ...run, ...told } : run)
    }
    const artifact = ctx.artifacts.explain(id)
    if (artifact) return json(artifact)
    // An execution a Worker source tells of (an agent run whose liveness is unknown, say), by its own id.
    const execution = await livenessOf(ctx, { execution: id })
    return execution?.liveness.length ? json({ execution: id, ...execution }) : failure(new Error(`nothing is known about ${id}`))
  })
}

/**
 * The executions whose liveness needs a look (PROP-0013), from `ctx.workers.liveness` where its
 * provider offers it: a run's, or one execution's. A source that could not tell is named
 * (`livenessUnread`), never read as having none (INV-2); undefined with no `liveness` to ask.
 */
async function livenessOf(ctx: Context, query: LivenessQuery): Promise<Pick<Explanation, 'liveness' | 'livenessUnread'> & { liveness: NonNullable<Explanation['liveness']> } | undefined> {
  const workers = ctx.get('workers')
  if (!workers?.liveness) return undefined
  try {
    const told = await workers.liveness(query)
    return { liveness: told.runs, ...(told.unread.length ? { livenessUnread: told.unread } : {}) }
  } catch (error) {
    return { liveness: [], livenessUnread: [{ source: 'workers', detail: (error as Error).message.slice(0, 200) }] }
  }
}
