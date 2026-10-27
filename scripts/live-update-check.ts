/**
 * The upgrade checks of `scripts/live-update.sh`, against a running profile
 * (docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release). Node runs
 * it as it is (types stripped); it needs no install of its own.
 *
 *   node scripts/live-update-check.ts capture <cli> <DSH_HOME> <before.json>
 *   node scripts/live-update-check.ts verify <cli> <DSH_HOME> <before.json> <snapshot dir> [--new-workers <prefix,…>] [--settle <seconds>] [--workers-wait <seconds>]
 *   node scripts/live-update-check.ts running <cli> <DSH_HOME>
 *   node scripts/live-update-check.ts await-idle <cli> <DSH_HOME> --wait <seconds> [--every <seconds>] [--cut-running [--cut-file <path>]]
 *   node scripts/live-update-check.ts stop-cut <cli> <DSH_HOME> --deadline <seconds>
 *   node scripts/live-update-check.ts cut-report <cli> <DSH_HOME> <cut file>
 *   node scripts/live-update-check.ts dispatch-pause <cli> <DSH_HOME> <reason>
 *   node scripts/live-update-check.ts dispatch-resume <cli> <DSH_HOME>
 *   node scripts/live-update-check.ts live-update-record <cli> <DSH_HOME> <done|failed> <from> <to> [<reason>]
 *   node scripts/live-update-check.ts hold-steps <cli> <DSH_HOME> <reason>
 *   node scripts/live-update-check.ts release-steps <cli> <DSH_HOME>
 *
 * Before the stop (T234), `dispatch-pause` pauses dispatch unless it is paused or off already,
 * `hold-steps` holds steps (T257: each running run finishes the step it is in and starts no next one,
 * so the wait ends at the next step boundary), and `await-idle` waits, bounded, until no workflow step
 * runs (every RUNNING node of every running run in
 * the store, read-only, on a Worker or not; the roster's `work` adds what it knows, and its bounds are
 * noted), saying what it waits for: each run, its step, the Worker, and for how long; `running` is one such
 * read, for the dry run; `dispatch-resume` lifts the update's own pause once the profile runs again, and
 * `release-steps` the hold when the update stops before the stop (the restart ends it otherwise);
 * `live-update-record` records how the update ended (MCP `live_update_record`, the event
 * `host.live-update` each project's lead inbox tells as `live-update.done` or `live-update.failed`).
 * When the update cuts (T269, its default), `await-idle --cut-file` writes the steps the stop is
 * about to cut, `stop-cut` stops the daemon with the CLI's `shutdownHost` and a short drain (60 s
 * by default, instead of the unit's 600 s), and `cut-report`, after the restart, says how each cut
 * step resumed (a free retry, its session resumed) and which cut checks ran again.
 *
 * `<cli>` is the installed CLI module, `packages/cli/lib/index.js` of the checkout the profile runs:
 * every call goes through its `callTool`, as the operator. `capture`, before the update, records the
 * profile's health, every run's `explain` and `result`, the store's migration versions (the store
 * opened read-only), and each Worker's availability from its roster (`system roster --json`); a
 * profile already down is no baseline, and it refuses it (`baselineProblems`). `verify`, after the
 * update, first waits, up to `--workers-wait` seconds (600 by default: two probe TTLs), until every
 * Worker that took work before takes work again, and prints the Workers before and after; one that
 * stays unavailable is a problem with its reason (`workerProblems`, T219: on 2026-10-26 an update
 * passed every check while all four Codex Workers were unavailable). It then holds the updated profile to the upgrade suite's
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

/**
 * One Worker's availability as the roster gives it (MCP `roster`, docs/design/roster.md):
 * `ready`, `busy`, `resting`, `unavailable`, or `quarantined`, and why when it takes no work (the
 * roster's reason: its account's, else its source's `unavailableReason`, T214).
 */
export interface WorkerAvailability { worker: string; state: string; reason?: string }

/** The Workers' availability, or why the roster could not tell it. */
export type Workers = { workers: WorkerAvailability[] } | { unread: string }

/**
 * `workers` (T219): each Worker's availability at the capture; absent from a capture made before
 * the check read it.
 */
export interface Capture { capturedAt: string; health: Health; migrations: Record<string, number>; runs: RunAnswer[]; workers?: Workers }

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

/** The states in which a Worker takes work. */
const TAKES_WORK = new Set(['ready', 'busy'])

const known = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const k = value as { value?: unknown; unknown?: unknown }
  if (typeof k.value === 'string') return k.value
  if (typeof k.unknown === 'string') return `unknown (${k.unknown})`
  return undefined
}

/**
 * Each Worker's availability in a roster record (`mcp-roster@1.x`): its `availability`'s state, and
 * its reason or summary when it takes no work. A record without its Workers says why they are unread.
 */
export function workersOf(roster: unknown): Workers {
  const listed = (roster as { workers?: unknown } | undefined)?.workers as { value?: unknown; unknown?: unknown } | undefined
  if (!listed || typeof listed !== 'object') return { unread: 'the roster gave no Workers' }
  if (!Array.isArray(listed.value)) return { unread: `the roster's Workers are unknown: ${typeof listed.unknown === 'string' ? listed.unknown : 'no reason given'}` }
  const workers: WorkerAvailability[] = []
  for (const entry of listed.value as Array<{ worker?: unknown; availability?: { state?: unknown; summary?: unknown; reason?: unknown } }>) {
    if (typeof entry?.worker !== 'string') continue
    const state = typeof entry.availability?.state === 'string' ? entry.availability.state : 'unknown'
    const reason = TAKES_WORK.has(state) ? undefined
      : known(entry.availability?.reason) ?? (typeof entry.availability?.summary === 'string' ? entry.availability.summary : undefined)
    workers.push({ worker: entry.worker, state, ...(reason ? { reason } : {}) })
  }
  return { workers: workers.sort((a, b) => (a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : 0)) }
}

