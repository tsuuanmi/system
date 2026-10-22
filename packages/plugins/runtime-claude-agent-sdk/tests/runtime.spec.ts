import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meteringOf } from '@tsuuanmi/system-agent-runtime-core'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { ClaudeAgentRuntime, type QueryFn } from '../src/index.ts'

type Call = { prompt: string; options: Record<string, unknown> }

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

const runtime = (query: QueryFn, executable: string | null = '/usr/bin/claude') =>
  new ClaudeAgentRuntime({ query, executable: executable ?? undefined, findExecutable: () => undefined, version: async () => '2.1.294' })

agentRuntimeProviderConformance('claude-agent-sdk', () => runtime(scripted()))

describe('claude-agent-sdk: the configured policy, exactly', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'system-claude-'))
  afterAll(() => rmSync(workspace, { recursive: true, force: true }))

  it('probes the installed Claude Code without running a task, and offers only what it can confine', async () => {
    expect(await runtime(scripted()).probe()).toEqual({
      available: true, detail: 'Claude Code 2.1.294; reads scoped to the workspace', version: '2.1.294', sandboxes: ['read-only', 'workspace-write'], resume: true, executes: false, readsConfined: true, gatesToolCalls: false,
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
      await new ClaudeAgentRuntime({ query: scripted(forwarded), executable: '/usr/bin/claude', forwardEnv: ['ANTHROPIC_API_KEY'] })
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
    await expect(runtime(scripted(calls)).run({ prompt: 'x', workspace, sandbox: 'workspace-write', tools: ['Edit', 'Bash'] }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'config_error', message: expect.stringContaining('Bash') })
    expect(calls).toEqual([])
  })

  it('confines a writable run to its workspace with path-scoped rules (bare rules wrote outside, live 2026-10-12)', async () => {
    const calls: Call[] = []
    await runtime(scripted(calls)).run({ prompt: 'fix it', workspace, sandbox: 'workspace-write' }, new AbortController().signal)
    expect(calls[0]!.options).toMatchObject({
      cwd: workspace, permissionMode: 'dontAsk', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
      allowedTools: ['Read(./**)', 'Grep(./**)', 'Glob(./**)', 'Edit(./**)', 'Write(./**)'],
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
