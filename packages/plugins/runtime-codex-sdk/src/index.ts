/**
 * Agent runtime provider `codex-sdk` (docs/design/agent-runtimes.md, REQ-WRK-5): Codex as a
 * Worker, through the official Codex TypeScript SDK, running the operator's installed `codex`.
 * The configured policy is held by Codex's own sandbox, exactly or refused (never loosened):
 * - the sandbox (`read-only`, or `workspace-write`: writes confined to the workspace) and the
 *   working directory come from configuration; approvals are never asked (`never`), so anything
 *   the sandbox refuses fails instead of waiting for a person;
 * - commands run inside the same sandbox, so a writable Codex Worker can also `validate`;
 * - network access and web search are off;
 * - the `codex` process starts without the daemon's credentials: only the variables the operator
 *   forwards by name (`forwardEnv`) or sets (`env`) reach it (INV-8);
 * - it runs in its own Codex home (`home`, never the operator's `~/.codex`), which must configure
 *   no MCP server: Codex starts those outside its sandbox, so a Worker would reach their tools
 *   (the system MCP server among them). Probe and every run check, and fail closed;
 * - Codex has no per-tool allow-list and no turn limit: a configured `tools` or `maxTurns` is
 *   refused, not ignored;
 * - Codex's sandbox confines writes only, so Codex starts under the read confinement of
 *   `ctx.agentRuntimes` (ADR-0024): bubblewrap hides the DSH home, its own home bound back,
 *   through an owner-only launcher (the SDK takes a program path, not arguments). The probe
 *   proves the confinement on this host; without it, a run is refused.
 * Codex's own configuration (its model provider and model) is the operator's, passed as
 * `config`, for example the system Responses gateway. The thread stays native; only its id
 * crosses as the run's handle (INV-7).
 * @module @tsuuanmi/system-runtime-codex-sdk
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type AgentRuntimeProvider, type Confinement, type RunResult, type RunSpec, type RuntimeEvidence, childEnvironment, confinedCommand, proveConfinement, writeLauncher } from '@tsuuanmi/system-agent-runtime-core'
import { dshHome, ensurePrivateDir } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'

/** The part of a Codex thread a run uses (the SDK's `Thread`, or a test double). */
export interface CodexThread {
  readonly id: string | null
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

export interface CodexClient {
  startThread(options: ThreadOptions): CodexThread
  resumeThread(id: string, options: ThreadOptions): CodexThread
}

export interface RuntimeOptions {
  /** The `codex` executable; found on PATH when absent. */
  executable?: string | undefined
  /** Codex `--config` overrides, such as its model provider (operator configuration). */
  config?: Record<string, unknown> | undefined
  /** Explicit environment for the `codex` process (no secrets: they belong in `forwardEnv`). */
  env?: Record<string, string> | undefined
  /** Daemon environment variables forwarded by name, such as the one a provider's `env_key` names. */
  forwardEnv?: string[] | undefined
  /** The Workers' Codex home (`CODEX_HOME`; default `<DSH_HOME>/system/codex-home`), never the operator's. */
  home?: string | undefined
  client?: (options: CodexOptions) => CodexClient
  /** The enabled MCP servers a Codex home configures (`codex mcp list`). */
  mcpServers?: (home: string, executable: string) => Promise<string[]>
  findExecutable?: () => string | undefined
  version?: (executable: string) => Promise<string>
  /**
   * The read confinement for a Codex child, given the paths it must still write (its home);
   * `ctx.agentRuntimes.confinement` (ADR-0024). Without it, the runtime offers no Worker.
   */
  confine?: ((bind: { readOnly?: readonly string[]; writable?: readonly string[] }) => Confinement) | undefined
  /** Proves the confinement on this host (default `proveConfinement`). */
  prove?: (confinement: Confinement) => Promise<{ confined: boolean; detail: string }>
  /**
   * Proves Codex's own sandbox still starts inside the confinement (default: `codex sandbox --
   * true`, confined): a host policy can let bubblewrap run yet refuse Codex's nested one.
   */
  nested?: (command: { command: string; args: string[] }, env: Record<string, string>) => Promise<void>
  /** The program the SDK starts for a confined Codex (default: an owner-only launcher script). */
  launcher?: (command: { command: string; args: string[] }) => string
}

export class CodexRuntime implements AgentRuntimeProvider {
  readonly kind = 'codex-sdk'

