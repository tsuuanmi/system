import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { BoardTask, TaskInput } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import StoreResources from '@tsuuanmi/system-resources'
import type { PoolConfig } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { CapabilityDescriptor, WorkerSandbox } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { advisorSuite, type DispatchHarness, FEATURES } from '../conformance/advisor.ts'
import { type Labelled, ModelAdvisor } from '../src/advisor.ts'
import type { Engine } from '../src/engine.ts'
import Workflow, { type Advice, type Advisor, type AdvisorFeatures, type AdvisorSignal, type Config, type DispatchConfig, dispatchProblems, dispatchSettings, type DispatchStatus, LocalAdvisor, OUTCOME_EVENT } from '../src/index.ts'

// The dispatch pass end to end (ADR-0064, PROP-0014 D1) over the store-backed board, approval queue,
// and resource ledger, on one durable store; only Worker execution is scripted. A loaded host needs time.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

/** `read` runs on auto; every other class, `dispatch` among them, takes the default: ask. */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/** A template whose writing step proves develop, then a review on any Worker. */
const DEV = {
  dev: [
    { nodeId: 'develop:1', objective: 'Write it', prompt: '{{input}}', capabilities: ['develop'], tier: 'standard' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer' },
    { nodeId: 'review:1', objective: 'Review it', prompt: 'Review: {{node:develop:1}}', capabilities: ['reason'], tier: 'standard' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer', dependsOn: ['develop:1'] },
  ],
}

const FIVE_H = 5 * 3600
/** An agent Worker of an account (opaque ids and group), idle, one slot. */
const agent = (id: string, account: string, extra: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor => worker(id, {
  schema: 'capability-descriptor@1.5', quotaClass: 'agent-plan', proves: ['reason', 'develop'], account: { id: account, group: 'g1', mode: 'assigned' },
  load: { running: 0, queued: 0, pending: 0, slots: 1 }, ...extra,
})
const pool = (account: string): PoolConfig => ({ pool: `plan/${account}`, account, kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: FIVE_H }] })

interface Booted {
  ctx: Context
  workers: ScriptedWorkers
  restartWorkflow: (config?: Config) => Promise<void>
  /** Read account's 5 h window as `used` percent, resetting in `resetsIn` minutes, observed `age` minutes ago. */
  read: (account: string, used: number, resetsIn?: number, age?: number) => Promise<void>
}

async function boot(options: { workflow?: Config; accounts?: string[]; sandbox?: (worker: string) => WorkerSandbox | undefined; policy?: AutonomyPolicy; quota?: Record<string, number> } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-dispatch-'))
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  workers.reply = () => 'hold'
  const accounts = options.accounts ?? ['acc-a', 'acc-b']
  const config: Config = { ...CONFIG, ...options.workflow, templates: { ...TEMPLATES, ...DEV, ...options.workflow?.templates }, dispatch: { sweepSeconds: 3600, ...options.workflow?.dispatch } }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register({ ...workers.source(c), ...(options.sandbox ? { sandbox: options.sandbox } : {}) }) }),
    ctx.plugin(StoreApprovals, { policies: [options.policy ?? POLICY], sweepSeconds: 3600 }),
    ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ctx.plugin(StoreResources, { pools: accounts.map(pool), ...(options.quota ? { quota: options.quota } : {}) }),
  ]
  await Promise.all(fibers)
  let engine = ctx.plugin(Workflow, config)
  await engine
  // The pass the engine makes at its start, before any task is ready.
  await ctx.workflow.sweepDispatch()
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  await activeProject(ctx)
  return {
    ctx, workers,
    restartWorkflow: async (next = config) => {
      await engine.dispose()
      engine = ctx.plugin(Workflow, next)
      await engine
      await ctx.workflow.sweepDispatch()
    },
    read: async (account, used, resetsIn = 300, age = 1) => {
      await ctx.resources.observe({
        schema: 'limit-state@1.0', pool: `plan/${account}`, account, window: { id: 'five-hour', kind: 'rolling', seconds: FIVE_H }, state: 'ok', usedPercentage: used,
        resetsAt: new Date(Date.now() + resetsIn * 60_000).toISOString(), source: 'runtime-result', observedAt: new Date(Date.now() - age * 60_000).toISOString(),
      })
    },
  }
}

const ready = (ctx: Context, title: string, extra: Partial<TaskInput> = {}): Promise<BoardTask> => readyTask(ctx, title, { template: 'dev', ...extra })
type Decision = { schema: string; decisionType: string; inputs: string[]; decider: { id: string; version: string }; outcome: { option: string; detail?: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const decisionOf = (ctx: Context, id: string | undefined): Decision => {
  const body = ctx.artifacts.get(id as `sha256:${string}`)?.body as Decision
  expect(body, `decision ${id}`).toBeDefined()
  schemas.assertRecord(body)
  return body
}
const dispatchRequests = async (ctx: Context) => (await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.action.class === 'dispatch')
const approve = async (ctx: Context, requestId: string): Promise<void> => {
  const request = (await ctx.approvals.get(requestId))!
  const [result] = await ctx.approvals.decide([{ requestId, subject: request.subject, verdict: 'approved' }])
  expect(result?.refused).toBeUndefined()
}
const askOf = (status: DispatchStatus, taskId: string) => status.asks.find((a) => a.taskId === taskId)
const reasonOf = (status: DispatchStatus, taskId: string): string => status.lastPass?.tasks.find((t) => t.taskId === taskId)?.reason ?? '(none)'

describe('dispatch settings (ADR-0064)', () => {
  it('defaults to the proposal\'s bounds, fills maxRunning and leaveRunsFree from maxActiveRuns, and refuses a value out of its range with its path', () => {
    expect(dispatchSettings({})).toMatchObject({ enabled: true, sweepSeconds: 60, maxPerPass: 2, maxRunning: 8, maxRunningPerProject: 2, maxRunningPerAccount: 1, maxRunningPerRepository: 4, leaveRunsFree: 4, maxOpenAsks: 4, approvedHoldMinutes: 30, maxActiveRuns: 16 })
    // A small engine leaves dispatch what it can: never more than maxActiveRuns − leaveRunsFree.
    expect(dispatchSettings({ maxActiveRuns: 1 })).toMatchObject({ leaveRunsFree: 0, maxRunning: 1 })
    expect(dispatchSettings({ maxActiveRuns: 6 })).toMatchObject({ leaveRunsFree: 4, maxRunning: 2 })
    expect(dispatchProblems({ dispatch: { maxOpenAsks: 33 } })).toEqual(['dispatch.maxOpenAsks must be a whole number from 1 to 32, not 33'])
    expect(dispatchProblems({ maxActiveRuns: 8, dispatch: { leaveRunsFree: 4, maxRunning: 5 } })).toEqual(['dispatch.maxRunning must be a whole number from 1 to 4, not 5'])
    expect(dispatchProblems({ maxActiveRuns: 8, dispatch: { leaveRunsFree: 8 } })).toEqual(['dispatch.leaveRunsFree must be a whole number from 0 to 7, not 8'])
    expect(dispatchProblems({ dispatch: { sweepSeconds: 5, approvedHoldMinutes: 0, maxRunningPerRepository: 17 } })).toHaveLength(3)
    expect(dispatchProblems({ dispatch: { bogus: 1 } as never })[0]).toMatch(/^dispatch\.bogus is not an option/)
    expect(() => dispatchSettings({ dispatch: { maxPerPass: 0 } })).toThrow('workflow: dispatch.maxPerPass must be a whole number from 1 to 16, not 0')
  })

  it('refuses the workflow row on a dispatch setting out of its range, so no engine runs on a value nobody chose (INV-2)', async () => {
    const ctx = new Context()
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-dispatch-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}), ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {})]
    await Promise.all(fibers)
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    })
    const engine = ctx.plugin(Workflow, { ...CONFIG, maxActiveRuns: 4, dispatch: { maxRunning: 4 } })
    try {
      await engine
    } catch {
      // refused at load: the assertion below is what matters
    }
    expect(ctx.get('workflow')).toBeUndefined()
    await engine.dispose()
  })
})

