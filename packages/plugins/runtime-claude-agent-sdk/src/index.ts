/**
 * Agent runtime provider `claude-agent-sdk` (docs/design/agent-runtimes.md): Claude Code as a
 * Worker, through the official Claude Agent SDK, running the operator's installed `claude`.
 * The configured policy is enforced exactly or refused (never loosened):
 * - only the listed built-in tools exist in the session (`tools`), and only they are
 *   pre-approved (`allowedTools`), each file tool for the workspace only, reads included; anything
 *   else is denied without a prompt (`dontAsk`, no approval surface);
 * - no settings files are loaded (`settingSources: []`) and no MCP server is attached
 *   (`strictMcpConfig` with none given, live check 2026-10-12: the account's claude.ai
 *   connectors were attached otherwise), so nothing outside the policy widens a Worker;
 * - `workspace-write` adds `Edit` and `Write`, pre-approved only by workspace-scoped rules
 *   (verified live against traversal, symlinks, and home paths), and `Bash`, whose every command
 *   runs in the SDK's sandbox (ADR-0038): writes to the workspace only, no network, no command
 *   outside it, and a run whose sandbox cannot start fails. A `read-only` run has no `Bash`;
 * - Claude Code starts under the read confinement of `ctx.agentRuntimes` (ADR-0024, ADR-0038):
 *   bubblewrap hides the host state, and only its own home (`CLAUDE_CONFIG_DIR`, never the
 *   operator's `~/.claude`) and the workspace come back. The probe proves the confinement on this
 *   host, and a sandbox with no network started inside it, before it offers `workspace-write` and
 *   reports `executes`; without either proof nothing writes or runs a command;
 * - Claude Code starts without the daemon's credentials: only the variables the operator
 *   forwards by name (`forwardEnv`) or sets (`env`) reach it (INV-8);
 * - a run or probe may name another home (one account's, ADR-0051), an owner-only directory that
 *   exists, which then stands for its own everywhere; who is signed in to a home (`identity`) is
 *   read as the account and organization ids of the `oauthAccount` its state file holds, after
 *   `claude auth status` there, confined, says it is logged in, with its sign-in in its own
 *   `.credentials.json`, and only on a Claude Code version a check verified
 *   (`VERIFIED_IDENTITY_VERSIONS`); only their keyed hash, and a masked email, leave it;
 * - a run's tool gate (`RunSpec.toolGate`) compiles to a PreToolUse hook on every tool: `deny`
 *   and `defer` are the hook's own decisions, and `allow` leaves the call to the pre-approvals
 *   above (a hook's `allow` would skip them); a deferred run stops there and never completes.
 *   `canUseTool` is never the gate: a pre-approved tool never reaches it.
 * The SDK's session stays native; only its id crosses as the run's handle (INV-7). What a run
 * consumed is read from the SDK's own messages (the result's `modelUsage`, `rate_limit_event`),
 * never from the model's text, and reported for a failed run too.
 * @module @tsuuanmi/system-runtime-claude-agent-sdk
 */
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, lstatSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { type HookCallback, type HookJSONOutput, type SandboxSettings, type SpawnedProcess, type SpawnOptions, query } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type AgentRuntimeProvider, type Confinement, type IdentityReading, type LimitObservation, type LoginCommand, type ModelUsage, type ProbeOptions, type RunMetering, type RunResult, type RunSpec,
  type RuntimeEvidence, type SandboxMode, type TokenUsage, type ToolGate, askToolGate, childEnvironment, confinedCommand, homeProblem, identityHmac, maskEmail, proveConfinement, readHomeJson,
  withMetering,
} from '@tsuuanmi/system-agent-runtime-core'
import { dshHome, ensurePrivateDir } from '@tsuuanmi/system-libs'
import { ProviderError, type ProviderErrorKind } from '@tsuuanmi/system-provider-core'

export type QueryFn = typeof query

/** Built-in tools that only read. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
/** Built-in tools that write files; always approved through workspace-scoped rules only. */
const WRITE_TOOLS = ['Edit', 'Write']
/** The built-in tool that runs commands: in a `workspace-write` run only, every command inside the SDK's sandbox (ADR-0038). */
const COMMAND_TOOL = 'Bash'
const ALLOWED: Record<SandboxMode, string[]> = { 'read-only': READ_ONLY_TOOLS, 'workspace-write': [...READ_ONLY_TOOLS, ...WRITE_TOOLS, COMMAND_TOOL] }

