/**
 * The liveness verdict (PROP-0013 phases L1 and L2, ADR-0056): whether a run that another process
 * held, or held before a restart, is gone. A pure rule over recorded signals and two configured
 * bounds, pinned by version, beside the probes that read the signals on this host. Only `dead` is
 * death: a probe that fails, a signal never reported, and every combination the rule does not name
 * are `unknown` (INV-2), so nothing is reconciled as gone on a missing fact (INV-4).
 */
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

/** The rule's id and version, as a decision that applies it names its decider. */
export const LIVENESS_RULE = { id: 'liveness', version: '1' } as const

/** The verdicts, in the rule's own words. */
export type LivenessVerdict = 'alive' | 'stalled' | 'unknown' | 'dead'
export const LIVENESS_VERDICTS: readonly LivenessVerdict[] = ['alive', 'stalled', 'unknown', 'dead']

/**
 * A process as recorded: the host and the boot it ran in, its pid, and its start time in clock ticks
 * after boot (field 22 of `/proc/<pid>/stat`), which tells a reused pid apart.
 */
export interface ProcessIdentity {
  host: string
  boot: string
  pid: number
  startTicks: number
}

/** What a probe of a process found: there, positively gone (why), or it cannot tell (why). */
export type ProcessProbe = { state: 'present' } | { state: 'gone'; why: string } | { state: 'unknown'; why: string }

/** What a probe of a lease found: still live, positively lapsed (expired, released, or taken over; why), or it cannot tell (why). */
export type LeaseProbe = { state: 'live' } | { state: 'lapsed'; why: string } | { state: 'unknown'; why: string }

/** The signals of one run, each as its probe found it now. */
export interface LivenessSignals {
  /** When the verdict is given (milliseconds since the epoch). */
  at: number
  /** The holder: its lease on the run, and the process that held it. */
  holder: { lease: LeaseProbe; process: ProcessProbe }
  /** The agent process the run's runtime started. */
  runtime: ProcessProbe
  /** The latest activity seen of the run (milliseconds since the epoch); undefined when none was ever recorded. */
  lastActivityAt?: number | undefined
}

/** The rule's two bounds, from configuration (INV-9). */
export interface LivenessBounds {
  /** No activity for this long, the agent process present: `stalled`. */
  stallSeconds: number
  /** No activity for this long, with the holder and the agent process positively gone: `dead`. */
  deadAfterSeconds: number
}

export interface Liveness {
  verdict: LivenessVerdict
  /** Each signal as found, in a fixed order: the holder's lease, the holder's process, the agent process, the activity. */
  reasons: string[]
  rule: typeof LIVENESS_RULE
  /**
   * For `unknown` only, when every probe found its signal gone and only the activity bound is not yet
   * past: when it will be (milliseconds since the epoch), so a caller looks again then.
   */
  recheckAt?: number
}

/**
 * The verdict (PROP-0013, the liveness table):
 * - `dead`: the holder's lease lapsed and its process is gone, the agent process is gone, and no
 *   activity was seen within `deadAfterSeconds`;
 * - `alive`: the holder's lease is live and the agent process present, with activity within `stallSeconds`;
 * - `stalled`: the agent process present, with no activity for `stallSeconds` or more;
 * - `unknown`: anything else, a failed probe or a signal never reported among it.
 * Throws a `RangeError` on bounds that are not positive whole seconds.
 */
export function livenessOf(signals: LivenessSignals, bounds: LivenessBounds): Liveness {
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isInteger(value) || value <= 0) throw new RangeError(`livenessOf: ${name} must be a positive whole number of seconds`)
  }
  const { at, holder, runtime, lastActivityAt } = signals
  // Activity stamped after `at` (another clock) counts as just now.
  const quietMs = lastActivityAt === undefined || !Number.isFinite(lastActivityAt) ? undefined : Math.max(0, at - lastActivityAt)
  const reasons = [
    `the holder's lease: ${describe(holder.lease)}`,
    `the holder's process: ${describe(holder.process)}`,
    `the agent process: ${describe(runtime)}`,
    quietMs === undefined ? 'activity: none was ever recorded' : `activity: the latest ${Math.floor(quietMs / 1000)} s ago`,
  ]
  const verdict = (v: LivenessVerdict, extra: Partial<Liveness> = {}): Liveness => ({ verdict: v, reasons, rule: LIVENESS_RULE, ...extra })
  const holderGone = holder.lease.state === 'lapsed' && holder.process.state === 'gone'
  if (holderGone && runtime.state === 'gone' && quietMs !== undefined) {
    if (quietMs >= bounds.deadAfterSeconds * 1000) return verdict('dead')
    return verdict('unknown', { recheckAt: lastActivityAt! + bounds.deadAfterSeconds * 1000 })
  }
  if (runtime.state === 'present' && quietMs !== undefined) {
    if (quietMs >= bounds.stallSeconds * 1000) return verdict('stalled')
    if (holder.lease.state === 'live') return verdict('alive')
  }
  return verdict('unknown')
}

