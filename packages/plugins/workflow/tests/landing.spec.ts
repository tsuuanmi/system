import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import StoreApprovals, { checkConfig } from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy, Check, Mode } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import { Landing, type LandingStatus, type LandingTarget, type Prepared } from '@tsuuanmi/system-landing-core'
import LocalLanding from '@tsuuanmi/system-landing-local'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { Checked, CheckStep, Landed, LandStep, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow, { type NodeTemplate, type TaskLanding } from '../src/index.ts'

// The engine's landing of an accepted result (ADR-0060) over the store-backed board and approval
// queue; the source that holds the tree is scripted, so each step's answer is the test's.
vi.setConfig({ testTimeout: 60_000 })

const policy = (merge: Mode, requires: Check[] = []): AutonomyPolicy => ({
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto', ...(requires.length ? { requires } : {}) }, { actionClass: 'merge', mode: merge }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
})

/** Scripted Workers whose results name a git working tree and the subject it is at, as an agent's do. */
class TreeWorkers extends ScriptedWorkers {
  private readonly results = new Map<string, ArtifactRef>()
  /** `tree`: the working tree every result names, or the one a result's text (its run's input) picks. */
  constructor(private readonly tree: string | ((text: string) => string), private readonly artifacts: () => Context['artifacts']) {
    super()
  }

  override get(id: string): WorkerExecution | undefined {
    const execution = super.get(id)
    if (!execution?.result) return execution
    if (!this.results.has(id)) {
      const text = (this.artifacts().get(execution.result)!.body as { text: string }).text
      const tree = typeof this.tree === 'string' ? this.tree : this.tree(text)
      this.results.set(id, this.artifacts().put({
        kind: 'report', bodySchema: 'agent-result@1.1', classification: 'public', producer: { type: 'worker', ref: 'w:standard' },
        body: { schema: 'agent-result@1.1', worker: 'w:standard', runtime: 'scripted', runId: 'agent-run', promptHash: sha256(text), sandbox: 'workspace-write', text, workspace: tree, subject: captureGitSubject(tree)!.subject },
      }).id as ArtifactRef)
    }
    return { ...execution, result: this.results.get(id)! }
  }
}

const BASE = { branch: 'main', sha: 'b'.repeat(40) }
const HEAD = 'c'.repeat(40)
/** Where a result forked from `main` when its target moved since (ADR-0068). */
const FORK = 'a'.repeat(40)
/** The run branch's head once the result is rebased onto `main`. */
const REBASED = 'e'.repeat(40)

type RebaseStep = Extract<LandStep, { step: 'rebase' }>

/** A source that holds no Worker and lands what its script says; every step it is asked, and every check, is kept. */
class Lander {
  readonly steps: LandStep[] = []
  readonly checked: CheckStep[] = []
  /** Where its commit says the result forked from the base; unset, it says nothing, as before ADR-0068. */
  fork: string | undefined
  rebaseAnswer: (step: RebaseStep) => Landed = (step) => step.phase === 'abandon'
    ? { outcome: 'abandoned', repository: '/repo', branch: `system/run/${step.runId}`, head: step.head, left: [] }
    : { outcome: 'rebased', repository: '/repo', branch: `system/run/${step.runId}`, head: REBASED, from: step.head, base: step.base, subject: { ref: REBASED, version: 'v-rebased' }, stat: ' a.c | 3 ++-', already: false }

  answer: (step: LandStep) => Landed | undefined = (step) => step.step === 'commit'
    ? { outcome: 'committed', repository: '/repo', branch: `system/run/${step.runId}`, head: HEAD, committed: true, base: BASE, contained: false, stat: ' a.c | 2 +-', subject: { ref: HEAD, version: 'v-committed' }, ...(this.fork ? { fork: this.fork } : {}) }
    : step.step === 'rebase' ? this.rebaseAnswer(step)
      : step.step === 'record' ? undefined
      : { outcome: 'merged', repository: '/repo', branch: `system/run/${step.runId}`, head: step.head, base: step.base, commit: 'd'.repeat(40), already: false }

  /** Each check passes, unless the script says otherwise. */
  checkAnswer: (step: CheckStep) => Checked = (step) => ({ outcome: 'checked', results: step.checks.map((check) => ({ check, outcome: 'passed', exitCode: 0, reason: 'exited 0' })) })
  /** Set: each check run is recorded as a `check-run@1.0`, each check's command configured, as the agents source does. */
  recorded = false
  private artifacts!: Context['artifacts']

  register(ctx: Context): void {
    this.artifacts = ctx.artifacts
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
      check: async (step) => {
        this.checked.push(step)
        const checked = this.checkAnswer(step)
        if (!this.recorded || checked.outcome !== 'checked') return checked
        const evidence = this.artifacts.put({
          kind: 'evidence', bodySchema: 'check-run@1.0', classification: step.classification, producer: { type: 'system', ref: 'lander' }, runId: step.runId,
          body: { schema: 'check-run@1.0', runId: step.runId, repository: step.workspace, workspace: step.workspace, subject: { type: 'git-head', ...step.subject }, setup: sha256('setup'), checks: checked.results.map((r) => ({ ...r, argv: ['npm', 'run', r.check] })) },
        }).id
        return { ...checked, evidence }
      },
    })
  }
}

/** A step as a list of them reads: its kind, and a rebase's phase. */
const stepOf = (step: LandStep): string => (step.step === 'rebase' ? `rebase:${step.phase}` : step.step)

/** A rebase the source could not replay past: `a.c` conflicts, `main` having gained one commit since the fork. */
const conflicted = (step: RebaseStep): Landed => ({
  outcome: 'conflicted', repository: '/repo', branch: `system/run/${step.runId}`, from: step.head, base: step.base, fork: FORK, files: ['a.c'], more: 0,
  moved: ['1234567 dev: a change the result must keep'],
})

/** A git working tree with one uncommitted change; `salt` makes its commits its own (a repository of its own, as a run's worktree is). */
function tree(salt = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-landing-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'a.c'), `int a;${salt ? ` /* ${salt} */` : ''}\n`)
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'a.c'), 'int a = 1;\n')
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The step that writes the result needs `develop`, as a template's writing step does (ADR-0068: its Worker is the result's author). */
const solo = (): NodeTemplate => ({ ...TEMPLATES['solo']![0]!, capabilities: ['reason', 'develop'] })
/**
 * The templates the landings run: `solo`, one writing step; and `made`, a writing step on the standard
 * tier, then a step on the economy tier that only runs in its worktree (a validation): its result names
 * the same tree, on a writing sandbox, but it wrote nothing of it.
 */
