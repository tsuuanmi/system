import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { ClaudeAgentRuntime, type QueryFn } from '../src/index.ts'

type Call = { prompt: string; options: Record<string, unknown> }

/** A scripted Claude Code: it answers with the prompt, as the SDK's message stream would. */
function scripted(calls: Call[] = [], result: Record<string, unknown> = {}): QueryFn {
  return ((params: { prompt: string; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} })
    const signal = (params.options?.abortController as AbortController | undefined)?.signal
    return (async function* () {
      if (signal?.aborted) throw new Error('aborted by the caller')
      yield { type: 'system', subtype: 'init', session_id: 'h-1' }
      yield { type: 'result', subtype: 'success', is_error: false, result: `echo: ${params.prompt}`, session_id: 'h-1', num_turns: 2, total_cost_usd: 0.01, ...result }
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
      available: true, detail: 'Claude Code 2.1.294; reads scoped to the workspace', version: '2.1.294', sandboxes: ['read-only', 'workspace-write'], resume: true, executes: false, readsConfined: true,
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
    expect(result).toEqual({ text: 'echo: review', nativeHandle: 'h-1', turns: 2, costUsd: 0.01 })
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
