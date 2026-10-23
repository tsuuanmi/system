/**
 * Agent runtime provider `antigravity-cli` (docs/design/agent-runtimes.md): the Antigravity CLI
 * (`agy`) as a Worker, in print mode (`--print`, `--output-format stream-json`), running the
 * operator's installed `agy`. The configured policy is held exactly, or the run is refused:
 * - Antigravity has no per-tool allow-list or workspace-scoped permission a headless run can be
 *   held to, so every tool call passes its PreToolUse hook, bridged to this process
 *   (`bridge.ts`): the runtime's own rules first (the sandbox's tools only, every location inside
 *   the workspace, no customization root written: `policy.ts`), then the run's tool gate. The hook
 *   answers `allow` only when both allow: the rules are the runtime's policy, so nothing is left
 *   for Antigravity's own permission prompts, which a headless run cannot show;
 * - it runs in a home of its own (`HOME`, where agy keeps its sign-in, settings, conversations,
 *   and customizations; never the operator's `~/.gemini`, which the read confinement hides), with
 *   the XDG directories inside it, its auto-update off, and no MCP server, plugin, or hook but the
 *   runtime's own: probe and every run check, and fail closed;
 * - a workspace whose customization roots (`.agents/` and its spellings, up to the repository
 *   root) hold hooks, MCP servers, or plugins is refused: agy would run them outside every gate;
 * - agy starts under the read confinement of `ctx.agentRuntimes` (ADR-0024): bubblewrap hides the
 *   host state; its home comes back writable, the workspace as the sandbox allows, and the run's
 *   gate directory read-only;
 * - agy starts without the daemon's credentials: only the variables the operator forwards by name
 *   (`forwardEnv`) or sets (`env`) reach it (INV-8);
 * - what Antigravity cannot express exactly is refused: a turn limit, continuing a conversation
 *   (not proven), and a tool gate while the Worker source's gate does not classify its tools.
 * The probe reports `sandboxes` only when the hook layer is proven on this host, as an ACP agent
 * offers none unless vouched for: without the hook, nothing would hold a policy. It proves the
 * bridge's half (the hook command, run as agy runs it inside the confinement, reaches the run's
 * gate), not agy's half: that agy runs the hook before each tool call takes a model turn to show.
 * It never reports `executes` (agy's terminal sandbox has no model-free proof, and commands are
 * never offered) or `resume`. The conversation stays native; only its id crosses as the run's
 * handle (INV-7). What a run consumed is read from agy's own result, never from the model's text.
 * @module @tsuuanmi/system-runtime-antigravity-cli
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type AgentRuntimeProvider, type Confinement, type RunMetering, type RunResult, type RunSpec, type RuntimeEvidence, type TokenUsage, type ToolGate,
  askToolGate, childEnvironment, confinedCommand, proveConfinement, withMetering,
} from '@tsuuanmi/system-agent-runtime-core'
import { dshHome } from '@tsuuanmi/system-libs'
import { ProviderError, type ProviderErrorKind } from '@tsuuanmi/system-provider-core'
import { type ConfinedExec, type HookAnswer, type HookEvent, HOOK_ENV, SELF_TEST_REASON, TOKEN_ENV, execConfined, openChannel, prepareHome, selfTest } from './bridge.ts'
import { TOOLS, refusal, workspaceCustomizations } from './policy.ts'

export { HOOKS_JSON, HOOK_COMMAND, prepareHome } from './bridge.ts'
export { READ_TOOLS, TOOLS, WRITE_TOOLS, refusal, workspaceCustomizations } from './policy.ts'

const KIND = 'antigravity-cli'

/**
 * agy versions on which a supervised live session showed the PreToolUse hook running before every
 * tool step, with the tool names and inputs `policy.ts` uses: none yet. The probe can prove the
 * bridge's half on the host, never agy's (that takes a model turn), so without a version here the
 * hook layer is not proven, no sandbox is offered, and no run starts
 * (docs/operations/runbooks.md#antigravity-cli-workers).
 */