/** The profile's Workers, read from its roster (`system roster --json`); a refused or failed read says why. */
export async function workersNow(call: CallTool, home: string): Promise<Workers> {
  try {
    const outcome = await call('roster', {}, home)
    if (outcome.isError || !outcome.structured) return { unread: `roster: ${outcome.text.slice(0, 300) || 'no roster record'}` }
    return workersOf(outcome.structured)
  } catch (error) {
    return { unread: `roster: ${(error as Error).message.split('\n')[0]}` }
  }
}

/**
 * What the update did to the Workers: each one that took work before it (`ready` or `busy`) must
 * take work again. One that is `unavailable` or `quarantined` now, or no longer listed, is a problem
 * with its reason; one `resting` at a usage limit is a note (a limit is no update's doing). Workers
 * that took no work before, and Workers new in the update, are not held to it. `waiting` names the
 * Workers that do not take work again yet.
 */
export function workerProblems(before: Workers | undefined, after: Workers): { problems: string[]; notes: string[]; waiting: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  const waiting: string[] = []
  if (!before) return { problems, notes: ['the capture holds no Workers (made before the check read them): their availability is not compared'], waiting }
  if ('unread' in before) return { problems, notes: [`the Workers were not read before the update (${before.unread}): their availability is not compared`], waiting }
  const ready = before.workers.filter((w) => TAKES_WORK.has(w.state))
  if ('unread' in after) {
    if (ready.length) {
      problems.push(`the Workers cannot be read after the update (${after.unread}): ${ready.length} took work before it`)
      waiting.push(...ready.map((w) => w.worker))
    }
    return { problems, notes, waiting }
  }
  const now = new Map(after.workers.map((w) => [w.worker, w]))
  for (const was of ready) {
    const is = now.get(was.worker)
    if (!is) {
      problems.push(`Worker ${was.worker} was ${was.state} before the update and is not listed now (its source does not describe it)`)
      waiting.push(was.worker)
    } else if (is.state === 'resting') {
      notes.push(`Worker ${was.worker} was ${was.state} before the update and is resting at a limit now: ${is.reason ?? 'no reason given'}`)
    } else if (!TAKES_WORK.has(is.state)) {
      problems.push(`Worker ${was.worker} was ${was.state} before the update and is ${is.state} now: ${is.reason ?? 'no reason given'}`)
      waiting.push(was.worker)
    }
  }
  return { problems, notes, waiting }
}

/**
 * Read the Workers until every one that took work before the update takes work again, or `waitMs`
 * has passed (bounded: two probe TTLs by default, so a runtime's first probe after the start, and one
 * more, have had their time). Returns the last read and what it judged.
 */
export async function awaitWorkers(read: () => Promise<Workers>, before: Workers | undefined, options: { waitMs: number; everyMs: number; sleep?: (ms: number) => Promise<unknown>; now?: () => number }): Promise<{ after: Workers; problems: string[]; notes: string[] }> {
  const wait = options.sleep ?? sleep
  const clock = options.now ?? Date.now
  const until = clock() + options.waitMs
  for (;;) {
    const after = await read()
    const judged = workerProblems(before, after)
    if (!judged.waiting.length || clock() >= until) return { after, problems: judged.problems, notes: judged.notes }
    await wait(Math.max(0, Math.min(options.everyMs, until - clock())))
  }
}

/**
 * A workflow step running now: its run, its node, the Worker it runs on (none for a step the engine
 * runs itself, or one not routed yet), the board task its run serves, and since when.
 */
export interface RunningStep { runId: string; nodeId: string; worker?: string; template?: string; taskId?: string; since?: string }

/**
 * Every step running now, as the store holds it: each RUNNING node of each running run, with or
 * without a Worker, with no bound; or why the store could not be read.
 */
export type StoreRunning = { steps: RunningStep[] } | { unread: string }

/**
 * What runs now (T234): every running step, and how many more the roster counted and did not list;
 * `notes` say what the roster could not tell (its bounds, a Worker whose work is unknown), which the
 * store's read covers. A store that cannot be read makes the whole read unread: a fact not read is
 * never read as nothing running (INV-2).
 */
export type Running = { steps: RunningStep[]; more: number; notes: string[] } | { unread: string }

const stepOrder = (s: RunningStep): string => `${s.runId}\0${s.nodeId}`

/**
 * The running steps in the store (opened read-only): every node in state RUNNING of every run in
 * status running, the engine's own record of what runs (docs/design/workflow-engine.md), so a step
 * on no Worker and a run older than the roster's newest 500 are seen too. The board task its run
 * serves (`workflow_tasks`) and its latest start (`workflow.node.started`) are read where the store
 * has them.
 */
