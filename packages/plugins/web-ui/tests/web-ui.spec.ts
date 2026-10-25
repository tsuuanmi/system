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
  get(id: string) { return id === RUN.runId ? RUN : id === CARRIED.runId ? CARRIED : undefined }
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
    new SchemaRegistry().assertDef('mcp-roster@1.6', 'roster-output', roster)
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
    await page.getByRole('link', { name: 'Workers' }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Workers', exact: true }).count()).toBe(1)
    expect(new URL(page.url()).search).toBe('?view=workers')
    // The operator's words: free, and resting until a clock time.
    expect(await page.getByLabel('Worker counts').innerText()).toBe('1 working · 0 free · 1 resting (the first until 11:00) · 0 unavailable')
    // The account once, its roles in its header, its rest said once for both.
    const account = page.getByRole('region', { name: 'Account Chatgpt · Studio Plus' })
    expect(await account.getByRole('heading', { level: 3 }).innerText()).toMatch(/^Chatgpt · Studio Plus: frontier, standard\b/)
    expect(await account.innerText()).toContain('Its account is resting until 11:00 (in 2 h)')
    const busy = account.getByRole('article', { name: 'Chatgpt · Studio Plus · standard' })
    expect(await busy.getByRole('heading', { level: 4 }).innerText()).toBe('standard')
    const shown = await busy.innerText()
    for (const said of ['The studio\'s chat subscription for quick questions (standard tier)', 'Working: 1 of 2 slot(s) in use; it still takes work',
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

  it.runIf(canRunBrowser)('shows each window of an account\'s pool as "5 h: used X % — resets HH:MM (read HH:MM)" with a small bar, at its limit first, and what its reading does not give as unknown, with why (ADR-0059, T116)', async () => {
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
    expect(await line('five-hour').innerText()).toBe('5 h: used 42 % — resets 09:45 (read 09:29)')
    expect(await line('seven-day').innerText()).toBe('7 d: at its limit, used unknown (its latest reading gives no used share) — resets 10:30 (read 09:29)')
    expect(await line('credit').innerText()).toBe('credit: no reading yet')
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
    await page.getByRole('link', { name: 'Workers' }).click()
    await expect.poll(() => page.getByRole('article', { name: 'agent:acc-a/develop' }).count()).toBe(1)
    // No reading yet, with why its account's usage report could not be read, its time on the clock (T111).
    const agent = page.getByRole('region', { name: 'Account Claude · slot 1' }).getByLabel('window five-hour of plan/agent')
    expect(await agent.innerText()).toBe('5 h: no reading yet: its account\'s usage report could not be read at 09:20: the runtime gave no answer within 30 s')
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
    const waiting = page.getByRole('region', { name: 'Waiting for you', exact: true })
    await expect.poll(() => waiting.innerText()).toContain('3 requests wait for your verdict')
    expect(await waiting.innerText()).toContain('1 run needs a look')
    // Each one by name under its count, linked to where it is decided (T141).
    expect(await waiting.innerText()).toMatch(/Allow a merge step: merge apr-1 · expires /)
    expect(await waiting.innerText()).toContain('an investigate run · its plan waits for your approval')
    await waiting.getByRole('link', { name: 'Allow a deploy step: merge apr-3' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('request-apr-3')
    expect(await page.getByRole('region', { name: 'Workers at a glance' }).innerText()).toContain('1 working · 0 free · 1 resting · 0 unavailable')
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
    for (const [link, purpose] of [['Board', 'Every project and its open tasks'], ['Workers', 'Every account and its Workers: what each is for'], ['Autonomy policy', 'Which actions run on their own']] as const) {
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

  it.runIf(canRunBrowser)('says on a run\'s page what happened to it in plain words: it started from the previous attempt\'s work, a team member\'s answer was sent again once, and its result was merged (ADR-0060, ADR-0061, ADR-0062, T141)', async () => {
    const { origin, token } = await boot()
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/?run=run_carried#token=${token}`)
    const happened = page.getByRole('region', { name: 'What happened' })
    await expect.poll(() => happened.count()).toBe(1)
    const said = await happened.innerText()
    expect(said).toContain('It started from the work attempt 1 left (its run): that change was already in its worktree, saved as cccccccccccc, so its writing step built on it instead of starting over.')
    expect(said).toContain('Team member 1\'s answer: the site answered with its own error instead of an answer, so it was sent again once, in a new conversation on the same Worker.')
    expect(said).toContain('Accepted and merged into main as eeeeeeeeeeee · not pushed')
    expect(await happened.getByRole('link', { name: 'its run' }).getAttribute('href')).toBe('?run=run_first')
    // Each new word has its "?" (T126), and the step reads by member, its id beside.
    for (const word of ['started from earlier work', 'sent again']) expect(await happened.getByRole('button', { name: `What is ${word}?` }).count(), word).toBe(1)
    const steps = page.locator('ol.timeline > li')
    expect(await steps.nth(1).innerText()).toMatch(/^team member 1's answer \(review:m1:propose\) done/)
    // The earlier attempt's error on a step that went on is history: said, never as the step's failure.
    expect(await steps.nth(1).innerText()).toContain('An earlier attempt failed: the site was busy, or answered with its own error — scripted overloaded')
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
    await expect.poll(() => card.innerText()).toContain('Kept out of teams by you: it is never a team member; it takes every other step.')
    expect(await card.getByRole('button', { name: 'What is team?' }).count()).toBe(1)
    await card.getByText('details', { exact: true }).click()
    expect(await card.innerText()).toContain('Kept out of teams by the operator: its account is named in teams.excludeWorkers')
    // Right now, by name: who is free, who is stalled, and which account has no quota left (T141).
    const now = page.getByRole('region', { name: 'Right now' })
    expect(await now.innerText()).toContain('Free: none.')
    expect(await now.innerText()).toContain('Stalled: none.')
    expect(await now.innerText()).toContain('No quota left: Chatgpt · Studio Plus until 11:00 (in 2 h)')
    // An engine that cannot tell: no line on the card, the unknown under its details (INV-2).
    workflow.excluded = new Error('the router is busy')
    await page.reload()
    await expect.poll(() => card.count()).toBe(1)
    expect(await card.innerText()).not.toContain('Kept out of teams')
    await card.getByText('details', { exact: true }).click()
    expect(await card.innerText()).toContain('Teams\nunknown (it could not be read: the router is busy)')
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