export const VERIFIED_HOOK_VERSIONS: readonly string[] = []

/**
 * Whether the `agents` source's tool gate classifies Antigravity's tool names: it does not yet. It
 * classifies Claude Code's tools and denies any other (docs/design/approvals.md#how-a-call-is-classified),
 * so a gated run could do nothing; until it does, this runtime reports `gatesToolCalls: false` and
 * refuses a gated run, and the `agents` source admits none of its Workers.
 */
const GATE_CLASSIFIES_TOOLS = false

/** How long the gate may take over one tool call; past it the call is denied. */
const GATE_MS = 30_000
/** One request through the bridge, the gate included; below the hook script's own 45 s. */
const REQUEST_MS = 40_000
/** After SIGTERM, how long before SIGKILL. */
const KILL_MS = 5000
/** The prompt is agy's argument (`--print=`): Linux takes at most 128 KiB in one argument. */
const MAX_PROMPT_BYTES = 100_000
/** The longest stream-json line read; a longer one fails the run. */
const MAX_LINE = 8 << 20
/** The most of agy's stderr kept for an error message. */
const MAX_STDERR = 8192

/** A command line, confined, run with agy's environment in its home; resolves its stdout, rejects on a non-zero exit. */
export type { ConfinedExec } from './bridge.ts'

/** Starts the confined agy process (default: `spawn`, stdout and stderr piped). */
export type SpawnAgy = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcess

/**
 * Whether the hook layer holds on this host for an agy `version`, given the bridge's self-test
 * (`test`), which runs the hook inside the confinement. Default {@link proveHooks}.
 */
export type HookProof = (version: string, test: () => Promise<{ ok: boolean; detail: string }>) => Promise<{ proven: boolean; detail: string }>

/** The bridge's self-test, and agy's half from {@link VERIFIED_HOOK_VERSIONS}. */
export const proveHooks: HookProof = async (version, test) => {
  const bridge = await test()
  if (!bridge.ok) return { proven: false, detail: bridge.detail }
  if (!VERIFIED_HOOK_VERSIONS.includes(version)) {
    return { proven: false, detail: `${bridge.detail}; that agy ${version} runs it before each tool call is not proven (it takes a model turn to show, and no live check of this version is recorded), so no sandbox is offered` }
  }
  return { proven: true, detail: `${bridge.detail}; agy ${version} runs it before each tool call (verified live)` }
}

export interface RuntimeOptions {
  /** The `agy` executable; found on PATH when absent. */
  executable?: string | undefined
  /** Explicit environment for agy (no secrets: they belong in `forwardEnv`). */
  env?: Record<string, string> | undefined
  /** Daemon environment variables forwarded by name, such as an API key agy should use. */
  forwardEnv?: string[] | undefined
  /** The Workers' Antigravity home (agy's `HOME`; default `<DSH_HOME>/system/antigravity-home`), never the operator's. */
  home?: string | undefined
  /**
   * The read confinement for an agy child, given the paths it must still reach (its home, its
   * workspace, the run's gate directory); `ctx.agentRuntimes.confinement` (ADR-0024). Without it, no run starts.
   */
  confine?: ((bind: { readOnly?: readonly string[]; writable?: readonly string[] }) => Confinement) | undefined
  /** Proves the confinement on this host (default `proveConfinement`). */
  prove?: (confinement: Confinement) => Promise<{ confined: boolean; detail: string }>
  /** Runs a confined command: agy's sign-in and plugin checks, and the hook's self-test (default `execFile`, bounded). */
  exec?: ConfinedExec
  /** Whether the hook layer holds (default {@link proveHooks}). */
  hooks?: HookProof | undefined
  /** Starts the confined agy process (default: `spawn`). */
  spawn?: SpawnAgy
  findExecutable?: () => string | undefined
  /** `agy --version`, with agy's environment (default: run it). */
  version?: (executable: string, env: Record<string, string>) => Promise<string>
  /** Where each run's owner-only gate directory is made (default `<DSH_HOME>/system/run`, hidden from every agent). */
  runRoot?: string | undefined
  /** The node executable that runs the hook (default: this process's). */
  node?: string | undefined
  /** Whether the Worker source's gate classifies Antigravity's tools (default false, {@link GATE_CLASSIFIES_TOOLS}); its tests drive the gate path with it. */
  gateClassifies?: boolean | undefined
  /** Bounds (tests shorten them). */
  timing?: { gateMs?: number; requestMs?: number; killMs?: number } | undefined
}