export function runningInStore(db: DatabaseSync): StoreRunning {
  let rows: Array<{ run_id: string; template: string | null; node_id: string; worker: string | null }>
  try {
    rows = db.prepare("SELECT r.run_id, r.template, n.node_id, n.worker FROM workflow_runs r JOIN workflow_nodes n ON n.run_id = r.run_id WHERE r.status = 'running' AND n.state = 'RUNNING' ORDER BY r.run_id, n.node_id")
      .all() as typeof rows
  } catch (error) {
    return { unread: `the store's runs: ${(error as Error).message.split('\n')[0]}` }
  }
  const optional = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch {
      return undefined
    }
  }
  const task = optional(() => db.prepare('SELECT task_id FROM workflow_tasks WHERE run_id = ?'))
  const started = optional(() => db.prepare("SELECT MAX(at) AS at FROM events WHERE type = 'workflow.node.started' AND run_id = ? AND node_id = ?"))
  return {
    steps: rows.map((row) => {
      const taskId = optional(() => (task?.get(row.run_id) as { task_id?: unknown } | undefined)?.task_id)
      const since = optional(() => (started?.get(row.run_id, row.node_id) as { at?: unknown } | undefined)?.at)
      return {
        runId: row.run_id, nodeId: row.node_id,
        ...(row.worker ? { worker: row.worker } : {}),
        ...(row.template ? { template: row.template } : {}),
        ...(typeof taskId === 'string' ? { taskId } : {}),
        ...(typeof since === 'string' ? { since } : {}),
      }
    }),
  }
}

/**
 * What runs: the store's running steps, each with what the roster (`mcp-roster@1.x`) adds about it,
 * and any step the roster lists that the store does not (both count). The roster's bounds
 * (docs/design/roster.md, "Every read and every list is bounded") are notes, never nothing running:
 * its `work.unread` (only the newest 500 runs read), its `unlisted` Workers, a Worker whose work is
 * unknown, and a roster not read; its `more` steps counted and not listed keep the wait waiting.
 */
export function runningOf(store: StoreRunning, roster: unknown): Running {
  if ('unread' in store) return { unread: store.unread }
  const notes: string[] = []
  const fromRoster = new Map<string, RunningStep>()
  let more = 0
  const rosterRead = roster as { workers?: unknown; unlisted?: unknown; unread?: unknown } | undefined
  const listed = rosterRead?.workers as { value?: unknown; unknown?: unknown } | undefined
  if (typeof rosterRead?.unread === 'string') notes.push(`the roster was not read (${rosterRead.unread}): the store's steps are named without what it adds`)
  else if (!listed || typeof listed !== 'object') notes.push('the roster gave no Workers: the store\'s steps are named without what it adds')
  else if (!Array.isArray(listed.value)) notes.push(`the roster's Workers are unknown (${typeof listed.unknown === 'string' ? listed.unknown : 'no reason given'}): the store's steps are named without what it adds`)
  else {
    const unknown: string[] = []
    const unread = new Set<string>()
    type Item = { runId?: unknown; nodeId?: unknown; template?: unknown; task?: { taskId?: unknown }; since?: { value?: unknown } }
    for (const entry of listed.value as Array<{ worker?: unknown; work?: { value?: { items?: unknown; more?: unknown; unread?: unknown }; unknown?: unknown } }>) {
      if (typeof entry?.worker !== 'string') continue
      const work = entry.work
      if (!work?.value || !Array.isArray(work.value.items)) {
        unknown.push(`${entry.worker} (${typeof work?.unknown === 'string' ? work.unknown : 'the roster lists no work for it'})`)
        continue
      }
      if (typeof work.value.unread === 'string') unread.add(work.value.unread)
      for (const item of work.value.items as Item[]) {
        if (typeof item?.runId !== 'string' || typeof item.nodeId !== 'string') continue
        fromRoster.set(stepOrder({ runId: item.runId, nodeId: item.nodeId }), {
          runId: item.runId, nodeId: item.nodeId, worker: entry.worker,
          ...(typeof item.template === 'string' ? { template: item.template } : {}),
          ...(typeof item.task?.taskId === 'string' ? { taskId: item.task.taskId } : {}),
          ...(typeof item.since?.value === 'string' ? { since: item.since.value } : {}),
        })
      }
      if (typeof work.value.more === 'number' && work.value.more > 0) more += work.value.more
    }
    for (const why of unread) notes.push(`the roster: ${why}; the store's read covers every run`)
    if (typeof rosterRead?.unlisted === 'number' && rosterRead.unlisted > 0) notes.push(`the roster did not list ${rosterRead.unlisted} Worker(s); the store's read covers their steps`)
    if (unknown.length) notes.push(`the roster does not know what runs on ${unknown.length} Worker(s): ${unknown.join(', ')}; the store's read covers their steps`)
  }
  const steps = store.steps.map((s) => {
    const r = fromRoster.get(stepOrder(s))
    fromRoster.delete(stepOrder(s))
    // The store's facts first; what it lacks (a Worker, a task, a start), the roster's.
    return r ? { ...r, ...s } : s
  })
  // A step the roster lists and the store does not (read a moment apart) still runs.
  steps.push(...fromRoster.values())
  return { steps: steps.sort((a, b) => (stepOrder(a) < stepOrder(b) ? -1 : stepOrder(a) > stepOrder(b) ? 1 : 0)), more, notes }
}

/** Nothing runs: the store was read, and neither it nor the roster names a running step. */
export function idle(running: Running): boolean {
  return 'steps' in running && !running.steps.length && !running.more
}

/** A duration in words: `40 s`, `4 min`, `1 h 31 min`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** What runs, one line each: the run, its step, the Worker, and for how long (from `now`). */
export function runningLines(running: Running, now: number): string[] {
  if ('unread' in running) return [`what runs cannot be read: ${running.unread}`]
  const lines = running.steps.map((s) => {
    const since = s.since === undefined ? Number.NaN : Date.parse(s.since)
    const elapsed = Number.isNaN(since) ? 'since when unknown' : `for ${duration(now - since)}`
    return `run ${s.runId} step ${s.nodeId} ${s.worker ? `on ${s.worker}` : 'on no Worker'}, ${elapsed}${s.taskId ? ` (task ${s.taskId}${s.template ? `, ${s.template}` : ''})` : s.template ? ` (${s.template})` : ''}`
  })
  if (running.more) lines.push(`and ${running.more} more step(s) the roster counted and did not list`)
  for (const note of running.notes) lines.push(`note: ${note}`)
  return lines
}

