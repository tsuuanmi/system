import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { ApprovalRequest, Verdict, VerdictResult } from '@tsuuanmi/system-approvals-core'
import { type Browser, chromium, type Page } from 'patchright-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import * as WebUi from '../src/index.ts'
import { lanWebServer } from '../../../gateway-core/tests/lan.ts'
import { decisionsIn, descriptionOf } from './wording.ts'

const RUN = {
  runId: 'run_abc', template: 'investigate', status: 'running', specHash: 'sha256:00', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:01Z',
  nodes: [{ nodeId: 'plan:1', state: 'COMPLETED', minTier: 'standard', attempt: 1, worker: 'worker:a/standard', tier: 'standard', quotaClass: 'subscription-chat' },
    { nodeId: 'plan:1:gate', state: 'BLOCKED', minTier: 'economy', attempt: 0 }],
  blocked: { kind: 'gate', nodeId: 'plan:1:gate', plan: 'sha256:11' },
}

/**
 * A board task's attempt 2 (T141): started from attempt 1's work (ADR-0061), a team member's answer sent
 * again once after a site's own error (ADR-0062), and its accepted result merged (ADR-0060).
 */
const CARRIED = {
  runId: 'run_carried', template: 'relay', status: 'completed', specHash: 'sha256:00', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:10:00Z', answer: 'done',
  nodes: [{ nodeId: 'develop:1', state: 'COMPLETED', minTier: 'standard', attempt: 1, worker: 'worker:a/standard', tier: 'standard' },
    { nodeId: 'review:m1:propose', state: 'COMPLETED', minTier: 'standard', attempt: 2, worker: 'worker:a/standard', tier: 'standard', error: { kind: 'overloaded', disposition: 'BACKOFF', message: 'scripted overloaded' } }],
  task: {
    taskId: 'task-7', generation: 1, claim: 'own', phase: 'reported',
    carry: { state: 'carried', from: { runId: 'run_first', attempt: 1, nodeId: 'develop:1', result: `sha256:${'1'.repeat(64)}`, workspace: '/w/run_first', subject: { ref: 'a'.repeat(40), version: 'b'.repeat(40) } }, decisions: [], commit: 'c'.repeat(40), at: '2026-10-12T00:00:01Z' },
    landing: { state: 'merged', branch: 'system/run/run_carried', head: 'd'.repeat(40), base: { branch: 'main', sha: 'a'.repeat(40) }, commit: 'e'.repeat(40), at: '2026-10-12T00:10:00Z' },
  },
}

/** A stand-in engine: what the UI reads and what it asks. */
class StubWorkflow extends Service {
  readonly calls: Array<[string, ...unknown[]]> = []
  constructor(ctx: Context) {
    super(ctx, 'workflow')
  }
  /** Runs listed after RUN: the roster suites' running step. */
  extra: unknown[] = []
  /** As the engine lists them (contract 1.7): by state, and by when their state changed. */
  usage(limit = 50, filter: { status?: readonly string[]; changedSince?: string } = {}) {
    return ([RUN, ...this.extra] as Array<{ status: string; updatedAt: string }>)
      .filter((r) => (filter.status === undefined || filter.status.includes(r.status)) && (filter.changedSince === undefined || r.updatedAt > filter.changedSince)).slice(0, limit)
  }
  /** When set, no run can be read: a page's refresh fails (the stale banner's suite). */
  gone = false
  get(id: string) { return this.gone ? undefined : id === RUN.runId ? RUN : id === CARRIED.runId ? CARRIED : undefined }
  explain(id: string) {
    if (id === CARRIED.runId) return { runId: id, nodes: [{ nodeId: 'develop:1', state: 'COMPLETED', decisions: [] }, { nodeId: 'review:m1:propose', state: 'COMPLETED', decisions: [{ id: 'sha256:44', type: 'recovery', outcome: 'resend', reasons: ['the site answered the sent prompt with its own error'] }] }] }
    return id === RUN.runId ? { runId: id, nodes: [{ nodeId: 'plan:1', state: 'COMPLETED', decisions: [{ id: 'sha256:22', type: 'route', outcome: 'worker:a/standard', reasons: ['proves reason'] }] }] } : undefined
  }
  landing() { return undefined }
  /** When set, the Workers the operator keeps out of teams (D58), or an engine that cannot tell. */
  excluded: { entries: string[]; workers: string[] } | Error | undefined
  async teamExclusion() {
    if (this.excluded instanceof Error) throw this.excluded
    return this.excluded ?? { entries: [], workers: [] }
  }
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
/** When the roster's pages are read: every time they show is on its day, so each reads as a clock time. */
const NOW = '2026-10-24T09:30:00.000Z'
/**
 * A page whose clock stands at NOW, in UTC, with a 24-hour clock: what it says of a time is the same
 * whenever and wherever the test runs (a reset past the host's midnight would read as another day).
 */
async function pinnedPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ timezoneId: 'UTC', locale: 'en-GB' })
  const page = await context.newPage()
  await page.clock.setFixedTime(NOW)
  return page
}
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
      ...this.extra,
    ]
  }
  /** Workers beside the website account's: the pools suite's agent Worker. */
  extra: unknown[] = []
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

/** A stand-in for the agent accounts: one slot whose last usage report could not be read (T111). */
class StubAgentWorkers extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentWorkers')
  }
  readonly agentAccounts = {
    list: () => [{ accountId: 'acc-a', provider: 'claude-agent-sdk', slot: 1, status: 'ready' }],
    workersIn: () => ['agent:acc-a/develop'],
    unreadReport: () => ({ why: 'the runtime gave no answer within 30 s', at: '2026-10-24T09:20:00.000Z' }),
  }
}

