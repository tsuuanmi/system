/**
 * Each agent runtime's probe, the evidence its Workers are admitted on
 * (docs/design/agent-runtimes.md#admission-evidence), kept so that a describe never waits for a
 * re-probe: the router gives a whole source 5 s, and a runtime's probe can take longer.
 *
 * - A probe result stands for `ttlMs` from when its probe started, never longer: past it, nothing
 *   uses it (the hard bound).
 * - Once a result is half its `ttlMs` old, the next probe starts in the background, whether or not
 *   anything reads, so a fresh result normally replaces it before it expires.
 * - The latest result wins, failed or not: a probe that throws, or proves less, replaces an older
 *   success at once, so no Worker is admitted on evidence a later probe contradicts.
 * - One probe at a time per runtime: concurrent reads share it.
 *
 * `described` (a describe) waits only for a runtime's first probe; past the bound it answers at
 * once with evidence that admits nothing, and the background probe brings the runtime back.
 * `proven` (a run's own check before the agent starts) waits for a fresh result. With `ttlMs` 0
 * no result stands: every read waits for a probe.
 */
import type { AgentRuntimeProvider, RuntimeEvidence } from '@tsuuanmi/system-agent-runtime-core'

interface State {
  /** The latest result, and when its probe started. */
  latest?: { at: number; evidence: RuntimeEvidence }
  /** The probe in flight. */
  running?: Promise<RuntimeEvidence> | undefined
  /** When the next background probe starts. */
  timer?: NodeJS.Timeout | undefined
}

export interface ProbeOptions {
  /** How long a result stands, from when its probe started (`probeTtlMs`). */
  ttlMs: number
  /** The runtime's provider as registered now, if any. */
  provider: (runtime: string) => AgentRuntimeProvider | undefined
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
   * nothing, at once, the next probe started if none runs. Only a runtime's first probe (or every
   * one, with `ttlMs` 0) is waited for.
   */
  async described(runtime: string): Promise<RuntimeEvidence> {
    const provider = this.options.provider(runtime)
    if (!provider) return refused(`no ${runtime} runtime is registered`)
    const state = this.state(runtime)
    const latest = state.latest
    if (!latest || !this.options.ttlMs) return this.probe(runtime, state, provider)
    const age = Date.now() - latest.at
    if (age < this.options.ttlMs) {
      // A background chain broken by a runtime that was gone when its timer fired starts again here.
      if (!state.running && !state.timer && age >= this.options.ttlMs / 2) void this.probe(runtime, state, provider)
      return latest.evidence
    }
    void this.probe(runtime, state, provider)
    this.options.warn(`agent Workers: the last probe of ${runtime} is older than probeTtlMs (${this.options.ttlMs} ms) and the next has not finished; its Workers take no work until it does`)
    return refused(`the last probe of ${runtime} started ${Math.round(age / 1000)} s ago, past probeTtlMs (${this.options.ttlMs} ms), and the next has not finished`)
  }

  /** For a run's own check before the agent starts: the latest result while it stands, else the probe it waits for. */
  async proven(runtime: string): Promise<RuntimeEvidence> {
    const provider = this.options.provider(runtime)
    if (!provider) return refused(`no ${runtime} runtime is registered`)
    const state = this.state(runtime)
    const latest = state.latest
    if (latest && Date.now() - latest.at < this.options.ttlMs) return latest.evidence
    return this.probe(runtime, state, provider)
  }

  /** The latest result while it stands (with `ttlMs` 0, the latest), without probing. */
  current(runtime: string): RuntimeEvidence | undefined {
    const latest = this.states.get(runtime)?.latest
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

  private state(runtime: string): State {
    let state = this.states.get(runtime)
    if (!state) this.states.set(runtime, (state = {}))
    return state
  }

  /** The probe in flight, or a new one; its result replaces the latest, and the next is scheduled. */
  private probe(runtime: string, state: State, provider: AgentRuntimeProvider): Promise<RuntimeEvidence> {
    if (state.running) return state.running
    if (this.options.stopped.aborted) return Promise.resolve(refused('agent Workers stopped'))
    clearTimeout(state.timer)
    state.timer = undefined
    const at = Date.now()
    const running = Promise.resolve()
      .then(() => provider.probe())
      .catch((error: unknown): RuntimeEvidence => refused((error instanceof Error ? error.message : String(error)).slice(0, 200)))
      .then((evidence) => {
        state.latest = { at, evidence }
        state.running = undefined
        this.schedule(runtime, state, at)
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
  private schedule(runtime: string, state: State, at: number): void {
    if (!this.options.ttlMs || this.options.stopped.aborted) return
    const due = at + this.options.ttlMs / 2
    if (Date.now() >= due) this.options.warn(`agent Workers: a probe of ${runtime} took longer than half of probeTtlMs (${this.options.ttlMs} ms), so it is probed again at once; its Workers take no work while a result is past probeTtlMs: raise probeTtlMs, or see why the runtime is slow`)
    const timer = setTimeout(() => {
      state.timer = undefined
      const provider = this.options.provider(runtime)
      // A runtime no longer registered is probed again when a read finds it registered.
      if (provider && !this.options.stopped.aborted) void this.probe(runtime, state, provider)
    }, Math.max(0, due - Date.now()))
    timer.unref()
    state.timer = timer
  }
}
