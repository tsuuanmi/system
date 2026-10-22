import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Action, ApprovalRequest, NewRequest } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import { type ArtifactRef, BoardError, type BoardTask, type Subject, type TaskInput } from '@tsuuanmi/system-board-core'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z as zod } from 'zod'
import { FakeApprovals } from '../../../approvals-core/conformance/approvals.ts'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import StoreBoard, { type Config } from '../src/index.ts'
import { BOARD_TOOLS, INPUTS } from '../src/tools.ts'

const T0 = new Date('2026-10-22T09:00:00Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
const schemas = new SchemaRegistry()
const HEAD: Subject = { type: 'git-head', ref: 'HEAD', version: 'abc123' }

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as a given scope would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

/** The approvals fake, which can be taken down: every call then throws, as an unavailable queue would. */
class FlakyApprovals extends FakeApprovals {
  down = false
  /** Only withdrawals fail, as a crash right after a move committed would leave it. */
  withdrawDown = false
  /** Requests the queue no longer knows, as a lost row or a restore from an older backup would leave it. */
  readonly forgotten = new Set<string>()
  private up(): void {
    if (this.down) throw new Error('the approval queue is unavailable')
  }

  override async check(action: Action) { this.up(); return super.check(action) }
  override async request(request: NewRequest, when?: Date) { this.up(); return super.request(request, when) }
  override async get(requestId: string) { this.up(); return this.forgotten.has(requestId) ? undefined : super.get(requestId) }
  override async list(filter?: Parameters<FakeApprovals['list']>[0]) { this.up(); return (await super.list(filter)).filter((r) => !this.forgotten.has(r.requestId)) }
  override async withdraw(requestId: string, when?: Date) {
    this.up()
    if (this.withdrawDown) throw new Error('the approval queue is unavailable')
    return super.withdraw(requestId, when)
  }
}

interface Booted {
  ctx: Context
  dir: string
  board: () => StoreBoard
  approvals: () => FlakyApprovals
  mcp: () => RecordingMcp
  /** Dispose the board and plug a new one into the same context: the same store, leases, and approvals. */
  restartBoard: (config?: Config) => Promise<void>
  stop: () => Promise<void>
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(options: { dir?: string; board?: Config } = {}): Promise<Booted> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-board-'))
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const base = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}), ctx.plugin(FlakyApprovals), ctx.plugin(RecordingMcp)]
  await Promise.all(base)
  let fiber = ctx.plugin(StoreBoard, { sweepSeconds: 0, ...options.board })
  await fiber
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await fiber.dispose()
    for (const f of [...base].reverse()) await f.dispose()
  }
  cleanups.push(stop)
  return {
    ctx, dir, stop,
    board: () => ctx.board as StoreBoard,
    approvals: () => ctx.approvals as FlakyApprovals,
    mcp: () => ctx.mcp as RecordingMcp,
    restartBoard: async (config?: Config) => {
      await fiber.dispose()
      fiber = ctx.plugin(StoreBoard, { sweepSeconds: 0, ...options.board, ...config })
      await fiber
    },
  }
}

const task = (projectId: string, title: string, extra: Partial<TaskInput> = {}): TaskInput => ({
  projectId, title, goal: `do ${title}`, acceptance: [{ id: 'a1', statement: 'tests pass', check: 'tests' }], actionClass: 'read', ...extra,
})
const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof BoardError ? error.failure : `not a BoardError: ${String(error)}`
  }
}
const decide = async (ctx: Context, requestId: string, verdict: 'approved' | 'rejected', when: Date): Promise<void> => {
  const request = await ctx.approvals.get(requestId)
  const [result] = await ctx.approvals.decide([{ requestId, subject: request!.subject, verdict }], when)
  expect(result?.refused).toBeUndefined()
}
/** An active project: founded, its charter approved by the operator, swept. */
const active = async (ctx: Context, projectId = 'p2', when = T0): Promise<void> => {
  const { approvalRequest } = await ctx.board.charter({ projectId, title: `project ${projectId}`, charter: CHARTER, milestones: [{ id: 'm1', title: 'First', state: 'planned' }] }, when)
  await decide(ctx, approvalRequest, 'approved', new Date(when.getTime() + 60_000))
  await ctx.board.sweep(new Date(when.getTime() + 60_000))
}
const ready = async (ctx: Context, input: TaskInput, when = at(2)): Promise<BoardTask> => {
  const proposed = await ctx.board.propose(input, when)
  await ctx.board.sweep(when)
  const t = (await ctx.board.task(proposed.taskId))!
  expect(t.state).toBe('ready')
  return t
}
const result = (ctx: Context, text: string): ArtifactRef => ctx.artifacts.put({
  kind: 'report', bodySchema: 'agent-result@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'test' },
  body: { schema: 'agent-result@1.0', worker: 'w', runtime: 'fake', runId: 'r', promptHash: `sha256:${'0'.repeat(64)}`, sandbox: 'read-only', text },
}).id as ArtifactRef
const acceptance = (ctx: Context, option: 'accept' | 'reject', on: ArtifactRef): ArtifactRef => ctx.artifacts.recordDecision({
  decisionType: 'acceptance', question: `Does ${on} satisfy the criteria?`, inputs: [on],
  candidates: [{ option: 'accept', selected: option === 'accept', reasons: ['checked'] }, { option: 'reject', selected: option === 'reject', reasons: ['checked'] }],
  decider: { type: 'rule', id: 'acceptance.test', version: '1' }, outcome: { option }, deterministic: true,
}, { producer: { type: 'policy', ref: 'test' } }).id as ArtifactRef
const open = (ctx: Context, projectId: string): Promise<ApprovalRequest[]> => ctx.approvals.list({ projectId, states: ['open', 'batched'] })

