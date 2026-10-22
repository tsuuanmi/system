import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../libs/conformance/runner.ts'
import { resourcesSuite, FakeResources } from '../conformance/resources.ts'
import { RESOURCES_CONTRACT } from '../src/index.ts'

// The seam's own fake passes the suite every provider must pass (ADR-0037).
runSuite(resourcesSuite, {
  name: 'the fake provider',
  contract: RESOURCES_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-resources-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(FakeResources)]
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
