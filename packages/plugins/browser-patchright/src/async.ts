/** Bounded waits shared by the pool and the login-profile contexts. */
import { abortReason } from '@tsuuanmi/system-provider-core'
import type { BrowserContext } from 'patchright-core'

/** Close a context, but never wait more than `ms` for a wedged browser. */
export async function closeWithin(context: BrowserContext, ms = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    context.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
}

/** `promise`, unless `signal` aborts first; then it rejects at once, and a late value goes to `onLate`. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onLate?: (value: T) => void): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.then((value) => onLate?.(value), () => undefined)
    return Promise.reject(abortReason(signal, 'browser turn aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void promise.then((value) => onLate?.(value), () => undefined)
      reject(abortReason(signal, 'browser turn aborted'))
    }
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