/** The tool call a run's gate deferred: the run stops there. */
interface Deferral {
  tool: string
  callId?: string | undefined
  requestId: string
  reason: string
}

export class AntigravityRuntime implements AgentRuntimeProvider {
  readonly kind = KIND
  private readonly home: string

  constructor(private readonly options: RuntimeOptions = {}) {
    if (options.home !== undefined && !isAbsolute(options.home)) throw new ProviderError('config_error', `${KIND}: home must be an absolute path`)
    this.home = options.home ?? join(dshHome(), 'system', 'antigravity-home')
  }

  async probe(): Promise<RuntimeEvidence> {
    const executable = this.executable()
    if (!executable) return unavailable('the Antigravity CLI is not installed (no agy executable on PATH)')
    let version: string
    try {
      version = await (this.options.version ?? agyVersion)(executable, this.environment())
    } catch (error) {
      return unavailable(`agy --version failed: ${firstLine(error)}`)
    }
    const home = this.homeProblem()
    if (home) return unavailable(home)
    // Nothing can run here, but what is missing is said (INV-2).
    const none = (detail: string): RuntimeEvidence => ({ available: true, detail: `Antigravity CLI ${version}; ${detail}`, version, sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false })
    if (!this.options.confine) return none('no read confinement is configured')
    const confinement = this.options.confine({ writable: [this.home] })
    const reads = await (this.options.prove ?? proveConfinement)(confinement)
    if (!reads.confined) return none(reads.detail)
    const env = this.environment()
    const signedOut = await this.signedOut(executable, confinement, env)
    if (signedOut) {
      return unavailable(`Antigravity CLI ${version} is not signed in inside its home ${this.home} (${signedOut}): sign in there once (docs/operations/runbooks.md#antigravity-cli-workers), or forward an API key by name (forwardEnv)`)
    }
    const plugins = await this.pluginProblem(executable, confinement, env)
    if (plugins) return unavailable(plugins)
    const hooks = await this.proveHooks(version, (dir) => this.options.confine!({ writable: [this.home], readOnly: [dir] }))
    const gates = hooks.proven && this.gateClassifies()
    return {
      available: true,
      detail: `Antigravity CLI ${version}; ${reads.detail}; ${hooks.detail}${gates ? '' : '; the agents source\'s tool gate does not classify Antigravity\'s tools, so a run with a gate is refused'}`,
      version, sandboxes: hooks.proven ? ['read-only', 'workspace-write'] : [], resume: false, executes: false, readsConfined: true, gatesToolCalls: gates,
    }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    if (!isAbsolute(spec.workspace)) throw new ProviderError('config_error', `${KIND}: the workspace must be an absolute path`)
    const offered = TOOLS[spec.sandbox]
    if (!offered) throw new ProviderError('config_error', `${KIND}: unknown sandbox ${String(spec.sandbox)}`)
    // Absent or empty means the sandbox's set.
    const tools = spec.tools?.length ? spec.tools : offered
    const refused = tools.filter((tool) => !offered.includes(tool))
    if (refused.length) throw new ProviderError('config_error', `${KIND}: a ${spec.sandbox} run offers only ${offered.join(', ')}; refusing ${refused.join(', ')}`)
    if (spec.maxTurns !== undefined) throw new ProviderError('config_error', `${KIND}: agy has no turn limit; refusing a configured maxTurns instead of ignoring it`)
    if (spec.resume) throw new ProviderError('config_error', `${KIND}: continuing a conversation is not proven for agy; refusing instead of starting a new one`)
    if (spec.toolGate && !this.gateClassifies()) {
      throw new ProviderError('config_error', `${KIND}: the run's tool gate does not classify Antigravity's tools and would deny every call; refusing a gated run until it does`)
    }
    if (Buffer.byteLength(spec.prompt) > MAX_PROMPT_BYTES) throw new ProviderError('invalid_input', `${KIND}: the prompt is longer than agy takes as an argument (${MAX_PROMPT_BYTES} bytes)`)
    const executable = this.executable()
    if (!executable) throw new ProviderError('config_error', `${KIND}: the Antigravity CLI is not installed (no agy executable on PATH)`)
    if (signal.aborted) throw new ProviderError('aborted', `${KIND}: aborted before starting`)
    if (!this.options.confine) throw new ProviderError('config_error', `${KIND}: no read confinement is configured; refusing to run agy with the host state readable (ADR-0024)`)
    const customized = workspaceCustomizations(spec.workspace)
    if (customized.length) {
      throw new ProviderError('config_error', `${KIND}: ${customized.join(', ')} would run hooks, MCP servers, or plugins outside the run's gate; refusing the workspace until they are removed`)
    }
    const home = this.homeProblem()
    if (home) throw new ProviderError('config_error', `${home}; nothing was run`)
    const version = await (this.options.version ?? agyVersion)(executable, this.environment()).catch((error: unknown) => {
      throw new ProviderError('config_error', `${KIND}: agy --version failed: ${firstLine(error)}`)
    })

    const run = new Run(spec, tools, signal, this.options.timing?.gateMs ?? GATE_MS)
    const channel = await openChannel(this.options.runRoot ?? join(dshHome(), 'system', 'run'), this.options.node ?? process.execPath, (event) => run.decide(event), {
      requestMs: this.options.timing?.requestMs ?? REQUEST_MS,
    }).catch((error: unknown) => {
      throw new ProviderError('config_error', `${KIND}: the run's gate cannot be opened: ${firstLine(error)}; nothing was run`, { cause: error })
    })
    try {
      const writes = spec.sandbox === 'workspace-write'
      const confinement = this.confinement(writes ? { writable: [this.home, spec.workspace], readOnly: [channel.dir] } : { writable: [this.home], readOnly: [spec.workspace, channel.dir] })
      const env = this.environment(channel.env)
      // The hook layer must hold for this run: its hook reaches its gate from inside its confinement.
      const hooks = await (this.options.hooks ?? proveHooks)(version, () => selfTest(this.home, confinement, env, this.exec()))
      if (!hooks.proven) throw new ProviderError('config_error', `${KIND}: ${hooks.detail}; refusing a run whose tool calls nothing would hold`)
      if (signal.aborted) throw new ProviderError('aborted', `${KIND}: aborted before starting`)
      run.arm()
      return await this.drive(run, executable, confinement, env, signal, onHandle)
    } finally {
      await channel.close()
    }
  }

