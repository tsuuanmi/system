/**
 * The scheduled review (board T290, D93 item 8): one area of a repository a day, read whole at the tip
 * of its branch, reviewed at the frontier tier, each important finding voted on by a second reviewer
 * of another family, each confirmed one proposed as a board task with its evidence, at most a cap a
 * run, never twice while the task is open. End to end over the store-backed board and approval queue
 * and a git repository with a planted defect; only Worker execution is scripted. Every instant a test
 * reads is a fixed one handed to the review, never the wall clock.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { activeProject, CONFIG, type Rendered, ScriptedWorkers } from '../conformance/workflow.ts'
import Workflow, { checkConfig, type ScheduledReviewConfig, SCHEDULED_REVIEW_NODES, type ScheduledReviewRow } from '../src/index.ts'
import { type AreaFile, areaOf, citesShown, dayOf, pickArea, scheduledReviewProblems, scheduledReviewSettings, selectFiles } from '../src/scheduled-review.ts'
import { parseGuide } from '../src/review-guides.ts'

vi.setConfig({ testTimeout: 120_000 })

const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio',
  rules: [{ actionClass: 'read', mode: 'auto' }], default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/** Two frontier reviewers of two provider families: the second reviewer prefers the family the first did not run on. */
const WORKERS = [
  worker('w:reviewer-a', { schema: 'capability-descriptor@1.3', family: 'family-a', tier: 'frontier', proves: ['review', 'local-data'] }),
  worker('w:reviewer-b', { schema: 'capability-descriptor@1.3', family: 'family-b', tier: 'frontier', proves: ['review', 'local-data'] }),
]

const section = (name: string): string => `## ${name}\n\nSay what is wrong at the line.\n`
const guide = (paths: string[], area: string): string => [
  '---', 'paths:', ...paths.map((p) => `  - ${p}`), 'owner: lead', 'version: 2', '---', `# Review guide: ${area}`, '',
  ...['What failure looks like here', 'What to check first', 'Paths to skip', 'Nit cap', 'Evidence rule', 'Summary rule'].map(section),
].join('\n')

const PLANTED = 'def add(a, b):\n    return a - b\n'
/** Thirty lines, so several findings can each cite a line of their own. */
const LONG = `${Array.from({ length: 15 }, (_, i) => `def f${i + 1}(a):\n    return a + ${i}`).join('\n')}\n`