/**
 * The steps running now: the roster first (MCP `roster`, as the operator; a refused or failed read is
 * a note), then the store, opened read-only, as `capture` does. A store that cannot be opened is unread.
 */
export async function runningNow(call: CallTool, home: string): Promise<Running> {
  let roster: unknown
  try {
    const outcome = await call('roster', {}, home)
    roster = outcome.isError || !outcome.structured ? { unread: `roster: ${outcome.text.slice(0, 300) || 'no roster record'}` } : outcome.structured
  } catch (error) {
    roster = { unread: `roster: ${(error as Error).message.split('\n')[0]}` }
  }
  let store: StoreRunning
  try {
    const db = new DatabaseSync(join(home, 'system', 'system.db'), { readOnly: true })
    try {
      store = runningInStore(db)
    } finally {
      db.close()
    }
  } catch (error) {
    store = { unread: `the store: ${(error as Error).message.split('\n')[0]}` }
  }
  return runningOf(store, roster)
}

/**
 * Read what runs until nothing does, or `waitMs` has passed (T234: a live update waits for running
 * agent runs before it stops the unit). Reports what it waits for at its first read, whenever that
 * changes, and every `reportEveryMs` otherwise. Returns whether nothing ran at the last read, that
 * read, and how long it waited.
 */
export async function awaitIdle(read: () => Promise<Running>, options: {
  waitMs: number; everyMs: number; reportEveryMs: number; report: (lines: string[]) => void; sleep?: (ms: number) => Promise<unknown>; now?: () => number
}): Promise<{ idle: boolean; last: Running; waitedMs: number }> {
  const wait = options.sleep ?? sleep
  const clock = options.now ?? Date.now
  const start = clock()
  const until = start + options.waitMs
  let shown: string | undefined
  let shownAt = 0
  for (;;) {
    const last = await read()
    const at = clock()
    if (idle(last)) return { idle: true, last, waitedMs: at - start }
    if (at >= until) return { idle: false, last, waitedMs: at - start }
    const key = 'unread' in last ? `unread\0${last.unread}` : JSON.stringify([last.steps.map((s) => [s.runId, s.nodeId, s.worker]), last.more, last.notes])
    if (key !== shown || at - shownAt >= options.reportEveryMs) {
      options.report([`waiting for what runs, ${duration(at - start)} of at most ${duration(options.waitMs)}:`, ...runningLines(last, at).map((line) => `  ${line}`)])
      shown = key
      shownAt = at
    }
    await wait(Math.max(0, Math.min(options.everyMs, until - at)))
  }
}

/** Where dispatch stood when the update paused it: it paused it now, the operator had, it is off, or the profile has none. */
export type DispatchPauseOutcome = { outcome: 'paused' | 'already' | 'off' | 'none'; detail: string }

/**
 * Pause dispatch, entirely, unless it is paused or off already (T234): no ready task starts by
 * itself while the update waits for what runs. A profile that serves no dispatch has nothing to pause.
 */
export async function pauseDispatch(call: CallTool, home: string, reason: string): Promise<DispatchPauseOutcome> {
  const status = await call('dispatch_status', {}, home)
  if (status.isError) {
    if (/unknown tool|not found|not installed/i.test(status.text)) return { outcome: 'none', detail: `this profile serves no dispatch (${status.text.slice(0, 200)})` }
    throw new Error(`dispatch_status: ${status.text}`)
  }
  const s = (status.structured ?? {}) as { enabled?: boolean; paused?: { since?: string; reason?: string } }
  if (s.paused) return { outcome: 'already', detail: `dispatch is paused already, since ${s.paused.since ?? '?'}${s.paused.reason ? ` (${s.paused.reason})` : ''}: left as it is` }
  if (s.enabled === false) return { outcome: 'off', detail: 'dispatch is off (dispatch.enabled: false): nothing starts by itself' }
  const paused = await call('dispatch_pause', { reason }, home)
  if (paused.isError) throw new Error(`dispatch_pause: ${paused.text}`)
  return { outcome: 'paused', detail: `dispatch paused: ${reason}` }
}

/** A profile's answer when it serves no `hold_steps` (its code is older than the hold). */
const NO_HOLD = /unknown tool|not found|not installed|no tool/i

/** Whether the update holds steps: it set the hold now, or the profile serves none (its code is older than the hold). */
export type HoldOutcome = { outcome: 'held' | 'none'; detail: string }

/**
 * Hold steps (T257, MCP `hold_steps`): each running run finishes the step it is in and starts no
 * next one until the release or the restart, so the wait ends with the steps in flight. A profile
 * that serves no hold (code from before it) holds nothing: the wait then lasts until no step runs.
 */
export async function holdSteps(call: CallTool, home: string, reason: string): Promise<HoldOutcome> {
  const held = await call('hold_steps', { reason }, home)
  if (held.isError) {
    if (NO_HOLD.test(held.text)) return { outcome: 'none', detail: `this profile holds no steps (${held.text.slice(0, 200)}): the wait lasts until no step runs` }
    throw new Error(`hold_steps: ${held.text}`)
  }
  const inFlight = Array.isArray(held.structured?.['inFlight']) ? (held.structured['inFlight'] as unknown[]).length : 0
  return { outcome: 'held', detail: `steps held: each running run finishes the step it is in (${inFlight} in flight) and starts no next one until the restart` }
}