/** A stand-in ledger: the website account's own pool, one window read from its usage report, one with no share, one never read (ADR-0059). */
class StubResources extends Service {
  constructor(ctx: Context) {
    super(ctx, 'resources')
  }
  readonly at = Date.parse(NOW)
  async pools() {
    const windows = [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }, { id: 'seven-day', kind: 'rolling', seconds: 604_800 }, { id: 'credit', kind: 'credit' }]
    const read = (window: (typeof windows)[number], extra: Record<string, unknown>) => ({ schema: 'limit-state@1.0', pool: 'plan/plus', account: 'plus', window, source: 'runtime-result', observedAt: new Date(this.at - 60_000).toISOString(), ...extra })
    return [{ pool: 'plan/agent', account: 'acc-a', kind: 'programmatic', windows: [windows[0]!], available: true, readings: [] }, {
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
    ...(options.pools ? [ctx.plugin(StubResources), ctx.plugin(StubAgentWorkers)] : []), ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUi, { tokenDir: dir })]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  if (options.roster) (ctx as unknown as { workflow: StubWorkflow }).workflow.extra = [STEP]
  if (options.pools) (ctx as unknown as { workers: StubRouter }).workers.extra = [{ worker: 'agent:acc-a/develop', provider: 'claude-agent-sdk', family: 'claude-agent-sdk', account: { id: 'acc-a', group: 'claude-agent-sdk', mode: 'assigned' }, tier: 'frontier', quotaClass: 'agent-plan', locality: 'local', state: 'ready', observedAt: AT }]
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

