import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type Confinement, meteringOf, proveConfinement, type ToolCall, type ToolGate } from '@tsuuanmi/system-agent-runtime-core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { HOOK_COMMAND, HOOK_ENV, HOOK_NAME, HOOKS_JSON, openChannel, TOKEN_ENV } from '../src/bridge.ts'
import { AntigravityRuntime, type HookProof, refusal, type RuntimeOptions, usageFrom, workspaceCustomizations } from '../src/index.ts'

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
  it('reports its home, confinement, and hook layer proven, and no executes, resume, or tool gate', async () => {
    const evidence = await runtime({ env: scenario().env }).probe()
    expect(evidence).toEqual({
      available: true, version: '1.4.6', sandboxes: ['read-only', 'workspace-write'], resume: false, executes: false, readsConfined: true, gatesToolCalls: false,
      detail: 'Antigravity CLI 1.4.6; host state hidden by the test; the hook reaches the run\'s gate inside the confinement; the agents source\'s tool gate does not classify Antigravity\'s tools, so a run with a gate is refused',
    })
    // Its own home: the confinement binds it back writable, and nothing else.
    expect(binds).toContainEqual({ writable: [HOME] })
    // It keeps one hooks.json there, with one PreToolUse hook on every tool, and nothing else.
    expect(readFileSync(join(HOME, '.gemini', 'config', 'hooks.json'), 'utf8')).toBe(HOOKS_JSON)
    expect(JSON.parse(HOOKS_JSON)).toEqual({ [HOOK_NAME]: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 60 }] }] } })
    expect(statSync(join(HOME, '.gemini', 'config')).mode & 0o077).toBe(0)
    // No gate directory is left behind.
    expect(readdirSync(RUN_ROOT)).toEqual([])
  })

  it('offers no sandbox while agy\'s half of the hook layer is not proven: no version is verified live, and it takes a model turn to show', async () => {
    const evidence = await runtime({ env: scenario().env, hooks: undefined }).probe()
    expect(evidence).toMatchObject({ available: true, readsConfined: true, sandboxes: [], gatesToolCalls: false, executes: false })
    expect(evidence.detail).toContain('the hook reaches the run\'s gate inside the confinement; that agy 1.4.6 runs it before each tool call is not proven')
  })

  it('reports gatesToolCalls only with the hook layer proven and its tools classified by the gate\'s owner', async () => {
    expect(await runtime({ env: scenario().env, gateClassifies: true }).probe()).toMatchObject({ gatesToolCalls: true, sandboxes: ['read-only', 'workspace-write'] })
    expect(await runtime({ env: scenario().env, gateClassifies: true, hooks: async () => ({ proven: false, detail: 'no' }) }).probe()).toMatchObject({ gatesToolCalls: false, sandboxes: [] })
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

  it('refuses what agy cannot hold exactly, before it starts: tools outside the sandbox, a turn limit, a conversation to continue, a gate it cannot classify, an oversized prompt', async () => {
    const s = scenario()
    const go = (spec: Partial<Parameters<AntigravityRuntime['run']>[0]>) => runtime({ env: s.env }).run({ prompt: 'x', workspace, sandbox: 'read-only', ...spec }, new AbortController().signal)
    await expect(go({ tools: ['view_file', 'code_action'] })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('refusing code_action') })
    await expect(go({ sandbox: 'workspace-write', tools: ['run_command'] })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('refusing run_command') })
    await expect(go({ maxTurns: 3 })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('no turn limit') })
    await expect(go({ resume: 'h-0' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('not proven') })
    await expect(go({ toolGate: async () => ({ decision: 'allow' }) })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('does not classify') })
    await expect(go({ prompt: 'x'.repeat(100_001) })).rejects.toMatchObject({ kind: 'invalid_input' })
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
    await expect(runtime({ env: s.env, hooks: undefined }).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('not proven') })
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

  it('lets a read-only run read inside its workspace only, and nothing else: no write, no command, no other tool', async () => {
    const s = scenario({
      calls: [
        { name: 'view_file', args: { AbsolutePath: join(workspace, 'src', 'a.ts'), StartLine: 1, EndLine: 5 } },
        { name: 'grep_search', args: { SearchPath: workspace, Query: '/etc/passwd', Includes: ['*.ts'] } },
        { name: 'view_file', args: { AbsolutePath: outside } },
        { name: 'view_file', args: { AbsolutePath: join(workspace, 'escape') } },
        { name: 'list_directory', args: { DirectoryPath: `${workspace}/../gated` } },
        { name: 'code_action', args: { TargetFile: join(workspace, 'b.ts'), CodeContent: 'b' } },
        { name: 'run_command', args: { CommandLine: 'ls', Cwd: workspace } },
        { name: 'search_web', args: { query: 'x' } },
      ],
    })
    await runtime({ env: s.env }).run({ prompt: 'review', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(answers(s.log())).toEqual([
      ['view_file', 'allow', ''],
      // A query is text, never a location.
      ['grep_search', 'allow', ''],
      ['view_file', 'deny', expect.stringContaining('is not inside the workspace')],
      ['view_file', 'deny', expect.stringContaining('is not inside the workspace')],
      ['list_directory', 'deny', expect.stringContaining('climbs out with ..')],
      ['code_action', 'deny', expect.stringContaining('not a tool this run offers')],
      ['run_command', 'deny', expect.stringContaining('not a tool this run offers')],
      ['search_web', 'deny', expect.stringContaining('not a tool this run offers')],
    ])
  })

  it('lets a workspace-write run edit files inside its workspace, never a customization root, and still no command', async () => {
    const s = scenario({
      calls: [
        { name: 'code_action', args: { TargetFile: join(workspace, 'src', 'b.ts'), CodeContent: '/* starts with a slash */\n', Description: 'add b', explanation: 'x' } },
        { name: 'code_action', args: { TargetFile: outside, CodeContent: 'x' } },
        { name: 'code_action', args: { TargetFile: join(workspace, '.agents', 'hooks.json'), CodeContent: '{}' } },
        { name: 'run_command', args: { CommandLine: 'npm test', Cwd: workspace } },
      ],
    })
    await runtime({ env: s.env }).run({ prompt: 'fix', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
    expect(answers(s.log())).toEqual([
      ['code_action', 'allow', ''],
      ['code_action', 'deny', expect.stringContaining('is not inside the workspace')],
      ['code_action', 'deny', expect.stringContaining('customization root')],
      ['run_command', 'deny', expect.stringContaining('not a tool this run offers')],
    ])
  })

  it('narrows to the configured tool list', async () => {
    const s = scenario({ calls: [{ name: 'view_file', args: { AbsolutePath: join(workspace, 'src', 'a.ts') } }, { name: 'grep_search', args: { SearchPath: workspace, Query: 'a' } }] })
    await runtime({ env: s.env }).run({ prompt: 'x', workspace, sandbox: 'read-only', tools: ['view_file'] }, new AbortController().signal)
    expect(answers(s.log()).map(([, d]) => d)).toEqual(['allow', 'deny'])
  })

  it('reads every string outside the known text fields as a location: home paths, other URIs, and unknown fields are held to the workspace', () => {
    const offered = ['view_file', 'code_action']
    expect(refusal({ tool: 'view_file', input: { AbsolutePath: pathToFileURL(join(workspace, 'src', 'a.ts')).href } }, workspace, offered)).toBeUndefined()
    expect(refusal({ tool: 'view_file', input: { AbsolutePath: 'src/a.ts' } }, workspace, offered)).toBeUndefined()
    for (const input of [{ AbsolutePath: '~/.ssh/id_rsa' }, { AbsolutePath: 'https://example.com/x' }, { Unknown: { nested: ['/etc/hostname'] } }, { AbsolutePath: 'a\0b' }, 'not an object']) {
      expect(refusal({ tool: 'view_file', input }, workspace, offered)).toBeDefined()
    }
    // A file's content and the model's explanation are text, at any depth.
    expect(refusal({ tool: 'code_action', input: { TargetFile: join(workspace, 'c.ts'), ReplacementChunks: [{ TargetContent: '/etc', ReplacementContent: '~/x' }], explanation: '../../' } }, workspace, offered)).toBeUndefined()
  })

  it('asks the gate with the tool, its input, and agy\'s step as the call id, after the runtime\'s rules: allow runs, deny is the reason the agent is told', async () => {
    const asked: ToolCall[] = []
    const toolGate: ToolGate = async (call) => {
      asked.push(call)
      return call.tool === 'view_file' ? { decision: 'allow' } : { decision: 'deny', reason: 'the policy forbids it' }
    }
    const s = scenario({
      calls: [
        { name: 'view_file', args: { AbsolutePath: join(workspace, 'src', 'a.ts') } },
        { name: 'code_action', args: { TargetFile: join(workspace, 'src', 'c.ts'), CodeContent: 'c' } },
        { name: 'view_file', args: { AbsolutePath: outside } },
      ],
    })
    const result = await runtime({ env: s.env, gateClassifies: true }).run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal)
    expect(result.text).toBe('echo: go')
    expect(asked).toEqual([
      { tool: 'view_file', input: { AbsolutePath: join(workspace, 'src', 'a.ts') }, callId: 'h-1:0' },
      { tool: 'code_action', input: { TargetFile: join(workspace, 'src', 'c.ts'), CodeContent: 'c' }, callId: 'h-1:1' },
    ])
    // The runtime's rules denied the third before the gate was asked.
    expect(answers(s.log())).toEqual([['view_file', 'allow', ''], ['code_action', 'deny', 'the policy forbids it'], ['view_file', 'deny', expect.stringContaining('not inside the workspace')]])
  })

  it('denies a deferred call, stops agy there, asks about nothing more, and fails the run as a config_error naming the request, with what it consumed', async () => {
    const asked: string[] = []
    const toolGate: ToolGate = async (call) => {
      asked.push(call.tool)
      return call.tool === 'code_action' ? { decision: 'defer', reason: 'waits for the operator', requestId: 'apr-1' } : { decision: 'allow' }
    }
    const s = scenario({
      calls: [
        { name: 'view_file', args: { AbsolutePath: join(workspace, 'src', 'a.ts') } },
        { name: 'code_action', args: { TargetFile: join(workspace, 'src', 'd.ts'), CodeContent: 'd' } },
        { name: 'view_file', args: { AbsolutePath: join(workspace, 'src', 'a.ts') } },
      ],
      hang: true,
    })
    const started = Date.now()
    const failure = await runtime({ env: s.env, gateClassifies: true }).run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal)
      .then(() => { throw new Error('the run completed') }, (error: unknown) => error as Error & { kind: string })
    expect(failure).toMatchObject({ kind: 'config_error', message: expect.stringContaining('approval request apr-1') })
    expect(failure.message).toContain('code_action (h-1:1)')
    expect(asked).toEqual(['view_file', 'code_action'])
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
      const s = scenario({ calls: [{ name: 'view_file', args: { AbsolutePath: join(workspace, 'src', 'a.ts') } }] })
      await runtime({ env: s.env, gateClassifies: true, timing: { gateMs: 50, killMs: 500 } }).run({ prompt: 'go', workspace, sandbox: 'read-only', toolGate }, new AbortController().signal)
      expect(answers(s.log())).toEqual([['view_file', 'deny', expect.stringMatching(/the tool gate/)]])
    }
  })
})