/** A repository whose `dev` holds a guide for one area, `calc/`, with a planted defect in it; `extra` areas each add a guide and a file. */
function repository(files: Record<string, string> = { 'calc/calc.py': PLANTED }, extra: string[] = []): { dir: string; sha: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'system-scheduled-review-repo-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'dev')
  mkdirSync(join(dir, 'docs/review'), { recursive: true })
  writeFileSync(join(dir, 'docs/review/calc.REVIEW.md'), guide(['calc/'], 'calc'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  for (const area of extra) {
    mkdirSync(join(dir, area), { recursive: true })
    writeFileSync(join(dir, `docs/review/${area}.REVIEW.md`), guide([`${area}/`], area))
    writeFileSync(join(dir, area, 'main.py'), 'print("hello")\n')
  }
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { dir, sha: () => git('rev-parse', 'dev').trim() }
}

const finding = (title: string, line: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  severity: 'important', title, file: 'calc/calc.py', line, evidence: `line ${line} returns the wrong value, so the call gives the wrong answer`, class: 'arithmetic sign', ...extra,
})

/** What the scripted reviewers answer: the first reviewer's findings, the second reviewer's vote on each important one. */
interface Script {
  findings: () => Array<Record<string, unknown>>
  vote?: 'confirm' | 'reject'
  /** The first reviewer's answer waits until the test releases it ({@link reviewAnswer}). */
  holdReview?: boolean
  /** The reviewers the runtime offers (default {@link WORKERS}: two families). */
  workers?: typeof WORKERS
}

/** The first reviewer's answer to a prompt: its findings on the subject the prompt names. */
const reviewAnswer = (prompt: string, findings: Array<Record<string, unknown>>): { text: string } =>
  ({ text: '```json\n' + JSON.stringify({ subject: /^Subject: (\S+)$/m.exec(prompt)?.[1], verdict: 'changes-requested', findings }) + '\n```' })

async function boot(dir: string, script: Script, scheduledReview: ScheduledReviewConfig = {}): Promise<{ ctx: Context; workers: ScriptedWorkers; restart: () => Promise<void> }> {
  const data = mkdtempSync(join(tmpdir(), 'system-scheduled-review-'))
  const ctx = new Context()
  const workers = new ScriptedWorkers()
  workers.extra = script.workers ?? WORKERS
  let reported: Array<Record<string, unknown>> = []
  workers.reply = (request: Rendered) => {
    const subject = /^Subject: (\S+)$/m.exec(request.prompt)?.[1]
    if (request.prompt.includes('## Verify these findings')) {
      const votes = reported.flatMap((f, i) => (f.severity === 'important' ? [{ finding: `f${i + 1}`, vote: script.vote ?? 'confirm', reason: `scripted ${script.vote ?? 'confirm'}` }] : []))
      return { text: '```json\n' + JSON.stringify({ subject, votes }) + '\n```' }
    }
    reported = script.findings()
    return script.holdReview ? 'hold' : reviewAnswer(request.prompt, reported)
  }
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(data, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
  ]
  await Promise.all(fibers)
  const config = { ...CONFIG, templates: { 'scheduled-review': SCHEDULED_REVIEW_NODES }, scheduledReview: { enabled: true, projectId: 'p1', repository: dir, ...scheduledReview } }
  let engine = ctx.plugin(Workflow, config)
  await engine
  onTestFinished(() => rmSync(data, { recursive: true, force: true }))
  onTestFinished(async () => {
    await engine.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  await activeProject(ctx)
  // The engine stops and starts again on the same durable store, the rest of the host staying up.
  const restart = async (): Promise<void> => {
    await engine.dispose()
    engine = ctx.plugin(Workflow, config)
    await engine
  }
  return { ctx, workers, restart }
}

/** Fixed instants, after the default start hour (03:00 UTC), one a day. */
const DAY = (n: number): Date => new Date(Date.UTC(2026, 10, 1 + n, 4, 0, 0))

const tasksOf = (ctx: Context) => ctx.board.tasks({ projectId: 'p1' })
const done = (row: ScheduledReviewRow | undefined): ScheduledReviewRow => {
  expect(row?.problem).toBeUndefined()
  expect(row?.state).toBe('done')
  return row!
}

describe('the area, the files, and the settings', () => {
  const g = (file: string): ReturnType<typeof parseGuide> => parseGuide(file, guide(['x/'], 'x'))
  const guides = ['a', 'b', 'c'].map((n) => {
    const read = g(`docs/review/${n}.REVIEW.md`)
    if (!read.ok) throw new Error(read.problem)
    return read.guide
  })

  it('picks one area a day, round robin in name order, and counts the rounds', () => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((n) => pickArea([...guides].reverse(), new Date(Date.UTC(2026, 10, 1 + n, 4))))
    const names = days.map((d) => areaOf(d!.guide))
    expect(names.slice(0, 3).sort()).toEqual(['a', 'b', 'c'])
    // Each next day is the next area, in a ring; the same three again after three days.
    expect(names.slice(3, 6)).toEqual(names.slice(0, 3))
    expect(names[6]).toBe(names[0])
    const cycles = days.map((d) => d!.cycle)
    expect(cycles).toEqual([...cycles].sort((a, b) => a - b))
    expect(pickArea([], DAY(0))).toBeUndefined()
    expect(dayOf(DAY(1))).toBe('2026-11-02')
  })

  it('reads an area that does not fit from a different place each round, and names the files left', () => {
    const files: AreaFile[] = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ path: `${n}.ts`, size: 100 })).concat([{ path: 'huge.ts', size: 10_000 }])
    const bounds = { maxFiles: 2, maxBytes: 1000, maxFileBytes: 5000 }
    const round = (cycle: number) => selectFiles(files, bounds, cycle)
    expect(round(0).shown.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(round(1).shown.map((f) => f.path)).toEqual(['c.ts', 'd.ts'])
    expect(round(0).left.map((f) => f.path)).toEqual(['c.ts', 'd.ts', 'e.ts', 'huge.ts'])
    // Everything that fits is read, in path order, whatever the round.
    expect(selectFiles(files.slice(0, 2), bounds, 7).shown.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    // A file larger than the bytes a review reads is never shown, whatever its own bound.
    expect(selectFiles([{ path: 'x.ts', size: 2000 }, { path: 'y.ts', size: 10 }], { maxFiles: 5, maxBytes: 1000, maxFileBytes: 5000 }, 0).left.map((f) => f.path)).toEqual(['x.ts'])
    expect(citesShown({ file: 'a.ts', line: 3 }, new Map([['a.ts', 3]]))).toBe(true)
    expect(citesShown({ file: 'a.ts', line: 4 }, new Map([['a.ts', 3]]))).toBe(false)
    expect(citesShown({ file: 'b.ts', line: 1 }, new Map([['a.ts', 3]]))).toBe(false)
  })

  it('reads every file of an area the byte bound cuts, round after round, even when the area has exactly as many files as a review may read', () => {
    const DEFAULTS = scheduledReviewSettings({})
    // 80 files of 10,000 bytes: the 80-file bound holds them all, the 400,000-byte one only 40.
    const files: AreaFile[] = Array.from({ length: 80 }, (_, i) => ({ path: `f${String(i).padStart(2, '0')}.ts`, size: 10_000 }))
    const first = selectFiles(files, DEFAULTS, 0).shown.map((f) => f.path)
    const second = selectFiles(files, DEFAULTS, 1).shown.map((f) => f.path)
    expect(first).toEqual(files.slice(0, 40).map((f) => f.path))
    expect(second).toEqual(files.slice(40).map((f) => f.path))
    // Any mix of sizes and bounds: within as many rounds as the area has files, every file is read.
    const sizes = [7, 300, 50, 999, 120, 640, 1, 480, 260, 75, 333, 900, 12, 410]
    const mixed: AreaFile[] = sizes.map((size, i) => ({ path: `m${String(i).padStart(2, '0')}.ts`, size }))
    for (const bounds of [{ maxFiles: 3, maxBytes: 1000, maxFileBytes: 1000 }, { maxFiles: 14, maxBytes: 1000, maxFileBytes: 1000 }, { maxFiles: 2, maxBytes: 5000, maxFileBytes: 1000 }]) {
      const read = new Set(Array.from({ length: mixed.length }, (_, cycle) => selectFiles(mixed, bounds, cycle).shown.map((f) => f.path)).flat())
      expect([...read].sort(), JSON.stringify(bounds)).toEqual(mixed.map((f) => f.path))
    }
  })

  it('is off by default, refuses what it cannot run on, and says why (INV-2)', () => {
    expect(scheduledReviewSettings({}).enabled).toBe(false)
    expect(scheduledReviewSettings({}).maxTasksPerRun).toBe(5)
    expect(checkConfig({})).toEqual([])
    expect(checkConfig({ scheduledReview: { enabled: false } })).toEqual([])
    expect(checkConfig({ scheduledReview: { enabled: true } })).toEqual([
      expect.stringContaining('scheduledReview.projectId is required'), expect.stringContaining('scheduledReview.repository is required'),
    ])
    expect(scheduledReviewProblems({ scheduledReview: { enabled: true, projectId: 'p1', repository: 'relative', maxTasksPerRun: 0, hourUtc: 24, ref: '-x' } })).toEqual([
      expect.stringContaining('hourUtc must be a whole number from 0 to 23'), expect.stringContaining('maxTasksPerRun must be a whole number from 1 to 20'),
      expect.stringContaining('ref must be a branch or ref name'), expect.stringContaining('repository must be the absolute path'),
    ])
    expect(scheduledReviewProblems({ scheduledReview: { enabled: true, projectId: 'p1', repository: '/r', cap: 1 } as never })).toEqual([expect.stringContaining('cap is not an option')])
    expect(() => scheduledReviewSettings({ scheduledReview: { maxFiles: 0 } })).toThrow(/maxFiles/)
  })
})

describe('a scheduled review over a fixture area with one planted defect', () => {
  it('proposes one task with its evidence, the guide it broke, and the place, after a second family confirmed it; the reviewers read the whole area at the frontier tier', async () => {
    const repo = repository()
    const { ctx, workers } = await boot(repo.dir, { findings: () => [finding('add() subtracts', 2), { severity: 'nit', title: 'name the arguments', file: 'calc/calc.py', line: 1 }] })
    const row = done(await ctx.workflow.scheduledReviewTick(DAY(0)))
    expect(row).toMatchObject({ area: 'calc', trigger: 'schedule', day: '2026-11-01', guideVersion: 2, ref: 'dev', commit: repo.sha(), filesRead: 1, filesLeft: 0, important: 1, confirmed: 1, rejected: 0, unverified: 0, nits: 1, filed: 1, duplicates: 0, capped: 0 })

    const tasks = await tasksOf(ctx)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ state: 'proposed', projectId: 'p1', title: 'Scheduled review (calc): add() subtracts', actionClass: 'workspace-write' })
    expect(tasks[0]!.taskId).toBe(row.tasks[0]!.taskId)
    expect(tasks[0]!.goal).toContain('Place: calc/calc.py:2')
    expect(tasks[0]!.goal).toContain('Evidence: line 2 returns the wrong value')
    expect(tasks[0]!.goal).toContain('Guide it broke: docs/review/calc.REVIEW.md, failure or class: arithmetic sign')
    expect(tasks[0]!.goal).toContain(`commit ${repo.sha()}`)
    expect(tasks[0]!.goal).toContain('Verified: scripted confirm')
    expect(tasks[0]!.acceptance).toEqual([{ id: 'fixed', statement: 'The defect no longer holds: add() subtracts (calc/calc.py:2)' }])

    // The whole area at the tip, not a diff: the file's lines numbered, the guide's text, and the subject.
    const [review, verify] = workers.started
    expect(review!.prompt).toContain(`Subject: scheduled-review:calc@${repo.sha().slice(0, 12)}`)
    expect(review!.prompt).toContain('=== calc/calc.py (2 lines) ===\n    1| def add(a, b):\n    2|     return a - b\n=== end of the area ===')
    expect(review!.prompt).toContain('Say what is wrong at the line.')
    expect(review!.prompt).not.toContain('{{')
    expect(verify!.prompt).toContain('## Verify these findings')
    expect(verify!.prompt).toContain('add() subtracts')
    // Frontier tier for both, and the second reviewer is of the other family.
    const run = ctx.workflow.get(row.runId!)!
    expect(run.template).toBe('scheduled-review')
    const [first, second] = ['review:1', 'verify:1'].map((id) => run.nodes.find((n) => n.nodeId === id)!)
    expect([first!.minTier, second!.minTier]).toEqual(['frontier', 'frontier'])
    expect(new Set([first!.worker, second!.worker]).size).toBe(2)
  })

  it('files nothing the second reviewer rejected, nor one whose citation was not in the area it was shown', async () => {
    const repo = repository()
    const rejecting = await boot(repo.dir, { findings: () => [finding('add() subtracts', 2)], vote: 'reject' })
    expect(done(await rejecting.ctx.workflow.scheduledReviewTick(DAY(0)))).toMatchObject({ important: 1, confirmed: 0, rejected: 1, unverified: 0, filed: 0 })
    expect(await tasksOf(rejecting.ctx)).toHaveLength(0)

    const other = repository()
    const elsewhere = await boot(other.dir, { findings: () => [finding('add() subtracts', 2, { file: 'calc/missing.py' }), finding('past the end', 40), { severity: 'important', title: 'no evidence' }] })
    // The finding with no file, line, and evidence is a nit already; the other two cite what was never shown.
    expect(done(await elsewhere.ctx.workflow.scheduledReviewTick(DAY(0)))).toMatchObject({ important: 2, confirmed: 0, unverified: 2, nits: 1, filed: 0 })
    expect(await tasksOf(elsewhere.ctx)).toHaveLength(0)
  })

  it('files nothing a verifier of the first reviewer\'s own family confirmed: its votes are no verification, and the row says why', async () => {
    const repo = repository()
    const oneFamily = [
      worker('w:reviewer-a', { schema: 'capability-descriptor@1.3', family: 'family-a', tier: 'frontier', proves: ['review', 'local-data'] }),
      worker('w:reviewer-a2', { schema: 'capability-descriptor@1.3', family: 'family-a', tier: 'frontier', proves: ['review', 'local-data'] }),
    ]
    const { ctx, workers } = await boot(repo.dir, { findings: () => [finding('add() subtracts', 2)], workers: oneFamily })
    const row = await ctx.workflow.scheduledReviewTick(DAY(0))
    // The verifier ran (its family was all there was) and confirmed; the vote does not count.
    expect(workers.started).toHaveLength(2)
    expect(row).toMatchObject({ state: 'done', important: 1, confirmed: 0, rejected: 0, unverified: 1, filed: 0 })
    expect(row!.problem).toMatch(/is not of another provider family than the first .*family family-a.*nothing is filed/)
    expect(await tasksOf(ctx)).toHaveLength(0)
  })

  it('settles a review a restart cut from its durable run: the finding is filed once, and the report counts it done', async () => {
    const repo = repository()
    const findings = [finding('add() subtracts', 2)]
    const { ctx, workers, restart } = await boot(repo.dir, { findings: () => findings, holdReview: true })
    const pending = ctx.workflow.scheduledReviewTick(DAY(0))
    await vi.waitFor(() => expect(workers.started).toHaveLength(1), { timeout: 30_000, interval: 25 })
    // Its run is on the row as soon as it is admitted, before anything is answered.
    const running = ctx.workflow.scheduledReviewReport().reviews[0]!
    expect(running).toMatchObject({ state: 'running', area: 'calc' })
    expect(running.runId).toBeDefined()

    // The host stops with the review waiting on its first reviewer: it stays running, for the next start.
    await restart()
    expect(await pending).toMatchObject({ reviewId: running.reviewId, state: 'running' })
    expect(await tasksOf(ctx)).toHaveLength(0)

    // After the restart the first reviewer answers; the new engine settles the review from the same run.
    workers.release(workers.started[0]!.id, reviewAnswer(workers.started[0]!.prompt, findings))
    const settled = await vi.waitFor(() => {
      const row = ctx.workflow.scheduledReviewReport().reviews[0]!
      if (row.state === 'running') throw new Error('the review is still running')
      return row
    }, { timeout: 60_000, interval: 50 })
    expect(settled).toMatchObject({ reviewId: running.reviewId, runId: running.runId, state: 'done', confirmed: 1, filed: 1 })
    expect(settled.problem).toBeUndefined()
    const tasks = await tasksOf(ctx)
    expect(tasks.map((t) => t.taskId)).toEqual(settled.tasks.map((t) => t.taskId))
    expect(tasks[0]!.goal).toContain('Place: calc/calc.py:2')
    // One run, one review, one verification: nothing was started again.
    expect(workers.started).toHaveLength(2)
    expect(ctx.workflow.scheduledReviewReport().areas).toEqual([expect.objectContaining({ area: 'calc', reviews: 1, unfinished: 0, filed: 1 })])
  })

  it('records a review the host stopped before its run was admitted as failed, with why, rather than leaving it running', async () => {
    const repo = repository()
    const { ctx, restart } = await boot(repo.dir, { findings: () => [] })
    // The row as a stop between its insert and its run's admission leaves it: running, no run.
    ctx.store.db.prepare(`INSERT INTO workflow_scheduled_reviews (review_id, day, trigger, area, guide_file, guide_version, repo_ref, commit_sha, state, started_at)
      VALUES ('sr_cut', '2026-11-01', 'schedule', 'calc', 'docs/review/calc.REVIEW.md', 2, 'dev', ?, 'running', '2026-11-01T04:00:00.000Z')`).run(repo.sha())
    await restart()
    const row = await vi.waitFor(() => {
      const found = ctx.workflow.scheduledReviewReport().reviews[0]!
      if (found.state === 'running') throw new Error('not reconciled yet')
      return found
    }, { timeout: 30_000, interval: 25 })
    expect(row).toMatchObject({ reviewId: 'sr_cut', state: 'failed', problem: 'the host stopped before its run was admitted' })
    expect(ctx.workflow.scheduledReviewReport().areas).toEqual([expect.objectContaining({ area: 'calc', reviews: 1, unfinished: 1 })])
  })

  it('does nothing while it is off, and when the day already has its review', async () => {
    const repo = repository()
    const off = await boot(repo.dir, { findings: () => [finding('add() subtracts', 2)] }, { enabled: false })
    expect(await off.ctx.workflow.scheduledReviewTick(DAY(0))).toBeUndefined()
    expect(off.workers.started).toHaveLength(0)
    expect(off.ctx.workflow.scheduledReviewReport().text).toBe('No scheduled review has run.')

    const on = await boot(repo.dir, { findings: () => [finding('add() subtracts', 2)] }, { hourUtc: 6 })
    // Before its hour nothing runs; from it, one review a day: a second pass the same day starts none.
    expect(await on.ctx.workflow.scheduledReviewTick(DAY(0))).toBeUndefined()
    done(await on.ctx.workflow.scheduledReviewTick(new Date(Date.UTC(2026, 10, 1, 6, 30))))
    expect(await on.ctx.workflow.scheduledReviewTick(new Date(Date.UTC(2026, 10, 1, 23, 0)))).toBeUndefined()
    expect(on.workers.started).toHaveLength(2)
  })
})