describe('ctx.board (store-backed): restart', () => {
  it('a new provider over the same store sees the same projects, tasks, holders, and waits, and continues sweeping (INV-4)', async () => {
    const b = await boot()
    const { ctx } = b
    await active(ctx)
    const claimed = await ready(ctx, task('p2', 'claimed'))
    await ctx.board.claim(claimed.taskId, 'lead', 60_000, at(3))
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    await ctx.board.sweep(at(2))
    const asks = await ready(ctx, task('p2', 'asks'))
    const { generation } = await ctx.board.claim(asks.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(asks.taskId, generation, { runId: 'run-1' }, at(3))
    await ctx.board.block(asks.taskId, generation, { reason: 'question', questions: ['Band width 64?'] }, at(3))
    const amendment = await ctx.board.charter({ projectId: 'p2', title: 'project p2', charter: { ...CHARTER, version: 2, intent: 'Twice as fast.' } }, at(3))
    const projects = await ctx.board.projects()
    const tasks = await ctx.board.tasks({ projectId: 'p2' })
    const before = ctx.board

    await b.restartBoard()
    expect(ctx.board).not.toBe(before)
    expect(await ctx.board.projects()).toEqual(projects)
    expect(await ctx.board.tasks({ projectId: 'p2' })).toEqual(tasks)
    expect((await ctx.board.task(claimed.taskId))?.holder).toMatchObject({ owner: 'lead', generation: 1 })
    expect((await ctx.board.task(asks.taskId))?.waiting).toMatchObject({ reason: 'question', questions: ['Band width 64?'] })

    // What was decided while it was down, or fell due, moves on the new provider's sweep.
    await decide(ctx, (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!, 'approved', at(4))
    await decide(ctx, amendment.approvalRequest, 'approved', at(4))
    const swept = await ctx.board.sweep(at(4))
    expect(swept.tasks.map((t) => t.taskId).sort()).toEqual([claimed.taskId, merge.taskId].sort())
    expect(await ctx.board.task(claimed.taskId)).toMatchObject({ state: 'ready' })
    expect(await ctx.board.task(merge.taskId)).toMatchObject({ state: 'ready' })
    expect(await ctx.board.project('p2')).toMatchObject({ state: 'active', charter: { version: 2, intent: 'Twice as fast.' } })
    const waiting = (await ctx.board.task(asks.taskId))!
    await ctx.board.sweep(new Date(Date.parse(waiting.waiting!.expiresAt)))
    expect(await ctx.board.task(asks.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'input-expired' } })
  })

  it('fences with the lease it stored across a process restart: the holder\'s generation still writes, a stale one is refused (INV-4, INV-15)', async () => {
    const first = await boot()
    await active(first.ctx)
    const t = await ready(first.ctx, task('p2', 't'))
    await first.ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
    await first.stop()

    const second = await boot({ dir: first.dir })
    const { ctx } = second
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'claimed', holder: { owner: 'lead', generation: 1 } })
    expect((await ctx.board.renew(t.taskId, 1, 60_000, at(3.5))).leaseExpiresAt).toBe(new Date(at(3.5).getTime() + 60_000).toISOString())
    await ctx.board.sweep(at(10))
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'ready' })
    const again = await ctx.board.claim(t.taskId, 'other', 60_000, at(10))
    expect(again.generation).toBe(2)
    expect(await failureOf(ctx.board.start(t.taskId, 1, { runId: 'run-stale' }, at(10)))).toBe('stale-generation')
    expect(await failureOf(ctx.board.renew(t.taskId, 1, 60_000, at(10)))).toBe('stale-generation')
    expect(await ctx.board.start(t.taskId, 2, { runId: 'run-1' }, at(10))).toMatchObject({ state: 'running', run: { runId: 'run-1' }, holder: { generation: 2 } })
  })

  it('sweeps once at start, so what fell due while it was down moves without a call (INV-4)', async () => {
    const b = await boot()
    const now = new Date()
    await active(b.ctx, 'p2', new Date(now.getTime() - 120_000))
    const proposed = await b.ctx.board.propose(task('p2', 'late'), now)
    await b.restartBoard({ sweepSeconds: 3600 })
    await vi.waitFor(async () => expect(await b.ctx.board.task(proposed.taskId)).toMatchObject({ state: 'ready' }), { timeout: 5000, interval: 20 })
  })
})