describe('the dispatch pass (ADR-0064, REQ-WF-16)', () => {
  it('in the operator\'s case asks for maxPerPass starts, oldest first, each on a free Worker chosen by quota, and says why for every task and Worker (REQ-WRK-12, INV-13)', async () => {
    const { ctx, workers, read } = await boot({ accounts: ['acc-a', 'acc-b', 'acc-c'] })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b'), agent('agent:acc-c/develop', 'acc-c', { load: { running: 1, queued: 0, pending: 0, slots: 1 } })]
    await read('acc-a', 0, 40)
    await read('acc-b', 0, 200)
    await read('acc-c', 10, 20)
    const first = await ready(ctx, 'first')
    const second = await ready(ctx, 'second')
    const third = await ready(ctx, 'third')
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass, pass.reason).toMatchObject({ state: 'ran', more: 0 })
    expect(pass.took.map((t) => [t.taskId, t.worker, t.how])).toEqual([[first.taskId, 'agent:acc-a/develop', 'asked'], [second.taskId, 'agent:acc-b/develop', 'asked']])
    expect(reasonOf(pass as DispatchStatus['lastPass'] & DispatchStatus, third.taskId)).toBe('(none)')
    const status = ctx.workflow.dispatchStatus()
    expect(reasonOf(status, third.taskId)).toBe('this pass took its 2 (dispatch.maxPerPass); a later pass looks again')
    // One request per start, bound to the task, its attempt, and the Worker (INV-5).
    const requests = await dispatchRequests(ctx)
    expect(requests).toHaveLength(2)
    const ask = askOf(status, first.taskId)!
    const request = requests.find((r) => r.requestId === ask.requestId)!
    expect(request).toMatchObject({ state: 'open', subject: { type: 'content', ref: `dispatch:${first.taskId}:attempt:0` }, requester: { component: 'workflow', taskId: first.taskId, projectId: 'p1' } })
    expect(request.subject.version).toMatch(/^quota-score@2:sha256:[0-9a-f]{64}$/)
    expect(request.action.summary).toMatch(/^Start attempt 1 of "first" .* on agent:acc-a\/develop: 5 h: used 0 %, headroom 80 above the 20 % reserve/)
    expect(ask).toMatchObject({ state: 'asked', worker: 'agent:acc-a/develop', account: 'acc-a', attempt: 1, windows: [{ name: '5 h', used: 0, headroom: 80, reserve: 20 }] })
    // The decisions: the select over the ready tasks, the choice over every Worker, the policy's verdict.
    const [selectId, choiceId, autonomyId] = ask.decisions
    const select = decisionOf(ctx, selectId)
    expect(select).toMatchObject({ decisionType: 'admission', decider: { id: 'dispatch.select', version: '1' }, outcome: { option: first.taskId } })
    expect(select.candidates.map((c) => [c.option, c.selected])).toEqual([[first.taskId, true], [second.taskId, false], [third.taskId, false]])
    expect(select.candidates[1]!.reasons[0]).toBe(`after ${first.taskId} in the order (the oldest ready task first)`)
    const choice = decisionOf(ctx, choiceId)
    expect(choice).toMatchObject({ decisionType: 'route', decider: { id: 'dispatch.choice', version: '1' }, outcome: { option: 'agent:acc-a/develop', detail: { score: 'quota-score@2', nodeId: 'develop:1', version: request.subject.version } } })
    expect(choice.inputs).toEqual(expect.arrayContaining([selectId, autonomyId]))
    const reasons = Object.fromEntries(choice.candidates.map((c) => [c.option, c.reasons]))
    expect(reasons['agent:acc-a/develop']![0]).toBe('free: every window has headroom above the 20 % reserve')
    expect(reasons['agent:acc-c/develop']![0]).toBe('not free: load 1 of 1 (dispatch.maxRunningPerAccount 1)')
    // The scripted Workers with no account are admitted, never free: their quota is unknown (INV-2).
    expect(reasons['w:standard']).toContain('not free: its quota is unknown: its Worker names no account, so no pool can be told to be its')
    expect(reasons['w:economy']![0]).toMatch(/^refused by routing: tier economy is below the minimum standard/)
    expect(decisionOf(ctx, autonomyId)).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'ask', detail: { actionClass: 'dispatch' } } })
    // Nothing started: no run, no claim.
    expect(workers.started).toHaveLength(0)
    expect((await ctx.board.task(first.taskId))!.state).toBe('ready')
  })

  it('asks once: a pass repeated adopts its open ask, and one interrupted between the request and its record adopts the request (INV-4)', async () => {
    const { ctx, workers, read } = await boot()
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'once')
    // The queue takes the request, then the engine dies before it records it on its row.
    const request = ctx.approvals.request.bind(ctx.approvals)
    let crash = true
    ctx.approvals.request = async (...args) => {
      const made = await request(...args)
      if (crash) {
        crash = false
        throw new Error('the host died after the request was made')
      }
      return made
    }
    const interrupted = await ctx.workflow.sweepDispatch()
    expect(interrupted.state).toBe('waiting')
    expect(askOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatchObject({ state: 'asking' })
    expect(await dispatchRequests(ctx)).toHaveLength(1)
    // The next pass finds the request on its subject, and asks nothing new.
    await ctx.workflow.sweepDispatch()
    await ctx.workflow.sweepDispatch()
    const [open] = await dispatchRequests(ctx)
    expect(await dispatchRequests(ctx)).toHaveLength(1)
    expect(askOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatchObject({ state: 'asked', requestId: open!.requestId })
    expect(reasonOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatch(/^an ask for attempt 1 is open/)
  })

  it('starts exactly the attempt and the Worker an approval names, through the engine\'s own start, and the run names why it started (INV-5, INV-13)', async () => {
    const { ctx, workers, read } = await boot()
    workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
    await read('acc-a', 0, 30)
    await read('acc-b', 0, 600)
    const task = await ready(ctx, 'go')
    await ctx.workflow.sweepDispatch()
    const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
    expect(ask.worker).toBe('agent:acc-a/develop')
    // Meanwhile acc-b would score higher: the approval still starts the Worker it names.
    await read('acc-b', 0, 10)
    await approve(ctx, ask.requestId!)
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took).toEqual([])
    const started = (await ctx.board.task(task.taskId))!
    expect(started.state).toBe('running')
    const runId = started.run!.runId
    await vi.waitFor(() => expect(workers.started.length).toBe(1), { timeout: 30_000 })
    expect(workers.started[0]).toMatchObject({ worker: 'agent:acc-a/develop', runId })
    expect(ctx.workflow.dispatchStatus().asks).toEqual([])
    // The run's admission names the dispatch decisions; explain shows them first, then the approval.
    const view = ctx.workflow.explain(runId)!
    expect(view.decisions!.slice(0, 4).map((d) => d.type)).toEqual(['admission', 'route', 'autonomy', 'approval'])
    const admission = ctx.artifacts.list({ kind: 'decision', decisionType: 'admission', runId, limit: 100 }).map((a) => a.body as Decision).find((d) => d.decider.id === 'workflow.task-admission')!
    expect(admission.inputs).toEqual(expect.arrayContaining(ask.decisions))
    expect(admission.candidates.find((c) => c.selected)!.reasons[0]).toMatch(/^dispatch chose its start/)
  })

  it('starts nothing on an approval whose Worker is not free, waits for it within approvedHoldMinutes, then uses the approval for nothing and asks again', async () => {
    const { ctx, workers, read } = await boot({ workflow: { dispatch: { approvedHoldMinutes: 30 } } })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'held')
    await ctx.workflow.sweepDispatch()
    const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
    // Its Worker is taken by other work before the approval comes.
    workers.extra = [agent('agent:acc-a/develop', 'acc-a', { load: { running: 1, queued: 0, pending: 0, slots: 1 } })]
    await approve(ctx, ask.requestId!)
    await ctx.workflow.sweepDispatch()
    expect(askOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatchObject({ state: 'approved', askId: ask.askId })
    expect(workers.started).toHaveLength(0)
    // Past the hold: the approval is used for nothing; the attempt is chosen again once a Worker is free.
    await ctx.workflow.sweepDispatch(new Date(Date.now() + 31 * 60_000))
    expect(ctx.workflow.dispatchStatus().asks.find((a) => a.askId === ask.askId)).toBeUndefined()
    expect(reasonOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatch(/^no Worker is free for step develop:1/)
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    await ctx.workflow.sweepDispatch()
    const again = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
    expect(again.askId).not.toBe(ask.askId)
    expect(again.state).toBe('asked')
    expect((await dispatchRequests(ctx)).map((r) => r.state).sort()).toEqual(['approved', 'open'])
    expect((await ctx.board.task(task.taskId))!.state).toBe('ready')
  })

  it('withdraws its open ask when the task moves on (a lead\'s start wins the race), and records why', async () => {
    const { ctx, workers, read } = await boot()
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'raced')
    await ctx.workflow.sweepDispatch()
    const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
    const run = await ctx.workflow.start({ template: 'dev', input: 'by hand', task: { taskId: task.taskId } })
    expect(run.task?.claim).toBe('own')
    await ctx.workflow.sweepDispatch()
    const request = (await ctx.approvals.get(ask.requestId!))!
    expect(request).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(ctx.workflow.dispatchStatus().asks).toEqual([])
    const closed = ctx.eventLog.query({ type: 'workflow.dispatch.closed', limit: 10 })
    expect(closed.map((e) => e.data?.['status'])).toEqual(['moved-on'])
  })

  it('never asks again for an attempt the operator denied, or let expire', async () => {
    const { ctx, workers, read } = await boot()
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'denied')
    await ctx.workflow.sweepDispatch()
    const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
    const request = (await ctx.approvals.get(ask.requestId!))!
    await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'rejected' }])
    await ctx.workflow.sweepDispatch()
    await ctx.workflow.sweepDispatch()
    expect(await dispatchRequests(ctx)).toHaveLength(1)
    expect(reasonOf(ctx.workflow.dispatchStatus(), task.taskId)).toBe(`dispatch does not ask again for attempt 1: you denied it (request ${request.requestId}); the lead or you may still start it by hand`)
  })

  it('keeps its bounds, counted from its rows: one per account, the open asks, per project, in total, and the runs it leaves free', async () => {
    const one = await boot({ accounts: ['acc-a'] })
    one.workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-a/develop-2', 'acc-a')]
    await one.read('acc-a', 0)
    const [a, b] = [await ready(one.ctx, 'a'), await ready(one.ctx, 'b')]
    await one.ctx.workflow.sweepDispatch()
    expect(one.ctx.workflow.dispatchStatus().asks.map((x) => x.taskId)).toEqual([a.taskId])
    expect(reasonOf(one.ctx.workflow.dispatchStatus(), b.taskId)).toMatch(/its account has 1 dispatched run\(s\) or ask\(s\) \(dispatch\.maxRunningPerAccount 1\)/)
    const asks = await boot({ accounts: ['acc-a', 'acc-b', 'acc-c'], workflow: { dispatch: { maxOpenAsks: 1, maxPerPass: 4 } } })
    asks.workers.extra = ['acc-a', 'acc-b', 'acc-c'].map((acc) => agent(`agent:${acc}/develop`, acc))
    for (const acc of ['acc-a', 'acc-b', 'acc-c']) await asks.read(acc, 0)
    const [x, y] = [await ready(asks.ctx, 'x'), await ready(asks.ctx, 'y')]
    await asks.ctx.workflow.sweepDispatch()
    expect(asks.ctx.workflow.dispatchStatus().asks.map((t) => t.taskId)).toEqual([x.taskId])
    expect(reasonOf(asks.ctx.workflow.dispatchStatus(), y.taskId)).toBe('1 ask(s) already wait for your go (dispatch.maxOpenAsks 1)')
    const project = await boot({ accounts: ['acc-a', 'acc-b', 'acc-c'], workflow: { dispatch: { maxRunningPerProject: 1, maxPerPass: 4 } } })
    project.workers.extra = ['acc-a', 'acc-b', 'acc-c'].map((acc) => agent(`agent:${acc}/develop`, acc))
    for (const acc of ['acc-a', 'acc-b', 'acc-c']) await project.read(acc, 0)
    const [, q] = [await ready(project.ctx, 'p'), await ready(project.ctx, 'q')]
    await project.ctx.workflow.sweepDispatch()
    expect(reasonOf(project.ctx.workflow.dispatchStatus(), q.taskId)).toBe('project p1 has 1 dispatched run(s) and ask(s) (dispatch.maxRunningPerProject 1)')
    const total = await boot({ accounts: ['acc-a', 'acc-b', 'acc-c'], workflow: { maxActiveRuns: 2, dispatch: { maxPerPass: 4, maxRunningPerProject: 4 } } })
    total.workers.extra = ['acc-a', 'acc-b', 'acc-c'].map((acc) => agent(`agent:${acc}/develop`, acc))
    for (const acc of ['acc-a', 'acc-b', 'acc-c']) await total.read(acc, 0)
    // maxActiveRuns 2 leaves dispatch 1 run (leaveRunsFree 1, maxRunning 1).
    const [, s2] = [await ready(total.ctx, 's1'), await ready(total.ctx, 's2')]
    await total.ctx.workflow.sweepDispatch()
    expect(total.ctx.workflow.dispatchStatus().settings).toMatchObject({ leaveRunsFree: 1, maxRunning: 1 })
    expect(reasonOf(total.ctx.workflow.dispatchStatus(), s2.taskId)).toBe('1 dispatched run(s) and ask(s) already (dispatch.maxRunning 1)')
  })

  it('runs tasks with no write subject on one repository in parallel up to maxRunningPerRepository (D64)', async () => {
    const repo = await boot({ accounts: ['acc-a', 'acc-b', 'acc-c'], workflow: { dispatch: { maxRunningPerRepository: 2, maxPerPass: 4, maxRunningPerProject: 4 } }, sandbox: () => ({ mode: 'workspace-write', workspace: '/repos/one', network: 'none' }) })
    repo.workers.extra = ['acc-a', 'acc-b', 'acc-c'].map((acc) => agent(`agent:${acc}/develop`, acc))
    for (const acc of ['acc-a', 'acc-b', 'acc-c']) await repo.read(acc, 0)
    const tasks = [await ready(repo.ctx, 'r1'), await ready(repo.ctx, 'r2'), await ready(repo.ctx, 'r3')]
    await repo.ctx.workflow.sweepDispatch()
    const status = repo.ctx.workflow.dispatchStatus()
    expect(status.asks.map((a) => [a.taskId, a.repository])).toEqual([[tasks[0]!.taskId, '/repos/one'], [tasks[1]!.taskId, '/repos/one']])
    expect(status.bounds.repositories).toEqual([{ repository: '/repos/one', used: 2, max: 2 }])
    expect(reasonOf(status, tasks[2]!.taskId)).toMatch(/repository \/repos\/one has 2 dispatched run\(s\) or ask\(s\) \(dispatch\.maxRunningPerRepository 2, D64\)/)
  })

  it('never counts an unknown, stale, or reserved window as free, and keeps the configured reserve (INV-2, D63)', async () => {
    const { ctx, workers, read } = await boot({ accounts: ['acc-a', 'acc-b', 'acc-c'], quota: { reservePercent: 30 } })
    workers.extra = ['acc-a', 'acc-b', 'acc-c'].map((acc) => agent(`agent:${acc}/develop`, acc))
    // acc-a: no reading; acc-b: stale (45 min old); acc-c: 70 % used, at the 30 % reserve.
    await read('acc-b', 0, 300, 45)
    await read('acc-c', 70)
    const task = await ready(ctx, 'none free')
    await ctx.workflow.sweepDispatch()
    expect(ctx.workflow.dispatchStatus().asks).toEqual([])
    const reason = reasonOf(ctx.workflow.dispatchStatus(), task.taskId)
    expect(reason).toMatch(/^no Worker is free for step develop:1/)
    expect(reason).toMatch(/no reading yet/)
    expect(reason).toMatch(/stale/)
    expect(reason).toMatch(/used 70 %, no headroom above the 30 % reserve/)
    expect(await dispatchRequests(ctx)).toHaveLength(0)
  })

  it('starts an attempt the operator approved through the board\'s gate with no second button, recorded as such (D62)', async () => {
    const { ctx, workers, read } = await boot()
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    // A command task: the board's gate asks the operator before it is ready.
    const proposed = await ctx.board.propose({ projectId: 'p1', title: 'gated', goal: 'do gated', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'command', template: 'dev' })
    await ctx.board.sweep(new Date())
    const waiting = (await ctx.board.task(proposed.taskId))!
    expect(waiting.state).toBe('waiting-for-approval')
    await approve(ctx, waiting.waiting!.approvalRequest!)
    await ctx.board.sweep(new Date())
    expect((await ctx.board.task(proposed.taskId))!.state).toBe('ready')
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took).toEqual([{ askId: expect.any(String), taskId: proposed.taskId, worker: 'agent:acc-a/develop', how: 'started' }])
    expect(await dispatchRequests(ctx)).toHaveLength(0)
    const task = (await ctx.board.task(proposed.taskId))!
    expect(task.state).toBe('running')
    const explained = ctx.workflow.explain(task.run!.runId)!
    const gate = explained.decisions!.find((d) => d.type === 'gate' && d.outcome === 'board-approval')!
    expect(gate.reasons[0]).toMatch(/approved attempt 1 on the board's request .*which counts as its dispatch approval \(D62\)/)
  })

  it('dispatches nothing under forbid, off, or paused; a pause withdraws its asks and holds across a restart', async () => {
    const forbid = await boot({ policy: { ...POLICY, rules: [...POLICY.rules, { actionClass: 'dispatch', mode: 'forbid' }] } })
    forbid.workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await forbid.read('acc-a', 0)
    const f = await ready(forbid.ctx, 'forbidden')
    await forbid.ctx.workflow.sweepDispatch()
    expect(reasonOf(forbid.ctx.workflow.dispatchStatus(), f.taskId)).toMatch(/^the policy forbids dispatch in project p1/)
    expect(await dispatchRequests(forbid.ctx)).toHaveLength(0)
    expect(forbid.workers.started).toHaveLength(0)
    expect((await forbid.ctx.board.task(f.taskId))!.state).toBe('ready')
    const off = await boot({ workflow: { dispatch: { enabled: false } } })
    off.workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await off.read('acc-a', 0)
    await ready(off.ctx, 'off')
    expect(await off.ctx.workflow.sweepDispatch()).toMatchObject({ state: 'off' })
    expect(await dispatchRequests(off.ctx)).toHaveLength(0)
    const paused = await boot()
    paused.workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await paused.read('acc-a', 0)
    const p = await ready(paused.ctx, 'paused')
    await paused.ctx.workflow.sweepDispatch()
    const ask = askOf(paused.ctx.workflow.dispatchStatus(), p.taskId)!
    const status = paused.ctx.workflow.pauseDispatch('a quiet afternoon')
    expect(status.paused).toMatchObject({ reason: 'a quiet afternoon' })
    expect(decisionOf(paused.ctx, status.paused!.decision)).toMatchObject({ decisionType: 'gate', decider: { id: 'dispatch.pause' }, outcome: { option: 'pause' } })
    await paused.ctx.workflow.sweepDispatch()
    expect((await paused.ctx.approvals.get(ask.requestId!))).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    await paused.restartWorkflow()
    expect(await paused.ctx.workflow.sweepDispatch()).toMatchObject({ state: 'paused' })
    expect(paused.ctx.workflow.dispatchStatus().paused?.reason).toBe('a quiet afternoon')
    paused.ctx.workflow.resumeDispatch()
    await paused.ctx.workflow.sweepDispatch()
    expect(askOf(paused.ctx.workflow.dispatchStatus(), p.taskId)).toMatchObject({ state: 'asked' })
  })

  it('counts the same after a restart, from its rows, and starts no task twice (INV-4)', async () => {
    const { ctx, workers, read, restartWorkflow } = await boot({ accounts: ['acc-a', 'acc-b'] })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
    await read('acc-a', 0)
    await read('acc-b', 0)
    const [one, two] = [await ready(ctx, 'one'), await ready(ctx, 'two')]
    await ctx.workflow.sweepDispatch()
    await approve(ctx, askOf(ctx.workflow.dispatchStatus(), one.taskId)!.requestId!)
    await ctx.workflow.sweepDispatch()
    const before = ctx.workflow.dispatchStatus().bounds
    expect(before.running.used).toBe(2)
    await restartWorkflow()
    expect(ctx.workflow.dispatchStatus().bounds).toEqual(before)
    await ctx.workflow.sweepDispatch()
    expect(ctx.workflow.dispatchStatus().bounds.running.used).toBe(2)
    expect((await ctx.board.task(one.taskId))!.attempts.count).toBe(1)
    expect(await dispatchRequests(ctx)).toHaveLength(2)
    expect(askOf(ctx.workflow.dispatchStatus(), two.taskId)).toMatchObject({ state: 'asked' })
  })
})

