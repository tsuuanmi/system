/**
 * Agent runtime providers `acp:<name>` (docs/design/agent-runtimes.md): any Agent Client
 * Protocol agent as a Worker, through the official ACP SDK, spawned as a subprocess in its
 * workspace. ACP gives the client the permission decisions and the file reads, so the client
 * side enforces the policy:
 * - every permission request is rejected;
 * - file reads are served inside the workspace only (symlinks resolved); no write and no
 *   terminal capability is advertised; no MCP server is passed;
 * - what ACP cannot express exactly (a tool list, a model, a turn limit) is refused.
 * An agent can still act on its own without asking, so `read-only` is offered only for an
 * agent the operator vouches for in configuration (`honoursPermissions`, INV-6); any other
 * agent offers no sandbox and stays unavailable as a Worker.
 * @module @tsuuanmi/system-runtime-acp
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { type Client, ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentRuntimeProvider, RunResult, RunSpec, RuntimeEvidence } from '@tsuuanmi/system-agent-runtime-core'
import { ProviderError, type ProviderErrorKind } from '@tsuuanmi/system-provider-core'

export interface AcpAgentConfig {
  /** The runtime kind is `acp:<name>`. */
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** The operator vouches that this agent asks permission before acting (default false). */
  honoursPermissions?: boolean
}

const PROBE_MS = 15_000
const CLIENT_INFO = { name: 'system', version: '0.0.0' }

export class AcpAgentRuntime implements AgentRuntimeProvider {
  readonly kind: string

  constructor(private readonly agent: AcpAgentConfig) {
    this.kind = `acp:${agent.name}`
  }

