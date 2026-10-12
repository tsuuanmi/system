import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import { describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { type CodexClient, CodexRuntime } from '../src/index.ts'

/** A Codex stand-in: records what it was asked, and streams the events a real thread would. */
function scripted(script: (prompt: string) => ThreadEvent[] = (prompt) => [
  { type: 'thread.started', thread_id: 'h-1' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: `echo: ${prompt}` } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
]) {
  const calls: Array<{ resume?: string; options: ThreadOptions; prompt?: string; config?: unknown; env?: Record<string, string> | undefined }> = []
  const thread = (resume: string | undefined, options: ThreadOptions) => {
    const call: (typeof calls)[number] = { ...(resume ? { resume } : {}), options }
    calls.push(call)
    let id: string | null = resume ?? null
    return {
      get id() { return id },
      runStreamed: async (prompt: string) => {
        call.prompt = prompt
        const events = script(prompt)
        return {
          events: (async function* () {
            for (const event of events) {
              if (event.type === 'thread.started') id = event.thread_id
              yield event
            }
          })(),
        }
      },
    }
  }
  const client = (options: { config?: unknown; env?: Record<string, string> }): CodexClient => {
    lastClient.config = options.config
    lastClient.env = options.env
    return { startThread: (o) => thread(undefined, o), resumeThread: (id, o) => thread(id, o) }
  }
  const lastClient: { config?: unknown; env?: Record<string, string> | undefined } = {}
  return { calls, client, lastClient }
}

const runtime = (s = scripted(), extra: Partial<ConstructorParameters<typeof CodexRuntime>[0]> = {}) =>
  new CodexRuntime({ executable: '/usr/bin/codex', client: s.client, version: async () => '0.162.1', ...extra })

agentRuntimeProviderConformance('codex-sdk', () => runtime())

describe('codex-sdk runtime (REQ-WRK-5, REQ-WRK-6)', () => {
  it('probes the installed codex: both sandboxes, resumable, and able to run confined commands', async () => {
    expect(await runtime().probe()).toMatchObject({ available: true, detail: 'Codex 0.162.1', sandboxes: ['read-only', 'workspace-write'], resume: true, executes: true })
    expect(await new CodexRuntime({ findExecutable: () => undefined }).probe()).toMatchObject({ available: false, sandboxes: [] })
  })

  it('holds a run to the configured policy: its sandbox and workspace, no approvals, no network, no web search', async () => {
    const s = scripted()
    await runtime(s, { config: { model_provider: 'system' }, env: { SYSTEM_MCP_TOKEN: 't' } }).run({ prompt: 'fix it', workspace: '/w', sandbox: 'workspace-write', model: 'system-standard' }, new AbortController().signal)
    expect(s.calls[0]).toMatchObject({ prompt: 'fix it', options: { workingDirectory: '/w', sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', model: 'system-standard' } })
    expect(s.lastClient.config).toEqual({ model_provider: 'system' })
    expect(s.lastClient.env).toMatchObject({ SYSTEM_MCP_TOKEN: 't', PATH: process.env.PATH })
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
