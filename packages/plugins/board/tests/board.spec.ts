import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Action, ApprovalRequest, NewRequest } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import { type ArtifactRef, BoardError, type BoardTask, type BudgetLine, freeRetriesOf, type Subject, type TaskInput } from '@tsuuanmi/system-board-core'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import { SchemaError, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z as zod } from 'zod'
import { FakeApprovals, POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import StoreBoard, { autoAcceptOf, type Config } from '../src/index.ts'
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
  /** Classes judged as another action, so a test can give a class a mode the conformance policies do not. */
  readonly judgeAs = new Map<Action['class'], Action>()
  private up(): void {
    if (this.down) throw new Error('the approval queue is unavailable')
  }

  override async check(action: Action) { this.up(); return super.check(this.judgeAs.get(action.class) ?? action) }
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

async function boot(options: { dir?: string; board?: Config; eventLog?: boolean } = {}): Promise<Booted> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-board-'))
  if (!options.dir) onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const base = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}), ctx.plugin(FlakyApprovals), ctx.plugin(RecordingMcp), ...(options.eventLog ? [ctx.plugin(EventLog, {})] : [])]
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
  onTestFinished(stop)
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
/** An `acceptance` decision on `taskId`'s result `on` with `subject` (default HEAD), reporting `checks`. */
const acceptance = (ctx: Context, option: 'accept' | 'reject', taskId: string, on: ArtifactRef, subject: Subject = HEAD, checks?: Action['checks']): ArtifactRef => ctx.artifacts.recordDecision({
  decisionType: 'acceptance', question: `Does ${on} satisfy the criteria?`, inputs: [on],
  candidates: [{ option: 'accept', selected: option === 'accept', reasons: ['checked'] }, { option: 'reject', selected: option === 'reject', reasons: ['checked'] }],
  decider: { type: 'rule', id: 'acceptance.test', version: '1' }, outcome: { option, detail: { taskId, subject, ...(checks ? { checks } : {}) } }, deterministic: true,
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

  it('never readies or cancels a lost or blocked run on the policy alone: with no ask verdict it waits for input (S6, INV-4)', async () => {
    const { ctx, approvals } = await boot()
    await active(ctx)
    // remediation judged auto (as the studio's read rule), funding forbidden (as p1's merge rule).
    approvals().judgeAs.set('remediation', { class: 'read' })
    approvals().judgeAs.set('funding', { class: 'merge', projectId: 'p1' })
    const lost = await ready(ctx, task('p2', 'lost'))
    const held = await ctx.board.claim(lost.taskId, 'lead', 60_000, at(3))
    await ctx.board.start(lost.taskId, held.generation, { runId: 'run-1' }, at(3))
    await ctx.board.sweep(at(10))
    const waiting = (await ctx.board.task(lost.taskId))!
    expect(waiting).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, run: { runId: 'run-1' }, attempts: { count: 1 } })
    expect(ctx.artifacts.get(waiting.lastDecision!)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'waiting-for-input', detail: { reason: 'reconciliation-failed', mode: 'auto' } } })
    expect(await failureOf(ctx.board.claim(lost.taskId, 'other', 60_000, at(10)))).toBe('invalid-transition')

    const spent = await ready(ctx, task('p2', 'spent'), at(10))
    const claim = await ctx.board.claim(spent.taskId, 'lead', 600_000, at(10))
    await ctx.board.start(spent.taskId, claim.generation, { runId: 'run-2' }, at(10))
    expect(await ctx.board.block(spent.taskId, claim.generation, { reason: 'budget-spent' }, at(11))).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, run: { runId: 'run-2' } })
    expect(await open(ctx, 'p2')).toEqual([])
  })

  it('asks again before the attempt after a lost run, an answered question, or a rejected review, and withdraws a request whose move could not commit (S9)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const approveCurrent = async (taskId: string, when: Date): Promise<string> => {
      const requestId = (await ctx.board.task(taskId))!.waiting!.approvalRequest!
      await decide(ctx, requestId, 'approved', when)
      await ctx.board.sweep(when)
      return requestId
    }
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge', maxAttempts: 4 }), at(2))
    await ctx.board.sweep(at(2))
    const asked = [await approveCurrent(merge.taskId, at(2))]

    // A lost run: the operator approves going on (remediation), then the class is asked about again.
    let claim = await ctx.board.claim(merge.taskId, 'lead', 60_000, at(3))
    await ctx.board.start(merge.taskId, claim.generation, { runId: 'run-1' }, at(3))
    await ctx.board.sweep(at(10))
    asked.push(await approveCurrent(merge.taskId, at(10)))
    const regated = (await ctx.board.task(merge.taskId))!
    expect(regated).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' }, attempts: { count: 1 } })
    expect(ctx.artifacts.get(regated.lastDecision!)?.body).toMatchObject({ decisionType: 'board', inputs: expect.arrayContaining([(await ctx.approvals.get(asked[1]!))!.resolution!.decision]) })
    asked.push(await approveCurrent(merge.taskId, at(11)))
    expect(await ctx.board.task(merge.taskId)).toMatchObject({ state: 'ready' })

    // A question: answering it continues the attempt that asked (T291), which is asked about too, on its own subject.
    claim = await ctx.board.claim(merge.taskId, 'lead', 600_000, at(12))
    await ctx.board.start(merge.taskId, claim.generation, { runId: 'run-2' }, at(12))
    await ctx.board.block(merge.taskId, claim.generation, { reason: 'question', questions: ['Squash?'] }, at(12))
    const answered = await ctx.board.answer(merge.taskId, ['yes'], at(13))
    expect(answered).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' }, attempts: { count: 2 } })
    expect(ctx.artifacts.get(answered.lastDecision!)?.body).toMatchObject({ outcome: { option: 'waiting-for-approval', detail: { answers: ['yes'], attempt: 2, continues: true } } })
    asked.push(await approveCurrent(merge.taskId, at(13)))

    // A rejected review whose move loses a race: the request it opened is withdrawn. The run is attempt 2 continued.
    claim = await ctx.board.claim(merge.taskId, 'lead', 600_000, at(14))
    expect(await ctx.board.start(merge.taskId, claim.generation, { runId: 'run-3' }, at(14))).toMatchObject({ attempts: { count: 2 } })
    const r = result(ctx, 'merged')
    await ctx.board.submit(merge.taskId, claim.generation, { artifacts: [r], subject: HEAD }, at(14))
    const rejecting = ctx.board.accept(merge.taskId, acceptance(ctx, 'reject', merge.taskId, r), at(15))
    await ctx.board.renew(merge.taskId, claim.generation, 600_000, at(15))
    expect(await failureOf(rejecting)).toBe('conflict')
    expect(await open(ctx, 'p2')).toEqual([])
    const rejected = await ctx.board.accept(merge.taskId, acceptance(ctx, 'reject', merge.taskId, r), at(15))
    expect(rejected).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' }, attempts: { count: 2 } })
    asked.push(rejected.waiting!.approvalRequest!)
    const subjects = await Promise.all(asked.map(async (id) => (await ctx.approvals.get(id))!.subject))
    expect(new Set(subjects.map((x) => `${x.ref}#${x.version}`)).size).toBe(asked.length)
    expect(subjects.at(-1)).toMatchObject({ ref: `board-task:${merge.taskId}:attempt:2`, version: 'approval-needed' })
    // The answered question's request named the wait it answered, so its approval never covers the later gate of the same attempt.
    expect(subjects.at(-2)!.ref).toMatch(new RegExp(`^board-task:${merge.taskId}:attempt:2:answered:`))
  })

  it('founds a project under a client request key at an id derived from it, so a retry after a crash adopts the request, also one approved meanwhile (M2, M6)', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    // What a board that crashed after asking, before recording, leaves: an open request on the derived project's charter.
    const crashed = await ok(call('board_charter', { title: 'Kernel', charter: CHARTER, clientRequestId: 'found-kernel' }))
    const projectId = crashed.projectId as string
    expect(projectId).toMatch(/^proj-[0-9a-f]{24}$/)
    ctx.store.db.prepare('DELETE FROM board_client_requests').run()
    ctx.store.db.prepare('DELETE FROM board_projects WHERE project_id = ?').run(projectId)
    await decide(ctx, crashed.approvalRequest as string, 'approved', at(1))
    const retried = await ok(call('board_charter', { title: 'Kernel', charter: CHARTER, clientRequestId: 'found-kernel' }))
    expect(retried).toMatchObject({ projectId, approvalRequest: crashed.approvalRequest, charterVersion: 1 })
    expect(await ctx.approvals.list({ projectId, states: ['open', 'batched', 'approved'] })).toHaveLength(1)
    await ctx.board.sweep(new Date())
    expect(await ctx.board.project(projectId)).toMatchObject({ state: 'active' })

    // A retried amendment reports the version that call asked about, not the retry's input.
    const amended = await ok(call('board_charter', { projectId, title: 'Kernel', charter: { ...CHARTER, version: 2 }, clientRequestId: 'amend-kernel' }))
    expect(amended.charterVersion).toBe(2)
    expect(await ok(call('board_charter', { projectId, title: 'Kernel', charter: { ...CHARTER, version: 7 }, clientRequestId: 'amend-kernel' }))).toEqual(amended)
  })

  it('refuses a result on another subject than the one the task writes (M4, INV-15)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const branch: Subject = { type: 'git-head', ref: 'refs/heads/kernel' }
    const t = await ready(ctx, task('p2', 'w', { writes: branch }))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
    const r = result(ctx, 'kernel')
    expect(await failureOf(ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: { type: 'git-head', ref: 'refs/heads/main', version: 'abc' } }, at(3.5)))).toBe('invalid')
    await ctx.board.sweep(at(10))
    const elsewhere = { type: 'git-head' as const, ref: 'refs/heads/main', version: 'abc' }
    expect(await failureOf(ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: elsewhere }, acceptance: acceptance(ctx, 'accept', t.taskId, r, elsewhere) }, at(11)))).toBe('invalid')
    const on = { ...branch, version: 'abc' }
    expect(await ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: on }, acceptance: acceptance(ctx, 'accept', t.taskId, r, on) }, at(11))).toMatchObject({ state: 'done' })
  })

  it('takes no answers for a rejected, retries-spent, or review-expired wait: each only expires to cancelled (S4)', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    await active(ctx)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
    await ctx.board.sweep(at(2))
    await decide(ctx, (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!, 'rejected', at(3))
    await ctx.board.sweep(at(3))
    const rejected = (await ctx.board.task(merge.taskId))!
    expect(rejected.waiting?.reason).toBe('rejected')
    const refused = await call('board_update', { taskId: merge.taskId, answers: [{ question: 0, answer: 'go on' }] })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/^invalid: .*a rejected wait takes no answers and only expires/)
    expect(await ctx.board.task(merge.taskId)).toEqual(rejected)
    await ctx.board.sweep(new Date(Date.parse(rejected.waiting!.expiresAt)))
    expect(await ctx.board.task(merge.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'input-expired' } })
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
    expect(await ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: acceptance(ctx, 'accept', t.taskId, r) }, at(11)))
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

  it('asks again once after a policy change withdrew the request a wait was on: it adopts the request a crash left between asking again and recording', async () => {
    const { ctx, approvals } = await boot()
    await active(ctx)
    const spend = await ctx.board.propose(task('p2', 'spend', { actionClass: 'spend' }), at(2))
    await ctx.board.sweep(at(2))
    const withdrawn = (await ctx.board.task(spend.taskId))!.waiting!.approvalRequest!
    const [studio, ...rest] = POLICIES
    expect(approvals().reload([{ ...studio!, version: studio!.version + 1 }, ...rest], at(3)).map((r) => r.requestId)).toEqual([withdrawn])
    // What a board that crashed after asking again, before committing, leaves in the queue.
    const verdict = await ctx.approvals.check({ class: 'spend', projectId: 'p2' })
    const orphan = await ctx.approvals.request({
      subject: { type: 'content', ref: `board-task:${spend.taskId}:attempt:0`, version: 'approval-needed' }, action: { class: 'spend', summary: 'approval-needed: spend' },
      requester: { component: 'board', projectId: 'p2', taskId: spend.taskId }, verdict, classification: 'operator-shared',
    }, at(3))
    await ctx.board.sweep(at(3))
    expect(await ctx.board.task(spend.taskId)).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed', approvalRequest: orphan.requestId } })
    expect((await open(ctx, 'p2')).map((r) => r.requestId)).toEqual([orphan.requestId])
  })

  it('asks again on an answered question\'s own subject after a policy change, so a later answer on the same attempt never adopts its approval (INV-2, T291)', async () => {
    const { ctx, approvals } = await boot()
    await active(ctx)
    const spend = await ctx.board.propose(task('p2', 'spend', { actionClass: 'spend' }), at(2))
    await ctx.board.sweep(at(2))
    await decide(ctx, (await ctx.board.task(spend.taskId))!.waiting!.approvalRequest!, 'approved', at(2))
    await ctx.board.sweep(at(2))
    const [studio, ...rest] = POLICIES
    let version = studio!.version
    const reload = (when: Date) => approvals().reload([{ ...studio!, version: ++version }, ...rest], when)
    const answeredOnce = async (runId: string, question: string, when: number): Promise<{ withdrawn: string; asked: string }> => {
      const { generation } = await ctx.board.claim(spend.taskId, 'lead', 600_000, at(when))
      await ctx.board.start(spend.taskId, generation, { runId }, at(when))
      await ctx.board.block(spend.taskId, generation, { reason: 'question', questions: [question] }, at(when + 0.5))
      const answered = await ctx.board.answer(spend.taskId, ['yes'], at(when + 1))
      const withdrawn = answered.waiting!.approvalRequest!
      expect(reload(at(when + 1.5)).map((r) => r.requestId)).toEqual([withdrawn])
      await ctx.board.sweep(at(when + 1.5))
      const regated = (await ctx.board.task(spend.taskId))!
      expect(regated).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' }, attempts: { count: 1 } })
      return { withdrawn, asked: regated.waiting!.approvalRequest! }
    }
    // The first answer's gate, withdrawn by a policy change, is asked again on its own subject, and approved.
    const first = await answeredOnce('run-1', 'Which band?', 3)
    const [was, again] = await Promise.all([ctx.approvals.get(first.withdrawn), ctx.approvals.get(first.asked)])
    expect(again!.subject.ref).toMatch(new RegExp(`^board-task:${spend.taskId}:attempt:1:answered:`))
    expect(again!.subject).toEqual(was!.subject)
    await decide(ctx, first.asked, 'approved', at(5))
    await ctx.board.sweep(at(5))
    expect(await ctx.board.task(spend.taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    // A second answer on the same attempt, withdrawn and asked again too: a new request on its own subject, never the first one's approval.
    const second = await answeredOnce('run-1b', 'Which width?', 6)
    expect(second.asked).not.toBe(first.asked)
    const asked = (await ctx.approvals.get(second.asked))!
    expect(asked.state).toBe('open')
    expect(asked.subject.ref).not.toBe(again!.subject.ref)
  })

  it('withdraws the request it asked again on a policy change when the task changed meanwhile, and leaves a wait the board withdrew itself as it is (S7)', async () => {
    const { ctx, approvals } = await boot()
    await active(ctx)
    const spend = await ctx.board.propose(task('p2', 'spend', { actionClass: 'spend' }), at(2))
    await ctx.board.sweep(at(2))
    const [studio, ...rest] = POLICIES
    approvals().reload([{ ...studio!, version: studio!.version + 1 }, ...rest], at(3))
    // The sweep stops at its first await on the queue; the lead cancels the task meanwhile.
    const sweeping = ctx.board.sweep(at(3))
    await ctx.board.cancel(spend.taskId, 'lead', undefined, at(3))
    expect((await sweeping).tasks).toEqual([])
    expect(await ctx.board.task(spend.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'lead' } })
    expect(await open(ctx, 'p2')).toEqual([])
    // The one the policy change withdrew, and the one the sweep asked again and then withdrew.
    expect((await ctx.approvals.list({ projectId: 'p2', states: ['rejected'] })).filter((r) => r.requester.taskId === spend.taskId)).toHaveLength(2)

    // A lost run whose request the board itself withdrew (a crash between its move and the withdrawal) keeps waiting for its owner.
    const t = await ready(ctx, task('p2', 't'), at(4))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(4))
    await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(4))
    await ctx.board.sweep(at(10))
    const lost = (await ctx.board.task(t.taskId))!
    await ctx.approvals.withdraw(lost.waiting!.approvalRequest!, at(11))
    expect(await ctx.board.sweep(at(11))).toEqual({ tasks: [], projects: [] })
    expect(await ctx.board.task(t.taskId)).toEqual(lost)
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
    expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, result(ctx, 'another')), at(5)))).toBe('invalid')
    const odd = ctx.artifacts.recordDecision({
      decisionType: 'acceptance', question: 'q', inputs: [mine], candidates: [{ option: 'maybe', selected: true, reasons: ['unsure'] }],
      decider: { type: 'rule', id: 'acceptance.test', version: '1' }, outcome: { option: 'maybe', detail: { taskId: t.taskId, subject: HEAD } }, deterministic: true,
    }, { producer: { type: 'policy', ref: 'test' } }).id as ArtifactRef
    expect(await failureOf(ctx.board.accept(t.taskId, odd, at(5)))).toBe('invalid')
    expect((await ctx.board.task(t.taskId))?.state).toBe('review')
    expect(await failureOf(ctx.board.submit(t.taskId, generation, { artifacts: [`sha256:${'9'.repeat(64)}`], subject: HEAD }, at(5)))).toBe('invalid-transition')
    expect(await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, mine), at(5))).toMatchObject({ state: 'done' })
  })

  it('records the required checks still to run on an auto task\'s readiness decision, and asks the policy with the checks an acceptance reports (S3)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const branch: Subject = { type: 'git-head', ref: 'refs/heads/kernel', version: 'abc123' }
    const t = await ready(ctx, task('p2', 'w', { actionClass: 'workspace-write', writes: { type: 'git-head', ref: 'refs/heads/kernel' } }))
    expect(ctx.artifacts.get(t.lastDecision!)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'ready', detail: { mode: 'auto', pendingChecks: ['tests', 'lint'] } } })
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
    const r = result(ctx, 'kernel')
    await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: branch }, at(4))
    // Lint not reported: only the operator accepts it now, so the board holds the review for the operator, lease released.
    const first = acceptance(ctx, 'accept', t.taskId, r, branch, { tests: true })
    const held = await ctx.board.accept(t.taskId, first, at(5))
    expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['lint'] } })
    expect(held.holder).toBeUndefined()
    expect(ctx.leases.current(`board-task:${t.taskId}`)).toBeUndefined()
    expect(ctx.artifacts.get(held.lastDecision!)?.body).toMatchObject({ decisionType: 'board', inputs: expect.arrayContaining([first]), outcome: { option: 'operator-review', detail: { pendingChecks: ['lint'] } } })
    const refused = await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, r, branch, { tests: true, lint: false }), at(5)).catch((e: unknown) => e as BoardError)
    expect(refused).toMatchObject({ failure: 'invalid', message: expect.stringMatching(/the review is the operator's/) })
    expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, r, branch, { tests: 'yes' } as unknown as Action['checks']), at(5)))).toBe('invalid')
    expect(await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, r, branch, { tests: true, lint: true }), at(5))).toMatchObject({ state: 'done' })
  })

  it('announces a review held for the operator, and its end, as events in the move\'s transaction, so a surface tells the operator before the hold expires (T99 D6)', async () => {
    const { ctx } = await boot({ eventLog: true })
    await active(ctx)
    const branch: Subject = { type: 'git-head', ref: 'refs/heads/kernel', version: 'abc123' }
    const hold = async (title: string, ref: string): Promise<{ taskId: string; r: ArtifactRef; held: BoardTask }> => {
      const t = await ready(ctx, task('p2', title, { actionClass: 'workspace-write', writes: { type: 'git-head', ref } }))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: `run-${title}` }, at(3))
      const r = result(ctx, title)
      await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: { ...branch, ref } }, at(4))
      const held = await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, r, { ...branch, ref }, { tests: true }), at(5))
      return { taskId: t.taskId, r, held }
    }
    const events = (type: string) => ctx.eventLog.query({ type, limit: 100 })
    const first = await hold('first', 'refs/heads/first')
    expect(events('board.review.held').map((e) => e.data)).toEqual([{ taskId: first.taskId, projectId: 'p2', expiresAt: first.held.waiting!.expiresAt, pendingChecks: ['lint'], runId: 'run-first' }])
    expect(events('board.review.held')[0]!.decision).toBe(first.held.lastDecision)
    // A digest attached under the hold is no new hold; the operator's acceptance ends it.
    expect(events('board.review.ended')).toEqual([])
    await ctx.board.accept(first.taskId, acceptance(ctx, 'accept', first.taskId, first.r, { ...branch, ref: 'refs/heads/first' }, { tests: true, lint: true }), at(6))
    expect(events('board.review.ended').map((e) => e.data)).toEqual([{ taskId: first.taskId, projectId: 'p2', state: 'done' }])
    // A hold nobody decides ends at its expiry: the task waits for input.
    const second = await hold('second', 'refs/heads/second')
    await ctx.board.sweep(new Date(Date.parse(second.held.waiting!.expiresAt) + 1000))
    expect(events('board.review.ended').map((e) => e.data).at(-1)).toEqual({ taskId: second.taskId, projectId: 'p2', state: 'waiting-for-input', reason: 'review-expired' })
    expect(events('board.review.held')).toHaveLength(2)
  })

  describe('the auto-accept rule (board.autoAccept, D80, ADR-0067)', () => {
    const TREE: Subject = { type: 'git-head', ref: 'c0ffee', version: 'sha256:tree' }
    const AUTO: Config = { autoAccept: { projects: ['p2'], branches: ['dev'] } }
    /** An `assessment@1.0` of `on`, as the engine's exact-subject review stores it. */
    const assessed = (ctx: Context, verdict: 'approve' | 'changes-requested', blocking = 0, on: Subject = TREE): ArtifactRef => ctx.artifacts.put({
      kind: 'assessment', bodySchema: 'assessment@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
      body: { schema: 'assessment@1.0', subject: on, verdict, findings: Array.from({ length: blocking }, (_, i) => ({ severity: 'blocking', title: `defect ${i + 1}` })) },
    }).id as ArtifactRef
    /** A `check-run@1.0` record of `on`, as the agents source records the run's required checks. */
    const checkRun = (ctx: Context, outcomes: Record<string, 'passed' | 'failed' | 'error'>, on: Subject = TREE): ArtifactRef => ctx.artifacts.put({
      kind: 'evidence', bodySchema: 'check-run@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'agents' },
      body: {
        schema: 'check-run@1.0', runId: 'run-1', repository: '/repo', workspace: '/repo/wt', subject: on, setup: `sha256:${'5'.repeat(64)}`,
        checks: Object.entries(outcomes).map(([check, outcome]) => ({ check, outcome, ...(outcome === 'error' ? {} : { exitCode: outcome === 'passed' ? 0 : 1 }), reason: outcome })),
      },
    }).id as ArtifactRef
    /** The engine's `acceptance` decision (`workflow.task-acceptance` 3): its checks, its last review, its check-run record, and where it lands. */
    const engineAcceptance = (ctx: Context, taskId: string, on: ArtifactRef, named: { checks?: Action['checks']; review?: ArtifactRef; cycle?: number; evidence?: ArtifactRef; results?: Array<Record<string, unknown>>; branch?: string }): ArtifactRef => ctx.artifacts.recordDecision({
      decisionType: 'acceptance', question: `Does the run's result complete its attempt of ${taskId}?`, inputs: [on, ...(named.evidence ? [named.evidence] : []), ...(named.review ? [named.review] : [])],
      candidates: [{ option: 'accept', selected: true, reasons: ['every step was accepted'] }, { option: 'reject', selected: false, reasons: ['not reject: no check failed'] }],
      decider: { type: 'rule', id: 'workflow.task-acceptance', version: '3' },
      outcome: {
        option: 'accept',
        detail: {
          taskId, subject: TREE, checks: named.checks ?? {},
          ...(named.review ? { review: { assessment: named.review, cycle: named.cycle ?? 1, maxCycles: 3 } } : {}),
          ...(named.evidence ? { checkRun: { evidence: named.evidence, ...(named.results ? { results: named.results } : {}) } } : {}),
          ...(named.branch ? { landing: { repository: '/repo', branch: named.branch } } : {}),
        },
      },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' } }).id as ArtifactRef
    /** A `workspace-write` task of `projectId` in review on a result on TREE. */
    const inReview = async (ctx: Context, title: string, projectId = 'p2'): Promise<{ taskId: string; r: ArtifactRef }> => {
      const t = await ready(ctx, task(projectId, title, { actionClass: 'workspace-write' }))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: `run-${title}` }, at(3))
      const r = result(ctx, title)
      await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: TREE }, at(4))
      return { taskId: t.taskId, r }
    }
    const autoReasons = (ctx: Context, held: BoardTask): string[] => {
      const body = ctx.artifacts.get(held.lastDecision!)?.body as { outcome?: { detail?: { autoAccept?: string[] } } } | undefined
      return body?.outcome?.detail?.autoAccept ?? []
    }

    it('accepts a result whose last review approved it and whose required checks passed on it, landing on a listed branch, on a decision naming the review and the check-run record (INV-13)', async () => {
      const { ctx } = await boot({ board: AUTO, eventLog: true })
      await active(ctx)
      const { taskId, r } = await inReview(ctx, 'lands')
      const review = assessed(ctx, 'approve')
      const evidence = checkRun(ctx, { tests: 'passed', lint: 'passed' })
      const accepting = engineAcceptance(ctx, taskId, r, { checks: { review: true, tests: true, lint: true }, review, evidence, branch: 'dev' })
      const done = await ctx.board.accept(taskId, accepting, at(5))
      expect(done).toMatchObject({ state: 'done', result: { acceptance: accepting, subject: TREE } })
      expect(done.waiting).toBeUndefined()
      expect(ctx.artifacts.get(done.lastDecision!)?.body).toMatchObject({
        decisionType: 'board', decider: { type: 'rule', id: 'board.auto-accept' }, inputs: expect.arrayContaining([accepting, review, evidence]),
        outcome: { option: 'done', detail: { reason: 'auto-accept', acceptance: accepting, review, checkRun: evidence, checks: ['tests', 'lint'], branch: 'dev' } },
      })
      expect(ctx.eventLog.query({ type: 'board.review.held', limit: 10 })).toEqual([])
    })

    it('holds for the operator, with the reason, a result whose last review left a blocking finding at the cycle bound', async () => {
      const { ctx } = await boot({ board: AUTO })
      await active(ctx)
      const evidence = checkRun(ctx, { tests: 'passed', lint: 'passed' })
      const checks = { tests: true, lint: true }
      const bound = await inReview(ctx, 'bound')
      const held = await ctx.board.accept(bound.taskId, engineAcceptance(ctx, bound.taskId, bound.r, { checks, review: assessed(ctx, 'changes-requested', 1), cycle: 3, evidence, branch: 'dev' }), at(5))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: [] } })
      expect(autoReasons(ctx, held)).toEqual([expect.stringMatching(/did not approve \(changes-requested\) and left 1 blocking finding\(s\) \(review cycle 3 of 3, the cycle bound\)$/)])
      // An approval that still lists a blocking finding is no approval either; nor is one with no review at all, or of another tree.
      const left = await inReview(ctx, 'left')
      expect(autoReasons(ctx, await ctx.board.accept(left.taskId, engineAcceptance(ctx, left.taskId, left.r, { checks, review: assessed(ctx, 'approve', 2), evidence, branch: 'dev' }), at(5)))).toEqual([expect.stringMatching(/left 2 blocking finding/)])
      const none = await inReview(ctx, 'none')
      expect(autoReasons(ctx, await ctx.board.accept(none.taskId, engineAcceptance(ctx, none.taskId, none.r, { checks, evidence, branch: 'dev' }), at(5)))).toEqual([expect.stringMatching(/names no review of the run/)])
      const other = await inReview(ctx, 'other')
      expect(autoReasons(ctx, await ctx.board.accept(other.taskId, engineAcceptance(ctx, other.taskId, other.r, { checks, review: assessed(ctx, 'approve', 0, { ...TREE, version: 'sha256:older' }), evidence, branch: 'dev' }), at(5))))
        .toEqual([expect.stringMatching(/is not of the result's exact tree/)])
      // Held, only the operator's acceptance accepts it now: another of the run owner's the rule does not apply to is refused.
      const again = await ctx.board.accept(bound.taskId, engineAcceptance(ctx, bound.taskId, bound.r, { checks, review: assessed(ctx, 'changes-requested', 1), cycle: 3, evidence, branch: 'dev' }), at(6)).catch((e: unknown) => e as BoardError)
      expect(again).toMatchObject({ failure: 'invalid', message: expect.stringMatching(/the auto-accept rule does not apply .*: the review is the operator's$/) })
      const operator = ctx.artifacts.recordDecision({
        decisionType: 'acceptance', question: 'Accept it?', inputs: [bound.r], candidates: [{ option: 'accept', selected: true, reasons: ['the operator accepts it'] }],
        decider: { type: 'operator', id: 'operator.review', version: '1' }, outcome: { option: 'accept', detail: { taskId: bound.taskId, subject: TREE } }, deterministic: false,
      }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
      expect(await ctx.board.accept(bound.taskId, operator, at(6))).toMatchObject({ state: 'done', lastDecision: operator })
    })

    it('never holds a result for nits, a pre-existing finding, or an important finding its verifier rejected; holds it for a confirmed one (ADR-0075)', async () => {
      const { ctx } = await boot({ board: AUTO })
      await active(ctx)
      const evidence = checkRun(ctx, { tests: 'passed', lint: 'passed' })
      const checks = { review: true, tests: true, lint: true }
      /** An `assessment@1.1`, as the engine stores a review's verified findings. */
      const verified = (verdict: 'approve' | 'changes-requested', findings: Array<Record<string, unknown>>): ArtifactRef => ctx.artifacts.put({
        kind: 'assessment', bodySchema: 'assessment@1.1', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
        body: { schema: 'assessment@1.1', subject: TREE, verdict, findings, summary: 'counted' },
      }).id as ArtifactRef
      const vote = (v: string) => ({ vote: v, reason: `scripted ${v}`, node: 'review:1:verify' })
      const nits = await inReview(ctx, 'nits')
      const review = verified('approve', [
        { id: 'f1', severity: 'nit', title: 'rename x' }, { id: 'f2', severity: 'nit', title: 'wording' },
        { id: 'f3', severity: 'pre-existing', title: 'sub() subtracts wrong', file: 'calc.py', line: 4, evidence: 'line 4' },
        { id: 'f4', severity: 'important', title: 'off by one', file: 'calc.py', line: 2, evidence: 'line 2', verification: vote('reject') },
      ])
      expect(await ctx.board.accept(nits.taskId, engineAcceptance(ctx, nits.taskId, nits.r, { checks, review, evidence, branch: 'dev' }), at(5))).toMatchObject({ state: 'done' })
      const confirmed = await inReview(ctx, 'confirmed')
      const blocking = verified('changes-requested', [{ id: 'f1', severity: 'important', title: 'off by one', file: 'calc.py', line: 2, evidence: 'line 2', verification: vote('confirm') }])
      const held = await ctx.board.accept(confirmed.taskId, engineAcceptance(ctx, confirmed.taskId, confirmed.r, { checks, review: blocking, cycle: 3, evidence, branch: 'dev' }), at(5))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
      expect(autoReasons(ctx, held)).toEqual([expect.stringMatching(/did not approve \(changes-requested\) and left 1 blocking finding\(s\)/)])
    })

    it('holds a result with a required check pending or failed, and one whose check-run record does not show it passed on that tree', async () => {
      const { ctx } = await boot({ board: AUTO })
      await active(ctx)
      const review = assessed(ctx, 'approve')
      // Pending: lint did not run to an exit code, so the policy's own hold stands.
      const pending = await inReview(ctx, 'pending')
      expect(await ctx.board.accept(pending.taskId, engineAcceptance(ctx, pending.taskId, pending.r, { checks: { review: true, tests: true }, review, evidence: checkRun(ctx, { tests: 'passed', lint: 'error' }), branch: 'dev' }), at(5)))
        .toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['lint'] } })
      // Failed, though the decision says otherwise: the record decides, never the decision's own account.
      const failed = await inReview(ctx, 'failed')
      const held = await ctx.board.accept(failed.taskId, engineAcceptance(ctx, failed.taskId, failed.r, { checks: { review: true, tests: true, lint: true }, review, evidence: checkRun(ctx, { tests: 'passed', lint: 'failed' }), branch: 'dev' }), at(5))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
      expect(autoReasons(ctx, held)).toEqual([expect.stringMatching(/does not show lint passed$/)])
      // Passed on another tree, or with no record at all.
      const elsewhere = await inReview(ctx, 'elsewhere')
      expect(autoReasons(ctx, await ctx.board.accept(elsewhere.taskId, engineAcceptance(ctx, elsewhere.taskId, elsewhere.r, { checks: { tests: true, lint: true }, review, evidence: checkRun(ctx, { tests: 'passed', lint: 'passed' }, { ...TREE, version: 'sha256:older' }), branch: 'dev' }), at(5))))
        .toEqual([expect.stringMatching(/is not of the result's exact tree/)])
      const unrecorded = await inReview(ctx, 'unrecorded')
      expect(autoReasons(ctx, await ctx.board.accept(unrecorded.taskId, engineAcceptance(ctx, unrecorded.taskId, unrecorded.r, { checks: { tests: true, lint: true }, review, branch: 'dev' }), at(5))))
        .toEqual([expect.stringMatching(/have no check-run record among its inputs/)])
    })

    describe('the circuit breaker (D93, ADR-0067 amendment)', () => {
      const day = (n: number): Date => at(n * 24 * 60)
      const booted = async (board: Config = AUTO) => {
        const b = await boot({ board })
        const { ctx } = b
        await active(ctx)
        const review = assessed(ctx, 'approve')
        const evidence = checkRun(ctx, { tests: 'passed', lint: 'passed' })
        /** A result the rule accepts on its own, or the task held when the rule does not apply. */
        const accepted = async (title: string): Promise<BoardTask> => {
          const t = await inReview(ctx, title)
          return ctx.board.accept(t.taskId, engineAcceptance(ctx, t.taskId, t.r, { checks: { review: true, tests: true, lint: true }, review, evidence, branch: 'dev' }), at(5))
        }
        return { b, ctx, accepted }
      }

      it('trips at two escaped defects of auto-accepted results in 7 days, on a decision naming the escapes it counted, and holds the next result for the operator with the reason', async () => {
        const { ctx, accepted } = await booted()
        const [a, b, c] = [await accepted('a'), await accepted('b'), await accepted('c')]
        expect([a.state, b.state, c.state]).toEqual(['done', 'done', 'done'])
        const first = await ctx.board.recordEscape!({ taskId: a.taskId, by: 'lead', note: 'the fix named npm_config_ only' }, day(1))
        expect(first.breaker).toBeUndefined()
        expect(await ctx.board.breakers!('p2', day(1))).toEqual([])
        // A second escape 6 days later is inside the window of the first: the line (2 in 7 days) is reached.
        const second = await ctx.board.recordEscape!({ taskId: b.taskId, by: 'operator', note: 'the report channel cannot be reopened' }, day(7))
        expect(second.breaker).toMatchObject({ state: 'tripped', projectId: 'p2', branch: 'dev', line: { escapes: 2, days: 7 }, trippedAt: day(7).toISOString(), now: { counted: 2, lineHolds: false } })
        expect(second.breaker!.escapes.map((e) => [e.taskId, e.recordedBy])).toEqual([[a.taskId, 'lead'], [b.taskId, 'operator']])
        const decision = ctx.artifacts.get(second.breaker!.decision)?.body as { decisionType: string; decider: { id: string }; inputs: string[]; outcome: { option: string; detail: { escapes: Array<{ taskId: string; note: string }> } } }
        expect(decision).toMatchObject({ decisionType: 'board', decider: { id: 'board.auto-accept-breaker' }, outcome: { option: 'auto-accept off' } })
        expect(decision.outcome.detail.escapes.map((e) => e.taskId)).toEqual([a.taskId, b.taskId])
        expect(decision.inputs).toEqual(expect.arrayContaining([a.lastDecision, b.lastDecision]))
        // Auto-accept for the project and branch is off: the next result is held, saying why.
        const held = await accepted('d')
        expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
        expect(autoReasons(ctx, held)).toEqual([expect.stringMatching(/the auto-accept breaker is tripped for p2 on dev since .*: 2 escaped defect\(s\) counted \(decision .*only the operator or the lead turns it on again/)])
        // Recording a third does not trip it twice.
        expect((await ctx.board.recordEscape!({ taskId: c.taskId, by: 'lead', note: 'a third' }, day(7))).breaker).toBeUndefined()
        expect(await ctx.board.breakers!('p2', day(7))).toHaveLength(1)
        expect((await ctx.board.escapes!('p2')).map((e) => e.taskId)).toEqual([a.taskId, b.taskId, c.taskId])
      })

      it('does not trip on escapes further apart than the window, or on a task the rule did not accept, or twice for one task', async () => {
        const { ctx, accepted } = await booted()
        const [a, b] = [await accepted('a'), await accepted('b')]
        await ctx.board.recordEscape!({ taskId: a.taskId, by: 'lead', note: 'one' }, day(1))
        expect((await ctx.board.recordEscape!({ taskId: b.taskId, by: 'lead', note: 'two, 8 days later' }, day(9))).breaker).toBeUndefined()
        expect(await ctx.board.breakers!('p2', day(9))).toEqual([])
        await expect(ctx.board.recordEscape!({ taskId: a.taskId, by: 'lead', note: 'again' }, day(9))).rejects.toMatchObject({ failure: 'invalid', message: expect.stringMatching(/already recorded/) })
        const held = await inReview(ctx, 'held')
        await expect(ctx.board.recordEscape!({ taskId: held.taskId, by: 'lead', note: 'not accepted' }, day(9))).rejects.toMatchObject({ failure: 'invalid', message: expect.stringMatching(/was not accepted by the auto-accept rule/) })
        await expect(ctx.board.recordEscape!({ taskId: held.taskId, by: 'agent' as 'lead', note: 'x' }, day(9))).rejects.toMatchObject({ failure: 'invalid' })
      })

      it('never turns itself on again: not with time, not on a sweep; the operator or the lead does, once the line holds, on a decision naming the trip', async () => {
        const { ctx, accepted } = await booted()
        const [a, b] = [await accepted('a'), await accepted('b')]
        await ctx.board.recordEscape!({ taskId: a.taskId, by: 'lead', note: 'one' }, day(1))
        const { breaker } = await ctx.board.recordEscape!({ taskId: b.taskId, by: 'lead', note: 'two' }, day(2))
        // Sixty days on and a sweep later the line holds, and auto-accept is still off.
        await ctx.board.sweep(day(60))
        expect(await ctx.board.breakers!('p2', day(60))).toMatchObject([{ breakerId: breaker!.breakerId, state: 'tripped', now: { counted: 0, lineHolds: true } }])
        expect(await accepted('after-sweep')).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
        // While the line does not hold, not even the operator turns it on.
        await expect(ctx.board.resetBreaker!('p2', 'dev', 'operator', day(3))).rejects.toMatchObject({ failure: 'invalid', message: expect.stringMatching(/the line does not hold: 2 escaped defect\(s\) in the last 7 days/) })
        // Only the operator or the lead; and only a breaker that is tripped.
        await expect(ctx.board.resetBreaker!('p2', 'dev', 'agent' as 'lead', day(60))).rejects.toMatchObject({ failure: 'invalid' })
        await expect(ctx.board.resetBreaker!('p2', 'main', 'lead', day(60))).rejects.toMatchObject({ failure: 'invalid-transition' })
        const reset = await ctx.board.resetBreaker!('p2', 'dev', 'lead', day(60))
        expect(reset).toMatchObject({ state: 'reset', reset: { at: day(60).toISOString(), by: 'lead' } })
        expect(ctx.artifacts.get(reset.reset!.decision)?.body).toMatchObject({ decider: { id: 'board.auto-accept-breaker' }, inputs: [breaker!.decision], outcome: { option: 'auto-accept on', detail: { by: 'lead', trip: breaker!.decision } } })
        expect(await ctx.board.breakers!('p2', day(60))).toEqual([])
        expect(await accepted('after-reset')).toMatchObject({ state: 'done' })
        await expect(ctx.board.resetBreaker!('p2', 'dev', 'lead', day(60))).rejects.toMatchObject({ failure: 'invalid-transition' })
      })

      it('is reached through the board tools: the lead or the operator records an escape and resets the breaker as the caller, every output valid against mcp-board 1.3, and a refused call changes nothing', async () => {
        const { b, ctx, accepted } = await booted()
        const call = caller(b)
        const [a, c] = [await accepted('a'), await accepted('c')]
        // The tools read now: only Date is faked, at fixed instants after the results were accepted.
        vi.useFakeTimers({ toFake: ['Date'] })
        onTestFinished(() => {
          vi.useRealTimers()
        })
        vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'))
        // The lead's token records it as the lead's; the operator's as the operator's.
        const first = await ok(call('board_escape', { taskId: a.taskId, note: 'pnpm 12 ignores the npm_config_ name', foundAt: '2026-10-26T09:00:00.000Z' }))
        expect(first).toMatchObject({ taskId: a.taskId, projectId: 'p2', branch: 'dev', foundAt: '2026-10-26T09:00:00.000Z', recordedBy: 'lead' })
        expect(first).not.toHaveProperty('breaker')
        expect(await ok(call('board_breakers', { projectId: 'p2' }))).toEqual({ breakers: [] })
        const second = await ok(call('board_escape', { taskId: c.taskId, note: 'the report channel cannot be reopened', foundAt: '2026-10-26T10:00:00.000Z' }, 'operator'))
        expect(second).toMatchObject({ recordedBy: 'operator', breaker: { projectId: 'p2', branch: 'dev', state: 'tripped', line: { escapes: 2, days: 7 }, escapes: [{ taskId: a.taskId }, { taskId: c.taskId }] } })
        expect(ctx.artifacts.get(second.breaker.decision)?.body).toMatchObject({ decider: { id: 'board.auto-accept-breaker' }, outcome: { option: 'auto-accept off' } })
        const listed = await ok(call('board_breakers', {}))
        expect(listed.breakers).toHaveLength(1)
        expect(listed.breakers[0]).toMatchObject({ breakerId: second.breaker.breakerId, counted: 2, lineHolds: false })
        // Refused, nothing changes: a task the rule did not accept, a second escape of one task, an input its schema refuses.
        const held = await inReview(ctx, 'held')
        expect((await call('board_escape', { taskId: held.taskId, note: 'x' })).content[0]?.text).toMatch(/^invalid: .*was not accepted by the auto-accept rule/)
        expect((await call('board_escape', { taskId: a.taskId, note: 'again' })).content[0]?.text).toMatch(/^invalid: an escape of .* is already recorded/)
        expect((await call('board_escape', { taskId: a.taskId, note: '' })).content[0]?.text).toMatch(/^invalid input, nothing done/)
        expect((await call('board_escape', { taskId: a.taskId, note: 'x', by: 'operator' })).content[0]?.text).toMatch(/^invalid input, nothing done/)
        expect(await ctx.board.escapes!('p2')).toHaveLength(2)
        // A reset while the line does not hold is refused, the breaker still tripped; a branch with none tripped too.
        expect((await call('board_breaker_reset', { projectId: 'p2', branch: 'dev' })).content[0]?.text).toMatch(/^invalid: the line does not hold/)
        expect((await call('board_breaker_reset', { projectId: 'p2', branch: 'main' }, 'operator')).content[0]?.text).toMatch(/^invalid-transition: /)
        expect(await ctx.board.breakers!('p2')).toHaveLength(1)
        // A sweep two weeks on leaves it tripped; once the window has passed and the line holds, the operator's token turns it on, recorded as the operator's.
        vi.setSystemTime(new Date('2026-11-10T00:00:00.000Z'))
        await ctx.board.sweep(new Date())
        expect(await ok(call('board_breakers', { projectId: 'p2' }))).toMatchObject({ breakers: [{ state: 'tripped', counted: 0, lineHolds: true }] })
        const reset = await ok(call('board_breaker_reset', { projectId: 'p2', branch: 'dev' }, 'operator'))
        expect(reset).toMatchObject({ state: 'reset', reset: { by: 'operator', at: '2026-11-10T00:00:00.000Z' }, counted: 0, lineHolds: true })
        expect(ctx.artifacts.get(reset.reset.decision)?.body).toMatchObject({ outcome: { option: 'auto-accept on', detail: { by: 'operator' } } })
        expect(await ok(call('board_breakers', { projectId: 'p2' }))).toEqual({ breakers: [] })
      })

      it('uses the configured line, refuses a malformed one, and keeps the default of 2 in 7 days without one', async () => {
        const { ctx, accepted } = await booted({ autoAccept: { projects: ['p2'], branches: ['dev'], breaker: { escapes: 1, days: 1 } } })
        const a = await accepted('a')
        expect((await ctx.board.recordEscape!({ taskId: a.taskId, by: 'lead', note: 'one is the line' }, day(1))).breaker).toMatchObject({ line: { escapes: 1, days: 1 } })
        expect(autoAcceptOf({ projects: ['p'], branches: ['dev'] })).toEqual({ projects: ['p'], branches: ['dev'] })
        for (const breaker of [{ escapes: 0, days: 7 }, { escapes: 2, days: 91 }, { escapes: 1.5, days: 7 }]) expect(() => autoAcceptOf({ projects: ['p'], branches: ['dev'], breaker })).toThrow(TypeError)
      })
    })

    it('holds for the lead or the operator a result whose check passed without running its browser tests, naming the check and what did not run; a plain pass is accepted as before (T247, T255)', async () => {
      const { ctx } = await boot({ board: AUTO, eventLog: true })
      await active(ctx)
      const review = assessed(ctx, 'approve')
      const evidence = checkRun(ctx, { tests: 'passed', lint: 'passed' })
      const checks = { review: true, tests: true, lint: true }
      const unrun = await inReview(ctx, 'unrun')
      const results = [
        { check: 'tests', outcome: 'passed', exitCode: 0, notRun: 'its browser tests (12 browser tests skipped: no usable Chrome)' },
        { check: 'lint', outcome: 'passed', exitCode: 0 },
      ]
      const held = await ctx.board.accept(unrun.taskId, engineAcceptance(ctx, unrun.taskId, unrun.r, { checks, review, evidence, results, branch: 'dev' }), at(5))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: [] } })
      expect(autoReasons(ctx, held)).toEqual(['checks passed, browser tests not run: its tests check passed without running its browser tests (12 browser tests skipped: no usable Chrome), so its pass says nothing of those'])
      const hold = ctx.artifacts.get(held.lastDecision!)!.body as { candidates: Array<{ reasons: string[] }> }
      expect(hold.candidates[0]!.reasons[0]).toMatch(/does not apply: checks passed, browser tests not run: its tests check passed without running its browser tests/)
      expect(ctx.eventLog.query({ type: 'board.review.held', limit: 10 })).toHaveLength(1)
      // The same records without notRun: a plain pass, done by the rule.
      const plain = await inReview(ctx, 'plain')
      const accepting = engineAcceptance(ctx, plain.taskId, plain.r, { checks, review, evidence, results: [{ check: 'tests', outcome: 'passed', exitCode: 0 }, results[1]!], branch: 'dev' })
      const done = await ctx.board.accept(plain.taskId, accepting, at(5))
      expect(done).toMatchObject({ state: 'done', result: { acceptance: accepting } })
      expect(ctx.artifacts.get(done.lastDecision!)?.body).toMatchObject({ decider: { id: 'board.auto-accept' } })
      // Held, the run owner's acceptance does not accept it again; the operator's does.
      const operator = ctx.artifacts.recordDecision({
        decisionType: 'acceptance', question: 'Accept it?', inputs: [unrun.r], candidates: [{ option: 'accept', selected: true, reasons: ['the operator accepts it'] }],
        decider: { type: 'operator', id: 'operator.review', version: '1' }, outcome: { option: 'accept', detail: { taskId: unrun.taskId, subject: TREE } }, deterministic: false,
      }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
      expect(await ctx.board.accept(unrun.taskId, operator, at(6))).toMatchObject({ state: 'done', lastDecision: operator })
    })

    it('holds a result that lands on another branch, or on none known; another project\'s result, and every one with the setting off, go as before', async () => {
      const { ctx } = await boot({ board: AUTO })
      await active(ctx)
      const review = assessed(ctx, 'approve')
      const evidence = checkRun(ctx, { tests: 'passed', lint: 'passed' })
      const checks = { review: true, tests: true, lint: true }
      const main = await inReview(ctx, 'main')
      expect(autoReasons(ctx, await ctx.board.accept(main.taskId, engineAcceptance(ctx, main.taskId, main.r, { checks, review, evidence, branch: 'main' }), at(5)))).toEqual(['it lands on main, not on a listed branch (dev)'])
      const nowhere = await inReview(ctx, 'nowhere')
      expect(autoReasons(ctx, await ctx.board.accept(nowhere.taskId, engineAcceptance(ctx, nowhere.taskId, nowhere.r, { checks, review, evidence }), at(5)))).toEqual([expect.stringMatching(/no landing target is known/)])
      // Not the run owner's: a decision the system did not produce never applies by the rule.
      const forged = await inReview(ctx, 'forged')
      const notOwners = ctx.artifacts.recordDecision({
        decisionType: 'acceptance', question: 'q', inputs: [forged.r, review, evidence], candidates: [{ option: 'accept', selected: true, reasons: ['looks fine'] }],
        decider: { type: 'rule', id: 'workflow.task-acceptance', version: '3' },
        outcome: { option: 'accept', detail: { taskId: forged.taskId, subject: TREE, checks, review: { assessment: review }, checkRun: { evidence }, landing: { repository: '/repo', branch: 'dev' } } }, deterministic: true,
      }, { producer: { type: 'policy', ref: 'test' } }).id as ArtifactRef
      expect(autoReasons(ctx, await ctx.board.accept(forged.taskId, notOwners, at(5)))).toEqual([expect.stringMatching(/is not the run owner's/)])
      // A project not listed: as before the setting, the policy alone decides.
      await active(ctx, 'p3')
      const unlisted = await inReview(ctx, 'unlisted', 'p3')
      const plain = engineAcceptance(ctx, unlisted.taskId, unlisted.r, { checks: { tests: true, lint: true }, branch: 'main' })
      expect(await ctx.board.accept(unlisted.taskId, plain, at(5))).toMatchObject({ state: 'done', lastDecision: plain })

      const off = await boot()
      await active(off.ctx)
      const before = await inReview(off.ctx, 'off')
      const accepting = engineAcceptance(off.ctx, before.taskId, before.r, { checks: { tests: true, lint: true } })
      expect(await off.ctx.board.accept(before.taskId, accepting, at(5))).toMatchObject({ state: 'done', lastDecision: accepting })
    })

    it('never applies an acceptance of a heavy result unattended, by the rule or by the policy alone; the tier is read from the record it names (ADR-0071, INV-2)', async () => {
      const { ctx } = await boot({ board: AUTO })
      await active(ctx)
      const review = assessed(ctx, 'approve')
      const evidence = checkRun(ctx, { tests: 'passed', lint: 'passed' })
      const checks = { review: true, tests: true, lint: true }
      /** The engine's `workflow.risk-tier` decision of a tier. */
      const tiered = (tier: 'light' | 'heavy'): ArtifactRef => ctx.artifacts.recordDecision({
        decisionType: 'gate', question: `What risk tier is the change (${tier})?`, inputs: [],
        candidates: [{ option: tier, selected: true, reasons: [`the change is ${tier}`] }, { option: tier === 'heavy' ? 'light' : 'heavy', selected: false, reasons: ['not it'] }],
        decider: { type: 'rule', id: 'workflow.risk-tier', version: '1' }, outcome: { option: tier }, deterministic: true,
      }, { producer: { type: 'system', ref: 'workflow' } }).id as ArtifactRef
      /** The engine's acceptance (version 4) naming a tier: `inInputs` false leaves its decision out of the inputs. */
      const withRisk = (taskId: string, r: ArtifactRef, tier: 'light' | 'heavy', decision: ArtifactRef, inInputs = true): ArtifactRef => ctx.artifacts.recordDecision({
        decisionType: 'acceptance', question: `Does the run's result complete its attempt of ${taskId}?`, inputs: [r, evidence, review, ...(inInputs ? [decision] : [])],
        candidates: [{ option: 'accept', selected: true, reasons: ['every step was accepted'] }, { option: 'reject', selected: false, reasons: ['not reject'] }],
        decider: { type: 'rule', id: 'workflow.task-acceptance', version: '4' },
        outcome: { option: 'accept', detail: { taskId, subject: TREE, checks, review: { assessment: review, cycle: 1, maxCycles: 3 }, checkRun: { evidence }, landing: { repository: '/repo', branch: 'dev' }, risk: { tier, decision } } },
        deterministic: true,
      }, { producer: { type: 'system', ref: 'workflow' } }).id as ArtifactRef
      const heavyOf = (held: BoardTask): string | undefined => (ctx.artifacts.get(held.lastDecision!)!.body as { outcome?: { detail?: { heavy?: string } } }).outcome?.detail?.heavy

      const heavy = await inReview(ctx, 'heavy')
      const held = await ctx.board.accept(heavy.taskId, withRisk(heavy.taskId, heavy.r, 'heavy', tiered('heavy')), at(5))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: [] } })
      expect(heavyOf(held)).toMatch(/is heavy-tier \(risk decision sha256:[0-9a-f]+\): a heavy change is never accepted automatically/)
      // A tier the decision claims but does not back with its record, or a claim the record contradicts, is held too.
      const unbacked = await inReview(ctx, 'unbacked')
      expect(heavyOf(await ctx.board.accept(unbacked.taskId, withRisk(unbacked.taskId, unbacked.r, 'light', tiered('light'), false), at(5)))).toMatch(/no workflow.risk-tier decision among its inputs/)
      const claimed = await inReview(ctx, 'claimed')
      expect(heavyOf(await ctx.board.accept(claimed.taskId, withRisk(claimed.taskId, claimed.r, 'light', tiered('heavy')), at(5)))).toMatch(/heavy-tier/)
      // A light one the rule applies to is done, as before.
      const light = await inReview(ctx, 'light')
      expect(await ctx.board.accept(light.taskId, withRisk(light.taskId, light.r, 'light', tiered('light')), at(5))).toMatchObject({ state: 'done' })
      // On a project the rule does not list, the policy alone would let a heavy result apply: it is held all the same.
      await active(ctx, 'p3')
      const unlisted = await inReview(ctx, 'unlisted', 'p3')
      expect(heavyOf(await ctx.board.accept(unlisted.taskId, withRisk(unlisted.taskId, unlisted.r, 'heavy', tiered('heavy')), at(5)))).toMatch(/heavy-tier/)
      // Only the operator's acceptance accepts it.
      const operator = ctx.artifacts.recordDecision({
        decisionType: 'acceptance', question: 'Accept it?', inputs: [heavy.r], candidates: [{ option: 'accept', selected: true, reasons: ['the operator accepts it'] }],
        decider: { type: 'operator', id: 'operator.review', version: '1' }, outcome: { option: 'accept', detail: { taskId: heavy.taskId, subject: TREE } }, deterministic: false,
      }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
      expect(await ctx.board.accept(heavy.taskId, operator, at(6))).toMatchObject({ state: 'done', lastDecision: operator })
    })

    it('holds an acceptance that names no risk tier when a policy of the task\'s project carries a path map: its silence is no tier (ADR-0071, INV-2)', async () => {
      const { ctx, approvals } = await boot({ board: AUTO })
      await active(ctx, 'p3')
      const tiered = POLICIES.map((p) => p.projectId === 'p3' ? { ...p, schema: 'autonomy-policy@1.1' as const, riskTiers: { version: 1, rules: [{ paths: ['**'], tier: 'light' as const, note: 'everything' }] } } : p)
      approvals().reload(tiered, at(4))
      const silent = await inReview(ctx, 'silent', 'p3')
      const held = await ctx.board.accept(silent.taskId, engineAcceptance(ctx, silent.taskId, silent.r, { checks: { tests: true, lint: true }, branch: 'main' }), at(5))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: [] } })
      expect((ctx.artifacts.get(held.lastDecision!)!.body as { outcome?: { detail?: { heavy?: string } } }).outcome?.detail?.heavy).toMatch(/names no risk tier .* carries a path map/)
      // With no map, the same acceptance applies as before.
      approvals().reload(POLICIES, at(5))
      const plain = await inReview(ctx, 'plain', 'p3')
      const accepting = engineAcceptance(ctx, plain.taskId, plain.r, { checks: { tests: true, lint: true }, branch: 'main' })
      expect(await ctx.board.accept(plain.taskId, accepting, at(6))).toMatchObject({ state: 'done', lastDecision: accepting })
    })

    it('validates the setting: distinct project ids and plain branch names within the bound; off unless both lists name one', () => {
      expect(autoAcceptOf(undefined)).toBeUndefined()
      expect(autoAcceptOf({ projects: ['system'], branches: [] })).toBeUndefined()
      expect(autoAcceptOf({ projects: [], branches: ['dev'] })).toBeUndefined()
      expect(autoAcceptOf({ projects: ['system'], branches: ['dev', 'release/1.0'] })).toEqual({ projects: ['system'], branches: ['dev', 'release/1.0'] })
      for (const branches of [['dev*'], ['de v'], ['-dev'], ['a..b'], ['dev/'], ['dev', 'dev'], [''], Array.from({ length: 65 }, (_, i) => `b${i}`)]) {
        expect(() => autoAcceptOf({ projects: ['system'], branches }), JSON.stringify(branches)).toThrow(TypeError)
      }
      for (const projects of [['sys tem'], ['system', 'system'], [7 as unknown as string]]) expect(() => autoAcceptOf({ projects, branches: ['dev'] })).toThrow(TypeError)
    })
  })

  describe('an attempt not spent on an infrastructure failure (ADR-0069)', () => {
    /** A run of the task recorded and failed only on the infrastructure, as its owner reports it. */
    const infraFailed = async (ctx: Context, taskId: string, runId: string, when: Date, reason = `${runId} stopped by a restart`): Promise<BoardTask> => {
      const { generation } = await ctx.board.claim(taskId, 'lead', 600_000, when)
      await ctx.board.start(taskId, generation, { runId }, when)
      return ctx.board.reconcileRun(taskId, runId, { status: 'failed', infrastructure: { kind: 'host-stopped', reason } }, when)
    }

    it('validates the bound: a whole number from 0 to 10, default 3; the configuration schema refuses any other (INV-2, INV-9)', () => {
      expect(freeRetriesOf(undefined)).toBe(3)
      expect(freeRetriesOf(0)).toBe(0)
      expect(freeRetriesOf(10)).toBe(10)
      for (const bad of [-1, 11, 1.5, '2', null]) expect(() => freeRetriesOf(bad), String(bad)).toThrow(/board.maxFreeRetries is a whole number from 0 to 10/)
      const row = { autoAccept: { projects: [], branches: [] } }
      expect(StoreBoard.Config(row).maxFreeRetries).toBe(3)
      expect(StoreBoard.Config({ ...row, maxFreeRetries: 0 }).maxFreeRetries).toBe(0)
      for (const bad of [-1, 11, 1.5]) expect(() => StoreBoard.Config({ ...row, maxFreeRetries: bad }), String(bad)).toThrow()
    })

    it('keeps the free retries it gave beside the record, across a restart, so the bound holds over the task\'s whole life', async () => {
      const { ctx, restartBoard } = await boot({ board: { maxFreeRetries: 2 } })
      await active(ctx)
      const t = await ready(ctx, task('p2', 'restarts', { maxAttempts: 1 }))
      expect(await infraFailed(ctx, t.taskId, 'run-1', at(3))).toMatchObject({ state: 'ready', attempts: { count: 0 } })
      await restartBoard()
      expect(await infraFailed(ctx, t.taskId, 'run-2', at(4))).toMatchObject({ state: 'ready', attempts: { count: 0 } })
      // The third is past the bound of 2: it counts, and with no attempt left the task waits for input.
      const ended = await infraFailed(ctx, t.taskId, 'run-3', at(5), 'the host restarted a third time')
      expect(ended).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' }, attempts: { count: 1, max: 1 } })
      const body = ctx.artifacts.get(ended.lastDecision!)!.body as { candidates: Array<{ selected: boolean; reasons: string[] }>; outcome: { detail: Record<string, unknown> } }
      expect(body.candidates.find((c) => c.selected)!.reasons.join(' ')).toMatch(/2 free retries are used .*counts \(host-stopped: the host restarted a third time\)/)
      expect(body.outcome.detail).toMatchObject({ infrastructure: { kind: 'host-stopped' }, freeRetry: { used: 2, max: 2, counted: true } })
    })

    it('with a bound of 0 counts every failure; a plain failure always counts', async () => {
      const { ctx } = await boot({ board: { maxFreeRetries: 0 } })
      await active(ctx)
      const t = await ready(ctx, task('p2', 'none free', { maxAttempts: 2 }))
      expect(await infraFailed(ctx, t.taskId, 'run-1', at(3))).toMatchObject({ state: 'ready', attempts: { count: 1 } })
      const plain = await boot()
      await active(plain.ctx)
      const p = await ready(plain.ctx, task('p2', 'plain', { maxAttempts: 2 }))
      const { generation } = await plain.ctx.board.claim(p.taskId, 'lead', 600_000, at(3))
      await plain.ctx.board.start(p.taskId, generation, { runId: 'run-1' }, at(3))
      expect(await plain.ctx.board.reconcileRun(p.taskId, 'run-1', { status: 'failed' }, at(3))).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    })
  })

  it('gives a task the attempts its proposal names, else its template\'s from the configuration, else the default 3 (T99 D6)', async () => {
    const { ctx, mcp } = await boot({ board: { templateAttempts: { 'algorithm-development': 6 } } })
    await active(ctx)
    expect((await ctx.board.propose(task('p2', 'plain'), at(2))).attempts).toEqual({ count: 0, max: 3 })
    expect((await ctx.board.propose(task('p2', 'templated', { template: 'algorithm-development' }), at(2))).attempts).toEqual({ count: 0, max: 6 })
    expect((await ctx.board.propose(task('p2', 'other', { template: 'agent-review' }), at(2))).attempts).toEqual({ count: 0, max: 3 })
    expect((await ctx.board.propose(task('p2', 'named', { template: 'algorithm-development', maxAttempts: 2 }), at(2))).attempts).toEqual({ count: 0, max: 2 })
    // The lead names it on board_propose, within 1 to 10.
    const propose = (args: Record<string, unknown>) => mcp().tools.get('board_propose')!.handler({ projectId: 'p2', title: 't', goal: 'g', acceptance: [{ id: 'a1', statement: 's' }], actionClass: 'read', ...args }, { scope: 'client' }) as unknown as Promise<{ isError?: boolean; structuredContent?: { taskId: string } }>
    const proposed = await propose({ maxAttempts: 5 })
    expect(proposed.isError).toBeFalsy()
    expect((await ctx.board.task(proposed.structuredContent!.taskId))!.attempts).toEqual({ count: 0, max: 5 })
    for (const maxAttempts of [0, 11, 2.5]) expect((await propose({ maxAttempts })).isError, String(maxAttempts)).toBe(true)
  })

  it('holds a lead token to its own project: another project\'s project and tasks are refused with the reason, its own pass (T285)', async () => {
    const { ctx, mcp } = await boot()
    await active(ctx, 'p2')
    await active(ctx, 'p3')
    const own = await ready(ctx, task('p2', 'mine'))
    const theirs = await ready(ctx, task('p3', 'theirs'))
    type Reply = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }
    // A lead token of project p2; null calls as the operator.
    const call = (name: string, args: Record<string, unknown>, lead: string | null = 'p2') => mcp().tools.get(name)!.handler(args, lead === null ? { scope: 'operator' } : { scope: 'client', lead }) as unknown as Promise<Reply>
    const refusal = /the lead token of project p2 reaches only project p2; .* belongs to project p3, so nothing was done/
    const calls: Array<[string, Record<string, unknown>]> = [
      ['board_claim', { taskId: theirs.taskId, owner: 'lead' }], ['board_cancel', { taskId: theirs.taskId }], ['board_update', { taskId: theirs.taskId, generation: 1 }],
      ['board_update', { taskId: theirs.taskId, answers: [{ question: 0, answer: 'x' }] }], ['board_task', { taskId: theirs.taskId }], ['board_escape', { taskId: theirs.taskId, note: 'n' }],
      ['board_brief', { projectId: 'p3' }], ['board_tasks', { projectId: 'p3' }], ['board_breakers', { projectId: 'p3' }], ['board_breaker_reset', { projectId: 'p3', branch: 'dev' }],
      ['board_propose', { ...task('p3', 'sneaked') }], ['board_propose', { ...task('p2', 'depends', { dependsOn: [theirs.taskId] }) }],
      ['board_charter', { projectId: 'p3', title: 't', charter: CHARTER }], ['board_reopen_review', { taskId: theirs.taskId, reason: 'r' }],
      ['board_defect', { taskId: theirs.taskId, fixes: own.taskId, sha: 'a'.repeat(40) }], ['board_defect', { taskId: own.taskId, fixes: theirs.taskId, sha: 'a'.repeat(40) }],
    ]
    for (const [name, args] of calls) {
      const refused = await call(name, args)
      expect(refused.isError, name).toBe(true)
      expect(refused.content[0]!.text, name).toMatch(refusal)
    }
    // Nothing of p3 moved.
    expect((await ctx.board.task(theirs.taskId))!.state).toBe('ready')
    expect((await ctx.board.tasks({ projectId: 'p3' })).map((t) => t.title)).toEqual(['theirs'])
    // A lead founds no project.
    expect((await call('board_charter', { title: 't', charter: CHARTER })).content[0]!.text).toMatch(/founds no project/)
    // The same calls on its own project pass; the project list and the breakers are its own only.
    expect((await call('board_task', { taskId: own.taskId })).isError).toBeFalsy()
    expect((await call('board_tasks', { projectId: 'p2' })).isError).toBeFalsy()
    expect((await call('board_brief', { projectId: 'p2' })).isError).toBeFalsy()
    expect((await call('board_claim', { taskId: own.taskId, owner: 'lead' })).isError).toBeFalsy()
    expect((await call('board_projects', {})).structuredContent!.projects).toEqual([expect.objectContaining({ projectId: 'p2' })])
    expect((await call('board_breakers', {})).isError).toBeFalsy()
    // The operator, and a client token with no project, reach both.
    expect((await call('board_projects', {}, null)).structuredContent!.projects).toHaveLength(2)
    expect((await mcp().tools.get('board_task')!.handler({ taskId: theirs.taskId }, { scope: 'client' })).isError).toBeFalsy()
    expect((await call('board_claim', { taskId: theirs.taskId, owner: 'op' }, null)).isError).toBeFalsy()
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
    const elsewhere = acceptance(ctx, 'accept', t.taskId, result(ctx, 'another result'))
    expect(await failureOf(ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: elsewhere }, at(11)))).toBe('invalid')
    expect((await ctx.approvals.get(lost.waiting!.approvalRequest!))?.state).toBe('open')
    expect(await ctx.board.task(t.taskId)).toEqual(lost)
    expect(await ctx.board.reconcileRun(t.taskId, 'run-1', { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: acceptance(ctx, 'reject', t.taskId, r) }, at(11)))
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

  it('lets a paused project\'s running attempt reach its outcome and its waits their expiry, claims and gates nothing new, and gates its proposed tasks once resumed (fail-closed rule 1, INV-9, INV-13)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const running = await ready(ctx, task('p2', 'running'))
    const asks = await ready(ctx, task('p2', 'asks'))
    const idle = await ready(ctx, task('p2', 'idle'))
    const run = await ctx.board.claim(running.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(running.taskId, run.generation, { runId: 'run-1' }, at(3))
    const question = await ctx.board.claim(asks.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(asks.taskId, question.generation, { runId: 'run-2' }, at(3))
    const asking = await ctx.board.block(asks.taskId, question.generation, { reason: 'question', questions: ['Which band?'] }, at(3))
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(3))
    const deploy = await ctx.board.propose(task('p2', 'deploy', { actionClass: 'deploy' }), at(3))
    await ctx.board.sweep(at(3))
    const deployWait = (await ctx.board.task(deploy.taskId))!.waiting!
    const later = await ctx.board.propose(task('p2', 'later'), at(4))

    const paused = await ctx.board.pause('p2', at(5))
    expect(paused).toMatchObject({ state: 'paused' })
    const pausing = ctx.artifacts.get(paused.lastDecision!)!.body as { decisionType: string; candidates: Array<{ option: string; selected: boolean; reasons: string[] }>; outcome: { option: string } }
    expect(pausing).toMatchObject({ decisionType: 'board', outcome: { option: 'paused' } })
    expect(pausing.candidates.map((c) => [c.option, c.selected, c.reasons.join(' ')])).toEqual([
      ['paused', true, expect.stringMatching(/no task is claimed or started.*a running attempt goes on to its outcome, and every wait keeps its expiry/)],
      ['active', false, 'not kept active: the operator paused it'],
    ])
    await ctx.board.sweep(at(5))
    expect(await ctx.board.task(later.taskId)).toMatchObject({ state: 'proposed' })
    expect(await failureOf(ctx.board.claim(idle.taskId, 'lead', 600_000, at(5)))).toBe('invalid-transition')

    // The running attempt goes on to its outcome: renewed, submitted, accepted.
    await ctx.board.renew(running.taskId, run.generation, 600_000, at(6))
    const r = result(ctx, 'finished while paused')
    await ctx.board.submit(running.taskId, run.generation, { artifacts: [r], subject: HEAD }, at(6))
    expect(await ctx.board.accept(running.taskId, acceptance(ctx, 'accept', running.taskId, r), at(7))).toMatchObject({ state: 'done' })
    // An approval asked before the pause still applies; the task it readies is not claimed while paused.
    await decide(ctx, (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!, 'approved', at(8))
    await ctx.board.sweep(at(8))
    expect(await ctx.board.task(merge.taskId)).toMatchObject({ state: 'ready' })
    expect(await failureOf(ctx.board.claim(merge.taskId, 'lead', 600_000, at(8)))).toBe('invalid-transition')
    // Every wait keeps its expiry.
    await ctx.board.sweep(new Date(Date.parse(deployWait.expiresAt) + 1000))
    expect(await ctx.board.task(deploy.taskId)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' } })
    const end = new Date(Date.parse(asking.waiting!.expiresAt) + 1000)
    await ctx.board.sweep(end)
    expect(await ctx.board.task(asks.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'input-expired' } })
    expect(await ctx.board.task(later.taskId)).toMatchObject({ state: 'proposed' })

    const resumed = await ctx.board.resume('p2', end)
    expect(ctx.artifacts.get(resumed.lastDecision!)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'active' }, candidates: [{ option: 'active', selected: true }, { option: 'paused', reasons: ['not kept paused: the operator resumed it'] }] })
    await ctx.board.sweep(end)
    const gated = (await ctx.board.task(later.taskId))!
    expect(gated).toMatchObject({ state: 'ready' })
    expect(ctx.artifacts.get(gated.lastDecision!)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'ready', detail: { mode: 'auto' } } })
    expect((await ctx.board.claim(idle.taskId, 'lead', 600_000, end)).generation).toBe(1)
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

