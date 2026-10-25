/**
 * One engine process for the resend crash case (plain JavaScript on the built packages, ADR-0062):
 * boots the store, routing, sessions, and the workflow engine with a two-member brainstorm, each
 * member on a Worker of its own family. A scripted source, kept in `<dir>/source.json` so it outlives
 * the process as a Worker runtime does, answers at once: member m1's first proposal is the site's own
 * error after the send (`siteError`), every other proposal and ballot an answer. `reset` starts a
 * session's next execution in a new conversation. Starts or resumes the run; reports on stdout as
 * `@@ {json}` lines: the run id, the resend decision once recorded (`start` then hangs, for the kill),
 * and the run's end with every execution the source started and the sessions it reset.
 * Usage: resend-harness.mjs <dir> start | resume <runId>
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
import { LEASE_CAP_MS } from './leases.mjs'

const [dir, mode, arg] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const AT = '2026-10-25T00:00:00Z'
const proves = ['reason', 'persistent-conversation'].map((capability) => ({ capability, evidence: { kind: 'conformance', at: AT } }))
const worker = (id, family) => ({
  schema: 'capability-descriptor@1.1', worker: id, provider: family, family, tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote', capabilities: proves, state: 'ready', observedAt: AT,
})

/** The source's durable state: executions by key and id, sessions, every start, and every reset. */
const FILE = join(dir, 'source.json')
const state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { executions: {}, keys: {}, sessions: {}, started: [], resets: [] }
const save = () => {
  writeFileSync(`${FILE}.tmp`, JSON.stringify(state))
  renameSync(`${FILE}.tmp`, FILE)
}

const proposal = (member) => `My proposal.\n${JSON.stringify({ recommendation: `option of ${member}`, rationale: 'it fits', risks: [] })}`
const ballot = JSON.stringify({ choice: 'O1', ranking: ['O1', 'O2'], rationale: 'I prefer O1', evidence: [], strongest: { O2: 'it is simpler' }, objections: [], confidence: 'high' })

function source(ctx) {
  return {
    name: 'scripted',
    describe: async () => [worker('w:a', 'family-a'), worker('w:b', 'family-b')],
    start: (request) => {
      const known = state.keys[request.key]
      if (known) return state.executions[known]
      const step = /:team:(m\d):(propose|ballot):/.exec(request.key)
      const session = request.sessionId ? (state.sessions[request.sessionId] ??= { worker: request.worker, conversations: 1 }) : undefined
      if (session) session.handle ??= `native-${request.sessionId}-${session.conversations}`
      const id = `x-${state.started.length + 1}`
      state.started.push({ id, key: request.key, worker: request.worker, sessionId: request.sessionId, conversation: session?.handle })
      const first = step?.[1] === 'm1' && step[2] === 'propose' && !state.started.slice(0, -1).some((s) => s.key.includes(':team:m1:propose:'))
      const execution = first
        ? { id, status: 'failed', submitted: true, decisions: [], error: { kind: 'overloaded', disposition: 'BACKOFF', message: 'the site answered with its own error', siteError: true } }
        : {
          id, status: 'completed', submitted: true, decisions: [],
          result: ctx.artifacts.put({
            kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: request.worker },
            body: { schema: 'provider-answer@1.0', provider: 'crash', account: 'crash', turnId: id, conversation: { mode: 'persistent', binding: session?.handle ?? 'none' }, promptHash: `sha256:${'0'.repeat(64)}`, text: step?.[2] === 'ballot' ? ballot : proposal(step?.[1] ?? 'm?') },
          }).id,
        }
      state.keys[request.key] = id
      state.executions[id] = execution
      save()
      return execution
    },
    get: (id) => state.executions[id],
    wait: async (id) => state.executions[id],
    affinity: (sessionId) => (state.sessions[sessionId] ? [state.sessions[sessionId].worker] : undefined),
    handle: (sessionId) => state.sessions[sessionId]?.handle,
    reset: (sessionId) => {
      const session = state.sessions[sessionId]
      if (!session) return false
      delete session.handle
      session.conversations += 1
      state.resets.push(sessionId)
      save()
      return true
    },
  }
}

const team = { nodeId: 'team', objective: 'Decide as a team', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.team-proposal', team: { kind: 'brainstorm' } }
const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, { maxTtlMs: LEASE_CAP_MS }), ctx.plugin(Egress, {}),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
  ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c) => void c.workers.register(source(c)) }),
  // The resend waits its back-off (retryDelayMs) before the new attempt starts: the kill lands in it.
  ctx.plugin(Workflow, { retryDelayMs: 20_000, templates: { team: [team] } }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow'], () => resolve(undefined)))
const runId = mode === 'start' ? ctx.workflow.start({ template: 'team', input: 'q', classification: 'public' }).runId : arg
report({ runId })
const resends = () => ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId, nodeId: 'team:m1:propose', limit: 100 })
  .map((a) => a.body).filter((d) => d.outcome.option === 'resend')
if (mode === 'start') {
  // Reported once the resend is decided, before its attempt starts: the test kills the process here.
  for (;;) {
    const [decision] = resends()
    if (decision) {
      report({ resent: { detail: decision.outcome.detail, started: state.started.filter((s) => s.key.includes(':team:m1:propose:')).length } })
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await new Promise(() => undefined)
}
const done = await ctx.workflow.wait(runId, 240_000)
report({ done: { status: done.status, started: state.started, resets: state.resets, resends: resends().length } })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
