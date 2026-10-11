/**
 * `ctx.agentRuntimes`: the agent runtime provider registry (docs/design/agent-runtimes.md).
 * Provider plugins register on load and are removed on unload; Workers name a runtime by
 * kind in configuration and never branch on it (INV-11).
 * @module @tsuuanmi/system-agent-runtimes
 */
import type { Context } from '@deepseek-ai/cordis'
import { type AgentRuntimeProvider, AgentRuntimes } from '@tsuuanmi/system-agent-runtime-core'

export * from '@tsuuanmi/system-agent-runtime-core'

export class AgentRuntimeRegistry extends AgentRuntimes {
  private readonly providers = new Map<string, AgentRuntimeProvider>()

  constructor(ctx: Context) {
    super(ctx)
  }

  register(provider: AgentRuntimeProvider): void {
    if (this.providers.has(provider.kind)) throw new Error(`agent runtime ${provider.kind} is already registered`)
    this.ctx.effect(() => {
      this.providers.set(provider.kind, provider)
      return () => {
        if (this.providers.get(provider.kind) === provider) this.providers.delete(provider.kind)
      }
    })
  }

  get(kind: string): AgentRuntimeProvider | undefined {
    return this.providers.get(kind)
  }

  list(): string[] {
    return [...this.providers.keys()].sort()
  }
}

export default AgentRuntimeRegistry
