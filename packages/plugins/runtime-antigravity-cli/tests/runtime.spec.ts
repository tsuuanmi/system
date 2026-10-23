import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type Confinement, meteringOf, proveConfinement, type ToolCall, type ToolGate } from '@tsuuanmi/system-agent-runtime-core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { HOOK_COMMAND, HOOK_ENV, HOOK_NAME, HOOKS_JSON, openChannel, TOKEN_ENV } from '../src/bridge.ts'
import { AntigravityRuntime, type HookProof, limitsFromUsage, refusal, type RuntimeOptions, USAGE_ARGS, usageFrom, VERIFIED_HOOK_VERSIONS, VERIFIED_LIMIT_VERSIONS, workspaceCustomizations } from '../src/index.ts'

const PASSTHROUGH = fileURLToPath(new URL('../../../agent-runtime-core/conformance/passthrough-bwrap.sh', import.meta.url))
const FAKE = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url))

const root = mkdtempSync(join(tmpdir(), 'system-agy-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
/** The Workers' Antigravity home of these tests, and where runs' gate directories go. */
const HOME = join(root, 'home')
const RUN_ROOT = join(root, 'run')
/** The scripted agy, started as an executable as the runtime starts the real one. */
const AGY = join(root, 'bin', 'agy')
mkdirSync(join(root, 'bin'), { recursive: true })
writeFileSync(AGY, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 })

/** Every bind a confinement was asked for, in order. */
const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: PASSTHROUGH, hide: [], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}
/** The bridge's real self-test decides; agy's half is taken as verified (the default never takes it: no version is recorded). */
const bridgeOnly: HookProof = async (_version, test) => {
  const t = await test()
  return { proven: t.ok, detail: t.detail }
}

let scenarioCount = 0
/** A scenario file for the scripted agy, and the log it appends to. */
function scenario(spec: Record<string, unknown> = {}): { env: Record<string, string>; log: () => Array<Record<string, unknown>> } {
  scenarioCount += 1
  const file = join(root, `scenario-${scenarioCount}.json`)
  const log = join(root, `log-${scenarioCount}.jsonl`)
  writeFileSync(file, JSON.stringify(spec))
  return {
    env: { FAKE_AGY_SCENARIO: file, FAKE_AGY_LOG: log },
    log: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []),
  }
}

const runtime = (extra: Partial<RuntimeOptions> = {}): AntigravityRuntime => new AntigravityRuntime({
  executable: AGY, home: HOME, runRoot: RUN_ROOT, confine, prove: async () => ({ confined: true, detail: 'host state hidden by the test' }), hooks: bridgeOnly,
  findExecutable: () => undefined, timing: { killMs: 500 }, ...extra,
})

const prints = (log: Array<Record<string, unknown>>) => log.filter((e) => e.command === 'print') as Array<{ argv: string[]; cwd: string; env: Record<string, string>; prompt: string; calls: Array<{ name: string; answer: { decision: string; reason?: string } }> }>

agentRuntimeProviderConformance('antigravity-cli', () => runtime({ env: scenario().env }))

