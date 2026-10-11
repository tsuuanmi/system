/**
 * Capability seam definition: `ctx.agentRuntimes` (docs/design/agent-runtimes.md). An agent
 * runtime is an external coding agent (Claude Code, Codex, an ACP agent) that `system` runs
 * as a Worker. Each provider adapts behaviour to this seam; the agent's own objects
 * (sessions, threads, events) stay native, and only a handle crosses it (INV-7).
 * @module @tsuuanmi/system-agent-runtime-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntimes: AgentRuntimes
  }
}

/** What the agent may do in its workspace. Policies come from trusted configuration only (INV-6). */
export type SandboxMode = 'read-only' | 'workspace-write'

/** What `probe()` established now; admission evidence, never a name (docs/design/agent-runtimes.md#admission-evidence). */
export interface RuntimeEvidence {
  available: boolean
  /** Why, in a few words: the version found, or what is missing. */
  detail: string
  version?: string
  /** Policies this provider can enforce exactly. */
  sandboxes: SandboxMode[]
  /** A finished run can be continued by its native handle (`persistent-conversation`). */
  resume: boolean
  /** It can run commands (tests, builds) confined to the workspace; required for `validate`. */
  executes: boolean
}

export interface RunSpec {
  prompt: string
  /** Absolute workspace root. */
  workspace: string
  sandbox: SandboxMode
  /** Tool allow-list; absent or empty means the provider's minimal set for the sandbox. */
  tools?: string[] | undefined
  /** Operator configuration; never a routing input (INV-11). */
  model?: string | undefined
  maxTurns?: number | undefined
  /** Native handle of a conversation to continue. */
  resume?: string | undefined
}

export interface RunResult {
  /** The agent's final message. */
  text: string
  /** Native session or thread handle, to continue it later. */
  nativeHandle?: string | undefined
  turns?: number | undefined
  costUsd?: number | undefined
}

/**
 * One agent runtime. `run` drives the agent's own loop to its terminal event. A policy the
 * runtime cannot enforce exactly is refused (an error of kind `config_error`); it is never
 * loosened. Errors carry a `kind` from the provider failure taxonomy (provider-core).
 */
export interface AgentRuntimeProvider {
  readonly kind: string
  probe(): Promise<RuntimeEvidence>
  run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult>
}

export abstract class AgentRuntimes extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentRuntimes')
  }

  /** Register a provider for the calling plugin's lifetime. Kinds are unique. */
  abstract register(provider: AgentRuntimeProvider): void

  abstract get(kind: string): AgentRuntimeProvider | undefined

  /** Registered kinds, sorted. */
  abstract list(): string[]
}
