/**
 * `ctx.agentRuntimes`: the agent runtime provider registry (docs/design/agent-runtimes.md).
 * Provider plugins register on load and are removed on unload; Workers name a runtime by
 * kind in configuration and never branch on it (INV-11). It also owns the read confinement
 * every agent child runs under (ADR-0024): the DSH home is always hidden.
 * @module @tsuuanmi/system-agent-runtimes
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type AgentRuntimeProvider, AgentRuntimes, type Confinement } from '@tsuuanmi/system-agent-runtime-core'
import { dshHome } from '@tsuuanmi/system-libs'

export * from '@tsuuanmi/system-agent-runtime-core'

export interface Config {
  /** The bubblewrap executable (default `bwrap` on PATH). */
  bwrap?: string
  /** Paths agent Workers must not read, besides the DSH home and the service's credentials directory. */
  hide?: string[]
  /** Paths under a hidden directory agent Workers may read (default `$DSH_HOME/system/tools`). */
  readOnly?: string[]
}

export class AgentRuntimeRegistry extends AgentRuntimes {
  static Config: z<Config> = z.object({
    bwrap: z.string().default('bwrap').description('The bubblewrap executable that confines agent Workers\' reads'),
    hide: z.array(z.string()).default([]).description('Paths agent Workers must not read, besides the DSH home and $CREDENTIALS_DIRECTORY (always hidden); $DSH_HOME expands'),
    readOnly: z.array(z.string()).default(['$DSH_HOME/system/tools']).description('Paths under a hidden directory agent Workers may read (the operator-installed agent CLIs); $DSH_HOME expands'),
  })

  private readonly providers = new Map<string, AgentRuntimeProvider>()

  constructor(ctx: Context, private readonly config: Config = {}) {
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

  confinement(writable: readonly string[] = []): Confinement {
    const credentials = process.env.CREDENTIALS_DIRECTORY
    const expand = (path: string) => path.replace(/^\$DSH_HOME(?=\/|$)/, dshHome())
    return {
      bwrap: this.config.bwrap ?? 'bwrap',
      hide: [dshHome(), ...(credentials ? [credentials] : []), ...(this.config.hide ?? []).map(expand)],
      readOnly: (this.config.readOnly ?? ['$DSH_HOME/system/tools']).map(expand),
      writable,
    }
  }
}

export default AgentRuntimeRegistry
