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
import * as WebUi from '../src/index.ts'

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
  usage() { return [RUN] }
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
  constructor(ctx: Context) {
    super(ctx, 'approvals')
  }
  async list() { return QUEUE }
  async get(id: string) { return QUEUE.find((r) => r.requestId === id) }
  async decide(verdicts: Verdict[], at: Date): Promise<VerdictResult[]> {
    this.calls.push([verdicts, at])
    return verdicts.map((v) => v.requestId === 'apr-3' ? { requestId: v.requestId, state: 'open', refused: 'subject-changed' } : { requestId: v.requestId, state: v.verdict, approval: `sha256:${'a'.repeat(64)}` })
  }
}

async function boot(options: { approvals?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-ui-'))
  // The UI takes the operator scope's token only (ADR-0023).
  writeFileSync(join(dir, 'operator.token'), Buffer.alloc(32, 7), { mode: 0o600 })
  writeFileSync(join(dir, 'client.token'), Buffer.alloc(32, 8), { mode: 0o600 })
  const token = Buffer.alloc(32, 7).toString('base64url')
  const ctx = new Context()
  const fibers = [ctx.plugin(StubWorkflow), ...(options.approvals ? [ctx.plugin(StubApprovals)] : []), ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUi, { tokenDir: dir })]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  return { ctx, origin, token, workflow: (ctx as unknown as { workflow: StubWorkflow }).workflow, approvals: () => (ctx as unknown as { approvals: StubApprovals }).approvals }
}

describe('web UI: the operator\'s view, loopback and token-gated', () => {
  it('registers nothing on a plain-HTTP bind beyond loopback: the token would travel in clear text (QA-5)', async () => {
    const routes: unknown[] = []
    class LanWebServer extends Service {
      protocol = 'http:'
      host = '192.0.2.10'
      port = 47317
      constructor(ctx: Context) { super(ctx, 'webServer') }
      register(route: unknown): () => void { routes.push(route); return () => undefined }
    }
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

  it.runIf(canRunBrowser)('shows the approval queue in a real browser and approves a batch on the subjects it shows', async () => {
    const { origin, token, approvals } = await boot({ approvals: true })
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    const queue = page.getByRole('region', { name: 'Approval queue' })
    await expect.poll(() => queue.getByText('Batch batch-1').count()).toBe(1)
    for (const text of ['merge apr-1', 'the branch lands on main', 'deploy', 'content board-task:apr-1:attempt:0 @ approval-needed', 'Not yet batched']) {
      expect(await queue.getByText(text, { exact: true }).count(), text).toBeGreaterThan(0)
    }
    expect(await page.locator('main').innerText()).not.toContain('null')
    await queue.getByRole('textbox', { name: 'Note for batch-1' }).fill('ship it')
    await queue.getByRole('button', { name: 'Approve batch' }).click()
    await expect.poll(() => approvals().calls.length).toBe(1)
    expect(approvals().calls[0]![0]).toEqual([
      { requestId: 'apr-1', subject: QUEUE[0]!.subject, verdict: 'approved', note: 'ship it' },
      { requestId: 'apr-2', subject: QUEUE[1]!.subject, verdict: 'approved', note: 'ship it' },
    ])
    await queue.getByRole('button', { name: 'Deny apr-3' }).click()
    await expect.poll(() => approvals().calls.length).toBe(2)
    expect(approvals().calls[1]![0]).toEqual([{ requestId: 'apr-3', subject: QUEUE[2]!.subject, verdict: 'rejected' }])
    await expect.poll(() => page.locator('#status').innerText()).toContain('refused: apr-3 (subject-changed)')
  }, 60_000)

  it.runIf(canRunBrowser)('renders runs, steps, and decisions in a real browser, and approves a waiting plan', async () => {
    const { origin, token, workflow } = await boot()
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${token}`)
    await page.getByRole('link', { name: 'run_abc' }).click()
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