describe('a second run does not file it again while the task is open', () => {
  it('files it once, however the next days word it, and again only once its task is cancelled; the report counts it per area over time', async () => {
    const repo = repository()
    let title = 'add() subtracts'
    let line = 2
    const { ctx } = await boot(repo.dir, { findings: () => [finding(title, line)] })

    const first = done(await ctx.workflow.scheduledReviewTick(DAY(0)))
    expect(first).toMatchObject({ filed: 1, duplicates: 0 })
    const taskId = first.tasks[0]!.taskId

    // The next day it finds the same defect: the task is open, so nothing is filed.
    const second = done(await ctx.workflow.scheduledReviewTick(DAY(1)))
    expect(second).toMatchObject({ area: 'calc', confirmed: 1, filed: 0, duplicates: 1 })
    // Another day, worded otherwise and a line off: still the same place.
    title = 'the sum is computed with a minus'
    line = 1
    expect(done(await ctx.workflow.scheduledReviewTick(DAY(2)))).toMatchObject({ confirmed: 1, filed: 0, duplicates: 1 })
    expect(await tasksOf(ctx)).toHaveLength(1)

    // Once its task is closed, the defect that still stands is filed again.
    await ctx.board.cancel(taskId, 'operator')
    title = 'add() subtracts'
    line = 2
    const fourth = done(await ctx.workflow.scheduledReviewTick(DAY(3)))
    expect(fourth).toMatchObject({ filed: 1, duplicates: 0 })
    const tasks = await tasksOf(ctx)
    expect(tasks.map((t) => t.state).sort()).toEqual(['cancelled', 'proposed'])

    const report = ctx.workflow.scheduledReviewReport()
    expect(report.areas).toEqual([expect.objectContaining({ area: 'calc', reviews: 4, unfinished: 0, important: 4, confirmed: 4, filed: 2, duplicates: 2, capped: 0 })])
    expect(report.reviews.map((r) => [r.day, r.filed, r.duplicates])).toEqual([['2026-11-04', 1, 0], ['2026-11-03', 0, 1], ['2026-11-02', 0, 1], ['2026-11-01', 1, 0]])
    expect(report.text).toContain('| calc | 4 | 0 | 4 | 4 | 0 | 0 | 0 | 2 | 2 | 0 | 2026-11-04 |')
  })

  it('treats an open task of the project with the same title as the same finding, whoever filed it', async () => {
    const repo = repository()
    const { ctx } = await boot(repo.dir, { findings: () => [finding('add() subtracts', 2)] })
    await ctx.board.propose({ projectId: 'p1', title: 'Scheduled review (calc): add() subtracts', goal: 'by hand', acceptance: [{ id: 'a', statement: 'fixed' }], actionClass: 'workspace-write' })
    expect(done(await ctx.workflow.scheduledReviewTick(DAY(0)))).toMatchObject({ confirmed: 1, filed: 0, duplicates: 1 })
    expect(await tasksOf(ctx)).toHaveLength(1)
  })

  it('reviews the next area the next day, round robin, and counts each area apart', async () => {
    const repo = repository({ 'calc/calc.py': PLANTED }, ['zeta'])
    const { ctx } = await boot(repo.dir, { findings: () => [] })
    const areas = [(await ctx.workflow.scheduledReviewTick(DAY(0)))!.area, (await ctx.workflow.scheduledReviewTick(DAY(1)))!.area, (await ctx.workflow.scheduledReviewTick(DAY(2)))!.area]
    expect(new Set(areas.slice(0, 2))).toEqual(new Set(['calc', 'zeta']))
    expect(areas[2]).toBe(areas[0])
    expect(ctx.workflow.scheduledReviewReport().areas.map((a) => [a.area, a.reviews])).toEqual([['calc', areas.filter((a) => a === 'calc').length], ['zeta', areas.filter((a) => a === 'zeta').length]])
  })
})

