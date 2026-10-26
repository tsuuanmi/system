import { captureGitSubject } from '@tsuuanmi/system-libs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { needsBubblewrap } from '../../../agent-runtime-core/tests/host.ts'
import { attempt, bootPilot, charter, FIXED, ORIGINAL, type Pilot, propose, reported, until } from './pilot.ts'

// A run's required checks on the real stack (T151, ADR-0063): the algorithm-development template
// over the real board, approval queue, ledger, digests, and agents source with a worktree per run and
// its repository's setup; only the agent runtime is scripted. The checks themselves are real commands
// the operator configured, run confined on the result's exact tree.
vi.setConfig({ testTimeout: 120_000 })

const pilots: Pilot[] = []
afterEach(async () => {
  while (pilots.length) await pilots.pop()!.dispose()
})
const boot = async (...args: Parameters<typeof bootPilot>): Promise<Pilot> => {
  const pilot = await bootPilot(...args)
  pilots.push(pilot)
  return pilot
}

type Acceptance = { decider: { id: string }; inputs: string[]; candidates: Array<{ selected: boolean; reasons: string[] }>; outcome: { option: string; detail: { checks: Record<string, boolean>; checkRun?: { evidence?: string } } } }
type CheckRun = { subject: { ref: string; version: string }; checks: Array<{ check: string; outcome: string; exitCode?: number; output?: { tail: string } }> }