/** The studio policy with `dispatch` at `mode`. */
const withDispatch = (mode: 'auto' | 'notify' | 'ask'): AutonomyPolicy => ({ ...POLICY, rules: [...POLICY.rules, { actionClass: 'dispatch', mode }] })
/** Every request the queue holds, in any of its states (a withdrawn or expired one is rejected), of the class `dispatch`. */
const everyDispatchRequest = dispatchRequests
/** The dispatch rows of a task, as the store keeps them. */
const rowsOf = (ctx: Context, taskId: string) => ctx.store.db.prepare('SELECT ask_id, state, mode, run_id, started_at FROM workflow_dispatch WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<{ ask_id: string; state: string; mode: string; run_id: string | null; started_at: string | null }>

describe('dispatch starting by itself (PROP-0014 D2, ADR-0064)', () => {
  it('under auto starts the chosen attempt with no request at all, records the choice with every candidate\'s reason, and the run says dispatch started it', async () => {
    const { ctx, workers, read } = await boot({ policy: withDispatch('auto'), accounts: ['acc-a', 'acc-b'] })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b', { load: { running: 1, queued: 0, pending: 0, slots: 1 } })]
    await read('acc-a', 0)
    await read('acc-b', 0)
    const task = await ready(ctx, 'by itself')
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took).toEqual([{ askId: expect.any(String), taskId: task.taskId, worker: 'agent:acc-a/develop', how: 'started' }])
    expect(reasonOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatch(/^taken: attempt 1 on agent:acc-a\/develop, started by itself: the policy gives dispatch auto in project p1, so nothing is asked; its run started$/)
    // No request, no queue entry, in any state (the project's founding charter, approved before, is the only one).
    expect(await everyDispatchRequest(ctx)).toHaveLength(0)
    expect((await ctx.approvals.list({ projectId: 'p1', states: ['open', 'batched', 'approved', 'rejected'] })).map((r) => r.action.class)).toEqual(['charter'])
    const started = (await ctx.board.task(task.taskId))!
    expect(started.state).toBe('running')
    const runId = started.run!.runId
    await vi.waitFor(() => expect(workers.started.length).toBe(1), { timeout: 30_000 })
    expect(workers.started[0]).toMatchObject({ worker: 'agent:acc-a/develop', runId })
    expect(ctx.workflow.get(runId)!.task?.startedBy).toBe('dispatch')
    // The decisions: the select, the choice over every Worker with its reason, and the policy's verdict, auto.
    const status = ctx.workflow.dispatchStatus()
    expect(status.asks).toEqual([])
    expect(status.started).toEqual([expect.objectContaining({ taskId: task.taskId, title: 'by itself', worker: 'agent:acc-a/develop', runId, mode: 'auto', runStatus: 'running', attempt: 1 })])
    expect(status.started[0]!.notice).toBeUndefined()
    expect(status.bounds.hour).toEqual({ used: 1, max: 6 })
    const view = ctx.workflow.explain(runId)!
    expect(view.decisions!.slice(0, 3).map((d) => d.type)).toEqual(['admission', 'route', 'autonomy'])
    const admission = ctx.artifacts.list({ kind: 'decision', decisionType: 'admission', runId, limit: 100 }).map((a) => a.body as Decision).find((d) => d.decider.id === 'workflow.task-admission')!
    const kept = ctx.store.db.prepare('SELECT dispatch FROM workflow_tasks WHERE run_id = ?').get(runId) as { dispatch: string }
    const decisions = (JSON.parse(kept.dispatch) as { decisions: string[] }).decisions
    // Under auto there is no approval: the select, the choice, and the policy's autonomy decision only.
    expect(decisions).toHaveLength(3)
    expect(admission.inputs).toEqual(expect.arrayContaining(decisions))
    const [selectId, choiceId, autonomyId] = decisions
    expect(decisionOf(ctx, selectId)).toMatchObject({ decider: { id: 'dispatch.select' }, outcome: { option: task.taskId } })
    expect(decisionOf(ctx, selectId).candidates[0]!.reasons[0]).toMatch(/the policy gives dispatch auto in project p1, so it starts with nothing asked/)
    const choice = decisionOf(ctx, choiceId)
    expect(choice).toMatchObject({ decisionType: 'route', decider: { id: 'dispatch.choice' }, outcome: { option: 'agent:acc-a/develop', detail: { score: 'quota-score@2' } } })
    const reasons = Object.fromEntries(choice.candidates.map((c) => [c.option, c.reasons]))
    expect(reasons['agent:acc-a/develop']![0]).toBe('free: every window has headroom above the 20 % reserve')
    expect(reasons['agent:acc-b/develop']![0]).toBe('not free: load 1 of 1 (dispatch.maxRunningPerAccount 1)')
    expect(decisionOf(ctx, autonomyId)).toMatchObject({ decisionType: 'autonomy', outcome: { option: 'auto', detail: { actionClass: 'dispatch' } } })
    // auto tells nothing beyond the record and Home.
    expect(ctx.eventLog.query({ type: 'workflow.dispatch.notice', limit: 10 })).toEqual([])
  })

  it('under notify starts it the same way and records one notice of the start', async () => {
    const { ctx, workers, read, restartWorkflow } = await boot({ policy: withDispatch('notify') })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'told')
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took.map((t) => t.how)).toEqual(['started'])
    expect(await everyDispatchRequest(ctx)).toHaveLength(0)
    const runId = (await ctx.board.task(task.taskId))!.run!.runId
    const notices = ctx.eventLog.query({ type: 'workflow.dispatch.notice', limit: 10 })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ runId, data: { taskId: task.taskId, projectId: 'p1', attempt: 1, worker: 'agent:acc-a/develop', runId } })
    expect(ctx.workflow.dispatchStatus().started).toEqual([expect.objectContaining({ taskId: task.taskId, mode: 'notify', notice: true })])
    // Passes after it, and a restart, tell nothing again.
    await ctx.workflow.sweepDispatch()
    await restartWorkflow()
    expect(ctx.eventLog.query({ type: 'workflow.dispatch.notice', limit: 10 })).toHaveLength(1)
  })

  it('under ask keeps asking as before: one request, nothing started, and the start is listed only once approved', async () => {
    const { ctx, workers, read } = await boot({ policy: withDispatch('ask') })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'asked')
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took.map((t) => t.how)).toEqual(['asked'])
    const [request] = await dispatchRequests(ctx)
    expect(request).toMatchObject({ state: 'open', subject: { ref: `dispatch:${task.taskId}:attempt:0` } })
    expect(workers.started).toHaveLength(0)
    expect(ctx.workflow.dispatchStatus().started).toEqual([])
    expect(rowsOf(ctx, task.taskId)).toEqual([expect.objectContaining({ state: 'asked', mode: 'ask' })])
    await approve(ctx, request!.requestId)
    await ctx.workflow.sweepDispatch()
    const runId = (await ctx.board.task(task.taskId))!.run!.runId
    expect(ctx.workflow.dispatchStatus().started).toEqual([expect.objectContaining({ runId, mode: 'ask' })])
    expect(ctx.workflow.get(runId)!.task?.startedBy).toBe('dispatch')
    expect(ctx.eventLog.query({ type: 'workflow.dispatch.notice', limit: 10 })).toEqual([])
  })

  it('keeps the hourly bounds, counted from its rows, and starts again once the hour leaves room', async () => {
    const all = await boot({ policy: withDispatch('auto'), accounts: ['acc-a', 'acc-b'], workflow: { dispatch: { maxPerHour: 1, maxPerPass: 4, maxRunningPerProject: 4 } } })
    all.workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
    await all.read('acc-a', 0)
    await all.read('acc-b', 0)
    const [first, second] = [await ready(all.ctx, 'first'), await ready(all.ctx, 'second')]
    await all.ctx.workflow.sweepDispatch()
    expect((await all.ctx.board.task(first.taskId))!.state).toBe('running')
    expect((await all.ctx.board.task(second.taskId))!.state).toBe('ready')
    expect(reasonOf(all.ctx.workflow.dispatchStatus(), second.taskId)).toBe('1 start(s) in the last hour already (dispatch.maxPerHour 1): dispatch starts nothing more until the hour leaves room (INV-9)')
    // A restart counts the same.
    await all.restartWorkflow()
    expect(reasonOf(all.ctx.workflow.dispatchStatus(), second.taskId)).toMatch(/^1 start\(s\) in the last hour already/)
    // An hour on (the start's row aged by an hour), there is room again.
    all.ctx.store.db.prepare('UPDATE workflow_dispatch SET started_at = ? WHERE task_id = ?').run(new Date(Date.now() - 61 * 60_000).toISOString(), first.taskId)
    await all.ctx.workflow.sweepDispatch()
    expect((await all.ctx.board.task(second.taskId))!.state).toBe('running')
    // Per project, and 0 starts nothing.
    const project = await boot({ policy: withDispatch('auto'), accounts: ['acc-a', 'acc-b'], workflow: { dispatch: { maxPerHour: 4, maxPerHourPerProject: 1, maxPerPass: 4, maxRunningPerProject: 4 } } })
    project.workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
    await project.read('acc-a', 0)
    await project.read('acc-b', 0)
    const [, q] = [await ready(project.ctx, 'p'), await ready(project.ctx, 'q')]
    await project.ctx.workflow.sweepDispatch()
    expect(reasonOf(project.ctx.workflow.dispatchStatus(), q.taskId)).toBe('project p1 had 1 start(s) in the last hour already (dispatch.maxPerHourPerProject 1): dispatch starts nothing more until the hour leaves room (INV-9)')
    expect(project.ctx.workflow.dispatchStatus().bounds.hourProjects).toEqual([{ projectId: 'p1', used: 1, max: 1 }])
    const none = await boot({ policy: withDispatch('auto'), workflow: { dispatch: { maxPerHour: 0 } } })
    none.workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await none.read('acc-a', 0)
    const z = await ready(none.ctx, 'zero')
    await none.ctx.workflow.sweepDispatch()
    expect((await none.ctx.board.task(z.taskId))!.state).toBe('ready')
    expect(none.workers.started).toHaveLength(0)
    // The settings: defaults, and a per-project bound above the hour's refused with its path.
    expect(dispatchSettings({})).toMatchObject({ maxPerHour: 6, maxPerHourPerProject: 3 })
    expect(dispatchSettings({ dispatch: { maxPerHour: 2 } })).toMatchObject({ maxPerHour: 2, maxPerHourPerProject: 2 })
    expect(dispatchProblems({ dispatch: { maxPerHour: 2, maxPerHourPerProject: 3 } })).toEqual(['dispatch.maxPerHourPerProject must be a whole number from 0 to 2, not 3'])
    expect(dispatchProblems({ dispatch: { maxPerHour: 121 } })).toEqual(['dispatch.maxPerHour must be a whole number from 0 to 120, not 121'])
  })

  it('pauses one project\'s dispatch: nothing there is started, it holds across a restart, and a resume starts it', async () => {
    const { ctx, workers, read, restartWorkflow } = await boot({ policy: withDispatch('auto') })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const status = ctx.workflow.pauseDispatch('quiet in p1', 'p1')
    expect(status.paused).toBeUndefined()
    expect(status.pausedProjects).toEqual([expect.objectContaining({ projectId: 'p1', reason: 'quiet in p1' })])
    expect(decisionOf(ctx, status.pausedProjects[0]!.decision)).toMatchObject({ decisionType: 'gate', decider: { id: 'dispatch.pause' }, outcome: { option: 'pause', detail: { projectId: 'p1' } } })
    const task = await ready(ctx, 'held')
    // The pass the pause ran may still be in flight, from before the task was ready: one more after it.
    await ctx.workflow.sweepDispatch()
    await ctx.workflow.sweepDispatch()
    expect(reasonOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatch(/^you paused dispatch in project p1 at .*: quiet in p1 \(decision sha256:[0-9a-f]{64}\); the lead and you still start its tasks by hand$/)
    expect((await ctx.board.task(task.taskId))!.state).toBe('ready')
    await restartWorkflow()
    expect(reasonOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatch(/^you paused dispatch in project p1/)
    expect(() => ctx.workflow.pauseDispatch(undefined, 'no spaces allowed')).toThrow(/a project id is/)
    ctx.workflow.resumeDispatch('p1')
    await ctx.workflow.sweepDispatch()
    expect((await ctx.board.task(task.taskId))!.state).toBe('running')
  })

  it('withdraws an open ask of a project the operator pauses, and keeps the pause of all dispatch apart', async () => {
    const { ctx, workers, read } = await boot()
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'asked, then paused')
    await ctx.workflow.sweepDispatch()
    const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
    ctx.workflow.pauseDispatch(undefined, 'p1')
    await ctx.workflow.sweepDispatch()
    expect(await ctx.approvals.get(ask.requestId!)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    const closed = ctx.eventLog.query({ type: 'workflow.dispatch.closed', limit: 10 })
    expect(closed.map((e) => [e.data?.['status'], e.data?.['reason']])).toEqual([['paused', expect.stringMatching(/^the operator paused dispatch in project p1 at /)]])
    expect(ctx.workflow.dispatchStatus().paused).toBeUndefined()
  })

  it('starts once when a restart comes in the middle of a start: the run the engine admitted is adopted, never started again (INV-4)', async () => {
    for (const rewound of ['starting', 'approved'] as const) {
      const { ctx, workers, read, restartWorkflow } = await boot({ policy: withDispatch('auto') })
      workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
      await read('acc-a', 0)
      const task = await ready(ctx, `crash while ${rewound}`)
      await ctx.workflow.sweepDispatch()
      const runId = (await ctx.board.task(task.taskId))!.run!.runId
      await vi.waitFor(() => expect(workers.started.length).toBe(1), { timeout: 30_000 })
      // The host died after the engine admitted the run, before the row recorded it started.
      ctx.store.db.prepare('UPDATE workflow_dispatch SET state = ?, run_id = NULL, started_at = NULL, outcome = NULL WHERE task_id = ?').run(rewound, task.taskId)
      await restartWorkflow()
      await ctx.workflow.sweepDispatch()
      expect(rowsOf(ctx, task.taskId)).toEqual([expect.objectContaining({ state: 'started', mode: 'auto', run_id: runId, started_at: expect.any(String) })])
      const after = (await ctx.board.task(task.taskId))!
      expect(after).toMatchObject({ state: 'running', run: { runId }, attempts: { count: 1 } })
      expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM workflow_tasks WHERE task_id = ?').get(task.taskId)).toEqual({ n: 1 })
      expect(workers.started).toHaveLength(1)
      expect(await everyDispatchRequest(ctx)).toHaveLength(0)
    }
  })
})

