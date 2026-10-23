/**
 * Retention (docs/design/workflow-engine.md#retention): a finished run's private text expires
 * after `retainDays`; after `retainRunsDays` (default 30), the finished run itself expires, and
 * then the artifacts that only it needed are collected and the website chats only it used are
 * deleted (INV-9). An operator deletes a run at any time.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Engine } from './engine.ts'
import { type RunStatus, WorkflowFailure } from './types.ts'

/** The Worker sessions a run's nodes used. */
const sessionsOf = (db: DatabaseSync, runId: string): string[] => (db.prepare(`SELECT DISTINCT json_extract(spec, '$.session.sessionId') AS session
  FROM workflow_nodes WHERE run_id = ? AND json_extract(spec, '$.session.sessionId') IS NOT NULL`).all(runId) as Array<{ session: string }>).map((r) => r.session)

/**
 * After a run's nodes are deleted, release the sessions no remaining run uses (a persistent
 * session continued by a later run stays): their Workers delete what they created for them
 * outside `system`, such as a website conversation (PROP-0004 Phase 5).
 */
function releaseUnused(e: Engine, db: DatabaseSync, sessions: string[], reason: string): number {
  const unused = sessions.filter((s) => !db.prepare("SELECT 1 FROM workflow_nodes WHERE json_extract(spec, '$.session.sessionId') = ? LIMIT 1").get(s))
  return unused.length ? e.ctx.workers.release(unused, reason).due : 0
}

/** A finished run's input and its rendered prompts are cleared after `retainDays`; the run stays. */
export function purge(e: Engine): void {
  if (e.stopped.signal.aborted) return
  const cutoff = new Date(Date.now() - (e.config.retainDays ?? 30) * 24 * 60 * 60_000).toISOString()
  e.ctx.store.transaction((db) => {
    db.prepare("UPDATE workflow_nodes SET prompt = NULL, brief_parts = NULL WHERE (prompt IS NOT NULL OR brief_parts IS NOT NULL) AND run_id IN (SELECT run_id FROM workflow_runs WHERE status != 'running' AND updated_at < ?)").run(cutoff)
    db.prepare("UPDATE workflow_runs SET input = '' WHERE input != '' AND status != 'running' AND updated_at < ?").run(cutoff)
  })
  expireRuns(e)
}

/**
 * Delete finished runs older than `retainRunsDays`, as the operator's delete does, then collect
 * the artifacts nothing retained references any more. A session's latest run always stays: a
 * persistent session has no closed state, and continuing it needs one of its runs.
 */
export function expireRuns(e: Engine, now: number = Date.now()): { deleted: number; conversations: number } {
  const days = e.config.retainRunsDays ?? 30
  if (!days || e.stopped.signal.aborted) return { deleted: 0, conversations: 0 }
  const cutoff = new Date(now - days * 24 * 60 * 60_000).toISOString()
  // A run whose outcome has not reached its board task yet stays until it has.
  const expired = e.ctx.store.db.prepare(`SELECT run_id, template FROM workflow_runs r WHERE status != 'running' AND updated_at < ?
    AND (session_id IS NULL OR created_at < (SELECT MAX(created_at) FROM workflow_runs s WHERE s.session_id = r.session_id))
    AND NOT EXISTS (SELECT 1 FROM workflow_tasks t WHERE t.run_id = r.run_id AND t.phase != 'reported')`).all(cutoff) as Array<{ run_id: string; template: string }>
  let conversations = 0
  for (const run of expired) {
    e.ctx.store.transaction((db) => {
      const sessions = sessionsOf(db, run.run_id)
      db.prepare('DELETE FROM workflow_nodes WHERE run_id = ?').run(run.run_id)
      db.prepare('DELETE FROM workflow_tasks WHERE run_id = ?').run(run.run_id)
      db.prepare('DELETE FROM workflow_deferrals WHERE run_id = ?').run(run.run_id)
      db.prepare("DELETE FROM workflow_runs WHERE run_id = ? AND status != 'running'").run(run.run_id)
      e.ctx.eventLog.append({ type: 'workflow.run.expired', runId: run.run_id, data: { template: run.template } })
      conversations += releaseUnused(e, db, sessions, `run ${run.run_id} expired`)
    })
  }
  // What a sweep removed, once per sweep: the first one after an upgrade may remove many runs.
  if (expired.length) {
    e.ctx.eventLog.append({ type: 'workflow.retention.swept', data: { runs: expired.length, conversations, retainRunsDays: days } })
    e.ctx.logger.info(`workflow: retention expired ${expired.length} run(s) older than ${days} day(s) and released ${conversations} website conversation(s) for deletion`)
  }
  // Collection reads the whole store in pages and yields between them: it runs on its own, and a
  // failure is logged; the next daily pass collects what this one did not.
  if (expired.length) {
    e.ctx.artifacts.collect(now).catch((error: unknown) => {
      e.ctx.logger.warn('workflow: collecting artifacts after expiring runs failed; the next daily pass retries')
      e.ctx.logger.warn(error)
    })
  }
  return { deleted: expired.length, conversations }
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
  const task = e.tasks.row(runId)
  if (task && task.phase !== 'reported') throw new WorkflowFailure('invalid_input', `run ${runId}'s outcome has not reached board task ${task.task_id} yet; delete it once it has`)
  e.ctx.store.transaction((db) => {
    const sessions = sessionsOf(db, runId)
    db.prepare('DELETE FROM workflow_nodes WHERE run_id = ?').run(runId)
    db.prepare('DELETE FROM workflow_tasks WHERE run_id = ?').run(runId)
    db.prepare('DELETE FROM workflow_deferrals WHERE run_id = ?').run(runId)
    db.prepare('DELETE FROM workflow_runs WHERE run_id = ? AND updated_at = ?').run(runId, updatedAt)
    e.ctx.eventLog.append({ type: 'workflow.run.deleted', runId, data: { template: run.template } })
    releaseUnused(e, db, sessions, `run ${runId} deleted`)
  })
  return { deleted: true, ...preview }
}