/**
 * Pre-approval rule for one tool. A file tool's is scoped to the working directory (`./**`): bare
 * rules reach the whole disk, as a bare `Write` wrote outside the workspace, and a bare `Read` or
 * `Grep` read outside it (live, 2026-10-12 and 2026-10-13), which would expose the daemon's own
 * state (`vault.key`, the token files). The scoped rules held against `..` traversal, a symlink
 * out of the workspace, and a home path; anything else is denied without a prompt (`dontAsk`).
 * `Bash` is pre-approved whole: the SDK's sandbox bounds where each command acts (the workspace,
 * no network), and the run's tool gate decides whether it runs at all, by its exact argv
 * (docs/design/approvals.md#a-workers-tool-calls).
 */
const rule = (tool: string): string => (tool === COMMAND_TOOL ? tool : `${tool}(./**)`)

/**
 * The SDK's sandbox for the commands of a `workspace-write` run (ADR-0038): on, and a run whose
 * sandbox cannot start fails instead of running a command unconfined (`failIfUnavailable`); no
 * command runs outside it, whatever the model asks (`allowUnsandboxedCommands: false`); writes
 * reach the run's workspace only; and no network: no domain is allowed, and `strictAllowlist`
 * makes any other host a refusal by the sandbox itself, never a question for a permission flow.
 */
export function commandSandbox(workspace: string): SandboxSettings {
  return {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
    filesystem: { allowWrite: [workspace] },
    network: { allowedDomains: [], strictAllowlist: true },
  }
}

/**
 * A namespaced `true` with no network, started inside the read confinement as the SDK's sandbox
 * starts a command on Linux: bubblewrap, found on Claude Code's PATH, with its own network and PID
 * namespaces over a read-only root. That it starts proves the second layer nests on this host
 * (ADR-0038), as Codex's probe proves its own sandbox (ADR-0024).
 */
const NESTED_SANDBOX = ['--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', 'true']

/** A command line, confined, run with Claude Code's environment; resolves its stdout, rejects on a non-zero exit. */
export type ConfinedRun = (command: { command: string; args: string[] }, env: Record<string, string>) => Promise<string>

/** Starts Claude Code's process, already confined (default: `spawn`, with stdin and stdout piped). */
export type SpawnConfined = (command: string, args: string[], options: { cwd?: string | undefined; env: Record<string, string | undefined>; signal: AbortSignal }) => SpawnedProcess

/** The hook's own timeout, in the SDK's unit (seconds): above the gate's bound (`TOOL_GATE_MS`), so the hook always answers itself. */
const HOOK_TIMEOUT_S = 60

/**
 * The Claude Code versions its identity reader is pinned to (ADR-0051, as ADR-0043 pins agy's
 * hook): with `CLAUDE_CONFIG_DIR` set, the home's `.claude.json` holds `oauthAccount` with
 * `accountUuid`, `emailAddress`, and `organizationUuid`, and its OAuth sign-in is kept in the home's
 * own `.credentials.json` (the lead's look on this host, field names only). On any other version a
 * reading is `unverified`. Owed (PROP-0012 phase A): the supervised check on the operator's real
 * accounts that the ids stay equal across a restart, a token refresh, and a re-login, and differ for
 * two accounts.
 */
export const VERIFIED_IDENTITY_VERSIONS: readonly string[] = ['2.1.308']

/** The reader's id, as an `agent-account@1.0` record names it. */
export const IDENTITY_READER = 'claude-state-file'

export interface RuntimeOptions {
  /** The `claude` executable; found on PATH when absent. */
  executable?: string | undefined
  /** Explicit environment for Claude Code (no secrets: they belong in `forwardEnv`). */
  env?: Record<string, string> | undefined
  /** Daemon environment variables forwarded by name, such as an API key Claude Code should use. */
  forwardEnv?: string[] | undefined
  /**
   * The Workers' Claude Code home (`CLAUDE_CONFIG_DIR`; default `<DSH_HOME>/system/claude-home`),
   * never the operator's `~/.claude`, which the read confinement hides from every agent.
   */
  home?: string | undefined
  /**
   * The read confinement for a Claude Code child, given the paths it must still reach (its home,
   * its workspace); `ctx.agentRuntimes.confinement` (ADR-0024). Without it, the runtime offers no Worker.
   */
  confine?: ((bind: { readOnly?: readonly string[]; writable?: readonly string[] }) => Confinement) | undefined
  /** Proves the confinement on this host (default `proveConfinement`). */
  prove?: (confinement: Confinement) => Promise<{ confined: boolean; detail: string }>
  /** Starts a sandbox with no network inside the confinement (default: {@link NESTED_SANDBOX}); rejects when it does not start. */
  nested?: ConfinedRun
  /** `claude auth status` inside the confinement (default: run it); rejects on a non-zero exit. */
  status?: ConfinedRun
  /** Starts the confined Claude Code process for the SDK (default: `spawn`). */
  spawn?: SpawnConfined
  query?: QueryFn
  findExecutable?: () => string | undefined
  version?: (executable: string) => Promise<string>
}

