import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy, RiskTierMap, TierByRisk } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard, { type Config as BoardConfig } from '@tsuuanmi/system-board'
import type { ArtifactRef, BoardTask } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { CapabilityDescriptor, ChangedFile, CheckStep, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { activeProject, CONFIG, readyTask, type Rendered, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow from '../src/index.ts'
import { type AcceptanceRisk, heavyReasons, secondFamily } from '../src/risk.ts'
import type { NodeTemplate } from '../src/spec.ts'

// Process tiered by risk (PROP-0016 §4, D83, ADR-0071), over the store-backed board and approval
// queue: the policy's path map gives a board task's change its tier, by the paths the Worker source
// says it touches. A heavy change gets a second review by another provider family before anything
// after its review runs, and is never accepted unattended; a light one skips its validation step once
// its required checks passed on its exact tree.
vi.setConfig({ testTimeout: 60_000 })

const MAP: RiskTierMap = {
  version: 1,
  rules: [
    { tier: 'light', note: 'documentation', paths: ['docs/'] },
    { tier: 'heavy', note: 'the gate', paths: ['src/gate/'] },
    { tier: 'normal', note: 'the source', paths: ['src/'] },
  ],
}
const policy = (riskTiers?: RiskTierMap, tierByRisk?: TierByRisk): AutonomyPolicy => ({
  schema: tierByRisk ? 'autonomy-policy@1.2' : riskTiers ? 'autonomy-policy@1.1' : 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }, { actionClass: 'merge', mode: 'ask' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 }, ...(riskTiers ? { riskTiers } : {}), ...(tierByRisk ? { tierByRisk } : {}),
})
/**
 * The operator's tier by risk (ADR-0073): heavy → frontier for develop and review, light → economy for
 * validate and docs; this template's validation step asks for `reason`, so its entry is named too.
 */
const BY_RISK: TierByRisk = { version: 1, heavy: { develop: 'frontier', review: 'frontier' }, light: { validate: 'economy', docs: 'economy', reason: 'economy' } }

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

/** The source that holds the run's worktree: it tells the change's paths (or cannot), and runs the required checks. */
class Holder {
  readonly checks: CheckStep[] = []
  files: string[] = []
  /** Files past the bound, counted only. */
  more = 0
  /** Set: the change cannot be read, with this error. */
  unreadable: string | undefined
  lint: 'passed' | 'failed' = 'passed'
  workspace = ''
  private artifacts!: Context['artifacts']

  register(ctx: Context): void {
    this.artifacts = ctx.artifacts
    ctx.workers.register({
      name: 'holder', describe: async () => [],
      changes: async (runId) => {
        if (this.unreadable) throw new Error(this.unreadable)
        return [{
          repository: '/repo', workspace: this.workspace, branch: `system/run/${runId}`, base: { branch: 'dev', sha: 'b'.repeat(40) }, head: 'b'.repeat(40),
          files: this.files.map((path): ChangedFile => ({ path, status: 'modified', added: 1, removed: 1 })), more: this.more, truncated: false,
        }]
      },
      start: () => {
        throw new Error('the holder runs no Worker')
      },
      get: () => undefined, wait: () => Promise.reject(new Error('the holder runs no Worker')),
      check: async (step) => {
        this.checks.push(step)
        const results = step.checks.map((check) => {
          const outcome = check === 'lint' ? this.lint : 'passed'
          return { check, outcome, exitCode: outcome === 'passed' ? 0 : 1, reason: `exited ${outcome === 'passed' ? 0 : 1}` }
        })
        const evidence = this.artifacts.put({
          kind: 'evidence', bodySchema: 'check-run@1.0', classification: step.classification, producer: { type: 'system', ref: 'holder' }, runId: step.runId,
          body: { schema: 'check-run@1.0', runId: step.runId, repository: step.workspace, workspace: step.workspace, subject: { type: 'git-head', ...step.subject }, setup: sha256('setup'), checks: results },
        }).id
        return { outcome: 'checked', results, evidence }
      },
    })
  }
}

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-risk-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'a.c'), 'int a;\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'a.c'), 'int a = 1;\n')
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const step = (nodeId: string, extra: Partial<NodeTemplate>): NodeTemplate => ({ nodeId, objective: `Do ${nodeId}`, prompt: '{{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...extra })
/** `algorithm-development`'s shape: a change, an exact-subject review of it, and a validation step a light change may skip. */
const TIERED: NodeTemplate[] = [
  step('develop', {}),
  step('review', { prompt: 'Review: {{input}}', capabilities: ['review'], dependsOn: ['develop'] }),
  step('validate', { prompt: 'Validate it', capabilities: ['reason'], dependsOn: ['review'], riskSkip: ['light'] }),
]

/** A reviewer of a provider family: it proves `review`, and its family is what routing compares (ADR-0027). */
const reviewer = (id: string, family: string): CapabilityDescriptor => worker(id, { schema: 'capability-descriptor@1.1', family, tier: 'standard', proves: ['review'] })
const TWO_FAMILIES = [reviewer('w:reviewer-a', 'fam-a'), reviewer('w:reviewer-b', 'fam-b')]
const AUTO: BoardConfig = { autoAccept: { projects: ['p1'], branches: ['dev'] } }

/** `map: null`: the policy carries no path map. */
async function boot({ map = MAP as RiskTierMap | null, reviewers = TWO_FAMILIES, board = AUTO, allowSameFamily = false, byRisk }: { map?: RiskTierMap | null; reviewers?: CapabilityDescriptor[]; board?: BoardConfig; allowSameFamily?: boolean; byRisk?: TierByRisk } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-risk-db-'))
  const workspace = tree()
  const holder = new Holder()
  holder.workspace = workspace
  const ctx = new Context()
  const workers = new TreeWorkers(workspace, () => ctx.artifacts)
  workers.extra = reviewers
  const answer = workers.reply
  workers.reply = (request: Rendered) => {
    const subject = /^Subject: (\S+)$/m.exec(request.prompt)?.[1]
    if (!subject) return answer(request)
    return { text: '```json\n' + JSON.stringify({ subject, verdict: 'approve', findings: [] }) + '\n```' }
  }
  const config = { ...CONFIG, approvalPollSeconds: 1, maxReviewCycles: 1, allowSameFamily, templates: { ...TEMPLATES, tiered: TIERED } }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => {
      c.workers.register(workers.source(c))
      holder.register(c)
    } }),
    ctx.plugin(StoreApprovals, { policies: [policy(map ?? undefined, byRisk)], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0, ...board }),
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
  const task = async (): Promise<{ taskId: string; runId: string }> => {
    const ready = await readyTask(ctx, 'tree', { writes: { type: 'git-head' as const, ref: subject.ref }, actionClass: 'workspace-write' })
    const run = await ctx.workflow.start({ template: 'tiered', input: 'change it', classification: 'public', task: { taskId: ready.taskId } })
    return { taskId: ready.taskId, runId: run.runId }
  }
  return { ctx, holder, workers, subject, task }
}