describe('ctx.board (store-backed): concurrency', () => {
  it('lets one of concurrent claims win, on one provider and across two over the same store file (INV-15)', async () => {
    const a = await boot()
    const b = await boot({ dir: a.dir })
    await active(a.ctx)
    const t = await ready(a.ctx, task('p2', 't'))
    const claims = await Promise.allSettled([
      a.ctx.board.claim(t.taskId, 'a', 60_000, at(3)), b.ctx.board.claim(t.taskId, 'b', 60_000, at(3)), a.ctx.board.claim(t.taskId, 'c', 60_000, at(3)),
    ])
    const won = claims.filter((c) => c.status === 'fulfilled')
    expect(won).toHaveLength(1)
    for (const lost of claims.filter((c) => c.status === 'rejected')) expect((lost.reason as BoardError).failure).toBe('invalid-transition')
    const holder = (await b.ctx.board.task(t.taskId))!.holder!
    expect(holder.generation).toBe(1)
    expect(['a', 'b', 'c']).toContain(holder.owner)
  })

  it('refuses a move decided before an await when the task changed meanwhile, and withdraws the request it opened', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    // The sweep stops at its first await on the queue; the lead cancels the task meanwhile.
    const sweeping = ctx.board.sweep(at(2))
    await ctx.board.cancel(merge.taskId, 'lead', undefined, at(2))
    expect((await sweeping).tasks).toEqual([])
    expect(await ctx.board.task(merge.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'lead' } })
    expect(await open(ctx, 'p2')).toEqual([])
  })

  it('puts a task to the operator once when two sweeps race (INV-4)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    await Promise.all([ctx.board.sweep(at(2)), ctx.board.sweep(at(2))])
    const waiting = (await ctx.board.task(merge.taskId))!
    expect(waiting.state).toBe('waiting-for-approval')
    expect((await open(ctx, 'p2')).map((r) => r.requestId)).toEqual([waiting.waiting!.approvalRequest])
  })

  it('moves nothing on a second sweep at the same time: the sweep is idempotent (INV-4)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    await ctx.board.propose(task('p2', 'a'), at(2))
    await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    expect((await ctx.board.sweep(at(2))).tasks).toHaveLength(2)
    const after = await ctx.board.tasks({ projectId: 'p2' })
    expect(await ctx.board.sweep(at(2))).toEqual({ tasks: [], projects: [] })
    expect(await ctx.board.tasks({ projectId: 'p2' })).toEqual(after)
    expect(await open(ctx, 'p2')).toHaveLength(1)
  })
})

