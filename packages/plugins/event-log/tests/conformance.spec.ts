import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { eventLogSuite, RETAIN_DAYS } from '../conformance/event-log.ts'
import EventLog from '../src/index.ts'

// The store-backed event log against the suite every `ctx.eventLog` provider must pass (ADR-0036).
runSuite(eventLogSuite, {
  name: '@tsuuanmi/system-event-log',
  contract: '1.0',
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-event-log-conformance-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(EventLog, { retainDays: RETAIN_DAYS })]
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
