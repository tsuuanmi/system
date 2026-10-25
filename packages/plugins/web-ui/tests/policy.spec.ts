import type { ApprovalRequest, AutonomyPolicy, PolicyChange } from '@tsuuanmi/system-approvals-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { activeProject } from '../../workflow/conformance/workflow.ts'
import { type Booted, boot, bundlePolicies, OPERATOR } from './store-backed.ts'

// A policy change end to end, through the web UI's API, over the store-backed approval queue and
// board under the bundle's own default studio policy (docs/design/approvals.md#a-policy-change).
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

/** The bundle's studio policy at the next version, with `actionClass` given `mode`. */
const ruling = (actionClass: 'merge' | 'command', mode: 'notify' | 'forbid'): AutonomyPolicy => {
  const [studio] = bundlePolicies()
  return { ...studio!, version: studio!.version + 1, rules: studio!.rules.map((r) => (r.actionClass === actionClass ? { ...r, mode } : r)) }
}

/** The bundle's studio policy at the next version, with merge given `mode`. */
const merging = (mode: 'notify' | 'forbid'): AutonomyPolicy => ruling('merge', mode)

/** A task of project p1 of `actionClass`, proposed and waiting for approval under the bundle's policy (merge and command ask). */
async function waitingMerge(ctx: Booted['ctx'], actionClass: 'merge' | 'command' = 'merge'): Promise<{ taskId: string; requestId: string }> {
  await activeProject(ctx)
  const proposed = await ctx.board.propose({ projectId: 'p1', title: actionClass, goal: `${actionClass} the branch`, acceptance: [{ id: 'a1', statement: 'merged' }], actionClass })
  await ctx.board.sweep(new Date())
  const task = (await ctx.board.task(proposed.taskId))!
  expect(task).toMatchObject({ state: 'waiting-for-approval', waiting: { reason: 'approval-needed' } })
  return { taskId: task.taskId, requestId: task.waiting!.approvalRequest! }
}

/** The page's propose, then the queue's listing of the request it opened. */
async function propose(booted: Booted, policy: AutonomyPolicy, note?: string): Promise<{ change: PolicyChange; request: ApprovalRequest }> {
  const proposed = await booted.call('policy/propose', { policy, ...(note ? { note } : {}) })
  expect(proposed.status, JSON.stringify(proposed.value)).toBe(200)
  const { change, request } = proposed.value as { change: PolicyChange; request: ApprovalRequest }
  schemas.assertRecord(change)
  schemas.assertRecord(request)
  const queued = ((await booted.call('approvals')).value.batches as Array<{ requests: ApprovalRequest[] }>).flatMap((b) => b.requests)
  expect(queued.map((r) => r.requestId)).toContain(request.requestId)
  return { change, request }
}

const decide = (booted: Booted, request: ApprovalRequest, verdict: 'approved' | 'rejected') =>
  booted.call('approvals/decide', { verdicts: [{ requestId: request.requestId, subject: request.subject, verdict }] })

/** The queue on, proposing from 3 approvals in an hour (docs/design/approvals.md#the-queue-proposes-a-policy-change). */
const REPEATED = { repeatedApprovals: { enabled: true, approvals: 3, windowSeconds: 3600 } }

/** A Worker's `pnpm lint` asked and approved on the page `times` times, then the queue's own pass: its proposal. */
async function queueProposes(booted: Booted, times = 3): Promise<PolicyChange> {
  for (let i = 0; i < times; i++) {
    const command = ['pnpm', 'lint']
    const verdict = await booted.ctx.approvals.check({ class: 'command', command })
    const request = await booted.ctx.approvals.request({
      subject: { type: 'content', ref: `agent-tool-call:run-${i}:Bash`, version: `v${i}` }, action: { class: 'command', summary: 'Bash: pnpm lint' },
      requester: { component: 'worker', runId: `run-${i}`, sessionId: `session-${i}` }, verdict, command, classification: 'operator-shared',
    })
    expect(((await decide(booted, request, 'approved')).value.results as Array<{ state: string }>)[0]!.state).toBe('approved')
  }
  const change = await (booted.ctx.approvals as unknown as { proposeRepeated: () => Promise<PolicyChange | undefined> }).proposeRepeated()
  expect(change).toMatchObject({ origin: { shape: { command: 'pnpm lint' }, approved: times } })
  return change!
}

