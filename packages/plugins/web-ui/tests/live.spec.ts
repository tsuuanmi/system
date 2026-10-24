import type { Context } from '@deepseek-ai/cordis'
import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { boot, OPERATOR, reviewed } from './store-backed.ts'

// What the operator finds on coming back (T124), over the store-backed board, approval queue, and
// engine: what happened since they last looked, who would take a step, and a running run as it moves.
vi.setConfig({ testTimeout: 120_000 })

/** A source that runs nothing and tells that the agent of `runId`'s step stalled, as the agents source does. */
function stalls(ctx: Context, runId: string, since: string): void {
  ctx.workers.register({
    name: 'liveness', describe: async () => [], start: () => { throw new Error('it runs nothing') }, get: () => undefined, wait: () => Promise.reject(new Error('it runs nothing')),
    liveness: async () => ({ runs: [{ execution: 'arun_1', worker: 'w:standard', state: 'stalled', since, reasons: ['no activity for 10 min'], runId, holds: [] }], counts: { stalled: 1, looking: 0, unknown: 0 } }),
  } as never)
}

describe('web UI: since you last looked, who would take a step, and a run as it moves (T124)', () => {
  it('says what happened since a time to the operator only: the runs that ended, the tasks that moved, and the requests that expired unanswered', async () => {
    const { ctx, call, client, workers } = await boot()
    await activeProject(ctx)
    const before = new Date().toISOString()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { task } = await reviewed(ctx, 'Fix the slow image build')
    workers.reply = () => ({ fail: 'reauth_required: the account must sign in again', disposition: 'USER_ACTION', sent: false })
    const failed = ctx.workflow.start({ template: 'solo', input: 'Compare the CDN offers', classification: 'public' })
    await vi.waitFor(() => expect(ctx.workflow.get(failed.runId)?.status).toBe('failed'), { timeout: 30_000 })
    // A request no one answered: it expires, counted as denied.
    const verdict = await ctx.approvals.check({ class: 'deploy' })
    const asked = await ctx.approvals.request({ subject: { type: 'content', ref: 'deploy:site', version: '1' }, action: { class: 'deploy', summary: 'Deploy the site' }, requester: { component: 'board', projectId: 'p1' }, verdict, classification: 'public' })
    await ctx.approvals.sweep(new Date(Date.parse(asked.expiresAt) + 1000))

    expect((await call(`activity?since=${encodeURIComponent(before)}`, undefined, client)).status).toBe(401)
    expect((await call('activity')).status).toBe(400)
    expect((await call('activity?since=yesterday')).status).toBe(400)
    const read = await call(`activity?since=${encodeURIComponent(before)}`)
    expect(read.status).toBe(200)
    const runs = read.value.runs as Array<Record<string, unknown>>
    expect(runs.map((r) => r.status).sort()).toEqual(['completed', 'failed'])
    expect(runs.find((r) => r.status === 'failed')).toMatchObject({ runId: failed.runId, template: 'solo', error: expect.stringContaining('reauth_required') })
    expect(runs.find((r) => r.status === 'completed')).toMatchObject({ taskId: task.taskId })
    expect(read.value.tasks).toEqual({ value: [expect.objectContaining({ taskId: task.taskId, title: 'Fix the slow image build', state: 'review', project: { projectId: 'p1', title: 'project p1' } })] })
    expect(read.value.expired).toEqual({ value: [{ requestId: asked.requestId, at: expect.any(String), summary: 'Deploy the site' }] })
    // Nothing since now.
    expect((await call(`activity?since=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}`)).value).toMatchObject({ runs: [], tasks: { value: [] }, expired: { value: [] } })
  })

  it('names the Workers that could likely take each step of a start, free or busy, and tells a running run\'s steps, last event, and a stall its source told (operator only)', async () => {
    const { ctx, call, client, workers } = await boot()
    await activeProject(ctx)
    workers.extra = [worker('w:coder', { schema: 'capability-descriptor@1.6', tier: 'frontier', kinds: ['code'], proves: ['reason'] } as never), worker('w:resting', { tier: 'frontier', state: 'quota-exhausted', proves: ['reason'] })]
    const task = await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    const preview = await call(`tasks/${task.taskId}/start`)
    // solo needs reason at standard tier or above, of no kind: a Worker given kinds does not take it; one resting is busy.
    expect((preview.value.steps as Array<{ workers: unknown }>)[0]!.workers).toEqual({ free: ['w:frontier', 'w:standard'], busy: ['w:resting'] })

    workers.reply = () => 'hold'
    const busy = await readyTask(ctx, 'Research the hosting options')
    const run = await ctx.workflow.start({ template: 'solo', input: 'research', classification: 'public', task: { taskId: busy.taskId } })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.nodes[0]?.state).toBe('RUNNING'), { timeout: 10_000 })
    expect((await call('runs/live', undefined, client)).status).toBe(401)
    let live = await call('runs/live')
    expect(live.status).toBe(200)
    const shown = (live.value.runs as Array<Record<string, any>>).find((r) => r.runId === run.runId)!
    expect(shown).toMatchObject({ template: 'solo', taskId: busy.taskId, steps: [{ nodeId: 'solo', attempt: 1, worker: expect.stringMatching(/^w:/), since: expect.any(String) }], lastEvent: { value: { type: expect.any(String), at: expect.any(String) } }, stalled: { value: null } })
    const since = new Date().toISOString()
    stalls(ctx, run.runId, since)
    live = await call('runs/live')
    expect((live.value.runs as Array<Record<string, any>>).find((r) => r.runId === run.runId)!.stalled).toEqual({ value: { since } })
  })

  it.runIf(canRunBrowser)('shows on Home what happened since the operator last looked, until marked as seen; names the waiting count in the window\'s title; the start names who would likely take it; a running run\'s page and card say where it is, and a stall (T124)', async () => {
    const booted = await boot()
    const { ctx, workers } = booted
    await activeProject(ctx)
    const { task } = await reviewed(ctx, 'Fix the slow image build')
    await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    workers.reply = () => 'hold'
    const busy = await readyTask(ctx, 'Research the hosting options')
    const run = await ctx.workflow.start({ template: 'solo', input: 'research', classification: 'public', task: { taskId: busy.taskId } })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.nodes[0]?.state).toBe('RUNNING'), { timeout: 10_000 })
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    // A first look: nothing to compare with yet, and the baseline is kept in this browser.
    const since = page.getByRole('region', { name: 'Since you last looked' })
    await expect.poll(() => since.innerText()).toContain('This is your first look from this browser')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('system.seen') ?? 'null'))).toMatchObject({ at: expect.any(String), workers: { 'w:standard': expect.any(String) } })
    // Back an hour later: the operator last looked before the review and while w:economy rested.
    await page.evaluate((at) => localStorage.setItem('system.seen', JSON.stringify({ at, workers: { 'w:economy': 'resting' } })), new Date(Date.now() - 3_600_000).toISOString())
    await page.reload()
    await expect.poll(() => since.innerText()).toContain('Waits for your review: "Fix the slow image build"')
    const said = await since.innerText()
    expect(said).toContain('Finished: "Fix the slow image build"')
    expect(said).toMatch(/Conformance · economy · economy is back from its rest: free/)
    expect(said).toMatch(/^Since you last looked 1 h ago/)
    // One thing waits (the review): the window's title counts it.
    await expect.poll(() => page.title()).toBe('(1) system — Home')
    await since.getByRole('button', { name: 'Mark as seen' }).click()
    await expect.poll(() => since.innerText()).toContain('Nothing happened that needs you.')
    // Recent runs: by the task's title, each step with its Worker's display name.
    const recent = page.locator('table tr', { hasText: 'Research the hosting options' })
    expect(await recent.innerText()).toMatch(/solo: Conformance · \w+ · \w+/)

    // The Board: the start names who would likely take it; the running card its last event, then a stall.
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Board' }).click()
    await expect.poll(() => page.title()).toBe('(1) system — Board')
    await page.getByRole('button', { name: 'Start Write the release notes' }).click()
    const confirming = page.getByRole('group', { name: 'Confirm start of Write the release notes' })
    await expect.poll(() => confirming.innerText()).toMatch(/Likely: Conformance · (frontier|standard) · (frontier|standard)/)
    await confirming.getByRole('button', { name: 'Cancel' }).click()
    stalls(ctx, run.runId, new Date().toISOString())
    const card = page.getByRole('region', { name: 'Working', exact: true }).getByRole('article', { name: 'Research the hosting options' })
    await expect.poll(() => card.innerText(), { timeout: 15_000 }).toMatch(/last event: .+ ago/)
    await expect.poll(() => card.innerText(), { timeout: 15_000 }).toMatch(/Stalled since .+: no activity past its source's bound/)
    // Its run's page: the step on its Worker and for how long, its last event, and the stall.
    await card.getByRole('link', { name: 'Open the run of Research the hosting options' }).click()
    const now = page.getByRole('region', { name: 'Now' })
    await expect.poll(() => now.count()).toBe(1)
    expect(await now.innerText()).toMatch(/^Now\b[^\n]*\nStep solo on Conformance · \w+ · \w+, for (less than a minute|\d+ min)/)
    expect(await now.innerText()).toMatch(/last event: .+ ago/)
    expect(await now.getByRole('alert').innerText()).toMatch(/^Stalled since /)
    expect(task.state).toBe('review')
  }, 90_000)
})
