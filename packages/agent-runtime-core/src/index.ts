/**
 * Capability seam definition: `ctx.agentRuntimes` (docs/design/agent-runtimes.md). An agent
 * runtime is an external coding agent (Claude Code, Codex, an ACP agent) that `system` runs
 * as a Worker. Each provider adapts behaviour to this seam; the agent's own objects
 * (sessions, threads, events) stay native, and only a handle crosses it (INV-7).
 * @module @tsuuanmi/system-agent-runtime-core
 */
import { execFile } from 'node:child_process'
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
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
  /**
   * It runs in the home a run or probe names ({@link RunSpec.home}, {@link ProbeOptions.home}), one
   * account's own sign-in, binding back only that home (ADR-0051). Absent or false: it runs in its
   * own configured home only, and refuses a run that names another.
   */
  homes?: boolean
}

/** What a probe is asked about (ADR-0051). */
export interface ProbeOptions {
  /**
   * Probe the account signed in to this home (an absolute path) instead of the provider's own
   * configured home. Only for a provider whose plain probe reports {@link RuntimeEvidence.homes}:
   * use {@link probeIn}, which never asks one that does not.
   */
  home?: string | undefined
}

/**
 * Who is signed in to a home, as a provider's identity reader reads it (ADR-0051). `verified`
 * carries the keyed hash of the principal ({@link identityHmac}), never the principal or a token
 * (INV-8). `missing`: the runtime's own sign-in check finds no sign-in; `ambiguous`: the principal
 * cannot be read whole; `unverified`: no reader is verified for this runtime version.
 */
export type IdentityReading =
  | {
    status: 'verified'
    /** HMAC-SHA256 of the provider and the principal's canonical parts, hex; compared in full. */
    hmac: string
    /** The reader that read it (an id), pinned to the versions a supervised check verified. */
    reader: string
    runtimeVersion: string
    /** A masked hint for the operator ({@link maskEmail}), when the runtime shows an email. */
    hint?: string | undefined
  }
  | {
    status: 'missing' | 'ambiguous' | 'unverified'
    /** Why, in a few words; never the principal. */
    reason: string
    reader?: string | undefined
    runtimeVersion?: string | undefined
  }

