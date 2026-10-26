import type { Context } from '@deepseek-ai/cordis'
import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { headlessIt, headlessLaunchOptions } from '../../browser-patchright/tests/support.ts'
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
    const runs = (read.value.runs as { value: Array<Record<string, unknown>> }).value
    expect(runs.map((r) => r.status).sort()).toEqual(['completed', 'failed'])
    expect(runs.find((r) => r.status === 'failed')).toMatchObject({ runId: failed.runId, template: 'solo', error: expect.stringContaining('reauth_required') })
    // Its kind and disposition beside the raw text, so Home leads with the run page's plain words (T160).
    const error = ctx.workflow.get(failed.runId)!.error!
    expect(runs.find((r) => r.status === 'failed')!.failure).toEqual({ kind: error.kind, disposition: error.disposition })
    expect(runs.find((r) => r.status === 'completed')).toMatchObject({ taskId: task.taskId })
    expect(read.value.tasks).toEqual({ value: [expect.objectContaining({ taskId: task.taskId, title: 'Fix the slow image build', state: 'review', project: { projectId: 'p1', title: 'project p1' } })] })
    expect(read.value.expired).toEqual({ value: [{ requestId: asked.requestId, at: expect.any(String), summary: 'Deploy the site' }] })
    // Nothing since now.
    expect((await call(`activity?since=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}`)).value).toMatchObject({ runs: { value: [] }, tasks: { value: [] }, expired: { value: [] } })
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
    const shown = (live.value.runs as { value: Array<Record<string, any>> }).value.find((r) => r.runId === run.runId)!
    expect(shown).toMatchObject({ template: 'solo', taskId: busy.taskId, steps: [{ nodeId: 'solo', attempt: 1, worker: expect.stringMatching(/^w:/), since: expect.any(String) }], lastEvent: { value: { type: expect.any(String), at: expect.any(String) } }, stalled: { value: null } })
    const since = new Date().toISOString()
    stalls(ctx, run.runId, since)
    live = await call('runs/live')
    expect((live.value.runs as { value: Array<Record<string, any>> }).value.find((r) => r.runId === run.runId)!.stalled).toEqual({ value: { since } })
    // A check of its result quiet past its bound, as the agents source tells it (T235): the run's explain lists it while it lasts.
    const quietSince = new Date().toISOString()
    ctx.eventLog.append({ type: 'agent-workers.check', runId: run.runId, data: { check: 'lint', command: 'corepack pnpm lint', state: 'stalled', quietSince, stallSeconds: 300, deadline: new Date(Date.now() + 600_000).toISOString() } })
    const explained = (await call(`runs/${encodeURIComponent(run.runId)}`)).value as { explain: { stalledChecks?: unknown } }
    expect(explained.explain.stalledChecks).toEqual([{ check: 'lint', command: 'corepack pnpm lint', since: expect.any(String), quietSince, stallSeconds: 300 }])
    ctx.eventLog.append({ type: 'agent-workers.check', runId: run.runId, data: { check: 'lint', command: 'corepack pnpm lint', state: 'resumed', stallSeconds: 300 } })
    expect(((await call(`runs/${encodeURIComponent(run.runId)}`)).value as { explain: { stalledChecks?: unknown } }).explain).not.toHaveProperty('stalledChecks')
    // A stall whose check's deadline passed is over, even with no `ended` (a restart cut the check).
    ctx.eventLog.append({ type: 'agent-workers.check', runId: run.runId, data: { check: 'lint', command: 'corepack pnpm lint', state: 'stalled', quietSince, stallSeconds: 300, deadline: new Date(Date.now() - 1000).toISOString() } })
    expect(((await call(`runs/${encodeURIComponent(run.runId)}`)).value as { explain: { stalledChecks?: unknown } }).explain).not.toHaveProperty('stalledChecks')
  })

  it('reads by state and newest first, bounded with more: a long run stays live, and is in the activity once it ends, however many runs started after it; an event log that fails or reads out of order is {unknown}, never a failed reply (T127 item 7, INV-2, INV-9)', async () => {
    const { ctx, call, workers } = await boot()
    const before = new Date().toISOString()
    await new Promise((resolve) => setTimeout(resolve, 5))
    workers.reply = (request) => (request.prompt.includes('the long one') ? 'hold' : { text: 'done' })
    const long = ctx.workflow.start({ template: 'solo', input: 'the long one', classification: 'public' })
    await vi.waitFor(() => expect(ctx.workflow.get(long.runId)?.nodes[0]?.state).toBe('RUNNING'), { timeout: 10_000 })
    // More runs start and end after it than the latest 100 the views read before.
    for (let i = 0; i < 101; i++) {
      const short = ctx.workflow.start({ template: 'solo', input: `short ${i}`, classification: 'public' })
      expect((await ctx.workflow.wait(short.runId, 30_000)).status).toBe('completed')
    }
    type Live = { runs: { value: Array<Record<string, any>>; more?: true } }
    const live = (await call('runs/live')).value as Live
    expect(live.runs.value.map((r) => r.runId)).toEqual([long.runId])
    expect(live.runs).not.toHaveProperty('more')
    expect(live.runs.value[0]).toMatchObject({ steps: [{ nodeId: 'solo', attempt: 1, since: expect.any(String) }], lastEvent: { value: { type: 'workflow.node.started', nodeId: 'solo' } } })

    // Unanswered requests, more than the activity lists.
    const verdict = await ctx.approvals.check({ class: 'deploy' })
    const asked: string[] = []
    for (let i = 0; i < 51; i++) asked.push((await ctx.approvals.request({ subject: { type: 'content', ref: `deploy:${i}`, version: '1' }, action: { class: 'deploy', summary: `Deploy ${i}` }, requester: { component: 'board', projectId: 'p1' }, verdict, classification: 'public' })).requestId)
    await ctx.approvals.sweep(new Date(Date.now() + 30 * 24 * 60 * 60_000))
    workers.release(workers.started.find((s) => s.prompt.includes('the long one'))!.id, { text: 'done at last' })
    expect((await ctx.workflow.wait(long.runId, 30_000)).status).toBe('completed')
    type Part = { value: Array<Record<string, any>>; more?: true } | { unknown: string }
    const activity = (await call(`activity?since=${encodeURIComponent(before)}`)).value as { runs: Part; tasks: Part; expired: Part }
    // The latest changed first: the long run ended last, and it is there.
    expect(activity.runs).toMatchObject({ value: expect.any(Array), more: true })
    expect((activity.runs as { value: Array<{ runId: string }> }).value).toHaveLength(50)
    expect((activity.runs as { value: Array<{ runId: string }> }).value[0]!.runId).toBe(long.runId)
    expect(activity.expired).toMatchObject({ value: expect.any(Array), more: true })
    const expired = (activity.expired as { value: Array<{ requestId: string }> }).value
    expect(expired).toHaveLength(50)
    expect(asked).toEqual(expect.arrayContaining(expired.map((x) => x.requestId)))
    expect(((await call('runs/live')).value as Live).runs).toEqual({ value: [] })

    // An event log that fails a newest-first read, or reads it oldest first: unknown with why, never a 500.
    const query = ctx.eventLog.query.bind(ctx.eventLog)
    onTestFinished(() => void (ctx.eventLog.query = query))
    const held = ctx.workflow.start({ template: 'solo', input: 'the long one again', classification: 'public' })
    await vi.waitFor(() => expect(ctx.workflow.get(held.runId)?.nodes[0]?.state).toBe('RUNNING'), { timeout: 10_000 })
    ctx.eventLog.query = ((filter: { order?: string }) => {
      if (filter.order === 'desc') throw new Error('the store is busy')
      return query(filter as never)
    }) as never
    const failing = await call('runs/live')
    expect(failing.status).toBe(200)
    expect((failing.value as Live).runs.value[0]).toMatchObject({ runId: held.runId, steps: [{ nodeId: 'solo' }], lastEvent: { unknown: 'the event log could not be read: the store is busy' } })
    expect((failing.value as Live).runs.value[0]!.steps[0]).not.toHaveProperty('since')
    const unread = await call(`activity?since=${encodeURIComponent(before)}`)
    expect(unread.status).toBe(200)
    expect(unread.value.expired).toEqual({ unknown: 'the event log could not be read: the store is busy' })
    ctx.eventLog.query = ((filter: { order?: string; limit?: number }) => query({ ...filter, order: 'asc', limit: Math.max(filter.limit ?? 2, 2) } as never)) as never
    expect(((await call('runs/live')).value as Live).runs.value[0]!.lastEvent).toEqual({ unknown: 'the event log could not be read: it did not read newest first (event log contract 1.1)' })
  })

  it('counts only what the operator can act on, the one count every page\'s title gives: open requests, reviews held for them, runs that wait for their own move, and runs outside the board that failed since they last looked (T127 item 8, INV-2)', async () => {
    const { ctx, call, client, workers } = await boot()
    await activeProject(ctx)
    type Waiting = { requests: { value: number }; reviews: { value: number; firstExpires?: string }; runs: { value: Array<{ runId: string }>; more?: true }; count: number; partial?: true }
    const read = async (since?: string): Promise<Waiting> => (await call(`waiting${since ? `?since=${encodeURIComponent(since)}` : ''}`)).value as Waiting
    expect((await call('waiting', undefined, client)).status).toBe(401)
    expect((await call('waiting?since=yesterday')).status).toBe(400)
    expect(await read()).toMatchObject({ requests: { value: 0 }, reviews: { value: 0 }, runs: { value: [] }, count: 0 })
    expect(await read()).not.toHaveProperty('partial')
    // A review held for the operator.
    await reviewed(ctx, 'Fix the slow image build')
    // A run outside the board that failed, which the operator may continue, and a board task's run that failed, which the board decides.
    workers.reply = () => ({ fail: 'reauth_required: the account must sign in again', disposition: 'USER_ACTION', sent: false })
    const failed = ctx.workflow.start({ template: 'solo', input: 'Compare the CDN offers', classification: 'public' })
    const task = await readyTask(ctx, 'Research the hosting options')
    const ofTask = await ctx.workflow.start({ template: 'solo', input: 'research', classification: 'public', task: { taskId: task.taskId } })
    for (const runId of [failed.runId, ofTask.runId]) await vi.waitFor(() => expect(ctx.workflow.get(runId)?.status).toBe('failed'), { timeout: 30_000 })
    // A run that waits for the operator's approval of its plan, which asks no request; and a run that merely runs.
    const plan = 'My plan.\n```json\n' + JSON.stringify({ confidence: 'high', nodes: [{ id: 'one', objective: 'Step one', prompt: 'step one', capabilities: ['develop'], tier: 'economy', dependsOn: [] }] }) + '\n```'
    workers.reply = (request) => (request.prompt.includes('Plan:') ? { text: plan } : 'hold')
    const planned = ctx.workflow.start({ template: 'planned', input: 'build it', classification: 'public' })
    const busy = ctx.workflow.start({ template: 'solo', input: 'work', classification: 'public' })
    await vi.waitFor(() => expect(ctx.workflow.get(planned.runId)?.blocked).toMatchObject({ kind: 'gate' }), { timeout: 30_000 })
    await vi.waitFor(() => expect(ctx.workflow.get(busy.runId)?.nodes[0]?.state).toBe('RUNNING'), { timeout: 30_000 })
    // An open request.
    const verdict = await ctx.approvals.check({ class: 'deploy' })
    await ctx.approvals.request({ subject: { type: 'content', ref: 'deploy:site', version: '1' }, action: { class: 'deploy', summary: 'Deploy the site' }, requester: { component: 'board', projectId: 'p1' }, verdict, classification: 'public' })

    const all = await read()
    expect(all).toMatchObject({ requests: { value: 1 }, reviews: { value: 1, firstExpires: expect.any(String) }, count: 4 })
    expect(all.runs.value.map((r) => r.runId).sort()).toEqual([failed.runId, planned.runId].sort())
    // Once the operator marked Home as seen after the failure, it is seen: no longer counted.
    const seen = await read(new Date().toISOString())
    expect(seen.runs.value.map((r) => r.runId)).toEqual([planned.runId])
    expect(seen.count).toBe(3)
  })

  headlessIt('leads a failed run on Home\'s Since you last looked with the run page\'s plain-words reason, the system\'s own text folded under it (T160)', async () => {
    const { ctx, workers } = await boot()
    workers.reply = () => ({ fail: 'reauth_required', disposition: 'USER_ACTION', sent: false })
    const failed = ctx.workflow.start({ template: 'solo', input: 'Compare the CDN offers', classification: 'public' })
    await vi.waitFor(() => expect(ctx.workflow.get(failed.runId)?.status).toBe('failed'), { timeout: 30_000 })
    const error = ctx.workflow.get(failed.runId)!.error!
    expect(error).toMatchObject({ kind: 'reauth_required', message: expect.stringContaining('scripted reauth_required') })
    // What the failure asks of the operator, in the run page's words for its disposition.
    const next = ({ USER_ACTION: 'it needs you', BACKOFF: 'it is tried again later', CODE_FIX: 'it needs a fix in the code or configuration', NONE: 'nothing more happens' } as Record<string, string>)[error.disposition]
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch(headlessLaunchOptions())
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    await page.evaluate((at) => localStorage.setItem('system.seen', JSON.stringify({ at, workers: {} })), new Date(Date.now() - 3_600_000).toISOString())
    await page.reload()
    const since = page.getByRole('region', { name: 'Since you last looked' })
    const item = since.locator('li', { hasText: 'Failed: a solo run' })
    await expect.poll(() => item.count(), { timeout: 15_000 }).toBe(1)
    // The reason in words first, as the run page says it (failureReason); the raw text only once opened.
    expect(await item.innerText()).toMatch(new RegExp(`^Failed: a solo run — its account must sign in again${next ? ` \\(${next}\\)` : ''} open the run`))
    expect(await item.locator('details').getAttribute('open')).toBeNull()
    expect(await item.getByText('scripted reauth_required').isVisible()).toBe(false)
    await item.getByText('What the system said').click()
    expect(await item.getByText('scripted reauth_required').isVisible()).toBe(true)
    // Home and the run page agree: the run page leads its failure with the very reason Home showed, then the raw text.
    const reason = /^Failed: a solo run — (.+?) open the run/.exec(await item.innerText())![1]!
    await page.goto(`${origin}/ui/?run=${encodeURIComponent(failed.runId)}#token=${OPERATOR}`)
    // Its status line (T172): the Failed chip, where it failed, then that reason and the raw text.
    const status = page.locator('.status-line')
    await expect.poll(() => status.count(), { timeout: 15_000 }).toBe(1)
    expect(await status.innerText()).toMatch(/^■ Failed\s+at solo: /)
    expect(await status.innerText()).toContain(`: ${reason} — ${error.message}`)
  }, 90_000)

  headlessIt('shows on Home what happened since the operator last looked, until marked as seen; names the waiting count in the window\'s title; the start names who would likely take it; a running run\'s page and card say where it is, and a stall (T124)', async () => {
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
    const browser = await chromium.launch(headlessLaunchOptions())
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
    // Recent runs: by the task's title, its state as a chip, its progress and current Worker in sight; each step with its Worker's display name folded (T171).
    const recent = page.locator('table tr', { hasText: 'Research the hosting options' })
    expect(await recent.innerText()).toMatch(/Running/)
    expect(await recent.innerText()).toMatch(/0\/1 steps · running: solo · Conformance · \w+ · \w+/)
    expect(await recent.textContent()).toMatch(/solo: Conformance · \w+ · \w+/)

    // The Board: the start names who would likely take it; the running card its last event, then a stall.
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Board' }).click()
    await expect.poll(() => page.title()).toBe('(1) system — Board')
    await page.getByRole('button', { name: 'Start Write the release notes' }).click()
    const confirming = page.getByRole('group', { name: 'Confirm start of Write the release notes' })
    await expect.poll(() => confirming.innerText()).toMatch(/Likely: Conformance · (frontier|standard) · (frontier|standard)/)
    await confirming.getByRole('button', { name: 'Cancel' }).click()
    stalls(ctx, run.runId, new Date().toISOString())
    const card = page.getByRole('region', { name: 'Working', exact: true }).getByRole('article', { name: 'Research the hosting options' })
    // Its last event under its Details (T239); a stall in sight.
    await expect.poll(() => card.textContent(), { timeout: 15_000 }).toMatch(/last event: .+ ago/)
    await expect.poll(() => card.innerText(), { timeout: 15_000 }).toMatch(/Stalled since .+: no activity past its source's bound/)
    // Its run's page: the step on its Worker and for how long, its last event, and the stall.
    await card.getByRole('link', { name: 'Open the run of Research the hosting options' }).click()
    const now = page.getByRole('region', { name: 'Now' })
    await expect.poll(() => now.count()).toBe(1)
    expect(await now.innerText()).toMatch(/^Now\b[^\n]*\nStep solo on Conformance · \w+ · \w+, for (<1 min|\d+ min)/)
    expect(await now.innerText()).toMatch(/last event: .+ ago/)
    expect(await now.getByRole('alert').innerText()).toMatch(/^Stalled since /)
    // A check of its result quiet past its bound (T235): the run's page says so under Checks.
    ctx.eventLog.append({ type: 'agent-workers.check', runId: run.runId, data: { check: 'lint', command: 'corepack pnpm lint', state: 'stalled', quietSince: new Date().toISOString(), stallSeconds: 300 } })
    const checks = page.getByRole('region', { name: 'Checks' })
    await expect.poll(() => checks.count(), { timeout: 15_000 }).toBe(1)
    expect(await checks.innerText()).toMatch(/Check stalled\s*lint: no output since .+ · it goes on until its deadline/)
    expect(task.state).toBe('review')
  }, 90_000)
})