export class ClaudeAgentRuntime implements AgentRuntimeProvider {
  readonly kind = 'claude-agent-sdk'
  private readonly query: QueryFn
  /** Its own configured home: where a run that names none runs, and slot 1 of its accounts. */
  readonly home: string

  constructor(private readonly options: RuntimeOptions = {}) {
    this.query = options.query ?? query
    if (options.home !== undefined && !isAbsolute(options.home)) throw new ProviderError('config_error', 'claude-agent-sdk: home must be an absolute path')
    this.home = options.home ?? join(dshHome(), 'system', 'claude-home')
  }

  async probe(options: ProbeOptions = {}): Promise<RuntimeEvidence> {
    // A named home is one account's (ADR-0051): an owner-only directory that exists, never made here.
    const named = options.home !== undefined ? homeProblem(options.home) : undefined
    if (named) return unavailable(`claude-agent-sdk: ${named}`)
    const home = options.home ?? this.home
    const executable = this.executable()
    if (!executable) return unavailable('Claude Code is not installed (no claude executable on PATH)')
    let version: string
    try {
      version = await (this.options.version ?? claudeVersion)(executable)
    } catch (error) {
      return unavailable(`claude --version failed: ${firstLine(error)}`)
    }
    // Every pre-approved tool is scoped to the workspace, and Claude Code runs under the host's
    // read confinement, proven here (ADR-0024, ADR-0038). A run's tool gate is a PreToolUse hook on
    // every tool, which holds in every permission mode.
    const found = { available: true, version, resume: true, gatesToolCalls: true, homes: true }
    const unconfined = (detail: string): RuntimeEvidence => ({ ...found, detail: `Claude Code ${version}; ${detail}`, sandboxes: ['read-only'], executes: false, readsConfined: false })
    if (!this.options.confine) return unconfined('no read confinement is configured')
    try {
      this.ensureHome(home)
    } catch (error) {
      return unavailable(`claude-agent-sdk: its home ${home} cannot be used: ${firstLine(error)}`)
    }
    const confinement = this.options.confine({ writable: [home] })
    const reads = await (this.options.prove ?? proveConfinement)(confinement)
    if (!reads.confined) return unconfined(reads.detail)
    const env = this.environment(home)
    const signedOut = await this.signedOut(executable, confinement, env)
    if (signedOut) {
      return unavailable(`Claude Code ${version} is not signed in inside its home ${home} (${signedOut}): sign in there (CLAUDE_CONFIG_DIR=${home} claude), or forward an API key by name (forwardEnv)`)
    }
    // Commands need the second layer too: without it, no run writes or runs a command (ADR-0038).
    const commands = await this.proveCommands(confinement, env)
    return {
      ...found, detail: `Claude Code ${version}; ${reads.detail}; ${commands.detail}`,
      sandboxes: commands.proven ? ['read-only', 'workspace-write'] : ['read-only'], executes: commands.proven, readsConfined: true,
    }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    if (!isAbsolute(spec.workspace)) throw new ProviderError('config_error', 'claude-agent-sdk: the workspace must be an absolute path')
    // One account's own home (ADR-0051): an owner-only directory that exists, or nothing runs.
    const named = spec.home !== undefined ? homeProblem(spec.home) : undefined
    if (named) throw new ProviderError('config_error', `claude-agent-sdk: ${named}; nothing was run`)
    const home = spec.home ?? this.home
    const allowed = ALLOWED[spec.sandbox]
    if (!allowed) throw new ProviderError('config_error', `claude-agent-sdk: unknown sandbox ${String(spec.sandbox)}`)
    // Absent or empty means the sandbox's default set; an empty `tools` would disable every tool.
    const tools = spec.tools?.length ? spec.tools : allowed
    const refused = tools.filter((tool) => !allowed.includes(tool))
    if (refused.length) {
      throw new ProviderError('config_error', `claude-agent-sdk: a ${spec.sandbox} run allows only ${allowed.join(', ')}; refusing ${refused.join(', ')}`)
    }
    const executable = this.executable()
    if (!executable) throw new ProviderError('config_error', 'claude-agent-sdk: Claude Code is not installed')
    if (signal.aborted) throw new ProviderError('aborted', 'claude-agent-sdk: aborted before starting')
    if (!this.options.confine) throw new ProviderError('config_error', 'claude-agent-sdk: no read confinement is configured; refusing to run Claude Code with the host state readable (ADR-0024)')
    const writes = spec.sandbox === 'workspace-write'
    const confinement = this.confinement(home, writes ? { writable: [home, spec.workspace] } : { writable: [home], readOnly: [spec.workspace] })
    const env = this.environment(home)
    if (writes) {
      // The second layer is proven again before a run that writes: its sandbox must start (ADR-0038).
      const commands = await this.proveCommands(confinement, env)
      if (!commands.proven) throw new ProviderError('config_error', `claude-agent-sdk: ${commands.detail}; refusing a workspace-write run, whose commands would not be confined (ADR-0038)`)
      if (signal.aborted) throw new ProviderError('aborted', 'claude-agent-sdk: aborted before starting')
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    let handle: string | undefined
    let result: Record<string, unknown> | undefined
    let mainModel: string | undefined
    const limits: LimitObservation[] = []
    let rejected = false
    const deferral: { current?: Deferral } = {}
    const metering = (): RunMetering => meteringFrom(result, mainModel, limits)
    try {
      const messages = this.query({
        prompt: spec.prompt,
        options: {
          cwd: spec.workspace, tools, allowedTools: tools.map(rule), permissionMode: 'dontAsk', permissionPrompts: 'none', settingSources: [],
          // No MCP server at all: not the operator's, not a project's, not the account's connectors.
          mcpServers: {}, strictMcpConfig: true,
          pathToClaudeCodeExecutable: executable, abortController: controller,
          // Under the host's read confinement, its home and the workspace bound back (ADR-0024, ADR-0038).
          spawnClaudeCodeProcess: (options) => this.spawnConfined(options, confinement),
          // Without the daemon's credentials (INV-8); its own sign-in lives in its home.
          env,
          // Every command in the SDK's sandbox: the workspace, no network, no way out (ADR-0038).
          ...(writes ? { sandbox: commandSandbox(spec.workspace) } : {}),
          ...(spec.model ? { model: spec.model } : {}), ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}), ...(spec.resume ? { resume: spec.resume } : {}),
          // No matcher: every tool call, subagents' included, passes the gate before it runs.
          ...(spec.toolGate ? { hooks: { PreToolUse: [{ hooks: [gateHook(spec.toolGate, deferral)], timeout: HOOK_TIMEOUT_S }] } } : {}),
        },
      })
      for await (const message of messages as AsyncIterable<Record<string, unknown>>) {
        const id = typeof message.session_id === 'string' ? message.session_id : undefined
        if (id && !handle) {
          handle = id
          onHandle?.(id)
        }
        // The main loop's model, as the SDK names it when the session starts.
        if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string' && message.model) mainModel ??= message.model
        if (message.type === 'rate_limit_event') {
          const info = message.rate_limit_info as Record<string, unknown> | undefined
          if (info?.status === 'rejected') rejected = true
          const observed = limitFrom(info)
          if (observed) limits.push(observed)
        }
        if (message.type === 'result') result = message
      }
    } catch (error) {
      if (signal.aborted) throw withMetering(new ProviderError('aborted', 'claude-agent-sdk: aborted'), metering())
      if (deferral.current) throw withMetering(deferredError(deferral.current), metering())
      throw withMetering(new ProviderError(rejected ? 'quota_exhausted' : 'session_broken', `claude-agent-sdk: ${(error as Error).message.slice(0, 300)}`, { cause: error }), metering())
    } finally {
      signal.removeEventListener('abort', abort)
    }
    if (signal.aborted) throw withMetering(new ProviderError('aborted', 'claude-agent-sdk: aborted'), metering())
    // A deferred run did not finish, whatever its result says: the call it stopped at never ran.
    if (deferral.current) throw withMetering(deferredError(deferral.current), metering())
    if (result && (DEFERRED.includes(String(result.terminal_reason)) || result.deferred_tool_use !== undefined)) {
      throw withMetering(new ProviderError('config_error', `claude-agent-sdk: the run stopped at a deferred tool call its gate did not defer (${String(result.terminal_reason)})`), metering())
    }
    if (!result) throw withMetering(new ProviderError(rejected ? 'quota_exhausted' : 'session_broken', 'claude-agent-sdk: the session ended without a result'), metering())
    if (result.subtype !== 'success' || result.is_error === true) {
      const errors = Array.isArray(result.errors) ? (result.errors as unknown[]).map(String).join('; ') : String(result.result ?? '')
      // A usage limit the agent hit ends the run: never retried on the same account (docs/design/resources.md).
      const kind = rejected ? 'quota_exhausted' : failureKind(String(result.subtype))
      throw withMetering(new ProviderError(kind, `claude-agent-sdk: ${String(result.subtype)}${errors ? `: ${errors.slice(0, 300)}` : ''}`), metering())
    }
    return {
      text: String(result.result ?? ''),
      nativeHandle: handle ?? (typeof result.session_id === 'string' ? result.session_id : undefined),
      ...metering(),
    }
  }

  private executable(): string | undefined {
    return this.options.executable ?? (this.options.findExecutable ?? (() => onPath('claude')))()
  }

  /**
   * Who is signed in to `home` (ADR-0051), hashed with `key`; never the ids themselves (INV-8). Only on
   * a pinned Claude Code version: `claude auth status` in that home, under the confinement and with
   * none of the operator's forwarded variables, must say it is logged in; the home must keep that
   * sign-in in its own `.credentials.json` (whose content is never read: a sign-in kept elsewhere is
   * not this home's, so `unverified`); then the account and organization ids of the `oauthAccount`
   * in the home's `.claude.json`, both whole, or the reading is `ambiguous` (never the email alone,
   * which can change). The email only gives the masked hint.
   */
  async identity(home: string, key: Uint8Array): Promise<IdentityReading> {
    const reader = IDENTITY_READER
    const executable = this.executable()
    if (!executable) return { status: 'unverified', reason: 'Claude Code is not installed (no claude executable on PATH)', reader }
    let runtimeVersion: string
    try {
      runtimeVersion = await (this.options.version ?? claudeVersion)(executable)
    } catch (error) {
      return { status: 'unverified', reason: `claude --version failed: ${firstLine(error)}`, reader }
    }
    const pinned = { reader, runtimeVersion }
    if (!VERIFIED_IDENTITY_VERSIONS.includes(runtimeVersion)) {
      return { status: 'unverified', reason: `no identity reader is verified for Claude Code ${runtimeVersion} (verified: ${VERIFIED_IDENTITY_VERSIONS.join(', ')})`, ...pinned }
    }
    const problem = homeProblem(home)
    if (problem) return { status: 'missing', reason: problem, ...pinned }
    if (!this.options.confine) return { status: 'unverified', reason: 'no read confinement is configured, so the sign-in cannot be checked as a run would see it (ADR-0024)', ...pinned }
    let status: string
    try {
      const confinement = this.confinement(home, { writable: [home] })
      status = await (this.options.status ?? runConfined)(confinedCommand(executable, ['auth', 'status'], confinement), childEnvironment([], { CLAUDE_CONFIG_DIR: home }))
    } catch (error) {
      return { status: 'missing', reason: `claude auth status failed: ${firstLine(error)}`, ...pinned }
    }
    const said = loggedIn(status)
    if (said === false) return { status: 'missing', reason: 'claude auth status: not logged in', ...pinned }
    if (said === undefined) return { status: 'ambiguous', reason: 'claude auth status: its output does not say who is signed in', ...pinned }
    let credentials: ReturnType<typeof lstatSync> | undefined
    try {
      credentials = lstatSync(join(home, '.credentials.json'))
    } catch {
      credentials = undefined
    }
    if (!credentials?.isFile()) return { status: 'unverified', reason: 'its sign-in is not kept in the home\'s own .credentials.json, so it is not this home\'s', ...pinned }
    const state = readHomeJson(join(home, '.claude.json'))
    if (state.state === 'absent') return { status: 'ambiguous', reason: 'the home holds no .claude.json naming the signed-in account', ...pinned }
    if (state.state === 'refused') return { status: 'ambiguous', reason: `its .claude.json cannot be read: ${state.why}`, ...pinned }
    const account = state.value.oauthAccount
    const fields = account && typeof account === 'object' ? account as Record<string, unknown> : {}
    const whole = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
    if (!whole(fields.accountUuid) || !whole(fields.organizationUuid)) {
      return { status: 'ambiguous', reason: 'its .claude.json does not name the signed-in account and its organization whole (oauthAccount.accountUuid, organizationUuid)', ...pinned }
    }
    const hint = typeof fields.emailAddress === 'string' ? maskEmail(fields.emailAddress) : undefined
    return { status: 'verified', hmac: identityHmac(key, this.kind, { accountUuid: fields.accountUuid, organizationUuid: fields.organizationUuid }), ...pinned, ...(hint ? { hint } : {}) }
  }

  /** Claude Code in `home`, where the operator signs in (`/login`) in their own terminal, without D-Bus (ADR-0051). */
  loginCommand(home: string): LoginCommand {
    return { command: this.executable() ?? 'claude', args: [], env: { CLAUDE_CONFIG_DIR: home } }
  }

  /** Claude Code's environment: without the daemon's credentials (INV-8), in its home. */
  private environment(home: string): Record<string, string> {
    return childEnvironment(this.options.forwardEnv, { ...this.options.env, CLAUDE_CONFIG_DIR: home })
  }

  /** Its own home is made owner-only on first use; a named one was checked to be one already, and is never made. */
  private ensureHome(home: string): void {
    if (home === this.home) ensurePrivateDir(home)
    else {
      const problem = homeProblem(home)
      if (problem) throw new Error(problem)
    }
  }

  /** The confinement of one run, checked before anything starts: its home exists owner-only, and no bind exposes a hidden path. */
  private confinement(home: string, bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement {
    try {
      this.ensureHome(home)
      const confinement = this.options.confine!(bind)
      confinedCommand('true', [], confinement)
      return confinement
    } catch (error) {
      throw new ProviderError('config_error', `claude-agent-sdk: ${firstLine(error)}; nothing was run`, { cause: error })
    }
  }

  /** The SDK's Claude Code process, started under the confinement: the SDK's command line, wrapped. */
  private spawnConfined(options: SpawnOptions, confinement: Confinement): SpawnedProcess {
    const confined = confinedCommand(options.command, options.args, confinement)
    return (this.options.spawn ?? spawnPiped)(confined.command, confined.args, { cwd: options.cwd, env: options.env, signal: options.signal })
  }

  /** Whether a sandbox with no network starts inside the confinement (ADR-0038). */
  private async proveCommands(confinement: Confinement, env: Record<string, string>): Promise<{ proven: boolean; detail: string }> {
    try {
      await (this.options.nested ?? runConfined)(confinedCommand('bwrap', NESTED_SANDBOX, confinement), env)
      return { proven: true, detail: 'commands confined: a sandbox with no network starts inside it' }
    } catch (error) {
      return { proven: false, detail: `commands cannot be confined: a sandbox does not start inside the confinement: ${firstLine(error)}` }
    }
  }

  /**
   * Why Claude Code is not signed in inside its home, or undefined when it is: `claude auth status`
   * under the confinement exits 0 and reports `"loggedIn": true`. Output that does not say so is
   * unknown, never a sign-in.
   */
  private async signedOut(executable: string, confinement: Confinement, env: Record<string, string>): Promise<string | undefined> {
    try {
      const status = await (this.options.status ?? runConfined)(confinedCommand(executable, ['auth', 'status'], confinement), env)
      const said = loggedIn(status)
      return said === true ? undefined : said === false ? 'claude auth status: not logged in' : 'claude auth status: its output does not say who is signed in'
    } catch (error) {
      return `claude auth status failed: ${firstLine(error)}`
    }
  }
}

