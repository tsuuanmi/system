import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentRuntimeProviderConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { type Confinement, meteringOf, type ToolCall, type ToolGate } from '@tsuuanmi/system-agent-runtime-core'
import { childTimeZone, CodexRuntime, FEATURES_OFF, limitFromMessage, VERIFIED_LIMIT_VERSIONS } from '../src/index.ts'
import { hookOverrides } from '../src/gate.ts'
import { type ProbeBehaviour, type Step, probeExec, scripted } from './fake-codex.ts'

const HOOK = fileURLToPath(new URL('../src/gate-hook.ts', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'cx-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const runDir = join(root, 'run')
const workspace = mkdtempSync(join(root, 'w-'))

const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confinement = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: '/usr/bin/bwrap', hide: ['/dsh'], readOnly: ['/dsh/system/tools', ...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}
const confined = {
  confine: confinement, prove: async () => ({ confined: true, detail: 'host state hidden by /usr/bin/bwrap' }), nested: async () => undefined, status: async () => undefined,
  launcher: (c: { command: string; args: string[] }) => `launcher:${[c.command, ...c.args].join(' ')}`,
}
const runtime = (s = scripted(), extra: Partial<ConstructorParameters<typeof CodexRuntime>[0]> = {}) =>
  new CodexRuntime({ executable: '/usr/bin/codex', home: '/codex-home', runDir, hook: HOOK, client: s.client, version: async () => '0.164.0', mcpServers: async () => [], exec: probeExec(), ...confined, ...extra })

agentRuntimeProviderConformance('codex-sdk', () => runtime())

const turn = (...steps: Step[]): Step[] => [{ type: 'thread.started', thread_id: 'h-1' }, { type: 'turn.started' }, ...steps, {
  type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
}]
const answer = (text: string): Step => ({ type: 'item.completed', item: { id: 'msg', type: 'agent_message', text } })
const command = (id: string, cmd: string): Step => ({ call: { tool: 'Bash', input: { command: cmd } }, item: { id, type: 'command_execution', command: cmd, aggregated_output: '', status: 'completed' } })

describe('codex-sdk runtime (REQ-WRK-5, REQ-WRK-6)', () => {
  it('probes the installed codex: both sandboxes, resumable, able to run confined commands, and gating every tool call', async () => {
    expect(await runtime().probe()).toMatchObject({
      available: true, sandboxes: ['read-only', 'workspace-write'], resume: true, executes: true, readsConfined: true, gatesToolCalls: true,
      detail: 'Codex 0.164.0; host state hidden by /usr/bin/bwrap; tool calls gated: a PreToolUse hook answered before each tool call, its deny held, and no terminal session started',
    })
    expect(await new CodexRuntime({ findExecutable: () => undefined }).probe()).toMatchObject({ available: false, sandboxes: [] })
  })

  it('holds a run to the configured policy: its sandbox and workspace, no approvals, no network, no web search, the tool-adding features off', async () => {
    const s = scripted()
    await runtime(s, { config: { model_provider: 'system', model_providers: { system: { base_url: 'http://127.0.0.1:47317/openai/v1', env_key: 'SYSTEM_MCP_TOKEN' } } }, env: { SYSTEM_MCP_TOKEN: 't' } })
      .run({ prompt: 'fix it', workspace: '/w', sandbox: 'workspace-write', model: 'system-standard' }, new AbortController().signal)
    expect(s.calls[0]).toMatchObject({ prompt: 'fix it', options: { workingDirectory: '/w', sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', model: 'system-standard' } })
    // The operator's configuration first, as dotted overrides, then what the runtime pins.
    expect(s.lastClient.config).toBeUndefined()
    expect(s.lastClient.overrides).toEqual([
      'model_provider="system"', 'model_providers.system.base_url="http://127.0.0.1:47317/openai/v1"', 'model_providers.system.env_key="SYSTEM_MCP_TOKEN"',
      ...FEATURES_OFF.map((f) => `features.${f}=false`), 'features.hooks=true', 'shell_environment_policy.exclude=["SYSTEM_CODEX_GATE_SOCKET", "SYSTEM_CODEX_GATE_KEY"]',
    ])
    expect(s.lastClient.env).toMatchObject({ SYSTEM_MCP_TOKEN: 't', PATH: process.env.PATH })
  })

  it('refuses a configuration it cannot hold exactly: MCP servers, hooks of its own, a feature it keeps off, hooks off', async () => {
    for (const [config, why] of [
      [{ mcp_servers: { x: { command: 'y' } } }, /mcp_servers/], [{ hooks: { PreToolUse: [] } }, /hooks/], [{ features: { apps: true } }, /features\.apps/],
      [{ features: { hooks: false } }, /features\.hooks/], [{ shell_environment_policy: { exclude: 'X' } }, /exclude/], [{ 'bad key': 1 }, /bare TOML key/],
    ] as const) {
      expect(() => new CodexRuntime({ config: config as Record<string, unknown> }), JSON.stringify(config)).toThrow(why)
    }
    // The operator's own exclusions are kept, the gate's added.
    const s = scripted()
    await runtime(s, { config: { shell_environment_policy: { inherit: 'core', exclude: ['AWS_*'] } } }).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)
    expect(s.lastClient.overrides).toEqual(expect.arrayContaining(['shell_environment_policy.inherit="core"', 'shell_environment_policy.exclude=["AWS_*", "SYSTEM_CODEX_GATE_SOCKET", "SYSTEM_CODEX_GATE_KEY"]']))
  })

  it('starts codex without the daemon\'s credentials; a credential reaches it only when forwarded by name (INV-8)', async () => {
    Object.assign(process.env, { SYSTEM_MCP_TOKEN: 'daemon-token', OPENAI_API_KEY: 'daemon-key' })
    try {
      const plain = scripted()
      await runtime(plain).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)
      expect(plain.lastClient.env).toMatchObject({ PATH: process.env.PATH })
      expect(plain.lastClient.env).not.toHaveProperty('SYSTEM_MCP_TOKEN')
      expect(plain.lastClient.env).not.toHaveProperty('OPENAI_API_KEY')
      const forwarded = scripted()
      await runtime(forwarded, { forwardEnv: ['SYSTEM_MCP_TOKEN'] }).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)
      expect(forwarded.lastClient.env).toMatchObject({ SYSTEM_MCP_TOKEN: 'daemon-token' })
      expect(forwarded.lastClient.env).not.toHaveProperty('OPENAI_API_KEY')
    } finally {
      delete process.env.SYSTEM_MCP_TOKEN
      delete process.env.OPENAI_API_KEY
    }
  })

  it('runs Codex in its own home, never the operator\'s (whose MCP servers would reach the Worker)', async () => {
    const s = scripted()
    await runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)
    expect(s.lastClient.env).toMatchObject({ CODEX_HOME: '/codex-home' })
    expect(() => new CodexRuntime({ home: 'relative' })).toThrow(/absolute/)
  })

  it('starts Codex through bubblewrap with the host state and the terminal devices hidden, and only its own home writable (ADR-0024)', async () => {
    const s = scripted()
    await runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)
    // Paths that do not exist on this host are skipped; no session gets a terminal, none reaches the operator's.
    expect(s.lastClient.program).toMatch(/^launcher:\/usr\/bin\/bwrap --die-with-parent --unshare-pid --new-session --dev-bind \/ \/ --proc \/proc .*-- \/usr\/bin\/codex$/)
    if (existsSync('/dev/ptmx')) expect(s.lastClient.program).toContain('--ro-bind /dev/null /dev/ptmx')
    if (existsSync('/dev/pts')) expect(s.lastClient.program).toContain('--tmpfs /dev/pts')
    // Its home is bound back writable; a read-only Worker's workspace read-only.
    expect(binds.at(-1)).toEqual({ writable: ['/codex-home'], readOnly: ['/w'] })
    await runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'workspace-write' }, new AbortController().signal)
    expect(binds.at(-1)).toEqual({ writable: ['/codex-home', '/w'], readOnly: [] })
  })

  it('offers no Worker, and runs nothing, when reads cannot be confined (ADR-0024, REQ-WRK-6)', async () => {
    const failed = runtime(scripted(), { prove: async () => ({ confined: false, detail: 'reads cannot be confined: bwrap missing' }) })
    expect(await failed.probe()).toMatchObject({ readsConfined: false, gatesToolCalls: false, detail: expect.stringContaining('reads cannot be confined') })
    // A host policy can let bubblewrap run, yet refuse Codex's own sandbox inside it.
    const nested = runtime(scripted(), { nested: async () => { throw new Error('bwrap: setting up uid map: Permission denied') } })
    expect(await nested.probe()).toMatchObject({ readsConfined: false, detail: expect.stringContaining('Codex\'s own sandbox does not start inside the confinement') })
    const s = scripted()
    const none = runtime(s, { confine: undefined })
    expect(await none.probe()).toMatchObject({ readsConfined: false, gatesToolCalls: false, detail: expect.stringContaining('no read confinement') })
    await expect(none.run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    expect(s.calls).toEqual([])
  })

  it('offers no Worker that is not signed in inside its own home, unless a model provider is configured or an API key forwarded', async () => {
    const signedOut = { status: async () => { throw new Error('Not logged in') } }
    expect(await runtime(scripted(), signedOut).probe()).toMatchObject({
      available: false, detail: expect.stringContaining('not signed in inside its home /codex-home (codex login status: Not logged in): sign in there (CODEX_HOME=/codex-home codex login)'),
    })
    expect(await runtime(scripted(), { ...signedOut, config: { model_provider: 'system' } }).probe()).toMatchObject({ available: true, gatesToolCalls: true })
    expect(await runtime(scripted(), { ...signedOut, forwardEnv: ['CODEX_API_KEY'] }).probe()).toMatchObject({ available: true })
  })

  it('fails closed when its Codex home has an MCP server: the Worker would reach tools outside its sandbox', async () => {
    const homes: string[] = []
    const withServer = (s = scripted()) => runtime(s, { mcpServers: async (home) => (homes.push(home), ['system']) })
    expect(await withServer().probe()).toMatchObject({ available: false, detail: expect.stringMatching(/MCP server.*system/) })
    const s = scripted()
    await expect(withServer(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    expect(s.calls).toEqual([])
    expect(homes).toEqual(['/codex-home', '/codex-home'])
  })

  it('refuses what Codex cannot express exactly: a tool allow-list or a turn limit, before running', async () => {
    const s = scripted()
    await expect(runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only', tools: ['Read'] }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    await expect(runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only', maxTurns: 3 }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    expect(s.calls).toEqual([])
  })

  it('resumes a thread by its native handle, and classifies a failed turn', async () => {
    const s = scripted()
    expect(await runtime(s).run({ prompt: 'again', workspace: '/w', sandbox: 'read-only', resume: 'thread-9' }, new AbortController().signal)).toMatchObject({ text: 'echo: again', nativeHandle: 'h-1' })
    expect(s.calls[0]).toMatchObject({ resume: 'thread-9' })
    const failing = scripted(() => [{ type: 'thread.started', thread_id: 'h-2' }, { type: 'turn.failed', error: { message: 'You have hit your usage limit' } }])
    await expect(runtime(failing).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'quota_exhausted' })
    const broken = scripted(() => [{ type: 'error', message: 'stream disconnected' }])
    await expect(runtime(broken).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'session_broken' })
  })
})

