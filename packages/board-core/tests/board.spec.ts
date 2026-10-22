import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { FakeApprovals } from '../../approvals-core/conformance/approvals.ts'
import { runSuite } from '../../libs/conformance/runner.ts'
import { boardSuite, FakeBoard } from '../conformance/board.ts'
import { BOARD_CONTRACT } from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037), over the approvals fake.
runSuite(boardSuite, {
  name: 'the fake provider',
  contract: BOARD_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-board-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(FakeApprovals), ctx.plugin(FakeBoard)]
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