  private readonly home: string

  constructor(private readonly options: RuntimeOptions = {}) {
    if (options.config && 'mcp_servers' in options.config) {
      throw new ProviderError('config_error', 'codex-sdk: mcp_servers in config would reach the Worker outside its sandbox; refusing')
    }
    this.home = options.home ?? join(dshHome(), 'system', 'codex-home')
  }

  async probe(): Promise<RuntimeEvidence> {
    const executable = this.executable()
    if (!executable) return unavailable('Codex is not installed (no codex executable on PATH)')
    try {
      const servers = await this.mcpServers(executable)
      if (servers.length) return unavailable(noMcp(this.home, servers))
      const version = await (this.options.version ?? codexVersion)(executable)
      // Codex's own sandbox confines writes only; reads are confined around it (ADR-0024).
      const reads = this.options.confine
        ? await this.proveReads(executable, this.options.confine({ writable: [this.home] }))
        : { confined: false, detail: 'no read confinement is configured' }
      // Codex confines commands in the same OS sandbox as its file writes, so it can validate.
      return {
        available: true, detail: `Codex ${version}; ${reads.detail}`, version, sandboxes: ['read-only', 'workspace-write'], resume: true, executes: true, readsConfined: reads.confined,
      }
    } catch (error) {
      return unavailable(`codex --version failed: ${(error as Error).message.slice(0, 160)}`)
    }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    if (!isAbsolute(spec.workspace)) throw new ProviderError('config_error', 'codex-sdk: the workspace must be an absolute path')
    if (signal.aborted) throw new ProviderError('aborted', 'codex-sdk: the run was stopped before it started')
    if (spec.sandbox !== 'read-only' && spec.sandbox !== 'workspace-write') throw new ProviderError('config_error', `codex-sdk: unknown sandbox ${String(spec.sandbox)}`)
    if (spec.tools?.length) throw new ProviderError('config_error', 'codex-sdk: Codex has no tool allow-list; refusing a configured tools list instead of ignoring it')
    if (spec.maxTurns !== undefined) throw new ProviderError('config_error', 'codex-sdk: Codex has no turn limit; refusing a configured maxTurns instead of ignoring it')
    const executable = this.executable()
    if (!executable) throw new ProviderError('config_error', 'codex-sdk: Codex is not installed (no codex executable on PATH)')
    const servers = await this.mcpServers(executable)
    if (servers.length) throw new ProviderError('config_error', noMcp(this.home, servers))
    if (!this.options.confine) throw new ProviderError('config_error', 'codex-sdk: no read confinement is configured; refusing to run Codex with the host state readable (ADR-0024)')
    // The workspace is bound back as the sandbox allows; Codex's own sandbox still confines writes.
    const workspace = spec.sandbox === 'workspace-write' ? { writable: [this.home, spec.workspace] } : { writable: [this.home], readOnly: [spec.workspace] }
    const confined = confinedCommand(executable, [], this.options.confine(workspace))
    const client = (this.options.client ?? ((options) => new Codex(options)))({
      codexPathOverride: (this.options.launcher ?? defaultLauncher)(confined),
      ...(this.options.config ? { config: this.options.config as NonNullable<CodexOptions['config']> } : {}),
      env: childEnvironment(this.options.forwardEnv, { ...this.options.env, CODEX_HOME: this.home }),
    })
    const thread: ThreadOptions = {
      workingDirectory: spec.workspace, sandboxMode: spec.sandbox, approvalPolicy: 'never', skipGitRepoCheck: true,
      networkAccessEnabled: false, webSearchMode: 'disabled', ...(spec.model ? { model: spec.model } : {}),
    }
    const handle = spec.resume ? client.resumeThread(spec.resume, thread) : client.startThread(thread)
    const { events } = await handle.runStreamed(spec.prompt, { signal })
    let text = ''
    let turns = 0
    let failure: string | undefined
    for await (const event of events) {
      if (event.type === 'thread.started') onHandle?.(event.thread_id)
      else if (event.type === 'item.completed' && event.item.type === 'agent_message') text = event.item.text
      else if (event.type === 'turn.completed') turns++
      else if (event.type === 'turn.failed') failure = event.error.message
      else if (event.type === 'error') failure = event.message
    }
    if (signal.aborted) throw new ProviderError('aborted', 'codex-sdk: the run was stopped')
    // A failed turn breaks the thread's work (as for Claude): the engine's recovery decides what follows.
    if (failure) throw new ProviderError(/usage limit|quota|rate limit/i.test(failure) ? 'quota_exhausted' : 'session_broken', `codex-sdk: ${failure.slice(0, 500)}`)
    return { text, ...(handle.id ? { nativeHandle: handle.id } : {}), turns }
  }

