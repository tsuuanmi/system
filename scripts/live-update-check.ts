/**
 * The upgrade checks of `scripts/live-update.sh`, against a running profile
 * (docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release). Node runs
 * it as it is (types stripped); it needs no install of its own.
 *
 *   node scripts/live-update-check.ts capture <cli> <DSH_HOME> <before.json>
 *   node scripts/live-update-check.ts verify <cli> <DSH_HOME> <before.json> <snapshot dir> [--new-workers <prefix,…>] [--settle <seconds>]
 *
 * `<cli>` is the installed CLI module, `packages/cli/lib/index.js` of the checkout the profile runs:
 * every call goes through its `callTool`, as the operator. `capture`, before the update, records the
 * profile's health, every run's `explain` and `result`, and the store's migration versions (the store
 * opened read-only); a profile already down is no baseline, and it refuses it (`baselineProblems`).
 * `verify`, after the update, holds the updated profile to the upgrade suite's
 * expectations (packages/cli/tests/upgrade/upgrade.e2e.ts): every old run still explains and answers
 * as it did (a run still running at the capture may have moved on; one that retention expired says
 * so in the event log), no migration went backwards, and every record of the post-update snapshot
 * (`system backup`) validates against its schema; and to the health it had (`healthProblems`). It
 * prints each problem and exits 1 when there is one, 2 when it cannot run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface HealthCheck { name: string; state: 'ok' | 'degraded' | 'down'; detail?: string }
export interface Health { state: 'ok' | 'degraded' | 'down'; checks: HealthCheck[] }

/** A run as the profile answered for it: its `explain` (template, status, steps) and its `result` status. */
export interface RunAnswer {
  runId: string
  explained: boolean
  error?: string
  template?: string
  status?: string
  nodes?: number
  result?: string | null
}

export interface Capture { capturedAt: string; health: Health; migrations: Record<string, number>; runs: RunAnswer[] }

interface ToolOutcome { isError: boolean; text: string; structured: Record<string, unknown> | undefined }
type CallTool = (name: string, args: Record<string, unknown>, home: string) => Promise<ToolOutcome>

/** The Workers a `workers` check names as unable to take work, with their state. */
function waiting(check: HealthCheck | undefined): Map<string, string> {
  if (!check || check.state === 'ok') return new Map()
  return new Map([...String(check.detail ?? '').matchAll(/(\S+) \(([a-z-]+)\)/g)].map((m) => [m[1]!, m[2]!]))
}

const RANK: Record<Health['state'], number> = { ok: 0, degraded: 1, down: 2 }

/**
 * Why a profile's health is no baseline to judge an update by: a check down, but `workers`, which
 * is judged Worker by Worker.
 */
export function baselineProblems(health: Health): string[] {
  return health.checks.filter((check) => check.name !== 'workers' && check.state === 'down').map((check) => `health check ${check.name} is down: ${check.detail ?? ''}`)
}

/**
 * What is worse in `after` than in `before`: a check in a worse state (ok, degraded, down) or gone,
 * a new check that is down, a new `manifests` check that is not ok (a refused manifest), and a
 * Worker that could take work and cannot. The `workers` check is judged Worker by Worker, never by
 * its state: a Worker whose id starts with one of `newWorkers` is new in the update, and one that
 * cannot take work yet is a note, as is a check no better and no worse than before.
 */
export function healthProblems(before: Health, after: Health, newWorkers: readonly string[] = []): { problems: string[]; notes: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  const was = new Map(before.checks.map((check) => [check.name, check]))
  const now = new Map(after.checks.map((check) => [check.name, check]))
  for (const [name, check] of was) {
    if (name === 'workers') continue
    const later = now.get(name)
    if (!later) problems.push(`health check ${name} was ${check.state} and is gone`)
    else if (RANK[later.state] > RANK[check.state]) problems.push(`health check ${name} was ${check.state} and is ${later.state}: ${later.detail ?? ''}`)
    else if (later.state !== 'ok') notes.push(`health check ${name} was ${check.state} and is ${later.state}: ${later.detail ?? ''}`)
  }
  for (const [name, check] of now) {
    if (name === 'workers' || was.has(name) || check.state === 'ok') continue
    if (check.state === 'down' || name === 'manifests') problems.push(`health check ${name}, new, is ${check.state}: ${check.detail ?? ''}`)
    else notes.push(`health check ${name}, new, is ${check.state}: ${check.detail ?? ''}`)
  }
  const waitedBefore = waiting(was.get('workers'))
  for (const [worker, state] of waiting(now.get('workers'))) {
    if (waitedBefore.has(worker)) continue
    if (newWorkers.some((prefix) => worker.startsWith(prefix))) notes.push(`Worker ${worker}, new, cannot take work yet (${state}): see the runbook's section on its runtime`)
    else problems.push(`Worker ${worker} could take work before the update and cannot now (${state})`)
  }
  return { problems, notes }
}

