import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it } from 'vitest'
import { requirement, worker, workersConformance } from '../../../workers-core/conformance/workers.ts'
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
  it('orders by the configured priority list after tier and quota class, and says why each admitted Worker lost', async () => {
    const { ctx, dispose } = await boot({ priority: ['w:z'] })
    try {
      ctx.workers.register({ name: 'test', describe: async () => [worker('w:a'), worker('w:z'), worker('w:eco', { tier: 'economy', quotaClass: 'metered' })] })
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

  it('refuses a source that describes an invalid or duplicate Worker', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.workers.register({ name: 'one', describe: async () => [worker('w:a')] })
      ctx.workers.register({ name: 'two', describe: async () => [worker('w:a')] })
      await expect(ctx.workers.list()).rejects.toThrow(/w:a/)
    } finally {
      await dispose()
    }
  })
})
