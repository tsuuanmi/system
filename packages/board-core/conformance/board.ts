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
import { type Action, type ApprovalRequest, type AutonomyPolicy, waitSeconds } from '@tsuuanmi/system-approvals-core'
import { POLICIES } from '../../approvals-core/conformance/approvals.ts'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type ActionClass, type ArtifactRef, Board, BoardError, type BoardTask, type CancelReason, type Charter, type CharterInput, type Claim, type Project, type RunOutcome,
  type ProjectState, type Subject, type TaskInput, type TaskState, TERMINAL, type WaitReason,
} from '../src/index.ts'

export type Boot = () => Promise<{
  ctx: Context
  dispose: () => Promise<void>
  /**
   * The operator's policy change: from now on `ctx.approvals` judges under `policies`, as after a
   * restart with that configuration, its queue kept. The next `ctx.approvals.sweep` withdraws the
   * open requests they no longer ask for.
   */
  changePolicies: (policies: readonly AutonomyPolicy[]) => Promise<void>
}>

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
/**
 * An `acceptance` decision on one task's result: it names the task and the result's exact subject,
 * lists the result's artifacts as inputs, and reports the checks it ran; by a rule unless `by` is the operator.
 */
const acceptance = (
  ctx: Context, option: 'accept' | 'reject', taskId: string, results: ArtifactRef | ArtifactRef[],
  extra: { subject?: Subject; checks?: Action['checks']; by?: 'rule' | 'operator' } = {},
): ArtifactRef => {
  const inputs = Array.isArray(results) ? results : [results]
  const operator = extra.by === 'operator'
  return ctx.artifacts.recordDecision({
    decisionType: 'acceptance', question: `Does the result of ${taskId} satisfy the criteria?`, inputs,
    candidates: [
      { option: 'accept', selected: option === 'accept', reasons: [option === 'accept' ? 'the criteria hold' : 'not accept: the criteria fail'] },
      { option: 'reject', selected: option === 'reject', reasons: [option === 'reject' ? 'the criteria fail' : 'not reject: the criteria hold'] },
    ],
    decider: operator ? { type: 'operator', id: 'operator', version: '1' } : { type: 'rule', id: 'acceptance.conformance', version: '1' },
    outcome: { option, detail: { taskId, subject: extra.subject ?? HEAD, ...(extra.checks ? { checks: extra.checks } : {}) } }, deterministic: !operator,
  }, { producer: operator ? { type: 'operator', ref: 'operator' } : { type: 'policy', ref: 'conformance' } }).id as ArtifactRef
}
const result = (ctx: Context, text: string): ArtifactRef => ctx.artifacts.put({
  kind: 'report', bodySchema: 'agent-result@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'conformance' },
  body: { schema: 'agent-result@1.0', worker: 'w', runtime: 'fake', runId: 'r', promptHash: `sha256:${'0'.repeat(64)}`, sandbox: 'read-only', text },
}).id as ArtifactRef
const HEAD: Subject = { type: 'git-head', ref: 'HEAD', version: 'abc123' }
/** A `digest@1.0` report over `sources`, as a digest provider writes it (its envelope's inputs are its sources). */
const digestOf = (ctx: Context, sources: ArtifactRef[], summary = 'the result in short'): ArtifactRef => ctx.artifacts.put({
  kind: 'report', bodySchema: 'digest@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'conformance' }, inputs: sources,
  body: { schema: 'digest@1.0', sources, status: 'passed', summary, claims: [{ id: 'C1', kind: 'finding', text: 'it ran', citation: { artifact: sources[0]!, quote: 'attempt' } }] },
}).id as ArtifactRef

const scenario = (id: string, title: string, run: (ctx: Context, booted: { changePolicies: (policies: readonly AutonomyPolicy[]) => Promise<void> }) => Promise<void>, since: '1.0' | '1.1' = '1.0'): Scenario<Boot> => ({
  id: `board.${id}`, since, title,
  run: async (boot) => {
    const { ctx, dispose, changePolicies } = await boot()
    try {
      await run(ctx, { changePolicies })
    } finally {
      await dispose()
    }
  },
})

