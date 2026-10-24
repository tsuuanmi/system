import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { ApprovalRequest, Verdict, VerdictResult } from '@tsuuanmi/system-approvals-core'
import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import * as WebUi from '../src/index.ts'
import { lanWebServer } from '../../../gateway-core/tests/lan.ts'

const RUN = {
  runId: 'run_abc', template: 'investigate', status: 'running', specHash: 'sha256:00', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:01Z',
  nodes: [{ nodeId: 'plan:1', state: 'COMPLETED', minTier: 'standard', attempt: 1, worker: 'worker:a/standard', tier: 'standard', quotaClass: 'subscription-chat' },
    { nodeId: 'plan:1:gate', state: 'BLOCKED', minTier: 'economy', attempt: 0 }],
  blocked: { kind: 'gate', nodeId: 'plan:1:gate', plan: 'sha256:11' },
}

/** A stand-in engine: what the UI reads and what it asks. */
class StubWorkflow extends Service {
  readonly calls: Array<[string, ...unknown[]]> = []
  constructor(ctx: Context) {
    super(ctx, 'workflow')
  }
  /** Runs listed after RUN: the roster suites' running step. */
  extra: unknown[] = []
  usage() { return [RUN, ...this.extra] }
  get(id: string) { return id === RUN.runId ? RUN : undefined }
  explain(id: string) { return id === RUN.runId ? { runId: id, nodes: [{ nodeId: 'plan:1', state: 'COMPLETED', decisions: [{ id: 'sha256:22', type: 'route', outcome: 'worker:a/standard', reasons: ['proves reason'] }] }] } : undefined }
  approve(id: string, input: unknown) { this.calls.push(['approve', id, input]); return RUN }
  async stop(id: string, reason?: string) { this.calls.push(['stop', id, reason]); return RUN }
  continue(id: string, nodeId?: string) { this.calls.push(['continue', id, nodeId]); return RUN }
  vote(id: string, input: unknown) { this.calls.push(['vote', id, input]); return RUN }
}

const queued = (requestId: string, batchId: string | undefined, extra: Partial<ApprovalRequest['action']> = {}): ApprovalRequest => ({
  schema: 'approval-request@1.0', requestId, state: batchId ? 'batched' : 'open', subject: { type: 'content', ref: `board-task:${requestId}:attempt:0`, version: 'approval-needed' },
  action: { class: 'merge', summary: `merge ${requestId}`, ...extra }, requester: { component: 'board', projectId: 'p1', taskId: `task-${requestId}` },
  policy: { id: 'studio', version: 1, decision: `sha256:${'d'.repeat(64)}` }, classification: 'operator-shared', ...(batchId ? { batchId } : {}),
  createdAt: '2026-10-22T09:00:00.000Z', expiresAt: '2026-10-23T09:00:00.000Z', revision: batchId ? 1 : 0,
})
/** In listing order: the batch first, then the unbatched request. */
const QUEUE = [queued('apr-1', 'batch-1', { consequences: 'the branch lands on main' }), queued('apr-2', 'batch-1'), queued('apr-3', undefined, { class: 'deploy' })]

/** A stand-in queue: what the UI lists, and the verdicts it passes on. */
class StubApprovals extends Service {
  readonly calls: Array<[Verdict[], Date]> = []
  /** Listings asked so far; while `held` is set, a listing waits for it (a slow refresh). */
  lists = 0
  held: Promise<void> | undefined
  /** When set, `decide` throws it: the route answers 409, and nothing is decided. */
  failure: Error | undefined
  constructor(ctx: Context) {
    super(ctx, 'approvals')
  }
  async list() {
    this.lists += 1
    await this.held
    return QUEUE
  }
  async get(id: string) { return QUEUE.find((r) => r.requestId === id) }
  async decide(verdicts: Verdict[], at: Date): Promise<VerdictResult[]> {
    if (this.failure) throw this.failure
    this.calls.push([verdicts, at])
    return verdicts.map((v) => v.requestId === 'apr-3' ? { requestId: v.requestId, state: 'open', refused: 'subject-changed' } : { requestId: v.requestId, state: v.verdict, approval: `sha256:${'a'.repeat(64)}` })
  }
}

