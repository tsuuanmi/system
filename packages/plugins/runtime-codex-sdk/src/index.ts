/**
 * Agent runtime provider `codex-sdk` (docs/design/agent-runtimes.md, REQ-WRK-5): Codex as a
 * Worker, through the official Codex TypeScript SDK, running the operator's installed `codex`.
 * The configured policy is held by Codex's own sandbox, exactly or refused (never loosened):
 * - the sandbox (`read-only`, or `workspace-write`: writes confined to the workspace) and the
 *   working directory come from configuration; approvals are never asked (`never`), so anything
 *   the sandbox refuses fails instead of waiting for a person;
 * - commands run inside the same sandbox, so a writable Codex Worker can also `validate`;
 * - network access and web search are off, and so are the features whose tools no hook sees or
 *   that start work outside the run (`FEATURES_OFF`);
 * - the `codex` process starts without the daemon's credentials: only the variables the operator
 *   forwards by name (`forwardEnv`) or sets (`env`) reach it (INV-8);
 * - it runs in its own Codex home (`home`, never the operator's `~/.codex`), which must configure
 *   no MCP server: Codex starts those outside its sandbox, so a Worker would reach their tools
 *   (the system MCP server among them). Probe and every run check, and fail closed. The probe also
 *   checks it is signed in there, unless a model provider is configured or an API key forwarded;
 * - Codex has no per-tool allow-list and no turn limit: a configured `tools` or `maxTurns` is
 *   refused, not ignored;
 * - a run's tool gate (`RunSpec.toolGate`) is a PreToolUse hook on every tool, reached through a
 *   private channel of the run (`gate.ts`): `allow` gives no decision, so Codex's sandbox still
 *   decides; `deny` blocks the call with the reason; `defer` blocks it and ends the run. Codex runs
 *   a tool when its hook fails, so the hook blocks on every failure, and a run stops when Codex
 *   reports a tool item its gate never allowed. Codex runs with no terminal (`/dev/ptmx` hidden):
 *   `write_stdin`, which asks no hook, then cannot reach a running command. The probe proves all of
 *   it on this host against a scripted model (`proof.ts`) before it reports `gatesToolCalls`;
 * - Codex's sandbox confines writes only, so Codex starts under the read confinement of
 *   `ctx.agentRuntimes` (ADR-0024): bubblewrap hides the DSH home, its own home bound back,
 *   through an owner-only launcher (the SDK takes a program path, not arguments). The probe
 *   proves the confinement on this host; without it, a run is refused.
 * A turn that fails on a usage limit is `quota_exhausted`, with the reset time Codex's message
 * names as a limit observation, read in the zone the child ran in, on a Codex version whose message
 * was verified (`limits.ts`).
 * Codex's own configuration (its model provider and model) is the operator's, passed as
 * `config`, for example the system Responses gateway. The thread stays native; only its id
 * crosses as the run's handle (INV-7).
 * @module @tsuuanmi/system-runtime-codex-sdk
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type AgentRuntimeProvider, type Confinement, type LimitObservation, type RunResult, type RunSpec, type RuntimeEvidence, type ToolCall, childEnvironment, confinedCommand, proveConfinement,
  withMetering, writeLauncher,
} from '@tsuuanmi/system-agent-runtime-core'
import { dshHome, ensurePrivateDir } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { type Deferral, type GateChannel, hookOverrides, openGateChannel } from './gate.ts'
import { VERIFIED_LIMIT_VERSIONS, childTimeZone, limitFromMessage } from './limits.ts'
import { configOverrides, refused } from './overrides.ts'
import { probeGate, proofFailure, startProbeModel } from './proof.ts'

export { VERIFIED_LIMIT_VERSIONS, childTimeZone, limitFromMessage } from './limits.ts'
export { FEATURES_OFF } from './overrides.ts'

/** The part of a Codex thread a run uses (the SDK's `Thread`, or a test double). */
export interface CodexThread {
  readonly id: string | null
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

export interface CodexClient {
  startThread(options: ThreadOptions): CodexThread
  resumeThread(id: string, options: ThreadOptions): CodexThread
}

/** A confined command line run to its end with an environment; resolves its exit code and stdout. */
export type ConfinedExec = (command: { command: string; args: string[] }, env: Record<string, string>, timeoutMs: number) => Promise<{ code: number | null; stdout: string }>

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
  /** The owner-only directory for launchers and gate channels (default `<DSH_HOME>/system/run`, hidden from Codex). */
  runDir?: string | undefined
  /** The gate hook script (default: `gate-hook.js` beside this module), run with `node`. */
  hook?: string | undefined
  /** The `node` that runs the hook (default: this process's). */
  node?: string | undefined
  client?: (options: CodexOptions) => CodexClient
  /** The enabled MCP servers a Codex home configures (`codex mcp list`). */
  mcpServers?: (home: string, executable: string) => Promise<string[]>
  findExecutable?: () => string | undefined
  version?: (executable: string) => Promise<string>
  /**
   * The read confinement for a Codex child, given the paths it must still reach (its home, its
   * workspace, the gate's channel); `ctx.agentRuntimes.confinement` (ADR-0024). Without it, the
   * runtime offers no Worker.
   */
  confine?: ((bind: { readOnly?: readonly string[]; writable?: readonly string[] }) => Confinement) | undefined
  /** Proves the confinement on this host (default `proveConfinement`). */
  prove?: (confinement: Confinement) => Promise<{ confined: boolean; detail: string }>
  /**
   * Proves Codex's own sandbox still starts inside the confinement (default: `codex sandbox --
   * true`, confined): a host policy can let bubblewrap run yet refuse Codex's nested one.
   */
  nested?: (command: { command: string; args: string[] }, env: Record<string, string>) => Promise<void>
  /** `codex login status` inside the confinement (default: run it); rejects when no one is signed in. */
  status?: (command: { command: string; args: string[] }, env: Record<string, string>) => Promise<void>
  /** Runs the probe's Codex turn (default: spawn it, stdin closed, killed at the timeout). */
  exec?: ConfinedExec
  /** The program the SDK starts for a confined Codex (default: an owner-only launcher script). */
  launcher?: (command: { command: string; args: string[] }) => string
}