/** A node's row, as the store keeps it. */
const nodeRowOf = (ctx: Context, runId: string, nodeId: string) => ctx.store.db.prepare('SELECT state, worker, not_before, error, attempt FROM workflow_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as { state: string; worker: string | null; not_before: string | null; error: string | null; attempt: number }
const closedOf = (ctx: Context) => ctx.eventLog.query({ type: 'workflow.dispatch.closed', limit: 50 }).map((e) => e.data?.['status'])

describe('every dispatched start stays explained (review T202 of PR #37)', () => {
  it('keeps a dispatched start on the Worker dispatch chose: refused at routing, the step waits for it within approvedHoldMinutes and never routes to another; past the hold the run fails with nothing sent (INV-13, ADR-0064)', async () => {
    const { ctx, workers, read, restartWorkflow } = await boot({ policy: withDispatch('auto'), workflow: { dispatch: { approvedHoldMinutes: 1 } } })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b', { load: { running: 1, queued: 0, pending: 0, slots: 1 } })]
    await read('acc-a', 0)
    await read('acc-b', 0)
    // Between dispatch's choice and the engine's routing, the chosen Worker signs out, and another one is idle now.
    const route = ctx.workers.route.bind(ctx.workers)
    ctx.workers.route = async (...args) => {
      workers.extra = [agent('agent:acc-a/develop', 'acc-a', { state: 'unavailable' }), agent('agent:acc-b/develop', 'acc-b')]
      return route(...args)
    }
    const task = await ready(ctx, 'bound to its choice')
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took.map((t) => [t.worker, t.how])).toEqual([['agent:acc-a/develop', 'started']])
    const runId = (await ctx.board.task(task.taskId))!.run!.runId
    await vi.waitFor(() => expect(workers.started.length + (nodeRowOf(ctx, runId, 'develop:1').error ? 1 : 0)).toBeGreaterThan(0), { timeout: 30_000 })
    // No Worker dispatch did not choose takes it: the step waits for the chosen one, nothing sent, no attempt spent.
    expect(workers.started).toEqual([])
    const waiting = nodeRowOf(ctx, runId, 'develop:1')
    expect(waiting).toMatchObject({ state: 'READY', worker: null, attempt: 0, not_before: expect.any(String) })
    expect(JSON.parse(waiting.error!).message).toMatch(/dispatch chose agent:acc-a\/develop for this step .*it waits for that Worker/)
    // Past the hold (the run started more than approvedHoldMinutes ago), the run fails on it, still with nothing sent.
    ctx.store.db.prepare('UPDATE workflow_runs SET created_at = ? WHERE run_id = ?').run(new Date(Date.now() - 2 * 60_000).toISOString(), runId)
    ctx.store.db.prepare('UPDATE workflow_nodes SET not_before = ? WHERE run_id = ?').run(new Date().toISOString(), runId)
    await restartWorkflow()
    await vi.waitFor(() => expect(ctx.workflow.get(runId)!.status).toBe('failed'), { timeout: 30_000 })
    expect(workers.started).toEqual([])
    expect(nodeRowOf(ctx, runId, 'develop:1').error).toMatch(/dispatch chose agent:acc-a\/develop for this step/)
  })

  it('never starts a waiting step on its chosen Worker once the hold has expired, even when that Worker is free again (ADR-0064)', async () => {
    const { ctx, workers, read, restartWorkflow } = await boot({ policy: withDispatch('auto'), workflow: { dispatch: { approvedHoldMinutes: 1 } } })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    // Between dispatch's choice and the engine's routing, the chosen Worker signs out.
    const route = ctx.workers.route.bind(ctx.workers)
    ctx.workers.route = async (...args) => {
      workers.extra = [agent('agent:acc-a/develop', 'acc-a', { state: 'unavailable' })]
      return route(...args)
    }
    const task = await ready(ctx, 'free again too late')
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took.map((t) => [t.worker, t.how])).toEqual([['agent:acc-a/develop', 'started']])
    const runId = (await ctx.board.task(task.taskId))!.run!.runId
    await vi.waitFor(() => expect(nodeRowOf(ctx, runId, 'develop:1').error).toMatch(/it waits for that Worker/), { timeout: 30_000 })
    expect(workers.started).toEqual([])
    // The chosen Worker is free again, with fresh readings, but only after the hold expired.
    ctx.workers.route = route
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    ctx.store.db.prepare('UPDATE workflow_runs SET created_at = ? WHERE run_id = ?').run(new Date(Date.now() - 2 * 60_000).toISOString(), runId)
    ctx.store.db.prepare('UPDATE workflow_nodes SET not_before = ? WHERE run_id = ?').run(new Date().toISOString(), runId)
    await restartWorkflow()
    await vi.waitFor(() => expect(ctx.workflow.get(runId)!.status).toBe('failed'), { timeout: 30_000 })
    expect(workers.started).toEqual([])
    expect(JSON.parse(nodeRowOf(ctx, runId, 'develop:1').error!).message).toMatch(/dispatch chose agent:acc-a\/develop for this step .*waited more than dispatch\.approvedHoldMinutes \(1\)/)
  })

  it('revalidates a row a crash left starting before its run was admitted: a pause closes it, an expired hold closes it, a Worker not free holds it, and nothing starts (INV-4)', async () => {
    for (const crash of ['paused', 'expired', 'busy'] as const) {
      const { ctx, workers, read, restartWorkflow } = await boot()
      workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
      await read('acc-a', 0)
      const task = await ready(ctx, `starting, then ${crash}`)
      await ctx.workflow.sweepDispatch()
      const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
      // Approved while its Worker is busy: the row waits, approved.
      workers.extra = [agent('agent:acc-a/develop', 'acc-a', { load: { running: 1, queued: 0, pending: 0, slots: 1 } })]
      await approve(ctx, ask.requestId!)
      await ctx.workflow.sweepDispatch()
      expect(rowsOf(ctx, task.taskId)).toEqual([expect.objectContaining({ state: 'approved' })])
      // The host marked it starting, then died before the engine admitted its run.
      ctx.store.db.prepare("UPDATE workflow_dispatch SET state = 'starting' WHERE ask_id = ?").run(ask.askId)
      if (crash !== 'busy') {
        workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
        await read('acc-a', 0)
      }
      if (crash === 'paused') ctx.workflow.pauseDispatch('stopped while it restarted')
      if (crash === 'expired') ctx.store.db.prepare('UPDATE workflow_dispatch SET approved_at = ? WHERE ask_id = ?').run(new Date(Date.now() - 31 * 60_000).toISOString(), ask.askId)
      await restartWorkflow()
      await ctx.workflow.sweepDispatch()
      expect(workers.started, crash).toEqual([])
      expect((await ctx.board.task(task.taskId))!.state, crash).toBe('ready')
      const row = rowsOf(ctx, task.taskId).find((r) => r.ask_id === ask.askId)!
      if (crash === 'busy') expect(row.state).toBe('approved')
      else {
        expect(row.state, crash).toBe('closed')
        expect(closedOf(ctx), crash).toContain(crash === 'paused' ? 'paused' : 'hold-expired')
      }
    }
  })

  it('uses an approval past approvedHoldMinutes for nothing, even with its Worker free and fresh readings', async () => {
    const { ctx, workers, read } = await boot({ workflow: { dispatch: { approvedHoldMinutes: 30 } } })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const task = await ready(ctx, 'expired, then free')
    await ctx.workflow.sweepDispatch()
    const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
    workers.extra = [agent('agent:acc-a/develop', 'acc-a', { load: { running: 1, queued: 0, pending: 0, slots: 1 } })]
    await approve(ctx, ask.requestId!)
    await ctx.workflow.sweepDispatch()
    expect(askOf(ctx.workflow.dispatchStatus(), task.taskId)).toMatchObject({ state: 'approved', askId: ask.askId })
    // Its Worker is free again, read a minute ago; the approval is 31 minutes old.
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    ctx.store.db.prepare('UPDATE workflow_dispatch SET approved_at = ? WHERE ask_id = ?').run(new Date(Date.now() - 31 * 60_000).toISOString(), ask.askId)
    await ctx.workflow.sweepDispatch()
    expect(workers.started).toEqual([])
    expect((await ctx.board.task(task.taskId))!.state).toBe('ready')
    expect(rowsOf(ctx, task.taskId).find((r) => r.ask_id === ask.askId)!.state).toBe('closed')
    expect(closedOf(ctx)).toEqual(['hold-expired'])
  })

  it('charges the starts settlement makes to the same maxPerPass as the asks and starts selection makes', async () => {
    const { ctx, workers, read } = await boot({ workflow: { dispatch: { maxPerPass: 1, maxRunningPerProject: 4 } } })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const first = await ready(ctx, 'approved first')
    await ctx.workflow.sweepDispatch()
    await approve(ctx, askOf(ctx.workflow.dispatchStatus(), first.taskId)!.requestId!)
    // A second ready task, with a free Worker of its own.
    workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
    await read('acc-b', 0)
    const second = await ready(ctx, 'ready second')
    await ctx.workflow.sweepDispatch()
    // The pass started the approved one: that was its one.
    expect((await ctx.board.task(first.taskId))!.state).toBe('running')
    expect(askOf(ctx.workflow.dispatchStatus(), second.taskId)).toBeUndefined()
    expect(reasonOf(ctx.workflow.dispatchStatus(), second.taskId)).toBe('this pass took its 1 (dispatch.maxPerPass); a later pass looks again')
    // The next pass has its own.
    await ctx.workflow.sweepDispatch()
    expect(askOf(ctx.workflow.dispatchStatus(), second.taskId)).toMatchObject({ state: 'asked', worker: 'agent:acc-b/develop' })
  })

  it('charges a request the queue opened to maxPerPass even when recording it on its row then fails, so the pass opens no second one (review of T205)', async () => {
    const { ctx, workers, read } = await boot({ workflow: { dispatch: { maxPerPass: 1, maxRunningPerProject: 4 } } })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
    await read('acc-a', 0)
    await read('acc-b', 0)
    const first = await ready(ctx, 'asking first')
    const second = await ready(ctx, 'asking second')
    await ctx.workflow.sweepDispatch()
    await ctx.workflow.sweepDispatch()
    const asks = [askOf(ctx.workflow.dispatchStatus(), first.taskId)!, askOf(ctx.workflow.dispatchStatus(), second.taskId)!]
    expect(asks.map((a) => a.state)).toEqual(['asked', 'asked'])
    // Both rows are back to asking with no open request: a crash before either was asked.
    for (const ask of asks) {
      await ctx.approvals.withdraw(ask.requestId!)
      ctx.store.db.prepare("UPDATE workflow_dispatch SET state = 'asking', request_id = NULL WHERE ask_id = ?").run(ask.askId)
    }
    // The queue opens each request it is given, but the row's record of it then fails.
    const opened: string[] = []
    const request = ctx.approvals.request.bind(ctx.approvals)
    ctx.approvals.request = async (...args) => {
      const created = await request(...args)
      opened.push(created.requestId)
      if (opened.length === 1) ctx.store.db.exec("CREATE TRIGGER t205_fail_ask BEFORE UPDATE ON workflow_dispatch WHEN NEW.state = 'asked' BEGIN SELECT RAISE(ABORT, 'the store failed'); END")
      return created
    }
    await ctx.workflow.sweepDispatch()
    // One request opened: it spent the pass's one, though its row still says asking.
    expect(opened).toHaveLength(1)
    expect(rowsOf(ctx, first.taskId).concat(rowsOf(ctx, second.taskId)).map((r) => r.state)).toEqual(['asking', 'asking'])
    // The store recovers: the next pass adopts that request (asking once, INV-4) and spends nothing on it, so it opens the other's.
    ctx.store.db.exec('DROP TRIGGER t205_fail_ask')
    await ctx.workflow.sweepDispatch()
    expect(opened).toHaveLength(2)
    expect((await dispatchRequests(ctx)).filter((r) => r.state === 'open').map((r) => r.requestId).sort()).toEqual([...opened].sort())
    expect([askOf(ctx.workflow.dispatchStatus(), first.taskId)!.state, askOf(ctx.workflow.dispatchStatus(), second.taskId)!.state]).toEqual(['asked', 'asked'])
  })
})

