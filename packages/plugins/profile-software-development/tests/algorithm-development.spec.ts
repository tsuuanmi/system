import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { captureGitSubject, subjectId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attempt, bootPilot, charter, decide, FIXED, MEASURED, ORIGINAL, operatorAccepts, type Pilot, propose, queued, reported, TESTS, until } from './pilot.ts'

// The algorithm-development template end to end (PROP-0010 B8): one attempt of a board task, over
// the real board, approval queue, ledger, digests, and agents source with a worktree per run; only
// the agent runtime is scripted.
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

/** The main working tree as the operator left it: on main, at its commit, clean. */
const untouched = (pilot: Pilot): void => {
  expect(pilot.git(pilot.repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(pilot.head)
  expect(pilot.git(pilot.repo, 'status', '--porcelain')).toBe('')
  expect(readFileSync(join(pilot.repo, 'calc.py'), 'utf8')).toBe(ORIGINAL)
}

describe('the algorithm-development template (PROP-0010 B8)', () => {
  it('runs one attempt of a board task: develop in the run\'s worktree, an exact-subject review whose fix waits on the approval queue, validation confined to the worktree last, then the result held for the operator with its digest (REQ-WF-5, REQ-WF-9, REQ-WRK-6, INV-15)', async () => {
    const pilot = await boot({ changes: 1 })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    expect(task.state).toBe('ready')
    const run = await attempt(ctx, task.taskId)
    expect(run.task).toMatchObject({ taskId: task.taskId })

    // The review asked for changes with a blocking finding: the fix waits on one request in the queue, on its exact plan and subject.
    const waiting = await queued(ctx, run.runId)
    expect(waiting.nodeId).toBe('review:1:approve:1')
    const request = (await ctx.approvals.get(waiting.approvalRequest))!
    const reviewed = /^Subject: (\S+)$/m.exec(agent.runs.find((r) => r.role === 'review')!.prompt)![1]!
    expect(request).toMatchObject({
      action: { class: 'remediation' }, requester: { component: 'workflow', runId: run.runId },
      subject: { type: 'artifact', ref: waiting.plan, version: reviewed },
    })
    expect(agent.runs.map((r) => r.role)).toEqual(['develop', 'review'])
    await decide(ctx, request.requestId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.state])).toEqual([
      ['develop:1', 'COMPLETED'], ['review:1', 'COMPLETED'], ['review:1:approve:1', 'COMPLETED'], ['review:1:fix:1', 'COMPLETED'], ['review:1:review:2', 'COMPLETED'], ['validate:1', 'COMPLETED'],
    ])

    // Every step of the run worked in the run's own worktree, on its branch; the repository's tree is untouched.
    const work = agent.runs.filter((r) => r.role !== 'digest')
    expect(work.map((r) => [r.role, r.sandbox])).toEqual([
      ['develop', 'workspace-write'], ['review', 'read-only'], ['fix', 'workspace-write'], ['review', 'read-only'], ['validate', 'workspace-write'],
    ])
    const worktree = work[0]!.workspace
    expect(basename(worktree)).toBe(run.runId)
    for (const r of work) expect(r.workspace).toBe(worktree)
    expect(pilot.git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(`system/run/${run.runId}`)
    expect(readFileSync(join(worktree, 'calc.py'), 'utf8')).toBe(FIXED)
    expect(existsSync(join(worktree, 'test_calc.py'))).toBe(true)
    untouched(pilot)

    // The reviewer read the task and the exact change, never the developer's answer; the re-review read the fixed subject.
    const reviews = work.filter((r) => r.role === 'review')
    expect(reviews[0]!.prompt).toContain('Goal: Make add() add, with its tests passing')
    expect(reviews[0]!.prompt).toContain('+    return a + b')
    expect(reviews[0]!.prompt).not.toContain('Hypothesis:')
    const final = captureGitSubject(worktree)!.subject
    expect(/^Subject: (\S+)$/m.exec(reviews[1]!.prompt)![1]).toBe(subjectId(final))
    const asked = (prompt: string): string => prompt.split('\n\n## The exact subject of this review')[0]!
    expect(asked(reviews[1]!.prompt)).toBe(asked(reviews[0]!.prompt))
    expect(asked(reviews[1]!.prompt)).toContain('Review this change as an independent reviewer')
    // The review and its re-review read and judge, and run no test or build: an environment limit is at most info.
    for (const review of reviews) {
      expect(asked(review.prompt)).toContain('you never run the project\'s tests or builds')
      expect(asked(review.prompt)).toContain('A command you could not run is not a finding about the change; an environment limit is at most an info finding.')
      expect(review.prompt).toContain('never run the project\'s tests or builds, which the validation and the run\'s required checks run.')
    }

    // Validation came last, on the fixed change: its listed command ran as the workspace write the policy judges it, asking no one.
    expect(agent.calls.filter((c) => c.role === 'validate')).toEqual([{ role: 'validate', tool: 'Bash', verdict: { decision: 'allow' } }])
    // The validator read the task's criteria, each with what checks it, and the worktree: never the
    // caller's input, which is the develop step's orders (T99 D4), nor any step's answer.
    const validator = work.find((r) => r.role === 'validate')!.prompt
    expect(validator).toContain(`- a1: ${TESTS} passes (check: tests)`)
    expect(validator).not.toContain('Fix add() so it adds')
    expect(validator).not.toContain('Hypothesis:')
    expect(work[0]!.prompt).toContain('Fix add() so it adds')
    const brief = ctx.artifacts.get(done.nodes.find((n) => n.nodeId === 'validate:1')!.brief!)!.body as { schema: string; acceptance: unknown[] }
    expect(brief).toMatchObject({ schema: 'brief@1.3', acceptance: [{ id: 'a1', statement: `${TESTS} passes`, check: 'tests' }] })
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).map((r) => r.action.class).sort()).toEqual(['charter', 'remediation'])

    // The result is the validation's report on the exact subject the task writes; the review check passed on it.
    const held = await until(async () => {
      const t = await ctx.board.task(task.taskId)
      return t?.result?.digest ? t : undefined
    }, 'the digest on the task\'s result')
    expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
    expect(held.result!.subject).toEqual({ type: 'git-head', ref: pilot.head, version: final.version })
    const [validation] = held.result!.artifacts
    expect((ctx.artifacts.get(validation!)!.body as { text: string; workspace: string }).text).toContain(MEASURED)
    const acceptance = ctx.artifacts.get(done.task!.outcome!.decision!)!.body as { decider: { id: string }; outcome: { option: string; detail: { checks: Record<string, boolean> } } }
    expect(acceptance).toMatchObject({ decider: { id: 'workflow.task-acceptance' }, outcome: { option: 'accept', detail: { checks: { review: true } } } })

    // The digest cites the validation's report, quoted verbatim.
    const digest = ctx.artifacts.get(held.result!.digest!)!.body as { sources: ArtifactRef[]; claims: Array<{ citation: { quote: string } }> }
    expect(digest.sources).toEqual(held.result!.artifacts)
    expect(digest.claims[0]!.citation.quote).toBe(`${TESTS}: exit 0`)

    // Every run was metered on the pool, and the operator's acceptance on /ui makes the task done.
    expect((await ctx.resources.usage({ pool: 'plan.agents' })).records).toHaveLength(agent.runs.length)
    expect((await operatorAccepts(ctx, task.taskId)).state).toBe('done')
  })

  it('admits validation only on a Worker whose commands are proven confined: without one, it fails with nothing sent, and the board counts the attempt (ADR-0038, INV-2)', async () => {
    const pilot = await boot({ executes: false })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const failed = await reported(ctx, run.runId)
    expect(failed.status).toBe('failed')
    expect(failed.nodes.find((n) => n.nodeId === 'validate:1')).toMatchObject({ state: 'FAILED' })
    // Developed and reviewed; the validation was never started, on any Worker.
    expect(agent.runs.map((r) => r.role)).toEqual(['develop', 'review'])
    const explained = ctx.workflow.explain(run.runId)!.nodes.find((n) => n.nodeId === 'validate:1')!
    expect(JSON.stringify(explained)).toContain('validate')
    // The failure is the attempt's: reported to the board, which readies the next one through its gate.
    expect(failed.task).toMatchObject({ outcome: { status: 'reconciled' } })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    untouched(pilot)
  })

  /** The candidates of a step's route decision: who was refused it, and why. */
  const routed = (ctx: Pilot['ctx'], runId: string, nodeId: string): Array<{ option: string; selected: boolean; reasons: string[] }> => {
    const routeId = ctx.workflow.explain(runId)!.nodes.find((n) => n.nodeId === nodeId)!.decisions.find((d) => d.type === 'route')!.id
    return (ctx.artifacts.get(routeId as ArtifactRef)!.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }).candidates
  }

  it('routes by kind of work when the operator gives Workers kinds: every writing step and its fix on the writer given code, docs, and tests, the review on the reviewer given none, and validate:1 alone on the Worker given validation; the tests variant writes on the same writer (REQ-WRK-11, ADR-0057)', async () => {
    const pilot = await boot({ changes: 1, writers: { developer: ['code', 'docs', 'tests'], tester: ['validation'] } })
    const { ctx } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    await decide(ctx, (await queued(ctx, run.runId)).approvalRequest)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([
      ['develop:1', 'agent:developer'], ['review:1', 'agent:reviewer'], ['review:1:approve:1', undefined], ['review:1:fix:1', 'agent:developer'],
      ['review:1:review:2', 'agent:reviewer'], ['validate:1', 'agent:tester'],
    ])
    // Each route decision says why the other Worker lost the step.
    expect(routed(ctx, run.runId, 'develop:1').find((c) => c.option === 'agent:tester')!.reasons).toEqual(['takes validation work only; this work is code work'])
    expect(routed(ctx, run.runId, 'validate:1').find((c) => c.option === 'agent:developer')!.reasons).toEqual(['takes code, docs, tests work only; this work is validation work'])
    // The tests variant of the same template: its develop step is tests work, still on the writer, and
    // its validation still on the Worker given validation (once the first task is done, as one
    // subject has one writer, INV-15).
    expect((await operatorAccepts(ctx, task.taskId)).state).toBe('done')
    const tests = await propose(pilot, 'p1', 'test add()')
    const written = await ctx.workflow.start({ template: 'algorithm-development', variant: 'tests', input: 'Test what add() returns', classification: 'operator-shared', task: { taskId: tests.taskId } })
    const finished = await reported(ctx, written.runId)
    expect(finished.nodes.find((n) => n.nodeId === 'develop:1')!.worker).toBe('agent:developer')
    expect(finished.nodes.find((n) => n.nodeId === 'validate:1')!.worker).toBe('agent:tester')
  })

  it('fails validate:1 closed, saying no Worker takes validation work, when the Workers given kinds name none of it: the writers given code and docs, tests never take it (ADR-0057, INV-2)', async () => {
    const pilot = await boot({ writers: { developer: ['code'], tester: ['docs', 'tests'] } })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const failed = await reported(ctx, run.runId)
    expect(failed.status).toBe('failed')
    expect(failed.nodes.find((n) => n.nodeId === 'validate:1')).toMatchObject({ state: 'FAILED' })
    expect(agent.runs.map((r) => r.role)).toEqual(['develop', 'review'])
    expect(JSON.stringify(ctx.workflow.explain(run.runId)!.nodes.find((n) => n.nodeId === 'validate:1'))).toContain('no Worker that proves validate, local-data takes validation work')
  })

  it('routes a step by the kind the row configures: validate:1 configured as tests work runs on the writer given docs, tests (ADR-0057)', async () => {
    const pilot = await boot({ writers: { developer: ['code'], tester: ['docs', 'tests'] }, profile: { kinds: { validate: 'tests' } } })
    const { ctx } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([['develop:1', 'agent:developer'], ['review:1', 'agent:reviewer'], ['validate:1', 'agent:tester']])
    expect(routed(ctx, run.runId, 'validate:1').find((c) => c.selected)!.reasons).toContain('takes tests work, one of its kinds')
  })

  it('denies a validation command the policy does not list, asking no one: the validation reports it not run, and the result goes to the operator so (approvals: a Worker\'s tool calls)', async () => {
    const pilot = await boot({ validate: 'npm run bench' })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() fast')
    const run = await attempt(ctx, task.taskId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    // The validation runs in a conversation of its own, which no later run continues: a call the policy
    // asks about is denied there, and nothing is queued that no run could use.
    const denied = agent.calls.find((c) => c.role === 'validate')!
    expect(denied).toMatchObject({ tool: 'Bash', verdict: { decision: 'deny', reason: expect.stringContaining('session') } })
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).map((r) => r.action.class)).toEqual(['charter'])
    expect(ctx.eventLog.query({ type: 'agent-workers.tool.denied', runId: run.runId })).toHaveLength(1)
    // The report says what was not measured, and the operator reads it before accepting anything.
    const held = (await ctx.board.task(task.taskId))!
    expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })
    expect((ctx.artifacts.get(held.result!.artifacts[0]!)!.body as { text: string }).text).toContain('npm run bench: not run')
  })

  it('retires each attempt\'s worktree after the retention, its result rejected or accepted, its work committed on its branch; the operator can list and remove them sooner (D12, INV-9)', async () => {
    const pilot = await boot()
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const digested = (taskId: string) => until(async () => {
      const t = await ctx.board.task(taskId)
      return t?.result?.digest ? t : undefined
    }, 'the digest on the task\'s result')
    // Attempt 1, rejected by the operator: the task is ready for attempt 2.
    const first = await attempt(ctx, task.taskId)
    expect((await reported(ctx, first.runId)).status).toBe('completed')
    await digested(task.taskId)
    expect(await operatorAccepts(ctx, task.taskId, 'reject')).toMatchObject({ state: 'ready' })
    // Attempt 2, accepted: done.
    const second = await attempt(ctx, task.taskId)
    expect((await reported(ctx, second.runId)).status).toBe('completed')
    await digested(task.taskId)
    expect((await operatorAccepts(ctx, task.taskId)).state).toBe('done')
    const worktreeOf = (runId: string): string => agent.runs.find((r) => r.role === 'develop' && basename(r.workspace) === runId)!.workspace
    // Both are finished. The rejected attempt's work is uncommitted; the accepted one's is committed on
    // its branch once the engine lands it (ADR-0060: its merge then waits for the operator, from the branch).
    await until(() => (ctx.workflow.get(second.runId)?.task?.landing?.state === 'asked' ? true : undefined), 'the accepted result committed and its merge asked')
    const listed = await ctx.agentWorkers.runWorktrees()
    expect(listed.worktrees.map((w) => [w.runId, w.state, w.changes])).toEqual([[first.runId, 'finished', 'uncommitted'], [second.runId, 'finished', 'clean']])
    // The operator's removal never discards: without the commit flag, the uncommitted one stays; the
    // clean one goes, its branch kept for the merge.
    expect((await ctx.agentWorkers.removeWorktrees()).worktrees.map((w) => [w.runId, w.outcome])).toEqual([[first.runId, 'kept'], [second.runId, 'removed']])
    // The retention removes the other once its hours have passed since its last agent run, its work kept on its branch.
    expect(await ctx.agentWorkers.sweepWorktrees(Date.now() + 167 * 60 * 60_000)).toEqual({ removed: [], kept: [] })
    expect(await ctx.agentWorkers.sweepWorktrees(Date.now() + 169 * 60 * 60_000)).toEqual({ removed: [worktreeOf(first.runId)], kept: [] })
    for (const run of [first, second]) {
      expect(existsSync(worktreeOf(run.runId))).toBe(false)
      expect(pilot.git(pilot.repo, 'show', `system/run/${run.runId}:calc.py`)).toBe(FIXED.trim())
    }
    expect(await ctx.agentWorkers.runWorktrees()).toMatchObject({ total: 0, worktrees: [] })
    untouched(pilot)
  })
})
