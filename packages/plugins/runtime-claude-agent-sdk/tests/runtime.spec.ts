import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { type AgentHome, agentHome, type Confinement, confinedCommand, HOME_STARTUP_DIRECTORIES, HOME_STATE_DIRECTORIES, type HostTool, meteringOf, type ToolCall, writableUnixSockets } from '@tsuuanmi/system-agent-runtime-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentRuntimeProviderConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { BWRAP, needsBubblewrap } from '../../../agent-runtime-core/tests/host.ts'
import { ClaudeAgentRuntime, type ConfinedRun, commandSandbox, type QueryFn, type RuntimeOptions, type SpawnConfined, withHomeState } from '../src/index.ts'

type Call = { prompt: string; options: Record<string, unknown> }

/** The Workers' Claude Code home of these tests. */
const HOME = mkdtempSync(join(tmpdir(), 'system-claude-home-'))
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

/** Every bind a confinement was asked for, in order. */
const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: '/usr/bin/bwrap', hide: ['/dsh'], readOnly: ['/dsh/system/tools', ...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}
/** The run directory of these tests, where each run's private shell home is made (T198). */
const RUN_DIR = mkdtempSync(join(tmpdir(), 'system-claude-run-'))
afterAll(() => rmSync(RUN_DIR, { recursive: true, force: true }))
/** A run's shell home's tool-state directories, writable, and fish's startup directories in them, read-only (T270). */
const homeDirectories = (home: string): { state: string[]; startup: string[] } => ({
  state: HOME_STATE_DIRECTORIES.map((name) => join(home, name)), startup: HOME_STARTUP_DIRECTORIES.map((name) => join(home, name)),
})
/** A host where both layers start: the read confinement is proven, a nested sandbox starts, and Claude Code is signed in. */
const confined: Partial<RuntimeOptions> = {
  confine, prove: async () => ({ confined: true, detail: 'host state hidden by /usr/bin/bwrap' }), nested: async () => '', status: async () => '{"loggedIn": true, "apiProvider": "firstParty"}',
  runDir: RUN_DIR,
  // No host socket to mask here: a test that cares names its own (T265).
  sockets: () => ({ sockets: [], complete: true }),
  socketDirectories: () => ({ directories: [], complete: true }),
}

/** The SDK's `modelUsage`: its `inputTokens` excludes cached input. */
const MODEL_USAGE = {
  'model-main': { inputTokens: 1200, outputTokens: 900, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 4000, webSearchRequests: 0, costUSD: 0.009, contextWindow: 200_000, maxOutputTokens: 32_000 },
  'model-small': { inputTokens: 300, outputTokens: 1000, cacheReadInputTokens: 500, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.001, contextWindow: 200_000, maxOutputTokens: 32_000 },
}
/** The same, normalized: input includes its cached part; the totals are the sums. */
const NORMALIZED = {
  usage: { inputTokens: 36_000, outputTokens: 1900, cacheReadInputTokens: 30_500, cacheCreationInputTokens: 4000 },
  models: [
    { model: 'model-main', usage: { inputTokens: 35_200, outputTokens: 900, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 4000 }, costUsd: 0.009 },
    { model: 'model-small', usage: { inputTokens: 800, outputTokens: 1000, cacheReadInputTokens: 500, cacheCreationInputTokens: 0 }, costUsd: 0.001 },
  ],
}

/**
 * A scripted Claude Code: it answers with the prompt, as the SDK's message stream would, with the
 * SDK's own usage numbers. `before` are messages streamed between `init` and the result; a
 * `result` of null ends the stream without one, and `throws` ends it with an error.
 */
function scripted(calls: Call[] = [], result: Record<string, unknown> | null = {}, options: { before?: Array<Record<string, unknown>>; init?: Record<string, unknown>; throws?: Error } = {}): QueryFn {
  return ((params: { prompt: string; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} })
    const signal = (params.options?.abortController as AbortController | undefined)?.signal
    return (async function* () {
      if (signal?.aborted) throw new Error('aborted by the caller')
      yield { type: 'system', subtype: 'init', session_id: 'h-1', model: 'model-main', ...options.init }
      for (const message of options.before ?? []) yield message
      if (options.throws) throw options.throws
      if (result === null) return
      yield {
        type: 'result', subtype: 'success', is_error: false, result: `echo: ${params.prompt}`, session_id: 'h-1', uuid: 'r-1', num_turns: 2, total_cost_usd: 0.01,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: MODEL_USAGE, ...result,
      }
    })()
  }) as unknown as QueryFn
}

const runtime = (query: QueryFn, executable: string | null = '/usr/bin/claude', extra: Partial<RuntimeOptions> = {}) =>
  new ClaudeAgentRuntime({ query, executable: executable ?? undefined, findExecutable: () => undefined, version: async () => '2.1.294', home: HOME, ...confined, ...extra })

agentRuntimeProviderConformance('claude-agent-sdk', () => runtime(scripted()))

