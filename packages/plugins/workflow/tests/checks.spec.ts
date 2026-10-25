import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef, BoardTask } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases, { LeaseLost } from '@tsuuanmi/system-leases'
import { captureGitSubject, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { Checked, CheckStep, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow from '../src/index.ts'

// A run's required checks (T151, ADR-0063): before a written result's acceptance, the engine has the
// source that holds its worktree run the checks the policy requires of it, on its exact tree, and
// reports each that ran to an exit code; over the store-backed board and approval queue. The source is
// scripted, so each check's outcome is the test's.
vi.setConfig({ testTimeout: 60_000 })

const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }, { actionClass: 'merge', mode: 'ask' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/** Scripted Workers whose results name a git working tree and the subject it is at, as an agent's do. */
class TreeWorkers extends ScriptedWorkers {
  private readonly results = new Map<string, ArtifactRef>()
  constructor(private readonly tree: string, private readonly artifacts: () => Context['artifacts']) {
    super()
  }

  override get(id: string): WorkerExecution | undefined {
    const execution = super.get(id)
    if (!execution?.result) return execution
    if (!this.results.has(id)) {
      const text = (this.artifacts().get(execution.result)!.body as { text: string }).text
      this.results.set(id, this.artifacts().put({
        kind: 'report', bodySchema: 'agent-result@1.1', classification: 'public', producer: { type: 'worker', ref: 'w:standard' },
        body: { schema: 'agent-result@1.1', worker: 'w:standard', runtime: 'scripted', runId: 'agent-run', promptHash: sha256(text), sandbox: 'workspace-write', text, workspace: this.tree, subject: captureGitSubject(this.tree)!.subject },
      }).id as ArtifactRef)
    }
    return { ...execution, result: this.results.get(id)! }
  }
}

type Outcome = 'passed' | 'failed' | 'error'

/** A source that holds no Worker and answers each run's checks as its script says, recording a check-run@1.0 as the agents source does. */
class Checker {
  readonly steps: CheckStep[] = []
  outcomes: Record<string, Outcome> = { tests: 'passed', lint: 'passed' }
  refuse: Checked | undefined
  private artifacts!: Context['artifacts']

  register(ctx: Context): void {
    this.artifacts = ctx.artifacts
    ctx.workers.register({
      name: 'checker', describe: async () => [],
      start: () => {
        throw new Error('the checker runs no Worker')
      },
      get: () => undefined, wait: () => Promise.reject(new Error('the checker runs no Worker')),
      check: async (step) => {
        this.steps.push(step)
        if (this.refuse) return this.refuse
        const results = step.checks.map((check) => {
          const outcome = this.outcomes[check] ?? 'error'
          return { check, outcome, ...(outcome === 'error' ? {} : { exitCode: outcome === 'passed' ? 0 : 1 }), reason: outcome === 'error' ? `no command for the ${check} check is configured` : `exited ${outcome === 'passed' ? 0 : 1}` }
        })
        const evidence = this.artifacts.put({
          kind: 'evidence', bodySchema: 'check-run@1.0', classification: step.classification, producer: { type: 'system', ref: 'checker' }, runId: step.runId,
          body: { schema: 'check-run@1.0', runId: step.runId, repository: step.workspace, workspace: step.workspace, subject: { type: 'git-head', ...step.subject }, setup: sha256('setup'), checks: results },
        }).id
        return { outcome: 'checked', results, evidence }
      },
    })
  }
}

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-checks-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'a.c'), 'int a;\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'a.c'), 'int a = 1;\n')
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const DEVELOP = [{ nodeId: 'develop', objective: 'Develop it', prompt: '{{input}}', capabilities: ['develop'], tier: 'standard' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer' }]

/** `onTree: false`: the Workers' results are plain reports, on no git working tree. */
async function boot(checker: Checker | undefined, { onTree = true }: { onTree?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-checks-db-'))
  const workspace = tree()
  const ctx = new Context()
  const workers = onTree ? new TreeWorkers(workspace, () => ctx.artifacts) : new ScriptedWorkers()
  const config = { ...CONFIG, approvalPollSeconds: 1, templates: { ...TEMPLATES, develop: DEVELOP } }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => {
      c.workers.register(workers.source(c))
      checker?.register(c)
    } }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  const engine = ctx.plugin(Workflow, config)
  await engine
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await activeProject(ctx)
  const { subject } = captureGitSubject(workspace)!
  /** A board task writing the tree (or, `writes: false`, naming no write subject), of `actionClass`, its run started. */
  const task = async (actionClass: 'workspace-write' | 'read' = 'workspace-write', { writes = true }: { writes?: boolean } = {}): Promise<{ taskId: string; runId: string }> => {
    const ready = await readyTask(ctx, 'tree', { ...(writes ? { writes: { type: 'git-head' as const, ref: subject.ref } } : {}), actionClass })
    const run = await ctx.workflow.start({ template: 'solo', input: 'change it', classification: 'public', task: { taskId: ready.taskId } })
    return { taskId: ready.taskId, runId: run.runId }
  }
  return { ctx, workspace, subject, task }
}

/** The task once its run's result reached the board: done, held for the operator, or sent back. */
const settled = (ctx: Context, taskId: string): Promise<BoardTask> => vi.waitFor(async () => {
  const task = (await ctx.board.task(taskId))!
  if (task.state === 'running' || task.state === 'claimed' || (task.state === 'review' && !task.waiting)) throw new Error(`task ${taskId} is ${task.state}`)
  return task
}, { timeout: 30_000, interval: 25 })

type Acceptance = { decider: { id: string; version: string }; inputs: string[]; candidates: Array<{ selected: boolean; reasons: string[] }>; outcome: { option: string; detail: Record<string, unknown> } }
const acceptanceOf = (ctx: Context, runId: string, rule = 'workflow.task-acceptance'): Acceptance => {
  const found = ctx.artifacts.list({ kind: 'decision', decisionType: 'acceptance', runId }).map((a) => a.body as Acceptance).filter((b) => b.decider.id === rule)
  expect(found).toHaveLength(1)
  return found[0]!
}

describe('ctx.workflow runs a written result\'s required checks on its exact tree before its acceptance (T151, ADR-0063)', () => {
  it('accepts a task\'s result whose required checks passed on its tree, without the operator, the evidence among the decision\'s inputs (REQ-WF-15, INV-5, INV-13)', async () => {
    const checker = new Checker()
    const { ctx, workspace, subject, task } = await boot(checker)
    const { taskId, runId } = await task()
    const done = await settled(ctx, taskId)
    expect(done).toMatchObject({ state: 'done' })
    expect(checker.steps).toEqual([{ runId, workspace, subject: { ref: subject.ref, version: subject.version }, checks: ['tests', 'lint'], classification: 'public' }])
    const acceptance = acceptanceOf(ctx, runId)
    expect(acceptance).toMatchObject({ decider: { version: '2' }, outcome: { option: 'accept', detail: { checks: { tests: true, lint: true }, checkRun: { source: 'checker', outcome: 'checked', asked: ['tests', 'lint'] } } } })
    const evidence = (acceptance.outcome.detail['checkRun'] as { evidence: string }).evidence
    expect(acceptance.inputs).toContain(evidence)
    expect(ctx.artifacts.get(evidence as ArtifactRef)).toMatchObject({ kind: 'evidence', bodySchema: 'check-run@1.0' })
    expect(done.result?.acceptance).toBeDefined()
  })

  it('sends a result whose check failed back as another attempt: a failed check is work for the lead, never the operator\'s (REQ-WF-15, INV-2)', async () => {
    const checker = new Checker()
    checker.outcomes = { tests: 'passed', lint: 'failed' }
    const { ctx, task } = await boot(checker)
    const { taskId, runId } = await task()
    const back = await settled(ctx, taskId)
    expect(back.state).toBe('ready')
    expect(back.attempts.count).toBe(1)
    const acceptance = acceptanceOf(ctx, runId)
    expect(acceptance.outcome).toMatchObject({ option: 'reject', detail: { checks: { tests: true, lint: false } } })
    expect(acceptance.candidates.find((c) => c.selected)!.reasons[0]).toMatch(/the run's own lint check failed on git-head/)
  })

  it('holds the result for the operator with each check that did not run to an exit code pending, and with every one pending when the source refuses or none can run them (INV-2)', async () => {
    const checker = new Checker()
    checker.outcomes = { tests: 'passed' }
    const half = await boot(checker)
    const one = await half.task()
    expect(await settled(half.ctx, one.taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['lint'] } })
    const acceptance = acceptanceOf(half.ctx, one.runId)
    expect(acceptance.outcome.detail['checks']).toEqual({ tests: true })
    expect(acceptance.candidates.find((c) => c.selected)!.reasons).toContainEqual(expect.stringContaining('its lint check did not run to an exit code on the result (no command for the lint check is configured); it stays pending'))

    const refusing = new Checker()
    refusing.refuse = { outcome: 'refused', cause: 'moved', reason: 'the worktree is now another tree' }
    const moved = await boot(refusing)
    const two = await moved.task()
    expect(await settled(moved.ctx, two.taskId)).toMatchObject({ state: 'review', waiting: { pendingChecks: ['tests', 'lint'] } })
    expect(acceptanceOf(moved.ctx, two.runId).outcome.detail).toMatchObject({ checkRun: { outcome: 'refused', cause: 'moved' } })

    // No source runs checks: as before, nothing is claimed, and the operator decides.
    const none = await boot(undefined)
    const three = await none.task()
    expect(await settled(none.ctx, three.taskId)).toMatchObject({ state: 'review', waiting: { pendingChecks: ['tests', 'lint'] } })
    expect(acceptanceOf(none.ctx, three.runId).outcome.detail).toMatchObject({ checkRun: { outcome: 'not-run', reason: expect.stringContaining('no Worker source holds the worktree') } })
  })

  it('holds for the operator a result whose checks could not start, an infrastructure error, and never sends it back as a failed attempt (INV-2)', async () => {
    const checker = new Checker()
    checker.outcomes = { tests: 'error', lint: 'error' }
    const { ctx, task } = await boot(checker)
    const { taskId, runId } = await task()
    const held = await settled(ctx, taskId)
    expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
    const acceptance = acceptanceOf(ctx, runId)
    expect(acceptance.outcome.option).toBe('accept')
    expect(acceptance.outcome.detail['checks']).toEqual({})
  })

  it('finishes a run whose acceptance was stored before its holder was lost on that acceptance, never asking its checks again: a failure is not replaced by a later pass (INV-4)', async () => {
    const checker = new Checker()
    checker.outcomes = { tests: 'passed', lint: 'failed' }
    const { ctx, task } = await boot(checker)
    const append = ctx.eventLog.append.bind(ctx.eventLog)
    let lost = 0
    // The run's lease lost as it finishes, after its acceptance was stored: the run's next turn takes it from there.
    vi.spyOn(ctx.eventLog, 'append').mockImplementation((event) => {
      if (event.type === 'workflow.run.completed' && !lost++) {
        // Asked again, its checks would pass now.
        checker.outcomes = { tests: 'passed', lint: 'passed' }
        throw new LeaseLost(`run:${event.runId}`, 'taken over')
      }
      return append(event)
    })
    const { taskId, runId } = await task()
    const back = await settled(ctx, taskId)
    expect(lost).toBe(2)
    expect(checker.steps).toHaveLength(1)
    expect(back.state).toBe('ready')
    expect(back.attempts.count).toBe(1)
    expect(acceptanceOf(ctx, runId).outcome).toMatchObject({ option: 'reject', detail: { checks: { tests: true, lint: false } } })
    expect(ctx.workflow.get(runId)).toMatchObject({ status: 'completed' })
  })

  it('asks for no check the task\'s class does not require', async () => {
    const checker = new Checker()
    const { ctx, task } = await boot(checker)
    const { taskId, runId } = await task('read')
    expect(await settled(ctx, taskId)).toMatchObject({ state: 'done' })
    expect(checker.steps).toEqual([])
    expect(acceptanceOf(ctx, runId).outcome.detail).not.toHaveProperty('checkRun')
  })

  describe('a board task with no write subject (T165: the lead\'s parallel tasks on one repository)', () => {
    it('runs the checks on the tree its agent result is on and binds the result to that tree: passed, it is accepted without the operator (INV-5)', async () => {
      const checker = new Checker()
      const { ctx, workspace, subject, task } = await boot(checker)
      const { taskId, runId } = await task('workspace-write', { writes: false })
      const done = await settled(ctx, taskId)
      expect(done).toMatchObject({ state: 'done', result: { subject: { type: 'git-head', ref: subject.ref, version: subject.version } } })
      expect(checker.steps).toEqual([{ runId, workspace, subject: { ref: subject.ref, version: subject.version }, checks: ['tests', 'lint'], classification: 'public' }])
      const acceptance = acceptanceOf(ctx, runId)
      expect(acceptance.outcome).toMatchObject({ option: 'accept', detail: { subject: { type: 'git-head', ref: subject.ref, version: subject.version }, checks: { tests: true, lint: true }, checkRun: { outcome: 'checked' } } })
      // The result's artifacts name that exact tree: the agent result on it is among them and the decision's inputs.
      const onTree = done.result!.artifacts.filter((a) => (ctx.artifacts.get(a)?.body as { subject?: { version?: string } } | undefined)?.subject?.version === subject.version)
      expect(onTree.length).toBeGreaterThan(0)
      for (const a of done.result!.artifacts) expect(acceptance.inputs).toContain(a)
    })

    it('sends one whose lint check failed on its tree back as a rejected attempt', async () => {
      const checker = new Checker()
      checker.outcomes = { tests: 'passed', lint: 'failed' }
      const { ctx, task } = await boot(checker)
      const { taskId, runId } = await task('workspace-write', { writes: false })
      const back = await settled(ctx, taskId)
      expect(back.state).toBe('ready')
      expect(back.attempts.count).toBe(1)
      const acceptance = acceptanceOf(ctx, runId)
      expect(acceptance.outcome).toMatchObject({ option: 'reject', detail: { subject: { type: 'git-head' }, checks: { tests: true, lint: false } } })
      expect(acceptance.candidates.find((c) => c.selected)!.reasons[0]).toMatch(/the run's own lint check failed on git-head/)
    })

    it('keeps the checks pending, for the operator, when its result is not on a git working tree (INV-2)', async () => {
      const checker = new Checker()
      const { ctx, task } = await boot(checker, { onTree: false })
      const { taskId, runId } = await task('workspace-write', { writes: false })
      expect(await settled(ctx, taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
      expect(checker.steps).toEqual([])
      const acceptance = acceptanceOf(ctx, runId)
      expect(acceptance.outcome.detail).toMatchObject({ subject: { type: 'artifact' } })
      expect(acceptance.outcome.detail).not.toHaveProperty('checkRun')
    })
  })

  it('records a plain run\'s checks as passed or failed on its acceptance, never blocking it', async () => {
    const checker = new Checker()
    checker.outcomes = { tests: 'passed', lint: 'failed' }
    const { ctx } = await boot(checker)
    const run = ctx.workflow.start({ template: 'develop', input: 'Fix add()', classification: 'public' })
    expect(await ctx.workflow.wait(run.runId, 30_000)).toMatchObject({ status: 'completed' })
    expect(acceptanceOf(ctx, run.runId, 'workflow.run-acceptance')).toMatchObject({
      decider: { version: '2' },
      outcome: { option: 'accept', detail: { actionClass: 'workspace-write', checks: { tests: true, lint: false }, pendingChecks: ['lint'], checkRun: { outcome: 'checked' } } },
    })
  })
})
