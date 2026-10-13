/**
 * Agent runtime provider `claude-agent-sdk` (docs/design/agent-runtimes.md): Claude Code as a
 * Worker, through the official Claude Agent SDK, running the operator's installed `claude`.
 * The configured policy is enforced exactly or refused (never loosened):
 * - only the listed built-in tools exist in the session (`tools`), and only they are
 *   pre-approved (`allowedTools`), each for the workspace only, reads included; anything else is
 *   denied without a prompt (`dontAsk`, no approval surface);
 * - no settings files are loaded (`settingSources: []`) and no MCP server is attached
 *   (`strictMcpConfig` with none given, live check 2026-10-12: the account's claude.ai
 *   connectors were attached otherwise), so nothing outside the policy widens a Worker;
 * - `workspace-write` adds `Edit` and `Write`, pre-approved only by workspace-scoped rules
 *   (verified live against traversal, symlinks, and home paths); `Bash` is not offered, as
 *   commands cannot be confined yet, so the runtime does not `validate`;
 * - Claude Code starts without the daemon's credentials: only the variables the operator
 *   forwards by name (`forwardEnv`) or sets (`env`) reach it (INV-8).
 * The SDK's session stays native; only its id crosses as the run's handle (INV-7).
 * @module @tsuuanmi/system-runtime-claude-agent-sdk
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type AgentRuntimeProvider, type RunResult, type RunSpec, type RuntimeEvidence, childEnvironment } from '@tsuuanmi/system-agent-runtime-core'
import { ProviderError, type ProviderErrorKind } from '@tsuuanmi/system-provider-core'

export type QueryFn = typeof query

/** Built-in tools that only read. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
/** Built-in tools that write files; always approved through workspace-scoped rules only. */
const WRITE_TOOLS = ['Edit', 'Write']
const ALLOWED: Record<'read-only' | 'workspace-write', string[]> = { 'read-only': READ_ONLY_TOOLS, 'workspace-write': [...READ_ONLY_TOOLS, ...WRITE_TOOLS] }

/**
 * Pre-approval rule for one tool, scoped to the working directory (`./**`). Bare rules reach the
 * whole disk: a bare `Write` wrote outside the workspace, and a bare `Read` or `Grep` read
 * outside it (live, 2026-10-12 and 2026-10-13), which would expose the daemon's own state
 * (`vault.key`, the token files). The scoped rules held against `..` traversal, a symlink out of
 * the workspace, and a home path; anything else is denied without a prompt (`dontAsk`).
 */
const rule = (tool: string): string => `${tool}(./**)`

export interface RuntimeOptions {
  /** The `claude` executable; found on PATH when absent. */
  executable?: string | undefined
  /** Explicit environment for Claude Code (no secrets: they belong in `forwardEnv`). */
  env?: Record<string, string> | undefined
  /** Daemon environment variables forwarded by name, such as an API key Claude Code should use. */
  forwardEnv?: string[] | undefined
  query?: QueryFn
  findExecutable?: () => string | undefined
  version?: (executable: string) => Promise<string>
}

export class ClaudeAgentRuntime implements AgentRuntimeProvider {
  readonly kind = 'claude-agent-sdk'
  private readonly query: QueryFn

  constructor(private readonly options: RuntimeOptions = {}) {
    this.query = options.query ?? query
  }

  async probe(): Promise<RuntimeEvidence> {
    const executable = this.executable()
    if (!executable) return { available: false, detail: 'Claude Code is not installed (no claude executable on PATH)', sandboxes: [], resume: false, executes: false }
    try {
      const version = await (this.options.version ?? claudeVersion)(executable)
      // No Bash: commands cannot be confined to the workspace yet, so it cannot validate.
      return { available: true, detail: `Claude Code ${version}`, version, sandboxes: ['read-only', 'workspace-write'], resume: true, executes: false }
    } catch (error) {
      return { available: false, detail: `claude --version failed: ${(error as Error).message.slice(0, 160)}`, sandboxes: [], resume: false, executes: false }
    }
  }

  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    if (!isAbsolute(spec.workspace)) throw new ProviderError('config_error', 'claude-agent-sdk: the workspace must be an absolute path')
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
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    let handle: string | undefined
    let result: Record<string, unknown> | undefined
    try {
      const messages = this.query({
        prompt: spec.prompt,
        options: {
          cwd: spec.workspace, tools, allowedTools: tools.map(rule), permissionMode: 'dontAsk', permissionPrompts: 'none', settingSources: [],
          // No MCP server at all: not the operator's, not a project's, not the account's connectors.
          mcpServers: {}, strictMcpConfig: true,
          pathToClaudeCodeExecutable: executable, abortController: controller,
          // Without the daemon's credentials (INV-8); its own sign-in lives in ~/.claude.
          env: childEnvironment(this.options.forwardEnv, this.options.env),
          ...(spec.model ? { model: spec.model } : {}), ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}), ...(spec.resume ? { resume: spec.resume } : {}),
        },
      })
      for await (const message of messages as AsyncIterable<Record<string, unknown>>) {
        const id = typeof message.session_id === 'string' ? message.session_id : undefined
        if (id && !handle) {
          handle = id
          onHandle?.(id)
        }
        if (message.type === 'result') result = message
      }
    } catch (error) {
      if (signal.aborted) throw new ProviderError('aborted', 'claude-agent-sdk: aborted')
      throw new ProviderError('session_broken', `claude-agent-sdk: ${(error as Error).message.slice(0, 300)}`, { cause: error })
    } finally {
      signal.removeEventListener('abort', abort)
    }
    if (signal.aborted) throw new ProviderError('aborted', 'claude-agent-sdk: aborted')
    if (!result) throw new ProviderError('session_broken', 'claude-agent-sdk: the session ended without a result')
    if (result.subtype !== 'success' || result.is_error === true) {
      const errors = Array.isArray(result.errors) ? (result.errors as unknown[]).map(String).join('; ') : String(result.result ?? '')
      throw new ProviderError(failureKind(String(result.subtype)), `claude-agent-sdk: ${String(result.subtype)}${errors ? `: ${errors.slice(0, 300)}` : ''}`)
    }
    return {
      text: String(result.result ?? ''),
      nativeHandle: handle ?? (typeof result.session_id === 'string' ? result.session_id : undefined),
      ...(typeof result.num_turns === 'number' ? { turns: result.num_turns } : {}),
      ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
    }
  }

  private executable(): string | undefined {
    return this.options.executable ?? (this.options.findExecutable ?? (() => onPath('claude')))()
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
}

export const name = 'runtime-claude-agent-sdk'
export const inject = ['agentRuntimes']
export const Config: z<Config> = z.object({
  executable: z.string().description('Path to the claude executable (default: found on PATH)'),
  env: z.dict(z.string()).description('Explicit environment for Claude Code (no secrets; use forwardEnv)'),
  forwardEnv: z.array(z.string()).description('Daemon environment variables forwarded by name, such as an API key Claude Code should use'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.agentRuntimes.register(new ClaudeAgentRuntime({ executable: config.executable, env: config.env, forwardEnv: config.forwardEnv }))
}