describe('claude-agent-sdk: the configured policy, exactly', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'system-claude-'))
  afterAll(() => rmSync(workspace, { recursive: true, force: true }))

  it('probes the installed Claude Code without running a task, and offers only what it can confine', async () => {
    expect(await runtime(scripted()).probe()).toEqual({
      available: true, detail: 'Claude Code 2.1.294; host state hidden by /usr/bin/bwrap; commands confined: a sandbox with no network starts inside it', version: '2.1.294',
      sandboxes: ['read-only', 'workspace-write'], resume: true, executes: true, readsConfined: true, gatesToolCalls: true, homes: true, cleanShells: false,
      readTools: ['Read', 'Grep', 'Glob'], hostTools: true, webTools: true,
    })
    expect(await runtime(scripted(), null).probe()).toMatchObject({ available: false, detail: expect.stringMatching(/not installed/) })
  })

  it('gives a research run (web) its reading tools and WebSearch and WebFetch, each pre-approved by name and gated; nothing else, and never writing (T262)', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'read-only', web: true }, new AbortController().signal)
    expect(calls[0]!.options.tools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'])
    expect(calls[0]!.options.allowedTools).toEqual(['Read(./**)', 'Grep(./**)', 'Glob(./**)', 'WebSearch', 'WebFetch'])
    // A read-only run that is no research run gets no web tool; a research run never writes or runs a command.
    await expect(runtime(scripted()).run({ prompt: 'x', workspace, sandbox: 'read-only', tools: ['Read', 'WebFetch'] }, new AbortController().signal)).rejects.toThrow(/refusing WebFetch/)
    await expect(runtime(scripted()).run({ prompt: 'x', workspace, sandbox: 'read-only', web: true, tools: ['WebSearch', 'Bash'] }, new AbortController().signal)).rejects.toThrow(/a research run allows only .*; refusing Bash/)
    await expect(runtime(scripted()).run({ prompt: 'x', workspace, sandbox: 'workspace-write', web: true }, new AbortController().signal)).rejects.toThrow(/read-only; refusing a workspace-write one/)
  })

  it('starts Claude Code without the daemon\'s credentials; a credential reaches it only when forwarded by name (INV-8)', async () => {
    Object.assign(process.env, { SYSTEM_MCP_TOKEN: 'daemon-token', ANTHROPIC_API_KEY: 'daemon-key' })
    try {
      const calls: Call[] = []
      await runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal)
      expect(calls[0]!.options.env).toMatchObject({ PATH: process.env.PATH })
      expect(calls[0]!.options.env).not.toHaveProperty('SYSTEM_MCP_TOKEN')
      expect(calls[0]!.options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      const forwarded: Call[] = []
      await runtime(scripted(forwarded), '/usr/bin/claude', { forwardEnv: ['ANTHROPIC_API_KEY'] })
        .run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal)
      expect(forwarded[0]!.options.env).toMatchObject({ ANTHROPIC_API_KEY: 'daemon-key' })
      expect(forwarded[0]!.options.env).not.toHaveProperty('SYSTEM_MCP_TOKEN')
    } finally {
      delete process.env.SYSTEM_MCP_TOKEN
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('runs read-only: no prompts, no settings files, only the allowed tools, in the workspace', async () => {
    const calls: Call[] = []
    const result = await runtime(scripted(calls)).run({ prompt: 'review', workspace, sandbox: 'read-only', model: 'model-x', maxTurns: 5, resume: 'h-0' }, new AbortController().signal)
    expect(result).toEqual({ text: 'echo: review', nativeHandle: 'h-1', turns: 2, costUsd: 0.01, resultId: 'h-1:r-1', model: 'model-main', ...NORMALIZED })
    expect(calls[0]!.options).toMatchObject({
      cwd: workspace, permissionMode: 'dontAsk', permissionPrompts: 'none', allowedTools: ['Read(./**)', 'Grep(./**)', 'Glob(./**)'], tools: ['Read', 'Grep', 'Glob'],
      settingSources: [], mcpServers: {}, strictMcpConfig: true, pathToClaudeCodeExecutable: '/usr/bin/claude', model: 'model-x', maxTurns: 5, resume: 'h-0',
    })
  })

  it('gives the run its host tools as an in-process server `system`, each pre-approved by its exact name, the input checked before the tool is called (ADR-0070)', async () => {
    const calls: Call[] = []
    const seen: Array<Record<string, unknown>> = []
    const hostTools: HostTool[] = [{
      name: 'dossier_append', description: 'Append an entry', readOnly: false,
      inputSchema: { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: { kind: { type: 'string', enum: ['plan', 'progress'] }, text: { type: 'string', minLength: 1, maxLength: 10 } } },
      call: async (input) => (seen.push(input), { text: 'appended #1', isError: false }),
    }]
    await runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'read-only', hostTools }, new AbortController().signal)
    expect(calls[0]!.options).toMatchObject({
      allowedTools: ['Read(./**)', 'Grep(./**)', 'Glob(./**)', 'mcp__system__dossier_append'], strictMcpConfig: true,
      mcpServers: { system: { type: 'sdk', name: 'system' } },
    })
    expect(Object.keys(calls[0]!.options.mcpServers as object)).toEqual(['system'])
    // The server the SDK connects: it lists the tool with its own schema, and answers a call only on an input the schema takes.
    const server = (calls[0]!.options.mcpServers as { system: { instance: { connect(t: unknown): Promise<void> } } }).system.instance
    const sent: Array<Record<string, unknown>> = []
    const transport: { onmessage?: (m: unknown) => void; send(m: unknown): Promise<void> } = { send: async (m) => void sent.push(m as Record<string, unknown>) }
    await server.connect(transport)
    const ask = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const before = sent.length
      transport.onmessage!({ jsonrpc: '2.0', ...message })
      return vi.waitFor(() => sent[before] ?? Promise.reject(new Error('no answer yet')))
    }
    expect(await ask({ id: 1, method: 'tools/list' })).toMatchObject({ id: 1, result: { tools: [{ name: 'dossier_append', inputSchema: hostTools[0]!.inputSchema, annotations: { readOnlyHint: false } }] } })
    expect(await ask({ id: 2, method: 'tools/call', params: { name: 'dossier_append', arguments: { kind: 'plan', text: 'go', runId: 'run_other' } } }))
      .toMatchObject({ id: 2, result: { isError: true, content: [{ text: expect.stringContaining('"runId" is not an argument of this tool') }] } })
    expect(await ask({ id: 3, method: 'tools/call', params: { name: 'dossier_append', arguments: { kind: 'evidence', text: 'go' } } }))
      .toMatchObject({ result: { isError: true, content: [{ text: 'refused: kind is none of plan, progress' }] } })
    expect(seen).toEqual([])
    expect(await ask({ id: 4, method: 'tools/call', params: { name: 'dossier_append', arguments: { kind: 'plan', text: 'go' } } }))
      .toMatchObject({ result: { isError: false, content: [{ type: 'text', text: 'appended #1' }] } })
    expect(seen).toEqual([{ kind: 'plan', text: 'go' }])
    // A host tool the seam cannot render is refused before anything runs.
    const before = calls.length
    await expect(runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'read-only', hostTools: [{ ...hostTools[0]!, name: 'Bad Name' }] }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('is not a host tool name') })
    expect(calls).toHaveLength(before)
  })

  it('never runs with no tools: an empty list means the minimal read set (live 2026-10-12)', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'read-only', tools: [] }, new AbortController().signal)
    expect(calls[0]!.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read(./**)', 'Grep(./**)', 'Glob(./**)'] })
  })

  it('refuses tools the sandbox cannot hold, before running (REQ-WRK-6)', async () => {
    const calls: Call[] = []
    await expect(runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'read-only', tools: ['Read', 'Write'] }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('Write') })
    await expect(runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'workspace-write', tools: ['Edit', 'WebFetch'] }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('WebFetch') })
    expect(calls).toEqual([])
  })

  it('confines a writable run to its workspace with path-scoped rules (bare rules wrote outside, live 2026-10-12); its commands go to the sandbox', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls)).run({ prompt: 'fix it', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
    expect(calls[0]!.options).toMatchObject({
      cwd: workspace, permissionMode: 'dontAsk', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      allowedTools: ['Read(./**)', 'Grep(./**)', 'Glob(./**)', 'Edit(./**)', 'Write(./**)', 'Bash'],
    })
  })

  it('maps the agent\'s terminal errors to the failure taxonomy', async () => {
    const spec = { prompt: 'x', workspace, sandbox: 'read-only' as const }
    await expect(runtime(scripted([], { subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] })).run(spec, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'timeout' })
    await expect(runtime(scripted([], { subtype: 'error_max_budget_usd', is_error: true, errors: [] })).run(spec, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'quota_exhausted' })
    await expect(runtime(scripted([], { subtype: 'error_during_execution', is_error: true, errors: ['boom'] })).run(spec, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'session_broken', message: expect.stringContaining('boom') })
  })
})

describe('claude-agent-sdk: what a run consumed, from the SDK\'s own numbers (docs/design/resources.md)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'system-claude-meter-'))
  afterAll(() => rmSync(workspace, { recursive: true, force: true }))
  const spec = { prompt: 'x', workspace, sandbox: 'read-only' as const }
  const failure = async (query: QueryFn, signal = new AbortController().signal) => {
    try {
      await runtime(query).run(spec, signal)
    } catch (error) {
      return error as Error & { kind: string }
    }
    throw new Error('the run did not fail')
  }
  const event = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'e-1', session_id: 'h-1' })
  const RESET = Date.UTC(2026, 9, 22, 14, 0, 0) / 1000

  it('sums the result\'s modelUsage over every model, input including its cached part; the result\'s own main-loop usage is not read', async () => {
    const result = await runtime(scripted()).run(spec, new AbortController().signal)
    expect(result).toMatchObject({ resultId: 'h-1:r-1', model: 'model-main', turns: 2, costUsd: 0.01, ...NORMALIZED })
    expect(result).not.toHaveProperty('limits')
    expectConsistentMetering(result)
  })

  it('names the main model from the session\'s init message, else the model with the most output tokens', async () => {
    expect((await runtime(scripted([], {}, { init: { model: undefined } })).run(spec, new AbortController().signal)).model).toBe('model-small')
  })

  it('reports no usage when an entry of modelUsage is unreadable: a partial sum would undercount', async () => {
    const result = await runtime(scripted([], { modelUsage: { ...MODEL_USAGE, broken: { outputTokens: 3 } } })).run(spec, new AbortController().signal)
    expect(result).not.toHaveProperty('usage')
    expect(result).not.toHaveProperty('models')
    expect(result).toMatchObject({ model: 'model-main', turns: 2, costUsd: 0.01 })
  })

  it('reports rate-limit events as observations with an opaque window, the reset in ISO time (the SDK gives Unix seconds), and use in percent (INV-11)', async () => {
    const before = [
      event({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: RESET, utilization: 0.82 }),
      event({ status: 'allowed', rateLimitType: 'seven_day' }),
      event({ status: 'allowed' }),
      // A reset in milliseconds would be centuries away: not believed.
      event({ status: 'allowed', rateLimitType: 'seven_day_family_a', resetsAt: RESET * 1000 }),
    ]
    const result = await runtime(scripted([], {}, { before })).run(spec, new AbortController().signal)
    expect(result.limits).toEqual([
      { window: 'five_hour', status: 'warning', resetsAt: '2026-10-22T14:00:00.000Z', usedPercentage: 82, observedAt: expect.any(String) },
      { window: 'seven_day', status: 'allowed', observedAt: expect.any(String) },
      { window: 'seven_day_family_a', status: 'allowed', observedAt: expect.any(String) },
    ])
    expectConsistentMetering(result)
  })

  it('reports what a failed run consumed on its error', async () => {
    const error = await failure(scripted([], { subtype: 'error_during_execution', is_error: true, errors: ['boom'] }))
    expect(error.kind).toBe('session_broken')
    expect(meteringOf(error)).toMatchObject({ resultId: 'h-1:r-1', model: 'model-main', turns: 2, costUsd: 0.01, ...NORMALIZED })
    expectConsistentMetering(meteringOf(error)!)
  })

  it('fails a run that hit a usage limit as quota_exhausted, never as retryable, with the limit and its reset (docs/design/resources.md)', async () => {
    const before = [event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: RESET })]
    const error = await failure(scripted([], { subtype: 'success', is_error: true, result: 'limit reached' }, { before }))
    expect(error.kind).toBe('quota_exhausted')
    expect(meteringOf(error)?.limits).toEqual([{ window: 'five_hour', status: 'rejected', resetsAt: '2026-10-22T14:00:00.000Z', observedAt: expect.any(String) }])
    // The stream broke after the limit, with no result at all.
    const broken = await failure(scripted([], null, { before, throws: new Error('429') }))
    expect(broken.kind).toBe('quota_exhausted')
    expect(meteringOf(broken)).toEqual({
      model: 'model-main', limits: [expect.objectContaining({ window: 'five_hour', status: 'rejected' })],
      partial: 'Claude Code ended before its result message, and before any assistant message reported usage',
    })
  })

  /** A Claude Code that streams `before`, then waits until the run is stopped, and never sends its result. */
  const stoppable = (before: Array<Record<string, unknown>>) => ((params: { options?: Record<string, unknown> }) => {
    const signal = (params.options!.abortController as AbortController).signal
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'h-1', model: 'model-main' }
      for (const message of before) yield message
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      throw new Error('aborted by the caller')
    })()
  }) as unknown as QueryFn
  /** One streamed assistant message: the SDK's own usage (input excludes cached input), once per content block. */
  const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    type: 'assistant', session_id: 'h-1', parent_tool_use_id: null, message: { id, model: 'model-main', role: 'assistant', content: [], usage }, ...extra,
  })

  it('reports what an aborted run saw before it stopped, marked partial; with no assistant message, no number (stop, timeout, drain)', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const error = await failure(stoppable([event({ status: 'allowed', rateLimitType: 'five_hour' })]), controller.signal)
    expect(error.kind).toBe('aborted')
    expect(meteringOf(error)).toEqual({
      model: 'model-main', limits: [expect.objectContaining({ window: 'five_hour', status: 'allowed' })],
      partial: 'Claude Code was stopped before its result message, and before any assistant message reported usage',
    })
    expectConsistentMetering(meteringOf(error)!)
    // A stop by the operator, a timeout, and a drain at the host's stop all abort the run's signal:
    // what its assistant messages streamed is reported, each response once, at its largest counts.
    const streamed = [
      assistant('msg_1', { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 }),
      assistant('msg_1', { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 }),
      assistant('msg_2', { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 2300 }),
      // A subagent's response counts as usage, not as a turn of the main loop.
      assistant('msg_3', { input_tokens: 7, output_tokens: 3 }, { parent_tool_use_id: 'toolu_1', message: { id: 'msg_3', model: 'model-small', usage: { input_tokens: 7, output_tokens: 3 } } }),
      // One without whole counts is not read: a number the SDK did not give stays missing.
      assistant('msg_4', { output_tokens: 9 }),
    ]
    const stopped = new AbortController()
    setTimeout(() => stopped.abort(), 20)
    const partial = await failure(stoppable(streamed), stopped.signal)
    expect(partial.kind).toBe('aborted')
    expect(meteringOf(partial)).toEqual({
      model: 'model-main', turns: 2,
      usage: { inputTokens: 4757, outputTokens: 53, cacheReadInputTokens: 4300, cacheCreationInputTokens: 300 },
      models: [
        { model: 'model-main', usage: { inputTokens: 4750, outputTokens: 50, cacheReadInputTokens: 4300, cacheCreationInputTokens: 300 } },
        { model: 'model-small', usage: { inputTokens: 7, outputTokens: 3 } },
      ],
      partial: 'Claude Code was stopped before its result message; counted from the usage its 3 assistant messages streamed, which leaves out the response in flight',
    })
    expectConsistentMetering(meteringOf(partial)!)
    // A run that sent its result is counted from it alone, never from the stream.
    const done = await runtime(scripted([], {}, { before: streamed })).run(spec, new AbortController().signal)
    expect(done).toMatchObject({ turns: 2, resultId: 'h-1:r-1', ...NORMALIZED })
    expect(done).not.toHaveProperty('partial')
  })
})

