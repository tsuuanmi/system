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
import { type Brief, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { Carried, CarryStep, ExecutionInfrastructure, LandStep } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { activeProject, CONFIG, readyTask, type Rendered, type Reply, ScriptedWorkers } from '../conformance/workflow.ts'
import Workflow, { type NodeTemplate, type RunView, type TaskCarry } from '../src/index.ts'

// The engine's side of starting a board task's next attempt from its previous attempt's work
// (ADR-0061) over the store-backed board and approval queue; the source that holds the trees is
// scripted, so each answer to a carry is the test's.
vi.setConfig({ testTimeout: 60_000 })

const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  // A workspace write runs with lint required at acceptance (checks.spec's studio policy), so acceptance can send an attempt back.
  rules: [{ actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['lint'] }, { actionClass: 'merge', mode: 'ask' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/** A writing step, then a step after it whose Worker may fail: T110a's develop and review, in miniature. */
const RELAY: NodeTemplate[] = [
  { nodeId: 'develop:1', objective: 'Change the tree', prompt: '{{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' },
  { nodeId: 'check:1', objective: 'Check the change', prompt: 'Check the change', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', dependsOn: ['develop:1'] },
]

/**
 * A source that holds no Worker and carries as its script says; every step it is asked is kept. It
 * keeps an ended attempt's tree (the landing's `commit` step) only when `keeps`, else holds none; and
 * it runs a run's required checks, its lint as `lint` says.
 */
class Carrier {
  readonly steps: CarryStep[] = []
  /** The `commit` steps it was asked, to keep an ended attempt's tree. */
  readonly kept: LandStep[] = []
  keeps = false
  lint: 'passed' | 'failed' = 'passed'
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
      land: async (step) => {
        if (step.step !== 'commit' || !this.keeps) return undefined
        this.kept.push(step)
        return { outcome: 'committed', repository: '/repo', branch: `system/run/${step.runId}`, head: 'e'.repeat(40), committed: true, base: { branch: 'main', sha: step.subject.ref }, contained: false, stat: '' }
      },
      check: async (step) => {
        const results = step.checks.map((check) => ({ check, outcome: this.lint, exitCode: this.lint === 'passed' ? 0 : 1, reason: `exited ${this.lint === 'passed' ? 0 : 1}` }))
        const evidence = ctx.artifacts.put({
          kind: 'evidence', bodySchema: 'check-run@1.0', classification: step.classification, producer: { type: 'system', ref: 'carrier' }, runId: step.runId,
          body: { schema: 'check-run@1.0', runId: step.runId, repository: step.workspace, workspace: step.workspace, subject: { type: 'git-head', ...step.subject }, setup: sha256('setup'), checks: results },
        }).id
        return { outcome: 'checked', results, evidence }
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
  /** The engine stops (as at the host's stop) and starts again on the same store. */
  const restart = async (): Promise<void> => {
    await fibers.pop()!.dispose()
    fibers.push(ctx.plugin(Workflow, { ...CONFIG, templates: { relay: RELAY } }))
    await fibers.at(-1)
  }
  return { ctx, workers, carrier, head: git('rev-parse', 'HEAD'), restart }
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
    expect(step!.message).toMatch(new RegExp(`^system: carry the work of attempt 1 of task ${task.taskId} into run ${second.runId}\\n\\nStep develop:1 of run ${first.runId} made this change, and the attempt ended without being accepted`))
    expect(step!.message).toMatch(new RegExp(`System-Task: ${task.taskId}\\nSystem-Run: ${first.runId}$`))
    const carry = carryOf(b.ctx, second.runId)!
    expect(carry).toMatchObject({ state: 'carried', commit: 'c'.repeat(40), branch: `system/run/${first.runId}`, worktree: `/worktrees/${second.runId}`, repository: '/repo' })
    expect(carry.decisions.map((d) => [decisionOf(b.ctx, d).decisionType, decisionOf(b.ctx, d).outcome.option])).toEqual([['admission', 'carry'], ['gate', 'carry']])
    expect(decisionOf(b.ctx, carry.decisions[1]!).outcome.detail).toMatchObject({ source: 'carrier', from: first.runId, commit: 'c'.repeat(40), carried: true })
    // Every brief of the run points at the carry first, with what the worktree holds.
    const briefs = b.workers.started.slice(startedBefore).map((s) => b.ctx.artifacts.get(s.brief!)!.body as Brief)
    expect(briefs).toHaveLength(2)
    for (const brief of briefs) {
      expect(brief.artifacts[0]).toEqual({ ref: carry.decisions[1], role: 'prior', note: `This run's worktree already holds the change step develop:1 of attempt 1 made (committed as ${'c'.repeat(40)} on system/run/${first.runId}, on top of ${b.head}): build on it, do not make it again. The dossier says why it ended` })
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

  it('carries nothing for a task that writes no subject, and asks no source (REQ-WF-14, INV-2, INV-15)', async () => {
    const b = await boot()
    const unbound = await failedOnce(b, 'unbound', BROKEN, {})
    const afterUnbound = await attempt(b.ctx, unbound.task)
    const carry = carryOf(b.ctx, afterUnbound.runId)!
    expect(carry).toMatchObject({ state: 'fresh', reason: `task ${unbound.task.taskId} names no subject it writes, so no earlier tree is held as its own (INV-15)` })
    expect(carry.decisions.map((d) => decisionOf(b.ctx, d))).toEqual([expect.objectContaining({ decisionType: 'admission', decider: expect.objectContaining({ id: 'workflow.task-worktree' }), outcome: expect.objectContaining({ option: 'fresh' }) })])
    expect(b.carrier.steps).toEqual([])
  })

  it('carries the change of an attempt that ended for a reason about the change too, not only a later step\'s failure (T271)', async () => {
    const b = await boot()
    const denied = await failedOnce(b, 'denied', { fail: 'egress_denied', disposition: 'USER_ACTION' })
    const afterDenied = await attempt(b.ctx, denied.task)
    expect(carryOf(b.ctx, afterDenied.runId)).toMatchObject({ state: 'carried', from: { runId: denied.first.runId, attempt: 1 } })
    expect(b.carrier.steps).toEqual([expect.objectContaining({ runId: afterDenied.runId, onto: b.head })])
  })

  it('attempt 2 failing acceptance: its change is the attempt\'s result, and attempt 3 starts from it, the dossier saying which attempt the tree came from and the commit that keeps it (T271)', async () => {
    const b = await boot()
    const ready = await readyTask(b.ctx, 'rejected', { writes: { type: 'git-head', ref: b.head }, actionClass: 'workspace-write' })
    // Attempt 1 fails on a later step; attempt 2 completes, and acceptance sends it back: the lint check failed on its tree.
    script(b, [BROKEN])
    const one = await attempt(b.ctx, ready)
    expect(one.status).toBe('failed')
    b.carrier.lint = 'failed'
    const two = await attempt(b.ctx, (await b.ctx.board.task(ready.taskId))!)
    expect(two.status).toBe('completed')
    const back = (await b.ctx.board.task(ready.taskId))!
    expect(back).toMatchObject({ state: 'ready', attempts: { count: 2 } })
    const twoTree = b.workers.worktrees.get(two.runId)!

    b.carrier.lint = 'passed'
    b.carrier.steps.length = 0
    const three = await attempt(b.ctx, back)
    expect(three.status).toBe('completed')
    expect(carryOf(b.ctx, three.runId)).toMatchObject({ state: 'carried', from: { runId: two.runId, attempt: 2, nodeId: 'develop:1', workspace: twoTree }, commit: 'c'.repeat(40), branch: `system/run/${two.runId}` })
    expect(b.carrier.steps).toEqual([expect.objectContaining({ runId: three.runId, onto: b.head, from: expect.objectContaining({ runId: two.runId, workspace: twoTree }) })])
    // The dossier: the attempt the tree came from, and the sha of the commit that keeps its change.
    const carried = b.ctx.workflow.dossier({ taskId: ready.taskId, limit: 50 }).entries.find((e) => e.attempt === 3 && e.text.includes('starts from the tree of attempt'))
    expect(carried).toMatchObject({ kind: 'evidence', attempt: 3, author: { type: 'system' }, commits: ['c'.repeat(40)] })
    expect(carried!.text).toBe(`Attempt 3 (run ${three.runId}) starts from the tree of attempt 2 (run ${two.runId}): its change is kept as commit ${'c'.repeat(40)} on system/run/${two.runId}, on top of ${b.head}.`)
  })

  it('keeps an ended attempt\'s change as its result when it ends, the sha in its dossier and its outcome; one that cannot be kept is said, never skipped (T271)', async () => {
    const b = await boot()
    const keptOf = async (taskId: string, runId: string) => vi.waitFor(() => {
      const kept = b.ctx.workflow.get(runId)?.task?.outcome?.kept
      if (!kept || kept.state === 'pending') throw new Error(`run ${runId}'s change is not settled yet`)
      return { kept, entry: b.ctx.workflow.dossier({ taskId, limit: 50 }).entries.find((e) => e.attempt === 1 && e.text.includes('ended without being accepted')) }
    }, { timeout: 30_000, interval: 25 })

    b.carrier.keeps = true
    const one = await failedOnce(b, 'kept', BROKEN)
    const kept = await keptOf(one.task.taskId, one.first.runId)
    expect(kept.kept).toMatchObject({ state: 'kept', commit: 'e'.repeat(40) })
    expect(kept.entry).toMatchObject({ kind: 'evidence', author: { type: 'system' }, commits: ['e'.repeat(40)] })
    expect(kept.entry!.text).toBe(`Attempt 1 (run ${one.first.runId}) ended without being accepted; its change is kept as commit ${'e'.repeat(40)} on system/run/${one.first.runId}, on top of ${b.head}, as the attempt's result.`)
    expect(b.carrier.kept).toEqual([expect.objectContaining({ step: 'commit', runId: one.first.runId, workspace: b.workers.worktrees.get(one.first.runId) })])
    // The task is done on its next attempt, so another may write the same commit (INV-15). No source holds trees from here.
    b.carrier.keeps = false
    expect((await attempt(b.ctx, one.task)).status).toBe('completed')
    expect((await b.ctx.board.task(one.task.taskId))!.state).toBe('done')

    // No source holds the tree: said, not skipped.
    const two = await failedOnce(b, 'not kept', BROKEN)
    const unkept = await keptOf(two.task.taskId, two.first.runId)
    expect(unkept.kept).toMatchObject({ state: 'not-kept', reason: expect.stringContaining('no Worker source holds') })
    expect(unkept.entry!.text).toContain('its change is not kept as a commit (no Worker source holds')
    expect(unkept.entry!.commits).toBeUndefined()
  })

  it('keeps after a restart what a stop left unkept or unsaid: a change still pending is committed then, and one kept but not yet in the dossier is said then, once (T271, INV-4)', async () => {
    const b = await boot()
    const outcomeOf = (runId: string): Record<string, unknown> => JSON.parse((b.ctx.store.db.prepare('SELECT outcome FROM workflow_tasks WHERE run_id = ?').get(runId) as { outcome: string }).outcome)
    const leave = (runId: string, kept: Record<string, unknown>): void => void b.ctx.store.db.prepare('UPDATE workflow_tasks SET outcome = ? WHERE run_id = ?').run(JSON.stringify({ ...outcomeOf(runId), kept }), runId)
    const said = (taskId: string): string[] => b.ctx.workflow.dossier({ taskId, limit: 50 }).entries.filter((e) => e.text.includes('its change is kept as commit')).map((e) => e.commits![0]!)
    const settledKept = (runId: string) => vi.waitFor(() => {
      const kept = b.ctx.workflow.get(runId)?.task?.outcome?.kept
      if (!kept?.said) throw new Error(`run ${runId}'s change is not said yet`)
      return kept
    }, { timeout: 30_000, interval: 25 })

    // No source held the tree when the attempt ended; a stop is left as if it came before that was settled.
    const one = await failedOnce(b, 'pending', BROKEN)
    await settledKept(one.first.runId)
    leave(one.first.runId, { state: 'pending', at: '2026-10-26T12:00:00.000Z' })
    b.carrier.keeps = true
    await b.restart()
    expect(await settledKept(one.first.runId)).toMatchObject({ state: 'kept', commit: 'e'.repeat(40), branch: `system/run/${one.first.runId}` })
    expect(said(one.task.taskId)).toEqual(['e'.repeat(40)])

    // Kept, and a stop came before the dossier said it: said at the restart, once. (The first task is done first: one writer per subject, INV-15.)
    b.carrier.keeps = false
    expect((await attempt(b.ctx, one.task)).status).toBe('completed')
    const two = await failedOnce(b, 'unsaid', BROKEN)
    await settledKept(two.first.runId)
    leave(two.first.runId, { state: 'kept', commit: 'f'.repeat(40), branch: `system/run/${two.first.runId}`, at: '2026-10-26T12:00:00.000Z' })
    await b.restart()
    expect(await settledKept(two.first.runId)).toMatchObject({ state: 'kept', commit: 'f'.repeat(40), said: true })
    expect(said(two.task.taskId)).toEqual(['f'.repeat(40)])
  })

  it('writes the dossier note of a carry settled before a stop at the run\'s next turn, from the carry it stored, a conflict and all (T271, INV-4)', async () => {
    const b = await boot()
    const { task, first } = await failedOnce(b, 'note', BROKEN)
    const moved = 'd'.repeat(40)
    const rebase = { outcome: 'conflict' as const, from: b.head, onto: moved, files: ['a.c'] }
    b.carrier.answer = (step) => ({
      outcome: 'carried', repository: '/repo', from: { branch: `system/run/${step.from.runId}`, commit: 'c'.repeat(40) },
      base: b.head, branch: `system/run/${step.runId}`, worktree: `/worktrees/${step.runId}`, carried: true, rebase,
    })
    // The writing step holds, so the run is between turns once its carry is settled.
    const reply = b.workers.reply
    b.workers.reply = (request) => (request.requirement.capabilities.includes('develop') ? 'hold' : reply(request))
    const second = await b.ctx.workflow.start({ template: 'relay', input: 'change a.c', classification: 'public', task: { taskId: task.taskId } })
    await vi.waitFor(() => expect(b.workers.holding()).toHaveLength(1), { timeout: 30_000 })
    const notes = () => b.ctx.workflow.dossier({ taskId: task.taskId, limit: 50 }).entries.filter((e) => e.text.includes(`starts from the tree of attempt 1 (run ${first.runId})`))
    expect(notes()).toHaveLength(1)
    // As a stop between the carry and its note leaves it: carried on the row, not yet noted.
    const row = b.ctx.store.db.prepare('SELECT carry FROM workflow_tasks WHERE run_id = ?').get(second.runId) as { carry: string }
    const { noted: _noted, ...unnoted } = JSON.parse(row.carry) as Record<string, unknown>
    b.ctx.store.db.prepare('UPDATE workflow_tasks SET carry = ? WHERE run_id = ?').run(JSON.stringify(unnoted), second.runId)
    // The engine starts again: the run's first turn writes the note, from the row.
    await b.restart()
    await vi.waitFor(() => expect(notes()).toHaveLength(2), { timeout: 30_000, interval: 25 })
    b.workers.release(b.workers.holding()[0]!, { text: 'changed a.c' })
    b.workers.reply = reply
    expect((await settledRun(b.ctx, second.runId)).status).toBe('completed')
    const again = notes()
    expect(again).toHaveLength(2)
    expect(again[1]!.text).toContain(`the repository moved from ${b.head} to ${moved} and the change conflicts with it (a.c)`)
    expect(again[1]!.commits).toEqual(['c'.repeat(40)])
  })

  it('tells the Worker of a rebase onto a moved dev, or of a conflict that left the tree at its own base, and says either in the dossier (T271)', async () => {
    const b = await boot()
    const moved = 'd'.repeat(40)
    const cases = {
      rebased: { base: moved, rebase: { outcome: 'rebased' as const, from: b.head, onto: moved }, brief: 'replayed', dossier: 'without conflict, and the worktree starts there' },
      conflict: { base: b.head, rebase: { outcome: 'conflict' as const, from: b.head, onto: moved, files: ['a.c'] }, brief: 'conflicts', dossier: 'the worktree stays at the change\'s own base' },
    }
    for (const [title, c] of Object.entries(cases)) {
      const { task, first } = await failedOnce(b, title, BROKEN)
      b.carrier.answer = (step) => ({
        outcome: 'carried', repository: '/repo', from: { branch: `system/run/${step.from.runId}`, commit: 'c'.repeat(40) },
        base: c.base, branch: `system/run/${step.runId}`, worktree: `/worktrees/${step.runId}`, carried: true, rebase: c.rebase,
      })
      const before = b.workers.started.length
      const run = await attempt(b.ctx, task)
      expect(run.status).toBe('completed')
      expect(carryOf(b.ctx, run.runId)).toMatchObject({ state: 'carried', rebase: c.rebase, base: c.base, from: { runId: first.runId } })
      const note = (b.ctx.artifacts.get(b.workers.started[before]!.brief!)!.body as Brief).artifacts[0]!.note!
      expect(note).toContain(`Dev moved to ${moved.slice(0, 8)}: ${c.brief}`)
      const entry = b.ctx.workflow.dossier({ taskId: task.taskId, limit: 50 }).entries.find((e) => e.text.includes('starts from the tree of attempt'))!
      expect(entry.text).toContain(`the repository moved from ${b.head} to ${moved}`)
      expect(entry.text).toContain(c.dossier)
    }
  })

  it('starts fresh when the task opts out, even from an attempt whose change would carry: no source is asked, and the dossier says so (T271)', async () => {
    const b = await boot()
    const { task, first } = await failedOnce(b, 'opt out', BROKEN)
    const before = b.workers.started.length
    const done = await settledRun(b.ctx, (await b.ctx.workflow.start({ template: 'relay', input: 'change a.c', classification: 'public', task: { taskId: task.taskId, fresh: true } })).runId)
    expect(done.status).toBe('completed')
    expect(b.carrier.steps).toEqual([])
    const carry = carryOf(b.ctx, done.runId)!
    expect(carry).toMatchObject({ state: 'fresh', from: { runId: first.runId, attempt: 1 }, reason: expect.stringContaining('asked for a fresh start') })
    expect(carry.decisions.map((d) => decisionOf(b.ctx, d).outcome)).toEqual([expect.objectContaining({ option: 'fresh', detail: expect.objectContaining({ optedOut: true }) })])
    for (const started of b.workers.started.slice(before)) expect(started.prompt).not.toContain('already holds the change')
    const entry = b.ctx.workflow.dossier({ taskId: task.taskId, limit: 50 }).entries.find((e) => e.text.includes('starts fresh'))
    expect(entry).toMatchObject({ kind: 'evidence', attempt: 2, author: { type: 'system' } })
    expect(entry!.text).toContain(`not from the tree of attempt 1 (run ${first.runId})`)
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