/**
 * Release the update's hold (MCP `hold_steps` with `release`): every running run goes on from its
 * recorded state. Released when its request's outcome was unknown too (an interruption during it):
 * a profile that serves no hold holds nothing, so there is nothing to release.
 */
export async function releaseSteps(call: CallTool, home: string): Promise<void> {
  const released = await call('hold_steps', { release: true }, home)
  if (released.isError && !NO_HOLD.test(released.text)) throw new Error(`hold_steps: ${released.text}`)
}

/** A Worker's availability in one cell: its state, and why when it takes no work. */
const cell = (w: WorkerAvailability | undefined): string => (!w ? '(not listed)' : w.reason ? `${w.state}: ${w.reason}` : w.state)

/**
 * The Workers before and after the update, one line each, in id order: the table the update prints.
 * Without `after`, the capture's column only.
 */
export function workersTable(before: Workers | undefined, after?: Workers): string[] {
  const unread = (side: string, w: Workers | undefined): string[] => (!w ? [`Workers ${side}: not captured`] : 'unread' in w ? [`Workers ${side}: not read (${w.unread})`] : [])
  const lines = [...unread('before the update', before), ...(after ? unread('after the update', after) : [])]
  const was = before && 'workers' in before ? new Map(before.workers.map((w) => [w.worker, w])) : undefined
  const is = after && 'workers' in after ? new Map(after.workers.map((w) => [w.worker, w])) : undefined
  const ids = [...new Set([...(was?.keys() ?? []), ...(is?.keys() ?? [])])].sort()
  if (!ids.length) return lines.length ? lines : ['Workers: none listed']
  const rows: string[][] = [['Worker', ...(was ? ['before'] : []), ...(after && is ? ['after'] : [])]]
  for (const id of ids) rows.push([id, ...(was ? [cell(was.get(id))] : []), ...(after && is ? [cell(is.get(id))] : [])])
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => (i < row.length - 1 ? row[i]!.length : 0))))
  return [...lines, ...rows.map((row) => row.map((text, i) => (i < row.length - 1 ? text.padEnd(widths[i]!) : text)).join('  ').trimEnd())]
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
  const workers = await workersNow(call, home)
  const captured: Capture = { capturedAt: new Date().toISOString(), health, migrations: versions, runs, workers }
  writeFileSync(out, `${JSON.stringify(captured, null, 2)}\n`, { mode: 0o600 })
  const unexplained = runs.filter((run) => !run.explained).length
  const ready = 'workers' in workers ? `${workers.workers.filter((w) => TAKES_WORK.has(w.state)).length} of ${workers.workers.length} Worker(s) taking work` : 'the Workers not read'
  console.log(`captured: health ${health.state}, ${runs.length} run(s)${unexplained ? ` (${unexplained} did not explain before the update)` : ''}, ${Object.keys(versions).length} store owner(s), ${ready}`)
  for (const line of workersTable(workers)) console.log(`  ${line}`)
  return 0
}