describe('web UI: the operator changes the autonomy policy through a policy-change approval', () => {
  it('shows the policy in force, takes a proposed version, asks it in the queue on its exact hash, and applies it only on approval: recorded with the old and new hashes, and the board re-gates a waiting task (INV-5, INV-13)', async () => {
    const booted = await boot()
    const { ctx, call } = booted
    const before = await call('policy')
    expect(before.status).toBe(200)
    const set = before.value.set as { hash: string; source: string; configHash: string }
    expect(set).toMatchObject({ source: 'configuration' })
    expect(set.hash).toBe(set.configHash)
    expect(before.value).toMatchObject({ proposals: true, changes: [], policies: [{ id: 'studio-default', version: 1 }] })
    // A merge always asks (D56), so the change loosens a command task's class instead.
    const { taskId, requestId } = await waitingMerge(ctx, 'command')

    const { change, request } = await propose(booted, ruling('command', 'notify'), 'commands are reviewed after the fact')
    expect(request).toMatchObject({ schema: 'approval-request@1.1', action: { class: 'policy-change' }, subject: { type: 'content', ref: 'autonomy-policy-set', version: change.hash }, requester: { component: 'approvals', policyChangeId: change.changeId } })
    expect(request.action.consequences).toContain('studio command ask → notify')
    expect(change).toMatchObject({ state: 'asked', baseHash: set.hash, effect: [{ actionClass: 'command', from: 'ask', to: 'notify' }], previous: { version: 1 }, policy: { version: 2 } })
    // Asked, not applied: the policy and the waiting task are as they were.
    expect((await call('policy')).value).toMatchObject({ set: { hash: set.hash }, changes: [{ changeId: change.changeId, state: 'asked' }] })
    expect((await ctx.approvals.check({ class: 'command', projectId: 'p1' })).mode).toBe('ask')

    // A verdict on another subject than the one shown changes nothing (INV-5).
    const forged = await call('approvals/decide', { verdicts: [{ requestId: request.requestId, subject: { ...request.subject, version: set.hash }, verdict: 'approved' }] })
    expect((forged.value.results as Array<{ refused?: string }>)[0]!.refused).toBe('subject-changed')
    const approved = await decide(booted, request, 'approved')
    expect((approved.value.results as Array<{ state: string }>)[0]!.state).toBe('approved')

    const after = await call('policy')
    expect(after.value).toMatchObject({ set: { hash: change.hash, source: 'store', changeId: change.changeId, configHash: set.hash }, policies: [{ id: 'studio-default', version: 2 }] })
    const [applied] = after.value.changes as PolicyChange[]
    expect(applied).toMatchObject({ changeId: change.changeId, state: 'applied' })
    expect(ctx.artifacts.get(applied!.applied!.decision)!.body).toMatchObject({
      schema: 'decision@1.6', decisionType: 'policy-change', decider: { type: 'rule', id: 'approvals.policy-change' },
      outcome: { option: change.hash, detail: { cause: 'approved', from: set.hash, to: change.hash, requestId: request.requestId } },
    })
    // The command task's request was withdrawn under the new set at once, and the board's next sweep puts the task to it: notify runs.
    expect(await ctx.approvals.get(requestId)).toMatchObject({ state: 'rejected', resolution: { cause: 'withdrawn' } })
    await ctx.board.sweep(new Date())
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'ready' })
  })

  it('leaves the policy and the waiting task as they are when the operator rejects the change', async () => {
    const booted = await boot()
    const { ctx, call } = booted
    const { taskId, requestId } = await waitingMerge(ctx)
    const before = (await call('policy')).value.set
    const { change, request } = await propose(booted, merging('forbid'))
    await decide(booted, request, 'rejected')
    const after = await call('policy')
    expect(after.value).toMatchObject({ set: before, policies: [{ version: 1 }], changes: [{ changeId: change.changeId, state: 'declined', declined: { cause: 'rejected' } }] })
    await ctx.board.sweep(new Date())
    expect(await ctx.board.task(taskId)).toMatchObject({ state: 'waiting-for-approval', waiting: { approvalRequest: requestId } })
    expect(await ctx.approvals.get(requestId)).toMatchObject({ state: 'open' })
  })

  it('keeps an applied change across a restart; a changed configuration refuses the queue until it supersedes the stored set (INV-2, INV-4)', async () => {
    const first = await boot()
    const { change, request } = await propose(first, merging('forbid'))
    await decide(first, request, 'approved')
    await first.stop()

    const second = await boot({ dir: first.dir })
    expect(second.refused).toBeUndefined()
    expect((await second.call('policy')).value).toMatchObject({ set: { hash: change.hash, source: 'store' }, policies: [{ version: 2 }] })
    expect((await second.ctx.approvals.check({ class: 'merge' })).mode).toBe('forbid')
    await second.stop()

    // The operator edits the configuration since: neither set is used, nothing that needs a person runs, and the UI says the queue is down.
    const [studio] = bundlePolicies()
    const edited = [{ ...studio!, version: 5, rules: studio!.rules.map((r) => (r.actionClass === 'spend' ? { ...r, mode: 'forbid' as const } : r)) }]
    const third = await boot({ dir: first.dir, approvals: { policies: edited } })
    expect(third.refused?.message).toContain(`set supersedes: '${change.hash}'`)
    expect((await third.call('policy')).status).toBe(503)
    expect((await third.call('approvals')).status).toBe(503)
    await third.stop()

    // The configuration that names the stored set takes over, and says so.
    const fourth = await boot({ dir: first.dir, approvals: { policies: edited, supersedes: change.hash } })
    expect(fourth.refused).toBeUndefined()
    const policy = await fourth.call('policy')
    expect(policy.value).toMatchObject({ set: { source: 'configuration' }, policies: [{ version: 5 }], changes: [{ changeId: change.changeId, state: 'retired' }] })
    expect((await fourth.ctx.approvals.check({ class: 'merge' })).mode).toBe('ask')
  })

  it('takes a change only from the operator\'s token, and refuses one the load-time rules or the version rule refuse, queueing nothing (INV-6)', async () => {
    const booted = await boot()
    const { call, client, ctx } = booted
    expect((await call('policy', undefined, client)).status).toBe(401)
    expect((await call('policy/propose', { policy: merging('forbid') }, client)).status).toBe(401)
    // A merge always asks (D56): a policy giving it notify is refused like one giving remediation auto.
    for (const policy of [{ ...merging('forbid'), version: 1 }, { ...merging('forbid'), default: 'auto' }, { ...merging('forbid'), rules: [{ actionClass: 'remediation', mode: 'auto' }] }, merging('notify')]) {
      const refused = await call('policy/propose', { policy })
      expect(refused.status, JSON.stringify(refused.value)).toBe(400)
      expect(refused.value.error).toMatch(/^invalid: /)
    }
    expect((await call('policy/propose', { policy: 'studio' })).status).toBe(400)
    expect((await call('policy/propose', { policy: merging('forbid') })).status).toBe(200)
    expect((await ctx.approvals.list()).map((r) => r.action.class)).toEqual(['policy-change'])
    expect(((await call('policy')).value.changes as PolicyChange[]).map((c) => c.state)).toEqual(['asked'])
  })
})

