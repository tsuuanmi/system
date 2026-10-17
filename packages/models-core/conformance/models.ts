/**
 * Conformance suite for `ctx.models` (plugin rule 7, INV-11), and a fake provider that passes
 * it. A provider's test wires the provider to a model that answers `echo: <prompt>` and
 * configures the catalog in {@link CATALOG}: `echo` and `local` reach that model, `gone` names a
 * route that is not mounted.
 */
import { type Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { type ModelCompletion, type ModelEntry, ModelError, type ModelFailure, type ModelRequest, Models, type ModelStatus } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/** The routing attributes of the catalog every provider under test is configured with. */
export const CATALOG: readonly ModelEntry[] = [
  { id: 'echo', tier: 'economy', quotaClass: 'metered', locality: 'remote', maxTokens: 64 },
  { id: 'gone', tier: 'standard', quotaClass: 'metered', locality: 'remote', maxTokens: 64 },
  { id: 'local', tier: 'standard', quotaClass: 'local', locality: 'local', maxTokens: 32 },
]

const failureOf = async (call: Promise<unknown>): Promise<ModelFailure | string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof ModelError ? error.failure : `not a ModelError: ${String(error)}`
  }
}

export function modelsConformance(name: string, boot: Boot): void {
  describe(`ctx.models conformance: ${name}`, () => {
    const withModels = async (run: (ctx: Context) => Promise<void>): Promise<void> => {
      const { ctx, dispose } = await boot()
      try {
        await run(ctx)
      } finally {
        await dispose()
      }
    }

    it('lists every catalog entry by id, with its routing attributes and what is available now (REQ-WRK-10)', () => withModels(async (ctx) => {
      const listed = await ctx.models.list()
      expect(listed.map(({ available: _a, detail: _d, family: _f, ...entry }) => entry)).toEqual(CATALOG.map(({ family: _f, ...entry }) => entry))
      expect(listed.map((m) => [m.id, m.available])).toEqual([['echo', true], ['gone', false], ['local', true]])
      for (const m of listed) expect(m.detail.length).toBeGreaterThan(0)
      // Every entry names who serves it, so routing can tell provider families apart (ADR-0027).
      for (const m of listed) expect(typeof m.family === 'string' && m.family.length > 0, `${m.id} has a family`).toBe(true)
    }))

    it('completes a prompt with its text, token usage, and finish (REQ-WRK-10)', () => withModels(async (ctx) => {
      const completion: ModelCompletion = await ctx.models.complete({ model: 'echo', prompt: 'hello' })
      expect(completion).toMatchObject({ model: 'echo', text: 'echo: hello', finish: 'stop', maxTokens: 64 })
      expect(Number.isInteger(completion.attempts) && completion.attempts >= 1).toBe(true)
      for (const n of [completion.usage.inputTokens, completion.usage.outputTokens]) expect(Number.isInteger(n) && n >= 0).toBe(true)
    }))

    it('never lets a call exceed the entry\'s output bound (INV-9)', () => withModels(async (ctx) => {
      expect((await ctx.models.complete({ model: 'echo', prompt: 'a', maxTokens: 100_000 })).maxTokens).toBe(64)
      expect((await ctx.models.complete({ model: 'echo', prompt: 'b', maxTokens: 16 })).maxTokens).toBe(16)
      expect((await ctx.models.complete({ model: 'local', prompt: 'c' })).maxTokens).toBe(32)
    }))

    it('takes a session\'s history and answers the prompt after it (ADR-0031)', () => withModels(async (ctx) => {
      const completion = await ctx.models.complete({ model: 'echo', prompt: 'and now?', history: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'echo: first' }] })
      expect(completion).toMatchObject({ model: 'echo', text: 'echo: and now?', finish: 'stop' })
    }))

    it('fails closed with a provider-neutral reason: unknown, unavailable, aborted (INV-2)', () => withModels(async (ctx) => {
      expect(await failureOf(ctx.models.complete({ model: 'nope', prompt: 'x' }))).toBe('unknown-model')
      expect(await failureOf(ctx.models.complete({ model: 'gone', prompt: 'x' }))).toBe('unavailable')
      const stopped = new AbortController()
      stopped.abort()
      expect(await failureOf(ctx.models.complete({ model: 'echo', prompt: 'x' }, stopped.signal))).toBe('aborted')
    }))
  })
}

export interface FakeScript {
  /** Hold each call this long before answering (abortable). */
  holdMs?: number
  /** Fail the next calls with these reasons, in order. */
  fail?: ModelFailure[]
  /** Answer with this text instead of the echo; it sees the request, the history included. */
  answer?: (prompt: string, request: ModelRequest) => string
}

/**
 * A fake provider of `ctx.models` over {@link CATALOG} (or another catalog): it answers
 * `echo: <prompt>`, counts calls, and can be scripted to hold or fail.
 */
export class FakeModels extends Models {
  readonly calls: ModelRequest[] = []

  constructor(ctx: Context, private readonly config: { catalog?: readonly ModelEntry[]; unavailable?: string[]; script?: FakeScript } = {}) {
    super(ctx)
  }

  get script(): FakeScript {
    return (this.config.script ??= {})
  }

  async list(): Promise<ModelStatus[]> {
    const unavailable = this.config.unavailable ?? ['gone']
    return [...(this.config.catalog ?? CATALOG)].sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((m) => ({ family: 'fake-route', ...m, available: !unavailable.includes(m.id), detail: unavailable.includes(m.id) ? 'route not mounted' : 'fake route' }))
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    const entry = (await this.list()).find((m) => m.id === request.model)
    if (!entry) throw new ModelError('unknown-model', `no catalog entry ${request.model}`)
    if (!entry.available) throw new ModelError('unavailable', `${request.model}: route not mounted`)
    if (signal?.aborted) throw new ModelError('aborted', 'aborted before the call')
    this.calls.push(request)
    const hold = this.script.holdMs
    if (hold) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, hold)
        signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new ModelError('aborted', 'aborted during the call'))), { once: true })
      })
    }
    const failure = this.script.fail?.shift()
    if (failure) throw new ModelError(failure, `scripted ${failure}`)
    const maxTokens = Math.min(request.maxTokens ?? entry.maxTokens, entry.maxTokens)
    return { model: entry.id, text: this.script.answer?.(request.prompt, request) ?? `echo: ${request.prompt}`, usage: { inputTokens: 7, outputTokens: 3 }, finish: 'stop', maxTokens, attempts: 1 }
  }
}
