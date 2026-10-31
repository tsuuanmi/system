/**
 * The host-wide bound on acceptance checks that run at once (T292). Every run of a project asks its
 * checks of the one daemon; a full `tests` check starts a test runner that uses the host's cores, and
 * several at once slow each other until tests pass their time bounds that pass alone. Checks wait here
 * for a place, first come first served: a check that waits is told (`onWait`) and never fails for the
 * wait, whose time its own deadline does not count. A check that must run alone asks for every place.
 * @module @tsuuanmi/system-agent-workers/check-queue
 */
import { availableParallelism } from 'node:os'

/** A place held until released. */
export interface Place { release: () => void }

interface Waiter { weight: number; limit: number; grant: () => void }

export class CheckQueue {
  private held = 0
  private readonly waiting: Waiter[] = []

  /** How many places are held now. */
  get running(): number {
    return this.held
  }

  /** How many checks wait for a place now. */
  get queued(): number {
    return this.waiting.length
  }

  /**
   * Take a place under `limit` (at most that many held at once): at once when one is free and none waits
   * before it, otherwise in the order asked, after `onWait` told how many wait ahead. `alone`: every place,
   * so nothing else runs while it holds them. Rejects with `signal`'s reason when it aborts while waiting.
   */
  acquire(limit: number, signal?: AbortSignal, onWait?: (ahead: number) => void, alone = false): Promise<Place> {
    const weight = alone ? limit : 1
    return new Promise<Place>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const abort = (): void => {
        const at = this.waiting.indexOf(waiter)
        if (at < 0) return
        this.waiting.splice(at, 1)
        reject(signal!.reason)
        this.admit()
      }
      const waiter: Waiter = {
        weight, limit,
        grant: () => {
          signal?.removeEventListener('abort', abort)
          this.held += weight
          let released = false
          resolve({
            release: () => {
              if (released) return
              released = true
              this.held -= weight
              this.admit()
            },
          })
        },
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.waiting.push(waiter)
      const ahead = this.waiting.length - 1
      this.admit()
      if (this.waiting.includes(waiter)) onWait?.(ahead)
    })
  }

  /** Grant places to the waiters in order, as far as they fit: the first that does not fit holds back those after it. */
  private admit(): void {
    for (let waiter = this.waiting[0]; waiter && this.held + waiter.weight <= waiter.limit; waiter = this.waiting[0]) {
      this.waiting.shift()
      waiter.grant()
    }
  }
}

/** The one queue of this process, the daemon's: every source of checks in it shares it. */
export const hostChecks = new CheckQueue()

const DEFAULT_STEP_TEST_RUNS = 6

/**
 * The test workers each writing step's own test runs get (T348): a budget of the host's cores (default
 * half of them, the host being shared) shared among the `runs` that may test at once (default
 * {@link DEFAULT_STEP_TEST_RUNS}, set to the dispatch's `maxRunning`), at least 1, at most 32.
 */
export function stepWorkers(stepTests: { coreBudget?: number; runs?: number }, cores = availableParallelism()): number {
  const budget = stepTests.coreBudget ?? Math.floor(cores / 2)
  return Math.max(1, Math.min(32, Math.floor(budget / (stepTests.runs ?? DEFAULT_STEP_TEST_RUNS))))
}

/**
 * The test workers each check run gets (T292): the host's cores less one (the main process) shared
 * among the `maxConcurrent` checks that may run at once, at least 1, at most 32 (the most vitest's
 * config ever gave a run). `configured` (a given `checks.maxWorkers`) wins.
 */
export function checkWorkers(maxConcurrent: number, configured?: number, cores = availableParallelism()): number {
  if (configured !== undefined) return configured
  return Math.max(1, Math.min(32, Math.floor((cores - 1) / maxConcurrent)))
}