describe('web UI: a policy change the queue proposed itself', () => {
  it('shows the queue\'s proposal with its origin in the queue and the history, and applies it only on the operator\'s approval (INV-6)', async () => {
    const booted = await boot({ approvals: REPEATED })
    const change = await queueProposes(booted)
    const queued = ((await booted.call('approvals')).value.batches as Array<{ requests: ApprovalRequest[] }>).flatMap((b) => b.requests)
    const request = queued.find((r) => r.requestId === change.requestId)!
    expect(request.action.summary).toBe('The queue proposes: list the command `pnpm lint` in studio-default (version 1 to 2)')
    const listed = (await booted.call('policy')).value.changes as PolicyChange[]
    expect(listed[0]).toMatchObject({ changeId: change.changeId, schema: 'policy-change@1.1', state: 'asked', origin: { rule: 'approvals.repeated-approvals' } })
    expect((await booted.ctx.approvals.check({ class: 'command', command: ['pnpm', 'lint'] })).mode).toBe('ask')
    await decide(booted, request, 'approved')
    expect((await booted.ctx.approvals.check({ class: 'command', command: ['pnpm', 'lint'] })).mode).toBe('auto')
    expect((await booted.call('policy')).value).toMatchObject({ set: { source: 'store', changeId: change.changeId }, policies: [{ version: 2, commands: ['pnpm lint'] }] })
  })
})