  /** Start agy on the run, read its stream to the end, and turn what it reported into the run's outcome. */
  private async drive(run: Run, executable: string, confinement: Confinement, env: Record<string, string>, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    const { spec } = run
    const args = [`--print=${spec.prompt}`, '--output-format', 'stream-json', '--disable-slash-commands', ...(spec.model ? [`--model=${spec.model}`] : [])]
    const c = confinedCommand(executable, args, confinement)
    const child = (this.options.spawn ?? spawnPiped)(c.command, c.args, { cwd: spec.workspace, env })
    const killMs = this.options.timing?.killMs ?? KILL_MS
    let killTimer: NodeJS.Timeout | undefined
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      // Under the confinement the signal ends bubblewrap, and its PID namespace with it; one that ignores it is killed.
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, killMs)
    }
    run.onStop(stop)
    signal.addEventListener('abort', stop, { once: true })
    const stream = new StreamReader(onHandle)
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR) stderr += chunk
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (!stream.push(chunk)) stop()
    })
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }))
      child.once('close', (code) => resolve({ code }))
    })
    clearTimeout(killTimer)
    signal.removeEventListener('abort', stop)
    stream.end()
    const metering = (): RunMetering => stream.metering()
    const errorText = stderr.trim().split('\n').filter(Boolean).slice(-3).join('; ').slice(0, 300)
    // The caller refused the handle (its run was taken over, say): its error, as it threw it.
    if (stream.handleError !== undefined) throw stream.handleError
    if (signal.aborted) throw withMetering(new ProviderError('aborted', `${KIND}: aborted`), metering())
    const deferred = run.deferral()
    // A deferred run did not finish, whatever agy reported: the call it stopped at never ran.
    if (deferred) throw withMetering(deferredError(deferred), metering())
    if (exit.error) throw withMetering(new ProviderError('config_error', `${KIND}: agy could not be started: ${exit.error.message.slice(0, 200)}`), metering())
    if (stream.overflow) throw withMetering(new ProviderError('session_broken', `${KIND}: agy wrote a stream-json line longer than ${MAX_LINE} bytes`), metering())
    const result = stream.result
    if (!result) throw withMetering(new ProviderError(failureKind(errorText), `${KIND}: agy ended without a result (exit ${exit.code ?? 'by signal'})${errorText ? `: ${errorText}` : ''}`), metering())
    const failure = typeof result.error === 'string' && result.error ? result.error : undefined
    if (exit.code !== 0 || result.status === 'ERROR' || failure) {
      const text = failure ?? errorText
      throw withMetering(new ProviderError(failureKind(text), `${KIND}: ${String(result.status ?? 'failed')}${text ? `: ${text.slice(0, 300)}` : ''}`), metering())
    }
    return { text: typeof result.response === 'string' ? result.response : '', ...(stream.handle ? { nativeHandle: stream.handle } : {}), ...metering() }
  }

  private executable(): string | undefined {
    return this.options.executable ?? (this.options.findExecutable ?? (() => onPath('agy')))()
  }

  private exec(): ConfinedExec {
    return this.options.exec ?? execConfined
  }

  private gateClassifies(): boolean {
    return this.options.gateClassifies ?? GATE_CLASSIFIES_TOOLS
  }

  /** What in the runtime's home would reach a Worker outside its gate, or why the home cannot be used; undefined when it is fit. */
  private homeProblem(): string | undefined {
    try {
      const problems = prepareHome(this.home)
      return problems.length ? `${KIND}: ${problems.join('; ')}, which a Worker would reach outside its gate: remove them, or give the runtime another home` : undefined
    } catch (error) {
      return `${KIND}: its home ${this.home} cannot be used: ${firstLine(error)}`
    }
  }

  /**
   * agy's environment: without the daemon's credentials (INV-8), in its own home, with every XDG
   * directory inside it (so nothing reaches the operator's), its auto-update off, and no D-Bus (so
   * its sign-in is the file in its home). The hook's variables come from the run alone: one set or
   * forwarded otherwise is dropped, never trusted.
   */
  private environment(gate: Record<string, string> = {}): Record<string, string> {
    const env = childEnvironment(this.options.forwardEnv, {
      ...this.options.env,
      HOME: this.home, XDG_CONFIG_HOME: join(this.home, '.config'), XDG_CACHE_HOME: join(this.home, '.cache'),
      XDG_DATA_HOME: join(this.home, '.local', 'share'), XDG_STATE_HOME: join(this.home, '.local', 'state'),
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    })
    delete env[HOOK_ENV]
    delete env[TOKEN_ENV]
    return { ...env, ...gate }
  }

  /** The confinement of one run, checked before anything starts: no bind exposes a hidden path. */
  private confinement(bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement {
    try {
      const confinement = this.options.confine!(bind)
      confinedCommand('true', [], confinement)
      return confinement
    } catch (error) {
      throw new ProviderError('config_error', `${KIND}: ${firstLine(error)}; nothing was run`, { cause: error })
    }
  }

  /** Why agy is not signed in inside its home, or undefined when it is: `agy models` under the confinement succeeds. */
  private async signedOut(executable: string, confinement: Confinement, env: Record<string, string>): Promise<string | undefined> {
    try {
      await this.exec()(confinedCommand(executable, ['models'], confinement), { env, cwd: this.home })
      return undefined
    } catch (error) {
      return `agy models failed: ${firstLine(error)}`
    }
  }

  /** The plugins agy would load from its home (`agy plugin list --json`): none may be enabled, since they bundle hooks and MCP servers. */
  private async pluginProblem(executable: string, confinement: Confinement, env: Record<string, string>): Promise<string | undefined> {
    try {
      const listed = JSON.parse(await this.exec()(confinedCommand(executable, ['plugin', 'list', '--json'], confinement), { env, cwd: this.home })) as unknown
      if (!Array.isArray(listed)) return `${KIND}: agy plugin list --json did not answer a list`
      const enabled = listed.filter((p) => (p as { enabled?: unknown }).enabled !== false).map((p) => String((p as { name?: unknown }).name ?? '?'))
      return enabled.length ? `${KIND}: the home ${this.home} has plugin(s) ${enabled.join(', ')} enabled, whose hooks and MCP servers a Worker would reach outside its gate: disable or remove them (HOME=${this.home} agy plugin disable <name>)` : undefined
    } catch (error) {
      return `${KIND}: agy plugin list failed: ${firstLine(error)}`
    }
  }

  /** The hook layer, with a channel of its own that answers the self-test only. */
  private async proveHooks(version: string, confine: (dir: string) => Confinement): Promise<{ proven: boolean; detail: string }> {
    let channel: Awaited<ReturnType<typeof openChannel>> | undefined
    try {
      channel = await openChannel(this.options.runRoot ?? join(dshHome(), 'system', 'run'), this.options.node ?? process.execPath, async () => ({ decision: 'deny', reason: SELF_TEST_REASON }))
      const dir = channel.dir
      return await (this.options.hooks ?? proveHooks)(version, () => selfTest(this.home, confine(dir), this.environment(channel!.env), this.exec()))
    } catch (error) {
      return { proven: false, detail: `the hook's gate cannot be opened: ${firstLine(error)}` }
    } finally {
      await channel?.close()
    }
  }
}