describe('the algorithm-development template with the repository\'s checks configured (T151)', () => {
  needsBubblewrap()
  it('runs the required tests and lint on the reviewed tree once the review is done, and the task\'s result is accepted on them without the operator (REQ-WF-15, INV-5)', async () => {
    const pilot = await boot({ checks: { tests: 'node tests.mjs', lint: 'node lint.mjs' } })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => n.nodeId)).toEqual(['develop:1', 'selfreview:1', 'review:1'])

    // The engine's acceptance names the checks it ran on the exact tree: the review it judged, and tests and lint by their exit codes.
    const acceptance = ctx.artifacts.get(done.task!.outcome!.decision!)!.body as Acceptance
    expect(acceptance).toMatchObject({ decider: { id: 'workflow.task-acceptance' }, outcome: { option: 'accept', detail: { checks: { review: true, tests: true, lint: true } } } })
    expect(acceptance.candidates.find((c) => c.selected)!.reasons).toContainEqual('the checks it ran: review passed, tests passed, lint passed')
    const evidence = acceptance.outcome.detail.checkRun!.evidence!
    expect(acceptance.inputs).toContain(evidence)
    const worktree = agent.runs.find((r) => r.role === 'develop')!.workspace
    const tree = captureGitSubject(worktree)!.subject
    const ran = ctx.artifacts.get(evidence as `sha256:${string}`)!.body as CheckRun
    expect(ran.subject).toMatchObject({ ref: pilot.head, version: tree.version })
    expect(ran.checks).toMatchObject([{ check: 'tests', outcome: 'passed', exitCode: 0, output: { tail: 'tests: 3 passed\n' } }, { check: 'lint', outcome: 'passed', exitCode: 0 }])

    // The board takes the engine's acceptance: no check pending, so the task is done with no review held for the operator.
    const accepted = await until(async () => {
      const t = await ctx.board.task(task.taskId)
      return t?.state === 'done' ? t : undefined
    }, 'the task done')
    expect(accepted.waiting).toBeUndefined()
    expect(accepted.result!.subject).toEqual({ type: 'git-head', ref: pilot.head, version: tree.version })
    // explain shows them under the run.
    expect(JSON.stringify(ctx.workflow.explain(run.runId))).toContain('tests passed, lint passed')
  })

  it('shows a check that printed nothing for its bound as stalled in the run\'s explain while it lasts, and no longer once the run moved on (T235)', async () => {
    const pilot = await boot({ checks: { tests: 'node tests.mjs', lint: 'node lint-quiet.mjs' }, checkStallSeconds: 1 })
    const { ctx } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const stalled = await until(() => ctx.workflow.explain(run.runId)?.stalledChecks?.find((c) => c.check === 'lint'), 'the lint check told stalled', 60_000)
    expect(stalled).toMatchObject({ check: 'lint', command: 'node lint-quiet.mjs', stallSeconds: 1, quietSince: expect.any(String), since: expect.any(String) })
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(ctx.workflow.explain(run.runId)!.stalledChecks).toBeUndefined()
    const acceptance = ctx.artifacts.get(done.task!.outcome!.decision!)!.body as Acceptance
    expect(acceptance.outcome.detail.checks).toMatchObject({ tests: true, lint: true })
  })

  it('sends the result back as another attempt when lint fails on it, naming the check and its exit code; the operator is not asked (REQ-WF-15, INV-2)', async () => {
    const pilot = await boot({ checks: { tests: 'node tests.mjs', lint: 'node lint-strict.mjs' } })
    const { ctx } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    const acceptance = ctx.artifacts.get(done.task!.outcome!.decision!)!.body as Acceptance
    expect(acceptance.outcome).toMatchObject({ option: 'reject', detail: { checks: { review: true, tests: true, lint: false } } })
    expect(acceptance.candidates.find((c) => c.selected)!.reasons[0]).toMatch(/^the run's own lint check failed on git-head /)
    const ran = ctx.artifacts.get(acceptance.outcome.detail.checkRun!.evidence! as `sha256:${string}`)!.body as CheckRun
    expect(ran.checks[1]).toMatchObject({ check: 'lint', outcome: 'failed', exitCode: 2, output: { tail: expect.stringContaining('lint-strict: calc.py has no header comment') } })
    // Another attempt through the board's gate, not a review held for the operator.
    const back = await until(async () => {
      const t = await ctx.board.task(task.taskId)
      return t?.state === 'ready' ? t : undefined
    }, 'the task ready for its next attempt')
    expect(back.attempts.count).toBe(1)
    expect((await ctx.approvals.list({ states: ['open', 'batched'] })).filter((r) => r.action.class !== 'charter')).toEqual([])
  })

  it('keeps the change of an attempt acceptance failed as a commit on its branch, its sha in the dossier, and starts the next attempt\'s worktree from it (T271)', async () => {
    const pilot = await boot({ checks: { tests: 'node tests.mjs', lint: 'node lint-strict.mjs' } })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const first = await attempt(ctx, task.taskId)
    expect(await reported(ctx, first.runId)).toMatchObject({ status: 'completed', task: { outcome: { status: 'rejected' } } })
    // Kept when the attempt ended: a commit on its own run branch, on the commit the task writes, recorded with its sha.
    const kept = await until(() => {
      const k = ctx.workflow.get(first.runId)?.task?.outcome?.kept
      return k && k.state !== 'pending' ? k : undefined
    }, 'the rejected attempt\'s change kept')
    expect(kept).toMatchObject({ state: 'kept', commit: pilot.git(pilot.repo, 'rev-parse', `system/run/${first.runId}`) })
    expect(pilot.git(pilot.repo, 'rev-parse', `${kept.commit}^`)).toBe(pilot.head)
    expect(pilot.git(pilot.repo, 'show', `${kept.commit}:calc.py`)).toBe(FIXED.trim())

    // The next attempt's worktree holds that change before its developer starts.
    const second = await attempt(ctx, task.taskId)
    await reported(ctx, second.runId)
    expect(agent.found).toEqual([ORIGINAL, FIXED])
    expect(ctx.workflow.get(second.runId)!.task!.carry).toMatchObject({ state: 'carried', from: { runId: first.runId, attempt: 1 }, commit: kept.commit })
    const entries = ctx.workflow.dossier({ taskId: task.taskId, limit: 50 }).entries
    expect(entries.find((e) => e.attempt === 1 && e.text.includes('its change is kept as commit'))).toMatchObject({ kind: 'evidence', commits: [kept.commit] })
    expect(entries.find((e) => e.attempt === 2 && e.text.includes('starts from the tree of attempt 1'))).toMatchObject({ kind: 'evidence', commits: [kept.commit] })
  })
})
