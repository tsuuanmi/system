import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { artifactsSuite, CONFIG } from '../conformance/artifacts.ts'
import Artifacts from '../src/index.ts'

// The provider over a real store, held to the suite any replacement must pass (ADR-0037).
runSuite(artifactsSuite, {
  name: '@tsuuanmi/system-artifacts',
  contract: '1.0',
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-artifacts-conformance-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, { ...CONFIG })]
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
