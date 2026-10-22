import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { approvalsSuite, POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import { APPROVALS_CONTRACT } from '../../../approvals-core/src/index.ts'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { ManualApprovals } from './manual.ts'

// The store-backed provider passes the seam's suite (ADR-0037) over the suite's policies, with no
// expected failures. Its own sweep and batch passes are off: the suite calls them at the times it names.
runSuite(approvalsSuite, {
  name: '@tsuuanmi/system-approvals',
  contract: APPROVALS_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-approvals-conformance-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(ManualApprovals, { policies: POLICIES })]
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
