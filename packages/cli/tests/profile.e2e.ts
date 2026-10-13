// Composition e2e (docs/engineering/testing.md): the shipped system profile, booted through
// the real dsh launcher from built lib/, with only the external port overridden.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'system-e2e-'))
const env = { ...process.env, DSH_HOME: home }
let child: ChildProcess | undefined

const ALLOWED_ROWS = ['timer', 'credentials', 'webserver', 'store', 'event-log', 'leases', 'artifacts', 'accounts', 'turn-receipts', 'display', 'browser', 'providers', 'provider-chatgpt-web', 'provider-gemini-web', 'login', 'egress', 'workers', 'turns', 'agent-runtimes', 'runtime-claude-agent-sdk', 'runtime-codex-sdk', 'runtime-acp', 'agent-workers', 'worker-sessions', 'workflow', 'profile-software-development', 'profile-scientific-research', 'gateway-anthropic', 'gateway-responses', 'web-ui', 'mcp-server']

async function client2(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-2', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
  return client
}

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await sleep(200)
  }
}

beforeAll(() => {
  execFileSync(process.execPath, [bin, 'init'], { env, stdio: 'pipe' })
  writeFileSync(join(home, 'port0.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
}, 180_000)

afterAll(async () => {
  // Kill the whole process group: SIGKILL on the wrapper alone orphans the dsh child,
  // which kept running (with its MCP port) after earlier failed runs.
  if (child?.pid !== undefined && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // the group already exited
    }
  }
  rmSync(home, { recursive: true, force: true })
})

describe('system profile (e2e through dsh)', () => {
  it('mounts exactly the allow-listed rows and no dsh-base', () => {
    const dump = execFileSync(process.execPath, [bin, 'start', '--dump-config'], { env, encoding: 'utf8' })
    const rows = [...dump.matchAll(/^- id: (\S+)/gm)].map((m) => m[1])
    expect(rows).toEqual(ALLOWED_ROWS)
    expect(dump).not.toMatch(/dsh-base|otel/)
  }, 60_000)

  it('boots, serves MCP to an authenticated client, authorizes every surface by scope (QA-14), and cleans up on SIGTERM', async () => {
    child = spawn(process.execPath, [bin, 'start', '--patch', join(home, 'port0.yml')], { env, stdio: 'pipe', detached: true })
    const discoveryPath = join(home, 'system', 'mcp.json')
    await waitFor(discoveryPath, 60_000)
    const { url, tokenFiles } = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { url: string; tokenFiles: Record<'operator' | 'client' | 'model', string> }

    const client = new Client({ name: 'e2e', version: '0' })
    const token = readFileSync(tokenFiles.operator).toString('base64url')
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ harness: 'system', store: 'ok', artifacts: 0, kernel: ['store', 'eventLog', 'leases', 'artifacts', 'credentials'], providers: ['chatgpt-web', 'gemini-web'] })
    await client.close()

    const listed = execFileSync(process.execPath, [bin, 'account', 'list'], { env, encoding: 'utf8' })
    expect(JSON.parse(listed)).toEqual([])
    // The runtime replaced the ask placeholder: with no saved account it fails closed, honestly.
    const second = await client2(url, token)
    const asked = await second.callTool({ name: 'ask', arguments: { prompt: 'hi', waitSeconds: 10 } }).finally(() => second.close())
    expect(asked.structuredContent).toMatchObject({ status: 'failed', error: { kind: 'reauth_required', disposition: 'USER_ACTION' } })

    // Every surface of the shipped composition authorizes by scope (ADR-0023, QA-14).
    const tokenOf = (scope: 'operator' | 'client' | 'model'): string => readFileSync(tokenFiles[scope]).toString('base64url')
    const toolsOf = async (scope: 'operator' | 'client'): Promise<string[]> => {
      const scoped = await client2(url, tokenOf(scope))
      return (await scoped.listTools().finally(() => scoped.close())).tools.map((t) => t.name).sort()
    }
    const clientTools = await toolsOf('client')
    expect(clientTools).toEqual(['ask', 'explain', 'research', 'result', 'run', 'session_inbox', 'session_send', 'status', 'usage'])
    expect(await toolsOf('operator')).toEqual(expect.arrayContaining([...clientTools, 'approve', 'stop', 'delete', 'drain', 'account_set_credentials', 'account_relogin', 'account_code']))
    const origin = new URL(url).origin
    const send = (path: string, scope: 'operator' | 'client' | 'model', body?: object) => fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { authorization: `Bearer ${tokenOf(scope)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    })
    const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
    for (const tool of ['approve', 'account_set_credentials']) expect((await send('/mcp', 'client', call(tool))).status).toBe(403)
    expect((await send('/mcp', 'model', call('status'))).status).toBe(401)
    for (const gateway of ['/anthropic/v1/models', '/openai/v1/models']) {
      expect((await send(gateway, 'model')).status).toBe(200)
      expect((await send(gateway, 'client')).status).toBe(401)
      expect((await send(gateway, 'operator')).status).toBe(401)
    }
    expect((await send('/ui/api/runs', 'operator')).status).toBe(200)
    expect((await send('/ui/api/runs', 'client')).status).toBe(401)
    expect(existsSync(join(home, 'system', 'mcp.token'))).toBe(false)

    expect(existsSync(join(home, 'system', 'system.db'))).toBe(true)
    expect(existsSync(join(home, 'system', 'vault.key'))).toBe(true)
    expect(existsSync(join(home, 'system', 'blobs'))).toBe(false)

    const exited = new Promise((resolve) => child?.on('exit', resolve))
    child.kill('SIGTERM')
    await exited
    expect(existsSync(discoveryPath)).toBe(false)
  }, 120_000)
})