describe('codex-sdk: the run\'s tool gate is a PreToolUse hook on every tool (docs/design/agent-runtimes.md#tool-gate)', () => {
  const gated = (gate: ToolGate) => ({ prompt: 'go', workspace, sandbox: 'workspace-write' as const, toolGate: gate })

  it('installs one hook on every tool, trusted by the hash of its definition, and no hook without a gate', async () => {
    const s = scripted()
    await runtime(s).run(gated(async () => ({ decision: 'allow' })), new AbortController().signal)
    const hooks = s.lastClient.overrides!.filter((o) => o.startsWith('hooks.'))
    const command = `'${process.execPath}' '${HOOK}'`
    // Codex 0.164 trusts a hook by sha256 of its definition's sorted-key JSON (checked live): any other hash and it never runs.
    const definition = `{"event_name":"pre_tool_use","hooks":[{"async":false,"command":${JSON.stringify(command)},"timeout":120,"type":"command"}],"matcher":"*"}`
    expect(hooks).toEqual([
      `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(command)},timeout=120}]}]`,
      `hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:${createHash('sha256').update(definition).digest('hex')}"}}`,
    ])
    expect(hookOverrides(process.execPath, HOOK)).toEqual(hooks)
    // The channel reaches the hook through Codex's environment, kept from its commands; its directory, the hook, and node are bound back read-only.
    expect(Object.keys(s.lastClient.env!)).toEqual(expect.arrayContaining(['SYSTEM_CODEX_GATE_SOCKET', 'SYSTEM_CODEX_GATE_KEY']))
    expect(binds.at(-1)).toEqual({ writable: ['/codex-home', workspace], readOnly: [expect.stringContaining(join(runDir, 'codex-gate-')), HOOK, process.execPath] })
    // Closed with the run: nothing of the channel is left.
    expect(readdirSync(runDir).filter((f) => f.startsWith('codex-gate-'))).toEqual([])
    const ungated = scripted()
    await runtime(ungated).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(ungated.lastClient.overrides!.filter((o) => o.startsWith('hooks.'))).toEqual([])
    expect(ungated.lastClient.env).not.toHaveProperty('SYSTEM_CODEX_GATE_KEY')
  })

  it('asks the gate with the tool, its input, and the call id; allow gives no decision (Codex\'s sandbox decides), deny blocks the call with the reason', async () => {
    const asked: ToolCall[] = []
    const s = scripted(() => turn(command('i1', 'npm test'), { call: { tool: 'apply_patch', input: { command: '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n' } } }, answer('done')))
    const result = await runtime(s).run(gated(async (call) => {
      asked.push(call)
      return call.tool === 'Bash' ? { decision: 'allow' } : { decision: 'deny', reason: 'the policy forbids it' }
    }), new AbortController().signal)
    expect(result).toMatchObject({ text: 'done', nativeHandle: 'h-1' })
    expect(asked).toEqual([
      { tool: 'Bash', input: { command: 'npm test' }, callId: 'call_1' },
      { tool: 'apply_patch', input: { command: '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n' }, callId: 'call_2' },
    ])
    expect(s.calls[0]!.hooks).toEqual([
      { tool: 'Bash', blocked: false, reason: '' },
      { tool: 'apply_patch', blocked: true, reason: 'the run\'s tool gate: the policy forbids it' },
    ])
  })

  it('blocks a call when the gate throws, gives a verdict it does not define, or a defer without a request', async () => {
    for (const toolGate of [
      async () => { throw new Error('boom') },
      async () => ({ decision: 'maybe' }),
      async () => ({ decision: 'defer', reason: 'x', requestId: '' }),
    ] as unknown as ToolGate[]) {
      const s = scripted(() => turn(command('i1', 'ls'), answer('done')))
      await runtime(s).run(gated(toolGate), new AbortController().signal)
      expect(s.calls[0]!.hooks).toEqual([{ tool: 'Bash', blocked: true, reason: expect.stringMatching(/the tool gate/) }])
    }
  })

  it('on a defer, blocks the call, denies every later one, and ends the run with a config_error naming the request (INV-2)', async () => {
    const asked: string[] = []
    const s = scripted(() => turn(command('i1', 'ls'), command('i2', 'npm publish'), command('i3', 'ls'), answer('done')))
    const error = await runtime(s).run(gated(async (call) => {
      const cmd = (call.input as { command: string }).command
      asked.push(cmd)
      return cmd === 'npm publish' ? { decision: 'defer', reason: 'waits for the operator', requestId: 'apr-1' } : { decision: 'allow' }
    }), new AbortController().signal).then(() => { throw new Error('the run completed') }, (e: unknown) => e as Error & { kind: string })
    expect(error).toMatchObject({ kind: 'config_error', message: expect.stringMatching(/stopped at tool call Bash \(call_2\) without running it: waits for the operator \(approval request apr-1\)/) })
    expect(asked).toEqual(['ls', 'npm publish'])
    expect(s.calls[0]!.hooks.map((h) => h.blocked)).toEqual([false, true])
    expect(s.calls[0]!.hooks[1]!.reason).toMatch(/apr-1.*the run stops here/)
  })

  it('stops a run in which Codex reports a tool item its gate never allowed: a hook that failed or did not run', async () => {
    // The hook is not run here (Codex skipped it), yet the command ran.
    const s = scripted(() => turn({ type: 'item.started', item: { id: 'x1', type: 'command_execution', command: 'curl x', aggregated_output: '', status: 'in_progress' } }, answer('done')))
    await expect(runtime(s).run(gated(async () => ({ decision: 'allow' })), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('command_execution item that the run\'s tool gate never allowed') })
    // One allowed call accounts for one item, and an item seen again (started, then completed) once.
    const ok = scripted(() => turn(command('i1', 'ls'), { call: { tool: 'view_image', input: { path: 'a.png' } } }, answer('done')))
    await expect(runtime(ok).run(gated(async () => ({ decision: 'allow' })), new AbortController().signal)).resolves.toMatchObject({ text: 'done' })
    // A web search is a tool no hook sees.
    const web = scripted(() => turn({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'x' } }, answer('done')))
    await expect(runtime(web).run(gated(async () => ({ decision: 'allow' })), new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
  })

  it('refuses a gated run whose hook cannot be read, before anything runs', async () => {
    const s = scripted()
    await expect(runtime(s, { hook: join(root, 'missing.js') }).run(gated(async () => ({ decision: 'allow' })), new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('gate hook') })
    expect(s.calls).toEqual([])
  })
})

describe('codex-sdk: the probe proves the gate on this host before it reports gatesToolCalls', () => {
  const probe = (behaviour: ProbeBehaviour, seen?: string[][]) => runtime(scripted(), { exec: probeExec(behaviour, seen) }).probe()

  it('plays one turn against a scripted model on loopback with the run\'s configuration, hook, and confinement; nothing is kept', async () => {
    const seen: string[][] = []
    expect(await probe({}, seen)).toMatchObject({ gatesToolCalls: true })
    const args = seen[0]!
    expect(args.slice(0, 7)).toEqual(['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd'])
    expect(args).toEqual(expect.arrayContaining(['features.hooks=true', 'model_provider="system-gate-probe"', 'approval_policy="never"', 'web_search="disabled"', ...hookOverrides(process.execPath, HOOK)]))
    expect(args.find((a) => a.startsWith('model_providers.'))).toMatch(/base_url="http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16}\/v1"/)
    expect(readdirSync(runDir).filter((f) => f.startsWith('codex-gate-') || f.startsWith('codex-probe-'))).toEqual([])
  })

  it('reports gatesToolCalls false, with the reason, when the hook does not run, a terminal session starts, a hosted tool is offered, or Codex fails', async () => {
    for (const [behaviour, why] of [
      [{ hook: 'skipped' }, 'the PreToolUse hook did not run before a tool call'],
      [{ terminal: true }, 'a terminal session started'],
      [{ hosted: true }, 'Codex offers the web_search tool'],
      [{ code: 1 }, 'Codex exited with 1'],
    ] as const) {
      expect(await probe(behaviour), why).toMatchObject({ available: true, readsConfined: true, gatesToolCalls: false, detail: expect.stringContaining(`tool calls cannot be gated: ${why}`) })
    }
    expect(await runtime(scripted(), { hook: join(root, 'missing.js') }).probe()).toMatchObject({ gatesToolCalls: false, detail: expect.stringContaining('gate hook') })
  })
})

describe('codex-sdk: a usage limit\'s reset time, from Codex\'s own message (docs/design/agent-runtimes.md#limit-readings)', () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/codex-0.164.0-limit-messages.json', import.meta.url)), 'utf8')) as {
    observedAt: string; timeZone: string; cases: Array<{ case: string; timeZone?: string; message: string; resetsAt: string | null }>
  }
  const observedAt = Date.parse(fixture.observedAt)
  const dated = fixture.cases[1]!.message
  // A run reads its message at the host's now: each test starts at the fixture's, so the dated reset
  // stays ahead of the read whenever the suite runs (only Date is faked; it advances with real time).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    vi.setSystemTime(observedAt)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads each 0.164.0 message shape in the child\'s zone, and no reading from one it cannot read (fail closed)', () => {
    expect(VERIFIED_LIMIT_VERSIONS).toEqual(['0.164.0'])
    for (const c of fixture.cases) {
      const limit = limitFromMessage(c.message, observedAt, c.timeZone ?? fixture.timeZone)
      if (c.resetsAt === null) expect(limit, c.case).toBeUndefined()
      else {
        expect(limit, c.case).toEqual({ window: '*', status: 'rejected', resetsAt: c.resetsAt, observedAt: fixture.observedAt })
        expectConsistentMetering({ limits: [limit!] })
      }
    }
  })

  it('takes a time of day on the child\'s date when it is read, so a message read past its midnight reads late, never early', () => {
    const message = 'You’ve hit your usage limit. Try again at 11:58 PM.'
    expect(limitFromMessage(message, Date.parse('2026-10-24T23:50:00.000Z'), 'UTC')?.resetsAt).toBe('2026-10-24T23:59:00.000Z')
    expect(limitFromMessage(message, Date.parse('2026-10-25T00:00:05.000Z'), 'UTC')?.resetsAt).toBe('2026-10-25T23:59:00.000Z')
    // 23:50 UTC is already Oct 25th in Ho Chi Minh City (06:50): 6:58 AM is that morning, not the UTC date's.
    expect(limitFromMessage('You’ve hit your usage limit. Try again at 6:58 AM.', Date.parse('2026-10-24T23:50:00.000Z'), 'Asia/Ho_Chi_Minh')?.resetsAt).toBe('2026-10-24T23:59:00.000Z')
    // 07:00 UTC is Los Angeles' midnight: 11:58 PM is that day's, read late.
    expect(limitFromMessage(message, Date.parse('2026-10-25T06:50:00.000Z'), 'America/Los_Angeles')?.resetsAt).toBe('2026-10-25T06:59:00.000Z')
    expect(limitFromMessage(message, Date.parse('2026-10-25T07:00:05.000Z'), 'America/Los_Angeles')?.resetsAt).toBe('2026-10-26T06:59:00.000Z')
  })

  it('reads the zone from the child\'s TZ, else the host\'s, and no zone from a TZ the child would not read as one', () => {
    expect(childTimeZone(undefined)).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(childTimeZone('Asia/Ho_Chi_Minh')).toBe('Asia/Ho_Chi_Minh')
    expect(childTimeZone('US/Eastern')).toBe('US/Eastern')
    expect(childTimeZone('UTC')).toBe('UTC')
    expect(childTimeZone(':Europe/Berlin')).toBe('Europe/Berlin')
    for (const tz of ['', ':', 'UTC0', 'CET-1CEST,M3.5.0,M10.5.0/3', '+05:00', '-03:00', 'Mars/Olympus_Mons', 'Etc/Unknown', 'europe/berlin', '/usr/share/zoneinfo/Europe/Berlin']) {
      expect(childTimeZone(tz), tz).toBeUndefined()
    }
    expect(limitFromMessage(dated, observedAt, 'Mars/Olympus_Mons')).toBeUndefined()
  })

  const limited = (message: string) => scripted(() => [{ type: 'thread.started', thread_id: 'h-3' }, { type: 'turn.started' }, { type: 'turn.failed', error: { message } }])
  const fail = async (s: ReturnType<typeof scripted>, version: () => Promise<string>, extra: Partial<ConstructorParameters<typeof CodexRuntime>[0]> = { env: { TZ: 'UTC' } }): Promise<Error & { kind: string }> => {
    const error = await runtime(s, { version, ...extra }).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal).then(() => undefined, (e: unknown) => e as Error & { kind: string })
    expect(error).toBeDefined()
    return error!
  }
  const resetOf = (error: Error) => meteringOf(error)?.limits?.[0]?.resetsAt
  const withDaemonTz = async <T>(tz: string | undefined, body: () => Promise<T>): Promise<T> => {
    const before = process.env.TZ
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
    try {
      return await body()
    } finally {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  }

  it('fails the run quota_exhausted with the reset as a rejected observation of window *, for the ledger to wait on', async () => {
    const before = Date.now()
    const error = await fail(limited(dated), async () => '0.164.0')
    expect(error.kind).toBe('quota_exhausted')
    const metering = meteringOf(error)!
    expect(metering.limits).toEqual([{ window: '*', status: 'rejected', resetsAt: '2026-10-29T09:42:00.000Z', observedAt: expect.any(String) }])
    expect(Date.parse(metering.limits![0]!.observedAt)).toBeGreaterThanOrEqual(before)
    expectConsistentMetering(metering)
  })

  it('leaves Codex\'s TZ as the operator or the daemon has it, and reads the reset in that zone, else the host\'s', async () => {
    const operator = limited(dated)
    expect(resetOf(await fail(operator, async () => '0.164.0', { env: { TZ: 'Asia/Ho_Chi_Minh' } }))).toBe('2026-10-29T02:42:00.000Z')
    expect(operator.lastClient.env).toMatchObject({ TZ: 'Asia/Ho_Chi_Minh' })
    await withDaemonTz('America/Los_Angeles', async () => {
      const daemon = limited(dated)
      expect(resetOf(await fail(daemon, async () => '0.164.0', {}))).toBe('2026-10-29T16:42:00.000Z')
      expect(daemon.lastClient.env).toMatchObject({ TZ: 'America/Los_Angeles' })
    })
    await withDaemonTz(undefined, async () => {
      const host = limited(dated)
      const error = await fail(host, async () => '0.164.0', {})
      expect(host.lastClient.env).not.toHaveProperty('TZ')
      expect(resetOf(error)).toBe(limitFromMessage(dated, observedAt, new Intl.DateTimeFormat().resolvedOptions().timeZone)!.resetsAt)
    })
  })

  it('reports no observation for a message it cannot read, in a zone it cannot read, or from a Codex version not verified, saying so', async () => {
    const later = await fail(limited('You’ve hit your usage limit. Try again later.'), async () => '0.164.0')
    expect(later).toMatchObject({ kind: 'quota_exhausted' })
    expect(meteringOf(later)).toBeUndefined()
    const zoneless = await fail(limited(dated), async () => '0.164.0', { env: { TZ: 'Mars/Olympus_Mons' } })
    expect(zoneless).toMatchObject({ kind: 'quota_exhausted', message: expect.stringContaining('its reset time is not read: Codex ran with TZ="Mars/Olympus_Mons", no time zone it can be read in') })
    expect(meteringOf(zoneless)).toBeUndefined()
    const unverified = await fail(limited(dated), async () => '0.165.0')
    expect(unverified).toMatchObject({ kind: 'quota_exhausted', message: expect.stringContaining('its reset time is not read: the usage-limit message of Codex 0.165.0 is not verified') })
    expect(meteringOf(unverified)).toBeUndefined()
    const unknown = await fail(limited(dated), async () => { throw new Error('no such file') })
    expect(unknown).toMatchObject({ kind: 'quota_exhausted', message: expect.stringContaining('its reset time is not read: codex --version failed: no such file') })
    expect(meteringOf(unknown)).toBeUndefined()
    // Another failure is no limit at all, and its version is never asked.
    let asked = 0
    const broken = await fail(limited('stream disconnected before completion'), async () => { asked++; return '0.164.0' })
    expect(broken).toMatchObject({ kind: 'session_broken' })
    expect(asked).toBe(0)
  })
})
