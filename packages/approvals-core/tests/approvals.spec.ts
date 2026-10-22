import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../libs/conformance/runner.ts'
import { approvalsSuite, FakeApprovals } from '../conformance/approvals.ts'
import { APPROVALS_CONTRACT } from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037).
runSuite(approvalsSuite, {
  name: 'the fake provider',
  contract: APPROVALS_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-approvals-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(FakeApprovals)]
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
