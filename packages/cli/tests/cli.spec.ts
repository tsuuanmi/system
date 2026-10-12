import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_LOCK } from '@tsuuanmi/system-browser-patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callTool, claudeGatewayCommand, codexGatewayCommand, drainHost, ensureBrowser, exitCode, formatExplanation, formatUsage, mcpConfig, mcpHeaders, mergeProfileManifest, parseAsk, uiUrl } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('system CLI (PR #3 kernel review)', () => {
  it('merges the bundle into an existing profile manifest without dropping operator plugins', () => {
    const merged = mergeProfileManifest({
      name: 'dsh-profile-system', dependencies: { 'operator-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['@tsuuanmi/system-bundle', 'operator-plugin'] } },
    }, '/opt/bundle')
    expect(merged.dependencies).toEqual({ 'operator-plugin': '^1.0.0', '@tsuuanmi/system-bundle': 'link:/opt/bundle' })
    expect(merged.dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle', 'operator-plugin'])
    expect(mergeProfileManifest(undefined, '/b').dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle'])
  })

  it('maps a signal death to 128 + signal number', () => {
    expect(exitCode(null, 'SIGTERM')).toBe(143)
    expect(exitCode(null, 'SIGINT')).toBe(130)
    expect(exitCode(3, null)).toBe(3)
  })

  it('never prints the bearer token inside the client configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    mkdirSync(join(home, 'system'))
    writeFileSync(join(home, 'system', 'mcp.token'), Buffer.alloc(32, 9))
    writeFileSync(join(home, 'system', 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:47317/mcp', tokenFile: join(home, 'system', 'mcp.token') }))
    const token = Buffer.alloc(32, 9).toString('base64url')
    for (const client of ['claude', 'codex'] as const) expect(mcpConfig(client, home)).not.toContain(token)
    expect(mcpConfig('codex', home)).toMatch(/\[mcp_servers\.system\][\s\S]*mcp-stdio/)
    expect(mcpConfig('claude', home)).toContain('headersHelper')
    expect(readFileSync(join(home, 'system', 'mcp.json'), 'utf8')).toContain('47317')
  })
})

describe('system init: browser prerequisites', () => {
  const chrome = { path: '/usr/bin/google-chrome', source: 'system' as const }

  it('keeps a usable Chrome and does not download one', async () => {
    const install = vi.fn()
    const report = await ensureBrowser({ discover: () => chrome, install, hasXvfb: () => true, vnc: () => '/usr/bin/x0vncserver' })
    expect(install).not.toHaveBeenCalled()
    expect(report).toEqual(['chrome: /usr/bin/google-chrome (system)', 'xvfb: ok', 'vnc (remote login): /usr/bin/x0vncserver'])
  })

  it('installs the pinned managed Chrome when none is usable, and flags a missing Xvfb', async () => {
    const install = vi.fn(async () => ({ path: '/home/u/.dsh/system/browsers/chrome', installed: true }))
    const report = await ensureBrowser({ discover: () => undefined, install, hasXvfb: () => false, vnc: () => undefined })
    expect(install).toHaveBeenCalledOnce()
    expect(report[0]).toBe(`chrome: installed managed Chrome ${CHROME_LOCK.buildId} at /home/u/.dsh/system/browsers/chrome`)
    expect(report[1]).toMatch(/xvfb: missing .*apt install xvfb/)
    expect(report[2]).toMatch(/vnc \(remote login\): missing .*tigervnc-scraping-server/)
  })
})

describe('system account (an MCP client of the running profile)', () => {
  it('explains that the profile must be running when there is no discovery file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    await expect(callTool('account_list', {}, home)).rejects.toThrow(/system start/)
  })
})

describe('system ask arguments', () => {
  it('reads the prompt from stdin with -, so it stays out of the process list and shell history', async () => {
    expect(await parseAsk(['--persist', '-'], async () => 'secret prompt\n')).toEqual({ prompt: 'secret prompt', persist: true })
    expect(await parseAsk(['--session', 'ses_1', 'hello', 'world'], async () => '')).toEqual({ prompt: 'hello world', sessionId: 'ses_1' })
    expect(await parseAsk(['--tier', 'frontier', 'q'], async () => '')).toEqual({ prompt: 'q', tier: 'frontier' })
    expect(await parseAsk([], async () => '')).toBeUndefined()
  })
})

describe('system usage and explain output', () => {
  it('shows, per request and step, the Worker, tier, and quota class that served it', () => {
    const lines = formatUsage({
      runs: [{
        runId: 'run_1', template: 'research', status: 'completed', createdAt: '2026-10-12T01:02:03.000Z',
        nodes: [
          { nodeId: 'research:1', state: 'COMPLETED', minTier: 'frontier', tier: 'frontier', worker: 'worker:chatgpt-main/frontier', quotaClass: 'subscription-chat' },
          { nodeId: 'compact:1', state: 'WAITING', minTier: 'economy' },
        ],
      }],
    })
    expect(lines).toEqual([
      'run_1  research  completed  2026-10-12T01:02:03.000Z',
      '  research:1  COMPLETED  frontier  subscription-chat  worker:chatgpt-main/frontier',
      '  compact:1  WAITING  -  -  -',
    ])
  })

  it('prints a run\'s decision chain, step by step', () => {
    const lines = formatExplanation({
      runId: 'run_1', template: 'ask', status: 'completed', specHash: 'sha256:ab',
      nodes: [{ nodeId: 'ask:1', state: 'COMPLETED', worker: 'worker:a/standard', quotaClass: 'subscription-chat', turnId: 'turn_1', decisions: [
        { id: 'sha256:01', type: 'egress', outcome: 'allow', reasons: ['public content is permitted'] },
        { id: 'sha256:02', type: 'route', outcome: 'worker:a/standard', reasons: ['proves reason', 'quota class subscription-chat'] },
      ] }],
    })
    expect(lines).toEqual([
      'run_1  ask  completed  spec sha256:ab',
      '  ask:1  COMPLETED  worker:a/standard  subscription-chat  turn_1',
      '    egress  allow  public content is permitted  (sha256:01)',
      '    route  worker:a/standard  proves reason; quota class subscription-chat  (sha256:02)',
    ])
  })
})

describe('Claude Code connection (headersHelper)', () => {
  it('prints the bearer header for headersHelper, and a config that never contains the token', () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    mkdirSync(join(home, 'system'))
    writeFileSync(join(home, 'system', 'mcp.token'), Buffer.alloc(32, 7))
    writeFileSync(join(home, 'system', 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:47317/mcp', tokenFile: join(home, 'system', 'mcp.token') }))
    const token = Buffer.alloc(32, 7).toString('base64url')
    expect(JSON.parse(mcpHeaders(home))).toEqual({ Authorization: `Bearer ${token}` })
    const claude = mcpConfig('claude', home)
    expect(claude).toContain('headersHelper')
    expect(claude).toContain('mcp-headers')
    expect(claude).not.toContain(token)
    // The web UI link carries the token in its fragment only.
    expect(uiUrl(home)).toBe(`http://127.0.0.1:47317/ui/#token=${token}`)
    // The gateway command never carries the token: Claude Code's apiKeyHelper reads it.
    const gateway = claudeGatewayCommand(home)
    expect(gateway).toMatch(/^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:47317\/anthropic claude --settings '\{"apiKeyHelper":".* mcp-token"\}'$/)
    expect(gateway).not.toContain(token)
    const codex = codexGatewayCommand(home)
    expect(codex).toMatch(/^SYSTEM_MCP_TOKEN="\$\(.* mcp-token\)" codex -c model_provider=system -c 'model_providers\.system=\{name="system",base_url="http:\/\/127\.0\.0\.1:47317\/openai\/v1",env_key="SYSTEM_MCP_TOKEN",wire_api="responses",request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=900000\}' -m system-standard$/)
    expect(codex).not.toContain(token)
  })
})

describe('drain (REQ-HOST-1)', () => {
  const polls = (answers: string[][]) => {
    const calls: string[] = []
    const call = async (name: string) => {
      calls.push(name)
      return { isError: false, text: '', structured: { draining: true, active: answers.shift() ?? [] } }
    }
    return { calls, call: call as never }
  }

  it('polls until nothing is executing', async () => {
    const { calls, call } = polls([['run_a'], ['run_a'], []])
    expect(await drainHost(10_000, { call, pollMs: 1 })).toEqual({ drained: true, active: [] })
    expect(calls).toEqual(['drain', 'drain', 'drain'])
  })

  it('reports what is still running at the deadline', async () => {
    const { call } = polls([['run_a'], ['run_a'], ['run_a'], ['run_a']])
    expect(await drainHost(0, { call, pollMs: 1 })).toEqual({ drained: false, active: ['run_a'] })
  })
})