describe('ctx.board (store-backed): the approval queue', () => {
  it('moves nothing that needs the queue while it is unavailable, and everything else still moves (INV-2)', async () => {
    const { ctx, approvals } = await boot()
    await active(ctx)
    const claimed = await ready(ctx, task('p2', 'claimed'))
    await ctx.board.claim(claimed.taskId, 'lead', 60_000, at(3))
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(3))
    approvals().down = true
    expect((await ctx.board.sweep(at(5))).tasks.map((t) => t.taskId)).toEqual([claimed.taskId])
    expect(await ctx.board.task(merge.taskId)).toMatchObject({ state: 'proposed' })
    expect(await ctx.board.task(claimed.taskId)).toMatchObject({ state: 'ready' })
    await expect(ctx.board.charter({ projectId: 'p9', title: 'p9', charter: CHARTER }, at(5))).rejects.toThrow(/unavailable/)
    expect(await ctx.board.project('p9')).toBeUndefined()
    approvals().down = false
    await ctx.board.sweep(at(5))
    const waiting = (await ctx.board.task(merge.taskId))!
    expect(waiting.state).toBe('waiting-for-approval')
    approvals().down = true
    await expect(ctx.board.cancel(merge.taskId, 'lead', undefined, at(6))).rejects.toThrow(/unavailable/)
    await expect(ctx.board.close('p2', 'stopped', at(6))).rejects.toThrow(/unavailable/)
    expect(await ctx.board.task(merge.taskId)).toEqual(waiting)
    expect((await ctx.board.project('p2'))?.state).toBe('active')
  })

  it('asks once across a crash between asking and recording: it adopts its own open request on the same exact subject (INV-4)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    // What a board that crashed after asking, before committing, leaves in the queue.
    const verdict = await ctx.approvals.check({ class: 'merge', projectId: 'p2' })
    const orphan = await ctx.approvals.request({
      subject: { type: 'content', ref: `board-task:${merge.taskId}:attempt:0`, version: 'approval-needed' }, action: { class: 'merge', summary: 'approval-needed: merge' },
      requester: { component: 'board', projectId: 'p2', taskId: merge.taskId }, verdict, classification: 'operator-shared',
    }, at(2))
    await ctx.board.sweep(at(2))
    expect((await ctx.board.task(merge.taskId))?.waiting?.approvalRequest).toBe(orphan.requestId)
    expect(await open(ctx, 'p2')).toHaveLength(1)
  })

  it('starts nothing with no attempt left, even when the operator approves going on (INV-9)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const t = await ready(ctx, task('p2', 't', { maxAttempts: 1 }))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
    const spent = await ctx.board.block(t.taskId, generation, { reason: 'budget-spent' }, at(4))
    expect((await ctx.approvals.get(spent.waiting!.approvalRequest!))?.action.class).toBe('funding')
    await decide(ctx, spent.waiting!.approvalRequest!, 'approved', at(5))
    await ctx.board.sweep(at(5))
    const stopped = (await ctx.board.task(t.taskId))!
    expect(stopped).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' }, attempts: { count: 1, max: 1 } })
    expect(ctx.artifacts.get(stopped.lastDecision!)?.body).toMatchObject({ decisionType: 'approval' })
  })

  it('commits a move before it withdraws the request the task waited on: a withdrawal that fails after it leaves an open request that changes nothing (S7)', async () => {
    const { ctx, approvals } = await boot()
    await active(ctx)
    const t = await ready(ctx, task('p2', 't'))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
    await ctx.board.sweep(at(10))
    const requestId = (await ctx.board.task(t.taskId))!.waiting!.approvalRequest!
    approvals().withdrawDown = true
    const r = result(ctx, 'finished')
    expect(await ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: acceptance(ctx, 'accept', r) }, at(11)))
      .toMatchObject({ state: 'done', result: { artifacts: [r] } })
    expect((await ctx.approvals.get(requestId))?.state).toBe('open')
    // The operator approving the orphan, or its expiry, moves nothing: no task waits on it.
    await decide(ctx, requestId, 'approved', at(12))
    expect(await ctx.board.sweep(at(12))).toEqual({ tasks: [], projects: [] })
    expect((await ctx.board.task(t.taskId))?.state).toBe('done')

    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(12))
    approvals().withdrawDown = false
    await ctx.board.sweep(at(12))
    const waitedOn = (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!
    approvals().withdrawDown = true
    expect(await ctx.board.cancel(merge.taskId, 'lead', undefined, at(13))).toMatchObject({ state: 'cancelled' })
    expect((await ctx.approvals.get(waitedOn))?.state).toBe('open')
    await ctx.approvals.sweep(at(60 * 24 * 30))
    expect(await ctx.board.sweep(at(60 * 24 * 30))).toEqual({ tasks: [], projects: [] })
  })

  it('withdraws nothing when a close fails after reading its tasks, so every wait stays as it was (M1)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    await ctx.board.sweep(at(2))
    const waiting = (await ctx.board.task(merge.taskId))!
    // The close stops at its first await; the project is paused meanwhile, so its transaction refuses.
    const closing = ctx.board.close('p2', 'stopped', at(3))
    await ctx.board.pause('p2', at(3))
    expect(await failureOf(closing)).toBe('conflict')
    expect(await ctx.board.task(merge.taskId)).toEqual(waiting)
    expect((await ctx.approvals.get(waiting.waiting!.approvalRequest!))?.state).toBe('open')
    expect(await ctx.board.close('p2', 'stopped', at(4))).toMatchObject({ state: 'closed' })
    expect((await ctx.approvals.get(waiting.waiting!.approvalRequest!))?.resolution?.cause).toBe('withdrawn')
  })

  it('applies a wait\'s expiry itself when the queue no longer knows its request, also across a restart: nothing waits forever (S2, INV-9)', async () => {
    const b = await boot()
    const { ctx, approvals } = b
    await active(ctx)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    await ctx.board.sweep(at(2))
    const waiting = (await ctx.board.task(merge.taskId))!
    const founded = await ctx.board.charter({ projectId: 'p4', title: 'Lost', charter: CHARTER }, at(2))
    const early = await ctx.board.propose(task('p4', 'early', { writes: { type: 'git-head', ref: 'refs/heads/lost' } }), at(2))
    const charterDue = (await ctx.approvals.get(founded.approvalRequest))!.expiresAt
    approvals().forgotten.add(waiting.waiting!.approvalRequest!)
    approvals().forgotten.add(founded.approvalRequest)
    await b.restartBoard()
    expect(await ctx.board.sweep(new Date(Date.parse(waiting.waiting!.expiresAt) - 1))).toEqual({ tasks: [], projects: [] })
    expect(await ctx.board.task(merge.taskId)).toEqual(waiting)
    const swept = await ctx.board.sweep(new Date(Math.max(Date.parse(waiting.waiting!.expiresAt), Date.parse(charterDue))))
    expect(swept.tasks.map((t) => t.taskId).sort()).toEqual([merge.taskId, early.taskId].sort())
    const expired = (await ctx.board.task(merge.taskId))!
    expect(expired).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' } })
    expect(ctx.artifacts.get(expired.lastDecision!)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'waiting-for-input', detail: { cause: 'expired', approvalRequest: waiting.waiting!.approvalRequest } } })
    expect(await ctx.board.project('p4')).toMatchObject({ state: 'closed', closure: { outcome: 'abandoned' } })
    expect(await ctx.board.task(early.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'project-closed' } })
    expect(await ctx.board.sweep(at(60 * 24 * 365))).toMatchObject({ projects: [] })
  })

  it('withdraws the request of a wait it expired itself, so the operator is not shown it again', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    await ctx.board.sweep(at(2))
    const { waiting } = (await ctx.board.task(merge.taskId))!
    await ctx.board.sweep(new Date(Date.parse(waiting!.expiresAt)))
    expect((await ctx.approvals.get(waiting!.approvalRequest!))?.resolution?.cause).toBe('withdrawn')
    expect(await open(ctx, 'p2')).toEqual([])
  })

  it('withdraws a pending amendment\'s request when its project closes, and holds one amendment at a time', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const { approvalRequest } = await ctx.board.charter({ projectId: 'p2', title: 'p2', charter: { ...CHARTER, version: 2 } }, at(3))
    expect(await failureOf(ctx.board.charter({ projectId: 'p2', title: 'p2', charter: { ...CHARTER, version: 2, intent: 'Other.' } }, at(3)))).toBe('invalid-transition')
    expect(await ctx.board.close('p2', 'stopped', at(4))).toMatchObject({ state: 'closed', closure: { outcome: 'stopped' } })
    expect((await ctx.approvals.get(approvalRequest))?.resolution?.cause).toBe('withdrawn')
    expect((await ctx.board.project('p2'))?.proposedCharter).toBeUndefined()
    expect(await ctx.board.sweep(at(5))).toEqual({ tasks: [], projects: [] })
  })
})

