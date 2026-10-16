import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import type { ModelEntry } from '@tsuuanmi/system-models-core'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeModels, type FakeScript } from '../../../models-core/conformance/models.ts'
import { ModelWorkers } from '../../models/src/index.ts'
import Workflow from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const CATALOG: ModelEntry[] = [{ id: 'fast', tier: 'standard', quotaClass: 'metered', locality: 'remote', maxTokens: 64 }]

/** The engine over a fake model Worker: no browser, so faults are injected deterministically. */
async function boot(script: FakeScript = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-engine-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(FakeModels, { catalog: CATALOG, script }),
    ctx.plugin(ModelWorkers, { callTimeoutMs: 60_000 }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100 }),
  ]
  await Promise.all(fibers)
  // Start-up recovery has run, so nothing scheduled then can take a run back by chance.
  await new Promise((resolve) => setTimeout(resolve, 200))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx }
}

describe('ctx.workflow: the engine under injected faults', () => {
  it('takes a run back after its lease is lost while a node waits on its execution, instead of stranding it', async () => {
    const { ctx } = await boot({ holdMs: 23_000 })
    const run = ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' })
    const node = (): string => ctx.workflow.get(run.runId)!.nodes[0]!.state
    while (node() !== 'RUNNING') await new Promise((resolve) => setTimeout(resolve, 50))
    // The host slept past the lease: the next heartbeat (a third of the TTL) finds it expired and gives it up.
    ctx.store.db.prepare('UPDATE leases SET expires_at = 1 WHERE resource = ?').run(`run:${run.runId}`)
    // The model call ends after that heartbeat; the run must still finish, not stay running for ever.
    expect(await ctx.workflow.wait(run.runId, 40_000)).toMatchObject({ status: 'completed', answer: 'echo: q' })
  }, 60_000)

  it('fails the node a scheduler exception happened on, so the operator can continue it once fixed', async () => {
    const { ctx } = await boot()
    const accept = ctx.workers.accept.bind(ctx.workers)
    ctx.workers.accept = (() => {
      throw new Error('a defect in acceptance')
    }) as typeof accept
    const run = ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' })
    expect(await ctx.workflow.wait(run.runId, 20_000)).toMatchObject({
      status: 'failed', nodes: [{ state: 'FAILED', error: { kind: 'internal', disposition: 'CODE_FIX', message: 'a defect in acceptance' } }],
    })
    // The fix lands; continuing reopens the failed node instead of refusing a run with none.
    ctx.workers.accept = accept
    ctx.workflow.continue(run.runId)
    expect(await ctx.workflow.wait(run.runId, 20_000)).toMatchObject({ status: 'completed', answer: 'echo: q' })
  }, 60_000)
})
