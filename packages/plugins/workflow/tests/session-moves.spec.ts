/**
 * A step its session's Worker cannot take (live 2026-10-26, board T229/T230): the research run's
 * session stayed on a website whose input bound its evidence step was over, every other Worker was
 * refused because the session stays on its Worker, and the run failed. Now the step leaves the
 * session for another admissible Worker: without the session when its brief already quotes the
 * session's earlier turns, through a handoff of them otherwise; a later step back on the session is
 * handed what it missed; and a step no Worker at all can take still fails, with the reason.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { sha256, startPrompt } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { ArtifactRef, WorkerExecution, WorkerStart } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import type { NodeTemplate } from '../src/index.ts'
import Workflow from '../src/index.ts'

/** A website Worker: it keeps a conversation, and takes at most 30,000 characters, as the Gemini site. */
const SITE = worker('web:gem/standard', {
  schema: 'capability-descriptor@1.3', family: 'site-b', tier: 'standard', quotaClass: 'subscription-chat', proves: ['reason', 'persistent-conversation'], maxInputChars: 30_000,
})
/** A model Worker: metered, so routing prefers the site; no input bound; it proves a web search. */
const MODEL = worker('model:api', { schema: 'capability-descriptor@1.1', family: 'other', tier: 'standard', quotaClass: 'metered', proves: ['reason', 'web-search', 'persistent-conversation'] })

/** A scripted source: a session stays on the Worker its first start chose; each start answers at once. */
function scripted(ctx: Context, answer: (prompt: string, start: WorkerStart) => string) {
  const started: Array<WorkerStart & { prompt: string }> = []
  const sessions = new Map<string, string>()
  const executions = new Map<string, WorkerExecution>()
  ctx.workers.register({
    name: 'scripted', describe: async () => [SITE, MODEL],
    start: (request) => {
      const prompt = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
      if (request.sessionId && !sessions.has(request.sessionId)) sessions.set(request.sessionId, request.worker)
      started.push({ ...request, prompt })
      const id = `x-${started.length}`
      const body = { schema: 'provider-answer@1.0', provider: 'scripted', account: 'scripted', turnId: id, conversation: { mode: 'persistent' }, promptHash: sha256(prompt), text: answer(prompt, request) }
      const result = ctx.artifacts.put({ kind: 'report', bodySchema: body.schema, classification: 'public', producer: { type: 'worker', ref: request.worker }, body }).id as ArtifactRef
      const execution: WorkerExecution = { id, status: 'completed', submitted: true, result, decisions: [] }
      executions.set(id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id)!,
    affinity: (sessionId) => {
      const first = sessions.get(sessionId)
      return first ? [first] : undefined
    },
  })
  return started
}

async function boot(templates: Record<string, NodeTemplate[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'system-session-moves-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, templates }),
  ]
  await Promise.all(fibers)
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx }
}

