import type { Context } from '@deepseek-ai/cordis'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type { WorkChange } from '@tsuuanmi/system-workers-core'
import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { activeProject } from '../../workflow/conformance/workflow.ts'
import { boot, OPERATOR, reviewed } from './store-backed.ts'

// End to end over the store-backed board, approval queue, and engine, under the bundle's own
// default studio policy, with the operator's verdicts through the web UI's API. Only Worker
// execution is scripted.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

describe('web UI: the operator accepts or rejects a board review held for the operator', () => {
  it('holds a workspace-write task\'s review past its run\'s lease, lists it with its pending checks, and takes only the operator\'s acceptance: done', async () => {
    const { ctx, call, client } = await boot()
    await activeProject(ctx)
    const { task, run } = await reviewed(ctx, 'kernel')
    schemas.assertRecord(task)
    expect(task).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
    expect(task.holder).toBeUndefined()
    // The bundle's policy: the operator has a day (expiry.defaultSeconds), not a lease's ten minutes.
    expect(Date.parse(task.waiting!.expiresAt) - Date.parse(task.waiting!.since)).toBe(86_400_000)
    await ctx.board.sweep(new Date(Date.now() + 11 * 60_000))
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })

    const listed = await call('reviews')
    expect(listed.status).toBe(200)
    expect(listed.value.reviews).toEqual([expect.objectContaining({
      taskId: task.taskId, project: { projectId: 'p1', title: 'project p1' }, subject: task.result!.subject, artifacts: [run.result],
      pendingChecks: ['tests', 'lint'], run: expect.objectContaining({ runId: run.runId }), heldFor: 'operator', expiresAt: task.waiting!.expiresAt,
    })])

    // Only the operator's channel decides (INV-6): a client token is refused by the guard before any route.
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject }, client)).status).toBe(401)
    // The verdict binds to the result the page showed (INV-5).
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: { ...task.result!.subject, ref: 'sha256:other' } })).status).toBe(409)
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'maybe', subject: task.result!.subject })).status).toBe(400)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review' })

    const decided = await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject, note: 'checked by hand' })
    expect(decided.status).toBe(200)
    expect(decided.value.task).toMatchObject({ state: 'done' })
    const done = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(done)
    expect(done).toMatchObject({ state: 'done', result: { acceptance: decided.value.decision } })
    const envelope = ctx.artifacts.get(done.result!.acceptance!)!
    expect(envelope.producer).toMatchObject({ type: 'operator' })
    expect(envelope.body).toMatchObject({
      decisionType: 'acceptance', decider: { type: 'operator' }, rationale: 'checked by hand',
      outcome: { option: 'accept', detail: { taskId: task.taskId, subject: task.result!.subject } }, inputs: [run.result],
    })
    expect((await call('reviews')).value.reviews).toEqual([])
  })

  it('takes the operator\'s rejection as another attempt, through the gate', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const { task } = await reviewed(ctx, 'rejected')
    const decided = await call(`reviews/${task.taskId}/decide`, { verdict: 'reject', subject: task.result!.subject })
    expect(decided.status).toBe(200)
    const again = (await ctx.board.task(task.taskId))!
    expect(again).toMatchObject({ state: 'ready', attempts: { count: 1, max: 2 } })
    expect(again.waiting).toBeUndefined()
    // A task no longer in review takes no verdict.
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject })).status).toBe(409)
  })

  it('ends a review the operator did not decide by the policy\'s wait as review-expired', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const { task } = await reviewed(ctx, 'lapsed')
    await ctx.board.sweep(new Date(Date.parse(task.waiting!.expiresAt) - 1000))
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review' })
    await ctx.board.sweep(new Date(Date.parse(task.waiting!.expiresAt) + 1000))
    const expired = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(expired)
    expect(expired).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject })).status).toBe(409)
  })
})