/** The runtime's own sign-in command for one home, run by the operator in their own terminal (ADR-0051). */
export interface LoginCommand {
  command: string
  args: string[]
  /**
   * The variables to set for it: the one naming the home (for example `CODEX_HOME`), and never a
   * session bus (`DBUS_SESSION_BUS_ADDRESS`), so the sign-in lands in the home's own files, where a
   * run, which starts without D-Bus, can read it.
   */
  env: Record<string, string>
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

/** How long a gate may take over one tool call by default (30 s); past it the call is denied. */
export const TOOL_GATE_MS = 30_000

/** Whether `verdict` is one the {@link ToolGate} contract defines: a `deny` with a reason, a `defer` with a reason and a request id. */
export function isToolVerdict(verdict: unknown): verdict is ToolVerdict {
  const v = verdict as Partial<{ decision: string; reason: unknown; requestId: unknown }> | null
  if (!v || typeof v !== 'object') return false
  if (v.decision === 'allow') return true
  if (v.decision === 'deny') return typeof v.reason === 'string'
  return v.decision === 'defer' && typeof v.reason === 'string' && typeof v.requestId === 'string' && v.requestId.length > 0
}

/**
 * Ask a run's gate about one tool call, as a gating provider must: bounded by `ms`, and fail-closed.
 * A gate that throws, gives a verdict the contract does not define, or does not answer in time is a
 * `deny` (INV-2), never a pass; the run's `signal` aborts the gate's own signal too.
 */
export async function askToolGate(gate: ToolGate, call: ToolCall, signal: AbortSignal, ms: number = TOOL_GATE_MS): Promise<ToolVerdict> {
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
    return isToolVerdict(verdict) ? verdict : { decision: 'deny', reason: 'the tool gate gave a verdict it does not define' }
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
  /**
   * The home the agent runs in (an absolute path): one account's own sign-in, the only home its
   * confinement binds back (ADR-0051). Absent: the provider's own configured home. A provider that
   * does not report {@link RuntimeEvidence.homes} refuses a run that names one (`config_error`),
   * before running anything, never ignores it.
   */
  home?: string | undefined
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

/** What a usage report is read for (ADR-0059). */
export interface LimitsOptions {
  /**
   * Read the report of the account signed in to this home (an absolute path) instead of the
   * provider's own configured home. A provider that does not report {@link RuntimeEvidence.homes}
   * answers a named home `unreadable`, never with its own home's report.
   */
  home?: string | undefined
}

/**
 * An account's usage report, read on request (ADR-0059): each window the runtime reports, as an
 * observation in the seam's units (a share used 0 to 100, ISO times), or why the report cannot be
 * read. An `unreadable` report records nothing: each window keeps its last reading.
 */
export type LimitReport = { limits: LimitObservation[] } | { unreadable: string }

/** How long one usage report may take by default (30 s); past it the report is `unreadable`. */
export const LIMITS_READ_MS = 30_000

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const LIMIT_STATUSES = ['allowed', 'warning', 'rejected']

/**
 * Why `observation` is not a {@link LimitObservation} as the seam defines it, or undefined when it
 * is: a window named (at most 128 characters), a status the seam names, ISO 8601 times, and a share
 * between 0 and 100.
 */
export function limitProblem(observation: unknown): string | undefined {
  const o = observation as Partial<Record<keyof LimitObservation, unknown>> | null
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'an observation is not an object'
  if (typeof o.window !== 'string' || !o.window.length || o.window.length > 128) return 'an observation names no window'
  if (typeof o.status !== 'string' || !LIMIT_STATUSES.includes(o.status)) return `the window ${o.window} has no status the seam names`
  const time = (value: unknown): boolean => typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))
  if (!time(o.observedAt)) return `the window ${o.window} has no ISO observedAt`
  if (o.resetsAt !== undefined && !time(o.resetsAt)) return `the window ${o.window} has a resetsAt that is not an ISO time`
  if (o.usedPercentage !== undefined && !(typeof o.usedPercentage === 'number' && o.usedPercentage >= 0 && o.usedPercentage <= 100)) return `the window ${o.window} has a used share outside 0 to 100`
  return undefined
}

/**
 * Read a provider's usage report as a Worker source must (ADR-0059): bounded by `ms`, aborted with
 * `signal`, and fail-closed. A provider without `limits`, one that throws, answers late, or answers
 * anything {@link LimitReport} does not define (an observation {@link limitProblem} refuses among
 * them) gives `unreadable`, with why, never a reading.
 */
export async function readLimits(provider: AgentRuntimeProvider, options: LimitsOptions, signal: AbortSignal, ms: number = LIMITS_READ_MS): Promise<LimitReport> {
  if (typeof provider.limits !== 'function') return { unreadable: `${provider.kind} reads no usage report` }
  if (signal.aborted) return { unreadable: 'the read was stopped before it started' }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    const late = new Promise<LimitReport>((resolve) => {
      timer = setTimeout(() => {
        resolve({ unreadable: `the usage report did not answer within ${ms / 1000} s` })
        controller.abort()
      }, ms)
    })
    const stopped = new Promise<LimitReport>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ unreadable: 'the read was stopped' }), { once: true })
    })
    const report = await Promise.race([provider.limits({ ...options }, controller.signal), late, stopped]) as unknown
    const r = report as Partial<{ limits: unknown; unreadable: unknown }> | null
    if (r && typeof r === 'object' && typeof r.unreadable === 'string' && r.limits === undefined) return { unreadable: r.unreadable.slice(0, 300) || 'it gave no reason' }
    if (!r || typeof r !== 'object' || r.unreadable !== undefined || !Array.isArray(r.limits)) return { unreadable: `${provider.kind} answered a report the seam does not define` }
    const problem = (r.limits as unknown[]).map(limitProblem).find((p) => p !== undefined)
    if (problem) return { unreadable: `${provider.kind} answered a report the seam does not define: ${problem}` }
    return { limits: (r.limits as LimitObservation[]).map((l) => ({ ...l })) }
  } catch (error) {
    return { unreadable: `the usage report failed: ${(error as Error)?.message?.split('\n')[0]!.slice(0, 200) ?? String(error)}` }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
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
  /**
   * Present when the run ended before the runtime's own final count of it (a stop, a timeout, a
   * deferred call): `usage` and `turns` are then what the agent reported while it ran, a lower bound
   * of what it consumed, and this says so in plain words (at most {@link MAX_PARTIAL} characters).
   * Never an invented figure: a number the agent did not report stays missing.
   */
  partial?: string | undefined
}

