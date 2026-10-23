/**
 * One engine process for the limit-wait crash case (plain JavaScript on the built packages): boots
 * the store, routing, and the workflow engine with one template whose step only two Workers prove,
 * two accounts of one assigned group, the first under a usage limit until `<reset>`; a scripted
 * source answers at once. Starts or resumes the run; reports on stdout as `@@ {json}` lines: the
 * run id, the node's wait once it waits, and the run's end with the Workers started in this process.
 * Usage: wait-harness.mjs <dir> <reset> start | resume <runId>
 */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'

const [dir, reset, mode, arg] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const AT = '2026-10-24T00:00:00Z'
const proves = ['reason', 'deep-research'].map((capability) => ({ capability, evidence: { kind: 'conformance', at: AT } }))
const worker = (id, account, extra = {}) => ({
  schema: 'capability-descriptor@1.5', worker: id, provider: 'crash', family: 'g', account: { id: account, group: 'g', mode: 'assigned' },
  tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote', capabilities: proves, state: 'ready', observedAt: AT, ...extra,
})

/** Executions started in this process; each answers at once. */
const started = []
const executions = new Map()
function source(ctx) {
  return {
    name: 'scripted',
    describe: async () => [worker('w:g-a', 'a', { cooldowns: [{ capability: 'deep-research', until: reset }] }), worker('w:g-b', 'b')],
    start: (request) => {
      const known = executions.get(request.key)
      if (known) return known
      started.push(request.worker)
      const result = ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: request.worker },
        body: { schema: 'provider-answer@1.0', provider: 'crash', account: 'crash', turnId: request.key, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text: `answer from ${request.worker}` },
      }).id
      const execution = { id: `x-${executions.size + 1}`, status: 'completed', submitted: true, result, decisions: [] }
      executions.set(request.key, execution)
      executions.set(execution.id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id),
  }
}

const step = { nodeId: 'needy', objective: 'Do needy', prompt: '{{input}}', capabilities: ['reason', 'deep-research'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' }
const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
  ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c) => void c.workers.register(source(c)) }),
  ctx.plugin(Workflow, { retryDelayMs: 300, templates: { needy: [step] } }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow'], () => resolve(undefined)))
const runId = mode === 'start' ? ctx.workflow.start({ template: 'needy', input: 'q', classification: 'public' }).runId : arg
report({ runId })
if (mode === 'start') {
  // Reported once the node waits for the reset: the test kills the process here.
  for (;;) {
    const node = ctx.workflow.get(runId)?.nodes.find((n) => n.nodeId === 'needy')
    if (node?.waitingUntil) {
      report({ waiting: { until: node.waitingUntil, attempt: node.attempt, started } })
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise(() => undefined)
}
const done = await ctx.workflow.wait(runId, 240_000)
report({ done: { ...done, started } })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
