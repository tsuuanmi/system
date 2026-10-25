/**
 * `ctx.models` over the DSH `llm` service: each catalog entry names a provider route that an
 * `llm` adapter row registers (for example `llm-pi-ai`) and a model on it. The route owns the
 * endpoint, the wire protocol, and the credential reference; the key resolves through
 * `ctx.credentials` per request and never appears here.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { type ModelCompletion, type ModelEntry, ModelError, type ModelFailure, type ModelRequest, Models, type ModelStatus, type ModelTurn, type Unprocessed } from '@tsuuanmi/system-models-core'

export interface CatalogEntry extends ModelEntry {
  /** The `llm` provider route that reaches the model. */
  route: string
  /** The model id on that route. */
  model: string
}

export interface LlmModelsConfig {
  models: CatalogEntry[]
  /** Re-attempts of a failed call that the route's retry policy calls transient (default 2). */
  maxRetries?: number
  /**
   * The longest an attempt's answer stream may stay silent (default 5 min). Past it the stream is
   * stopped and the attempt fails as `TIMEOUT`: a stalled connection, which the route's retry
   * policy may re-attempt. A slow answer that keeps streaming is never stopped by it.
   */
  idleTimeoutMs?: number
}

/** The default silence bound: the old per-call deadline, so no call that answered under it is stopped by a stall now. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000

/** DSH's provider-neutral failure codes, mapped onto the seam's vocabulary. */
const FAILURES: Record<string, ModelFailure> = {
  MISSING_CREDENTIAL: 'credential', INVALID_CREDENTIAL: 'credential', AUTH: 'credential',
  QUOTA: 'quota', ACCOUNT_QUOTA: 'quota',
  RATE_LIMIT: 'rate-limit', TIMEOUT: 'timeout',
  SERVER: 'transient', TRANSPORT: 'transient', EMPTY_RESPONSE: 'transient',
  NO_ADAPTER: 'unavailable', UNKNOWN_MODEL: 'unavailable',
  ABORTED: 'aborted',
}

/** A failed attempt says whether any output of any kind came before the failure. */
type Attempt = { ok: true; completion: Omit<ModelCompletion, 'model' | 'maxTokens' | 'attempts'> } | { ok: false; failure: LlmFailure; output?: boolean }

/**
 * The provider's own word that it did not process the request (T209): an HTTP status with the
 * status name it gives for it, as a Gemini API (and any Google-style API) reports an overload or a
 * spent rate. Both must be said: a bare 503 or 429 is not taken as a promise that nothing ran.
 */
const UNPROCESSED: ReadonlyArray<{ status: number; name: string }> = [{ status: 503, name: 'UNAVAILABLE' }, { status: 429, name: 'RESOURCE_EXHAUSTED' }]

/** Whether a failure before any output is the provider saying it did not process the request. */
export function unprocessedOf(failure: LlmFailure): Unprocessed | undefined {
  const said = UNPROCESSED.find(({ status, name }) => (failure.status === status || new RegExp(`\\b${status}\\b`).test(failure.message)) && new RegExp(`\\b${name}\\b`).test(failure.message))
  if (!said) return undefined
  return { status: `${said.status} ${said.name}`, ...(failure.providerRetryAfterMs !== undefined ? { retryAfterMs: failure.providerRetryAfterMs } : {}) }
}

/** Failures no re-attempt can fix, whatever a route's retry policy says: trying again only bills again. */
const NEVER_RETRIED = new Set(['ABORTED', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'NO_ADAPTER', 'UNKNOWN_MODEL'])

export class LlmModels extends Models {
  static inject = ['llm']

  private readonly catalog: CatalogEntry[]