const LANDING_TEMPLATES: Record<string, NodeTemplate[]> = {
  ...TEMPLATES,
  solo: [solo()],
  made: [
    { ...solo(), nodeId: 'develop' },
    { ...solo(), nodeId: 'validate', prompt: 'Validate the change in the worktree', capabilities: ['reason'], tier: 'economy', dependsOn: ['develop'] },
  ],
}

/**
 * A landing provider other than the local one (PROP-0017 L0): its own subject for the merge request,
 * and a `land` that fails, as one that went away before it landed would, so the landing stays
 * `merging` on its approval.
 */
class FirstLanding extends Landing {
  static lands = 0
  readonly id = 'first'

  async prepare(t: LandingTarget): Promise<Prepared> {
    return { outcome: 'prepared', provider: this.id, subject: { type: 'git-head', ref: t.branch, version: `landing:first:${t.base.sha}:${t.head}` }, consequences: ['Approved: the first provider lands it.', 'Denied: nothing lands.'] }
  }

  async land(): Promise<never> {
    FirstLanding.lands++
    throw new Error('the first provider went away before it landed')
  }

  async status(): Promise<LandingStatus> {
    return { state: 'unknown', provider: this.id, reason: 'not read' }
  }
}

/** The landing provider the composition mounts, as the bundle's `landing-local` row does; `swap` puts another in its place. */
async function boot(merge: Mode, lander: Lander | undefined, requires: Check[] = [], template = 'solo', landingProvider: Plugin = LocalLanding, many: { runs: number; batch?: number } = { runs: 1 }) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-landing-db-'))
  // With several runs, each has a working tree of its own, picked by the marker its input carries.
  const workspaces = Array.from({ length: many.runs }, (_, k) => tree(many.runs > 1 ? `#${k}` : ''))
  const workspace = workspaces[0]!
  const ctx = new Context()
  const workers = new TreeWorkers(many.runs > 1 ? (text) => workspaces.find((_, k) => text.includes(`change it #${k}`)) ?? workspace : workspace, () => ctx.artifacts)
  const config = { ...CONFIG, approvalPollSeconds: 1, templates: LANDING_TEMPLATES, ...(many.batch ? { landingBatch: many.batch } : {}) }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => {
      c.workers.register(workers.source(c))
      lander?.register(c)
    } }),
    ctx.plugin(StoreApprovals, { policies: [policy(merge, requires)], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  let landing = ctx.plugin(landingProvider)
  await landing
  let engine = ctx.plugin(Workflow, config)
  await engine
  onTestFinished(async () => {
    await engine.dispose()
    await landing.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  await activeProject(ctx)
  const { subject } = captureGitSubject(workspace)!
  // A read task the engine itself accepts: done once its run reports (no operator review).
  const task = await readyTask(ctx, 'tree', { writes: { type: 'git-head', ref: subject.ref } })
  const run = await ctx.workflow.start({ template, input: many.runs > 1 ? 'change it #0' : 'change it', classification: 'public', task: { taskId: task.taskId } })
  const runs = [{ taskId: task.taskId, runId: run.runId }]
  for (let k = 1; k < many.runs; k++) {
    const more = await readyTask(ctx, `tree ${k}`, { writes: { type: 'git-head', ref: captureGitSubject(workspaces[k]!)!.subject.ref } })
    runs.push({ taskId: more.taskId, runId: (await ctx.workflow.start({ template, input: `change it #${k}`, classification: 'public', task: { taskId: more.taskId } })).runId })
  }
  return {
    ctx, workers, workspace, subject, taskId: task.taskId, runId: run.runId, runs,
    restart: async () => {
      await engine.dispose()
      engine = ctx.plugin(Workflow, config)
      await engine
    },
    /** Put another landing provider in place of the one mounted. */
    swap: async (next: Plugin) => {
      await landing.dispose()
      landing = ctx.plugin(next)
      await landing
    },
  }
}

const landingOf = (ctx: Context, runId: string): TaskLanding | undefined => ctx.workflow.get(runId)?.task?.landing
const until = (ctx: Context, runId: string, ...states: Array<TaskLanding['state']>): Promise<TaskLanding> => vi.waitFor(() => {
  const landing = landingOf(ctx, runId)
  if (!landing || !states.includes(landing.state)) throw new Error(`the landing of ${runId} is ${landing?.state ?? 'not there'}${landing?.reason ? ` (${landing.reason})` : ''}, not ${states.join(' or ')}`)
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

  it('names the files a merge regenerated, and the commands that made them, in its merge decision (T166, INV-13)', async () => {
    const lander = new Lander()
    const { ctx, runId } = await boot('ask', lander)
    const asked = await until(ctx, runId, 'asked')
    // The commands' autonomy decision: any recorded artifact stands for it here.
    const autonomy = asked.decisions![0]!
    lander.answer = (step) => step.step === 'merge'
      ? { outcome: 'merged', repository: '/repo', branch: `system/run/${step.runId}`, head: step.head, base: step.base, commit: 'e'.repeat(40), already: false,
        regenerated: { files: ['docs/validation/traceability.md'], commands: ['corepack pnpm gen:traceability'], autonomy: [autonomy] } }
      : undefined
    const [request] = await merges(ctx)
    await ctx.approvals.decide([{ requestId: asked.requestId!, subject: request!.subject, verdict: 'approved' }])
    const merged = await until(ctx, runId, 'merged')
    expect(merged.commit).toBe('e'.repeat(40))
    const decision = ctx.artifacts.get(merged.decisions!.at(-1)!)!
    const body = decision.body as { outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; reasons: string[] }> }
    expect(body.outcome).toMatchObject({ option: 'merge', detail: { regenerated: { files: ['docs/validation/traceability.md'], commands: ['corepack pnpm gen:traceability'] } } })
    expect(body.candidates[0]!.reasons.join('\n')).toContain('regenerated: docs/validation/traceability.md')
    expect(body.candidates[0]!.reasons.join('\n')).toContain('corepack pnpm gen:traceability')
    expect(decision.inputs).toContain(autonomy)
  })

  it('refuses the merge a forbid policy forbids, recorded, asking no one; a merge always asks, whatever the policy says, and a denied one merges nothing (D56, REQ-WF-13, INV-2)', async () => {
    const forbidden = await boot('forbid', new Lander())
    const refused = await until(forbidden.ctx, forbidden.runId, 'refused')
    expect(refused).toMatchObject({ cause: 'forbidden', reason: expect.stringMatching(/forbids merge/) })
    expect(optionsOf(forbidden.ctx, refused)).toEqual(['commit', 'refuse'])
    expect(await merges(forbidden.ctx)).toEqual([])

    // No policy merges on its own word: one that gives merge auto or notify is refused when the queue loads it (ALWAYS_ASK).
    for (const mode of ['auto', 'notify'] as const) expect(checkConfig({ policies: [policy(mode)] })).toContain(`policy studio: merge always asks; its rule may not say ${mode}`)

    // The merge waits on the operator's approval: the request says so, and denied, nothing is merged.
    const lander = new Lander()
    const denied = await boot('ask', lander)
    const asked = await until(denied.ctx, denied.runId, 'asked')
    const [request] = await merges(denied.ctx)
    expect(request!.action.consequences).toContain('A merge always asks the operator (D56), whatever the policy\'s mode for merge.')
    await denied.ctx.approvals.decide([{ requestId: asked.requestId!, subject: request!.subject, verdict: 'rejected' }])
    const rejected = await until(denied.ctx, denied.runId, 'rejected')
    expect(rejected.reason).toMatch(/was not approved \(the operator denied it\): nothing is merged/)
    expect(lander.steps.map((s) => s.step)).toEqual(['commit'])
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

  it('lands only on the subject the approved request names: a provider that changed after the approval, before the merge, lands nothing on it, and the merge is asked again on its own subject (PROP-0017 L0, INV-4, INV-5)', async () => {
    FirstLanding.lands = 0
    const lander = new Lander()
    const { ctx, runId, swap } = await boot('ask', lander, [], 'solo', FirstLanding)
    const asked = await until(ctx, runId, 'asked')
    const [request] = await merges(ctx)
    expect(request!.subject).toEqual({ type: 'git-head', ref: `system/run/${runId}`, version: `landing:first:${BASE.sha}:${HEAD}` })
    await ctx.approvals.decide([{ requestId: asked.requestId!, subject: request!.subject, verdict: 'approved' }])
    // Approved, and the first provider went away before it landed: the landing stays `merging` on that approval.
    await vi.waitFor(() => expect(FirstLanding.lands).toBeGreaterThan(0), { timeout: 30_000 })
    expect(landingOf(ctx, runId)?.state).toBe('merging')
    // Another provider in its place: its subject is not the approved one, so nothing lands on that approval.
    await swap(LocalLanding)
    const again = await vi.waitFor(() => {
      const l = landingOf(ctx, runId)
      if (l?.state !== 'asked' || l.requestId === asked.requestId) throw new Error(`the landing is ${l?.state}, not asked again`)
      return l
    }, { timeout: 30_000, interval: 25 })
    expect(lander.steps.map((s) => s.step)).not.toContain('merge')
    const refusal = (again.decisions ?? []).map((d) => bodyOf(ctx, d)).find((b) => b.outcome.option === 'refuse')
    expect(refusal?.outcome.detail).toMatchObject({ step: 'merge', cause: 'unbound' })
    expect(refusal?.candidates[0]!.reasons[0]).toMatch(/approved system\/run\/\S+ at landing:first:.*but the landing provider in force \(local\) lands .* at landing:merge:/)
    expect((await merges(ctx)).map((r) => [r.state, r.subject.version])).toEqual(expect.arrayContaining([
      ['approved', `landing:first:${BASE.sha}:${HEAD}`], ['open', `landing:merge:${BASE.sha}:${HEAD}`],
    ]))
  })

  it('waits, asking nothing and merging nothing, while no provider of ctx.landing is registered; never lands some other way (INV-2)', async () => {
    const lander = new Lander()
    const { ctx, runId, swap } = await boot('ask', lander)
    const asked = await until(ctx, runId, 'asked')
    const [request] = await merges(ctx)
    await swap({ name: 'no-landing', apply: () => undefined })
    await ctx.approvals.decide([{ requestId: asked.requestId!, subject: request!.subject, verdict: 'approved' }])
    const held = await vi.waitFor(() => {
      const l = landingOf(ctx, runId)
      if (!l?.reason?.includes('no landing provider (ctx.landing) is registered')) throw new Error(`the landing is ${l?.state}${l?.reason ? ` (${l.reason})` : ''}`)
      return l
    }, { timeout: 30_000, interval: 25 })
    expect(held.state).toBe('asked')
    expect(lander.steps.map((s) => s.step)).toEqual(['commit'])
    // The provider back: the approval is read, and the merge lands on it.
    await swap(LocalLanding)
    const merged = await until(ctx, runId, 'merged')
    expect(merged.commit).toBe('d'.repeat(40))
  })
})

type Body = { outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; reasons: string[] }>; inputs: string[] }
const bodyOf = (ctx: Context, ref: ArtifactRef): Body => ctx.artifacts.get(ref)!.body as Body

describe('ctx.workflow rebases an accepted result onto its landing target when that moved, and checks it again before the merge is asked (ADR-0068, D82)', () => {
  it('lands a result whose target moved without conflict rebased: the rebase recorded, its required checks run again on the rebased tree, the merge asked on that tree, no attempt spent; a restart mid-way does nothing twice (INV-4, INV-5, INV-13)', async () => {
    const lander = new Lander()
    lander.fork = FORK
    const { ctx, subject, taskId, runId, restart } = await boot('ask', lander, ['tests'])
    const asked = await until(ctx, runId, 'asked')
    expect(lander.steps.map(stepOf)).toEqual(['commit', 'rebase:start'])
    expect(lander.steps[1]).toMatchObject({ runId, head: HEAD, base: BASE, message: expect.stringContaining(`Rebased onto main at ${BASE.sha} (it moved from ${FORK})`) })
    // The checks: at the run's end on its own tree (ADR-0063), then again on the rebased one.
    expect(lander.checked.map((c) => c.subject)).toEqual([{ ref: subject.ref, version: subject.version }, { ref: REBASED, version: 'v-rebased' }])
    expect(lander.checked[1]).toMatchObject({ runId, checks: ['tests'] })
    // The acceptance's run is the related tests', the landing's is the full suite, once (T299).
    expect(lander.checked[0]!.scope).toBeUndefined()
    expect(lander.checked.filter((c) => c.scope === 'landing')).toEqual([lander.checked[1]])
    expect(asked).toMatchObject({ head: REBASED, base: BASE, fork: FORK, stat: ' a.c | 3 ++-', rebase: { from: HEAD, head: REBASED, fork: FORK, count: 0, checks: ['tests'] } })
    expect(optionsOf(ctx, asked)).toEqual(['commit', 'rebase', 'recheck'])
    const rebase = bodyOf(ctx, asked.decisions![1]!)
    expect(rebase.outcome.detail).toMatchObject({ step: 'rebase', from: HEAD, head: REBASED, base: BASE, fork: FORK, checks: ['tests'] })
    expect(rebase.candidates[0]!.reasons.join('\n')).toContain(`main moved from ${FORK} to ${BASE.sha} since the result's work started`)
    expect(rebase.candidates[0]!.reasons.join('\n')).toContain('it replayed with no conflict')
    expect(bodyOf(ctx, asked.decisions![2]!).outcome.detail).toMatchObject({ step: 'recheck', checks: ['tests'], results: [{ check: 'tests', outcome: 'passed', exitCode: 0 }] })
    const [request] = await merges(ctx)
    expect(request!.subject.version).toBe(`landing:merge:${BASE.sha}:${REBASED}`)
    expect(request!.action.consequences).toContain(`main moved since the result's work started (from ${FORK}): the result was rebased onto it from ${HEAD}, and its required checks (tests) passed again on the rebased tree.`)
    // A target that only moved spends no attempt: the task is done on its first.
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })

    // A crash after the rebase began, before the landing stored it: the restart asks again, adopts the request on the same tree.
    ctx.store.db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ?').run(JSON.stringify({ ...asked, state: 'rebase', head: HEAD, requestId: undefined, decisions: asked.decisions!.slice(0, 1), rebase: { from: HEAD, base: BASE, fork: FORK, count: 0 } }), runId)
    await restart()
    const again = await until(ctx, runId, 'asked')
    expect(again.requestId).toBe(asked.requestId)
    expect(await merges(ctx)).toHaveLength(1)
    await ctx.approvals.decide([{ requestId: asked.requestId!, subject: request!.subject, verdict: 'approved' }])
    const merged = await until(ctx, runId, 'merged')
    expect(lander.steps.at(-1)).toMatchObject({ step: 'merge', head: REBASED, base: BASE })
    expect(optionsOf(ctx, merged).at(-1)).toBe('merge')
  })

  it('gives a conflicting rebase to a writing step on the result\'s own author\'s Worker, told what moved and that the target\'s behaviour is kept, then lands its resolution; one it cannot resolve goes back as another attempt, the branch put back (INV-2, INV-13)', async () => {
    const lander = new Lander()
    lander.fork = FORK
    lander.rebaseAnswer = (step) => step.phase === 'start' ? conflicted(step) : new Lander().rebaseAnswer(step)
    const { ctx, workers, runId, taskId } = await boot('ask', lander)
    const asked = await until(ctx, runId, 'asked')
    expect(lander.steps.map(stepOf)).toEqual(['commit', 'rebase:start', 'rebase:resolved'])
    // The resolving step: on the Worker that wrote the result, in the run (so in its worktree), started once.
    const author = ctx.workflow.get(runId)!.nodes.find((n) => n.nodeId === 'solo')!.worker
    const resolving = workers.started.filter((s) => s.key.startsWith('landing-rebase:'))
    expect(resolving).toHaveLength(1)
    expect(resolving[0]).toMatchObject({ key: `landing-rebase:${runId}:${HEAD}:${BASE.sha}`, worker: author, runId })
    const prompt = resolving[0]!.prompt
    expect(prompt).toContain(`What moved: main went from ${FORK} to ${BASE.sha}, with these commits (newest first):\n- 1234567 dev: a change the result must keep`)
    expect(prompt).toContain('These files have conflicts, marked with <<<<<<< and >>>>>>> lines: a.c.')
    expect(prompt).toContain('main\'s behaviour must be kept: never drop or undo a change that came from it')
    expect(prompt).toContain('Do not commit and do not run git')
    expect(optionsOf(ctx, asked)).toEqual(['commit', 'resolve', 'rebase'])
    const resolve = bodyOf(ctx, asked.decisions![1]!)
    expect(resolve.outcome.detail).toMatchObject({ step: 'resolve', files: ['a.c'], worker: author, nodeId: 'solo' })
    expect(bodyOf(ctx, asked.decisions![2]!).outcome.detail).toMatchObject({ step: 'rebase', from: HEAD, head: REBASED, resolvedBy: { nodeId: 'solo', worker: author } })
    const [request] = await merges(ctx)
    // No command check ran on the result at its acceptance (none is required), so none runs again, and the request says so.
    expect(request!.action.consequences).toContain(`the result was rebased onto it from ${HEAD}, its conflicts resolved by ${author}; no check ran on the rebased tree, as no command check ran on the result at its acceptance.`)
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })

    // Markers left: not resolved, the branch put back, and the result goes back to the board with why.
    const stuck = new Lander()
    stuck.fork = FORK
    stuck.rebaseAnswer = (step) => step.phase === 'start' ? conflicted(step)
      : step.phase === 'resolved' ? { outcome: 'refused', cause: 'conflict', reason: 'conflict markers are left in a.c: the rebase is not resolved' }
        : { outcome: 'abandoned', repository: '/repo', branch: `system/run/${step.runId}`, head: step.head, left: [] }
    const back = await boot('ask', stuck)
    back.workers.reply = () => ({ text: 'The conflict in a.c changes what main does either way; I left its markers.' })
    const returned = await until(back.ctx, back.runId, 'returned')
    expect(stuck.steps.map(stepOf)).toEqual(['commit', 'rebase:start', 'rebase:resolved', 'rebase:abandon'])
    expect(returned.reason).toMatch(/did not resolve the rebase onto main at b+: conflict markers are left in a\.c/)
    expect(returned.reason).toContain('It said: The conflict in a.c changes what main does either way; I left its markers.')
    expect(optionsOf(back.ctx, returned)).toEqual(['commit', 'resolve', 'return'])
    const giveUp = returned.decisions!.at(-1)!
    expect(bodyOf(back.ctx, giveUp).candidates[0]!.reasons).toContain(`system/run/${back.runId} is back at ${HEAD}`)
    // Another attempt, through the gate again, the board's decision naming why; nothing merges.
    const task = (await back.ctx.board.task(back.taskId))!
    expect(task).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    expect(bodyOf(back.ctx, task.lastDecision!).inputs).toContain(giveUp)
    expect(await merges(back.ctx)).toEqual([])
  })

  it('gives the conflict to the Worker of the step that wrote the result, not to a later step\'s that only ran in its worktree, on a brief that names the task and its project, so what it draws is the task\'s (INV-6, INV-9)', async () => {
    const lander = new Lander()
    lander.fork = FORK
    lander.rebaseAnswer = (step) => step.phase === 'start' ? conflicted(step) : new Lander().rebaseAnswer(step)
    const { ctx, workers, runId, taskId } = await boot('ask', lander, [], 'made')
    const asked = await until(ctx, runId, 'asked')
    const nodes = ctx.workflow.get(runId)!.nodes
    const author = nodes.find((n) => n.nodeId === 'develop')!.worker!
    const validator = nodes.find((n) => n.nodeId === 'validate')!.worker!
    expect(author).not.toBe(validator)
    const resolving = workers.started.filter((s) => s.key.startsWith('landing-rebase:'))
    expect(resolving).toHaveLength(1)
    expect(resolving[0]).toMatchObject({ worker: author, runId })
    expect(bodyOf(ctx, asked.decisions![1]!).outcome.detail).toMatchObject({ step: 'resolve', nodeId: 'develop', worker: author })
    // A board task's brief, as every step of its run is given: the task, its project, and its attempt, with the resolution's instructions.
    expect(resolving[0]!.brief).toBe(asked.rebase!.brief)
    const task = (await ctx.board.task(taskId))!
    const brief = ctx.artifacts.get(resolving[0]!.brief!)!
    expect(brief.body).toMatchObject({ schema: 'brief@1.2', taskId, projectId: task.projectId, attempt: 1, goal: `Resolve the conflicts of board task ${taskId}'s rebase onto main (ADR-0068)` })
    expect(brief.body).not.toHaveProperty('ask')
    expect(resolving[0]!.prompt).toContain('These files have conflicts, marked with <<<<<<< and >>>>>>> lines: a.c.')
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })
  })

  it('sends back a result whose unresolved rebase was put back before a crash, the task not yet reopened: the return is kept before the branch is put back, so a restart finishes it instead of refusing the landing (INV-4)', async () => {
    const stuck = new Lander()
    stuck.fork = FORK
    stuck.rebaseAnswer = (step) => step.phase === 'start' ? conflicted(step)
      : step.phase === 'resolved' ? { outcome: 'refused', cause: 'conflict', reason: 'conflict markers are left in a.c: the rebase is not resolved' }
        : { outcome: 'abandoned', repository: '/repo', branch: `system/run/${step.runId}`, head: step.head, left: [] }
    // The process dies after the branch was put back, before the board reopened the task.
    const reopen = vi.spyOn(StoreBoard.prototype, 'reopen').mockRejectedValue(new Error('the process died before the board reopened the task'))
    onTestFinished(() => reopen.mockRestore())
    const { ctx, runId, taskId, restart } = await boot('ask', stuck)
    await vi.waitFor(() => expect(reopen).toHaveBeenCalled(), { timeout: 30_000, interval: 25 })
    const kept = landingOf(ctx, runId)!
    expect(kept).toMatchObject({ state: 'returning', rebase: { returning: { why: expect.stringContaining('did not resolve the rebase onto main') } } })
    expect(stuck.steps.map(stepOf)).toEqual(['commit', 'rebase:start', 'rebase:resolved', 'rebase:abandon'])
    expect(kept.rebase!.returning!.decision).toBe(kept.decisions!.at(-1))
    expect((await ctx.board.task(taskId))?.state).toBe('done')
    // As if it died before the return decision was saved, too: only the return itself is kept.
    const returning = { why: kept.rebase!.returning!.why, inputs: kept.rebase!.returning!.inputs }
    ctx.store.db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ?').run(JSON.stringify({ ...kept, rebase: { ...kept.rebase, returning }, decisions: kept.decisions!.slice(0, -1) }), runId)
    reopen.mockRestore()
    await restart()
    const returned = await until(ctx, runId, 'returned')
    // The branch is put back again (the source finds it back), never resolved again against a head it no longer is at; the result goes back.
    expect(stuck.steps.map(stepOf).slice(0, 4)).toEqual(['commit', 'rebase:start', 'rebase:resolved', 'rebase:abandon'])
    expect(new Set(stuck.steps.map(stepOf).slice(4))).toEqual(new Set(['rebase:abandon']))
    expect(returned.reason).toMatch(/did not resolve the rebase onto main at b+: conflict markers are left in a\.c/)
    expect(optionsOf(ctx, returned)).toEqual(['commit', 'resolve', 'return'])
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    expect(await merges(ctx)).toEqual([])
  })

  it('does not land a result whose required check fails after the rebase: it goes back as another attempt, with the check that failed (INV-2, INV-5)', async () => {
    const lander = new Lander()
    lander.fork = FORK
    lander.checkAnswer = (step) => ({
      outcome: 'checked', results: step.checks.map((check) => step.subject.ref === REBASED
        ? { check, outcome: 'failed' as const, exitCode: 1, reason: 'exited 1', failures: ['FAIL scripts/other.spec.ts > a test the base gained', 'AssertionError: expected 1 to be 2'] }
        : { check, outcome: 'passed' as const, exitCode: 0, reason: 'exited 0' }),
    })
    const { ctx, runId, taskId } = await boot('ask', lander, ['tests'])
    const returned = await until(ctx, runId, 'returned')
    expect(returned.reason).toMatch(new RegExp(`its required tests check\\(s\\) failed on the result rebased onto main at ${BASE.sha} \\(tests failed \\(exit 1\\)\\)`))
    // The failing tests are named in what goes back (T270).
    expect(returned.reason).toContain('failing: tests: FAIL scripts/other.spec.ts > a test the base gained | tests: AssertionError: expected 1 to be 2')
    expect(lander.checked.at(-1)).toMatchObject({ scope: 'landing' })
    expect(lander.steps.map(stepOf)).toEqual(['commit', 'rebase:start'])
    expect(optionsOf(ctx, returned)).toEqual(['commit', 'rebase', 'return'])
    expect(bodyOf(ctx, returned.decisions!.at(-1)!).outcome.detail).toMatchObject({ step: 'recheck', subject: { ref: REBASED, version: 'v-rebased' }, results: [{ check: 'tests', outcome: 'failed', exitCode: 1 }] })
    expect(await merges(ctx)).toEqual([])
    const task = (await ctx.board.task(taskId))!
    expect(task).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    expect(bodyOf(ctx, task.lastDecision!).inputs).toContain(returned.decisions!.at(-1)!)
  })

  it('runs the full suite once on the committed tree when the base did not move, before the merge is asked; a failure there goes back with its failing tests named (T299)', async () => {
    for (const fork of [BASE.sha, undefined]) {
      const lander = new Lander()
      lander.fork = fork
      const { ctx, subject, runId } = await boot('ask', lander, ['tests'])
      const asked = await until(ctx, runId, 'asked')
      expect(lander.steps.map(stepOf)).toEqual(['commit'])
      // The acceptance's related tests on the result's tree, then the landing's full suite on the committed tree, once.
      expect(lander.checked.map((c) => [c.subject, c.scope])).toEqual([[{ ref: subject.ref, version: subject.version }, undefined], [{ ref: HEAD, version: 'v-committed' }, 'landing']])
      expect(optionsOf(ctx, asked)).toEqual(['commit', 'recheck'])
      expect(bodyOf(ctx, asked.decisions![1]!).outcome.detail).toMatchObject({ step: 'recheck', scope: 'landing', subject: { ref: HEAD, version: 'v-committed' }, results: [{ check: 'tests', outcome: 'passed' }] })
      expect(asked).toMatchObject({ head: HEAD, base: BASE })
      expect(await merges(ctx)).toHaveLength(1)
    }
    const lander = new Lander()
    lander.checkAnswer = (step) => ({
      outcome: 'checked', results: step.checks.map((check) => step.scope === 'landing'
        ? { check, outcome: 'failed' as const, exitCode: 1, reason: 'exited 1', failures: ['FAIL packages/other/tests/x.spec.ts > a test the related set left out'] }
        : { check, outcome: 'passed' as const, exitCode: 0, reason: 'exited 0' }),
    })
    const { ctx, runId, taskId } = await boot('ask', lander, ['tests'])
    const returned = await until(ctx, runId, 'returned')
    expect(returned.reason).toContain(`failed on the result committed on system/run/${runId} at ${HEAD}`)
    expect(returned.reason).toContain('failing: tests: FAIL packages/other/tests/x.spec.ts > a test the related set left out')
    expect(optionsOf(ctx, returned)).toEqual(['commit', 'return'])
    expect(await merges(ctx)).toEqual([])
    expect((await ctx.board.task(taskId))!).toMatchObject({ state: 'ready', attempts: { count: 1 } })
  })

  it('runs again, on the rebased tree, the checks the run\'s own acceptance ran or left pending, when the operator accepted the result on the board: one that fails there does not land (ADR-0063, INV-2, INV-5)', async () => {
    const lander = new Lander()
    lander.fork = FORK
    // The repository configures a command for each check (its check-run evidence names it).
    lander.recorded = true
    // On the run's own tree, tests passes and lint does not run to an exit code (so the review is held for the operator, lint pending);
    // on the rebased tree, tests passes and lint, required all the same, fails.
    lander.checkAnswer = (step) => ({
      outcome: 'checked', results: step.checks.map((check) => step.subject.ref === REBASED
        ? check === 'lint' ? { check, outcome: 'failed' as const, exitCode: 1, reason: 'exited 1' } : { check, outcome: 'passed' as const, exitCode: 0, reason: 'exited 0' }
        : check === 'lint' ? { check, outcome: 'error' as const, reason: 'lint timed out' } : { check, outcome: 'passed' as const, exitCode: 0, reason: 'exited 0' }),
    })
    const { ctx, runId, taskId } = await boot('ask', lander, ['tests', 'lint'])
    const outcome = await vi.waitFor(() => {
      const reported = ctx.workflow.get(runId)?.task?.outcome
      if (reported?.status !== 'review') throw new Error(`run ${runId}'s outcome is ${reported?.status ?? 'not reported'}, not review`)
      return reported
    }, { timeout: 30_000, interval: 25 })
    expect((await ctx.board.task(taskId))?.state).toBe('review')
    expect(landingOf(ctx, runId)?.state).toBe('watch')
    // The run's own acceptance recorded the tests check it ran on its exact result.
    const own = outcome.decision!
    // lint, which did not run to an exit code, is left out of its checks (ADR-0063), and only its check run says it was asked.
    expect(bodyOf(ctx, own).outcome.detail).toMatchObject({ checks: { tests: true }, checkRun: { asked: expect.arrayContaining(['tests', 'lint']) } })
    expect(bodyOf(ctx, own).outcome.detail['checks']).not.toHaveProperty('lint')

    // The operator accepts on /ui: an acceptance decision with no checks of its own.
    const held = (await ctx.board.task(taskId))!
    const decision = ctx.artifacts.recordDecision({
      decisionType: 'acceptance', question: `Does the operator accept the result of board task ${taskId}?`,
      inputs: [...held.result!.artifacts, ...(held.result!.digest ? [held.result!.digest] : [])],
      candidates: [{ option: 'accept', selected: true, reasons: ['the operator accepts it'] }, { option: 'reject', selected: false, reasons: ['not reject: the operator chose accept'] }],
      decider: { type: 'operator', id: 'operator.review', version: '1' }, outcome: { option: 'accept', detail: { taskId, subject: held.result!.subject } }, deterministic: false,
    }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
    expect((await ctx.board.accept(taskId, decision)).state).toBe('done')

    const returned = await until(ctx, runId, 'returned')
    expect(returned.acceptance).toBe(decision)
    // The pending lint is required on the rebased tree too: an acceptance of a result whose check did not run is no pass of it.
    expect(lander.checked.at(-1)).toMatchObject({ runId, subject: { ref: REBASED, version: 'v-rebased' }, checks: ['tests', 'lint'] })
    expect(returned.rebase?.checks).toEqual(['tests', 'lint'])
    expect(returned.reason).toMatch(/its required lint check\(s\) failed on the result rebased onto main/)
    expect(optionsOf(ctx, returned)).toEqual(['commit', 'rebase', 'return'])
    expect(await merges(ctx)).toEqual([])
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
  })
})

