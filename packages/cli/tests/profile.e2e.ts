// Composition e2e (docs/engineering/testing.md): the shipped system profile, booted through
// the real dsh launcher from built lib/, with only the external port overridden.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
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

// The default composition: the Claude Code agent rows are on (PROP-0010 B3); the Codex, ACP,
// Antigravity CLI, software-development, and model gateway rows are off (PROP-0004).
// The rows the default composition has but turns off, and the DSH rows, whose packages ship no plugin manifest.
const OFF_ROWS = ['runtime-codex-sdk', 'runtime-acp', 'runtime-antigravity-cli', 'profile-software-development', 'gateway-anthropic', 'gateway-responses']
const DSH_PACKAGES = ['@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai']

type Plugin = { name: string; rows: string[]; mounted: boolean; manifest: string; lifecycle?: { state: string; since: string; decision: string } }
/** The plugins the first boot recorded, which a restart over an unchanged composition must leave as they are. */
let firstBoot: Plugin[] = []

const ALLOWED_ROWS = ['timer', 'credentials', 'webserver', 'store', 'event-log', 'leases', 'artifacts', 'plugin-host', 'resources', 'approvals', 'accounts', 'turn-receipts', 'display', 'browser', 'providers', 'provider-chatgpt-web', 'provider-gemini-web', 'login', 'egress', 'workers', 'turns', 'agent-runtimes', 'runtime-claude-agent-sdk', 'agent-workers', 'llm', 'llm-pi-ai', 'models', 'worker-sessions', 'workflow', 'board', 'digest', 'report', 'profile-scientific-research', 'web-ui', 'mcp-server']

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
  it('mounts exactly the allow-listed rows (Claude Code agent rows on; Codex, ACP, and gateway rows off) and no dsh-base', () => {
    const dump = execFileSync(process.execPath, [bin, 'start', '--dump-config'], { env, encoding: 'utf8' })
    const mounted = dump.split(/^(?=- id: )/m).filter((block) => block.startsWith('- id: ') && !/^ {2}disabled: true$/m.test(block)).map((block) => /^- id: (\S+)/.exec(block)![1])
    expect(mounted).toEqual(ALLOWED_ROWS)
    expect(dump).not.toMatch(/dsh-base|otel/)
  }, 60_000)

  it('turns an off row back on from an operator patch (off, not deleted)', () => {
    const patch = join(home, 'rows-on.yml')
    writeFileSync(patch, '- id: gateway-anthropic\n  disabled: false\n- id: runtime-codex-sdk\n  disabled: false\n')
    const dump = execFileSync(process.execPath, [bin, 'start', '--patch', patch, '--dump-config'], { env, encoding: 'utf8' })
    const mounted = dump.split(/^(?=- id: )/m).filter((block) => block.startsWith('- id: ') && !/^ {2}disabled: true$/m.test(block)).map((block) => /^- id: (\S+)/.exec(block)![1])
    expect(mounted).toEqual(expect.arrayContaining(['gateway-anthropic', 'runtime-codex-sdk']))
    expect(mounted).not.toContain('gateway-responses')
    expect(mounted).not.toContain('runtime-acp')
  }, 60_000)

  it('checks the profile against this code before a start: a removed team procedure and a bad config value are named, with exit 1', () => {
    const patchFile = join(home, 'profiles', 'system', 'cordis.patch.yml')
    const original = readFileSync(patchFile, 'utf8')
    const run = () => spawnSync(process.execPath, [bin, 'check'], { env, encoding: 'utf8' })
    try {
      expect(run()).toMatchObject({ status: 0, stdout: expect.stringMatching(/^ok: \d+ row\(s\) of the profile pass this code's checks/) })
      writeFileSync(patchFile, [
        '- id: workflow',
        '  config:',
        '    templates:',
        '      panel-led:',
        '        - { nodeId: panel, objective: o, prompt: "{{input}}", capabilities: [reason], tier: standard, conversation: temporary, acceptance: acceptance.answer, team: { members: 2, rounds: 2 } }',
        '- id: mcp-server',
        '  config:',
        '    minFreeBytes: lots',
        '',
      ].join('\n'))
      const failed = run()
      expect(failed.status).toBe(1)
      expect(failed.stderr).toMatch(/row workflow \(@tsuuanmi\/system-workflow\): template panel-led: node panel: team must be \{kind: brainstorm \| review/)
      expect(failed.stderr).toMatch(/row mcp-server \(@tsuuanmi\/system-mcp-server\): .*minFreeBytes/)
      expect(failed.stderr).toMatch(/2 problem\(s\): fix the profile patch before starting this code/)
    } finally {
      writeFileSync(patchFile, original)
    }
  })

  it('boots, serves MCP to an authenticated client, authorizes every surface by scope (QA-14), and cleans up on SIGTERM', async () => {
    child = spawn(process.execPath, [bin, 'start', '--patch', join(home, 'port0.yml')], { env, stdio: 'pipe', detached: true })
    const discoveryPath = join(home, 'system', 'mcp.json')
    await waitFor(discoveryPath, 60_000)
    const { url, tokenFiles } = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { url: string; tokenFiles: Record<'operator' | 'client' | 'model', string> }

    const client = new Client({ name: 'e2e', version: '0' })
    const token = readFileSync(tokenFiles.operator).toString('base64url')
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ harness: 'system', store: 'ok', kernel: ['store', 'eventLog', 'leases', 'artifacts', 'credentials'], providers: ['chatgpt-web', 'gemini-web'] })
    // The plugin host read every row from the loader and each package's manifest, and recorded each
    // plugin's lifecycle as a decision: a row on is default, a row off candidate (REQ-HOST-7, INV-13).
    const { plugins, artifacts, health } = status.structuredContent as { plugins: Plugin[]; artifacts: number; health: { checks: Array<{ name: string; state: string; detail: string }> } }
    expect(plugins.filter((p) => p.mounted).flatMap((p) => p.rows)).toEqual(ALLOWED_ROWS)
    expect(plugins.filter((p) => !p.mounted).flatMap((p) => p.rows)).toEqual(OFF_ROWS)
    const ours = plugins.filter((p) => !DSH_PACKAGES.includes(p.name))
    expect(plugins.filter((p) => DSH_PACKAGES.includes(p.name)).map((p) => [p.name, p.manifest, p.lifecycle])).toEqual(DSH_PACKAGES.map((name) => [name, 'absent', undefined]))
    for (const p of ours) expect([p.name, p.manifest, p.lifecycle?.state]).toEqual([p.name, 'valid', p.mounted ? 'default' : 'candidate'])
    expect(artifacts).toBe(ours.length)
    expect(health.checks.find((c) => c.name === 'manifests')).toMatchObject({ state: 'ok', detail: expect.stringContaining('4 have none') })
    firstBoot = plugins
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
    expect(clientTools).toEqual([
      'approvals_get', 'approvals_list', 'approvals_policy', 'ask',
      'board_brief', 'board_cancel', 'board_charter', 'board_claim', 'board_projects', 'board_propose', 'board_task', 'board_tasks', 'board_update',
      'brainstorm', 'digests_get', 'digests_request', 'explain', 'report', 'research', 'resources_pools', 'resources_usage', 'result', 'review', 'run', 'session_inbox', 'session_send', 'status', 'usage', 'vote',
    ])
    // Digests are on (B6): a request names stored artifacts only, and one that names none is refused with nothing done.
    const digester = await client2(url, tokenOf('client'))
    const refusedDigest = await digester.callTool({ name: 'digests_request', arguments: { sources: [`sha256:${'0'.repeat(64)}`] } }).finally(() => digester.close())
    expect(refusedDigest).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^invalid: .* is not a stored artifact/) }] })
    // The resource ledger is core and on: with no pool configured it lists none (B2).
    const ledger = await client2(url, tokenOf('client'))
    const pools = await ledger.callTool({ name: 'resources_pools', arguments: {} })
    const usage = await ledger.callTool({ name: 'resources_usage', arguments: {} }).finally(() => ledger.close())
    expect([pools.structuredContent, usage.structuredContent]).toEqual([{ pools: [] }, { records: [], totals: [] }])
    // The approval queue is core and on, with the bundle's default studio policy; the board asks through it (B5).
    const queue = await client2(url, tokenOf('client'))
    const policy = await queue.callTool({ name: 'approvals_policy', arguments: {} })
    const queued = await queue.callTool({ name: 'approvals_list', arguments: {} }).finally(() => queue.close())
    expect(policy.structuredContent).toMatchObject({ policies: [{ id: 'studio-default', scope: 'studio' }], effective: expect.arrayContaining([{ actionClass: 'read', mode: 'auto' }, { actionClass: 'deploy', mode: 'ask' }]), set: { source: 'configuration', projects: [] } })
    expect(queued.structuredContent).toEqual({ requests: [] })
    // The baseline report is on (B8): over the board, the queue, and the ledger, with nothing recorded it counts nothing.
    const reporter = await client2(url, tokenOf('client'))
    const week = await reporter.callTool({ name: 'report', arguments: {} }).finally(() => reporter.close())
    expect(week.structuredContent).toMatchObject({ projects: [], approvals: { asked: 0 }, usage: { total: { records: 0 } }, baseline: { acceptedResults: 0 } })
    expect((week.content as Array<{ text: string }>)[0]!.text).toMatch(/^# Report: every project\n/)
    expect(await toolsOf('operator')).toEqual(expect.arrayContaining([...clientTools, 'approve', 'approvals_decide', 'approvals_policy_propose', 'board_pause', 'board_resume', 'board_close', 'stop', 'delete', 'drain', 'account_set_credentials', 'account_relogin', 'account_code', 'model_key']))
    const origin = new URL(url).origin
    const send = (path: string, scope: 'operator' | 'client' | 'model', body?: object) => fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { authorization: `Bearer ${tokenOf(scope)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    })
    const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
    for (const tool of ['approve', 'approvals_decide', 'approvals_policy_propose', 'board_pause', 'board_resume', 'board_close', 'account_set_credentials', 'model_key']) expect((await send('/mcp', 'client', call(tool))).status).toBe(403)
    expect((await send('/mcp', 'model', call('status'))).status).toBe(401)
    // The model gateways are off in this composition (PROP-0004): no route answers, whatever the token.
    for (const gateway of ['/anthropic/v1/models', '/openai/v1/models']) expect((await send(gateway, 'model')).status).toBe(404)
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

  it('boots with a Claude Code Worker configured on a host without Claude Code: the Worker is unavailable, and the profile serves as before (PROP-0010 B3)', async () => {
    const patch = join(home, 'claude-missing.yml')
    writeFileSync(patch, [
      readFileSync(join(home, 'port0.yml'), 'utf8').trimEnd(),
      '- id: runtime-claude-agent-sdk', '  config:', `    executable: ${join(home, 'no-claude', 'claude')}`,
      '- id: agent-workers', '  config:', '    workers:', `      - { id: reviewer, runtime: claude-agent-sdk, workspace: ${home}, sandbox: read-only, tier: standard }`, '',
    ].join('\n'))
    child = spawn(process.execPath, [bin, 'start', '--patch', patch], { env, stdio: 'pipe', detached: true })
    const discoveryPath = join(home, 'system', 'mcp.json')
    await waitFor(discoveryPath, 60_000)
    const { url, tokenFiles } = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { url: string; tokenFiles: Record<'operator', string> }
    const client = await client2(url, readFileSync(tokenFiles.operator).toString('base64url'))
    const status = await client.callTool({ name: 'status', arguments: {} }).finally(() => client.close())
    expect(status.structuredContent).toMatchObject({ harness: 'system', store: 'ok' })
    const { checks } = (status.structuredContent as { health: { checks: Array<{ name: string; detail?: string }> } }).health
    expect(checks.find((check) => check.name === 'workers')?.detail).toContain('agent:reviewer (unavailable)')
    expect(checks.find((check) => check.name === 'plugins')).toMatchObject({ state: 'ok' })
    // The same rows on and off as at the first boot: the plugin host records nothing again (REQ-HOST-7).
    expect((status.structuredContent as { plugins: Plugin[] }).plugins).toEqual(firstBoot)
    const exited = new Promise((resolve) => child?.on('exit', resolve))
    child.kill('SIGTERM')
    await exited
    expect(existsSync(discoveryPath)).toBe(false)
  }, 120_000)

  it('records a row the operator turns on as one lifecycle decision, chained to the one before it, and changes no other plugin\'s record (REQ-HOST-7, INV-13)', async () => {
    expect(firstBoot.length).toBeGreaterThan(0)
    const patch = join(home, 'gateway-on.yml')
    writeFileSync(patch, `${readFileSync(join(home, 'port0.yml'), 'utf8').trimEnd()}\n- id: gateway-anthropic\n  disabled: false\n`)
    child = spawn(process.execPath, [bin, 'start', '--patch', patch], { env, stdio: 'pipe', detached: true })
    const discoveryPath = join(home, 'system', 'mcp.json')
    await waitFor(discoveryPath, 60_000)
    const { url, tokenFiles } = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { url: string; tokenFiles: Record<'operator', string> }
    const client = await client2(url, readFileSync(tokenFiles.operator).toString('base64url'))
    try {
      const { plugins } = (await client.callTool({ name: 'status', arguments: {} })).structuredContent as { plugins: Plugin[] }
      const before = firstBoot.find((p) => p.rows.includes('gateway-anthropic'))!
      const after = plugins.find((p) => p.rows.includes('gateway-anthropic'))!
      expect([before.lifecycle?.state, after.mounted, after.lifecycle?.state]).toEqual(['candidate', true, 'default'])
      expect(plugins.filter((p) => p !== after)).toEqual(firstBoot.filter((p) => p.name !== after.name))
      const read = await client.callTool({ name: 'artifact', arguments: { id: after.lifecycle!.decision } })
      const decision = JSON.parse((read.structuredContent as { text: string }).text) as { schema: string; decisionType: string; inputs: string[]; outcome: { option: string; detail: { from: string } } }
      expect(decision).toMatchObject({ schema: 'decision@1.5', decisionType: 'lifecycle', inputs: [before.lifecycle!.decision], outcome: { option: 'default', detail: { from: 'candidate' } } })
    } finally {
      await client.close()
      const exited = new Promise((resolve) => child?.on('exit', resolve))
      child.kill('SIGTERM')
      await exited
    }
  }, 120_000)
})