/** An advisor that records what it was given and answers with `answer`. */
class FakeAdvisor implements Advisor {
  readonly id = 'fake'
  readonly seen: AdvisorFeatures[] = []
  constructor(private readonly answer: (features: AdvisorFeatures, signal: AdvisorSignal) => Promise<Advice>) {}
  advise(features: AdvisorFeatures, signal: AdvisorSignal): Promise<Advice> {
    this.seen.push(features)
    return this.answer(features, signal)
  }
}
/** Advice that prefers every candidate but the chosen one (A): if shadow could change the choice, it would. */
const contrary = new FakeAdvisor(async (f) => ({
  status: 'advice', provider: 'fake', modelVersion: 'fake@1',
  candidates: f.candidates.map((c) => ({ alias: c.alias, accepted: c.alias === 'A' ? 0.01 : 0.99, limit: c.alias === 'A' ? 0.99 : 0.01, needsOperator: 0.5 })),
}))
type Answered = Decision & { modelAnswers?: Array<{ provider: string; modelVersion: string; questionSetVersion?: string; questionId: string; type: string; probability?: number }>; deterministic: boolean }
/** The advice decision a choice names as its input (rule or model `advisor.dispatch`). */
const adviceOf = (ctx: Context, choice: Decision): Answered => {
  const ids = choice.inputs.filter((id) => (ctx.artifacts.get(id as `sha256:${string}`)?.body as Decision | undefined)?.decider?.id === 'advisor.dispatch')
  expect(ids, 'the choice names exactly one advice decision as its input (INV-13)').toHaveLength(1)
  return decisionOf(ctx, ids[0]) as Answered
}