/** The task once its run's result reached the board: done, held for the operator, or sent back. */
const settled = (ctx: Context, taskId: string): Promise<BoardTask> => vi.waitFor(async () => {
  const task = (await ctx.board.task(taskId))!
  if (task.state === 'running' || task.state === 'claimed' || (task.state === 'review' && !task.waiting)) throw new Error(`task ${taskId} is ${task.state}`)
  return task
}, { timeout: 30_000, interval: 25 })

type Decision = { decider: { id: string; version: string }; inputs: string[]; candidates: Array<{ option: string; selected: boolean; reasons: string[] }>; outcome: { option: string; detail: Record<string, unknown> } }
const decisionsOf = (ctx: Context, runId: string, rule: string): Array<Decision & { nodeId?: string }> =>
  ctx.artifacts.list({ kind: 'decision', runId, limit: 1000 }).filter((a) => (a.body as Decision).decider.id === rule).map((a) => ({ ...(a.body as Decision), ...(a.nodeId ? { nodeId: a.nodeId } : {}) }))
const acceptanceOf = (ctx: Context, runId: string): Decision => {
  const found = decisionsOf(ctx, runId, 'workflow.task-acceptance')
  expect(found).toHaveLength(1)
  return found[0]!
}

describe('a heavy change (ADR-0071): a second review by another provider family, never accepted unattended', () => {
  it('grows a second review the other family takes, accepts with both families\' approvals, and holds the result for the operator though the auto-accept rule would apply', async () => {
    const { ctx, holder, workers, subject, task } = await boot()
    holder.files = ['docs/a.md', 'src/gate/policy.ts']
    const { taskId, runId } = await task()
    const held = await settled(ctx, taskId)

    // The tier, decided when the review approved, under that review, from the paths the change touches.
    const atReview = decisionsOf(ctx, runId, 'workflow.risk-tier').find((d) => d.nodeId === 'review')!
    expect(atReview.outcome).toMatchObject({ option: 'heavy', detail: { counts: { light: 1, normal: 0, heavy: 1 }, maps: [{ policy: { id: 'studio', version: 1 }, version: 1 }] } })
    expect(atReview.candidates.find((c) => c.selected)!.reasons).toContain('src/gate/policy.ts is heavy: the gate (src/gate/)')

    // The second review ran after the first, on a Worker of the other family, before the validation step.
    const view = ctx.workflow.get(runId)!
    const first = view.nodes.find((n) => n.nodeId === 'review')!
    const second = view.nodes.find((n) => n.nodeId === 'review:second')!
    expect(second.state).toBe('COMPLETED')
    expect(new Set([first.worker, second.worker])).toEqual(new Set(['w:reviewer-a', 'w:reviewer-b']))
    const validate = workers.started.findIndex((s) => s.prompt.includes('Validate it'))
    expect(validate).toBeGreaterThan(workers.started.findIndex((s) => s.worker === second.worker))

    // The acceptance names the run-level tier decision among its inputs, and the two families.
    const acceptance = acceptanceOf(ctx, runId)
    expect(acceptance).toMatchObject({ decider: { version: '4' }, outcome: { option: 'accept', detail: { risk: { tier: 'heavy', families: 2 } } } })
    const risk = acceptance.outcome.detail['risk'] as { decision: string }
    expect(acceptance.inputs).toContain(risk.decision)
    expect(ctx.artifacts.get(risk.decision as ArtifactRef)?.body).toMatchObject({ decider: { id: 'workflow.risk-tier' }, outcome: { option: 'heavy' } })
    expect(decisionsOf(ctx, runId, 'workflow.risk-tier').filter((d) => d.nodeId === undefined)).toHaveLength(1)

    // Reviewed, checked, landing on a listed branch: the auto-accept rule would apply, but a heavy result is the operator's.
    expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: [] } })
    expect(ctx.artifacts.get(held.lastDecision!)?.body).toMatchObject({ outcome: { option: 'operator-review', detail: { heavy: expect.stringContaining('heavy-tier') } } })

    // The tier and why, in the run's explain.
    expect(ctx.workflow.explain(runId)?.risk).toMatchObject({ tier: 'heavy', decision: risk.decision, reasons: expect.arrayContaining([expect.stringContaining('src/gate/policy.ts is heavy')]) })
    expect(acceptance.outcome.detail['subject']).toMatchObject({ type: 'git-head', ref: subject.ref })
  })

  it('fails the second review when only one provider family can review, even with allowSameFamily on: no heavy result is accepted on one family\'s word (INV-2)', async () => {
    const { ctx, holder, task } = await boot({ reviewers: [reviewer('w:reviewer-a', 'fam-a'), reviewer('w:reviewer-a2', 'fam-a')], allowSameFamily: true })
    holder.files = ['src/gate/policy.ts']
    const { taskId, runId } = await task()
    const after = await settled(ctx, taskId)
    expect(after.state).not.toBe('done')
    const view = ctx.workflow.get(runId)!
    expect(view.status).toBe('failed')
    expect(view.nodes.find((n) => n.nodeId === 'review:second')).toMatchObject({ state: 'FAILED' })
    expect(view.nodes.find((n) => n.nodeId === 'validate')?.state).toBe('WAITING')
    expect(decisionsOf(ctx, runId, 'workflow.same-family')).toEqual([])
    expect(decisionsOf(ctx, runId, 'workflow.task-acceptance')).toEqual([])
  })

  it('is heavy when the change cannot be read, or holds paths past the bound, or touches a path no rule matches (INV-2)', async () => {
    const unread = await boot()
    unread.holder.unreadable = 'the worktree is gone'
    const one = await unread.task()
    await settled(unread.ctx, one.taskId)
    expect(decisionsOf(unread.ctx, one.runId, 'workflow.risk-tier').find((d) => d.nodeId === 'review')?.outcome).toMatchObject({
      option: 'heavy', detail: { paths: [{ tier: 'heavy', why: 'unreadable', detail: 'source holder could not read its worktree of the run: the worktree is gone' }] },
    })

    const past = await boot()
    past.holder.files = ['docs/a.md']
    past.holder.more = 4
    const two = await past.task()
    await settled(past.ctx, two.taskId)
    expect(acceptanceOf(past.ctx, two.runId).outcome.detail['risk']).toMatchObject({ tier: 'heavy' })

    const unmatched = await boot()
    unmatched.holder.files = ['docs/a.md', 'tools/new.sh']
    const three = await unmatched.task()
    await settled(unmatched.ctx, three.taskId)
    expect(acceptanceOf(unmatched.ctx, three.runId).outcome.detail['risk']).toMatchObject({ tier: 'heavy' })
  })
})

