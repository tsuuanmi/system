import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { ArtifactRef, BoardTask } from '@tsuuanmi/system-board-core'
import { type DigestRequest, Digests, type DigestView } from '@tsuuanmi/system-digest-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { type Brief, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { type Drafter, FakeDigests } from '../../../digest-core/conformance/digests.ts'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../conformance/workflow.ts'
import Workflow, { type Config, type RunView, type TaskView } from '../src/index.ts'

// The engine's digests of board task results, end to end over the store-backed board and approval
// queue; the digest provider is the seam's fake (or one that holds requests), and Workers are scripted.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/** Every {@link HeldDigests} started, the latest last. */
const helds: HeldDigests[] = []

/** A digest provider whose requests stay pending until the test writes them; it outlives the engine's restarts. */
class HeldDigests extends Digests {
  static inject = ['artifacts']
  readonly requests = new Map<string, DigestView>()

  constructor(ctx: Context) {
    super(ctx)
    helds.push(this)
  }

  private readonly keys = new Map<string, string>()
  private readonly waiters = new Set<() => void>()

  async request(input: DigestRequest): Promise<DigestView> {
    const known = input.key !== undefined ? this.keys.get(input.key) : undefined
    if (known) return this.requests.get(known)!
    const at = new Date().toISOString()
    const view: DigestView = { requestId: `dig-${randomBytes(6).toString('hex')}`, state: 'pending', sources: [...input.sources], createdAt: at, updatedAt: at }
    this.requests.set(view.requestId, view)
    if (input.key !== undefined) this.keys.set(input.key, view.requestId)
    return view
  }

  async get(requestId: string): Promise<DigestView | undefined> {
    return this.requests.get(requestId)
  }

  async wait(requestId: string, timeoutMs: number): Promise<DigestView> {
    if (this.requests.get(requestId)?.state === 'pending') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs)
        function done(): void {
          clearTimeout(timer)
          resolve()
        }
        this.waiters.add(done)
      })
    }
    return this.requests.get(requestId)!
  }

  /** Settle a request written, with a digest of its sources. */
  write(requestId: string): ArtifactRef {
    const view = this.requests.get(requestId)!
    const digest = this.ctx.artifacts.put({
      kind: 'report', bodySchema: 'digest@1.0', classification: 'public', producer: { type: 'worker', ref: 'held' }, inputs: view.sources,
      body: { schema: 'digest@1.0', sources: view.sources, status: 'passed', summary: 'held, then written', claims: [{ id: 'C1', kind: 'finding', text: 'it answered', citation: { artifact: view.sources[0]!, quote: 'answer' } }] },
    }).id as ArtifactRef
    this.requests.set(requestId, { ...view, state: 'written', digest, updatedAt: new Date().toISOString() })
    for (const wake of this.waiters) wake()
    this.waiters.clear()
    return digest
  }
}

/** A drafter that quotes the first source's text verbatim, so its digest is written. */
const quoting = (quote: string): Drafter => (sources) => ({
  text: `\`\`\`json\n${JSON.stringify({ status: 'passed', summary: 'The step answered.', claims: [{ id: 'C1', kind: 'finding', text: 'It answered.', citation: { artifact: sources[0], quote } }] })}\n\`\`\``,
})