/** What differs in a run's answers after the update. A run that was running may have finished or grown since. */
export function runProblems(before: RunAnswer, after: RunAnswer): string[] {
  if (!after.explained) return [`run ${before.runId} no longer explains: ${after.error ?? ''}`]
  const problems: string[] = []
  if (after.template !== before.template) problems.push(`run ${before.runId}: template ${after.template}, was ${before.template}`)
  if (before.status === 'running') return problems
  if (after.status !== before.status) problems.push(`run ${before.runId}: status ${after.status}, was ${before.status}`)
  if (after.nodes !== before.nodes) problems.push(`run ${before.runId}: ${after.nodes} step(s), was ${before.nodes}`)
  if (after.result !== before.result) problems.push(`run ${before.runId}: result ${after.result}, was ${before.result}`)
  return problems
}

/** The operator's `callTool` of the installed CLI. */
async function callToolOf(cli: string): Promise<CallTool> {
  const module = (await import(pathToFileURL(resolve(cli)).href)) as { callTool?: CallTool }
  if (typeof module.callTool !== 'function') throw new Error(`${cli} exports no callTool: name packages/cli/lib/index.js`)
  return module.callTool
}

/**
 * The profile's whole health. `status` lists only the checks that are not ok unless asked for every
 * one (`checks: true`, mcp-status@1.0); a profile from before that ignores the argument and lists them
 * all, so before and after an update are read alike.
 */
export async function healthOf(call: CallTool, home: string): Promise<Health> {
  const outcome = await call('status', { checks: true }, home)
  const health = outcome.structured?.['health'] as Health | undefined
  if (outcome.isError || !health) throw new Error(`status: ${outcome.text || 'no health report'}`)
  return health
}

/** Each store owner's latest migration. */
function migrations(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare('SELECT owner, MAX(version) AS version FROM system_migrations GROUP BY owner').all() as Array<{ owner: string; version: number }>
  return Object.fromEntries(rows.map((row) => [row.owner, row.version]))
}

async function answerOf(call: CallTool, home: string, runId: string): Promise<RunAnswer> {
  const explained = await call('explain', { id: runId }, home)
  if (explained.isError) return { runId, explained: false, error: explained.text.slice(0, 300) }
  const view = (explained.structured ?? {}) as { template?: string; status?: string; nodes?: unknown[] }
  const result = await call('result', { runId, waitSeconds: 0 }, home)
  const answer: RunAnswer = { runId, explained: true, nodes: (view.nodes ?? []).length, result: (result.structured?.['status'] as string | undefined) ?? null }
  if (view.template !== undefined) answer.template = view.template
  if (view.status !== undefined) answer.status = view.status
  return answer
}

export async function capture(cli: string, home: string, out: string): Promise<number> {
  const call = await callToolOf(cli)
  const health = await healthOf(call, home)
  const broken = baselineProblems(health)
  if (broken.length) {
    for (const problem of broken) console.error(`problem: ${problem}`)
    console.error('the profile is down before the update: fix it first, so the update can be judged against it')
    return 1
  }
  const db = new DatabaseSync(join(home, 'system', 'system.db'), { readOnly: true })
  let runIds: string[]
  let versions: Record<string, number>
  try {
    runIds = (db.prepare('SELECT run_id FROM workflow_runs ORDER BY created_at, run_id').all() as Array<{ run_id: string }>).map((row) => row.run_id)
    versions = migrations(db)
  } finally {
    db.close()
  }
  const runs: RunAnswer[] = []
  for (const runId of runIds) runs.push(await answerOf(call, home, runId))
  const captured: Capture = { capturedAt: new Date().toISOString(), health, migrations: versions, runs }
  writeFileSync(out, `${JSON.stringify(captured, null, 2)}\n`, { mode: 0o600 })
  const unexplained = runs.filter((run) => !run.explained).length
  console.log(`captured: health ${health.state}, ${runs.length} run(s)${unexplained ? ` (${unexplained} did not explain before the update)` : ''}, ${Object.keys(versions).length} store owner(s)`)
  return 0
}