  async probe(): Promise<RuntimeEvidence> {
    // The handshake only: nothing is asked of the agent, and anything it asks is refused.
    const session = this.spawn(process.cwd(), (): Client => ({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined,
    }))
    try {
      const init = await withTimeout(session.connection.initialize({
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO,
      }), PROBE_MS)
      const info = init.agentInfo as { name?: string; version?: string } | undefined
      return {
        available: true,
        detail: `ACP agent ${info?.name ?? this.agent.name}${info?.version ? ` ${info.version}` : ''} (protocol ${init.protocolVersion})`,
        ...(info?.version ? { version: info.version } : {}),
        sandboxes: this.agent.honoursPermissions ? ['read-only'] : [],
        resume: init.agentCapabilities?.loadSession === true,
        executes: false,
      }
    } catch (error) {
      return { available: false, detail: `${this.kind}: ${(error as Error).message.slice(0, 160)}${session.stderr() ? ` (${session.stderr().slice(0, 120)})` : ''}`, sandboxes: [], resume: false, executes: false }
    } finally {
      session.close()
    }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    if (!isAbsolute(spec.workspace)) throw new ProviderError('config_error', `${this.kind}: the workspace must be an absolute path`)
    if (spec.sandbox !== 'read-only') throw new ProviderError('config_error', `${this.kind}: only read-only is offered; the client cannot confine an agent's own writes`)
    if (!this.agent.honoursPermissions) throw new ProviderError('config_error', `${this.kind}: no policy can be enforced on an agent the operator has not vouched for (honoursPermissions)`)
    for (const [field, value] of [['a tool list', spec.tools?.length], ['a model', spec.model], ['a turn limit', spec.maxTurns]] as const) {
      if (value) throw new ProviderError('config_error', `${this.kind}: ACP cannot express ${field}; refusing instead of ignoring it`)
    }
    if (signal.aborted) throw new ProviderError('aborted', `${this.kind}: aborted before starting`)
    const root = await realpath(spec.workspace)
    let text = ''
    const session = this.spawn(spec.workspace, (): Client => ({
      requestPermission: async (params) => {
        const reject = params.options.find((o) => o.kind === 'reject_once') ?? params.options.find((o) => o.kind === 'reject_always')
        return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } }
      },
      sessionUpdate: async (notification) => {
        const update = notification.update as { sessionUpdate: string; content?: { type: string; text?: string } }
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += update.content.text ?? ''
      },
      readTextFile: async (params) => {
        const content = await readFile(await inside(root, params.path), 'utf8')
        const lines = content.split('\n')
        const start = Math.max(0, (params.line ?? 1) - 1)
        return { content: params.line || params.limit ? lines.slice(start, params.limit ? start + params.limit : undefined).join('\n') : content }
      },
    }))
    let sessionId: string | undefined
    const abort = (): void => {
      if (sessionId) void session.connection.cancel({ sessionId }).catch(() => undefined)
      setTimeout(() => session.close(), 3000).unref()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const init = await session.connection.initialize({
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO,
      })
      if (spec.resume) {
        if (init.agentCapabilities?.loadSession !== true) throw new ProviderError('config_error', `${this.kind}: the agent cannot load a session`)
        await session.connection.loadSession({ sessionId: spec.resume, cwd: spec.workspace, mcpServers: [] })
        // A loaded session replays its history as updates; only this prompt's answer counts.
        text = ''
        sessionId = spec.resume
      } else {
        sessionId = (await session.connection.newSession({ cwd: spec.workspace, mcpServers: [] })).sessionId
      }
      onHandle?.(sessionId)
      if (signal.aborted) abort()
      const response = await session.connection.prompt({ sessionId, prompt: [{ type: 'text', text: spec.prompt }] })
      if (signal.aborted || response.stopReason === 'cancelled') throw new ProviderError('aborted', `${this.kind}: aborted`)
      if (response.stopReason !== 'end_turn') throw new ProviderError(stopKind(response.stopReason), `${this.kind}: stopped (${response.stopReason})`)
      return { text, nativeHandle: sessionId }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      if (signal.aborted) throw new ProviderError('aborted', `${this.kind}: aborted`)
      throw new ProviderError('session_broken', `${this.kind}: ${(error as Error).message?.slice(0, 300) ?? String(error)}${session.stderr() ? ` (${session.stderr().slice(0, 160)})` : ''}`, { cause: error })
    } finally {
      signal.removeEventListener('abort', abort)
      session.close()
    }
  }

  private spawn(cwd: string, client: () => Client): { connection: ClientSideConnection; close: () => void; stderr: () => string } {
    const child: ChildProcess = spawn(this.agent.command, this.agent.args ?? [], { cwd, env: { ...process.env, ...this.agent.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    const exited = new Promise<Error>((resolve) => {
      child.once('error', (error) => resolve(error))
      child.once('exit', (code, sig) => resolve(new Error(`the agent exited (${sig ?? code})`)))
    })
    const connection = new ClientSideConnection(client, ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>))
    // A dead agent fails pending calls instead of leaving them waiting.
    const guard = new Proxy(connection, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => Promise.race([(value as (...a: unknown[]) => Promise<unknown>).apply(target, args), exited.then((error) => Promise.reject(error))])
      },
    })
    return {
      connection: guard,
      close: () => {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
      },
      stderr: () => stderr.trim(),
    }
  }
}

/** The real path of `path` if it lies inside `root` (already real); otherwise a refusal. */
async function inside(root: string, path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`refused: ${path} is not an absolute path`)
  const real = await realpath(path).catch(() => {
    throw new Error(`refused: ${path} does not exist`)
  })
  const rel = relative(root, real)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === '..') throw new Error(`refused: ${path} is outside the workspace`)
  return real
}

function stopKind(reason: string): ProviderErrorKind {
  if (reason === 'max_tokens' || reason === 'max_turn_requests') return 'timeout'
  if (reason === 'refusal') return 'invalid_input'
  return 'session_broken'
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

export interface Config {
  agents: AcpAgentConfig[]
}

export const name = 'runtime-acp'
export const inject = ['agentRuntimes']
export const Config: z<Config> = z.object({
  agents: z.array(z.object({
    name: z.string().pattern(/^[a-z][a-z0-9-]*$/).required(),
    command: z.string().required(),
    args: z.array(z.string()).default([]),
    env: z.dict(z.string()).default({}),
    honoursPermissions: z.boolean().default(false).description('The operator vouches that the agent asks permission before acting'),
  })).default([]).description('ACP agents, each registered as the runtime acp:<name>'),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config = { agents: [] }): void {
  for (const agent of config.agents ?? []) ctx.agentRuntimes.register(new AcpAgentRuntime(agent))
}