describe('ctx.board (store-backed): the protocol\'s guards', () => {
  it('takes an acceptance decision only on the task\'s own result, and only accept or reject (fail-closed rule 5, INV-5)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const t = await ready(ctx, task('p2', 't'))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
    const mine = result(ctx, 'mine')
    await ctx.board.submit(t.taskId, generation, { artifacts: [mine], subject: HEAD }, at(4))
    expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', result(ctx, 'another')), at(5)))).toBe('invalid')
    const odd = ctx.artifacts.recordDecision({
      decisionType: 'acceptance', question: 'q', inputs: [mine], candidates: [{ option: 'maybe', selected: true, reasons: ['unsure'] }],
      decider: { type: 'rule', id: 'acceptance.test', version: '1' }, outcome: { option: 'maybe' }, deterministic: true,
    }, { producer: { type: 'policy', ref: 'test' } }).id as ArtifactRef
    expect(await failureOf(ctx.board.accept(t.taskId, odd, at(5)))).toBe('invalid')
    expect((await ctx.board.task(t.taskId))?.state).toBe('review')
    expect(await failureOf(ctx.board.submit(t.taskId, generation, { artifacts: [`sha256:${'9'.repeat(64)}`], subject: HEAD }, at(5)))).toBe('invalid-transition')
    expect(await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', mine), at(5))).toMatchObject({ state: 'done' })
  })

  it('checks a lost run\'s reported outcome before it withdraws the request the task waits on, so a refused report changes nothing (INV-4)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const t = await ready(ctx, task('p2', 't'))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
    await ctx.board.sweep(at(10))
    const lost = (await ctx.board.task(t.taskId))!
    expect(lost.waiting).toMatchObject({ reason: 'reconciliation-failed' })
    const r = result(ctx, 'finished')
    const elsewhere = acceptance(ctx, 'accept', result(ctx, 'another result'))
    expect(await failureOf(ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: elsewhere }, at(11)))).toBe('invalid')
    expect((await ctx.approvals.get(lost.waiting!.approvalRequest!))?.state).toBe('open')
    expect(await ctx.board.task(t.taskId)).toEqual(lost)
    expect(await ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: acceptance(ctx, 'reject', r) }, at(11)))
      .toMatchObject({ state: 'ready', attempts: { count: 1 } })
    expect(ctx.leases.current(`board-task:${t.taskId}`)).toBeUndefined()
  })

  it('starts nothing in a paused project, not even a task claimed before the pause (fail-closed rule 1)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const t = await ready(ctx, task('p2', 't'))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
    await ctx.board.pause('p2', at(3))
    expect(await failureOf(ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(4)))).toBe('invalid-transition')
    await ctx.board.resume('p2', at(5))
    expect((await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(5))).state).toBe('running')
  })

  it('lets one open task write a subject at a time, also when one ends (INV-15)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const branch: Subject = { type: 'git-head', ref: 'refs/heads/kernel' }
    const first = await ctx.board.propose(task('p2', 'w1', { actionClass: 'workspace-write', writes: branch }), at(2))
    expect(await failureOf(ctx.board.propose(task('p2', 'w2', { actionClass: 'workspace-write', writes: { ...branch, version: 'other' } }), at(2)))).toBe('conflict')
    await ctx.board.cancel(first.taskId, 'superseded', 'replaced', at(3))
    expect((await ctx.board.propose(task('p2', 'w2', { actionClass: 'workspace-write', writes: branch }), at(3))).state).toBe('proposed')
  })

  it('records a reason on every candidate of every board decision, and names the decision behind every move (INV-13)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const a = await ready(ctx, task('p2', 'a'))
    const b = await ctx.board.propose(task('p2', 'b', { dependsOn: [a.taskId] }), at(2))
    const { generation } = await ctx.board.claim(a.taskId, 'lead', 60_000, at(3))
    await ctx.board.start(a.taskId, generation, { runId: 'run-1' }, at(3))
    await ctx.board.block(a.taskId, generation, { reason: 'question', questions: ['Why?'] }, at(3))
    await ctx.board.answer(a.taskId, ['Because.'], at(3))
    await ctx.board.cancel(a.taskId, 'operator', 'enough', at(3))
    await ctx.board.sweep(at(4))
    expect(await ctx.board.task(b.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'dependency-cancelled' } })
    await ctx.board.pause('p2', at(5))
    await ctx.board.resume('p2', at(5))
    await ctx.board.close('p2', 'achieved', at(6))
    const decisions = ctx.artifacts.list({ kind: 'decision', decisionType: 'board', limit: 1000 })
    expect(decisions.length).toBeGreaterThanOrEqual(10)
    for (const envelope of decisions) {
      const body = envelope.body as { schema: string; candidates: Array<{ option: string; reasons: string[] }>; outcome: { detail?: Record<string, unknown> } }
      expect(body.schema).toBe('decision@1.4')
      for (const candidate of body.candidates) expect(candidate.reasons.length, `${envelope.id} ${candidate.option}`).toBeGreaterThan(0)
      expect(body.outcome.detail).toMatchObject({ projectId: 'p2' })
    }
    for (const t of await ctx.board.tasks({ projectId: 'p2' })) expect(ctx.artifacts.get(t.lastDecision!)?.kind).toBe('decision')
    const answered = decisions.map((d) => d.body as { outcome: { option: string; detail?: { answers?: string[] } } }).find((d) => d.outcome.detail?.answers)
    expect(answered?.outcome).toMatchObject({ option: 'ready', detail: { answers: ['Because.'] } })
  })
})