describe('ctx.board (store-backed): funding a spent budget', () => {
  const usd = (amount: number): BudgetLine[] => [{ pool: 'max.programmatic', unit: 'usd', amount }]
  /** A running task of p2 with a 10 usd budget, its attempt started: its holder's generation. */
  const running = async (ctx: Context, title: string, when: number, extra: Partial<TaskInput> = {}): Promise<{ taskId: string; generation: number }> => {
    const t = await ready(ctx, task('p2', title, { budget: usd(10), ...extra }), at(when))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(when))
    await ctx.board.start(t.taskId, generation, { runId: `run-${title}-${when}` }, at(when))
    return { taskId: t.taskId, generation }
  }
  const boardDecision = (ctx: Context, ref: ArtifactRef | undefined) => ctx.artifacts.get(ref!)!.body as { decisionType: string; inputs: string[]; outcome: { option: string; detail: Record<string, unknown> } }

  it('bounds a task\'s raises together by fundingMaxPercent of what it declared: an ask past what is left opens no request, and nothing is raised (INV-9)', async () => {
    const { ctx } = await boot({ board: { fundingMaxPercent: 50 } })
    await active(ctx)
    let { taskId, generation } = await running(ctx, 'raised', 3)
    const first = await ctx.board.block(taskId, generation, { reason: 'budget-spent', funding: usd(4) }, at(4))
    await decide(ctx, first.waiting!.approvalRequest!, 'approved', at(5))
    await ctx.board.sweep(at(5))
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'ready', budget: usd(14), funding: [{ lines: usd(4) }] })

    // 4 raised of the 5 (50% of the 10 declared): 2 more is past it, though 2 is within 50% of the 14 it holds now.
    ;({ generation } = await ctx.board.claim(taskId, 'lead', 600_000, at(6)))
    await ctx.board.start(taskId, generation, { runId: 'run-raised-2' }, at(6))
    const asked = (await open(ctx, 'p2')).length
    const refused = await ctx.board.block(taskId, generation, { reason: 'budget-spent', funding: usd(2) }, at(7))
    schemas.assertRecord(refused)
    expect(refused).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, budget: usd(14), funding: [{ lines: usd(4) }], attempts: { count: 2 } })
    expect(refused.holder).toBeUndefined()
    expect(boardDecision(ctx, refused.lastDecision)).toMatchObject({ decisionType: 'board', outcome: { option: 'waiting-for-input', detail: { reason: 'budget-spent', funding: usd(2), fundingMaxPercent: 50 } } })
    expect((await open(ctx, 'p2')).length).toBe(asked)
    // The lease is released with the move: the holder's generation no longer writes.
    expect(await failureOf(ctx.board.renew(taskId, generation, 600_000, at(8)))).toBe('stale-generation')
  })

  it('applies an approval only within the bound in force when it is applied, and only on the exact lines its request binds: otherwise nothing is raised, and the task waits for input (INV-5, INV-9)', async () => {
    const { ctx, restartBoard } = await boot()
    await active(ctx)
    const lowered = await running(ctx, 'lowered', 3)
    const asked = await ctx.board.block(lowered.taskId, lowered.generation, { reason: 'budget-spent', funding: usd(8) }, at(4))
    await decide(ctx, asked.waiting!.approvalRequest!, 'approved', at(5))
    // The operator lowers the bound before the board applies the approval.
    await restartBoard({ fundingMaxPercent: 50 })
    await ctx.board.sweep(at(5))
    const past = (await ctx.board.task(lowered.taskId))!
    schemas.assertRecord(past)
    expect(past).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, budget: usd(10) })
    expect(past.funding).toBeUndefined()
    const resolution = (await ctx.approvals.get(asked.waiting!.approvalRequest!))!.resolution!
    expect(boardDecision(ctx, past.lastDecision)).toMatchObject({ outcome: { option: 'waiting-for-input', detail: { cause: 'past-bound', funding: usd(8) } }, inputs: [resolution.decision] })

    // A wait whose stored lines are not the ones its request was asked on: the approval binds nothing (INV-5).
    await restartBoard({ fundingMaxPercent: 100 })
    const altered = await running(ctx, 'altered', 6)
    const blocked = await ctx.board.block(altered.taskId, altered.generation, { reason: 'budget-spent', funding: usd(4) }, at(7))
    const record = { ...blocked, waiting: { ...blocked.waiting!, funding: usd(5) } }
    schemas.assertRecord(record)
    ctx.store.db.prepare('UPDATE board_tasks SET record = ? WHERE task_id = ?').run(JSON.stringify(record), altered.taskId)
    await decide(ctx, blocked.waiting!.approvalRequest!, 'approved', at(8))
    await ctx.board.sweep(at(8))
    const unbound = (await ctx.board.task(altered.taskId))!
    expect(unbound).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, budget: usd(10) })
    expect(unbound.funding).toBeUndefined()
    expect(boardDecision(ctx, unbound.lastDecision)).toMatchObject({ outcome: { detail: { cause: 'unbound' } } })
  })

  it('says in the queue that an approval with no attempt left raises nothing, and raises nothing then (INV-9)', async () => {
    const { ctx } = await boot()
    await active(ctx)
    const { taskId, generation } = await running(ctx, 'last', 3, { maxAttempts: 1 })
    const blocked = await ctx.board.block(taskId, generation, { reason: 'budget-spent', funding: usd(4) }, at(4))
    const request = (await ctx.approvals.get(blocked.waiting!.approvalRequest!))!
    expect(request.action.consequences).toBe('Approved: nothing is raised, since all 1 attempt(s) are used; the task waits for input (retries-spent). Denied or unanswered: the budget stays 10 usd of max.programmatic, and the task waits for input (rejected) until it is cancelled.')
    await decide(ctx, request.requestId, 'approved', at(5))
    await ctx.board.sweep(at(5))
    const stopped = (await ctx.board.task(taskId))!
    expect(stopped).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' }, budget: usd(10) })
    expect(stopped.funding).toBeUndefined()
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
  if (!reply.isError) schemas.assertDef('mcp-board@1.1', `${tool.replaceAll('_', '-')}-output`, reply.structuredContent)
  return reply
}
const ok = async (reply: ReturnType<Call>): Promise<Record<string, any>> => {
  const r = await reply
  expect(r.isError, r.content[0]?.text).toBeFalsy()
  return r.structuredContent!
}
const example = (name: string): Record<string, any> => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as Record<string, any>

describe('ctx.board (store-backed): board_* MCP tools', () => {
  it('re-opens a review-expired task through board_reopen_review, as the caller, only while its run\'s worktree is recorded and on disk (T286)', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    await active(ctx)
    const t = await ready(ctx, task('p2', 'lapse', { actionClass: 'workspace-write', maxAttempts: 2 }))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: 'run-lapse' }, at(3))
    const r = result(ctx, 'lapse')
    // Submitted inside the 60 s lease (it ends at at(4)); then the holder is gone past it.
    await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: HEAD }, at(3.5))
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'review' })
    await ctx.board.sweep(at(30))
    const held = (await ctx.board.task(t.taskId))!
    // Held for the operator, with the class's required checks still pending: none was reported.
    expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: expect.arrayContaining(['tests', 'lint']) } })
    expect(held.holder).toBeUndefined()
    // Nobody decides by the policy's wait: it expires.
    await ctx.board.sweep(new Date(Date.parse(held.waiting!.expiresAt)))
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
    // The tool reads now: only Date is faked, at a fixed instant after the review expired.
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    vi.setSystemTime(new Date(Date.parse(held.waiting!.expiresAt) + 60_000))
    // No worktree recorded for its run: refused, nothing changes.
    expect((await call('board_reopen_review', { taskId: t.taskId, reason: 'approved twice' })).content[0]?.text).toMatch(/^invalid-transition: .*has no worktree left/)
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
    // Recorded, but gone from disk: refused too.
    ctx.store.db.prepare('CREATE TABLE agent_worktrees (repository TEXT, workflow_run_id TEXT, path TEXT, branch TEXT, removed_at TEXT)').run()
    const dir = mkdtempSync(join(tmpdir(), 'board-worktree-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    ctx.store.db.prepare('INSERT INTO agent_worktrees VALUES (?, ?, ?, ?, NULL)').run('/repo', 'run-lapse', join(dir, 'gone'), 'system/run/run-lapse')
    expect((await call('board_reopen_review', { taskId: t.taskId, reason: 'approved twice' })).content[0]?.text).toMatch(/^invalid-transition: .*has no worktree left/)
    // Removed by the retention: refused.
    ctx.store.db.prepare('UPDATE agent_worktrees SET path = ?, removed_at = ?').run(dir, '2026-10-26T00:00:00.000Z')
    expect((await call('board_reopen_review', { taskId: t.taskId, reason: 'approved twice' })).content[0]?.text).toMatch(/^invalid-transition: .*has no worktree left/)
    // An input its schema refuses: nothing done.
    ctx.store.db.prepare('UPDATE agent_worktrees SET removed_at = NULL').run()
    expect((await call('board_reopen_review', { taskId: t.taskId, reason: '' })).content[0]?.text).toMatch(/^invalid input, nothing done/)
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'waiting-for-input' })
    // Its worktree exists: back to review with its result, held for the operator, recorded as the operator's decision.
    const back = await ok(call('board_reopen_review', { taskId: t.taskId, reason: 'approved twice' }, 'operator'))
    expect(back).toMatchObject({ taskId: t.taskId, state: 'review' })
    expect(ctx.artifacts.get(back.decision)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'operator-review', detail: { reopenedBy: 'operator', runId: 'run-lapse' } } })
    expect(await ctx.board.task(t.taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: expect.arrayContaining(['tests', 'lint']) }, result: { artifacts: [r] }, attempts: { count: 1 } })
    // In review, it is not re-opened again.
    expect((await call('board_reopen_review', { taskId: t.taskId, reason: 'again' })).content[0]?.text).toMatch(/^invalid-transition: /)
  })

  it('contributes the lead\'s board tools at client scope and the operator\'s project moves at operator scope, each input shape taking what its schema definition takes (INV-6)', async () => {
    const b = await boot()
    expect([...b.mcp().tools.keys()].sort()).toEqual([...BOARD_TOOLS].sort())
    const operator = ['board_pause', 'board_resume', 'board_close']
    for (const name of BOARD_TOOLS) expect(b.mcp().tools.get(name)!.spec.scope, name).toBe(operator.includes(name) ? 'operator' : 'client')
    for (const name of ['mcp-board.charter', 'mcp-board.claim', 'mcp-board.brief', 'mcp-board.task', 'mcp-board.close']) {
      const { tool, input } = example(name) as { tool: typeof BOARD_TOOLS[number]; input: unknown }
      expect(zod.object(INPUTS[tool]).safeParse(input).success, name).toBe(true)
      schemas.assertDef('mcp-board@1.1', `${tool.replaceAll('_', '-')}-input`, input)
    }
    // The shape of an answer is in the tool's own description, which the generated reference shows (T99 D7).
    expect((INPUTS.board_update.answers as unknown as zod.ZodType).description).toContain('each item {question, answer}')
    expect(zod.object(INPUTS.board_update).safeParse({ taskId: 'task-1', answers: [{ question: 0, answer: 'Use the v2 API' }] }).success).toBe(true)
    expect(zod.object(INPUTS.board_update).safeParse({ taskId: 'task-1', answers: [{ index: 0, text: 'Use the v2 API' }] }).success).toBe(false)
    schemas.assertDef('mcp-board@1.1', 'board-update-input', { taskId: 'task-1', answers: [{ question: 0, answer: 'Use the v2 API' }] })
    expect(zod.object(INPUTS.board_close).safeParse({ projectId: 'p2', outcome: 'abandoned' }).success).toBe(false)
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
    // The run that serves the attempt starts, submits, and accepts it as its owner: no tool does.
    await ctx.board.start(taskId, 1, { runId: 'run-1' })
    const r = result(ctx, 'kernel')
    expect(await ctx.board.submit(taskId, 1, { artifacts: [r], subject: HEAD, files: ['src/kernel.ts'], next: 'vectorize' })).toMatchObject({ taskId, state: 'review' })
    await ctx.board.accept(taskId, acceptance(ctx, 'accept', taskId, r))

    const brief = await ok(call('board_brief', { projectId: 'p2' }))
    expect(brief).toMatchObject({ projectId: 'p2', intent: CHARTER.intent, state: 'active', milestone: 'm1', tasks: { done: 1 }, readFirst: [{ ref: r }] })
  })

  it('claims for 600 s by default, within the leases\' own cap, and says that cap bounds a claim; it says a run started with the task serves it, and no tool takes a result', async () => {
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
    expect(spec.description).toMatch(/with the `run` tool, naming the task with this owner as holder and this generation/)
    // One attempt, one writer (INV-15): the run that serves it submits its result, never a tool beside it.
    expect(b.mcp().tools.has('board_complete')).toBe(false)
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
    expect(b.mcp().tools.get('board_update')!.spec.description).toMatch(/Only a question wait takes answers/)
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

  it('pauses, resumes, and closes a project for the operator only: a client\'s call moves nothing, each move names its board decision, and a close cancels the open tasks, releases their leases, and withdraws what they and a pending amendment waited on (INV-6, INV-13)', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    await active(ctx)
    const idle = await ready(ctx, task('p2', 'idle'))
    const held = await ready(ctx, task('p2', 'held'))
    await ctx.board.claim(held.taskId, 'lead', 600_000)
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }))
    await ctx.board.sweep(new Date())
    const waitedOn = (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!
    const { approvalRequest: amendment } = await ctx.board.charter({ projectId: 'p2', title: 'project p2', charter: { ...CHARTER, version: 2 } })
    const project = (await ctx.board.project('p2'))!

    // A client is refused by the handler too, whatever reached it; nothing moves.
    for (const [tool, args, move] of [['board_pause', { projectId: 'p2' }, 'pauses'], ['board_resume', { projectId: 'p2' }, 'resumes'], ['board_close', { projectId: 'p2', outcome: 'stopped' }, 'closes']] as const) {
      const refused = await call(tool, args, 'client')
      expect([refused.isError, refused.content[0]?.text], tool).toEqual([true, `invalid: only the operator ${move} a project`])
    }
    expect(await ctx.board.project('p2')).toEqual(project)
    expect(await ctx.board.task(idle.taskId)).toMatchObject({ state: 'ready' })

    const paused = await ok(call('board_pause', { projectId: 'p2' }, 'operator'))
    const stored = (await ctx.board.project('p2'))!
    expect(paused).toEqual({ projectId: 'p2', state: 'paused', revision: stored.revision, decision: stored.lastDecision })
    expect(ctx.artifacts.get(paused.decision)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'paused' } })
    expect((await call('board_pause', { projectId: 'p2' }, 'operator')).content[0]?.text).toMatch(/^invalid-transition: p2 is paused, not active/)
    expect(await failureOf(ctx.board.claim(idle.taskId, 'lead', 600_000))).toBe('invalid-transition')
    const resumed = await ok(call('board_resume', { projectId: 'p2' }, 'operator'))
    expect(resumed).toMatchObject({ projectId: 'p2', state: 'active', revision: stored.revision + 1 })
    expect(ctx.artifacts.get(resumed.decision)?.body).toMatchObject({ decisionType: 'board', outcome: { option: 'active' } })

    // Refused while a task runs, with nothing moved.
    const runs = await ready(ctx, task('p2', 'runs'), new Date())
    const { generation } = await ctx.board.claim(runs.taskId, 'lead', 600_000)
    await ctx.board.start(runs.taskId, generation, { runId: 'run-1' })
    const before = await ctx.board.tasks({ projectId: 'p2' })
    expect((await call('board_close', { projectId: 'p2', outcome: 'stopped' }, 'operator')).content[0]?.text).toMatch(/^invalid-transition: p2 has a task running or in review/)
    expect(await ctx.board.tasks({ projectId: 'p2' })).toEqual(before)
    const r = result(ctx, 'last')
    await ctx.board.submit(runs.taskId, generation, { artifacts: [r], subject: HEAD })
    await ctx.board.accept(runs.taskId, acceptance(ctx, 'accept', runs.taskId, r))
    expect((await call('board_close', { projectId: 'p2', outcome: 'abandoned' }, 'operator')).content[0]?.text).toMatch(/^invalid input, nothing done/)

    const closed = await ok(call('board_close', { projectId: 'p2', outcome: 'stopped' }, 'operator'))
    const after = (await ctx.board.project('p2'))!
    expect(closed).toEqual({ projectId: 'p2', state: 'closed', outcome: 'stopped', revision: after.revision, decision: after.closure!.decision, cancelled: 3 })
    expect(ctx.artifacts.get(closed.decision)?.body).toMatchObject({
      decisionType: 'board', outcome: { option: 'closed', detail: { outcome: 'stopped', cancelled: 3 } },
      candidates: [{ option: 'closed', selected: true, reasons: ['closed as stopped'] }, { option: 'active', selected: false, reasons: ['not kept active: the operator closed it; 3 open task(s) cancelled'] }],
    })
    for (const t of [idle, held, merge]) expect(await ctx.board.task(t.taskId), t.title).toMatchObject({ state: 'cancelled', cancellation: { reason: 'project-closed' } })
    expect(await ctx.board.task(runs.taskId)).toMatchObject({ state: 'done' })
    expect(ctx.leases.current(`board-task:${held.taskId}`)).toBeUndefined()
    for (const requestId of [waitedOn, amendment]) expect((await ctx.approvals.get(requestId))?.resolution?.cause, requestId).toBe('withdrawn')
    expect(await open(ctx, 'p2')).toEqual([])
    expect((await call('board_close', { projectId: 'p2', outcome: 'stopped' }, 'operator')).content[0]?.text).toMatch(/^invalid-transition/)
    expect((await call('board_resume', { projectId: 'nope' }, 'operator')).content[0]?.text).toMatch(/^unknown-project/)
  })

  it('checks the output of every tool that changes the board before its move commits: one its schema refuses (a defect) changes nothing, and a request it opened is withdrawn (INV-2, INV-14)', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    await active(ctx)
    const idle = await ready(ctx, task('p2', 'idle'))
    const held = await ready(ctx, task('p2', 'held'))
    const claim = await ctx.board.claim(held.taskId, 'lead', 600_000)
    const asks = await ready(ctx, task('p2', 'asks'))
    const { generation } = await ctx.board.claim(asks.taskId, 'lead', 600_000)
    await ctx.board.start(asks.taskId, generation, { runId: 'run-1' })
    await ctx.board.block(asks.taskId, generation, { reason: 'question', questions: ['Band width?'] })
    const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }))
    await ctx.board.sweep(new Date())
    const waitedOn = (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!
    // A defect: every output of a tool that changes the board is one its schema refuses.
    const assertDef = SchemaRegistry.prototype.assertDef
    const spy = vi.spyOn(SchemaRegistry.prototype, 'assertDef').mockImplementation(function (this: SchemaRegistry, tag, def, value) {
      if (tag.startsWith('mcp-board@') && def.endsWith('-output') && !/^board-(projects|brief|tasks|task)-output$/.test(def)) throw new SchemaError(`${tag}#/$defs/${def}`, [], 'a defect')
      assertDef.call(this, tag, def, value)
    })
    onTestFinished(() => spy.mockRestore())
    const snapshot = async () => ({
      projects: await ctx.board.projects(), tasks: await ctx.board.tasks({ projectId: 'p2' }), requests: await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] }),
      leases: [idle, held, asks].map((t) => ctx.leases.current(`board-task:${t.taskId}`)),
    })
    const before = await snapshot()
    const calls: Array<[string, Record<string, unknown>, 'client' | 'operator']> = [
      ['board_charter', { projectId: 'p3', title: 'Other', charter: CHARTER, clientRequestId: 'found-p3' }, 'client'],
      ['board_charter', { projectId: 'p2', title: 'project p2', charter: { ...CHARTER, version: 2 } }, 'client'],
      ['board_propose', { projectId: 'p2', title: 'x', goal: 'g', acceptance: [{ id: 'a1', statement: 's' }], actionClass: 'read', clientRequestId: 'x-1' }, 'client'],
      ['board_claim', { taskId: idle.taskId, owner: 'lead' }, 'client'],
      ['board_update', { taskId: held.taskId, generation: claim.generation }, 'client'],
      ['board_update', { taskId: asks.taskId, answers: [{ question: 0, answer: '64' }] }, 'client'],
      ['board_cancel', { taskId: merge.taskId }, 'client'],
      ['board_pause', { projectId: 'p2' }, 'operator'],
      ['board_close', { projectId: 'p2', outcome: 'stopped' }, 'operator'],
    ]
    for (const [tool, args, scope] of calls) {
      const refused = await call(tool, args, scope)
      expect([refused.isError, refused.content[0]?.text], tool).toEqual([true, expect.stringMatching(new RegExp(`^board: ${tool} would make an output its schema refuses \\(a defect\\), so nothing changed`))])
    }
    // Nothing moved, and the requests the refused charters opened were withdrawn; the waits kept theirs.
    const after = await snapshot()
    expect({ ...after, requests: after.requests.filter((r) => r.resolution?.cause !== 'withdrawn') }).toEqual(before)
    expect(after.requests.filter((r) => r.resolution?.cause === 'withdrawn').map((r) => r.action.class)).toEqual(['charter', 'charter'])
    expect((await ctx.approvals.get(waitedOn))?.resolution).toBeUndefined()
    // The move is taken once the output checks: the same retry-safe key founds the project then.
    spy.mockRestore()
    expect(await ok(call('board_charter', { projectId: 'p3', title: 'Other', charter: CHARTER, clientRequestId: 'found-p3' }))).toMatchObject({ projectId: 'p3', state: 'proposed', charterVersion: 1 })
    expect(await ok(call('board_pause', { projectId: 'p2' }, 'operator'))).toMatchObject({ state: 'paused' })
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