const AT = '2026-10-24T09:29:58.000Z'
/** A run whose step runs on worker:plus/standard now. */
const STEP = { runId: 'run_xyz', template: 'review', status: 'running', specHash: 'sha256:00', createdAt: AT, updatedAt: AT, nodes: [{ nodeId: 'review:m1:propose', state: 'RUNNING', minTier: 'standard', attempt: 1, worker: 'worker:plus/standard' }] }
/** A stand-in router for the roster: a website account's two tiers, one busy, one resting at its limit. */
class StubRouter extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workers')
  }
  async list() {
    const account = { id: 'plus', group: 'chatgpt-web', mode: 'assigned' }
    return [
      { worker: 'worker:plus/standard', provider: 'chatgpt-web', family: 'chatgpt-web', description: 'The studio\'s chat subscription for quick questions (standard tier)', account, load: { running: 1, queued: 0, pending: 0, slots: 2 }, tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote', state: 'ready', observedAt: AT },
      { worker: 'worker:plus/frontier', provider: 'chatgpt-web', family: 'chatgpt-web', account: { ...account, limitUntil: '2026-10-24T11:00:00.000Z' }, tier: 'frontier', quotaClass: 'subscription-chat', locality: 'remote', state: 'quota-exhausted', observedAt: AT },
    ]
  }
  sources() { return [{ source: 'website', state: 'described', at: AT, workers: 2 }] }
  siblings() { return ['worker:plus/frontier', 'worker:plus/standard'] }
  /** An earlier run of the busy Worker that ended without being known to be gone, still holding its session (PROP-0013). */
  async liveness() {
    return {
      runs: [{ source: 'stub', execution: 'arun_00000000000000a2', worker: 'worker:plus/standard', state: 'unknown', since: AT, holds: ['session ses_9'], runId: 'run_old', reasons: ['the agent process: unknown (never reported)'], action: 'free it' }],
      counts: { unknown: 1, looking: 0, stalled: 0 }, unread: [],
    }
  }
}
class StubAccounts extends Service {
  constructor(ctx: Context) {
    super(ctx, 'accounts')
  }
  async list() { return [{ id: 'plus', provider: 'chatgpt-web', label: 'Studio Plus', status: 'ready' }] }
  async duplicateIdentities() { return [] }
}

/** A stand-in ledger: the website account's own pool, one window read from its usage report, one with no share, one never read (ADR-0059). */
class StubResources extends Service {
  constructor(ctx: Context) {
    super(ctx, 'resources')
  }
  readonly at = Date.now()
  async pools() {
    const windows = [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }, { id: 'seven-day', kind: 'rolling', seconds: 604_800 }, { id: 'credit', kind: 'credit' }]
    const read = (window: (typeof windows)[number], extra: Record<string, unknown>) => ({ schema: 'limit-state@1.0', pool: 'plan/plus', account: 'plus', window, source: 'runtime-result', observedAt: new Date(this.at - 60_000).toISOString(), ...extra })
    return [{
      pool: 'plan/plus', account: 'plus', kind: 'interactive', windows, available: false, until: new Date(this.at + 3_600_000).toISOString(),
      readings: [read(windows[0]!, { state: 'ok', usedPercentage: 42, resetsAt: new Date(this.at + 900_000).toISOString() }), read(windows[1]!, { state: 'limited', resetsAt: new Date(this.at + 3_600_000).toISOString() })],
    }]
  }
  async usage() { return { records: [], totals: [] } }
}

async function boot(options: { approvals?: boolean; roster?: boolean; pools?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-ui-'))
  // The UI takes the operator scope's token only (ADR-0023).
  writeFileSync(join(dir, 'operator.token'), Buffer.alloc(32, 7), { mode: 0o600 })
  writeFileSync(join(dir, 'client.token'), Buffer.alloc(32, 8), { mode: 0o600 })
  const token = Buffer.alloc(32, 7).toString('base64url')
  const ctx = new Context()
  const fibers = [ctx.plugin(StubWorkflow), ...(options.approvals ? [ctx.plugin(StubApprovals)] : []), ...(options.roster ? [ctx.plugin(StubRouter), ctx.plugin(StubAccounts)] : []),
    ...(options.pools ? [ctx.plugin(StubResources)] : []), ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUi, { tokenDir: dir })]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  if (options.roster) (ctx as unknown as { workflow: StubWorkflow }).workflow.extra = [STEP]
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  return { ctx, origin, token, workflow: (ctx as unknown as { workflow: StubWorkflow }).workflow, approvals: () => (ctx as unknown as { approvals: StubApprovals }).approvals }
}

