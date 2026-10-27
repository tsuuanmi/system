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
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, KEEPER, readyTask, type Rendered, type Reply, ScriptedWorkers } from '../conformance/workflow.ts'
import Workflow, { type NodeTemplate, type RunView } from '../src/index.ts'

// T291: a Worker's question does not spend an attempt. The answer continues the attempt that asked:
// the run after it keeps what completed and runs the asking step again, on its session, with the answers.
vi.setConfig({ testTimeout: 60_000 })

const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }], default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/** A first step, then a later step on the run's own session: the later one is the one that asks. */
const LATER: NodeTemplate[] = [
  { nodeId: 'first', objective: 'Read the material', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' },
  { nodeId: 'later', objective: 'Answer the task', prompt: 'Answer the task', capabilities: ['reason'], tier: 'standard', conversation: 'persistent', acceptance: 'acceptance.answer', dependsOn: ['first'] },
]

/** A writing step, then a later step that asks (no source here carries a worktree). */
const WRITES: NodeTemplate[] = [
  { nodeId: 'develop', objective: 'Change the tree', prompt: 'Change the tree: {{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' },
  { nodeId: 'later', objective: 'Answer the task', prompt: 'Answer the task', capabilities: ['reason'], tier: 'standard', conversation: 'persistent', acceptance: 'acceptance.answer', dependsOn: ['develop'] },
]

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-question-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  // The later step keeps the run's conversation, so a Worker that keeps one takes it.
  workers.extra = [KEEPER]
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => c.workers.register(workers.source(c)) }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  fibers.push(ctx.plugin(Workflow, { ...CONFIG, templates: { later: LATER, writes: WRITES } }))
  await fibers.at(-1)
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  await activeProject(ctx)
  return { ctx, workers }
}

const settledRun = async (ctx: Context, runId: string): Promise<RunView> => vi.waitFor(() => {
  const view = ctx.workflow.get(runId)
  if (view?.task?.phase !== 'reported') throw new Error(`run ${runId} is not reported yet`)
  return view
}, { timeout: 30_000, interval: 25 })

type Decision = { decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> } }
const continueDecision = (ctx: Context, runId: string): Decision | undefined => ctx.artifacts.list({ kind: 'decision', decisionType: 'admission', runId, limit: 100 })
  .map((a) => a.body as Decision).find((d) => d.decider.id === 'workflow.task-continue')

describe('an answered question continues its attempt (T291)', () => {
  it('runs a later step that asked on attempt 3 again on attempt 3, on its session with the answers, keeps the step before it, and completes', async () => {
    const { ctx, workers } = await boot()
    const task = await readyTask(ctx, 'asks late', { maxAttempts: 3 })
    const run = async (): Promise<RunView> => settledRun(ctx, (await ctx.workflow.start({ template: 'later', input: 'q', classification: 'public', task: { taskId: task.taskId } })).runId)
    let later: Reply[] = []
    workers.reply = (request: Rendered): Reply => (request.prompt.includes('Answer the task') ? later.shift() ?? { text: 'the answer' } : { text: 'read' })

    // Attempts 1 and 2 fail at the later step: each is spent.
    for (const n of [1, 2]) {
      later = [{ fail: 'egress_denied', disposition: 'USER_ACTION', sent: true }]
      expect(await run()).toMatchObject({ status: 'failed' })
      expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready', attempts: { count: n, max: 3 } })
    }

    // Attempt 3: the first step answers, the later one asks.
    later = [{ text: '{"questions": ["Which band width?"]}' }]
    const asked = await run()
    expect(asked).toMatchObject({ status: 'failed', error: { kind: 'question' } })
    expect(asked.nodes.map((n) => [n.nodeId, n.state])).toEqual([['first', 'COMPLETED'], ['later', 'FAILED']])
    const before = (await ctx.board.task(task.taskId))!
    expect(before).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'question' }, attempts: { count: 3, max: 3 } })
    const askingStart = workers.started.at(-1)!

    // Answered: the count is the count before it, and the task is ready for the same attempt.
    const answered = await ctx.board.answer(task.taskId, ['64 is enough'])
    expect(answered).toMatchObject({ state: 'ready', attempts: before.attempts })

    // The run after it keeps the first step and runs only the later one, on attempt 3, on its session, with the answers.
    const sent = workers.started.length
    const next = await run()
    expect(next).toMatchObject({ status: 'completed' })
    expect(next.task!.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    expect(workers.started.length).toBe(sent + 1)
    const resumed = workers.started.at(-1)!
    expect(resumed.prompt).toContain('Answer the task')
    expect(resumed.prompt).toContain('64 is enough')
    expect(resumed.sessionId).toBeDefined()
    expect(resumed.sessionId).toBe(askingStart.sessionId)
    expect((ctx.artifacts.get(resumed.brief!)!.body as { attempt: number }).attempt).toBe(3)
    expect(next.nodes.map((n) => [n.nodeId, n.state])).toEqual([['first', 'COMPLETED'], ['later', 'COMPLETED']])
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 3, max: 3 } })
    // The engine's choice is recorded: it continued the asking step, keeping the completed one.
    expect(continueDecision(ctx, next.runId)?.outcome).toMatchObject({ option: 'continue', detail: { attempt: 3, nodeId: 'later', kept: ['first'], writers: [], from: asked.runId } })
  })

  it('never keeps a completed writing step: the template runs again from its first step, on the same attempt (INV-5)', async () => {
    const { ctx, workers } = await boot()
    const task = await readyTask(ctx, 'asks after writing', { maxAttempts: 1 })
    const run = async (): Promise<RunView> => settledRun(ctx, (await ctx.workflow.start({ template: 'writes', input: 'q', classification: 'public', task: { taskId: task.taskId } })).runId)
    let later: Reply[] = [{ text: '{"questions": ["Keep the API?"]}' }]
    workers.reply = (request: Rendered): Reply => (request.prompt.includes('Answer the task') ? later.shift() ?? { text: 'the answer' } : { text: 'changed' })

    const asked = await run()
    expect(asked).toMatchObject({ status: 'failed', error: { kind: 'question' } })
    expect(asked.nodes.map((n) => [n.nodeId, n.state])).toEqual([['develop', 'COMPLETED'], ['later', 'FAILED']])
    await ctx.board.answer(task.taskId, ['yes'])
    later = []

    // The writing step completed on the asking run's tree, so it is not kept: it runs again.
    const sent = workers.started.length
    const next = await run()
    expect(next).toMatchObject({ status: 'completed' })
    const again = workers.started.slice(sent)
    expect(again.map((s) => (s.prompt.includes('Change the tree') ? 'develop' : 'later'))).toEqual(['develop', 'later'])
    expect(again.at(-1)!.prompt).toContain('yes')
    expect((ctx.artifacts.get(again[0]!.brief!)!.body as { attempt: number }).attempt).toBe(1)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1, max: 1 } })
    expect(continueDecision(ctx, next.runId)?.outcome).toMatchObject({ option: 'fresh', detail: { attempt: 1, writers: ['develop'], kept: [] } })
  })
})
