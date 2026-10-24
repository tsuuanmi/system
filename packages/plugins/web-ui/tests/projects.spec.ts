import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { ArtifactRef, Project } from '@tsuuanmi/system-board-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { type Booted, boot, OPERATOR, reviewed } from './store-backed.ts'

// The operator's project moves end to end, through the web UI's API, over the store-backed board,
// approval queue, and engine, under the bundle's own default studio policy
// (docs/design/board.md#the-operators-project-moves). Only Worker execution is scripted.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

/** The page's listing of one project. */
async function listed(booted: Booted, projectId = 'p1'): Promise<Record<string, any>> {
  const { status, value } = await booted.call('projects')
  expect(status).toBe(200)
  const project = (value.projects as Array<Record<string, any>>).find((p) => p.projectId === projectId)
  expect(project, projectId).toBeDefined()
  return project!
}

/** The board decision a move recorded, every candidate with a reason (INV-13). */
function boardDecision(booted: Booted, ref: string): { candidates: Array<{ option: string; selected: boolean; reasons: string[] }>; outcome: { option: string; detail: Record<string, unknown> } } {
  const body = booted.ctx.artifacts.get(ref as ArtifactRef)!.body as ReturnType<typeof boardDecision> & { decisionType: string; schema: string }
  schemas.assertRecord(body)
  expect(body.decisionType).toBe('board')
  for (const candidate of body.candidates) expect(candidate.reasons.join('').trim(), candidate.option).not.toBe('')
  return body
}

const open = async (booted: Booted): Promise<ApprovalRequest[]> => ((await booted.call('approvals')).value.batches as Array<{ requests: ApprovalRequest[] }>).flatMap((b) => b.requests)

