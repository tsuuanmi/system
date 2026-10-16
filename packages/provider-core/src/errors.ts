/** Retry disposition per failure class (docs/design/workflow-engine.md#recovery). */
export type Disposition = 'IMMEDIATE' | 'BACKOFF' | 'RECREATE_SESSION' | 'USER_ACTION' | 'CODE_FIX' | 'CONFIG_FIX' | 'NONE'

export type ProviderErrorKind =
  | 'network' | 'timeout' | 'provider_stalled' | 'session_broken' | 'conversation_lost' | 'input_dropped'
  | 'reauth_required' | 'challenge' | 'quota_exhausted' | 'reconciliation_failed'
  | 'ui_drift' | 'config_error' | 'aborted' | 'invalid_input' | 'internal' | 'overloaded' | 'egress_denied'

const DISPOSITIONS: Record<ProviderErrorKind, Disposition> = {
  network: 'BACKOFF',
  timeout: 'BACKOFF',
  provider_stalled: 'RECREATE_SESSION',
  session_broken: 'RECREATE_SESSION',
  // The site positively no longer has the bound conversation: reopening it again cannot help.
  conversation_lost: 'USER_ACTION',
  // The site took the text away without answering (over its input limit): sending it again cannot help.
  input_dropped: 'USER_ACTION',
  reauth_required: 'USER_ACTION',
  challenge: 'USER_ACTION',
  quota_exhausted: 'USER_ACTION',
  reconciliation_failed: 'USER_ACTION',
  ui_drift: 'CONFIG_FIX', // update the provider's UI map (ADR-0021)
  config_error: 'CODE_FIX',
  internal: 'CODE_FIX',
  overloaded: 'BACKOFF',
  egress_denied: 'USER_ACTION',
  aborted: 'NONE',
  invalid_input: 'NONE',
}

export function dispositionOf(kind: ProviderErrorKind): Disposition {
  return DISPOSITIONS[kind]
}

/** A typed provider-runtime failure; `disposition` tells the engine how to recover. */
export class ProviderError extends Error {
  readonly disposition: Disposition

  constructor(readonly kind: ProviderErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderError'
    this.disposition = dispositionOf(kind)
  }
}

/**
 * The abort reason as an Error. A caller's own Error reason is kept; a bare `abort()`
 * (DOMException AbortError) or a non-Error reason becomes a typed `aborted` failure.
 */
export function abortReason(signal: AbortSignal | undefined, what = 'provider turn aborted'): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof Error && reason.name !== 'AbortError') return reason
  return new ProviderError('aborted', what, { cause: reason })
}

/** Programming and contract errors: retrying cannot help and may repeat a side effect. */
const INTERNAL = new Set(['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'SchemaError', 'RevisionConflict'])

/**
 * Type a failure the runtime did not raise itself. Programming and contract errors are
 * `internal` (CODE_FIX, never retried); anything else (browser or page failures) is a
 * broken session that a fresh context may fix.
 */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  return new ProviderError(INTERNAL.has(name) ? 'internal' : 'session_broken', message, { cause: error })
}
