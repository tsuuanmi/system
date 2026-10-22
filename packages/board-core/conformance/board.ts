/**
 * Conformance suite for `ctx.board` (ADR-0037; docs/design/board.md), and a fake provider that
 * passes it. `boot` returns a context that provides `ctx.board`, `ctx.approvals` configured with
 * the approvals suite's `POLICIES`, and `ctx.artifacts`, with no project.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { canonicalJson, SchemaRegistry } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import type {} from '@tsuuanmi/system-approvals-core'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type ActionClass, type ArtifactRef, Board, BoardError, type BoardTask, type CancelReason, type Charter, type CharterInput, type Claim, type Project,
  type ProjectState, type Subject, type TaskInput, type TaskState, TERMINAL, type WaitReason,
} from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

const T0 = new Date('2026-10-22T09:00:00Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
const schemas = new SchemaRegistry()

export const CHARTER: Charter = {
  version: 1,
  intent: 'A kernel at least 3x faster with identical scores.',
  criteria: [{ id: 'speed', statement: 'Median speed-up at least 3x', measure: { kind: 'benchmark', target: 3, comparison: 'at-least', unit: 'x' } }],
  constraints: {},
  stopRules: [{ id: 'no-gain', condition: 'Below 1.5x after two milestones', action: 'pivot' }],
  budget: { pools: [{ pool: 'max.programmatic', unit: 'usd', amount: 100 }] },
}
const task = (projectId: string, title: string, extra: Partial<TaskInput> = {}): TaskInput => ({
  projectId, title, goal: `do ${title}`, acceptance: [{ id: 'a1', statement: 'tests pass', check: 'tests' }], actionClass: 'read', ...extra,
})

const validTask = (t: BoardTask): BoardTask => {
  schemas.assertRecord(t)
  return t
}
const validProject = (p: Project): Project => {
  schemas.assertRecord(p)
  return p
}
const decisionOf = (ctx: Context, ref: ArtifactRef | undefined): { decisionType: string; outcome: { option: string } } => {
  expect(ref, 'a decision').toBeDefined()
  const envelope = ctx.artifacts.get(ref!)
  expect(envelope?.kind).toBe('decision')
  return envelope!.body as { decisionType: string; outcome: { option: string } }
}
const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof BoardError ? error.failure : `not a BoardError: ${String(error)}`
  }
}
const stateOf = async (ctx: Context, taskId: string): Promise<TaskState | undefined> => (await ctx.board.task(taskId))?.state
const decide = async (ctx: Context, requestId: string, verdict: 'approved' | 'rejected', when: Date): Promise<void> => {
  const request = await ctx.approvals.get(requestId)
  const [result] = await ctx.approvals.decide([{ requestId, subject: request!.subject, verdict }], when)
  expect(result?.refused).toBeUndefined()
}
/** An active project: founded, its charter approved by the operator, swept. */
const active = async (ctx: Context, projectId = 'p1'): Promise<Project> => {
  const { approvalRequest } = await ctx.board.charter({ projectId, title: `project ${projectId}`, charter: CHARTER }, T0)
  await decide(ctx, approvalRequest, 'approved', at(1))
  await ctx.board.sweep(at(1))
  return (await ctx.board.project(projectId))!
}
/** A ready task of an active project. */
const ready = async (ctx: Context, input: TaskInput): Promise<BoardTask> => {
  const proposed = await ctx.board.propose(input, at(2))
  await ctx.board.sweep(at(2))
  expect(await stateOf(ctx, proposed.taskId)).toBe('ready')
  return (await ctx.board.task(proposed.taskId))!
}
const acceptance = (ctx: Context, option: 'accept' | 'reject', result: ArtifactRef): ArtifactRef => ctx.artifacts.recordDecision({
  decisionType: 'acceptance', question: `Does ${result} satisfy the criteria?`, inputs: [result],
  candidates: [{ option: 'accept', selected: option === 'accept', reasons: [] }, { option: 'reject', selected: option === 'reject', reasons: [] }],
  decider: { type: 'rule', id: 'acceptance.conformance', version: '1' }, outcome: { option }, deterministic: true,
}, { producer: { type: 'policy', ref: 'conformance' } }).id as ArtifactRef
const result = (ctx: Context, text: string): ArtifactRef => ctx.artifacts.put({
  kind: 'report', bodySchema: 'agent-result@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'conformance' },
  body: { schema: 'agent-result@1.0', worker: 'w', runtime: 'fake', runId: 'r', promptHash: `sha256:${'0'.repeat(64)}`, sandbox: 'read-only', text },
}).id as ArtifactRef
const HEAD: Subject = { type: 'git-head', ref: 'HEAD', version: 'abc123' }

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>): Scenario<Boot> => ({
  id: `board.${id}`, since: '1.0', title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const boardSuite = defineSuite<Boot>({
  seam: 'board',
  contract: '1.0',
  scenarios: [
    scenario('charter-approved-activates', 'starts work only under a charter the operator approved, bound to that charter version (INV-5, INV-6)', async (ctx) => {
      const { project, approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: CHARTER }, T0)
      expect(validProject(project)).toMatchObject({ projectId: 'p1', state: 'proposed', charter: { version: 1 }, revision: 0 })
      const request = await ctx.approvals.get(approvalRequest)
      expect(request).toMatchObject({ action: { class: 'charter' }, requester: { component: 'board', projectId: 'p1' }, subject: { type: 'content', ref: 'project:p1:charter:1' } })
      const early = await ctx.board.propose(task('p1', 'early'), T0)
      await ctx.board.sweep(at(1))
      expect(await stateOf(ctx, early.taskId)).toBe('proposed')
      await decide(ctx, approvalRequest, 'approved', at(2))
      const { projects } = await ctx.board.sweep(at(2))
      expect(projects.map((p) => p.projectId)).toEqual(['p1'])
      const activated = validProject((await ctx.board.project('p1'))!)
      expect(activated.state).toBe('active')
      expect(activated.charter.approval).toBe((await ctx.approvals.get(approvalRequest))?.resolution?.approval)
      expect(decisionOf(ctx, activated.lastDecision).decisionType).toBe('approval')
      await ctx.board.sweep(at(3))
      expect(await stateOf(ctx, early.taskId)).toBe('ready')
    }),
    scenario('charter-rejected-abandons', 'closes a project whose first charter is rejected or expires, as abandoned (INV-2)', async (ctx) => {
      const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: CHARTER }, T0)
      await decide(ctx, approvalRequest, 'rejected', at(1))
      await ctx.board.sweep(at(1))
      expect(validProject((await ctx.board.project('p1'))!)).toMatchObject({ state: 'closed', closure: { outcome: 'abandoned' } })
      const second = await ctx.board.charter({ projectId: 'p2', title: 'Other', charter: CHARTER }, T0)
      await ctx.approvals.sweep(at(60 * 24 * 30))
      await ctx.board.sweep(at(60 * 24 * 30))
      expect((await ctx.board.project('p2'))?.closure?.outcome).toBe('abandoned')
      expect((await ctx.approvals.get(second.approvalRequest))?.resolution?.cause).toBe('expired')
    }),
    scenario('charter-amendment', 'holds an amended charter until it is approved, keeping the project\'s state, and refuses a wrong version', async (ctx) => {
      await active(ctx)
      expect(await failureOf(ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: { ...CHARTER, version: 3 } }, at(5)))).toBe('invalid')
      expect(await failureOf(ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: { ...CHARTER, version: 2, approval: `sha256:${'1'.repeat(64)}` } }, at(5)))).toBe('invalid')
      const { project, approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: { ...CHARTER, version: 2, intent: 'A kernel at least 2x faster.' } }, at(5))
      expect(validProject(project)).toMatchObject({ state: 'active', charter: { version: 1 }, proposedCharter: { version: 2 } })
      await decide(ctx, approvalRequest, 'approved', at(6))
      await ctx.board.sweep(at(6))
      const amended = validProject((await ctx.board.project('p1'))!)
      expect(amended).toMatchObject({ state: 'active', charter: { version: 2, intent: 'A kernel at least 2x faster.' } })
      expect(amended.proposedCharter).toBeUndefined()
    }),
    scenario('ready-after-dependencies', 'makes a task ready only once its dependencies are done and the policy allows it, naming the decision (INV-13)', async (ctx) => {
      await active(ctx)
      const a = await ctx.board.propose(task('p1', 'a'), at(2))
      const b = await ctx.board.propose(task('p1', 'b', { dependsOn: [a.taskId] }), at(2))
      expect(validTask(a)).toMatchObject({ state: 'proposed', attempts: { count: 0, max: 3 }, revision: 0 })
      await ctx.board.sweep(at(2))
      const readyA = validTask((await ctx.board.task(a.taskId))!)
      expect(readyA.state).toBe('ready')
      expect(decisionOf(ctx, readyA.lastDecision)).toMatchObject({ decisionType: 'board', outcome: { option: 'ready' } })
      expect(await stateOf(ctx, b.taskId)).toBe('proposed')
    }),
    scenario('ask-before-start', 'asks the operator before starting a task the policy says to ask about, and starts it only once approved (INV-2)', async (ctx) => {
      await active(ctx, 'p2')
      const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
      await ctx.board.sweep(at(2))
      const waiting = validTask((await ctx.board.task(merge.taskId))!)
      expect(waiting).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' } })
      const request = await ctx.approvals.get(waiting.waiting!.approvalRequest!)
      expect(request).toMatchObject({ state: 'open', action: { class: 'merge' }, requester: { component: 'board', projectId: 'p2', taskId: merge.taskId } })
      expect(waiting.waiting!.expiresAt).toBe(request!.expiresAt)
      await ctx.board.sweep(at(3))
      expect(await stateOf(ctx, merge.taskId)).toBe('waiting-for-approval')
      await decide(ctx, request!.requestId, 'approved', at(4))
      await ctx.board.sweep(at(4))
      expect(await stateOf(ctx, merge.taskId)).toBe('ready')
    }),
    scenario('rejection-waits-then-cancels', 'turns a rejected or expired approval into a wait for input, which cancels the task when it expires; nothing runs (INV-2, INV-9)', async (ctx) => {
      await active(ctx, 'p2')
      const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
      await ctx.board.sweep(at(2))
      const { waiting } = (await ctx.board.task(merge.taskId))!
      await ctx.approvals.sweep(new Date(Date.parse(waiting!.expiresAt)))
      await ctx.board.sweep(new Date(Date.parse(waiting!.expiresAt)))
      const rejected = validTask((await ctx.board.task(merge.taskId))!)
      expect(rejected).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' } })
      await ctx.board.sweep(new Date(Date.parse(rejected.waiting!.expiresAt) - 1))
      expect(await stateOf(ctx, merge.taskId)).toBe('waiting-for-input')
      await ctx.board.sweep(new Date(Date.parse(rejected.waiting!.expiresAt)))
      expect(validTask((await ctx.board.task(merge.taskId))!)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'input-expired' } })
    }),
    scenario('forbidden-never-runs', 'cancels a task whose action the policy forbids, without asking anyone (INV-2)', async (ctx) => {
      await active(ctx, 'p1')
      const merge = await ctx.board.propose(task('p1', 'merge', { actionClass: 'merge' }), at(2))
      await ctx.board.sweep(at(2))
      const cancelled = validTask((await ctx.board.task(merge.taskId))!)
      expect(cancelled).toMatchObject({ state: 'cancelled', cancellation: { reason: 'forbidden' } })
      expect(decisionOf(ctx, cancelled.lastDecision).decisionType).toBe('autonomy')
      expect(await ctx.approvals.list({ projectId: 'p1', states: ['open', 'batched'] })).toEqual([])
    }),
    scenario('lease-fences', 'gives a task one holder at a time, fences every write by its generation, and readies a claim whose lease lapsed before any run (INV-15, INV-4)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't'))
      const claim: Claim = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
      expect(claim).toMatchObject({ taskId: t.taskId, generation: 1, leaseExpiresAt: new Date(at(3).getTime() + 60_000).toISOString() })
      expect(validTask((await ctx.board.task(t.taskId))!)).toMatchObject({ state: 'claimed', holder: { owner: 'lead', generation: 1 } })
      expect(await failureOf(ctx.board.claim(t.taskId, 'other', 60_000, at(3)))).toBe('invalid-transition')
      expect(await failureOf(ctx.board.start(t.taskId, 2, { runId: 'r1' }, at(3)))).toBe('stale-generation')
      await ctx.board.sweep(at(5))
      expect(await stateOf(ctx, t.taskId)).toBe('ready')
      expect(await failureOf(ctx.board.start(t.taskId, 1, { runId: 'r1' }, at(5)))).toBe('stale-generation')
      const again = await ctx.board.claim(t.taskId, 'other', 60_000, at(5))
      expect(again.generation).toBe(2)
      const renewed = await ctx.board.renew(t.taskId, 2, 120_000, at(5.5))
      expect(renewed.leaseExpiresAt).toBe(new Date(at(5.5).getTime() + 120_000).toISOString())
      expect(await failureOf(ctx.board.renew(t.taskId, 1, 60_000, at(5.5)))).toBe('stale-generation')
    }),
    scenario('lost-run-never-restarts', 'records the run before it starts, and never starts a run again whose holder was lost: it waits for approval to run again (INV-4)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't'))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
      const running = validTask(await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3)))
      expect(running).toMatchObject({ state: 'running', run: { runId: 'run-1' }, attempts: { count: 1 } })
      await ctx.board.sweep(at(10))
      const lost = validTask((await ctx.board.task(t.taskId))!)
      expect(lost).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'reconciliation-failed' } })
      expect((await ctx.approvals.get(lost.waiting!.approvalRequest!))?.action.class).toBe('remediation')
      await decide(ctx, lost.waiting!.approvalRequest!, 'approved', at(11))
      await ctx.board.sweep(at(11))
      expect(validTask((await ctx.board.task(t.taskId))!)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    }),
    scenario('review-to-done', 'takes a result with its exact subject to review, never straight to done, and is done only by an accepting acceptance decision (INV-5, INV-13)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't', { maxAttempts: 2 }))
      let { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      const first = result(ctx, 'attempt 1')
      expect(validTask(await ctx.board.submit(t.taskId, generation, { artifacts: [first], subject: HEAD, files: ['src/a.ts'] }, at(4)))).toMatchObject({ state: 'review', result: { artifacts: [first] } })
      expect(await failureOf(ctx.board.accept(t.taskId, first, at(5)))).toBe('invalid')
      expect(validTask(await ctx.board.accept(t.taskId, acceptance(ctx, 'reject', first), at(5)))).toMatchObject({ state: 'ready', attempts: { count: 1, max: 2 } })
      ;({ generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(6)))
      await ctx.board.start(t.taskId, generation, { runId: 'run-2' }, at(6))
      const second = result(ctx, 'attempt 2')
      await ctx.board.submit(t.taskId, generation, { artifacts: [second], subject: HEAD }, at(7))
      const accepted = acceptance(ctx, 'accept', second)
      const done = validTask(await ctx.board.accept(t.taskId, accepted, at(8)))
      expect(done).toMatchObject({ state: 'done', result: { artifacts: [second], subject: HEAD, acceptance: accepted }, lastDecision: accepted })
      expect(done.holder).toBeUndefined()
      expect(done.run?.runId).toBe('run-2')
    }),
    scenario('retries-bounded', 'waits for input once review rejected the last attempt allowed (INV-9)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't', { maxAttempts: 1 }))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      const r = result(ctx, 'only attempt')
      await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: HEAD }, at(4))
      expect(validTask(await ctx.board.accept(t.taskId, acceptance(ctx, 'reject', r), at(5)))).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' } })
    }),
    scenario('block-and-answer', 'interrupts a running task: spent budget waits for approval, a question for input; answering every question makes it ready', async (ctx) => {
      await active(ctx)
      const spent = await ready(ctx, task('p1', 'spent'))
      let { generation } = await ctx.board.claim(spent.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(spent.taskId, generation, { runId: 'run-1' }, at(3))
      const budget = validTask(await ctx.board.block(spent.taskId, generation, { reason: 'budget-spent' }, at(4)))
      expect(budget).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'budget-spent' } })
      expect((await ctx.approvals.get(budget.waiting!.approvalRequest!))?.action.class).toBe('funding')
      const asks = await ready(ctx, task('p1', 'asks'))
      ;({ generation } = await ctx.board.claim(asks.taskId, 'lead', 600_000, at(3)))
      await ctx.board.start(asks.taskId, generation, { runId: 'run-2' }, at(3))
      const question = validTask(await ctx.board.block(asks.taskId, generation, { reason: 'question', questions: ['Band width 64?', 'Keep the API?'] }, at(4)))
      expect(question).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'question', questions: ['Band width 64?', 'Keep the API?'] } })
      expect(await failureOf(ctx.board.answer(asks.taskId, ['yes'], at(5)))).toBe('invalid')
      expect(validTask(await ctx.board.answer(asks.taskId, ['yes', 'no'], at(5)))).toMatchObject({ state: 'ready' })
    }),
    scenario('cancel-cascades', 'cancels a task not running, withdraws the approval it waited on, and cancels the tasks that depended on it', async (ctx) => {
      await active(ctx, 'p2')
      const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
      const after = await ctx.board.propose(task('p2', 'after', { dependsOn: [merge.taskId] }), at(2))
      await ctx.board.sweep(at(2))
      const requestId = (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!
      expect(validTask(await ctx.board.cancel(merge.taskId, 'lead', 'not needed', at(3)))).toMatchObject({ state: 'cancelled', cancellation: { reason: 'lead', note: 'not needed' } })
      expect((await ctx.approvals.get(requestId))?.resolution?.cause).toBe('withdrawn')
      await ctx.board.sweep(at(3))
      expect(validTask((await ctx.board.task(after.taskId))!)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'dependency-cancelled' } })
      const busy = await ready(ctx, task('p2', 'busy'))
      const { generation } = await ctx.board.claim(busy.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(busy.taskId, generation, { runId: 'run-1' }, at(3))
      expect(await failureOf(ctx.board.cancel(busy.taskId, 'operator', undefined, at(4)))).toBe('invalid-transition')
    }),
    scenario('propose-validates', 'refuses a task of an unknown project, with dependencies outside its project, or writing a subject another open task writes (INV-15)', async (ctx) => {
      await active(ctx, 'p1')
      await active(ctx, 'p2')
      expect(await failureOf(ctx.board.propose(task('nope', 'x'), at(2)))).toBe('unknown-project')
      const other = await ctx.board.propose(task('p2', 'other'), at(2))
      expect(await failureOf(ctx.board.propose(task('p1', 'x', { dependsOn: [other.taskId] }), at(2)))).toBe('invalid')
      expect(await failureOf(ctx.board.propose(task('p1', 'x', { dependsOn: ['task-unknown'] }), at(2)))).toBe('invalid')
      const branch: Subject = { type: 'git-head', ref: 'refs/heads/kernel' }
      await ctx.board.propose(task('p1', 'w1', { actionClass: 'workspace-write', writes: branch }), at(2))
      expect(await failureOf(ctx.board.propose(task('p1', 'w2', { actionClass: 'workspace-write', writes: branch }), at(2)))).toBe('conflict')
      expect(await failureOf(ctx.board.propose({ ...task('p1', 'x'), maxAttempts: 11 }, at(2)))).toBe('invalid')
      expect((await ctx.board.tasks({ projectId: 'p1' })).map((t) => t.title)).toEqual(['w1'])
    }),
    scenario('pause-and-close', 'starts nothing in a paused project, and closes a project only when nothing of it runs, cancelling its open tasks', async (ctx) => {
      await active(ctx)
      const t = await ctx.board.propose(task('p1', 't'), at(2))
      expect(validProject(await ctx.board.pause('p1', at(2)))).toMatchObject({ state: 'paused' })
      await ctx.board.sweep(at(2))
      expect(await stateOf(ctx, t.taskId)).toBe('proposed')
      await ctx.board.resume('p1', at(3))
      await ctx.board.sweep(at(3))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      const open = await ctx.board.propose(task('p1', 'open'), at(3))
      expect(await failureOf(ctx.board.close('p1', 'stopped', at(4)))).toBe('invalid-transition')
      await ctx.board.submit(t.taskId, generation, { artifacts: [result(ctx, 'r')], subject: HEAD }, at(4))
      await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', result(ctx, 'r')), at(5))
      const closed = validProject(await ctx.board.close('p1', 'achieved', at(6)))
      expect(closed).toMatchObject({ state: 'closed', closure: { outcome: 'achieved' } })
      expect((await ctx.board.task(open.taskId))?.cancellation?.reason).toBe('project-closed')
      expect(await failureOf(ctx.board.propose(task('p1', 'late'), at(7)))).toBe('invalid-transition')
    }),
  ],
})