// It runs in a named home whether or not it is available now: `homes` says what it can do, not its state.
const unavailable = (detail: string): RuntimeEvidence => ({ available: false, detail, sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false, homes: true })

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 160)

/** What `claude auth status` output says of the sign-in (`"loggedIn"`), or undefined when it says nothing it can be read as. */
function loggedIn(stdout: string): boolean | undefined {
  try {
    const said = (JSON.parse(stdout) as { loggedIn?: unknown } | null)?.loggedIn
    return typeof said === 'boolean' ? said : undefined
  } catch {
    return undefined
  }
}

const runConfined: ConfinedRun = async (command, env) => (await promisify(execFile)(command.command, command.args, { timeout: 15_000, env })).stdout

const spawnPiped: SpawnConfined = (command, args, options) => spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'ignore'] })

/** The tool call a run's gate deferred: the run stops there. */
interface Deferral {
  tool: string
  callId?: string | undefined
  requestId: string
  reason: string
}

/** Result terminal reasons for a run that stopped at a deferred tool call. */
const DEFERRED = ['tool_deferred', 'tool_deferred_unavailable']

const deferredError = (d: Deferral): ProviderError => new ProviderError('config_error',
  `claude-agent-sdk: the run stopped at tool call ${d.tool}${d.callId ? ` (${d.callId})` : ''} without running it: ${d.reason.slice(0, 300)} (approval request ${d.requestId})`)