/** A commit id of a run's own, as a source would name its commits (40 hex digits). */
const idOf = (runId: string, what: string): string => createHash('sha1').update(`${runId}:${what}`).digest('hex')

/**
 * A source over a target that moves with each merge, as a real one does: it answers a commit with the
 * target as it is now, refuses a rebase or a merge on a target that is not where the step says, and
 * names each result's own commits.
 */
class MovingTarget {
  tip = BASE.sha
  readonly merged: string[] = []
  readonly rebases: Array<{ runId: string; onto: string; stacked: boolean }> = []
  /** The tree versions whose checks fail; trees not named pass. */
  failing = new Set<string>()
  /** What each commit and rebase says it changed (`git diff --stat`). */
  stat = ' a.c | 3 ++-'

  constructor(lander: Lander) {
    lander.fork = FORK
    lander.answer = (step) => this.answer(step)
    lander.checkAnswer = (step) => {
      const fails = this.failing.has(step.subject.version)
      return { outcome: 'checked', results: step.checks.map((check) => ({ check, outcome: fails ? 'failed' as const : 'passed' as const, exitCode: fails ? 1 : 0, reason: 'ran', ...(fails ? { failures: [`FAIL a.spec.ts > on ${step.subject.version}`] } : {}) })) }
    }
  }

