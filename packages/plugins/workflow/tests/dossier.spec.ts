import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { type Brief, captureGitSubject, contentId, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { ArtifactRef, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { activeProject, CONFIG, importantFinding, type Rendered, readyTask, ScriptedWorkers, verifierReply } from '../conformance/workflow.ts'
import Workflow, { DOSSIER_FILE, DOSSIER_LIMITS, type DossierAppendInput, type DossierCaller, type DossierEntry, type DossierView, type NodeTemplate, renderDossier, type RunView } from '../src/index.ts'

// The task dossier (docs/design/task-dossier.md, ADR-0070), end to end over the store-backed board and
// approval queue and a git working tree; only Worker execution is scripted.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

/** `read` runs on auto; everything else (the charter, a remediation) asks. */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }], default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

const step = (nodeId: string, extra: Partial<NodeTemplate>): NodeTemplate => ({
  nodeId, objective: `Do ${nodeId}`, prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...extra,
})
/**
 * A change (a writing step: `develop`) only Workers that also prove `craft` take, and an exact-subject
 * review of it: blocking findings grow a fix (on the same capabilities) behind the approval queue, then a re-review.
 */
const TEMPLATES: Record<string, NodeTemplate[]> = {
  change: [step('develop', { prompt: 'Develop: {{input}}', capabilities: ['develop', 'craft'] }), step('review', { prompt: 'Review: {{input}}', capabilities: ['review'], dependsOn: ['develop'] })],
  solo: [step('solo', {})],
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
        kind: 'report', bodySchema: 'agent-result@1.1', classification: 'public', producer: { type: 'worker', ref: 'w:agent' },
        body: { schema: 'agent-result@1.1', worker: 'w:agent', runtime: 'scripted', runId: `agent-${id}`, promptHash: sha256(text), sandbox: 'workspace-write', text, workspace: this.workspace, subject },
      }).id as ArtifactRef)
    }
    return { ...execution, result: this.results.get(id)! }
  }
}

/** A git working tree with a commit. */
function workingTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-dossier-tree-'))
  const git = (...args: string[]): void => void execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The engine over the store-backed board and queue; with `tree`, its Workers answer as agents in that working tree. */
async function boot(tree?: string): Promise<{ ctx: Context; workers: ScriptedWorkers }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-workflow-dossier-'))
  const ctx = new Context()
  const workers = tree ? new TreeWorkers(tree, () => ctx.artifacts) : new ScriptedWorkers()
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  const engine = ctx.plugin(Workflow, { ...CONFIG, approvalPollSeconds: 1, templates: TEMPLATES })
  await engine
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx, workers }
}

const until = <T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 30_000): Promise<T> => vi.waitFor(async () => {
  const value = await read()
  if (!value) throw new Error(`timed out waiting for ${what}`)
  return value
}, { timeout: ms, interval: 25 })

const reported = (ctx: Context, runId: string): Promise<RunView> => until(() => {
  const view = ctx.workflow.get(runId)
  return view?.task?.phase === 'reported' ? view : undefined
}, `run ${runId}'s report`, 60_000)

/** The refusal a call throws, or `appended`. */
const refusal = (call: () => unknown): string => {
  try {
    call()
    return 'appended'
  } catch (error) {
    return (error as Error).message
  }
}

const briefOf = (ctx: Context, start: Rendered): Brief => ctx.artifacts.get(start.brief!)!.body as Brief
/** The dossier view a brief points at (its slice), and the one it places as a file. */
const sliceOf = (ctx: Context, brief: Brief): DossierView | undefined => brief.artifacts
  .map((p) => ctx.artifacts.get(p.ref)).find((a) => a?.bodySchema === 'task-dossier@1.0')?.body as DossierView | undefined
const fileOf = (ctx: Context, brief: Brief): DossierView | undefined => {
  const file = brief.files?.find((f) => f.path === DOSSIER_FILE)
  return file ? ctx.artifacts.get(file.ref)!.body as DossierView : undefined
}

