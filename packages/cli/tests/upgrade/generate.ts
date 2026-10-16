/**
 * Generates a seeded store fixture for the upgrade suite (PROP-0003 M6c item 4,
 * upgrade.e2e.ts beside this file): the real kernel, Worker router, sessions, and workflow
 * engine, with a scripted chat Worker source standing in for website accounts, run through every
 * kind of run the engine keeps (ask, a persistent session, a plan and its steps, an approval gate,
 * a re-plan with retired nodes, a team brainstorm, a rejected result). The store is written as SQL text
 * (reviewable, no binary in git) with a manifest of the runs and what the suite expects of them.
 *
 *   pnpm gen:upgrade-fixture <label>
 *
 * A fixture is generated once per release from that release's code and never edited afterwards;
 * until releases exist, one is seeded from the current code.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '../../../plugins/artifacts/src/index.ts'
import Egress from '../../../plugins/egress/src/index.ts'
import EventLog from '../../../plugins/event-log/src/index.ts'
import Leases from '../../../plugins/leases/src/index.ts'
import Store from '../../../plugins/store/src/index.ts'
import WorkerSessions from '../../../plugins/worker-sessions/src/index.ts'
import WorkerRouter, { type WorkerExecution } from '../../../plugins/workers/src/index.ts'
import Workflow, { type RunView } from '../../../plugins/workflow/src/index.ts'
import { TEST_TEMPLATES } from '../../../plugins/workflow/tests/templates.ts'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

export interface FixtureRun { runId: string; template: string; status: string; nodes: number }
export interface Manifest { label: string; source: string; createdAt: string; runs: FixtureRun[]; sessions: string[] }

/** A chat Worker on two accounts that answers at once, by the prompt's kind. */
function chatSource(ctx: Context): void {
  const executions = new Map<string, WorkerExecution>()
  const plan = (step: string): string => '```json\n' + JSON.stringify({ confidence: 'high', nodes: [{ id: step, objective: `Do ${step}`, prompt: `the ${step}`, capabilities: ['reason'], tier: 'economy' }] }) + '\n```'
  const answer = (prompt: string): string => {
    if (prompt.includes('Plan how to answer')) return plan(prompt.includes('Corrected context') ? 'new-step' : 'old-step')
    if (prompt.includes('<findings>')) return 'Synthesis of the findings https://example.org/source'
    if (prompt.includes('"recommendation"')) return 'Close it for inspection.\n{"recommendation": "Close the bridge for an inspection", "rationale": "Cracks were reported", "risks": ["traffic delays"]}'
    if (prompt.includes('your ballot')) return '{"choice": "O1", "ranking": ["O1", "O2"], "rationale": "Safety first", "evidence": [], "strongest": {"O2": "It is the same advice"}, "objections": [], "confidence": "high"}'
    if (prompt.includes('reject me')) return ''
    return `An answer to: ${prompt.slice(0, 60)} https://example.org/answer`
  }
  ctx.workers.register({
    name: 'chat',
    // Two provider families, so a team has its two members (ADR-0027).
    describe: async () => ['a', 'b'].map((account) => ({
      schema: 'capability-descriptor@1.1' as const, worker: `chat:${account}`, provider: 'fixture', family: `fixture-${account}`, tier: 'standard' as const, quotaClass: 'subscription-chat', locality: 'remote' as const,
      capabilities: ['reason', 'persistent-conversation'].map((capability) => ({ capability, evidence: { kind: 'conformance' as const, at: '2026-10-14T00:00:00Z' } })),
      state: 'ready' as const, observedAt: '2026-10-14T00:00:00Z',
    })),
    start: (request) => {
      const id = `chat-${executions.size + 1}`
      const result = ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: request.worker },
        body: { schema: 'provider-answer@1.0', provider: 'fixture', account: request.worker.replace(/^chat:/, 'account-'), turnId: id, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text: answer(request.prompt) || ' ' },
      }).id
      const execution: WorkerExecution = { id, status: 'completed', submitted: true, result: result as `sha256:${string}`, decisions: [] }
      executions.set(id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id)!,
  })
}

/** The plan a run's gate waits on. */
const planOf = (view: RunView): string => (view.blocked?.kind === 'gate' ? view.blocked.plan : '')

