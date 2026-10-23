import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { ApprovalRequest, AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { ArtifactRef, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { CONFIG, type Rendered, ScriptedWorkers } from '../conformance/workflow.ts'
import Workflow, { type NodeTemplate, type RunView } from '../src/index.ts'

// Remediation on the approval queue (docs/design/workflow-engine.md#remediation-on-the-approval-queue),
// end to end over the store-backed queue and a git working tree; only Worker execution is scripted.
vi.setConfig({ testTimeout: 120_000 })

/** Everything asks but `read`: `remediation` is never auto or notify anyway (ALWAYS_ASK). */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }], default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

const step = (nodeId: string, extra: Partial<NodeTemplate>): NodeTemplate => ({
  nodeId, objective: `Do ${nodeId}`, prompt: '{{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...extra,
})
/** A change, and an exact-subject review of it: blocking findings grow a fix behind a gate, then a re-review. */
const TEMPLATES: Record<string, NodeTemplate[]> = {
  change: [step('develop', { prompt: 'Develop: {{input}}' }), step('review', { prompt: 'Review: {{input}}', capabilities: ['review'], dependsOn: ['develop'] })],
}

/** Scripted Workers that answer as agents in one git working tree, each result an `agent-result@1.1` on the tree's subject then. */
class TreeWorkers extends ScriptedWorkers {
  private readonly results = new Map<string, ArtifactRef>()
  constructor(private readonly workspace: string, private readonly artifacts: () => Context['artifacts']) {
    super()
  }

  override get(id: string): WorkerExecution | undefined {
    const execution = super.get(id)
    if (!execution?.result) return execution
    if (!this.results.has(id)) {
      const text = (this.artifacts().get(execution.result)!.body as { text: string }).text
      const { subject } = captureGitSubject(this.workspace)!
      this.results.set(id, this.artifacts().put({
        kind: 'report', bodySchema: 'agent-result@1.1', classification: 'public', producer: { type: 'worker', ref: 'w:standard' },
        body: { schema: 'agent-result@1.1', worker: 'w:standard', runtime: 'scripted', runId: `agent-${id}`, promptHash: sha256(text), sandbox: 'workspace-write', text, workspace: this.workspace, subject },
      }).id as ArtifactRef)
    }
    return { ...execution, result: this.results.get(id)! }
  }
}

/** A git working tree with a commit. */
function workingTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-remediation-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

interface Booted {
  ctx: Context
  workers: TreeWorkers
  dir: string
  /** Stop the engine alone, run `between` while it is down (the queue and the store stay), then start it again. */
  restartWorkflow: (between?: () => void | Promise<void>) => Promise<void>
}

/**
 * The engine over a working tree: the developer changes calc.py, a fix adds a test, and the
 * reviewer asks for changes `reviews` times, then approves.
 */
