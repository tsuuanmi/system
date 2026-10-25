/**
 * Capability seam definition: `ctx.models` (docs/design/models.md). An API or local model, named
 * by an entry of the operator's model catalog, answers one prompt with text. The seam names no
 * vendor, model, or library (INV-11): a provider maps catalog entries to whatever reaches the
 * model, and reports failures in the provider-neutral vocabulary below.
 * @module @tsuuanmi/system-models-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { Tier } from '@tsuuanmi/system-workers-core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    models: Models
  }
}

/** A catalog entry as routing sees it; how the provider reaches the model stays with the provider. */
export interface ModelEntry {
  /** Catalog id, unique; the Worker is `model:<id>`. */
  id: string
  tier: Tier
  /** `metered` (paid per token) or `local` (no quota). */
  quotaClass: 'metered' | 'local'
  /** Where the model runs: `local` keeps the prompt on this machine. */
  locality: 'remote' | 'local'
  /** The output bound of every call (INV-9). */
  maxTokens: number
  /** Who serves the model, as an opaque provider family (ADR-0027); the Worker's family. */
  family?: string
  /** What it is for, in the operator's words: its Worker's `description` (`capability-descriptor@1.7`); never a routing input. */
  description?: string
  /**
   * Its name for people, in the operator's words (`capability-descriptor@1.8` `title`), such as the
   * product it reaches: its Worker's display name is the title and its tier. Never a routing input.
   */
  title?: string
  /** Session bounds for this entry (ADR-0031); the Worker source's defaults when absent. */
  maxSessionTurns?: number
  maxHistoryChars?: number
  /** The longest prompt this model is sent, in characters, when the operator sets one (ADR-0032); history is bounded on its own. */
  maxInputChars?: number
}

/** One earlier turn of a session, as text (ADR-0031). */
export interface ModelTurn {
  role: 'user' | 'assistant'
  text: string
}

/** An entry with what the provider can prove about it now. */
export interface ModelStatus extends ModelEntry {
  available: boolean
  /** Why, in a few words. */
  detail: string
}

export interface ModelRequest {
  /** Catalog id. */
  model: string
  prompt: string
  /** A session's earlier turns, in order, sent before the prompt (ADR-0031). */
  history?: readonly ModelTurn[] | undefined
  /** At most the entry's own bound; a larger value is cut to it. */
  maxTokens?: number | undefined
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
}

export interface ModelCompletion {
  model: string
  text: string
  usage: ModelUsage
  /** `max-tokens`: the answer was cut at the bound. */
  finish: 'stop' | 'max-tokens'
  /** The output bound the call ran under. */
  maxTokens: number
  /** Provider requests this completion took, its re-attempts included; each may be billed. */
  attempts: number
}

/**
 * Why a call failed:
 * - `unknown-model`: no catalog entry has the id;
 * - `unavailable`: the entry's provider route is not mounted or does not serve the model;
 * - `credential`: the key is missing or refused;
 * - `quota`: the account's quota or balance is spent;
 * - `rate-limit`, `transient`, `timeout`: worth trying again later;
 * - `invalid-request`: the request cannot succeed as written (for example, too long);
 * - `aborted`: the caller's signal stopped it.
 */
export type ModelFailure = 'unknown-model' | 'unavailable' | 'credential' | 'quota' | 'rate-limit' | 'transient' | 'timeout' | 'invalid-request' | 'aborted'

/**
 * A provider's own word that it did not process a request, before any output (T209): `503
 * UNAVAILABLE` (overloaded) or `429 RESOURCE_EXHAUSTED`. Retrying it cannot duplicate an answer.
 */
export interface Unprocessed {
  /** What the provider said, in a few words (`503 UNAVAILABLE`). */
  status: string
  /** How long the provider asked to wait, when it said. */
  retryAfterMs?: number
}

export class ModelError extends Error {
  /** Set when the provider said it did not process the request, before any output. */
  readonly unprocessed?: Unprocessed
  /** Provider requests the failed call made, when the provider counted them; each may be billed. */
  readonly attempts?: number
  constructor(readonly failure: ModelFailure, message: string, options?: ErrorOptions & { unprocessed?: Unprocessed; attempts?: number }) {
    super(message, options)
    this.name = 'ModelError'
    if (options?.unprocessed) this.unprocessed = options.unprocessed
    if (options?.attempts !== undefined) this.attempts = options.attempts
  }
}

export abstract class Models extends Service {
  constructor(ctx: Context) {
    super(ctx, 'models')
  }

  /** Every catalog entry with its availability now, ordered by id. */
  abstract list(): Promise<ModelStatus[]>

  /**
   * One completion of `prompt`, bounded by the entry's `maxTokens`. Rejects with a
   * {@link ModelError}; a call stopped by `signal` fails as `aborted`. Each call may be billed.
   */
  abstract complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCompletion>
}
