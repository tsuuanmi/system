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
      assessments: { value: [{ nodeId: 'review:1', createdAt: expect.any(String), verdict: 'approve', findings: [{ severity: 'warning', title: 'The header name is matched case-sensitively', file: 'src/limits.ts' }], reviewer: 'w:standard' }] },
      report: { nodeId: 'solo', text: run.answer },
    })
    // A source that cannot read its worktree is named, with why.
    ctx.workers.register({ name: 'failing', describe: async () => [], start: () => { throw new Error('none') }, get: () => undefined, wait: () => Promise.reject(new Error('none')), changes: async () => { throw new Error('git failed') } } as never)
    expect(((await call(`runs/${run.runId}/review`)).value.change as { value: { unread: unknown } }).value.unread).toEqual([{ source: 'failing', detail: 'git failed' }])
  })

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
    expect(await pending.innerText()).toBe('Checks not run: tests, lint. Accepting counts them as passed — run them first.')
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
