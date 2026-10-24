import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy, Mode } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { Landed, LandStep, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow, { type TaskLanding } from '../src/index.ts'

// The engine's landing of an accepted result (ADR-0060) over the store-backed board and approval
// queue; the source that holds the tree is scripted, so each step's answer is the test's.
vi.setConfig({ testTimeout: 60_000 })

const policy = (merge: Mode): AutonomyPolicy => ({
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'merge', mode: merge }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
})

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

const BASE = { branch: 'main', sha: 'b'.repeat(40) }
const HEAD = 'c'.repeat(40)

/** A source that holds no Worker and lands what its script says; every step it is asked is kept. */
class Lander {
  readonly steps: LandStep[] = []
  answer: (step: LandStep) => Landed | undefined = (step) => step.step === 'commit'
    ? { outcome: 'committed', repository: '/repo', branch: `system/run/${step.runId}`, head: HEAD, committed: true, base: BASE, contained: false, stat: ' a.c | 2 +-' }
    : { outcome: 'merged', repository: '/repo', branch: `system/run/${step.runId}`, head: step.head, base: step.base, commit: 'd'.repeat(40), already: false }

  register(ctx: Context): void {
    ctx.workers.register({
      name: 'lander', describe: async () => [],
      start: () => {
        throw new Error('the lander runs nothing')
      },
      get: () => undefined, wait: () => Promise.reject(new Error('the lander runs nothing')),
      land: async (step) => {
        this.steps.push(step)
        return this.answer(step)
      },
    })
  }
}

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-landing-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'a.c'), 'int a;\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'a.c'), 'int a = 1;\n')
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(merge: Mode, lander: Lander | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-landing-db-'))
  const workspace = tree()
  const ctx = new Context()
  const workers = new TreeWorkers(workspace, () => ctx.artifacts)
  const config = { ...CONFIG, approvalPollSeconds: 1, templates: TEMPLATES }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => {
      c.workers.register(workers.source(c))
      lander?.register(c)
    } }),
    ctx.plugin(StoreApprovals, { policies: [policy(merge)], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  let engine = ctx.plugin(Workflow, config)
  await engine
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await activeProject(ctx)
  const { subject } = captureGitSubject(workspace)!
  // A read task the engine itself accepts: done once its run reports (no operator review).
  const task = await readyTask(ctx, 'tree', { writes: { type: 'git-head', ref: subject.ref } })
  const run = await ctx.workflow.start({ template: 'solo', input: 'change it', classification: 'public', task: { taskId: task.taskId } })
  return {
    ctx, workspace, subject, taskId: task.taskId, runId: run.runId,
    restart: async () => {
      await engine.dispose()
      engine = ctx.plugin(Workflow, config)
      await engine
    },
  }
}

const landingOf = (ctx: Context, runId: string): TaskLanding | undefined => ctx.workflow.get(runId)?.task?.landing
const until = (ctx: Context, runId: string, ...states: Array<TaskLanding['state']>): Promise<TaskLanding> => vi.waitFor(() => {
  const landing = landingOf(ctx, runId)
  if (!landing || !states.includes(landing.state)) throw new Error(`the landing of ${runId} is ${landing?.state ?? 'not there'}, not ${states.join(' or ')}`)
  return landing
}, { timeout: 30_000, interval: 25 })
const optionsOf = (ctx: Context, landing: TaskLanding): string[] => (landing.decisions ?? []).map((d) => (ctx.artifacts.get(d)!.body as { outcome: { option: string } }).outcome.option)
const merges = async (ctx: Context) => (await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.action.class === 'merge')

describe('ctx.workflow lands an accepted result through the source that holds its tree (ADR-0060)', () => {
  it('asks to merge once the task is done, adopts the request it asked before a restart instead of asking twice, and merges on the approval (REQ-WF-13, INV-4, INV-5)', async () => {
    const lander = new Lander()
    const { ctx, workspace, subject, taskId, runId, restart } = await boot('ask', lander)
    const asked = await until(ctx, runId, 'asked')
    expect(lander.steps[0]).toMatchObject({ step: 'commit', runId, workspace, subject: { ref: subject.ref, version: subject.version } })
    expect((lander.steps[0] as { message: string }).message).toMatch(new RegExp(`^system: land task ${taskId}: tree\\n\\nThe result of run ${runId} on git:${subject.ref}:${subject.version}, accepted by rule workflow\\.task-acceptance`))
    const [request] = await merges(ctx)
    expect(request).toMatchObject({ requestId: asked.requestId, subject: { type: 'git-head', ref: `system/run/${runId}`, version: `landing:merge:${BASE.sha}:${HEAD}` }, requester: { component: 'workflow', runId, taskId } })
    // A crash after the request was asked, before the landing stored it: the restart adopts it.
    ctx.store.db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ?').run(JSON.stringify({ ...asked, state: 'committed', requestId: undefined }), runId)
    await restart()
    const again = await until(ctx, runId, 'asked')
    expect(again.requestId).toBe(asked.requestId)
    expect(await merges(ctx)).toHaveLength(1)
    await ctx.approvals.decide([{ requestId: asked.requestId!, subject: request!.subject, verdict: 'approved' }])
    const merged = await until(ctx, runId, 'merged')
    expect(merged.commit).toBe('d'.repeat(40))
    expect(lander.steps.at(-1)).toMatchObject({ step: 'merge', runId, head: HEAD, base: BASE, message: expect.stringContaining(`on the operator's approval of request ${asked.requestId}`) })
    expect(optionsOf(ctx, merged)).toEqual(['commit', 'merge'])
  })

  it('refuses the merge a forbid policy forbids, recorded, asking no one; an auto policy merges without asking (REQ-WF-13, INV-2)', async () => {
    const forbidden = await boot('forbid', new Lander())
    const refused = await until(forbidden.ctx, forbidden.runId, 'refused')
    expect(refused).toMatchObject({ cause: 'forbidden', reason: expect.stringMatching(/forbids merge/) })
    expect(optionsOf(forbidden.ctx, refused)).toEqual(['commit', 'refuse'])
    expect(await merges(forbidden.ctx)).toEqual([])

    const lander = new Lander()
    const auto = await boot('auto', lander)
    const merged = await until(auto.ctx, auto.runId, 'merged')
    expect(merged.requestId).toBeUndefined()
    expect(lander.steps.map((s) => s.step)).toEqual(['commit', 'merge'])
    expect(await merges(auto.ctx)).toEqual([])
  })

  it('lands nothing when no Worker source holds the tree, and waits while the source says a run may still write it (INV-15)', async () => {
    const none = await boot('ask', undefined)
    const landing = await until(none.ctx, none.runId, 'none')
    expect(landing.reason).toMatch(/no Worker source holds .* as the worktree of run/)
    expect(landing.decisions).toBeUndefined()

    const lander = new Lander()
    const answer = lander.answer
    lander.answer = () => ({ outcome: 'refused', cause: 'busy', reason: 'an agent run of it is unfinished' })
    const busy = await boot('ask', lander)
    await vi.waitFor(() => expect(lander.steps.length).toBeGreaterThan(2), { timeout: 30_000 })
    expect(landingOf(busy.ctx, busy.runId)).toMatchObject({ state: 'commit', reason: 'an agent run of it is unfinished' })
    expect(landingOf(busy.ctx, busy.runId)?.decisions).toBeUndefined()
    lander.answer = answer
    await until(busy.ctx, busy.runId, 'asked')
  })
})