async function boot(options: { workflow?: Config; digests?: Drafter | 'held' | false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-digests-'))
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  const config: Config = { ...CONFIG, ...options.workflow, templates: { ...TEMPLATES, ...options.workflow?.templates } }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ...(options.digests === 'held' ? [ctx.plugin(HeldDigests)] : options.digests ? [ctx.plugin(FakeDigests, { drafter: options.digests })] : []),
  ]
  await Promise.all(fibers)
  let engine = ctx.plugin(Workflow, config)
  await engine
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  await activeProject(ctx)
  return {
    ctx, workers, held: () => helds.at(-1)!,
    restartWorkflow: async (between?: () => void | Promise<void>) => {
      await engine.dispose()
      await between?.()
      engine = ctx.plugin(Workflow, config)
      await engine
    },
  }
}

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The run's task once its digest settled: attached or bypassed. */
const digested = async (ctx: Context, runId: string): Promise<TaskView> => {
  await until(() => ['attached', 'bypassed'].includes(ctx.workflow.get(runId)?.task?.digest?.state ?? ''), `run ${runId}'s digest`)
  return ctx.workflow.get(runId)!.task!
}
const run = async (ctx: Context, task: BoardTask, input = 'the question'): Promise<RunView> => {
  const started = await ctx.workflow.start({ template: 'solo', input, classification: 'public', task: { taskId: task.taskId } })
  await until(() => ctx.workflow.get(started.runId)?.task?.phase === 'reported', `run ${started.runId}'s report`)
  return ctx.workflow.get(started.runId)!
}
type Decision = { decisionType: string; inputs: string[]; decider: { id: string }; outcome: { option: string; detail?: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const decisionOf = (ctx: Context, ref: string | undefined): Decision => {
  const body = ctx.artifacts.get(ref as ArtifactRef)!.body as Decision & { schema: string }
  schemas.assertRecord(body)
  return body
}
const events = (ctx: Context, runId: string) => ctx.eventLog.query({ runId, type: 'workflow.task.digest' })

describe('the engine digests a board task\'s result once it reached the board (B6)', () => {
  it('asks once the result is reported, sets the written digest on the task through the board\'s attachDigest, and the next task\'s brief points at it', async () => {
    const { ctx, workers } = await boot({ digests: quoting('answer') })
    const first = await readyTask(ctx, 'first')
    workers.reply = () => ({ text: 'the answer of the first' })
    const one = await run(ctx, first)
    // The report came first: the task is done whatever the digest does.
    expect(one.task?.outcome).toMatchObject({ status: 'accepted', state: 'done' })
    const task = await digested(ctx, one.runId)
    expect(task.digest).toMatchObject({ state: 'attached', requestId: expect.any(String), digest: expect.stringMatching(/^sha256:/) })
    const board = (await ctx.board.task(first.taskId))!
    schemas.assertRecord(board)
    expect(board.result).toMatchObject({ artifacts: [one.result], digest: (task.digest as { digest?: string }).digest })
    expect((ctx.artifacts.get(board.result!.digest!)!.body as { sources: string[] }).sources).toEqual([one.result])
    // Asked for by a recorded admission decision, and its end is an event naming the digest's own settling decision.
    const asked = decisionOf(ctx, (task.digest as { decision?: string }).decision)
    expect(asked).toMatchObject({ decisionType: 'admission', decider: { id: 'workflow.task-digest' }, outcome: { option: 'request', detail: { taskId: first.taskId, runId: one.runId, requested: 0, perHour: 6 } }, inputs: [one.result] })
    const [event] = events(ctx, one.runId)
    expect(event).toMatchObject({ data: { taskId: first.taskId, state: 'attached' } })
    expect(decisionOf(ctx, event!.decision)).toMatchObject({ decisionType: 'acceptance', decider: { id: 'digests.quote-check' }, outcome: { option: 'written' } })

    // A task that depends on it reads the digest, never the raw result.
    const second = await readyTask(ctx, 'second', { dependsOn: [first.taskId] })
    const two = await run(ctx, second, 'go on')
    expect(two.task?.outcome).toMatchObject({ status: 'accepted' })
    const brief = ctx.artifacts.get(workers.started.at(-1)!.brief!)!.body as Brief
    expect(brief.artifacts).toEqual([{ ref: board.result!.digest, role: 'input', note: `the digest of the accepted result of ${first.taskId}: first` }])
  })

  it('records why a result keeps no digest: the hourly bound reached, a digest not written, or no digest provider loaded (ADR-0036, INV-9)', async () => {
    const { ctx, workers } = await boot({ digests: (sources, tier) => (tier === 'economy' ? quoting('answer')(sources, tier) : { fail: 'never' }), workflow: { digestsPerHour: 1 } })
    workers.reply = () => ({ text: 'an answer' })
    const one = await run(ctx, await readyTask(ctx, 'one'))
    expect((await digested(ctx, one.runId)).digest?.state).toBe('attached')
    const two = await run(ctx, await readyTask(ctx, 'two'))
    const bypassed = await digested(ctx, two.runId)
    expect(bypassed.digest).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/1 digest\(s\) were requested in the last hour, the bound \(workflow.digestsPerHour 1/) })
    const decision = decisionOf(ctx, (bypassed.digest as { decision?: string }).decision)
    expect(decision).toMatchObject({ outcome: { option: 'bypass' } })
    expect(decision.candidates.every((c) => c.reasons.length > 0)).toBe(true)
    expect((await ctx.board.task(ctx.workflow.get(two.runId)!.task!.taskId))!.result!.digest).toBeUndefined()
    expect(events(ctx, two.runId)).toMatchObject([{ data: { state: 'bypassed' } }])

    // No digest provider: the same, recorded.
    const bare = await boot({ digests: false })
    bare.workers.reply = () => ({ text: 'an answer' })
    const three = await run(bare.ctx, await readyTask(bare.ctx, 'three'))
    expect((await digested(bare.ctx, three.runId)).digest).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/no digest provider is loaded/) })
  })

  it('leaves the result without a digest when none is written, naming the digest\'s settling decision', async () => {
    const { ctx, workers } = await boot({ digests: () => ({ text: 'no digest here' }) })
    workers.reply = () => ({ text: 'an answer' })
    const one = await run(ctx, await readyTask(ctx, 'one'))
    const task = await digested(ctx, one.runId)
    expect(task.digest).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/the digest was not-written: the answer holds no JSON object/) })
    expect(decisionOf(ctx, events(ctx, one.runId)[0]!.decision)).toMatchObject({ decider: { id: 'digests.quote-check' }, outcome: { option: 'not-written' } })
    expect((await ctx.board.task(task.taskId))!.result!.digest).toBeUndefined()
  })

  it('sets the digest on a review held for the operator, whose acceptance then names it', async () => {
    const { ctx, workers } = await boot({ digests: quoting('answer') })
    workers.reply = () => ({ text: 'an answer' })
    const one = await run(ctx, await readyTask(ctx, 'writes', { actionClass: 'workspace-write' }))
    expect(one.task?.outcome).toMatchObject({ status: 'review', state: 'review' })
    const task = await digested(ctx, one.runId)
    expect(task.digest?.state).toBe('attached')
    expect((await ctx.board.task(task.taskId))!).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' }, result: { artifacts: [one.result], digest: expect.stringMatching(/^sha256:/) } })
  })

  it('goes on after a restart: a request made before the engine stopped is waited for and set on the task, asked once (INV-4)', async () => {
    const { ctx, workers, held, restartWorkflow } = await boot({ digests: 'held' })
    workers.reply = () => ({ text: 'an answer' })
    const one = await run(ctx, await readyTask(ctx, 'one'))
    await until(() => ctx.workflow.get(one.runId)?.task?.digest?.state === 'requested', 'the digest request')
    await restartWorkflow()
    expect(held().requests.size).toBe(1)
    const digest = held().write([...held().requests.keys()][0]!)
    const task = await digested(ctx, one.runId)
    expect(task.digest).toMatchObject({ state: 'attached', digest })
    expect(held().requests.size).toBe(1)
    expect((await ctx.board.task(task.taskId))!.result!.digest).toBe(digest)
  })

  it('gives up on a request that does not settle within its bound, and on a digest the board no longer takes, recording why (INV-9, ADR-0036)', async () => {
    const { ctx, workers, held, restartWorkflow } = await boot({ digests: 'held' })
    workers.reply = () => ({ text: 'an answer' })
    const one = await run(ctx, await readyTask(ctx, 'one'))
    await until(() => ctx.workflow.get(one.runId)?.task?.digest?.state === 'requested', 'the digest request')
    await restartWorkflow(() => {
      const row = ctx.store.db.prepare('SELECT digest FROM workflow_tasks WHERE run_id = ?').get(one.runId) as { digest: string }
      const state = { ...JSON.parse(row.digest), requestedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }
      ctx.store.db.prepare('UPDATE workflow_tasks SET digest = ? WHERE run_id = ?').run(JSON.stringify(state), one.runId)
    })
    expect((await digested(ctx, one.runId)).digest).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/did not settle within 6 hours of asking/) })

    // The operator rejects a held review, and the next attempt starts before the digest is written: the board refuses it.
    const writes = await readyTask(ctx, 'writes', { actionClass: 'workspace-write', maxAttempts: 2 })
    const two = await run(ctx, writes)
    await until(() => ctx.workflow.get(two.runId)?.task?.digest?.state === 'requested', 'the second digest request')
    const review = (await ctx.board.task(writes.taskId))!
    const reject = ctx.artifacts.recordDecision({
      decisionType: 'acceptance', question: 'Does the operator accept it?', inputs: review.result!.artifacts,
      candidates: [{ option: 'reject', selected: true, reasons: ['not yet'] }, { option: 'accept', selected: false, reasons: ['not accept: not yet'] }],
      decider: { type: 'operator', id: 'operator.review', version: '1' }, outcome: { option: 'reject', detail: { taskId: writes.taskId, subject: review.result!.subject } }, deterministic: false,
    }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
    expect(await ctx.board.accept(writes.taskId, reject)).toMatchObject({ state: 'ready' })
    const claim = await ctx.board.claim(writes.taskId, 'lead', 60_000)
    await ctx.board.start(writes.taskId, claim.generation, { runId: 'run-next' })
    held().write((ctx.workflow.get(two.runId)!.task!.digest as { requestId: string }).requestId)
    expect((await digested(ctx, two.runId)).digest).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/the board did not take digest .* \(invalid-transition: .* has no result to digest\)/) })
  })
})