describe('a board task\'s dossier (ADR-0070)', () => {
  it('carries the work between Workers that share no session: the author appends its plan and progress through the gated tool, the reviewer reads the dossier and never the author\'s transcript, the fix on another Worker continues from it, and the System writes the evidence; entries only append, and never change', async () => {
    const tree = workingTree()
    const { ctx, workers } = await boot(tree)
    // The author writes on w:author; the reviewer reviews; nothing else proves `craft`.
    workers.extra = [worker('w:author', { tier: 'standard', proves: ['develop', 'craft'] }), worker('w:reviewer', { tier: 'standard', proves: ['review'] })]
    let reviews = 0
    workers.reply = (request) => {
      // The second reviewer confirms the important finding (ADR-0075).
      const verified = verifierReply(request.prompt)
      if (verified) return verified
      const subject = /^Subject: (\S+)$/m.exec(request.prompt)?.[1]
      if (subject) {
        const changes = ++reviews === 1
        return { text: '```json\n' + JSON.stringify({ subject, verdict: changes ? 'changes-requested' : 'approve', findings: [changes ? importantFinding('no test covers add()', 'calc.py') : { severity: 'nit', title: 'no test covers add()', file: 'calc.py' }] }) + '\n```' }
      }
      if (request.prompt.includes('Fix the blocking findings')) {
        writeFileSync(join(tree, 'test_calc.py'), 'assert True\n')
        return { text: 'added test_calc.py' }
      }
      // The author's run is held while it works, so it appends through the tool as a running step does.
      return 'hold'
    }
    await activeProject(ctx)
    const task = await readyTask(ctx, 'make add() add')
    const run = await ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public', task: { taskId: task.taskId } })
    await until(() => ctx.workflow.get(run.runId)?.nodes.find((n) => n.nodeId === 'develop' && n.state === 'RUNNING'), 'the author\'s step running')

    // The author's Worker appends through the tool its source binds to the step it runs and its
    // execution (an agent Worker's host tool: agent-workers tests/dossier.spec.ts); here the scripted
    // source stands in for it, bound to the execution it started.
    const held = await until(() => workers.started.find((s) => s.worker === 'w:author'), 'the author\'s execution')
    const authorStep: DossierCaller = { runId: run.runId, nodeId: 'develop', execution: held.id }
    // The gate: only the step's running execution appends, only what its role writes (an author's evidence is the output of its checks, T267), bounded.
    const append = (extra: Partial<DossierAppendInput> = {}, caller: Partial<DossierCaller> = {}) => () => ctx.workflow.appendToDossier({ ...authorStep, ...caller }, { kind: 'progress', text: 'x', ...extra })
    expect(refusal(append({ kind: 'review' }))).toMatch(/a writing step appends plan, progress, response, evidence, not review; nothing was appended/)
    expect(refusal(append({ text: 'x'.repeat(DOSSIER_LIMITS.text + 1) }))).toMatch(/an entry holds 1 to 4000/)
    expect(refusal(append({}, { nodeId: 'review' }))).toMatch(/step review of run .* is not running/)
    expect(refusal(append({ commits: ['not-a-commit'] }))).toMatch(/commits are at most 16 hex ids/)
    expect(refusal(append({ refs: [`sha256:${'0'.repeat(64)}`] }))).toMatch(/is not a stored artifact/)
    // Naming the running step is not enough: one that is not its running execution writes nothing as its Worker, and reads nothing.
    expect(refusal(append({ kind: 'plan' }, { execution: 'exec-forged' }))).toMatch(/execution exec-forged is not the one step develop of run .* runs now.*; nothing was appended/)
    expect(refusal(() => ctx.workflow.readDossier({ ...authorStep, execution: 'exec-forged' }))).toMatch(/is not the one step develop .*; nothing was read/)
    expect(ctx.workflow.dossier({ taskId: task.taskId }).total).toBe(0)

    const PLAN = 'Plan: make add() return a + b in calc.py; risk: none of its callers relies on the difference.'
    const plan = ctx.workflow.appendToDossier(authorStep, { kind: 'plan', text: PLAN })
    expect(plan.seq).toBe(1)
    writeFileSync(join(tree, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    const PROGRESS = 'Changed calc.py: add() now adds. Remains: a test for add(), which I did not write.'
    expect(ctx.workflow.appendToDossier(authorStep, { kind: 'progress', text: PROGRESS }).seq).toBe(2)
    const before = ctx.workflow.dossier({ taskId: task.taskId }).entries
    // The step's Worker reads its own task's dossier with the same binding.
    expect(ctx.workflow.readDossier(authorStep).entries).toEqual(before)
    // The author's last message holds its conversation's detail: what the reviewer must never be given.
    const TRANSCRIPT = 'Transcript: I listed the tree, read calc.py, and edited it.'
    workers.release(held.id, { text: TRANSCRIPT })

    // The review asked for changes: while the fix waits on the queue, the author's Worker goes away and another takes its place.
    const waiting = await until(() => {
      const view = ctx.workflow.get(run.runId)
      return view?.blocked?.kind === 'gate' && view.blocked.approvalRequest ? view.blocked.approvalRequest : undefined
    }, 'the fix to wait on the queue')
    workers.extra = [worker('w:fixer', { tier: 'standard', proves: ['develop', 'craft'] }), worker('w:reviewer', { tier: 'standard', proves: ['review'] })]
    const request = (await ctx.approvals.get(waiting))!
    await ctx.approvals.decide([{ requestId: waiting, subject: request.subject, verdict: 'approved' }])
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.worker ?? null])).toEqual([
      ['develop', 'w:author'], ['review', 'w:reviewer'], ['review:verify', 'w:reviewer'], ['review:approve:1', null], ['review:fix:1', 'w:fixer'], ['review:review:2', 'w:reviewer'],
    ])

    // The reviewer read the dossier (the author's plan and progress), never its transcript: no session
    // to resume, no pointer at the author's result or brief, and no word of its last message.
    const reviewer = workers.started.find((s) => s.worker === 'w:reviewer')!
    const author = done.nodes.find((n) => n.nodeId === 'develop')!
    const reviewBrief = briefOf(ctx, reviewer)
    expect(reviewBrief.resume).toBeUndefined()
    const authorResult = ctx.workflow.records(run.runId).find((r) => r.nodeId === 'develop')!.outputReceipt!.result
    expect(reviewBrief.artifacts.map((p) => p.ref)).not.toContain(authorResult)
    expect(reviewBrief.artifacts.map((p) => p.ref)).not.toContain(author.brief)
    expect(reviewer.prompt).toContain(PLAN)
    expect(reviewer.prompt).toContain(PROGRESS)
    expect(reviewer.prompt).not.toContain(TRANSCRIPT)
    expect(reviewer.prompt).not.toContain('Develop: Fix add()')
    expect(sliceOf(ctx, reviewBrief)!.text).not.toContain(TRANSCRIPT)

    // The fix ran on another Worker, in a conversation of its own, and continued from the dossier: the
    // author's plan and progress, and the review's findings bound to the subject it reviewed.
    const fixer = workers.started.find((s) => s.worker === 'w:fixer')!
    const fixBrief = briefOf(ctx, fixer)
    expect(fixBrief.resume).toBeUndefined()
    expect(fixer.prompt).toContain(PLAN)
    expect(fixer.prompt).toContain(PROGRESS)
    expect(fixer.prompt).toContain('changes-requested, 1 finding (1 blocking)')
    expect(fixer.prompt).not.toContain(TRANSCRIPT)
    const slice = sliceOf(ctx, fixBrief)!
    schemas.assertRecord(slice)
    expect([...slice.text].length).toBeLessThanOrEqual(DOSSIER_LIMITS.sliceChars)
    expect(slice).toMatchObject({ taskId: task.taskId, entries: 4, maxChars: DOSSIER_LIMITS.sliceChars })
    // The whole dossier is in the run's workspace too, for a source that places files, with the board's TASKS.md.
    expect(fileOf(ctx, fixBrief)!.text).toContain(PLAN)

    // The result's landing reaches its outcome after the report (this runtime lands nothing): its end is evidence too.
    const moving = ['watch', 'commit', 'rebase', 'resolving', 'returning', 'recheck', 'committed', 'asked', 'merging']
    await until(() => (moving.includes(ctx.workflow.landing(run.runId)?.state ?? 'none') ? undefined : true), 'the landing\'s outcome')
    const landed = ctx.workflow.landing(run.runId)

    // The dossier, read on demand: the author's two entries, then the review, its verification, the
    // fix's response, the re-review, and the System's evidence (acceptance, the report to the board,
    // the landing's outcome).
    const page = ctx.workflow.dossier({ runId: run.runId })
    expect(page.entries.map((e) => [e.seq, e.kind, e.author.type, e.author.ref])).toEqual([
      [1, 'plan', 'worker', 'w:author'], [2, 'progress', 'worker', 'w:author'], [3, 'review', 'worker', 'w:reviewer'], [4, 'review', 'worker', 'w:reviewer'],
      // The approving re-review's nit is told the author once, before the review's own entry (ADR-0075).
      [5, 'response', 'worker', 'w:fixer'], [6, 'evidence', 'system', 'workflow'], [7, 'review', 'worker', 'w:reviewer'], [8, 'evidence', 'system', 'workflow'], [9, 'evidence', 'system', 'workflow'],
      ...(landed ? [[10, 'evidence', 'system', 'workflow']] : []),
    ])
    if (landed) expect(page.entries[9]!.text).toMatch(new RegExp(`^Landing of run ${run.runId}'s accepted result: ${landed.state}`))
    const [, , review, verification, response, , , acceptance, report] = page.entries
    // The verification's entry gives the vote on the review's finding, its count first (ADR-0075).
    expect(verification!.text).toMatch(/^1 important \(1 confirmed, 0 not\); 1 confirmed important finding blocks/)
    expect(verification!.text).toContain('f1 important: no test covers add() (calc.py:1)')
    expect(verification!.text).toContain('— confirm: scripted confirm')
    // The review is bound to the exact subject it reviewed; its result and assessment are linked, not copied.
    const reviewResult = ctx.workflow.records(run.runId).find((r) => r.nodeId === 'review')!.outputReceipt!.result
    expect(review!.subject).toMatchObject({ type: 'git-head' })
    expect(review!.refs).toContain(reviewResult)
    expect(review!.text).not.toContain('```json')
    // The fix's agent answer is linked, never copied.
    expect(response!.text).toMatch(/answered the review that grew it on w:fixer/)
    expect(response!.text).not.toContain('added test_calc.py')
    expect(acceptance!.text).toMatch(/^Acceptance of attempt 1 \(run .*\): accept/)
    expect(acceptance!.refs).toContain(done.task!.outcome!.decision)
    expect(report!.text).toMatch(/^Reported to the board: run .* accepted, task done/)

    // Append only: each entry names the one before it, by its content id, and none changed since it was read.
    const entries = page.entries.map((e) => ctx.artifacts.get(e.id)!)
    entries.forEach((envelope, i) => {
      const body = envelope.body as DossierEntry
      schemas.assertRecord(body)
      expect(body.seq).toBe(i + 1)
      expect(body.prev).toBe(i ? entries[i - 1]!.id : undefined)
      expect(envelope.id).toBe(contentId({ kind: envelope.kind, bodySchema: envelope.bodySchema, body: envelope.body, blob: undefined, inputs: envelope.inputs, lineage: envelope.lineage, subject: envelope.subject }))
    })
    expect(page.entries.slice(0, 2)).toEqual(before)
    expect(() => ctx.store.db.prepare('UPDATE workflow_dossiers SET kind = ? WHERE task_id = ? AND seq = 1').run('evidence', task.taskId)).toThrow(/never changes/)
    expect(ctx.workflow.dossier({ taskId: task.taskId }).entries).toEqual(page.entries)
    // A step that settled appends no more: the gate refuses a step that is not running.
    expect(refusal(append({}))).toMatch(/is not running/)
    // Paged: at most `limit`, and where the next page starts.
    expect(ctx.workflow.dossier({ taskId: task.taskId, from: 3, limit: 2 })).toMatchObject({ total: page.total, next: 5, entries: [{ seq: 3 }, { seq: 4 }] })
    expect(readFileSync(join(tree, 'calc.py'), 'utf8')).toContain('a + b')
  })

  it('binds a reviewer\'s own entry to the subject its step reviews, and still writes the review\'s assessed entry, its result and assessment linked', async () => {
    const tree = workingTree()
    const { ctx, workers } = await boot(tree)
    workers.extra = [worker('w:author', { tier: 'standard', proves: ['develop', 'craft'] }), worker('w:reviewer', { tier: 'standard', proves: ['review'] })]
    workers.reply = (request) => {
      if (/^Subject: (\S+)$/m.test(request.prompt)) return 'hold'
      writeFileSync(join(tree, 'calc.py'), 'def add(a, b):\n    return a + b\n')
      return { text: 'changed calc.py' }
    }
    await activeProject(ctx)
    const task = await readyTask(ctx, 'make add() add')
    const run = await ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public', task: { taskId: task.taskId } })
    const held = await until(() => workers.started.find((s) => s.worker === 'w:reviewer'), 'the reviewer\'s execution')
    await until(() => ctx.workflow.get(run.runId)?.nodes.find((n) => n.nodeId === 'review' && n.state === 'RUNNING'), 'the review step running')
    const subject = /^Subject: (\S+)$/m.exec(held.prompt)![1]!
    const reviewStep: DossierCaller = { runId: run.runId, nodeId: 'review', execution: held.id }
    const OWN = 'Read calc.py: add() now adds; no test covers it, which is not blocking.'
    ctx.workflow.appendToDossier(reviewStep, { kind: 'review', text: OWN })
    workers.release(held.id, { text: '```json\n' + JSON.stringify({ subject, verdict: 'approve', findings: [{ severity: 'info', title: 'no test covers add()', file: 'calc.py' }] }) + '\n```' })
    expect((await reported(ctx, run.runId)).status).toBe('completed')

    const page = ctx.workflow.dossier({ taskId: task.taskId })
    const reviews = page.entries.filter((e) => e.kind === 'review')
    expect(reviews.map((e) => e.author.ref)).toEqual(['w:reviewer', 'w:reviewer'])
    const [own, assessed] = reviews as [typeof reviews[0], typeof reviews[0]]
    // The reviewer's own entry: its text as written, bound to the subject the step reviews (never one it names).
    expect(own.text).toBe(OWN)
    expect(own.subject).toMatchObject({ type: 'git-head' })
    // The engine's entry: the verdict and findings from the stored assessment, bound to the same subject, the result linked.
    const reviewResult = ctx.workflow.records(run.runId).find((r) => r.nodeId === 'review')!.outputReceipt!.result
    expect(assessed.seq).toBeGreaterThan(own.seq)
    expect(assessed.text).toMatch(/: approve, 1 finding\. Its result and assessment are linked\. The reviewer's own entry precedes this one\./)
    expect(assessed.subject).toEqual(own.subject)
    expect(assessed.refs).toContain(reviewResult)
    expect(assessed.refs!.length).toBe(3)
  })

  it('appends a website Worker\'s answer as its step\'s entry, and gives the next attempt the dossier of the one before', async () => {
    const { ctx, workers } = await boot()
    workers.reply = () => ({ fail: 'internal', disposition: 'CODE_FIX', sent: true })
    await activeProject(ctx)
    const task = await readyTask(ctx, 'answer')
    // Attempt 1 fails: its step settled no result, and the report of its failure is the System's evidence.
    const first = await ctx.workflow.start({ template: 'solo', input: 'Say hello', classification: 'public', task: { taskId: task.taskId } })
    expect((await reported(ctx, first.runId)).task?.outcome).toMatchObject({ status: 'reconciled', state: 'ready' })
    const ANSWER = 'Hello: the answer of a website Worker, which has no tool of its own.'
    workers.reply = () => ({ text: ANSWER })
    const second = await ctx.workflow.start({ template: 'solo', input: 'Say hello', classification: 'public', task: { taskId: task.taskId } })
    expect((await reported(ctx, second.runId)).status).toBe('completed')
    const page = ctx.workflow.dossier({ taskId: task.taskId })
    expect(page.entries.map((e) => [e.attempt, e.kind, e.author.type])).toEqual([[1, 'evidence', 'system'], [2, 'progress', 'worker'], [2, 'evidence', 'system'], [2, 'evidence', 'system']])
    // The website Worker's answer is the entry, as it is.
    expect(page.entries[1]!.text).toBe(ANSWER)
    // Attempt 2's step was given attempt 1's dossier: the report of its failure.
    const brief = briefOf(ctx, workers.started.at(-1)!)
    expect(sliceOf(ctx, brief)!.text).toMatch(/#1 · attempt 1 · evidence · System/)
    expect(workers.started.at(-1)!.prompt).toContain('Reported to the board: run ')
  })

  it('keeps every slice within its bound: the latest entries that fit, newest last, a summary of the rest, and where to read them', () => {
    const at = (seq: number): ArtifactRef => `sha256:${seq.toString(16).padStart(64, '0')}` as ArtifactRef
    const kinds = ['plan', 'progress', 'review', 'response', 'evidence'] as const
    const body = (seq: number): DossierEntry => ({
      schema: 'task-dossier-entry@1.0', projectId: 'p1', taskId: 't1', seq, ...(seq > 1 ? { prev: at(seq - 1) } : {}), attempt: 1 + Math.floor(seq / 10), kind: kinds[seq % 5]!,
      author: seq % 5 === 4 ? { type: 'system', ref: 'workflow' } : { type: 'worker', ref: 'w:author', nodeId: 'develop' },
      text: `entry ${seq}: ${'é𝄞x'.repeat(1333)}`, refs: [at(1000 + seq)],
    })
    for (const total of [1, 3, 30, 300]) {
      for (const maxChars of [1000, DOSSIER_LIMITS.sliceChars, 20_000]) {
        const latest = Array.from({ length: total }, (_, i) => total - i).map((seq) => ({ seq, ref: at(seq), body: body(seq) }))
        const { text, shown } = renderDossier({ projectId: 'p1', taskId: 't1', total, kinds: { plan: total } }, latest, maxChars)
        expect([...text].length, `${total} entries within ${maxChars}`).toBeLessThanOrEqual(maxChars)
        // At least the latest is shown, in part; what is shown is the latest, newest last.
        expect(shown.at(-1)).toBe(at(total))
        expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => at(total - shown.length + 1 + i)))
        expect(text).toContain(`#${total} · `)
        if (shown.length < total) expect(text).toContain(`Entries 1 to ${total - shown.length} are not shown here`)
        else expect(text).toContain('Every entry is shown.')
      }
    }
  })
})
