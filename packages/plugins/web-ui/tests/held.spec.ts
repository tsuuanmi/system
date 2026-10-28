import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { headlessIt, headlessLaunchOptions } from '../../browser-patchright/tests/support.ts'
import { activeProject } from '../../workflow/conformance/workflow.ts'
import { decideTogether, digestLines, heldOrder, whyHeld, type NotRun, type Send } from '../client/heldbatch.ts'
import type { ReviewCard } from '../src/api.ts'
import { boot, OPERATOR, reviewed, type Booted } from './store-backed.ts'

// The results held for the operator, decided together (T336): each its own decision, over the store-backed board and the web UI's real API.
vi.setConfig({ testTimeout: 120_000 })

const card = (over: Partial<ReviewCard>): ReviewCard => ({ taskId: 't', title: 't', actionClass: 'workspace-write', subject: { type: 'git-head', ref: 'a' }, artifacts: [], project: { projectId: 'p1' }, pendingChecks: [], heldFor: 'operator', expiresAt: '2026-10-28T10:00:00.000Z', ...over })

/** What the page sends for a row: the reviews endpoint's decision, its refusal thrown as the server's words. */
const sender = (call: Booted['call']): Send => async (row, verdict, note, checksNotRun) => {
  const sent = await call(`reviews/${row.taskId}/decide`, { verdict, subject: row.subject, note, ...(Object.keys(checksNotRun).length ? { checksNotRun } : {}) })
  if (sent.status !== 200) throw new Error(String(sent.value.error))
  return { decision: sent.value.decision as string, task: (sent.value.task as { state: string }).state }
}
const none = (): NotRun => ({ needed: [], given: {} })
const reason = (error: unknown) => (error as Error).message
const held = async (call: Booted['call']): Promise<ReviewCard[]> => heldOrder((await call('reviews')).value.reviews as ReviewCard[])