async function boot(options: { queue?: boolean; policy?: AutonomyPolicy; reviews?: number } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-queue-'))
  const tree = workingTree()
  const ctx = new Context()
  const workers = new TreeWorkers(tree, () => ctx.artifacts)
  workers.extra = [worker('w:reviewer', { tier: 'standard', proves: ['review'] })]
  let reviews = 0
  workers.reply = (request: Rendered) => {
    const subject = /^Subject: (\S+)$/m.exec(request.prompt)?.[1]
    if (subject) {
      const changes = ++reviews <= (options.reviews ?? 1)
      return { text: '```json\n' + JSON.stringify({ subject, verdict: changes ? 'changes-requested' : 'approve', findings: [{ severity: changes ? 'blocking' : 'info', title: 'no test for add()', file: 'calc.py' }] }) + '\n```' }
    }
    if (request.prompt.includes('Fix the blocking findings')) writeFileSync(join(tree, `test_${workers.started.length}.py`), 'assert True\n')
    else writeFileSync(join(tree, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    return { text: 'done' }
  }
  const config = { ...CONFIG, approvalPollSeconds: 1, templates: TEMPLATES }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ...(options.queue === false ? [] : [ctx.plugin(StoreApprovals, { policies: [options.policy ?? POLICY], sweepSeconds: 3600 })]),
  ]
  await Promise.all(fibers)
  let engine = ctx.plugin(Workflow, config)
  await engine
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return {
    ctx, workers, dir,
    restartWorkflow: async (between) => {
      await engine.dispose()
      await between?.()
      engine = ctx.plugin(Workflow, config)
      await engine
    },
  }
}

const until = async <T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The run once it waits on the remediation gate's request in the queue. */
const queued = (ctx: Context, runId: string): Promise<RunView & { blocked: { kind: 'gate'; approvalRequest: string; plan: ArtifactRef } }> =>
  until(() => {
    const view = ctx.workflow.get(runId)
    return view?.blocked?.kind === 'gate' && view.blocked.approvalRequest ? view as RunView & { blocked: { kind: 'gate'; approvalRequest: string; plan: ArtifactRef } } : undefined
  }, `run ${runId} to wait on the queue`)

const finished = (ctx: Context, runId: string): Promise<RunView> => until(() => {
  const view = ctx.workflow.get(runId)
  return view && view.status !== 'running' ? view : undefined
}, `run ${runId} to finish`, 60_000)

const decide = async (ctx: Context, request: ApprovalRequest, verdict: 'approved' | 'rejected'): Promise<void> => {
  const [result] = await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict }])
  expect(result!.refused).toBeUndefined()
}

const fixes = (workers: ScriptedWorkers): number => workers.started.filter((s) => s.prompt.includes('Fix the blocking findings')).length