describe('web UI: the policy page in a real browser', () => {
  it.runIf(canRunBrowser)('says in the queue entry that the queue, not the operator, proposed a change, and why', async () => {
    const booted = await boot({ approvals: REPEATED })
    const change = await queueProposes(booted)
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const queue = page.getByRole('region', { name: 'Approval queue' })
    await queue.getByRole('button', { name: `Show the change of ${change.requestId}` }).click()
    await expect.poll(() => queue.innerText()).toContain('Proposed by the queue, not by you: you approved pnpm lint 3 times among the requests of the last 1 hour, and rejected none')
    await page.goto(`${origin}/ui/?view=policy#token=${OPERATOR}`)
    await expect.poll(() => page.locator('main').innerText()).toContain('(proposed by the queue)')
  }, 60_000)

  it.runIf(canRunBrowser)('shows the policy in force and a diff of a proposed version, proposes it, shows the change in the queue entry, and shows it in force once approved there', async () => {
    const booted = await boot()
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?view=policy#token=${OPERATOR}`)
    await expect.poll(() => page.getByRole('heading', { name: 'Autonomy policy' }).count()).toBe(1)
    expect(await page.locator('main').innerText()).toContain('Active policy · Configuration')
    expect(await page.locator('main').innerText()).not.toContain('null')
    // The editor, folded under Advanced, holds the studio policy at the next version; the diff shows what changes.
    await page.getByText('Advanced: the record as JSON').click()
    const editor = page.getByRole('textbox', { name: 'Proposed policy record (JSON)' })
    const draft = JSON.parse(await editor.inputValue()) as AutonomyPolicy
    expect(draft).toMatchObject({ id: 'studio-default', version: 2 })
    await editor.fill(JSON.stringify(merging('forbid'), null, 2))
    // The form shows the record edited as JSON: merge, which always asks, is Blocked there, said so.
    const merge = page.getByRole('region', { name: 'Propose a change' }).getByRole('row', { name: /^merge/ })
    await expect.poll(() => merge.innerText()).toContain('Blocked here; change it under Advanced')
    expect(await merge.innerText()).toMatch(/^merge\s+Blocked\s/)
    await page.getByRole('button', { name: 'Show change' }).click()
    await expect.poll(() => page.locator('pre.diff .add').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining('"mode": "forbid"')]))
    expect(await page.locator('pre.diff .del').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining('"mode": "ask"')]))
    await page.getByRole('textbox', { name: 'Note for the proposed change' }).fill('no merges for now')
    await page.getByRole('button', { name: 'Propose', exact: true }).click()
    await expect.poll(() => page.locator('#status').innerText()).toContain('proposed pch-')
    const [request] = await booted.ctx.approvals.list()
    expect(request).toMatchObject({ action: { class: 'policy-change' } })

    // The queue entry shows the change it asks for, then the operator approves it there.
    await page.getByRole('link', { name: 'system' }).click()
    const queue = page.getByRole('region', { name: 'Approval queue' })
    const entry = queue.locator('article', { hasText: `request ${request!.requestId}` })
    // Show change and what a verdict does are under the card's Details (T186).
    await expect.poll(() => entry.locator('details.card-details > summary').count()).toBe(1)
    await entry.locator('details.card-details > summary').click()
    await queue.getByRole('button', { name: `Show the change of ${request!.requestId}` }).click()
    await expect.poll(() => queue.getByText('studio: merge').count()).toBeGreaterThan(0)
    expect(await queue.innerText()).toContain('ask → forbid')
    expect(await entry.innerText()).toContain('If approved: the proposed set replaces the set in force at once')
    await entry.getByRole('button', { name: 'Approve: put the change in force' }).click()
    await expect.poll(async () => (await booted.ctx.approvals.policy()).set?.source).toBe('store')
    await expect.poll(() => page.locator('#outcome').textContent()).toContain('Recorded as your verdict on request ' + request!.requestId)
    expect(await page.locator('#outcome').innerText()).toContain('Approved: ')
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Autonomy policy' }).click()
    await expect.poll(() => page.locator('main').innerText()).toContain('Active policy · Approved change')
    // Which change, folded with the set's hash (T171).
    expect(await page.locator('details', { hasText: 'Exact set' }).textContent()).toMatch(/The change pch-\S+ you approved, kept while the configuration it came from is unchanged\./)
  }, 60_000)

  it.runIf(canRunBrowser)('decides an asked change on the policy page itself: its card, with Approve and Deny, above the policy, and its history row linking to it (T95, T97)', async () => {
    const booted = await boot()
    const { change, request } = await propose(booted, merging('forbid'), 'no merges for now')
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?view=policy#token=${OPERATOR}`)
    const waiting = page.getByRole('region', { name: 'Changes awaiting approval' })
    await expect.poll(() => waiting.innerText()).toContain('Changes awaiting approval · 1')
    // The state in two words first, each mode a chip, what each mode means folded; the set's hash folded (T171).
    const main = await page.locator('main').innerText()
    expect(main).toContain('Active policy · Configuration')
    for (const mode of ['Automatic', 'Notify', 'Ask approval', 'Blocked']) expect(main, mode).toContain(mode)
    expect(main).not.toContain('it waits for your approval on Home')
    expect(await page.locator('details', { hasText: 'About modes' }).textContent()).toContain('Ask approval: it waits for your approval on Home')
    expect(await page.locator('details', { hasText: 'Exact set' }).getAttribute('open')).toBeNull()
    const card = waiting.locator('article', { hasText: `request ${request.requestId}` })
    // One line and two buttons (T186); what a verdict does, what it is about, and the set's hashes under its closed Details.
    // A policy change's card keeps its diff one press away, beside the two verdicts (T186).
    expect(await card.getByRole('button').allInnerTexts()).toEqual(['Approve', 'Deny', 'Show change'])
    expect(await card.innerText()).not.toContain('If approved')
    expect(await card.innerText()).not.toContain(change.hash)
    await card.locator('details.card-details > summary').click()
    expect(await card.innerText()).toContain('If approved: the proposed set replaces the set in force at once')
    // The set's hashes are folded behind details: the card reads in words (T116).
    expect(await card.innerText()).toContain('the policy set this change would put in force')
    await card.getByText('details', { exact: true }).click()
    expect(await card.innerText()).toContain(change.hash)
    // The history row says it waits, its id behind a copy button, and its link takes the focus to that card.
    const row = page.getByRole('row', { name: /^studio-default 1 → 2/ })
    expect(await row.locator('button.copy').getAttribute('data-copy')).toBe(change.changeId)
    expect(await row.innerText()).not.toContain(change.changeId)
    await row.getByRole('link', { name: 'Approval needed' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`request-${request.requestId}`)
    await card.getByRole('button', { name: 'Approve: put the change in force' }).click()
    await expect.poll(async () => (await booted.ctx.approvals.policy()).set?.source).toBe('store')
    expect((await booted.ctx.approvals.policy()).set?.changeId).toBe(change.changeId)
    await expect.poll(() => page.locator('#outcome').textContent()).toContain('Recorded as your verdict on request ' + request.requestId)
    // Re-rendered: nothing waits any more, and the change is in force.
    await expect.poll(() => page.locator('main').innerText()).toContain('Active policy · Approved change')
    expect(await page.locator('details', { hasText: 'Exact set' }).textContent()).toContain(`The change ${change.changeId} you approved`)
    expect(await waiting.count()).toBe(0)
  }, 60_000)

  it.runIf(canRunBrowser)('edits the policy as a form: a mode per action class, the classes that always ask fixed at ask with why, the commands as lines, the expiry and batch numbers; the JSON follows under Advanced, and the proposal is the queue\'s to validate (T116)', async () => {
    const booted = await boot()
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/?view=policy#token=${OPERATOR}`)
    const form = page.getByRole('region', { name: 'Propose a change' })
    await expect.poll(() => form.getByRole('combobox', { name: 'Mode of command' }).count()).toBe(1)
    expect(await form.innerText()).toContain('studio-default · Version 1 → 2')
    // Every class that always asks is fixed at Approval required, why on demand; no select for it (T171).
    for (const fixed of ['merge', 'deploy', 'charter', 'policy-change']) {
      expect(await form.getByRole('combobox', { name: `Mode of ${fixed}` }).count(), fixed).toBe(0)
      const row = form.getByRole('row', { name: new RegExp(`^${fixed}\\b`) })
      expect(await row.innerText(), fixed).toMatch(/Approval required\s+Why always/)
      expect(await row.textContent(), fixed).toContain('It always asks, whatever a rule says: ')
    }
    expect(await form.getByRole('row', { name: /^merge/ }).innerText()).not.toContain('an accepted result lands only on your approval')
    expect(await form.getByRole('row', { name: /^merge/ }).textContent()).toContain('an accepted result lands only on your approval')
    expect(await form.getByRole('combobox', { name: 'Mode of workspace-write' }).inputValue()).toBe('auto')
    // A mode by its name (the stored value under it); a row says only what the select does not: its required checks.
    expect(await form.getByRole('combobox', { name: 'Mode of workspace-write' }).locator('option:checked').textContent()).toBe('Automatic')
    expect(await form.getByRole('row', { name: /^workspace-write/ }).innerText()).toContain('Requires: tests, lint')
    const options = await form.getByRole('combobox', { name: 'Mode of command' }).locator('option').allTextContents()
    expect(options[0]).toMatch(/^Use default \((Ask approval|Blocked)\)$/)
    expect(options.slice(1)).toEqual(['Automatic', 'Notify', 'Ask approval', 'Blocked'])
    await form.getByRole('combobox', { name: 'Mode of command' }).selectOption('forbid')
    await form.getByRole('textbox', { name: 'Workspace-write commands, one per line' }).fill('pnpm lint\n\n  pnpm test  \n')
    expect(await form.locator('details', { hasText: 'How commands match' }).textContent()).toContain('matches a line word for word')
    await form.getByLabel('Request expiry (h)').fill('12')
    await form.getByLabel('Batch size (requests)').fill('5')
    await form.getByLabel('Batch delay (min)').fill('30')
    await form.getByText('Advanced: the record as JSON').click()
    const draft = JSON.parse(await form.getByRole('textbox', { name: 'Proposed policy record (JSON)' }).inputValue()) as AutonomyPolicy
    expect(draft).toMatchObject({ id: 'studio-default', version: 2, commands: ['pnpm lint', 'pnpm test'], expiry: { defaultSeconds: 43_200, maxSeconds: 1_209_600 }, batch: { maxSize: 5, maxWaitSeconds: 1800 } })
    expect(draft.rules.find((r) => r.actionClass === 'command')).toEqual({ actionClass: 'command', mode: 'forbid' })
    expect(draft.rules.find((r) => r.actionClass === 'workspace-write')).toEqual({ actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] })
    await form.getByRole('button', { name: 'Show change' }).click()
    await expect.poll(() => form.locator('pre.diff .add').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining('"mode": "forbid"'), expect.stringContaining('"pnpm lint"')]))
    // The queue validates as it always did: an expiry past its maximum is refused, and nothing is asked.
    await form.getByLabel('Request expiry (h)').fill('9000')
    await form.getByRole('button', { name: 'Propose', exact: true }).click()
    await expect.poll(() => form.getByRole('alert').innerText()).toMatch(/^Not proposed: invalid: /)
    expect(await booted.ctx.approvals.list()).toEqual([])
    await form.getByLabel('Request expiry (h)').fill('12')
    await form.getByRole('button', { name: 'Propose', exact: true }).click()
    await expect.poll(() => page.locator('#outcome').innerText()).toContain('Proposed: studio-default version 2')
    const [request] = await booted.ctx.approvals.list()
    expect(request).toMatchObject({ action: { class: 'policy-change' } })
    const change = ((await booted.call('policy')).value.changes as PolicyChange[])[0]!
    // What is next in sight; the change and request ids under Record IDs.
    expect(await page.locator('#outcome').innerText()).toContain('Approval needed — nothing changes until you approve it')
    expect(await page.locator('#outcome').textContent()).toContain(`Recorded as change ${change.changeId}; request ${request!.requestId}.`)
    expect(change.policy).toMatchObject({ version: 2, commands: ['pnpm lint', 'pnpm test'], expiry: { defaultSeconds: 43_200 }, batch: { maxSize: 5, maxWaitSeconds: 1800 } })
  }, 60_000)
})