/** The longest {@link RunMetering.partial} a provider reports, in characters. */
export const MAX_PARTIAL = 300

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
 * What a run reports of itself while it runs, for its Worker source's liveness verdict (PROP-0013,
 * ADR-0056). Both are optional: a provider that reports neither leaves those signals unknown, and a
 * missing signal is never read as gone. A callback that throws changes nothing about the run.
 */
export interface RunObserver {
  /**
   * The agent process the run started: the outermost process of its confinement, whose end ends the
   * agent. Reported once, as soon as it exists.
   */
  onProcess?(process: { pid: number }): void
  /** The agent did something (a stream event, a tool call asked), at `at` (milliseconds since the epoch). May be called often. */
  onActivity?(at: number): void
}

/** Tell an observer, never letting it change the run: a callback that throws is ignored. */
export function observe(observer: RunObserver | undefined, event: { process: { pid: number } } | { activity: number }): void {
  try {
    if ('process' in event) observer?.onProcess?.(event.process)
    else observer?.onActivity?.(event.activity)
  } catch {
    // The run's own outcome never depends on what its source records of it.
  }
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
  /**
   * Its name for people (optional; at most {@link MAX_TITLE} characters, plain text on one line), such
   * as the agent's product name: the roster and the operator's listings show it before an account's
   * label and a Worker's role. Only a provider names its tool; never a routing input (INV-11).
   */
  readonly title?: string | undefined
  /**
   * Its own configured home (an absolute path), where a run that names none runs. Optional: a Worker
   * source adopts it, without moving it, as slot 1 of the runtime's accounts (ADR-0051).
   */
  readonly home?: string | undefined
  /** What it proves now, for its own home or, when it reports `homes`, the one `options.home` names. */
  probe(options?: ProbeOptions): Promise<RuntimeEvidence>
  /** `observer` (optional, PROP-0013): the agent process and its activity, as far as the provider can tell them. */
  run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void, observer?: RunObserver): Promise<RunResult>
  /**
   * Who is signed in to `home`, read under the same confinement as a run, hashed with `key` (the
   * per-install key, at least 16 bytes) by {@link identityHmac} (ADR-0051). Optional: a provider
   * without it has no verified reader, so its accounts are `unverified`. It never throws for a home
   * it cannot read: that reading is `missing` or `ambiguous`.
   */
  identity?(home: string, key: Uint8Array): Promise<IdentityReading>
  /** The runtime's own sign-in command for `home` ({@link LoginCommand}); optional, with `identity`. */
  loginCommand?(home: string): LoginCommand
  /**
   * The usage report of the account signed in to `options.home` (its own home when absent), every
   * window it reports as an observation (ADR-0059). Read under the same confinement and with the same
   * scrubbed environment as its probe, starting no model turn, spending no quota a run would, and
   * leaving no conversation behind: a runtime whose report cannot promise that does not implement it
   * (optional). It reads a format only on a runtime version whose format was checked, and on another
   * answers `unreadable`, naming the version. It never throws for a report it cannot read, a home it
   * does not run in, or an aborted `signal`: that is `unreadable`, with why. Ask it through
   * {@link readLimits}, which bounds it.
   */
  limits?(options: LimitsOptions, signal: AbortSignal): Promise<LimitReport>
}