describe('antigravity-cli: the probe proves what it reports, and never runs a task', () => {
  it('reports its home, confinement, and hook layer proven, its tool calls gated, and no executes or resume', async () => {
    const evidence = await runtime({ env: scenario().env }).probe()
    expect(evidence).toEqual({
      available: true, version: '1.4.6', sandboxes: ['read-only', 'workspace-write'], resume: false, executes: false, readsConfined: true, gatesToolCalls: true,
      detail: 'Antigravity CLI 1.4.6; host state hidden by the test; the hook reaches the run\'s gate inside the confinement',
    })
    // Its own home: the confinement binds it back writable, and nothing else.
    expect(binds).toContainEqual({ writable: [HOME] })
    // It keeps one hooks.json there, with one PreToolUse hook on every tool, and nothing else.
    expect(readFileSync(join(HOME, '.gemini', 'config', 'hooks.json'), 'utf8')).toBe(HOOKS_JSON)
    expect(JSON.parse(HOOKS_JSON)).toEqual({ [HOOK_NAME]: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 60 }] }] } })
    // The home is owner-only; agy's own directories inside it may be readable to others (it makes them 0755).
    expect(statSync(HOME).mode & 0o077).toBe(0)
    chmodSync(join(HOME, '.gemini', 'config'), 0o755)
    expect(await runtime({ env: scenario().env }).probe()).toMatchObject({ available: true })
    chmodSync(HOME, 0o750)
    try {
      expect(await runtime({ env: scenario().env }).probe()).toMatchObject({ available: false, detail: expect.stringContaining('must not be accessible by group or others') })
    } finally {
      chmodSync(HOME, 0o700)
    }
    // No gate directory is left behind.
    expect(readdirSync(RUN_ROOT)).toEqual([])
  })

  it('admits an agy version verified live, and offers no sandbox and gates nothing for any other: agy\'s half of the hook layer takes a model turn to show', async () => {
    expect(VERIFIED_HOOK_VERSIONS).toEqual(['1.4.6'])
    const verified = await runtime({ env: scenario().env, hooks: undefined }).probe()
    expect(verified).toMatchObject({ available: true, readsConfined: true, sandboxes: ['read-only', 'workspace-write'], gatesToolCalls: true, executes: false })
    expect(verified.detail).toContain('the hook reaches the run\'s gate inside the confinement; agy 1.4.6 runs it before each tool call (verified live)')
    const unverified = await runtime({ env: scenario().env, hooks: undefined, version: async () => '1.4.7' }).probe()
    expect(unverified).toMatchObject({ available: true, readsConfined: true, sandboxes: [], gatesToolCalls: false, executes: false })
    expect(unverified.detail).toContain('the hook reaches the run\'s gate inside the confinement; that agy 1.4.7 runs it before each tool call is not proven')
  })

  it('reports gatesToolCalls exactly when the hook layer is proven', async () => {
    expect(await runtime({ env: scenario().env, hooks: async () => ({ proven: false, detail: 'no' }) }).probe()).toMatchObject({ gatesToolCalls: false, sandboxes: [] })
  })

  it('is unavailable, with the reason, when agy is missing, failing, or not signed in inside its own home (INV-2)', async () => {
    expect(await runtime({ executable: undefined }).probe()).toMatchObject({ available: false, detail: expect.stringContaining('not installed') })
    expect(await runtime({ version: async () => { throw new Error('exec format error') } }).probe()).toMatchObject({ available: false, detail: 'agy --version failed: exec format error' })
    const signedOut = await runtime({ env: { ...scenario().env, FAKE_AGY_SIGNED_OUT: '1' } }).probe()
    expect(signedOut).toMatchObject({ available: false, readsConfined: false, sandboxes: [] })
    expect(signedOut.detail).toContain(`not signed in inside its home ${HOME}`)
    expect(signedOut.detail).toContain('Please sign in')
  })

  it('offers nothing without a proven read confinement (ADR-0024)', async () => {
    expect(await runtime({ confine: undefined }).probe()).toMatchObject({ available: true, readsConfined: false, sandboxes: [], detail: expect.stringContaining('no read confinement is configured') })
    expect(await runtime({ prove: async () => ({ confined: false, detail: 'reads cannot be confined: bwrap: setting up uid map: Permission denied' }) }).probe())
      .toMatchObject({ readsConfined: false, sandboxes: [], detail: expect.stringContaining('uid map') })
  })

  it('refuses a home whose plugins, MCP servers, or other hooks would reach a Worker outside its gate; rewrites its own stale hooks.json', async () => {
    const enabled = await runtime({ env: { ...scenario().env, FAKE_AGY_PLUGINS: JSON.stringify([{ name: 'kit', enabled: true, mcpServers: ['db'] }, { name: 'off', enabled: false }]) } }).probe()
    expect(enabled).toMatchObject({ available: false, detail: expect.stringContaining('plugin(s) kit enabled') })
    expect(await runtime({ env: { ...scenario().env, FAKE_AGY_PLUGINS: JSON.stringify([{ name: 'off', enabled: false }]) } }).probe()).toMatchObject({ available: true })
    const config = join(HOME, '.gemini', 'config')
    try {
      writeFileSync(join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: { system: { url: 'http://127.0.0.1:1/mcp' } } }))
      expect(await runtime({ env: scenario().env }).probe()).toMatchObject({ available: false, detail: expect.stringContaining('configures MCP server(s) system') })
      writeFileSync(join(config, 'mcp_config.json'), '')
      writeFileSync(join(config, 'hooks.json'), JSON.stringify({ linter: { PostToolUse: [] } }))
      expect(await runtime({ env: scenario().env }).probe()).toMatchObject({ available: false, detail: expect.stringContaining('configures hooks other than the runtime\'s own') })
      writeFileSync(join(config, 'hooks.json'), JSON.stringify({ [HOOK_NAME]: { PreToolUse: [] } }))
      expect(await runtime({ env: scenario().env }).probe()).toMatchObject({ available: true })
      expect(readFileSync(join(config, 'hooks.json'), 'utf8')).toBe(HOOKS_JSON)
    } finally {
      rmSync(join(config, 'mcp_config.json'), { force: true })
      writeFileSync(join(config, 'hooks.json'), HOOKS_JSON)
    }
  })
})

describe('antigravity-cli: its accounts (ADR-0051)', () => {
  it('gives agy in a home to sign in with, as its HOME with the XDG directories inside it, and no session bus; it reads no identity, so its accounts stay unverified', () => {
    const r = runtime()
    const login = r.loginCommand(join(root, 'slot'))
    expect(login).toMatchObject({ command: AGY, args: [], env: { HOME: join(root, 'slot'), XDG_CONFIG_HOME: join(root, 'slot', '.config'), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } })
    expect(Object.keys(login.env)).not.toContain('DBUS_SESSION_BUS_ADDRESS')
    expect((r as { identity?: unknown }).identity).toBeUndefined()
    expect(r.home).toBe(HOME)
  })
})