describe('the acceptance of a heavy result requires approving reviews of its exact tree by two provider families', () => {
  const at = 'git:abc:v1'
  const risk = (reviews: AcceptanceRisk['reviews'], tier: AcceptanceRisk['tier'] = 'heavy'): AcceptanceRisk => ({ tier, decision: 'sha256:r' as ArtifactRef, reviews })

  it('counts families, never reviews: two Workers of one family are one', () => {
    expect(secondFamily(risk([{ node: 'review', worker: 'a1', subject: at, family: 'fam-a' }, { node: 'review:second', worker: 'a2', subject: at, family: 'fam-a' }]), at)).toMatchObject({ met: false, families: 1 })
    expect(secondFamily(risk([{ node: 'review', worker: 'a', subject: at, family: 'fam-a' }, { node: 'review:second', worker: 'b', subject: at, family: 'fam-b' }]), at)).toMatchObject({ met: true, families: 2 })
  })

  it('counts only approvals of the exact tree, and a Worker whose family is not listed now as none (INV-5, ADR-0027)', () => {
    expect(secondFamily(risk([{ node: 'review', worker: 'a', subject: at, family: 'fam-a' }, { node: 'review:second', worker: 'b', subject: 'git:abc:v0', family: 'fam-b' }]), at)).toMatchObject({ met: false, families: 1 })
    expect(secondFamily(risk([{ node: 'review', worker: 'a', subject: at, family: 'fam-a' }, { node: 'review:second', worker: 'gone', subject: at }]), at)).toMatchObject({ met: false, families: 1 })
  })

  const reviewed = { node: 'review', verdict: 'approve', blocking: 0, cycle: 1, maxCycles: 3, subject: { ref: 'abc', version: 'v1' } }
  const both: AcceptanceRisk['reviews'] = [{ node: 'review', worker: 'a', subject: at, family: 'fam-a' }, { node: 'review:second', worker: 'b', subject: at, family: 'fam-b' }]
  const report = { type: 'artifact', ref: 'sha256:report' }

  it('judges a result bound to a report artifact on the tree its reviews judged (T280)', () => {
    expect(heavyReasons(risk(both), report, reviewed)).toMatchObject({ met: true, families: 2, reasons: [] })
  })

  it('names a last review that requested changes at the bound first, before any family reason (T280)', () => {
    const said = heavyReasons(risk([both[0]!]), report, { ...reviewed, verdict: 'changes-requested', blocking: 1, cycle: 3 })
    expect(said.met).toBe(false)
    expect(said.reasons[0]).toMatch(/changes-requested with 1 blocking finding\(s\) at cycle 3 of 3/)
    expect(said.reasons[1]).toMatch(/only 1 provider family/)
  })

  it('throws on an empty subject, never reading it as no reviews (T280)', () => {
    expect(() => secondFamily(risk(both), '')).toThrow(/empty/)
  })

  it('rejects a heavy result with no review of a git tree, saying so', () => {
    expect(heavyReasons(risk(both), report, undefined)).toMatchObject({ met: false, reasons: [expect.stringMatching(/no review of a git tree/)] })
  })

  it('asks nothing of a light or normal result, or of a run with no tier', () => {
    expect(secondFamily(risk([], 'normal'), at).met).toBe(true)
    expect(secondFamily(undefined, at).met).toBe(true)
  })
})