const hookDecision = (decision: 'deny' | 'defer', reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason.slice(0, 1000) },
})

/**
 * The run's gate as a PreToolUse hook. `deny` and `defer` are the hook's decisions, which hold in
 * every permission mode; `allow` returns no decision, so the workspace-scoped pre-approvals still
 * decide (a hook's `allow` would skip them, and with them the workspace bound). Once a call is
 * deferred, every later call is denied: the run stops at the deferred one.
 */
function gateHook(gate: ToolGate, deferral: { current?: Deferral }): HookCallback {
  return async (input, toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const stopped = deferral.current
    if (stopped) return hookDecision('deny', `the run stopped at tool call ${stopped.tool}, which waits for approval request ${stopped.requestId}; no further tool call runs`)
    const callId = input.tool_use_id || toolUseId
    const verdict = await askToolGate(gate, { tool: input.tool_name, input: input.tool_input, ...(callId ? { callId } : {}) }, signal)
    if (verdict.decision === 'allow') return {}
    if (verdict.decision === 'defer') {
      deferral.current = { tool: input.tool_name, callId, requestId: verdict.requestId, reason: verdict.reason }
      return hookDecision('defer', verdict.reason)
    }
    return hookDecision('deny', verdict.reason)
  }
}

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined)
const CACHE = ['cacheReadInputTokens', 'cacheCreationInputTokens'] as const