describe('claude-agent-sdk: the run\'s tool gate is a PreToolUse hook on every tool (docs/design/approvals.md)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'system-claude-gate-'))
  afterAll(() => rmSync(workspace, { recursive: true, force: true }))
  type Hook = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>
  type Matcher = { matcher?: string; hooks: Hook[]; timeout?: number }

  /**
   * A scripted Claude Code that makes `tools` calls in order, each through the PreToolUse hooks the
   * run registered, as the CLI does; a `defer` ends the run there, as a headless query does
   * (result `success`, `terminal_reason: tool_deferred`).
   */
  function calling(tools: Array<{ name: string; input: unknown }>, seen: Array<Record<string, unknown>>, matchers: Matcher[][] = []): QueryFn {
    return ((params: { prompt: string; options?: Record<string, unknown> }) => {
      const registered = ((params.options?.hooks as Record<string, Matcher[]> | undefined)?.PreToolUse ?? [])
      matchers.push(registered)
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'h-1', model: 'model-main' }
        let deferred: { id: string; name: string; input: unknown } | undefined
        for (const [i, call] of tools.entries()) {
          const id = `toolu_${i + 1}`
          let output: Record<string, unknown> = {}
          for (const matcher of registered) {
            for (const hook of matcher.hooks) {
              output = await hook({ hook_event_name: 'PreToolUse', session_id: 'h-1', transcript_path: '/t', cwd: workspace, tool_name: call.name, tool_input: call.input, tool_use_id: id }, id, { signal: new AbortController().signal })
            }
          }
          seen.push(output)
          if ((output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'defer') {
            deferred = { id, name: call.name, input: call.input }
            break
          }
        }
        yield {
          type: 'result', subtype: 'success', is_error: false, result: deferred ? '' : `echo: ${params.prompt}`, session_id: 'h-1', uuid: 'r-1', num_turns: 1, total_cost_usd: 0.01,
          usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: MODEL_USAGE,
          ...(deferred ? { terminal_reason: 'tool_deferred', deferred_tool_use: deferred } : { terminal_reason: 'completed' }),
        }
      })()
    }) as unknown as QueryFn
  }
  const decision = (output: Record<string, unknown>) => output.hookSpecificOutput as { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } | undefined

  it('registers one PreToolUse hook with no matcher (every tool), and no other hook; canUseTool stays unset (REQ-WRK-6)', async () => {
    const matchers: Matcher[][] = []
    const calls: Call[] = []
    await runtime(calling([], [], matchers)).run({ prompt: 'x', workspace, sandbox: 'read-only', toolGate: async () => ({ decision: 'allow' }) }, new AbortController().signal)
    expect(matchers[0]).toHaveLength(1)
    expect(matchers[0]![0]!.matcher).toBeUndefined()
    expect(matchers[0]![0]!.hooks).toHaveLength(1)
    expect(matchers[0]![0]!.timeout).toBeGreaterThan(30)
    await runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'read-only', toolGate: async () => ({ decision: 'allow' }) }, new AbortController().signal)
    expect(Object.keys(calls[0]!.options.hooks as object)).toEqual(['PreToolUse'])
    expect(calls[0]!.options).not.toHaveProperty('canUseTool')
    // No gate, no hook: the run is held to its pre-approvals alone.
    const ungated: Call[] = []
    await runtime(scripted(ungated)).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(ungated[0]!.options).not.toHaveProperty('hooks')
  })

  it('asks the gate with the tool, its input, and the call id; allow leaves the call to the workspace-scoped pre-approvals, deny is the hook\'s deny with the reason', async () => {
    const asked: unknown[] = []
    const seen: Array<Record<string, unknown>> = []
    const toolGate = async (call: ToolCall) => {
      asked.push(call)
      return call.tool === 'Read' ? { decision: 'allow' as const } : { decision: 'deny' as const, reason: 'the policy forbids it' }
    }
    const result = await runtime(calling([{ name: 'Read', input: { file_path: 'a.txt' } }, { name: 'Write', input: { file_path: 'b.txt', content: 'x' } }], seen))
      .run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal)
    expect(result.text).toBe('echo: go')
    expect(asked).toEqual([{ tool: 'Read', input: { file_path: 'a.txt' }, callId: 'toolu_1' }, { tool: 'Write', input: { file_path: 'b.txt', content: 'x' }, callId: 'toolu_2' }])
    // A hook's allow would skip the pre-approvals, and with them the workspace bound: no decision instead.
    expect(seen[0]).toEqual({})
    expect(decision(seen[1]!)).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'the policy forbids it' })
  })

  it('defers with the hook\'s defer, runs no further call, and ends the run as a config_error naming the request, though the result says success', async () => {
    const seen: Array<Record<string, unknown>> = []
    const asked: string[] = []
    const toolGate = async (call: { tool: string }) => {
      asked.push(call.tool)
      return call.tool === 'Bash' ? { decision: 'defer' as const, reason: 'waits for the operator', requestId: 'apr-1' } : { decision: 'allow' as const }
    }
    const failure = await runtime(calling([{ name: 'Read', input: { file_path: 'a' } }, { name: 'Bash', input: { command: 'npm test' } }, { name: 'Read', input: { file_path: 'b' } }], seen))
      .run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal).then(() => { throw new Error('the run completed') }, (error: unknown) => error as Error & { kind: string })
    expect(failure).toMatchObject({ kind: 'config_error', message: expect.stringContaining('apr-1') })
    expect(failure.message).toContain('Bash (toolu_2)')
    expect(decision(seen[1]!)).toMatchObject({ permissionDecision: 'defer', permissionDecisionReason: 'waits for the operator' })
    expect(asked).toEqual(['Read', 'Bash'])
    // What the run consumed is still reported.
    expectConsistentMetering(meteringOf(failure)!)
    expect(meteringOf(failure)).toMatchObject({ turns: 1 })
  })

  it('reports what a run that stopped at a deferred call streamed, marked partial, when no result follows the defer', async () => {
    const toolGate = async () => ({ decision: 'defer' as const, reason: 'waits for the operator', requestId: 'apr-9' })
    const query = ((params: { options?: Record<string, unknown> }) => {
      const registered = ((params.options?.hooks as Record<string, Matcher[]> | undefined)?.PreToolUse ?? [])
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'h-1', model: 'model-main' }
        yield { type: 'assistant', session_id: 'h-1', parent_tool_use_id: null, message: { id: 'msg_1', model: 'model-main', usage: { input_tokens: 20, output_tokens: 8 } } }
        for (const hook of registered[0]!.hooks) await hook({ hook_event_name: 'PreToolUse', session_id: 'h-1', transcript_path: '/t', cwd: workspace, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1' }, 'toolu_1', { signal: new AbortController().signal })
        // The CLI exits on the defer without a result message.
        throw new Error('Claude Code process exited with code 1')
      })()
    }) as unknown as QueryFn
    const failure = await runtime(query).run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal)
      .then(() => { throw new Error('the run completed') }, (error: unknown) => error as Error & { kind: string })
    expect(failure).toMatchObject({ kind: 'config_error', message: expect.stringContaining('apr-9') })
    expect(meteringOf(failure)).toEqual({
      model: 'model-main', turns: 1, usage: { inputTokens: 20, outputTokens: 8 }, models: [{ model: 'model-main', usage: { inputTokens: 20, outputTokens: 8 } }],
      partial: 'Claude Code stopped at a deferred tool call before its result message; counted from the usage its 1 assistant message streamed, which leaves out the response in flight',
    })
    expectConsistentMetering(meteringOf(failure)!)
  })

  it('denies every call after a defer, without asking the gate again, should the agent go on', async () => {
    const asked: string[] = []
    const seen: Array<Record<string, unknown>> = []
    const toolGate = async (call: { tool: string }) => {
      asked.push(call.tool)
      return { decision: 'defer' as const, reason: 'waits', requestId: 'apr-2' }
    }
    // A CLI that cannot defer here goes on with the next call.
    const query = ((params: { prompt: string; options?: Record<string, unknown> }) => {
      const hooks = (params.options!.hooks as Record<string, Matcher[]>).PreToolUse!
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'h-1' }
        for (const tool of ['Bash', 'Read']) seen.push(await hooks[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: tool, session_id: 'h-1', transcript_path: '/t', cwd: workspace }, tool, { signal: new AbortController().signal }))
        yield { type: 'result', subtype: 'success', is_error: false, result: 'done anyway', session_id: 'h-1', uuid: 'r-1', num_turns: 1, terminal_reason: 'tool_deferred_unavailable' }
      })()
    }) as unknown as QueryFn
    await expect(runtime(query).run({ prompt: 'go', workspace, sandbox: 'workspace-write', toolGate }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('apr-2') })
    expect(asked).toEqual(['Bash'])
    expect(decision(seen[1]!)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('apr-2') })
  })

  it('denies a call when the gate throws, gives a verdict it does not define, or a defer without a request', async () => {
    for (const toolGate of [
      async () => { throw new Error('store busy') },
      async () => ({ decision: 'maybe' }) as never,
      async () => ({ decision: 'defer', reason: 'x', requestId: '' }) as never,
      async () => ({ decision: 'deny' }) as never,
    ]) {
      const seen: Array<Record<string, unknown>> = []
      await runtime(calling([{ name: 'Read', input: { file_path: 'a' } }], seen)).run({ prompt: 'go', workspace, sandbox: 'read-only', toolGate }, new AbortController().signal)
      expect(decision(seen[0]!)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/the tool gate/) })
    }
  })

  it('fails a run whose result says a tool call was deferred that its gate never deferred (INV-2)', async () => {
    const query = scripted([], { terminal_reason: 'tool_deferred', deferred_tool_use: { id: 't', name: 'Bash', input: {} } })
    await expect(runtime(query).run({ prompt: 'x', workspace, sandbox: 'read-only', toolGate: async () => ({ decision: 'allow' }) }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('did not defer') })
  })
})