describe('antigravity-cli: a run, exactly as configured, or refused before anything starts', () => {
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
  beforeEach(() => {
    binds.length = 0
  })

  it('starts agy in print mode with stream-json, in the workspace, in its own home, without the daemon\'s credentials (INV-8)', async () => {
    Object.assign(process.env, { DAEMON_API_KEY: 'daemon-key', DAEMON_TOKEN_X: 'daemon-token' })
    try {
      const s = scenario()
      const result = await runtime({ env: { ...s.env, [HOOK_ENV]: '/bin/true', XDG_CONFIG_HOME: '/elsewhere' }, forwardEnv: ['DAEMON_API_KEY'] })
        .run({ prompt: 'review it', workspace, sandbox: 'read-only', model: 'model-x' }, new AbortController().signal)
      expect(result).toMatchObject({ text: 'echo: review it', nativeHandle: 'h-1', model: 'model-main', turns: 2 })
      const [seen] = prints(s.log())
      expect(seen!.argv).toEqual(['--print=review it', '--output-format', 'stream-json', '--disable-slash-commands', '--model=model-x'])
      expect(seen!.cwd).toBe(workspace)
      expect(seen!.env).toMatchObject({
        HOME, XDG_CONFIG_HOME: join(HOME, '.config'), XDG_CACHE_HOME: join(HOME, '.cache'), XDG_DATA_HOME: join(HOME, '.local', 'share'), XDG_STATE_HOME: join(HOME, '.local', 'state'),
        AGY_CLI_DISABLE_AUTO_UPDATE: 'true', DAEMON_API_KEY: 'daemon-key',
      })
      // The hook's variables are the run's own, never one configured or forwarded.
      expect(seen!.env[HOOK_ENV]).toMatch(new RegExp(`^${RUN_ROOT}/antigravity-[^/]+/hook$`))
      expect(seen!.env[TOKEN_ENV]).toMatch(/^[0-9a-f]{64}$/)
      expect(seen!.env).not.toHaveProperty('DAEMON_TOKEN_X')
    } finally {
      delete process.env.DAEMON_API_KEY
      delete process.env.DAEMON_TOKEN_X
    }
  })

  it('binds its home writable, the workspace as the sandbox allows, and the run\'s gate directory read-only, which is removed after the run (ADR-0024)', async () => {
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      binds.length = 0
      await runtime({ env: scenario().env }).run({ prompt: 'x', workspace, sandbox }, new AbortController().signal)
      const run = binds.find((b) => b.readOnly?.some((p) => p.startsWith(RUN_ROOT)))!
      const gate = run.readOnly!.find((p) => p.startsWith(RUN_ROOT))!
      expect(run).toEqual(sandbox === 'read-only' ? { writable: [HOME], readOnly: [workspace, gate] } : { writable: [HOME, workspace], readOnly: [gate] })
    }
    expect(readdirSync(RUN_ROOT)).toEqual([])
  })

  it('refuses what agy cannot hold exactly, before it starts: tools outside the sandbox, a turn limit, a conversation to continue, an oversized prompt (REQ-WRK-6)', async () => {
    const s = scenario()
    const go = (spec: Partial<Parameters<AntigravityRuntime['run']>[0]>) => runtime({ env: s.env }).run({ prompt: 'x', workspace, sandbox: 'read-only', ...spec }, new AbortController().signal)
    await expect(go({ tools: ['read_file', 'write_file'] })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('refusing write_file') })
    await expect(go({ sandbox: 'workspace-write', tools: ['run_command'] })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('refusing run_command') })
    await expect(go({ maxTurns: 3 })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('no turn limit') })
    await expect(go({ resume: 'h-0' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('not proven') })
    await expect(go({ prompt: 'x'.repeat(100_001) })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(go({ prompt: 'a\0b' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(go({ model: 'm\0' })).rejects.toMatchObject({ kind: 'config_error' })
    await expect(runtime({ env: s.env, confine: undefined }).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('no read confinement') })
    expect(prints(s.log())).toEqual([])
  })

  it('refuses a workspace whose customization roots hold hooks, MCP servers, or plugins, up to its repository root: agy would run them outside the gate', async () => {
    const repo = join(root, 'repo')
    const nested = join(repo, 'packages', 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(nested, '.agents', 'rules'), { recursive: true })
    expect(workspaceCustomizations(nested)).toEqual([])
    for (const [where, entry] of [[nested, '.agents/hooks.json'], [repo, '_agent/mcp_config.json'], [repo, '.agent/plugins']] as const) {
      const path = join(where, entry)
      if (entry.endsWith('plugins')) mkdirSync(path, { recursive: true })
      else {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, '{}')
      }
      expect(workspaceCustomizations(nested)).toEqual([path])
      const s = scenario()
      await expect(runtime({ env: s.env }).run({ prompt: 'x', workspace: nested, sandbox: 'read-only' }, new AbortController().signal))
        .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining(path) })
      expect(prints(s.log())).toEqual([])
      rmSync(path, { recursive: true })
    }
    // Above the repository root, nothing counts.
    mkdirSync(join(root, '.agents'), { recursive: true })
    writeFileSync(join(root, '.agents', 'hooks.json'), '{}')
    expect(workspaceCustomizations(nested)).toEqual([])
    rmSync(join(root, '.agents'), { recursive: true })
  })

  it('refuses a run whose hook layer is not proven on this host, before agy starts', async () => {
    const s = scenario()
    await expect(runtime({ env: s.env, hooks: async () => ({ proven: false, detail: 'the hook does not run inside the confinement: node: not found' }) })
      .run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('node: not found') })
    // The default proof: the bridge holds, agy's half is not verified for this version.
    await expect(runtime({ env: s.env, hooks: undefined, version: async () => '1.4.7' }).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('that agy 1.4.7 runs it before each tool call is not proven') })
    expect(prints(s.log())).toEqual([])
    expect(readdirSync(RUN_ROOT)).toEqual([])
  })
})

