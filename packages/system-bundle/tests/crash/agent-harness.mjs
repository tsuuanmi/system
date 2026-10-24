/**
 * One engine process for the agent-run crash case (plain JavaScript on the built packages):
 * boots the store, routing, the agent Worker source with one scripted read-only runtime, and the
 * workflow engine; starts or resumes an `agent-review` run; reports on stdout as `@@ {json}` lines. The
 * scripted runtime appends one line to `<dir>/agent-started` each time a run starts, then works
 * slowly, so the suite can kill the process with SIGKILL while the agent is running.
 * Usage: agent-harness.mjs <dir> <workspace> start <input> | resume <runId>
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import AgentWorkers from '@tsuuanmi/system-agent-workers'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { AGENT_REVIEW } from '@tsuuanmi/system-profile-software-development'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'
import { LEASE_CAP_MS } from './leases.mjs'

const [dir, workspace, mode, arg] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)

/** A scripted agent: records each start, then takes 60 s unless aborted. It makes no tool calls, so it asks the run's tool gate before every one trivially. */
const scripted = {
  kind: 'scripted',
  probe: async () => ({ available: true, detail: 'scripted', sandboxes: ['read-only'], resume: false, executes: false, readsConfined: true, gatesToolCalls: true }),
  run: async (spec, signal) => {
    appendFileSync(join(dir, 'agent-started'), `${spec.prompt.length}\n`)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 60_000)
      signal.addEventListener('abort', () => (clearTimeout(timer), reject(Object.assign(new Error('stopped'), { kind: 'aborted' }))), { once: true })
    })
    return { text: 'No findings.' }
  },
}

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, { maxTtlMs: LEASE_CAP_MS }), ctx.plugin(Egress, {}),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry, {}),
  ctx.plugin(AgentWorkers, { workers: [{ id: 'reviewer', runtime: 'scripted', workspace, sandbox: 'read-only', tier: 'standard' }] }),
  ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 300, templates: { 'agent-review': AGENT_REVIEW } }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow', 'agentRuntimes'], () => resolve(undefined)))
ctx.agentRuntimes.register(scripted)
const runId = mode === 'start' ? ctx.workflow.start({ template: 'agent-review', input: arg, classification: 'operator-shared' }).runId : arg
report({ runId })
const done = await ctx.workflow.wait(runId, 240_000)
report({ done })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
