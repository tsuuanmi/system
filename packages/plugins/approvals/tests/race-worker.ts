// One process of the verdict race in approvals.spec.ts: it opens the shared store, says `ready`,
// and on `go` gives its verdict on the request the other processes decide too.
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import StoreApprovals from '../src/index.ts'

const [path, requestId, subject, verdict, policies] = process.argv.slice(2) as [string, string, string, 'approved' | 'rejected', string]
const ctx = new Context()
const fibers = [ctx.plugin(Store, { path, busyTimeoutMs: 30_000 }), ctx.plugin(Artifacts, {}), ctx.plugin(StoreApprovals, { policies: JSON.parse(policies), sweepSeconds: 0 })]
await Promise.all(fibers)
process.on('message', (message) => {
  if (message !== 'go') return
  void ctx.approvals.decide([{ requestId, subject: JSON.parse(subject), verdict }], new Date('2026-10-22T09:01:00Z'))
    .then(async ([result]) => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      process.send!(JSON.stringify(result), () => process.exit(0))
    })
})
process.send!('ready')