const TTL_INPUT_SECONDS = 7 * 24 * 3600

/**
 * A fake provider of `ctx.board`: the protocol in memory. Approvals go through `ctx.approvals`,
 * decisions through `ctx.artifacts`.
 */
export class FakeBoard extends Board {
  static inject = ['artifacts', 'approvals']
  private readonly projectsById = new Map<string, Project>()
  private readonly tasksById = new Map<string, BoardTask>()
  /** Pending charter requests: request id → project and the version it would approve. */
  private readonly charters = new Map<string, { projectId: string; version: number }>()
  private generations = new Map<string, number>()

  constructor(ctx: Context, private readonly config: { inputExpirySeconds?: number } = {}) {
    super(ctx)
  }

  private decide(subject: string, from: string, to: string, at: Date, why: string): ArtifactRef {
    return this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'board', question: `Does ${subject} move from ${from} to ${to}?`, inputs: [],
      candidates: [{ option: to, selected: true, reasons: [why] }, { option: from, selected: false, reasons: [] }],
      decider: { type: 'rule', id: 'board.transition', version: '1' }, outcome: { option: to, detail: { subject, from, at: at.toISOString() } }, deterministic: true,
    }, { producer: { type: 'system', ref: 'board' } }).id as ArtifactRef
  }

  private save<T extends Project | BoardTask>(record: T, at: Date, changes: { [K in keyof T]?: T[K] | undefined }): T {
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete (record as unknown as Record<string, unknown>)[key]
      else (record as unknown as Record<string, unknown>)[key] = value
    }
    record.revision += 1
    record.updatedAt = at.toISOString()
    schemas.assertRecord(record)
    return structuredClone(record)
  }

  private projectOf(projectId: string): Project {
    const project = this.projectsById.get(projectId)
    if (!project) throw new BoardError('unknown-project', `no project ${projectId}`)
    return project
  }

  private taskOf(taskId: string): BoardTask {
    const task = this.tasksById.get(taskId)
    if (!task) throw new BoardError('unknown-task', `no task ${taskId}`)
    return task
  }

  private held(task: BoardTask, generation: number, at: Date): void {
    if (!task.holder || task.holder.generation !== generation || Date.parse(task.holder.leaseExpiresAt) <= at.getTime()) {
      throw new BoardError('stale-generation', `${task.taskId}: generation ${generation} does not hold it`)
    }
  }

  private expect(task: BoardTask, ...states: TaskState[]): void {
    if (!states.includes(task.state)) throw new BoardError('invalid-transition', `${task.taskId} is ${task.state}, not ${states.join(' or ')}`)
  }

  async charter(input: CharterInput, at: Date = new Date()) {
    if (input.charter.approval !== undefined) throw new BoardError('invalid', 'a charter never carries its approval in')
    const existing = input.projectId === undefined ? undefined : this.projectsById.get(input.projectId)
    const projectId = input.projectId ?? `proj-${randomUUID().slice(0, 8)}`
    const version = existing ? existing.charter.version + 1 : 1
    if (input.charter.version !== version) throw new BoardError('invalid', `the charter version must be ${version}`)
    if (existing && existing.state !== 'active' && existing.state !== 'paused') throw new BoardError('invalid-transition', `${projectId} is ${existing.state}`)
    const verdict = await this.ctx.approvals.check({ class: 'charter', projectId })
    if (verdict.mode !== 'ask') throw new BoardError('invalid', `a charter is always asked about; the policy says ${verdict.mode}`)
    const hash = `sha256:${createHash('sha256').update(canonicalJson(input.charter)).digest('hex')}`
    const request = await this.ctx.approvals.request({
      subject: { type: 'content', ref: `project:${projectId}:charter:${version}`, version: hash },
      action: { class: 'charter', summary: `${existing ? 'Amend' : 'Found'} ${input.title}: ${input.charter.intent}`.slice(0, 500) },
      requester: { component: 'board', projectId }, verdict, classification: input.classification ?? 'operator-shared',
    }, at)
    this.charters.set(request.requestId, { projectId, version })
    if (existing) return { project: this.save(existing, at, { proposedCharter: input.charter }), approvalRequest: request.requestId }
    const project: Project = {
      schema: 'project@1.0', projectId, title: input.title, state: 'proposed', charter: input.charter, milestones: input.milestones ?? [],
      ...(input.template ? { template: input.template } : {}), ...(input.classification ? { classification: input.classification } : {}),
      createdAt: at.toISOString(), revision: 0,
    }
    schemas.assertRecord(project)
    this.projectsById.set(projectId, project)
    return { project: structuredClone(project), approvalRequest: request.requestId }
  }

  async project(projectId: string) {
    const p = this.projectsById.get(projectId)
    return p && structuredClone(p)
  }

  async projects(filter: { state?: ProjectState } = {}) {
    return [...this.projectsById.values()].filter((p) => filter.state === undefined || p.state === filter.state).map((p) => structuredClone(p))
  }

  async pause(projectId: string, at: Date = new Date()) {
    const project = this.projectOf(projectId)
    if (project.state !== 'active') throw new BoardError('invalid-transition', `${projectId} is ${project.state}`)
    return this.save(project, at, { state: 'paused', lastDecision: this.decide(projectId, 'active', 'paused', at, 'paused') })
  }

  async resume(projectId: string, at: Date = new Date()) {
    const project = this.projectOf(projectId)
    if (project.state !== 'paused') throw new BoardError('invalid-transition', `${projectId} is ${project.state}`)
    return this.save(project, at, { state: 'active', lastDecision: this.decide(projectId, 'paused', 'active', at, 'resumed') })
  }

  async close(projectId: string, outcome: 'achieved' | 'stopped', at: Date = new Date()) {
    const project = this.projectOf(projectId)
    if (project.state === 'closed' || project.state === 'proposed') throw new BoardError('invalid-transition', `${projectId} is ${project.state}`)
    const tasks = [...this.tasksById.values()].filter((t) => t.projectId === projectId)
    if (tasks.some((t) => t.state === 'running' || t.state === 'review')) throw new BoardError('invalid-transition', `${projectId} has a task running or in review`)
    for (const t of tasks) if (!TERMINAL.includes(t.state)) await this.cancelTask(t, 'project-closed', at)
    const decision = this.decide(projectId, project.state, 'closed', at, outcome)
    return this.save(project, at, { state: 'closed', closure: { outcome, decision, at: at.toISOString() }, lastDecision: decision, proposedCharter: undefined })
  }

  async propose(input: TaskInput, at: Date = new Date()) {
    const project = this.projectOf(input.projectId)
    if (project.state === 'closed') throw new BoardError('invalid-transition', `${input.projectId} is closed`)
    for (const dep of input.dependsOn ?? []) {
      if (this.tasksById.get(dep)?.projectId !== input.projectId) throw new BoardError('invalid', `dependency ${dep} is not a task of ${input.projectId}`)
    }
    if (input.writes) {
      const same = (s: Subject | undefined) => s?.type === input.writes!.type && s.ref === input.writes!.ref
      if ([...this.tasksById.values()].some((t) => !TERMINAL.includes(t.state) && same(t.writes))) throw new BoardError('conflict', `another open task writes ${input.writes.ref}`)
    }
    const task: BoardTask = {
      schema: 'board-task@1.0', taskId: `task-${randomUUID().slice(0, 8)}`, projectId: input.projectId, title: input.title, goal: input.goal,
      acceptance: input.acceptance, dependsOn: input.dependsOn ?? [], actionClass: input.actionClass, state: 'proposed',
      attempts: { count: 0, max: input.maxAttempts ?? 3 }, createdAt: at.toISOString(), revision: 0,
      ...(input.milestone ? { milestone: input.milestone } : {}), ...(input.template ? { template: input.template } : {}),
      ...(input.writes ? { writes: input.writes } : {}), ...(input.budget ? { budget: input.budget } : {}),
    }
    try {
      schemas.assertRecord(task)
    } catch (error) {
      throw new BoardError('invalid', (error as Error).message)
    }
    this.tasksById.set(task.taskId, task)
    return structuredClone(task)
  }

  async task(taskId: string) {
    const t = this.tasksById.get(taskId)
    return t && structuredClone(t)
  }

  async tasks(filter: { projectId: string; states?: TaskState[] }) {
    return [...this.tasksById.values()].filter((t) => t.projectId === filter.projectId && (filter.states === undefined || filter.states.includes(t.state)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId)).map((t) => structuredClone(t))
  }

  private lease(task: BoardTask, owner: string, ttlMs: number, at: Date, generation: number): Claim {
    const leaseExpiresAt = new Date(at.getTime() + ttlMs).toISOString()
    task.holder = { owner, generation, leaseExpiresAt }
    return { taskId: task.taskId, generation, leaseExpiresAt }
  }

  async claim(taskId: string, owner: string, ttlMs: number, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.expect(task, 'ready')
    if (this.projectOf(task.projectId).state !== 'active') throw new BoardError('invalid-transition', `${task.projectId} is not active`)
    const generation = (this.generations.get(taskId) ?? 0) + 1
    this.generations.set(taskId, generation)
    const claim = this.lease(task, owner, ttlMs, at, generation)
    this.save(task, at, { state: 'claimed', lastDecision: this.decide(taskId, 'ready', 'claimed', at, `lease ${generation} taken by ${owner}`) })
    return claim
  }

  async renew(taskId: string, generation: number, ttlMs: number, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.held(task, generation, at)
    const claim = this.lease(task, task.holder!.owner, ttlMs, at, generation)
    this.save(task, at, {})
    return claim
  }

  async start(taskId: string, generation: number, run: { runId: string; brief?: ArtifactRef }, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.held(task, generation, at)
    this.expect(task, 'claimed')
    return this.save(task, at, {
      state: 'running', run: { runId: run.runId, ...(run.brief ? { brief: run.brief } : {}), startedAt: at.toISOString() },
      attempts: { ...task.attempts, count: task.attempts.count + 1 }, result: undefined,
      lastDecision: this.decide(taskId, 'claimed', 'running', at, `run ${run.runId} recorded before it starts`),
    })
  }

  async submit(taskId: string, generation: number, result: { artifacts: ArtifactRef[]; digest?: ArtifactRef; subject: Subject; files?: string[]; next?: string }, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.held(task, generation, at)
    this.expect(task, 'running')
    if (result.artifacts.some((a) => !this.ctx.artifacts.get(a))) throw new BoardError('invalid', 'a result artifact is unknown')
    return this.save(task, at, { state: 'review', result, lastDecision: this.decide(taskId, 'running', 'review', at, 'result recorded') })
  }

  async accept(taskId: string, acceptance: ArtifactRef, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.expect(task, 'review')
    const body = this.ctx.artifacts.get(acceptance)?.body as { decisionType?: string; outcome?: { option?: string } } | undefined
    if (body?.decisionType !== 'acceptance') throw new BoardError('invalid', `${acceptance} is not an acceptance decision`)
    if (body.outcome?.option === 'accept') {
      return this.save(task, at, { state: 'done', result: { ...task.result!, acceptance }, holder: undefined, lastDecision: acceptance })
    }
    if (task.attempts.count < task.attempts.max) return this.save(task, at, { state: 'ready', holder: undefined, run: undefined, result: undefined, lastDecision: acceptance })
    return this.save(task, at, { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('retries-spent', at), lastDecision: acceptance })
  }

  private inputWait(reason: WaitReason, at: Date, questions?: string[]): BoardTask['waiting'] {
    return { reason, ...(questions ? { questions } : {}), since: at.toISOString(), expiresAt: new Date(at.getTime() + (this.config.inputExpirySeconds ?? TTL_INPUT_SECONDS) * 1000).toISOString() }
  }

  /** Ask the policy about `actionClass` for this task: run, wait for approval, or never run. */
  private async gate(task: BoardTask, actionClass: ActionClass, reason: 'approval-needed' | 'budget-spent' | 'reconciliation-failed', at: Date): Promise<BoardTask> {
    const verdict = await this.ctx.approvals.check({ class: actionClass, projectId: task.projectId })
    if (verdict.mode === 'forbid') return this.cancelTask(task, 'forbidden', at, verdict.decision)
    if (verdict.mode === 'auto' || verdict.mode === 'notify') return this.save(task, at, { state: 'ready', holder: undefined, run: undefined, waiting: undefined, lastDecision: verdict.decision })
    const request = await this.ctx.approvals.request({
      subject: { type: 'content', ref: `board-task:${task.taskId}:attempt:${task.attempts.count}`, version: reason },
      action: { class: actionClass, summary: `${reason}: ${task.title}`.slice(0, 500) },
      requester: { component: 'board', projectId: task.projectId, taskId: task.taskId, ...(task.run ? { runId: task.run.runId } : {}) },
      verdict, classification: this.projectOf(task.projectId).classification ?? 'operator-shared',
    }, at)
    return this.save(task, at, {
      state: 'waiting-for-approval', holder: undefined,
      waiting: { reason, approvalRequest: request.requestId, since: at.toISOString(), expiresAt: request.expiresAt }, lastDecision: verdict.decision,
    })
  }

  async block(taskId: string, generation: number, wait: { reason: 'budget-spent' | 'reconciliation-failed' | 'question'; questions?: string[] }, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.held(task, generation, at)
    this.expect(task, 'running')
    if (wait.reason === 'question') {
      if (!wait.questions?.length) throw new BoardError('invalid', 'a question wait names its questions')
      return this.save(task, at, { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('question', at, wait.questions), lastDecision: this.decide(taskId, 'running', 'waiting-for-input', at, 'question') })
    }
    return this.gate(task, wait.reason === 'budget-spent' ? 'funding' : 'remediation', wait.reason, at)
  }

  async answer(taskId: string, answers: string[], at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.expect(task, 'waiting-for-input')
    if (task.waiting?.reason !== 'question' || answers.length !== (task.waiting.questions?.length ?? 0)) throw new BoardError('invalid', 'answer every question of a question wait')
    return this.save(task, at, { state: 'ready', waiting: undefined, lastDecision: this.decide(taskId, 'waiting-for-input', 'ready', at, 'answered') })
  }

  private async cancelTask(task: BoardTask, reason: CancelReason, at: Date, decision?: ArtifactRef, note?: string): Promise<BoardTask> {
    if (task.waiting?.approvalRequest) await this.ctx.approvals.withdraw(task.waiting.approvalRequest, at)
    return this.save(task, at, {
      state: 'cancelled', holder: undefined, waiting: undefined, cancellation: { reason, ...(note ? { note } : {}), at: at.toISOString() },
      lastDecision: decision ?? this.decide(task.taskId, task.state, 'cancelled', at, reason),
    })
  }

  async cancel(taskId: string, reason: 'operator' | 'lead' | 'superseded', note?: string, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.expect(task, 'proposed', 'ready', 'claimed', 'waiting-for-input', 'waiting-for-approval')
    return this.cancelTask(task, reason, at, undefined, note)
  }

  async sweep(at: Date) {
    const moved = new Map<string, BoardTask>()
    const movedProjects = new Map<string, Project>()
    // Charters: an approved one takes effect; a refused first charter abandons its project.
    for (const [requestId, { projectId, version }] of this.charters) {
      const request = await this.ctx.approvals.get(requestId)
      if (!request?.resolution) continue
      this.charters.delete(requestId)
      const project = this.projectOf(projectId)
      const approved = request.state === 'approved'
      if (project.state === 'proposed') {
        movedProjects.set(projectId, approved
          ? this.save(project, at, { state: 'active', charter: { ...project.charter, approval: request.resolution.approval! }, lastDecision: request.resolution.decision })
          : this.save(project, at, { state: 'closed', closure: { outcome: 'abandoned', decision: request.resolution.decision, at: at.toISOString() }, lastDecision: request.resolution.decision }))
      } else if (project.proposedCharter?.version === version) {
        movedProjects.set(projectId, this.save(project, at, approved
          ? { charter: { ...project.proposedCharter, approval: request.resolution.approval! }, proposedCharter: undefined, lastDecision: request.resolution.decision }
          : { proposedCharter: undefined, lastDecision: request.resolution.decision }))
      }
    }
    for (const task of [...this.tasksById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const project = this.projectOf(task.projectId)
      const now = at.getTime()
      if (task.state === 'proposed') {
        const deps = task.dependsOn.map((d) => this.taskOf(d))
        if (deps.some((d) => d.state === 'cancelled')) moved.set(task.taskId, await this.cancelTask(task, 'dependency-cancelled', at))
        else if (project.state === 'active' && deps.every((d) => d.state === 'done')) {
          const verdict = await this.ctx.approvals.check({ class: task.actionClass, projectId: task.projectId })
          if (verdict.mode === 'ask') moved.set(task.taskId, await this.gate(task, task.actionClass, 'approval-needed', at))
          else if (verdict.mode === 'forbid') moved.set(task.taskId, await this.cancelTask(task, 'forbidden', at, verdict.decision))
          else moved.set(task.taskId, this.save(task, at, { state: 'ready', lastDecision: this.decide(task.taskId, 'proposed', 'ready', at, `dependencies done; policy ${verdict.mode}`) }))
        }
      } else if (task.state === 'claimed' && Date.parse(task.holder!.leaseExpiresAt) <= now) {
        moved.set(task.taskId, this.save(task, at, { state: 'ready', holder: undefined, lastDecision: this.decide(task.taskId, 'claimed', 'ready', at, 'lease lapsed before any run') }))
      } else if (task.state === 'running' && Date.parse(task.holder!.leaseExpiresAt) <= now) {
        moved.set(task.taskId, await this.gate(task, 'remediation', 'reconciliation-failed', at))
      } else if (task.state === 'waiting-for-approval') {
        const request = await this.ctx.approvals.get(task.waiting!.approvalRequest!)
        if (request?.state === 'approved') moved.set(task.taskId, this.save(task, at, { state: 'ready', waiting: undefined, run: undefined, lastDecision: request.resolution!.decision }))
        else if (request?.state === 'rejected') moved.set(task.taskId, this.save(task, at, { state: 'waiting-for-input', waiting: this.inputWait('rejected', at), lastDecision: request.resolution!.decision }))
      } else if (task.state === 'waiting-for-input' && Date.parse(task.waiting!.expiresAt) <= now) {
        moved.set(task.taskId, await this.cancelTask(task, 'input-expired', at))
      }
    }
    return { tasks: [...moved.values()], projects: [...movedProjects.values()] }
  }
}