describe('ctx.board (store-backed): validation', () => {
  it('refuses an invalid task, charter, owner, or note before anything is stored or asked (INV-14)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    expect(await failureOf(ctx.board.propose(task('p2', 'x'.repeat(201)), at(2)))).toBe('invalid')
    expect(await failureOf(ctx.board.propose({ ...task('p2', 'x'), acceptance: [] }, at(2)))).toBe('invalid')
    expect(await failureOf(ctx.board.propose(task('p2', 'x', { milestone: 'm9' }), at(2)))).toBe('invalid')
    expect(await failureOf(ctx.board.propose(task('p2', 'x', { maxAttempts: 0 }), at(2)))).toBe('invalid')
    expect(await ctx.board.tasks({ projectId: 'p2' })).toEqual([])
    expect(await failureOf(ctx.board.charter({ projectId: 'p3', title: 'p3', charter: { ...CHARTER, criteria: [] } }, at(2)))).toBe('invalid')
    expect(await ctx.board.project('p3')).toBeUndefined()
    expect(await ctx.approvals.list({ projectId: 'p3' })).toEqual([])
    const t = await ready(ctx, task('p2', 't', { milestone: 'm1' }))
    expect(await failureOf(ctx.board.claim(t.taskId, 'not an id', 60_000, at(3)))).toBe('invalid')
    expect(await failureOf(ctx.board.claim(t.taskId, 'lead', 0, at(3)))).toBe('invalid')
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'ready' })
    expect(ctx.leases.current(`board-task:${t.taskId}`)).toBeUndefined()
    expect((await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))).generation).toBe(1)
    expect(await failureOf(ctx.board.cancel(t.taskId, 'lead', 'n'.repeat(501), at(3)))).toBe('invalid')
    expect(await failureOf(ctx.board.cancel(t.taskId, 'nobody' as 'lead', undefined, at(3)))).toBe('invalid')
    expect((await ctx.board.task(t.taskId))?.state).toBe('claimed')
  })

  it('never acts on a stored record that fails its schema: reads refuse it and the sweep leaves it (INV-14)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const t = await ctx.board.propose(task('p2', 't'), at(2))
    ctx.store.db.prepare("UPDATE board_tasks SET record = json_set(record, '$.attempts.count', 99) WHERE task_id = ?").run(t.taskId)
    await expect(ctx.board.task(t.taskId)).rejects.toThrow(/not a valid board-task@1.0/)
    expect(await ctx.board.sweep(at(2))).toEqual({ tasks: [], projects: [] })
  })
})

// --- MCP ---

type Call = (tool: string, args: Record<string, unknown>, scope?: 'client' | 'operator') => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text?: string }> }>
const caller = (b: Booted): Call => async (tool, args, scope = 'client') => {
  const registered = b.mcp().tools.get(tool)
  expect(registered, tool).toBeDefined()
  const reply = await registered!.handler(args, { scope }) as Awaited<ReturnType<Call>>
  // Every structured output is checked against its definition in schemas/mcp-board.v1.json, with Ajv.
  if (!reply.isError) schemas.assertDef('mcp-board@1.0', `${tool.replaceAll('_', '-')}-output`, reply.structuredContent)
  return reply
}
const ok = async (reply: ReturnType<Call>): Promise<Record<string, any>> => {
  const r = await reply
  expect(r.isError, r.content[0]?.text).toBeFalsy()
  return r.structuredContent!
}
const example = (name: string): Record<string, any> => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as Record<string, any>