describe('antigravity-cli: the hook fails closed on its own', () => {
  /** The command in hooks.json, run as agy runs it; asynchronously, since the channel answers from this process. */
  const hook = (env: Record<string, string>, input: unknown = { toolCall: { name: 'view_file', args: {} } }): Promise<{ decision: string; reason?: string }> => new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', HOOK_COMMAND], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env } })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk)
    })
    child.on('error', reject)
    child.on('close', () => resolve(JSON.parse(out.trim().split('\n').at(-1)!) as { decision: string; reason?: string }))
    child.stdin.end(JSON.stringify(input))
  })
  const allowAll = async () => ({ decision: 'allow' as const })

  it('denies in a session no run started: no hook named, or one that is not executable', async () => {
    expect(await hook({})).toEqual({ decision: 'deny', reason: 'no system tool gate is attached to this session' })
    expect(await hook({ [HOOK_ENV]: join(root, 'missing') })).toMatchObject({ decision: 'deny' })
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
    const s = scenario({ calls: [{ name: 'view_file', args: { AbsolutePath: join(workspace, 'a.txt') } }, { name: 'view_file', args: { AbsolutePath: outside } }] })
    const result = await hosted(s.env).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(result.text).toBe('echo: x')
    expect(prints(s.log())[0]!.calls.map((c) => c.answer.decision)).toEqual(['allow', 'deny'])
  })
})