  private answer(step: LandStep): Landed | undefined {
    const branch = `system/run/${step.runId}`
    if (step.step === 'commit') {
      const head = idOf(step.runId, 'head')
      return { outcome: 'committed', repository: '/repo', branch, head, committed: true, base: { branch: 'main', sha: this.tip }, contained: false, stat: this.stat, subject: { ref: head, version: 'v-committed' }, fork: FORK }
    }
    if (step.step === 'rebase') {
      if (step.phase === 'abandon') return { outcome: 'abandoned', repository: '/repo', branch, head: step.head, left: [] }
      // A stack's rebase is onto the commit before it, which holds the target's tip; any other is onto the tip itself.
      if (!step.stacked && step.base.sha !== this.tip) return { outcome: 'refused', cause: 'base-moved', reason: `main is at ${this.tip} now, not at ${step.base.sha}` }
      this.rebases.push({ runId: step.runId, onto: step.base.sha, stacked: step.stacked === true })
      const head = idOf(step.runId, `rebased:${step.base.sha}`)
      return { outcome: 'rebased', repository: '/repo', branch, head, from: step.head, base: step.base, subject: { ref: head, version: `v-${step.runId}-${step.stacked ? 'stack' : 'solo'}` }, stat: this.stat, already: false }
    }
    if (step.step === 'merge') {
      if (step.base.sha !== this.tip) return { outcome: 'refused', cause: 'base-moved', reason: `main is at ${this.tip} now, not at ${step.base.sha}` }
      this.merged.push(step.runId)
      this.tip = idOf(step.runId, 'merge')
      return { outcome: 'merged', repository: '/repo', branch, head: step.head, base: step.base, commit: this.tip, already: false }
    }
    return undefined
  }
}

