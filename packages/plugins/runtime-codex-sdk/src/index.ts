/**
 * Agent runtime provider `codex-sdk` (docs/design/agent-runtimes.md, REQ-WRK-5): Codex as a
 * Worker, through the official Codex TypeScript SDK, running the operator's installed `codex`.
 * The configured policy is held by Codex's own sandbox, exactly or refused (never loosened):
 * - the sandbox (`read-only`, or `workspace-write`: writes confined to the workspace) and the
 *   working directory come from configuration; approvals are never asked (`never`), so anything
 *   the sandbox refuses fails instead of waiting for a person;
 * - commands run inside the same sandbox, so a writable Codex Worker can also `validate`;
 * - network access and web search are off;
 * - Codex has no per-tool allow-list and no turn limit: a configured `tools` or `maxTurns` is
 *   refused, not ignored.
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
import type { AgentRuntimeProvider, RunResult, RunSpec, RuntimeEvidence } from '@tsuuanmi/system-agent-runtime-core'
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
  /** Extra environment for the `codex` process, such as the variable a provider's `env_key` names. */
  env?: Record<string, string> | undefined
  client?: (options: CodexOptions) => CodexClient
  findExecutable?: () => string | undefined
  version?: (executable: string) => Promise<string>
}

export class CodexRuntime implements AgentRuntimeProvider {
  readonly kind = 'codex-sdk'

  constructor(private readonly options: RuntimeOptions = {}) {}

  async probe(): Promise<RuntimeEvidence> {
    const executable = this.executable()
    if (!executable) return { available: false, detail: 'Codex is not installed (no codex executable on PATH)', sandboxes: [], resume: false, executes: false }
    try {
      const version = await (this.options.version ?? codexVersion)(executable)
      // Codex confines commands in the same OS sandbox as its file writes, so it can validate.
      return { available: true, detail: `Codex ${version}`, version, sandboxes: ['read-only', 'workspace-write'], resume: true, executes: true }
    } catch (error) {
      return { available: false, detail: `codex --version failed: ${(error as Error).message.slice(0, 160)}`, sandboxes: [], resume: false, executes: false }
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
    const client = (this.options.client ?? ((options) => new Codex(options)))({
      codexPathOverride: executable,
      ...(this.options.config ? { config: this.options.config as NonNullable<CodexOptions['config']> } : {}),
      ...(this.options.env ? { env: { ...inherited(), ...this.options.env } } : {}),
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

  private executable(): string | undefined {
    return this.options.executable ?? (this.options.findExecutable ?? (() => findOnPath('codex')))()
  }
}

/** The environment the `codex` process inherits when extra variables are given (the SDK then inherits nothing). */
function inherited(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
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

async function codexVersion(executable: string): Promise<string> {
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 15_000 })
  return stdout.trim().replace(/^codex-cli\s+/, '')
}

export interface Config {
  executable?: string
  config?: Record<string, unknown>
  env?: Record<string, string>
}

export const name = 'runtime-codex-sdk'
export const inject = ['agentRuntimes']
export const Config: z<Config> = z.object({
  executable: z.string().description('Path to the codex executable (default: found on PATH)'),
  config: z.dict(z.any()).description('Codex --config overrides, such as model_provider and model_providers (operator configuration)'),
  env: z.dict(z.string()).description('Extra environment for the codex process, such as the variable a provider env_key names'),
})

export function apply(ctx: Context, config: Config = {}): void {
  ctx.agentRuntimes.register(new CodexRuntime({ executable: config.executable, config: config.config, env: config.env }))
}