/** The most characters of a runtime's {@link AgentRuntimeProvider.title}. */
export const MAX_TITLE = 64

/** A provider's title when it gives a usable one (1 to {@link MAX_TITLE} characters, no control character); otherwise none. */
export function titleOf(provider: Pick<AgentRuntimeProvider, 'title'> | undefined): string | undefined {
  const title = provider?.title
  return typeof title === 'string' && /^[^\p{Cc}]{1,64}$/u.test(title) ? title : undefined
}

/**
 * The keyed hash of a principal (ADR-0051): HMAC-SHA256, keyed by the per-install key, over the
 * provider and the principal's parts in a canonical order. A plain hash of an email or an account id
 * could be reversed by guessing; the key keeps the id from revealing the person. Refuses an empty
 * part, a part that is not a string, or a short key: a principal read in part is `ambiguous`, never
 * hashed.
 */
export function identityHmac(key: Uint8Array, provider: string, parts: Readonly<Record<string, string>>): string {
  if (key.length < 16) throw new RangeError('identityHmac: the key must be at least 16 bytes')
  const names = Object.keys(parts).sort()
  if (!provider || !names.length) throw new RangeError('identityHmac: a provider and at least one principal part are required')
  for (const name of names) {
    if (typeof parts[name] !== 'string' || !parts[name]) throw new RangeError(`identityHmac: the principal part ${name} is empty`)
  }
  const canonical = JSON.stringify([provider, names.map((name) => [name, parts[name]])])
  return createHmac('sha256', key).update(canonical).digest('hex')
}

/** An agent account's id (ADR-0051): `<provider>:<first 16 hex characters of its HMAC>`. */
export function accountIdOf(provider: string, hmac: string): string {
  if (!/^[0-9a-f]{64}$/.test(hmac)) throw new RangeError('accountIdOf: the HMAC is 64 hex characters')
  return `${provider}:${hmac.slice(0, 16)}`
}

/** The most bytes an identity reader reads of one file in a home ({@link readHomeJson}). */
export const MAX_HOME_FILE_BYTES = 1024 * 1024

/**
 * One JSON file of a home, as an identity reader reads it (ADR-0051): `absent` when there is none;
 * `refused` (with why, never the content) when it is not a regular file of this user (a symlink a run
 * planted in its writable home included: it is never followed), is larger than
 * {@link MAX_HOME_FILE_BYTES}, or is not a JSON object; else its parsed value. A run can write its own
 * home, so nothing here trusts the file beyond its shape, and the caller reads only the fields its
 * reader names.
 */
export function readHomeJson(path: string): { state: 'absent' } | { state: 'refused'; why: string } | { state: 'read'; value: Record<string, unknown> } {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' }
    return { state: 'refused', why: code === 'ELOOP' ? 'it is a symbolic link' : `it cannot be opened (${code ?? 'error'})` }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { state: 'refused', why: 'it is not a regular file' }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return { state: 'refused', why: 'it belongs to another user' }
    if (stat.size > MAX_HOME_FILE_BYTES) return { state: 'refused', why: `it is larger than ${MAX_HOME_FILE_BYTES} bytes` }
    let value: unknown
    try {
      value = JSON.parse(readFileSync(fd, 'utf8'))
    } catch {
      return { state: 'refused', why: 'it is not JSON' }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? { state: 'read', value: value as Record<string, unknown> } : { state: 'refused', why: 'it is not a JSON object' }
  } finally {
    closeSync(fd)
  }
}

