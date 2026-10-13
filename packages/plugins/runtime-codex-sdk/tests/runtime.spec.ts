import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import { describe, expect, it } from 'vitest'
import { agentRuntimeProviderConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import type { Confinement } from '@tsuuanmi/system-agent-runtime-core'
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
  const client = (options: { codexPathOverride?: string; config?: unknown; env?: Record<string, string> }): CodexClient => {
    lastClient.program = options.codexPathOverride
    lastClient.config = options.config
    lastClient.env = options.env
    return { startThread: (o) => thread(undefined, o), resumeThread: (id, o) => thread(id, o) }
  }
  const lastClient: { program?: string | undefined; config?: unknown; env?: Record<string, string> | undefined } = {}
  return { calls, client, lastClient }
}

const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confinement = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: '/usr/bin/bwrap', hide: ['/dsh'], readOnly: ['/dsh/system/tools', ...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}
const confined = {
  confine: confinement, prove: async () => ({ confined: true, detail: 'host state hidden by /usr/bin/bwrap' }), nested: async () => undefined,
  launcher: (c: { command: string; args: string[] }) => `launcher:${[c.command, ...c.args].join(' ')}`,
}
const runtime = (s = scripted(), extra: Partial<ConstructorParameters<typeof CodexRuntime>[0]> = {}) =>
  new CodexRuntime({ executable: '/usr/bin/codex', home: '/codex-home', client: s.client, version: async () => '0.162.1', mcpServers: async () => [], ...confined, ...extra })

agentRuntimeProviderConformance('codex-sdk', () => runtime())

describe('codex-sdk runtime (REQ-WRK-5, REQ-WRK-6)', () => {
  it('probes the installed codex: both sandboxes, resumable, and able to run confined commands', async () => {
    expect(await runtime().probe()).toMatchObject({
      available: true, detail: 'Codex 0.162.1; host state hidden by /usr/bin/bwrap', sandboxes: ['read-only', 'workspace-write'], resume: true, executes: true, readsConfined: true,
    })
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

  it('runs Codex in its own home, never the operator\'s (whose MCP servers would reach the Worker)', async () => {
    const s = scripted()
    await runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)
    expect(s.lastClient.env).toMatchObject({ CODEX_HOME: '/codex-home' })
  })

  it('starts Codex through bubblewrap with the host state hidden and only its own home writable (ADR-0024)', async () => {
    const s = scripted()
    await runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)
    // Paths that do not exist on this host are skipped, so only the options and the command remain.
    expect(s.lastClient.program).toBe('launcher:/usr/bin/bwrap --die-with-parent --unshare-pid --new-session --dev-bind / / --proc /proc -- /usr/bin/codex')
    // Its home is bound back writable; a read-only Worker's workspace read-only.
    expect(binds.at(-1)).toEqual({ writable: ['/codex-home'], readOnly: ['/w'] })
    await runtime(s).run({ prompt: 'x', workspace: '/w', sandbox: 'workspace-write' }, new AbortController().signal)
    expect(binds.at(-1)).toEqual({ writable: ['/codex-home', '/w'] })
  })

  it('offers no Worker, and runs nothing, when reads cannot be confined (ADR-0024, REQ-WRK-6)', async () => {
    const failed = runtime(scripted(), { prove: async () => ({ confined: false, detail: 'reads cannot be confined: bwrap missing' }) })
    expect(await failed.probe()).toMatchObject({ readsConfined: false, detail: expect.stringContaining('reads cannot be confined') })
    // A host policy can let bubblewrap run, yet refuse Codex's own sandbox inside it.
    const nested = runtime(scripted(), { nested: async () => { throw new Error('bwrap: setting up uid map: Permission denied') } })
    expect(await nested.probe()).toMatchObject({ readsConfined: false, detail: expect.stringContaining('Codex\'s own sandbox does not start inside the confinement') })
    const s = scripted()
    const none = runtime(s, { confine: undefined })
    expect(await none.probe()).toMatchObject({ readsConfined: false, detail: expect.stringContaining('no read confinement') })
    await expect(none.run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    expect(s.calls).toEqual([])
  })

  it('fails closed when its Codex home has an MCP server: the Worker would reach tools outside its sandbox', async () => {
    const homes: string[] = []
    const withServer = (s = scripted()) => runtime(s, { mcpServers: async (home) => (homes.push(home), ['system']) })
    expect(await withServer().probe()).toMatchObject({ available: false, detail: expect.stringMatching(/MCP server.*system/) })
    const s = scripted()
    await expect(withServer(s).run({ prompt: 'x', workspace: '/w', sandbox: 'read-only' }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    expect(s.calls).toEqual([])
    expect(homes).toEqual(['/codex-home', '/codex-home'])
    // An MCP server given through configuration is refused the same way.
    expect(() => new CodexRuntime({ config: { mcp_servers: { x: { command: 'y' } } } })).toThrow(/mcp_servers/)
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
