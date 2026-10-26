/**
 * One task, one author session (board T232; operator 2026-10-26). A review's fix was routed like any
 * step and often ran on another account's Worker in a fresh context (T207, T213, T216), which re-read
 * everything and lost the author's reasoning. Now a fix continues the writing step's own session on its
 * Worker, the review's findings its next message; the reviewer stays independent, in a session of its
 * own; an author's Worker that cannot take the fix is waited on within a bound, or the session is
 * handed off, recorded; and each fix's result is its own commit of the run's review history, the
 * worktree's HEAD never moved.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { type Brief, captureGitSubject, sha256, startPrompt } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { type ArtifactRef, type CapabilityDescriptor, type Landed, type LandStep, reviewRef, type WorkerExecution, type WorkerStart } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { importantFinding, verifierReply } from '../conformance/workflow.ts'
import Workflow, { type NodeTemplate, type RunView } from '../src/index.ts'

vi.setConfig({ testTimeout: 120_000 })

const AUTHOR = worker('w:author', { schema: 'capability-descriptor@1.3', family: 'family-a', proves: ['develop', 'persistent-conversation'] })
const OTHER = worker('w:other', { schema: 'capability-descriptor@1.3', family: 'family-b', proves: ['develop', 'persistent-conversation'] })
const REVIEWER = worker('w:reviewer', { schema: 'capability-descriptor@1.3', family: 'family-c', proves: ['review'] })

/** As algorithm-development: the change is written in the run's session, then reviewed in a temporary one. */
const TEMPLATES: Record<string, NodeTemplate[]> = {
  change: [
    { nodeId: 'develop:1', objective: 'Change add()', prompt: 'Develop: {{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'persistent', acceptance: 'acceptance.answer' },
    { nodeId: 'review:1', objective: 'Review the change', prompt: 'Review: {{input}}', dependsOn: ['develop:1'], capabilities: ['review'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' },
  ],
}

/** As algorithm-development since T267: the author's own review, on the author's account, before anything else. */
const SELF: Record<string, NodeTemplate[]> = {
  selfcheck: [
    { nodeId: 'develop:1', objective: 'Change add()', prompt: 'Develop: {{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'persistent', acceptance: 'acceptance.answer' },
    { nodeId: 'selfreview:1', objective: 'Review your own change', prompt: 'Self-review: {{input}}', dependsOn: ['develop:1'], capabilities: ['review'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', selfReview: 'develop:1' },
  ],
}

/** One start as the scripted runtime saw it: the prompt it read, the session's turns before it, and the conversation it resumed. */
type Seen = WorkerStart & { prompt: string; before: string[]; resumed?: string }

/**
 * A scripted agent runtime over one git working tree. A session stays on the Worker its first start
 * chose and keeps a native conversation (its transcript): a start that resumes it reads its earlier
 * turns. Its `land` commits the tree, only while it is exactly the subject asked, as an agent source's does.
 */
class AuthorWorkers {
  readonly seen: Seen[] = []
  readonly sessions = new Map<string, { worker: string; handle: string; turns: string[] }>()
  workers: CapabilityDescriptor[] = [AUTHOR, REVIEWER]
  reviews = 0
  private readonly executions = new Map<string, WorkerExecution>()

  constructor(readonly tree: string, private readonly ctx: () => Context) {}

  source() {
    return {
      name: 'authors',
      describe: async () => this.workers,
      start: (request: WorkerStart) => this.start(request),
      get: (id: string) => this.executions.get(id),
      wait: async (id: string) => this.executions.get(id)!,
      affinity: (sessionId: string) => {
        const session = this.sessions.get(sessionId)
        return session ? [session.worker] : undefined
      },
      handle: (sessionId: string) => this.sessions.get(sessionId)?.handle,
      land: async (step: LandStep): Promise<Landed | undefined> => this.land(step),
    }
  }

  private start(request: WorkerStart): WorkerExecution {
    const ctx = this.ctx()
    const prompt = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
    const brief = ctx.artifacts.get(request.brief!)!.body as Brief
    let session = request.sessionId ? this.sessions.get(request.sessionId) : undefined
    // A resume reads the conversation's earlier turns; anything else starts a new one.
    const resumed = brief.resume && session?.handle === brief.resume.nativeHandle ? session : undefined
    if (request.sessionId && !resumed) {
      session = { worker: session?.worker ?? request.worker, handle: `native-${request.sessionId}-${this.seen.length + 1}`, turns: [] }
      this.sessions.set(request.sessionId, session)
    }
    const before = session ? [...session.turns] : []
    session?.turns.push(prompt)
    this.seen.push({ ...request, prompt, before, ...(resumed ? { resumed: brief.resume!.nativeHandle } : {}) })
    const text = this.answer(prompt, before)
    const { subject } = captureGitSubject(this.tree)!
    const result = ctx.artifacts.put({
      kind: 'report', bodySchema: 'agent-result@1.1', classification: 'public', producer: { type: 'worker', ref: request.worker },
      body: { schema: 'agent-result@1.1', worker: request.worker, runtime: 'scripted', runId: `agent-${this.seen.length}`, promptHash: sha256(text), sandbox: 'workspace-write', text, workspace: this.tree, subject },
    }).id as ArtifactRef
    const execution: WorkerExecution = { id: `x-${this.seen.length}`, status: 'completed', submitted: true, result, decisions: [] }
    this.executions.set(execution.id, execution)
    return execution
  }

  /** The developer changes add(); the reviewer asks for a test once, then approves; a fix adds the test, saying whether it remembers its change. */
  private answer(prompt: string, before: string[]): string {
    // A second reviewer confirms the important finding (ADR-0075), in a session of its own.
    const verified = verifierReply(prompt)
    if (verified) return verified.text
    const subject = /^Subject: (\S+)$/m.exec(prompt)?.[1]
    if (subject) {
      const changes = ++this.reviews === 1
      return '```json\n' + JSON.stringify({ subject, verdict: changes ? 'changes-requested' : 'approve', findings: changes ? [importantFinding('no test for add()', 'calc.py')] : [] }) + '\n```'
    }
    if (prompt.includes('Fix the blocking findings')) {
      writeFileSync(join(this.tree, 'test_calc.py'), 'from calc import add\nassert add(1, 2) == 3\n')
      return before.some((turn) => turn.startsWith('Develop: ')) ? 'added a test, on top of the add() I changed' : 'added a test'
    }
    writeFileSync(join(this.tree, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    return 'changed add()'
  }

  /** A `record`, as the worktree source makes it: the tree as a commit on the run's history ref, from an index of its own, HEAD untouched. */
  private land(step: LandStep): Landed | undefined {
    if (step.step !== 'record' || step.workspace !== this.tree) return undefined
    const now = captureGitSubject(this.tree)!.subject
    if (now.ref !== step.subject.ref || now.version !== step.subject.version) return { outcome: 'refused', cause: 'moved', reason: `the tree is not ${step.subject.ref}` }
    const ref = reviewRef(step.runId)
    const index = { GIT_INDEX_FILE: join(this.tree, '..', 'record-index') }
    git(this.tree, 'read-tree', 'HEAD', { env: index })
    git(this.tree, 'add', '--all', { env: index })
    const tree = git(this.tree, 'write-tree', { env: index }).trim()
    rmSync(index.GIT_INDEX_FILE, { force: true })
    let parent: string
    try {
      parent = git(this.tree, 'rev-parse', '--verify', '--quiet', ref).trim()
    } catch {
      parent = now.ref
    }
    if (git(this.tree, 'rev-parse', `${parent}^{tree}`).trim() === tree) return { outcome: 'recorded', repository: this.tree, ref, commit: parent, parent, recorded: false }
    const commit = git(this.tree, 'commit-tree', tree, '-p', parent, '-m', step.message).trim()
    git(this.tree, 'update-ref', ref, commit)
    return { outcome: 'recorded', repository: this.tree, ref, commit, parent, recorded: true }
  }
}

/** `git -C dir …`; a last argument `{ env }` adds to its environment. */
const git = (dir: string, ...args: Array<string | { env: Record<string, string> }>): string => {
  const last = args.at(-1)
  const env = typeof last === 'object' ? last.env : {}
  const words = args.filter((a): a is string => typeof a === 'string')
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...words], { encoding: 'utf8', env: { ...process.env, ...env } })
}

async function boot(config: { fixSessionWaitMinutes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-fix-sessions-'))
  const tree = join(dir, 'tree')
  execFileSync('git', ['init', '-q', '-b', 'main', tree])
  writeFileSync(join(tree, 'calc.py'), 'def add(a, b):\n    return a - b\n')
  git(tree, 'add', '.')
  git(tree, 'commit', '-q', '-m', 'init')
  const ctx = new Context()
  const workers = new AuthorWorkers(tree, () => ctx)
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'author-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source()) }),
    ctx.plugin(Workflow, { retryDelayMs: 100, templates: { ...TEMPLATES, ...SELF }, ...config }),
  ]
  await Promise.all(fibers)
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return { ctx, workers, tree }
}

const until = <T>(read: () => T | undefined, what: string, ms = 30_000): Promise<T> => vi.waitFor(() => {
  const value = read()
  if (!value) throw new Error(`timed out waiting for ${what}`)
  return value
}, { timeout: ms, interval: 25 })

/** Start the change, and approve its fix's plan once the run waits on it; `meanwhile` runs before the approval. */
async function runToFix(ctx: Context, meanwhile: () => void = () => {}): Promise<string> {
  const { runId } = ctx.workflow.start({ template: 'change', input: 'Fix add()', classification: 'public' })
  const blocked = await until(() => {
    const view = ctx.workflow.get(runId)
    return view?.blocked?.kind === 'gate' ? view.blocked as { plan: string } : undefined
  }, 'the fix\'s gate')
  meanwhile()
  ctx.workflow.approve(runId, { verdict: 'approved', plan: blocked.plan })
  return runId
}

const finished = (ctx: Context, runId: string): Promise<RunView> => until(() => {
  const view = ctx.workflow.get(runId)
  return view && view.status !== 'running' ? view : undefined
}, `run ${runId} to finish`, 60_000)

type Decision = { decider: { id: string }; outcome: { option: string; detail?: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const decisions = (ctx: Context, runId: string, rule: string): Decision[] =>
  ctx.artifacts.list({ kind: 'decision', runId, limit: 1000 }).map((a) => a.body as Decision).filter((d) => d.decider.id === rule)

describe('one task, one author session (board T232)', () => {
  it('continues the author\'s session on its Worker for the fix, which sees its earlier turns; the reviewer never runs in it; each fix is its own commit, and the re-review reads only the change since the last review, with the open finding', async () => {
    const { ctx, workers, tree } = await boot()
    const runId = await runToFix(ctx)
    const done = await finished(ctx, runId)
    expect(done.status).toBe('completed')
    // The review's important finding is verified before it grows the fix (ADR-0075).
    const [develop, review, verify, fix, recheck] = workers.seen
    expect(workers.seen).toHaveLength(5)
    expect(verify!.prompt).toContain('## Verify these findings')
    expect(develop).toMatchObject({ worker: 'w:author', sessionId: expect.any(String) })
    // The fix is the author session's next message, on its Worker, resuming its native conversation.
    expect(fix).toMatchObject({ worker: 'w:author', sessionId: develop!.sessionId, resumed: workers.sessions.get(develop!.sessionId!)!.handle })
    expect(fix!.before).toEqual([develop!.prompt])
    expect(fix!.prompt).toContain('reviewed the change you made earlier in this conversation')
    expect(fix!.prompt).toContain(`Reviewed subject: ${/^Subject: (\S+)$/m.exec(review!.prompt)![1]}`)
    expect(fix!.prompt).toContain('- no test for add() (calc.py:1)')
    expect(fix!.prompt).toContain('What to change:')
    expect(ctx.workflow.records(runId).find((r) => r.nodeId === 'review:1:fix:1')!.outputReceipt).toBeDefined()
    expect((ctx.artifacts.get(ctx.workflow.records(runId).find((r) => r.nodeId === 'review:1:fix:1')!.outputReceipt!.result)!.body as { text: string }).text).toBe('added a test, on top of the add() I changed')
    const [path] = decisions(ctx, runId, 'workflow.fix-session')
    expect(path).toMatchObject({ outcome: { option: 'continue', detail: { sessionId: develop!.sessionId, author: 'develop:1', worker: 'w:author' } } })
    // The reviewer is independent: each review runs in no session, never the author's, and resumes nothing.
    for (const reviewer of [review!, verify!, recheck!]) {
      expect(reviewer).toMatchObject({ worker: 'w:reviewer', sessionId: undefined })
      expect(reviewer.resumed).toBeUndefined()
      expect((ctx.artifacts.get(reviewer.brief!)!.body as Brief).resume).toBeUndefined()
    }
    // History: the change the review read, then the fix, each its own commit on the run's review
    // history ref; the worktree's HEAD never moved, so a task bound to it still binds the result.
    const base = git(tree, 'rev-parse', 'main').trim()
    expect(git(tree, 'log', '--format=%s', '-1', 'main').trim()).toBe('init')
    const history = reviewRef(runId)
    expect(git(tree, 'log', '--format=%s', '-3', history).trim().split('\n')).toEqual([
      `system: review:1:fix:1 of run ${runId}, the fix of review review:1's blocking findings`,
      expect.stringMatching(/^system: the change review review:1 of run \S+ read \(git:/),
      'init',
    ])
    expect(git(tree, 'show', '--name-only', '--format=', history).trim()).toBe('test_calc.py')
    expect(git(tree, 'show', '--name-only', '--format=', `${history}~1`).trim()).toBe('calc.py')
    expect(git(tree, 'rev-parse', `${history}~2`).trim()).toBe(base)
    expect(captureGitSubject(tree)!.subject.ref).toBe(base)
    const commits = decisions(ctx, runId, 'workflow.fix-commit')
    expect(commits.map((d) => [d.outcome.option, d.outcome.detail!.what])).toEqual([['commit', 'reviewed'], ['commit', 'fixed']])
    // The re-review reads only what changed since the subject the last review read (T266), with the
    // open finding to check: the rest of the change was reviewed already, and is not shown again.
    const reviewedAt = git(tree, 'rev-parse', `${history}~1`).trim()
    expect(recheck!.prompt).toContain('This is review cycle 2. The last review (review:1) read subject')
    expect(recheck!.prompt).toContain('Review only what changed since then')
    const since = recheck!.prompt.split(`(relative to commit ${reviewedAt}, which holds it), verbatim:`)[1]!
    expect(since).toContain('test_calc.py')
    expect(recheck!.prompt).not.toContain('return a + b')
    expect(recheck!.prompt).not.toContain(`The whole change relative to commit ${base}`)
    expect(recheck!.prompt).toContain('- review:1#f1 important: no test for add() (calc.py:1)')
  })

  it('waits for the author\'s Worker while it cannot take the fix, recorded, then hands the session off past the bound, recorded, rather than starting fresh in silence', async () => {
    const { ctx, workers } = await boot({ fixSessionWaitMinutes: 0.03 })
    const runId = await runToFix(ctx, () => {
      // The author's account runs out of quota after the review, and another writer is there.
      workers.workers = [{ ...AUTHOR, state: 'quota-exhausted' }, OTHER, REVIEWER]
    })
    const done = await finished(ctx, runId)
    expect(done.status).toBe('completed')
    const develop = workers.seen[0]!
    const [wait] = decisions(ctx, runId, 'workflow.fix-session')
    expect(wait).toMatchObject({ outcome: { option: 'wait', detail: { sessionId: develop.sessionId, author: 'develop:1', fixSessionWaitMinutes: 0.03 } } })
    // Past the bound, handed off through the session move (T230), carrying the author's turn.
    const developResult = ctx.workflow.records(runId).find((r) => r.nodeId === 'develop:1')!.outputReceipt!.result
    const [move] = decisions(ctx, runId, 'workflow.session-move')
    expect(move).toMatchObject({ outcome: { option: 'handoff', detail: { sessionId: develop.sessionId, from: ['w:author'], worker: 'w:other', carried: [developResult] } } })
    expect(move!.candidates.find((c) => c.option === 'stay')!.reasons[0]).toMatch(/its bounded wait for them ended$/)
    const fix = workers.seen.find((s) => s.prompt.includes('Fix the blocking findings'))!
    expect(fix).toMatchObject({ worker: 'w:other', sessionId: undefined })
    expect(fix.prompt).toContain('changed add()')
    // Nothing was sent while it waited: one fix in all.
    expect(workers.seen.filter((s) => s.prompt.includes('Fix the blocking findings'))).toHaveLength(1)
  })

  it('waits for the author\'s account while it cannot take the self-review, recorded, spending no attempt, then runs it there (T267 hotfix, 2026-10-26)', async () => {
    const { ctx, workers } = await boot({ fixSessionWaitMinutes: 0.05 })
    // The author's account reviews too (its read-only role); it is out of quota for a moment once the change is written.
    const author = { ...AUTHOR, capabilities: [...AUTHOR.capabilities, ...REVIEWER.capabilities] }
    workers.workers = [author, REVIEWER]
    const scripted = workers as unknown as { answer: (prompt: string, before: string[]) => string }
    const answer = scripted.answer.bind(workers)
    scripted.answer = (prompt, before) => {
      if (prompt.startsWith('Develop: ')) {
        workers.workers = [{ ...author, state: 'quota-exhausted' }, REVIEWER]
        setTimeout(() => { workers.workers = [author, REVIEWER] }, 1000)
      }
      return answer(prompt, before)
    }
    const { runId } = ctx.workflow.start({ template: 'selfcheck', input: 'Fix add()', classification: 'public' })
    const done = await finished(ctx, runId)
    expect(done.status).toBe('completed')
    const [wait] = decisions(ctx, runId, 'workflow.self-review-wait')
    expect(wait).toMatchObject({ outcome: { option: 'wait', detail: { selfReviewOf: 'develop:1', fixSessionWaitMinutes: 0.05 } } })
    const self = done.nodes.find((n) => n.nodeId === 'selfreview:1')!
    expect(self).toMatchObject({ state: 'COMPLETED', worker: 'w:author', attempt: 1 })
  })

  it('hands a lost author session off, recorded, its brief carrying the session\'s earlier turns', async () => {
    const { ctx, workers } = await boot()
    const runId = await runToFix(ctx, () => workers.sessions.clear())
    const done = await finished(ctx, runId)
    expect(done.status).toBe('completed')
    const develop = workers.seen[0]!
    const developResult = ctx.workflow.records(runId).find((r) => r.nodeId === 'develop:1')!.outputReceipt!.result
    const [handoff] = decisions(ctx, runId, 'workflow.fix-session')
    expect(handoff).toMatchObject({ outcome: { option: 'handoff', detail: { sessionId: develop.sessionId, author: 'develop:1', carried: [developResult] } } })
    expect(handoff!.outcome.detail!.lost).toBe(`no Worker keeps session ${develop.sessionId} now`)
    const fix = workers.seen.find((s) => s.prompt.includes('Fix the blocking findings'))!
    // A new conversation of the same session, handed what the lost one held.
    expect(fix).toMatchObject({ sessionId: develop.sessionId })
    expect(fix.resumed).toBeUndefined()
    expect(fix.prompt).toContain('changed add()')
  })
})