type Decision = { decider: { id: string }; outcome: { option: string; detail?: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const moves = (ctx: Context, runId: string): Decision[] =>
  ctx.artifacts.list({ kind: 'decision', decisionType: 'route', runId, limit: 100 }).map((a) => a.body as Decision).filter((d) => d.decider.id === 'workflow.session-move')

const step = (nodeId: string, prompt: string, extra: Partial<NodeTemplate> = {}): NodeTemplate =>
  ({ nodeId, objective: `step ${nodeId}`, prompt, capabilities: ['reason'], tier: 'standard', conversation: 'persistent', acceptance: 'acceptance.answer', ...extra })

describe('a step its session\'s Worker cannot take (live 2026-10-26, board T229)', () => {
  it('runs a step over its session\'s Worker\'s input bound without the session, when its brief quotes every earlier turn; the run completes', async () => {
    // As the research template: frame on the site, then a step that quotes it and is over the site's bound.
    const research: NodeTemplate[] = [
      step('frame:1', 'Frame: {{input}}'),
      step('evidence:1', 'Extract the evidence from:\n{{node:frame:1}}', { dependsOn: ['frame:1'] }),
      step('conclusion:1', 'Conclude.', { dependsOn: ['evidence:1'] }),
    ]
    const { ctx } = await boot({ research })
    const started = scripted(ctx, (prompt) => (prompt.startsWith('Frame:') ? `FRAMED ${'h'.repeat(40_000)}` : prompt.startsWith('Extract') ? 'EVIDENCE TABLE' : 'CONCLUDED'))
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does it hold?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    const [frame, evidence, conclusion] = started
    expect(frame).toMatchObject({ worker: 'web:gem/standard', sessionId: expect.any(String) })
    // Off the session, on the Worker that takes it: no session, nothing to resume.
    expect(evidence).toMatchObject({ worker: 'model:api', sessionId: undefined })
    expect(evidence!.prompt).toContain('FRAMED')
    const [move] = moves(ctx, done.runId)
    expect(move).toMatchObject({ outcome: { option: 'sessionless', detail: { sessionId: frame!.sessionId, from: ['web:gem/standard'], worker: 'model:api', carried: [] } } })
    expect(move!.candidates.find((c) => c.option === 'stay')!.reasons[0]).toMatch(/^not stay: session \S+ stays on web:gem\/standard, which cannot take this step: web:gem\/standard: the input has \d+ characters; it takes at most 30000/)
    // Back on the session's Worker, the conclusion is handed the step its conversation never saw.
    expect(conclusion).toMatchObject({ worker: 'web:gem/standard', sessionId: frame!.sessionId })
    expect(conclusion!.prompt).toContain('EVIDENCE TABLE')
    expect(moves(ctx, done.runId)).toHaveLength(1)
    // The route decision of the step off the session reports its input against the bound it is over.
    const route = ctx.artifacts.get(ctx.workflow.records(done.runId).find((r) => r.nodeId === 'evidence:1')!.execution!.route)!.body as Decision
    expect(route.candidates.find((c) => c.selected)!.reasons).toContainEqual(expect.stringMatching(/^input \d+ characters; model:api declares no input bound$/))
  })

  it('hands a step whose capability its session\'s Worker lacks to a Worker that proves it, carrying the turns its brief does not quote; the run completes', async () => {
    const search: NodeTemplate[] = [
      step('frame:1', 'Frame: {{input}}'),
      // It quotes nothing: what it builds on is the conversation, so the handoff carries it.
      step('search:1', 'Search the web for the question framed above.', { dependsOn: ['frame:1'], capabilities: ['reason', 'web-search'] }),
    ]
    const { ctx } = await boot({ search })
    const started = scripted(ctx, (prompt) => (prompt.startsWith('Frame:') ? 'H1: it holds' : 'FOUND'))
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'search', input: 'Does it hold?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    const [frame, search1] = started
    expect(frame!.worker).toBe('web:gem/standard')
    expect(search1).toMatchObject({ worker: 'model:api', sessionId: undefined })
    // The handoff: the session's earlier turn, in the brief.
    expect(search1!.prompt).toContain('H1: it holds')
    const [move] = moves(ctx, done.runId)
    const frameResult = ctx.workflow.records(done.runId).find((r) => r.nodeId === 'frame:1')!.outputReceipt!.result
    expect(move).toMatchObject({ outcome: { option: 'handoff', detail: { worker: 'model:api', carried: [frameResult] } } })
    expect(move!.candidates.find((c) => c.option === 'stay')!.reasons[0]).toContain('does not prove web-search')
  })

  it('still fails a step no Worker at all can take, with the reason, after trying it off the session', async () => {
    const deep: NodeTemplate[] = [
      step('frame:1', 'Frame: {{input}}'),
      step('deep:1', 'Research it deeply: {{node:frame:1}}', { dependsOn: ['frame:1'], capabilities: ['reason', 'deep-research'] }),
    ]
    const { ctx } = await boot({ deep })
    const started = scripted(ctx, () => 'H1: it holds')
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep', input: 'Does it hold?' }).runId, 30_000)
    expect(done.status).toBe('failed')
    expect(started).toHaveLength(1)
    expect(done.error!.message).toMatch(/^no Worker can take this work: no Worker proves deep-research \(.*\); off session \S+ \(whose Workers cannot take it: web:gem\/standard: does not prove deep-research\), no other Worker takes it either: no Worker can take this work: no Worker proves deep-research/)
    expect(moves(ctx, done.runId)).toEqual([])
  })
})
