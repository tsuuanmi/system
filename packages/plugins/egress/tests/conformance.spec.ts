import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { EGRESS_CONFIG, egressSuite } from '../../../workers-core/conformance/egress.ts'
import Egress from '../src/index.ts'

// The real provider, over a real store and artifact ledger, passes the seam's suite (ADR-0037).
runSuite(egressSuite, {
  name: '@tsuuanmi/system-egress',
  contract: '1.0',
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-egress-conformance-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Egress, EGRESS_CONFIG)]
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
