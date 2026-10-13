/**
 * Capability seam definition: `ctx.agentRuntimes` (docs/design/agent-runtimes.md). An agent
 * runtime is an external coding agent (Claude Code, Codex, an ACP agent) that `system` runs
 * as a Worker. Each provider adapts behaviour to this seam; the agent's own objects
 * (sessions, threads, events) stay native, and only a handle crosses it (INV-7).
 * @module @tsuuanmi/system-agent-runtime-core
 */
import { execFile } from 'node:child_process'
import { chmodSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { type Context, Service } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

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
  /**
   * Host state (the DSH home, with the vault, tokens, and store) is unreadable to the agent,
   * proven on this host now (ADR-0024). A Worker is unavailable without it.
   */
  readsConfined: boolean
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

  /**
   * The read confinement for an agent child (ADR-0024), from operator configuration, with
   * `writable` (the child's own home, if it lives under a hidden directory) bound back.
   */
  abstract confinement(writable?: readonly string[]): Confinement
}

/**
 * What an agent child must not read, and what it still needs from inside those paths
 * (ADR-0024). Applied with bubblewrap: the child sees the host as it is, except that each
 * hidden directory is an empty tmpfs and each hidden file reads as empty.
 */
export interface Confinement {
  /** The bubblewrap executable. */
  bwrap: string
  /** Directories and files hidden from the child: always the DSH home, plus operator paths. */
  hide: readonly string[]
  /** Paths under a hidden directory bound back read-only (operator-installed tools). */
  readOnly: readonly string[]
  /** Paths under a hidden directory bound back writable (the child's own home). */
  writable: readonly string[]
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * The command line that runs `command args` under `confinement`. Paths that do not exist are
 * skipped (there is nothing to hide or bind); symlinks are resolved first.
 */
export function confinedCommand(command: string, args: readonly string[], confinement: Confinement): { command: string; args: string[] } {
  // --die-with-parent: stopping the run signals bubblewrap, and the agent must end with it.
  const argv = ['--die-with-parent', '--dev-bind', '/', '/']
  for (const path of confinement.hide.map(real)) {
    if (!path) continue
    argv.push(...(statSync(path).isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path]))
  }
  for (const path of confinement.readOnly.map(real)) if (path) argv.push('--ro-bind', path, path)
  for (const path of confinement.writable.map(real)) if (path) argv.push('--bind', path, path)
  return { command: confinement.bwrap, args: [...argv, '--', command, ...args] }
}

const quote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`

/**
 * An executable launcher for an SDK that takes only a program path (no arguments): an
 * owner-only shell script in `dir` that execs `command` with its arguments, then the SDK's
 * own. Named by its content, so a changed confinement gets a new file and a running one is
 * never rewritten. `dir` must exist and be owner-only. Returns the script's path.
 */
export function writeLauncher(dir: string, name: string, command: { command: string; args: readonly string[] }): string {
  const script = `#!/bin/sh\nexec ${[command.command, ...command.args].map(quote).join(' ')} "$@"\n`
  const path = join(dir, `${name}-${createHash('sha256').update(script).digest('hex').slice(0, 16)}.sh`)
  try {
    writeFileSync(path, script, { mode: 0o700, flag: 'wx' })
    chmodSync(path, 0o700)
  } catch (error) {
    // Same name, same content: another run wrote it first.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return path
}

/** Runs a command and resolves its stdout; rejects on a non-zero exit. */
export type RunCommand = (command: string, args: string[]) => Promise<string>

const runCommand: RunCommand = async (command, args) => (await promisify(execFile)(command, args, { timeout: 15_000 })).stdout

/**
 * Prove on this host that `confinement` hides what it should: the confined command runs at
 * all, every hidden directory lists only the way down to the paths bound back, and no hidden
 * file can be read. Fails closed: a missing bubblewrap, or user namespaces the host refuses,
 * is `confined: false`.
 */
export async function proveConfinement(confinement: Confinement, run: RunCommand = runCommand): Promise<{ confined: boolean; detail: string }> {
  const kept = [...confinement.readOnly, ...confinement.writable].map(real).filter((p): p is string => !!p)
  const confined = (command: string, args: string[]) => {
    const c = confinedCommand(command, args, confinement)
    return run(c.command, c.args)
  }
  try {
    await confined('true', [])
  } catch (error) {
    return { confined: false, detail: `reads cannot be confined: ${(error as Error).message.split('\n')[0]!.slice(0, 160)}` }
  }
  for (const path of confinement.hide.map(real)) {
    if (!path) continue
    if (!statSync(path).isDirectory()) {
      // A hidden file is masked by an unreadable device node: reading it fails, or yields nothing.
      const read = await confined('cat', [path]).catch(() => '')
      if (read.length) return { confined: false, detail: `${path} is readable under ${confinement.bwrap}` }
      continue
    }
    const allowed = new Set(kept.filter((k) => k.startsWith(path + sep)).map((k) => relative(path, k).split(sep)[0]))
    const listing = await confined('ls', ['-A', path]).catch((error: Error) => error)
    if (listing instanceof Error) return { confined: false, detail: `${path} cannot be listed under ${confinement.bwrap}: ${listing.message.split('\n')[0]!.slice(0, 120)}` }
    const visible = listing.split('\n').filter(Boolean).filter((name) => !allowed.has(name))
    if (visible.length) return { confined: false, detail: `${path} still shows ${visible.length} entr${visible.length === 1 ? 'y' : 'ies'} under ${confinement.bwrap}` }
  }
  return { confined: true, detail: `host state hidden by ${confinement.bwrap}` }
}

/**
 * The environment an agent runtime's child process starts with (INV-8): DSH's own scrub of the
 * daemon environment (credential-shaped and `DSH_*` names removed; PATH, HOME, locale, proxy
 * kept), then the variables the operator forwards by name (never by value in configuration,
 * e.g. the gateway token a Codex Worker's model provider reads), then explicit values.
 */
export function childEnvironment(forward: readonly string[] = [], explicit: Record<string, string> = {}): Record<string, string> {
  const env = scrubbedParentEnv()
  for (const name of forward) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...explicit }
}