describe('remediation on the approval queue', () => {
  it('puts the fix\'s plan to the queue on its exact subject, and runs the fix only once the operator approves it there', async () => {
    const { ctx, workers } = await boot()
    const run = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
    const waiting = await queued(ctx, run.runId)
    expect(waiting.blocked.nodeId).toBe('review:approve:1')
    const request = (await ctx.approvals.get(waiting.blocked.approvalRequest))!
    const gate = ctx.workflow.records(run.runId).find((r) => r.nodeId === 'review:approve:1')!
    const reviewed = /Subject: (\S+)/.exec(workers.started.find((s) => s.prompt.startsWith('Review'))!.prompt)![1]!
    // One request, bound to exactly the plan and the reviewed subject (INV-5), asked by the workflow for this gate.
    expect(['open', 'batched']).toContain(request.state)
    expect(request).toMatchObject({
      subject: { type: 'artifact', ref: waiting.blocked.plan, version: reviewed }, action: { class: 'remediation', refs: [waiting.blocked.plan] },
      requester: { component: 'workflow', runId: run.runId, nodeId: 'review:approve:1' }, classification: 'public',
    })
    expect(waiting.blocked.until).toBe(request.expiresAt)
    expect(gate.state).toBe('BLOCKED')
    expect(fixes(workers)).toBe(0)
    // The queue is the one channel for this verdict: the operator's plan approval is refused, and changes nothing.
    expect(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: waiting.blocked.plan })).toThrow(/waits on approval request .* in the approval queue/)
    expect(ctx.workflow.get(run.runId)!.blocked).toMatchObject({ kind: 'gate' })
    // Polling again asks nothing new.
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).toHaveLength(1)
    await decide(ctx, request, 'approved')
    const done = await finished(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(fixes(workers)).toBe(1)
    const opened = ctx.workflow.records(run.runId).find((r) => r.nodeId === 'review:approve:1')!
    const approved = (await ctx.approvals.get(request.requestId))!
    // The gate's result is the operator's approval, and a gate decision by the engine's rule names it.
    expect(opened.outputReceipt!.result).toBe(approved.resolution!.approval)
    const decision = ctx.artifacts.get(opened.outputReceipt!.acceptance)!.body as { decisionType: string; decider: { id: string }; outcome: { option: string; detail: { approvalRequest: string } } }
    expect(decision).toMatchObject({ decisionType: 'gate', decider: { id: 'workflow.remediation-approval' }, outcome: { option: 'open', detail: { approvalRequest: request.requestId } } })
    expect(done.nodes.map((n) => [n.nodeId, n.state])).toEqual([
      ['develop', 'COMPLETED'], ['review', 'COMPLETED'], ['review:approve:1', 'COMPLETED'], ['review:fix:1', 'COMPLETED'], ['review:review:2', 'COMPLETED'],
    ])
  })

  it('ends the cycle on a rejection, and asks again on continue', async () => {
    const { ctx, workers } = await boot()
    const run = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
    const first = (await ctx.approvals.get((await queued(ctx, run.runId)).blocked.approvalRequest))!
    await decide(ctx, first, 'rejected')
    const failed = await finished(ctx, run.runId)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected' } })
    expect(failed.error!.message).toContain('the operator rejected it')
    expect(fixes(workers)).toBe(0)
    ctx.workflow.continue(run.runId, 'review:approve:1')
    const again = await queued(ctx, run.runId)
    // A new request on the same exact subject: the old verdict never opens the reopened gate.
    expect(again.blocked.approvalRequest).not.toBe(first.requestId)
    const second = (await ctx.approvals.get(again.blocked.approvalRequest))!
    expect(second.subject).toEqual(first.subject)
    await decide(ctx, second, 'approved')
    expect((await finished(ctx, run.runId)).status).toBe('completed')
    expect(fixes(workers)).toBe(1)
  })

  it('ends the cycle as gate_timeout when the request expires unanswered', async () => {
    const { ctx, workers } = await boot()
    const run = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
    const request = (await ctx.approvals.get((await queued(ctx, run.runId)).blocked.approvalRequest))!
    await ctx.approvals.sweep(new Date(Date.parse(request.expiresAt) + 1000))
    const failed = await finished(ctx, run.runId)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'gate_timeout' } })
    expect(fixes(workers)).toBe(0)
  })

  it('closes the gate when the policy forbids remediation, asking no one', async () => {
    const { ctx, workers } = await boot({ policy: { ...POLICY, rules: [...POLICY.rules, { actionClass: 'remediation', mode: 'forbid' }] } })
    const run = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
    const failed = await finished(ctx, run.runId)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected' } })
    expect(failed.error!.message).toContain('forbids remediation')
    expect(await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).toEqual([])
    expect(fixes(workers)).toBe(0)
  })

  it('withdraws the request when the operator stops the run', async () => {
    const { ctx, workers } = await boot()
    const run = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
    const requestId = (await queued(ctx, run.runId)).blocked.approvalRequest
    await ctx.workflow.stop(run.runId)
    expect(await ctx.approvals.get(requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(fixes(workers)).toBe(0)
  })

  it('reconciles on restart: a verdict given while the engine was down applies, and a request whose id was never stored is adopted, never asked twice (INV-4)', async () => {
    const { ctx, workers, dir, restartWorkflow } = await boot()
    const run = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
    const request = (await ctx.approvals.get((await queued(ctx, run.runId)).blocked.approvalRequest))!
    await restartWorkflow(async () => {
      // As if the engine crashed after the queue took the request and before the gate stored its id.
      const db = new DatabaseSync(join(dir, 'system.db'))
      db.prepare("UPDATE workflow_nodes SET approval_request = NULL WHERE run_id = ? AND node_id = 'review:approve:1'").run(run.runId)
      db.close()
      await decide(ctx, request, 'approved')
    })
    const done = await finished(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(fixes(workers)).toBe(1)
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).map((r) => r.requestId)).toEqual([request.requestId])
  })

  it('without an approval queue, the fix waits for the operator\'s plan gate, never for a policy (INV-2)', async () => {
    const { ctx, workers } = await boot({ queue: false })
    const run = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
    const view = await until(() => {
      const v = ctx.workflow.get(run.runId)
      return v?.blocked?.kind === 'gate' ? v : undefined
    }, 'the plan gate')
    expect(view.blocked).not.toHaveProperty('approvalRequest')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(fixes(workers)).toBe(0)
    ctx.workflow.approve(run.runId, { verdict: 'approved', plan: (view.blocked as { plan: string }).plan })
    expect((await finished(ctx, run.runId)).status).toBe('completed')
    expect(fixes(workers)).toBe(1)
  })
})
