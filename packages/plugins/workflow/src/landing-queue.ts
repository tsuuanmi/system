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