/**
 * Paths hidden from every Codex child besides the confinement's own: the terminal devices. No
 * session gets a terminal (`/dev/ptmx`, or where it links into `/dev/pts`), and no process reaches
 * the operator's own terminals (`/dev/pts/<n>`).
 */
export const NO_TERMINAL: readonly string[] = ['/dev/ptmx', '/dev/pts']

/** Codex items that are not a tool's work: messages, reasoning, the plan, errors. Any other item is a tool call's. */
const PLAIN_ITEMS = new Set(['agent_message', 'reasoning', 'todo_list', 'error'])

/** Variables that sign Codex in without its home's login. */
const API_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY']

export class CodexRuntime implements AgentRuntimeProvider {
  readonly kind = 'codex-sdk'

  private readonly home: string
  private readonly runDir: string
  private readonly overrides: string[]

  constructor(private readonly options: RuntimeOptions = {}) {
    const why = refused(options.config ?? {})
    if (why) throw new ProviderError('config_error', `codex-sdk: ${why}; refusing`)
    if (options.home !== undefined && !isAbsolute(options.home)) throw new ProviderError('config_error', 'codex-sdk: home must be an absolute path')
    this.home = options.home ?? join(dshHome(), 'system', 'codex-home')
    this.runDir = options.runDir ?? join(dshHome(), 'system', 'run')
    this.overrides = configOverrides(options.config)
  }

