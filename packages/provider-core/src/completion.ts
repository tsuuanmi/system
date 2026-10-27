// Ported from tsuuanmi/internet src/browser/completion.ts (docs/design/provider-turns.md#two-clock-completion).
import { sleep } from '@tsuuanmi/system-libs'
import { ProviderError, abortReason } from './errors.ts'

export interface CompletionSnapshot {
  responsePresent: boolean
  text: string
  html: string
  running: boolean
  /**
   * Work the provider shows before any answer text (Deep research's growing activity, say): any
   * change counts as progress, so the stall clock does not run out while it grows.
   */
  progress?: string
}

export interface CompletedResponse {
  readonly text: string
  readonly html: string
}

export type ProviderProgressKind = 'response_started' | 'response_changed' | 'generation_started' | 'generation_stopped'

export interface ProviderProgressEvent {
  readonly kind: ProviderProgressKind
  readonly at: string
}

export interface WaitOptions {
  /** Absolute hard deadline for the turn. */
  timeoutMs: number
  /** No-meaningful-progress deadline; must be lower than `timeoutMs`. */
  stallTimeoutMs?: number
  pollMs: number
  stableMs: number
  signal?: AbortSignal
  onProgress?: (event: ProviderProgressEvent) => void
  /** The clock both deadlines read (milliseconds); the wall clock when absent. A test controls it; the page's own timers are not touched. */
  now?: () => number
}

function emit(observer: WaitOptions['onProgress'], kind: ProviderProgressKind, at: number): void {
  try {
    observer?.({ kind, at: new Date(at).toISOString() })
  } catch {
    // Progress projection must never change turn correctness.
  }
}

/**
 * Wait for a stable completed response, distinguishing the hard deadline (`timeout`)
 * from a semantic no-progress stall (`provider_stalled`). Only response presence,
 * text, and running transitions renew the stall clock.
 */
export async function waitForStableCompletion(read: () => Promise<CompletionSnapshot>, options: WaitOptions): Promise<CompletedResponse> {
  if (options.stallTimeoutMs !== undefined && options.stallTimeoutMs >= options.timeoutMs) {
    throw new ProviderError('config_error', 'stallTimeoutMs must be lower than timeoutMs')
  }
  const now = options.now ?? Date.now
  const startedAt = now()
  const deadline = startedAt + options.timeoutMs
  let lastProgressAt = startedAt
  let previous: CompletionSnapshot | undefined
  let candidate: string | undefined
  let stableSince: number | undefined

  while (now() < deadline) {
    if (options.signal?.aborted) throw abortReason(options.signal)
    const snapshot = await read()
    const at = now()
    const text = snapshot.text.trim()
    const presenceChanged = previous === undefined || snapshot.responsePresent !== previous.responsePresent
    if (presenceChanged) {
      if (snapshot.responsePresent) emit(options.onProgress, 'response_started', at)
      lastProgressAt = at
    }
    if (previous === undefined || snapshot.running !== previous.running) {
      emit(options.onProgress, snapshot.running ? 'generation_started' : 'generation_stopped', at)
      lastProgressAt = at
    }
    if (previous !== undefined && !presenceChanged && text !== previous.text.trim()) {
      emit(options.onProgress, 'response_changed', at)
      lastProgressAt = at
    }
    if (previous !== undefined && snapshot.progress !== previous.progress) lastProgressAt = at
    previous = snapshot

    if (snapshot.responsePresent && text.length > 0) {
      if (!snapshot.running && candidate === text) {
        stableSince ??= at
        if (at - stableSince >= options.stableMs) return { text, html: snapshot.html }
      } else {
        stableSince = undefined
      }
      candidate = text
    } else {
      candidate = undefined
      stableSince = undefined
    }

    if (options.stallTimeoutMs !== undefined && at - lastProgressAt >= options.stallTimeoutMs) {
      throw new ProviderError('provider_stalled', `provider made no meaningful progress for ${options.stallTimeoutMs}ms`)
    }
    await sleep(options.pollMs, options.signal).catch(() => {
      throw abortReason(options.signal)
    })
  }
  throw new ProviderError('timeout', `provider did not complete within ${options.timeoutMs}ms`)
}
