import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { MAX_RESUBMITS, turnReceiptsSuite } from '../conformance/turn-receipts.ts'
import TurnReceipts from '../src/index.ts'

// The store-backed receipts against the suite every `ctx.turnReceipts` provider must pass (ADR-0036).
runSuite(turnReceiptsSuite, {
  name: '@tsuuanmi/system-turn-receipts',
  contract: '1.0',
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turn-receipts-conformance-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(TurnReceipts, { maxResubmits: MAX_RESUBMITS })]
    await Promise.all(fibers)
    return {
      ctx,
      dispose: async () => {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        await new Promise((resolve) => setImmediate(resolve))
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
