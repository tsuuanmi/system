import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type Confinement, confinedCommand, meteringOf, type ToolCall } from '@tsuuanmi/system-agent-runtime-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { ClaudeAgentRuntime, type ConfinedRun, commandSandbox, type QueryFn, type RuntimeOptions, type SpawnConfined } from '../src/index.ts'

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
/** A host where both layers start: the read confinement is proven, a nested sandbox starts, and Claude Code is signed in. */
const confined: Partial<RuntimeOptions> = {
  confine, prove: async () => ({ confined: true, detail: 'host state hidden by /usr/bin/bwrap' }), nested: async () => '', status: async () => '{"loggedIn": true, "apiProvider": "firstParty"}',
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
      sandboxes: ['read-only', 'workspace-write'], resume: true, executes: true, readsConfined: true, gatesToolCalls: true,
    })
    expect(await runtime(scripted(), null).probe()).toMatchObject({ available: false, detail: expect.stringMatching(/not installed/) })
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
    const result = await runtime(scripted(calls)).run({ prompt: 'review', workspace, sandbox: 'read-only', model: 'opus-x', maxTurns: 5, resume: 'h-0' }, new AbortController().signal)
    expect(result).toEqual({ text: 'echo: review', nativeHandle: 'h-1', turns: 2, costUsd: 0.01, resultId: 'h-1:r-1', model: 'model-main', ...NORMALIZED })
    expect(calls[0]!.options).toMatchObject({
      cwd: workspace, permissionMode: 'dontAsk', permissionPrompts: 'none', allowedTools: ['Read(./**)', 'Grep(./**)', 'Glob(./**)'], tools: ['Read', 'Grep', 'Glob'],
      settingSources: [], mcpServers: {}, strictMcpConfig: true, pathToClaudeCodeExecutable: '/usr/bin/claude', model: 'opus-x', maxTurns: 5, resume: 'h-0',
    })
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
      event({ status: 'allowed', rateLimitType: 'seven_day_opus', resetsAt: RESET * 1000 }),
    ]
    const result = await runtime(scripted([], {}, { before })).run(spec, new AbortController().signal)
    expect(result.limits).toEqual([
      { window: 'five_hour', status: 'warning', resetsAt: '2026-10-22T14:00:00.000Z', usedPercentage: 82, observedAt: expect.any(String) },
      { window: 'seven_day', status: 'allowed', observedAt: expect.any(String) },
      { window: 'seven_day_opus', status: 'allowed', observedAt: expect.any(String) },
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
    expect(meteringOf(broken)).toEqual({ model: 'model-main', limits: [expect.objectContaining({ window: 'five_hour', status: 'rejected' })] })
  })

  it('reports what an aborted run saw before it stopped; a run with no result reports no usage', async () => {
    const controller = new AbortController()
    const query = ((params: { options?: Record<string, unknown> }) => {
      const signal = (params.options!.abortController as AbortController).signal
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'h-1', model: 'model-main' }
        yield event({ status: 'allowed', rateLimitType: 'five_hour' })
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        throw new Error('aborted by the caller')
      })()
    }) as unknown as QueryFn
    setTimeout(() => controller.abort(), 20)
    const error = await failure(query, controller.signal)
    expect(error.kind).toBe('aborted')
    expect(meteringOf(error)).toEqual({ model: 'model-main', limits: [expect.objectContaining({ window: 'five_hour', status: 'allowed' })] })
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
    expect(nested).toEqual([{ command: '/usr/bin/bwrap', args: [...OPTIONS, '--bind', HOME, HOME, '--', ...NESTED], env: expect.objectContaining({ CLAUDE_CONFIG_DIR: HOME }) }])
    expect(status).toEqual([[...OPTIONS, '--bind', HOME, HOME, '--', '/usr/bin/claude', 'auth', 'status']])
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
    // Output it cannot read, from a command that succeeded, says nothing against the sign-in.
    expect(await runtime(scripted(), '/usr/bin/claude', { status: async () => 'Logged in.' }).probe()).toMatchObject({ available: true })
  })

  it('enables the SDK\'s sandbox in a workspace-write run with exactly ADR-0038\'s settings, and offers Bash there', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls)).run({ prompt: 'run the tests', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
    expect(calls[0]!.options.sandbox).toEqual({
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [workspace] },
      network: { allowedDomains: [], strictAllowlist: true },
    })
    expect(calls[0]!.options.sandbox).toEqual(commandSandbox(workspace))
    expect(calls[0]!.options).toMatchObject({ tools: expect.arrayContaining(['Bash']), allowedTools: expect.arrayContaining(['Bash']) })
    // A Worker that lists its tools without Bash runs no command, in the same sandbox.
    const listed: Call[] = []
    await runtime(scripted(listed)).run({ prompt: 'x', workspace, sandbox: 'workspace-write', tools: ['Read', 'Edit'] }, new AbortController().signal)
    expect(listed[0]!.options).toMatchObject({ tools: ['Read', 'Edit'], allowedTools: ['Read(./**)', 'Edit(./**)'], sandbox: commandSandbox(workspace) })
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
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const calls: Call[] = []
      await runtime(scripted(calls), '/usr/bin/claude', { spawn }).run({ prompt: 'x', workspace, sandbox }, new AbortController().signal)
      expect(binds.at(-1)).toEqual(sandbox === 'read-only' ? { writable: [HOME], readOnly: [workspace] } : { writable: [HOME, workspace] })
      const start = calls[0]!.options.spawnClaudeCodeProcess as (options: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }) => unknown
      start({ command: '/usr/bin/claude', args: ['--output-format', 'stream-json'], cwd: workspace, env: { CLAUDE_CONFIG_DIR: HOME }, signal: new AbortController().signal })
    }
    expect(spawned).toEqual([
      { command: '/usr/bin/bwrap', args: [...OPTIONS, '--ro-bind', workspace, workspace, '--bind', HOME, HOME, '--', '/usr/bin/claude', '--output-format', 'stream-json'], cwd: workspace, env: { CLAUDE_CONFIG_DIR: HOME } },
      { command: '/usr/bin/bwrap', args: [...OPTIONS, '--bind', HOME, HOME, '--bind', workspace, workspace, '--', '/usr/bin/claude', '--output-format', 'stream-json'], cwd: workspace, env: { CLAUDE_CONFIG_DIR: HOME } },
    ])
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