/**
 * One model's usage from the SDK's `modelUsage` entry, normalized: the SDK's `inputTokens`
 * excludes cached input, so the cache read and cache creation counts are added to it. An entry
 * without whole input and output counts is unreadable.
 */
function modelUsageFrom(model: string, entry: Record<string, unknown>): ModelUsage | undefined {
  const input = count(entry.inputTokens)
  const output = count(entry.outputTokens)
  if (!model || input === undefined || output === undefined) return undefined
  const usage: TokenUsage = { inputTokens: input, outputTokens: output }
  for (const key of CACHE) {
    const cached = count(entry[key])
    if (cached !== undefined) {
      usage[key] = cached
      usage.inputTokens += cached
    }
  }
  const cost = entry.costUSD
  return { model, usage, ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}) }
}

/**
 * What a run consumed, from the SDK's own messages: the result's `modelUsage` (every model and
 * subagent; the result's own `usage` covers the main loop only and is not read), its turns and
 * cost, and the rate-limit events seen. The main model is the one the session's `init` message
 * names; without one, the model with the most output tokens. When any `modelUsage` entry is
 * unreadable, no usage is reported: a partial sum would undercount (a missing number stays missing).
 */
function meteringFrom(result: Record<string, unknown> | undefined, mainModel: string | undefined, limits: LimitObservation[]): RunMetering {
  const metering: RunMetering = {}
  if (result) {
    if (typeof result.session_id === 'string' && result.session_id && typeof result.uuid === 'string' && result.uuid) metering.resultId = `${result.session_id}:${result.uuid}`
    const turns = count(result.num_turns)
    if (turns !== undefined) metering.turns = turns
    if (typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0) metering.costUsd = result.total_cost_usd
    const entries = result.modelUsage && typeof result.modelUsage === 'object' ? Object.entries(result.modelUsage as Record<string, Record<string, unknown>>) : []
    const models = entries.map(([model, entry]) => (entry && typeof entry === 'object' ? modelUsageFrom(model, entry) : undefined))
    if (models.length && models.every((m) => m !== undefined)) {
      const sorted = (models as ModelUsage[]).sort((a, b) => a.model.localeCompare(b.model))
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
      for (const m of sorted) {
        usage.inputTokens += m.usage.inputTokens
        usage.outputTokens += m.usage.outputTokens
        for (const key of CACHE) if (m.usage[key] !== undefined) usage[key] = (usage[key] ?? 0) + m.usage[key]
      }
      metering.usage = usage
      metering.models = sorted
      mainModel ??= [...sorted].sort((a, b) => b.usage.outputTokens - a.usage.outputTokens || a.model.localeCompare(b.model))[0]!.model
    }
  }
  if (mainModel) metering.model = mainModel
  if (limits.length) metering.limits = limits.map((limit) => ({ ...limit }))
  return metering
}

