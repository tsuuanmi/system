// Ported from tsuuanmi/internet src/browser/provider-scheduler.ts (docs/design/scheduling-and-leases.md).
import { ProviderError, abortReason } from './errors.ts'

export interface ProviderLease {
  generation: number
  /** Aborts when the caller cancels, the account is invalidated, or the scheduler closes. */
  signal: AbortSignal
}

type Work<T> = (lease: ProviderLease) => Promise<T>
interface Job<T> {
  kind: 'turn' | 'exclusive'
  sessionId?: string
  signal: AbortSignal | undefined
  work: Work<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  abort?: () => void
}
interface ActiveJob { controller: AbortController; externalAbort?: () => void }

/**
 * Per-account scheduler: different sessions run in parallel up to `capacity`, one session
 * runs strictly in order, and a queued exclusive job (login, visible run, close) is a FIFO
 * fence. `invalidate` bumps the generation so late commits from stale turns can be refused.
 */
export class ProviderScheduler {
  private readonly queue: Job<unknown>[] = []
  private readonly activeSessions = new Set<string>()
  private readonly activeJobs = new Set<ActiveJob>()
  private readonly idleWaiters = new Set<() => void>()
  private active = 0
  private exclusive = false
  private generation = 0
  private closed: Error | undefined

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('provider scheduler capacity must be a positive integer')
  }

  get isIdle(): boolean {
    return this.active === 0 && this.queue.length === 0
  }

  currentGeneration(): number {
    return this.generation
  }

  isCurrent(lease: ProviderLease): boolean {
    return this.closed === undefined && lease.generation === this.generation && !lease.signal.aborted
  }

  /** Invalidate every lease: reject queued work and abort active work. */
  invalidate(reason: Error): void {
    this.generation += 1
    this.rejectQueued(reason)
    this.abortActive(reason)
  }

  async waitForIdle(): Promise<void> {
    if (!this.isIdle) await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  close(reason: Error = new ProviderError('aborted', 'provider scheduler closed')): void {
    if (this.closed) return
    this.closed = reason
    this.invalidate(reason)
  }

  runTurn<T>(sessionId: string, signal: AbortSignal | undefined, work: Work<T>): Promise<T> {
    if (sessionId.trim().length === 0) return Promise.reject(new ProviderError('invalid_input', 'provider scheduler session id must not be empty'))
    return this.enqueue({ kind: 'turn', sessionId, signal, work } as Omit<Job<T>, 'resolve' | 'reject'>)
  }

  runExclusive<T>(work: Work<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue({ kind: 'exclusive', signal, work } as Omit<Job<T>, 'resolve' | 'reject'>)
  }

  private enqueue<T>(spec: Omit<Job<T>, 'resolve' | 'reject'>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(this.closed)
      if (spec.signal?.aborted) return reject(abortReason(spec.signal))
      const job: Job<T> = { ...spec, resolve, reject }
      job.abort = () => {
        const index = this.queue.indexOf(job as Job<unknown>)
        if (index < 0) return
        this.queue.splice(index, 1)
        reject(abortReason(spec.signal))
        this.notifyIdle()
        this.drive()
      }
      spec.signal?.addEventListener('abort', job.abort, { once: true })
      this.queue.push(job as Job<unknown>)
      this.drive()
    })
  }

  private drive(): void {
    if (this.exclusive) return
    if (this.closed) return this.notifyIdle()
    for (;;) {
      const next = this.nextRunnable()
      if (!next) return this.notifyIdle()
      this.queue.splice(next.index, 1)
      this.start(next.job)
      if (next.job.kind === 'exclusive') return
    }
  }

  private nextRunnable(): { index: number; job: Job<unknown> } | undefined {
    if (this.active >= this.capacity) return undefined
    const fence = this.queue.findIndex((job) => job.kind === 'exclusive')
    const limit = fence < 0 ? this.queue.length : fence
    for (let index = 0; index < limit; index++) {
      const job = this.queue[index]
      if (job?.kind === 'turn' && !this.activeSessions.has(job.sessionId!)) return { index, job }
    }
    if (fence === 0 && this.active === 0) {
      const job = this.queue[0]
      if (job) return { index: 0, job }
    }
    return undefined
  }

  private start(job: Job<unknown>): void {
    const controller = new AbortController()
    const active: ActiveJob = { controller }
    if (job.abort) job.signal?.removeEventListener('abort', job.abort)
    active.externalAbort = () => controller.abort(job.signal?.reason)
    job.signal?.addEventListener('abort', active.externalAbort, { once: true })
    if (job.kind === 'turn') this.activeSessions.add(job.sessionId!)
    else this.exclusive = true
    this.active++
    this.activeJobs.add(active)
    void job.work({ generation: this.generation, signal: controller.signal })
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--
        this.activeJobs.delete(active)
        if (active.externalAbort) job.signal?.removeEventListener('abort', active.externalAbort)
        if (job.kind === 'turn') this.activeSessions.delete(job.sessionId!)
        else this.exclusive = false
        this.drive()
      })
  }

  private abortActive(reason: Error): void {
    for (const active of this.activeJobs) active.controller.abort(reason)
  }

  private rejectQueued(reason: Error): void {
    for (const job of this.queue.splice(0)) {
      if (job.abort) job.signal?.removeEventListener('abort', job.abort)
      job.reject(reason)
    }
    this.notifyIdle()
  }

  private notifyIdle(): void {
    if (!this.isIdle) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
