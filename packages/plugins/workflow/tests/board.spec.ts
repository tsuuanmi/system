import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard, { type Config as BoardConfig } from '@tsuuanmi/system-board'
import { type ArtifactRef, type BoardTask, type BudgetLine, fundingVersion, type Subject, type TaskInput } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject, contentId, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import StoreResources from '@tsuuanmi/system-resources'
import type { UsageRecord } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { WorkerExecution } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow, { type Config, type RunView, WorkflowFailure } from '../src/index.ts'

// End to end over the store-backed board and approval queue and the engine, on one durable store;
// only Worker execution is scripted. A loaded host needs time.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

/** `read` runs on auto; `workspace-write` on auto once tests and lint pass; everything else asks. */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/**
 * Scripted Workers that answer as an agent in a git working tree: each result is an
 * `agent-result@1.1` naming the workspace and the subject the tree is at when the engine reads it
 * (or `stale`, a version the tree never had).
 */
class AgentWorkers extends ScriptedWorkers {
  stale = false
  private readonly results = new Map<string, ArtifactRef>()
  constructor(private readonly workspace: string, private readonly artifacts: () => Context['artifacts']) {
    super()
  }

  override get(id: string): WorkerExecution | undefined {
    const execution = super.get(id)
    if (!execution?.result) return execution
    if (!this.results.has(id)) {
      const text = (this.artifacts().get(execution.result)?.body as { text: string }).text
      const { subject } = captureGitSubject(this.workspace)!
      this.results.set(id, this.artifacts().put({
        kind: 'report', bodySchema: 'agent-result@1.1', classification: 'public', producer: { type: 'worker', ref: 'w:standard' },
        body: { schema: 'agent-result@1.1', worker: 'w:standard', runtime: 'scripted', runId: 'agent-run', promptHash: sha256(text), sandbox: 'workspace-write', text, workspace: this.workspace, subject: this.stale ? { ...subject, version: 'stale' } : subject },
      }).id as ArtifactRef)
    }
    return { ...execution, result: this.results.get(id)! }
  }
}

/** A git working tree with a commit and a change on top. */
function workingTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-tree-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'kernel.c'), 'int main(void) { return 0; }\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'kernel.c'), 'int main(void) { return 1; }\n')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The store-backed board under a short lease cap (as `leases.maxTtlMs` would set it, without the engine's own run lease), counting renewals. */
class ShortLeaseBoard extends StoreBoard {
  static readonly CAP_MS = 3000
  renewals = 0
  override async claim(taskId: string, owner: string, ttlMs: number, at?: Date) {
    return super.claim(taskId, owner, Math.min(ttlMs, ShortLeaseBoard.CAP_MS), at)
  }

  override async renew(taskId: string, generation: number, ttlMs: number, at?: Date) {
    this.renewals++
    return super.renew(taskId, generation, Math.min(ttlMs, ShortLeaseBoard.CAP_MS), at)
  }
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface Booted {
  ctx: Context
  workers: ScriptedWorkers
  /** Stop the engine alone, run `between` while it is down (the board, the queue, and the store stay), then start it again. */
  restartWorkflow: (between?: () => void | Promise<void>) => Promise<void>
  /** Stop the board alone (a host that died), then start it again over the same store, as a restart does. */
  restartBoard: () => Promise<void>
}

/** The store-backed ledger's one pool, as the ledger fake configures it. */
const POOLS = [{ pool: 'max.programmatic', account: 'max', kind: 'programmatic' as const, windows: [{ id: 'monthly', kind: 'credit' as const }] }]

async function boot(options: { workflow?: Config; board?: boolean | 'short'; boardConfig?: BoardConfig; workspace?: string; resources?: boolean | 'store' } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-board-'))
  const ctx = new Context()
  const workers = options.workspace ? new AgentWorkers(options.workspace, () => ctx.artifacts) : new ScriptedWorkers()
  const config: Config = { ...CONFIG, ...options.workflow, templates: { ...TEMPLATES, ...options.workflow?.templates } }
  const boardPlugin = options.board === 'short' ? ShortLeaseBoard : StoreBoard
  const boardConfig: BoardConfig = { ...options.boardConfig, sweepSeconds: 0 }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ...(options.board === false ? [] : [ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 })]),
  ]
  const boardAt = fibers.length
  if (options.board !== false) fibers.push(ctx.plugin(boardPlugin, boardConfig))
  if (options.resources === 'store') fibers.push(ctx.plugin(StoreResources, { pools: POOLS }))
  else if (options.resources) fibers.push(ctx.plugin(FakeResources))
  await Promise.all(fibers)
  let engine = ctx.plugin(Workflow, config)
  await engine
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return {
    ctx, workers,
    restartWorkflow: async (between) => {
      await engine.dispose()
      await between?.()
      engine = ctx.plugin(Workflow, config)
      await engine
    },
    restartBoard: async () => {
      await fibers[boardAt]!.dispose()
      fibers[boardAt] = ctx.plugin(boardPlugin, boardConfig)
      await fibers[boardAt]
    },
  }
}

const project = (ctx: Context): Promise<void> => activeProject(ctx)
/** The fake ledger's `max.programmatic` pool reads ok, so a budget on it can be reserved (a window with no reading is unknown, INV-2). */
const poolOpen = async (ctx: Context, observedAt = new Date()): Promise<void> => {
  await ctx.resources.observe({ schema: 'limit-state@1.0', pool: 'max.programmatic', account: 'max', window: { id: 'monthly', kind: 'credit' }, state: 'ok', source: 'runtime-result', observedAt: observedAt.toISOString() })
}
const ready = (ctx: Context, title: string, extra: Partial<TaskInput> = {}): Promise<BoardTask> => readyTask(ctx, title, extra)
/** Usage the ledger counts for a task, as earlier work recorded it on `max.programmatic`: one run of one turn. */
const drew = (ctx: Context, taskId: string, requestId: string, extra: Partial<UsageRecord> = {}): Promise<unknown> => ctx.resources.record({
  schema: 'usage-record@1.0', requestId, source: 'runtime-result', observedAt: new Date().toISOString(), account: 'max', pool: 'max.programmatic', taskId, turns: 1, ...extra,
})

const settled = async (ctx: Context, runId: string): Promise<RunView> => {
  const view = await ctx.workflow.wait(runId, 60_000)
  expect(view.status, `run ${runId} finished`).not.toBe('running')
  return view
}

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The run's outcome reached its task. */
const reported = async (ctx: Context, runId: string): Promise<RunView> => {
  await until(() => ctx.workflow.get(runId)?.task?.phase === 'reported', `run ${runId}'s report`)
  return ctx.workflow.get(runId)!
}

type Decision = { decisionType: string; inputs: string[]; decider: { id: string }; outcome: { option: string; detail?: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const decisionOf = (ctx: Context, ref: string | undefined): Decision => {
  expect(ref, 'a decision').toBeDefined()
  const envelope = ctx.artifacts.get(ref as ArtifactRef)
  expect(envelope?.kind).toBe('decision')
  schemas.assertRecord(envelope!.body as { schema: string })
  return envelope!.body as Decision
}
const decisionsOf = (ctx: Context, type: string, deciderId: string): Decision[] =>
  ctx.artifacts.list({ kind: 'decision', decisionType: type, limit: 1000 }).map((a) => a.body as Decision).filter((d) => d.decider.id === deciderId)

const refusalOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call()
    return 'admitted'
  } catch (error) {
    return error instanceof WorkflowFailure ? `${error.kind}: ${error.message}` : `untyped: ${String(error)}`
  }
}

