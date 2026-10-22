// One process of the reservation race in resources.spec.ts: it opens the shared store, says
// `ready`, and on `go` reserves against a cap the other processes reserve against too.
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import StoreResources from '../src/index.ts'

const [path, runId, pools] = process.argv.slice(2) as [string, string, string]
const ctx = new Context()
const fibers = [ctx.plugin(Store, { path, busyTimeoutMs: 30_000 }), ctx.plugin(Artifacts, {}), ctx.plugin(StoreResources, { pools: JSON.parse(pools) })]
await Promise.all(fibers)
process.on('message', (message) => {
  if (message !== 'go') return
  void ctx.resources.reserve({ runId, taskId: 'race', lines: [{ pool: 'p', unit: 'usd', amount: 0.6 }], caps: [{ pool: 'p', unit: 'usd', amount: 1 }] }, new Date('2026-10-22T09:01:00Z'))
    .then(async (reservation) => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      process.send!(reservation.state, () => process.exit(0))
    })
})
process.send!('ready')