describe('ctx.board (store-backed): the defect link (PROP-0016 I4)', () => {
  const finished = async (ctx: Context, title: string): Promise<BoardTask> => {
    const t = await ready(ctx, task('p2', title))
    const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(t.taskId, generation, { runId: `run-${title}` }, at(3))
    const r = result(ctx, title)
    await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: HEAD }, at(4))
    return ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, r), at(5))
  }

  it('files a task with the defect it fixes, and links an existing task once, as the lead, the reviewer, or the operator, only to a done task of its project', async () => {
    const b = await boot()
    const { ctx } = b
    const call = caller(b)
    await active(ctx)
    const landed = await finished(ctx, 'landed')
    const filed = await ctx.board.propose(task('p2', 'fix', { fixes: { taskId: landed.taskId, sha: 'abc1234' } }), at(6))
    expect(filed).toMatchObject({ schema: 'board-task@1.2', defect: { fixes: landed.taskId, sha: 'abc1234', by: 'filed', at: at(6).toISOString() } })
    expect((await ctx.board.task(filed.taskId))?.defect).toEqual(filed.defect)
    // Refused: a task not done, an unknown one, a bad sha.
    const open = await ctx.board.propose(task('p2', 'open'), at(6))
    expect(await failureOf(ctx.board.propose(task('p2', 'x', { fixes: { taskId: open.taskId, sha: 'abc1234' } }), at(6)))).toBe('invalid')
    expect(await failureOf(ctx.board.propose(task('p2', 'x', { fixes: { taskId: 'task-nope', sha: 'abc1234' } }), at(6)))).toBe('invalid')
    expect(await failureOf(ctx.board.propose(task('p2', 'x', { fixes: { taskId: landed.taskId, sha: 'xyz' } }), at(6)))).toBe('invalid')
    // Linked later, as the lead (the default), once.
    const later = await ctx.board.propose(task('p2', 'later'), at(7))
    expect(await ok(call('board_defect', { taskId: later.taskId, fixes: landed.taskId, sha: 'abc1234' }))).toMatchObject({ taskId: later.taskId })
    expect((await ctx.board.task(later.taskId))?.defect).toMatchObject({ fixes: landed.taskId, by: 'lead' })
    expect((await call('board_defect', { taskId: later.taskId, fixes: landed.taskId, sha: 'abc1234' })).content[0]?.text).toMatch(/^invalid: .*already fixes/)
    const reviewed = await ctx.board.propose(task('p2', 'reviewed'), at(7))
    await ok(call('board_defect', { taskId: reviewed.taskId, fixes: landed.taskId, sha: 'abc1234', as: 'reviewer' }))
    expect((await ctx.board.task(reviewed.taskId))?.defect?.by).toBe('reviewer')
    const byOperator = await ctx.board.propose(task('p2', 'operator'), at(7))
    await ok(call('board_defect', { taskId: byOperator.taskId, fixes: landed.taskId, sha: 'abc1234', as: 'lead' }, 'operator'))
    expect((await ctx.board.task(byOperator.taskId))?.defect?.by).toBe('operator')
    expect((await call('board_defect', { taskId: open.taskId, fixes: open.taskId, sha: 'abc1234' })).content[0]?.text).toMatch(/^invalid/)
  })
})