describe.skipIf(!BWRAP && !REQUIRED)('claude-agent-sdk under the real bubblewrap: both layers nest on this host (ADR-0038)', () => {
  const root = mkdtempSync(join(tmpdir(), 'system-claude-host-'))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'system', 'claude-home')
  const vaultKey = join(dsh, 'system', 'vault.key')
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  /** A stand-in `claude`: its version, and a signed-in `auth status`; it never runs a task. */
  const claude = join(root, 'bin', 'claude')
  const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => ({ bwrap: BWRAP ?? 'bwrap', hide: [dsh], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] })
  const server = createServer((socket) => socket.end())
  let port = 0
  beforeAll(async () => {
    for (const dir of [home, workspace, outside, join(root, 'bin')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(vaultKey, 'vault key')
    writeFileSync(claude, '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.308 (Claude Code)" ;;\n  auth) echo \'{"loggedIn": true}\' ;;\n  *) exit 2 ;;\nesac\n', { mode: 0o755 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * A command in the sandbox a workspace-write run's settings ask for, rendered as the SDK's
   * sandbox renders them on Linux (bubblewrap): the root read-only, each `allowWrite` path writable,
   * and its own network namespace when no domain is allowed; nested inside the run's confinement.
   */
  const sandboxed = async (script: string): Promise<number> => {
    const settings = commandSandbox(workspace)
    const writable = settings.filesystem?.allowWrite ?? []
    const network = settings.network?.allowedDomains?.length ? [] : ['--unshare-net']
    const inner = ['--die-with-parent', '--new-session', ...network, '--unshare-pid', '--ro-bind', '/', '/', ...writable.flatMap((path) => ['--bind', path, path]), '--dev', '/dev', '--proc', '/proc', '--', 'sh', '-c', script]
    const c = confinedCommand('bwrap', inner, confine({ writable: [home, workspace] }))
    return promisify(execFile)(c.command, c.args).then(() => 0, (error: { code?: number }) => error.code ?? 1)
  }
  const connect = `${process.execPath} -e "require('net').connect(PORT, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(3))"`

  it('proves both layers with the real bubblewrap: reads confined, and a sandbox with no network nested inside', async () => {
    const evidence = await new ClaudeAgentRuntime({ executable: claude, home, confine }).probe()
    expect(evidence).toMatchObject({ available: true, version: '2.1.308', readsConfined: true, executes: true, sandboxes: ['read-only', 'workspace-write'] })
    // Without bubblewrap on Claude Code's PATH the SDK's sandbox cannot start: no executes, the reason named.
    const noNested = await new ClaudeAgentRuntime({ executable: claude, home, confine, env: { PATH: join(root, 'bin') } }).probe()
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

  it('cuts a sandboxed command off the network, while the confinement alone still reaches it (the check can see a connection)', async () => {
    const script = connect.replace('PORT', String(port))
    const c = confinedCommand('sh', ['-c', script], confine({ writable: [home, workspace] }))
    expect(await promisify(execFile)(c.command, c.args).then(() => 0, (error: { code?: number }) => error.code ?? 1)).toBe(0)
    expect(await sandboxed(script)).toBe(3)
  })
})