/** A run's change as the agents source reads it: a changed file, a long added one, and a binary one (T122). */
const changeOf = (runId: string): WorkChange => ({
  repository: '/repo', workspace: `/worktrees/repo/${runId}`, branch: `system/run/${runId}`, base: { branch: 'main', sha: 'a'.repeat(40) }, head: 'a'.repeat(40), more: 0, truncated: false,
  files: [
    { path: 'src/limits.ts', status: 'modified', added: 1, removed: 1, diff: 'diff --git a/src/limits.ts b/src/limits.ts\n--- a/src/limits.ts\n+++ b/src/limits.ts\n@@ -1,3 +1,3 @@\n-  return { limit }\n+  return { limit, header }' },
    { path: 'tests/many.spec.ts', status: 'added', added: 250, removed: 0, diff: ['new file tests/many.spec.ts (untracked)', ...Array.from({ length: 250 }, (_, i) => `+line ${i + 1}`)].join('\n') },
    { path: 'assets/logo.png', status: 'added', binary: true },
  ],
})

/** A source that holds no Worker and reads the change of `runId` (and fails for `broken`), as the agents source does. */
function changes(ctx: Context, runId: string): void {
  ctx.workers.register({
    name: 'worktrees', describe: async () => [], start: () => { throw new Error('it runs nothing') }, get: () => undefined, wait: () => Promise.reject(new Error('it runs nothing')),
    changes: async (id: string) => { if (id === 'broken') throw new Error('git failed'); return id === runId ? [changeOf(runId)] : undefined },
  } as never)
}

/** The review step's verdict, as the engine stores a bound review's. */
function assessment(ctx: Context, runId: string): void {
  const subject = { type: 'git-head' as const, ref: 'a'.repeat(40), version: 'b'.repeat(64) }
  ctx.artifacts.put({ kind: 'assessment', bodySchema: 'assessment@1.0', subject, inputs: [], classification: 'public', producer: { type: 'system', ref: 'workflow' }, runId, nodeId: 'review:1',
    body: { schema: 'assessment@1.0', subject, verdict: 'approve', findings: [{ severity: 'warning', title: 'The header name is matched case-sensitively', file: 'src/limits.ts' }], reviewer: 'w:standard' } } as never)
}

