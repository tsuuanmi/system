/**
 * `ctx.agentRuntimes`: the agent runtime provider registry (docs/design/agent-runtimes.md).
 * Provider plugins register on load and are removed on unload; Workers name a runtime by
 * kind in configuration and never branch on it (INV-11). It also owns the read confinement
 * every agent child runs under (ADR-0024).
 * @module @tsuuanmi/system-agent-runtimes
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type AgentRuntimeProvider, AgentRuntimes, type Confinement } from '@tsuuanmi/system-agent-runtime-core'
import { dshHome, secretPaths } from '@tsuuanmi/system-libs'

export * from '@tsuuanmi/system-agent-runtime-core'

export interface Config {
  /** The bubblewrap executable (default: found on PATH, a root-owned one first). */
  bwrap?: string
  /** Paths agent Workers must not read, besides those always hidden. */
  hide?: string[]
  /** Paths under a hidden directory agent Workers may read (default `$DSH_HOME/system/tools`). */
  readOnly?: string[]
}

/**
 * Always hidden from an agent child, when present: the DSH home (vault, key, tokens, store, login
 * profiles, DSH's own credentials); the session's runtime directory (its message bus and key
 * agents, through which a process could run commands outside the sandbox); the temporary
 * directories (the browsers' live profiles, the display cookie, the remote-login socket); the
 * service's credentials; and the usual credential stores in the home directory.
 */
/**
 * The operator's credential stores in the home directory: keys and tokens, and every coding
 * agent's own login, whichever agent runs. An agent runtime runs in a home of its own (Codex in
 * `<DSH_HOME>/system/codex-home`), bound back, so no agent ever reads another's credentials or
 * the operator's.
 */
export const CREDENTIAL_STORES: readonly string[] = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.Xauthority', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  join('.config', 'gh'), join('.config', 'gcloud'), join('.docker', 'config.json'), join('.cargo', 'credentials.toml'),
  // coding agents' logins and settings
  '.claude', '.claude.json', '.codex', '.gemini', '.cursor', join('.config', 'github-copilot'), join('.config', 'opencode'), join('.local', 'share', 'opencode'),
]

function alwaysHidden(): string[] {
  const home = homedir()
  const runtime = process.env.XDG_RUNTIME_DIR ?? (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : undefined)
  return [
    dshHome(), ...(runtime ? [runtime] : []), ...(process.env.CREDENTIALS_DIRECTORY ? [process.env.CREDENTIALS_DIRECTORY] : []),
    tmpdir(), '/tmp', '/var/tmp', '/dev/shm',
    ...CREDENTIAL_STORES.map((p) => join(home, p)),
  ]
}

/** `bwrap` on PATH as an absolute path, a root-owned one first (an operator's own copy can be replaced by any process of theirs). */
function findBwrap(): string {
  const found: string[] = []
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, 'bwrap')
    try {
      accessSync(candidate, constants.X_OK)
      found.push(candidate)
    } catch {
      // not here
    }
  }
  return found.find((path) => statSync(path).uid === 0) ?? found[0] ?? 'bwrap'
}

export class AgentRuntimeRegistry extends AgentRuntimes {
  static Config: z<Config> = z.object({
    bwrap: z.string().description('The bubblewrap executable that confines agent Workers\' reads (default: found on PATH, a root-owned one first)'),
    hide: z.array(z.string()).default([]).description('Paths agent Workers must not read, besides those always hidden; $DSH_HOME expands'),
    readOnly: z.array(z.string()).default(['$DSH_HOME/system/tools']).description('Paths under a hidden directory agent Workers may read (the operator-installed agent CLIs); $DSH_HOME expands'),
  })

  private readonly providers = new Map<string, AgentRuntimeProvider>()
  /** Resolved once, so the probe and every run use the same binary whatever a child's PATH is. */
  private readonly bwrap: string

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx)
    this.bwrap = config.bwrap ?? findBwrap()
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

  confinement(bind: { readOnly?: readonly string[]; writable?: readonly string[] } = {}): Confinement {
    const expand = (path: string) => path.replace(/^\$DSH_HOME(?=\/|$)/, dshHome())
    // The defaults and registered secrets that exist now; an operator entry is kept as given,
    // so a typo shows in the probe's detail instead of passing silently.
    const present = [...alwaysHidden(), ...secretPaths()].filter((path) => existsSync(path))
    return {
      bwrap: this.bwrap,
      hide: [...new Set([...present, ...(this.config.hide ?? []).map(expand)])],
      readOnly: [...(this.config.readOnly ?? ['$DSH_HOME/system/tools']).map(expand), ...(bind.readOnly ?? [])],
      writable: [...(bind.writable ?? [])],
    }
  }
}

export default AgentRuntimeRegistry
