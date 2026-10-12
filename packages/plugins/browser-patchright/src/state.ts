/**
 * Conversion between `PortableState` (what `ctx.accounts` stores) and the engine's
 * `storageState`. Capture keeps only what the driver's `stateOrigins` would send or store:
 * cookies whose domain matches an origin host, and per-origin localStorage and IndexedDB.
 */
import type { PortableState } from '@tsuuanmi/system-provider-core'

type Entry = Record<string, unknown>

export interface StorageState {
  cookies: Entry[]
  origins: Array<{ origin: string; localStorage?: Entry[]; indexedDB?: Entry[] }>
}

export interface CaptureOptions {
  origins: string[]
  now: string
  previous?: PortableState | undefined
  /** Serialized IndexedDB above this size keeps the previous capture (default 16 MiB). */
  maxIndexedDbBytes?: number
}

const DEFAULT_MAX_INDEXED_DB_BYTES = 16 * 1024 * 1024

/** RFC 6265 domain-match: the cookie would be sent to `host`. */
function domainMatches(cookieDomain: unknown, host: string): boolean {
  if (typeof cookieDomain !== 'string' || !cookieDomain) return false
  const domain = cookieDomain.replace(/^\./, '').toLowerCase()
  return host === domain || host.endsWith(`.${domain}`)
}

export function fromStorageState(raw: StorageState, options: CaptureOptions): PortableState {
  const allowed = new Set(options.origins.map((o) => new URL(o).origin))
  const hosts = [...allowed].map((o) => new URL(o).hostname.toLowerCase())
  const cookies = raw.cookies.filter((c) => hosts.some((h) => domainMatches(c.domain, h)))
  const entries = raw.origins.filter((o) => allowed.has(o.origin))
  const localStorage = entries.map((o) => ({ origin: o.origin, localStorage: o.localStorage ?? [] }))
  const idb = entries.filter((o) => o.indexedDB?.length).map((o) => ({ origin: o.origin, indexedDB: o.indexedDB }))

  let indexedDB: NonNullable<PortableState['indexedDB']> = { status: 'absent' }
  if (idb.length) {
    const max = options.maxIndexedDbBytes ?? DEFAULT_MAX_INDEXED_DB_BYTES
    if (Buffer.byteLength(JSON.stringify(idb)) <= max) indexedDB = { status: 'captured', data: idb }
    else if (options.previous?.indexedDB?.data) indexedDB = { status: 'kept-previous', data: options.previous.indexedDB.data }
  }
  return { origins: options.origins, cookies, localStorage, indexedDB, capturedAt: options.now }
}

export function toStorageState(state: PortableState | undefined): StorageState {
  if (!state) return { cookies: [], origins: [] }
  const byOrigin = new Map<string, StorageState['origins'][number]>()
  const entry = (origin: string): StorageState['origins'][number] => {
    let found = byOrigin.get(origin)
    if (!found) byOrigin.set(origin, (found = { origin }))
    return found
  }
  for (const item of state.localStorage ?? []) entry(String(item.origin)).localStorage = item.localStorage as Entry[]
  for (const item of state.indexedDB?.data ?? []) entry(String(item.origin)).indexedDB = item.indexedDB as Entry[]
  return { cookies: state.cookies, origins: [...byOrigin.values()].map((o) => ({ localStorage: [], ...o })) }
}