describe('ctx.workflow serves board tasks over the store-backed board and approval queue', () => {
  it('takes a ready task, records the run on the board before any step runs, then submits and accepts its result: done', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'answer')
    // When the first step starts, the board already records this run (run first, then work).
    const seen: Array<BoardTask['state'] | undefined> = []
    workers.reply = () => 'hold'
    const run = await ctx.workflow.start({ template: 'solo', input: 'the question', classification: 'public', task: { taskId: task.taskId } })
    expect(run.task).toMatchObject({ taskId: task.taskId, claim: 'own', phase: 'started', generation: 1 })
    await until(() => workers.started.length === 1, 'the step started')
    const running = (await ctx.board.task(task.taskId))!
    seen.push(running.state)
    expect(running).toMatchObject({ state: 'running', run: { runId: run.runId }, holder: { owner: `workflow:${run.runId}`, generation: 1 }, attempts: { count: 1 } })
    expect(workers.started[0]!.runId).toBe(run.runId)
    workers.release(workers.started[0]!.id, { text: 'the answer' })

    const done = await settled(ctx, run.runId)
    expect(done).toMatchObject({ status: 'completed', answer: 'the answer' })
    const view = await reported(ctx, run.runId)
    expect(view.task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    const board = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(board)
    expect(seen).toEqual(['running'])
    expect(board).toMatchObject({ state: 'done', result: { artifacts: [done.result], subject: { type: 'artifact', ref: done.result } } })
    // The acceptance binds to the exact result: the task, its subject, and every artifact among its inputs.
    const acceptance = decisionOf(ctx, board.result!.acceptance)
    expect(acceptance).toMatchObject({ decisionType: 'acceptance', outcome: { option: 'accept', detail: { taskId: task.taskId, runId: run.runId, subject: { type: 'artifact', ref: done.result }, checks: {} } } })
    expect(acceptance.inputs).toEqual([done.result])
    expect(board.lastDecision).toBe(board.result!.acceptance)
    // The engine's choice to claim it is a decision, with a reason for every candidate (INV-13).
    const [taken] = decisionsOf(ctx, 'admission', 'workflow.task-admission')
    expect(taken).toMatchObject({ outcome: { option: 'claim', detail: { taskId: task.taskId } } })
    expect(taken!.candidates.every((c) => c.reasons.length > 0)).toBe(true)
    const events = ctx.eventLog.query({ runId: run.runId, limit: 100 }).map((e) => e.type)
    expect(events).toEqual(expect.arrayContaining(['workflow.run.started', 'workflow.run.completed', 'workflow.task.reported']))
  })

  it('adopts a lead\'s live claim, and refuses a stale claim or a task not ready before any step runs', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'lead')
    const claim = await ctx.board.claim(task.taskId, 'lead-session', 120_000)
    // A stale claim (an older generation, or another holder) and a task not ready start nothing.
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'x', task: { taskId: task.taskId, holder: 'lead-session', generation: claim.generation + 1 } }))).toMatch(/^invalid_input: a stale claim/)
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'x', task: { taskId: task.taskId, holder: 'someone-else', generation: claim.generation } }))).toMatch(/^invalid_input: a stale claim/)
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'x', task: { taskId: task.taskId } }))).toMatch(/^invalid_input: task \S+ is claimed, not ready/)
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'x', task: { taskId: task.taskId, holder: 'lead-session' } }))).toMatch(/both or neither/)
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'x', task: { taskId: 'task-unknown' } }))).toMatch(/unknown board task/)
    expect(workers.started).toHaveLength(0)
    expect(ctx.workflow.usage()).toHaveLength(0)
    expect((await ctx.board.task(task.taskId))).toMatchObject({ state: 'claimed', holder: { owner: 'lead-session', generation: claim.generation }, attempts: { count: 0 } })
    const refused = decisionsOf(ctx, 'admission', 'workflow.task-admission').filter((d) => d.outcome.option === 'refuse')
    expect(refused).toHaveLength(3)

    const run = await ctx.workflow.start({ template: 'solo', input: 'adopted', classification: 'public', task: { taskId: task.taskId, holder: 'lead-session', generation: claim.generation } })
    expect(run.task).toMatchObject({ claim: 'adopted', generation: claim.generation })
    expect(await settled(ctx, run.runId)).toMatchObject({ status: 'completed' })
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', run: { runId: run.runId } })
    expect(decisionsOf(ctx, 'admission', 'workflow.task-admission').some((d) => d.outcome.option === 'adopt' && d.outcome.detail?.['holder'] === 'lead-session')).toBe(true)
    // An attempt is served by one run: a second run for a task done is refused.
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'again', task: { taskId: task.taskId } }))).toMatch(/is done, not ready/)
  })

  it('serves one attempt with one run: concurrent starts on one claim admit one run, and a repeated clientRequestId returns it (INV-15, INV-4)', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'raced')
    const claim = await ctx.board.claim(task.taskId, 'lead', 120_000)
    const input = { template: 'solo', input: 'q', classification: 'public' as const, task: { taskId: task.taskId, holder: 'lead', generation: claim.generation } }
    const outcomes = await Promise.allSettled([ctx.workflow.start(input), ctx.workflow.start(input)])
    const admitted = outcomes.filter((o): o is PromiseFulfilledResult<RunView> => o.status === 'fulfilled')
    expect(admitted).toHaveLength(1)
    const refused = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected')!.reason as WorkflowFailure
    expect(refused).toBeInstanceOf(WorkflowFailure)
    expect(refused.kind).toBe('invalid_input')
    const run = admitted[0]!.value
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    expect(workers.started).toHaveLength(1)
    expect(ctx.workflow.usage()).toHaveLength(1)

    const next = await ready(ctx, 'keyed')
    const keyed = { template: 'solo', input: 'k', classification: 'public' as const, clientRequestId: 'k-1', task: { taskId: next.taskId } }
    const first = await ctx.workflow.start(keyed)
    expect((await ctx.workflow.start(keyed)).runId).toBe(first.runId)
    expect(await refusalOf(() => ctx.workflow.start({ ...keyed, task: { taskId: task.taskId } }))).toMatch(/clientRequestId was reused/)
    expect(decisionsOf(ctx, 'admission', 'workflow.task-admission').filter((d) => d.outcome.detail?.['taskId'] === next.taskId)).toHaveLength(1)
  })

  it('renews the task\'s lease while the run lives, at a third of what the board granted, so a long step never loses it', async () => {
    const { ctx, workers } = await boot({ board: 'short' })
    await project(ctx)
    const task = await ready(ctx, 'long')
    const board = ctx.board as ShortLeaseBoard
    workers.reply = () => 'hold'
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    await until(() => workers.started.length === 1, 'the step started')
    // Past two of the board's lease lengths, the run still holds the task: it renewed in time.
    await new Promise((resolve) => setTimeout(resolve, 2 * ShortLeaseBoard.CAP_MS + 500))
    expect(board.renewals).toBeGreaterThanOrEqual(2)
    await ctx.board.sweep(new Date())
    const running = (await ctx.board.task(task.taskId))!
    expect(running).toMatchObject({ state: 'running', run: { runId: run.runId } })
    expect(Date.parse(running.holder!.leaseExpiresAt)).toBeGreaterThan(Date.now())
    workers.release(workers.started[0]!.id, { text: 'long answer' })
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    // Nothing renews a finished run's lease.
    const renewed = board.renewals
    await new Promise((resolve) => setTimeout(resolve, ShortLeaseBoard.CAP_MS))
    expect(board.renewals).toBe(renewed)
  })

  it('reports a failed run through reconcileRun: the attempt counts, and the board readies the next one through the gate', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'fails')
    workers.reply = () => ({ fail: 'internal', disposition: 'CODE_FIX', sent: true })
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect(await settled(ctx, run.runId)).toMatchObject({ status: 'failed' })
    const view = await reported(ctx, run.runId)
    expect(view.task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
    expect(decisionOf(ctx, view.task!.outcome!.decision)).toMatchObject({ decisionType: 'reconciliation', outcome: { option: 'report', detail: { status: 'failed' } } })
    const next = (await ctx.board.task(task.taskId))!
    expect(next).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    expect(next.run).toBeUndefined()
    // The run was that attempt: the operator's continue does not run it again; a new run serves the next attempt.
    expect(() => ctx.workflow.continue(run.runId)).toThrow(/served an attempt of board task/)
    workers.reply = () => ({ text: 'second time' })
    const second = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect(await settled(ctx, second.runId)).toMatchObject({ status: 'completed', answer: 'second time' })
    expect((await reported(ctx, second.runId)).task?.outcome).toMatchObject({ status: 'accepted' })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 2 } })
  })

  it('stops a task\'s run on the operator\'s stop and reports it failed', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'stopped')
    workers.reply = () => 'hold'
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    await until(() => workers.started.length === 1, 'the step started')
    await ctx.workflow.stop(run.runId, 'not needed')
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
    expect(workers.cancelled).toEqual([workers.started[0]!.id])
  })

  it('after a restart, reconciles a run whose holder was lost and reports it with reconcileRun, starting nothing new', async () => {
    const { ctx, workers, restartWorkflow } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'restart')
    workers.reply = () => 'hold'
    const run = await ctx.workflow.start({ template: 'chain', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    await until(() => workers.started.length === 1, 'step a started')
    await restartWorkflow(async () => {
      // The host was down past the lease: the board's sweep finds the holder lost mid-run and asks the operator.
      ctx.store.db.prepare('UPDATE leases SET expires_at = 1 WHERE resource = ?').run(`board-task:${task.taskId}`)
      await ctx.board.sweep(new Date())
      expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'reconciliation-failed' } })
      // Step a's execution finished while the engine was down.
      workers.release(workers.started[0]!.id, { text: 'alpha' })
    })
    const view = await reported(ctx, run.runId)
    // Reconciled, never replayed: step a's result is taken, and step b never starts without the holder.
    expect(workers.started).toHaveLength(1)
    expect(view).toMatchObject({ status: 'failed', error: { kind: 'holder_lost' } })
    expect(view.nodes.map((n) => n.state)).toEqual(['COMPLETED', 'FAILED'])
    expect(view.task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
    expect(decisionOf(ctx, view.task!.lost)).toMatchObject({ decisionType: 'recovery', outcome: { option: 'wind-down' } })
    const after = (await ctx.board.task(task.taskId))!
    expect(after).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    // The pending reconciliation request was withdrawn once the move committed.
    expect((await ctx.approvals.list({ states: ['open', 'batched'] })).length).toBe(0)
  })

  it('after a restart, reports a run whose holder was lost but whose work had finished as completed: reconcileRun accepts it', async () => {
    const { ctx, workers, restartWorkflow } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'finished-while-down')
    workers.reply = () => 'hold'
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    await until(() => workers.started.length === 1, 'the step started')
    await restartWorkflow(async () => {
      ctx.store.db.prepare('UPDATE leases SET expires_at = 1 WHERE resource = ?').run(`board-task:${task.taskId}`)
      await ctx.board.sweep(new Date())
      workers.release(workers.started[0]!.id, { text: 'done while down' })
    })
    const view = await reported(ctx, run.runId)
    expect(view).toMatchObject({ status: 'completed', answer: 'done while down' })
    expect(view.task?.outcome).toMatchObject({ status: 'reconciled', state: 'done' })
    expect(workers.started).toHaveLength(1)
    const done = (await ctx.board.task(task.taskId))!
    expect(done).toMatchObject({ state: 'done', run: { runId: run.runId }, result: { artifacts: [view.result] } })
    expect(decisionOf(ctx, done.result!.acceptance).outcome.option).toBe('accept')
    expect((await ctx.approvals.list({ states: ['open', 'batched'] })).length).toBe(0)
  })

  it('leaves a task in review when its run reports none of the checks its class requires: the review is the operator\'s', async () => {
    const { ctx } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'writes', { actionClass: 'workspace-write' })
    const run = await ctx.workflow.start({ template: 'solo', input: 'change it', classification: 'public', task: { taskId: task.taskId } })
    expect(await settled(ctx, run.runId)).toMatchObject({ status: 'completed' })
    const view = await reported(ctx, run.runId)
    expect(view.task?.outcome).toMatchObject({ status: 'review', state: 'review' })
    expect(view.task?.outcome?.reason).toMatch(/held for the operator until .*: tests, lint pending/)
    const review = (await ctx.board.task(task.taskId))!
    // Held by the board, not by the run's lease: the policy's wait for the class (an hour here).
    expect(review).toMatchObject({ state: 'review', result: { artifacts: [view.result] }, waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
    expect(review.holder).toBeUndefined()
    expect(Date.parse(review.waiting!.expiresAt) - Date.parse(review.waiting!.since)).toBe(3600_000)
    expect(review.result?.acceptance).toBeUndefined()
  })

  it('binds the result of a task that writes a working tree to the exact subject the run left it at, and accepts it there (INV-5, INV-15)', async () => {
    const tree = workingTree()
    const { ctx } = await boot({ workspace: tree })
    await project(ctx)
    const { subject } = captureGitSubject(tree)!
    const task = await ready(ctx, 'tree', { writes: { type: 'git-head', ref: subject.ref } })
    const run = await ctx.workflow.start({ template: 'solo', input: 'change it', classification: 'public', task: { taskId: task.taskId } })
    const done = await settled(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    const board = (await ctx.board.task(task.taskId))!
    expect(board.result).toMatchObject({ artifacts: [done.result], subject: { type: 'git-head', ref: subject.ref, version: subject.version } })
    expect(decisionOf(ctx, board.result!.acceptance).outcome.detail?.['subject']).toEqual(subject)
  })

  it('fails a run whose result names a version of the written tree it is no longer at, and reports it failed (INV-5)', async () => {
    const tree = workingTree()
    const booted = await boot({ workspace: tree })
    ;(booted.workers as AgentWorkers).stale = true
    const { ctx } = booted
    await project(ctx)
    const { subject } = captureGitSubject(tree)!
    const task = await ready(ctx, 'stale tree', { writes: { type: 'git-head', ref: subject.ref } })
    const run = await ctx.workflow.start({ template: 'solo', input: 'change it', classification: 'public', task: { taskId: task.taskId } })
    expect(await settled(ctx, run.runId)).toMatchObject({ status: 'failed', error: { kind: 'stale_subject', message: expect.stringMatching(/is no longer git-head/) } })
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
  })

  it('fails a run whose result is not on the subject its task writes, and reports it failed (INV-5)', async () => {
    const { ctx } = await boot()
    await project(ctx)
    const writes: Subject = { type: 'git-head', ref: 'abc123' }
    const task = await ready(ctx, 'writer', { writes })
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    const view = await settled(ctx, run.runId)
    expect(view).toMatchObject({ status: 'failed', error: { kind: 'stale_subject' } })
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
    expect(decisionsOf(ctx, 'gate', 'workflow.task-subject')).toHaveLength(1)
  })

  it('briefs a task from the board: the accepted results of the task it depends on by content id, its budget less the usage the ledger counts for it, its criteria first (PROP-0010)', async () => {
    const { ctx, workers } = await boot({ resources: true })
    await project(ctx)
    await poolOpen(ctx)
    const first = await ready(ctx, 'first')
    workers.reply = () => ({ text: 'the first result' })
    const one = await ctx.workflow.start({ template: 'solo', input: 'q1', classification: 'public', task: { taskId: first.taskId } })
    expect((await reported(ctx, one.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    const budget = [{ pool: 'max.programmatic', unit: 'usd' as const, amount: 5 }, { pool: 'max.programmatic', unit: 'runs' as const, amount: 3 }]
    const second = await ctx.board.propose({ projectId: 'p1', title: 'second', goal: 'build on the first', acceptance: [{ id: 'a1', statement: 'it builds' }], actionClass: 'read', dependsOn: [first.taskId], budget })
    await ctx.board.sweep(new Date())
    await ctx.resources.record({
      schema: 'usage-record@1.0', requestId: 'r-1', source: 'runtime-result', observedAt: new Date().toISOString(), account: 'max', pool: 'max.programmatic', taskId: second.taskId,
      turns: 2, cost: { amount: 1.5, currency: 'USD', basis: 'runtime-estimate' },
    })
    workers.reply = () => ({ text: 'the second result' })
    const two = await ctx.workflow.start({ template: 'solo', input: 'go on', classification: 'public', task: { taskId: second.taskId } })
    expect((await reported(ctx, two.runId)).task?.outcome).toMatchObject({ status: 'accepted' })
    const started = workers.started.at(-1)!
    const brief = ctx.artifacts.get(started.brief!)!.body as { budget: { remaining: unknown[] }; artifacts: Array<{ ref: string; role: string; note: string }>; taskId: string; attempt: number }
    const firstResult = (await ctx.board.task(first.taskId))!.result!.artifacts[0]!
    expect(brief).toMatchObject({ taskId: second.taskId, attempt: 1, budget: { remaining: [{ pool: 'max.programmatic', unit: 'usd', amount: 3.5 }, { pool: 'max.programmatic', unit: 'runs', amount: 2 }] } })
    expect(brief.artifacts).toEqual([{ ref: firstResult, role: 'input', note: `the accepted result of ${first.taskId}: first` }])
    expect(JSON.stringify(brief)).not.toContain('the first result')
    expect(started.prompt).toBe(`Board task ${second.taskId} of project p1, attempt 1.\nGoal: build on the first\nAcceptance criteria:\n- a1: it builds\nIf you cannot finish without an answer from a person, answer with only this JSON object and nothing else: {"questions": ["..."]}, with 1 to 8 questions of at most 500 characters each. The task then waits for the answers, and its next attempt is given them.\n\ngo on\n\nRead these too:\n\n<artifact id="${firstResult}" role="input" note="the accepted result of ${first.taskId}: first">\nthe first result\n</artifact>`)
  })

  it('counts against a task\'s budget the usage the ledger records under the runs that served it and the executions they started, each record once (PROP-0010)', async () => {
    const { ctx, workers } = await boot({ resources: true })
    await project(ctx)
    await poolOpen(ctx)
    const budget = [
      { pool: 'max.programmatic', unit: 'usd' as const, amount: 5 }, { pool: 'max.programmatic', unit: 'runs' as const, amount: 4 },
      { pool: 'max.programmatic', unit: 'tokens' as const, amount: 1000 },
    ]
    const task = await ready(ctx, 'metered', { budget })
    workers.reply = () => ({ fail: 'invalid_input', disposition: 'NONE', sent: false })
    const one = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect((await reported(ctx, one.runId)).task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
    const record = (requestId: string, extra: Partial<UsageRecord>) => ctx.resources.record({
      schema: 'usage-record@1.0', requestId, source: 'runtime-result', observedAt: new Date().toISOString(), account: 'max', pool: 'max.programmatic', ...extra,
    })
    // The ledger counts by run: an agent Worker names its own execution, another source the workflow run, a reservation the task.
    await record('agent-1', { runId: workers.started[0]!.id, usage: { inputTokens: 300, outputTokens: 100 }, cost: { amount: 1.25, currency: 'USD', basis: 'runtime-estimate' } })
    await record('model-1', { runId: one.runId, turns: 1, cost: { amount: 0.5, currency: 'USD', basis: 'runtime-estimate' } })
    await record('both-1', { runId: one.runId, taskId: task.taskId, turns: 1, cost: { amount: 0.25, currency: 'USD', basis: 'runtime-estimate' } })
    await record('other-1', { runId: 'run_unrelated', turns: 1, cost: { amount: 9, currency: 'USD', basis: 'runtime-estimate' } })
    workers.reply = () => ({ text: 'the second attempt' })
    const two = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect((await reported(ctx, two.runId)).task?.outcome).toMatchObject({ status: 'accepted' })
    const brief = ctx.artifacts.get(workers.started.at(-1)!.brief!)!.body as { attempt: number; budget: { remaining: unknown[] } }
    expect(brief).toMatchObject({ attempt: 2, budget: { remaining: [
      { pool: 'max.programmatic', unit: 'usd', amount: 3 }, { pool: 'max.programmatic', unit: 'runs', amount: 1 }, { pool: 'max.programmatic', unit: 'tokens', amount: 600 },
    ] } })
  })

  it('reserves a task\'s budget lines on the ledger before its run starts work, for the task, and releases the reservation when the run finishes (PROP-0010)', async () => {
    const { ctx, workers } = await boot({ resources: true })
    await project(ctx)
    await poolOpen(ctx)
    const budget = [{ pool: 'max.programmatic', unit: 'usd' as const, amount: 5 }, { pool: 'max.programmatic', unit: 'runs' as const, amount: 3 }]
    const task = await ready(ctx, 'funded', { budget })
    workers.reply = () => 'hold'
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    await until(() => workers.started.length === 1, 'the step started')
    // Held while the run lives: the least of each line, the task's lines as its caps.
    const held = ctx.workflow.get(run.runId)!.task!.budget!
    expect(held).toMatchObject({ state: 'reserved' })
    const reserved = decisionOf(ctx, held.decision)
    expect(reserved).toMatchObject({ decisionType: 'budget', outcome: { option: 'reserved', detail: { runId: run.runId, lines: [{ pool: 'max.programmatic', unit: 'usd', amount: 0.000001 }, { pool: 'max.programmatic', unit: 'runs', amount: 1 }] } } })
    const { reservationId } = JSON.parse((ctx.store.db.prepare('SELECT budget FROM workflow_tasks WHERE run_id = ?').get(run.runId) as { budget: string }).budget) as { reservationId: string }
    workers.release(workers.started[0]!.id, { text: 'within budget' })
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    await until(() => ctx.workflow.get(run.runId)!.task!.budget!.state === 'released', 'the reservation released')
    await expect(ctx.resources.release(reservationId)).rejects.toMatchObject({ failure: 'unknown-reservation' })
    expect(ctx.eventLog.query({ runId: run.runId, type: 'workflow.task.budget', limit: 10 }).map((e) => e.data?.['state'])).toEqual(['reserved'])
    // A record of the run now counts for the task: the run was reserved for it.
    await ctx.resources.record({ schema: 'usage-record@1.0', requestId: 'run-1', source: 'runtime-result', observedAt: new Date().toISOString(), account: 'max', pool: 'max.programmatic', runId: run.runId, turns: 1 })
    expect((await ctx.resources.usage({ taskId: task.taskId })).records).toHaveLength(1)
  })

  it('blocks a task whose budget is spent (budget-spent) before any step of its run runs; the board asks the operator to fund it (PROP-0010, INV-2)', async () => {
    const { ctx, workers } = await boot({ resources: true })
    await project(ctx)
    await poolOpen(ctx)
    const task = await ready(ctx, 'spent', { budget: [{ pool: 'max.programmatic', unit: 'runs', amount: 1 }, { pool: 'max.programmatic', unit: 'usd', amount: 5 }] })
    // One run already counted for the task: its runs line is reached.
    await ctx.resources.record({ schema: 'usage-record@1.0', requestId: 'r-spent', source: 'runtime-result', observedAt: new Date().toISOString(), account: 'max', pool: 'max.programmatic', taskId: task.taskId, turns: 1 })
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    const failed = await settled(ctx, run.runId)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'budget_spent', disposition: 'USER_ACTION' } })
    expect(failed.error!.message).toMatch(/cap 1 runs of max.programmatic would be exceeded/)
    expect(workers.started).toHaveLength(0)
    const view = await reported(ctx, run.runId)
    expect(view.task?.budget).toMatchObject({ state: 'refused', spent: true, blocked: true })
    expect(decisionOf(ctx, view.task!.budget!.decision)).toMatchObject({ decisionType: 'budget', outcome: { option: 'refused' } })
    expect(view.task?.outcome).toMatchObject({ status: 'blocked', state: 'waiting-for-approval' })
    // The board's own path for a spent budget: funding asks the operator (the policy's default here).
    const blocked = (await ctx.board.task(task.taskId))!
    expect(blocked).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'budget-spent' }, run: { runId: run.runId }, attempts: { count: 1 } })
    const request = (await ctx.approvals.get(blocked.waiting!.approvalRequest!))!
    expect(request).toMatchObject({ action: { class: 'funding' }, requester: { component: 'board', taskId: task.taskId } })
    expect(ctx.eventLog.query({ runId: run.runId, type: 'workflow.task.budget', limit: 10 }).map((e) => e.data?.['state'])).toEqual(['refused'])
  })

  it('asks to fund a spent budget by lines computed from the ledger\'s count, which the operator sees and approves in the queue; the board raises exactly those, and the next attempt reserves on the store-backed ledger and runs (PROP-0010, INV-5, INV-13)', async () => {
    const { ctx, workers } = await boot({ resources: 'store' })
    await project(ctx)
    await poolOpen(ctx)
    const budget: BudgetLine[] = [{ pool: 'max.programmatic', unit: 'runs', amount: 2 }, { pool: 'max.programmatic', unit: 'usd', amount: 3 }]
    const task = await ready(ctx, 'spent', { budget })
    // What earlier work drew, as the ledger counts it for the task: both runs, and half a dollar past the usd line.
    await drew(ctx, task.taskId, 'r-1', { cost: { amount: 2, currency: 'USD', basis: 'runtime-estimate' } })
    await drew(ctx, task.taskId, 'r-2', { cost: { amount: 1.5, currency: 'USD', basis: 'runtime-estimate' } })
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect(await settled(ctx, run.runId)).toMatchObject({ status: 'failed', error: { kind: 'budget_spent', message: expect.stringMatching(/asking to raise the budget by \+1 runs of max.programmatic, \+1.5 usd of max.programmatic/) } })
    expect(workers.started).toHaveLength(0)
    // Each spent line: what the task overdrew it by, plus one attempt's share of it (the line over its 3 attempts), at the unit's precision.
    const ask: BudgetLine[] = [{ pool: 'max.programmatic', unit: 'runs', amount: 1 }, { pool: 'max.programmatic', unit: 'usd', amount: 1.5 }]
    expect((await reported(ctx, run.runId)).task).toMatchObject({ budget: { state: 'refused', spent: true, blocked: true, funding: ask }, outcome: { status: 'blocked', state: 'waiting-for-approval' } })
    const blocked = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(blocked)
    expect(blocked).toMatchObject({ schema: 'board-task@1.1', state: 'waiting-for-approval', waiting: { reason: 'budget-spent', funding: ask }, budget, attempts: { count: 1 } })

    // The operator reads the lines in the queue, and the verdict binds to exactly them (INV-5).
    const request = (await ctx.approvals.get(blocked.waiting!.approvalRequest!))!
    expect(request).toMatchObject({ action: { class: 'funding' }, subject: { type: 'content', ref: `board-task:${task.taskId}:attempt:1`, version: fundingVersion(contentId(ask)) } })
    expect(request.action.summary).toBe('budget-spent: spent; raise its budget by +1 runs of max.programmatic, +1.5 usd of max.programmatic')
    expect(request.action.consequences).toMatch(/^Approved: the board adds exactly \+1 runs of max.programmatic, \+1.5 usd of max.programmatic to the task's budget, which becomes 3 runs of max.programmatic, 4.5 usd of max.programmatic, and attempt 2 of 3/)
    const [verdict] = await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }])
    expect(verdict?.refused).toBeUndefined()
    await ctx.board.sweep(new Date())
    const funded = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(funded)
    expect(funded).toMatchObject({ state: 'ready', attempts: { count: 1 }, budget: [{ pool: 'max.programmatic', unit: 'runs', amount: 3 }, { pool: 'max.programmatic', unit: 'usd', amount: 4.5 }] })
    expect(funded.funding).toEqual([{ lines: ask, approval: verdict!.approval, decision: expect.stringMatching(/^sha256:/), at: expect.any(String) }])
    const raise = decisionOf(ctx, funded.funding![0]!.decision)
    expect(raise).toMatchObject({ decisionType: 'board', outcome: { option: 'funded', detail: { approvalRequest: request.requestId, funding: ask } } })
    const resolution = (await ctx.approvals.get(request.requestId))!.resolution!
    expect(raise.inputs).toEqual(expect.arrayContaining([resolution.decision, resolution.approval]))
    // Raised before the gate: the next attempt's readiness names the raise.
    expect(decisionOf(ctx, funded.lastDecision).inputs).toContain(funded.funding![0]!.decision)

    // The next attempt reserves within the raised lines, and runs.
    workers.reply = () => ({ text: 'funded work' })
    const second = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect(await settled(ctx, second.runId)).toMatchObject({ status: 'completed', answer: 'funded work' })
    const view = await reported(ctx, second.runId)
    expect(view.task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    expect(decisionOf(ctx, view.task!.budget!.decision)).toMatchObject({ decisionType: 'budget', outcome: { option: 'reserved', detail: { caps: funded.budget } } })
    expect(workers.started).toHaveLength(1)
    const brief = ctx.artifacts.get(workers.started[0]!.brief!)!.body as { budget: { remaining: unknown[] } }
    expect(brief.budget.remaining).toEqual([{ pool: 'max.programmatic', unit: 'runs', amount: 1 }, { pool: 'max.programmatic', unit: 'usd', amount: 1 }])
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 2 } })
  })

  it('raises nothing when the operator denies the funding, and asks for none past the board\'s bound per task: either way the task waits for input (INV-9)', async () => {
    const { ctx } = await boot({ resources: 'store', boardConfig: { fundingMaxPercent: 40 } })
    await project(ctx)
    await poolOpen(ctx)
    const budget: BudgetLine[] = [{ pool: 'max.programmatic', unit: 'usd', amount: 3 }]
    const spend = async (title: string, drawnUsd: number): Promise<{ task: BoardTask; run: RunView }> => {
      const task = await ready(ctx, title, { budget })
      await drew(ctx, task.taskId, `r-${title}`, { cost: { amount: drawnUsd, currency: 'USD', basis: 'runtime-estimate' } })
      const started = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
      expect(await settled(ctx, started.runId)).toMatchObject({ status: 'failed', error: { kind: 'budget_spent' } })
      return { task, run: await reported(ctx, started.runId) }
    }

    // Within the bound (one attempt's share, 1 usd, of at most 40% of 3), denied: the budget stays.
    const denied = await spend('denied', 3)
    expect(denied.run.task?.budget?.funding).toEqual([{ pool: 'max.programmatic', unit: 'usd', amount: 1 }])
    const asked = (await ctx.board.task(denied.task.taskId))!
    const request = (await ctx.approvals.get(asked.waiting!.approvalRequest!))!
    await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'rejected' }])
    await ctx.board.sweep(new Date())
    const rejected = (await ctx.board.task(denied.task.taskId))!
    schemas.assertRecord(rejected)
    expect(rejected).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, budget })
    expect(rejected.funding).toBeUndefined()
    expect(rejected.waiting?.funding).toBeUndefined()

    // Past the bound: a dollar overdrawn plus one attempt's share is 2 usd, more than 40% of 3, so no request is opened.
    const greedy = await spend('greedy', 4)
    expect(greedy.run.task?.budget).toMatchObject({ blocked: true, funding: [{ pool: 'max.programmatic', unit: 'usd', amount: 2 }] })
    const refused = (await ctx.board.task(greedy.task.taskId))!
    schemas.assertRecord(refused)
    expect(refused).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, budget })
    expect(refused.holder).toBeUndefined()
    expect(decisionOf(ctx, refused.lastDecision)).toMatchObject({ decisionType: 'board', outcome: { option: 'waiting-for-input', detail: { reason: 'budget-spent', funding: [{ amount: 2 }], fundingMaxPercent: 40 } } })
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.requester.taskId === greedy.task.taskId)).toEqual([])
    expect(greedy.run.task?.outcome).toMatchObject({ status: 'blocked', state: 'waiting-for-input' })
  })

  it('asks for no funding when a task\'s budget is spent on its last attempt: the run fails as budget_spent, and its report leaves the task waiting for input (retries-spent), with nothing put to the operator (ADR-0044, INV-9, INV-13)', async () => {
    const { ctx, workers } = await boot({ resources: 'store' })
    await project(ctx)
    await poolOpen(ctx)
    const budget: BudgetLine[] = [{ pool: 'max.programmatic', unit: 'runs', amount: 1 }]
    const task = await ready(ctx, 'last', { budget, maxAttempts: 1 })
    await drew(ctx, task.taskId, 'r-last')
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    const failed = await settled(ctx, run.runId)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'budget_spent', disposition: 'USER_ACTION' } })
    expect(failed.error!.message).toMatch(/it was the task's last attempt \(attempt 1 of 1\), so no funding was asked/)
    expect(workers.started).toHaveLength(0)
    const view = await reported(ctx, run.runId)
    expect(view.task?.budget).toMatchObject({ state: 'refused', spent: true })
    expect(view.task?.budget).not.toHaveProperty('blocked')
    expect(view.task?.budget).not.toHaveProperty('funding')
    // The engine's own choice, made before its effect (INV-13), on the ledger's refusal.
    const gate = decisionOf(ctx, view.task!.budget!.lastAttempt)
    expect(gate).toMatchObject({ decisionType: 'gate', decider: { id: 'workflow.task-funding' }, inputs: [view.task!.budget!.decision], outcome: { option: 'end', detail: { taskId: task.taskId, attempt: 1, maxAttempts: 1 } } })
    expect(gate.candidates.map((c) => [c.option, c.selected])).toEqual([['end', true], ['ask', false]])
    // Reported as a failed run with no attempt left: the board's own retries-spent wait, which expires.
    expect(view.task?.outcome).toMatchObject({ status: 'reconciled', state: 'waiting-for-input' })
    const ended = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(ended)
    expect(ended).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' }, budget, attempts: { count: 1, max: 1 } })
    expect(ended.funding).toBeUndefined()
    expect(decisionOf(ctx, ended.lastDecision)).toMatchObject({ decisionType: 'board', outcome: { option: 'waiting-for-input', detail: { runId: run.runId, outcome: 'failed' } } })
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.requester.taskId === task.taskId)).toEqual([])
    expect(decisionsOf(ctx, 'gate', 'workflow.task-funding')).toHaveLength(1)
  })

  it('reconciles a crash between the operator\'s approval and the board\'s move: the raise is applied once, adopting the request the dead move left, and the next attempt reserves and runs (INV-4)', async () => {
    const { ctx, workers, restartBoard } = await boot({ resources: 'store' })
    await project(ctx)
    await poolOpen(ctx)
    // A merge task asks before every attempt, so going on opens a request of its own.
    const proposed = await ctx.board.propose({ projectId: 'p1', title: 'merge it', goal: 'merge', acceptance: [{ id: 'a1', statement: 'merged' }], actionClass: 'merge', budget: [{ pool: 'max.programmatic', unit: 'runs', amount: 1 }] })
    await ctx.board.sweep(new Date())
    const approve = async (requestId: string): Promise<void> => {
      const request = (await ctx.approvals.get(requestId))!
      const [result] = await ctx.approvals.decide([{ requestId, subject: request.subject, verdict: 'approved' }])
      expect(result?.refused).toBeUndefined()
    }
    await approve((await ctx.board.task(proposed.taskId))!.waiting!.approvalRequest!)
    await ctx.board.sweep(new Date())
    await drew(ctx, proposed.taskId, 'r-merge')
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: proposed.taskId } })
    expect(await settled(ctx, run.runId)).toMatchObject({ status: 'failed', error: { kind: 'budget_spent' } })
    await reported(ctx, run.runId)
    const funding = (await ctx.board.task(proposed.taskId))!.waiting!
    expect(funding).toMatchObject({ reason: 'budget-spent', funding: [{ pool: 'max.programmatic', unit: 'runs', amount: 1 }] })
    await approve(funding.approvalRequest!)

    // The board's move dies after the queue took the next attempt's request and before the move committed.
    const request = StoreApprovals.prototype.request
    const died = vi.spyOn(StoreApprovals.prototype, 'request').mockImplementationOnce(async function (this: StoreApprovals, ...args: Parameters<typeof request>) {
      await request.apply(this, args)
      throw new Error('the host died before the board committed its move')
    })
    await ctx.board.sweep(new Date())
    died.mockRestore()
    expect((await ctx.board.task(proposed.taskId))!).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'budget-spent' }, budget: [{ amount: 1 }] })
    const orphans = (await ctx.approvals.list({ states: ['open', 'batched'] })).filter((r) => r.requester.taskId === proposed.taskId)
    expect(orphans.map((r) => r.subject)).toEqual([{ type: 'content', ref: `board-task:${proposed.taskId}:attempt:1`, version: 'approval-needed' }])

    // Restarted, the board finds the approval still standing: it raises the budget once, and its gate adopts the request the dead move left.
    await restartBoard()
    await ctx.board.sweep(new Date())
    const funded = (await ctx.board.task(proposed.taskId))!
    schemas.assertRecord(funded)
    expect(funded).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed', approvalRequest: orphans[0]!.requestId }, budget: [{ amount: 2 }] })
    expect(funded.funding).toHaveLength(1)
    expect(await ctx.board.sweep(new Date())).toEqual({ tasks: [], projects: [] })
    expect((await ctx.approvals.list({ states: ['open', 'batched'] })).filter((r) => r.requester.taskId === proposed.taskId).map((r) => r.requestId)).toEqual([orphans[0]!.requestId])

    await approve(orphans[0]!.requestId)
    await ctx.board.sweep(new Date())
    expect((await ctx.board.task(proposed.taskId))!).toMatchObject({ state: 'ready', budget: [{ amount: 2 }] })
    workers.reply = () => ({ text: 'merged' })
    const second = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: proposed.taskId } })
    expect(await settled(ctx, second.runId)).toMatchObject({ status: 'completed', answer: 'merged' })
    expect(decisionOf(ctx, (await reported(ctx, second.runId)).task!.budget!.decision)).toMatchObject({ outcome: { option: 'reserved' } })
    expect(workers.started).toHaveLength(1)
  })

  it('refuses a task with a budget before taking it when no ledger is loaded, or its pool is not configured or not available, with nothing started (INV-2)', async () => {
    const bare = await boot()
    await project(bare.ctx)
    const unledgered = await ready(bare.ctx, 'no ledger', { budget: [{ pool: 'max.programmatic', unit: 'runs', amount: 3 }] })
    expect(await refusalOf(() => bare.ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: unledgered.taskId } }))).toMatch(/^config_error: task \S+ declares a budget, and no resource ledger is loaded/)

    const { ctx, workers } = await boot({ resources: true })
    await project(ctx)
    const unknown = await ready(ctx, 'unknown pool', { budget: [{ pool: 'nowhere', unit: 'runs', amount: 3 }] })
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: unknown.taskId } }))).toMatch(/^config_error: .*draws on pool nowhere, which the resource ledger does not configure/)
    // No reading yet: missing telemetry is not capacity.
    const unread = await ready(ctx, 'unread pool', { budget: [{ pool: 'max.programmatic', unit: 'runs', amount: 3 }] })
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: unread.taskId } }))).toMatch(/^overloaded: pool max.programmatic of task \S+'s budget is unavailable/)
    expect(workers.started).toHaveLength(0)
    expect(bare.workers.started).toHaveLength(0)
    for (const [c, t] of [[bare.ctx, unledgered], [ctx, unknown], [ctx, unread]] as const) expect(await c.board.task(t.taskId)).toMatchObject({ state: 'ready', attempts: { count: 0 } })
    expect(decisionsOf(ctx, 'admission', 'workflow.task-admission').filter((d) => d.outcome.option === 'refuse')).toHaveLength(2)
  })

  it('blocks a task on the questions a step asks instead of answering (question); answered, its next attempt is briefed with the answers (PROP-0010, INV-6)', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'unclear')
    workers.reply = () => ({ text: '```json\n{"questions": ["Which band width?", "Keep the old API?"]}\n```' })
    const run = await ctx.workflow.start({ template: 'chain', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    const failed = await settled(ctx, run.runId)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'question', disposition: 'USER_ACTION' } })
    // The step that asked has no result, and nothing after it started.
    expect(failed.nodes.map((n) => n.state)).toEqual(['FAILED', 'WAITING'])
    expect(failed.nodes[0]!.result).toBeUndefined()
    expect(workers.started).toHaveLength(1)
    // Its brief offered the way to ask (brief@1.2 ask).
    expect(ctx.artifacts.get(workers.started[0]!.brief!)!.body).toMatchObject({ schema: 'brief@1.2', ask: { maxQuestions: 8 } })
    const view = await reported(ctx, run.runId)
    expect(view.task?.question).toMatchObject({ state: 'raised', nodeId: 'a', questions: ['Which band width?', 'Keep the old API?'] })
    expect(decisionOf(ctx, view.task!.question!.decision)).toMatchObject({ decisionType: 'gate', decider: { id: 'workflow.task-question' }, outcome: { option: 'ask', detail: { taskId: task.taskId, nodeId: 'a' } } })
    expect(view.task?.outcome).toMatchObject({ status: 'blocked', state: 'waiting-for-input' })
    expect(ctx.eventLog.query({ runId: run.runId, limit: 100 }).map((e) => e.type)).toEqual(expect.arrayContaining(['workflow.node.failed', 'workflow.task.question', 'workflow.run.failed', 'workflow.task.reported']))
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'question', questions: ['Which band width?', 'Keep the old API?'] }, attempts: { count: 1 } })

    // The lead answers every question: the next attempt goes through the gate (read: auto) and is briefed with the answers.
    await ctx.board.answer(task.taskId, ['64 is enough', 'yes, keep it'])
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready' })
    workers.reply = () => ({ text: 'the answer' })
    const next = await ctx.workflow.start({ template: 'chain', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect((await reported(ctx, next.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    const brief = ctx.artifacts.get(workers.started[1]!.brief!)!.body as { attempt: number; artifacts: Array<{ role: string; note: string }> }
    expect(brief.attempt).toBe(2)
    expect(brief.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'review', note: 'the answers to the 2 question(s) attempt 1 asked, and the decision that made attempt 2' })]))
    expect(workers.started[1]!.prompt).toContain('64 is enough')
  })

  it('takes an answer that only mentions questions as a result, and offers no way to ask outside a board task', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    const task = await ready(ctx, 'prose')
    workers.reply = () => ({ text: 'Done. I had no {"questions": ["none"]} left.' })
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    workers.reply = () => ({ text: '{"questions": ["Which?"]}' })
    const plain = await settled(ctx, ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public' }).runId)
    expect(plain).toMatchObject({ status: 'completed', answer: '{"questions": ["Which?"]}' })
    expect(ctx.artifacts.get(workers.started.at(-1)!.brief!)!.body).not.toHaveProperty('ask')
  })

  it('gives every brief of a task\'s run the board\'s TASKS.md as a file for its worktree, bounded, by content id, never in a source\'s prompt that writes none (PROP-0010, INV-9, INV-12)', async () => {
    const { ctx, workers } = await boot()
    await project(ctx)
    await ready(ctx, 'other work')
    const task = await ready(ctx, 'with a board')
    const run = await ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    expect((await reported(ctx, run.runId)).task?.outcome).toMatchObject({ status: 'accepted' })
    const envelope = ctx.artifacts.get(workers.started[0]!.brief!)!
    const brief = envelope.body as { files: Array<{ path: string; ref: ArtifactRef; note: string }> }
    expect(brief.files).toEqual([{ path: '.system/TASKS.md', ref: expect.any(String), note: 'the board of project p1 when this run was admitted (2 task(s))' }])
    expect(envelope.inputs).toContain(brief.files[0]!.ref)
    const projection = ctx.artifacts.get(brief.files[0]!.ref)!
    expect(projection).toMatchObject({ kind: 'evidence', bodySchema: 'board-projection@1.0', classification: 'public', body: { projectId: 'p1', format: 'tasks-md', tasks: 2, truncated: false } })
    const text = (projection.body as { text: string }).text
    expect(text).toContain('### with a board')
    expect(text).toContain('### other work')
    expect(text).toContain(`- id: \`${task.taskId}\``)
    // A source that writes no file never mentions one.
    expect(workers.started[0]!.prompt).not.toContain('TASKS.md')
  })

  it('cuts the TASKS.md projection at tasksFile.maxChars with a note, and writes none with tasksFile.maxTasks 0 (INV-9)', async () => {
    const cut = await boot({ workflow: { tasksFile: { maxChars: 1024 } } })
    await project(cut.ctx)
    for (const n of [1, 2, 3]) await ready(cut.ctx, `long ${n}`, { goal: `${'a long goal line\n'.repeat(40)}` })
    const task = await ready(cut.ctx, 'cut')
    const run = await cut.ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: task.taskId } })
    await reported(cut.ctx, run.runId)
    const file = (cut.ctx.artifacts.get(cut.workers.started[0]!.brief!)!.body as { files: Array<{ ref: ArtifactRef }> }).files[0]!
    const body = cut.ctx.artifacts.get(file.ref)!.body as { text: string; truncated: boolean; tasks: number }
    expect(body).toMatchObject({ truncated: true, tasks: 4 })
    expect([...body.text].length).toBeLessThanOrEqual(1024)
    expect(body.text).toMatch(/…\(cut at 1024 characters of \d+: read the rest of the board with board_tasks\)\n$/)

    const none = await boot({ workflow: { tasksFile: { maxTasks: 0 } } })
    await project(none.ctx)
    const bare = await ready(none.ctx, 'no file')
    await reported(none.ctx, (await none.ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public', task: { taskId: bare.taskId } })).runId)
    expect(none.ctx.artifacts.get(none.workers.started[0]!.brief!)!.body).not.toHaveProperty('files')
  })

  it('fails a node whose instructions retention cleared, with nothing sent, instead of briefing it on its goal alone (INV-2)', async () => {
    const { ctx, workers } = await boot({ board: false })
    workers.reply = () => ({ fail: 'invalid_input', disposition: 'NONE', sent: false })
    const failed = await settled(ctx, ctx.workflow.start({ template: 'solo', input: 'q', classification: 'public' }).runId)
    expect(failed.status).toBe('failed')
    ctx.store.db.prepare('UPDATE workflow_nodes SET prompt = NULL, brief_parts = NULL WHERE run_id = ?').run(failed.runId)
    workers.reply = () => ({ text: 'never' })
    ctx.workflow.continue(failed.runId)
    const again = await settled(ctx, failed.runId)
    expect(again).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } })
    expect(again.nodes[0]!.error?.message).toMatch(/no instructions left/)
    expect(workers.started).toHaveLength(1)
  })

  it('resumes a task\'s session only on a conversation its Worker keeps for any work, never on one it keeps for a review member\'s steps alone (ADR-0049)', async () => {
    const { ctx, workers } = await boot()
    const at = '2026-10-23T00:00:00Z'
    // The same Worker, keeping conversations for any work, then (its runtime no longer resuming) for review members only.
    const keeper = (scoped: boolean) => worker('w:keeper', {
      schema: 'capability-descriptor@1.4', tier: 'standard',
      capabilities: [{ capability: 'reason', evidence: { kind: 'conformance', at } }, { capability: 'persistent-conversation', evidence: { kind: 'conformance', at }, ...(scoped ? { scope: 'review-member' as const } : {}) }],
    })
    workers.extra = [keeper(false)]
    await project(ctx)
    const attempt = async (task: BoardTask): Promise<RunView> => {
      const run = await ctx.workflow.start({ template: 'kept', input: 'q', classification: 'public', task: { taskId: task.taskId } })
      await settled(ctx, run.runId)
      return reported(ctx, run.runId)
    }
    workers.reply = () => ({ fail: 'invalid_input', disposition: 'NONE', sent: true })
    const kept = await ready(ctx, 'kept', { maxAttempts: 3 })
    const first = await attempt(kept)
    expect(first.sessionId).toBeDefined()
    await ctx.board.sweep(new Date())
    workers.extra = [keeper(true)]
    const second = await attempt((await ctx.board.task(kept.taskId))!)
    const [fresh] = decisionsOf(ctx, 'admission', 'workflow.task-session')
    expect(fresh).toMatchObject({ outcome: { option: 'fresh' } })
    expect(fresh!.candidates.find((c) => c.option === 'fresh')!.reasons.join(' ')).toMatch(/cannot resume it now/)
    expect(second.sessionId).not.toBe(first.sessionId)
    // Its step needs a conversation for any work, which no Worker keeps now: it fails closed, unsent.
    expect(second.status).toBe('failed')
    expect(workers.started).toHaveLength(1)
  })

  it('refuses a template other than the task\'s, a classification laxer than its project\'s, and a run for a task with no board loaded', async () => {
    const { ctx, workers } = await boot()
    const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'private', charter: CHARTER, classification: 'local-private' })
    const request = await ctx.approvals.get(approvalRequest)
    await ctx.approvals.decide([{ requestId: approvalRequest, subject: request!.subject, verdict: 'approved' }])
    await ctx.board.sweep(new Date())
    const task = await ready(ctx, 'templated', { template: 'chain' })
    expect(await refusalOf(() => ctx.workflow.start({ template: 'solo', input: 'q', task: { taskId: task.taskId } }))).toMatch(/runs template chain, not solo/)
    expect(await refusalOf(() => ctx.workflow.start({ template: 'chain', input: 'q', classification: 'public', task: { taskId: task.taskId } }))).toMatch(/is local-private: .* cannot be public/)
    expect(workers.started).toHaveLength(0)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready' })

    const bare = await boot({ board: false })
    expect(await refusalOf(() => bare.ctx.workflow.start({ template: 'solo', input: 'q', task: { taskId: 'task-1' } }))).toMatch(/^config_error: no board is loaded/)
    // Without a task, a run works as before.
    expect(await settled(bare.ctx, bare.ctx.workflow.start({ template: 'solo', input: 'plain', classification: 'public' }).runId)).toMatchObject({ status: 'completed' })
  })
})
