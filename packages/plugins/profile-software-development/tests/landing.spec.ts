import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { captureGitSubject, SchemaRegistry, subjectId } from '@tsuuanmi/system-libs'
import type { TaskLanding } from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attempt, bootPilot, charter, decide, FIXED, operatorAccepts, type Pilot, reported, until } from './pilot.ts'

// Landing an accepted result (ADR-0060): the pilot in miniature, over a scratch repository, with
// the real engine, board, approval queue, and agents source with a worktree per run.
vi.setConfig({ testTimeout: 120_000 })

const pilots: Pilot[] = []
afterEach(async () => {
  while (pilots.length) await pilots.pop()!.dispose()
})
const boot = async (): Promise<Pilot> => {
  const pilot = await bootPilot()
  pilots.push(pilot)
  return pilot
}

type Decision = { decisionType: string; decider: { id: string }; inputs: string[]; outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; reasons: string[] }> }

/**
 * T99a's task: proposed with no `writes`, so its result's subject is the validation's report, which
 * names the run's worktree and the exact tree there. Its attempt runs, and the result is held for the
 * operator with tests and lint pending.
 */
async function heldResult(pilot: Pilot): Promise<{ task: BoardTask; runId: string; worktree: string }> {
  const { ctx } = pilot
  await charter(ctx, 'p1')
  const proposed = await ctx.board.propose({
    projectId: 'p1', title: 'make add() add', goal: 'Make add() add, with its tests passing', milestone: 'm1',
    acceptance: [{ id: 'a1', statement: 'npm test passes', check: 'tests' }], actionClass: 'workspace-write', template: 'algorithm-development',
  })
  await ctx.board.sweep(new Date())
  const run = await attempt(ctx, proposed.taskId)
  const done = await reported(ctx, run.runId)
  expect(done.task?.outcome).toMatchObject({ status: 'review', state: 'review' })
  const task = (await ctx.board.task(proposed.taskId))!
  expect(task.result!.subject).toMatchObject({ type: 'artifact' })
  const worktree = pilot.agent.runs.find((r) => r.role === 'develop')!.workspace
  return { task, runId: run.runId, worktree }
}

const landing = (pilot: Pilot, runId: string): TaskLanding | undefined => pilot.ctx.workflow.get(runId)?.task?.landing
const landed = (pilot: Pilot, runId: string, ...states: Array<TaskLanding['state']>): Promise<TaskLanding> =>
  until(() => {
    const l = landing(pilot, runId)
    return l && states.includes(l.state) ? l : undefined
  }, `the landing of run ${runId} to be ${states.join(' or ')}`)
const decisionsOf = (pilot: Pilot, l: TaskLanding): Decision[] => (l.decisions ?? []).map((d) => {
  const body = pilot.ctx.artifacts.get(d)!.body as Decision & { schema: string }
  new SchemaRegistry().assertRecord(body)
  return body
})
const mergeRequests = async (pilot: Pilot): Promise<ApprovalRequest[]> => (await pilot.ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.action.class === 'merge')
const commitOn = (pilot: Pilot, dir: string, file: string, text: string, message: string): string => {
  writeFileSync(join(dir, file), text)
  pilot.git(dir, 'add', file)
  pilot.git(dir, 'commit', '-q', '-m', message)
  return pilot.git(dir, 'rev-parse', 'HEAD')
}

