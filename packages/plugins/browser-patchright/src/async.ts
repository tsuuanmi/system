/** Bounded waits shared by the pool and the login-profile contexts. */
import { abortReason } from '@tsuuanmi/system-provider-core'
import type { BrowserContext, Page } from 'patchright-core'

/** The longest a close waits for a page of its context that is still opening. */
export const ATTACH_WAIT_MS = 10_000

/** Pages still opening, per context. */
const opening = new WeakMap<BrowserContext, Set<Promise<Page>>>()

/** `promise`, or nothing once `ms` have passed; whether it settled within them. */
async function boundedBy(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
  return settled
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
 * Close a page, never waiting more than `ms` for the browser to confirm it. Chrome acknowledges a
 * close that lands as the page's navigation commits, then drops it: the tab stays open, and
 * `page.close()` waits for it with no bound of its own (CI 2026-10-24: a runtime stop hung on the
 * page its abort closed). Such a tab closes with its context. A close the browser did not confirm
 * within the bound is told to `warn`, never passed over in silence; whether it was confirmed.
 */
export async function closePageWithin(page: Page, warn: (message: string) => void, ms = 5000): Promise<boolean> {
  const confirmed = await boundedBy(page.close(), ms)
  if (!confirmed) warn(`the browser did not confirm a page's close within ${ms / 1000} s; the page no longer counts as open, and its tab closes with its context`)
  return confirmed
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