describe('web UI: the results held for the operator, decided together (T336)', () => {
  it('lists every held result oldest expiry first, and says why each is held: its hold decision\'s words, else the checks pending or not run', () => {
    const list = [card({ taskId: 'b', expiresAt: '2026-10-28T12:00:00.000Z' }), card({ taskId: 'a', expiresAt: '2026-10-28T09:00:00.000Z' }), card({ taskId: 'c', heldFor: 'reviewer' }), (() => { const d = card({ taskId: 'd' }); delete d.expiresAt; return d })()]
    expect(heldOrder(list).map((r) => r.taskId)).toEqual(['a', 'b'])
    expect(whyHeld(card({ holdReason: 'the result is heavy-tier: never accepted automatically' }))).toBe('the result is heavy-tier: never accepted automatically')
    expect(whyHeld(card({ pendingChecks: ['tests', 'lint'], checks: { value: [{ check: 'tests', state: 'failed', exitCode: 1 }, { check: 'lint', state: 'pending', why: 'x' }] } }))).toBe('checks failed: tests; checks not run: lint')
    expect(whyHeld(card({ checks: { value: [{ check: 'tests', state: 'passed', exitCode: 0, notRun: 'its browser tests' }] } }))).toMatch(/^checks passed, browser tests not run: tests/)
    expect(digestLines('\n  first\n\nsecond\nthird\nfourth')).toEqual(['first', 'second', 'third'])
  })

  it('records three held results accepted together as three decisions, each with the same note, one after another', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const tasks = [(await reviewed(ctx, 'one')).task, (await reviewed(ctx, 'two')).task, (await reviewed(ctx, 'three')).task]
    const rows = await held(call)
    expect(rows).toHaveLength(3)
    const results = await decideTogether(rows, 'accept', 'read all three', none, sender(call), reason)
    expect([...results.values()].map((r) => r.state)).toEqual(['recorded', 'recorded', 'recorded'])
    const decisions = new Set([...results.values()].map((r) => (r as { decision: string }).decision))
    expect(decisions.size).toBe(3)
    for (const task of tasks) {
      const done = (await ctx.board.task(task.taskId))!
      expect(done).toMatchObject({ state: 'done' })
      expect(ctx.artifacts.get(done.result!.acceptance!)!.body).toMatchObject({ decider: { type: 'operator' }, rationale: 'read all three', outcome: { option: 'accept', detail: { taskId: task.taskId } } })
    }
    // A decided row leaves the list.
    expect(await held(call)).toEqual([])
  })

  it('holds back a row that needs a why for a check not run until it has one, and sends the rest', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const needing = (await reviewed(ctx, 'needs a note')).task, plain = (await reviewed(ctx, 'plain')).task
    const rows = await held(call)
    let asked: NotRun = { needed: ['lint'], given: {} }
    const sent: string[] = []
    const send = sender(call)
    const spy: Send = (row, verdict, note, notRun) => { sent.push(row.taskId + ':' + JSON.stringify(notRun)); return send(row, verdict, note, notRun) }
    const notRun = (r: ReviewCard): NotRun => (r.taskId === needing.taskId ? asked : none())
    const first = await decideTogether(rows, 'accept', 'ok', notRun, spy, reason)
    expect(first.get(needing.taskId)).toEqual({ state: 'needs-note', checks: ['lint'] })
    expect(first.get(plain.taskId)).toMatchObject({ state: 'recorded' })
    expect(sent).toEqual([plain.taskId + ':{}'])
    expect(await ctx.board.task(needing.taskId)).toMatchObject({ state: 'review' })
    // Sending it back needs no why: that row is sent as it is.
    asked = { needed: ['lint'], given: {} }
    // With its why, it is sent, naming the check.
    asked = { needed: ['lint'], given: { lint: 'no lint command is configured' } }
    const second = await decideTogether([rows.find((r) => r.taskId === needing.taskId)!], 'accept', 'ok', notRun, spy, reason)
    expect(second.get(needing.taskId)).toMatchObject({ state: 'recorded' })
    expect(sent[1]).toBe(needing.taskId + ':{"lint":"no lint command is configured"}')
  })

  it('sends back together without asking for a why, and shows a refused row\'s server reason while the others are recorded and the refused stays in review', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const a = (await reviewed(ctx, 'a')).task, b = (await reviewed(ctx, 'b')).task
    const rows = await held(call)
    // One row's page is stale: its result is not the one the board holds now (INV-5).
    const stale = rows.map((r) => (r.taskId === b.taskId ? { ...r, subject: { ...r.subject, ref: 'sha256:other' } } : r))
    const results = await decideTogether(stale, 'reject', 'try again', () => ({ needed: ['lint'], given: {} }), sender(call), reason)
    expect(results.get(a.taskId)).toMatchObject({ state: 'recorded', task: 'ready' })
    const refused = results.get(b.taskId)
    expect(refused).toMatchObject({ state: 'refused' })
    expect((refused as { reason: string }).reason).not.toBe('')
    expect(await ctx.board.task(b.taskId)).toMatchObject({ state: 'review' })
    expect((await held(call)).map((r) => r.taskId)).toEqual([b.taskId])
  })

  headlessIt('shows a "Held for you" section at the top of Reviews: a row each, select two and accept them together; the decided rows leave at once and Home\'s count follows', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    await reviewed(ctx, 'Keep the first header')
    await reviewed(ctx, 'Keep the second header')
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch(headlessLaunchOptions())
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const section = page.getByRole('region', { name: 'Held for you' })
    await expect.poll(() => section.locator('li.held-row').count(), { timeout: 15_000 }).toBe(2)
    expect(await section.innerText()).toContain('Keep the first header')
    await section.getByRole('checkbox', { name: 'Select Keep the first header' }).check()
    await section.getByRole('checkbox', { name: 'Select Keep the second header' }).check()
    await section.getByLabel('Note for all (optional)').fill('read both')
    // Their tests and lint are pending: each asks for why they did not run, in its row, and is not sent without it.
    await section.getByRole('button', { name: 'Accept 2 selected' }).click()
    await expect.poll(() => section.getByText(/Not sent: say why tests, lint did not run/).count(), { timeout: 15_000 }).toBe(2)
    expect((await call('reviews')).value.reviews).toHaveLength(2)
    // The page redraws every 5 seconds, on a loaded host between two steps: fill and press again until they are decided.
    await expect.poll(async () => {
      if (((await call('reviews')).value.reviews as unknown[]).length) {
        for (const input of await section.getByLabel(/Accept with (tests|lint) not run, because/).all()) await input.fill('no browser here')
        await section.getByRole('button', { name: 'Accept 2 selected' }).click({ timeout: 5_000 })
      }
      return (await call('reviews')).value.reviews
    }, { timeout: 45_000, interval: 2_000 }).toEqual([])
    await expect.poll(() => section.count(), { timeout: 15_000 }).toBe(0)
    expect(await page.getByRole('button', { name: 'Accept', exact: true }).count()).toBe(0)
    expect((await call('waiting')).value.reviews).toEqual({ value: 0 })
  }, 90_000)
})