/** The dispatch the advisor seam's suite runs in: two free Workers on two accounts, acc-a's chosen (more headroom, the sooner reset). */
const advisorHarness = async (): Promise<DispatchHarness> => {
  const { ctx, workers, read } = await boot({ accounts: ['acc-a', 'acc-b'] })
  workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
  await read('acc-a', 10, 40)
  await read('acc-b', 30, 200)
  return { ctx, chosen: 'agent:acc-a/develop', hidden: ['acc-a', 'acc-b', 'agent:', 'p1'], ready: (title, goal) => ready(ctx, title, { goal }) }
}
/** `n` labelled attempts for the local adapter: accepted with headroom, limited without. */
const labelled = (n: number): Labelled[] => Array.from({ length: n }, (_, i) => {
  const high = i % 2 === 0
  const candidate = { ...FEATURES.candidates[0]!, free: high, windows: [{ known: true, seconds: 18_000, used: high ? 10 : 75, headroom: high ? 70 : 5, resetsInMinutes: 120 }] }
  return { candidate, reservePercent: 20, labels: { accepted: high ? 1 : 0, limit: high ? 0 : 1, 'needs-operator': 0 } }
})
/** The model adapter over a scripted model Worker, which answers every alias its prompt's features name, under its model's version. */
const scriptedModel = (): Advisor => {
  let text = ''
  const source = {
    start: (request: { prompt: string }) => {
      const features = JSON.parse(request.prompt.split('\n').at(-1)!) as AdvisorFeatures
      text = JSON.stringify({ candidates: features.candidates.map((c, i) => ({ alias: c.alias, accepted: 0.8 - 0.1 * i, limit: 0.1, needsOperator: 0.05 })) })
      return { id: 'exec-1', status: 'running' }
    },
    wait: async (id: string) => ({ id, status: 'completed', result: 'artifact-1' }),
    cancel: () => undefined,
  }
  const workers = { route: async () => ({ source: 'models', worker: { worker: 'model:advice' }, decisions: [], release: () => undefined }), source: () => source }
  const engine = { ctx: { workers, egress: { defaultClassification: 'internal' }, artifacts: { get: () => ({ body: { model: 'scripted-model-001', text } }) } } } as unknown as Engine
  return new ModelAdvisor(engine, 'model:advice', 256)
}