  constructor(ctx: Context, private readonly config: LlmModelsConfig) {
    super(ctx)
    this.catalog = [...config.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async list(): Promise<ModelStatus[]> {
    return Promise.all(this.catalog.map(async ({ route, model, ...entry }) => ({ ...entry, family: entry.family || route, ...(await this.probe(route, model)) })))
  }

  /** The route is mounted and resolves the model, without a model call. */
  private async probe(route: string, model: string): Promise<{ available: boolean; detail: string }> {
    if (!this.ctx.llm.listProviders().some((p) => p.id === route)) return { available: false, detail: `route ${route} is not mounted` }
    try {
      await this.ctx.llm.resolveModelInfo(route, model)
      return { available: true, detail: `route ${route} serves ${model}` }
    } catch (error) {
      return { available: false, detail: `route ${route} cannot serve ${model}: ${(error as Error).message.slice(0, 200)}` }
    }
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    const entry = this.catalog.find((m) => m.id === request.model)
    if (!entry) throw new ModelError('unknown-model', `no catalog entry ${request.model}`)
    const probe = await this.probe(entry.route, entry.model)
    if (!probe.available) throw new ModelError('unavailable', `${entry.id}: ${probe.detail}`)
    if (signal?.aborted) throw new ModelError('aborted', `${entry.id}: aborted before the call`)
    const maxTokens = Math.max(1, Math.min(request.maxTokens ?? entry.maxTokens, entry.maxTokens))
    // The route owns which failures are transient; the bound on re-attempts is ours (INV-9).
    const policy = this.ctx.llm.providerRetryPolicy(entry.route)
    const limit = Math.min(this.config.maxRetries ?? 2, policy.mode === 'normal' ? policy.maxRetries : Number.POSITIVE_INFINITY)
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(entry, request.prompt, request.history ?? [], maxTokens, signal)
      if (outcome.ok) return { model: entry.id, ...outcome.completion, maxTokens, attempts: attempt + 1 }
      const { failure } = outcome
      // The provider said it did not process the request: not the route's quick re-attempt, but
      // the caller's own bounded back-off, which records each retry (T209).
      const unprocessed = outcome.output || signal?.aborted ? undefined : unprocessedOf(failure)
      if (unprocessed) throw modelError(entry.id, failure, signal, unprocessed, attempt + 1)
      // Output came before the failure: the prompt was processed, so it is never resent, whatever the route retries (T209).
      if (outcome.output) throw modelError(entry.id, failure, signal)
      const transient = !NEVER_RETRIED.has(failure.code) && (policy.mode === 'always' || policy.retryableCodes.includes(failure.code))
      if (!transient || attempt >= limit || signal?.aborted) throw modelError(entry.id, failure, signal)
      const backoff = Math.min(policy.maxDelayMs, failure.providerRetryAfterMs ?? policy.initialDelayMs * 2 ** attempt)
      await sleep(backoff, signal)
    }
  }

  /**
   * One provider request: the visible text, usage, and how it finished. Any stream event is
   * progress; an attempt silent for `idleTimeoutMs` is stopped and fails as `TIMEOUT`, saying how
   * far it got, so a stalled connection is told apart from a slow answer.
   */
  private async attempt(entry: CatalogEntry, prompt: string, history: readonly ModelTurn[], maxTokens: number, signal: AbortSignal | undefined): Promise<Attempt> {
    const texts: string[] = []
    let usage = { inputTokens: 0, outputTokens: 0 }
    const idleMs = this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    const stall = new AbortController()
    const timer = setTimeout(() => stall.abort(), idleMs)
    let events = 0
    let chars = 0
    // Any output the model produced, of any kind (a block, text, reasoning, a tool call, or output
    // tokens reported): after it, a failure is never taken as the provider not processing the request.
    let output = false
    const stalled = (): Attempt => ({ ok: false, failure: { code: 'TIMEOUT', message: `no progress for ${idleMs} ms (idleTimeoutMs) after ${events} stream event(s) and ${chars} characters of answer; the stream was stopped` } })
    const stopped = (): boolean => stall.signal.aborted && !signal?.aborted
    try {
      const stream = this.ctx.llm.stream({
        provider: entry.route, model: entry.model, maxTokens,
        // A session's earlier turns, then the prompt (ADR-0031).
        messages: [
          ...history.map((turn) => (turn.role === 'user'
            ? { role: 'user' as const, content: [{ type: 'text' as const, text: turn.text }] }
            : createAssistantMessage({ content: [{ type: 'text', text: turn.text }], source: { provider: entry.route, model: entry.model } }))),
          { role: 'user', content: [{ type: 'text', text: prompt }] },
        ],
        signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
      })
      for await (const chunk of stream as AsyncIterable<StreamChunk>) {
        if (stopped()) return stalled()
        timer.refresh()
        events++
        if (chunk.type === 'block-start' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') output = true
        else if (chunk.type === 'text-delta') {
          chars += chunk.text.length
          output = true
        } else if (chunk.type === 'block-end') {
          output = true
          if (chunk.block.type === 'text') texts.push(chunk.block.text)
        } else if (chunk.type === 'usage') {
          usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }
          if (chunk.usage.outputTokens > 0) output = true
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason.kind === 'error' || reason.kind === 'aborted') return stopped() ? stalled() : { ok: false, failure: reason.failure, output }
          return { ok: true, completion: { text: texts.join(''), usage, finish: reason.kind === 'max-tokens' ? 'max-tokens' : 'stop' } }
        }
      }
      if (stopped()) return stalled()
      return { ok: false, failure: { code: 'TRANSPORT', message: 'the stream ended without a finish' } }
    } catch (error) {
      if (stopped()) return stalled()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function modelError(model: string, failure: LlmFailure, signal: AbortSignal | undefined, unprocessed?: Unprocessed, attempts?: number): ModelError {
  // A request the provider did not process is worth trying again later, whatever its code says.
  const kind: ModelFailure = signal?.aborted ? 'aborted' : unprocessed ? (unprocessed.status.startsWith('429') ? 'rate-limit' : 'transient') : FAILURES[failure.code] ?? 'invalid-request'
  // A provider can echo part of a refused key: a credential failure says only what failed.
  if (kind === 'credential') return new ModelError(kind, `${model}: ${failure.code}: the provider refused the credential, or none is stored (system model key)`)
  return new ModelError(kind, `${model}: ${failure.code}: ${failure.message.slice(0, 500)}`, { ...(unprocessed ? { unprocessed } : {}), ...(attempts ? { attempts } : {}) })
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', stop)
      resolve()
    }
    function stop(): void {
      clearTimeout(timer)
      reject(new ModelError('aborted', 'aborted while waiting to try again'))
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}
