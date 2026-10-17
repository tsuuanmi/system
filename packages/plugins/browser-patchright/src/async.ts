/** Bounded waits shared by the pool and the login-profile contexts. */
import { abortReason } from '@tsuuanmi/system-provider-core'
import type { BrowserContext, Page } from 'patchright-core'

/** The longest a close waits for a page of its context that is still opening. */
export const ATTACH_WAIT_MS = 10_000

/** Pages still opening, per context. */
const opening = new WeakMap<BrowserContext, Set<Promise<Page>>>()

/** `promise`, or nothing once `ms` have passed. */
async function boundedBy(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
}

/**
 * A new page of `context`, tracked until it has opened or failed. A close of the context waits
 * for it first (`closeWithin`): the browser library attaches a new page's session in steps of its
 * own, and one of them (`Network.setCacheDisabled`) rejects with no handler when the context
 * closes under it.
 */
export function newPage(context: BrowserContext): Promise<Page> {
  const pending = context.newPage()
  let set = opening.get(context)
  if (!set) opening.set(context, (set = new Set()))
  set.add(pending)
  const done = (): void => void set.delete(pending)
  pending.then(done, done)
  return pending
}

/**
 * Close a context once the pages it is still opening have attached (at most `attachMs`), and
 * never wait more than `ms` for the close itself, for a wedged browser.
 */
export async function closeWithin(context: BrowserContext, ms = 5000, attachMs = ATTACH_WAIT_MS): Promise<void> {
  const pending = opening.get(context)
  if (pending?.size) await boundedBy(Promise.allSettled(pending), attachMs)
  await boundedBy(context.close(), ms)
}

/**
 * `promise`, unless `signal` aborts first; then it rejects at once, and a late value goes to
 * `onLate`, once. Without a signal it is `promise` itself, with no bound of its own: each caller
 * bounds the operation it waits on.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onLate?: (value: T) => void): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.then((value) => onLate?.(value), () => undefined)
    return Promise.reject(abortReason(signal, 'browser turn aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    // A value after the abort reaches `onLate` from the handler below, never from here as well.
    const onAbort = (): void => reject(abortReason(signal, 'browser turn aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) onLate?.(value)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