export async function verify(cli: string, home: string, beforePath: string, snapshot: string, newWorkers: readonly string[], settleSeconds: number, workersWaitSeconds: number): Promise<number> {
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as Capture
  const call = await callToolOf(cli)
  const problems: string[] = []
  const notes: string[] = []

  // The Workers, given up to the wait to take work again: a start probes each runtime anew, and a
  // Worker that took work before and stays unavailable (a probe failing on the host) fails the check.
  const workers = await awaitWorkers(() => workersNow(call, home), before.workers, { waitMs: workersWaitSeconds * 1000, everyMs: 10_000 })
  console.log('the Workers before and after the update:')
  for (const line of workersTable(before.workers, workers.after)) console.log(`  ${line}`)
  problems.push(...workers.problems)
  notes.push(...workers.notes)

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

/** What runs now, one read (the dry run's): exit 0 when nothing does, 1 when a step does or it cannot be told. */
export async function running(cli: string, home: string): Promise<number> {
  const now = await runningNow(await callToolOf(cli), home)
  if (idle(now)) {
    console.log('nothing runs now: no workflow step runs')
    for (const line of runningLines(now, Date.now())) console.log(`  ${line}`)
    return 0
  }
  console.log('running now:')
  for (const line of runningLines(now, Date.now())) console.log(`  ${line}`)
  return 1
}

/**
 * The steps an update's stop cut (T269), as `await-idle` wrote them before the stop (`--cut-file`):
 * when, and each step running then; `unread` when what ran could not be read.
 */
export interface CutSteps { cutAt: string; steps: RunningStep[]; unread?: string }

/**
 * Wait, up to `waitSeconds`, until no workflow step runs, reading the roster and the store every
 * `everySeconds` and saying what it waits for. Exit 0 when nothing runs; 1 at the bound, naming what
 * still runs (with `cut`, as what the stop is about to cut, and written to `cutFile` for the update's
 * report, T269).
 */
export async function awaitIdleCommand(cli: string, home: string, waitSeconds: number, everySeconds: number, cut: boolean, cutFile?: string): Promise<number> {
  const call = await callToolOf(cli)
  const outcome = await awaitIdle(() => runningNow(call, home), {
    waitMs: waitSeconds * 1000, everyMs: everySeconds * 1000, reportEveryMs: 300_000, report: (lines) => { for (const line of lines) console.log(line) },
  })
  // What the stop may cut, for the report after the restart: the steps running now (none when idle;
  // a run's checks, which are no step, are told by their re-run after it).
  if (cut && cutFile) {
    const cutSteps: CutSteps = {
      cutAt: new Date().toISOString(), steps: !outcome.idle && 'steps' in outcome.last ? outcome.last.steps : [], ...('unread' in outcome.last ? { unread: outcome.last.unread } : {}),
    }
    writeFileSync(cutFile, `${JSON.stringify(cutSteps, null, 2)}\n`, { mode: 0o600 })
  }
  if (outcome.idle) {
    console.log(`nothing runs: no workflow step runs${outcome.waitedMs >= 1000 ? ` (after ${duration(outcome.waitedMs)})` : ''}`)
    for (const line of runningLines(outcome.last, Date.now())) console.log(`  ${line}`)
    return 0
  }
  console.log(cut
    ? `still running after ${duration(outcome.waitedMs)}, the bound; the stop cuts each step below, and each resumes by itself after the restart`
    : `still running after ${duration(outcome.waitedMs)}, the bound:`)
  for (const line of runningLines(outcome.last, Date.now())) console.log(`  ${line}`)
  return 1
}

/** What `system shutdown` does, as the CLI module exports it: drain up to the deadline, then stop the daemon. */
type ShutdownHost = (deadlineMs: number, options: { home?: string; call?: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>; onActive?: (active: string[]) => void }) => Promise<{ drained: boolean; active: string[]; pid: number; undrained?: string }>

/**
 * The cut (T269): stop the daemon with a short drain, `deadlineSeconds`, instead of the unit's
 * ExecStop's (600 s), which waited for every step anyway. The CLI's own `shutdownHost`: no new run is
 * admitted, the drain waits up to the deadline, then the daemon is sent SIGTERM and exits. Agent
 * runs are cut at once then (their sessions and worktrees kept, marked host-stopped: a free retry,
 * ADR-0069); a website turn already sent is reconciled at the next start, never resent (INV-4). Exit
 * 0 once the daemon exited; 3 when the CLI has no `shutdownHost` (code from before it): the
 * caller then refuses the cut, never falling back to the unit's drain.
 */
export async function stopCut(cli: string, home: string, deadlineSeconds: number): Promise<number> {
  const module = (await import(pathToFileURL(resolve(cli)).href)) as { shutdownHost?: ShutdownHost; callTool?: CallTool }
  const { shutdownHost, callTool } = module
  if (typeof shutdownHost !== 'function' || typeof callTool !== 'function') {
    console.log(`${cli} has no shutdownHost: the short stop cannot be made`)
    return 3
  }
  let said = ''
  const outcome = await shutdownHost(deadlineSeconds * 1000, {
    // This home's daemon, whatever DSH_HOME this process has.
    home, call: (name, args) => callTool(name, args, home),
    onActive: (active) => {
      const now = active.join(', ')
      if (now !== said) console.log(`draining, up to ${duration(deadlineSeconds * 1000)}: ${active.length} run(s) still running: ${now}`)
      said = now
    },
  })
  console.log(outcome.undrained
    ? `not drained (${outcome.undrained}); the daemon (pid ${outcome.pid}) was stopped`
    : outcome.drained
      ? `drained; the daemon (pid ${outcome.pid}) was stopped`
      : `cut at the deadline (${duration(deadlineSeconds * 1000)}): ${outcome.active.length} run(s) still running were cut (${outcome.active.join(', ')}); the daemon (pid ${outcome.pid}) was stopped, and each resumes on the next start`)
  return 0
}

/** How one cut step resumed after the restart, as the store tells it (T269). */
export interface CutOutcome { step: RunningStep; how: 'free-retry' | 'resumed' | 'restarted' | 'counted' | 'pending' | 'unknown'; detail: string }

/** A failed node's error as one short line: its kind and message, as the engine stored them. */
function errorReason(error: string | null | undefined): string {
  if (!error) return 'no reason recorded'
  try {
    const parsed = JSON.parse(error) as { kind?: string; message?: string }
    const line = `${parsed.kind ?? 'failed'}: ${parsed.message ?? ''}`.replace(/\s+/g, ' ').trim()
    return line.length > 300 ? `${line.slice(0, 299)}…` : line
  } catch {
    return error.slice(0, 300)
  }
}

/** Whether a node's stored infrastructure mark (the engine's JSON, or a bare kind) says the host stopped it. */
function hostStopped(mark: string | null): boolean {
  if (!mark) return false
  if (mark === 'host-stopped') return true
  try {
    return (JSON.parse(mark) as { kind?: unknown }).kind === 'host-stopped'
  } catch {
    return false
  }
}

/** A check the host cut that ran again after the restart (`agent-workers.check.rerun`, T269). */
export interface CheckRerun { runId: string; check: string; subject?: string; cuts?: number; decision?: string }

/**
 * How each step the stop cut resumed (T269), read from the store (opened read-only) after the
 * restart: a free retry (its step ended host-stopped, so its run's failure spends no attempt, ADR-0069;
 * the task's next run named when there is one), resumed in place (its run went on, the step in its
 * session from its recorded state), counted (its run failed for a reason not the host's), or not
 * settled yet (it resumes by itself; `system explain` follows it). And each check the host cut that
 * ran again since the cut (`agent-workers.check.rerun`): a check is no step, so the wait never named it.
 */
export function cutOutcomes(db: DatabaseSync, cut: CutSteps): { steps: CutOutcome[]; checks: CheckRerun[] } {
  const optional = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch {
      return undefined
    }
  }
  const steps = cut.steps.map((step): CutOutcome => {
    type Node = { state: string; infrastructure: string | null; error: string | null }
    const node = optional(() => db.prepare('SELECT state, infrastructure, error FROM workflow_nodes WHERE run_id = ? AND node_id = ?').get(step.runId, step.nodeId) as Node | undefined)
      ?? optional(() => db.prepare('SELECT state, infrastructure, NULL AS error FROM workflow_nodes WHERE run_id = ? AND node_id = ?').get(step.runId, step.nodeId) as Node | undefined)
      ?? optional(() => db.prepare('SELECT state, NULL AS infrastructure, NULL AS error FROM workflow_nodes WHERE run_id = ? AND node_id = ?').get(step.runId, step.nodeId) as Node | undefined)
    const run = optional(() => db.prepare('SELECT status FROM workflow_runs WHERE run_id = ?').get(step.runId) as { status: string } | undefined)
    if (!node || !run) return { step, how: 'unknown', detail: `the store no longer holds run ${step.runId} step ${step.nodeId}` }
    const taskId = step.taskId
    const next = taskId
      ? optional(() => db.prepare('SELECT t.run_id AS runId, r.status FROM workflow_tasks t JOIN workflow_runs r ON r.run_id = t.run_id WHERE t.task_id = ? AND t.run_id != ? AND r.created_at >= ? ORDER BY r.created_at DESC LIMIT 1')
        .get(taskId, step.runId, cut.cutAt) as { runId: string; status: string } | undefined)
      : undefined
    // The step's agent run ran again by itself after the stop (T283): `agent-workers.run.resumed`, its run's own event.
    const again = optional(() => (db.prepare("SELECT entry FROM events WHERE type = 'agent-workers.run.resumed' AND run_id = ? AND at >= ? ORDER BY seq").all(step.runId, cut.cutAt) as Array<{ entry: string }>)
      .map((row) => JSON.parse(row.entry) as { nodeId?: string; data?: { how?: string; step?: string; resumes?: number } })
      .filter((entry) => entry.nodeId === step.nodeId || entry.data?.step === step.nodeId)
      .at(-1)) ?? undefined
    if (again && node.state !== 'FAILED' && run.status !== 'failed') {
      const how = again.data?.how === 'restarted' ? 'restarted' : 'resumed'
      const now = `; the step is ${node.state.toLowerCase()} (run ${run.status})`
      return {
        step, how,
        detail: how === 'resumed'
          ? `resumed: the agent run went on in its native session after the restart, no attempt spent, nothing asked of the operator${now}${again.data?.resumes ? ` (cut ${again.data.resumes} time(s))` : ''}`
          : `restarted: its runtime cannot resume, so the agent run started again from the same worktree after the restart, no attempt spent, nothing asked of the operator${now}${again.data?.resumes ? ` (cut ${again.data.resumes} time(s))` : ''}`,
      }
    }
    if (hostStopped(node.infrastructure)) {
      return {
        step, how: 'free-retry',
        detail: `free retry (T218): the step ended host-stopped, so its run's failure spends no attempt${next ? `; run ${next.runId} serves task ${step.taskId} now (${next.status})` : step.taskId ? `; task ${step.taskId} goes back for the same attempt` : ''}`,
      }
    }
    if (run.status === 'failed') return { step, how: 'counted', detail: `its run failed, not as the host's (step ${node.state})${node.error ? `: ${errorReason(node.error)}` : ''}: the attempt counts; system explain ${step.runId}` }
    if (node.state === 'COMPLETED' || run.status === 'completed') return { step, how: 'resumed', detail: `resumed: the step went on in its session from its recorded state, and is ${node.state.toLowerCase()} (run ${run.status})` }
    if (node.state === 'RUNNING') return { step, how: 'resumed', detail: `resumed: the step runs again in its session from its recorded state (run ${run.status})` }
    return { step, how: 'pending', detail: `not settled yet (step ${node.state}, run ${run.status}): it resumes by itself; system explain ${step.runId}` }
  })
  const rows = optional(() => db.prepare("SELECT run_id, entry FROM events WHERE type = 'agent-workers.check.rerun' AND at >= ? ORDER BY seq").all(cut.cutAt) as Array<{ run_id: string; entry: string }>) ?? []
  const checks = rows.map((row): CheckRerun => {
    const entry = optional(() => JSON.parse(row.entry) as { decision?: string; data?: { check?: string; subject?: string; cuts?: number } }) ?? {}
    return {
      runId: row.run_id, check: entry.data?.check ?? '?',
      ...(entry.data?.subject ? { subject: entry.data.subject } : {}), ...(typeof entry.data?.cuts === 'number' ? { cuts: entry.data.cuts } : {}), ...(entry.decision ? { decision: entry.decision } : {}),
    }
  })
  return { steps, checks }
}

