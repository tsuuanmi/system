// Composition e2e for the api-first preset (ADR-0025): `system init --preset api-first`, booted
// through the real dsh launcher from built lib/, with a model route to a local fake
// OpenAI-compatible server and the model catalog in the operator's own patch.
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
import { type FakeOpenAi, fakeOpenAi } from '../../plugins/models/tests/fake-openai.ts'

const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'system-e2e-api-first-'))
const env = { ...process.env, DSH_HOME: home }
const KEY = 'SYSTEM_E2E_MODEL_KEY'
let child: ChildProcess | undefined
let server: FakeOpenAi
let initOutput = ''

/** The rows the api-first composition mounts: no display, browser, website driver, login, account, turn, or gateway row. */
const API_FIRST_ROWS = ['timer', 'credentials', 'webserver', 'store', 'event-log', 'leases', 'artifacts', 'egress', 'workers', 'agent-runtimes', 'runtime-claude-agent-sdk', 'runtime-codex-sdk', 'runtime-acp', 'agent-workers', 'llm', 'llm-pi-ai', 'models', 'worker-sessions', 'workflow', 'profile-software-development', 'profile-scientific-research', 'web-ui', 'mcp-server']

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await sleep(200)
  }
}

beforeAll(async () => {
  server = await fakeOpenAi()
  initOutput = execFileSync(process.execPath, [bin, 'init', '--preset', 'api-first'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  writeFileSync(join(home, 'port0.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
  // The operator's own patch: one route (keyed by reference, never by value) and one catalog entry.
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      local-fake:', '        api: openai-completions', `        baseURL: ${server.baseURL}`, `        apiKeyEnv: ${KEY}`, '        models:', '          - id: m1',
    '- id: models', '  config:', '    models:', '      - id: fast', '        route: local-fake', '        model: m1', '        tier: standard',
    // A one-step template needing a website-only capability, to show its refusal.
    '- id: workflow', '  config:', '    templates:', '      deep-only:', '        - nodeId: research:1', '          objective: Deep research', "          prompt: '{{input}}'",
    '          capabilities: [reason, deep-research]', '          tier: frontier', '          conversation: persistent', '          acceptance: acceptance.answer', '',
  ].join('\n'))
}, 180_000)

afterAll(async () => {
  if (child?.pid !== undefined && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // the group already exited
    }
  }
  await server?.close()
  rmSync(home, { recursive: true, force: true })
})

describe('the api-first preset (e2e through dsh, ADR-0025)', () => {
  it('init writes the preset as its own layer and skips the Chrome and Xvfb checks', () => {
    expect(initOutput).toMatch(/browser: not mounted in this composition; Chrome and Xvfb are not needed/)
    expect(initOutput).not.toMatch(/chrome:|xvfb:/)
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'system', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle', '@tsuuanmi/system-preset-api-first'])
  })

  it('mounts exactly the api-first rows: no website, login, account, turn, or gateway row, no dsh-base, no telemetry', () => {
    const dump = execFileSync(process.execPath, [bin, 'start', '--dump-config'], { env, encoding: 'utf8' })
    const mounted = dump.split(/^(?=- id: )/m).filter((block) => block.startsWith('- id: ') && !/^ {2}disabled: true$/m.test(block)).map((block) => /^- id: (\S+)/.exec(block)![1])
    expect(mounted).toEqual(API_FIRST_ROWS)
    expect(dump).not.toMatch(/dsh-base|otel/)
  }, 60_000)

  it('boots, answers through an API model Worker once its key is in the vault, and refuses website-only work with the reason (REQ-WRK-10)', async () => {
    child = spawn(process.execPath, [bin, 'start', '--patch', join(home, 'port0.yml')], { env, stdio: 'pipe', detached: true })
    const discoveryPath = join(home, 'system', 'mcp.json')
    await waitFor(discoveryPath, 60_000)
    const { url, tokenFiles } = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { url: string; tokenFiles: Record<'operator' | 'client' | 'model', string> }
    const token = readFileSync(tokenFiles.operator).toString('base64url')
    const connect = async (): Promise<Client> => {
      const client = new Client({ name: 'e2e-api-first', version: '0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
      return client
    }
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const client = await connect()
      return (await client.callTool({ name, arguments: args }).finally(() => client.close())).structuredContent
    }
    const lister = await connect()
    const tools = (await lister.listTools().finally(() => lister.close())).tools.map((t) => t.name)
    expect(tools).toContain('model_key')
    expect(tools.filter((t) => t.startsWith('account_'))).toEqual([])
    expect(await call('status', {})).toMatchObject({ harness: 'system', store: 'ok', providers: [] })

    // No key stored yet: the call fails closed, for the operator to act on, and nothing is sent.
    expect(await call('ask', { prompt: 'hi', waitSeconds: 20 })).toMatchObject({ status: 'failed', error: { kind: 'reauth_required', disposition: 'USER_ACTION' } })
    expect(server.requests).toEqual([])

    // The operator stores the key from stdin; it reaches the route through the vault.
    execFileSync(process.execPath, [bin, 'model', 'key', KEY], { env, input: 'sk-e2e-0123456789\n', encoding: 'utf8' })
    expect(await call('ask', { prompt: 'hi', waitSeconds: 30 })).toMatchObject({ status: 'completed', answer: 'echo: hi', nodes: [{ worker: 'model:fast', quotaClass: 'metered' }] })
    expect(server.requests.at(-1)).toMatchObject({ authorization: 'Bearer sk-e2e-0123456789', body: { model: 'm1', max_completion_tokens: 4096 } })
    expect(readFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), 'utf8')).not.toContain('sk-e2e')

    const research = await call('run', { template: 'deep-only', input: 'Does caffeine improve recall?', waitSeconds: 20 }) as { status: string; nodes: Array<{ nodeId: string; error?: { message: string } }> }
    expect(research.status).toBe('failed')
    expect(research.nodes[0]!.error!.message).toMatch(/^no Worker can take this work: no Worker proves deep-research/)

    const origin = new URL(url).origin
    for (const gateway of ['/anthropic/v1/models', '/openai/v1/models']) {
      expect((await fetch(`${origin}${gateway}`, { headers: { authorization: `Bearer ${readFileSync(tokenFiles.model).toString('base64url')}` } })).status).toBe(404)
    }

    const exited = new Promise((resolve) => child?.on('exit', resolve))
    child.kill('SIGTERM')
    await exited
    expect(existsSync(discoveryPath)).toBe(false)
  }, 120_000)
})