/** The options every confined command line starts with (agent-runtime-core's `confinedCommand`). */
const OPTIONS = ['--die-with-parent', '--unshare-pid', '--new-session', '--dev-bind', '/', '/', '--proc', '/proc']
/** Every confined command's own /tmp (a confinement that does not hide it gets one), first, and the variables that name it, last (T113). */
const PRIVATE_TMP = ['--tmpfs', '/tmp']
const TEMP_ENV = ['--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp']
/** The sandbox the probe starts inside the confinement: bubblewrap on Claude Code's PATH, a namespaced `true` with no network. */
const NESTED = ['bwrap', '--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', 'true']

describe('claude-agent-sdk: two confinements, reads by the host and commands by the SDK\'s sandbox (ADR-0038)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'system-claude-confined-'))
  afterAll(() => rmSync(workspace, { recursive: true, force: true }))
  const failing = (message: string): ConfinedRun => async () => { throw new Error(message) }

  it('proves both layers before it reports executes: the read confinement on this host, then a sandbox with no network started inside it, in its own home', async () => {
    const nested: Array<{ command: string; args: string[]; env: Record<string, string> }> = []
    const status: string[][] = []
    const evidence = await runtime(scripted(), '/usr/bin/claude', {
      nested: async (command, env) => (nested.push({ ...command, env }), ''),
      status: async (command) => (status.push(command.args), '{"loggedIn": true}'),
    }).probe()
    expect(evidence).toMatchObject({ available: true, readsConfined: true, executes: true, sandboxes: ['read-only', 'workspace-write'] })
    // Its own home is the one path bound back writable; the confinement hides the operator's ~/.claude.
    expect(binds.at(-1)).toEqual({ writable: [HOME] })
    expect(nested).toEqual([{ command: '/usr/bin/bwrap', args: [...OPTIONS, ...PRIVATE_TMP, '--bind', HOME, HOME, ...TEMP_ENV, '--', ...NESTED], env: expect.objectContaining({ CLAUDE_CONFIG_DIR: HOME }) }])
    expect(status).toEqual([[...OPTIONS, ...PRIVATE_TMP, '--bind', HOME, HOME, ...TEMP_ENV, '--', '/usr/bin/claude', 'auth', 'status']])
  })

  it('reports executes false, with the reason, when either layer is not proven: no workspace-write, so nothing writes or runs a command (INV-2)', async () => {
    const asked: string[] = []
    const reads = await runtime(scripted(), '/usr/bin/claude', {
      prove: async () => ({ confined: false, detail: 'reads cannot be confined: bwrap: setting up uid map: Permission denied' }),
      nested: async () => (asked.push('nested'), ''),
    }).probe()
    expect(reads).toMatchObject({ available: true, readsConfined: false, executes: false, sandboxes: ['read-only'], detail: expect.stringContaining('reads cannot be confined: bwrap') })
    expect(asked).toEqual([])
    const commands = await runtime(scripted(), '/usr/bin/claude', { nested: failing('bwrap: No permissions to create new namespace') }).probe()
    expect(commands).toMatchObject({ available: true, readsConfined: true, executes: false, sandboxes: ['read-only'] })
    expect(commands.detail).toBe('Claude Code 2.1.294; host state hidden by /usr/bin/bwrap; commands cannot be confined: a sandbox does not start inside the confinement: bwrap: No permissions to create new namespace')
    const none = await runtime(scripted(), '/usr/bin/claude', { confine: undefined }).probe()
    expect(none).toMatchObject({ readsConfined: false, executes: false, sandboxes: ['read-only'], detail: expect.stringContaining('no read confinement is configured') })
  })

  it('reports a Claude Code that is not signed in inside its home as unavailable, naming the home, without failing anything (the profile still boots)', async () => {
    for (const status of [failing('Command failed: claude auth status'), async () => '{"loggedIn": false}']) {
      expect(await runtime(scripted(), '/usr/bin/claude', { status }).probe()).toMatchObject({ available: false, executes: false, readsConfined: false, detail: expect.stringContaining(`not signed in inside its home ${HOME}`) })
    }
    // Output that does not say `"loggedIn": true`, even from a command that succeeded, is no
    // sign-in: an unknown state is never taken for one (INV-2).
    for (const output of ['Logged in.', '{"apiProvider": "firstParty"}', '{"loggedIn": "yes"}', 'null']) {
      expect(await runtime(scripted(), '/usr/bin/claude', { status: async () => output }).probe()).toMatchObject({
        available: false, detail: expect.stringContaining('claude auth status: its output does not say who is signed in'),
      })
    }
  })

  it('enables the SDK\'s sandbox in a workspace-write run with exactly ADR-0038\'s settings, and offers Bash there', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls)).run({ prompt: 'run the tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
    // Its commands write the workspace and the shells' tool-state directories (T270), and never where a
    // later command's shell reads startup code (T198): Claude Code's home, which holds the shell
    // snapshot it sources, nor fish's startup directories. The shells' HOME is not denied whole, since
    // a deny wins over an allow: the rest of it is in no allow, so it stays read-only.
    const shellHome = (calls[0]!.options.env as Record<string, string>).HOME!
    expect(shellHome).toMatch(new RegExp(`^${RUN_DIR}/agent-home-`))
    const { state, startup } = homeDirectories(shellHome)
    expect(calls[0]!.options.sandbox).toEqual({
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      // The workspace, and the confinement's private /dev/shm, which a headless Chrome writes (T265).
      filesystem: { allowWrite: [workspace, '/dev/shm', ...state], denyWrite: [HOME, ...startup] },
      // No network; unix sockets, which Chrome needs, the host's own masked in the run first (T265).
      network: { allowedDomains: [], strictAllowlist: true, allowAllUnixSockets: true },
    })
    expect(calls[0]!.options.sandbox).toEqual(commandSandbox(workspace, [HOME, ...startup], { write: ['/dev/shm', ...state], unixSockets: true }))
    // No allowed directory lies under a denied one: it would be denied (a deny wins).
    for (const allowed of state) expect([HOME, ...startup].some((denied) => allowed === denied || allowed.startsWith(`${denied}/`)), allowed).toBe(false)
    expect(calls[0]!.options).toMatchObject({ tools: expect.arrayContaining(['Bash']), allowedTools: expect.arrayContaining(['Bash']) })
    // A Worker that lists its tools without Bash runs no command, in the same sandbox.
    const listed: Call[] = []
    await runtime(scripted(listed)).run({ prompt: 'x', workspace, sandbox: 'workspace-write', tools: ['Read', 'Edit'] }, new AbortController().signal)
    const other = homeDirectories((listed[0]!.options.env as Record<string, string>).HOME!)
    expect(listed[0]!.options).toMatchObject({ tools: ['Read', 'Edit'], allowedTools: ['Read(./**)', 'Edit(./**)'], sandbox: commandSandbox(workspace, [HOME, ...other.startup], { write: ['/dev/shm', ...other.state], unixSockets: true }) })
  })

  it('gives a writing run\'s commands what a browser test needs, as a check\'s confinement does: the managed Chrome the confinement names readable, its private /dev/shm and the run\'s report file writable, the file named to them, unix sockets with the host\'s masked (T265)', async () => {
    const browsers = mkdtempSync(join(tmpdir(), 'system-claude-browsers-'))
    const report = join(mkdtempSync(join(tmpdir(), 'system-claude-report-')), 'report')
    writeFileSync(report, '', { mode: 0o600 })
    try {
      const calls: Call[] = []
      const spawned: string[][] = []
      const spawn: SpawnConfined = (command, args) => {
        spawned.push([command, ...args])
        return { pid: 4243 } as unknown as ReturnType<SpawnConfined>
      }
      const withBrowsers = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => ({ ...confine(bind), env: { SYSTEM_BROWSERS_DIR: browsers } })
      await runtime(scripted(calls), '/usr/bin/claude', { confine: withBrowsers, spawn })
        .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write', reportFile: report }, new AbortController().signal)
      const { state, startup } = homeDirectories((calls[0]!.options.env as Record<string, string>).HOME!)
      expect(calls[0]!.options.sandbox).toEqual(commandSandbox(workspace, [HOME, ...startup], { read: [browsers], write: ['/dev/shm', report, ...state], unixSockets: true }))
      expect(calls[0]!.options.sandbox).toMatchObject({ filesystem: { allowWrite: [workspace, '/dev/shm', report, ...state], allowRead: [browsers], denyWrite: [HOME, ...startup] } })
      // Claude Code itself starts with the report file bound back writable and named in SYSTEM_CHECK_REPORT_PATH.
      const start = calls[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
      start({ command: '/usr/bin/claude', args: [], env: {}, signal: new AbortController().signal })
      const line = spawned[0]!.join(' ')
      expect(line).toContain(`--bind ${realpathSync(report)} ${realpathSync(report)}`)
      expect(line).toContain(`--setenv SYSTEM_CHECK_REPORT_PATH ${report}`)
      expect(line).toContain(`--setenv SYSTEM_BROWSERS_DIR ${browsers}`)
      // Unix sockets, which Chrome needs, by default; no network either way.
      expect((calls[0]!.options.sandbox as { network: Record<string, unknown> }).network).toEqual({ allowedDomains: [], strictAllowlist: true, allowAllUnixSockets: true })
      // Refused where the operator turned them off.
      const refused: Call[] = []
      await runtime(scripted(refused), '/usr/bin/claude', { confine: withBrowsers, unixSockets: false })
        .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write', reportFile: report }, new AbortController().signal)
      expect((refused[0]!.options.sandbox as { network: Record<string, unknown> }).network).toEqual({ allowedDomains: [], strictAllowlist: true })
      // A host socket the run could connect to is masked in its confinement before its commands may make one, after every bind:
      // here under the workspace, which the run binds back writable (the host's /tmp itself is a private tmpfs inside, where an unbound socket is not seen).
      const daemon = createServer(() => undefined)
      const socket = join(workspace, 'daemon.sock')
      await new Promise<void>((resolve) => daemon.listen(socket, resolve))
      try {
        const masking: Call[] = []
        const masked: string[][] = []
        const spawnMasked: SpawnConfined = (command, args) => (masked.push([command, ...args]), { pid: 4244 } as unknown as ReturnType<SpawnConfined>)
        await runtime(scripted(masking), '/usr/bin/claude', { confine: withBrowsers, spawn: spawnMasked, sockets: () => ({ sockets: [socket], complete: true }) })
          .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
        const begin = masking[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
        begin({ command: '/usr/bin/claude', args: [], env: {}, signal: new AbortController().signal })
        const args = masked[0]!.join(' ')
        const mask = `--ro-bind /dev/null ${realpathSync(socket)}`
        expect(args).toContain(`--bind ${realpathSync(workspace)} ${realpathSync(workspace)}`)
        expect(args).toContain(mask)
        expect(args.lastIndexOf(mask)).toBeGreaterThan(args.lastIndexOf(`--bind ${realpathSync(workspace)}`))
        expect(masking[0]!.options.sandbox).toMatchObject({ network: { allowAllUnixSockets: true } })
        // A scan that may have missed one: unix sockets stay refused.
        const partial: Call[] = []
        await runtime(scripted(partial), '/usr/bin/claude', { confine: withBrowsers, sockets: () => ({ sockets: [socket], complete: false }) })
          .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
        expect((partial[0]!.options.sandbox as { network: Record<string, unknown> }).network).toEqual({ allowedDomains: [], strictAllowlist: true })
        // Where the command sandbox does not start with the masks (a host's bubblewrap that cannot mount
        // over a socket) and the socket's own directory cannot be hidden instead (here it is the
        // workspace), the run is proven again without them and runs with unix sockets refused, as
        // before T265: never a writing Worker the masks took away.
        const fallback: Call[] = []
        const fallbackLines: string[][] = []
        const proofs: string[] = []
        const nested: ConfinedRun = async (command) => {
          const line = command.args.join(' ')
          proofs.push(line)
          if (line.includes(mask)) throw new Error('bwrap: Can\'t bind mount /oldroot/dev/null on /newroot/daemon.sock: Not a directory')
          return ''
        }
        await runtime(scripted(fallback), '/usr/bin/claude', { confine: withBrowsers, nested, spawn: (command, args) => (fallbackLines.push([command, ...args]), { pid: 4246 } as unknown as ReturnType<SpawnConfined>), sockets: () => ({ sockets: [socket], complete: true }) })
          .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
        expect(proofs).toHaveLength(2)
        expect(proofs[0]).toContain(mask)
        expect(proofs[1]).not.toContain(mask)
        expect((fallback[0]!.options.sandbox as { network: Record<string, unknown> }).network).toEqual({ allowedDomains: [], strictAllowlist: true })
        const fallbackStart = fallback[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
        fallbackStart({ command: '/usr/bin/claude', args: [], env: {}, signal: new AbortController().signal })
        expect(fallbackLines[0]!.join(' ')).not.toContain(mask)
        // Bubblewrap 0.4 cannot mount over a socket: a socket in a directory the run does not work in
        // (a tool's own runtime directory) is kept from its commands by hiding that directory instead,
        // proven next, and its commands make unix sockets; where that does not start either, they stay refused.
        // (Outside the host's /tmp, which the confinement replaces with a private tmpfs, so the child
        // would see it; a plain file stands for the socket, as the scan is scripted here.)
        const toolDir = realpathSync(mkdtempSync('/dev/shm/system-claude-tool-run-'))
        const toolSocket = join(toolDir, 'tool.sock')
        writeFileSync(toolSocket, '')
        try {
          const toolMask = `--ro-bind /dev/null ${toolSocket}`
          const cover = `--tmpfs ${toolDir}`
          for (const coverStarts of [true, false]) {
            const run: Call[] = []
            const lines: string[][] = []
            const tried: string[] = []
            const oldBwrap: ConfinedRun = async (command) => {
              const line = command.args.join(' ')
              tried.push(line)
              if (line.includes(toolMask)) throw new Error('bwrap: Can\'t create file at ' + toolSocket + ': No such device or address')
              if (!coverStarts && line.includes(cover)) throw new Error('bwrap: Can\'t mount tmpfs')
              return ''
            }
            await runtime(scripted(run), '/usr/bin/claude', { confine: withBrowsers, nested: oldBwrap, spawn: (command, args) => (lines.push([command, ...args]), { pid: 4248 } as unknown as ReturnType<SpawnConfined>), sockets: () => ({ sockets: [toolSocket], complete: true }) })
              .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
            expect(tried).toHaveLength(coverStarts ? 2 : 3)
            expect(tried[0]).toContain(toolMask)
            expect(tried[1]).toContain(cover)
            expect(tried[1]).not.toContain(toolMask)
            const begin = run[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
            begin({ command: '/usr/bin/claude', args: [], env: {}, signal: new AbortController().signal })
            const line = lines[0]!.join(' ')
            expect(line).not.toContain(toolMask)
            if (coverStarts) {
              expect(line).toContain(cover)
              expect(run[0]!.options.sandbox).toMatchObject({ network: { allowAllUnixSockets: true } })
            } else {
              expect(tried[2]).not.toContain(cover)
              expect(line).not.toContain(cover)
              expect((run[0]!.options.sandbox as { network: Record<string, unknown> }).network).toEqual({ allowedDomains: [], strictAllowlist: true })
            }
          }
        } finally {
          rmSync(toolDir, { recursive: true, force: true })
        }
        // The real scanner, given what the run's confinement hides and binds back: the workspace lies
        // under a hidden directory (as a run's worktree lies under the hidden DSH home) and is bound
        // back writable, so its socket is seen, found in the kernel's list, and masked.
        const hiddenParent = dirname(workspace)
        const underHidden = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => ({ ...withBrowsers(bind), hide: [hiddenParent] })
        const asked: Array<{ hide: readonly string[]; rebound: readonly string[] }> = []
        const realScan = (hide: readonly string[], rebound: readonly string[]) => (asked.push({ hide, rebound }), writableUnixSockets([], hide, undefined, rebound))
        const scanned: Call[] = []
        const lines: string[][] = []
        await runtime(scripted(scanned), '/usr/bin/claude', { confine: underHidden, sockets: realScan, spawn: (command, args) => (lines.push([command, ...args]), { pid: 4245 } as unknown as ReturnType<SpawnConfined>) })
          .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
        expect(asked[0]!.hide).toContain(hiddenParent)
        expect(asked[0]!.rebound).toContain(workspace)
        const go = scanned[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
        go({ command: '/usr/bin/claude', args: [], env: {}, signal: new AbortController().signal })
        expect(lines[0]!.join(' ')).toContain(mask)
        expect(scanned[0]!.options.sandbox).toMatchObject({ network: { allowAllUnixSockets: true } })
      } finally {
        await new Promise((resolve) => daemon.close(resolve))
      }
      // A socket a daemon makes after the run's scan, while the run goes on (dockerd starting, making
      // its socket in /run), is never in the masks, a snapshot: the directories where the host's
      // daemons make their sockets are denied to the run's commands for the whole run instead.
      const daemonDir = mkdtempSync(join(tmpdir(), 'system-claude-run-dir-'))
      const late = join(daemonDir, 'docker.sock')
      const lateDaemon = createServer(() => undefined)
      let listening: Promise<void> | undefined
      try {
        const during: Call[] = []
        const lateLines: string[][] = []
        const inner = scripted(during)
        // The model's turn is under way: the scan is done, and the daemon starts now.
        const query = ((params: Parameters<QueryFn>[0]) => {
          listening = new Promise<void>((resolve) => lateDaemon.listen(late, resolve))
          return inner(params)
        }) as unknown as QueryFn
        await runtime(query, '/usr/bin/claude', { confine: withBrowsers, socketDirectories: () => ({ directories: [daemonDir], complete: true }), spawn: (command, args) => (lateLines.push([command, ...args]), { pid: 4247 } as unknown as ReturnType<SpawnConfined>) })
          .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
        await listening
        expect(existsSync(late)).toBe(true)
        const lateStart = during[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
        lateStart({ command: '/usr/bin/claude', args: [], env: {}, signal: new AbortController().signal })
        // The snapshot missed it, as it must: the scan ran before the socket was there.
        expect(lateLines[0]!.join(' ')).not.toContain(late)
        // The run's commands are denied its whole directory, for the whole run, unix sockets or not reachable through it.
        expect(during[0]!.options.sandbox).toMatchObject({ filesystem: { denyRead: [daemonDir] }, network: { allowAllUnixSockets: true } })
        // Where its commands make no unix socket, nothing is denied them beyond what was.
        const off: Call[] = []
        await runtime(scripted(off), '/usr/bin/claude', { confine: withBrowsers, unixSockets: false, socketDirectories: () => ({ directories: [daemonDir], complete: true }) })
          .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
        expect((off[0]!.options.sandbox as { filesystem: Record<string, unknown> }).filesystem).not.toHaveProperty('denyRead')
        // A socket directory that could not be made (so could not be covered, and a daemon could still
        // make it, and its socket, during the run): unix sockets stay refused for the run.
        const unmade: Call[] = []
        await runtime(scripted(unmade), '/usr/bin/claude', { confine: withBrowsers, socketDirectories: () => ({ directories: [daemonDir], complete: false }) })
          .run({ prompt: 'run the browser tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
        expect((unmade[0]!.options.sandbox as { network: Record<string, unknown> }).network).toEqual({ allowedDomains: [], strictAllowlist: true })
        expect((unmade[0]!.options.sandbox as { filesystem: Record<string, unknown> }).filesystem).not.toHaveProperty('denyRead')
      } finally {
        await new Promise((resolve) => lateDaemon.close(resolve))
        rmSync(daemonDir, { recursive: true, force: true })
      }
      // A read-only run runs no command: no sandbox.
      const reading: Call[] = []
      await runtime(scripted(reading), '/usr/bin/claude', { confine: withBrowsers }).run({ prompt: 'review', workspace, sandbox: 'read-only', reportFile: report }, new AbortController().signal)
      expect(reading[0]!.options).not.toHaveProperty('sandbox')
      // A report file that is not a regular file is refused before anything runs.
      await expect(runtime(scripted(), '/usr/bin/claude', { confine: withBrowsers }).run({ prompt: 'x', workspace, sandbox: 'workspace-write', reportFile: dirname(report) }, new AbortController().signal))
        .rejects.toMatchObject({ kind: 'config_error' })
    } finally {
      rmSync(browsers, { recursive: true, force: true })
      rmSync(dirname(report), { recursive: true, force: true })
    }
  })

  it('keeps Bash off in a read-only run, and refuses it there before anything runs', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls)).run({ prompt: 'review', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(calls[0]!.options.tools).not.toContain('Bash')
    expect(calls[0]!.options.allowedTools).not.toContain('Bash')
    expect(calls[0]!.options).not.toHaveProperty('sandbox')
    const refused: Call[] = []
    await expect(runtime(scripted(refused)).run({ prompt: 'x', workspace, sandbox: 'read-only', tools: ['Read', 'Bash'] }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('refusing Bash') })
    expect(refused).toEqual([])
  })

  it('refuses a workspace-write run whose sandbox does not start inside the confinement, before Claude Code starts; a read-only run still runs', async () => {
    const calls: Call[] = []
    const host = runtime(scripted(calls), '/usr/bin/claude', { nested: failing('bwrap: setting up uid map: Permission denied') })
    await expect(host.run({ prompt: 'fix it', workspace, sandbox: 'workspace-write' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/commands cannot be confined.*uid map.*refusing a workspace-write run/) })
    expect(calls).toEqual([])
    await host.run({ prompt: 'review', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(calls).toHaveLength(1)
    // A run stopped while its sandbox is being proven never starts.
    const stopped = new AbortController()
    const late: Call[] = []
    await expect(runtime(scripted(late), '/usr/bin/claude', { nested: async () => (stopped.abort(), '') }).run({ prompt: 'fix it', workspace, sandbox: 'workspace-write' }, stopped.signal))
      .rejects.toMatchObject({ kind: 'aborted' })
    expect(late).toEqual([])
  })

  it('fails a run whose sandbox cannot start once Claude Code runs: it never completes, and no command runs unconfined (INV-2)', async () => {
    // As the CLI does: with failIfUnavailable it ends with an error result; without, it would run the command unsandboxed.
    const unavailableSandbox = ((params: { prompt: string; options?: Record<string, unknown> }) => {
      const sandbox = params.options?.sandbox as { enabled?: boolean; failIfUnavailable?: boolean } | undefined
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'h-1', model: 'model-main' }
        yield sandbox?.enabled && sandbox.failIfUnavailable
          ? { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['sandbox required but unavailable: bubblewrap cannot create a namespace'], session_id: 'h-1', uuid: 'r-1', num_turns: 0 }
          : { type: 'result', subtype: 'success', is_error: false, result: 'ran npm test unsandboxed', session_id: 'h-1', uuid: 'r-1', num_turns: 1 }
      })()
    }) as unknown as QueryFn
    await expect(runtime(unavailableSandbox).run({ prompt: 'run the tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'session_broken', message: expect.stringContaining('sandbox required but unavailable') })
    // A CLI that exits at startup, with no result at all, fails the run the same way.
    await expect(runtime(scripted([], null)).run({ prompt: 'run the tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'session_broken', message: expect.stringContaining('without a result') })
  })

  it('starts Claude Code itself under bubblewrap: the SDK\'s command line wrapped, its home writable, and the workspace as the run\'s sandbox allows (ADR-0024)', async () => {
    const spawned: Array<{ command: string; args: string[]; cwd?: string | undefined; env: Record<string, string | undefined> }> = []
    const spawn: SpawnConfined = (command, args, options) => {
      spawned.push({ command, args, cwd: options.cwd, env: options.env })
      return {} as ReturnType<SpawnConfined>
    }
    // Each run's private shell home (T198), bound back read-only after its own home and the workspace: no startup file can be written there.
    const shellHomes: string[] = []
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const calls: Call[] = []
      const query = scripted(calls)
      // As the SDK does: it starts Claude Code while the run is on, when the run's shell home exists (removed with the run).
      const starting = ((params: Parameters<QueryFn>[0]) => {
        const messages = query(params)
        const start = (params as { options?: Record<string, unknown> }).options?.spawnClaudeCodeProcess as (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
        start({ command: '/usr/bin/claude', args: ['--output-format', 'stream-json'], cwd: workspace, env: { CLAUDE_CONFIG_DIR: HOME }, signal: new AbortController().signal })
        return messages
      }) as unknown as QueryFn
      await runtime(starting, '/usr/bin/claude', { spawn }).run({ prompt: 'x', workspace, sandbox }, new AbortController().signal)
      const shellHome = binds.at(-1)!.readOnly!.find((path) => /\/agent-home-[^/]+$/.test(path))!
      shellHomes.push(shellHome)
      expect(shellHome).toMatch(new RegExp(`^${RUN_DIR}/agent-home-`))
      // Its tool-state directories writable over it, fish's startup directories in them read-only again (T270).
      const { state, startup } = homeDirectories(shellHome)
      expect(binds.at(-1)).toEqual(sandbox === 'read-only'
        ? { writable: [HOME, ...state], readOnly: [workspace, shellHome, ...startup] }
        : { writable: [HOME, workspace, ...state], readOnly: [shellHome, ...startup] })
    }
    // Shallowest first: the home read-only, its tool-state directories writable over it, and each startup directory read-only over the one it lies in.
    const home = (h: string): string[] => [
      '--ro-bind', h, h, '--bind', join(h, '.cache'), join(h, '.cache'), '--bind', join(h, '.config'), join(h, '.config'),
      '--ro-bind', join(h, '.config/fish'), join(h, '.config/fish'), '--bind', join(h, '.local/share'), join(h, '.local/share'), '--bind', join(h, '.local/state'), join(h, '.local/state'),
      '--ro-bind', join(h, '.local/share/fish'), join(h, '.local/share/fish'),
    ]
    expect(spawned).toEqual([
      { command: '/usr/bin/bwrap', args: [...OPTIONS, ...PRIVATE_TMP, '--ro-bind', workspace, workspace, '--bind', HOME, HOME, ...home(shellHomes[0]!), ...TEMP_ENV, '--', '/usr/bin/claude', '--output-format', 'stream-json'], cwd: workspace, env: { CLAUDE_CONFIG_DIR: HOME } },
      { command: '/usr/bin/bwrap', args: [...OPTIONS, ...PRIVATE_TMP, '--bind', HOME, HOME, '--bind', workspace, workspace, ...home(shellHomes[1]!), ...TEMP_ENV, '--', '/usr/bin/claude', '--output-format', 'stream-json'], cwd: workspace, env: { CLAUDE_CONFIG_DIR: HOME } },
    ])
  })

  it('reports its confined process once it is started, and each SDK message as activity; an observer that throws changes nothing (PROP-0013)', async () => {
    const calls: Call[] = []
    const processes: Array<{ pid: number }> = []
    const activity: number[] = []
    const spawn: SpawnConfined = () => ({ pid: 4242 }) as unknown as ReturnType<SpawnConfined>
    const before = Date.now()
    const result = await runtime(scripted(calls), '/usr/bin/claude', { spawn }).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal, undefined, {
      onProcess: (p) => processes.push(p), onActivity: (at) => activity.push(at),
    })
    expect(result.text).toBe('echo: x')
    // The scripted SDK yields its init and its result: two messages, two activity times, in order.
    expect(activity).toHaveLength(2)
    expect(activity[0]).toBeGreaterThanOrEqual(before)
    expect(activity[1]).toBeGreaterThanOrEqual(activity[0]!)
    const start = calls[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
    start({ command: '/usr/bin/claude', args: [], env: {}, signal: new AbortController().signal })
    expect(processes).toEqual([{ pid: 4242 }])
    const throwing = await runtime(scripted(), '/usr/bin/claude', { spawn }).run({ prompt: 'y', workspace, sandbox: 'read-only' }, new AbortController().signal, undefined, {
      onActivity: () => {
        throw new Error('the source could not record it')
      },
    })
    expect(throwing.text).toBe('echo: y')
  })

  it('runs Claude Code in its own home, never the operator\'s, and refuses a run with no read confinement, before anything runs', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls), '/usr/bin/claude', { env: { CLAUDE_CONFIG_DIR: join(HOME, 'elsewhere') } }).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal)
    expect(calls[0]!.options.env).toMatchObject({ CLAUDE_CONFIG_DIR: HOME })
    expect(() => new ClaudeAgentRuntime({ home: 'relative/home' })).toThrow(/home must be an absolute path/)
    const none: Call[] = []
    await expect(runtime(scripted(none), '/usr/bin/claude', { confine: undefined }).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('no read confinement') })
    // A bind that would re-expose a hidden path is refused, never run.
    const exposing = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => ({ ...confine(bind), hide: [join(workspace, 'secret')] })
    writeFileSync(join(workspace, 'secret'), 'a key')
    await expect(runtime(scripted(none), '/usr/bin/claude', { confine: exposing }).run({ prompt: 'x', workspace, sandbox: 'read-only' }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('would expose') })
    rmSync(join(workspace, 'secret'))
    expect(none).toEqual([])
  })

  it('gives each run\'s shells a fresh, empty, private HOME outside the workspace, removed with the run, and no variable a shell runs code from (T198)', async () => {
    // The daemon's environment names startup code, and the operator's config sets one: neither reaches Claude Code.
    Object.assign(process.env, { BASH_ENV: join(workspace, '.bashrc'), ENV: join(workspace, '.profile'), 'BASH_FUNC_echo%%': '() { id; }' })
    try {
      // What Claude Code is started with, as it starts: its environment, and what its HOME holds then.
      const homes: Array<{ home: string; env: Record<string, string>; entries: string[]; mode: number }> = []
      const script = scripted() as unknown as (params: { prompt: string; options?: Record<string, unknown> }) => unknown
      const spy = ((params: { prompt: string; options?: Record<string, unknown> }) => {
        const env = params.options!.env as Record<string, string>
        // Its files, never its directories: it holds only the empty tool-state and startup directories (T270).
        const entries = readdirSync(env.HOME!, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => join(e.parentPath, e.name))
        homes.push({ home: env.HOME!, env, entries, mode: statSync(env.HOME!).mode & 0o777 })
        return script(params)
      }) as unknown as QueryFn
      for (const sandbox of ['read-only', 'workspace-write'] as const) {
        await runtime(spy, '/usr/bin/claude', { env: { ENV: '/x', PS4: '$(id)' } }).run({ prompt: 'x', workspace, sandbox }, new AbortController().signal)
      }
      expect(homes).toHaveLength(2)
      for (const { env } of homes) {
        for (const name of ['BASH_ENV', 'ENV', 'PS4', 'BASH_FUNC_echo%%']) expect(env, name).not.toHaveProperty(name)
      }
      for (const { home, entries, mode } of homes) {
        // Made in the run directory: not in the workspace (where its tools write and git sees it), with no file, owner-only.
        expect(home.startsWith(`${RUN_DIR}/agent-home-`)).toBe(true)
        expect(home.startsWith(workspace)).toBe(false)
        expect(entries).toEqual([])
        expect(mode).toBe(0o700)
        // Removed once the run ended: nothing a run wrote there reaches the next one.
        expect(existsSync(home)).toBe(false)
      }
      expect(homes[0]!.home).not.toBe(homes[1]!.home)
    } finally {
      delete process.env.BASH_ENV
      delete process.env.ENV
      delete process.env['BASH_FUNC_echo%%']
    }
  })

  it('never reports cleanShells: Claude Code starts its shells its own way, sourcing a snapshot of its own, so no gate takes its shell command for a read (T198)', async () => {
    expect(await runtime(scripted()).probe()).toMatchObject({ executes: true, cleanShells: false })
    expect(await runtime(scripted(), '/usr/bin/claude', { nested: failing('no namespace') }).probe()).toMatchObject({ executes: false, cleanShells: false })
  })
})

describe('claude-agent-sdk under the real bubblewrap: both layers nest on this host (ADR-0038)', () => {
  needsBubblewrap()
  const root = mkdtempSync(join(tmpdir(), 'system-claude-host-'))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'system', 'claude-home')
  const vaultKey = join(dsh, 'system', 'vault.key')
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  /** A stand-in `claude`: its version, and a signed-in `auth status`; it never runs a task. */
  const claude = join(root, 'bin', 'claude')
  // The stand-in lies in the test's /tmp, which a confined command does not see (its /tmp is its own): bound back, as an operator's tools are.
  const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => ({ bwrap: BWRAP ?? 'bwrap', hide: [dsh], readOnly: [...(bind.readOnly ?? []), join(root, 'bin')], writable: [...(bind.writable ?? [])] })
  const server = createServer((socket) => socket.end())
  let port = 0
  beforeAll(async () => {
    for (const dir of [home, workspace, outside, join(root, 'bin'), join(dsh, 'system', 'run'), join(home, 'shell-snapshots')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
    shell = agentHome(join(dsh, 'system', 'run'), workspace)
    writeFileSync(vaultKey, 'vault key')
    writeFileSync(claude, '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.308 (Claude Code)" ;;\n  auth) echo \'{"loggedIn": true}\' ;;\n  *) exit 2 ;;\nesac\n', { mode: 0o755 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  /** A run's private shell home (T198), as a run makes it: in the run directory, which the confinement hides. */
  let shell: AgentHome

  /**
   * A command in the sandbox a workspace-write run's settings ask for, rendered as the SDK's
   * sandbox renders them on Linux (bubblewrap): the root read-only, each `allowWrite` path writable,
   * each `denyWrite` path read-only over it, and its own network namespace when no domain is
   * allowed; nested inside the run's confinement, bound as a run's (its shell home read-only, its
   * tool-state directories writable, fish's startup directories in them read-only, T270). With
   * `outer: false`, the confinement binds the whole shell home writable, so the second layer's own
   * settings alone decide what it may write there.
   */
  const sandboxed = async (script: string, { outer = true }: { outer?: boolean } = {}): Promise<number> => {
    const settings = commandSandbox(workspace, [home, ...shell.startup], withHomeState({ read: [], write: [] }, shell))
    const writable = settings.filesystem?.allowWrite ?? []
    const denied = settings.filesystem?.denyWrite ?? []
    const network = settings.network?.allowedDomains?.length ? [] : ['--unshare-net']
    const inner = [
      '--die-with-parent', '--new-session', ...network, '--unshare-pid', '--ro-bind', '/', '/', ...writable.flatMap((path) => ['--bind', path, path]),
      ...denied.flatMap((path) => ['--ro-bind', path, path]), '--dev', '/dev', '--proc', '/proc', '--', 'sh', '-c', script,
    ]
    const binds = outer ? { writable: [home, workspace, ...shell.writable], readOnly: [shell.path, ...shell.startup] } : { writable: [home, workspace, shell.path] }
    const c = confinedCommand('bwrap', inner, confine(binds))
    return promisify(execFile)(c.command, c.args).then(() => 0, (error: { code?: number }) => error.code ?? 1)
  }
  const connect = `${process.execPath} -e "require('net').connect(PORT, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(3))"`

  it('proves both layers with the real bubblewrap: reads confined, and a sandbox with no network nested inside', async () => {
    const runDir = join(dsh, 'system', 'run')
    const evidence = await new ClaudeAgentRuntime({ executable: claude, home, confine, runDir }).probe()
    expect(evidence).toMatchObject({ available: true, version: '2.1.308', readsConfined: true, executes: true, sandboxes: ['read-only', 'workspace-write'], cleanShells: false })
    // Without bubblewrap on Claude Code's PATH the SDK's sandbox cannot start: no executes, the reason named.
    const noNested = await new ClaudeAgentRuntime({ executable: claude, home, confine, runDir, env: { PATH: join(root, 'bin') } }).probe()
    expect(noNested).toMatchObject({ readsConfined: true, executes: false, sandboxes: ['read-only'], detail: expect.stringContaining('commands cannot be confined') })
  })

  it('lets a sandboxed command write its workspace, and nothing else: not outside it, not Claude Code\'s own home, and it never reads the host state', async () => {
    expect(await sandboxed(`touch ${join(workspace, 'built')}`)).toBe(0)
    expect(existsSync(join(workspace, 'built'))).toBe(true)
    expect(await sandboxed(`touch ${join(outside, 'escaped')}`)).not.toBe(0)
    expect(await sandboxed(`touch ${join(home, 'settings.json')}`)).not.toBe(0)
    expect(existsSync(join(outside, 'escaped')) || existsSync(join(home, 'settings.json'))).toBe(false)
    expect(await sandboxed(`cat ${vaultKey}`)).not.toBe(0)
  })

  it('lets no sandboxed command write startup code a later command\'s shell would run: not Claude Code\'s shell snapshot, not a startup file in the shells\' HOME (T198)', async () => {
    const plant = 'echo() { builtin printf pwned; }'
    const h = shell.path
    const files = [
      join(home, 'shell-snapshots', 'snapshot-bash-1.sh'), join(h, '.bashrc'), join(h, '.bash_profile'), join(h, '.profile'),
      // Nor beside or inside the tool-state directories: the home's top and `.local` stay read-only, fish's directories too (T270).
      join(h, '.local', 'bashrc'), join(h, '.config', 'fish', 'config.fish'), join(h, '.local', 'share', 'fish', 'vendor_conf.d', 'x.fish'),
    ]
    for (const file of files) {
      expect(await sandboxed(`mkdir -p ${join(file, '..')}; printf '%s\\n' '${plant}' > ${file}`), file).not.toBe(0)
      expect(existsSync(file), file).toBe(false)
    }
    // Fish's directories are refused by the second layer itself too, whatever the confinement binds (T270).
    for (const file of [join(h, '.config', 'fish', 'config.fish'), join(h, '.local', 'share', 'fish', 'x.fish')]) {
      expect(await sandboxed(`printf '%s\\n' '${plant}' > ${file}`, { outer: false }), file).not.toBe(0)
      expect(existsSync(file), file).toBe(false)
    }
    // The workspace stays writable: the denial is of those directories, not of every write.
    expect(await sandboxed(`printf '%s\\n' '${plant}' > ${join(workspace, '.bashrc')}`)).toBe(0)
  })

  it('lets a sandboxed command make and write a tool\'s state under ~/.local, ~/.cache and ~/.config, through both layers, quietly (T270)', async () => {
    const h = shell.path
    for (const dir of [join(h, '.local', 'share', 'tool'), join(h, '.local', 'state', 'tool'), join(h, '.cache', 'tool'), join(h, '.config', 'tool')]) {
      // The second layer itself allows it (its deny list names no parent of it), and so does the run's confinement.
      expect(await sandboxed(`mkdir -p ${dir} && printf x > ${join(dir, 'state')}`, { outer: false }), dir).toBe(0)
      rmSync(dir, { recursive: true })
      expect(await sandboxed(`mkdir -p ${dir} && printf x > ${join(dir, 'state')}`), dir).toBe(0)
      expect(readFileSync(join(dir, 'state'), 'utf8'), dir).toBe('x')
    }
    // With HOME the shells' home, what a tool does on its first run (the noise each test file printed) prints nothing.
    const settings = commandSandbox(workspace, [home, ...shell.startup], withHomeState({ read: [], write: [] }, shell))
    const c = confinedCommand('bwrap', [
      '--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/',
      ...(settings.filesystem?.allowWrite ?? []).flatMap((path) => ['--bind', path, path]), ...(settings.filesystem?.denyWrite ?? []).flatMap((path) => ['--ro-bind', path, path]),
      '--dev', '/dev', '--proc', '/proc', '--setenv', 'HOME', h, '--', 'sh', '-c',
      'mkdir -p "$HOME/.local" "$HOME/.local/share/applications" && touch "$HOME/.local/share/applications/mimeapps.list" && mkdir -p "$HOME/.cache/x" "$HOME/.config/x"',
    ], confine({ writable: [home, workspace, ...shell.writable], readOnly: [h, ...shell.startup] }))
    expect(await promisify(execFile)(c.command, c.args)).toEqual({ stdout: '', stderr: '' })
  })

  it('cuts a sandboxed command off the network, while the confinement alone still reaches it (the check can see a connection)', async () => {
    const script = connect.replace('PORT', String(port))
    const c = confinedCommand('sh', ['-c', script], confine({ writable: [home, workspace] }))
    expect(await promisify(execFile)(c.command, c.args).then(() => 0, (error: { code?: number }) => error.code ?? 1)).toBe(0)
    expect(await sandboxed(script)).toBe(3)
  })
})