  async probe(): Promise<RuntimeEvidence> {
    const executable = this.executable()
    if (!executable) return unavailable('Codex is not installed (no codex executable on PATH)')
    let version: string
    try {
      const servers = await this.mcpServers(executable)
      if (servers.length) return unavailable(noMcp(this.home, servers))
      version = await (this.options.version ?? codexVersion)(executable)
    } catch (error) {
      return unavailable(`codex --version failed: ${firstLine(error)}`)
    }
    // Codex confines commands in the same OS sandbox as its file writes, so it can validate.
    const found = { available: true, version, sandboxes: ['read-only', 'workspace-write'] as RuntimeEvidence['sandboxes'], resume: true, executes: true }
    // Codex's own sandbox confines writes only; reads are confined around it (ADR-0024).
    if (!this.options.confine) return { ...found, detail: `Codex ${version}; no read confinement is configured`, readsConfined: false, gatesToolCalls: false }
    let confinement: Confinement
    try {
      confinement = this.confinement({ writable: [this.home] })
    } catch (error) {
      return { ...found, detail: `Codex ${version}; ${firstLine(error)}`, readsConfined: false, gatesToolCalls: false }
    }
    const reads = await this.proveReads(executable, confinement)
    if (!reads.confined) return { ...found, detail: `Codex ${version}; ${reads.detail}`, readsConfined: false, gatesToolCalls: false }
    const signedOut = await this.signedOut(executable, confinement)
    if (signedOut) {
      return unavailable(`Codex ${version} is not signed in inside its home ${this.home} (${signedOut}): sign in there (CODEX_HOME=${this.home} codex login), configure a model provider (config), or forward an API key by name (forwardEnv)`)
    }
    const gate = await this.proveGate(executable)
    return { ...found, detail: `Codex ${version}; ${reads.detail}; ${gate.detail}`, readsConfined: true, gatesToolCalls: gate.proven }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    if (!isAbsolute(spec.workspace)) throw new ProviderError('config_error', 'codex-sdk: the workspace must be an absolute path')
    // One account's own home (ADR-0051) is not supported yet: refused, never run in the configured home instead.
    if (spec.home !== undefined) throw new ProviderError('config_error', 'codex-sdk: it runs in its configured home only; refusing a run that names another (RunSpec.home)')
    if (signal.aborted) throw new ProviderError('aborted', 'codex-sdk: the run was stopped before it started')
    if (spec.sandbox !== 'read-only' && spec.sandbox !== 'workspace-write') throw new ProviderError('config_error', `codex-sdk: unknown sandbox ${String(spec.sandbox)}`)
    if (spec.tools?.length) throw new ProviderError('config_error', 'codex-sdk: Codex has no tool allow-list; refusing a configured tools list instead of ignoring it')
    if (spec.maxTurns !== undefined) throw new ProviderError('config_error', 'codex-sdk: Codex has no turn limit; refusing a configured maxTurns instead of ignoring it')
    const executable = this.executable()
    if (!executable) throw new ProviderError('config_error', 'codex-sdk: Codex is not installed (no codex executable on PATH)')
    const servers = await this.mcpServers(executable)
    if (servers.length) throw new ProviderError('config_error', noMcp(this.home, servers))
    if (!this.options.confine) throw new ProviderError('config_error', 'codex-sdk: no read confinement is configured; refusing to run Codex with the host state readable (ADR-0024)')
    if (spec.toolGate) this.checkHook()
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    signal.addEventListener('abort', stop, { once: true })
    let channel: GateChannel | undefined
    let ungated: string | undefined
    let text = ''
    let turns = 0
    let failure: string | undefined
    let id: string | null = null
    let launcher: string | undefined
    // The child's environment, set before Codex starts: its `TZ` is the zone a limit's reset is read in.
    let env: Record<string, string> | undefined
    try {
      if (spec.toolGate) {
        try {
          channel = await openGateChannel({ parent: this.runDir, gate: spec.toolGate, workspace: spec.workspace, signal: controller.signal, onDefer: stop })
        } catch (error) {
          throw new ProviderError('config_error', `codex-sdk: the run's tool gate cannot be reached by its hook: ${firstLine(error)}; nothing was run`, { cause: error })
        }
      }
      // The workspace is bound back as the sandbox allows; Codex's own sandbox still confines writes.
      const own = channel ? [channel.dir, this.hook(), this.node()] : []
      const bind = spec.sandbox === 'workspace-write' ? { writable: [this.home, spec.workspace], readOnly: own } : { writable: [this.home], readOnly: [spec.workspace, ...own] }
      let confined: { command: string; args: string[] }
      try {
        confined = confinedCommand(executable, [], this.confinement(bind))
      } catch (error) {
        throw new ProviderError('config_error', `codex-sdk: ${firstLine(error)}; nothing was run`, { cause: error })
      }
      // A gated run's launcher names its own channel, so it is the run's alone, and removed with it.
      const program = this.options.launcher ? this.options.launcher(confined) : (launcher = defaultLauncher(this.runDir, confined))
      if (!channel) launcher = undefined
      env = this.environment(channel)
      const client = (this.options.client ?? ((options) => new Codex(options)))({
        codexPathOverride: program,
        configOverrides: [...this.overrides, ...(channel ? hookOverrides(this.node(), this.hook()) : [])],
        env,
      })
      const thread: ThreadOptions = {
        workingDirectory: spec.workspace, sandboxMode: spec.sandbox, approvalPolicy: 'never', skipGitRepoCheck: true,
        networkAccessEnabled: false, webSearchMode: 'disabled', ...(spec.model ? { model: spec.model } : {}),
      }
      const handle = spec.resume ? client.resumeThread(spec.resume, thread) : client.startThread(thread)
      const { events } = await handle.runStreamed(spec.prompt, { signal: controller.signal })
      const seen = new Set<string>()
      for await (const event of events) {
        if (event.type === 'thread.started') onHandle?.(event.thread_id)
        else if (event.type === 'turn.completed') turns++
        else if (event.type === 'turn.failed') failure = event.error.message
        else if (event.type === 'error') failure = event.message
        else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
          if (event.type === 'item.completed' && event.item.type === 'agent_message') text = event.item.text
          // A tool's item that no allowed call accounts for ran past the gate: its hook failed or never ran.
          if (channel && !seen.has(event.item.id)) {
            seen.add(event.item.id)
            if (!PLAIN_ITEMS.has(event.item.type) && !channel.consume(event.item.type)) {
              ungated = event.item.type
              stop()
              break
            }
          }
        }
      }
      id = handle.id
    } catch (error) {
      if (signal.aborted) throw new ProviderError('aborted', 'codex-sdk: the run was stopped')
      if (ungated) throw ungatedError(ungated)
      const deferral = channel?.deferral()
      if (deferral) throw deferredError(deferral)
      if (error instanceof ProviderError) throw error
      throw new ProviderError('session_broken', `codex-sdk: ${firstLine(error)}`, { cause: error })
    } finally {
      signal.removeEventListener('abort', stop)
      await channel?.close()
      if (launcher) rmSync(launcher, { force: true })
    }
    if (signal.aborted) throw new ProviderError('aborted', 'codex-sdk: the run was stopped')
    if (ungated) throw ungatedError(ungated)
    // A deferred run did not finish, whatever Codex reported: the call it stopped at never ran.
    const deferral = channel?.deferral()
    if (deferral) throw deferredError(deferral)
    // A failed turn breaks the thread's work (as for Claude): the engine's recovery decides what follows.
    if (failure && !/usage limit|quota|rate limit/i.test(failure)) throw new ProviderError('session_broken', `codex-sdk: ${failure.slice(0, 500)}`)
    if (failure) throw await this.limitError(executable, failure, env!.TZ)
    return { text, ...(id ? { nativeHandle: id } : {}), turns }
  }

  /**
   * The `quota_exhausted` error of a turn that failed on a usage limit, with the limit its message
   * names as an observation (`limits.ts`), in the zone of the child's `TZ` (`tz`, else the host's):
   * read only on a Codex version whose message was verified and in a zone that can be read, and
   * otherwise named as not read in the error, so the run's limit closes the pool for the Worker's
   * cooldown (never open).
   */
  private async limitError(executable: string, failure: string, tz: string | undefined): Promise<ProviderError> {
    const message = `codex-sdk: ${failure.slice(0, 500)}`
    const observedAt = Date.now()
    let version: string
    try {
      version = await (this.options.version ?? codexVersion)(executable)
    } catch (error) {
      return new ProviderError('quota_exhausted', `${message} (its reset time is not read: codex --version failed: ${firstLine(error)})`)
    }
    if (!VERIFIED_LIMIT_VERSIONS.includes(version)) {
      return new ProviderError('quota_exhausted', `${message} (its reset time is not read: the usage-limit message of Codex ${version} is not verified)`)
    }
    const zone = childTimeZone(tz)
    if (!zone) return new ProviderError('quota_exhausted', `${message} (its reset time is not read: Codex ran with TZ=${JSON.stringify(tz)}, no time zone it can be read in)`)
    const limit: LimitObservation | undefined = limitFromMessage(failure, observedAt, zone)
    return limit ? withMetering(new ProviderError('quota_exhausted', message), { limits: [limit] }) : new ProviderError('quota_exhausted', message)
  }

  /** The read confinement for one Codex child, with no terminal device (`NO_TERMINAL`). */
  private confinement(bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement {
    const confinement = this.options.confine!(bind)
    const checked = { ...confinement, hide: [...confinement.hide, ...NO_TERMINAL] }
    // A bind that would expose a hidden path throws here, before anything starts.
    confinedCommand('true', [], checked)
    return checked
  }

  /** Codex's environment: without the daemon's credentials (INV-8), in its own home, with the gate's channel. */
  private environment(channel?: GateChannel): Record<string, string> {
    return childEnvironment(this.options.forwardEnv, { ...this.options.env, CODEX_HOME: this.home, ...channel?.env })
  }

  private hook(): string {
    return this.options.hook ?? fileURLToPath(new URL('./gate-hook.js', import.meta.url))
  }

  private node(): string {
    return this.options.node ?? process.execPath
  }

  /** The hook script and `node` exist: a gated run without them would run its tools unasked. */
  private checkHook(): void {
    for (const [what, path] of [['the gate hook', this.hook()], ['node', this.node()]] as const) {
      try {
        accessSync(path, constants.R_OK)
      } catch {
        throw new ProviderError('config_error', `codex-sdk: ${what} ${path} cannot be read; refusing a gated run`)
      }
    }
  }

  private async proveReads(executable: string, confinement: Confinement): Promise<{ confined: boolean; detail: string }> {
    const reads = await (this.options.prove ?? proveConfinement)(confinement)
    if (!reads.confined) return reads
    try {
      await (this.options.nested ?? runQuiet)(confinedCommand(executable, ['sandbox', '--', 'true'], confinement), childEnvironment([], { CODEX_HOME: this.home }))
      return reads
    } catch (error) {
      return { confined: false, detail: `Codex's own sandbox does not start inside the confinement: ${firstLine(error)}` }
    }
  }

  /**
   * Why Codex is not signed in inside its home, or undefined when it is, or needs no login: a
   * configured model provider (other than the built-in one), or an API key forwarded by name.
   */
  private async signedOut(executable: string, confinement: Confinement): Promise<string | undefined> {
    const provider = this.options.config?.model_provider
    if (typeof provider === 'string' && provider !== 'openai') return undefined
    if ([...this.options.forwardEnv ?? [], ...Object.keys(this.options.env ?? {})].some((name) => API_KEYS.includes(name))) return undefined
    try {
      await (this.options.status ?? loginStatus)(confinedCommand(executable, ['login', 'status'], confinement), this.environment())
      return undefined
    } catch (error) {
      return `codex login status: ${firstLine(error)}`
    }
  }

  /**
   * Proves on this host that a gated run's hook answers before each tool call, its deny holds, and no
   * terminal session starts, with Codex's own configuration and confinement and a scripted model
   * (`proof.ts`). Nothing reaches a model provider, and nothing is kept in Codex's home (`--ephemeral`).
   */
  private async proveGate(executable: string): Promise<{ proven: boolean; detail: string }> {
    const no = (why: string) => ({ proven: false, detail: `tool calls cannot be gated: ${why}` })
    try {
      this.checkHook()
    } catch (error) {
      return no((error as Error).message.replace(/^codex-sdk: /, ''))
    }
    const nonce = randomBytes(8).toString('hex')
    const calls: ToolCall[] = []
    const controller = new AbortController()
    let work: string | undefined
    let channel: GateChannel | undefined
    let model: Awaited<ReturnType<typeof startProbeModel>> | undefined
    try {
      ensurePrivateDir(this.runDir)
      work = mkdtempSync(join(this.runDir, 'codex-probe-'))
      model = await startProbeModel(nonce)
      channel = await openGateChannel({ parent: this.runDir, gate: probeGate(nonce, calls), workspace: work, signal: controller.signal, onDefer: () => undefined })
      const confinement = this.confinement({ writable: [this.home], readOnly: [work, channel.dir, this.hook(), this.node()] })
      const provider = `model_providers.system-gate-probe={name="system gate probe",base_url=${JSON.stringify(model.baseUrl)},wire_api="responses",request_max_retries=0,stream_max_retries=0}`
      const args = [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', work,
        ...[...this.overrides, ...hookOverrides(this.node(), this.hook()), 'model_provider="system-gate-probe"', provider, 'approval_policy="never"', 'web_search="disabled"']
          .flatMap((o) => ['--config', o]),
        '--model', 'system-gate-probe', 'Reply as the scripted model says.',
      ]
      const { code, stdout } = await (this.options.exec ?? execConfined)(confinedCommand(executable, args, confinement), this.environment(channel), 60_000)
      const why = proofFailure(nonce, calls, model, stdout)
      if (why) return no(why)
      if (code !== 0) return no(`Codex exited with ${String(code)}`)
      return { proven: true, detail: 'tool calls gated: a PreToolUse hook answered before each tool call, its deny held, and no terminal session started' }
    } catch (error) {
      return no(firstLine(error))
    } finally {
      controller.abort()
      await channel?.close()
      await model?.close()
      if (work) rmSync(work, { recursive: true, force: true })
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

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 160)

const deferredError = (d: Deferral): ProviderError => new ProviderError('config_error',
  `codex-sdk: the run stopped at tool call ${d.tool}${d.callId ? ` (${d.callId})` : ''} without running it: ${d.reason.slice(0, 300)} (approval request ${d.requestId})`)

const ungatedError = (item: string): ProviderError => new ProviderError('config_error',
  `codex-sdk: Codex reported a ${item} item that the run's tool gate never allowed (its PreToolUse hook failed or did not run); the run was stopped`)

const unavailable = (detail: string): RuntimeEvidence => ({ available: false, detail, sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false })

/** An owner-only launcher in the run directory (`<DSH_HOME>/system/run`), which the confinement then hides from Codex. */
function defaultLauncher(dir: string, command: { command: string; args: string[] }): string {
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

/** Runs a command to its end; rejects on a non-zero exit. */
async function runQuiet(command: { command: string; args: string[] }, env: Record<string, string>): Promise<void> {
  await promisify(execFile)(command.command, command.args, { timeout: 15_000, env })
}

/** `codex login status`, confined: rejects with what it printed when it exits non-zero ("Not logged in"). */
async function loginStatus(command: { command: string; args: string[] }, env: Record<string, string>): Promise<void> {
  try {
    await promisify(execFile)(command.command, command.args, { timeout: 15_000, env })
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown }
    const said = `${String(stdout ?? '')}\n${String(stderr ?? '')}`.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
    throw new Error(said?.slice(0, 160) || firstLine(error))
  }
}

/** Runs the probe's Codex turn: stdin closed (Codex otherwise waits for more input), stdout kept, killed at the timeout. */
const execConfined: ConfinedExec = (command, env, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(command.command, command.args, { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, killSignal: 'SIGKILL' })
  const chunks: Buffer[] = []
  let size = 0
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= 4 * 1024 * 1024) chunks.push(chunk)
  })
  child.once('error', reject)
  child.once('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }))
})

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
  config: z.dict(z.any()).description('Codex --config overrides, such as model_provider and model_providers (operator configuration); no mcp_servers, no hooks, and no feature the runtime keeps off'),
  env: z.dict(z.string()).description('Explicit environment for the codex process (no secrets; use forwardEnv)'),
  forwardEnv: z.array(z.string()).description('Daemon environment variables forwarded by name, such as the one a provider env_key names'),
  home: z.string().description('The Workers\' Codex home (CODEX_HOME; default <DSH_HOME>/system/codex-home), never the operator\'s ~/.codex; it must configure no MCP server; sign in there once'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.agentRuntimes.register(new CodexRuntime({
    executable: config.executable, config: config.config, env: config.env, forwardEnv: config.forwardEnv, home: config.home,
    confine: (bind) => ctx.agentRuntimes.confinement(bind),
  }))
}
