import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { WorkerSource } from '@tsuuanmi/system-workers-core'
import { vi } from 'vitest'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { workflowSuite } from '../conformance/workflow.ts'
import Workflow, { type Config } from '../src/index.ts'

// Each scenario runs the engine end to end on a durable store; a loaded host needs time.
vi.setConfig({ testTimeout: 120_000 })

/** The suite's policy since 1.2: `read` runs on auto, everything else asks. */
const POLICY: AutonomyPolicy = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio', rules: [{ actionClass: 'read', mode: 'auto' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}

/**
 * The engine composed with the real plugins it injects, over `dir`, the store-backed board and
 * approval queue among them (the board's own sweep off: the suite sweeps); only Worker execution is scripted.
 */
async function compose(dir: string, source: (ctx: Context) => WorkerSource, config: Config): Promise<{ ctx: Context; stop: () => Promise<void> }> {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    // Registered before the engine starts, so a restarted engine reconciles against it.
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(source(c)) }),
    ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ctx.plugin(Workflow, config),
  ]
  await Promise.all(fibers)
  return {
    ctx,
    stop: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    },
  }
}

runSuite(workflowSuite, {
  name: '@tsuuanmi/system-workflow',
  contract: '1.2',
  boot: async (source, config) => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-conformance-'))
    let current = await compose(dir, source, config)
    return {
      ctx: current.ctx,
      restart: async (between) => {
        await current.stop()
        await between?.()
        current = await compose(dir, source, config)
        return current.ctx
      },
      dispose: async () => {
        await current.stop()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
