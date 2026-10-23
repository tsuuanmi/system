import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it } from 'vitest'
import { requirement, source, worker, workersConformance } from '../../../workers-core/conformance/workers.ts'
import WorkerRouter, { type Config } from '../src/index.ts'

async function boot(config: Config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workers-'))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(WorkerRouter, config)]
  await Promise.all(fibers)
  return {
    ctx,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

workersConformance('@tsuuanmi/system-workers', () => boot())

describe('ctx.workers: configured preferences', () => {
  it('orders by the configured priority list after tier and quota class, and says why each admitted Worker lost (REQ-ART-1)', async () => {
    const { ctx, dispose } = await boot({ priority: ['w:z'] })
    try {
      ctx.workers.register(source('test', [worker('w:a'), worker('w:z'), worker('w:eco', { tier: 'economy', quotaClass: 'metered' })]))
      const admitted = await ctx.workers.route(requirement({ tier: { min: 'standard', source: 'caller' } }))
      expect(admitted.worker.worker).toBe('w:z')
      const route = ctx.artifacts.get(admitted.decisions.route)?.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
      expect(route.candidates).toEqual([
        { option: 'w:a', selected: false, reasons: ['admitted; w:z comes first in the configured priority list'] },
        { option: 'w:eco', selected: false, reasons: ['tier economy is below the minimum standard'] },
        { option: 'w:z', selected: true, reasons: ['proves reason', 'lowest admissible tier standard', 'quota class subscription-chat', 'first in the configured priority list'] },
      ])
    } finally {
      await dispose()
    }
  })

  it('orders quota classes as configured: the api-first order puts local and metered models before website quota (REQ-WRK-8)', async () => {
    const workers = [worker('w:site'), worker('w:api', { quotaClass: 'metered' }), worker('w:local', { quotaClass: 'local', locality: 'local' })]
    const order = async (config: Config): Promise<string[]> => {
      const { ctx, dispose } = await boot(config)
      try {
        ctx.workers.register(source('test', workers))
        const first = (await ctx.workers.route(requirement())).worker.worker
        const second = (await ctx.workers.route(requirement({}), { restrict: { workers: ['w:site', 'w:api'], reason: 'test' } })).worker.worker
        return [first, second]
      } finally {
        await dispose()
      }
    }
    expect(await order({})).toEqual(['w:site', 'w:site'])
    expect(await order({ quotaPreference: ['local', 'metered', 'agent-plan', 'subscription-chat'] })).toEqual(['w:local', 'w:api'])
  })

  it('ships the acceptance.answer and acceptance.cited contracts', async () => {
    const { ctx, dispose } = await boot()
    try {
      const put = (text: string) => ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'test' },
        body: { schema: 'provider-answer@1.0', provider: 'p', account: 'a', turnId: 't', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
      }).id as `sha256:${string}`
      expect(ctx.workers.accept(put('fine'), 'acceptance.answer').accepted).toBe(true)
      const uncited = ctx.workers.accept(put('fine'), 'acceptance.cited')
      expect(uncited).toMatchObject({ accepted: false, reasons: ['the answer cites no source link'] })
      const cited = 'See [A](https://a.example/x) and https://b.example/y, again https://a.example/x.'
      const accepted = ctx.workers.accept(put(cited), 'acceptance.cited')
      expect(accepted).toMatchObject({ accepted: true, reasons: ['the answer cites 2 source link(s)'] })
      // A link ending in a long run of punctuation is counted in linear time (no polynomial backtracking).
      const started = performance.now()
      expect(ctx.workers.accept(put(`See https://a.example/x${'!'.repeat(100_000)}y and https://a.example/x?!.`), 'acceptance.cited')).toMatchObject({ reasons: ['the answer cites 2 source link(s)'] })
      expect(performance.now() - started).toBeLessThan(1000)
      // The losing option says why it lost (INV-13): the failed check, or that every check passed.
      const candidates = (decision: string) => (ctx.artifacts.get(decision)?.body as { candidates: unknown[] }).candidates
      expect(candidates(uncited.decision)).toEqual([
        { option: 'accept', selected: false, reasons: ['not accept: the answer cites no source link'] },
        { option: 'reject', selected: true, reasons: ['the answer cites no source link'] },
      ])
      expect(candidates(accepted.decision)).toEqual([
        { option: 'accept', selected: true, reasons: ['the answer cites 2 source link(s)'] },
        { option: 'reject', selected: false, reasons: ['not reject: every check of acceptance.cited passed'] },
      ])
    } finally {
      await dispose()
    }
  })

  it('rejects a structured result that fails its schema with a bounded reason, however long the validation errors (REQ-ART-5)', async () => {
    const { ctx, dispose } = await boot()
    try {
      const text = '```json\n' + JSON.stringify({ question: 'q', hypotheses: Array.from({ length: 40 }, (_, i) => ({ id: `bad-${i}`, statement: 1 })) }) + '\n```'
      const result = ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'test' },
        body: { schema: 'provider-answer@1.0', provider: 'p', account: 'a', turnId: 't', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
      }).id as `sha256:${string}`
      const verdict = ctx.workers.accept(result, 'acceptance.answer', { resultSchema: 'hypothesis-set@1.0' })
      expect(verdict.accepted).toBe(false)
      expect(verdict.reasons[0]!.length).toBeLessThanOrEqual(300)
    } finally {
      await dispose()
    }
  })

  it('refuses a source that describes an invalid or duplicate Worker', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.workers.register(source('one', [worker('w:a')]))
      ctx.workers.register(source('two', [worker('w:a')]))
      await expect(ctx.workers.list()).rejects.toThrow(/w:a/)
    } finally {
      await dispose()
    }
  })
})