const STATUS: Record<string, LimitObservation['status']> = { allowed: 'allowed', allowed_warning: 'warning', rejected: 'rejected' }
/** A reset time further than this from now is not believed (a unit the SDK changed, say). */
const PLAUSIBLE_MS = 400 * 86_400_000

/**
 * One `rate_limit_event`'s `rate_limit_info` as an observation. `resetsAt` is Unix time in
 * seconds: the CLI fills it from the `anthropic-ratelimit-unified-reset` header, which it compares
 * with `Date.now() / 1000` (Claude Code 2.1.308). `utilization` is a fraction (0 to 1). The window
 * is the SDK's `rateLimitType`, kept opaque; a rejection without one is reported with the window
 * `*`, which no configuration maps, so the ledger closes every window of the pool; any other event
 * without one is not reported.
 */
function limitFrom(info: Record<string, unknown> | undefined): LimitObservation | undefined {
  const status = typeof info?.status === 'string' ? STATUS[info.status] : undefined
  // A rejection that names no window is still reported (window '*'), so the ledger closes the pool.
  const window = typeof info?.rateLimitType === 'string' && info.rateLimitType ? info.rateLimitType : status === 'rejected' ? '*' : undefined
  if (!status || !window) return undefined
  const observed = Date.now()
  const reset = typeof info!.resetsAt === 'number' && Number.isFinite(info!.resetsAt) ? info!.resetsAt * 1000 : undefined
  const used = typeof info!.utilization === 'number' && Number.isFinite(info!.utilization) ? Math.min(100, Math.max(0, Math.round(info!.utilization * 10_000) / 100)) : undefined
  return {
    window, status,
    ...(reset !== undefined && Math.abs(reset - observed) <= PLAUSIBLE_MS ? { resetsAt: new Date(reset).toISOString() } : {}),
    ...(used !== undefined ? { usedPercentage: used } : {}),
    observedAt: new Date(observed).toISOString(),
  }
}

