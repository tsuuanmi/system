/**
 * Capability seam definition: `ctx.agentRuntimes` (docs/design/agent-runtimes.md). An agent
 * runtime is an external coding agent (Claude Code, Codex, an ACP agent) that `system` runs
 * as a Worker. Each provider adapts behaviour to this seam; the agent's own objects
 * (sessions, threads, events) stay native, and only a handle crosses it (INV-7).
 * @module @tsuuanmi/system-agent-runtime-core
 */
import { execFile } from 'node:child_process'
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
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
  /**
   * Every tool call the agent makes passes the run's {@link RunSpec.toolGate} before it runs, and a
   * `defer` stops the run at that call. A Worker source that gates its runs admits no Worker
   * without it.
   */
  gatesToolCalls: boolean
}

/** One tool call an agent is about to make, as its runtime reports it. */
export interface ToolCall {
  /** The tool's name, as the runtime names it. */
  tool: string
  /** The tool's input, as the agent gave it. */
  input: unknown
  /** The runtime's own id of this call, when it has one (opaque). */
  callId?: string | undefined
}

/**
 * What a run's gate says about one tool call. `allow` lets the call through to the runtime's own
 * policy, which still holds (an allowed call outside the workspace stays refused); `deny` refuses
 * it, and the agent is told `reason`; `defer` stops the run at the call without running it, until
 * the approval request `requestId` is answered.
 */
export type ToolVerdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'defer'; reason: string; requestId: string }

/**
 * A per-tool-call gate, from the Worker source that owns the run (trusted, INV-6). A provider that
 * gates (`gatesToolCalls`) asks it before every tool call, subagents' included, and treats a gate
 * that throws, or does not answer within the provider's own bound, as `deny`. After a `defer`, the
 * provider runs no further tool call and ends the run, rejecting with a `config_error` that names
 * the request: a deferred run never completes. A provider that cannot ask it before every tool
 * call refuses a run that carries one (`config_error`), never ignores it.
 */
export type ToolGate = (call: ToolCall, signal: AbortSignal) => Promise<ToolVerdict>

/** Whether `verdict` is one the gate's contract defines: `allow`, `deny` with a reason, or `defer` with a reason and a request id. */
function definedVerdict(verdict: unknown): verdict is ToolVerdict {
  const v = verdict as Partial<{ decision: string; reason: unknown; requestId: unknown }> | null
  if (!v || typeof v !== 'object') return false
  if (v.decision === 'allow') return true
  if (v.decision === 'deny') return typeof v.reason === 'string'
  return v.decision === 'defer' && typeof v.reason === 'string' && typeof v.requestId === 'string' && v.requestId.length > 0
}

/**
 * Ask a run's gate about one tool call, bounded, as every runtime that gates must: a gate that
 * throws, answers a verdict the contract does not define, or does not answer within `ms` is a
 * deny, never a pass (INV-2). The signal the gate is given aborts when `signal` does or the bound
 * passes.
 */
export async function askToolGate(gate: ToolGate, call: ToolCall, signal: AbortSignal, ms: number): Promise<ToolVerdict> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    const late = new Promise<ToolVerdict>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ decision: 'deny', reason: `the tool gate did not answer within ${ms / 1000} s` })
      }, ms)
    })
    const verdict = await Promise.race([gate(call, controller.signal), late])
    return definedVerdict(verdict) ? verdict : { decision: 'deny', reason: 'the tool gate gave a verdict it does not define' }
  } catch (error) {
    return { decision: 'deny', reason: `the tool gate failed: ${(error as Error)?.message?.slice(0, 200) ?? String(error)}` }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
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
  /** Asked before every tool call the agent makes ({@link ToolGate}). */
  toolGate?: ToolGate | undefined
}

/**
 * Token counts of a run, normalized as the ledger counts them (the `tokenUsage` definition in
 * `schemas/common.v1.json`, named after the OpenTelemetry GenAI usage attributes): `inputTokens`
 * includes cached input, and the two cache counts are parts of it. A provider whose agent reports
 * input without its cached part adds the cached part before it reports.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

/** One model's share of a run's usage, as the runtime reports it. */
export interface ModelUsage {
  model: string
  usage: TokenUsage
  /** The runtime's own estimate for this model, in USD. */
  costUsd?: number
}