/** One run's state, as its gate channel sees it. */
class Run {
  private armed = false
  private deferred: Deferral | undefined
  private stopper: (() => void) | undefined
  private readonly stopped = new AbortController()
  /** Aborts a gate still deciding when the run is aborted or stops at a deferred call. */
  private readonly ending: AbortSignal

  constructor(readonly spec: RunSpec, private readonly tools: readonly string[], signal: AbortSignal, private readonly gateMs: number) {
    this.ending = AbortSignal.any([signal, this.stopped.signal])
  }

  /** From here on the channel answers the agent's calls; before, only the self-test's. */
  arm(): void {
    this.armed = true
  }

  onStop(stop: () => void): void {
    this.stopper = stop
  }

  deferral(): Deferral | undefined {
    return this.deferred
  }

  /**
   * One tool call: denied once the run stopped at a deferred call; then the runtime's own rules;
   * then the run's gate, bounded. A `defer` is denied to agy (it has no way to wait on one), and
   * the run is stopped there: it fails naming the request, and no further call runs.
   */
  async decide(event: HookEvent): Promise<HookAnswer> {
    if (!this.armed) return { decision: 'deny', reason: SELF_TEST_REASON }
    const stopped = this.deferred
    if (stopped) return deny(`the run stopped at tool call ${stopped.tool}, which waits for approval request ${stopped.requestId}; no further tool call runs`)
    const refused = refusal(event, this.spec.workspace, this.tools)
    if (refused) return deny(refused)
    const gate: ToolGate | undefined = this.spec.toolGate
    if (!gate) return { decision: 'allow' }
    const verdict = await askToolGate(gate, { tool: event.tool, input: event.input, ...(event.callId ? { callId: event.callId } : {}) }, this.ending, this.gateMs)
    if (verdict.decision === 'allow') return { decision: 'allow' }
    if (verdict.decision === 'defer') {
      if (this.deferred) return deny(`the run stopped at tool call ${this.deferred.tool}, which waits for approval request ${this.deferred.requestId}; no further tool call runs`)
      this.deferred = { tool: event.tool, callId: event.callId, requestId: verdict.requestId, reason: verdict.reason }
      this.stopped.abort()
      setImmediate(() => this.stopper?.())
      return deny(`${verdict.reason} (approval request ${verdict.requestId}); the run stops at this call`)
    }
    return deny(verdict.reason)
  }
}