/**
 * Whether `home` can hold an account's sign-in for a run or a reading (ADR-0051): an existing
 * directory of this user, not a symbolic link, that group and others cannot reach. Undefined when it
 * can; else why not. A home is never created here: an enrollment slot creates its own.
 */
export function homeProblem(home: string): string | undefined {
  if (!isAbsolute(home)) return `the home ${home} is not an absolute path`
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(home)
  } catch {
    return `the home ${home} does not exist`
  }
  if (!stat.isDirectory()) return `the home ${home} is not a directory`
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return `the home ${home} belongs to another user`
  if ((stat.mode & 0o077) !== 0) return `the home ${home} is reachable by group or others (mode ${(stat.mode & 0o777).toString(8)})`
  return undefined
}

/** An email masked for the operator (`j…@example.com`): its first letter and its domain; undefined for anything else. */
export function maskEmail(email: string): string | undefined {
  // Read by hand rather than by `^([^@\s])[^@\s]*@([^@\s]+\.[^@\s]+)$`, which backtracks polynomially
  // on a long run of dots (CodeQL js/polynomial-redos); it accepts exactly what that expression did.
  if (/\s/.test(email)) return undefined
  const at = email.indexOf('@')
  if (at < 1 || at !== email.lastIndexOf('@')) return undefined
  const domain = email.slice(at + 1)
  if (!domain.slice(1, -1).includes('.')) return undefined
  return `${email[0]}…@${domain}`
}

/**
 * Probe the account signed in to `home` (ADR-0051), failing closed: a provider whose own probe does
 * not report `homes` would answer for its own home, so it is not asked, and the evidence is
 * unavailable; so is a home that is not an absolute path.
 */
