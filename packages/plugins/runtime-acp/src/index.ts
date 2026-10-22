/**
 * Agent runtime providers `acp:<name>` (docs/design/agent-runtimes.md): any Agent Client
 * Protocol agent as a Worker, through the official ACP SDK, spawned as a subprocess in its
 * workspace. ACP gives the client the permission decisions and the file reads, so the client
 * side enforces the policy:
 * - every permission request is rejected;
 * - file reads are served inside the workspace only (symlinks resolved); no write and no
 *   terminal capability is advertised; no MCP server is passed;
 * - what ACP cannot express exactly (a tool list, a model, a turn limit, a tool gate) is refused;
 * - the agent starts without the daemon's credentials: only the variables the operator forwards
 *   by name (`forwardEnv`) or sets (`env`) reach it (INV-8);
 * - an aborted run cancels the prompt, then ends the agent: SIGTERM, then SIGKILL. Under the
 *   confinement the signal ends bubblewrap, and everything in the agent's PID namespace dies
 *   with it, children included;
 * - the agent runs under the read confinement (ADR-0024): it can act on the disk without asking,
 *   so host state is hidden from its process, not only from the reads it asks the client for.
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
import { type AgentRuntimeProvider, type Confinement, type RunResult, type RunSpec, type RuntimeEvidence, childEnvironment, confinedCommand, proveConfinement } from '@tsuuanmi/system-agent-runtime-core'
import { ProviderError, type ProviderErrorKind } from '@tsuuanmi/system-provider-core'

export interface AcpAgentConfig {
  /** The runtime kind is `acp:<name>`. */
  name: string
  command: string
  args?: string[]
  /** Explicit environment for the agent (no secrets: they belong in `forwardEnv`). */
  env?: Record<string, string>
  /** Daemon environment variables forwarded by name, such as an API key the agent needs. */
  forwardEnv?: string[]
  /** The operator vouches that this agent asks permission before acting (default false). */
  honoursPermissions?: boolean
}

const PROBE_MS = 15_000
const CLIENT_INFO = { name: 'system', version: '0.0.0' }

export interface AcpTiming {
  /** After an abort, how long the agent has to honour the cancel before it is ended (default 3 s). */
  cancelMs?: number
  /** After SIGTERM, how long before SIGKILL (default 5 s). */
  killMs?: number
}

export interface AcpConfinement {
  /** The read confinement for the agent (`ctx.agentRuntimes.confinement`). Without it, no Worker. */
  confine?: ((bind: { readOnly?: readonly string[]; writable?: readonly string[] }) => Confinement) | undefined
  /** Proves the confinement on this host (default `proveConfinement`). */
  prove?: (confinement: Confinement) => Promise<{ confined: boolean; detail: string }>
}

export class AcpAgentRuntime implements AgentRuntimeProvider {
  readonly kind: string
  private readonly timing: Required<AcpTiming>

  constructor(private readonly agent: AcpAgentConfig, timing: AcpTiming = {}, private readonly reads: AcpConfinement = {}) {
    this.kind = `acp:${agent.name}`
    this.timing = { cancelMs: 3000, killMs: 5000, ...timing }
  }

  async probe(): Promise<RuntimeEvidence> {
    // The handshake only: nothing is asked of the agent, and anything it asks is refused.
    const session = this.spawn('/', [], (): Client => ({
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async () => undefined,
    }))
    try {
      const init = await withTimeout(session.connection.initialize({
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO,
      }), PROBE_MS)
      const info = init.agentInfo as { name?: string; version?: string } | undefined
      const reads = this.reads.confine
        ? await (this.reads.prove ?? proveConfinement)(this.reads.confine({}))
        : { confined: false, detail: 'no read confinement is configured' }
      return {
        available: true,
        detail: `ACP agent ${info?.name ?? this.agent.name}${info?.version ? ` ${info.version}` : ''} (protocol ${init.protocolVersion}); ${reads.detail}`,
        ...(info?.version ? { version: info.version } : {}),
        sandboxes: this.agent.honoursPermissions ? ['read-only'] : [],
        resume: init.agentCapabilities?.loadSession === true,
        executes: false,
        readsConfined: reads.confined,
        // An agent asks the client only for what it chooses to: not every tool call reaches a gate.
        gatesToolCalls: false,
      }
    } catch (error) {
      return {
        available: false, detail: `${this.kind}: ${(error as Error).message.slice(0, 160)}${session.stderr() ? ` (${session.stderr().slice(0, 120)})` : ''}`,
        sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false,
      }
    } finally {
      session.close()
    }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    if (!isAbsolute(spec.workspace)) throw new ProviderError('config_error', `${this.kind}: the workspace must be an absolute path`)
    if (spec.sandbox !== 'read-only') throw new ProviderError('config_error', `${this.kind}: only read-only is offered; the client cannot confine an agent's own writes`)
    if (!this.agent.honoursPermissions) throw new ProviderError('config_error', `${this.kind}: no policy can be enforced on an agent the operator has not vouched for (honoursPermissions)`)
    for (const [field, value] of [['a tool list', spec.tools?.length], ['a model', spec.model], ['a turn limit', spec.maxTurns], ['a tool gate', spec.toolGate]] as const) {
      if (value) throw new ProviderError('config_error', `${this.kind}: ACP cannot express ${field}; refusing instead of ignoring it`)
    }
    if (!this.reads.confine) throw new ProviderError('config_error', `${this.kind}: no read confinement is configured; refusing to run the agent with the host state readable (ADR-0024)`)
    if (signal.aborted) throw new ProviderError('aborted', `${this.kind}: aborted before starting`)
    const root = await realpath(spec.workspace)
    let text = ''
    const session = this.spawn(spec.workspace, [spec.workspace], (): Client => ({
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
      setTimeout(() => session.close(), this.timing.cancelMs).unref()
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

  private spawn(cwd: string, readOnly: string[], client: () => Client): { connection: ClientSideConnection; close: () => void; stderr: () => string } {
    // The probe's handshake runs confined too when it can, so it proves the agent starts that way.
    const { command, args } = this.reads.confine
      ? confinedCommand(this.agent.command, this.agent.args ?? [], this.reads.confine({ readOnly }))
      : { command: this.agent.command, args: this.agent.args ?? [] }
    const child: ChildProcess = spawn(command, args, { cwd, env: childEnvironment(this.agent.forwardEnv, this.agent.env), stdio: ['pipe', 'pipe', 'pipe'] })
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
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        // An agent that ignores SIGTERM is killed, so nothing waits on it forever.
        const kill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, this.timing.killMs)
        kill.unref()
        child.once('exit', () => clearTimeout(kill))
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
    env: z.dict(z.string()).default({}).description('Explicit environment for the agent (no secrets; use forwardEnv)'),
    forwardEnv: z.array(z.string()).default([]).description('Daemon environment variables forwarded by name, such as an API key the agent needs'),
    honoursPermissions: z.boolean().default(false).description('The operator vouches that the agent asks permission before acting'),
  })).default([]).description('ACP agents, each registered as the runtime acp:<name>'),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config = { agents: [] }): void {
  for (const agent of config.agents ?? []) ctx.agentRuntimes.register(new AcpAgentRuntime(agent, {}, { confine: (bind) => ctx.agentRuntimes.confinement(bind) }))
}