export const boardSuite = defineSuite<Boot>({
  seam: 'board',
  contract: '1.1',
  scenarios: [
    scenario('charter-approved-activates', 'starts work only under a charter the operator approved, bound to that charter version, with every milestone planned (INV-5, INV-6)', async (ctx) => {
      expect(await failureOf(ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: CHARTER, milestones: [{ id: 'm1', title: 'First', state: 'funded', funding: `sha256:${'1'.repeat(64)}` }] }, T0))).toBe('invalid')
      expect(await failureOf(ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: CHARTER, milestones: [{ id: 'm1', title: 'First', state: 'done' }] }, T0))).toBe('invalid')
      expect(await ctx.board.project('p1')).toBeUndefined()
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
    scenario('abandoned-cancels-tasks', 'cancels the open tasks of a project whose charter is refused, freeing the subjects they would write (INV-15)', async (ctx) => {
      const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'Kernel', charter: CHARTER }, T0)
      const branch: Subject = { type: 'git-head', ref: 'refs/heads/kernel' }
      const early = await ctx.board.propose(task('p1', 'early', { actionClass: 'workspace-write', writes: branch }), T0)
      await decide(ctx, approvalRequest, 'rejected', at(1))
      const { tasks, projects } = await ctx.board.sweep(at(1))
      expect(projects.map((p) => p.projectId)).toEqual(['p1'])
      expect(tasks.map((t) => t.taskId)).toEqual([early.taskId])
      expect(validProject((await ctx.board.project('p1'))!)).toMatchObject({ state: 'closed', closure: { outcome: 'abandoned' } })
      expect(validTask((await ctx.board.task(early.taskId))!)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'project-closed' } })
      await active(ctx, 'p2')
      expect((await ctx.board.propose(task('p2', 'again', { actionClass: 'workspace-write', writes: branch }), at(2))).state).toBe('proposed')
    }),
    scenario('waits-expire-on-their-own', 'applies an approval wait\'s expiry itself when the queue has not: a task waits for input, a first charter abandons its project, an amendment is dropped; nothing starts (INV-9)', async (ctx) => {
      await active(ctx, 'p2')
      const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge' }), at(2))
      await ctx.board.sweep(at(2))
      const waiting = (await ctx.board.task(merge.taskId))!
      const due = Date.parse(waiting.waiting!.expiresAt)
      await ctx.board.sweep(new Date(due - 1))
      expect(await stateOf(ctx, merge.taskId)).toBe('waiting-for-approval')
      // The queue's own sweep never ran: the board does not wait on it forever.
      await ctx.board.sweep(new Date(due))
      expect(validTask((await ctx.board.task(merge.taskId))!)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' } })
      expect(decisionOf(ctx, (await ctx.board.task(merge.taskId))!.lastDecision).outcome.option).toBe('waiting-for-input')

      const founded = await ctx.board.charter({ projectId: 'p3', title: 'Unanswered', charter: CHARTER }, at(2))
      const amended = await ctx.board.charter({ projectId: 'p2', title: 'project p2', charter: { ...CHARTER, version: 2, intent: 'Twice as fast.' } }, at(2))
      const late = new Date(Math.max(...await Promise.all([founded, amended].map(async (c) => Date.parse((await ctx.approvals.get(c.approvalRequest))!.expiresAt)))))
      await ctx.board.sweep(late)
      expect(validProject((await ctx.board.project('p3'))!)).toMatchObject({ state: 'closed', closure: { outcome: 'abandoned' } })
      const p2 = validProject((await ctx.board.project('p2'))!)
      expect(p2).toMatchObject({ state: 'active', charter: { version: 1 } })
      expect(p2.proposedCharter).toBeUndefined()

      // A task left waiting on a withdrawn request (a crash between a move and its withdrawal) expires the same way.
      await active(ctx, 'p1')
      const t = await ready(ctx, task('p1', 't'))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      await ctx.board.sweep(at(10))
      const lost = (await ctx.board.task(t.taskId))!
      await ctx.approvals.withdraw(lost.waiting!.approvalRequest!, at(11))
      await ctx.board.sweep(new Date(Date.parse(lost.waiting!.expiresAt)))
      expect(validTask((await ctx.board.task(t.taskId))!)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' } })
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
      // No input revives a rejected wait: it takes no answers and only expires.
      expect(await failureOf(ctx.board.answer(merge.taskId, [], at(3)))).toBe('invalid')
      expect(await failureOf(ctx.board.answer(merge.taskId, ['go on'], at(3)))).toBe('invalid')
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
      expect(validTask(await ctx.board.accept(t.taskId, acceptance(ctx, 'reject', t.taskId, first), at(5)))).toMatchObject({ state: 'ready', attempts: { count: 1, max: 2 } })
      ;({ generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(6)))
      await ctx.board.start(t.taskId, generation, { runId: 'run-2' }, at(6))
      const second = result(ctx, 'attempt 2')
      const notes = result(ctx, 'attempt 2 notes')
      await ctx.board.submit(t.taskId, generation, { artifacts: [second, notes], subject: HEAD }, at(7))
      // The decision binds to this task, the result's exact subject, and every artifact of it (INV-5).
      expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', 'task-another', [second, notes]), at(8)))).toBe('invalid')
      expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, [second, notes], { subject: { ...HEAD, version: 'def456' } }), at(8)))).toBe('invalid')
      expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, [second]), at(8)))).toBe('invalid')
      expect(await stateOf(ctx, t.taskId)).toBe('review')
      const accepted = acceptance(ctx, 'accept', t.taskId, [second, notes])
      const done = validTask(await ctx.board.accept(t.taskId, accepted, at(8)))
      expect(done).toMatchObject({ state: 'done', result: { artifacts: [second, notes], subject: HEAD, acceptance: accepted }, lastDecision: accepted })
      expect(done.holder).toBeUndefined()
      expect(done.run?.runId).toBe('run-2')
    }),
    scenario('checks-bind-at-acceptance', 'readies an auto task before its required checks run, and accepts it without the operator only once the acceptance reports them passed', async (ctx) => {
      await active(ctx, 'p2')
      const branch: Subject = { type: 'git-head', ref: 'refs/heads/kernel' }
      const at3 = { ...branch, version: 'abc123' }
      const w = await ready(ctx, task('p2', 'w', { actionClass: 'workspace-write', writes: branch }))
      const { generation } = await ctx.board.claim(w.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(w.taskId, generation, { runId: 'run-1' }, at(3))
      const r = result(ctx, 'kernel')
      // A task that writes a subject leaves its result on that subject (INV-15).
      expect(await failureOf(ctx.board.submit(w.taskId, generation, { artifacts: [r], subject: HEAD }, at(4)))).toBe('invalid')
      await ctx.board.submit(w.taskId, generation, { artifacts: [r], subject: at3 }, at(4))
      // Not the operator's, with required checks not reported: the board holds the review for the operator, lease released, within the policy's wait.
      const held = validTask(await ctx.board.accept(w.taskId, acceptance(ctx, 'accept', w.taskId, r, { subject: at3 }), at(5)))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'], expiresAt: new Date(at(5).getTime() + 3600_000).toISOString() } })
      expect(held.holder).toBeUndefined()
      expect(await failureOf(ctx.board.accept(w.taskId, acceptance(ctx, 'accept', w.taskId, r, { subject: at3, checks: { tests: true, lint: false } }), at(5)))).toBe('invalid')
      expect(await stateOf(ctx, w.taskId)).toBe('review')
      // Held, the review outlives any lease, and ends review-expired at its wait's expiry.
      await ctx.board.sweep(at(5 + 59))
      expect(await stateOf(ctx, w.taskId)).toBe('review')
      expect(validTask(await ctx.board.accept(w.taskId, acceptance(ctx, 'accept', w.taskId, r, { subject: at3, checks: { tests: true, lint: true } }), at(5)))).toMatchObject({ state: 'done' })

      // The operator's own acceptance needs no check; a rejection applies without one too.
      const other: Subject = { type: 'git-head', ref: 'refs/heads/other', version: 'abc123' }
      const o = await ready(ctx, task('p2', 'o', { actionClass: 'workspace-write', writes: { type: 'git-head', ref: 'refs/heads/other' }, maxAttempts: 2 }))
      let claim = await ctx.board.claim(o.taskId, 'lead', 600_000, at(6))
      await ctx.board.start(o.taskId, claim.generation, { runId: 'run-2' }, at(6))
      const r2 = result(ctx, 'other')
      await ctx.board.submit(o.taskId, claim.generation, { artifacts: [r2], subject: other }, at(7))
      expect(await ctx.board.accept(o.taskId, acceptance(ctx, 'reject', o.taskId, r2, { subject: other }), at(8))).toMatchObject({ state: 'ready' })
      claim = await ctx.board.claim(o.taskId, 'lead', 600_000, at(9))
      await ctx.board.start(o.taskId, claim.generation, { runId: 'run-3' }, at(9))
      await ctx.board.submit(o.taskId, claim.generation, { artifacts: [r2], subject: other }, at(10))
      expect(validTask(await ctx.board.accept(o.taskId, acceptance(ctx, 'accept', o.taskId, r2, { subject: other, by: 'operator' }), at(11)))).toMatchObject({ state: 'done' })
    }),
    scenario('review-held-for-operator', 'holds a review only the operator may accept for the operator, not by a lease: the operator\'s acceptance makes it done, a rejection another attempt, and with no decision by the policy\'s wait it ends review-expired (INV-9)', async (ctx) => {
      await active(ctx, 'p2')
      const held = async (title: string, start: number): Promise<{ task: BoardTask; r: ArtifactRef }> => {
        const t = await ready(ctx, task('p2', title, { actionClass: 'workspace-write', maxAttempts: 2 }))
        const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(start))
        await ctx.board.start(t.taskId, generation, { runId: `run-${title}` }, at(start))
        const r = result(ctx, title)
        await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: HEAD }, at(start))
        const moved = validTask(await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, r), at(start)))
        expect(moved).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
        expect(moved.holder).toBeUndefined()
        return { task: moved, r }
      }
      // Past the claim's lease, the held review is still the operator's.
      const accepted = await held('accepted', 3)
      await ctx.board.sweep(at(30))
      expect(await stateOf(ctx, accepted.task.taskId)).toBe('review')
      const byOperator = acceptance(ctx, 'accept', accepted.task.taskId, accepted.r, { by: 'operator' })
      expect(validTask(await ctx.board.accept(accepted.task.taskId, byOperator, at(31)))).toMatchObject({ state: 'done', result: { acceptance: byOperator } })
      // The operator's rejection is another attempt, through the gate.
      const rejected = await held('rejected', 32)
      const reject = validTask(await ctx.board.accept(rejected.task.taskId, acceptance(ctx, 'reject', rejected.task.taskId, rejected.r, { by: 'operator' }), at(33)))
      expect(reject).toMatchObject({ state: 'ready', attempts: { count: 1 } })
      expect(reject.waiting).toBeUndefined()
      // No decision within the policy's wait for the class (an hour here): review-expired, which expires in turn.
      const lapsed = await held('lapsed', 34)
      await ctx.board.sweep(at(34 + 59))
      expect(await stateOf(ctx, lapsed.task.taskId)).toBe('review')
      await ctx.board.sweep(at(34 + 61))
      expect(validTask((await ctx.board.task(lapsed.task.taskId))!)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
    }),
    scenario('digest-attached', 'attaches the digest of a task\'s exact result once, never while its reviewer holds the review, moving nothing; a review held for the operator takes one, and the operator\'s acceptance must then name it (INV-5, ADR-0036)', async (ctx) => {
      await active(ctx, 'p2')
      const t = await ready(ctx, task('p2', 'digested', { actionClass: 'workspace-write' }))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      expect(ctx.board.attachDigest, 'a provider at contract 1.1 attaches digests').toBeTypeOf('function')
      const attach = (taskId: string, digest: ArtifactRef, when: Date): Promise<BoardTask> => ctx.board.attachDigest!(taskId, digest, when)
      const r = result(ctx, 'attempt 1')
      const notes = result(ctx, 'attempt 1 notes')
      const digest = digestOf(ctx, [r, notes])
      expect(await failureOf(attach('task-unknown', digest, at(3)))).toBe('unknown-task')
      // No result yet.
      expect(await failureOf(attach(t.taskId, digest, at(3)))).toBe('invalid-transition')
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      await ctx.board.submit(t.taskId, generation, { artifacts: [r, notes], subject: HEAD }, at(4))
      // The reviewer holds the review: a digest now would change what its acceptance binds to.
      expect(await failureOf(attach(t.taskId, digest, at(4)))).toBe('invalid-transition')
      const held = validTask(await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, [r, notes]), at(5)))
      expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
      // Only a digest@1.0 report of exactly the result's artifacts.
      expect(await failureOf(attach(t.taskId, digestOf(ctx, [r]), at(6)))).toBe('invalid')
      expect(await failureOf(attach(t.taskId, r, at(6)))).toBe('invalid')
      expect(await failureOf(attach(t.taskId, `sha256:${'e'.repeat(64)}`, at(6)))).toBe('invalid')
      const attached = validTask(await attach(t.taskId, digest, at(6)))
      expect(attached).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' }, result: { artifacts: [r, notes], subject: HEAD, digest }, lastDecision: held.lastDecision, revision: held.revision + 1 })
      // Once: the same digest changes nothing, another is refused.
      expect(validTask(await attach(t.taskId, digest, at(7)))).toMatchObject({ revision: attached.revision })
      expect(await failureOf(attach(t.taskId, digestOf(ctx, [r, notes], 'another digest'), at(7)))).toBe('invalid-transition')
      // The operator's acceptance binds to the whole result, its digest included.
      expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, [r, notes], { by: 'operator' }), at(8)))).toBe('invalid')
      const byOperator = acceptance(ctx, 'accept', t.taskId, [r, notes, digest], { by: 'operator' })
      expect(validTask(await ctx.board.accept(t.taskId, byOperator, at(8)))).toMatchObject({ state: 'done', result: { digest, acceptance: byOperator } })

      // A done task's result takes its digest after the acceptance: the acceptance stands on the raw artifacts.
      const d = await ready(ctx, task('p2', 'done first'))
      const claim = await ctx.board.claim(d.taskId, 'lead', 600_000, at(9))
      await ctx.board.start(d.taskId, claim.generation, { runId: 'run-2' }, at(9))
      const r2 = result(ctx, 'attempt 1 of done first')
      await ctx.board.submit(d.taskId, claim.generation, { artifacts: [r2], subject: HEAD }, at(10))
      const accepted = acceptance(ctx, 'accept', d.taskId, r2)
      const done = validTask(await ctx.board.accept(d.taskId, accepted, at(10)))
      expect(done.state).toBe('done')
      const later = digestOf(ctx, [r2])
      expect(validTask(await attach(d.taskId, later, at(11)))).toMatchObject({ state: 'done', result: { artifacts: [r2], digest: later, acceptance: accepted }, lastDecision: accepted })
    }, '1.1'),
    scenario('run-outcome-reconciled', 'takes a lost holder\'s run outcome from the run\'s owner, withdrawing the approval it asked for, and refuses an outcome for another run (INV-4)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't', { maxAttempts: 2 }))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      await ctx.board.sweep(at(10))
      const lost = (await ctx.board.task(t.taskId))!
      expect(lost.waiting?.reason).toBe('reconciliation-failed')
      const r = result(ctx, 'finished while the holder was gone')
      const outcome: RunOutcome = { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: acceptance(ctx, 'accept', t.taskId, r) }
      expect(await failureOf(ctx.board.reconcileRun(t.taskId, 'run-other', outcome, at(11)))).toBe('invalid')
      expect(validTask(await ctx.board.reconcileRun(t.taskId, 'run-1', outcome, at(11)))).toMatchObject({ state: 'done', result: { artifacts: [r], subject: HEAD }, run: { runId: 'run-1' } })
      expect((await ctx.approvals.get(lost.waiting!.approvalRequest!))?.resolution?.cause).toBe('withdrawn')
      const f = await ready(ctx, task('p1', 'f', { maxAttempts: 2 }))
      const claim = await ctx.board.claim(f.taskId, 'lead', 600_000, at(12))
      await ctx.board.start(f.taskId, claim.generation, { runId: 'run-2' }, at(12))
      expect(validTask(await ctx.board.reconcileRun(f.taskId, 'run-2', { status: 'failed' }, at(13)))).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    }),
    scenario('withdrawn-wait-kept', 'keeps a lost run waiting on a request withdrawn before its move committed, so its owner\'s later report still applies (INV-4)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't'))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      await ctx.board.sweep(at(10))
      const lost = validTask((await ctx.board.task(t.taskId))!)
      // What a crash after the withdrawal, before the owner's move committed, leaves.
      await ctx.approvals.withdraw(lost.waiting!.approvalRequest!, at(11))
      expect((await ctx.board.sweep(at(11))).tasks).toEqual([])
      expect(await ctx.board.task(t.taskId)).toEqual(lost)
      const r = result(ctx, 'finished while the holder was gone')
      const outcome: RunOutcome = { status: 'completed', result: { artifacts: [r], subject: HEAD }, acceptance: acceptance(ctx, 'accept', t.taskId, r) }
      expect(validTask(await ctx.board.reconcileRun(t.taskId, 'run-1', outcome, at(12)))).toMatchObject({ state: 'done', result: { artifacts: [r] } })
    }),
    scenario('policy-change-asks-again', 'puts a wait whose request the queue withdrew on a policy change to the policy again, as a fresh gate: ready when it now needs no person, the forbid outcome when forbidden, one new request on the same subject while it still asks; a charter wait too (INV-2, INV-9, INV-13)', async (ctx, { changePolicies }) => {
      await active(ctx, 'p2')
      const loose = await ctx.board.propose(task('p2', 'loose', { actionClass: 'merge' }), at(2))
      const tight = await ctx.board.propose(task('p2', 'tight', { actionClass: 'deploy' }), at(2))
      const still = await ctx.board.propose(task('p2', 'still', { actionClass: 'spend' }), at(2))
      const lost = await ready(ctx, task('p2', 'lost'))
      const { generation } = await ctx.board.claim(lost.taskId, 'lead', 60_000, at(3))
      await ctx.board.start(lost.taskId, generation, { runId: 'run-1' }, at(3))
      await ctx.board.sweep(at(10))
      const amendment = await ctx.board.charter({ projectId: 'p2', title: 'project p2', charter: { ...CHARTER, version: 2, intent: 'Twice as fast.' } }, at(10))
      const waits = new Map<string, ApprovalRequest>()
      for (const t of [loose, tight, still, lost]) {
        const waiting = (await ctx.board.task(t.taskId))!
        expect(waiting.state).toBe('waiting-for-approval')
        waits.set(t.taskId, (await ctx.approvals.get(waiting.waiting!.approvalRequest!))!)
      }

      // The studio's next version lets merge run, forbids deploy and remediation, and still asks about spend and charter.
      const [studio, ...rest] = POLICIES
      const rule = (actionClass: ActionClass, mode: 'auto' | 'forbid') => ({ actionClass, mode })
      await changePolicies([{ ...studio!, version: studio!.version + 1, rules: [...studio!.rules.filter((r) => !['merge', 'deploy'].includes(r.actionClass)), rule('merge', 'auto'), rule('deploy', 'forbid'), rule('remediation', 'forbid')] }, ...rest])
      await ctx.approvals.sweep(at(12))
      for (const requestId of [...[...waits.values()].map((r) => r.requestId), amendment.approvalRequest]) {
        expect((await ctx.approvals.get(requestId))?.resolution?.cause).toBe('withdrawn')
      }
      await ctx.board.sweep(at(12))
      const regated = async (taskId: string): Promise<BoardTask> => {
        const t = validTask((await ctx.board.task(taskId))!)
        const decision = ctx.artifacts.get(t.lastDecision!)!.body as { decisionType: string; inputs: string[]; candidates: Array<{ option: string; reasons: string[] }>; outcome: { option: string } }
        expect(decision).toMatchObject({ decisionType: 'board', outcome: { option: t.state } })
        // It names the withdrawal it answers.
        expect(decision.inputs).toContain((await ctx.approvals.get(waits.get(taskId)!.requestId))!.resolution!.decision)
        expect(decision.candidates.length).toBeGreaterThan(1)
        for (const candidate of decision.candidates) expect(candidate.reasons.some((r) => r.trim() !== '')).toBe(true)
        return t
      }
      expect(await regated(loose.taskId)).toMatchObject({ state: 'ready' })
      expect(await regated(tight.taskId)).toMatchObject({ state: 'cancelled', cancellation: { reason: 'forbidden' } })
      expect(await regated(lost.taskId)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'rejected' }, run: { runId: 'run-1' } })
      const asked = await regated(still.taskId)
      expect(asked).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' } })
      const again = (await ctx.approvals.get(asked.waiting!.approvalRequest!))!
      expect(again.requestId).not.toBe(waits.get(still.taskId)!.requestId)
      expect(again).toMatchObject({ state: 'open', subject: waits.get(still.taskId)!.subject, requester: { component: 'board', taskId: still.taskId } })
      expect(asked.waiting!.expiresAt).toBe(again.expiresAt)
      // Once: a later sweep moves nothing and asks nothing more.
      expect(await ctx.board.sweep(at(13))).toEqual({ tasks: [], projects: [] })
      const open = await ctx.approvals.list({ projectId: 'p2' })
      expect(open.filter((r) => r.requester.taskId === still.taskId).map((r) => r.requestId)).toEqual([again.requestId])
      // The amendment waits on a new request on its exact version, which the operator can still approve.
      const charter = open.filter((r) => r.action.class === 'charter')
      expect(charter.map((r) => r.subject)).toEqual([(await ctx.approvals.get(amendment.approvalRequest))!.subject])
      expect(validProject((await ctx.board.project('p2'))!).proposedCharter?.version).toBe(2)
      await decide(ctx, charter[0]!.requestId, 'approved', at(14))
      await decide(ctx, again.requestId, 'approved', at(14))
      await ctx.board.sweep(at(14))
      expect(validProject((await ctx.board.project('p2'))!)).toMatchObject({ charter: { version: 2, intent: 'Twice as fast.' } })
      expect(await stateOf(ctx, still.taskId)).toBe('ready')

      // A charter the policy now forbids: nothing can approve it, so the project is abandoned, its open tasks cancelled.
      const founded = await ctx.board.charter({ projectId: 'p4', title: 'Later', charter: CHARTER }, at(15))
      const early = await ctx.board.propose(task('p4', 'early'), at(15))
      await changePolicies([{ ...studio!, version: studio!.version + 2, rules: [...studio!.rules, rule('charter', 'forbid')] }, ...rest])
      await ctx.approvals.sweep(at(16))
      expect((await ctx.approvals.get(founded.approvalRequest))?.resolution?.cause).toBe('withdrawn')
      await ctx.board.sweep(at(16))
      const abandoned = validProject((await ctx.board.project('p4'))!)
      expect(abandoned).toMatchObject({ state: 'closed', closure: { outcome: 'abandoned' } })
      expect(decisionOf(ctx, abandoned.lastDecision)).toMatchObject({ decisionType: 'board', outcome: { option: 'closed' } })
      expect((await ctx.board.task(early.taskId))?.cancellation?.reason).toBe('project-closed')
    }),
    scenario('review-expires', 'bounds review: a reviewer whose lease lapses with no decision leaves the task waiting for input, which expires in turn (INV-9)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't'))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 60_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      await ctx.board.submit(t.taskId, generation, { artifacts: [result(ctx, 'r')], subject: HEAD }, at(3.5))
      await ctx.board.sweep(at(10))
      const expired = validTask((await ctx.board.task(t.taskId))!)
      expect(expired).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
      expect(expired.holder).toBeUndefined()
      expect(await failureOf(ctx.board.answer(t.taskId, [], at(11)))).toBe('invalid')
      expect(await failureOf(ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, result(ctx, 'r')), at(11)))).toBe('invalid-transition')
      await ctx.board.sweep(new Date(Date.parse(expired.waiting!.expiresAt)))
      expect((await ctx.board.task(t.taskId))?.cancellation?.reason).toBe('input-expired')
    }),
    scenario('retries-bounded', 'waits for input once review rejected the last attempt allowed, a wait no input revives, which expires (INV-9)', async (ctx) => {
      await active(ctx)
      const t = await ready(ctx, task('p1', 't', { maxAttempts: 1 }))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      const r = result(ctx, 'only attempt')
      await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: HEAD }, at(4))
      const spent = validTask(await ctx.board.accept(t.taskId, acceptance(ctx, 'reject', t.taskId, r), at(5)))
      expect(spent).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' } })
      expect(await failureOf(ctx.board.answer(t.taskId, [], at(6)))).toBe('invalid')
      await ctx.board.sweep(new Date(Date.parse(spent.waiting!.expiresAt)))
      expect((await ctx.board.task(t.taskId))?.cancellation?.reason).toBe('input-expired')
    }),
    scenario('approval-per-attempt', 'asks the operator again before every new attempt of a task the policy asks about: one approval never covers a later attempt (INV-2)', async (ctx) => {
      await active(ctx, 'p2')
      const merge = await ctx.board.propose(task('p2', 'merge', { actionClass: 'merge', maxAttempts: 2 }), at(2))
      await ctx.board.sweep(at(2))
      const first = (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!
      await decide(ctx, first, 'approved', at(3))
      await ctx.board.sweep(at(3))
      const { generation } = await ctx.board.claim(merge.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(merge.taskId, generation, { runId: 'run-1' }, at(3))
      const r = result(ctx, 'merged')
      await ctx.board.submit(merge.taskId, generation, { artifacts: [r], subject: HEAD }, at(4))
      const rejected = validTask(await ctx.board.accept(merge.taskId, acceptance(ctx, 'reject', merge.taskId, r), at(5)))
      expect(rejected).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' }, attempts: { count: 1 } })
      const second = await ctx.approvals.get(rejected.waiting!.approvalRequest!)
      expect(second?.requestId).not.toBe(first)
      expect(second).toMatchObject({ state: 'open', subject: { ref: `board-task:${merge.taskId}:attempt:1` } })
      expect(await failureOf(ctx.board.claim(merge.taskId, 'lead', 600_000, at(5)))).toBe('invalid-transition')
      await decide(ctx, second!.requestId, 'approved', at(6))
      await ctx.board.sweep(at(6))
      expect(await stateOf(ctx, merge.taskId)).toBe('ready')
    }),
    scenario('spent-never-ready', 'never makes a task ready once its attempts are spent: an answer or an approval to go on leaves it waiting for input, which expires (INV-9)', async (ctx) => {
      await active(ctx)
      const asks = await ready(ctx, task('p1', 'asks', { maxAttempts: 1 }))
      let claim = await ctx.board.claim(asks.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(asks.taskId, claim.generation, { runId: 'run-1' }, at(3))
      await ctx.board.block(asks.taskId, claim.generation, { reason: 'question', questions: ['Keep the API?'] }, at(4))
      const answered = validTask(await ctx.board.answer(asks.taskId, ['yes'], at(5)))
      expect(answered).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' }, attempts: { count: 1, max: 1 } })
      const decision = ctx.artifacts.get(answered.lastDecision!)?.body as { candidates: Array<{ reasons: string[] }> }
      for (const candidate of decision.candidates) expect(candidate.reasons.some((r) => r.trim() !== '')).toBe(true)
      await ctx.board.sweep(new Date(Date.parse(answered.waiting!.expiresAt)))
      expect((await ctx.board.task(asks.taskId))?.cancellation?.reason).toBe('input-expired')

      const spent = await ready(ctx, task('p1', 'spent', { maxAttempts: 1 }))
      claim = await ctx.board.claim(spent.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(spent.taskId, claim.generation, { runId: 'run-2' }, at(3))
      const blocked = await ctx.board.block(spent.taskId, claim.generation, { reason: 'budget-spent' }, at(4))
      await decide(ctx, blocked.waiting!.approvalRequest!, 'approved', at(5))
      await ctx.board.sweep(at(5))
      expect(validTask((await ctx.board.task(spent.taskId))!)).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'retries-spent' } })
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
    scenario('pause-and-close', 'starts and claims nothing in a paused project, and closes a project only when nothing of it runs or is in review, cancelling its open tasks and withdrawing the requests they and a pending amendment waited on', async (ctx) => {
      await active(ctx)
      const free = await ready(ctx, task('p1', 'free'))
      const t = await ctx.board.propose(task('p1', 't'), at(2))
      expect(validProject(await ctx.board.pause('p1', at(2)))).toMatchObject({ state: 'paused' })
      expect(await failureOf(ctx.board.pause('p1', at(2)))).toBe('invalid-transition')
      await ctx.board.sweep(at(2))
      expect(await stateOf(ctx, t.taskId)).toBe('proposed')
      expect(await failureOf(ctx.board.claim(free.taskId, 'lead', 600_000, at(2)))).toBe('invalid-transition')
      expect(validProject(await ctx.board.resume('p1', at(3)))).toMatchObject({ state: 'active' })
      expect(await failureOf(ctx.board.resume('p1', at(3)))).toBe('invalid-transition')
      await ctx.board.sweep(at(3))
      const { generation } = await ctx.board.claim(t.taskId, 'lead', 600_000, at(3))
      await ctx.board.start(t.taskId, generation, { runId: 'run-1' }, at(3))
      const open = await ctx.board.propose(task('p1', 'open'), at(3))
      const deploy = await ctx.board.propose(task('p1', 'deploy', { actionClass: 'deploy' }), at(3))
      await ctx.board.sweep(at(3))
      const waitedOn = (await ctx.board.task(deploy.taskId))!.waiting!.approvalRequest!
      const { approvalRequest: amendment } = await ctx.board.charter({ projectId: 'p1', title: 'project p1', charter: { ...CHARTER, version: 2 } }, at(3))
      expect(await failureOf(ctx.board.close('p1', 'stopped', at(4)))).toBe('invalid-transition')
      const r = result(ctx, 'r')
      await ctx.board.submit(t.taskId, generation, { artifacts: [r], subject: HEAD }, at(4))
      expect(await failureOf(ctx.board.close('p1', 'stopped', at(4)))).toBe('invalid-transition')
      await ctx.board.accept(t.taskId, acceptance(ctx, 'accept', t.taskId, r), at(5))
      const closed = validProject(await ctx.board.close('p1', 'achieved', at(6)))
      expect(closed).toMatchObject({ state: 'closed', closure: { outcome: 'achieved' } })
      expect(closed.proposedCharter).toBeUndefined()
      expect(decisionOf(ctx, closed.closure!.decision)).toMatchObject({ decisionType: 'board', outcome: { option: 'closed' } })
      for (const id of [free.taskId, open.taskId, deploy.taskId]) expect((await ctx.board.task(id))?.cancellation?.reason, id).toBe('project-closed')
      for (const requestId of [waitedOn, amendment]) expect((await ctx.approvals.get(requestId))?.resolution?.cause, requestId).toBe('withdrawn')
      expect(await failureOf(ctx.board.close('p1', 'achieved', at(7)))).toBe('invalid-transition')
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
  /** Pending charter requests: request id → project, the version it would approve, and when it expires. */
  private readonly charters = new Map<string, { projectId: string; version: number; expiresAt: string }>()
  private generations = new Map<string, number>()

  constructor(ctx: Context, private readonly config: { inputExpirySeconds?: number } = {}) {
    super(ctx)
  }

  /** A `board` decision: `to` chosen for `why`, staying at `from` (or each of `others`, when given) declined, each with its reason. */
  private decide(subject: string, from: string, to: string, at: Date, why: string, extra: { inputs?: ArtifactRef[]; others?: Array<{ option: string; whyNot: string }> } = {}): ArtifactRef {
    return this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'board', question: `Does ${subject} move from ${from} to ${to}?`, inputs: extra.inputs ?? [],
      candidates: [
        { option: to, selected: true, reasons: [why] },
        ...(extra.others ?? [{ option: from, whyNot: why }]).map((o) => ({ option: o.option, selected: false, reasons: [`not ${o.option}: ${o.whyNot}`] })),
      ],
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

  /** A task that writes a subject leaves its result on it. */
  private writes(task: BoardTask, subject: Subject): void {
    if (task.writes && (task.writes.type !== subject.type || task.writes.ref !== subject.ref)) throw new BoardError('invalid', `${task.taskId} writes ${task.writes.ref}, not ${subject.ref}`)
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
    if (!existing && (input.milestones ?? []).some((m) => m.state !== 'planned' || m.funding !== undefined)) throw new BoardError('invalid', 'a new project\'s milestones are planned, with no funding')
    const verdict = await this.ctx.approvals.check({ class: 'charter', projectId })
    if (verdict.mode !== 'ask') throw new BoardError('invalid', `a charter is always asked about; the policy says ${verdict.mode}`)
    const hash = `sha256:${createHash('sha256').update(canonicalJson(input.charter)).digest('hex')}`
    const request = await this.ctx.approvals.request({
      subject: { type: 'content', ref: `project:${projectId}:charter:${version}`, version: hash },
      action: { class: 'charter', summary: `${existing ? 'Amend' : 'Found'} ${input.title}: ${input.charter.intent}`.slice(0, 500) },
      requester: { component: 'board', projectId }, verdict, classification: input.classification ?? 'operator-shared',
    }, at)
    this.charters.set(request.requestId, { projectId, version, expiresAt: request.expiresAt })
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
    const closed = this.save(project, at, { state: 'closed', closure: { outcome, decision, at: at.toISOString() }, lastDecision: decision, proposedCharter: undefined })
    // A pending amendment is dropped with it: the move first, its request withdrawn after.
    for (const [requestId, pending] of Array.from(this.charters)) {
      if (pending.projectId !== projectId) continue
      this.charters.delete(requestId)
      await this.ctx.approvals.withdraw(requestId, at)
    }
    return closed
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
    this.writes(task, result.subject)
    return this.save(task, at, { state: 'review', result, lastDecision: this.decide(taskId, 'running', 'review', at, 'result recorded') })
  }

  async accept(taskId: string, acceptance: ArtifactRef, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.expect(task, 'review')
    return this.applyAcceptance(task, acceptance, at)
  }

  /**
   * Done when the decision accepts the result, else another attempt or a wait for input; saved to
   * `stored` (default the task itself). The decision binds to this task's exact result, and one
   * that is not the operator's accepts only with the class's required checks passed.
   */
  private async applyAcceptance(task: BoardTask, acceptance: ArtifactRef, at: Date, stored: BoardTask = task): Promise<BoardTask> {
    const envelope = this.ctx.artifacts.get(acceptance)
    const body = envelope?.body as { decisionType?: string; inputs?: string[]; decider?: { type?: string }; outcome?: { option?: string; detail?: { taskId?: string; subject?: Subject; checks?: Action['checks'] } } } | undefined
    if (body?.decisionType !== 'acceptance') throw new BoardError('invalid', `${acceptance} is not an acceptance decision`)
    const result = task.result!
    const detail = body.outcome?.detail
    const subject = detail?.subject
    if (detail?.taskId !== task.taskId || subject?.type !== result.subject.type || subject.ref !== result.subject.ref || subject.version !== result.subject.version
      || [...result.artifacts, ...(result.digest ? [result.digest] : [])].some((a) => !body.inputs?.includes(a))) {
      throw new BoardError('invalid', `${acceptance} does not decide on this task's exact result`)
    }
    if (body.outcome?.option !== 'accept' && body.outcome?.option !== 'reject') throw new BoardError('invalid', `${acceptance} is neither accept nor reject`)
    if (body.outcome.option === 'accept' && !(body.decider?.type === 'operator' && envelope!.producer.type === 'operator')) {
      const verdict = await this.ctx.approvals.check({ class: task.actionClass, projectId: task.projectId, ...(detail.checks ? { checks: detail.checks } : {}) })
      if (verdict.mode === 'forbid' || verdict.failedChecks?.length) {
        if (task.waiting?.reason === 'operator-review') throw new BoardError('invalid', `${acceptance}: the required checks have not passed; the review is the operator's`)
        // Only the operator accepts it now: the board holds the review, bounded by the policy's wait for the class.
        const { policies } = await this.ctx.approvals.policy(task.projectId)
        return this.save(stored, at, {
          state: 'review', result: task.result, holder: undefined,
          waiting: { reason: 'operator-review', pendingChecks: verdict.failedChecks ?? [], since: at.toISOString(), expiresAt: new Date(at.getTime() + waitSeconds(policies, task.actionClass) * 1000).toISOString() },
          lastDecision: this.decide(task.taskId, 'review', 'review held for the operator', at, `${acceptance} is not the operator's and required checks have not passed`),
        })
      }
    }
    if (body.outcome.option === 'accept') {
      return this.save(stored, at, { state: 'done', result: { ...task.result!, acceptance }, holder: undefined, waiting: undefined, lastDecision: acceptance })
    }
    if (task.attempts.count < task.attempts.max) return this.again(stored, at, 'review rejected the attempt')
    return this.save(stored, at, { state: 'waiting-for-input', holder: undefined, result: task.result, waiting: this.inputWait('retries-spent', at), lastDecision: acceptance })
  }

  async reconcileRun(taskId: string, runId: string, outcome: RunOutcome, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    if (!(task.state === 'running' || (task.state === 'waiting-for-approval' && task.waiting?.reason === 'reconciliation-failed'))) {
      throw new BoardError('invalid-transition', `${taskId} is ${task.state}, not waiting on a run`)
    }
    if (task.run?.runId !== runId) throw new BoardError('invalid', `${taskId} recorded run ${task.run?.runId}, not ${runId}`)
    const pending = task.waiting?.approvalRequest
    let moved: BoardTask
    if (outcome.status === 'completed') {
      if (outcome.result.artifacts.some((a) => !this.ctx.artifacts.get(a))) throw new BoardError('invalid', 'a result artifact is unknown')
      this.writes(task, outcome.result.subject)
      moved = await this.applyAcceptance({ ...task, result: outcome.result }, outcome.acceptance, at, task)
    } else {
      const failed = this.decide(taskId, task.state, task.attempts.count < task.attempts.max ? 'ready' : 'waiting-for-input', at, `run ${runId} failed`)
      moved = task.attempts.count < task.attempts.max
        ? await this.again(task, at, `run ${runId} failed`)
        : this.save(task, at, { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('retries-spent', at), lastDecision: failed })
    }
    // The move first, the request withdrawn after: nothing waits on it any more.
    if (pending) await this.ctx.approvals.withdraw(pending, at)
    return moved
  }

  private inputWait(reason: WaitReason, at: Date, questions?: string[]): BoardTask['waiting'] {
    return { reason, ...(questions ? { questions } : {}), since: at.toISOString(), expiresAt: new Date(at.getTime() + (this.config.inputExpirySeconds ?? TTL_INPUT_SECONDS) * 1000).toISOString() }
  }

  /**
   * Ask the operator about `actionClass` for this task. From running (a spent budget, a lost run)
   * only an approval goes on: a verdict under which no request can be opened leaves it waiting for
   * input, never readied or cancelled (INV-4).
   */
  private async gate(task: BoardTask, actionClass: ActionClass, reason: 'approval-needed' | 'budget-spent' | 'reconciliation-failed', at: Date): Promise<BoardTask> {
    const verdict = await this.ctx.approvals.check({ class: actionClass, projectId: task.projectId })
    if (verdict.mode !== 'ask') {
      return this.save(task, at, { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('rejected', at), lastDecision: this.decide(task.taskId, task.state, 'waiting-for-input', at, `${reason}: the policy gives ${actionClass} ${verdict.mode}, so no approval can be asked`) })
    }
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

  /** Back for a new attempt, through the gate again: one approval never covers a later attempt. */
  private async again(task: BoardTask, at: Date, why: string): Promise<BoardTask> {
    const verdict = await this.ctx.approvals.check({ class: task.actionClass, projectId: task.projectId })
    if (verdict.mode === 'forbid') return this.cancelTask(task, 'forbidden', at, verdict.decision)
    if (verdict.mode === 'ask') {
      const request = await this.ctx.approvals.request({
        subject: { type: 'content', ref: `board-task:${task.taskId}:attempt:${task.attempts.count}`, version: 'approval-needed' },
        action: { class: task.actionClass, summary: `approval-needed: ${task.title}`.slice(0, 500) },
        requester: { component: 'board', projectId: task.projectId, taskId: task.taskId }, verdict, classification: this.projectOf(task.projectId).classification ?? 'operator-shared',
      }, at)
      return this.save(task, at, {
        state: 'waiting-for-approval', holder: undefined, run: undefined, result: undefined,
        waiting: { reason: 'approval-needed', approvalRequest: request.requestId, since: at.toISOString(), expiresAt: request.expiresAt }, lastDecision: verdict.decision,
      })
    }
    return this.save(task, at, { state: 'ready', holder: undefined, run: undefined, result: undefined, waiting: undefined, lastDecision: this.decide(task.taskId, task.state, 'ready', at, `${why}; policy ${verdict.mode}`) })
  }

  /** Whether the queue withdrew `request` on a policy change (decider rule `approvals.policy`), not the board itself. */
  private withdrawnByPolicy(request: ApprovalRequest | undefined): boolean {
    if (request?.resolution?.cause !== 'withdrawn') return false
    const body = this.ctx.artifacts.get(request.resolution.decision)?.body as { decider?: { type?: string; id?: string } } | undefined
    return body?.decider?.type === 'rule' && body.decider.id === 'approvals.policy'
  }

  /**
   * The wait's gate again, under the policy now, for a request the queue withdrew on a policy
   * change: an approval-needed wait is readied on auto or notify, asked again on ask (same
   * subject), cancelled on forbid; a spent budget or a lost run is asked again on ask, and waits
   * for input on any other verdict. A `board` decision names the withdrawal and the verdict.
   */
  private async regate(task: BoardTask, withdrawn: ApprovalRequest, at: Date): Promise<BoardTask> {
    const reason = task.waiting!.reason as 'approval-needed' | 'budget-spent' | 'reconciliation-failed'
    const actionClass: ActionClass = reason === 'budget-spent' ? 'funding' : reason === 'reconciliation-failed' ? 'remediation' : task.actionClass
    const verdict = await this.ctx.approvals.check({ class: actionClass, projectId: task.projectId })
    const options: Record<string, string> = reason === 'approval-needed'
      ? { ready: 'auto or notify', 'waiting-for-approval': 'ask', cancelled: 'forbid' }
      : { 'waiting-for-approval': 'ask', 'waiting-for-input': 'auto, notify, or forbid' }
    const to = verdict.mode === 'ask' ? 'waiting-for-approval' : reason !== 'approval-needed' ? 'waiting-for-input' : verdict.mode === 'forbid' ? 'cancelled' : 'ready'
    const request = verdict.mode === 'ask'
      ? await this.ctx.approvals.request({
        subject: withdrawn.subject, action: { class: actionClass, summary: `${reason}: ${task.title}`.slice(0, 500) },
        requester: { component: 'board', projectId: task.projectId, taskId: task.taskId, ...(task.run ? { runId: task.run.runId } : {}) },
        verdict, classification: this.projectOf(task.projectId).classification ?? 'operator-shared',
      }, at)
      : undefined
    const decision = this.decide(task.taskId, task.state, to, at, `the policy change withdrew ${withdrawn.requestId}; the policy now gives ${actionClass} ${verdict.mode}`, {
      inputs: [withdrawn.resolution!.decision, verdict.decision],
      others: Object.entries(options).filter(([o]) => o !== to).map(([option, modes]) => ({ option, whyNot: `only on ${modes}, and the policy gives ${actionClass} ${verdict.mode}` })),
    })
    if (to === 'cancelled') return this.cancelTask(task, 'forbidden', at, decision)
    if (to === 'ready') return this.save(task, at, { state: 'ready', holder: undefined, run: undefined, waiting: undefined, lastDecision: decision })
    if (to === 'waiting-for-input') return this.save(task, at, { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('rejected', at), lastDecision: decision })
    return this.save(task, at, { waiting: { reason, approvalRequest: request!.requestId, since: at.toISOString(), expiresAt: request!.expiresAt }, lastDecision: decision })
  }

  /**
   * The charter put to the policy again, for a request the queue withdrew on a policy change: on
   * ask a new request on the same subject; otherwise nothing can approve it, so a first charter
   * abandons its project and an amendment is dropped.
   */
  private async regateCharter(requestId: string, withdrawn: ApprovalRequest, projectId: string, version: number, at: Date): Promise<{ project: Project; cancelled: BoardTask[] } | undefined> {
    this.charters.delete(requestId)
    const project = this.projectOf(projectId)
    const founding = project.state === 'proposed'
    const pending = founding ? project.charter : project.proposedCharter
    if (project.state === 'closed' || pending?.version !== version) return undefined
    const verdict = await this.ctx.approvals.check({ class: 'charter', projectId })
    const [asked, refused] = founding ? ['proposed', 'closed'] : ['amendment-pending', 'amendment-dropped']
    const inputs = [withdrawn.resolution!.decision, verdict.decision]
    if (verdict.mode === 'ask') {
      const request = await this.ctx.approvals.request({
        subject: withdrawn.subject, action: withdrawn.action, requester: { component: 'board', projectId }, verdict, classification: project.classification ?? 'operator-shared',
      }, at)
      this.charters.set(request.requestId, { projectId, version, expiresAt: request.expiresAt })
      const decision = this.decide(projectId, asked, asked, at, `the policy change withdrew ${requestId}; the policy still asks about charter: asked again`, { inputs, others: [{ option: refused, whyNot: 'the policy still asks' }] })
      return { project: this.save(project, at, { lastDecision: decision }), cancelled: [] }
    }
    const decision = this.decide(projectId, asked, refused, at, `the policy change withdrew ${requestId}; the policy now gives charter ${verdict.mode}, so nothing can approve it`, { inputs, others: [{ option: asked, whyNot: `asked again only on ask, not ${verdict.mode}` }] })
    if (!founding) return { project: this.save(project, at, { proposedCharter: undefined, lastDecision: decision }), cancelled: [] }
    const cancelled: BoardTask[] = []
    for (const t of this.tasksById.values()) if (t.projectId === projectId && !TERMINAL.includes(t.state)) cancelled.push(await this.cancelTask(t, 'project-closed', at))
    return { project: this.save(project, at, { state: 'closed', closure: { outcome: 'abandoned', decision, at: at.toISOString() }, lastDecision: decision }), cancelled }
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
    if (task.attempts.count < task.attempts.max) return this.again(task, at, 'answered')
    // No attempt left: a ready task could never start and would never expire, so it waits for input (INV-9).
    return this.save(task, at, { state: 'waiting-for-input', run: undefined, waiting: this.inputWait('retries-spent', at), lastDecision: this.decide(taskId, 'ready', 'waiting-for-input', at, 'answered, but no attempt is left') })
  }

  private async cancelTask(task: BoardTask, reason: CancelReason, at: Date, decision?: ArtifactRef, note?: string): Promise<BoardTask> {
    const pending = task.waiting?.approvalRequest
    const cancelled = this.save(task, at, {
      state: 'cancelled', holder: undefined, waiting: undefined, cancellation: { reason, ...(note ? { note } : {}), at: at.toISOString() },
      lastDecision: decision ?? this.decide(task.taskId, task.state, 'cancelled', at, reason),
    })
    // The move first, the request withdrawn after: nothing waits on it any more.
    if (pending) await this.ctx.approvals.withdraw(pending, at)
    return cancelled
  }

  async cancel(taskId: string, reason: 'operator' | 'lead' | 'superseded', note?: string, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    this.expect(task, 'proposed', 'ready', 'claimed', 'waiting-for-input', 'waiting-for-approval')
    return this.cancelTask(task, reason, at, undefined, note)
  }

  async attachDigest(taskId: string, digest: ArtifactRef, at: Date = new Date()) {
    const task = this.taskOf(taskId)
    if (!task.result) throw new BoardError('invalid-transition', `${taskId} has no result to digest`)
    if (task.result.digest === digest) return structuredClone(task)
    if (task.result.digest) throw new BoardError('invalid-transition', `${taskId}'s result already has a digest`)
    if (task.state === 'review' && task.waiting?.reason !== 'operator-review') throw new BoardError('invalid-transition', `${taskId}'s reviewer holds the review`)
    const envelope = this.ctx.artifacts.get(digest)
    const sources = envelope?.kind === 'report' && envelope.bodySchema === 'digest@1.0' ? (envelope.body as { sources?: unknown }).sources : undefined
    if (!Array.isArray(sources) || sources.length !== task.result.artifacts.length || task.result.artifacts.some((a) => !sources.includes(a))) {
      throw new BoardError('invalid', `${digest} is not a digest@1.0 report of exactly the result's artifacts`)
    }
    return this.save(task, at, { result: { ...task.result, digest } })
  }

  async sweep(at: Date) {
    const moved = new Map<string, BoardTask>()
    const movedProjects = new Map<string, Project>()
    // Charters: an approved one takes effect; a refused or expired first charter abandons its project and cancels its tasks.
    // A snapshot: putting a charter to the policy again replaces its entry.
    for (const [requestId, { projectId, version, expiresAt }] of Array.from(this.charters)) {
      const request = await this.ctx.approvals.get(requestId)
      // A request the queue withdrew on a policy change: the charter is put to the policy again.
      if (this.withdrawnByPolicy(request)) {
        const settled = await this.regateCharter(requestId, request!, projectId, version, at)
        if (settled) movedProjects.set(projectId, settled.project)
        for (const t of settled?.cancelled ?? []) moved.set(t.taskId, t)
        continue
      }
      // The board refuses a request itself once it expired unresolved (INV-9); one it withdrew itself is no verdict.
      const resolved = request?.resolution && request.resolution.cause !== 'withdrawn'
      if (!resolved && Date.parse(expiresAt) > at.getTime()) continue
      this.charters.delete(requestId)
      const project = this.projectOf(projectId)
      const approved = resolved && request!.state === 'approved'
      const decision = resolved ? request!.resolution!.decision : this.decide(projectId, 'charter asked', 'charter refused', at, `request ${requestId} expired at ${expiresAt} with no verdict`)
      if (project.state === 'proposed') {
        if (approved) {
          movedProjects.set(projectId, this.save(project, at, { state: 'active', charter: { ...project.charter, approval: request!.resolution!.approval! }, lastDecision: decision }))
        } else {
          for (const t of this.tasksById.values()) if (t.projectId === projectId && !TERMINAL.includes(t.state)) moved.set(t.taskId, await this.cancelTask(t, 'project-closed', at))
          movedProjects.set(projectId, this.save(project, at, { state: 'closed', closure: { outcome: 'abandoned', decision, at: at.toISOString() }, lastDecision: decision }))
        }
      } else if (project.proposedCharter?.version === version) {
        movedProjects.set(projectId, this.save(project, at, approved
          ? { charter: { ...project.proposedCharter, approval: request!.resolution!.approval! }, proposedCharter: undefined, lastDecision: decision }
          : { proposedCharter: undefined, lastDecision: decision }))
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
        // The run's outcome is unknown here; its owner may still report it (reconcileRun), which withdraws the request.
        moved.set(task.taskId, await this.gate(task, 'remediation', 'reconciliation-failed', at))
      } else if (task.state === 'review' && task.waiting) {
        // A review held for the operator ends at its wait's expiry, as one whose reviewer's lease lapsed does.
        if (Date.parse(task.waiting.expiresAt) <= now) {
          moved.set(task.taskId, this.save(task, at, { state: 'waiting-for-input', waiting: this.inputWait('review-expired', at), lastDecision: this.decide(task.taskId, 'review', 'waiting-for-input', at, 'review-expired: the operator gave no acceptance decision in time') }))
        }
      } else if (task.state === 'review' && Date.parse(task.holder!.leaseExpiresAt) <= now) {
        // Review is bounded: no acceptance decision came while the reviewer held the task (INV-9).
        moved.set(task.taskId, this.save(task, at, { state: 'waiting-for-input', holder: undefined, waiting: this.inputWait('review-expired', at), lastDecision: this.decide(task.taskId, 'review', 'waiting-for-input', at, 'review-expired') }))
      } else if (task.state === 'waiting-for-approval') {
        const request = await this.ctx.approvals.get(task.waiting!.approvalRequest!)
        // A request the queue withdrew on a policy change: the wait's gate runs again under the policy now.
        if (this.withdrawnByPolicy(request)) {
          moved.set(task.taskId, await this.regate(task, request!, at))
          continue
        }
        // Otherwise only the board withdraws, once nothing waits: a task still waiting on a withdrawn request keeps waiting,
        // and the board applies a wait's expiry itself when the queue has not (INV-9).
        if (!request?.resolution || request.resolution.cause === 'withdrawn') {
          const due = Math.min(Date.parse(task.waiting!.expiresAt), request ? Date.parse(request.expiresAt) : Infinity)
          if (due <= now) moved.set(task.taskId, this.save(task, at, { state: 'waiting-for-input', waiting: this.inputWait('rejected', at), lastDecision: this.decide(task.taskId, 'waiting-for-approval', 'waiting-for-input', at, 'the approval wait expired with no verdict') }))
          continue
        }
        if (request.state === 'approved' && task.waiting!.reason !== 'approval-needed' && task.attempts.count < task.attempts.max) moved.set(task.taskId, await this.again(task, at, 'the operator approved going on'))
        else if (request.state === 'approved' && task.attempts.count >= task.attempts.max) {
          moved.set(task.taskId, this.save(task, at, { state: 'waiting-for-input', waiting: this.inputWait('retries-spent', at), lastDecision: request.resolution.decision }))
        } else if (request?.state === 'approved') moved.set(task.taskId, this.save(task, at, { state: 'ready', waiting: undefined, run: undefined, lastDecision: request.resolution!.decision }))
        else if (request?.state === 'rejected') moved.set(task.taskId, this.save(task, at, { state: 'waiting-for-input', waiting: this.inputWait('rejected', at), lastDecision: request.resolution!.decision }))
      } else if (task.state === 'waiting-for-input' && Date.parse(task.waiting!.expiresAt) <= now) {
        moved.set(task.taskId, await this.cancelTask(task, 'input-expired', at))
      }
    }
    return { tasks: [...moved.values()], projects: [...movedProjects.values()] }
  }
}
