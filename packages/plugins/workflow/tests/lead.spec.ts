// A lead's token reaches only its own project (T285, ADR-0076): over the store-backed board, the
// engine, and the Worker sessions on one store, the tools a lead calls refuse another project's task,
// run, and Workers with the reason, and the same calls on its own project pass.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolContext, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, KEEPER, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow from '../src/index.ts'

// End to end over real plugins on one durable store; a loaded host needs time.
vi.setConfig({ testTimeout: 120_000 })

/** `read` runs on auto; everything else (a charter) asks. */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

type Reply = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-lead-'))
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  // Every step holds: the runs stay running, and the calls below read them as they stand.
  workers.reply = () => 'hold'
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(RecordingMcp), ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }),
  ]
  await Promise.all(fibers)
  const board = ctx.plugin(StoreBoard, { sweepSeconds: 0 })
  await board
  fibers.push(board)
  const engine = ctx.plugin(Workflow, { ...CONFIG, templates: { ...TEMPLATES } })
  await engine
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  const mcp = (ctx as unknown as { mcp: RecordingMcp }).mcp
  const call = (name: string, args: Record<string, unknown>, context: ToolContext): Promise<Reply> => mcp.tools.get(name)!.handler(args, context) as unknown as Promise<Reply>
  return { ctx, workers, call }
}

const asLead = (project: string): ToolContext => ({ scope: 'client', lead: project })
const OPERATOR: ToolContext = { scope: 'operator' }
const refusal = (own: string, other: string | undefined) => new RegExp(`the lead token of project ${own} reaches only project ${own}; .* belongs to ${other === undefined ? 'no project' : `project ${other}`}`)
const runIdOf = (reply: Reply): string => {
  expect(reply.isError, reply.content[0]?.text).toBeFalsy()
  return (reply.structuredContent as { runId: string }).runId
}

