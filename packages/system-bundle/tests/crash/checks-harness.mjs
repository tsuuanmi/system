/**
 * One engine process for the run's-checks crash case (plain JavaScript on the built packages,
 * ADR-0063): boots the store, the approval queue, routing, the agent Worker source with one writing
 * Worker on a scripted runtime (a worktree per workflow run of `<dir>/repo`, whose setup is `true` and
 * whose `tests` check is `node tests.mjs`), and the workflow engine with a one-step `develop` template.
 * The check hangs while the worktree holds `hang` (git-ignored, written by the agent in `start`), after
 * writing `started`, so the suite can kill the process with SIGKILL while a check runs. Reports on
 * stdout as `@@ {json}` lines.
 * - `start`: starts the run; reports its id, the agent's worktree, and when the check started.
 * - `resume <runId> <worktree>`: removes `hang`, boots again, and reports the run's end with its
 *   acceptance decision.
 * Usage: checks-harness.mjs <dir> start | resume <runId> <worktree>
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import AgentWorkers from '@tsuuanmi/system-agent-workers'
import StoreApprovals from '@tsuuanmi/system-approvals'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'
import { LEASE_CAP_MS } from './leases.mjs'

const [dir, mode, runArg, worktreeArg] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const repo = join(dir, 'repo')
const TESTS = 'node tests.mjs'
const SETUP = 'true'

if (mode === 'resume') rmSync(join(worktreeArg, 'hang'), { force: true })

const policy = {
  schema: 'autonomy-policy@1.0', id: 'studio-crash', version: 1, scope: 'studio',
  rules: [
    { actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests'] }, { actionClass: 'command', mode: 'ask' },
    ...['merge', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change'].map((actionClass) => ({ actionClass, mode: 'ask' })),
  ],
  default: 'ask', commands: [SETUP, TESTS], expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
}

/** A scripted writing agent: makes add() add, and in `start` leaves `hang` so the check hangs. */
const scripted = {
  kind: 'scripted',
  probe: async () => ({ available: true, detail: 'scripted', sandboxes: ['read-only', 'workspace-write'], resume: false, executes: true, readsConfined: true, gatesToolCalls: true }),
  run: async (spec) => {
    writeFileSync(join(spec.workspace, 'calc.py'), 'def add(a, b):\n    return a + b\n')
    if (mode === 'start') writeFileSync(join(spec.workspace, 'hang'), '')
    report({ worktree: spec.workspace })
    return { text: 'Changed calc.py.' }
  },
}

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, { maxTtlMs: LEASE_CAP_MS }), ctx.plugin(Egress, {}),
  ctx.plugin(StoreApprovals, { policies: [policy], sweepSeconds: 3600 }),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(AgentRuntimeRegistry, {}),
  ctx.plugin(AgentWorkers, {
    workers: [{ id: 'dev', runtime: 'scripted', workspace: repo, sandbox: 'workspace-write', tier: 'standard', tools: [], worktreePerRun: true }], worktreeRoot: join(dir, 'worktrees'),
    worktreeSetup: [{ repository: repo, commands: [SETUP], checks: { tests: TESTS } }],
  }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['agentWorkers', 'agentRuntimes'], () => resolve(undefined)))
ctx.agentRuntimes.register(scripted)
const develop = [{ nodeId: 'develop', objective: 'Make add() add', prompt: '{{input}}', capabilities: ['develop'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' }]
const engine = ctx.plugin(Workflow, { retryDelayMs: 50, maxAttempts: 1, templates: { develop } })
await engine

if (mode === 'start') {
  const { runId } = ctx.workflow.start({ template: 'develop', input: 'Make add() add', classification: 'operator-shared' })
  report({ runId })
  const watch = setInterval(() => {
    const worktree = ctx.store.db.prepare('SELECT path FROM agent_worktrees WHERE workflow_run_id = ?').get(runId)?.path
    if (worktree && existsSync(join(worktree, 'started'))) {
      clearInterval(watch)
      report({ checking: { worktree, status: ctx.workflow.get(runId)?.status } })
    }
  }, 50)
} else {
  const done = await ctx.workflow.wait(runArg, 120_000)
  const acceptances = ctx.artifacts.list({ kind: 'decision', decisionType: 'acceptance', runId: runArg })
    .map((a) => a.body).filter((b) => b.decider.id === 'workflow.run-acceptance')
  report({ done: { status: done.status, acceptances: acceptances.length, detail: acceptances[0]?.outcome.detail, inputs: acceptances[0]?.inputs } })
  await engine.dispose()
  for (const fiber of [...fibers].reverse()) await fiber.dispose()
  process.exit(0)
}