/**
 * A rate-limit observation the agent reported during a run. `window` is the runtime's own name
 * for the limit window, opaque here: the operator's configuration maps it to a pool's window
 * (INV-11), and an unmapped one is not read.
 */
export interface LimitObservation {
  window: string
  /** `allowed`: under the limit; `warning`: near it; `rejected`: hit, no more work until it resets. */
  status: 'allowed' | 'warning' | 'rejected'
  /** When the window resets (ISO 8601), when the runtime says. */
  resetsAt?: string
  /** How much of the window is used, 0 to 100, when the runtime says. */
  usedPercentage?: number
  /** When the observation was made (ISO 8601). */
  observedAt: string
}

/**
 * What a run consumed, from the runtime's own objective numbers (docs/design/resources.md),
 * never from the model's own report. Every field is optional: a missing number stays missing.
 * When `usage` and `models` are both present, each count of `usage` is the sum over `models`.
 */
export interface RunMetering {
  /** The runtime's own identity of the result the numbers come from (a deduplication key, opaque). */
  resultId?: string | undefined
  /** The model the run's main loop answered with, as the runtime names it. */
  model?: string | undefined
  /** The whole run's usage, every model and subagent included. */
  usage?: TokenUsage | undefined
  /** The same usage split per model. */
  models?: ModelUsage[] | undefined
  turns?: number | undefined
  /** The runtime's own estimate for the whole run, in USD. */
  costUsd?: number | undefined
  /** The rate-limit observations the agent reported during the run, in the order seen. */
  limits?: LimitObservation[] | undefined
}

export interface RunResult extends RunMetering {
  /** The agent's final message. */
  text: string
  /** Native session or thread handle, to continue it later. */
  nativeHandle?: string | undefined
}

const METERING = Symbol.for('@tsuuanmi/system-agent-runtime-core/metering')

/**
 * Attach what a failed or aborted run consumed to the error `run` rejects with, so the run is
 * metered like a completed one (`usage-record` outcome `failed` or `aborted`). Returns `error`.
 */
export function withMetering<E extends Error>(error: E, metering: RunMetering): E {
  Object.defineProperty(error, METERING, { value: metering, enumerable: false, configurable: true })
  return error
}

/** What a failed or aborted run consumed, when its runtime attached it (`withMetering`). */
export function meteringOf(error: unknown): RunMetering | undefined {
  return error instanceof Error ? (error as Error & { [METERING]?: RunMetering })[METERING] : undefined
}

/**
 * One agent runtime. `run` drives the agent's own loop to its terminal event. A policy the
 * runtime cannot enforce exactly is refused (an error of kind `config_error`); it is never
 * loosened. Errors carry a `kind` from the provider failure taxonomy (provider-core). A run
 * reports what it consumed (`RunMetering`) when its agent says, in its result, or attached to the
 * error it fails with (`withMetering`).
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
   * The read confinement for an agent child (ADR-0024): what is always hidden, the operator's
   * configuration, and every registered secret path; with `bind` (the child's own home and its
   * workspace, when they live under a hidden directory) bound back.
   */
  abstract confinement(bind?: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement
}

/**
 * What an agent child must not read, and what it still needs from inside those paths
 * (ADR-0024). Applied with bubblewrap: the child sees the host as it is, except that each
 * hidden directory is an empty tmpfs and each hidden file an unreadable device node. It runs in
 * its own PID namespace and session, and dies with its launcher.
 */