const deny = (reason: string): HookAnswer => ({ decision: 'deny', reason: reason.slice(0, 1000) })

const deferredError = (d: Deferral): ProviderError => new ProviderError('config_error',
  `${KIND}: the run stopped at tool call ${d.tool}${d.callId ? ` (${d.callId})` : ''} without running it: ${d.reason.slice(0, 300)} (approval request ${d.requestId})`)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined)

/**
 * agy's stream-json, one JSON object per line, each naming its `event` with its payload under that
 * name (`{"event":"result","result":{…}}`). Read: the conversation id, from the first event that
 * carries one (reported as the run's handle at once); the main model, from the first that names
 * one; and the `result`. A line that is not a JSON object is skipped; one longer than
 * {@link MAX_LINE} stops the run.
 */
class StreamReader {
  handle: string | undefined
  model: string | undefined
  result: Record<string, unknown> | undefined
  overflow = false
  /** What `onHandle` threw: the run stops, and fails with it. */
  handleError: unknown
  private buffered = ''

  constructor(private readonly onHandle?: (handle: string) => void) {}

  /** Takes a chunk of stdout; false once the run must stop (a line too long, a handle refused). */
  push(chunk: string): boolean {
    if (!this.reading()) return false
    this.buffered += chunk
    let end = this.buffered.indexOf('\n')
    while (end >= 0 && this.reading()) {
      this.line(this.buffered.slice(0, end))
      this.buffered = this.buffered.slice(end + 1)
      end = this.buffered.indexOf('\n')
    }
    if (this.buffered.length > MAX_LINE) this.overflow = true
    return this.reading()
  }