// The seam's conformance suite, run by every advisor System has, and by a fake (plugin rule 7).
for (const [name, advisor] of [
  ['a fake whose advice is contrary to the choice', () => contrary],
  ['local, fitted on 40 labelled attempts', () => new LocalAdvisor(() => labelled(40), 30, 1)],
  ['local, with too few labelled attempts', () => new LocalAdvisor(() => labelled(5), 30, 1)],
  ['model, over a scripted model Worker', scriptedModel],
] as Array<[string, () => Advisor]>) runSuite(advisorSuite, { name, contract: '1.0', boot: { advisor, dispatch: advisorHarness } })

describe('the dispatch advisor in shadow (PROP-0015 J1)', () => {
  it('records the full distribution of an advice as the choice\'s input, and, with no advisor, the features as unavailable (INV-13)', async () => {
    const run = async (advisor: Advisor | undefined) => {
      const { ctx, workers, read } = await boot({ accounts: ['acc-a', 'acc-b'] })
      ctx.workflow.setDispatchAdvisor(advisor)
      workers.extra = [agent('agent:acc-a/develop', 'acc-a'), agent('agent:acc-b/develop', 'acc-b')]
      await read('acc-a', 0, 40)
      await read('acc-b', 0, 200)
      const task = await ready(ctx, 'same either way')
      await ctx.workflow.sweepDispatch()
      const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
      return { ctx, choice: decisionOf(ctx, ask.decisions[1]) }
    }
    const without = await run(undefined)
    const advised = await run(contrary)
    // Without an advisor the features are still recorded, as unavailable (the local adapter learns from them).
    expect(adviceOf(without.ctx, without.choice)).toMatchObject({ decisionType: 'route', decider: { type: 'rule', id: 'advisor.dispatch' }, outcome: { option: 'unavailable', detail: { status: 'unavailable', reason: 'no advisor: dispatch.advisor.provider is none' } }, deterministic: true })
    const advice = adviceOf(advised.ctx, advised.choice)
    expect(advice).toMatchObject({ decisionType: 'route', decider: { type: 'model', id: 'advisor.dispatch', version: 'fake@1' }, outcome: { option: 'advice', detail: { shadow: true, chosen: 'A', aliases: { A: 'agent:acc-a/develop' } } }, deterministic: false })
    // Every other admitted candidate, in the score's order, under the next alias (never sent: kept on the decision).
    expect(Object.values(advice.outcome.detail!['aliases'] as Record<string, string>)).toContain('agent:acc-b/develop')
    const n = (advice.outcome.detail!['features'] as AdvisorFeatures).candidates.length
    expect(advice.modelAnswers).toHaveLength(3 * n)
    expect(advice.modelAnswers!.find((m) => m.questionId === 'accepted:B')).toEqual({ provider: 'fake', modelVersion: 'fake@1', questionSetVersion: 'dispatch-advice@1', questionId: 'accepted:B', type: 'yes-no', probability: 0.99 })
    expect(advised.ctx.eventLog.query({ type: 'workflow.dispatch.advised', limit: 10 }).map((e) => e.data?.['status'])).toEqual(['advice'])
  })

  it('records an advisor\'s failure, timeout, malformed answer, or faulty stop listener as unavailable, with why, and asks on the Worker it would have anyway; nothing escapes as an uncaught exception', async () => {
    const uncaught: unknown[] = []
    const record = (error: unknown): void => void uncaught.push(error)
    process.on('uncaughtException', record)
    process.on('unhandledRejection', record)
    onTestFinished(() => {
      process.off('uncaughtException', record)
      process.off('unhandledRejection', record)
    })
    const cases: Array<[string, Advisor, RegExp]> = [
      ['throws', new FakeAdvisor(async () => {
        throw new Error('the provider is down')
      }), /^error: the provider is down/],
      ['hangs', new FakeAdvisor((_f, signal) => new Promise((_resolve, reject) => signal.onAbort(() => reject(new Error('aborted'))))), /^timeout: no answer within 100 ms \(dispatch\.advisor\.timeoutMs\)$/],
      ['hangs, its stop listener throwing', new FakeAdvisor((_f, signal) => new Promise(() => signal.onAbort(() => {
        throw new Error('a stop listener that throws')
      }))), /^timeout: no answer within 100 ms \(dispatch\.advisor\.timeoutMs\); its stop listener failed, ignored: a stop listener that throws$/],
      ['hangs, its stop listener rejecting', new FakeAdvisor((_f, signal) => new Promise(() => signal.onAbort(async () => {
        throw new Error('a stop listener that rejects')
      }))), /^timeout: no answer within 100 ms/],
      ['skips a candidate', new FakeAdvisor(async () => ({ status: 'advice', provider: 'fake', modelVersion: 'fake@1', candidates: [] })), /^malformed answer: it answers no candidate, not exactly A/],
      ['answers out of range', new FakeAdvisor(async (f) => ({ status: 'advice', provider: 'fake', modelVersion: 'fake@1', candidates: f.candidates.map((c) => ({ alias: c.alias, accepted: 2, limit: 0, needsOperator: 0 })) })), /^malformed answer: candidate A/],
      ['is unpinned', new FakeAdvisor(async (f) => ({ status: 'advice', provider: 'fake', modelVersion: '', candidates: f.candidates.map((c) => ({ alias: c.alias, accepted: 0.5, limit: 0.5, needsOperator: 0.5 })) })), /^malformed answer: no model version/],
      ['names a numeric provider', new FakeAdvisor(async (f) => ({ status: 'advice', provider: 123 as never, modelVersion: 'fake@1', candidates: f.candidates.map((c) => ({ alias: c.alias, accepted: 0.5, limit: 0.5, needsOperator: 0.5 })) })), /^malformed answer: the provider must be a non-empty string, not number/],
      ['names an object provider when unavailable', new FakeAdvisor(async () => ({ status: 'unavailable', provider: {} as never, reason: 'x' })), /^malformed answer: the provider must be a non-empty string, not object/],
      ['answers a getter that throws', new FakeAdvisor(async () => Object.defineProperty({}, 'status', { get: () => { throw new Error('a hostile answer') } }) as never), /^malformed answer: a hostile answer/],
      ['mutates the features', new FakeAdvisor(async (f) => {
        f.candidates.length = 0
        return { status: 'unavailable', provider: 'fake', reason: 'never reached' }
      }), /^error: /],
    ]
    for (const [name, advisor, why] of cases) {
      const { ctx, workers, read } = await boot({ workflow: { dispatch: { advisor: { timeoutMs: 100 } } } })
      ctx.workflow.setDispatchAdvisor(advisor)
      workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
      await read('acc-a', 0)
      const task = await ready(ctx, `advisor ${name}`)
      const pass = await ctx.workflow.sweepDispatch()
      expect(pass.took.map((t) => [t.taskId, t.worker, t.how]), name).toEqual([[task.taskId, 'agent:acc-a/develop', 'asked']])
      const ask = askOf(ctx.workflow.dispatchStatus(), task.taskId)!
      expect(ask.state, name).toBe('asked')
      const advice = adviceOf(ctx, decisionOf(ctx, ask.decisions[1]))
      expect(advice.outcome.option, name).toBe('unavailable')
      expect(String(advice.outcome.detail!['reason']), name).toMatch(why)
      expect(advice.candidates.find((c) => c.selected)!.reasons[1]).toBe('the choice stands as dispatch.choice made it')
    }
    // Later turns of the event loop, where an EventTarget would have rethrown a listener's error.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(uncaught).toEqual([])
  })

  it('is off unless configured: by default, or with a model named but provider not model, the model adapter is never called, and each choice records that no advisor was asked', async () => {
    const advise = vi.spyOn(ModelAdvisor.prototype, 'advise').mockImplementation(async () => ({ status: 'unavailable', provider: 'model-worker', reason: 'the spy answered' }))
    onTestFinished(() => advise.mockRestore())
    const choose = async (dispatch: DispatchConfig): Promise<Answered> => {
      const { ctx, workers, read } = await boot({ workflow: { dispatch } })
      workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
      await read('acc-a', 0)
      const task = await ready(ctx, 'advisor off')
      await ctx.workflow.sweepDispatch()
      return adviceOf(ctx, decisionOf(ctx, askOf(ctx.workflow.dispatchStatus(), task.taskId)!.decisions[1]))
    }
    expect(dispatchSettings({}).advisor.provider).toBe('none')
    for (const dispatch of [{}, { advisor: { model: { worker: 'model:advice' } } }]) {
      expect((await choose(dispatch)).outcome.detail).toMatchObject({ status: 'unavailable', provider: 'none', reason: 'no advisor: dispatch.advisor.provider is none' })
    }
    expect((await choose({ advisor: { provider: 'local', model: { worker: 'model:advice' } } })).outcome.detail).toMatchObject({ status: 'unavailable', provider: 'local-logistic' })
    expect(advise).not.toHaveBeenCalled()
    // Configured, it is called, once per choice: the spy would have seen any call above.
    expect((await choose({ advisor: { provider: 'model', model: { worker: 'model:advice' } } })).outcome.detail).toMatchObject({ status: 'unavailable', provider: 'model-worker', reason: 'the spy answered' })
    expect(advise).toHaveBeenCalledTimes(1)
  })

  it('configured local, says insufficient data until enough labelled attempts exist; and records each dispatched attempt\'s outcome', async () => {
    const { ctx, workers, read } = await boot({ workflow: { dispatch: { advisor: { provider: 'local' } } } })
    workers.extra = [agent('agent:acc-a/develop', 'acc-a')]
    await read('acc-a', 0)
    const proposed = await ctx.board.propose({ projectId: 'p1', title: 'outcome', goal: 'do it', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'command', template: 'dev' })
    await ctx.board.sweep(new Date())
    await approve(ctx, (await ctx.board.task(proposed.taskId))!.waiting!.approvalRequest!)
    await ctx.board.sweep(new Date())
    workers.reply = () => ({ text: 'done' })
    const pass = await ctx.workflow.sweepDispatch()
    expect(pass.took.map((t) => t.how)).toEqual(['started'])
    const ask = ctx.eventLog.query({ type: 'workflow.dispatch.chosen', limit: 10 })[0]!
    const choice = decisionOf(ctx, ask.decision)
    const advice = adviceOf(ctx, choice)
    expect(advice.outcome).toMatchObject({ option: 'unavailable', detail: { provider: 'local-logistic' } })
    expect(String(advice.outcome.detail!['reason'])).toBe('insufficient data: 0 of the 30 labelled dispatched attempts it needs (dispatch.advisor.minLabelled)')
    // The run reports its task: the attempt's labels are recorded once, naming the advice of its choice.
    await vi.waitFor(() => expect(ctx.eventLog.query({ type: OUTCOME_EVENT, limit: 10 })).toHaveLength(1), { timeout: 60_000 })
    const [outcome] = ctx.eventLog.query({ type: OUTCOME_EVENT, limit: 10 })
    // The advice decision its choice names among its inputs (a decision's inputs are kept in no particular order).
    const named = choice.inputs.filter((id) => (ctx.artifacts.get(id as `sha256:${string}`)?.body as Decision | undefined)?.decider?.id === 'advisor.dispatch')
    expect(outcome!.data).toMatchObject({ taskId: proposed.taskId, attempt: 0, worker: 'agent:acc-a/develop', countsKey: 'acc-a', advice: named[0], alias: 'A', labels: { limit: 0 } })
    const labels = outcome!.data!['labels'] as Record<string, number>
    for (const q of ['accepted', 'limit', 'needs-operator']) expect([0, 1]).toContain(labels[q])
  })
})