function failureKind(subtype: string): ProviderErrorKind {
  if (subtype === 'error_max_turns') return 'timeout'
  if (subtype === 'error_max_budget_usd') return 'quota_exhausted'
  return 'session_broken'
}

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

async function claudeVersion(executable: string): Promise<string> {
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 15_000 })
  const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0]
  if (!version) throw new Error(`unexpected output: ${stdout.slice(0, 80)}`)
  return version
}

export interface Config {
  /** Path to `claude`; found on PATH when absent. */
  executable?: string
  env?: Record<string, string>
  forwardEnv?: string[]
  home?: string
}

export const name = 'runtime-claude-agent-sdk'
export const inject = ['agentRuntimes']
export const Config: z<Config> = z.object({
  executable: z.string().description('Path to the claude executable (default: found on PATH)'),
  env: z.dict(z.string()).description('Explicit environment for Claude Code (no secrets; use forwardEnv)'),
  forwardEnv: z.array(z.string()).description('Daemon environment variables forwarded by name, such as an API key Claude Code should use'),
  home: z.string().description('The Workers\' Claude Code home (CLAUDE_CONFIG_DIR; default <DSH_HOME>/system/claude-home), never the operator\'s ~/.claude; sign in there once'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.agentRuntimes.register(new ClaudeAgentRuntime({
    executable: config.executable, env: config.env, forwardEnv: config.forwardEnv, home: config.home,
    confine: (bind) => ctx.agentRuntimes.confinement(bind),
  }))
}