export async function probeIn(provider: AgentRuntimeProvider, home: string): Promise<RuntimeEvidence> {
  const own = await provider.probe()
  if (!own.homes) return { ...own, available: false, detail: `${provider.kind} runs in its own configured home only, not in ${home}` }
  if (!isAbsolute(home)) return { ...own, available: false, detail: `the home ${home} is not an absolute path` }
  return provider.probe({ home })
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

/**
 * The temporary directory of every confined command: a fresh tmpfs of its own at `/tmp`, never the
 * host's, which `TMPDIR`, `TMP`, and `TEMP` name, so a tool's temporary files and sockets (a test
 * runner's IPC pipe, a compiler's cache) land there whatever the daemon's own temporary directory is.
 */
export const PRIVATE_TMP = '/tmp'

interface Plan {
  /** Hidden roots that exist: no other hidden path contains them. */
  hidden: Array<{ path: string; dir: boolean }>
  /** Every hidden path that exists, roots or not (real paths). */
  hides: string[]
  binds: Array<{ path: string; writable: boolean }>
  /** Hide entries that do not exist on this host (a typo, or nothing to hide yet). */
  absent: string[]
  /** Binds that would re-expose a hidden path, or the host's temporary directory. */
  conflicts: string[]
  /** The host's `/tmp` (its real path), when no hidden directory already lies over it: a tmpfs is mounted there. */
  tmp?: string
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
  // The host's /tmp is never seen: hidden like the rest when the confinement names it, else a tmpfs of its own.
  const host = real(PRIVATE_TMP)
  const covered = host !== undefined && [...hides.keys()].some((h) => h === host || under(host, h))
  const masked = [...hides.keys(), ...(host !== undefined && !covered ? [host] : [])]
  const conflicts = [...binds.keys()].flatMap((bind) => masked.filter((h) => h === bind || under(h, bind)).map((h) => `binding back ${bind} would expose ${h}`))
  const hidden = [...hides].filter(([path]) => ![...hides.keys()].some((other) => other !== path && under(path, other))).map(([path, dir]) => ({ path, dir }))
  return { hidden, hides: masked, binds: [...binds].map(([path, writable]) => ({ path, writable })), absent, conflicts, ...(host !== undefined && !covered ? { tmp: host } : {}) }
}

/**
 * More than the read confinement, for a command a Worker source runs itself rather than an agent
 * (a run's worktree setup, docs/design/agent-runtimes.md#a-worktrees-setup). Every field is optional;
 * none given, the command runs as an agent child does.
 */
export interface ConfinedCommandOptions {
  /**
   * The host's file system is read-only to the child: only the confinement's `writable` binds, the
   * tmpfs that hides each hidden directory (its private `/tmp` among them), and writable `views` can
   * be written. Default: the host as writable as it is to the daemon.
   */
  readOnly?: boolean
  /** `false`: no network, a network namespace of the child's own with only its loopback. Default: the host's network. */
  network?: false
  /** The directory the child starts in (absolute). */
  chdir?: string
  /**
   * Host directories seen at another path, mounted in this order after every other mount: `source`
   * at `path`, writable or read-only. Like a bind, a view whose source is, or holds, a hidden path
   * is refused, and so is one whose source does not exist. A source inside a hidden directory is
   * the caller's to choose, as a bind's is.
   */
  views?: ReadonlyArray<{ source: string; path: string; writable: boolean }>
}

/**
 * The command line that runs `command args` under `confinement`: its own PID namespace (with
 * its own /proc) and session, so nothing it starts outlives it and it cannot reach the
 * daemon's terminal; then the mounts, shallowest first, so a path bound back lies over the
 * tmpfs that hides its parent; then `options`' views. Its temporary directory is always a fresh
 * tmpfs of its own at {@link PRIVATE_TMP} (the confinement's when it hides `/tmp`, else one mounted
 * there), writable whatever `readOnly` says, and `TMPDIR`, `TMP`, and `TEMP` name it, over any value
 * of its environment. Throws when a bind or a view would re-expose a hidden path or the host's `/tmp`.
 */
export function confinedCommand(command: string, args: readonly string[], confinement: Confinement, options: ConfinedCommandOptions = {}): { command: string; args: string[] } {
  const { hidden, hides, binds, conflicts, tmp } = plan(confinement)
  if (conflicts.length) throw new Error(`read confinement refused: ${conflicts[0]}`)
  const views = (options.views ?? []).map((view) => {
    const source = real(view.source)
    if (!source) throw new Error(`read confinement refused: the view source ${view.source} does not exist`)
    if (!isAbsolute(view.path)) throw new Error(`read confinement refused: the view path ${view.path} is not absolute`)
    const exposed = hides.find((h) => h === source || under(h, source))
    if (exposed) throw new Error(`read confinement refused: the view of ${source} would expose ${exposed}`)
    return [view.writable ? '--bind' : '--ro-bind', source, view.path]
  })
  if (options.chdir !== undefined && !isAbsolute(options.chdir)) throw new Error(`read confinement refused: the start directory ${options.chdir} is not absolute`)
  const mounts = [
    ...(tmp !== undefined ? [{ path: tmp, args: ['--tmpfs', tmp] }] : []),
    ...hidden.map((h) => ({ path: h.path, args: h.dir ? ['--tmpfs', h.path] : ['--ro-bind', '/dev/null', h.path] })),
    ...binds.map((b) => ({ path: b.path, args: [b.writable ? '--bind' : '--ro-bind', b.path, b.path] })),
  ].sort((a, b) => depth(a.path) - depth(b.path))
  const root = options.readOnly ? ['--ro-bind', '/', '/', '--dev', '/dev'] : ['--dev-bind', '/', '/']
  const argv = [
    '--die-with-parent', '--unshare-pid', ...(options.network === false ? ['--unshare-net'] : []), '--new-session', ...root, '--proc', '/proc',
    ...mounts.flatMap((m) => m.args), ...views.flat(), ...(options.chdir !== undefined ? ['--chdir', options.chdir] : []),
    ...['TMPDIR', 'TMP', 'TEMP'].flatMap((name) => ['--setenv', name, PRIVATE_TMP]),
  ]
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
