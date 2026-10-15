/**
 * API and local models as Workers (docs/design/models.md, REQ-WRK-10). One row mounts two parts:
 * - `ctx.models` over the DSH `llm` service, from the operator's model catalog ({@link LlmModels});
 * - the `models` Worker source, which reaches models only through `ctx.models` ({@link ModelWorkers}).
 * It also contributes the operator tool `model_key`, which stores a route's API key in the
 * encrypted vault under the credential reference the route names (`apiKeyEnv`).
 * @module @tsuuanmi/system-models
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-gateway-core'
import { z as zod } from 'zod'
import { type CatalogEntry, LlmModels } from './llm.ts'
import { ModelWorkers } from './workers.ts'

export { LlmModels, type CatalogEntry } from './llm.ts'
export { ModelWorkers } from './workers.ts'

export const name = 'models'

export interface Config {
  /** The model catalog: each entry is the Worker `model:<id>`. Empty: no model Workers. */
  models: CatalogEntry[]
  /** Re-attempts of a call that failed transiently, as the route's retry policy defines it (default 2). */
  maxRetries?: number
  /** Calls in flight at once, over every model Worker (default 4). */
  maxConcurrentCalls?: number
  /** Hard deadline per call (default 5 min). */
  callTimeoutMs?: number
  /** Days a finished call and its prompt are kept (default 30). */
  retainDays?: number
}

/** The schema bounds a model id to 64 characters, so the catalog does too: a longer one would fail after the call was billed. */
const ID = /^[a-z][a-z0-9-]{0,63}$/

export const Config: z<Config> = z.object({
  models: z.array(z.object({
    id: z.string().pattern(ID).required().description('Catalog id; the Worker is model:<id>'),
    route: z.string().required().description('The llm provider route that reaches the model (an llm-pi-ai providers key)'),
    model: z.string().required().description('The model id on that route'),
    tier: z.union(['economy', 'standard', 'frontier']).required(),
    quotaClass: z.union(['metered', 'local']).default('metered').description('metered: paid per token; local: no quota'),
    locality: z.union(['remote', 'local']).default('remote').description('local: the model runs on this machine (egress class model-local)'),
    maxTokens: z.natural().min(1).max(200_000).default(4096).description('Output bound of every call (INV-9)'),
    family: z.string().description('Opaque provider family (ADR-0027; default: the route). Give two routes to one vendor the same family, so diversity treats them as one'),
  })).default([]).description('The model catalog (REQ-WRK-10); names no key: a key is stored with the operator tool model_key'),
  maxRetries: z.natural().max(5).default(2).description('Re-attempts of a transiently failed call'),
  maxConcurrentCalls: z.natural().min(1).max(64).default(4).description('Model calls in flight at once'),
  callTimeoutMs: z.natural().min(1).default(5 * 60_000).description('Hard deadline per call'),
  retainDays: z.natural().min(1).default(30).description('Days a finished call and its prompt are kept'),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config): void {
  const ids = new Set<string>()
  for (const entry of config.models ?? []) {
    if (!ID.test(entry.id)) throw new Error(`model id ${entry.id} must match ${ID}`)
    if (ids.has(entry.id)) throw new Error(`duplicate model ${entry.id}`)
    ids.add(entry.id)
  }
  ctx.plugin(LlmModels, { models: config.models ?? [], ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}) })
  ctx.plugin(ModelWorkers, {
    ...(config.maxConcurrentCalls !== undefined ? { maxConcurrentCalls: config.maxConcurrentCalls } : {}),
    ...(config.callTimeoutMs !== undefined ? { callTimeoutMs: config.callTimeoutMs } : {}),
    ...(config.retainDays !== undefined ? { retainDays: config.retainDays } : {}),
  })
  ctx.inject(['mcp', 'credentials'], (c) => {
    c.mcp.tool('model_key', {
      description: 'Operator tool: store a model route\'s API key, encrypted, under the credential reference its apiKeyEnv names. Nothing is returned or logged.',
      inputSchema: {
        name: zod.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).describe('The credential reference (an UPPER_SNAKE name), as the route\'s apiKeyEnv names it'),
        value: zod.string().min(1).max(4096),
      },
    }, async ({ name: ref, value }) => {
      try {
        await c.credentials.set(credentialRef(String(ref)), String(value))
        return { content: [{ type: 'text', text: `stored ${String(ref)}` }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }
      }
    })
  })
}
