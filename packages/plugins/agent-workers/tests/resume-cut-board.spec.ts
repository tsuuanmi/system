/**
 * A board task's develop step cut by the host's own stop (the drain of `system shutdown --deadline`,
 * as a live update makes it) resumes by itself after the restart (T283; seen live 2026-10-26, where
 * the cut develop:1 of T270 failed `reconciliation_failed` and its task waited for the operator).
 * Over the store-backed board, approval queue, and engine, restarted on one store; only the agent
 * runtime is scripted. The counterparts: an agent that dies on its own still sends its next attempt to
 * a person, and a run no stop marked (the host crashed) is never resumed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import AgentWorkers from '../src/index.ts'
import { ScriptedAgent } from './stack.ts'

const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-cut-ws-'))
afterAll(() => rmSync(WORKSPACE, { recursive: true, force: true }))

/** Each attempt of a `read` task asks a person first, so a run that fails and goes back for its attempt makes a request. */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'ask' }, { actionClass: 'workspace-write', mode: 'auto' }, { actionClass: 'command', mode: 'ask' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
}
const CHANGE = [{ nodeId: 'develop', objective: 'Change the code', prompt: '{{input}}', capabilities: ['develop', 'local-data'], tier: 'standard' as const, conversation: 'persistent' as const, acceptance: 'acceptance.answer' }]
const CAPABLE = { sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'> }

/** The host: the store-backed stack on `dir`, stopped as `system shutdown` stops it (every plugin disposed, the engine first). */
async function host(dir: string, agent: ScriptedAgent) {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(WorkerSessions, {}),
    ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: agent.kind, workspace: WORKSPACE, sandbox: 'workspace-write', tier: 'standard' }], deadAfterSeconds: 1 }),
    ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  const engine = ctx.plugin(Workflow, { retryDelayMs: 50, approvalPollSeconds: 1, templates: { change: CHANGE } })
  await engine
  ctx.agentRuntimes.register(agent)
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  onTestFinished(stop)
  return { ctx, stop }
}

/** Approve the request a task waits on, and sweep it to ready. */
async function approve(ctx: Context, taskId: string): Promise<void> {
  const waiting = (await ctx.board.task(taskId))!
  expect(waiting.state).toBe('waiting-for-approval')
  const request = (await ctx.approvals.get(waiting.waiting!.approvalRequest!))!
  await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }])
  await ctx.board.sweep(new Date())
  expect((await ctx.board.task(taskId))!.state).toBe('ready')
}