  private async proveReads(executable: string, confinement: Confinement): Promise<{ confined: boolean; detail: string }> {
    const reads = await (this.options.prove ?? proveConfinement)(confinement)
    if (!reads.confined) return reads
    try {
      await (this.options.nested ?? nestedSandbox)(confinedCommand(executable, ['sandbox', '--', 'true'], confinement), childEnvironment([], { CODEX_HOME: this.home }))
      return reads
    } catch (error) {
      return { confined: false, detail: `Codex's own sandbox does not start inside the confinement: ${(error as Error).message.split('\n')[0]!.slice(0, 160)}` }
    }
  }

  private async mcpServers(executable: string): Promise<string[]> {
    if (this.options.mcpServers) return this.options.mcpServers(this.home, executable)
    ensurePrivateDir(this.home)
    return codexMcpServers(this.home, executable)
  }

  private executable(): string | undefined {
    return this.options.executable ?? (this.options.findExecutable ?? (() => findOnPath('codex')))()
  }
}

const unavailable = (detail: string): RuntimeEvidence => ({ available: false, detail, sandboxes: [], resume: false, executes: false, readsConfined: false })

/** An owner-only launcher under `<DSH_HOME>/system/run`, which the confinement then hides from Codex. */
function defaultLauncher(command: { command: string; args: string[] }): string {
  const dir = join(dshHome(), 'system', 'run')
  ensurePrivateDir(dir)
  return writeLauncher(dir, 'codex-sdk', command)
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return undefined
}

const noMcp = (home: string, servers: string[]): string =>
  `codex-sdk: the Codex home ${home} configures MCP server(s) ${servers.join(', ')}, which a Worker would reach outside its sandbox; remove them (codex mcp remove) or give the runtime another home`

/** The enabled MCP servers of a Codex home, from `codex mcp list --json`. */
async function codexMcpServers(home: string, executable: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)(executable, ['mcp', 'list', '--json'], { timeout: 15_000, env: childEnvironment([], { CODEX_HOME: home }) })
  const servers = JSON.parse(stdout) as Array<{ name: string; enabled?: boolean }>
  return servers.filter((s) => s.enabled !== false).map((s) => s.name)
}

async function nestedSandbox(command: { command: string; args: string[] }, env: Record<string, string>): Promise<void> {
  await promisify(execFile)(command.command, command.args, { timeout: 15_000, env })
}

async function codexVersion(executable: string): Promise<string> {
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 15_000 })
  return stdout.trim().replace(/^codex-cli\s+/, '')
}

export interface Config {
  executable?: string
  config?: Record<string, unknown>
  env?: Record<string, string>
  forwardEnv?: string[]
  home?: string
}

export const name = 'runtime-codex-sdk'
export const inject = ['agentRuntimes']
export const Config: z<Config> = z.object({
  executable: z.string().description('Path to the codex executable (default: found on PATH)'),
  config: z.dict(z.any()).description('Codex --config overrides, such as model_provider and model_providers (operator configuration)'),
  env: z.dict(z.string()).description('Explicit environment for the codex process (no secrets; use forwardEnv)'),
  forwardEnv: z.array(z.string()).description('Daemon environment variables forwarded by name, such as the one a provider env_key names'),
  home: z.string().description('The Workers\' Codex home (CODEX_HOME; default <DSH_HOME>/system/codex-home); it must configure no MCP server'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.agentRuntimes.register(new CodexRuntime({
    executable: config.executable, config: config.config, env: config.env, forwardEnv: config.forwardEnv, home: config.home,
    confine: (bind) => ctx.agentRuntimes.confinement(bind),
  }))
}
