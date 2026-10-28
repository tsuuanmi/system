/**
 * The landing queue (docs/design/workflow-engine.md#the-landing-queue): one per repository and target
 * branch, kept on the landings themselves (`workflow_tasks.landing.queue`), so it is durable in the
 * store and a restart reads it instead of rebuilding it (INV-4). A committed result enters it with the
 * next `seq`; one landing holds the target's `turn` at a time, and the next one is promoted only once
 * that one reached an end, so a later result never moves the target under an earlier one's landing.
 * Every read here is bounded (INV-9): the open landings of one key.
 */
import type { Engine } from './engine.ts'
import type { LandingQueueView, TaskLanding, TaskRow } from './types.ts'

/** The landing states still in progress (the sweep looks at them). */
export const OPEN = ['watch', 'commit', 'queued', 'stacked', 'rebase', 'resolving', 'returning', 'recheck', 'committed', 'asked', 'merging'] as const

/** Landings of one queue read at most (INV-9): far more than 12 runs at once. */
const QUEUE_MAX = 200

export const queueKey = (repository: string, branch: string): string => `${repository}#${branch}`

interface Entry {
  row: TaskRow
  landing: TaskLanding
}

/** The open landings of one queue, in the order they entered it. */
export function entries(e: Engine, key: string): Entry[] {
  const rows = e.ctx.store.db.prepare(`SELECT * FROM workflow_tasks WHERE json_extract(landing, '$.queue.key') = ? AND json_extract(landing, '$.state') IN (${OPEN.map(() => '?').join(', ')})
    ORDER BY json_extract(landing, '$.queue.seq') LIMIT ${QUEUE_MAX}`).all(key, ...OPEN) as unknown as TaskRow[]
  return rows.map((row) => ({ row, landing: JSON.parse(row.landing!) as TaskLanding }))
}

/** Open landings `openLandings` reads at most (INV-9). */
const OPEN_MAX = 500

/** One open landing as the lead brief reads it: its queue and the queue's target branch, the result, its state, and its place (from 1). */
export interface OpenLanding { key: string; branch: string; runId: string; taskId: string; state: TaskLanding['state']; position: number }

/**
 * Every open landing of every queue, queue by queue in the order they entered it; at most
 * {@link OPEN_MAX}, and `more` when there are more than that, so a reader never takes the read for
 * the whole of the queues (INV-2).
 */
export function openLandings(e: Engine): { landings: OpenLanding[]; more: boolean } {
  const rows = e.ctx.store.db.prepare(`SELECT run_id, task_id, landing FROM workflow_tasks WHERE json_extract(landing, '$.queue.key') IS NOT NULL AND json_extract(landing, '$.state') IN (${OPEN.map(() => '?').join(', ')})
    ORDER BY json_extract(landing, '$.queue.key'), json_extract(landing, '$.queue.seq') LIMIT ${OPEN_MAX + 1}`).all(...OPEN) as Array<{ run_id: string; task_id: string; landing: string }>
  const places = new Map<string, number>()
  const landings = rows.slice(0, OPEN_MAX).map((r) => {
    const landing = JSON.parse(r.landing) as TaskLanding
    const key = landing.queue!.key
    const position = (places.get(key) ?? 0) + 1
    places.set(key, position)
    return { key, branch: landing.base?.branch ?? key.slice(key.lastIndexOf('#') + 1), runId: r.run_id, taskId: r.task_id, state: landing.state, position }
  })
  return { landings, more: rows.length > OPEN_MAX }
}

/** The next place in a queue: after every landing it ever held, so an order is never reused. */
export function nextSeq(e: Engine, key: string): number {
  const last = e.ctx.store.db.prepare(`SELECT MAX(json_extract(landing, '$.queue.seq')) AS seq FROM workflow_tasks WHERE json_extract(landing, '$.queue.key') = ?`).get(key) as { seq: number | null } | undefined
  return (last?.seq ?? 0) + 1
}

/** The row of a run, read now (a sweep's rows are older than the moves made since). */
export function fresh(e: Engine, runId: string): Entry | undefined {
  const row = e.ctx.store.db.prepare('SELECT * FROM workflow_tasks WHERE run_id = ?').get(runId) as unknown as TaskRow | undefined
  return row?.landing ? { row, landing: JSON.parse(row.landing) as TaskLanding } : undefined
}

/** Where a landing stands in its queue, for `explain` and `/ui`; undefined when it is in none. */
export function queueView(e: Engine, row: TaskRow): LandingQueueView | undefined {
  const landing = row.landing ? JSON.parse(row.landing) as TaskLanding : undefined
  const q = landing?.queue
  if (!landing || !q) return undefined
  const open = entries(e, q.key)
  const index = open.findIndex((x) => x.row.run_id === row.run_id)
  const holder = open.find((x) => x.landing.queue?.turn && x.row.run_id !== row.run_id)
  const runs = q.batch?.runs ?? []
  return {
    key: q.key, state: landing.state, length: open.length,
    ...(index >= 0 ? { position: index + 1 } : {}),
    ...(holder && !q.turn ? { holder: { runId: holder.row.run_id, taskId: holder.row.task_id } } : {}),
    ...(q.batch ? { batch: { size: runs.length, limit: q.batch.limit, index: runs.indexOf(row.run_id) + 1 } } : {}),
  }
}
