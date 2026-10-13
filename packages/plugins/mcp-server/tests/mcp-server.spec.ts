import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import { z as zod } from 'zod'
import McpEndpoint from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

type Tokens = Record<'operator' | 'client' | 'model', string>

async function boot(): Promise<{ url: string; token: string; tokens: Tokens; dir: string; ctx: Context }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-mcp-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(Store, { path: join(dir, 'system.db') }),
    ctx.plugin(Artifacts, {}),
    ctx.plugin(McpEndpoint, { tokenDir: dir, discoveryFile: join(dir, 'mcp.json') }),
  ]
  await Promise.all(fibers)
  cleanups.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  const discovery = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFiles: Tokens }
  const tokens = Object.fromEntries(Object.entries(discovery.tokenFiles).map(([scope, file]) => [scope, readFileSync(file).toString('base64url')])) as Tokens
  return { url: discovery.url, token: tokens.operator, tokens, dir, ctx }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
  cleanups.push(() => client.close())
  return client
}

describe('system MCP server on ctx.webServer', () => {
  it('serves tools contributed by plugins, for the contributing plugin\'s lifetime only (REQ-GW-3, INV-10)', async () => {
    const { url, token, ctx } = await boot()
    const fiber = ctx.inject(['mcp'], (c) => {
      c.mcp.tool('echo', { description: 'Echo back', inputSchema: { text: zod.string() } }, async ({ text }) => ({ content: [{ type: 'text' as const, text: String(text) }] }))
    })
    await fiber
    const client = await connect(url, token)
    expect((await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).content).toEqual([{ type: 'text', text: 'hi' }])
    await fiber.dispose()
    const after = await connect(url, token)
    expect((await after.listTools()).tools.map((t) => t.name)).not.toContain('echo')
    expect(() => ctx.mcp.tool('status', { description: 'x', inputSchema: {} }, async () => ({ content: [] }))).toThrow(/already/)
  })

  it('writes a 0600 discovery file and serves the slice 1 tool surface', async () => {
    const { url, token, dir } = await boot()
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600)
    const client = await connect(url, token)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['ask', 'events', 'research', 'result', 'status'])
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ harness: 'system', store: 'ok', artifacts: 0, kernel: ['store', 'artifacts'] })
    // No milestone baked into the code: status reports what is mounted, not a roadmap stage.
    expect(status.structuredContent).not.toHaveProperty('stage')
  })

  it('reports health in status: every check for both scopes, what to do only for the operator (REQ-HOST-6, ADR-0023)', async () => {
    const { url, tokens } = await boot()
    type Health = { state: string; checks: Array<{ name: string; state: string; detail: string }> }
    const health = async (token: string) => ((await (await connect(url, token)).callTool({ name: 'status', arguments: {} })).structuredContent as { health: Health }).health
    const operator = await health(tokens.operator)
    const client = await health(tokens.client)
    expect(operator.checks.map((c) => c.name)).toEqual(['runtime', 'store', 'disk'])
    expect(operator.checks.find((c) => c.name === 'store')).toMatchObject({ state: 'ok' })
    expect(client.state).toBe(operator.state)
    // A client sees which checks are ok, never versions, paths, sizes, or names.
    expect(client.checks).toEqual(operator.checks.map(({ name, state }) => ({ name, state })))
  })

  it('reads the event log for the operator only, in order, a page at a time (QA-7, ADR-0023)', async () => {
    const { url, tokens, ctx } = await boot()
    const fiber = ctx.plugin(EventLog, {})
    await fiber
    cleanups.push(() => fiber.dispose())
    for (const type of ['a.one', 'b.two', 'a.three']) ctx.eventLog.append({ type, runId: 'r1' })
    const operator = await connect(url, tokens.operator)
    const read = async (args: Record<string, unknown>) => (await operator.callTool({ name: 'events', arguments: args })).structuredContent as { events: Array<{ seq: number; type: string }>; next: number }
    const first = await read({ runId: 'r1', limit: 2 })
    expect(first.events.map((e) => e.type)).toEqual(['a.one', 'b.two'])
    expect((await read({ runId: 'r1', afterSeq: first.next })).events.map((e) => e.type)).toEqual(['a.three'])
    expect((await read({ type: 'a.three' })).events).toHaveLength(1)
    const client = await connect(url, tokens.client)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('events')
  })

  it('answers liveness at /healthz with no token and no data', async () => {
    const { url } = await boot()
    const live = await fetch(new URL('/healthz', url))
    expect([live.status, await live.text()]).toEqual([200, 'ok'])
  })

  it('reports ask as not installed rather than pretending to work', async () => {
    const { url, token } = await boot()
    const client = await connect(url, token)
    const result = await client.callTool({ name: 'ask', arguments: { prompt: 'hello' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/workflow engine is not mounted/)
  })

  it('rejects a missing token, a browser origin, and a foreign Host header (QA-5)', async () => {
    const { url, token } = await boot()
    const init = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }
    expect((await fetch(url, init)).status).toBe(401)
    expect((await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status).toBe(403)
    const port = new URL(url).port
    const response = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `evil.example:${port}`, authorization: `Bearer ${token}` } }, (res) => resolve(res.statusCode ?? 0))
        req.on('error', reject)
        req.end('{}')
      }, reject)
    })
    expect(response).toBe(421)
  })

  it('removes the discovery file when the plugin unloads', async () => {
    const { dir } = await boot()
    while (cleanups.length > 1) await cleanups.pop()!()
    expect(() => statSync(join(dir, 'mcp.json'))).toThrow()
  })
})