describe('a light change (ADR-0071): its validation step is skipped once its required checks pass', () => {
  it('retires the validation step after the review approved and the checks passed on its exact tree, and is accepted without the operator', async () => {
    const { ctx, holder, workers, task } = await boot()
    holder.files = ['docs/a.md', 'docs/b.md']
    const { taskId, runId } = await task()
    expect(await settled(ctx, taskId)).toMatchObject({ state: 'done' })
    expect(workers.started.some((s) => s.prompt.includes('Validate it'))).toBe(false)
    const view = ctx.workflow.get(runId)!
    expect(view.nodes.find((n) => n.nodeId === 'validate')?.state).toBe('RETIRED')
    expect(view.nodes.some((n) => n.nodeId === 'review:second')).toBe(false)
    const [skip] = decisionsOf(ctx, runId, 'workflow.risk-skip')
    expect(skip).toMatchObject({ nodeId: 'validate', outcome: { option: 'skip', detail: { tier: 'light' } } })
    expect(acceptanceOf(ctx, runId).outcome).toMatchObject({ option: 'accept', detail: { risk: { tier: 'light' }, checks: { tests: true, lint: true } } })
    expect(ctx.workflow.explain(runId)?.risk?.tier).toBe('light')
  })

  it('runs the validation step when a required check failed, recorded, and the failed check sends the work back', async () => {
    const { ctx, holder, workers, task } = await boot()
    holder.files = ['docs/a.md']
    holder.lint = 'failed'
    const { taskId, runId } = await task()
    expect((await settled(ctx, taskId)).state).toBe('ready')
    expect(workers.started.some((s) => s.prompt.includes('Validate it'))).toBe(true)
    const [run] = decisionsOf(ctx, runId, 'workflow.risk-skip')
    expect(run).toMatchObject({ nodeId: 'validate', outcome: { option: 'run' } })
    expect(run!.candidates.find((c) => c.selected)!.reasons[0]).toMatch(/a required check failed: lint/)
  })

  it('a normal change runs every step and is accepted as before', async () => {
    const { ctx, holder, workers, task } = await boot()
    holder.files = ['src/a.c']
    const { taskId, runId } = await task()
    expect(await settled(ctx, taskId)).toMatchObject({ state: 'done' })
    expect(workers.started.some((s) => s.prompt.includes('Validate it'))).toBe(true)
    expect(decisionsOf(ctx, runId, 'workflow.risk-skip')).toEqual([])
    expect(acceptanceOf(ctx, runId).outcome.detail['risk']).toMatchObject({ tier: 'normal' })
  })
})