/** A ready board task (its attempt approved), its run started, and its develop step's agent running. */
async function running(dir: string, agent: ScriptedAgent) {
  const first = await host(dir, agent)
  const { ctx } = first
  const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'project p1', charter: CHARTER })
  const charter = (await ctx.approvals.get(approvalRequest))!
  await ctx.approvals.decide([{ requestId: approvalRequest, subject: charter.subject, verdict: 'approved' }])
  await ctx.board.sweep(new Date())
  const proposed = await ctx.board.propose({ projectId: 'p1', title: 'change', goal: 'add the flag', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read' })
  await ctx.board.sweep(new Date())
  await approve(ctx, proposed.taskId)
  const run = await ctx.workflow.start({ template: 'change', input: 'Add the flag', classification: 'operator-shared', task: { taskId: proposed.taskId } })
  return { ...first, taskId: proposed.taskId, runId: run.runId }
}

const reported = (ctx: Context, runId: string) => vi.waitFor(() => {
  const view = ctx.workflow.get(runId)!
  if (view.task?.phase !== 'reported') throw new Error(`run ${runId} is not reported yet (${view.status})`)
  return view
}, { timeout: 30_000, interval: 50 })

/** Every request a person was ever asked in the project (open, batched, or decided), and how many attempts the task has made. */
const asked = async (ctx: Context, taskId: string) => ({
  requests: (await ctx.approvals.list({ projectId: 'p1', states: ['open', 'batched', 'approved', 'rejected'] })).map((r) => r.requestId),
  attempts: (await ctx.board.task(taskId))!.attempts.count,
})

const agentProcessOf = (ctx: Context) => (ctx.store.db.prepare("SELECT agent_process FROM agent_runs WHERE status = 'running'").get() as { agent_process: string | null } | undefined)?.agent_process

describe('a board task\'s develop step the host cut resumes by itself (T283)', { timeout: 60_000 }, () => {
  it('resumes the step in its session after a shutdown cut: the same run completes and is accepted, no approval request is made, and the attempt count is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-cut-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const cutAgent = new ScriptedAgent({ ...CAPABLE, holdMs: 30_000, process: true })
    const first = await running(dir, cutAgent)
    await vi.waitFor(() => expect(agentProcessOf(first.ctx)).toEqual(expect.any(String)), { timeout: 10_000 })
    const before = await asked(first.ctx, first.taskId)
    expect(before.attempts).toBe(1)
    // The cut: the host stops with the step's agent running.
    await first.stop()

    const again = new ScriptedAgent({ ...CAPABLE })
    const second = await host(dir, again)
    const done = await reported(second.ctx, first.runId)
    // The same run went on and was accepted: its step ran again only as a resume of its native session.
    expect(done).toMatchObject({ status: 'completed', task: { outcome: { status: 'accepted' } } })
    expect(again.runs).toHaveLength(1)
    expect(again.runs[0]).toMatchObject({ resume: 'h-1' })
    expect(second.ctx.eventLog.query({ type: 'agent-workers.run.resumed' })).toEqual([expect.objectContaining({ runId: first.runId, data: expect.objectContaining({ how: 'resumed', nativeHandle: 'h-1' }) })])
    // Nobody was asked, and the attempt is the one it was.
    expect(await asked(second.ctx, first.taskId)).toEqual(before)
    expect((await second.ctx.board.task(first.taskId))!.state).toBe('done')
  })

  it('still asks when the agent dies on its own while the host runs: its run fails, and the next attempt waits for a person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-cut-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const dying = new ScriptedAgent({ ...CAPABLE, fail: new ProviderError('session_broken', 'the agent process exited on its own') })
    const first = await running(dir, dying)
    const before = await asked(first.ctx, first.taskId)
    const done = await reported(first.ctx, first.runId)
    expect(done).toMatchObject({ status: 'failed' })
    expect(first.ctx.eventLog.query({ type: 'agent-workers.run.resumed' })).toEqual([])
    const after = await asked(first.ctx, first.taskId)
    expect(after.requests).toHaveLength(before.requests.length + 1)
    const task = (await first.ctx.board.task(first.taskId))!
    expect(task).toMatchObject({ state: 'waiting-for-approval', waiting: { approvalRequest: after.requests.find((r) => !before.requests.includes(r)) } })
  })

  it('never resumes a run no stop marked (the host crashed): its agent run is reconciled as lost for the operator, never run again, and its run fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-cut-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const first = await running(dir, new ScriptedAgent({ ...CAPABLE, holdMs: 30_000, process: true }))
    await vi.waitFor(() => expect(agentProcessOf(first.ctx)).toEqual(expect.any(String)), { timeout: 10_000 })
    const before = await asked(first.ctx, first.taskId)
    await first.stop()
    // A crash, not a stop: the host died with nothing marked.
    const db = new DatabaseSync(join(dir, 'system.db'))
    db.prepare('UPDATE agent_runs SET host_stopped_at = NULL').run()
    db.close()

    const again = new ScriptedAgent({ ...CAPABLE })
    const second = await host(dir, again)
    const done = await reported(second.ctx, first.runId)
    expect(done).toMatchObject({ status: 'failed' })
    expect(again.runs).toEqual([])
    const execution = done.nodes.find((n) => n.nodeId === 'develop')!.executionId!
    expect(second.ctx.workers.source('agents')!.get(execution)).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION' } })
    expect(second.ctx.eventLog.query({ type: 'agent-workers.run.resumed' })).toEqual([])
    // The board took it as the host's failure (ADR-0069): the attempt is given back, on the approval that attempt already had.
    const task = (await second.ctx.board.task(first.taskId))!
    expect(task).toMatchObject({ state: 'waiting-for-approval', attempts: { count: before.attempts - 1 } })
    expect((await asked(second.ctx, first.taskId)).requests).toEqual(before.requests)
  })
})