/** An operator action, retried while the run's advance still holds its lease. */
const asOperator = async <T>(action: () => T): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      return action()
    } catch (error) {
      if (!/busy/.test((error as Error).message) || i > 100) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

const settle = async (check: () => boolean, ms = 30_000): Promise<void> => {
  for (const started = Date.now(); !check();) {
    if (Date.now() - started > ms) throw new Error('the fixture run did not settle')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Run every kind of run the engine keeps, and return what the upgrade suite expects of them. */
async function seed(ctx: Context): Promise<{ runs: RunView[]; sessions: string[] }> {
  const wf = ctx.workflow
  const done = (runId: string): Promise<RunView> => wf.wait(runId, 30_000)
  const runs: RunView[] = []
  // A one-shot ask, and a persistent session continued once.
  runs.push(await done(wf.start({ template: 'ask', input: 'What is the capital of France?' }).runId))
  const first = await done(wf.start({ template: 'ask', input: 'Remember the number 7.', persist: true }).runId)
  runs.push(first, await done(wf.start({ template: 'ask', input: 'Which number?', sessionId: first.sessionId! }).runId))
  // A planner, its grown steps, and a synthesis.
  runs.push(await done(wf.start({ template: 'investigate', input: 'Why is the sky blue?' }).runId))
  // A gated plan, approved; then a re-plan after its input was superseded, approved again.
  const gated = wf.start({ template: 'fixture-gated', input: 'Plan with a gate' })
  await settle(() => wf.get(gated.runId)?.blocked !== undefined)
  await asOperator(() => wf.approve(gated.runId, { verdict: 'approved', plan: planOf(wf.get(gated.runId)!), note: 'fixture approval' }))
  await done(gated.runId)
  await new Promise((resolve) => setTimeout(resolve, 200))
  await asOperator(() => wf.supersede(gated.runId, 'context:1', { text: 'Corrected context', note: 'fixture re-plan' }))
  await settle(() => wf.get(gated.runId)?.blocked !== undefined)
  await asOperator(() => wf.approve(gated.runId, { verdict: 'approved', plan: planOf(wf.get(gated.runId)!) }))
  runs.push(await done(gated.runId))
  // A team brainstorm on two provider families, and a run that fails on a rejected result.
  runs.push(await done(wf.start({ template: 'brainstorm', input: 'Is the bridge safe?' }).runId))
  runs.push(await done(wf.start({ template: 'fixture-strict', input: 'reject me' }).runId))
  const sessions = [...new Set(runs.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))]
  return { runs, sessions }
}

/** The store as SQL text: schema, then rows in rowid order. */
export function dumpSql(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const quote = (value: unknown): string => {
      if (value === null || value === undefined) return 'NULL'
      if (typeof value === 'number' || typeof value === 'bigint') return String(value)
      if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`
      return `'${String(value).replace(/'/g, "''")}'`
    }
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'index', name").all() as Array<{ type: string; name: string; sql: string }>
    const lines = ['PRAGMA foreign_keys = OFF;', 'BEGIN;']
    for (const object of objects) lines.push(`${object.sql};`)
    for (const { name } of objects.filter((o) => o.type === 'table')) {
      for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Array<Record<string, unknown>>) {
        lines.push(`INSERT INTO "${name}" (${Object.keys(row).map((c) => `"${c}"`).join(', ')}) VALUES (${Object.values(row).map(quote).join(', ')});`)
      }
    }
    lines.push('COMMIT;')
    return `${lines.join('\n')}\n`
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const label = process.argv[2]
  if (!label || !/^[a-z0-9][a-z0-9.-]{0,40}$/.test(label)) throw new Error('usage: gen-upgrade-fixture <label> (lowercase letters, digits, dots, hyphens)')
  const dir = mkdtempSync(join(tmpdir(), 'system-upgrade-fixture-'))
  const [planner, synthesis] = TEST_TEMPLATES.investigate!
  const templates = {
    investigate: TEST_TEMPLATES.investigate!,
    'fixture-gated': [
      { nodeId: 'context:1', objective: 'Gather context', prompt: 'context for: {{input}}', capabilities: ['reason'], tier: 'economy' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer' },
      { ...planner!, dependsOn: ['context:1'], prompt: `${planner!.prompt}\n\nContext: {{node:context:1}}`, grows: { maxNodes: 2, approvalRequired: ['reason'] } },
      synthesis!,
    ],
    'fixture-strict': [{ nodeId: 'ask:1', objective: 'Answer', prompt: '{{input}}', capabilities: ['reason'], tier: 'economy' as const, conversation: 'temporary' as const, acceptance: 'acceptance.cited', maxEscalations: 0 }],
  }
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
  ]
  try {
    await Promise.all(fibers)
    // The engine once the services it injects are up, as the profile's composition order has it.
    fibers.push(ctx.plugin(Workflow, { templates, retryDelayMs: 100 }))
    await fibers.at(-1)
    chatSource(ctx)
    const { runs, sessions } = await seed(ctx)
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    const out = join(FIXTURES, label)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'system.sql'), dumpSql(join(dir, 'system.db')))
    const source = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const manifest: Manifest = { label, source, createdAt: new Date().toISOString(), runs: runs.map((r) => ({ runId: r.runId, template: r.template, status: r.status, nodes: r.nodes.length })), sessions }
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`wrote ${out}: ${runs.length} runs (${runs.map((r) => `${r.template} ${r.status}`).join(', ')})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
