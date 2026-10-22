import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import { POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import { boardSuite } from '../../../board-core/conformance/board.ts'
import { BOARD_CONTRACT } from '../../../board-core/src/index.ts'
import { runSuite } from '../../../libs/conformance/runner.ts'
import StoreApprovals from '../src/index.ts'

// The bundle's composition: the store-backed board passes its seam's suite over this queue, as it
// does over the approvals fake, with no expected failures. Both own clocks are off: the suite
// sweeps at the times it names.
runSuite(boardSuite, {
  name: '@tsuuanmi/system-board over @tsuuanmi/system-approvals',
  contract: BOARD_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-approvals-board-'))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}),
      ctx.plugin(StoreApprovals, { policies: POLICIES, sweepSeconds: 0 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ]
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
