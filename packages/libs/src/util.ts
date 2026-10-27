/** A plain JSON-like object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** At most `max` characters (code points), cut on a whole character and marked with '…'. */
export function clampText(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** Wait `ms`; when `signal` aborts first, reject with its reason (at once if it already has). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const stop = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/** The distinct items, sorted. */
export const unique = (items: Iterable<string>): string[] => [...new Set(items)].sort()