describe('the cap holds', () => {
  it('proposes at most five tasks a run, counting the rest as capped, and files the rest of them only once the board has room', async () => {
    const repo = repository({ 'calc/calc.py': LONG })
    // Seven defects at seven lines of their own (more than three lines apart), all confirmed.
    const lines = [2, 6, 10, 14, 18, 22, 26]
    const { ctx } = await boot(repo.dir, { findings: () => lines.map((line, i) => finding(`f${i + 1} gives the wrong value`, line)) })
    const first = done(await ctx.workflow.scheduledReviewTick(DAY(0)))
    expect(first).toMatchObject({ important: 7, confirmed: 7, filed: 5, capped: 2, duplicates: 0 })
    expect(await tasksOf(ctx)).toHaveLength(5)
    // The next run files none of the five again, and takes the two the cap left.
    const second = done(await ctx.workflow.scheduledReviewTick(DAY(1)))
    expect(second).toMatchObject({ confirmed: 7, filed: 2, capped: 0, duplicates: 5 })
    expect(await tasksOf(ctx)).toHaveLength(7)
  })

  it('takes a lower cap from the configuration, and a cap of one files one', async () => {
    const repo = repository({ 'calc/calc.py': LONG })
    const { ctx } = await boot(repo.dir, { findings: () => [2, 10].map((line) => finding(`wrong at ${line}`, line)) }, { maxTasksPerRun: 1 })
    expect(done(await ctx.workflow.scheduledReviewTick(DAY(0)))).toMatchObject({ confirmed: 2, filed: 1, capped: 1 })
    expect(await tasksOf(ctx)).toHaveLength(1)
  })
})