export interface Confinement {
  /** The bubblewrap executable (an absolute path). */
  bwrap: string
  /**
   * Directories and files hidden from the child: the DSH home, the runtime and temporary
   * directories, credential stores, and every secret path a plugin registered.
   */
  hide: readonly string[]
  /** Paths under a hidden directory bound back read-only (operator-installed tools, a read-only workspace). */
  readOnly: readonly string[]
  /** Paths under a hidden directory bound back writable (the child's own home, a writable workspace). */
  writable: readonly string[]
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const under = (path: string, root: string): boolean => path.startsWith(root.endsWith(sep) ? root : root + sep)
const depth = (path: string): number => path.split(sep).filter(Boolean).length

interface Plan {
  /** Hidden roots that exist: no other hidden path contains them. */
  hidden: Array<{ path: string; dir: boolean }>
  binds: Array<{ path: string; writable: boolean }>
  /** Hide entries that do not exist on this host (a typo, or nothing to hide yet). */
  absent: string[]
  /** Binds that would re-expose a hidden path. */
  conflicts: string[]
}

function plan(confinement: Confinement): Plan {
  const absent: string[] = []
  const hides = new Map<string, boolean>()
  for (const entry of confinement.hide) {
    const path = real(entry)
    if (!path) absent.push(entry)
    else hides.set(path, statSync(path).isDirectory())
  }
  const binds = new Map<string, boolean>()
  for (const [list, writable] of [[confinement.readOnly, false], [confinement.writable, true]] as const) {
    for (const entry of list) {
      const path = real(entry)
      if (path) binds.set(path, writable || (binds.get(path) ?? false))
    }
  }
  const conflicts = [...binds.keys()].flatMap((bind) => [...hides.keys()].filter((h) => h === bind || under(h, bind)).map((h) => `binding back ${bind} would expose ${h}`))
  const hidden = [...hides].filter(([path]) => ![...hides.keys()].some((other) => other !== path && under(path, other))).map(([path, dir]) => ({ path, dir }))
  return { hidden, binds: [...binds].map(([path, writable]) => ({ path, writable })), absent, conflicts }
}

/**
 * The command line that runs `command args` under `confinement`: its own PID namespace (with
 * its own /proc) and session, so nothing it starts outlives it and it cannot reach the
 * daemon's terminal; then the mounts, shallowest first, so a path bound back lies over the
 * tmpfs that hides its parent. Throws when a bind would re-expose a hidden path.
 */
export function confinedCommand(command: string, args: readonly string[], confinement: Confinement): { command: string; args: string[] } {
  const { hidden, binds, conflicts } = plan(confinement)
  if (conflicts.length) throw new Error(`read confinement refused: ${conflicts[0]}`)
  const mounts = [
    ...hidden.map((h) => ({ path: h.path, args: h.dir ? ['--tmpfs', h.path] : ['--ro-bind', '/dev/null', h.path] })),
    ...binds.map((b) => ({ path: b.path, args: [b.writable ? '--bind' : '--ro-bind', b.path, b.path] })),
  ].sort((a, b) => depth(a.path) - depth(b.path))
  const argv = ['--die-with-parent', '--unshare-pid', '--new-session', '--dev-bind', '/', '/', '--proc', '/proc', ...mounts.flatMap((m) => m.args)]
  return { command: confinement.bwrap, args: [...argv, '--', command, ...args] }
}

const quote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`

/**
 * An executable launcher for an SDK that takes only a program path (no arguments): an
 * owner-only shell script in `dir` that execs `command` with its arguments, then the SDK's
 * own. Named by its content and written whole (a temporary file, then a rename), so a crash
 * never leaves a short launcher; an existing file is used only when it is a regular, single-link,
 * owner-only file of this user with exactly that content, and replaced otherwise. `dir` must be
 * owner-only. Returns the script's path.
 */
export function writeLauncher(dir: string, name: string, command: { command: string; args: readonly string[] }): string {
  const script = `#!/bin/sh\nexec ${[command.command, ...command.args].map(quote).join(' ')} "$@"\n`
  const path = join(dir, `${name}-${createHash('sha256').update(script).digest('hex').slice(0, 16)}.sh`)
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      const own = typeof process.getuid !== 'function' || stat.uid === process.getuid()
      if (stat.isFile() && own && stat.nlink === 1 && (stat.mode & 0o777) === 0o700 && readFileSync(fd, 'utf8') === script) return path
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // ELOOP: a symlink planted at the name; it is replaced below.
    if (code !== 'ENOENT' && code !== 'ELOOP') throw error
  }
  const temp = join(dir, `.${name}-${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700)
  try {
    writeFileSync(fd, script)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(temp, 0o700)
  renameSync(temp, path)
  return path
}

/** Runs a command and resolves its stdout; rejects on a non-zero exit. */
export type RunCommand = (command: string, args: string[]) => Promise<string>

const runCommand: RunCommand = async (command, args) => (await promisify(execFile)(command, args, { timeout: 15_000 })).stdout

/**
 * Prove on this host, positively, that `confinement` hides what it should. Fails closed: a
 * missing bubblewrap, user namespaces the host refuses, or any check below is `confined: false`.
 * 1. No bind re-exposes a hidden path, and the confined command runs at all.
 * 2. Inside, every hidden directory, and every directory on the way down to a path bound back,
 *    is a different directory from the host's (the tmpfs, by device and inode), and lists only
 *    the next component of a path bound back.
 * 3. Inside, every hidden file is the null device (character device 1:3), never the file.
 */
export async function proveConfinement(confinement: Confinement, run: RunCommand = runCommand): Promise<{ confined: boolean; detail: string }> {
  const { hidden, binds, absent, conflicts } = plan(confinement)
  if (conflicts.length) return { confined: false, detail: `read confinement refused: ${conflicts[0]}` }
  const confined = (command: string, args: string[]) => {
    const c = confinedCommand(command, args, confinement)
    return run(c.command, c.args)
  }
  const fail = (detail: string) => ({ confined: false, detail })
  try {
    await confined('true', [])
  } catch (error) {
    return fail(`reads cannot be confined: ${(error as Error).message.split('\n')[0]!.slice(0, 160)}`)
  }
  // The directories a child sees masked: each hidden directory, and each on the way to a bind.
  const masked = new Map<string, Set<string>>()
  for (const h of hidden.filter((h) => h.dir)) masked.set(h.path, new Set())
  for (const b of binds) {
    const root = hidden.find((h) => h.dir && under(b.path, h.path))
    if (!root) continue
    const parts = relative(root.path, b.path).split(sep)
    let dir = root.path
    for (const part of parts) {
      masked.get(dir)!.add(part)
      dir = join(dir, part)
      if (dir !== b.path && !masked.has(dir)) masked.set(dir, new Set())
    }
  }
  const files = hidden.filter((h) => !h.dir).map((h) => h.path)
  try {
    const lines = (await confined('stat', ['-c', '%n|%d:%i|%F|%t:%T', '--', ...masked.keys(), ...files])).split('\n').filter(Boolean)
    const inside = new Map(lines.map((line) => {
      const [name, id, type, device] = line.split('|')
      return [name!, { id: id!, type: type!, device: device! }]
    }))
    for (const dir of masked.keys()) {
      const host = statSync(dir)
      if (inside.get(dir)?.id === `${host.dev}:${host.ino}`) return fail(`${dir} is the host directory under ${confinement.bwrap}, not masked`)
    }
    for (const file of files) {
      const seen = inside.get(file)
      if (seen?.type !== 'character special file' || seen.device !== '1:3') return fail(`${file} is not masked by the null device under ${confinement.bwrap}`)
    }
    for (const [dir, allowed] of masked) {
      const visible = (await confined('ls', ['-A', dir])).split('\n').filter(Boolean).filter((name) => !allowed.has(name))
      if (visible.length) return fail(`${dir} still shows ${visible.length} entr${visible.length === 1 ? 'y' : 'ies'} under ${confinement.bwrap}`)
    }
  } catch (error) {
    return fail(`the confinement could not be inspected: ${(error as Error).message.split('\n')[0]!.slice(0, 160)}`)
  }
  return { confined: true, detail: `host state hidden by ${confinement.bwrap}${absent.length ? ` (not present, nothing to hide: ${absent.join(', ')})` : ''}` }
}

/**
 * Variables that lead to the operator's session rather than hold a secret: its message bus,
 * key agents, and displays. An agent never gets them unless the operator forwards one by name.
 */
const SESSION_ACCESS = ['DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']

/**
 * The environment an agent runtime's child process starts with (INV-8): DSH's own scrub of the
 * daemon environment (credential-shaped and `DSH_*` names removed; PATH, HOME, locale, proxy
 * kept) without the session-access variables, then the variables the operator forwards by
 * name (never by value in configuration, e.g. the gateway token a Codex Worker's model
 * provider reads), then explicit values.
 */
export function childEnvironment(forward: readonly string[] = [], explicit: Record<string, string> = {}): Record<string, string> {
  const env = scrubbedParentEnv()
  for (const name of SESSION_ACCESS) delete env[name]
  for (const name of forward) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...explicit }
}
