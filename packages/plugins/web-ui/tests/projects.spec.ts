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
    // In sight (T186): one line, for which project and until when with what no response does, an irreversible denial as a chip, and two short buttons.
    const text = await card.innerText()
    for (const said of ['Found project project p1 (charter version 1)', 'for project project p1', 'Expires in', 'No response: denied', 'Deny cannot be undone']) expect(text, said).toContain(said)
    expect(await card.getByRole('button').allInnerTexts()).toEqual(['Approve', 'Deny'])
    // Who asked, what it is about, what each verdict does, the request's id, its exact expiry, and the board's sweep are under one closed Details, never dropped (T171, T186).
    for (const folded of ['Asked by', 'charter version 1 of project p1', 'Cannot be undone.', 'request ' + approvalRequest]) expect(text, folded).not.toContain(folded)
    expect(await card.locator('details.card-details').getAttribute('open')).toBeNull()
    await card.getByText('Details', { exact: true }).click()
    const opened = await card.innerText()
    for (const said of ['Asked by the board of project project p1', 'charter version 1 of project p1',
      '2 proposed task(s) go through the autonomy policy. No run starts by itself.', 'is closed as abandoned, and 2 open task(s) are cancelled. Cannot be undone.',
      'request ' + approvalRequest, 'The board activates it on its next sweep, within a minute', 'Approve: activate project · Deny: abandon project']) expect(opened, said).toContain(said)
    expect(await card.locator('button.copy', { hasText: 'Copy request ID' }).getAttribute('data-copy')).toBe(approvalRequest)
    await card.getByRole('textbox', { name: 'Note (optional)' }).fill('go')
    await card.getByRole('button', { name: 'Approve: activate project' }).click()
    const outcome = page.locator('#outcome')
    await expect.poll(() => outcome.innerText()).toContain('Approved: Found project project p1 (charter version 1)')
    const request = await ctx.approvals.get(approvalRequest)
    expect(request).toMatchObject({ state: 'approved', resolution: { cause: 'verdict' } })
    // What happens next in sight; the request and approval record ids under Record IDs.
    expect(await outcome.innerText()).toContain('The board activates project project p1 on its next sweep')
    expect(await outcome.textContent()).toContain(`Recorded as your verdict on request ${approvalRequest} (approval record ${request!.resolution!.approval})`)
    expect(ctx.artifacts.get(request!.resolution!.approval!)!.body).toMatchObject({ verdict: 'approved', by: 'operator', note: 'go' })
    // The queue no longer lists it; the board's next sweep activates the project.
    await expect.poll(() => page.locator('main').innerText()).toContain('No approvals needed.')
    await ctx.board.sweep(new Date())
    expect((await ctx.board.project('p1'))?.state).toBe('active')
    await outcome.getByRole('button', { name: 'Dismiss' }).click()
    expect(await outcome.innerText()).toBe('')
  }, 60_000)

  it.runIf(canRunBrowser)('says on Home and above the Reviews when the first review held for the operator expires, in a real browser (T99 D6)', async () => {
    const booted = await boot()
    const { ctx } = booted
    await activeProject(ctx)
    const { task } = await reviewed(ctx, 'Fix the slow image build')
    expect(task.waiting).toMatchObject({ reason: 'operator-review' })
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const waiting = page.getByRole('region', { name: 'Needs your attention', exact: true })
    await expect.poll(() => waiting.innerText()).toMatch(/Reviews · 1 · first expires in \d+ (h|min|days)/)
    expect(await page.getByRole('region', { name: 'Reviews' }).innerText()).toMatch(/1 review is held for you; the first expires in \d+ (h|min|days) — .+\. Unanswered by then, its task waits for input, which nothing revives\./)
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
    expect(await column('Needs your attention').innerText()).toContain('Merge the login fix')
    const card = column('Working').getByRole('article', { name: 'Research the hosting options' })
    // Which account and role took it, and for how long (T119).
    expect(await card.innerText()).toMatch(/Conformance · standard · standard, less than a minute/)
    await card.getByRole('link', { name: 'Open the run of Research the hosting options' }).click()
    // A task's run is headed by its task's title, its project below, its run id behind a copy button (T141, T171).
    await expect.poll(() => page.getByRole('heading', { name: 'Research the hosting options', exact: true }).count()).toBe(1)
    expect(await page.locator('main').innerText()).toContain('project p1')
    expect(await page.locator('main').innerText()).not.toContain(run.runId)
    expect(await page.getByRole('button', { name: 'Copy run ID' }).getAttribute('data-copy')).toBe(run.runId)
    await page.goBack()
    // Several projects: all by default, each card naming its project; the filter shows one.
    await expect.poll(() => column('Ready').innerText()).toContain('Handbook rewrite')
    // Capacity in numbers; how a ready task starts is folded beside it (T171).
    expect(await page.getByLabel('Capacity').innerText()).toMatch(/Workers? free · 2 tasks ready/)
    expect(await page.getByLabel('Capacity').innerText()).not.toContain('A ready task starts')
    expect(await page.locator('details', { hasText: 'How a ready task starts' }).textContent()).toContain('A ready task starts when you press Start on its card or the lead runs it')
    // Each project's state as counts (T141, T171), what needs you by kind on demand.
    expect(await page.getByLabel('State of project p1').innerText()).toBe('Needs you 2 · Working 1 · Ready 1 · Proposed 0')
    expect(await page.getByLabel('State of Handbook rewrite').innerText()).toBe('Needs you 0 · Working 0 · Ready 1 · Proposed 0')
    expect(await page.getByRole('article', { name: 'project p1', exact: true }).locator('details', { hasText: 'What needs you' }).textContent()).toContain('1 review, 1 approval')
    await page.getByLabel('Show').selectOption('p2')
    await expect.poll(() => column('Ready').innerText()).not.toContain('Write the release notes')
    // The filter is in the address: a reload keeps it.
    expect(new URL(page.url()).search).toBe('?view=board&project=p2')
    await page.reload()
    await expect.poll(() => column('Ready').innerText()).toContain('Outline the chapters')
    expect(await column('Ready').innerText()).not.toContain('Write the release notes')
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
    await expect.poll(() => page.locator('main').innerText()).toContain('Charter approval needed')
    expect(await page.locator('main').innerText()).toContain('1 task approval')
    await page.getByRole('link', { name: 'Review request', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`request-${approvalRequest}`)
    expect(new URL(page.url()).search).toBe(`?request=${approvalRequest}`)
    await page.goto(`${origin}/ui/?view=board#token=${OPERATOR}`)
    await expect.poll(() => page.locator('main').innerText()).toContain('1 task approval')
    await page.getByRole('link', { name: 'Allow a merge step: Merge the login fix' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`request-${waiting}`)
    // The card names the task by its title, not its id: on its line, and who asked under its Details (T186).
    const asked = page.locator(`#request-${waiting}`)
    expect(await asked.locator('.line').innerText()).toContain('for the task "Merge the login fix"')
    await asked.getByText('Details', { exact: true }).click()
    expect(await asked.innerText()).toContain('Asked by the board, for the task "Merge the login fix" of project project p1')
  }, 60_000)

  it.runIf(canRunBrowser)('shows a done task whose accepted result waits to merge under Needs your attention, with its merge request\'s Approve and Deny on the card, and the request in words on Home (ADR-0060, T141)', async () => {
    const booted = await boot()
    const { ctx } = booted
    await activeProject(ctx)
    const task = await readyTask(ctx, 'Band the inner loop')
    const run = await ctx.workflow.start({ template: 'solo', input: 'band it', classification: 'public', task: { taskId: task.taskId } })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.task?.phase).toBe('reported'), { timeout: 30_000 })
    expect((await ctx.board.task(task.taskId))!.state).toBe('done')
    // The merge request the engine asks once the result is committed on the run's branch (ADR-0060), and the landing that waits on it.
    const branch = `system/run/${run.runId}`
    const [base, head] = ['a'.repeat(40), 'b'.repeat(40)]
    const verdict = await ctx.approvals.check({ class: 'merge', projectId: 'p1' })
    expect(verdict.mode).toBe('ask')
    const request = await ctx.approvals.request({
      subject: { type: 'git-head', ref: branch, version: `landing:merge:${base}:${head}` },
      action: { class: 'merge', summary: 'Merge the accepted result of task "Band the inner loop" into main', consequences: 'Approved: system merges it.' },
      requester: { component: 'workflow', runId: run.runId, taskId: task.taskId, projectId: 'p1' }, verdict, classification: 'public',
    })
    booted.ctx.store.db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ?').run(JSON.stringify({
      state: 'asked', branch, head, base: { branch: 'main', sha: base }, requestId: request.requestId, expiresAt: request.expiresAt, at: new Date().toISOString(),
    }), run.runId)
    const card = ((await listed(booted)).tasks as Array<Record<string, any>>).find((t) => t.taskId === task.taskId)
    expect(card).toMatchObject({ state: 'done', landing: { state: 'asked', branch, base: 'main', requestId: request.requestId } })
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/?view=board#token=${OPERATOR}`)
    const waiting = page.getByRole('region', { name: 'Needs your attention', exact: true }).getByRole('article', { name: 'Band the inner loop' })
    await expect.poll(() => waiting.count()).toBe(1)
    expect(await waiting.innerText()).toContain('Merge approval needed · into main')
    // Its request's card on Home says what it merges, and what each verdict does in words (T141); the branch and heads folded (T171).
    await page.goto(`${origin}/ui/?request=${request.requestId}`)
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`request-${request.requestId}`)
    const asked = page.locator(`#request-${request.requestId}`)
    // One line names the task it is for (T186); the rest is under its closed Details.
    expect(await asked.locator('.line').innerText()).toContain('for the task "Band the inner loop"')
    expect(await asked.getByRole('button').allInnerTexts()).toEqual(['Approve', 'Deny'])
    expect(await asked.innerText()).not.toContain('bbbbbbbbbbbb')
    expect(await asked.textContent()).toContain('branch ' + branch + ' at bbbbbbbbbbbb, onto the base at aaaaaaaaaaaa')
    await asked.getByText('Details', { exact: true }).click()
    expect(await asked.innerText()).toContain('the accepted change of "Band the inner loop" · not pushed')
    expect(await asked.innerText()).toContain('Asked by the run of the task "Band the inner loop"')
    expect(await asked.innerText()).toContain('The accepted change of the task "Band the inner loop" is merged as one merge commit. Not pushed.')
    expect(await asked.innerText()).toContain('Not merged: the change stays on its branch; the task stays done.')
    expect(await asked.getByRole('button', { name: 'Approve: merge change' }).count()).toBe(1)
    expect(await asked.getByRole('button', { name: 'Deny: keep branch only' }).count()).toBe(1)
    // Approved by button on the Board card itself, on the request's exact subject (INV-5).
    await page.goto(`${origin}/ui/?view=board`)
    await waiting.getByRole('button', { name: /^Approve: merge change/ }).click()
    await expect.poll(async () => (await ctx.approvals.get(request.requestId))?.state).toBe('approved')
    await expect.poll(() => page.locator('#outcome').innerText()).toContain('Approved: ')
    expect(await page.locator('#outcome').textContent()).toContain('Recorded as your verdict on request ' + request.requestId)
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

  it('starts a ready task\'s run for the operator\'s token only, as the lead does: what would run said first, bound to the task revision and template shown; a task naming no template refused (T116)', async () => {
    const booted = await boot()
    const { ctx, call, client, workers } = booted
    await activeProject(ctx)
    const task = await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    const bare = await readyTask(ctx, 'Draft the pricing page copy')
    const card = ((await listed(booted)).tasks as Array<Record<string, any>>).find((t) => t.taskId === task.taskId)
    expect(card).toMatchObject({ state: 'ready', template: 'solo', revision: task.revision, attempts: { count: 0, max: task.attempts.max } })

    expect((await call(`tasks/${task.taskId}/start`, undefined, client)).status).toBe(401)
    expect((await call(`tasks/${task.taskId}/start`, { revision: task.revision, template: 'solo' }, client)).status).toBe(401)
    const preview = await call(`tasks/${task.taskId}/start`)
    expect(preview.status, JSON.stringify(preview.value)).toBe(200)
    expect(preview.value).toEqual({ task: { taskId: task.taskId, title: 'Write the release notes', revision: task.revision, template: 'solo', attempts: task.attempts }, steps: [{ nodeId: 'solo', objective: 'Do solo', capabilities: ['reason'], tier: 'standard', workers: { free: ['w:frontier', 'w:standard'], busy: [] } }] }) // w:economy is below the step's tier (T124)
    const none = await call(`tasks/${bare.taskId}/start`)
    expect([none.status, none.value.error]).toEqual([409, expect.stringMatching(/names no template, so it cannot start from here: the lead starts it/)])
    expect((await call(`tasks/${bare.taskId}/start`, { revision: bare.revision, template: 'solo' })).status).toBe(409)
    expect((await call('tasks/nope/start')).status).toBe(404)
    expect((await call(`tasks/${task.taskId}/start`, { template: 'solo' })).status).toBe(400)
    expect((await call(`tasks/${task.taskId}/start`, { revision: task.revision + 1, template: 'solo' })).status).toBe(409)
    expect((await call(`tasks/${task.taskId}/start`, { revision: task.revision, template: 'chain' })).status).toBe(409)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'ready' })
    expect(await ctx.board.task(bare.taskId)).toMatchObject({ state: 'ready' })

    workers.reply = () => 'hold'
    const started = await call(`tasks/${task.taskId}/start`, { revision: task.revision, template: 'solo' })
    expect(started.status, JSON.stringify(started.value)).toBe(200)
    const run = started.value.run as { runId: string; template: string; task: { taskId: string } }
    expect(run).toMatchObject({ template: 'solo', task: { taskId: task.taskId } })
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'running', run: { runId: run.runId } })
    // The run's input is the task's own words; a second press finds the task no longer ready and starts nothing.
    expect(ctx.workflow.get(run.runId)!.nodes).toHaveLength(1)
    const again = await call(`tasks/${task.taskId}/start`, { revision: task.revision, template: 'solo' })
    expect([again.status, again.value.error]).toEqual([409, expect.stringMatching(/is running, not ready: nothing was started/)])
    expect(ctx.workflow.usage(10).filter((r) => r.runId !== run.runId && (r as { task?: { taskId: string } }).task?.taskId === task.taskId)).toEqual([])
  })

  it('says a start the board did not answer is not started yet, never refused: 202 names the run, which starts once the board shows it recorded (T127 item 13, INV-2)', async () => {
    const { ctx, call, workers } = await boot()
    await activeProject(ctx)
    const task = await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    workers.reply = () => 'hold'
    const original = { start: ctx.board.start.bind(ctx.board), task: ctx.board.task.bind(ctx.board) }
    let asked = false
    ctx.board.start = (async () => {
      asked = true
      throw new Error('the board store is busy')
    }) as never
    ctx.board.task = (async (taskId: string) => {
      if (asked) throw new Error('the board store is busy')
      return original.task(taskId)
    }) as never
    onTestFinished(() => {
      ctx.board.start = original.start
      ctx.board.task = original.task
    })
    const answer = await call(`tasks/${task.taskId}/start`, { revision: task.revision, template: 'solo' })
    expect(answer.status, JSON.stringify(answer.value)).toBe(202)
    expect(answer.value).toEqual({ pending: { runId: expect.stringMatching(/^run_/), reason: expect.stringMatching(/^the board did not answer the start of run run_\w+ for task \S+ \(the board store is busy\); the run starts only once the board shows it recorded$/) } })
    // Admitted and waiting for the board's record, nothing of it run: not refused.
    const runId = (answer.value.pending as { runId: string }).runId
    expect(ctx.workflow.get(runId)).toMatchObject({ status: 'running', task: { taskId: task.taskId, phase: 'starting' } })
    expect(workers.started).toEqual([])
  })

  it('binds the run\'s input to the revision of the task it was read at: a task that moved between the page\'s read and the engine\'s is refused, nothing started (T127 item 13, INV-5)', async () => {
    const { ctx, call, workers } = await boot()
    await activeProject(ctx)
    const task = await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    // The route reads the task, then the engine does: the second read finds it moved.
    const read = ctx.board.task.bind(ctx.board)
    let reads = 0
    ctx.board.task = (async (taskId: string) => {
      const found = await read(taskId)
      reads += 1
      return reads === 2 && found ? { ...found, revision: found.revision + 1, goal: 'another goal' } : found
    }) as never
    onTestFinished(() => void (ctx.board.task = read))
    const refused = await call(`tasks/${task.taskId}/start`, { revision: task.revision, template: 'solo' })
    expect([refused.status, refused.value.error]).toEqual([409, `board task ${task.taskId} changed since it was read (revision ${task.revision + 1}, not ${task.revision}); nothing was started`])
    expect(workers.started).toEqual([])
    expect(await read(task.taskId)).toMatchObject({ state: 'ready', attempts: { count: 0 } })
  })

  it.runIf(canRunBrowser)('starts a ready task from its Board card in a real browser after a confirmation that says what runs on which kind of Worker; the card moves to Working, and a task naming no template is refused with why (T116)', async () => {
    const booted = await boot()
    const { ctx, workers } = booted
    await activeProject(ctx)
    await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    await readyTask(ctx, 'Draft the pricing page copy')
    workers.reply = () => 'hold'
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/?view=board#token=${OPERATOR}`)
    const column = (name: string) => page.getByRole('region', { name, exact: true })
    const notes = column('Ready').getByRole('article', { name: 'Write the release notes' })
    await expect.poll(() => notes.count()).toBe(1)
    expect(await notes.innerText()).toContain('solo template')
    // The card names who its first step would likely go to, before any press (T141); the alternatives folded (T171).
    await expect.poll(() => notes.innerText()).toMatch(/Likely Worker: Conformance · (frontier|standard) · (frontier|standard)\s*\+1 other/)
    expect(await notes.locator('details', { hasText: '+1 other' }).textContent()).toMatch(/\+1 otherConformance · (frontier|standard) · (frontier|standard)/)

    // No template: refused with why, and nothing moves.
    const pricing = column('Ready').getByRole('article', { name: 'Draft the pricing page copy' })
    expect(await pricing.innerText()).toContain('No template: the lead starts it')
    await page.getByRole('button', { name: 'Start Draft the pricing page copy' }).click()
    const refused = page.getByRole('alert', { name: 'Cannot start Draft the pricing page copy' })
    await expect.poll(() => refused.count()).toBe(1)
    expect(await refused.innerText()).toMatch(/names no template, so it cannot start from here/)
    await refused.getByRole('button', { name: 'Cancel' }).click()

    await page.getByRole('button', { name: 'Start Write the release notes' }).click()
    const confirming = page.getByRole('group', { name: 'Confirm start of Write the release notes' })
    await expect.poll(() => confirming.count()).toBe(1)
    const said = await confirming.innerText()
    expect(said).toMatch(/solo template · attempt 1 of \d+ · 1 step/)
    expect(said).toContain('Do solo: standard+ · reason')
    // What a start does, and that nothing runs until Confirm start, folded under it (T171).
    expect(said).not.toContain('Nothing runs until you confirm')
    expect(await confirming.textContent()).toContain('Nothing runs until you confirm')
    expect(await confirming.textContent()).toContain('The run claims the task, which moves to Working')
    expect((await ctx.board.tasks({ projectId: 'p1', states: ['ready'] })).length).toBe(2)
    await confirming.getByRole('button', { name: 'Confirm start' }).click()
    const outcome = page.locator('#outcome')
    await expect.poll(() => outcome.innerText()).toContain('Started: Write the release notes')
    expect(await outcome.innerText()).toMatch(/Run run_\w+ of the solo template claimed the task/)
    await expect.poll(() => column('Working').getByRole('article', { name: 'Write the release notes' }).count()).toBe(1)
    expect(await column('Ready').getByRole('article', { name: 'Write the release notes' }).count()).toBe(0)
    await outcome.getByRole('link', { name: /^run_/ }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Write the release notes', exact: true }).count()).toBe(1)
  }, 60_000)

  it.runIf(canRunBrowser)('lays every page out at 600 px in a real browser: no page wider than the screen, the Kanban columns stacked with readable cards, and the navigation wrapping whole links (T116)', async () => {
    const booted = await boot()
    const { ctx, workers } = booted
    await activeProject(ctx)
    await readyTask(ctx, 'Write the release notes for the relaunch of the studio website', { template: 'solo' })
    await reviewed(ctx, 'Fix the slow image build')
    const done = await ctx.workflow.start({ template: 'chain', input: 'Summarise the hosting options', classification: 'public' })
    await vi.waitFor(() => expect(ctx.workflow.get(done.runId)?.status).toBe('completed'), { timeout: 30_000 })
    workers.reply = () => 'hold'
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 600, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    for (const path of ['/ui/', '/ui/?view=board', '/ui/?view=workers', '/ui/?view=policy', `/ui/?run=${done.runId}`]) {
      await page.goto(origin + path)
      await expect.poll(() => page.locator('#status').innerText(), { message: path }).toContain('updated')
      expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(600)
      // Each navigation link stays on one line; the links wrap as a whole.
      for (const name of ['Home', 'Board', 'Workers', 'Autonomy policy']) {
        const box = (await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name }).boundingBox())!
        expect(box.height, `${path} ${name}`).toBeLessThan(30)
        expect(box.x + box.width, `${path} ${name}`).toBeLessThanOrEqual(600)
      }
    }
    // Workers of no account are listed under their own header, each card headed by its whole name (T119).
    await page.goto(`${origin}/ui/?view=workers`)
    const lone = page.getByRole('region', { name: 'Workers of no account' })
    await expect.poll(() => lone.getByRole('article', { name: /^Conformance · standard · standard/ }).count()).toBe(1)
    expect(await lone.getByRole('heading', { level: 4, name: 'Conformance · standard · standard' }).count()).toBe(1)
    await page.goto(`${origin}/ui/?view=board`)
    const columns = page.locator('.kanban > .column')
    await expect.poll(() => columns.count()).toBe(5)
    // Stacked, one under another, Needs your attention first: what needs the operator is on top of a narrow screen (T141).
    const boxes = (await columns.evaluateAll((list) => list.map((c) => ({ name: c.getAttribute('aria-label'), ...JSON.parse(JSON.stringify(c.getBoundingClientRect())) as { x: number; y: number; width: number } }))))
      .sort((a, b) => a.y - b.y)
    expect(boxes.map((b) => b.name)).toEqual(['Needs your attention', 'Proposed', 'Ready', 'Working', 'Review'])
    for (const [i, box] of boxes.entries()) {
      expect(box.x, `column ${i}`).toBe(boxes[0]!.x)
      expect(box.width, `column ${i}`).toBeGreaterThan(500)
      if (i) expect(box.y, `column ${i}`).toBeGreaterThan(boxes[i - 1]!.y)
    }
    const card = page.getByRole('article', { name: 'Write the release notes for the relaunch of the studio website' })
    expect((await card.boundingBox())!.width).toBeGreaterThan(500)
    expect((await card.getByRole('button', { name: /^Start / }).boundingBox())!.width).toBeGreaterThan(400)
  }, 90_000)
})