/** Scoped control credentials (ADR-0023): what each token holder may see and call over /mcp. */
describe('scoped tokens', () => {
  const callBody = (name: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
  const post = (url: string, token: string, body: string) => fetch(url, {
    method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
  })

  it('refuses a client token calling the operator\'s events tool (QA-14, QA-7)', async () => {
    const { url, tokens } = await boot()
    const refused = await post(url, tokens.client, callBody('events'))
    expect(refused.status).toBe(403)
    expect(refused.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  it('shows a client only the client tools; the operator sees every tool; a tool that declares no scope is operator-only (QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    ctx.mcp.tool('op_only', { description: 'operator action', inputSchema: {} }, async () => ({ content: [{ type: 'text' as const, text: 'done' }] }))
    ctx.mcp.tool('cl_tool', { description: 'client tool', inputSchema: {}, scope: 'client' }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    const client = await connect(url, tokens.client)
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['ask', 'cl_tool', 'research', 'result', 'status'])
    const operator = await connect(url, tokens.operator)
    const listed = (await operator.listTools()).tools
    expect(listed.map((t) => t.name).sort()).toEqual(['ask', 'cl_tool', 'events', 'op_only', 'research', 'result', 'status'])
    // The reference page shows each tool's scope from the listing.
    expect(listed.find((t) => t.name === 'op_only')?._meta).toMatchObject({ 'system/scope': 'operator' })
    expect(listed.find((t) => t.name === 'cl_tool')?._meta).toMatchObject({ 'system/scope': 'client' })
    expect((await operator.callTool({ name: 'op_only', arguments: {} })).content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('refuses a client calling an operator tool with 403 insufficient_scope, in a batch too (QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    ctx.mcp.tool('op_only', { description: 'operator action', inputSchema: {} }, async () => ({ content: [] }))
    const refused = await post(url, tokens.client, callBody('op_only'))
    expect(refused.status).toBe(403)
    expect(refused.headers.get('www-authenticate')).toMatch(/error="insufficient_scope".*scope="operator"/)
    expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' })
    expect((await post(url, tokens.client, `[${callBody('status')},${callBody('op_only')}]`)).status).toBe(403)
    expect((await post(url, tokens.operator, callBody('op_only'))).status).toBe(200)
  })

  it('tells a tool handler the caller\'s scope, so what it records names who acted (QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    ctx.mcp.tool('whoami', { description: 'scope', inputSchema: {}, scope: 'client' }, async (_args, { scope }) => ({ content: [{ type: 'text' as const, text: scope }] }))
    for (const scope of ['client', 'operator'] as const) {
      const client = await connect(url, tokens[scope])
      expect((await client.callTool({ name: 'whoami', arguments: {} })).content).toEqual([{ type: 'text', text: scope }])
    }
  })

  it('accepts no model token on /mcp: a model holder reaches only the model gateways (QA-14)', async () => {
    const { url, tokens } = await boot()
    expect((await post(url, tokens.model, callBody('status'))).status).toBe(401)
  })

  it('keeps one distinct owner-only file per scope and names them in the discovery file', async () => {
    const { dir, tokens } = await boot()
    expect(new Set(Object.values(tokens)).size).toBe(3)
    for (const scope of ['operator', 'client', 'model']) expect(statSync(join(dir, `${scope}.token`)).mode & 0o777).toBe(0o600)
    expect(() => statSync(join(dir, 'mcp.token'))).toThrow()
  })
})

describe('discovery file ownership (PR #3 security review)', () => {
  it("does not delete another instance's discovery file on unload", async () => {
    const { dir } = await boot()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:1/mcp', tokenFile: 'x', pid: process.pid + 1 }))
    while (cleanups.length > 1) await cleanups.pop()!()
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).pid).toBe(process.pid + 1)
  })
})

const { mcpToolsConformance } = await import('../../../gateway-core/conformance/mcp-tools.ts')
let endpoint: { url: string; tokens: Tokens } | undefined
mcpToolsConformance('mcp-server', async () => {
  const booted = await boot()
  endpoint = { url: booted.url, tokens: booted.tokens }
  return { ctx: booted.ctx, dispose: async () => { while (cleanups.length) await cleanups.pop()!() } }
}, async (_ctx, scope) => {
  // What a real MCP client holding that scope's token sees over the authenticated endpoint.
  const client = await connect(endpoint!.url, endpoint!.tokens[scope])
  return (await client.listTools()).tools.map((tool) => tool.name)
})
