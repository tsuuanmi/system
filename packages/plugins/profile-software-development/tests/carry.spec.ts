import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactRef } from '@tsuuanmi/system-board-core'
import { captureGitSubject, SchemaRegistry } from '@tsuuanmi/system-libs'
import type { TaskCarry, TaskLanding } from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attempt, bootPilot, charter, decide, FIXED, operatorAccepts, ORIGINAL, type Pilot, propose, queued, reported, type Script, until } from './pilot.ts'

// A board task's next attempt starting from the work its previous attempt left (ADR-0061, T112):
// the pilot in miniature, over a scratch repository, with the real engine, board, approval queue,
// and agents source with a worktree per run.
vi.setConfig({ testTimeout: 120_000 })

const pilots: Pilot[] = []
afterEach(async () => {
  while (pilots.length) await pilots.pop()!.dispose()
})
const boot = async (script: Script): Promise<Pilot> => {
  const pilot = await bootPilot(script)
  pilots.push(pilot)
  return pilot
}

type Decision = { decisionType: string; decider: { id: string }; inputs: string[]; outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
const decisionOf = (pilot: Pilot, ref: ArtifactRef): Decision => {
  const body = pilot.ctx.artifacts.get(ref)!.body as Decision & { schema: string }
  new SchemaRegistry().assertRecord(body)
  return body
}
const carryOf = (pilot: Pilot, runId: string): TaskCarry | undefined => pilot.ctx.workflow.get(runId)?.task?.carry

/**
 * Attempt 1 of a task that writes the repository's HEAD: its develop step completes in the run's
 * worktree, then its review ends on a broken session (T110a: the review reached its turn limit), so
 * the attempt fails, the board counts it, and the task is ready again.
 */
async function brokenAttempt(pilot: Pilot): Promise<{ taskId: string; runId: string; worktree: string }> {
  await charter(pilot.ctx, 'p1')
  const task = await propose(pilot, 'p1', 'make add() add')
  const run = await attempt(pilot.ctx, task.taskId)
  const done = await reported(pilot.ctx, run.runId)
  expect(done).toMatchObject({ status: 'failed', error: { kind: 'session_broken' }, task: { outcome: { status: 'reconciled' } } })
  expect((await pilot.ctx.board.task(task.taskId))).toMatchObject({ state: 'ready', attempts: { count: 1 } })
  const worktree = pilot.agent.runs.find((r) => r.role === 'develop')!.workspace
  return { taskId: task.taskId, runId: run.runId, worktree }
}

/** The next attempt of the task, once its outcome reached the board. */
async function nextAttempt(pilot: Pilot, taskId: string): Promise<string> {
  const run = await attempt(pilot.ctx, taskId)
  await reported(pilot.ctx, run.runId)
  return run.runId
}

describe('a board task\'s next attempt starts from the previous attempt\'s work (ADR-0061)', () => {
  it('T110a: an attempt whose develop step completed and whose review\'s session then broke is carried into the next: its worktree starts from that change, its developer builds on it, its review reviews the whole change, and it lands as one change on the base (REQ-WF-14, INV-5, INV-13)', async () => {
    const pilot = await boot({ reviewFails: 1 })
    const { ctx } = pilot
    const first = await brokenAttempt(pilot)
    const left = captureGitSubject(first.worktree)!.subject
    expect(left.ref).toBe(pilot.head)

    const runId = await nextAttempt(pilot, first.taskId)
    expect(ctx.workflow.get(runId)!.task?.outcome).toMatchObject({ status: 'review' })
    const branch = `system/run/${first.runId}`
    const commit = pilot.git(pilot.repo, 'rev-parse', branch)
    const carry = carryOf(pilot, runId)!
    expect(carry).toMatchObject({ state: 'carried', from: { runId: first.runId, attempt: 1, nodeId: 'develop:1', workspace: first.worktree, subject: { ref: pilot.head, version: left.version } }, branch, commit })

    // Recorded (INV-13): the admission decision, then the carry the source made, naming the earlier run and the commit; explain shows both.
    const [admitted, carried, ...more] = carry.decisions.map((d) => decisionOf(pilot, d))
    expect(more).toEqual([])
    expect(admitted).toMatchObject({ decisionType: 'admission', decider: { id: 'workflow.task-worktree' }, outcome: { option: 'carry', detail: { taskId: first.taskId, from: first.runId, nodeId: 'develop:1' } } })
    expect(carried).toMatchObject({
      decisionType: 'gate', decider: { id: 'workflow.task-worktree' },
      outcome: { option: 'carry', detail: { from: first.runId, commit, fromBranch: branch, base: pilot.head, branch: `system/run/${runId}`, source: 'agents', carried: true } },
    })
    expect(carried!.inputs).toEqual(expect.arrayContaining([carry.decisions[0], carry.from.result]))
    expect(ctx.workflow.explain(runId)!.decisions!.map((d) => d.id)).toEqual(expect.arrayContaining(carry.decisions))
    expect(ctx.eventLog.query({ type: 'workflow.task.carry', runId }).map((e) => [e.data?.['state'], e.data?.['commit']])).toEqual([['carried', commit]])

    // The earlier tree, committed on its run's branch by the system, on top of the commit the task writes.
    expect(pilot.git(pilot.repo, 'rev-parse', `${branch}^`)).toBe(pilot.head)
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%an <%ae>', branch)).toBe('system <system@localhost>')
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%B', branch)).toContain(`System-Run: ${first.runId}\nSystem-Subject: git:${pilot.head}:${left.version}\nSystem-Carried-To: ${runId}`)
    expect(pilot.git(first.worktree, 'status', '--porcelain')).toBe('')

    // Attempt 2's developer found the change already in its worktree, and its brief said so.
    const developers = pilot.agent.runs.filter((r) => r.role === 'develop')
    expect(pilot.agent.found).toEqual([ORIGINAL, FIXED])
    expect(developers[1]!.prompt).toContain(`already holds the change step develop:1 of attempt 1 made (committed as ${commit} on ${branch}, on top of ${pilot.head}): build on it, do not make it again`)

    // Its review reviewed the whole change, on the commit the task writes, and the result is on that subject.
    const review = pilot.agent.runs.filter((r) => r.role === 'review').at(-1)!
    expect(review.workspace).toBe(developers[1]!.workspace)
    expect(review.prompt).toContain('+    return a + b')
    expect(/^Subject: git:([0-9a-f]+):/m.exec(review.prompt)![1]).toBe(pilot.head)
    expect((await ctx.board.task(first.taskId))!.result!.subject).toMatchObject({ type: 'git-head', ref: pilot.head })

    // Accepted, it lands as one commit on the base, holding the change.
    await operatorAccepts(ctx, first.taskId)
    const landing = await until(() => {
      const l: TaskLanding | undefined = ctx.workflow.get(runId)?.task?.landing
      return l?.state === 'asked' ? l : undefined
    }, 'the landing to ask for the merge')
    expect(pilot.git(pilot.repo, 'rev-parse', `${landing.head}^`)).toBe(pilot.head)
    expect(pilot.git(pilot.repo, 'show', `${landing.head}:calc.py`)).toBe(FIXED.trim())
  })

  it('never carries an attempt whose review asked for changes, nor one the board judged: the next attempt starts from HEAD, the decision saying why (REQ-WF-14, INV-2)', async () => {
    const pilot = await boot({ changes: 1 })
    const { ctx } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    // Attempt 1: the review asks for changes, and the operator rejects the fix.
    const first = await attempt(ctx, task.taskId)
    await decide(ctx, (await queued(ctx, first.runId)).approvalRequest, 'rejected')
    expect(await reported(ctx, first.runId)).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected' } })

    const second = await nextAttempt(pilot, task.taskId)
    const fresh = carryOf(pilot, second)!
    expect(fresh).toMatchObject({ state: 'fresh', from: { runId: first.runId, nodeId: 'develop:1' }, reason: expect.stringMatching(/a review asked for changes, or a plan\): the change was judged, so it is not carried/) })
    expect(fresh.decisions.map((d) => decisionOf(pilot, d).outcome.option)).toEqual(['fresh'])
    expect(pilot.git(pilot.repo, 'rev-parse', `system/run/${first.runId}`)).toBe(pilot.head)

    // Attempt 2's result reached the board, and the operator rejects it: attempt 3 starts from HEAD too.
    await operatorAccepts(ctx, task.taskId, 'reject')
    const third = await nextAttempt(pilot, task.taskId)
    expect(carryOf(pilot, third)).toMatchObject({ state: 'fresh', from: { runId: second }, reason: `run ${second} completed: its result went to the board, which judged it, so the next attempt starts from HEAD` })
    expect(pilot.agent.found).toEqual([ORIGINAL, ORIGINAL, ORIGINAL])
    expect(ctx.eventLog.query({ type: 'workflow.task.carry' })).toEqual([])
  })

  it('never carries a tree off the commit the task writes: a developer that committed moved its subject, so the next attempt starts from HEAD (REQ-WF-14, INV-5, INV-15)', async () => {
    const pilot = await boot({ reviewFails: 1, commits: true })
    const first = await brokenAttempt(pilot)
    const moved = pilot.git(first.worktree, 'rev-parse', 'HEAD')
    expect(moved).not.toBe(pilot.head)
    const runId = await nextAttempt(pilot, first.taskId)
    expect(carryOf(pilot, runId)).toMatchObject({
      state: 'fresh', reason: `the tree step develop:1 of run ${first.runId} left is on ${moved}, not on ${pilot.head}, the commit task ${first.taskId} writes: its subject moved, so it is not carried`,
    })
    expect(pilot.agent.found).toEqual([ORIGINAL, ORIGINAL])
    expect(pilot.git(pilot.repo, 'rev-parse', `system/run/${first.runId}`)).toBe(moved)
  })

  it('carries nothing onto another base: once the repository\'s HEAD moved, the source refuses and commits nothing, and the next attempt starts from HEAD as it is (REQ-WF-14, INV-5)', async () => {
    const pilot = await boot({ reviewFails: 1 })
    const first = await brokenAttempt(pilot)
    // Another change lands on main meanwhile.
    writeFileSync(join(pilot.repo, 'README.md'), 'calc\n')
    pilot.git(pilot.repo, 'add', 'README.md')
    pilot.git(pilot.repo, 'commit', '-q', '-m', 'operator: a readme')
    const runId = await nextAttempt(pilot, first.taskId)
    const carry = carryOf(pilot, runId)!
    expect(carry).toMatchObject({ state: 'fresh', cause: 'base-moved', reason: expect.stringMatching(/^source agents did not carry it: the HEAD of .* is [0-9a-f]+ now, not [0-9a-f]+, the commit the tree .* is on: a fresh worktree starts from the HEAD, so the earlier work is not carried onto another base$/) })
    expect(carry.decisions.map((d) => decisionOf(pilot, d).outcome.option)).toEqual(['carry', 'fresh'])
    expect(decisionOf(pilot, carry.decisions[1]!).outcome.detail).toMatchObject({ source: 'agents', cause: 'base-moved' })
    expect(pilot.agent.found).toEqual([ORIGINAL, ORIGINAL])
    // The earlier worktree is left as it was: nothing committed on its branch.
    expect(pilot.git(first.worktree, 'status', '--porcelain')).toContain('calc.py')
    expect(pilot.git(pilot.repo, 'rev-parse', `system/run/${first.runId}`)).toBe(pilot.head)
  })

  it('carries nothing from a worktree that changed after its develop step, or that was removed: the next attempt starts from HEAD (REQ-WF-14, INV-2, INV-5)', async () => {
    const dirty = await boot({ reviewFails: 1 })
    const changed = await brokenAttempt(dirty)
    writeFileSync(join(changed.worktree, 'stray.txt'), 'written after the develop step\n')
    const afterChange = await nextAttempt(dirty, changed.taskId)
    expect(carryOf(dirty, afterChange)).toMatchObject({ state: 'fresh', cause: 'moved', reason: expect.stringMatching(/changed since, so its work is not carried/) })
    expect(dirty.agent.found).toEqual([ORIGINAL, ORIGINAL])
    expect(dirty.git(changed.worktree, 'status', '--porcelain')).toContain('stray.txt')

    const missing = await boot({ reviewFails: 1 })
    const removed = await brokenAttempt(missing)
    expect(await missing.ctx.agentWorkers.removeWorktrees({ runId: removed.runId, commitChanges: true })).toMatchObject({ worktrees: [{ runId: removed.runId, outcome: 'removed' }] })
    expect(existsSync(removed.worktree)).toBe(false)
    const afterRemoval = await nextAttempt(missing, removed.taskId)
    expect(carryOf(missing, afterRemoval)).toMatchObject({ state: 'fresh', cause: 'gone', reason: expect.stringMatching(/was removed .* so the tree .* can no longer be checked/) })
    expect(missing.agent.found).toEqual([ORIGINAL, ORIGINAL])
  })
})
