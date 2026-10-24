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

/** The bundle's studio policy at the next version, with merge given `mode`. */
const merging = (mode: 'notify' | 'forbid'): AutonomyPolicy => {
  const [studio] = bundlePolicies()
  return { ...studio!, version: studio!.version + 1, rules: studio!.rules.map((r) => (r.actionClass === 'merge' ? { ...r, mode } : r)) }
}

/** A merge task of project p1, proposed and waiting for approval under the bundle's policy (merge asks). */
async function waitingMerge(ctx: Booted['ctx']): Promise<{ taskId: string; requestId: string }> {
  await activeProject(ctx)
  const proposed = await ctx.board.propose({ projectId: 'p1', title: 'merge', goal: 'merge the branch', acceptance: [{ id: 'a1', statement: 'merged' }], actionClass: 'merge' })
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
    const { taskId, requestId } = await waitingMerge(ctx)

    const { change, request } = await propose(booted, merging('notify'), 'merges are reviewed after the fact')
    expect(request).toMatchObject({ schema: 'approval-request@1.1', action: { class: 'policy-change' }, subject: { type: 'content', ref: 'autonomy-policy-set', version: change.hash }, requester: { component: 'approvals', policyChangeId: change.changeId } })
    expect(request.action.consequences).toContain('studio merge ask → notify')
    expect(change).toMatchObject({ state: 'asked', baseHash: set.hash, effect: [{ actionClass: 'merge', from: 'ask', to: 'notify' }], previous: { version: 1 }, policy: { version: 2 } })
    // Asked, not applied: the policy and the waiting task are as they were.
    expect((await call('policy')).value).toMatchObject({ set: { hash: set.hash }, changes: [{ changeId: change.changeId, state: 'asked' }] })
    expect((await ctx.approvals.check({ class: 'merge', projectId: 'p1' })).mode).toBe('ask')

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
    // The merge request was withdrawn under the new set at once, and the board's next sweep puts the task to it: notify runs.
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
    for (const policy of [{ ...merging('forbid'), version: 1 }, { ...merging('forbid'), default: 'auto' }, { ...merging('forbid'), rules: [{ actionClass: 'remediation', mode: 'auto' }] }]) {
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
    expect(await page.locator('main').innerText()).toContain('the configuration')
    expect(await page.locator('main').innerText()).not.toContain('null')
    // The editor holds the studio policy at the next version; the diff shows what changes.
    const editor = page.getByRole('textbox', { name: 'Proposed policy record (JSON)' })
    const draft = JSON.parse(await editor.inputValue()) as AutonomyPolicy
    expect(draft).toMatchObject({ id: 'studio-default', version: 2 })
    await editor.fill(JSON.stringify(merging('forbid'), null, 2))
    await page.getByRole('button', { name: 'Show diff' }).click()
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
    await queue.getByRole('button', { name: `Show the change of ${request!.requestId}` }).click()
    await expect.poll(() => queue.getByText('studio: merge').count()).toBeGreaterThan(0)
    expect(await queue.innerText()).toContain('ask → forbid')
    const entry = queue.locator('article', { hasText: `request ${request!.requestId}` })
    expect(await entry.innerText()).toContain('If approved: the set')
    await entry.getByRole('button', { name: 'Approve: put the change in force' }).click()
    await expect.poll(async () => (await booted.ctx.approvals.policy()).set?.source).toBe('store')
    await expect.poll(() => page.locator('#outcome').innerText()).toContain('Recorded as your verdict on request ' + request!.requestId)
    await page.getByRole('link', { name: 'Autonomy policy' }).click()
    await expect.poll(() => page.locator('main').innerText()).toContain('In force: the change pch-')
  }, 60_000)

  it.runIf(canRunBrowser)('decides an asked change on the policy page itself: its card, with Approve and Deny, above the policy, and its history row linking to it (T95, T97)', async () => {
    const booted = await boot()
    const { change, request } = await propose(booted, merging('forbid'), 'no merges for now')
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?view=policy#token=${OPERATOR}`)
    const waiting = page.getByRole('region', { name: 'Changes waiting for your verdict' })
    await expect.poll(() => waiting.innerText()).toContain('A change waits for your verdict')
    // The state in words first, each mode explained; the set's hash folded.
    expect(await page.locator('main').innerText()).toContain('In force: the configuration.')
    expect(await page.locator('main').innerText()).toContain('ask: it waits for your approval on Home')
    expect(await page.locator('details', { hasText: 'Exact set' }).getAttribute('open')).toBeNull()
    const card = waiting.locator('article', { hasText: `request ${request.requestId}` })
    expect(await card.innerText()).toContain('If approved: the set')
    // The history row says it waits, and its link takes the focus to that card.
    await page.getByRole('link', { name: 'waiting for your verdict' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(`request-${request.requestId}`)
    await card.getByRole('button', { name: 'Approve: put the change in force' }).click()
    await expect.poll(async () => (await booted.ctx.approvals.policy()).set?.source).toBe('store')
    expect((await booted.ctx.approvals.policy()).set?.changeId).toBe(change.changeId)
    await expect.poll(() => page.locator('#outcome').innerText()).toContain('Recorded as your verdict on request ' + request.requestId)
    // Re-rendered: nothing waits any more, and the change is in force.
    await expect.poll(() => page.locator('main').innerText()).toContain('In force: the change pch-')
    expect(await waiting.count()).toBe(0)
  }, 60_000)
})