describe('web UI: the operator pauses, resumes, and closes a project on the board', () => {
  it('lists the projects and pauses one for the operator\'s token only, bound to the revision shown: a paused project starts no run and gates nothing; resumed, it gates its proposed task and runs it (INV-5, INV-6, INV-13)', async () => {
    const booted = await boot()
    const { ctx, call, client } = booted
    await activeProject(ctx)
    const ready = await readyTask(ctx, 'ready')
    const later = await ctx.board.propose({ projectId: 'p1', title: 'later', goal: 'do later', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read' })
    const shown = await listed(booted)
    expect(shown).toMatchObject({ projectId: 'p1', title: 'project p1', state: 'active', charter: { version: 1 }, open: { proposed: 1, ready: 1, running: 0, review: 0 } })

    // Only the operator's channel moves a project (INV-6): a client token is refused by the guard before any route.
    expect((await call('projects', undefined, client)).status).toBe(401)
    expect((await call('projects/p1/pause', { revision: shown.revision }, client)).status).toBe(401)
    // The move binds to the project the page showed (INV-5); a malformed one is refused; nothing moves.
    expect((await call('projects/p1/pause', { revision: shown.revision - 1 })).status).toBe(409)
    expect((await call('projects/p1/pause', {})).status).toBe(400)
    expect((await call('projects/p1/halt', { revision: shown.revision })).status).toBe(404)
    expect((await call('projects/nope/pause', { revision: 0 })).status).toBe(404)
    expect((await ctx.board.project('p1'))?.revision).toBe(shown.revision)

    const paused = await call('projects/p1/pause', { revision: shown.revision })
    expect(paused.status, JSON.stringify(paused.value)).toBe(200)
    schemas.assertRecord(paused.value.project as Project)
    expect(paused.value.project).toMatchObject({ state: 'paused', revision: shown.revision + 1, lastDecision: paused.value.decision })
    const pausing = boardDecision(booted, paused.value.decision as string)
    expect(pausing.outcome.option).toBe('paused')
    expect(pausing.candidates.find((c) => !c.selected)?.reasons).toEqual(['not kept active: the operator paused it'])
    const again = await call('projects/p1/pause', { revision: shown.revision + 1 })
    expect([again.status, again.value.error]).toEqual([409, expect.stringMatching(/^invalid-transition: /)])

    // Paused: the engine starts no run for its ready task, and the sweep gates nothing.
    await expect(ctx.workflow.start({ template: 'solo', input: 'go', classification: 'public', task: { taskId: ready.taskId } })).rejects.toThrow(/p1 is paused, not active.*nothing was started/)
    await ctx.board.sweep(new Date())
    expect(await ctx.board.task(later.taskId)).toMatchObject({ state: 'proposed' })
    expect(await listed(booted)).toMatchObject({ state: 'paused', open: { proposed: 1, ready: 1 } })

    const resumed = await call('projects/p1/resume', { revision: shown.revision + 1 })
    expect(resumed.status, JSON.stringify(resumed.value)).toBe(200)
    expect(boardDecision(booted, resumed.value.decision as string).outcome.option).toBe('active')
    await ctx.board.sweep(new Date())
    expect(await ctx.board.task(later.taskId)).toMatchObject({ state: 'ready' })
    const run = await ctx.workflow.start({ template: 'solo', input: 'go', classification: 'public', task: { taskId: later.taskId } })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.task?.phase).toBe('reported'), { timeout: 60_000, interval: 25 })
    expect(await ctx.board.task(later.taskId)).toMatchObject({ state: 'done' })
  })

  it('refuses to close a project while a task is in review, then closes it: its open tasks cancelled, a claim released, and the requests its waiting task and pending amendment were on withdrawn in the queue (INV-6, INV-13)', async () => {
    const booted = await boot()
    const { ctx, call, client } = booted
    await activeProject(ctx)
    const { task: inReview } = await reviewed(ctx, 'kernel')
    const claimed = await readyTask(ctx, 'claimed')
    await ctx.board.claim(claimed.taskId, 'lead', 600_000)
    const merge = await ctx.board.propose({ projectId: 'p1', title: 'merge', goal: 'merge the branch', acceptance: [{ id: 'a1', statement: 'merged' }], actionClass: 'merge' })
    const proposed = await ctx.board.propose({ projectId: 'p1', title: 'proposed', goal: 'do it', acceptance: [{ id: 'a1', statement: 'done' }], actionClass: 'read', dependsOn: [inReview.taskId] })
    await ctx.board.sweep(new Date())
    const waitedOn = (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!
    const { approvalRequest: amendment } = await ctx.board.charter({ projectId: 'p1', title: 'project p1', charter: { ...CHARTER, version: 2 } })
    expect((await open(booted)).map((r) => r.requestId).sort()).toEqual([waitedOn, amendment].sort())

    let shown = await listed(booted)
    expect(shown).toMatchObject({ state: 'active', amendment: 2, open: { review: 1, claimed: 1, 'waiting-for-approval': 1, proposed: 1 } })
    expect((await call('projects/p1/close', { revision: shown.revision, outcome: 'stopped' }, client)).status).toBe(401)
    expect((await call('projects/p1/close', { revision: shown.revision, outcome: 'abandoned' })).status).toBe(400)
    const refused = await call('projects/p1/close', { revision: shown.revision, outcome: 'stopped' })
    expect([refused.status, refused.value.error]).toEqual([409, expect.stringMatching(/^invalid-transition: p1 has a task running or in review/)])
    expect(await ctx.board.task(merge.taskId)).toMatchObject({ state: 'waiting-for-approval' })

    // The operator decides the review first, on the same page's API.
    expect((await call(`reviews/${inReview.taskId}/decide`, { verdict: 'accept', subject: inReview.result!.subject })).status).toBe(200)
    await ctx.board.sweep(new Date())
    shown = await listed(booted)
    const closed = await call('projects/p1/close', { revision: shown.revision, outcome: 'stopped' })
    expect(closed.status, JSON.stringify(closed.value)).toBe(200)
    const project = (await ctx.board.project('p1'))!
    schemas.assertRecord(project)
    expect(project).toMatchObject({ state: 'closed', closure: { outcome: 'stopped', decision: closed.value.decision } })
    expect(project.proposedCharter).toBeUndefined()
    const closing = boardDecision(booted, closed.value.decision as string)
    expect(closing.outcome).toMatchObject({ option: 'closed', detail: { outcome: 'stopped', cancelled: 3 } })

    expect(await ctx.board.task(inReview.taskId)).toMatchObject({ state: 'done' })
    for (const t of [claimed, merge, proposed]) expect(await ctx.board.task(t.taskId), t.title).toMatchObject({ state: 'cancelled', cancellation: { reason: 'project-closed' } })
    expect(ctx.leases.current(`board-task:${claimed.taskId}`)).toBeUndefined()
    for (const requestId of [waitedOn, amendment]) expect(await ctx.approvals.get(requestId), requestId).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    expect(await open(booted)).toEqual([])
    // Closed is final: listed last, with its closure, and no move applies to it.
    expect(await listed(booted)).toMatchObject({ state: 'closed', closure: { outcome: 'stopped' }, open: { proposed: 0, claimed: 0, 'waiting-for-approval': 0 } })
    for (const move of ['close', 'pause', 'resume']) expect((await call(`projects/p1/${move}`, { revision: project.revision, outcome: 'achieved' })).status, move).toBe(409)
  })

  it.runIf(canRunBrowser)('founds a project from the queue in a real browser: the charter says what approving and denying do, the approval is recorded and shown with its id, and the board activates the project (T84)', async () => {
    const booted = await boot()
    const { ctx } = booted
    const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'project p1', charter: CHARTER })
    for (const title of ['first', 'second']) await ctx.board.propose({ projectId: 'p1', title, goal: `do ${title}`, acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read' })
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const card = page.getByRole('article', { name: 'Found project project p1 (charter version 1)' })
    await expect.poll(() => card.count()).toBe(1)
    const text = await card.innerText()
    for (const said of ['Asked by the board of project project p1', 'request ' + approvalRequest, 'charter version 1 of project p1',
      '2 proposed task(s) go through the autonomy policy', 'is closed as abandoned, and 2 open task(s) are cancelled', 'unanswered by then, it counts as denied']) expect(text, said).toContain(said)
    await card.getByRole('textbox', { name: 'Note with your verdict on this request (optional)' }).fill('go')
    await card.getByRole('button', { name: 'Approve: activate project p1' }).click()
    const outcome = page.locator('#outcome')
    await expect.poll(() => outcome.innerText()).toContain('Approved: Found project project p1 (charter version 1)')
    const request = await ctx.approvals.get(approvalRequest)
    expect(request).toMatchObject({ state: 'approved', resolution: { cause: 'verdict' } })
    expect(await outcome.innerText()).toContain(`Recorded as your verdict on request ${approvalRequest} (approval record ${request!.resolution!.approval})`)
    expect(ctx.artifacts.get(request!.resolution!.approval!)!.body).toMatchObject({ verdict: 'approved', by: 'operator', note: 'go' })
    // The queue no longer lists it; the board's next sweep activates the project.
    await expect.poll(() => page.locator('main').innerText()).toContain('Nothing waits for your verdict.')
    await ctx.board.sweep(new Date())
    expect((await ctx.board.project('p1'))?.state).toBe('active')
    await outcome.getByRole('button', { name: 'Dismiss' }).click()
    expect(await outcome.innerText()).toBe('')
  }, 60_000)

  it.runIf(canRunBrowser)('shows the Board as a Kanban: a column per state with one card per task, who works on it, its run, a project filter, and the moves in each project\'s header (T97)', async () => {
    const booted = await boot()
    const { ctx, workers } = booted
    await activeProject(ctx)
    const { approvalRequest } = await ctx.board.charter({ projectId: 'p2', title: 'Handbook rewrite', charter: CHARTER })
    const charter = await ctx.approvals.get(approvalRequest)
    await ctx.approvals.decide([{ requestId: approvalRequest, subject: charter!.subject, verdict: 'approved' }])
    await ctx.board.sweep(new Date())
    await readyTask(ctx, 'Write the release notes')
    await reviewed(ctx, 'Fix the slow image build')
    await ctx.board.propose({ projectId: 'p1', title: 'Merge the login fix', goal: 'merge the branch', acceptance: [{ id: 'a1', statement: 'merged' }], actionClass: 'merge' })
    await ctx.board.propose({ projectId: 'p2', title: 'Outline the chapters', goal: 'outline', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read' })
    await ctx.board.sweep(new Date())
    // A task whose run is on a Worker now.
    const busy = await readyTask(ctx, 'Research the hosting options')
    workers.reply = () => 'hold'
    const run = await ctx.workflow.start({ template: 'solo', input: 'research', classification: 'public', task: { taskId: busy.taskId } })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.nodes[0]?.state).toBe('RUNNING'), { timeout: 10_000 })
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/?view=board#token=${OPERATOR}`)
    const column = (name: string) => page.getByRole('region', { name, exact: true })
    await expect.poll(() => column('Ready').innerText()).toContain('Write the release notes')
    expect(await column('Ready').innerText()).toContain('Outline the chapters')
    expect(await column('Review').innerText()).toContain('Fix the slow image build')
    expect(await column('Waiting for you').innerText()).toContain('Merge the login fix')
    const card = column('Working').getByRole('article', { name: 'Research the hosting options' })
    expect(await card.innerText()).toMatch(/Conformance · standard · standard, for less than a minute/)
    await card.getByRole('link', { name: 'Open the run of Research the hosting options' }).click()
    await expect.poll(() => page.getByRole('heading', { name: `Run ${run.runId}` }).count()).toBe(1)
    await page.goBack()
    // Several projects: all by default, each card naming its project; the filter shows one.
    await expect.poll(() => column('Ready').innerText()).toContain('Handbook rewrite')
    expect(await page.getByLabel('Capacity').innerText()).toMatch(/Workers? idle · 2 tasks ready\. A ready task starts when the lead runs it/)
    await page.getByLabel('Show').selectOption('p2')
    await expect.poll(() => column('Ready').innerText()).not.toContain('Write the release notes')
    expect(await column('Ready').innerText()).toContain('Outline the chapters')
    expect(await page.getByRole('button', { name: 'Pause p1' }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Pause p2' }).count()).toBe(1)
    // Done and Cancelled are folded.
    expect(await page.locator('details', { hasText: 'Done (' }).getAttribute('open')).toBeNull()
  }, 90_000)

  it.runIf(canRunBrowser)('links each pending decision on the Board to its card: a charter, and a task waiting for approval (T97)', async () => {
    const booted = await boot()
    const { ctx } = booted
    await activeProject(ctx)
    const merge = await ctx.board.propose({ projectId: 'p1', title: 'Merge the login fix', goal: 'merge the branch', acceptance: [{ id: 'a1', statement: 'merged' }], actionClass: 'merge' })
    await ctx.board.sweep(new Date())
    const waiting = (await ctx.board.task(merge.taskId))!.waiting!.approvalRequest!
    const { approvalRequest } = await ctx.board.charter({ projectId: 'docs', title: 'Handbook rewrite', charter: CHARTER })
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?view=board#token=${OPERATOR}`)
    await expect.poll(() => page.locator('main').innerText()).toContain('Its charter waits for your verdict')
    expect(await page.locator('main').innerText()).toContain('1 task(s) wait for your approval')
    await page.getByRole('link', { name: 'decide it', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`request-${approvalRequest}`)
    expect(new URL(page.url()).search).toBe(`?request=${approvalRequest}`)
    await page.goto(`${origin}/ui/?view=board#token=${OPERATOR}`)
    await expect.poll(() => page.locator('main').innerText()).toContain('wait for your approval')
    await page.getByRole('link', { name: 'Allow a merge step: Merge the login fix' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`request-${waiting}`)
  }, 60_000)

  it.runIf(canRunBrowser)('pauses a project in a real browser only after a confirmation that says what a pause does, and closes it after one that counts what a close cancels; Cancel moves nothing', async () => {
    const booted = await boot()
    const { ctx } = booted
    await activeProject(ctx)
    await readyTask(ctx, 'ready')
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    await page.getByRole('link', { name: 'Board' }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Board' }).count()).toBe(1)
    expect(await page.locator('main').innerText()).toContain('project p1')
    expect(await page.locator('main').innerText()).not.toContain('null')

    await page.getByRole('button', { name: 'Pause p1' }).click()
    const pausing = page.getByRole('group', { name: 'Confirm pause of p1' })
    await expect.poll(() => pausing.innerText()).toContain('no task of it is claimed or started')
    expect((await ctx.board.project('p1'))?.state).toBe('active')
    await pausing.getByRole('button', { name: 'Confirm pause' }).click()
    await expect.poll(async () => (await ctx.board.project('p1'))?.state).toBe('paused')
    await expect.poll(() => page.getByRole('button', { name: 'Resume p1' }).count()).toBe(1)

    await page.getByRole('button', { name: 'Close p1' }).click()
    const closing = page.getByRole('group', { name: 'Confirm close of p1' })
    await expect.poll(() => closing.innerText()).toContain('1 open task(s) are cancelled')
    await closing.getByRole('button', { name: 'Cancel' }).click()
    expect(await closing.count()).toBe(0)
    expect((await ctx.board.project('p1'))?.state).toBe('paused')
    await page.getByRole('button', { name: 'Close p1' }).click()
    await page.getByRole('combobox', { name: 'Outcome of p1' }).selectOption('stopped')
    await page.getByRole('button', { name: 'Confirm close' }).click()
    await expect.poll(async () => (await ctx.board.project('p1'))?.closure?.outcome).toBe('stopped')
    await expect.poll(() => page.locator('main').innerText()).toContain('closed (stopped)')
    expect(await page.getByRole('button', { name: 'Close p1' }).count()).toBe(0)
  }, 60_000)
})