describe('ctx.board (store-backed): board_* MCP tools', () => {
  it('contributes the ten board tools at client scope, each input shape taking what its schema definition takes', async () => {
    const b = await boot()
    expect([...b.mcp().tools.keys()].sort()).toEqual([...BOARD_TOOLS].sort())
    for (const name of BOARD_TOOLS) expect(b.mcp().tools.get(name)!.spec.scope, name).toBe('client')
    for (const name of ['mcp-board.charter', 'mcp-board.claim', 'mcp-board.brief', 'mcp-board.task']) {
      const { tool, input } = example(name) as { tool: typeof BOARD_TOOLS[number]; input: unknown }
      expect(zod.object(INPUTS[tool]).safeParse(input).success, name).toBe(true)
      schemas.assertDef('mcp-board@1.0', `${tool.replaceAll('_', '-')}-input`, input)
    }
    expect(zod.object(INPUTS.board_claim).safeParse({ taskId: 'task-1', owner: 'lead', ttlSeconds: 5 }).success).toBe(false)
    expect(zod.object(INPUTS.board_charter).safeParse({ ...example('mcp-board.charter').input, charter: { ...CHARTER, approval: `sha256:${'1'.repeat(64)}` } }).success).toBe(false)
  })

  it('serves a task from charter to review through the tools, every output valid against its schema definition', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    const founded = await ok(call('board_charter', { projectId: 'p2', title: 'Kernel', charter: CHARTER, milestones: [{ id: 'm1', title: 'First', state: 'planned' }], clientRequestId: 'found-p2' }))
    expect(founded).toMatchObject({ projectId: 'p2', state: 'proposed', charterVersion: 1 })
    expect(await ok(call('board_charter', { projectId: 'p2', title: 'Kernel', charter: CHARTER, clientRequestId: 'found-p2' }))).toEqual(founded)
    expect(await open(ctx, 'p2')).toHaveLength(1)
    await decide(ctx, founded.approvalRequest as string, 'approved', at(1))
    await ctx.board.sweep(at(1))
    expect((await ok(call('board_projects', {}))).projects).toEqual([{ projectId: 'p2', title: 'Kernel', state: 'active', milestone: 'm1', tasks: expect.objectContaining({ proposed: 0, done: 0 }) }])

    const proposed = await ok(call('board_propose', { projectId: 'p2', title: 'Kernel v1', goal: 'Write it.', acceptance: [{ id: 'a1', statement: 'tests pass', check: 'tests' }], actionClass: 'read', milestone: 'm1', clientRequestId: 'kernel-v1' }))
    expect(proposed).toMatchObject({ state: 'proposed', revision: 0 })
    expect(await ok(call('board_propose', { projectId: 'p2', title: 'Kernel v1', goal: 'Write it.', acceptance: [{ id: 'a1', statement: 'tests pass' }], actionClass: 'read', clientRequestId: 'kernel-v1' }))).toEqual(proposed)
    const taskId = proposed.taskId as string
    await ctx.board.sweep(at(2))
    expect((await ok(call('board_tasks', { projectId: 'p2', states: ['ready'] }))).tasks).toEqual([expect.objectContaining({ taskId, state: 'ready', milestone: 'm1' })])
    expect((await ok(call('board_task', { taskId }))).task).toMatchObject({ taskId, state: 'ready' })

    const claim = await ok(call('board_claim', { taskId, owner: 'lead-session-01', ttlSeconds: 120 }))
    expect(claim).toMatchObject({ taskId, state: 'claimed', generation: 1 })
    const renewed = await ok(call('board_update', { taskId, generation: 1, note: 'halfway' }))
    expect(renewed).toMatchObject({ taskId, state: 'claimed' })
    expect(Date.parse(renewed.leaseExpiresAt as string)).toBeGreaterThanOrEqual(Date.parse(claim.leaseExpiresAt as string))
    expect((await call('board_update', { taskId, generation: 2 })).content[0]?.text).toMatch(/^stale-generation/)
    await ctx.board.start(taskId, 1, { runId: 'run-1' })
    const r = result(ctx, 'kernel')
    expect(await ok(call('board_complete', { taskId, generation: 1, artifacts: [r], subject: HEAD, files: ['src/kernel.ts'], next: 'vectorize' }))).toMatchObject({ taskId, state: 'review' })
    await ctx.board.accept(taskId, acceptance(ctx, 'accept', r))

    const brief = await ok(call('board_brief', { projectId: 'p2' }))
    expect(brief).toMatchObject({ projectId: 'p2', intent: CHARTER.intent, state: 'active', milestone: 'm1', tasks: { done: 1 }, readFirst: [{ ref: r }] })
  })

  it('claims for 600 s by default, within the leases\' own cap, and says that cap bounds a claim; it says a claimed task is started by the engine', async () => {
    const b = await boot()
    const { ctx } = b
    await active(ctx)
    const t = await ready(ctx, task('p2', 't'))
    const before = Date.now()
    const claim = await ok(caller(b)('board_claim', { taskId: t.taskId, owner: 'lead' }))
    const lease = Date.parse(claim.leaseExpiresAt as string)
    expect(lease).toBeGreaterThanOrEqual(before + 600_000)
    expect(lease).toBeLessThanOrEqual(Date.now() + 600_000)
    const spec = b.mcp().tools.get('board_claim')!.spec
    expect(spec.description).toMatch(/leases\.maxTtlMs/)
    expect(spec.description).toMatch(/started by the workflow engine/)
    expect(b.mcp().tools.get('board_complete')!.spec.description).toMatch(/cannot be completed alone today/)
  })

  it('answers questions by index, cancels as whoever calls, and refuses an invalid input without doing anything', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    await active(ctx)
    const asks = await ready(ctx, task('p2', 'asks'))
    const { generation } = await ctx.board.claim(asks.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(asks.taskId, generation, { runId: 'run-1' }, at(3))
    await ctx.board.block(asks.taskId, generation, { reason: 'question', questions: ['Band width?', 'Keep the API?'] }, at(3))
    expect((await call('board_update', { taskId: asks.taskId, answers: [{ question: 1, answer: 'yes' }] })).isError).toBe(true)
    expect((await call('board_update', { taskId: asks.taskId, answers: [{ question: 0, answer: '64' }, { question: 0, answer: '32' }] })).isError).toBe(true)
    expect(await ok(call('board_update', { taskId: asks.taskId, answers: [{ question: 1, answer: 'yes' }, { question: 0, answer: '64' }] }))).toMatchObject({ state: 'ready' })
    const answered = (await ctx.board.task(asks.taskId))!
    expect(ctx.artifacts.get(answered.lastDecision!)?.body).toMatchObject({ outcome: { detail: { answers: ['64', 'yes'] } } })

    const one = await ctx.board.propose(task('p2', 'one'), at(4))
    const two = await ctx.board.propose(task('p2', 'two'), at(4))
    expect(await ok(call('board_cancel', { taskId: one.taskId, note: 'not needed' }))).toMatchObject({ state: 'cancelled' })
    expect(await ok(call('board_cancel', { taskId: two.taskId }, 'operator'))).toMatchObject({ state: 'cancelled' })
    expect((await ctx.board.task(one.taskId))?.cancellation).toMatchObject({ reason: 'lead', note: 'not needed' })
    expect((await ctx.board.task(two.taskId))?.cancellation?.reason).toBe('operator')

    const before = await ctx.board.tasks({ projectId: 'p2' })
    const refused = await call('board_propose', { projectId: 'p2', title: 'x', goal: 'g', acceptance: [{ id: 'a1', statement: 's' }], actionClass: 'read', extra: true })
    expect(refused).toMatchObject({ isError: true })
    expect(refused.content[0]?.text).toMatch(/^invalid input, nothing done/)
    expect((await call('board_claim', { taskId: asks.taskId, owner: 'lead', ttlSeconds: 5 })).isError).toBe(true)
    expect((await call('board_task', { taskId: 'task-nope' })).content[0]?.text).toMatch(/^unknown-task/)
    expect((await call('board_tasks', { projectId: 'nope' })).content[0]?.text).toMatch(/^unknown-project/)
    expect(await ctx.board.tasks({ projectId: 'p2' })).toEqual(before)
  })

  it('pages board_tasks and board_projects: 20 by default, never more than the page bound, with a cursor it refuses when forged (INV-9)', async () => {
    const b = await boot({ board: { pageBound: 25 } })
    const { ctx } = b
    const call = caller(b)
    await active(ctx, 'p1')
    await active(ctx, 'p2')
    await active(ctx, 'p3')
    for (let i = 0; i < 30; i++) await ctx.board.propose(task('p2', `t${String(i).padStart(2, '0')}`), at(2 + i / 100))
    const first = await ok(call('board_tasks', { projectId: 'p2' }))
    expect(first.tasks).toHaveLength(20)
    const second = await ok(call('board_tasks', { projectId: 'p2', after: first.next }))
    expect(second.tasks).toHaveLength(10)
    expect(second.next).toBeUndefined()
    expect([...first.tasks, ...second.tasks].map((t: { title: string }) => t.title)).toEqual(Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, '0')}`))
    const bounded = await ok(call('board_tasks', { projectId: 'p2', limit: 100 }))
    expect(bounded.tasks).toHaveLength(25)
    expect(bounded.next).toBeDefined()
    expect((await call('board_tasks', { projectId: 'p2', after: 'forged' })).content[0]?.text).toMatch(/^invalid/)
    const projects = await ok(call('board_projects', { limit: 2 }))
    expect(projects.projects.map((p: { projectId: string }) => p.projectId)).toEqual(['p1', 'p2'])
    expect((await ok(call('board_projects', { limit: 2, after: projects.next }))).projects.map((p: { projectId: string }) => p.projectId)).toEqual(['p3'])
    expect(b.board().projectPage({ state: 'closed' })).toEqual({ items: [] })
    expect(() => b.board().taskPage({ projectId: 'p2', limit: 0 })).toThrow(BoardError)
  })
})

describe('ctx.board (store-backed): the TASKS.md projection', () => {
  it('renders one project\'s board deterministically: ids, titles, states, acceptance checkboxes, dependencies, holders, and why a task waits', async () => {
    const b = await boot()
    const { ctx } = b
    await active(ctx)
    const done = await ready(ctx, task('p2', 'Baseline'))
    let { generation } = await ctx.board.claim(done.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(done.taskId, generation, { runId: 'run-1' }, at(3))
    const r = result(ctx, 'baseline')
    await ctx.board.submit(done.taskId, generation, { artifacts: [r], subject: HEAD }, at(3))
    await ctx.board.accept(done.taskId, acceptance(ctx, 'accept', r), at(3))
    const held = await ready(ctx, task('p2', 'Kernel', { goal: 'Write the kernel.\n## Not a heading of the board', dependsOn: [done.taskId] }), at(4))
    ;({ generation } = await ctx.board.claim(held.taskId, 'lead', 600_000, at(4)))
    const asks = await ready(ctx, task('p2', 'Asks'), at(4))
    const g = (await ctx.board.claim(asks.taskId, 'lead', 600_000, at(4))).generation
    await ctx.board.start(asks.taskId, g, { runId: 'run-2' }, at(4))
    await ctx.board.block(asks.taskId, g, { reason: 'question', questions: ['Band width 64?'] }, at(4))
    const merge = await ctx.board.propose(task('p2', 'Merge', { actionClass: 'merge' }), at(4))
    await ctx.board.sweep(at(4))

    const md = await b.board().tasksMarkdown('p2')
    expect(await b.board().tasksMarkdown('p2')).toBe(md)
    await b.restartBoard()
    expect(await b.board().tasksMarkdown('p2')).toBe(md)
    expect(md).toMatch(/^<!-- TASKS\.md for project p2: a projection/)
    expect(md).toContain('# project p2')
    for (const t of [done, held, asks, merge]) expect(md).toContain(`- id: \`${t.taskId}\``)
    expect(md.indexOf('## In progress')).toBeLessThan(md.indexOf('## Waiting'))
    expect(md.indexOf('## Waiting')).toBeLessThan(md.indexOf('## Done'))
    expect(md).toContain('- state: claimed')
    expect(md).toContain(`- holder: lead (generation ${generation}, lease until ${new Date(at(4).getTime() + 600_000).toISOString()})`)
    expect(md).toContain(`- depends on: \`${done.taskId}\``)
    expect(md).toContain('- [ ] a1: tests pass (tests)')
    expect(md).toContain('- [x] a1: tests pass (tests)')
    expect(md).toMatch(/- waiting: for input \(question\) since [^\n]+\n {2}1\. Band width 64\?/)
    expect(md).toMatch(/- waiting: for approval \(approval-needed, request `apr-[^`]+`\)/)
    expect(md).toContain('> ## Not a heading of the board')
    expect(md).not.toMatch(/^## Not a heading/m)
  })

  it('lists at most projectionMaxTasks tasks, open ones first, and counts the rest (INV-9)', async () => {
    const b = await boot({ board: { projectionMaxTasks: 2 } })
    await active(b.ctx)
    const cancelled = await b.ctx.board.propose(task('p2', 'gone'), at(2))
    await b.ctx.board.cancel(cancelled.taskId, 'lead', undefined, at(2))
    await b.ctx.board.propose(task('p2', 'one'), at(3))
    await b.ctx.board.propose(task('p2', 'two'), at(3))
    const md = await b.board().tasksMarkdown('p2')
    expect(md).toContain('### one')
    expect(md).toContain('### two')
    expect(md).not.toContain('### gone')
    expect(md).toContain('1 more task(s) are not listed here (at most 2 are)')
    expect(await failureOf(b.board().tasksMarkdown('nope'))).toBe('unknown-project')
  })
})
