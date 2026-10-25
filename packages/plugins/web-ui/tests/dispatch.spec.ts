import type { Context } from '@deepseek-ai/cordis'
import type { PoolConfig } from '@tsuuanmi/system-resources-core'
import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { worker } from '../../../workers-core/conformance/workers.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { boot, OPERATOR } from './store-backed.ts'

// Home's "Starts awaiting approval" (ADR-0064, PROP-0014 D1) over the store-backed board, approval queue,
// resource ledger, and engine, under the bundle's own studio policy (dispatch takes its default: ask).
vi.setConfig({ testTimeout: 120_000 })

const POOLS: PoolConfig[] = [{ pool: 'plan/max', account: 'max', kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }] }]

/** One Worker of the pooled account, idle, its 5 h window read just now at `used` percent. */
async function freeWorker(ctx: Context, workers: { extra: unknown[] }, used = 0): Promise<void> {
  workers.extra = [worker('w:max', { schema: 'capability-descriptor@1.5', tier: 'standard', quotaClass: 'agent-plan', proves: ['reason'], account: { id: 'max', group: 'g', mode: 'assigned' }, load: { running: 0, queued: 0, pending: 0, slots: 1 } })]
  await ctx.resources.observe({
    schema: 'limit-state@1.0', pool: 'plan/max', account: 'max', window: { id: 'five-hour', kind: 'rolling', seconds: 18_000 }, state: 'ok', usedPercentage: used,
    resetsAt: new Date(Date.now() + 40 * 60_000).toISOString(), source: 'runtime-result', observedAt: new Date().toISOString(),
  })
}

describe('web UI: the starts System proposes, on Home (ADR-0064)', () => {
  it('serves dispatch to the operator only: its settings, the asks with their Worker and windows, the bounds, and the last pass', async () => {
    const { ctx, call, client, workers } = await boot({ pools: POOLS })
    await activeProject(ctx)
    await freeWorker(ctx, workers)
    const task = await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    await ctx.workflow.sweepDispatch()
    expect((await call('dispatch', undefined, client)).status).toBe(401)
    const read = await call('dispatch')
    expect(read.status).toBe(200)
    expect(read.value).toMatchObject({
      enabled: true, settings: { maxOpenAsks: 4, maxRunningPerAccount: 1 },
      bounds: { openAsks: { used: 1, max: 4 }, running: { used: 1, max: 8 } },
      asks: [{ taskId: task.taskId, title: 'Write the release notes', state: 'asked', worker: 'w:max', attempt: 1, windows: [{ name: '5 h', used: 0, headroom: 80, reserve: 20 }] }],
      lastPass: { state: 'ran', took: [{ taskId: task.taskId, worker: 'w:max', how: 'asked' }] },
    })
    expect((await call('dispatch', {})).status).toBe(405)
  })

  it.runIf(canRunBrowser)('lists each proposed start under Starts awaiting approval with its Worker and quota line, why that Worker folded, starts it on Approve, and says when dispatch is paused', async () => {
    const { ctx, workers } = await boot({ pools: POOLS })
    await activeProject(ctx)
    await freeWorker(ctx, workers, 12)
    workers.reply = () => 'hold'
    const task = await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    await ctx.workflow.sweepDispatch()
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const go = page.getByRole('region', { name: 'Starts awaiting approval' })
    await expect.poll(() => go.innerText()).toContain('Write the release notes · attempt 1 · Conformance')
    const said = await go.innerText()
    expect(said).toMatch(/5 h · used 12 % · reserve 20 % · resets /)
    expect(said).toMatch(/Expires in .+ · No response: denied/)
    // Why that Worker, when its quota was read, and its project: folded under the start (T171).
    expect(said).toContain('Why this Worker?')
    expect(said).not.toContain('tier standard, agent-plan, known')
    expect(await go.textContent()).toMatch(/Why this Worker\?tier standard, agent-plan, known/)
    // The request itself is in the queue too, described as a start.
    expect(await page.getByRole('region', { name: 'Approval queue' }).innerText()).toMatch(/Approve: start it/)
    await go.getByRole('button', { name: 'Approve the start of Write the release notes' }).click()
    await vi.waitFor(async () => expect((await ctx.approvals.list({ states: ['approved'] })).filter((r) => r.action.class === 'dispatch')).toHaveLength(1), { timeout: 15_000 })
    await ctx.workflow.sweepDispatch()
    await vi.waitFor(() => expect(workers.started.map((s) => s.worker)).toEqual(['w:max']), { timeout: 15_000 })
    expect((await ctx.board.task(task.taskId))!.state).toBe('running')
    ctx.workflow.pauseDispatch('a quiet afternoon')
    await page.reload()
    await expect.poll(() => go.innerText()).toMatch(/Automatic starts paused · a quiet afternoon · since /)
    // How to resume is folded beside it.
    expect(await go.innerText()).toContain('How to resume')
    expect(await go.textContent()).toContain('System proposes no start until you resume it: system dispatch resume.')
  }, 90_000)
})