describe('landing an accepted result (ADR-0060)', () => {
  it('T99a: an accepted result is no longer left uncommitted in its run\'s worktree: the system commits it on the run\'s branch, asks the operator to merge it, and merges it on the approval (REQ-WF-13, INV-5, INV-13)', async () => {
    const pilot = await boot()
    const { ctx } = pilot
    const { task, runId, worktree } = await heldResult(pilot)
    const accepted = captureGitSubject(worktree)!.subject
    expect(pilot.git(worktree, 'status', '--porcelain')).toContain('calc.py')
    // Held for the operator, nothing is committed or asked: the review is the operator's.
    expect(landing(pilot, runId)).toMatchObject({ state: 'watch', workspace: worktree, subject: { ref: pilot.head, version: accepted.version } })
    expect(await mergeRequests(pilot)).toEqual([])

    const acceptedTask = await operatorAccepts(ctx, task.taskId)
    expect(acceptedTask.state).toBe('done')
    const asked = await landed(pilot, runId, 'asked')
    const branch = `system/run/${runId}`

    // Committed on the run's branch by the system, on top of where the branch began, naming the task, the run, the reviewer, and the operator's acceptance.
    const head = pilot.git(pilot.repo, 'rev-parse', branch)
    expect(asked).toMatchObject({ branch, head, base: { branch: 'main', sha: pilot.head }, acceptance: acceptedTask.result!.acceptance })
    expect(pilot.git(pilot.repo, 'rev-parse', `${branch}^`)).toBe(pilot.head)
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%an <%ae>', branch)).toBe('system <system@localhost>')
    const message = pilot.git(pilot.repo, 'log', '-1', '--format=%B', branch)
    expect(message.split('\n')[0]).toBe(`system: land task ${task.taskId}: make add() add`)
    expect(message).toContain(`The result of run ${runId} on ${subjectId(accepted)}, accepted by the operator (acceptance decision ${acceptedTask.result!.acceptance}).`)
    expect(message).toMatch(/Reviewed on that tree: review:1 by agent:reviewer: approve\./)
    expect(message).toContain(`System-Task: ${task.taskId}\nSystem-Run: ${runId}\nSystem-Acceptance: ${acceptedTask.result!.acceptance}\nSystem-Subject: ${subjectId(accepted)}`)
    expect(pilot.git(pilot.repo, 'show', `${branch}:calc.py`)).toBe(FIXED.trim())
    expect(pilot.git(worktree, 'status', '--porcelain')).toBe('')
    // The repository's checkout is untouched until the operator approves the merge.
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(pilot.head)
    expect(pilot.git(pilot.repo, 'status', '--porcelain')).toBe('')

    // The commit is a recorded decision under the run's final step, which explain shows.
    const [commit] = decisionsOf(pilot, asked)
    expect(commit).toMatchObject({ decisionType: 'gate', decider: { id: 'workflow.landing' }, outcome: { option: 'commit', detail: { taskId: task.taskId, runId, step: 'commit', branch, head, committed: true, acceptance: acceptedTask.result!.acceptance } } })
    expect(commit!.inputs).toContain(acceptedTask.result!.acceptance)
    expect(ctx.workflow.explain(runId)!.nodes.find((n) => n.nodeId === 'validate:1')!.decisions.map((d) => d.id)).toContain(asked.decisions![0])

    // One merge request on the queue, bound to the base's and the branch's heads, showing the change.
    const [request, ...more] = await mergeRequests(pilot)
    expect(more).toEqual([])
    expect(request).toMatchObject({
      requestId: asked.requestId, state: 'open', subject: { type: 'git-head', ref: branch, version: `landing:merge:${pilot.head}:${head}` },
      action: { class: 'merge', summary: 'Merge the accepted result of task "make add() add" into main' }, requester: { component: 'workflow', runId, taskId: task.taskId, projectId: 'p1' },
    })
    expect(request!.action.consequences).toContain('calc.py | 2 +-')

    await decide(ctx, request!.requestId)
    const merged = await landed(pilot, runId, 'merged')
    const mergeCommit = pilot.git(pilot.repo, 'rev-parse', 'HEAD')
    expect(merged.commit).toBe(mergeCommit)
    expect(pilot.git(pilot.repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%P', 'HEAD')).toBe(`${pilot.head} ${head}`)
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%an <%ae>|%s', 'HEAD')).toBe(`system <system@localhost>|system: merge task ${task.taskId}: make add() add`)
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%B', 'HEAD')).toContain(`System-Landing: landing:merge:${pilot.head}:${head}`)
    expect(readFileSync(join(pilot.repo, 'calc.py'), 'utf8')).toBe(FIXED)
    expect(pilot.git(pilot.repo, 'status', '--porcelain')).toBe('')
    expect(pilot.git(pilot.repo, 'remote')).toBe('')
    expect(decisionsOf(pilot, merged).at(-1)).toMatchObject({ decider: { id: 'workflow.landing' }, outcome: { option: 'merge', detail: { step: 'merge', commit: mergeCommit, already: false, requestId: request!.requestId } } })
    expect(ctx.eventLog.query({ type: 'workflow.task.landing', runId }).map((e) => e.data?.['state'])).toEqual(['commit', 'committed', 'asked', 'merging', 'merged'])

    // Each step done again, as after a restart, finds its work done and does nothing twice (INV-4).
    expect(await ctx.workers.land!({ step: 'commit', runId, workspace: worktree, subject: { ref: pilot.head, version: accepted.version }, message: 'again' })).toMatchObject({ outcome: 'committed', committed: false, head, contained: true })
    expect(await ctx.workers.land!({ step: 'merge', runId, workspace: worktree, head, base: { branch: 'main', sha: pilot.head }, message: 'again' })).toMatchObject({ outcome: 'merged', commit: mergeCommit, already: true })
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(mergeCommit)
  })

  it('commits nothing when the worktree moved after the acceptance: refused with a decision, the tree left as it is, nothing asked (REQ-WF-13, INV-5, INV-2)', async () => {
    const pilot = await boot()
    const { ctx } = pilot
    const { task, runId, worktree } = await heldResult(pilot)
    writeFileSync(join(worktree, 'later.txt'), 'written after the review\n')
    await operatorAccepts(ctx, task.taskId)
    const refused = await landed(pilot, runId, 'refused')
    expect(refused).toMatchObject({ cause: 'moved', reason: expect.stringMatching(/changed after the acceptance, so nothing is committed/) })
    expect(decisionsOf(pilot, refused)).toEqual([expect.objectContaining({ decider: expect.objectContaining({ id: 'workflow.landing' }), outcome: expect.objectContaining({ option: 'refuse', detail: expect.objectContaining({ step: 'commit', cause: 'moved' }) }) })])
    expect(pilot.git(pilot.repo, 'rev-parse', `system/run/${runId}`)).toBe(pilot.head)
    expect(pilot.git(worktree, 'diff', '--name-only')).toBe('calc.py')
    expect(pilot.git(worktree, 'ls-files', '--others', '--exclude-standard')).toBe('later.txt')
    expect(await mergeRequests(pilot)).toEqual([])
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(pilot.head)
  })

  it('refuses a merge that conflicts with the base and leaves the repository as it was; the branch keeps its commit (REQ-WF-13, INV-2)', async () => {
    const pilot = await boot()
    const { ctx } = pilot
    const { task, runId } = await heldResult(pilot)
    // The operator changed the same line on main before accepting.
    const base = commitOn(pilot, pilot.repo, 'calc.py', 'def add(a, b):\n    return b + a\n', 'operator: add the other way')
    await operatorAccepts(ctx, task.taskId)
    const asked = await landed(pilot, runId, 'asked')
    expect(asked.base).toEqual({ branch: 'main', sha: base })
    await decide(ctx, asked.requestId!)
    const refused = await landed(pilot, runId, 'refused')
    expect(refused).toMatchObject({ cause: 'conflict', reason: expect.stringMatching(/conflicts with main at [0-9a-f]+ in calc\.py: the merge was aborted, and the repository is as it was/) })
    expect(decisionsOf(pilot, refused).at(-1)).toMatchObject({ outcome: { option: 'refuse', detail: { step: 'merge', cause: 'conflict' } } })
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(base)
    expect(pilot.git(pilot.repo, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(pilot.repo, 'calc.py'), 'utf8')).toBe('def add(a, b):\n    return b + a\n')
    expect(pilot.git(pilot.repo, 'rev-parse', `system/run/${runId}`)).toBe(asked.head)
  })

  it('asks again on the base as it is when the base moved after the approval was asked, and merges on the new approval; a denial merges nothing (REQ-WF-13, INV-5)', async () => {
    const pilot = await boot()
    const { ctx } = pilot
    const { task, runId } = await heldResult(pilot)
    await operatorAccepts(ctx, task.taskId)
    const first = await landed(pilot, runId, 'asked')
    // Another change lands on main meanwhile (a file the branch does not touch).
    const moved = commitOn(pilot, pilot.repo, 'README.md', 'calc\n', 'operator: a readme')
    await decide(ctx, first.requestId!)
    const again = await until(() => {
      const l = landing(pilot, runId)
      return l?.state === 'asked' && l.requestId !== first.requestId ? l : undefined
    }, 'the merge asked again on the moved base')
    expect(again.base).toEqual({ branch: 'main', sha: moved })
    expect(decisionsOf(pilot, again).map((d) => [d.outcome.option, d.outcome.detail['cause']])).toEqual([['commit', undefined], ['refuse', 'base-moved'], ['commit', undefined]])
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(moved)
    const requests = await mergeRequests(pilot)
    expect(requests.map((r) => [r.state, r.subject.version])).toEqual(expect.arrayContaining([['approved', `landing:merge:${pilot.head}:${first.head}`], ['open', `landing:merge:${moved}:${first.head}`]]))

    // Denied: nothing is merged, and the branch keeps its commit for the operator.
    await decide(ctx, again.requestId!, 'rejected')
    const rejected = await landed(pilot, runId, 'rejected')
    expect(rejected.reason).toMatch(/was not approved \(the operator denied it\): nothing is merged/)
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(moved)
    expect(pilot.git(pilot.repo, 'rev-parse', `system/run/${runId}`)).toBe(first.head)
  })
})
