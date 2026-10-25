import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { POOLS, resourcesSuite, TEMPLATES } from '../../../resources-core/conformance/resources.ts'
import { RESOURCES_CONTRACT } from '@tsuuanmi/system-resources-core'
import StoreResources from '../src/index.ts'

// The store-backed ledger against the suite every `ctx.resources` provider must pass (ADR-0036,
// ADR-0037), with no known failure.
runSuite(resourcesSuite, {
  name: '@tsuuanmi/system-resources',
  contract: RESOURCES_CONTRACT,
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-resources-conformance-'))
    const ctx = new Context()
    // With the event log the host loads: a scoped cap reads it for usage the ledger could not count (ADR-0065).
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}),
      ctx.plugin(StoreResources, { pools: structuredClone([...POOLS]), templates: structuredClone([...TEMPLATES]) }),
    ]
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
