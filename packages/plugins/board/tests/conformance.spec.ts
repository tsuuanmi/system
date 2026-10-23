import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import { FakeApprovals } from '../../../approvals-core/conformance/approvals.ts'
import { boardSuite } from '../../../board-core/conformance/board.ts'
import { BOARD_CONTRACT } from '../../../board-core/src/index.ts'
import { runSuite } from '../../../libs/conformance/runner.ts'
import StoreBoard from '../src/index.ts'

// The store-backed provider passes the seam's suite (ADR-0037) over the approvals fake, with no
// expected failures. Its own sweeper is off: the suite sweeps at the times it names.
runSuite(boardSuite, {
  name: '@tsuuanmi/system-board',
  contract: BOARD_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-board-conformance-'))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}), ctx.plugin(FakeApprovals),
      ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ]
    await Promise.all(fibers)
    return {
      ctx,
      changePolicies: async (policies) => { (ctx.approvals as FakeApprovals).reload(policies) },
      dispose: async () => {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
