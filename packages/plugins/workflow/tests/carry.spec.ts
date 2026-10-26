import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef, BoardTask, TaskInput } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { type Brief, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { Carried, CarryStep, ExecutionInfrastructure } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, readyTask, type Rendered, type Reply, ScriptedWorkers } from '../conformance/workflow.ts'
import Workflow, { type NodeTemplate, type RunView, type TaskCarry } from '../src/index.ts'

// The engine's side of starting a board task's next attempt from its previous attempt's work
// (ADR-0061) over the store-backed board and approval queue; the source that holds the trees is
// scripted, so each answer to a carry is the test's.
vi.setConfig({ testTimeout: 60_000 })

const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio', rules: [{ actionClass: 'read', mode: 'auto' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/** A writing step, then a step after it whose Worker may fail: T110a's develop and review, in miniature. */
const RELAY: NodeTemplate[] = [
  { nodeId: 'develop:1', objective: 'Change the tree', prompt: '{{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' },
  { nodeId: 'check:1', objective: 'Check the change', prompt: 'Check the change', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', dependsOn: ['develop:1'] },
]

/** A source that holds no Worker and carries as its script says; every step it is asked is kept. */
class Carrier {
  readonly steps: CarryStep[] = []
  answer: (step: CarryStep) => Carried | undefined | Promise<Carried | undefined> = (step) => ({
    outcome: 'carried', repository: '/repo', from: { branch: `system/run/${step.from.runId}`, commit: 'c'.repeat(40) },
    base: step.from.subject.ref, branch: `system/run/${step.runId}`, worktree: `/worktrees/${step.runId}`, carried: true,
  })

  register(ctx: Context): void {
    ctx.workers.register({
      name: 'carrier', describe: async () => [],
      start: () => {
        throw new Error('the carrier runs nothing')
      },
      get: () => undefined, wait: () => Promise.reject(new Error('the carrier runs nothing')),
      carry: async (step) => {
        this.steps.push(step)
        return this.answer(step)
      },
    })
  }
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-carry-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const repository = join(dir, 'repo')
  const git = (...args: string[]): string => execFileSync('git', ['-C', repository, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', repository])
  writeFileSync(join(repository, 'a.c'), 'int a;\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  workers.worktreePerRun = { repository, runs: join(dir, 'runs') }
  const carrier = new Carrier()
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => {
      c.workers.register(workers.source(c))
      carrier.register(c)
    } }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  fibers.push(ctx.plugin(Workflow, { ...CONFIG, templates: { relay: RELAY } }))
  await fibers.at(-1)
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  await activeProject(ctx)
  return { ctx, workers, carrier, head: git('rev-parse', 'HEAD') }
}

type Booted = Awaited<ReturnType<typeof boot>>

/** How the step after the writing step fails; `infrastructure`, its source's word that only the infrastructure ended it (ADR-0069). */
type Failure = { fail: string; disposition: string; infrastructure?: ExecutionInfrastructure }

/** The scripted Workers: a writing step changes its run's worktree; the step after it fails as `failing` says, then answers. */
function script(b: Booted, failing: Failure[]): void {
  b.workers.reply = (request: Rendered): Reply => {
    if (request.requirement.capabilities.includes('develop')) {
      writeFileSync(join(b.workers.worktrees.get(request.runId!)!, 'a.c'), `int a = ${b.workers.started.length};\n`)
      return { text: 'changed a.c' }
    }
    const failure = failing.shift()
    return failure ? { ...failure, sent: true } : { text: 'checked' }
  }
}

const settledRun = async (ctx: Context, runId: string): Promise<RunView> => vi.waitFor(() => {
  const view = ctx.workflow.get(runId)
  if (view?.task?.phase !== 'reported') throw new Error(`run ${runId} is not reported yet`)
  return view
}, { timeout: 30_000, interval: 25 })
const attempt = async (ctx: Context, task: BoardTask): Promise<RunView> => settledRun(ctx, (await ctx.workflow.start({ template: 'relay', input: 'change a.c', classification: 'public', task: { taskId: task.taskId } })).runId)
const carryOf = (ctx: Context, runId: string): TaskCarry | undefined => ctx.workflow.get(runId)?.task?.carry
type Decision = { decisionType: string; decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> } }
const decisionOf = (ctx: Context, ref: ArtifactRef): Decision => {
  const body = ctx.artifacts.get(ref)!.body as Decision & { schema: string }
  new SchemaRegistry().assertRecord(body)
  return body
}

/** A task that writes the repository at `head`, whose attempt 1 completes its writing step and then fails as `failure`. */
async function failedOnce(b: Booted, title: string, failure: Failure, extra: Partial<TaskInput> = { writes: { type: 'git-head', ref: b.head } }): Promise<{ task: BoardTask; first: RunView }> {
  script(b, [failure])
  const task = await readyTask(b.ctx, title, extra)
  const first = await attempt(b.ctx, task)
  expect(first).toMatchObject({ status: 'failed', error: { kind: failure.fail } })
  expect(first.nodes.find((n) => n.nodeId === 'develop:1')?.state).toBe('COMPLETED')
  return { task: (await b.ctx.board.task(task.taskId))!, first }
}

const BROKEN = { fail: 'session_broken', disposition: 'RECREATE_SESSION' }

describe('ctx.workflow starts a board task\'s next attempt from its previous attempt\'s work (ADR-0061)', () => {
  it('asks the source that holds the tree before the run\'s first step, records what it did, and points every brief of the run at it (REQ-WF-14, INV-13)', async () => {
    const b = await boot()
    const { task, first } = await failedOnce(b, 'relay', BROKEN)
    const tree = b.workers.worktrees.get(first.runId)!
    // The source holds its answer: the run starts no step until it has one.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const answer = b.carrier.answer
    b.carrier.answer = async (step) => {
      await held
      return answer(step)
    }
    const startedBefore = b.workers.started.length
    const second = await b.ctx.workflow.start({ template: 'relay', input: 'change a.c', classification: 'public', task: { taskId: task.taskId } })
    await vi.waitFor(() => expect(b.carrier.steps).toHaveLength(1), { timeout: 30_000 })
    expect(carryOf(b.ctx, second.runId)).toMatchObject({ state: 'due', from: { runId: first.runId, attempt: 1, nodeId: 'develop:1', workspace: tree, subject: { ref: b.head } } })
    expect(b.workers.started).toHaveLength(startedBefore)
    release()
    const done = await settledRun(b.ctx, second.runId)
    expect(done.status).toBe('completed')

    const [step] = b.carrier.steps
    expect(step).toMatchObject({ runId: second.runId, from: { runId: first.runId, workspace: tree, subject: { ref: b.head } } })
    expect(step!.message).toMatch(new RegExp(`^system: carry the work of attempt 1 of task ${task.taskId} into run ${second.runId}\\n\\nStep develop:1 of run ${first.runId} made this change, and the attempt failed only after it`))
    expect(step!.message).toMatch(new RegExp(`System-Task: ${task.taskId}\\nSystem-Run: ${first.runId}$`))
    const carry = carryOf(b.ctx, second.runId)!
    expect(carry).toMatchObject({ state: 'carried', commit: 'c'.repeat(40), branch: `system/run/${first.runId}`, worktree: `/worktrees/${second.runId}`, repository: '/repo' })
    expect(carry.decisions.map((d) => [decisionOf(b.ctx, d).decisionType, decisionOf(b.ctx, d).outcome.option])).toEqual([['admission', 'carry'], ['gate', 'carry']])
    expect(decisionOf(b.ctx, carry.decisions[1]!).outcome.detail).toMatchObject({ source: 'carrier', from: first.runId, commit: 'c'.repeat(40), carried: true })
    // Every brief of the run points at the carry first, with what the worktree holds.
    const briefs = b.workers.started.slice(startedBefore).map((s) => b.ctx.artifacts.get(s.brief!)!.body as Brief)
    expect(briefs).toHaveLength(2)
    for (const brief of briefs) {
      expect(brief.artifacts[0]).toEqual({ ref: carry.decisions[1], role: 'prior', note: `This run's worktree already holds the change step develop:1 of attempt 1 made (committed as ${'c'.repeat(40)} on system/run/${first.runId}, on top of ${b.head}): build on it, do not make it again` })
    }
    expect(b.workers.started.at(-2)!.prompt).toContain('already holds the change step develop:1 of attempt 1 made')
    expect(b.ctx.workflow.explain(second.runId)!.decisions!.map((d) => d.id)).toEqual(expect.arrayContaining(carry.decisions))
  })

  it('starts from HEAD, recorded with why, when no source holds the tree, when the source refuses, and when it cannot answer (REQ-WF-14, INV-2)', async () => {
    const b = await boot()
    const cases: Array<[string, (step: CarryStep) => Carried | undefined, RegExp]> = [
      ['nobody', () => undefined, /^no Worker source holds .* as the worktree of run run_/],
      ['refused', () => ({ outcome: 'refused', cause: 'moved', reason: 'the tree moved' }), /^source carrier did not carry it: the tree moved$/],
      ['throws', () => {
        throw new Error('the store failed')
      }, /^source carrier did not carry it: source carrier could not carry the worktree .* into run run_.*: the store failed$/],
    ]
    for (const [title, answer, reason] of cases) {
      b.carrier.answer = answer
      const { task } = await failedOnce(b, title, BROKEN)
      const before = b.workers.started.length
      const second = await attempt(b.ctx, task)
      expect(second.status).toBe('completed')
      const carry = carryOf(b.ctx, second.runId)!
      expect(carry).toMatchObject({ state: 'fresh', reason: expect.stringMatching(reason) })
      expect(carry.decisions.map((d) => decisionOf(b.ctx, d).outcome.option)).toEqual(['carry', 'fresh'])
      // No brief says the worktree holds anything.
      for (const started of b.workers.started.slice(before)) expect(started.prompt).not.toContain('already holds the change')
      // The task is done: the next one may write the same commit.
      expect((await b.ctx.board.task(task.taskId))!.state).toBe('done')
    }
    expect(b.ctx.eventLog.query({ type: 'workflow.task.carry' }).map((e) => e.data?.['state'])).toEqual(['fresh', 'fresh', 'fresh'])
  })

  it('carries nothing for a task that writes no subject, nor after a failure about the change, and asks no source (REQ-WF-14, INV-2, INV-15)', async () => {
    const b = await boot()
    const unbound = await failedOnce(b, 'unbound', BROKEN, {})
    const afterUnbound = await attempt(b.ctx, unbound.task)
    expect(carryOf(b.ctx, afterUnbound.runId)).toMatchObject({ state: 'fresh', reason: `task ${unbound.task.taskId} names no subject it writes, so no earlier tree is held as its own (INV-15)` })

    const denied = await failedOnce(b, 'denied', { fail: 'egress_denied', disposition: 'USER_ACTION' })
    const afterDenied = await attempt(b.ctx, denied.task)
    const carry = carryOf(b.ctx, afterDenied.runId)!
    expect(carry).toMatchObject({ state: 'fresh', reason: `run ${denied.first.runId} failed as egress_denied, which is not a later step's Worker, session, or limit failing, so its change is not carried` })
    expect(carry.decisions.map((d) => decisionOf(b.ctx, d))).toEqual([expect.objectContaining({ decisionType: 'admission', decider: expect.objectContaining({ id: 'workflow.task-worktree' }), outcome: expect.objectContaining({ option: 'fresh' }) })])
    expect(b.carrier.steps).toEqual([])
  })

  it('carries the work of a run the board did not count: its writing step completed, then a later step failed only on the infrastructure (ADR-0069)', async () => {
    const b = await boot()
    // The review's Worker went away after its step was sent: its source says that alone ended it.
    const { task, first } = await failedOnce(b, 'free retry', { fail: 'config_error', disposition: 'CODE_FIX', infrastructure: 'worker-unavailable' })
    // The board gave the attempt back: the count is where it was before the run.
    expect(task).toMatchObject({ state: 'ready', attempts: { count: 0 } })
    const second = await attempt(b.ctx, task)
    expect(second.status).toBe('completed')
    const carry = carryOf(b.ctx, second.runId)!
    expect(carry).toMatchObject({ state: 'carried', from: { runId: first.runId, attempt: 1, nodeId: 'develop:1' }, commit: 'c'.repeat(40) })
    expect(decisionOf(b.ctx, carry.decisions[0]!)).toMatchObject({ decisionType: 'admission', outcome: { option: 'carry', detail: { attempt: 1, from: first.runId, fromAttempt: 1 } } })
    expect(b.carrier.steps).toEqual([expect.objectContaining({ runId: second.runId, from: expect.objectContaining({ runId: first.runId }) })])
    expect(b.carrier.steps[0]!.message).toContain(`attempt 1, run ${second.runId}, starts from it`)
  })

  it('decides nothing for a start whose claim the board refuses, and starts from HEAD, recorded with why, when the previous attempt\'s record cannot be read (T127 item 12, INV-2, INV-13)', async () => {
    const b = await boot()
    const { task, first } = await failedOnce(b, 'refused then unread', BROKEN)
    const decided = (): number => b.ctx.artifacts.list({ kind: 'decision', limit: 1000 }).filter((a) => (a.body as Decision).decider.id === 'workflow.task-worktree').length
    // A claim handed for a task that is ready, not claimed: refused before anything is decided about the worktree.
    const before = decided()
    await expect(b.ctx.workflow.start({ template: 'relay', input: 'change a.c', classification: 'public', task: { taskId: task.taskId, holder: 'lead:someone', generation: 7 } })).rejects.toThrow(/not claimed, so there is no claim to hand to the run; nothing was started/)
    expect(decided()).toBe(before)

    // The previous run's record no longer parses: the start goes on, from HEAD, and says why.
    b.ctx.store.db.prepare('UPDATE workflow_tasks SET frame = ? WHERE run_id = ?').run('{"attempt": 1', first.runId)
    const second = await attempt(b.ctx, task)
    expect(second.status).toBe('completed')
    const carry = carryOf(b.ctx, second.runId)!
    expect(carry).toEqual({ state: 'fresh', decisions: [expect.any(String)], reason: expect.stringMatching(new RegExp(`^the engine's record of attempt 1 \\(run ${first.runId}\\) could not be read \\(.+\\), so its work is not carried$`)), at: expect.any(String) })
    expect(decisionOf(b.ctx, carry.decisions[0]!)).toMatchObject({ decisionType: 'admission', decider: { id: 'workflow.task-worktree' }, outcome: { option: 'fresh', detail: { taskId: task.taskId, attempt: 2, fromAttempt: 1 } } })
    expect(b.carrier.steps).toEqual([])
    expect(decided()).toBe(before + 1)
  })
})
