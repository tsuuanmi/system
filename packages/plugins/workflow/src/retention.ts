/**
 * Retention (docs/design/workflow-engine.md#retention): a finished run's private text expires
 * after `retainDays`; with `retainRunsDays` set, the finished run itself expires, and then the
 * artifacts that only it needed are collected (INV-9). An operator deletes a run at any time.
 */
import type { Engine } from './engine.ts'
import { type RunStatus, WorkflowFailure } from './types.ts'

/** A finished run's input and its rendered prompts are cleared after `retainDays`; the run stays. */
export function purge(e: Engine): void {
  if (e.stopped.signal.aborted) return
  const cutoff = new Date(Date.now() - (e.config.retainDays ?? 30) * 24 * 60 * 60_000).toISOString()
  e.ctx.store.transaction((db) => {
    db.prepare("UPDATE workflow_nodes SET prompt = NULL WHERE prompt IS NOT NULL AND run_id IN (SELECT run_id FROM workflow_runs WHERE status != 'running' AND updated_at < ?)").run(cutoff)
    db.prepare("UPDATE workflow_runs SET input = '' WHERE input != '' AND status != 'running' AND updated_at < ?").run(cutoff)
  })
  expireRuns(e)
}

/**
 * Delete finished runs older than `retainRunsDays`, as the operator's delete does, then collect
 * the artifacts nothing retained references any more. A session's latest run always stays: a
 * persistent session has no closed state, and continuing it needs one of its runs.
 */
export function expireRuns(e: Engine, now: number = Date.now()): { deleted: number } {
  const days = e.config.retainRunsDays ?? 0
  if (!days || e.stopped.signal.aborted) return { deleted: 0 }
  const cutoff = new Date(now - days * 24 * 60 * 60_000).toISOString()
  const expired = e.ctx.store.db.prepare(`SELECT run_id, template FROM workflow_runs r WHERE status != 'running' AND updated_at < ?
    AND (session_id IS NULL OR created_at < (SELECT MAX(created_at) FROM workflow_runs s WHERE s.session_id = r.session_id))`).all(cutoff) as Array<{ run_id: string; template: string }>
  for (const run of expired) {
    e.ctx.store.transaction((db) => {
      db.prepare('DELETE FROM workflow_nodes WHERE run_id = ?').run(run.run_id)
      db.prepare("DELETE FROM workflow_runs WHERE run_id = ? AND status != 'running'").run(run.run_id)
      e.ctx.eventLog.append({ type: 'workflow.run.expired', runId: run.run_id, data: { template: run.template } })
    })
  }
  if (expired.length) e.ctx.artifacts.collect(now)
  return { deleted: expired.length }
}

/**
 * Delete a finished run (REQ-WF-7): without `updatedAt` it only previews; with it, it deletes
 * when the run is unchanged since that preview. Artifacts stay.
 */
export function deleteRun(e: Engine, runId: string, updatedAt?: string): { deleted: boolean; runId: string; template: string; status: RunStatus; updatedAt: string; nodes: number } {
  const run = e.runRow(runId)
  if (!run) throw new WorkflowFailure('invalid_input', `unknown run ${runId}`)
  const preview = { runId, template: run.template, status: run.status, updatedAt: run.updated_at, nodes: e.nodeRows(runId).length }
  if (updatedAt === undefined) return { deleted: false, ...preview }
  if (run.status === 'running') throw new WorkflowFailure('invalid_input', `run ${runId} is running; stop it first`)
  if (updatedAt !== run.updated_at) throw new WorkflowFailure('invalid_input', `run ${runId} changed since the preview (now ${run.updated_at}); preview again`)
  e.ctx.store.transaction((db) => {
    db.prepare('DELETE FROM workflow_nodes WHERE run_id = ?').run(runId)
    db.prepare('DELETE FROM workflow_runs WHERE run_id = ? AND updated_at = ?').run(runId, updatedAt)
    e.ctx.eventLog.append({ type: 'workflow.run.deleted', runId, data: { template: run.template } })
  })
  return { deleted: true, ...preview }
}