export async function verify(cli: string, home: string, beforePath: string, snapshot: string, newWorkers: readonly string[], settleSeconds: number): Promise<number> {
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as Capture
  const call = await callToolOf(cli)
  const problems: string[] = []
  const notes: string[] = []

  // Health, given time to settle: a start reads the Workers and accounts again.
  let health = await healthOf(call, home)
  let judged = healthProblems(before.health, health, newWorkers)
  for (const until = Date.now() + settleSeconds * 1000; judged.problems.length && Date.now() < until;) {
    await sleep(10_000)
    health = await healthOf(call, home)
    judged = healthProblems(before.health, health, newWorkers)
  }
  problems.push(...judged.problems)
  notes.push(...judged.notes)

  // Every old run still explains and answers as it did.
  let same = 0
  for (const run of before.runs) {
    if (!run.explained) {
      notes.push(`run ${run.runId} did not explain before the update either`)
      continue
    }
    const now = await answerOf(call, home, run.runId)
    if (!now.explained) {
      const expired = await call('events', { runId: run.runId, type: 'workflow.run.expired', limit: 1 }, home)
      if (!expired.isError && (expired.structured?.['events'] as unknown[] | undefined)?.length) {
        notes.push(`run ${run.runId} was expired by retention`)
        continue
      }
    }
    const differ = runProblems(run, now)
    if (differ.length) problems.push(...differ)
    else same++
  }

  // The post-update snapshot: no migration went backwards, and every record validates.
  const db = new DatabaseSync(join(snapshot, 'system.db'), { readOnly: true })
  let records = 0
  try {
    const after = migrations(db)
    for (const [owner, version] of Object.entries(before.migrations)) {
      if ((after[owner] ?? 0) < version) problems.push(`store owner ${owner} is at migration ${after[owner] ?? 0}, was ${version}`)
    }
    const libs = (await import(pathToFileURL(createRequire(resolve(cli)).resolve('@tsuuanmi/system-libs')).href)) as {
      SchemaRegistry: new () => { assert(tag: string, value: unknown): void; assertRecord(value: { schema?: unknown }): void }
    }
    const schemas = new libs.SchemaRegistry()
    let invalid = 0
    const check = (where: string, validate: () => void): void => {
      try {
        validate()
        records++
      } catch (error) {
        if (invalid++ < 50) problems.push(`${where} does not validate: ${String((error as Error).message).slice(0, 200)}`)
      }
    }
    for (const row of db.prepare('SELECT run_id, node_id, record FROM workflow_nodes').all() as Array<{ run_id: string; node_id: string; record: string }>) {
      check(`step ${row.run_id}/${row.node_id}`, () => schemas.assertRecord(JSON.parse(row.record) as { schema?: unknown }))
    }
    for (const row of db.prepare('SELECT session_id, record FROM worker_sessions').all() as Array<{ session_id: string; record: string }>) {
      check(`session ${row.session_id}`, () => schemas.assertRecord(JSON.parse(row.record) as { schema?: unknown }))
    }
    for (const row of db.prepare('SELECT id, envelope FROM artifacts').all() as Array<{ id: string; envelope: string }>) {
      check(`artifact ${row.id}`, () => {
        const envelope = JSON.parse(row.envelope) as { schema?: unknown; bodySchema: string; body: unknown }
        schemas.assertRecord(envelope)
        schemas.assert(envelope.bodySchema, envelope.body)
      })
    }
    if (invalid > 50) problems.push(`${invalid - 50} more record(s) do not validate`)
  } finally {
    db.close()
  }

  for (const note of notes) console.log(`note: ${note}`)
  for (const problem of problems) console.error(`problem: ${problem}`)
  console.log(`health ${health.state}; ${same} of ${before.runs.length} old run(s) explain and answer as before; ${records} record(s) validate`)
  return problems.length ? 1 : 0
}

const USAGE = `usage: node scripts/live-update-check.ts capture <cli> <DSH_HOME> <before.json>
       node scripts/live-update-check.ts verify <cli> <DSH_HOME> <before.json> <snapshot dir> [--new-workers <prefix,…>] [--settle <seconds>]`

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  const option = (name: string, fallback: string): string => {
    const at = args.indexOf(name)
    return at >= 0 && args[at + 1] !== undefined ? args.splice(at, 2)[1]! : fallback
  }
  if (command === 'capture' && args.length === 3) return capture(args[0]!, args[1]!, args[2]!)
  if (command === 'verify') {
    const newWorkers = option('--new-workers', '').split(',').filter(Boolean)
    const settle = Number(option('--settle', '120'))
    if (args.length === 4 && Number.isFinite(settle) && settle >= 0) return verify(args[0]!, args[1]!, args[2]!, args[3]!, newWorkers, settle)
  }
  console.error(USAGE)
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    console.error(`live-update-check: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
}
