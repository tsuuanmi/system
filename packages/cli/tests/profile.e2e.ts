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

const ALLOWED_ROWS = ['timer', 'credentials', 'webserver', 'store', 'blobs', 'event-log', 'leases', 'artifacts', 'accounts', 'turn-receipts', 'display', 'browser', 'providers', 'provider-chatgpt-web', 'login', 'egress', 'workers', 'turns', 'agent-runtimes', 'runtime-claude-agent-sdk', 'runtime-acp', 'agent-workers', 'workflow', 'mcp-server']

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

  it('boots, serves MCP to an authenticated client, and cleans up on SIGTERM', async () => {
    child = spawn(process.execPath, [bin, 'start', '--patch', join(home, 'port0.yml')], { env, stdio: 'pipe', detached: true })
    const discoveryPath = join(home, 'system', 'mcp.json')
    await waitFor(discoveryPath, 60_000)
    const { url, tokenFile } = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { url: string; tokenFile: string }

    const client = new Client({ name: 'e2e', version: '0' })
    const token = readFileSync(tokenFile).toString('base64url')
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ harness: 'system', store: 'ok', artifacts: 0, kernel: ['store', 'blobs', 'eventLog', 'leases', 'artifacts', 'credentials'], providers: ['chatgpt-web'] })
    await client.close()

    const listed = execFileSync(process.execPath, [bin, 'account', 'list'], { env, encoding: 'utf8' })
    expect(JSON.parse(listed)).toEqual([])
    // The runtime replaced the ask placeholder: with no saved account it fails closed, honestly.
    const second = await client2(url, token)
    const asked = await second.callTool({ name: 'ask', arguments: { prompt: 'hi', waitSeconds: 10 } }).finally(() => second.close())
    expect(asked.structuredContent).toMatchObject({ status: 'failed', error: { kind: 'reauth_required', disposition: 'USER_ACTION' } })

    expect(existsSync(join(home, 'system', 'system.db'))).toBe(true)
    expect(existsSync(join(home, 'system', 'vault.key'))).toBe(true)
    expect(existsSync(join(home, 'system', 'blobs'))).toBe(true)

    const exited = new Promise((resolve) => child?.on('exit', resolve))
    child.kill('SIGTERM')
    await exited
    expect(existsSync(discoveryPath)).toBe(false)
  }, 120_000)
})
