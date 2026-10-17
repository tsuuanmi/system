/**
 * `ctx.models` over the DSH `llm` service: each catalog entry names a provider route that an
 * `llm` adapter row registers (for example `llm-pi-ai`) and a model on it. The route owns the
 * endpoint, the wire protocol, and the credential reference; the key resolves through
 * `ctx.credentials` per request and never appears here.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, type LlmFailure, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { type ModelCompletion, type ModelEntry, ModelError, type ModelFailure, type ModelRequest, Models, type ModelStatus, type ModelTurn } from '@tsuuanmi/system-models-core'

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
}

/** DSH's provider-neutral failure codes, mapped onto the seam's vocabulary. */
const FAILURES: Record<string, ModelFailure> = {
  MISSING_CREDENTIAL: 'credential', INVALID_CREDENTIAL: 'credential', AUTH: 'credential',
  QUOTA: 'quota', ACCOUNT_QUOTA: 'quota',
  RATE_LIMIT: 'rate-limit', TIMEOUT: 'timeout',
  SERVER: 'transient', TRANSPORT: 'transient', EMPTY_RESPONSE: 'transient',
  NO_ADAPTER: 'unavailable', UNKNOWN_MODEL: 'unavailable',
  ABORTED: 'aborted',
}

type Attempt = { ok: true; completion: Omit<ModelCompletion, 'model' | 'maxTokens' | 'attempts'> } | { ok: false; failure: LlmFailure }

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
      const transient = !NEVER_RETRIED.has(failure.code) && (policy.mode === 'always' || policy.retryableCodes.includes(failure.code))
      if (!transient || attempt >= limit || signal?.aborted) throw modelError(entry.id, failure, signal)
      const backoff = Math.min(policy.maxDelayMs, failure.providerRetryAfterMs ?? policy.initialDelayMs * 2 ** attempt)
      await sleep(backoff, signal)
    }
  }

  /** One provider request: the visible text, usage, and how it finished. */
  private async attempt(entry: CatalogEntry, prompt: string, history: readonly ModelTurn[], maxTokens: number, signal: AbortSignal | undefined): Promise<Attempt> {
    const texts: string[] = []
    let usage = { inputTokens: 0, outputTokens: 0 }
    const stream = this.ctx.llm.stream({
      provider: entry.route, model: entry.model, maxTokens,
      // A session's earlier turns, then the prompt (ADR-0031).
      messages: [
        ...history.map((turn) => (turn.role === 'user'
          ? { role: 'user' as const, content: [{ type: 'text' as const, text: turn.text }] }
          : createAssistantMessage({ content: [{ type: 'text', text: turn.text }], source: { provider: entry.route, model: entry.model } }))),
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
      ...(signal ? { signal } : {}),
    })
    for await (const chunk of stream as AsyncIterable<StreamChunk>) {
      if (chunk.type === 'block-end' && chunk.block.type === 'text') texts.push(chunk.block.text)
      else if (chunk.type === 'usage') usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }
      else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason.kind === 'error' || reason.kind === 'aborted') return { ok: false, failure: reason.failure }
        return { ok: true, completion: { text: texts.join(''), usage, finish: reason.kind === 'max-tokens' ? 'max-tokens' : 'stop' } }
      }
    }
    return { ok: false, failure: { code: 'TRANSPORT', message: 'the stream ended without a finish' } }
  }
}

function modelError(model: string, failure: LlmFailure, signal: AbortSignal | undefined): ModelError {
  const kind: ModelFailure = signal?.aborted ? 'aborted' : FAILURES[failure.code] ?? 'invalid-request'
  // A provider can echo part of a refused key: a credential failure says only what failed.
  if (kind === 'credential') return new ModelError(kind, `${model}: ${failure.code}: the provider refused the credential, or none is stored (system model key)`)
  return new ModelError(kind, `${model}: ${failure.code}: ${failure.message.slice(0, 500)}`)
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