describe('web UI: what the operator reads before a review verdict (T122)', () => {
  it('serves a run\'s change, its reviewers\' verdicts, and its report to the operator only, read through ctx.workers.changes; a change that cannot be read is said, never empty (INV-2, INV-6)', async () => {
    const { ctx, call, client } = await boot()
    await activeProject(ctx)
    const { run } = await reviewed(ctx, 'kernel')
    expect((await call(`runs/${run.runId}/review`)).value).toMatchObject({ change: { value: { changes: [], unread: [] } }, assessments: { value: [] } })
    changes(ctx, run.runId)
    assessment(ctx, run.runId)
    expect((await call(`runs/${run.runId}/review`, undefined, client)).status).toBe(401)
    expect((await call('runs/run_nope/review')).status).toBe(404)
    expect((await call(`runs/${run.runId}/review`, {})).status).toBe(405)
    const read = await call(`runs/${run.runId}/review`)
    expect(read.status).toBe(200)
    expect(read.value).toEqual({
      runId: run.runId,
      change: { value: { changes: [{ ...changeOf(run.runId), source: 'worktrees' }], unread: [] } },
      assessments: { value: [{ nodeId: 'review:1', createdAt: expect.any(String), verdict: 'approve', findings: [{ severity: 'warning', title: 'The header name is matched case-sensitively', file: 'src/limits.ts' }], reviewer: 'w:standard' }], more: 0 },
      report: { nodeId: 'solo', text: run.answer },
    })
    // A source that cannot read its worktree is named, with why.
    ctx.workers.register({ name: 'failing', describe: async () => [], start: () => { throw new Error('none') }, get: () => undefined, wait: () => Promise.reject(new Error('none')), changes: async () => { throw new Error('git failed') } } as never)
    expect(((await call(`runs/${run.runId}/review`)).value.change as { value: { unread: unknown } }).value.unread).toEqual([{ source: 'failing', detail: 'git failed' }])
  })

  it('says what changed is unknown when the run\'s result names the workspace an agent worked in and no source read a change there, never that it changed nothing (INV-2)', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const { run } = await reviewed(ctx, 'kernel')
    // A run whose result names no workspace changed nothing that a source holds.
    expect((await call(`runs/${run.runId}/review`)).value.change).toEqual({ value: { changes: [], unread: [] } })
    // Its result an agent's, which worked in a workspace: no source answering is not "no change".
    const result = ctx.artifacts.put({
      kind: 'report', bodySchema: 'agent-result@1.1', inputs: [], classification: 'public', producer: { type: 'worker', ref: 'agent:dev' }, runId: run.runId, nodeId: 'solo',
      body: { schema: 'agent-result@1.1', worker: 'agent:dev', runtime: 'scripted', runId: 'x', nativeHandle: 'h', promptHash: `sha256:${'c'.repeat(64)}`, sandbox: 'workspace-write', workspace: '/worktrees/repo/run_x', turns: 1, text: 'done' },
    } as never)
    ctx.store.db.prepare('UPDATE workflow_runs SET result = ? WHERE run_id = ?').run(result.id, run.runId)
    expect((await call(`runs/${run.runId}/review`)).value.change).toEqual({ unknown: 'no Worker source read the change in /worktrees/repo/run_x, the workspace the run\'s result names, so what it changed is not known' })
    // A source that read it, or one that could not, answers as before.
    changes(ctx, run.runId)
    expect((await call(`runs/${run.runId}/review`)).value.change).toEqual({ value: { changes: [{ ...changeOf(run.runId), source: 'worktrees' }], unread: [] } })
  })

  it('lists the newest verdicts first, at most 20, and counts the older ones as more', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const { run } = await reviewed(ctx, 'kernel')
    const subject = { type: 'git-head' as const, ref: 'a'.repeat(40), version: 'b'.repeat(64) }
    for (let i = 1; i <= 23; i++) {
      ctx.artifacts.put({ kind: 'assessment', bodySchema: 'assessment@1.0', subject, inputs: [], classification: 'public', producer: { type: 'system', ref: 'workflow' }, runId: run.runId, nodeId: `review:${i}`,
        body: { schema: 'assessment@1.0', subject, verdict: i === 23 ? 'approve' : 'changes-requested', findings: [{ severity: 'warning', title: `finding ${i}` }] } } as never)
      // A later millisecond: stored later is newer.
      await new Promise((resolve) => setTimeout(resolve, 3))
    }
    const { assessments } = (await call(`runs/${run.runId}/review`)).value as { assessments: { value: Array<{ nodeId: string; verdict: string }>; more: number; moreAtLeast?: true } }
    expect(assessments.value.map((a) => a.nodeId)).toEqual(Array.from({ length: 20 }, (_, i) => `review:${23 - i}`))
    expect(assessments.value[0]!.verdict).toBe('approve')
    expect(assessments.more).toBe(3)
    expect(assessments.moreAtLeast).toBeUndefined()
  })

  it.runIf(canRunBrowser)('reads a review that failed once per run and result: the 5-second refresh never reads it again, the operator\'s Read it again does (T128a)', async () => {
    const booted = await boot()
    const { ctx } = booted
    await activeProject(ctx)
    await reviewed(ctx, 'Keep the rate-limit header')
    // The review read fails as a whole: the server cannot list the run's verdicts.
    const artifacts = ctx.artifacts as unknown as { list: (filter?: { kind?: string }) => unknown[] }
    const list = artifacts.list.bind(artifacts)
    let reads = 0
    artifacts.list = (filter) => {
      if (filter?.kind !== 'assessment') return list(filter)
      reads++
      throw new Error('the ledger is busy')
    }
    onTestFinished(() => void (artifacts.list = list))
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const card = page.getByRole('region', { name: 'Reviews' }).getByRole('article', { name: 'Keep the rate-limit header' })
    await expect.poll(() => card.getByText(/What the run changed and what its steps said could not be read/).count(), { timeout: 15_000 }).toBe(1)
    expect(reads).toBe(1)
    // Two refreshes later, still read once.
    await new Promise((resolve) => setTimeout(resolve, 11_000))
    expect(reads).toBe(1)
    expect(await card.getByText(/could not be read/).count()).toBe(1)
    await card.getByRole('button', { name: 'Read it again' }).click()
    await expect.poll(() => reads, { timeout: 15_000 }).toBe(2)
  }, 90_000)

  it.runIf(canRunBrowser)('shows a review card with what changed (the stat, each file folded, a long one with show all), the reviewer\'s verdict, the run\'s report, and the checks not run in warning; after Accept, where the result stands on its way in (T122, ADR-0060)', async () => {
    const booted = await boot()
    const { ctx } = booted
    await activeProject(ctx)
    const { task, run } = await reviewed(ctx, 'Keep the rate-limit header')
    changes(ctx, run.runId)
    assessment(ctx, run.runId)
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const card = page.getByRole('region', { name: 'Reviews' }).getByRole('article', { name: 'Keep the rate-limit header' })
    await expect.poll(() => card.getByText('What changed').count()).toBe(1)
    const change = card.getByRole('group', { name: `Change on system/run/${run.runId}` })
    expect(await change.locator('.stat').innerText()).toBe(`3 files changed +251 −1 · on system/run/${run.runId}, against main at aaaaaaaaaaaa`)
    // Each file folded: opened, its diff in lines; a long one shows its first 200 lines, then all.
    expect(await change.innerText()).not.toContain('return { limit, header }')
    await change.locator('summary', { hasText: 'src/limits.ts' }).click()
    expect((await change.locator('pre.diff .add').first().innerText()).trimEnd()).toBe('+  return { limit, header }')
    expect((await change.locator('pre.diff .del').first().innerText()).trimEnd()).toBe('-  return { limit }')
    await change.locator('summary', { hasText: 'tests/many.spec.ts' }).click()
    const long = change.locator('li', { hasText: 'tests/many.spec.ts' })
    expect(await long.innerText()).not.toContain('+line 250')
    await long.getByRole('button', { name: 'Show all 251 lines' }).click()
    expect(await long.innerText()).toContain('+line 250')
    expect(await change.locator('li', { hasText: 'assets/logo.png' }).innerText()).toContain('binary')
    // The reviewer's verdict and the run's report, next to the verdict buttons; the checks not run in warning.
    expect(await card.innerText()).toContain('Approved by the review at review:1 (w:standard)')
    expect(await card.innerText()).toContain('The header name is matched case-sensitively (src/limits.ts)')
    expect(await card.innerText()).toContain('The run\'s last step, solo, reported this, in its own words:')
    const pending = card.locator('p.pending-checks')
    expect(await pending.innerText()).toMatch(/^Checks not run: tests, lint\. Accepting counts them as passed — run them first\./)
    const wait = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--wait)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color })
    expect(await pending.evaluate((p) => getComputedStyle(p).color)).toBe(wait)
    await card.getByRole('button', { name: 'Accept: mark it done' }).click()
    await expect.poll(async () => (await ctx.board.task(task.taskId))?.state).toBe('done')
    // Where the accepted result stands (ADR-0060), as its landing moves: committed on its branch, then its merge asked, linked.
    const landing = (value: Record<string, unknown>) => ctx.store.db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ?').run(JSON.stringify({ branch: `system/run/${run.runId}`, at: new Date().toISOString(), ...value }), run.runId)
    landing({ state: 'committed', head: 'b'.repeat(40), base: { branch: 'main', sha: 'a'.repeat(40) } })
    const accepted = page.getByRole('region', { name: 'Accepted, on their way in' }).getByRole('article', { name: 'Accepted: Keep the rate-limit header' })
    await expect.poll(() => accepted.count(), { timeout: 15_000 }).toBe(1)
    expect(await accepted.innerText()).toContain(`Accepted and committed on system/run/${run.runId} as bbbbbbbbbbbb; its merge request comes next`)
    landing({ state: 'asked', head: 'b'.repeat(40), base: { branch: 'main', sha: 'a'.repeat(40) }, requestId: 'apr-merge-1' })
    await expect.poll(() => accepted.innerText(), { timeout: 15_000 }).toContain('Accepted — waiting to merge into main: approve')
    expect(await accepted.getByRole('link', { name: 'approve', exact: true }).getAttribute('href')).toBe('/ui/?request=apr-merge-1')
    // The run's page shows the same change and where it stands.
    await accepted.getByRole('link', { name: 'open its run' }).click()
    const panel = page.getByRole('region', { name: 'What it changed' })
    await expect.poll(() => panel.count()).toBe(1)
    expect(await panel.innerText()).toContain('Accepted — waiting to merge into main: approve')
    expect(await panel.innerText()).toContain('3 files changed +251 −1')
    landing({ state: 'merged', head: 'b'.repeat(40), base: { branch: 'main', sha: 'a'.repeat(40) }, commit: 'c'.repeat(40) })
    await page.goto(`${origin}/ui/`)
    await expect.poll(() => page.getByRole('heading', { name: 'Reviews' }).count()).toBe(1)
    expect(await page.getByRole('region', { name: 'Accepted, on their way in' }).count()).toBe(0)
  }, 90_000)
})
