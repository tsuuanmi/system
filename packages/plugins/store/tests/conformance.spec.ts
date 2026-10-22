import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { storeSuite } from '../conformance/store.ts'
import Store from '../src/index.ts'

// The node:sqlite store against the suite every `ctx.store` provider must pass (ADR-0036).
runSuite(storeSuite, {
  name: '@tsuuanmi/system-store',
  contract: '1.0',
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-store-conformance-'))
    const ctx = new Context()
    // A directory the store creates itself, so it sets the directory's mode too.
    const fiber = ctx.plugin(Store, { path: join(dir, 'db', 'system.db') })
    await fiber
    return {
      ctx,
      dispose: async () => {
        await fiber.dispose()
        // The store closes after the dispose pass.
        await new Promise((resolve) => setImmediate(resolve))
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
