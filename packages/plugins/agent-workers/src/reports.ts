/**
 * The periodic read of each account's usage report (ADR-0059,
 * docs/design/agent-runtimes.md#an-accounts-usage-report): every account the `agents` source names
 * (each ready, assigned account whose Workers draw on a declared pool, on a runtime that reads one) is
 * read every period, skipped while a read of it, a run's own after it ends included, is less than a
 * period old; at most one periodic read is in flight per runtime, and none starts after a stop. What a
 * read records, and how it is bounded, is the caller's (`read`).
 * @module
 */

/** One account the periodic read covers. */
export interface ReportTarget {
  account: string
  runtime: string
  /** How often it is read, in milliseconds: its provider's `limitReadSeconds`. */
  periodMs: number
  /** Read it once, bounded; never rejects. */
  read: () => Promise<void>
}

/** How soon after a start the first pass runs: an idle account's windows are read again soon after a restart. */
const FIRST_PASS_MS = 5_000
/** The longest the schedule waits between two passes, so an account ready later is read by then. */
const MAX_WAIT_MS = 60_000
/** The shortest it waits, so a pass that read nothing never spins. */
const MIN_WAIT_MS = 1_000

export class ReportSchedule {
  /** When each account's report was last read, by this process (in memory: a restart reads each again). */
  private readonly last = new Map<string, number>()
  /** The periodic reads in flight, one chain per runtime. */
  private readonly chains = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly options: { targets: () => ReportTarget[]; stopped: AbortSignal; track: (work: Promise<unknown>) => void }) {}

  /** A read of `account` starts now (a run's own read after it ends too): its next periodic read waits a period from here. */
  noted(account: string, at: number = Date.now()): void {
    this.last.set(account, at)
  }

  /** When `account`'s report was last read by this process, if it was. */
  lastRead(account: string): number | undefined {
    return this.last.get(account)
  }

  /** The first pass shortly, then each pass when the next account is due (between 1 s and a minute later). */
  start(): void {
    this.arm(FIRST_PASS_MS)
  }

  close(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Read every account that is due now: per runtime, one at a time, the longest unread first, each at
   * most once per pass. A runtime whose chain is still reading is left to it (it takes up what became
   * due). Resolves when those reads ended.
   */
  async pass(): Promise<void> {
    const runtimes = [...new Set(this.options.targets().map((t) => t.runtime))]
    await Promise.allSettled(runtimes.map((runtime) => this.chains.get(runtime) ?? this.chain(runtime)))
  }

  private chain(runtime: string): Promise<void> {
    const chain = (async () => {
      const read = new Set<string>()
      for (;;) {
        if (this.options.stopped.aborted) return
        const next = this.due(runtime, Date.now(), read)
        if (!next) return
        read.add(next.account)
        this.noted(next.account)
        await next.read()
      }
    })().finally(() => this.chains.delete(runtime))
    this.chains.set(runtime, chain)
    this.options.track(chain)
    return chain
  }

  /** The account of `runtime` most overdue at `now` (never read first, then by id), not read in this pass yet. */
  private due(runtime: string, now: number, read: ReadonlySet<string>): ReportTarget | undefined {
    const since = (t: ReportTarget): number => this.last.get(t.account) ?? Number.NEGATIVE_INFINITY
    return this.options.targets()
      .filter((t) => t.runtime === runtime && t.periodMs > 0 && !read.has(t.account) && now - since(t) >= t.periodMs)
      .sort((a, b) => since(a) - since(b) || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0))[0]
  }

  private arm(ms: number): void {
    if (this.options.stopped.aborted) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const passing = this.pass().finally(() => this.arm(this.wait(Date.now())))
      this.options.track(passing)
    }, ms)
    this.timer.unref()
  }

  /** How long until the next account is due, at least {@link MIN_WAIT_MS} and at most {@link MAX_WAIT_MS}. */
  private wait(now: number): number {
    const waits = this.options.targets().filter((t) => t.periodMs > 0).map((t) => {
      const last = this.last.get(t.account)
      return last === undefined ? 0 : last + t.periodMs - now
    })
    return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, ...(waits.length ? [Math.min(...waits)] : [MAX_WAIT_MS])))
  }
}