  end(): void {
    if (this.reading() && this.buffered.trim()) this.line(this.buffered)
    this.buffered = ''
  }

  private reading(): boolean {
    return !this.overflow && this.handleError === undefined
  }

  private line(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!isObject(message)) return
    const name = typeof message.event === 'string' ? message.event : undefined
    const payload = name && isObject(message[name]) ? message[name] as Record<string, unknown> : message
    const id = [payload.conversation_id, message.conversation_id].find((v): v is string => typeof v === 'string' && v.length > 0)
    if (id && !this.handle) {
      this.handle = id
      try {
        this.onHandle?.(id)
      } catch (error) {
        this.handleError = error ?? new Error('the handle was refused')
      }
    }
    if (typeof payload.model === 'string' && payload.model) this.model ??= payload.model
    if (name === 'result') this.result = payload
  }

  /** What the run consumed, from agy's own result: its turns and usage; the model when an event named it. */
  metering(): RunMetering {
    const metering: RunMetering = {}
    if (this.result) {
      const turns = count(this.result.num_turns)
      if (turns !== undefined) metering.turns = turns
      const usage = usageFrom(this.result.usage)
      if (usage) metering.usage = usage
    }
    if (this.model) metering.model = this.model
    return metering
  }
}

/**
 * The result's `usage`, normalized as the ledger counts it (input includes its cached part, output
 * its thinking), or undefined when it cannot be read exactly. agy reports `input_tokens`,
 * `output_tokens`, `thinking_tokens`, `cache_read_tokens`, and `total_tokens`; which counts include
 * which is not documented, so the total decides: input either includes the cache read or not, and
 * output either includes the thinking or not, and the one reading whose sum is the total is taken
 * (two readings that both fit give the same numbers). No total, with a cache read or thinking to
 * place, or no reading that fits: no usage (a missing number stays missing).
 */