describe('tier by risk (ADR-0073): a step\'s minimum tier set by its task\'s risk tier, as the policy maps it, recorded', () => {
  const tierDecisions = (ctx: Context, runId: string) => decisionsOf(ctx, runId, 'workflow.tier-by-risk')

  it('raises a heavy change\'s reviews to frontier, the first and the second, a recorded decision naming the risk and the map, while develop, routed before the change existed, keeps its tier', async () => {
    const frontier = (id: string, family: string) => worker(id, { schema: 'capability-descriptor@1.1', family, tier: 'frontier', proves: ['review'] })
    const { ctx, holder, workers, task } = await boot({ reviewers: [frontier('w:reviewer-a', 'fam-a'), frontier('w:reviewer-b', 'fam-b')], byRisk: BY_RISK })
    holder.files = ['src/gate/policy.ts']
    const { taskId, runId } = await task()
    await settled(ctx, taskId)
    // develop ran before there was a change: it keeps its template's tier. Both reviews are tiered from the change they review (T288).
    const decided = tierDecisions(ctx, runId)
    expect(decided.map((d) => d.nodeId)).toEqual(['review', 'review:second'])
    expect(decided[0]).toMatchObject({ outcome: { option: 'frontier', detail: { risk: 'heavy', from: 'standard', to: 'frontier' } } })
    expect(ctx.workflow.get(runId)!.nodes.find((n) => n.nodeId === 'review')).toMatchObject({ tier: 'frontier' })
    // The routing-time decision is the review's own, never the run's: the acceptance still records its one run-level decision.
    expect(acceptanceOf(ctx, runId).outcome.detail['risk']).toMatchObject({ tier: 'heavy' })
    expect(decisionsOf(ctx, runId, 'workflow.risk-tier').filter((d) => d.nodeId === undefined)).toHaveLength(1)
    const second = decided[1]
    expect(second).toMatchObject({ decider: { id: 'workflow.tier-by-risk', version: '1' }, outcome: { option: 'frontier', detail: { risk: 'heavy', from: 'standard', to: 'frontier', matched: [{ policy: 'studio', policyVersion: 1, mapVersion: 1, key: 'review', tier: 'frontier' }] } } })
    expect(second!.inputs).toHaveLength(1)
    expect(ctx.artifacts.get(second!.inputs[0] as ArtifactRef)?.body).toMatchObject({ decider: { id: 'workflow.risk-tier' }, outcome: { option: 'heavy' } })
    expect(second!.candidates.find((c) => c.selected)!.reasons).toEqual([expect.stringContaining('the task\'s change is heavy'), 'raised from standard to frontier'])
    const view = ctx.workflow.get(runId)!
    expect(view.nodes.find((n) => n.nodeId === 'review:second')).toMatchObject({ state: 'COMPLETED', worker: 'w:reviewer-b', tier: 'frontier' })
    expect(view.nodes.find((n) => n.nodeId === 'develop')).toMatchObject({ worker: 'w:standard', tier: 'standard' })
    const explained = ctx.workflow.explain(runId)!.nodes.find((n) => n.nodeId === 'review:second')!
    expect(explained.decisions.map((d) => d.type)).toEqual(expect.arrayContaining(['tier', 'route']))
    expect(workers.started.filter((s) => s.worker === 'w:frontier')).toEqual([])
  })

  it('runs a first attempt\'s first review at frontier when its develop wrote a heavy change, and at the template\'s tier when the change is light (T288)', async () => {
    const heavy = await boot({ reviewers: [reviewer('w:reviewer-a', 'fam-a'), worker('w:reviewer-b', { schema: 'capability-descriptor@1.1', family: 'fam-b', tier: 'frontier', proves: ['review'] })], byRisk: BY_RISK })
    heavy.holder.files = ['src/gate/policy.ts']
    const one = await heavy.task()
    // Only fam-b reviews at frontier, so the second review (fam-a, frontier) finds no Worker and the run fails before any
    // acceptance: what is asserted here is the first review's tier only.
    await settled(heavy.ctx, one.taskId)
    expect(heavy.ctx.workflow.get(one.runId)!.nodes.find((n) => n.nodeId === 'review')?.state).toBe('COMPLETED')
    const first = tierDecisions(heavy.ctx, one.runId).find((d) => d.nodeId === 'review')!
    expect(first).toMatchObject({ outcome: { option: 'frontier', detail: { risk: 'heavy', from: 'standard', to: 'frontier' } } })
    // Its input is the risk of the change it reviews, decided under the review when it was routed.
    expect(heavy.ctx.artifacts.get(first.inputs[0] as ArtifactRef)).toMatchObject({ nodeId: 'review', body: { decider: { id: 'workflow.risk-tier' }, outcome: { option: 'heavy', detail: { routed: 'review' } } } })
    // The frontier Worker of fam-b took it; at the template's standard tier, fam-a's would have been as good.
    expect(heavy.ctx.workflow.get(one.runId)!.nodes.find((n) => n.nodeId === 'review')).toMatchObject({ worker: 'w:reviewer-b', tier: 'frontier' })

    const light = await boot({ byRisk: BY_RISK })
    light.holder.files = ['docs/a.md']
    const two = await light.task()
    await settled(light.ctx, two.taskId)
    expect(decisionsOf(light.ctx, two.runId, 'workflow.risk-tier').find((d) => d.nodeId === 'review' && d.outcome.detail['routed'] === 'review')?.outcome.option).toBe('light')
    expect(tierDecisions(light.ctx, two.runId).find((d) => d.nodeId === 'review')).toBeUndefined()
    expect(light.ctx.workflow.get(two.runId)!.nodes.find((n) => n.nodeId === 'review')).toMatchObject({ tier: 'standard' })
  })

  it('records in the brief of a step on a Worker that offers tiers the tier it was served at and the model its source runs there; a one-tier Worker\'s brief names neither', async () => {
    const tiered = worker('w:reviewer-t', { schema: 'capability-descriptor@1.10', family: 'fam-a', tier: 'standard', tiers: [{ tier: 'standard' }, { tier: 'frontier' }], proves: ['review'] })
    const { ctx, workers, task } = await boot({ map: null, reviewers: [tiered] })
    workers.models.set('w:reviewer-t standard', 'model-standard-1')
    workers.models.set('w:reviewer-t frontier', 'model-frontier-1')
    const { taskId, runId } = await task()
    await settled(ctx, taskId)
    const view = ctx.workflow.get(runId)!
    const brief = (nodeId: string) => ctx.artifacts.get(view.nodes.find((n) => n.nodeId === nodeId)!.brief!)!.body as Record<string, unknown>
    expect(brief('review')).toMatchObject({ schema: 'brief@1.5', tier: 'standard', model: 'model-standard-1' })
    expect(brief('develop')).not.toHaveProperty('tier')
    expect(brief('develop')).not.toHaveProperty('model')
  })

  it('lowers a light change\'s validation to economy when it runs (a required check failed), and leaves a normal change\'s steps as their templates say', async () => {
    const { ctx, holder, workers, task } = await boot({ byRisk: BY_RISK })
    holder.files = ['docs/a.md']
    holder.lint = 'failed'
    const { taskId, runId } = await task()
    await settled(ctx, taskId)
    const validate = workers.started.find((s) => s.prompt.includes('Validate it'))!
    expect(validate.worker).toBe('w:economy')
    expect(tierDecisions(ctx, runId)).toEqual([expect.objectContaining({ nodeId: 'validate', outcome: expect.objectContaining({ option: 'economy', detail: expect.objectContaining({ risk: 'light', from: 'standard', to: 'economy' }) }) })])

    const normal = await boot({ byRisk: BY_RISK })
    normal.holder.files = ['src/a.c']
    const two = await normal.task()
    await settled(normal.ctx, two.taskId)
    expect(tierDecisions(normal.ctx, two.runId)).toEqual([])
    expect(normal.workers.started.find((s) => s.prompt.includes('Validate it'))!.worker).toBe('w:standard')
  })

  it('starts a heavy task\'s next attempt with its develop step at frontier, from the earlier attempt\'s risk tier', async () => {
    const { ctx, holder, workers, task } = await boot({ reviewers: [reviewer('w:reviewer-a', 'fam-a'), reviewer('w:reviewer-a2', 'fam-a')], byRisk: { version: 2, heavy: { develop: 'frontier' } } })
    holder.files = ['src/gate/policy.ts']
    const first = await task()
    // One family only: the second review cannot run, and the attempt fails, its change found heavy.
    expect((await settled(ctx, first.taskId)).state).toBe('ready')
    expect(decisionsOf(ctx, first.runId, 'workflow.risk-tier').map((d) => d.outcome.option)).toContain('heavy')
    const again = await ctx.workflow.start({ template: 'tiered', input: 'change it again', classification: 'public', task: { taskId: first.taskId } })
    await vi.waitFor(() => {
      if (!ctx.workflow.get(again.runId)!.nodes.find((n) => n.nodeId === 'develop')?.worker) throw new Error('develop not routed yet')
    }, { timeout: 30_000, interval: 25 })
    expect(ctx.workflow.get(again.runId)!.nodes.find((n) => n.nodeId === 'develop')).toMatchObject({ worker: 'w:frontier', tier: 'frontier' })
    expect(workers.started.find((s) => s.runId === again.runId)!.worker).toBe('w:frontier')
    const [raised] = tierDecisions(ctx, again.runId)
    expect(raised).toMatchObject({ nodeId: 'develop', outcome: { option: 'frontier', detail: { risk: 'heavy', from: 'standard', matched: [{ mapVersion: 2, key: 'develop' }] } } })
    // Its input is the earlier attempt's risk-tier decision: the task's tier, read from the run that found it.
    expect(ctx.artifacts.get(raised!.inputs[0] as ArtifactRef)?.body).toMatchObject({ decider: { id: 'workflow.risk-tier' }, outcome: { option: 'heavy' } })
  })

  it('holds a step whose tier at its risk tier cannot be read (the policy unreadable): it is never routed at its template\'s tier, and fails unsent once its attempts are spent (INV-2)', async () => {
    const { ctx, workers, task } = await boot({ byRisk: BY_RISK })
    const read = vi.spyOn(ctx.approvals, 'policy').mockRejectedValue(new Error('the policy store is unavailable'))
    const { taskId, runId } = await task()
    await vi.waitFor(() => {
      if (ctx.workflow.get(runId)!.status !== 'failed') throw new Error('run not failed yet')
    }, { timeout: 30_000, interval: 25 })
    expect(read).toHaveBeenCalled()
    // Nothing was routed or sent: not at the template's tier, not anywhere.
    expect(workers.started.filter((s) => s.runId === runId)).toEqual([])
    const develop = ctx.workflow.get(runId)!.nodes.find((n) => n.nodeId === 'develop')!
    expect(develop).toMatchObject({ state: 'FAILED', error: { kind: 'internal', message: expect.stringContaining('the autonomy policy could not be read (the policy store is unavailable)') } })
    expect(develop).not.toHaveProperty('worker')
    expect(develop.error!.message).toContain('the step is held, not routed at its template\'s tier')
    expect(tierDecisions(ctx, runId)).toEqual([])
    read.mockRestore()
    expect((await ctx.board.task(taskId))!.state).not.toBe('done')
  })
})

it('is off with no path map in the policy: no tier is decided, and the process is as before', async () => {
  const { ctx, holder, workers, task } = await boot({ map: null })
  holder.files = ['src/gate/policy.ts']
  const { taskId, runId } = await task()
  expect(await settled(ctx, taskId)).toMatchObject({ state: 'done' })
  expect(workers.started.some((s) => s.prompt.includes('Validate it'))).toBe(true)
  expect(decisionsOf(ctx, runId, 'workflow.risk-tier')).toEqual([])
  expect(acceptanceOf(ctx, runId).outcome.detail).not.toHaveProperty('risk')
  expect(ctx.workflow.explain(runId)).not.toHaveProperty('risk')
})
