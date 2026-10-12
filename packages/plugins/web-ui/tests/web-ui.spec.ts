import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { chromium } from 'patchright-core'
import { afterEach, describe, expect, it } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import * as WebUi from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const RUN = {
  runId: 'run_abc', template: 'investigate', status: 'running', specHash: 'sha256:00', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:01Z',
  nodes: [{ nodeId: 'plan:1', state: 'COMPLETED', minTier: 'standard', attempt: 1, worker: 'worker:a/standard', tier: 'standard', quotaClass: 'subscription-chat' },
    { nodeId: 'plan:1:gate', state: 'BLOCKED', minTier: 'economy', attempt: 0 }],
  blocked: { nodeId: 'plan:1:gate', plan: 'sha256:11' },
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
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-ui-'))
  const tokenFile = join(dir, 'mcp.token')
  writeFileSync(tokenFile, Buffer.alloc(32, 7), { mode: 0o600 })
  const token = Buffer.alloc(32, 7).toString('base64url')
  const ctx = new Context()
  const fibers = [ctx.plugin(StubWorkflow), ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUi, { tokenFile })]
  await Promise.all(fibers)
  cleanups.push(async () => { for (const f of [...fibers].reverse()) await f.dispose() }, () => rmSync(dir, { recursive: true, force: true }))
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  return { ctx, origin, token, workflow: (ctx as unknown as { workflow: StubWorkflow }).workflow }
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
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    await ctx.plugin(StubWorkflow)
    await ctx.plugin(LanWebServer)
    try {
      await ctx.plugin(WebUi, { tokenFile: join(dir, 'mcp.token') })
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
    expect((await post('approve', { verdict: 'maybe' })).status).toBe(400)
    expect((await post('stop', {}, 'text/plain')).status).toBe(415)
    expect((await post('delete', {})).status).toBe(404)
    expect(workflow.calls).toEqual([['approve', 'run_abc', { verdict: 'approved', note: 'ok', plan: 'sha256:11' }], ['stop', 'run_abc', 'enough'], ['continue', 'run_abc', undefined]])
  })

  it.runIf(canRunBrowser)('renders runs, steps, and decisions in a real browser, and approves a waiting plan', async () => {
    const { origin, token, workflow } = await boot()
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    cleanups.push(() => browser.close())
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
