import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { captureGitSubject, SchemaRegistry, subjectId } from '@tsuuanmi/system-libs'
import type { TaskLanding } from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attempt, bootPilot, charter, decide, FIXED, operatorAccepts, type Pilot, reported, type Script, until } from './pilot.ts'

// Landing an accepted result (ADR-0060): the pilot in miniature, over a scratch repository, with
// the real engine, board, approval queue, and agents source with a worktree per run.
vi.setConfig({ testTimeout: 120_000 })

const pilots: Pilot[] = []
afterEach(async () => {
  while (pilots.length) await pilots.pop()!.dispose()
})
const boot = async (script: Script = {}): Promise<Pilot> => {
  const pilot = await bootPilot(script)
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

  it('rebases a result whose base gained a conflicting change before the merge is asked: the conflict goes to a writing step on the result\'s author\'s Worker, told what moved, and the merge is asked on its resolution (ADR-0068, REQ-WF-13, INV-5)', async () => {
    const pilot = await boot()
    const { ctx } = pilot
    const { task, runId, worktree } = await heldResult(pilot)
    // The operator changed the same line on main before accepting.
    const base = commitOn(pilot, pilot.repo, 'calc.py', 'def add(a, b):\n    return b + a\n', 'operator: add the other way')
    await operatorAccepts(ctx, task.taskId)
    const asked = await landed(pilot, runId, 'asked')
    expect(asked.base).toEqual({ branch: 'main', sha: base })
    expect(asked.rebase).toMatchObject({ fork: pilot.head, base: { branch: 'main', sha: base }, files: ['calc.py'], head: asked.head })
    expect(decisionsOf(pilot, asked).map((d) => d.outcome.option)).toEqual(['commit', 'resolve', 'rebase'])
    // The resolving step ran in the run's worktree, told what moved and to keep main's behaviour.
    const resolving = pilot.agent.runs.at(-1)!
    expect(resolving.workspace).toBe(worktree)
    expect(resolving.prompt).toMatch(/What moved: main went from [0-9a-f]+ to [0-9a-f]+, with these commits \(newest first\):\n- [0-9a-f]+ operator: add the other way/)
    expect(resolving.prompt).toContain('These files have conflicts, marked with <<<<<<< and >>>>>>> lines: calc.py.')
    expect(resolving.prompt).toContain('main\'s behaviour must be kept')
    // The branch now holds the resolution on top of the base, and nothing was merged yet.
    const branch = `system/run/${runId}`
    expect(pilot.git(pilot.repo, 'rev-parse', branch)).toBe(asked.head)
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%P', branch)).toBe(base)
    expect(pilot.git(pilot.repo, 'show', `${branch}:calc.py`)).toBe(FIXED.trim())
    expect(pilot.git(worktree, 'status', '--porcelain')).toBe('')
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(base)
    const [request] = (await mergeRequests(pilot)).filter((r) => r.state === 'open')
    expect(request!.subject.version).toBe(`landing:merge:${base}:${asked.head}`)
    // The operator's acceptance spent the one attempt; the rebase spent none.
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })
    await decide(ctx, asked.requestId!)
    const merged = await landed(pilot, runId, 'merged')
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(merged.commit)
    expect(readFileSync(join(pilot.repo, 'calc.py'), 'utf8')).toBe(FIXED)
    expect(pilot.git(pilot.repo, 'status', '--porcelain')).toBe('')
  })

  it('gives the conflict to the developer that wrote the result, not to the Worker that validated it, on its task\'s brief: the resolving run reserves and draws within the task\'s and the project\'s caps (ADR-0068, ADR-0057, INV-6)', async () => {
    const pilot = await boot({ writers: { developer: ['code', 'docs', 'tests'], tester: ['validation'] } })
    const { ctx } = pilot
    const { task, runId, worktree } = await heldResult(pilot)
    const nodes = ctx.workflow.get(runId)!.nodes
    // Both wrote in the run's worktree on a writing sandbox; only develop:1 wrote the result.
    expect(nodes.find((n) => n.nodeId === 'develop:1')!.worker).toBe('agent:developer')
    expect(nodes.find((n) => n.nodeId === 'validate:1')!.worker).toBe('agent:tester')
    commitOn(pilot, pilot.repo, 'calc.py', 'def add(a, b):\n    return b + a\n', 'operator: add the other way')
    await operatorAccepts(ctx, task.taskId)
    const asked = await landed(pilot, runId, 'asked')
    expect(decisionsOf(pilot, asked).map((d) => d.outcome.option)).toEqual(['commit', 'resolve', 'rebase'])
    expect(decisionsOf(pilot, asked)[1]!.outcome.detail).toMatchObject({ step: 'resolve', nodeId: 'develop:1', worker: 'agent:developer' })
    const executionId = asked.rebase!.executionId!
    const run = ctx.store.db.prepare('SELECT worker, workflow_run_id, task_id, project_id FROM agent_runs WHERE run_id = ?').get(executionId)
    expect(run).toEqual({ worker: 'agent:developer', workflow_run_id: runId, task_id: task.taskId, project_id: 'p1' })
    expect(pilot.agent.runs.at(-1)).toMatchObject({ role: 'develop', workspace: worktree })
    // Its reservation names the task and the project, so their caps hold it, as for any step of the task's run.
    const reservations = ctx.store.db.prepare('SELECT task_id, project_id FROM resource_reservations WHERE run_id = ?').all(executionId)
    expect(reservations.length).toBeGreaterThan(0)
    expect(reservations).toEqual(reservations.map(() => ({ task_id: task.taskId, project_id: 'p1' })))
    expect(pilot.git(pilot.repo, 'show', `system/run/${runId}:calc.py`)).toBe(FIXED.trim())
  })

  it('asks again on the base as it is when the base moved after the approval was asked, the result rebased onto it first; a denial merges nothing (ADR-0068, REQ-WF-13, INV-5)', async () => {
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
    // It moved with no conflict: rebased by the source alone, no writing step, no attempt spent.
    expect(decisionsOf(pilot, again).map((d) => [d.outcome.option, d.outcome.detail['cause']])).toEqual([['commit', undefined], ['refuse', 'base-moved'], ['commit', undefined], ['rebase', undefined]])
    expect(again.rebase).toMatchObject({ from: first.head, fork: pilot.head, base: { branch: 'main', sha: moved }, count: 0 })
    expect(again.head).not.toBe(first.head)
    const branch = `system/run/${runId}`
    expect(pilot.git(pilot.repo, 'log', '-1', '--format=%P', again.head!)).toBe(moved)
    expect(pilot.git(pilot.repo, 'show', `${again.head}:calc.py`)).toBe(FIXED.trim())
    expect(pilot.git(pilot.repo, 'show', `${again.head}:README.md`)).toBe('calc')
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(moved)
    const requests = await mergeRequests(pilot)
    expect(requests.map((r) => [r.state, r.subject.version])).toEqual(expect.arrayContaining([['approved', `landing:merge:${pilot.head}:${first.head}`], ['open', `landing:merge:${moved}:${again.head}`]]))
    expect(requests.find((r) => r.state === 'open')!.action.consequences).toContain(`main moved since the result's work started (from ${pilot.head}): the result was rebased onto it from ${first.head}; no check ran on the rebased tree, as no command check ran on the result at its acceptance.`)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'done', attempts: { count: 1 } })

    // Denied: nothing is merged, and the branch keeps its rebased commit for the operator.
    await decide(ctx, again.requestId!, 'rejected')
    const rejected = await landed(pilot, runId, 'rejected')
    expect(rejected.reason).toMatch(/was not approved \(the operator denied it\): nothing is merged/)
    expect(pilot.git(pilot.repo, 'rev-parse', 'HEAD')).toBe(moved)
    expect(pilot.git(pilot.repo, 'rev-parse', branch)).toBe(again.head)
  })
})
