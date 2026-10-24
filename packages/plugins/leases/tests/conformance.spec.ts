import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { LEASE_MAX_TTL_MS, leasesSuite } from '../conformance/leases.ts'
import Leases from '../src/index.ts'

// The real provider over a real store passes the seam's suite (ADR-0037).
runSuite(leasesSuite, {
  name: '@tsuuanmi/system-leases',
  contract: '1.1',
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-leases-conformance-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Leases, { maxTtlMs: LEASE_MAX_TTL_MS })]
    await Promise.all(fibers)
    return {
      ctx,
      dispose: async () => {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
