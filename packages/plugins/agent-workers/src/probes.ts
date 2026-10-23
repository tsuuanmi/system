/**
 * Each agent runtime's probe, the evidence its Workers are admitted on
 * (docs/design/agent-runtimes.md#admission-evidence), kept so that a describe never waits for a
 * re-probe: the router gives a whole source 5 s, and a runtime's probe can take longer. A runtime is
 * probed in its own home and, on its own, in each named home a Worker's runs run in (an account's,
 * ADR-0051): what follows holds per runtime and home.
 *
 * - A probe result stands for `ttlMs` from when its probe started, never longer: past it, nothing
 *   uses it (the hard bound).
 * - Once a result is half its `ttlMs` old, the next probe starts in the background, whether or not
 *   anything reads, so a fresh result normally replaces it before it expires. A named home is probed
 *   in the background only while it is `inUse`; one that is not is forgotten, and a later read
 *   probes it first.
 * - The latest result wins, failed or not: a probe that throws, or proves less, replaces an older
 *   success at once, so no Worker is admitted on evidence a later probe contradicts.
 * - After each probe, and before its result stands, `after` reads the accounts of that home again
 *   (ADR-0051), so no result stands on an account the re-read would have taken out.
 * - One probe at a time per runtime and home: concurrent reads share it.
 *
 * `described` (a describe) waits only for the first probe; past the bound it answers at once with
 * evidence that admits nothing, and the background probe brings the runtime back. `proven` (a run's
 * own check before the agent starts) waits for a fresh result. With `ttlMs` 0 no result stands:
 * every read waits for a probe.
 */
import { type AgentRuntimeProvider, type RuntimeEvidence, probeIn } from '@tsuuanmi/system-agent-runtime-core'

interface State {
  /** The latest result, and when its probe started. */
  latest?: { at: number; evidence: RuntimeEvidence }
  /** The probe in flight. */
  running?: Promise<RuntimeEvidence> | undefined
  /** When the next background probe starts. */
  timer?: NodeJS.Timeout | undefined
}

/** What one probe is of: a runtime in its own home (`home` undefined) or in a named one. */
interface Target {
  runtime: string
  home: string | undefined
  key: string
}

export interface ProbeOptions {
  /** How long a result stands, from when its probe started (`probeTtlMs`). */
  ttlMs: number
  /** The runtime's provider as registered now, if any. */
  provider: (runtime: string) => AgentRuntimeProvider | undefined
  /**
   * After each probe, before its result stands: the accounts of that home read again (`home`
   * undefined: every account of the runtime). Never rejects; one that does is ignored.
   */
  after?: (runtime: string, home: string | undefined) => Promise<void>
  /** Whether a named home is still one a Worker's runs run in; a background probe of one that is not is dropped. */
  inUse?: (runtime: string, home: string) => boolean
  /** Once aborted, no probe starts. */
  stopped: AbortSignal
  /** Each probe started, so a stop waits for it. */
  track: (probe: Promise<unknown>) => void
  /** A standing problem, logged once. */
  warn: (message: string) => void
}

/** Evidence that admits no Worker, with why. */
export const refused = (detail: string): RuntimeEvidence => ({ available: false, detail, sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false })

export class Probes {
  private readonly states = new Map<string, State>()

  constructor(private readonly options: ProbeOptions) {}

  /**
   * For a describe: the latest result while it stands. Past the bound, evidence that admits
   * nothing, at once, the next probe started if none runs. Only the first probe of a runtime in a
   * home (or every one, with `ttlMs` 0) is waited for.
   */
  async described(runtime: string, home?: string): Promise<RuntimeEvidence> {
    const provider = this.options.provider(runtime)
    if (!provider) return refused(`no ${runtime} runtime is registered`)
    const target = targetOf(runtime, home)
    const state = this.state(target)
    const latest = state.latest
    if (!latest || !this.options.ttlMs) return this.probe(target, state, provider)
    const age = Date.now() - latest.at
    if (age < this.options.ttlMs) {
      // A background chain broken by a runtime that was gone when its timer fired starts again here.
      if (!state.running && !state.timer && age >= this.options.ttlMs / 2) void this.probe(target, state, provider)
      return latest.evidence
    }
    void this.probe(target, state, provider)
    const named = label(target)
    this.options.warn(`agent Workers: the last probe of ${named} is older than probeTtlMs (${this.options.ttlMs} ms) and the next has not finished; its Workers take no work until it does`)
    return refused(`the last probe of ${named} started ${Math.round(age / 1000)} s ago, past probeTtlMs (${this.options.ttlMs} ms), and the next has not finished`)
  }

