import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals, { checkConfig } from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy, Check, Mode } from '@tsuuanmi/system-approvals-core'
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
    ? { outcome: 'committed', repository: '/repo', branch: `system/run/${step.runId}`, head: HEAD, committed: true, base: BASE, contained: false, stat: ' a.c | 2 +-', ...(this.fork ? { fork: this.fork } : {}) }
    : step.step === 'rebase' ? this.rebaseAnswer(step)
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

async function boot(merge: Mode, lander: Lander | undefined, requires: Check[] = [], template = 'solo') {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-landing-db-'))
  const workspace = tree()
  const ctx = new Context()
  const workers = new TreeWorkers(workspace, () => ctx.artifacts)
  const config = { ...CONFIG, approvalPollSeconds: 1, templates: LANDING_TEMPLATES }
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
  const run = await ctx.workflow.start({ template, input: 'change it', classification: 'public', task: { taskId: task.taskId } })
  return {
    ctx, workers, workspace, subject, taskId: task.taskId, runId: run.runId,
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
        ? { check, outcome: 'failed' as const, exitCode: 1, reason: 'exited 1' }
        : { check, outcome: 'passed' as const, exitCode: 0, reason: 'exited 0' }),
    })
    const { ctx, runId, taskId } = await boot('ask', lander, ['tests'])
    const returned = await until(ctx, runId, 'returned')
    expect(returned.reason).toMatch(new RegExp(`its required tests check\\(s\\) failed on the result rebased onto main at ${BASE.sha} \\(tests failed \\(exit 1\\)\\)`))
    expect(lander.steps.map(stepOf)).toEqual(['commit', 'rebase:start'])
    expect(optionsOf(ctx, returned)).toEqual(['commit', 'rebase', 'return'])
    expect(bodyOf(ctx, returned.decisions!.at(-1)!).outcome.detail).toMatchObject({ step: 'recheck', subject: { ref: REBASED, version: 'v-rebased' }, results: [{ check: 'tests', outcome: 'failed', exitCode: 1 }] })
    expect(await merges(ctx)).toEqual([])
    const task = (await ctx.board.task(taskId))!
    expect(task).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    expect(bodyOf(ctx, task.lastDecision!).inputs).toContain(returned.decisions!.at(-1)!)
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