describe('web UI: the operator\'s view, loopback and token-gated', () => {
  it('registers nothing on a plain-HTTP bind beyond loopback: the token would travel in clear text (QA-5)', async () => {
    const { LanWebServer, routes } = lanWebServer()
    const dir = mkdtempSync(join(tmpdir(), 'system-ui-lan-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    await ctx.plugin(StubWorkflow)
    await ctx.plugin(LanWebServer)
    try {
      await ctx.plugin(WebUi, { tokenDir: dir })
    } catch {
      // the refusal itself is the point
    }
    expect(routes).toEqual([])
  })

  it('serves a data-free shell under a strict content security policy', async () => {
    const { origin } = await boot()
    const page = await fetch(`${origin}/ui/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('cache-control')).toBe('no-store')
    const html = await page.text()
    expect(html).toContain('<script src="/ui/app.js"></script>')
    expect(html).not.toContain('run_abc')
    expect((await fetch(`${origin}/ui/app.js`)).headers.get('content-type')).toContain('javascript')
  })

  it('guards the API: token, own origin, and loopback host only', async () => {
    const { origin, token } = await boot()
    const auth = { authorization: `Bearer ${token}` }
    expect((await fetch(`${origin}/ui/api/runs`)).status).toBe(401)
    expect((await fetch(`${origin}/ui/api/runs`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${origin}/ui/api/runs`, { headers: { authorization: `Bearer ${Buffer.alloc(32, 8).toString('base64url')}` } })).status).toBe(401)
    expect((await fetch(`${origin}/ui/api/runs`, { headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
    // fetch cannot set Host; a rebinding attack arrives with a foreign one.
    const rebound = await new Promise<number>((resolve, reject) => {
      request(`${origin}/ui/api/runs`, { headers: { ...auth, host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!) }).on('error', reject).end()
    })
    expect(rebound).toBe(421)
    const runs = await fetch(`${origin}/ui/api/runs`, { headers: { ...auth, origin } })
    expect(runs.status).toBe(200)
    expect(await runs.json()).toMatchObject({ runs: [{ runId: 'run_abc' }] })
    expect(await (await fetch(`${origin}/ui/api/runs/run_abc`, { headers: auth })).json()).toMatchObject({ run: { runId: 'run_abc' }, explain: { runId: 'run_abc' } })
    expect((await fetch(`${origin}/ui/api/runs/run_nope`, { headers: auth })).status).toBe(404)
  })

  it('passes the operator\'s actions to the engine, and only with a JSON body', async () => {
    const { origin, token, workflow } = await boot()
    const post = (path: string, body: unknown, type = 'application/json') =>
      fetch(`${origin}/ui/api/runs/run_abc/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type, origin }, body: JSON.stringify(body) })
    expect((await post('approve', { verdict: 'approved', note: 'ok', plan: 'sha256:11' })).status).toBe(200)
    expect((await post('stop', { reason: 'enough' })).status).toBe(200)
    expect((await post('continue', {})).status).toBe(200)
    expect((await post('vote', { decision: 'sha256:33', option: 'O2', rationale: 'the operator decides' })).status).toBe(200)
    expect((await post('vote', { decision: 'sha256:33', option: 'O2' })).status).toBe(400)
    expect((await post('approve', { verdict: 'maybe' })).status).toBe(400)
    expect((await post('stop', {}, 'text/plain')).status).toBe(415)
    expect((await post('delete', {})).status).toBe(404)
    expect(workflow.calls).toEqual([['approve', 'run_abc', { verdict: 'approved', note: 'ok', plan: 'sha256:11' }], ['stop', 'run_abc', 'enough'], ['continue', 'run_abc', undefined],
      ['vote', 'run_abc', { decision: 'sha256:33', option: 'O2', rationale: 'the operator decides', by: 'operator' }]])
  })

  it('lists the approval queue by batch and passes the operator\'s verdicts on, each bound to the subject the page showed (INV-5, INV-6)', async () => {
    const { origin, token, approvals } = await boot({ approvals: true })
    const auth = { authorization: `Bearer ${token}`, origin }
    const queue = await fetch(`${origin}/ui/api/approvals`, { headers: auth })
    expect(queue.status).toBe(200)
    expect(await queue.json()).toEqual({ batches: [{ batchId: 'batch-1', requests: [QUEUE[0], QUEUE[1]] }, { requests: [QUEUE[2]] }] })
    const post = (body: unknown, type = 'application/json', headers: Record<string, string> = auth) =>
      fetch(`${origin}/ui/api/approvals/decide`, { method: 'POST', headers: { ...headers, 'content-type': type }, body: JSON.stringify(body) })
    const one = (r: ApprovalRequest, verdict: string, extra: Record<string, unknown> = {}) => ({ requestId: r.requestId, subject: r.subject, verdict, ...extra })

    // One request, with its own note.
    const single = await post({ verdicts: [one(QUEUE[2]!, 'rejected', { note: '  not now  ' })] })
    expect(single.status).toBe(200)
    expect(await single.json()).toEqual({ results: [{ requestId: 'apr-3', state: 'open', refused: 'subject-changed' }] })
    // A batch: one verdict each for the requests shown, the call's note on each.
    const before = Date.now()
    expect((await post({ batchId: 'batch-1', note: 'ship', verdicts: [one(QUEUE[0]!, 'approved'), one(QUEUE[1]!, 'approved')] })).status).toBe(200)
    expect(approvals().calls.map(([verdicts]) => verdicts)).toEqual([
      [{ requestId: 'apr-3', subject: QUEUE[2]!.subject, verdict: 'rejected', note: 'not now' }],
      [{ requestId: 'apr-1', subject: QUEUE[0]!.subject, verdict: 'approved', note: 'ship' }, { requestId: 'apr-2', subject: QUEUE[1]!.subject, verdict: 'approved', note: 'ship' }],
    ])
    // Decided at the wall clock, never a time the page names.
    expect(approvals().calls[1]![1].getTime()).toBeGreaterThanOrEqual(before)

    // Refused before anything is decided: a request outside the batch named, a malformed verdict, a bad body or caller.
    const refusals: Array<[Response, number]> = [
      [await post({ batchId: 'batch-1', verdicts: [one(QUEUE[0]!, 'approved'), one(QUEUE[2]!, 'approved')] }), 409],
      [await post({ batchId: 'batch-9', verdicts: [one(QUEUE[0]!, 'approved')] }), 409],
      [await post({ verdicts: [one(QUEUE[0]!, 'maybe')] }), 400],
      [await post({ verdicts: [{ requestId: 'apr-1', verdict: 'approved' }] }), 400],
      [await post({ verdicts: [one(QUEUE[0]!, 'approved', { subject: { type: 'anything', ref: 'x' } })] }), 400],
      [await post({ verdicts: [] }), 400],
      [await post({ verdicts: Array.from({ length: 51 }, () => one(QUEUE[0]!, 'approved')) }), 400],
      [await post({ batchId: '../x', verdicts: [one(QUEUE[0]!, 'approved')] }), 400],
      [await post({ verdicts: [one(QUEUE[0]!, 'approved')] }, 'text/plain'), 415],
      [await post({ verdicts: [one(QUEUE[0]!, 'approved')] }, 'application/json', { authorization: `Bearer ${Buffer.alloc(32, 8).toString('base64url')}` }), 401],
      [await fetch(`${origin}/ui/api/approvals/decide`, { headers: auth }), 405],
      [await fetch(`${origin}/ui/api/approvals/other`, { headers: auth }), 404],
    ]
    expect(refusals.map(([response]) => response.status)).toEqual(refusals.map(([, status]) => status))
    expect(approvals().calls).toHaveLength(2)
  })

  it('answers 503 for the reviews and the projects when no ctx.board runs, and refuses a client token there as everywhere (401)', async () => {
    const { origin, token } = await boot()
    const auth = { authorization: `Bearer ${token}` }
    const reviews = await fetch(`${origin}/ui/api/reviews`, { headers: auth })
    expect([reviews.status, await reviews.json()]).toEqual([503, { error: 'the board is not running' }])
    expect((await fetch(`${origin}/ui/api/reviews/task-1/decide`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', origin }, body: '{"verdict":"accept"}' })).status).toBe(503)
    expect((await fetch(`${origin}/ui/api/reviews`, { headers: { authorization: `Bearer ${Buffer.alloc(32, 8).toString('base64url')}` } })).status).toBe(401)
    const projects = await fetch(`${origin}/ui/api/projects`, { headers: auth })
    expect([projects.status, await projects.json()]).toEqual([503, { error: 'the board is not running' }])
    expect((await fetch(`${origin}/ui/api/projects/p1/close`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', origin }, body: '{"revision":1,"outcome":"stopped"}' })).status).toBe(503)
    expect((await fetch(`${origin}/ui/api/projects/p1/close`, { method: 'POST', headers: { authorization: `Bearer ${Buffer.alloc(32, 8).toString('base64url')}`, 'content-type': 'application/json', origin }, body: '{"revision":1,"outcome":"stopped"}' })).status).toBe(401)
  })

  it('answers 503 for the queue when no ctx.approvals runs, and serves the runs as before', async () => {
    const { origin, token } = await boot()
    const auth = { authorization: `Bearer ${token}` }
    const queue = await fetch(`${origin}/ui/api/approvals`, { headers: auth })
    expect([queue.status, await queue.json()]).toEqual([503, { error: 'the approval queue is not running' }])
    expect((await fetch(`${origin}/ui/api/approvals/decide`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', origin }, body: '{"verdicts":[]}' })).status).toBe(503)
    expect((await fetch(`${origin}/ui/api/runs`, { headers: auth })).status).toBe(200)
  })

  it('serves the roster to the operator only, with account labels, valid against mcp-roster@1.4, and what it could not read as unknown (REQ-HOST-8)', async () => {
    const { origin, token } = await boot({ roster: true })
    const auth = { authorization: `Bearer ${token}` }
    const response = await fetch(`${origin}/ui/api/roster`, { headers: auth })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    const roster = await response.json() as Record<string, unknown>
    new SchemaRegistry().assertDef('mcp-roster@1.4', 'roster-output', roster)
    expect(roster).toMatchObject({
      counts: { busy: 1, resting: 1 },
      workers: { value: [
        { worker: 'worker:plus/frontier', name: 'Chatgpt · Studio Plus · frontier', availability: { state: 'resting', summary: 'resting at a limit until 2026-10-24T11:00:00.000Z' } },
        // The stand-in engine's run is not running this Worker now; no ledger, so its pools are unknown.
        { worker: 'worker:plus/standard', name: 'Chatgpt · Studio Plus · standard', description: { value: 'The studio\'s chat subscription for quick questions (standard tier)' }, availability: { summary: 'busy 1 of 2' }, account: { value: { record: { value: { label: { value: 'Studio Plus' } } } } },
          work: { value: { items: [{ runId: 'run_xyz', nodeId: 'review:m1:propose', since: { unknown: 'the event log (ctx.eventLog) is not mounted' }, summary: 'Running review run run_xyz, step review:m1:propose, since an unknown time' }], more: 0 } }, pools: { unknown: 'the resource ledger (ctx.resources) is not mounted' },
          liveness: { value: [{ execution: 'arun_00000000000000a2', state: 'unknown', since: AT, runId: 'run_old', summary: expect.stringContaining('ended without being known to be gone, holding session ses_9') }] } },
      ] },
    })
    new SchemaRegistry().assertDef('mcp-roster@1.4', 'roster-output', roster)
    expect((await fetch(`${origin}/ui/api/roster`, { headers: { authorization: `Bearer ${Buffer.alloc(32, 8).toString('base64url')}` } })).status).toBe(401)
    expect((await fetch(`${origin}/ui/api/roster`, { headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${origin}/ui/api/roster`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', origin }, body: '{}' })).status).toBe(405)
    // With no Worker registry at all, the Workers are unknown, not an empty list.
    const bare = await boot()
    const none = await (await fetch(`${bare.origin}/ui/api/roster`, { headers: { authorization: `Bearer ${bare.token}` } })).json()
    expect(none).toMatchObject({ workers: { unknown: 'the Worker registry (ctx.workers) is not mounted' } })
  })

  it.runIf(canRunBrowser)('renders the Workers tab in a real browser: counts, one card per Worker by status, what it is for (or a derived line, marked), what it does now, its account and limits (T85)', async () => {
    const { origin, token } = await boot({ roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    await page.getByRole('link', { name: 'Workers' }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Workers', exact: true }).count()).toBe(1)
    expect(new URL(page.url()).search).toBe('?view=workers')
    expect(await page.getByLabel('Worker counts').innerText()).toMatch(/^1 working · 0 idle · 1 at a limit \(the first back .+\) · 0 unavailable$/)
    const working = page.getByRole('region', { name: 'Working' })
    const busy = working.getByRole('article', { name: 'Chatgpt · Studio Plus · standard' })
    const card = await busy.innerText()
    // Its display name heads the card, its id under it.
    expect(await busy.getByRole('heading', { level: 4 }).innerText()).toBe('Chatgpt · Studio Plus · standard')
    for (const said of ['Worker id worker:plus/standard', 'The studio\'s chat subscription for quick questions (standard tier)', 'Working: 1 of 2 slot(s) in use; it still takes work',
      'Running review run run_xyz, step review:m1:propose, since an unknown time', 'Studio Plus', 'plus · website account, ready', 'standard tier, subscription-chat, remote',
      // Beside what it does now, the earlier run that holds its session for want of a verdict, and what frees it (PROP-0013).
      'agent run arun_00000000000000a2 of run run_old ended without being known to be gone, holding session ses_9; free it once its agent is gone (system free arun_00000000000000a2 --agent-gone)']) expect(card, said).toContain(said)
    await busy.getByRole('link', { name: 'Open run run_old' }).focus()
    const resting = page.getByRole('region', { name: 'At a limit' }).getByRole('article', { name: 'Chatgpt · Studio Plus · frontier' })
    const rest = await resting.innerText()
    expect(rest).toContain('derived')
    expect(rest).toContain('chatgpt-web Worker, frontier tier, subscription-chat, remote (no description is configured)')
    expect(rest).toMatch(/At a limit: back (in|.* ago)/)
    expect(rest).toContain('unknown (the resource ledger (ctx.resources) is not mounted)')
    // The run link opens its page.
    await busy.getByRole('link', { name: 'Open run run_xyz' }).focus()
    expect(await page.locator('main').innerText()).not.toContain('null')
  }, 60_000)

  it.runIf(canRunBrowser)('shows each window of an account\'s pool as "used X % of N h, resets HH:MM (read HH:MM)", and what its reading does not give as unknown, with why (ADR-0059)', async () => {
    const { origin, token } = await boot({ roster: true, pools: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?view=workers#token=${token}`)
    const busy = page.getByRole('article', { name: 'worker:plus/standard' })
    const line = (window: string) => busy.getByLabel(`window ${window} of plan/plus`)
    await expect.poll(() => line('five-hour').count()).toBe(1)
    expect(await line('five-hour').innerText()).toMatch(/^five-hour: used 42 % of 5 h, resets [^,()]+ \(read [^)]+\)$/)
    expect(await line('seven-day').innerText()).toMatch(/^seven-day: used unknown \(its latest reading gives no used share\), resets [^,()]+ \(read [^)]+\); at its limit$/)
    expect(await line('credit').innerText()).toBe('credit: used unknown (no reading yet), resets unknown (no reading yet)')
    expect(await page.locator('main').innerText()).not.toContain('null')
  }, 60_000)

  it.runIf(canRunBrowser)('shows the approval queue in a real browser and approves a batch on the subjects it shows', async () => {
    const { origin, token, approvals } = await boot({ approvals: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const queue = page.getByRole('region', { name: 'Approval queue' })
    await expect.poll(() => queue.getByText('Batch batch-1: 2 related requests').count()).toBe(1)
    for (const text of ['merge apr-1', 'the branch lands on main', 'deploy', 'content board-task:apr-1:attempt:0 @ approval-needed', 'Decided one by one',
      'Allow a merge step: merge apr-1']) {
      expect(await queue.getByText(text, { exact: true }).count(), text).toBeGreaterThan(0)
    }
    expect(await queue.innerText()).toContain('3 requests wait for your verdict')
    expect(await queue.innerText()).toContain('task apr-1 of project p1, attempt 1')
    expect(await page.locator('main').innerText()).not.toContain('null')
    await queue.getByRole('textbox', { name: 'Note for every request of this batch (optional)' }).fill('ship it')
    await queue.getByRole('button', { name: 'Approve all 2 in this batch' }).click()
    await expect.poll(() => approvals().calls.length).toBe(1)
    expect(approvals().calls[0]![0]).toEqual([
      { requestId: 'apr-1', subject: QUEUE[0]!.subject, verdict: 'approved', note: 'ship it' },
      { requestId: 'apr-2', subject: QUEUE[1]!.subject, verdict: 'approved', note: 'ship it' },
    ])
    await expect.poll(() => page.locator('#outcome').innerText()).toContain('2 verdicts recorded')
    await page.locator('article', { hasText: 'request apr-3' }).getByRole('button', { name: 'Deny: hold the task' }).click()
    await expect.poll(() => approvals().calls.length).toBe(2)
    expect(approvals().calls[1]![0]).toEqual([{ requestId: 'apr-3', subject: QUEUE[2]!.subject, verdict: 'rejected' }])
    // A refused verdict is an alert that says why, and that nothing was decided.
    await expect.poll(() => page.getByRole('alert').innerText()).toContain('Not recorded: your denial of Allow a deploy step: merge apr-3')
    expect(await page.getByRole('alert').innerText()).toContain('what it asks about changed since the page showed it')
  }, 60_000)

  it.runIf(canRunBrowser)('keeps a press on Approve when a refresh lands between pressing and releasing: the click is not lost (T84)', async () => {
    const { origin, token, approvals } = await boot({ approvals: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const approve = page.locator('article', { hasText: 'request apr-3' }).getByRole('button', { name: 'Approve: allow this deploy' })
    await expect.poll(() => approve.count()).toBe(1)
    // The next periodic refresh starts and waits on the queue's listing.
    let release!: () => void
    approvals().held = new Promise((resolve) => { release = resolve })
    const listed = approvals().lists
    await expect.poll(() => approvals().lists, { timeout: 10_000 }).toBeGreaterThan(listed)
    // The operator presses Approve while it is in flight; it lands; then they release.
    await approve.scrollIntoViewIfNeeded()
    const box = (await approve.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    release()
    approvals().held = undefined
    await new Promise((resolve) => setTimeout(resolve, 300))
    await page.mouse.up()
    await expect.poll(() => approvals().calls.length).toBe(1)
    expect(approvals().calls[0]![0]).toEqual([{ requestId: 'apr-3', subject: QUEUE[2]!.subject, verdict: 'approved' }])
  }, 60_000)

  it.runIf(canRunBrowser)('shows a verdict that was not recorded as an alert that stays through refreshes until dismissed (INV-2, T84)', async () => {
    const { origin, token, approvals } = await boot({ approvals: true })
    approvals().failure = new Error('the store is busy')
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    await page.locator('article', { hasText: 'request apr-3' }).getByRole('button', { name: 'Approve: allow this deploy' }).click()
    const alert = page.getByRole('alert')
    await expect.poll(() => alert.innerText()).toContain('Not recorded: your approval of Allow a deploy step: merge apr-3')
    expect(await alert.innerText()).toContain('the store is busy')
    expect(await alert.innerText()).toContain('Nothing was decided: the request is still open in the queue.')
    // The buttons are back for another try.
    expect(await page.locator('article', { hasText: 'request apr-3' }).getByRole('button', { name: 'Approve: allow this deploy' }).isEnabled()).toBe(true)
    // A periodic refresh does not take it away.
    const listed = approvals().lists
    await expect.poll(() => approvals().lists, { timeout: 10_000 }).toBeGreaterThan(listed)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await alert.innerText()).toContain('the store is busy')
    await alert.getByRole('button', { name: 'Dismiss' }).click()
    expect(await page.getByRole('alert').count()).toBe(0)
  }, 60_000)

  it.runIf(canRunBrowser)('opens on a dashboard: what waits for you, each linked to its section, the Workers at a glance, the runs that need a look with their action, and the recent runs (T97)', async () => {
    const { origin, token } = await boot({ approvals: true, roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const waiting = page.getByRole('region', { name: 'Waiting for you' })
    await expect.poll(() => waiting.innerText()).toContain('3 requests wait for your verdict')
    expect(await waiting.innerText()).toContain('1 run needs a look')
    expect(await page.getByRole('region', { name: 'Workers at a glance' }).innerText()).toContain('1 working · 0 idle · 1 at a limit · 0 unavailable')
    // The blocked run is listed with why and where it is decided.
    const look = page.getByRole('region', { name: 'Runs that need a look' })
    expect(await look.innerText()).toContain('its plan waits for your approval')
    await look.getByRole('link', { name: 'Open it to decide' }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Run run_abc' }).count()).toBe(1)
    await page.goBack()
    await waiting.getByRole('link', { name: '3 requests wait for your verdict' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('approvals')
    expect(await page.getByRole('heading', { name: 'Recent runs' }).count()).toBe(1)
  }, 60_000)

  it.runIf(canRunBrowser)('has one navigation on every page, the current page marked, and each page a title with one line of what it is for (T97)', async () => {
    const { origin, token } = await boot({ approvals: true, roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const nav = page.getByRole('navigation', { name: 'Pages' })
    const current = () => nav.locator('[aria-current="page"]').innerText()
    await expect.poll(() => page.getByRole('heading', { name: 'Home', exact: true }).count()).toBe(1)
    expect(await current()).toBe('Home')
    expect(await page.locator('p.lead').innerText()).toContain('What waits for your verdict')
    for (const [link, purpose] of [['Board', 'Every project and its open tasks'], ['Workers', 'Every Worker: what it is for'], ['Autonomy policy', 'Which actions run on their own']] as const) {
      await nav.getByRole('link', { name: link }).click()
      await expect.poll(() => page.getByRole('heading', { name: link, exact: true }).count()).toBe(1)
      expect(await current()).toBe(link)
      expect(await page.locator('p.lead').innerText()).toContain(purpose)
      expect(await page.title()).toBe(`system: ${link}`)
    }
    // Keyboard: the navigation is links, reached and followed without a pointer.
    await nav.getByRole('link', { name: 'Home' }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => current()).toBe('Home')
    await page.getByRole('link', { name: 'run_abc' }).first().click()
    await expect.poll(() => page.getByRole('heading', { name: 'Run run_abc' }).count()).toBe(1)
    expect(await page.locator('main').innerText()).not.toContain('← ')
  }, 60_000)

  it.runIf(canRunBrowser)('shows a run as a sentence, what you can do, the answer, and its steps as a timeline in words, the decisions and spec folded (T97)', async () => {
    const { origin, token } = await boot({ roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?run=run_abc#token=${token}`)
    await expect.poll(() => page.getByRole('heading', { name: 'Run run_abc' }).count()).toBe(1)
    const text = await page.locator('main').innerText()
    expect(text).toContain('investigate run, started')
    expect(text).toContain('It waits for you: its plan waits for your approval.')
    expect(text).toContain('Step plan:1:gate waits for your approval of its plan before it runs.')
    expect(text).toContain('No answer yet: it comes when the last step is done.')
    const steps = page.locator('ol.timeline > li')
    expect(await steps.count()).toBe(2)
    expect(await steps.nth(0).innerText()).toMatch(/^plan:1 done · worker:a\/standard · standard tier/)
    expect(await steps.nth(1).innerText()).toContain('plan:1:gate waiting for you · needs an economy tier Worker')
    // Decisions and the spec are folded until asked for.
    expect(await page.locator('details', { hasText: 'How it was decided (1)' }).getAttribute('open')).toBeNull()
    expect(await page.getByText('proves reason').isVisible()).toBe(false)
    await page.getByText('How it was decided (1)').click()
    expect(await page.getByText('proves reason').isVisible()).toBe(true)
    expect(await page.getByText('sha256:00').isVisible()).toBe(false)
    expect(await page.getByText('ends it now: nothing more of it runs').count()).toBe(1)
  }, 60_000)

  it.runIf(canRunBrowser)('renders runs, steps, and decisions in a real browser, and approves a waiting plan', async () => {
    const { origin, token, workflow } = await boot()
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    await page.getByRole('link', { name: 'run_abc' }).first().click()
    await expect.poll(() => page.getByText('worker:a/standard').count()).toBeGreaterThan(0)
    await expect.poll(() => page.getByText('proves reason').count()).toBeGreaterThan(0)
    // The token leaves the address bar once read; absent sections leave no stray text.
    expect(new URL(page.url()).hash).toBe('')
    expect(await page.locator('main').innerText()).not.toContain('null')
    await page.getByRole('button', { name: 'Approve plan' }).click()
    await expect.poll(() => workflow.calls.length).toBe(1)
    expect(workflow.calls[0]![0]).toBe('approve')
    // The page approves the plan it shows (INV-5).
    expect(workflow.calls[0]![2]).toMatchObject({ verdict: 'approved', plan: 'sha256:11' })
  }, 60_000)
})