/** The report's lines: each cut step and how it resumed, then each check re-run (T269). */
export function cutReportLines(cut: CutSteps, outcomes: { steps: CutOutcome[]; checks: CheckRerun[] }): string[] {
  const lines = [`cut at ${cut.cutAt}: ${cut.steps.length} step(s)${cut.unread ? ` (what ran could not be read whole: ${cut.unread})` : ''}`]
  for (const o of outcomes.steps) lines.push(`  run ${o.step.runId} step ${o.step.nodeId}${o.step.worker ? ` on ${o.step.worker}` : ''}${o.step.taskId ? ` (task ${o.step.taskId})` : ''}: ${o.detail}`)
  for (const c of outcomes.checks) lines.push(`  run ${c.runId}: its ${c.check} check, cut by the host, re-run${c.subject ? ` on ${c.subject}` : ''}${c.cuts ? ` (cut ${c.cuts} time(s))` : ''}${c.decision ? `, decision ${c.decision}` : ''}`)
  if (!outcomes.steps.length && !outcomes.checks.length) lines.push('  nothing was cut that the store tells of')
  return lines
}

/** The update's report of what its stop cut (T269): read-only, never a problem of the update. */
export function cutReport(home: string, cutFile: string): number {
  const cut = JSON.parse(readFileSync(cutFile, 'utf8')) as CutSteps
  const db = new DatabaseSync(join(home, 'system', 'system.db'), { readOnly: true })
  try {
    for (const line of cutReportLines(cut, cutOutcomes(db, cut))) console.log(line)
  } finally {
    db.close()
  }
  return 0
}