describe('a lead token reaches only its own project (T285)', () => {
  it('runs a board task of its own project, and refuses another project\'s task before anything starts', async () => {
    const { ctx, workers, call } = await boot()
    await activeProject(ctx, 'p1')
    await activeProject(ctx, 'p2')
    const mine = await readyTask(ctx, 'mine', { projectId: 'p1' })
    const theirs = await readyTask(ctx, 'theirs', { projectId: 'p2' })
    const refused = await call('run', { template: 'solo', input: 'x', waitSeconds: 0, task: { taskId: theirs.taskId } }, asLead('p1'))
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(refusal('p1', 'p2'))
    expect((await ctx.board.task(theirs.taskId))!.state).toBe('ready')
    expect(workers.started).toHaveLength(0)
    expect(ctx.workflow.usage()).toHaveLength(0)
    const passed = await call('run', { template: 'solo', input: 'x', waitSeconds: 0, task: { taskId: mine.taskId } }, asLead('p1'))
    expect(passed.isError, passed.content[0]?.text).toBeFalsy()
    expect(passed.structuredContent).toMatchObject({ template: 'solo', task: { taskId: mine.taskId } })
    // The operator's token, with no project, reaches both.
    expect((await call('run', { template: 'solo', input: 'x', waitSeconds: 0, task: { taskId: theirs.taskId } }, OPERATOR)).isError).toBeFalsy()
  })

  it('tags a run with no board task with the lead\'s project, and reads a lead only its own runs', async () => {
    const { ctx, call } = await boot()
    const own = runIdOf(await call('ask', { prompt: 'q', waitSeconds: 0 }, asLead('p1')))
    const theirs = runIdOf(await call('run', { template: 'solo', input: 'q', waitSeconds: 0 }, asLead('p2')))
    const untagged = ctx.workflow.start({ template: 'solo', input: 'the operator\'s own' }).runId
    expect(await ctx.workflow.projectOfRun(own)).toBe('p1')
    expect(await ctx.workflow.projectOfRun(theirs)).toBe('p2')
    expect(await ctx.workflow.projectOfRun(untagged)).toBeUndefined()
    // result, explain, vote, and the dossier of another project's run are refused with the reason; its own pass.
    expect((await call('result', { runId: own, waitSeconds: 0 }, asLead('p1'))).isError).toBeFalsy()
    expect((await call('explain', { id: own }, asLead('p1'))).isError).toBeFalsy()
    const reads: Array<[string, Record<string, unknown>]> = [
      ['result', { runId: own, waitSeconds: 0 }], ['explain', { id: own }], ['vote', { runId: own, decision: 'd', option: 'a', rationale: 'r' }], ['dossier_read', { runId: own }],
    ]
    for (const [name, args] of reads) {
      const refused = await call(name, args, asLead('p2'))
      expect(refused.isError, name).toBe(true)
      expect(refused.content[0]!.text, name).toMatch(refusal('p2', 'p1'))
    }
    // A run of no project is the operator's.
    expect((await call('result', { runId: untagged, waitSeconds: 0 }, asLead('p1'))).content[0]!.text).toMatch(refusal('p1', undefined))
    // A vote on its own run passes the project check (and is then refused by the engine: the run waits on no tie).
    expect((await call('vote', { runId: own, decision: 'd', option: 'a', rationale: 'r' }, asLead('p1'))).content[0]!.text).not.toMatch(/the lead token/)
    const seen = async (context: ToolContext) => ((await call('usage', {}, context)).structuredContent as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId).sort()
    expect(await seen(asLead('p1'))).toEqual([own])
    expect(await seen(asLead('p2'))).toEqual([theirs])
    expect(await seen(OPERATOR)).toEqual([own, theirs, untagged].sort())
  })

  it('continues a session only within its own project, on ask and run alike', async () => {
    const { ctx, call } = await boot()
    const first = runIdOf(await call('ask', { prompt: 'q', persist: true, waitSeconds: 0 }, asLead('p1')))
    const sessionId = ctx.workflow.get(first)!.sessionId!
    expect(sessionId).toBeTruthy()
    expect(await ctx.workflow.projectOfSession(sessionId)).toBe('p1')
    const before = ctx.workflow.usage().length
    for (const [name, args] of [['ask', { prompt: 'q2', sessionId, waitSeconds: 0 }], ['run', { template: 'solo', input: 'q2', sessionId, waitSeconds: 0 }]] as const) {
      const refused = await call(name, args, asLead('p2'))
      expect(refused.isError, name).toBe(true)
      expect(refused.content[0]!.text, name).toMatch(refusal('p2', 'p1'))
    }
    expect(ctx.workflow.usage()).toHaveLength(before)
    expect((await call('ask', { prompt: 'q2', sessionId, waitSeconds: 0 }, asLead('p1'))).isError).toBeFalsy()
    expect((await call('ask', { prompt: 'q3', sessionId, waitSeconds: 0 }, OPERATOR)).isError).toBeFalsy()
    // An unknown session is no project's: refused to a lead.
    expect((await call('ask', { prompt: 'q', sessionId: 'ses-none', waitSeconds: 0 }, asLead('p1'))).content[0]!.text).toMatch(refusal('p1', undefined))
  })

  it('reads a task\'s dossier only for its own project', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx, 'p1')
    await activeProject(ctx, 'p2')
    const theirs = await readyTask(ctx, 'theirs', { projectId: 'p2' })
    const refused = await call('dossier_read', { taskId: theirs.taskId }, asLead('p1'))
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(refusal('p1', 'p2'))
    expect((await call('dossier_read', {}, asLead('p1'))).content[0]!.text).toMatch(/reads a dossier of its own project only/)
    expect((await call('dossier_read', { taskId: theirs.taskId }, asLead('p2'))).content[0]!.text).not.toMatch(/the lead token/)
  })

  it('lets a lead message the Workers of its own project and no other\'s', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx, 'p1')
    await activeProject(ctx, 'p2')
    const mine = await readyTask(ctx, 'mine', { projectId: 'p1' })
    const theirs = await readyTask(ctx, 'theirs', { projectId: 'p2' })
    const a = runIdOf(await call('run', { template: 'solo', input: 'x', waitSeconds: 0, task: { taskId: mine.taskId } }, OPERATOR))
    const b = runIdOf(await call('run', { template: 'solo', input: 'x', waitSeconds: 0, task: { taskId: theirs.taskId } }, OPERATOR))
    const formation = `sha256:${'0'.repeat(64)}` as never
    for (const [id, runId] of [['ses-a', a], ['ses-b', b]] as const) {
      ctx.workerSessions.group(`g-${id}`)
      ctx.workerSessions.join(`g-${id}`, { sessionId: id, role: 'worker', runtime: 'model-api', worker: 'w:standard', formation, runId })
    }
    for (const target of ['ses-b', 'g-ses-b']) {
      const refused = await call('session_send', { to: target, body: 'answer' }, asLead('p1'))
      expect(refused.isError, target).toBe(true)
      expect(refused.content[0]!.text, target).toMatch(/reaches only its own project's Workers; session ses-b belongs to project p2/)
    }
    expect((await call('session_inbox', { sessionId: 'ses-b' }, asLead('p1'))).isError).toBe(true)
    expect(ctx.workerSessions.inbox('ses-b')).toHaveLength(0)
    // A group with no session, and a session that is none, are no Worker of its project.
    ctx.workerSessions.group('g-empty')
    expect((await call('session_send', { to: 'g-empty', body: 'answer' }, asLead('p1'))).content[0]!.text).toMatch(/names no Worker session of it/)
    expect((await call('session_send', { to: 'ses-none', body: 'answer' }, asLead('p1'))).content[0]!.text).toMatch(/names no Worker session of it/)
    for (const target of ['ses-a', 'g-ses-a']) expect((await call('session_send', { to: target, body: 'answer' }, asLead('p1'))).isError, target).toBeFalsy()
    expect((await call('session_inbox', { sessionId: 'ses-a' }, asLead('p1'))).isError).toBeFalsy()
    // One message to the session, one to its group.
    expect(ctx.workerSessions.inbox('ses-a')).toHaveLength(2)
    // The operator reaches both.
    expect((await call('session_send', { to: 'ses-b', body: 'answer' }, OPERATOR)).isError).toBeFalsy()
  })

  it('keeps a retry key within its project on every start tool: another project\'s lead with the same key and request gets a run of its own', async () => {
    const { ctx, call } = await boot()
    ctx.workflow.template('research', TEMPLATES.solo!)
    const starts: Array<[string, Record<string, unknown>]> = [
      ['ask', { prompt: 'q', waitSeconds: 0 }], ['research', { question: 'q' }], ['brainstorm', { question: 'q' }], ['review', { material: 'q' }],
      ['run', { template: 'solo', input: 'q', waitSeconds: 0 }],
    ]
    for (const [name, args] of starts) {
      const keyed = { ...args, clientRequestId: `k-${name}` }
      const a = runIdOf(await call(name, keyed, asLead('p1')))
      const b = runIdOf(await call(name, keyed, asLead('p2')))
      expect(b, name).not.toBe(a)
      expect(await ctx.workflow.projectOfRun(a), name).toBe('p1')
      expect(await ctx.workflow.projectOfRun(b), name).toBe('p2')
      // The key still retries within its project, and the operator's own key is its own.
      expect(runIdOf(await call(name, keyed, asLead('p1'))), name).toBe(a)
      const operator = runIdOf(await call(name, keyed, OPERATOR))
      expect([a, b], name).not.toContain(operator)
      expect(await ctx.workflow.projectOfRun(operator), name).toBeUndefined()
    }
  })

  it('gives a lead the reply of its own Worker it woke, and no other project\'s lead: a wake run belongs to its session\'s project', async () => {
    const { ctx, workers, call } = await boot()
    // Here Workers answer, and one keeps its conversation, so a session can be woken.
    workers.reply = (request) => ({ text: `answer: ${request.prompt}` })
    workers.extra = [KEEPER]
    const origin = runIdOf(await call('ask', { prompt: 'start a conversation', waitSeconds: 0 }, asLead('p1')))
    expect((await ctx.workflow.wait(origin, 30_000)).status).toBe('completed')
    ctx.workerSessions.group('g-wake')
    ctx.workerSessions.join('g-wake', { sessionId: 'ses-wake', role: 'm1', runtime: 'local-tool', worker: 'w:keeper', formation: `sha256:${'0'.repeat(64)}` as never, runId: origin })
    // A first turn gives the session its native conversation, which a wake resumes.
    expect((await ctx.workflow.wait(ctx.workflow.start({ template: 'kept', input: 'first', classification: 'public', sessionId: 'ses-wake' }).runId, 30_000)).status).toBe('completed')
    expect((await call('session_send', { to: 'ses-wake', body: 'what next?' }, asLead('p1'))).isError).toBeFalsy()
    // The idle session is woken on the message: an ask run on its own session, which the engine starts with no project of its own.
    const wake = await vi.waitFor(() => {
      const row = ctx.store.db.prepare('SELECT run_id FROM workflow_wakes WHERE session_id = ?').get('ses-wake') as { run_id: string } | undefined
      if (!row) throw new Error('not woken yet')
      return row.run_id
    }, { timeout: 30_000, interval: 50 })
    expect(await ctx.workflow.projectOfRun(wake)).toBe('p1')
    // The lead reads its Worker's reply: the wake run's answer.
    const read = await call('result', { runId: wake, waitSeconds: 30 }, asLead('p1'))
    expect(read.isError, read.content[0]?.text).toBeFalsy()
    expect(read.structuredContent).toMatchObject({ runId: wake, sessionId: 'ses-wake', status: 'completed', answer: expect.stringContaining('what next?') })
    expect((await call('result', { runId: wake, waitSeconds: 0 }, asLead('p2'))).content[0]!.text).toMatch(refusal('p2', 'p1'))
    const listed = ((await call('usage', {}, asLead('p1'))).structuredContent as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId)
    expect(listed).toContain(wake)
  })
})
