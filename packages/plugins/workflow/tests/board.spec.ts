import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef, BoardTask, Subject, TaskInput } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { WorkerExecution } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHARTER } from '../../../board-core/conformance/board.ts'
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
}

async function boot(options: { workflow?: Config; board?: boolean | 'short'; workspace?: string } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-board-'))
  const ctx = new Context()
  const workers = options.workspace ? new AgentWorkers(options.workspace, () => ctx.artifacts) : new ScriptedWorkers()
  const config: Config = { ...CONFIG, ...options.workflow, templates: { ...TEMPLATES, ...options.workflow?.templates } }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ...(options.board === false ? [] : [ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(options.board === 'short' ? ShortLeaseBoard : StoreBoard, { sweepSeconds: 0 })]),
  ]
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
  }
}

const project = (ctx: Context): Promise<void> => activeProject(ctx)
const ready = (ctx: Context, title: string, extra: Partial<TaskInput> = {}): Promise<BoardTask> => readyTask(ctx, title, extra)

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
    expect(view.task?.outcome?.reason).toMatch(/tests, lint not passed/)
    const review = (await ctx.board.task(task.taskId))!
    expect(review).toMatchObject({ state: 'review', result: { artifacts: [view.result] } })
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