/** How long `verify` waits for the Workers to take work again by default: two of agent-workers' default `probeTtlMs` (5 min). */
export const WORKERS_WAIT_SECONDS = 600

const USAGE = `usage: node scripts/live-update-check.ts capture <cli> <DSH_HOME> <before.json>
       node scripts/live-update-check.ts verify <cli> <DSH_HOME> <before.json> <snapshot dir> [--new-workers <prefix,…>] [--settle <seconds>] [--workers-wait <seconds>]
       node scripts/live-update-check.ts running <cli> <DSH_HOME>
       node scripts/live-update-check.ts await-idle <cli> <DSH_HOME> --wait <seconds> [--every <seconds>] [--cut-running [--cut-file <path>]]
       node scripts/live-update-check.ts stop-cut <cli> <DSH_HOME> --deadline <seconds>
       node scripts/live-update-check.ts cut-report <cli> <DSH_HOME> <cut file>
       node scripts/live-update-check.ts dispatch-pause <cli> <DSH_HOME> <reason>
       node scripts/live-update-check.ts dispatch-resume <cli> <DSH_HOME>
       node scripts/live-update-check.ts live-update-record <cli> <DSH_HOME> <done|failed> <from> <to> [<reason>]
       node scripts/live-update-check.ts hold-steps <cli> <DSH_HOME> <reason>
       node scripts/live-update-check.ts release-steps <cli> <DSH_HOME>`

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  const option = (name: string, fallback: string): string => {
    const at = args.indexOf(name)
    return at >= 0 && args[at + 1] !== undefined ? args.splice(at, 2)[1]! : fallback
  }
  if (command === 'capture' && args.length === 3) return capture(args[0]!, args[1]!, args[2]!)
  if (command === 'running' && args.length === 2) return running(args[0]!, args[1]!)
  if (command === 'await-idle') {
    const cut = args.includes('--cut-running')
    if (cut) args.splice(args.indexOf('--cut-running'), 1)
    const wait = Number(option('--wait', 'none'))
    const every = Number(option('--every', '30'))
    const cutFile = option('--cut-file', '')
    if (args.length === 2 && Number.isInteger(wait) && wait >= 0 && Number.isInteger(every) && every >= 1) return awaitIdleCommand(args[0]!, args[1]!, wait, every, cut, cutFile || undefined)
  }
  if (command === 'stop-cut') {
    const deadline = Number(option('--deadline', 'none'))
    if (args.length === 2 && Number.isInteger(deadline) && deadline >= 0) return stopCut(args[0]!, args[1]!, deadline)
  }
  if (command === 'cut-report' && args.length === 3) return cutReport(args[1]!, args[2]!)
  if (command === 'dispatch-pause' && args.length === 3) {
    const paused = await pauseDispatch(await callToolOf(args[0]!), args[1]!, args[2]!)
    console.log(`${paused.outcome}: ${paused.detail}`)
    return 0
  }
  if (command === 'hold-steps' && args.length === 3) {
    const held = await holdSteps(await callToolOf(args[0]!), args[1]!, args[2]!)
    console.log(`${held.outcome}: ${held.detail}`)
    return 0
  }
  if (command === 'release-steps' && args.length === 2) {
    await releaseSteps(await callToolOf(args[0]!), args[1]!)
    console.log('steps released: each running run goes on from its recorded state')
    return 0
  }
  if (command === 'live-update-record' && (args.length === 5 || args.length === 6) && (args[2] === 'done' || args[2] === 'failed')) {
    // How the update ended, for every project's lead inbox (D107): a profile without the tool is a note, never a failure.
    const recorded = await (await callToolOf(args[0]!))('live_update_record', { outcome: args[2], from: args[3], to: args[4], ...(args[5] ? { reason: args[5] } : {}) }, args[1]!)
    if (recorded.isError) {
      console.error(`live_update_record: ${recorded.text}`)
      return 1
    }
    console.log(`recorded for the lead inbox: live update ${args[2]}`)
    return 0
  }
  if (command === 'dispatch-resume' && args.length === 2) {
    const resumed = await (await callToolOf(args[0]!))('dispatch_resume', {}, args[1]!)
    if (resumed.isError) {
      console.error(`dispatch_resume: ${resumed.text}`)
      return 1
    }
    console.log('dispatch resumed')
    return 0
  }
  if (command === 'verify') {
    const newWorkers = option('--new-workers', '').split(',').filter(Boolean)
    const settle = Number(option('--settle', '120'))
    const workersWait = Number(option('--workers-wait', String(WORKERS_WAIT_SECONDS)))
    if (args.length === 4 && Number.isFinite(settle) && settle >= 0 && Number.isFinite(workersWait) && workersWait >= 0) {
      return verify(args[0]!, args[1]!, args[2]!, args[3]!, newWorkers, settle, workersWait)
    }
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
