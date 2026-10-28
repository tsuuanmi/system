// One process of the sequence race in decisions.spec.ts: it opens the shared store, says `ready`, and
// on `go` records `count` questions, then reports the numbers the store gave it.
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import * as Decisions from '../src/index.ts'

const [path, label, count] = process.argv.slice(2) as [string, string, string]
const ctx = new Context()
const fibers = [ctx.plugin(Store, { path, busyTimeoutMs: 30_000 })]
await Promise.all(fibers)
fibers.push(ctx.plugin(Decisions, {}))
await fibers[1]
const log = new Decisions.DecisionLog(ctx)
process.on('message', (message) => {
  if (message !== 'go') return
  const ids: string[] = []
  for (let i = 0; i < Number(count); i++) ids.push(log.ask({ question: `question ${label}-${i}` }, { kind: 'operator' }, new Date('2026-10-27T09:00:00.000Z')).id)
  void (async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    process.send!(JSON.stringify(ids), () => process.exit(0))
  })()
})
process.send!('ready')