describe('antigravity-cli: every tool call passes the hook: the runtime\'s rules, then the run\'s gate (docs/design/approvals.md)', () => {
  const workspace = join(root, 'gated')
  const outside = join(root, 'outside.txt')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.ts'), 'a\n')
  writeFileSync(outside, 'secret\n')
  symlinkSync(outside, join(workspace, 'escape'))
  const answers = (log: Array<Record<string, unknown>>) => prints(log)[0]!.calls.map((c) => [c.name, c.answer.decision, c.answer.reason ?? ''])

  it('lets a read-only run read inside its workspace only, and nothing else: no write, no command, no other tool (REQ-WRK-6)', async () => {
    const s = scenario({
      calls: [
        { name: 'read_file', args: { Path: join(workspace, 'src', 'a.ts'), StartLine: 1, EndLine: 5 } },
        { name: 'read_file', args: { Path: outside } },
        { name: 'read_file', args: { Path: join(workspace, 'escape') } },
        { name: 'read_file', args: { Path: `${workspace}/../gated/src/a.ts` } },
        { name: 'write_file', args: { Path: join(workspace, 'b.ts'), Content: 'b' } },
        { name: 'edit_file', args: { Path: join(workspace, 'src', 'a.ts'), Target: 'a', Replacement: 'b' } },
        { name: 'run_command', args: { CommandLine: 'ls', WaitMsBeforeAsync: 5000 } },
        { name: 'search_web', args: { query: 'x' } },
        { name: 'invoke_subagent', args: { Prompt: 'x', Workspace: workspace } },
      ],
    })
    await runtime({ env: s.env }).run({ prompt: 'review', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(answers(s.log())).toEqual([
      ['read_file', 'allow', ''],
      ['read_file', 'deny', expect.stringContaining('is not inside the workspace')],
      ['read_file', 'deny', expect.stringContaining('is not inside the workspace')],
      ['read_file', 'deny', expect.stringContaining('climbs out with ..')],
      ['write_file', 'deny', expect.stringContaining('not a tool this run offers')],
      ['edit_file', 'deny', expect.stringContaining('not a tool this run offers')],
      ['run_command', 'deny', expect.stringContaining('not a tool this run offers')],
      ['search_web', 'deny', expect.stringContaining('not a tool this run offers')],
      ['invoke_subagent', 'deny', expect.stringContaining('not a tool this run offers')],
    ])
  })

  it('lets a workspace-write run edit files inside its workspace, never a customization root, and still no command', async () => {
    const s = scenario({
      calls: [
        { name: 'write_file', args: { Path: join(workspace, 'src', 'b.ts'), Content: '/* starts with a slash */\n', Append: false } },
        { name: 'edit_file', args: { Path: join(workspace, 'src', 'a.ts'), Target: '~/a', Replacement: '/etc/b' } },
        { name: 'write_file', args: { Path: outside, Content: 'x' } },
        { name: 'edit_file', args: { Path: join(workspace, 'escape'), Target: 'secret', Replacement: 'x' } },
        { name: 'write_file', args: { Path: join(workspace, '.agents', 'hooks.json'), Content: '{}' } },
        { name: 'run_command', args: { CommandLine: 'npm test' } },
      ],
    })
    await runtime({ env: s.env }).run({ prompt: 'fix', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
    expect(answers(s.log())).toEqual([
      ['write_file', 'allow', ''],
      // An edit's target and replacement are text, never a location.
      ['edit_file', 'allow', ''],
      ['write_file', 'deny', expect.stringContaining('is not inside the workspace')],
      ['edit_file', 'deny', expect.stringContaining('is not inside the workspace')],
      ['write_file', 'deny', expect.stringContaining('customization root')],
      ['run_command', 'deny', expect.stringContaining('not a tool this run offers')],
    ])
  })

  it('narrows to the configured tool list', async () => {
    const s = scenario({ calls: [{ name: 'read_file', args: { Path: join(workspace, 'src', 'a.ts') } }, { name: 'write_file', args: { Path: join(workspace, 'c.ts'), Content: 'c' } }] })
    await runtime({ env: s.env }).run({ prompt: 'x', workspace, sandbox: 'workspace-write', tools: ['read_file'] }, new AbortController().signal)
    expect(answers(s.log()).map(([, d]) => d)).toEqual(['allow', 'deny'])
  })

  it('reads every string outside the known text fields as a location: home paths, other URIs, and unknown fields are held to the workspace', () => {
    const offered = ['read_file', 'write_file']
    expect(refusal({ tool: 'read_file', input: { Path: pathToFileURL(join(workspace, 'src', 'a.ts')).href } }, workspace, offered)).toBeUndefined()
    expect(refusal({ tool: 'read_file', input: { Path: 'src/a.ts' } }, workspace, offered)).toBeUndefined()
    for (const input of [{ Path: '~/.ssh/id_rsa' }, { Path: 'https://example.com/x' }, { Path: pathToFileURL(outside).href }, { Unknown: { nested: ['/etc/hostname'] } }, { Path: 'a\0b' }, 'not an object']) {
      expect(refusal({ tool: 'read_file', input }, workspace, offered)).toBeDefined()
    }
    // A file's content is text, at any depth.
    expect(refusal({ tool: 'write_file', input: { Path: join(workspace, 'c.ts'), Content: '../../etc/passwd' } }, workspace, offered)).toBeUndefined()
    expect(refusal({ tool: 'write_file', input: { Path: join(workspace, 'c.ts'), ArtifactMetadata: { Summary: '/etc/passwd' } } }, workspace, offered)).toBeDefined()
  })

  it('asks the gate with the tool, its input, and agy\'s step as the call id, after the runtime\'s rules: allow runs, deny is the reason the agent is told', async () => {
    const asked: ToolCall[] = []
    const toolGate: ToolGate = async (call) => {
      asked.push(call)
      return call.tool === 'read_file' ? { decision: 'allow' } : { decision: 'deny', reason: 'the policy forbids it' }
    }
    const s = scenario({
      calls: [
        { name: 'read_file', args: { Path: join(workspace, 'src', 'a.ts') } },
        { name: 'write_file', args: { Path: join(workspace, 'src', 'c.ts'), Content: 'c' } },
        { name: 'read_file', args: { Path: outside } },
      ],
    })
    const result = await runtime({ env: s.env }).run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal)
    expect(result.text).toBe('echo: go')
    expect(asked).toEqual([
      { tool: 'read_file', input: { Path: join(workspace, 'src', 'a.ts') }, callId: 'h-1:0' },
      { tool: 'write_file', input: { Path: join(workspace, 'src', 'c.ts'), Content: 'c' }, callId: 'h-1:1' },
    ])
    // The runtime's rules denied the third before the gate was asked.
    expect(answers(s.log())).toEqual([['read_file', 'allow', ''], ['write_file', 'deny', 'the policy forbids it'], ['read_file', 'deny', expect.stringContaining('not inside the workspace')]])
  })

  it('denies a deferred call, stops agy there, asks about nothing more, and fails the run as a config_error naming the request, with what it consumed', async () => {
    const asked: string[] = []
    const toolGate: ToolGate = async (call) => {
      asked.push(call.tool)
      return call.tool === 'write_file' ? { decision: 'defer', reason: 'waits for the operator', requestId: 'apr-1' } : { decision: 'allow' }
    }
    const s = scenario({
      calls: [
        { name: 'read_file', args: { Path: join(workspace, 'src', 'a.ts') } },
        { name: 'write_file', args: { Path: join(workspace, 'src', 'd.ts'), Content: 'd' } },
        { name: 'read_file', args: { Path: join(workspace, 'src', 'a.ts') } },
      ],
      hang: true,
    })
    const started = Date.now()
    const failure = await runtime({ env: s.env }).run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal)
      .then(() => { throw new Error('the run completed') }, (error: unknown) => error as Error & { kind: string })
    expect(failure).toMatchObject({ kind: 'config_error', message: expect.stringContaining('approval request apr-1') })
    expect(failure.message).toContain('write_file (h-1:1)')
    expect(asked).toEqual(['read_file', 'write_file'])
    // agy was stopped, not left to run to the end of its hang.
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(meteringOf(failure)).toMatchObject({ model: 'model-main' })
    expectConsistentMetering(meteringOf(failure)!)
  })

  it('denies when the gate throws, answers a verdict it does not define, or does not answer within its bound (INV-2)', async () => {
    for (const toolGate of [
      async () => { throw new Error('store busy') },
      async () => ({ decision: 'maybe' }) as never,
      async () => ({ decision: 'defer', reason: 'x', requestId: '' }) as never,
      () => new Promise<never>(() => undefined),
    ] as ToolGate[]) {
      const s = scenario({ calls: [{ name: 'read_file', args: { Path: join(workspace, 'src', 'a.ts') } }] })
      await runtime({ env: s.env, timing: { gateMs: 50, killMs: 500 } }).run({ prompt: 'go', workspace, sandbox: 'read-only', toolGate }, new AbortController().signal)
      expect(answers(s.log())).toEqual([['read_file', 'deny', expect.stringMatching(/the tool gate/)]])
    }
  })
})

describe('antigravity-cli: the hook fails closed on its own', () => {
  /** The command in hooks.json, run as agy runs it; asynchronously, since the channel answers from this process. */
  const hook = (env: Record<string, string>, input: unknown = { toolCall: { name: 'read_file', args: {} } }): Promise<{ decision: string; reason?: string }> => new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', HOOK_COMMAND], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env } })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk)
    })
    child.on('error', reject)
    // A hook that denies before it reads its input closes stdin early: the write then fails, and the deny is what is checked.
    child.stdin.on('error', () => undefined)
    child.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1)!) as { decision: string; reason?: string }))
    child.stdin.end(JSON.stringify(input))
  })
  const allowAll = async () => ({ decision: 'allow' as const })

  it('denies in a session no run started: no hook named, or one that is not executable', async () => {
    expect(await hook({})).toEqual({ decision: 'deny', reason: 'no system tool gate is attached to this session' })
    expect(await hook({ [HOOK_ENV]: join(root, 'missing') })).toMatchObject({ decision: 'deny' })
  })

  it('prints a deny itself when the run\'s hook gives no answer: agy 1.4.6 runs the tool on a hook that exits 0 printing nothing', async () => {
    const launcher = (name: string, body: string): string => {
      const path = join(root, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      return path
    }
    const noAnswer = { decision: 'deny', reason: 'the tool gate hook of this run gave no answer' }
    expect(await hook({ [HOOK_ENV]: launcher('silent', 'cat >/dev/null; exit 0') })).toEqual(noAnswer)
    expect(await hook({ [HOOK_ENV]: launcher('fails', 'cat >/dev/null; echo \'{"decision":"allow"}\'; exit 1') })).toEqual(noAnswer)
    expect(await hook({ [HOOK_ENV]: launcher('killed', 'kill -9 $$') })).toEqual(noAnswer)
    // An answer is passed on as the hook printed it.
    expect(await hook({ [HOOK_ENV]: launcher('answers', 'cat >/dev/null; echo \'{"decision":"allow"}\'') })).toEqual({ decision: 'allow' })
  })

  it('answers the run\'s gate with the run\'s token, and denies without it, after the channel closed, or past its bound', async () => {
    const channel = await openChannel(RUN_ROOT, process.execPath, allowAll)
    try {
      expect(statSync(channel.dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(channel.dir, 'gate.sock')).mode & 0o077).toBe(0)
      expect(await hook(channel.env)).toEqual({ decision: 'allow' })
      expect(await hook({ ...channel.env, [TOKEN_ENV]: 'f'.repeat(64) })).toEqual({ decision: 'deny', reason: 'the hook did not present this run\'s token' })
      expect(await hook({ [HOOK_ENV]: channel.env[HOOK_ENV]! })).toEqual({ decision: 'deny', reason: 'no system tool gate is attached to this session' })
      expect(await hook(channel.env, 'not a tool call')).toEqual({ decision: 'deny', reason: 'the hook\'s input names no tool call' })
      expect(await hook(channel.env, { toolCall: { name: '' } })).toEqual({ decision: 'deny', reason: 'the hook\'s input names no tool call' })
    } finally {
      await channel.close()
    }
    expect(existsSync(channel.dir)).toBe(false)
    expect(await hook(channel.env)).toMatchObject({ decision: 'deny' })
    const slow = await openChannel(RUN_ROOT, process.execPath, () => new Promise(() => undefined), { requestMs: 100 })
    try {
      expect(await hook(slow.env)).toEqual({ decision: 'deny', reason: 'the run\'s tool gate did not answer within 0 s' })
    } finally {
      await slow.close()
    }
  })
})

