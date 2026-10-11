import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import * as mcpServer from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(): Promise<{ url: string; token: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-mcp-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(Store, { path: join(dir, 'system.db') }),
    ctx.plugin(Artifacts, {}),
    ctx.plugin(mcpServer, { tokenFile: join(dir, 'mcp.token'), discoveryFile: join(dir, 'mcp.json') }),
  ]
  await Promise.all(fibers)
  cleanups.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  const discovery = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFile: string }
  return { url: discovery.url, token: readFileSync(discovery.tokenFile).toString('base64url'), dir }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
  cleanups.push(() => client.close())
  return client
}

describe('system MCP server on ctx.webServer', () => {
  it('writes a 0600 discovery file and serves the slice 1 tool surface', async () => {
    const { url, token, dir } = await boot()
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600)
    const client = await connect(url, token)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['ask', 'research', 'result', 'status'])
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ harness: 'system', stage: 'M0', store: 'ok', artifacts: 0 })
  })

  it('reports ask as not installed rather than pretending to work', async () => {
    const { url, token } = await boot()
    const client = await connect(url, token)
    const result = await client.callTool({ name: 'ask', arguments: { prompt: 'hello' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/M1\.5/)
  })

  it('rejects a missing token, a browser origin, and a foreign Host header', async () => {
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