  it('serves the roster to the operator only, with account labels, valid against mcp-roster@1.6, and what it could not read as unknown (REQ-HOST-8)', async () => {
    const { origin, token } = await boot({ roster: true })
    const auth = { authorization: `Bearer ${token}` }
    const response = await fetch(`${origin}/ui/api/roster`, { headers: auth })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    const roster = await response.json() as Record<string, unknown>
    new SchemaRegistry().assertDef('mcp-roster@1.6', 'roster-output', roster)
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
    new SchemaRegistry().assertDef('mcp-roster@1.7', 'roster-output', roster)
    // Capacity now, made on the server (T152), which the Workers page's Right now renders as it is: no Worker free, the account at its limit until its reset.
    new SchemaRegistry().assertDef('mcp-roster@1.7', 'capacity', roster.now)
    expect(roster.now).toMatchObject({
      free: { value: { items: [], more: 0 } },
      noQuota: { value: { items: [{ account: 'plus', name: 'Chatgpt · Studio Plus', until: { value: '2026-10-24T11:00:00.000Z' } }], more: 0 } },
    })
    expect((await fetch(`${origin}/ui/api/roster`, { headers: { authorization: `Bearer ${Buffer.alloc(32, 8).toString('base64url')}` } })).status).toBe(401)
    expect((await fetch(`${origin}/ui/api/roster`, { headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${origin}/ui/api/roster`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', origin }, body: '{}' })).status).toBe(405)
    // With no Worker registry at all, the Workers are unknown, not an empty list.
    const bare = await boot()
    const none = await (await fetch(`${bare.origin}/ui/api/roster`, { headers: { authorization: `Bearer ${bare.token}` } })).json()
    expect(none).toMatchObject({ workers: { unknown: 'the Worker registry (ctx.workers) is not mounted' } })
  })

  it.runIf(canRunBrowser)('renders the Workers tab in a real browser: counts, the Workers by account under its header, each card calm (what it is for, its status, what it does now) with every unknown, derived, or technical fact folded under its details (T85, T119)', async () => {
    const { origin, token } = await boot({ roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await pinnedPage(browser)
    await page.goto(`${origin}/ui/#token=${token}`)
    await page.getByRole('link', { name: 'Workers', exact: true }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Workers', exact: true }).count()).toBe(1)
    expect(new URL(page.url()).search).toBe('?view=workers')
    // The operator's words: free, and resting until a clock time.
    expect(await page.getByLabel('Worker counts').innerText()).toBe('1 working · 0 free · 1 resting (the first until 11:00) · 0 unavailable')
    // The account once, how many Workers in its header (their roles under its details), its rest said once for both.
    const account = page.getByRole('region', { name: 'Account Chatgpt · Studio Plus' })
    expect(await account.getByRole('heading', { level: 3 }).innerText()).toMatch(/^Chatgpt · Studio Plus · 2 Workers\b/)
    expect(await account.innerText()).toContain('Its account is resting until 11:00 (in 2 h)')
    expect(await account.locator('details.facts').first().textContent()).toContain('Rolesfrontier, standard')
    const busy = account.getByRole('article', { name: 'Chatgpt · Studio Plus · standard' })
    expect(await busy.getByRole('heading', { level: 4 }).innerText()).toBe('standard')
    const shown = await busy.innerText()
    for (const said of ['The studio\'s chat subscription for quick questions (standard tier)', 'Working · 1/2 slots · 1 slot free',
      // The step in words (T141): a team member's answer, not its node id; the roster's own sentence is under details.
      'Running team member 1\'s answer in a team run',
      // Beside what it does now, the earlier run that holds its session for want of a verdict, and what frees it (PROP-0013): never folded.
      'agent run arun_00000000000000a2 of run run_old ended without being known to be gone, holding session ses_9; free it once its agent is gone (system free arun_00000000000000a2 --agent-gone)']) expect(shown, said).toContain(said)
    // Nothing technical or unknown up front: it is all under the card's details.
    for (const folded of ['Worker id', 'worker:plus/standard', 'unknown (', 'family', 'role none', 'Load']) expect(shown, folded).not.toContain(folded)
    await busy.getByText('details', { exact: true }).click()
    const opened = await busy.innerText()
    for (const said of ['Worker id', 'worker:plus/standard', 'plus · website account, ready', 'standard tier, subscription-chat, remote', '1 of 2 running',
      'Running review run run_xyz, step review:m1:propose, since an unknown time']) expect(opened, said).toContain(said)
    await busy.getByRole('link', { name: 'Open run run_old' }).focus()
    // A reason that blocks work stays visible: resting until when.
    const resting = account.getByRole('article', { name: 'Chatgpt · Studio Plus · frontier' })
    const rest = await resting.innerText()
    expect(rest).toContain('Resting until 11:00 (in 2 h)')
    expect(rest).not.toContain('derived')
    await resting.getByText('details', { exact: true }).click()
    expect(await resting.innerText()).toContain('chatgpt-web Worker, frontier tier, subscription-chat, remote (no description is configured)')
    // The account's quota that could not be read is folded under its own details.
    expect(await account.innerText()).not.toContain('the resource ledger (ctx.resources) is not mounted')
    await account.getByText('details', { exact: true }).first().click()
    expect(await account.innerText()).toContain('unknown (the resource ledger (ctx.resources) is not mounted)')
    await busy.getByRole('link', { name: 'Open run run_xyz' }).focus()
    expect(await page.locator('main').innerText()).not.toContain('null')
  }, 60_000)

  it.runIf(canRunBrowser)('shows each window of an account\'s pool as "5 h · used X % · resets HH:MM" with a small bar, when it was read under the account\'s details, at its limit first, and what its reading does not give as unknown, with why (ADR-0059, T116, T171)', async () => {
    const { origin, token } = await boot({ roster: true, pools: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await pinnedPage(browser)
    await page.goto(`${origin}/ui/?view=workers#token=${token}`)
    // The quota is the account's: shown once, under its header (T119).
    const busy = page.getByRole('region', { name: 'Account Chatgpt · Studio Plus' })
    const line = (window: string) => busy.getByLabel(`window ${window} of plan/plus`)
    await expect.poll(() => line('five-hour').count()).toBe(1)
    // Read a minute before NOW; reset 15 min and 1 h after it: each on the page's day, so a clock time.
    expect(await line('five-hour').innerText()).toBe('5 h · used 42 % · resets 09:45')
    expect(await line('seven-day').innerText()).toBe('7 d · at its limit · used unknown (its latest reading gives no used share) · resets 10:30')
    expect(await line('credit').innerText()).toBe('credit · no reading yet')
    // When each window was read: under the account's details, never dropped (T171).
    expect(await busy.locator('details.facts').first().textContent()).toContain('Quota read5 h read 09:29; 7 d read 09:29')
    // A small bar beside a window whose share is read; the window at its limit first, in a pool at its limit (T116).
    expect(await line('five-hour').locator('meter').getAttribute('value')).toBe('42')
    expect(await line('credit').locator('meter').count()).toBe(0)
    expect(await busy.locator('.window').evaluateAll((lines) => lines.map((l) => l.getAttribute('aria-label')))).toEqual(['window seven-day of plan/plus', 'window five-hour of plan/plus', 'window credit of plan/plus'])
    // The pool at its limit rests: said once, by its account (its limitUntil), not again by the pool.
    expect(await page.getByRole('region', { name: 'Account Chatgpt · Studio Plus' }).innerText()).toMatch(/Its account is resting until /)
    // Each account's capacity on Home in one line, its 5 h bar beside it (T119).
    await page.getByRole('link', { name: 'Home' }).click()
    const capacity = page.getByLabel('Capacity of Chatgpt · Studio Plus')
    await expect.poll(() => capacity.count()).toBe(1)
    expect(await capacity.innerText()).toBe('Chatgpt · Studio Plus: resting until 11:00 (in 2 h); 5 h used 42 %, resets 09:45')
    expect(await capacity.locator('meter').getAttribute('value')).toBe('42')
    expect(await page.getByLabel('Capacity of Claude · slot 1').innerText()).toBe('Claude · slot 1: 5 h no reading yet')
    await page.getByRole('link', { name: 'Workers', exact: true }).click()
    await expect.poll(() => page.getByRole('article', { name: 'agent:acc-a/develop' }).count()).toBe(1)
    // No reading yet, with why its account's usage report could not be read, its time on the clock (T111).
    const agent = page.getByRole('region', { name: 'Account Claude · slot 1' }).getByLabel('window five-hour of plan/agent')
    expect(await agent.innerText()).toBe('5 h · no reading yet: its account\'s usage report could not be read at 09:20: the runtime gave no answer within 30 s')
    expect(await agent.innerText()).not.toContain('2026-10-24T')
    expect(await page.locator('main').innerText()).not.toContain('null')
  }, 60_000)

  it.runIf(canRunBrowser)('shows the approval queue in a real browser and approves a batch on the subjects it shows', async () => {
    const { origin, token, approvals } = await boot({ approvals: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const queue = page.getByRole('region', { name: 'Approval queue' })
    // A batch by its size, its id folded behind its copy button (T171).
    const batch = queue.getByRole('region', { name: 'Batch batch-1' })
    await expect.poll(() => batch.getByRole('heading', { level: 3 }).first().innerText()).toMatch(/^2 related requests/)
    expect(await batch.locator('button.copy', { hasText: 'Copy batch ID' }).getAttribute('data-copy')).toBe('batch-1')
    for (const text of ['merge apr-1', 'the branch lands on main', 'deploy', 'content board-task:apr-1:attempt:0 @ approval-needed', 'Decided one by one',
      'Allow a merge step: merge apr-1', 'batch-1']) {
      expect(await queue.getByText(text, { exact: true }).count(), text).toBeGreaterThan(0)
    }
    expect(await queue.innerText()).toMatch(/3 approvals · next expiry /)
    // Each card (T186): one line, what is asked, for which task, and until when, with what no response does; two short buttons;
    // who asked, what it is about, its id, and its exact expiry under one closed Details.
    const third = page.locator('#request-apr-3')
    expect(await third.locator('.line').innerText()).toMatch(/^Allow a deploy step: merge apr-3\s+for task apr-3 · Expired .+ ago · No response: denied$/)
    expect(await third.getByRole('button').allInnerTexts()).toEqual(['Approve', 'Deny'])
    expect(await third.locator('details.card-details').getAttribute('open')).toBeNull()
    expect(await third.innerText()).not.toContain('Asked by')
    expect(await third.innerText()).not.toContain('request apr-3')
    expect(await third.textContent()).toContain('request apr-3')
    await third.getByText('Details', { exact: true }).click()
    expect(await third.innerText()).toContain('Asked by the board, for task task-apr-3 of project p1')
    expect(await third.innerText()).toContain('task apr-3 of project p1, attempt 1')
    expect(await third.innerText()).toContain('request apr-3')
    expect(await third.innerText()).toContain('Approve: allow this deploy · Deny: hold the task')
    expect(await page.locator('main').innerText()).not.toContain('null')
    // T191: every decision is Approve / Deny (a batch's Approve all 2 / Deny all 2), its effect its accessible
    // description, never its label.
    const decisions = await decisionsIn(queue)
    expect(decisions.map((d) => d.label)).toEqual(['Approve all 2', 'Deny all 2', 'Approve', 'Deny', 'Approve', 'Deny', 'Approve', 'Deny'])
    for (const d of decisions) expect(d.description, d.label).not.toBe('')
    expect(decisions.slice(0, 2).map((d) => d.description)).toEqual(['approves each request below as shown', 'denies each request below'])
    const thirdDeny = third.getByRole('button', { name: 'Deny', exact: true })
    expect(await descriptionOf(third.getByRole('button', { name: 'Approve', exact: true }))).toBe('allows this deploy')
    expect(await descriptionOf(thirdDeny)).toBe('holds the task')
    // The effect is said beside each button too, for every reader.
    expect(await third.locator('.actions').innerText()).toMatch(/Approve\s+allows this deploy\s+Deny\s+holds the task/)
    await queue.getByRole('textbox', { name: 'Note for all (optional)' }).fill('ship it')
    await queue.getByRole('button', { name: 'Approve all 2' }).click()
    await expect.poll(() => approvals().calls.length).toBe(1)
    expect(approvals().calls[0]![0]).toEqual([
      { requestId: 'apr-1', subject: QUEUE[0]!.subject, verdict: 'approved', note: 'ship it' },
      { requestId: 'apr-2', subject: QUEUE[1]!.subject, verdict: 'approved', note: 'ship it' },
    ])
    // The result counted, what happens next for each; the records' ids folded.
    await expect.poll(() => page.locator('#outcome').innerText()).toContain('2 approved')
    expect(await page.locator('#outcome').innerText()).not.toContain('approval record')
    expect(await page.locator('#outcome').textContent()).toContain('Recorded as your verdict on request apr-1 (approval record sha256:')
    await thirdDeny.click()
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
    const approve = page.locator('article', { hasText: 'request apr-3' }).getByRole('button', { name: 'Approve', exact: true })
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
    await page.locator('article', { hasText: 'request apr-3' }).getByRole('button', { name: 'Approve', exact: true }).click()
    const alert = page.getByRole('alert')
    await expect.poll(() => alert.innerText()).toContain('Not recorded: your approval of Allow a deploy step: merge apr-3')
    expect(await alert.innerText()).toContain('the store is busy')
    expect(await alert.innerText()).toContain('Nothing was decided: the request is still open in the queue.')
    // The buttons are back for another try.
    const again = page.locator('article', { hasText: 'request apr-3' }).getByRole('button', { name: 'Approve', exact: true })
    expect(await again.isEnabled()).toBe(true)
    // Its label back, and still described by its effect (T191).
    expect(await descriptionOf(again)).toBe('allows this deploy')
    // A periodic refresh does not take it away.
    const listed = approvals().lists
    await expect.poll(() => approvals().lists, { timeout: 10_000 }).toBeGreaterThan(listed)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await alert.innerText()).toContain('the store is busy')
    await alert.getByRole('button', { name: 'Dismiss' }).click()
    expect(await page.getByRole('alert').count()).toBe(0)
  }, 60_000)

  // Round 8 (T186): one line and two buttons a card, its facts under one closed Details, at most 5 rows a list.
  /** Seven runs outside the board that failed in the last minutes: seven lines since the operator last looked, eight runs needing attention with RUN. */
  const failedRuns = (now: number) => Array.from({ length: 7 }, (_, i) => ({
    runId: `run_f${i + 1}`, template: 'solo', status: 'failed', specHash: 'sha256:00', createdAt: new Date(now - 600_000).toISOString(), updatedAt: new Date(now - (i + 1) * 60_000).toISOString(),
    nodes: [], error: { kind: 'timeout', disposition: 'NONE', message: `scripted timeout ${i + 1}` },
  }))

  it.runIf(canRunBrowser)('keeps every fact of an approval card under its Details, closed by default, and reaches every button by keyboard, those inside Details once it is opened', async () => {
    const { origin, token } = await boot({ approvals: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const cards = page.locator('article.request[id^="request-"]')
    await expect.poll(() => cards.count()).toBe(3)
    for (const id of ['apr-1', 'apr-2', 'apr-3']) {
      const card = page.locator(`#request-${id}`)
      // In sight: one line and two buttons, Approve and Deny, each named by its effect for assistive technology.
      expect(await card.getByRole('button').allInnerTexts(), id).toEqual(['Approve', 'Deny'])
      expect(await card.getByRole('button', { name: /^Approve: / }).count(), id).toBe(1)
      expect(await card.getByRole('button', { name: /^Deny: / }).count(), id).toBe(1)
      expect(await card.locator('.line').innerText(), id).toMatch(/·\s*(Expires|Expired) .+ · No response: denied$/)
      // Every other fact folded, never dropped: who asked, what it is about, its exact subject, what each verdict does, its id and expiry.
      const details = card.locator('details.card-details')
      expect(await details.count(), id).toBe(1)
      expect(await details.getAttribute('open'), id).toBeNull()
      const shown = await card.innerText()
      for (const folded of ['Asked by', 'About', 'Exact subject', `request ${id}`, 'expires ']) expect(shown, `${id}: ${folded}`).not.toContain(folded)
      const all = await card.textContent()
      for (const fact of ['Asked by the board', `of project p1, attempt 1`, `content board-task:${id}:attempt:0 @ approval-needed`, `request ${id}`, 'expires ', 'Note (optional)']) expect(all, `${id}: ${fact}`).toContain(fact)
    }
    // A merge's consequences as given; a task's step says what approving and denying do.
    expect(await page.locator('#request-apr-1').textContent()).toContain('the branch lands on main')
    expect(await page.locator('#request-apr-3').textContent()).toMatch(/If you approve.+If you deny/)
    expect(await page.locator('main details.fold[open]').count()).toBe(0)

    // Keyboard: from the top of the page, Tab reaches every button in sight.
    await page.locator('main').focus()
    const marked = await page.locator('main button:visible').evaluateAll((list) => list.map((b, i) => { b.setAttribute('data-k', String(i)); return (b.getAttribute('aria-label') ?? b.textContent ?? '') }))
    expect(marked).toEqual(expect.arrayContaining(['Approve all 2', 'Deny all 2', 'Approve: allow this merge', 'Deny: hold the task', 'Approve: allow this deploy']))
    const reached = new Set<string>()
    for (let i = 0; i < 400 && reached.size < marked.length; i++) {
      await page.keyboard.press('Tab')
      const k = await page.evaluate(() => document.activeElement?.getAttribute('data-k') ?? null)
      if (k !== null) reached.add(k)
    }
    expect(reached.size).toBe(marked.length)
    // A card's Details opens by keyboard, and its controls then join the keyboard order.
    const third = page.locator('#request-apr-3')
    await third.locator('details.card-details > summary').focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => third.locator('details.card-details').getAttribute('open')).toBe('')
    expect(await third.innerText()).toContain('Asked by the board, for task task-apr-3 of project p1')
    const inside: string[] = []
    for (let i = 0; i < 8 && !inside.includes('Copy request ID'); i++) {
      await page.keyboard.press('Tab')
      inside.push(await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a?.getAttribute('aria-label') ?? (a?.tagName === 'INPUT' ? 'input:' + a.id : a?.textContent ?? '') }))
    }
    expect(inside).toContain('input:note-apr-3')
    expect(inside).toContain('Copy request ID')
  }, 60_000)

  it.runIf(canRunBrowser)('shows at most 5 rows in Since you last looked and in Runs needing attention, each with a Show all that reaches every row and stays through the refresh', async () => {
    const { origin, token, workflow } = await boot({ approvals: true })
    const now = Date.now()
    workflow.extra = failedRuns(now)
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${token}`)
    await page.evaluate((at) => localStorage.setItem('system.seen', JSON.stringify({ at, workers: {} })), new Date(now - 3_600_000).toISOString())
    await page.reload()
    const since = page.getByRole('region', { name: 'Since you last looked' })
    const lines = since.locator('ul.since > li')
    await expect.poll(() => lines.count(), { timeout: 15_000 }).toBe(5)
    // The latest first: the five newest of the seven, then Show all 7.
    expect(await lines.first().innerText()).toMatch(/^Failed: a solo run — it took longer than its limit/)
    const more = since.getByRole('button', { name: 'Show all 7' })
    expect(await more.getAttribute('aria-expanded')).toBe('false')
    expect(await more.getAttribute('aria-controls')).toBe('since-list')
    await more.click()
    await expect.poll(() => lines.count()).toBe(7)
    expect(await since.getByRole('button', { name: 'Show first 5' }).getAttribute('aria-expanded')).toBe('true')
    // Each raw text is still under its own fold.
    expect(await since.locator('li details').count()).toBe(7)

    const look = page.getByRole('region', { name: 'Runs needing attention' })
    const runs = look.getByRole('article')
    expect(await runs.count()).toBe(5)
    await look.getByRole('button', { name: 'Show all 8' }).click()
    await expect.poll(() => runs.count()).toBe(8)
    for (let i = 1; i <= 7; i++) expect(await look.locator('button.copy', { hasText: 'Copy run ID' }).evaluateAll((list) => list.map((b) => b.getAttribute('data-copy')))).toContain(`run_f${i}`)

    // A refresh keeps both lists as the operator left them.
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); document.querySelector('main section[aria-label="Since you last looked"]')!.setAttribute('data-old', '1') })
    await expect.poll(() => page.locator('main section[data-old]').count(), { timeout: 15_000 }).toBe(0)
    await expect.poll(() => lines.count()).toBe(7)
    expect(await runs.count()).toBe(8)
    await look.getByRole('button', { name: 'Show first 5' }).click()
    await expect.poll(() => runs.count()).toBe(5)
  }, 60_000)

  it.runIf(canRunBrowser)('heads every page with its title and one short sentence at most', async () => {
    const { origin, token } = await boot({ roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    for (const path of ['/ui/', '/ui/?run=run_abc', '/ui/?view=board', '/ui/?view=workers', '/ui/?view=policy', '/ui/?view=help']) {
      if (path !== '/ui/') await page.goto(origin + path)
      await expect.poll(() => page.locator('main h2.page').count(), { message: path }).toBe(1)
      const leads = await page.locator('main h2.page ~ p.lead').allInnerTexts()
      expect(leads, path).toHaveLength(1)
      // One sentence: a single full stop, at its end, and short.
      expect(leads[0], path).toMatch(/^[^.!?]+[.!?]$/)
      expect(leads[0]!.length, path).toBeLessThanOrEqual(48)
    }
  }, 60_000)

  it.runIf(canRunBrowser)('opens on a dashboard: what waits for you, each linked to its section, the Workers at a glance, the runs that need a look with their action, and the recent runs (T97)', async () => {
    const { origin, token } = await boot({ approvals: true, roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    // Each group a label and its count (T171), each one by name under it, linked to where it is decided (T141).
    const waiting = page.getByRole('region', { name: 'Needs your attention', exact: true })
    await expect.poll(() => waiting.innerText()).toContain('Approvals · 3')
    expect(await waiting.innerText()).toContain('Runs needing attention · 1')
    expect(await waiting.innerText()).toMatch(/Allow a merge step: merge apr-1 · expires /)
    expect(await waiting.innerText()).toContain('an investigate run · Plan awaiting approval')
    await waiting.getByRole('link', { name: 'Allow a deploy step: merge apr-3' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('request-apr-3')
    expect(await page.getByRole('region', { name: 'Workers at a glance' }).innerText()).toContain('1 working · 0 free · 1 resting · 0 unavailable')
    // The blocked run is listed by its title, why as a chip, and one action; its id behind a copy button.
    const look = page.getByRole('region', { name: 'Runs needing attention' })
    expect(await look.innerText()).toContain('Plan awaiting approval')
    expect(await look.innerText()).not.toContain('run_abc')
    expect(await look.getByRole('button', { name: 'Copy run ID' }).getAttribute('data-copy')).toBe('run_abc')
    await look.getByRole('link', { name: 'Open run' }).click()
    await expect.poll(() => page.locator('h2.page[data-page="run:run_abc"]').count()).toBe(1)
    await page.goBack()
    await waiting.getByRole('link', { name: 'Approvals · 3' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('approvals')
    expect(await page.getByRole('heading', { name: 'Recent runs' }).count()).toBe(1)
    // A recent run: its title, its state as a chip (a word and a symbol, never colour alone), its progress; its steps' Workers and id folded.
    const row = page.locator('table tr', { hasText: 'investigate run' })
    expect(await row.innerText()).toContain('▲ Needs your attention')
    expect(await row.innerText()).toContain('1/2 steps · waiting: plan:1:gate')
    expect(await row.innerText()).not.toContain('run_abc')
    expect(await row.textContent()).toContain('plan:1: worker:a/standard')
    expect(await row.textContent()).toContain('template investigate · run run_abc')
  }, 60_000)

  it.runIf(canRunBrowser)('has one navigation on every page, the current page marked, and each page a title with a few words of what it is for (T97, T171)', async () => {
    const { origin, token } = await boot({ approvals: true, roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const nav = page.getByRole('navigation', { name: 'Pages' })
    const current = () => nav.locator('[aria-current="page"]').innerText()
    await expect.poll(() => page.getByRole('heading', { name: 'Home', exact: true }).count()).toBe(1)
    expect(await current()).toBe('Home')
    expect(await page.locator('p.lead').innerText()).toBe('Your next actions and recent activity.')
    for (const [link, purpose] of [['Board', 'Projects and tasks.'], ['Workers', 'Availability, quota, and current work.'], ['Autonomy policy', 'Control which actions need approval.']] as const) {
      await nav.getByRole('link', { name: link }).click()
      await expect.poll(() => page.getByRole('heading', { name: link, exact: true }).count()).toBe(1)
      expect(await current()).toBe(link)
      expect(await page.locator('p.lead').innerText()).toContain(purpose)
      expect(await page.title()).toMatch(new RegExp(`^(\\(\\d+\\) )?system — ${link}$`))
    }
    // Keyboard: the navigation is links, reached and followed without a pointer.
    await nav.getByRole('link', { name: 'Home' }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => current()).toBe('Home')
    await page.getByRole('link', { name: 'investigate run' }).first().click()
    await expect.poll(() => page.locator('h2.page[data-page="run:run_abc"]').count()).toBe(1)
    expect(await page.getByRole('heading', { level: 2 }).first().innerText()).toBe('investigate run')
    expect(await page.locator('p.lead').innerText()).toBe('Result and progress.')
    expect(await page.locator('main').innerText()).not.toContain('← ')
  }, 60_000)

  it.runIf(canRunBrowser)('shows a run as a status chip and where it is, what you can do, the answer, and its steps as a timeline in words, the decisions, spec, and ids folded (T97, T171)', async () => {
    const { origin, token, workflow } = await boot({ roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?run=run_abc#token=${token}`)
    await expect.poll(() => page.locator('h2.page[data-page="run:run_abc"]').count()).toBe(1)
    const text = await page.locator('main').innerText()
    expect(await page.locator('p.status-line').innerText()).toMatch(/^▲ Needs your attention Plan awaiting approval · started .+ ago$/)
    expect(text).toContain('Plan awaiting approval · plan:1:gate')
    expect(text).toContain('No answer yet.')
    // The run's id, its template, and its last change behind a copy button and under Technical details.
    expect(text).not.toContain('run_abc')
    expect(await page.getByRole('button', { name: 'Copy run ID' }).getAttribute('data-copy')).toBe('run_abc')
    expect(await page.locator('details', { hasText: 'Technical details' }).textContent()).toMatch(/Template investigate · last changed .+ · spec sha256:00/)
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
    // The plan's verdicts are Approve / Deny, as every approval's, each described by its effect (T191).
    expect(await decisionsIn(page.locator('main .panel', { hasText: 'Plan awaiting approval' }))).toEqual([
      { label: 'Approve', description: 'the step goes on with this plan' }, { label: 'Deny', description: 'this plan does not run' }])
    // Stop ends the run, so it asks first: nothing is sent until Confirm, and Cancel sends nothing (T170). Its
    // label is Stop run, what it does its accessible description (T191).
    const stop = page.getByRole('button', { name: 'Stop run' })
    expect(await descriptionOf(stop)).toBe('ends this run, after you confirm')
    expect(await page.getByText('ends this run, after you confirm').count()).toBe(1)
    await stop.click()
    const confirm = page.getByRole('group', { name: 'Confirm stop' })
    await expect.poll(() => confirm.innerText()).toContain('Stop this run?')
    // The confirmation is Confirm / Cancel, as every confirmation's, each described by what it does.
    expect(await decisionsIn(confirm)).toEqual([
      { label: 'Confirm', description: 'stops this run: nothing more of it runs' }, { label: 'Cancel', description: 'the run goes on' }])
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Confirm')
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    expect(await confirm.count()).toBe(0)
    expect(workflow.calls).toEqual([])
    await page.getByRole('button', { name: 'Stop run' }).click()
    await page.getByRole('group', { name: 'Confirm stop' }).getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => workflow.calls).toEqual([['stop', 'run_abc', 'stopped from the web UI']])
  }, 60_000)

  it.runIf(canRunBrowser)('says on a run\'s page what happened to it in plain words: it started from the previous attempt\'s work, a team member\'s answer was sent again once, and its result was merged (ADR-0060, ADR-0061, ADR-0062, T141)', async () => {
    const { origin, token } = await boot()
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?run=run_carried#token=${token}`)
    const happened = page.getByRole('region', { name: 'What happened' })
    await expect.poll(() => happened.count()).toBe(1)
    // Each outcome in a line; its mechanics (the worktree, the commit, the new conversation) folded under it (T171).
    const said = await happened.innerText()
    expect(said).toContain('Continued from attempt 1 (its run)')
    expect(said).toContain('Team member 1\'s answer: retried once after a service error.')
    expect(said).toContain('Accepted and merged into main as eeeeeeeeeeee · not pushed')
    expect(said).not.toContain('worktree')
    const folded = await happened.textContent()
    expect(folded).toContain('That change was already in its worktree, saved as cccccccccccc; its writing step built on it instead of starting over.')
    expect(folded).toContain('The site answered with its own error instead of an answer, so it was sent again once, in a new conversation on the same Worker; never a third time.')
    expect(await happened.getByRole('link', { name: 'its run' }).getAttribute('href')).toBe('?run=run_first')
    // Each new word has its "?" (T126); the run is headed by its template with no task; the step reads by member, its id folded.
    for (const word of ['continued from earlier work', 'retried after a service error']) expect(await happened.getByRole('button', { name: `What is ${word}?` }).count(), word).toBe(1)
    const steps = page.locator('ol.timeline > li')
    expect(await steps.nth(1).innerText()).toMatch(/^team member 1's answer done/)
    expect(await steps.nth(1).innerText()).not.toContain('review:m1:propose')
    expect(await steps.nth(1).textContent()).toContain('review:m1:propose')
    // The earlier attempt's error on a step that went on is history: folded under Attempt history, never as the step's failure;
    // its reason in the plain words of failureReason, its disposition included (T160).
    expect(await steps.nth(1).innerText()).toContain('Attempt history')
    expect(await steps.nth(1).textContent()).toContain('An earlier attempt failed: the site was busy, or answered with its own error (it is tried again later) — scripted overloaded')
    expect(await steps.nth(1).locator('.state.failed').count()).toBe(0)
  }, 60_000)

  it.runIf(canRunBrowser)('says on a Worker\'s card that the operator keeps it out of teams, and folds an engine that cannot tell under its details (D58, T141)', async () => {
    const { origin, token, workflow } = await boot({ roster: true })
    workflow.excluded = { entries: ['plus'], workers: ['worker:plus/frontier', 'worker:plus/standard'] }
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await pinnedPage(browser)
    await page.goto(`${origin}/ui/?view=workers#token=${token}`)
    const card = page.getByRole('article', { name: 'Chatgpt · Studio Plus · standard' })
    // The operator's own choice as a chip, never folded; what it means behind its "?" (T171).
    await expect.poll(() => card.innerText()).toContain('◆ Excluded from teams')
    expect(await card.getByRole('button', { name: 'What is team?' }).count()).toBe(1)
    await card.getByText('details', { exact: true }).click()
    expect(await card.innerText()).toContain('Kept out of teams by the operator: its account is named in teams.excludeWorkers')
    // Right now, by name: a count each, then who is free, who is stalled, and which account has no quota left (T141, T171).
    const now = page.getByRole('region', { name: 'Right now' })
    expect(await now.innerText()).toContain('Free: 0')
    expect(await now.innerText()).toContain('Stalled: 0')
    expect(await now.innerText()).toContain('No quota left: 1 — Chatgpt · Studio Plus until 11:00 (in 2 h)')
    // An engine that cannot tell: no chip on the card, the unknown under its details (INV-2).
    workflow.excluded = new Error('the router is busy')
    await page.reload()
    await expect.poll(() => card.count()).toBe(1)
    expect(await card.innerText()).not.toContain('Excluded from teams')
    await card.getByText('details', { exact: true }).click()
    expect(await card.innerText()).toContain('Teams\nunknown (it could not be read: the router is busy)')
  }, 60_000)

  it.runIf(canRunBrowser)('names the same free, stalled, and no-quota Workers on Home as on the Workers page, from the one capacity summary, and never offers a Worker kept out of teams for team work (T152, D58, T160)', async () => {
    const { origin, token, ctx, workflow } = await boot({ roster: true })
    // A Worker of no account, free with no quota tracked, which the operator excludes from teams.
    const router = (ctx as unknown as { workers: StubRouter }).workers
    router.extra = [{ worker: 'worker:local/economy', provider: 'ollama', family: 'ollama', tier: 'economy', quotaClass: 'local', locality: 'local', state: 'ready', observedAt: AT }]
    workflow.excluded = { entries: ['worker:local/economy'], workers: ['worker:local/economy'] }
    const roster = await (await fetch(`${origin}/ui/api/roster`, { headers: { authorization: `Bearer ${token}` } })).json() as { now: { free: { value: { items: Array<{ worker: string; name: string }> } } } }
    const free = roster.now.free.value.items
    expect(free.map((f) => f.worker)).toEqual(['worker:local/economy'])
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await pinnedPage(browser)
    await page.goto(`${origin}/ui/#token=${token}`)
    const lines = async () => {
      const now = page.getByRole('region', { name: 'Right now' })
      await expect.poll(() => now.count()).toBe(1)
      const said = (await now.innerText()).split('\n')
      return Object.fromEntries(['Free', 'Stalled', 'No quota left'].map((head) => [head, said.find((l) => l.startsWith(`${head}: `))]))
    }
    // Home renders the summary by the same function as the Workers page: the same names on each line.
    const home = await lines()
    expect(await page.getByRole('region', { name: 'Workers at a glance' }).getByRole('region', { name: 'Right now' }).count()).toBe(1)
    expect(home['Free']).toBe(`Free: 1 — ${free[0]!.name} (quota not tracked; excluded from teams: free for other steps, not team work)`)
    expect(home['Stalled']).toBe('Stalled: 0')
    expect(home['No quota left']).toBe('No quota left: 1 — Chatgpt · Studio Plus until 11:00 (in 2 h)')
    await page.getByRole('link', { name: 'Workers', exact: true }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Workers', exact: true }).count()).toBe(1)
    expect(await lines()).toEqual(home)
    // Kept in teams again, it is free for every step: said the same on both pages.
    workflow.excluded = undefined
    await page.reload()
    await expect.poll(async () => (await lines())['Free']).toBe(`Free: 1 — ${free[0]!.name} (quota not tracked)`)
    const workers = await lines()
    await page.getByRole('link', { name: 'Home' }).click()
    await expect.poll(() => page.getByRole('region', { name: 'Since you last looked' }).count()).toBe(1)
    expect(await lines()).toEqual(workers)
  }, 60_000)

  it.runIf(canRunBrowser)('renders runs, steps, and decisions in a real browser, and approves a waiting plan', async () => {
    const { origin, token, workflow } = await boot()
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    await page.getByRole('link', { name: 'investigate run' }).first().click()
    await expect.poll(() => page.locator('h2.page[data-page="run:run_abc"]').count()).toBe(1)
    await expect.poll(() => page.getByText('worker:a/standard').count()).toBeGreaterThan(0)
    await expect.poll(() => page.getByText('proves reason').count()).toBeGreaterThan(0)
    // The token leaves the address bar once read; absent sections leave no stray text.
    expect(new URL(page.url()).hash).toBe('')
    expect(await page.locator('main').innerText()).not.toContain('null')
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect.poll(() => workflow.calls.length).toBe(1)
    expect(workflow.calls[0]![0]).toBe('approve')
    // The page approves the plan it shows (INV-5).
    expect(workflow.calls[0]![2]).toMatchObject({ verdict: 'approved', plan: 'sha256:11' })
  }, 60_000)
})

describe('web UI: the shared building blocks and the production states (T172)', () => {
  const GLYPHS = ['●', '▲', '■', '◆', '○']

  it.runIf(canRunBrowser)('builds every page from one status chip (a word and a symbol, never colour alone), one count with its unit, one relative time with its exact time on hover and focus, one fold closed by default, and one copy button for ids', async () => {
    const { origin, token } = await boot({ approvals: true, roster: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    await expect.poll(() => page.getByRole('region', { name: 'Runs needing attention' }).count()).toBe(1)
    for (const path of ['/ui/', '/ui/?run=run_abc', '/ui/?view=workers', '/ui/?view=help']) {
      if (path !== '/ui/') await page.goto(origin + path)
      await expect.poll(() => page.locator('main h2.page').count(), { message: path }).toBe(1)
      await expect.poll(() => page.locator('main .loading').count(), { message: path }).toBe(0)
      // Chips: each a symbol of its own shape and a word.
      const chips = await page.locator('main .chip').evaluateAll((list) => list.map((c) => [c.querySelector('.glyph')?.textContent ?? '', (c.textContent ?? '').slice(1).trim()]))
      for (const [glyph, word] of chips) {
        expect(GLYPHS, path).toContain(glyph)
        expect(word, path).not.toBe('')
      }
      // Relative times: the exact time on hover (title) and on focus (tabindex, data-exact).
      const times = await page.locator('main time.rel').evaluateAll((list) => list.map((t) => [t.getAttribute('datetime'), t.getAttribute('title'), t.getAttribute('data-exact'), t.getAttribute('tabindex')]))
      for (const [datetime, title, exact, tabindex] of times) {
        expect(datetime, path).toBeTruthy()
        expect(title, path).toBeTruthy()
        expect(exact, path).toBe(title)
        expect(tabindex, path).toBe('0')
      }
      // Folds: closed by default.
      expect(await page.locator('main details.fold[open]').count(), path).toBe(0)
      // An id is never the first thing in a row.
      for (const first of await page.locator('main table tbody tr > td:first-child').allInnerTexts()) expect(first, path).not.toMatch(/^(run_|apr-|sha256:|pch-)/)
    }
    expect(await page.locator('main details.fold').count()).toBeGreaterThan(0)
    // A relative time shows its exact time when focused by keyboard.
    await page.goto(`${origin}/ui/?run=run_abc`)
    const time = page.locator('main time.rel:visible').first()
    await expect.poll(() => time.count()).toBe(1)
    await time.focus()
    const after = await time.evaluate((t) => getComputedStyle(t, '::after').content)
    expect(after.includes((await time.getAttribute('data-exact'))!) || after.includes('attr(data-exact)')).toBe(true)
    // The count with its unit.
    await page.goto(`${origin}/ui/`)
    const queue = page.getByRole('region', { name: 'Approval queue' })
    await expect.poll(() => queue.locator('.qty').first().innerText()).toBe('3 approvals')
    expect(await queue.locator('.qty .n').first().innerText()).toBe('3')
    // The copy button: the id behind it, copied on a press (or shown, selected, where no clipboard is).
    const copy = page.getByRole('region', { name: 'Runs needing attention' }).getByRole('button', { name: 'Copy run ID' })
    expect(await copy.getAttribute('data-copy')).toBe('run_abc')
    await copy.click()
    await expect.poll(async () => (await page.locator('code.copied').count()) > 0 || (await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))) === 'run_abc').toBe(true)
    if (await page.locator('code.copied').count()) expect(await page.locator('code.copied').innerText()).toBe('run_abc')
  }, 90_000)

  it.runIf(canRunBrowser)('shows a skeleton while a page first loads, still under reduced motion, and puts the keyboard on Skip to content first (T170)', async () => {
    const { origin, token, approvals } = await boot({ approvals: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    let release!: () => void
    approvals().held = new Promise((resolve) => { release = resolve })
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const loading = page.locator('main .loading')
    await expect.poll(() => loading.count()).toBe(1)
    expect(await loading.innerText()).toBe('Loading…')
    expect(await page.locator('main').getAttribute('aria-busy')).toBe('true')
    expect(await loading.evaluate((l) => getComputedStyle(l).animationName)).toBe('pulse')
    // Reduced motion: the skeleton stays, still.
    const still = await (await browser.newContext({ reducedMotion: 'reduce' })).newPage()
    await still.goto(`${origin}/ui/#token=${token}`)
    await expect.poll(() => still.locator('main .loading').count()).toBe(1)
    expect(await still.locator('main .loading').evaluate((l) => getComputedStyle(l).animationName)).toBe('none')
    release()
    approvals().held = undefined
    await expect.poll(() => page.getByRole('heading', { name: 'Home', exact: true }).count()).toBe(1)
    expect(await page.locator('main').getAttribute('aria-busy')).toBeNull()
    expect(await loading.count()).toBe(0)
    // The first Tab reaches Skip to content, shown while focused; the next, the navigation.
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Skip to content')
    expect((await page.getByRole('link', { name: 'Skip to content' }).boundingBox())!.x).toBeGreaterThanOrEqual(0)
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('home')
    // A focused control shows its focus.
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid')
  }, 60_000)

  it.runIf(canRunBrowser)('says the data is stale, and when it was read, when a refresh fails over a page already shown, and clears it once a refresh succeeds; a page that never loaded says so with Try again (T170)', async () => {
    const { origin, token, workflow } = await boot()
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?run=run_abc#token=${token}`)
    await expect.poll(() => page.locator('h2.page[data-page="run:run_abc"]').count()).toBe(1)
    await expect.poll(() => page.locator('#status').innerText()).toMatch(/^updated \d+ s ago$/)
    const stale = page.locator('#stale')
    expect(await stale.isVisible()).toBe(false)
    workflow.gone = true
    await expect.poll(() => stale.isVisible(), { timeout: 15_000 }).toBe(true)
    expect(await stale.innerText()).toMatch(/^Stale: the last refresh failed \(unknown run run_abc\)\. Showing what was read at .+; trying again every 5 s\.$/)
    // What was read stays on the page, and the header says the refresh failed.
    expect(await page.locator('h2.page[data-page="run:run_abc"]').count()).toBe(1)
    expect(await page.locator('#status').innerText()).toContain('could not refresh: unknown run run_abc')
    workflow.gone = false
    await expect.poll(() => stale.isVisible(), { timeout: 15_000 }).toBe(false)
    await expect.poll(() => page.locator('#status').innerText()).toMatch(/^updated \d+ s ago$/)
    // A page that never loaded: its error and one next action.
    await page.goto(`${origin}/ui/?run=run_nope`)
    const failed = page.locator('main .error-state')
    await expect.poll(() => failed.count()).toBe(1)
    expect(await failed.innerText()).toContain('This page could not be loaded: unknown run run_nope.')
    expect(await failed.getByRole('button', { name: 'Try again' }).count()).toBe(1)
    expect(await stale.isVisible()).toBe(false)
  }, 60_000)
})