describe('antigravity-cli: agy 1.4.6\'s hook inputs, recorded in the supervised live check, replayed through the bridge', { timeout: 30_000 }, () => {
  interface Recorded { toolCall: { name: string; args: Record<string, unknown> }; stepIdx: number; conversationId: string }
  interface Bridged extends Recorded { sandbox: 'read-only' | 'workspace-write'; answer: 'allow' | 'deny'; by: 'gate' | 'rules'; reason?: string; gateSaw?: ToolCall }
  const live = join(root, 'live')
  const workspace = join(live, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(live, 'outside'))
  // The fixture's placeholders, as this host's paths: the session's workspace, a directory beside it, agy's home.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/agy-1.4.6-hook-inputs.json', import.meta.url), 'utf8')
    .replaceAll('<workspace>', workspace).replaceAll('<outside>', join(live, 'outside')).replaceAll('<home>', HOME).replaceAll('<scratch>', live)) as {
    agy: string; recorded: Array<{ input: Recorded }>; bridge: Bridged[]
  }
  const answers = (log: Array<Record<string, unknown>>) => prints(log)[0]!.calls.map((c) => [c.name, c.answer.decision, c.answer.reason ?? ''])
  const gate = (asked: ToolCall[]): ToolGate => async (call) => {
    asked.push(call)
    return JSON.stringify(call.input).includes('gate-denied.txt') ? { decision: 'deny', reason: 'the live check gate denies gate-denied.txt' } : { decision: 'allow' }
  }

  it('is the evidence for the version the runtime admits', () => {
    expect(VERIFIED_HOOK_VERSIONS).toContain(fixture.agy)
  })

  it('answers each call of the live bridge sessions as it was answered live: the runtime\'s rules first, then the gate, asked with the same call', async () => {
    for (const sandbox of ['workspace-write', 'read-only'] as const) {
      const calls = fixture.bridge.filter((b) => b.sandbox === sandbox)
      const asked: ToolCall[] = []
      const s = scenario({ calls: calls.map(({ toolCall, stepIdx, conversationId }) => ({ input: { toolCall, stepIdx, conversationId } })) })
      await runtime({ env: s.env }).run({ prompt: 'replay', workspace, sandbox, toolGate: gate(asked) }, new AbortController().signal)
      expect(answers(s.log()), sandbox).toEqual(calls.map((b) => [b.toolCall.name, b.answer, b.reason ?? '']))
      expect(asked, sandbox).toEqual(calls.filter((b) => b.by === 'gate').map((b) => b.gateSaw))
    }
  })

  it('takes every hook input agy gave the recording hook, whole: its file tools reach the gate with agy\'s step as the call id, and run_command is denied', async () => {
    const asked: ToolCall[] = []
    const s = scenario({ calls: fixture.recorded.map((r) => ({ input: r.input })) })
    await runtime({ env: s.env }).run({ prompt: 'replay', workspace, sandbox: 'workspace-write', toolGate: gate(asked) }, new AbortController().signal)
    const files = fixture.recorded.filter((r) => r.input.toolCall.name !== 'run_command').map((r) => r.input)
    expect(new Set(files.map((r) => r.toolCall.name))).toEqual(new Set(['read_file', 'edit_file', 'write_file']))
    expect(asked).toEqual(files.map((r) => ({ tool: r.toolCall.name, input: r.toolCall.args, callId: `${r.conversationId}:${r.stepIdx}` })))
    expect(answers(s.log()).filter(([name]) => name === 'run_command')).toEqual([['run_command', 'deny', expect.stringContaining('not a tool this run offers')]])
    expect(answers(s.log()).filter(([name]) => name !== 'run_command').every(([, decision]) => decision === 'allow')).toBe(true)
  })
})

