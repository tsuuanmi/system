/**
 * Portable authenticated browser state for one account (`account@1.0` `state`): cookies,
 * localStorage, and IndexedDB for the provider driver's `stateOrigins` only
 * (docs/design/browser-runtime.md#accounts-ctxaccounts-provider-agnostic-multi-account).
 * Shared by `ctx.accounts` (which stores it encrypted) and `ctx.browser` (which builds
 * turn contexts from it and captures it back).
 */
export interface PortableState {
  origins: string[]
  cookies: Record<string, unknown>[]
  /** One `{ origin, localStorage }` entry per captured origin. */
  localStorage?: Record<string, unknown>[]
  /** `kept-previous` when a capture exceeded the size cap and the earlier data was retained. */
  indexedDB?: { status: 'captured' | 'kept-previous' | 'absent'; data?: Record<string, unknown>[] }
  capturedAt: string
}
