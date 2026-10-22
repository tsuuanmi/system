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
 * The SDK's session stays native; only its id crosses as the run's handle (INV-7). What a run
 * consumed is read from the SDK's own messages (the result's `modelUsage`, `rate_limit_event`),
 * never from the model's text, and reported for a failed run too.
 * @module @tsuuanmi/system-runtime-claude-agent-sdk
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type AgentRuntimeProvider, type LimitObservation, type ModelUsage, type RunMetering, type RunResult, type RunSpec, type RuntimeEvidence, type TokenUsage, childEnvironment, withMetering,
} from '@tsuuanmi/system-agent-runtime-core'
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
    if (!executable) return { available: false, detail: 'Claude Code is not installed (no claude executable on PATH)', sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false }
    try {
      const version = await (this.options.version ?? claudeVersion)(executable)
      // No Bash: commands cannot be confined to the workspace yet, so it cannot validate. Every
      // pre-approved tool is scoped to the workspace, reads included, and nothing else is
      // allowed, so the host state stays unreadable (ADR-0024; verified live 2026-10-13).
      return {
        available: true, detail: `Claude Code ${version}; reads scoped to the workspace`, version, sandboxes: ['read-only', 'workspace-write'], resume: true, executes: false, readsConfined: true,
        gatesToolCalls: false,
      }
    } catch (error) {
      return { available: false, detail: `claude --version failed: ${(error as Error).message.slice(0, 160)}`, sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false }
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
    if (spec.toolGate) throw new ProviderError('config_error', 'claude-agent-sdk: a tool gate is not asked yet; refusing it instead of ignoring it')
    const executable = this.executable()
    if (!executable) throw new ProviderError('config_error', 'claude-agent-sdk: Claude Code is not installed')
    if (signal.aborted) throw new ProviderError('aborted', 'claude-agent-sdk: aborted before starting')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    let handle: string | undefined
    let result: Record<string, unknown> | undefined
    let mainModel: string | undefined
    const limits: LimitObservation[] = []
    let rejected = false
    const metering = (): RunMetering => meteringFrom(result, mainModel, limits)
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
      throw withMetering(new ProviderError(rejected ? 'quota_exhausted' : 'session_broken', `claude-agent-sdk: ${(error as Error).message.slice(0, 300)}`, { cause: error }), metering())
    } finally {
      signal.removeEventListener('abort', abort)
    }
    if (signal.aborted) throw withMetering(new ProviderError('aborted', 'claude-agent-sdk: aborted'), metering())
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
