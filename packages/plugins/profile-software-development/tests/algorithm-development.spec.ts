import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { captureGitSubject, subjectId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attempt, bootPilot, charter, decide, EVIDENCE, FIXED, MEASURED, ORIGINAL, operatorAccepts, type Pilot, propose, queued, reported, until } from './pilot.ts'

// The algorithm-development template end to end (PROP-0010 B8, T267): one attempt of a board task,
// over the real board, approval queue, ledger, digests, and agents source with a worktree per run;
// only the agent runtime is scripted.
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

/** A review guide (docs/design/handbook.md#review-guides-reviewmd) for the paths it names. */
const guide = (title: string, paths: string[]): string => [
  '---', 'paths:', ...paths.map((p) => `  - ${p}`), 'owner: lead', 'version: 1', '---', `# Review guide: ${title}`, '',
  '## What failure looks like here', `- ${title} fails like this.`, '', '## What to check first', '1. The thing.', '', '## Paths to skip', '- None.', '',
  '## Nit cap', 'At most 3 nits.', '', '## Evidence rule', 'A file and a line.', '', '## Summary rule', 'Open with the count.', '',
].join('\n')

describe('the algorithm-development template (PROP-0010 B8, T267)', () => {
  it('runs one attempt of a board task: develop in the run\'s worktree and show the checks\' output in the dossier, the author\'s own review in a new session, an exact-subject review whose fix waits on the approval queue last, then the result held for the operator with its digest (REQ-WF-5, REQ-WF-9, REQ-WRK-6, INV-15)', async () => {
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
    const reviewed = /^Subject: (\S+)$/m.exec(agent.runs.filter((r) => r.role === 'review')[0]!.prompt)![1]!
    expect(request).toMatchObject({
      action: { class: 'remediation' }, requester: { component: 'workflow', runId: run.runId },
      subject: { type: 'artifact', ref: waiting.plan, version: reviewed },
    })
    // The author verified, then reviewed its own change in a run of its own, before the independent review started.
    expect(agent.runs.map((r) => r.role)).toEqual(['develop', 'selfreview', 'review', 'verify'])
    await decide(ctx, request.requestId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.state])).toEqual([
      ['develop:1', 'COMPLETED'], ['selfreview:1', 'COMPLETED'], ['review:1', 'COMPLETED'], ['review:1:verify', 'COMPLETED'], ['review:1:approve:1', 'COMPLETED'], ['review:1:fix:1', 'COMPLETED'], ['review:1:review:2', 'COMPLETED'],
    ])

    // Every step of the run worked in the run's own worktree, on its branch; the repository's tree is untouched. There is no validation step.
    const work = agent.runs.filter((r) => r.role !== 'digest')
    expect(work.map((r) => [r.role, r.sandbox])).toEqual([
      ['develop', 'workspace-write'], ['selfreview', 'read-only'], ['review', 'read-only'], ['verify', 'read-only'], ['fix', 'workspace-write'], ['review', 'read-only'],
    ])
    expect(done.nodes.some((n) => n.nodeId.startsWith('validate'))).toBe(false)
    const worktree = work[0]!.workspace
    expect(basename(worktree)).toBe(run.runId)
    for (const r of work) expect(r.workspace).toBe(worktree)
    expect(pilot.git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(`system/run/${run.runId}`)
    expect(readFileSync(join(worktree, 'calc.py'), 'utf8')).toBe(FIXED)
    expect(existsSync(join(worktree, 'test_calc.py'))).toBe(true)
    untouched(pilot)

    // The author's checks' output is in the dossier as its own evidence entry, before anything reviewed it;
    // the review's fix showed the checks' output again, for the tree it left.
    expect(agent.appended).toEqual([expect.objectContaining({ isError: false }), expect.objectContaining({ isError: false })])
    const entries = ctx.workflow.dossier({ taskId: task.taskId }).entries
    const shown = entries.filter((e) => e.kind === 'evidence' && e.author.type === 'worker')
    expect(shown.map((e) => [e.author.nodeId, e.text])).toEqual([['develop:1', EVIDENCE], ['review:1:fix:1', EVIDENCE]])
    expect(shown[0]).toMatchObject({ author: { type: 'worker', ref: 'agent:developer' } })
    expect(work[4]!.prompt).toContain('run the checks the task requires again on the fixed tree')

    // One task, one author session (T232): the fix continued develop:1's session, and the change the
    // review read and the fix's result are each a commit of the run's review history, while the
    // worktree's HEAD stays the commit the task writes, so its result and checks still bind (below).
    expect(work[4]!.resume).toBe('h-1')
    const history = `refs/system/reviews/${run.runId}`
    expect(pilot.git(worktree, 'rev-parse', 'HEAD')).toBe(pilot.head)
    expect(pilot.git(worktree, 'log', '--format=%s', history).split('\n')).toEqual([
      `system: review:1:fix:1 of run ${run.runId}, the fix of review review:1's blocking findings`,
      expect.stringMatching(/^system: the change review review:1 of run \S+ read \(git:/),
      'init',
    ])
    expect(pilot.git(worktree, 'show', '--name-only', '--format=', history)).toBe('test_calc.py')
    expect(pilot.git(worktree, 'show', '--name-only', '--format=', `${history}~1`)).toBe('calc.py')
    expect(pilot.git(worktree, 'rev-parse', `${history}~2`)).toBe(pilot.head)
    expect(pilot.git(worktree, 'status', '--porcelain', '--', 'calc.py', 'test_calc.py')).toBe('M calc.py\n?? test_calc.py')

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
    // The review and its re-review read and judge, and run no test or build: its author showed the checks' output; an environment limit is at most a nit.
    for (const review of reviews) {
      expect(asked(review.prompt)).toContain('you never run the project\'s tests or builds')
      expect(asked(review.prompt)).toContain('A command you could not run is not a finding about the change; an environment limit is at most a nit.')
      expect(review.prompt).toContain('never run the project\'s tests or builds, which the run\'s required checks run.')
    }
    // Its brief holds the dossier, so the reviewer sees the author's evidence.
    expect(reviews[0]!.prompt).toContain(MEASURED)

    // The writer was given the order to verify; no step runs the validation.
    expect(work[0]!.prompt).toContain('Fix add() so it adds')
    expect(work[0]!.prompt).toContain('append their real output, verbatim, to the task\'s dossier as an evidence entry')
    expect(agent.calls.filter((c) => c.tool === 'Bash')).toEqual([])
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).map((r) => r.action.class).sort()).toEqual(['charter', 'remediation'])

    // The result is the review's report on the exact subject the task writes; the review check passed on it.
    const held = await until(async () => {
      const t = await ctx.board.task(task.taskId)
      return t?.result?.digest ? t : undefined
    }, 'the digest on the task\'s result')
    expect(held).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
    expect(held.result!.subject).toEqual({ type: 'git-head', ref: pilot.head, version: final.version })
    const acceptance = ctx.artifacts.get(done.task!.outcome!.decision!)!.body as { decider: { id: string }; outcome: { option: string; detail: { checks: Record<string, boolean> } } }
    expect(acceptance).toMatchObject({ decider: { id: 'workflow.task-acceptance' }, outcome: { option: 'accept', detail: { checks: { review: true } } } })

    // The digest cites the result, quoted verbatim.
    const digest = ctx.artifacts.get(held.result!.digest!)!.body as { sources: ArtifactRef[]; claims: Array<{ citation: { quote: string } }> }
    expect(digest.sources).toEqual(held.result!.artifacts)
    expect(digest.claims[0]!.citation.quote).toBe('```json')

    // Every run was metered on the pool, and the operator's acceptance on /ui makes the task done.
    expect((await ctx.resources.usage({ pool: 'plan.agents' })).records).toHaveLength(agent.runs.length)
    expect((await operatorAccepts(ctx, task.taskId)).state).toBe('done')
  })

  it('has no validate step: the template\'s steps are develop, the author\'s self-review, and the review (T267)', async () => {
    const pilot = await boot()
    expect(pilot.ctx.workflow.templateSteps('algorithm-development')!.map((s) => s.nodeId)).toEqual(['develop:1', 'selfreview:1', 'review:1'])
  })

  it('refuses a develop step at its end that shows no output of its checks in the dossier: nothing reviews it, the failure is the attempt\'s, and a gate decision says why (T267, INV-2, INV-13)', async () => {
    const pilot = await boot({ evidence: false })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const failed = await reported(ctx, run.runId)
    expect(failed.status).toBe('failed')
    expect(failed.nodes.find((n) => n.nodeId === 'develop:1')).toMatchObject({ state: 'FAILED' })
    expect(JSON.stringify(failed.nodes.find((n) => n.nodeId === 'develop:1'))).toContain('evidence_missing')
    // Developed and nothing else: neither the self-review nor the review was started.
    expect(agent.runs.map((r) => r.role)).toEqual(['develop'])
    expect(failed.nodes.find((n) => n.nodeId === 'selfreview:1')!.state).toBe('WAITING')
    const gate = ctx.workflow.explain(run.runId)!.nodes.find((n) => n.nodeId === 'develop:1')!.decisions.map((d) => ctx.artifacts.get(d.id as ArtifactRef)!.body as { decider: { id: string }; outcome: { option: string } }).find((b) => b.decider.id === 'workflow.evidence')!
    expect(gate.outcome.option).toBe('refuse')
    expect(ctx.workflow.dossier({ taskId: task.taskId }).entries.some((e) => e.kind === 'evidence' && e.author.type === 'worker')).toBe(false)
    expect(failed.task).toMatchObject({ outcome: { status: 'reconciled' } })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready', attempts: { count: 1 } })
    untouched(pilot)
  })

  it('refuses evidence that shows no checks\' output: an entry that only says it is done ends the step as one with none (T267)', async () => {
    const pilot = await boot({ evidenceText: 'done' })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const failed = await reported(ctx, run.runId)
    expect(failed.status).toBe('failed')
    expect(agent.appended).toEqual([expect.objectContaining({ isError: false })])
    expect(agent.runs.map((r) => r.role)).toEqual(['develop'])
    const develop = JSON.stringify(failed.nodes.find((n) => n.nodeId === 'develop:1'))
    expect(develop).toContain('evidence_missing')
    expect(develop).toContain('reports 0 exit codes')
  })

  it('never admits a develop step to a Worker that could not show its checks\' output: with no dossier tool, it fails admission and nothing is sent (T267, INV-2)', async () => {
    const pilot = await boot({ hostTools: false })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const failed = await reported(ctx, run.runId)
    expect(failed.status).toBe('failed')
    expect(failed.nodes.find((n) => n.nodeId === 'develop:1')).toMatchObject({ state: 'FAILED' })
    expect(agent.runs.filter((r) => r.role !== 'digest')).toEqual([])
    expect(JSON.stringify(ctx.workflow.explain(run.runId)!.nodes.find((n) => n.nodeId === 'develop:1'))).toContain('dossier')
    untouched(pilot)
  })

  it('runs the author\'s own review in a new session on the author\'s account, and answers its confirmed important findings in the author\'s session before the independent review starts, with no approval gate (T267, ADR-0075)', async () => {
    const pilot = await boot({ selfChanges: 1 })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    // The self-review asked for a change, a second reviewer confirmed it (ADR-0075); the author fixed it, the self-review ran again, and only then the review started.
    expect(done.nodes.map((n) => [n.nodeId, n.state, n.worker ?? null])).toEqual([
      ['develop:1', 'COMPLETED', 'agent:developer'], ['selfreview:1', 'COMPLETED', 'agent:reviewer'], ['selfreview:1:verify', 'COMPLETED', 'agent:reviewer'], ['selfreview:1:fix:1', 'COMPLETED', 'agent:developer'],
      ['selfreview:1:review:2', 'COMPLETED', 'agent:reviewer'], ['review:1', 'COMPLETED', 'agent:reviewer'],
    ])
    expect(agent.runs.map((r) => r.role).filter((role) => role !== 'digest')).toEqual(['develop', 'selfreview', 'verify', 'fix', 'selfreview', 'review'])
    const work = agent.runs.filter((r) => r.role !== 'digest')
    // A new session: the self-review resumes no conversation (its own), and never the author's; the fix continues the author's.
    expect(work[1]!.resume).toBeUndefined()
    expect(work[4]!.resume).toBeUndefined()
    expect(work[5]!.resume).toBeUndefined()
    expect(work[3]!.resume).toBe('h-1')
    // A fresh context: its prompt holds the goal and the diff, never the author's answer, its orders (the
    // caller's input), or the dossier (the author's evidence and progress); it is given no file, and the
    // engine refuses its dossier_read. The independent review, after it, is given the dossier.
    for (const r of [work[1]!, work[4]!]) {
      expect(r.prompt).toContain('You wrote this change in an earlier session you cannot see')
      expect(r.prompt).toContain('Goal: Make add() add, with its tests passing')
      expect(r.prompt).toContain('Requested change: Make add() add, with its tests passing')
      expect(r.prompt).not.toContain('Hypothesis:')
      expect(r.prompt).not.toContain('Fix add() so it adds')
      expect(r.prompt).not.toContain('Dossier of board task')
      expect(r.prompt).not.toContain(MEASURED)
    }
    // The first reads the whole change; its re-review only the change since, with the open finding (ADR-0075).
    expect(work[1]!.prompt).toContain('+    return a + b')
    expect(work[4]!.prompt).toContain('- selfreview:1#f1 important: a stray debug line (calc.py:2)')
    expect(work[4]!.prompt).toContain('+assert True')
    expect(work[4]!.prompt).not.toContain('+    return a + b')
    for (const id of ['selfreview:1', 'selfreview:1:review:2']) {
      const brief = ctx.artifacts.get(done.nodes.find((n) => n.nodeId === id)!.brief!)!.body as { files?: unknown[]; artifacts: Array<{ ref: ArtifactRef }> }
      expect(brief.files, id).toBeUndefined()
      expect(brief.artifacts.map((p) => ctx.artifacts.get(p.ref)?.bodySchema), id).not.toContain('task-dossier@1.0')
    }
    expect(agent.selfReads).toEqual([expect.objectContaining({ isError: true, text: expect.stringContaining('never the task\'s dossier') }), expect.objectContaining({ isError: true })])
    // Nor can it read the dossier the author's step was given from the shared worktree: its `.system/`
    // holds only its own brief's files, none, by the time it starts.
    expect(agent.selfFiles).toEqual([{ dossier: false, tasks: false }, { dossier: false, tasks: false }])
    expect(work[5]!.prompt).toContain('Dossier of board task')
    // The author's fix showed the checks' output again, for the tree it left.
    expect(agent.appended).toHaveLength(2)
    expect(work[3]!.prompt).toContain('run the checks the task requires again on the fixed tree')
    // The fix is the author answering its own review: no request in the queue but the charter.
    expect((await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).map((r) => r.action.class)).toEqual(['charter'])
    // The independent review read the change as fixed, and the self-review counts for nothing the review decides.
    const final = captureGitSubject(work[0]!.workspace)!.subject
    expect(/^Subject: (\S+)$/m.exec(work[5]!.prompt)![1]).toBe(subjectId(final))
    const acceptance = ctx.artifacts.get(done.task!.outcome!.decision!)!.body as { outcome: { detail: { checks: Record<string, boolean> } } }
    expect(acceptance.outcome.detail.checks.review).toBe(true)
    expect(ctx.workflow.explain(run.runId)!.risk).toBeUndefined()
  })

  it('gives a review the review guides of the areas its change touches, and only those: the self-review and the review, never the writer (T267)', async () => {
    const pilot = await boot({
      guides: {
        'python.REVIEW.md': guide('python code', ['*.py']),
        'docs.REVIEW.md': guide('the documentation', ['docs/']),
        'broken.REVIEW.md': '# no front matter\n',
      },
    })
    const { ctx, agent } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    expect((await reported(ctx, run.runId)).status).toBe('completed')
    const prompt = (role: string): string => agent.runs.find((r) => r.role === role)!.prompt
    for (const role of ['selfreview', 'review']) {
      // calc.py is the change: the guide of its area is in the brief, the other is not, and the one that does not parse is named, not dropped.
      expect(prompt(role), role).toContain('# Review guide: python code')
      expect(prompt(role), role).not.toContain('# Review guide: the documentation')
      expect(prompt(role), role).toContain('broken.REVIEW.md: no front matter')
      expect(prompt(role), role).toContain('1 left out: no changed path is in their area')
    }
    expect(prompt('develop')).not.toContain('Review guide')
    // The guide is an artifact the brief points at, with its version and hash, so a result traces to the rules it was reviewed by.
    const brief = ctx.artifacts.get(ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === 'review:1')!.brief!)!.body as { artifacts: Array<{ ref: ArtifactRef; role: string }> }
    const pointed = brief.artifacts.map((p) => ctx.artifacts.get(p.ref)).find((a) => a?.bodySchema === 'review-guides@1.0')!
    expect(pointed.body).toMatchObject({ guides: [{ file: 'docs/review/python.REVIEW.md', version: 1, owner: 'lead' }], left: 1, problems: [expect.stringContaining('broken.REVIEW.md')] })
  })

  /** The candidates of a step's route decision: who was refused it, and why. */
  const routed = (ctx: Pilot['ctx'], runId: string, nodeId: string): Array<{ option: string; selected: boolean; reasons: string[] }> => {
    const routeId = ctx.workflow.explain(runId)!.nodes.find((n) => n.nodeId === nodeId)!.decisions.find((d) => d.type === 'route')!.id
    return (ctx.artifacts.get(routeId as ArtifactRef)!.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }).candidates
  }

  it('routes by kind of work when the operator gives Workers kinds: every writing step and its fix on the writer given code, docs, and tests, both reviews on the reviewer given none; the tests variant writes on the same writer (REQ-WRK-11, ADR-0057)', async () => {
    const pilot = await boot({ changes: 1, writers: { developer: ['code', 'docs', 'tests'] } })
    const { ctx } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    await decide(ctx, (await queued(ctx, run.runId)).approvalRequest)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([
      ['develop:1', 'agent:developer'], ['selfreview:1', 'agent:reviewer'], ['review:1', 'agent:reviewer'], ['review:1:verify', 'agent:reviewer'], ['review:1:approve:1', undefined], ['review:1:fix:1', 'agent:developer'],
      ['review:1:review:2', 'agent:reviewer'],
    ])
    // The reviewer given no kinds took both reviews; the writer, which is given kinds, took neither (it proves no review either).
    expect(routed(ctx, run.runId, 'selfreview:1').find((c) => c.selected)!.option).toBe('agent:reviewer')
    // The tests variant of the same template: its develop step is tests work, still on the writer (once the
    // first task is done, as one subject has one writer, INV-15).
    expect((await operatorAccepts(ctx, task.taskId)).state).toBe('done')
    const tests = await propose(pilot, 'p1', 'test add()')
    const written = await ctx.workflow.start({ template: 'algorithm-development', variant: 'tests', input: 'Test what add() returns', classification: 'operator-shared', task: { taskId: tests.taskId } })
    const finished = await reported(ctx, written.runId)
    expect(finished.nodes.find((n) => n.nodeId === 'develop:1')!.worker).toBe('agent:developer')
    expect(routed(ctx, written.runId, 'develop:1').find((c) => c.selected)!.reasons).toContain('takes tests work, one of its kinds')
  })

  it('routes a step by the kind the row configures: develop:1 configured as docs work runs on the writer given docs and tests (ADR-0057)', async () => {
    const pilot = await boot({ writers: { developer: ['code'], tester: ['docs', 'tests'] }, profile: { kinds: { develop: 'docs' } } })
    const { ctx } = pilot
    await charter(ctx, 'p1')
    const task = await propose(pilot, 'p1', 'make add() add')
    const run = await attempt(ctx, task.taskId)
    const done = await reported(ctx, run.runId)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([['develop:1', 'agent:tester'], ['selfreview:1', 'agent:reviewer'], ['review:1', 'agent:reviewer']])
    expect(routed(ctx, run.runId, 'develop:1').find((c) => c.selected)!.reasons).toContain('takes docs work, one of its kinds')
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
