/**
 * Retention (docs/design/workflow-engine.md#retention): runs are deleted only by the operator;
 * what expires on its own is a finished run's private text.
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