export function usageFrom(raw: unknown): TokenUsage | undefined {
  if (!isObject(raw)) return undefined
  const input = count(raw.input_tokens)
  const output = count(raw.output_tokens)
  if (input === undefined || output === undefined) return undefined
  const cache = count(raw.cache_read_tokens) ?? 0
  const thinking = count(raw.thinking_tokens) ?? 0
  const total = count(raw.total_tokens)
  const withCache = (usage: TokenUsage): TokenUsage => (raw.cache_read_tokens !== undefined && count(raw.cache_read_tokens) !== undefined ? { ...usage, cacheReadInputTokens: cache } : usage)
  if (total === undefined) return cache === 0 && thinking === 0 ? withCache({ inputTokens: input, outputTokens: output }) : undefined
  const readings: Array<{ fits: boolean; usage: TokenUsage }> = [
    { fits: cache <= input && total === input + output + thinking, usage: { inputTokens: input, outputTokens: output + thinking } },
    { fits: total === input + cache + output + thinking, usage: { inputTokens: input + cache, outputTokens: output + thinking } },
    { fits: cache <= input && thinking <= output && total === input + output, usage: { inputTokens: input, outputTokens: output } },
  ]
  const reading = readings.find((r) => r.fits)
  return reading ? withCache(reading.usage) : undefined
}

/** A failure's kind, from agy's own words: a sign-in to renew, a quota or capacity limit, or a broken session. */
function failureKind(text: string): ProviderErrorKind {
  if (/authenticat|not logged in|sign in|log in|logged out|expired/i.test(text)) return 'reauth_required'
  if (/quota|rate.?limit|resource.?exhausted|credits/i.test(text)) return 'quota_exhausted'
  if (/capacity|overloaded/i.test(text)) return 'overloaded'
  return 'session_broken'
}

const unavailable = (detail: string): RuntimeEvidence => ({ available: false, detail, sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false })

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200)

const spawnPiped: SpawnAgy = (command, args, options) => spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return undefined
}

async function agyVersion(executable: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 15_000, env })
  const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0]
  if (!version) throw new Error(`unexpected output: ${stdout.slice(0, 80)}`)
  return version
}

export interface Config {
  /** Path to `agy`; found on PATH when absent. */
  executable?: string
  env?: Record<string, string>
  forwardEnv?: string[]
  home?: string
}

export const name = 'runtime-antigravity-cli'
export const inject = ['agentRuntimes']
export const Config: z<Config> = z.object({
  executable: z.string().description('Path to the agy executable (default: found on PATH)'),
  env: z.dict(z.string()).description('Explicit environment for agy (no secrets; use forwardEnv)'),
  forwardEnv: z.array(z.string()).description('Daemon environment variables forwarded by name, such as an API key agy should use'),
  home: z.string().description('The Workers\' Antigravity home (agy\'s HOME; default <DSH_HOME>/system/antigravity-home), never the operator\'s; sign in there once'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.agentRuntimes.register(new AntigravityRuntime({
    executable: config.executable, env: config.env, forwardEnv: config.forwardEnv, home: config.home,
    confine: (bind) => ctx.agentRuntimes.confinement(bind),
  }))
}