describe('ctx.board (store-backed): the TASKS.md projection', () => {
  it('renders one project\'s board deterministically: ids, titles, states, acceptance checkboxes, dependencies, holders, and why a task waits, with its questions or the funding it asks for', async () => {
    const b = await boot()
    const { ctx } = b
    await active(ctx)
    const done = await ready(ctx, task('p2', 'Baseline'))
    let { generation } = await ctx.board.claim(done.taskId, 'lead', 600_000, at(3))
    await ctx.board.start(done.taskId, generation, { runId: 'run-1' }, at(3))
    const r = result(ctx, 'baseline')
    await ctx.board.submit(done.taskId, generation, { artifacts: [r], subject: HEAD }, at(3))
    await ctx.board.accept(done.taskId, acceptance(ctx, 'accept', done.taskId, r), at(3))
    const held = await ready(ctx, task('p2', 'Kernel', { goal: 'Write the kernel.\n## Not a heading of the board', dependsOn: [done.taskId] }), at(4))
    ;({ generation } = await ctx.board.claim(held.taskId, 'lead', 600_000, at(4)))
    const asks = await ready(ctx, task('p2', 'Asks'), at(4))
    const g = (await ctx.board.claim(asks.taskId, 'lead', 600_000, at(4))).generation
    await ctx.board.start(asks.taskId, g, { runId: 'run-2' }, at(4))
    await ctx.board.block(asks.taskId, g, { reason: 'question', questions: ['Band width 64?'] }, at(4))
    const spent = await ready(ctx, task('p2', 'Spent', { budget: [{ pool: 'max.programmatic', unit: 'usd', amount: 10 }, { pool: 'max.programmatic', unit: 'tokens', amount: 1000 }] }), at(4))
    const s = (await ctx.board.claim(spent.taskId, 'lead', 600_000, at(4))).generation
    await ctx.board.start(spent.taskId, s, { runId: 'run-3' }, at(4))
    await ctx.board.block(spent.taskId, s, { reason: 'budget-spent', funding: [{ pool: 'max.programmatic', unit: 'usd', amount: 4 }, { pool: 'max.programmatic', unit: 'tokens', amount: 500 }] }, at(4))
    const merge = await ctx.board.propose(task('p2', 'Merge', { actionClass: 'merge' }), at(4))
    await ctx.board.sweep(at(4))

    const md = await b.board().tasksMarkdown('p2')
    expect(await b.board().tasksMarkdown('p2')).toBe(md)
    await b.restartBoard()
    expect(await b.board().tasksMarkdown('p2')).toBe(md)
    expect(md).toMatch(/^<!-- TASKS\.md for project p2: a projection/)
    expect(md).toContain('# project p2')
    for (const t of [done, held, asks, spent, merge]) expect(md).toContain(`- id: \`${t.taskId}\``)
    expect(md.indexOf('## In progress')).toBeLessThan(md.indexOf('## Waiting'))
    expect(md.indexOf('## Waiting')).toBeLessThan(md.indexOf('## Done'))
    expect(md).toContain('- state: claimed')
    expect(md).toContain(`- holder: lead (generation ${generation}, lease until ${new Date(at(4).getTime() + 600_000).toISOString()})`)
    expect(md).toContain(`- depends on: \`${done.taskId}\``)
    expect(md).toContain('- [ ] a1: tests pass (tests)')
    expect(md).toContain('- [x] a1: tests pass (tests)')
    expect(md).toMatch(/- waiting: for input \(question\) since [^\n]+\n {2}1\. Band width 64\?/)
    expect(md).toMatch(/- waiting: for approval \(approval-needed, request `apr-[^`]+`\)/)
    // A spent budget's ask: the exact lines its request would add.
    expect(md).toMatch(/- waiting: for approval \(budget-spent, request `apr-[^`]+`\) since [^\n]+\n {2}- funding asked: \+4 usd of max\.programmatic, \+500 tokens of max\.programmatic\n/)
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