/** Approve the merge request the run's landing asks, once it asks. */
async function approve(ctx: Context, runId: string): Promise<void> {
  const asked = await until(ctx, runId, 'asked')
  const request = (await merges(ctx)).find((r) => r.requestId === asked.requestId)!
  await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }])
}

describe('ctx.workflow keeps one landing queue per target branch (PROP-0016 I3)', () => {
  it('lands three results accepted together one at a time, in the order they entered the queue, each rebased and checked on the tree it merges into, none refused for a target that moved', async () => {
    const lander = new Lander()
    const target = new MovingTarget(lander)
    const { ctx, runs } = await boot('ask', lander, ['tests'], 'solo', LocalLanding, { runs: 3 })
    const states = (): string[] => runs.map((r) => landingOf(ctx, r.runId)?.state ?? 'none')
    // All three are committed and waiting; one holds the target and asks, the others wait: one request at a time.
    await vi.waitFor(() => expect(states().filter((s) => s === 'asked')).toHaveLength(1), { timeout: 30_000, interval: 25 })
    await vi.waitFor(() => expect(states().filter((s) => s === 'queued')).toHaveLength(2), { timeout: 30_000, interval: 25 })
    expect((await merges(ctx)).filter((r) => r.state === 'open')).toHaveLength(1)
    const order = [...runs].sort((a, b) => landingOf(ctx, a.runId)!.queue!.seq - landingOf(ctx, b.runId)!.queue!.seq)
    expect(order.map((r) => landingOf(ctx, r.runId)!.queue!.seq)).toEqual([1, 2, 3])
    expect(landingOf(ctx, order[0]!.runId)!.state).toBe('asked')
    expect(ctx.workflow.explain(order[2]!.runId)!.landing).toMatchObject({ state: 'queued', position: 3, length: 3, holder: { runId: order[0]!.runId } })
    for (const [k, run] of order.entries()) {
      await approve(ctx, run.runId)
      await until(ctx, run.runId, 'merged')
      // The next in line is the only one that asks meanwhile.
      if (k < 2) await vi.waitFor(() => expect(states().filter((s) => s === 'asked')).toHaveLength(1), { timeout: 30_000, interval: 25 })
    }
    expect(target.merged).toEqual(order.map((r) => r.runId))
    // Each was rebased once, onto the target as the one before it left it, and checked there, once at the landing.
    const tips = [BASE.sha, ...order.slice(0, 2).map((r) => idOf(r.runId, 'merge'))]
    expect(target.rebases).toEqual(order.map((r, k) => ({ runId: r.runId, onto: tips[k], stacked: false })))
    for (const run of order) {
      const landed = landingOf(ctx, run.runId)!
      expect(lander.checked.filter((c) => c.runId === run.runId && c.scope === 'landing').map((c) => c.subject.version)).toEqual([`v-${run.runId}-solo`])
      expect(landed).toMatchObject({ state: 'merged', rebase: { count: 0 } })
      expect(landed.cause).toBeUndefined()
      expect(optionsOf(ctx, landed)).not.toContain('refuse')
    }
    expect(lander.steps.filter((s) => s.step === 'merge').map((s) => s.runId)).toEqual(order.map((r) => r.runId))
  })

  it('lands a stack of N results at once when N is configured: with N=3 a failing middle result is found and sent back alone while the other two land', async () => {
    const lander = new Lander()
    const target = new MovingTarget(lander)
    const { ctx, runs } = await boot('ask', lander, ['tests'], 'solo', LocalLanding, { runs: 4, batch: 3 })
    const states = (): string[] => runs.map((r) => landingOf(ctx, r.runId)?.state ?? 'none')
    await vi.waitFor(() => expect(states().filter((s) => s === 'asked')).toHaveLength(1), { timeout: 30_000, interval: 25 })
    await vi.waitFor(() => expect(states().filter((s) => s === 'queued')).toHaveLength(3), { timeout: 30_000, interval: 25 })
    const [first, lead, middle, tip] = [...runs].sort((a, b) => landingOf(ctx, a.runId)!.queue!.seq - landingOf(ctx, b.runId)!.queue!.seq)
    // The middle result fails its checks, and so does the stack that holds it.
    target.failing = new Set([`v-${middle!.runId}-stack`, `v-${tip!.runId}-stack`])
    await approve(ctx, first!.runId)
    await until(ctx, first!.runId, 'merged')

    // The next three form a stack: the middle one is found failing and goes back alone.
    const returned = await until(ctx, middle!.runId, 'returned')
    expect(returned.reason).toMatch(/fails first with result 2 of it .* which pass: it goes back alone/)
    expect(optionsOf(ctx, returned)).toContain('return')
    // Its branch was put back when it went.
    expect(lander.steps.filter((s) => s.runId === middle!.runId).map(stepOf)).toEqual(['commit', 'rebase:start', 'rebase:abandon'])
    expect(target.rebases.filter((r) => r.runId === middle!.runId)).toEqual([{ runId: middle!.runId, onto: expect.any(String), stacked: true }])
    expect(await ctx.board.task(runs.find((r) => r.runId === middle!.runId)!.taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    // The head lands alone, checked on its own tree, and the batch size is recorded on the decision that formed the stack.
    const head = await until(ctx, lead!.runId, 'asked')
    expect(head.queue!.batch).toMatchObject({ runs: [lead!.runId, middle!.runId, tip!.runId], limit: 3 })
    const queue = (head.decisions ?? []).map((d) => bodyOf(ctx, d)).find((b) => b.outcome.option === 'queue')
    expect(queue?.outcome.detail).toMatchObject({ step: 'queue', limit: 3, runs: [lead!.runId, middle!.runId, tip!.runId] })
    await approve(ctx, lead!.runId)
    await until(ctx, lead!.runId, 'merged')
    // The last was stacked again from the queue, and lands on the target as the head left it.
    await approve(ctx, tip!.runId)
    const last = await until(ctx, tip!.runId, 'merged')
    expect(target.merged).toEqual([first!.runId, lead!.runId, tip!.runId])
    expect(lander.steps.filter((s) => s.step === 'merge').map((s) => s.runId)).toEqual([first!.runId, lead!.runId, tip!.runId])
    // The failing stack was checked once on the tip's tree; the tip then passed alone, on the tree it merged into.
    expect(lander.checked.filter((c) => c.runId === tip!.runId && c.scope === 'landing').map((c) => c.subject.version)).toEqual([`v-${tip!.runId}-stack`, `v-${tip!.runId}-solo`])
    expect(target.rebases.filter((r) => r.runId === tip!.runId).map((r) => [r.stacked, r.onto === idOf(lead!.runId, 'merge')])).toEqual([[true, false], [false, true]])
    expect(last.queue!.batch).toBeUndefined()
    // The search that found the middle result is a decision of the tip that ran the stack's checks.
    expect(optionsOf(ctx, last)).toContain('bisect')
  })

  it('asks one merge for a whole stack on a request that names every task and run it lands, each with its own change; on its approval all land, each recording that request', async () => {
    const lander = new Lander()
    const target = new MovingTarget(lander)
    const { ctx, runs } = await boot('ask', lander, ['tests'], 'solo', LocalLanding, { runs: 4, batch: 3 })
    const states = (): string[] => runs.map((r) => landingOf(ctx, r.runId)?.state ?? 'none')
    await vi.waitFor(() => expect(states().filter((s) => s === 'queued')).toHaveLength(3), { timeout: 30_000, interval: 25 })
    const [first, lead, middle, tip] = [...runs].sort((a, b) => landingOf(ctx, a.runId)!.queue!.seq - landingOf(ctx, b.runId)!.queue!.seq)
    await approve(ctx, first!.runId)
    await until(ctx, first!.runId, 'merged')

    // The stack's tip asks; the results under it wait on it, asking nothing.
    const asked = await until(ctx, tip!.runId, 'asked')
    expect(asked.queue!.batch!.lands).toEqual([lead!.runId, middle!.runId])
    const open = (await merges(ctx)).filter((r) => r.state === 'open')
    expect(open).toHaveLength(1)
    const [request] = open
    const titles = await Promise.all([lead, middle, tip].map(async (r) => (await ctx.board.task(r!.taskId))!.title))
    expect(request!.action.summary).toBe('Merge the accepted results of 3 tasks into main as one stack (each named in the details)')
    for (const [k, r] of [lead, middle, tip].entries()) expect(request!.action.consequences).toContain(`${k + 1}. "${titles[k]}" task ${r!.taskId}, run ${r!.runId},`)
    expect(request!.action.consequences).toContain('one merge lands all 3 results of this stack into main')

    await approve(ctx, tip!.runId)
    const merged = await until(ctx, tip!.runId, 'merged')
    // One merge, of the tip; it names the results under it in its commit message.
    expect(target.merged).toEqual([first!.runId, tip!.runId])
    const message = (lander.steps.filter((s) => s.step === 'merge').at(-1) as { message: string }).message
    for (const r of [lead, middle]) expect(message).toContain(`task ${r!.taskId} (run ${r!.runId})`)
    expect(bodyOf(ctx, merged.decisions!.at(-1)!).candidates[0]!.reasons[1]).toBe(`with it land the 2 result(s) stacked under it that request ${merged.requestId} named: runs ${lead!.runId}, ${middle!.runId}`)
    for (const r of [lead, middle]) {
      const under = await until(ctx, r!.runId, 'merged')
      expect(under).toMatchObject({ commit: merged.commit, requestId: merged.requestId, approval: merged.approval, queue: { batch: { tip: tip!.runId } } })
      expect(bodyOf(ctx, under.decisions!.at(-1)!).candidates[0]!.reasons[0]).toBe(`the tip's merge request ${merged.requestId} named this result among those it lands`)
      // Its dossier evidence says whose request it landed on, and that the request named it.
      await vi.waitFor(() => {
        const evidence = ctx.workflow.dossier({ runId: r!.runId, limit: 50 }).entries.map((e) => e.text).filter((t) => t.includes('accepted result: merged'))
        expect(evidence.at(-1)).toContain(`merge request ${merged.requestId} (the request of its stack's tip, run ${tip!.runId}, which named this result among those it lands)`)
      }, { timeout: 30_000, interval: 25 })
    }
  })

  it('names every result of the largest stack (N=8) with long changes within the request\'s bound, the tip included, before any change is listed', async () => {
    const lander = new Lander()
    const target = new MovingTarget(lander)
    // A change far longer than a request could hold for eight results.
    target.stat = Array.from({ length: 30 }, (_, k) => ` packages/plugins/some-package/src/file-${k}.ts | 12 ++++++------`).join('\n')
    const { ctx, runs } = await boot('ask', lander, ['tests'], 'solo', LocalLanding, { runs: 9, batch: 8 })
    const states = (): string[] => runs.map((r) => landingOf(ctx, r.runId)?.state ?? 'none')
    await vi.waitFor(() => expect(states().filter((s) => s === 'queued')).toHaveLength(8), { timeout: 30_000, interval: 25 })
    const [first, ...stack] = [...runs].sort((a, b) => landingOf(ctx, a.runId)!.queue!.seq - landingOf(ctx, b.runId)!.queue!.seq)
    await approve(ctx, first!.runId)
    await until(ctx, first!.runId, 'merged')

    const tip = stack.at(-1)!
    const asked = await until(ctx, tip.runId, 'asked')
    const [request] = (await merges(ctx)).filter((r) => r.state === 'open')
    const said = request!.action.consequences!
    expect(said.length).toBeLessThanOrEqual(2000)
    // Every result the merge lands is named whole, in order, the tip last; and only those are recorded as named.
    const at = stack.map((r) => said.indexOf(`task ${r.taskId}, run ${r.runId},`))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(said).toContain(`run ${tip.runId}, at ${asked.head} (the tip, the head this request merges)`)
    expect(said.indexOf('Their changes, in order:')).toBeGreaterThan(at.at(-1)!)
    expect(asked.queue!.batch!.lands).toEqual(stack.slice(0, -1).map((r) => r.runId))

    await approve(ctx, tip.runId)
    await until(ctx, tip.runId, 'merged')
    expect(target.merged).toEqual([first!.runId, tip.runId])
    for (const r of stack.slice(0, -1)) expect(await until(ctx, r.runId, 'merged')).toMatchObject({ requestId: asked.requestId, queue: { batch: { tip: tip.runId } } })
  })
})