describe('antigravity-cli: the outcome, and what a run consumed, from agy\'s own result', () => {
  const workspace = join(root, 'metered')
  mkdirSync(workspace, { recursive: true })
  const spec = { prompt: 'x', workspace, sandbox: 'read-only' as const }
  const failure = async (s: Record<string, unknown>, signal = new AbortController().signal) => {
    try {
      await runtime({ env: scenario(s).env }).run(spec, signal)
    } catch (error) {
      return error as Error & { kind: string }
    }
    throw new Error('the run did not fail')
  }

  it('normalizes usage by the reading whose sum is agy\'s total: input including its cache read, output its thinking; no fitting reading, no usage', () => {
    // Input includes the cache read, output excludes the thinking.
    expect(usageFrom({ input_tokens: 1500, output_tokens: 300, thinking_tokens: 200, cache_read_tokens: 1000, total_tokens: 2000 })).toEqual({ inputTokens: 1500, outputTokens: 500, cacheReadInputTokens: 1000 })
    // Input excludes the cache read.
    expect(usageFrom({ input_tokens: 500, output_tokens: 300, thinking_tokens: 200, cache_read_tokens: 1000, total_tokens: 2000 })).toEqual({ inputTokens: 1500, outputTokens: 500, cacheReadInputTokens: 1000 })
    // Output includes the thinking.
    expect(usageFrom({ input_tokens: 1500, output_tokens: 500, thinking_tokens: 200, cache_read_tokens: 1000, total_tokens: 2000 })).toEqual({ inputTokens: 1500, outputTokens: 500, cacheReadInputTokens: 1000 })
    expect(usageFrom({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(usageFrom({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 })
    for (const raw of [
      { input_tokens: 1500, output_tokens: 300, thinking_tokens: 200, cache_read_tokens: 1000, total_tokens: 2500 },
      { input_tokens: 1500, output_tokens: 300, cache_read_tokens: 1000 },
      { input_tokens: -1, output_tokens: 3, total_tokens: 2 },
      { output_tokens: 3 },
      'usage',
    ]) expect(usageFrom(raw)).toBeUndefined()
    expectConsistentMetering({ usage: usageFrom({ input_tokens: 500, output_tokens: 300, thinking_tokens: 200, cache_read_tokens: 1000, total_tokens: 2000 })! })
  })

  it('reports turns, usage, and the main model of a completed run; a failed run carries them on its error', async () => {
    const result = await runtime({ env: scenario().env }).run(spec, new AbortController().signal)
    expect(result).toEqual({ text: 'echo: x', nativeHandle: 'h-1', model: 'model-main', turns: 2, usage: { inputTokens: 1500, outputTokens: 500, cacheReadInputTokens: 1000 } })
    const failed = await failure({ result: { status: 'ERROR', error: 'Agent execution terminated due to error.', response: '' }, exitCode: 1 })
    expect(failed.kind).toBe('session_broken')
    expect(meteringOf(failed)).toEqual({ model: 'model-main', turns: 2, usage: { inputTokens: 1500, outputTokens: 500, cacheReadInputTokens: 1000 } })
  })

  it('maps agy\'s failures to the taxonomy: a sign-in to renew, a quota, model capacity, a run without a result, a non-zero exit', async () => {
    expect((await failure({ result: { status: 'ERROR', error: 'authentication failed or timed out', usage: {} }, exitCode: 1 })).kind).toBe('reauth_required')
    expect((await failure({ result: { status: 'ERROR', error: 'individual quota reached' }, exitCode: 1 })).kind).toBe('quota_exhausted')
    expect((await failure({ result: { status: 'ERROR', error: 'MODEL_CAPACITY_EXHAUSTED: try again later' }, exitCode: 1 })).kind).toBe('overloaded')
    const none = await failure({ result: null, stderr: 'panic: runtime error' })
    expect(none).toMatchObject({ kind: 'session_broken', message: expect.stringContaining('without a result (exit 1): panic: runtime error') })
    expect(await failure({ exitCode: 3 })).toMatchObject({ kind: 'session_broken', message: expect.stringContaining('SUCCESS') })
  })

  it('stops agy when aborted, and reports what it saw', async () => {
    const controller = new AbortController()
    const started = Date.now()
    // Aborted once agy runs: it named its conversation, then waits.
    const aborted = await runtime({ env: scenario({ hang: true }).env }).run(spec, controller.signal, () => setTimeout(() => controller.abort(), 50))
      .then(() => { throw new Error('the run completed') }, (error: unknown) => error as Error & { kind: string })
    expect(aborted.kind).toBe('aborted')
    expect(meteringOf(aborted)).toEqual({ model: 'model-main' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('fails with the caller\'s own error when it refuses the handle, and stops agy', async () => {
    const lost = new Error('lease lost')
    await expect(runtime({ env: scenario({ hang: true }).env }).run(spec, new AbortController().signal, () => { throw lost })).rejects.toBe(lost)
  })
})

function findBwrap(): string | undefined {
  try {
    return execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
const BWRAP = findBwrap()
// CI requires the real bubblewrap, so a missing one fails instead of skipping silently.
const REQUIRED = process.env.SYSTEM_REQUIRE_BWRAP === '1'

describe('antigravity-cli: a quota\'s reset time, from agy\'s own usage report (docs/design/agent-runtimes.md#metering)', () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/agy-1.4.6-usage.json', import.meta.url)), 'utf8')) as {
    observedAt: string; cases: Array<{ case: string; stdout: unknown; limits?: unknown[]; unreadable?: string }>
  }
  const text = (stdout: unknown): string => (typeof stdout === 'string' ? stdout : JSON.stringify(stdout))
  const workspace = join(root, 'limited')
  mkdirSync(workspace, { recursive: true })
  const spec = { prompt: 'x', workspace, sandbox: 'read-only' as const }
  const quota = { result: { status: 'ERROR', error: 'You have exhausted your quota on this model.' }, exitCode: 1 }
  let reports = 0
  /** A run on the scripted agy whose usage report prints `stdout`; its error, and agy's log. */
  const fail = async (s: Record<string, unknown>, extra: { stdout?: unknown; env?: Record<string, string>; version?: string } = {}) => {
    const sc = scenario(s)
    const env: Record<string, string> = { ...sc.env, ...extra.env }
    if (extra.stdout !== undefined) {
      reports += 1
      env.FAKE_AGY_USAGE = join(root, `usage-${reports}.json`)
      writeFileSync(env.FAKE_AGY_USAGE, `${text(extra.stdout)}\n`)
    }
    const version = extra.version
    const error = await runtime({ env, ...(version ? { version: async () => version } : {}) }).run(spec, new AbortController().signal)
      .then(() => { throw new Error('the run did not fail') }, (e: unknown) => e as Error & { kind: string })
    return { error, log: sc.log() }
  }

  it('reads each 1.4.6 report shape, and nothing from one it cannot read (fail closed)', () => {
    expect(VERIFIED_LIMIT_VERSIONS).toEqual(['1.4.6'])
    expect(USAGE_ARGS).toEqual(['--print=/usage', '--output-format', 'json'])
    const observedAt = Date.parse(fixture.observedAt)
    for (const c of fixture.cases) {
      const read = limitsFromUsage(text(c.stdout), observedAt)
      if (c.unreadable !== undefined) expect(read, c.case).toEqual({ unreadable: c.unreadable })
      else {
        expect(read, c.case).toEqual({ limits: c.limits })
        expectConsistentMetering({ limits: (read as { limits: [] }).limits })
      }
    }
  })

  it('a run that hits a quota carries the report\'s limits, read after the run under the home\'s confinement, with no gate and no slash command off', async () => {
    const before = Date.now()
    const { error, log } = await fail(quota, { stdout: fixture.cases[0]!.stdout })
    expect(error.kind).toBe('quota_exhausted')
    const metering = meteringOf(error)!
    expect(metering).toMatchObject({ model: 'model-main', turns: 2 })
    expect(metering.limits).toEqual((fixture.cases[0]!.limits as Array<Record<string, unknown>>).map((l) => ({ ...l, observedAt: expect.any(String) })))
    expect(Date.parse(metering.limits![0]!.observedAt)).toBeGreaterThanOrEqual(before)
    expectConsistentMetering(metering)
    const usage = log.filter((e) => e.command === 'usage') as Array<{ argv: string[]; cwd: string; env: Record<string, string> }>
    expect(usage).toHaveLength(1)
    expect(usage[0]!.argv).toEqual([...USAGE_ARGS])
    expect(usage[0]!.cwd).toBe(HOME)
    expect(usage[0]!.env).toMatchObject({ HOME, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })
    // agy's environment, exactly as the run's print had it, without the run's gate. Whatever the
    // scrubbed daemon environment carries (CI sets SYSTEM_REQUIRE_*) reaches both alike.
    const [print] = prints(log)
    expect(Object.keys(print!.env)).toEqual(expect.arrayContaining([HOOK_ENV, TOKEN_ENV]))
    expect(usage[0]!.env).toEqual(Object.fromEntries(Object.entries(print!.env).filter(([k]) => k !== HOOK_ENV && k !== TOKEN_ENV)))
    // After the run's own print, never before it.
    expect(log.map((e) => e.command)).toEqual(['print', 'usage'])
    expect(binds.at(-1)).toEqual({ writable: [HOME] })
  })

  it('a run without a result that hit a rate limit reads the report too; any other failure never asks for it', async () => {
    const none = await fail({ result: null, stderr: 'Error: RESOURCE_EXHAUSTED: rate limit' }, { stdout: fixture.cases[1]!.stdout })
    expect(none.error.kind).toBe('quota_exhausted')
    expect(meteringOf(none.error)!.limits).toEqual([expect.objectContaining({ window: '*', status: 'rejected', resetsAt: '2026-10-24T10:15:30.250Z' })])
    const broken = await fail({ result: { status: 'ERROR', error: 'Agent execution terminated due to error.' }, exitCode: 1 }, { stdout: fixture.cases[0]!.stdout })
    expect(broken.error.kind).toBe('session_broken')
    expect(broken.log.map((e) => e.command)).toEqual(['print'])
  })

  it('a report it cannot read, or that fails, gives no limit, and the error says why', async () => {
    const garbled = await fail(quota, { stdout: fixture.cases.find((c) => c.case.startsWith('not JSON'))!.stdout })
    expect(garbled.error).toMatchObject({ kind: 'quota_exhausted', message: expect.stringContaining('(its reset time is not read: agy\'s usage report cannot be read: it is not one JSON object)') })
    expect(meteringOf(garbled.error)!.limits).toBeUndefined()
    const failing = await fail(quota, { env: { FAKE_AGY_USAGE_FAIL: 'Error: Please sign in.' } })
    expect(failing.error).toMatchObject({ kind: 'quota_exhausted', message: expect.stringContaining('(its reset time is not read: agy\'s usage report failed: Error: Please sign in. (exit 1))') })
    expect(meteringOf(failing.error)!.limits).toBeUndefined()
    // A report with no bucket is read: no limit is known, and the error says nothing more.
    const empty = await fail(quota)
    expect(empty.error.message).not.toContain('not read')
    expect(meteringOf(empty.error)!.limits).toBeUndefined()
  })

  it('never asks an agy version whose report is not verified, and says so', async () => {
    const { error, log } = await fail(quota, { stdout: fixture.cases[0]!.stdout, version: '1.4.7' })
    expect(error).toMatchObject({ kind: 'quota_exhausted', message: expect.stringContaining('(its reset time is not read: the usage report of agy 1.4.7 is not verified)') })
    expect(meteringOf(error)!.limits).toBeUndefined()
    expect(log.map((e) => e.command)).toEqual(['print'])
  })
})

describe.skipIf(!BWRAP && !REQUIRED)('antigravity-cli under the real bubblewrap: the hook reaches the run\'s gate from inside the confinement', () => {
  const host = mkdtempSync(join(tmpdir(), 'system-agy-host-'))
  const dsh = join(host, 'dsh')
  const home = join(dsh, 'system', 'antigravity-home')
  const runRoot = join(dsh, 'system', 'run')
  const workspace = join(host, 'workspace')
  const outside = join(host, 'outside.txt')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(dsh, 0o700)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'a\n')
  writeFileSync(join(dsh, 'system', 'vault.key'), 'vault key')
  writeFileSync(outside, 'b\n')
  afterAll(() => rmSync(host, { recursive: true, force: true }))
  const real = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => ({ bwrap: BWRAP ?? 'bwrap', hide: [dsh], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] })
  const hosted = (env: Record<string, string>) => new AntigravityRuntime({ executable: AGY, home, runRoot, confine: real, hooks: bridgeOnly, findExecutable: () => undefined, env, timing: { killMs: 500 } })

  it('proves the confinement and the bridge on this host: the run\'s gate directory, under the hidden DSH home, is reached read-only from inside', async () => {
    const evidence = await hosted(scenario().env).probe()
    expect(evidence).toMatchObject({ available: true, readsConfined: true, sandboxes: ['read-only', 'workspace-write'] })
    expect(evidence.detail).toContain('the hook reaches the run\'s gate inside the confinement')
    expect((await proveConfinement(real({ writable: [home] }))).confined).toBe(true)
  })

  it('holds a run to its workspace through the hook, under the real confinement', async () => {
    const s = scenario({ calls: [{ name: 'read_file', args: { Path: join(workspace, 'a.txt') } }, { name: 'read_file', args: { Path: outside } }] })
    const result = await hosted(s.env).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(result.text).toBe('echo: x')
    expect(prints(s.log())[0]!.calls.map((c) => c.answer.decision)).toEqual(['allow', 'deny'])
  })
})