  /** For a run's own check before the agent starts: the latest result while it stands, else the probe it waits for. */
  async proven(runtime: string, home?: string): Promise<RuntimeEvidence> {
    const provider = this.options.provider(runtime)
    if (!provider) return refused(`no ${runtime} runtime is registered`)
    const target = targetOf(runtime, home)
    const state = this.state(target)
    const latest = state.latest
    if (latest && Date.now() - latest.at < this.options.ttlMs) return latest.evidence
    return this.probe(target, state, provider)
  }

  /** The latest result while it stands (with `ttlMs` 0, the latest), without probing. */
  current(runtime: string, home?: string): RuntimeEvidence | undefined {
    const latest = this.states.get(targetOf(runtime, home).key)?.latest
    if (!latest) return undefined
    return !this.options.ttlMs || Date.now() - latest.at < this.options.ttlMs ? latest.evidence : undefined
  }

  /** No background probe starts any more; one in flight finishes, and the caller waits for it. */
  close(): void {
    for (const state of this.states.values()) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  private state(target: Target): State {
    let state = this.states.get(target.key)
    if (!state) this.states.set(target.key, (state = {}))
    return state
  }

  /** The probe in flight, or a new one; its result replaces the latest once its accounts are read again, and the next is scheduled. */
  private probe(target: Target, state: State, provider: AgentRuntimeProvider): Promise<RuntimeEvidence> {
    if (state.running) return state.running
    if (this.options.stopped.aborted) return Promise.resolve(refused('agent Workers stopped'))
    clearTimeout(state.timer)
    state.timer = undefined
    const at = Date.now()
    const running = Promise.resolve()
      .then(() => (target.home === undefined ? provider.probe() : probeIn(provider, target.home)))
      .catch((error: unknown): RuntimeEvidence => refused((error instanceof Error ? error.message : String(error)).slice(0, 200)))
      .then(async (evidence) => {
        await Promise.resolve().then(() => this.options.after?.(target.runtime, target.home)).catch(() => undefined)
        state.latest = { at, evidence }
        state.running = undefined
        this.schedule(target, state, at)
        return evidence
      })
    state.running = running
    this.options.track(running)
    return running
  }

  /**
   * The next probe, in the background, once the result whose probe started at `at` is half its
   * `ttlMs` old: at once after a probe slower than that (still one at a time).
   */
  private schedule(target: Target, state: State, at: number): void {
    if (!this.options.ttlMs || this.options.stopped.aborted) return
    const due = at + this.options.ttlMs / 2
    if (Date.now() >= due) this.options.warn(`agent Workers: a probe of ${label(target)} took longer than half of probeTtlMs (${this.options.ttlMs} ms), so it is probed again at once; its Workers take no work while a result is past probeTtlMs: raise probeTtlMs, or see why the runtime is slow`)
    const timer = setTimeout(() => {
      state.timer = undefined
      // A named home no Worker's runs run in any more is forgotten: a later read probes it first.
      if (target.home !== undefined && this.options.inUse && !this.options.inUse(target.runtime, target.home)) {
        if (!state.running && this.states.get(target.key) === state) this.states.delete(target.key)
        return
      }
      const provider = this.options.provider(target.runtime)
      // A runtime no longer registered is probed again when a read finds it registered.
      if (provider && !this.options.stopped.aborted) void this.probe(target, state, provider)
    }, Math.max(0, due - Date.now()))
    timer.unref()
    state.timer = timer
  }
}

const targetOf = (runtime: string, home: string | undefined): Target => ({ runtime, home, key: home === undefined ? runtime : `${runtime}\0${home}` })
const label = (target: Target): string => (target.home === undefined ? target.runtime : `${target.runtime} in ${target.home}`)