function describe(probe: LeaseProbe | ProcessProbe): string {
  return 'why' in probe ? `${probe.state} (${probe.why})` : probe.state
}

/** How a probe reads a file: `readFileSync` as text, or a stand-in in a test. */
export type ReadText = (path: string) => string

const readText: ReadText = (path) => readFileSync(path, 'utf8')

/** This host's name, as a recorded process names it. */
export function hostOf(): string {
  return hostname()
}

/** The identity of the running process `pid` on this host, or undefined when it cannot be read (no such process, no `/proc`). */
export function processIdentity(pid: number, read: ReadText = readText): ProcessIdentity | undefined {
  try {
    const boot = bootOf(read)
    const stat = statOf(read(`/proc/${pid}/stat`))
    if (!boot || !stat || stat.state === 'Z' || stat.state === 'X') return undefined
    return { host: hostOf(), boot, pid, startTicks: stat.startTicks }
  } catch {
    return undefined
  }
}

let self: ProcessIdentity | null | undefined
/** This process's own identity (read once), or undefined when it cannot be read. */
export function currentProcess(): ProcessIdentity | undefined {
  if (self === undefined) self = processIdentity(process.pid) ?? null
  return self ?? undefined
}

/**
 * Whether a recorded process is still there, read from this host's `/proc`. `gone` only on positive
 * evidence: the host restarted since (another boot id), no process has its pid, the one that has it
 * started at another time (a reused pid), or it has exited (a zombie). Never reported, recorded on
 * another host, or anything that cannot be read is `unknown`.
 */
export function probeProcess(recorded: ProcessIdentity | undefined, read: ReadText = readText): ProcessProbe {
  if (!recorded) return { state: 'unknown', why: 'never reported' }
  if (recorded.host !== hostOf()) return { state: 'unknown', why: `it ran on another host (${recorded.host.slice(0, 64)})` }
  let boot: string | undefined
  try {
    boot = bootOf(read)
  } catch (error) {
    return { state: 'unknown', why: `this host's boot id cannot be read (${codeOf(error)})` }
  }
  if (!boot) return { state: 'unknown', why: 'this host\'s boot id cannot be read' }
  if (boot !== recorded.boot) return { state: 'gone', why: 'the host restarted since it was recorded' }
  let text: string
  try {
    text = read(`/proc/${recorded.pid}/stat`)
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ESRCH') return { state: 'gone', why: `no process ${recorded.pid} exists` }
    return { state: 'unknown', why: `process ${recorded.pid} cannot be read (${codeOf(error)})` }
  }
  const stat = statOf(text)
  if (!stat) return { state: 'unknown', why: `process ${recorded.pid}'s status cannot be read` }
  if (stat.startTicks !== recorded.startTicks) return { state: 'gone', why: `pid ${recorded.pid} now belongs to a process started at another time` }
  if (stat.state === 'Z' || stat.state === 'X') return { state: 'gone', why: `process ${recorded.pid} has exited` }
  return { state: 'present' }
}

/** A recorded identity read back from its stored JSON, or undefined when it is not one. */
export function processIdentityOf(value: unknown): ProcessIdentity | undefined {
  const v = value as Partial<ProcessIdentity> | null
  if (!v || typeof v !== 'object') return undefined
  if (typeof v.host !== 'string' || !v.host || typeof v.boot !== 'string' || !v.boot) return undefined
  if (!Number.isInteger(v.pid) || v.pid! <= 0 || !Number.isInteger(v.startTicks) || v.startTicks! < 0) return undefined
  return { host: v.host, boot: v.boot, pid: v.pid!, startTicks: v.startTicks! }
}

function bootOf(read: ReadText): string | undefined {
  const boot = read('/proc/sys/kernel/random/boot_id').trim()
  return /^[0-9a-f-]{8,64}$/i.test(boot) ? boot : undefined
}

/** The state and start time of `/proc/<pid>/stat`: the fields after the command's closing parenthesis, which may itself hold spaces and parentheses. */
function statOf(text: string): { state: string; startTicks: number } | undefined {
  const close = text.lastIndexOf(')')
  if (close < 0) return undefined
  // Field 3 (state) is the first after the command; field 22 (starttime) is the 20th.
  const fields = text.slice(close + 2).trim().split(/\s+/)
  const startTicks = Number(fields[19])
  if (!fields[0] || !Number.isSafeInteger(startTicks) || startTicks < 0) return undefined
  return { state: fields[0], startTicks }
}

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message.slice(0, 80) : String(error))
}
