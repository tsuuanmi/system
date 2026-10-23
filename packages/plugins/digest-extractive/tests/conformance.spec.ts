import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { DIGESTS_CONTRACT } from '@tsuuanmi/system-digest-core'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import { vi } from 'vitest'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { digestsSuite } from '../../../digest-core/conformance/digests.ts'
import { DigestWorker } from '../../../digest-core/conformance/worker.ts'
import ExtractiveDigests from '../src/index.ts'
import { sourcesOfExtract } from './helpers.ts'

vi.setConfig({ testTimeout: 60_000 })

// The extractive provider over real routing, artifacts, and leases; only the Worker is scripted, and
// it answers in the suite's own way (claims citing a source and a quote), which this provider checks
// as the seam's quote check does.
runSuite(digestsSuite, {
  name: '@tsuuanmi/system-digest-extractive',
  contract: DIGESTS_CONTRACT,
  boot: async (drafter) => {
    const dir = mkdtempSync(join(tmpdir(), 'system-digest-extractive-conformance-'))
    const ctx = new Context()
    const worker = new DigestWorker(drafter, sourcesOfExtract)
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(WorkerRouter, {}),
      ctx.plugin({ name: 'digest-worker', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(worker.source(c)) }),
      ctx.plugin(ExtractiveDigests, {}),
    ]
    await Promise.all(fibers)
    return {
      ctx,
      dispose: async () => {
        for (const fiber of [...fibers].reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
