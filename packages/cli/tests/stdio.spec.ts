import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import McpEndpoint from '@tsuuanmi/system-mcp-server'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('system mcp-stdio (a stdio shim for MCP clients without header helpers, e.g. Codex)', () => {
  it('forwards tools and calls to the running profile, authenticating with the client scope\'s 0600 token file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'system-stdio-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(Store, { path: join(home, 'system', 'system.db') }),
      ctx.plugin(McpEndpoint, { tokenDir: join(home, 'system'), discoveryFile: join(home, 'system', 'mcp.json') }),
    ]
    await Promise.all(fibers)
    cleanups.push(async () => { for (const f of fibers.reverse()) await f.dispose() })
    // An operator action the shim's client must not see (ADR-0023).
    ;(ctx as unknown as { mcp: { tool: (...args: unknown[]) => void } }).mcp.tool('op_only', { description: 'x', inputSchema: {} }, async () => ({ content: [] }))

    const bin = new URL('../src/bin.ts', import.meta.url).pathname
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', bin, 'mcp-stdio'], env: { ...process.env, DSH_HOME: home } as Record<string, string> })
    const client = new Client({ name: 'codex-like', version: '0' })
    await client.connect(transport)
    cleanups.push(() => client.close())
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['ask', 'research', 'result', 'status']))
    expect(tools.map((t) => t.name)).not.toContain('op_only')
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ harness: 'system', store: 'ok' })
    expect(readFileSync(join(home, 'system', 'mcp.json'), 'utf8')).not.toContain(readFileSync(join(home, 'system', 'client.token')).toString('base64url'))
  }, 60_000)
})
