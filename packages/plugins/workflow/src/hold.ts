/**
 * The hold between steps (docs/design/workflow-engine.md#the-hold-between-steps, T257): while a live
 * update waits to stop the host, each running run finishes the step it is in and starts no next one.
 * The operator sets it, with its reason, and releases it; the next start of the host releases one
 * left over, so a hold never outlives the process it was set in. Its row is the `steps-hold` row of
 * `workflow_dispatch_control` (no table of its own: it is one control value, as dispatch's pause is).
 * Each change is a `gate` decision, recorded before the row changes, and an event that names it
 * (`workflow.steps.held`, `workflow.steps.released`; INV-13), as dispatch's pause is. A released run
 * goes on from its recorded state, exactly as after a restart: a step already sent is waited on,
 * never sent again.
 */
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { now } from './types.ts'

/** The hold: since when, why, and the operator's decision that set it. */
export interface StepHold { since: string; reason?: string; decision?: ArtifactRef }

/** A step running now: a RUNNING node of a running run, sent to its Worker. */
export interface StepInFlight { runId: string; nodeId: string; worker?: string }

/** The hold, if one is set, and the steps in flight, which it lets finish. */
export interface HoldView { held?: StepHold; inFlight: StepInFlight[] }

const ROW = 'steps-hold'

/** The hold set now, if any. */
export function heldNow(e: Engine): StepHold | undefined {
  const row = e.ctx.store.db.prepare('SELECT paused FROM workflow_dispatch_control WHERE id = ?').get(ROW) as { paused: string | null } | undefined
  return row?.paused ? JSON.parse(row.paused) as StepHold : undefined
}

/** The hold and every step in flight, from the engine's rows. */
export function holdView(e: Engine): HoldView {
  const held = heldNow(e)
  const rows = e.ctx.store.db.prepare(`SELECT n.run_id, n.node_id, n.worker FROM workflow_nodes n JOIN workflow_runs r ON r.run_id = n.run_id
    WHERE r.status = 'running' AND n.state = 'RUNNING' ORDER BY n.run_id, n.node_id`).all() as Array<{ run_id: string; node_id: string; worker: string | null }>
  return { ...(held ? { held } : {}), inFlight: rows.map((r) => ({ runId: r.run_id, nodeId: r.node_id, ...(r.worker ? { worker: r.worker } : {}) })) }
}

/** The operator's hold and release (INV-13: each a decision, recorded before the row changes). */
const HOLD = { type: 'operator', id: 'workflow.steps-hold', version: '1' } as const
/** The release a start makes of a hold left over: the engine's rule, not a person's. */
const RESTART = { type: 'rule', id: 'workflow.steps-hold-restart', version: '1' } as const

/**
 * Set the hold (the operator's): no run starts a next step until it is released. Holding a held
 * engine changes nothing. The `gate` decision (rule `workflow.steps-hold`) is recorded first, and the
 * row and the `workflow.steps.held` event name it (INV-13).
 */
export function hold(e: Engine, reason?: string): HoldView {
  if (heldNow(e)) return holdView(e)
  const why = reason?.trim() ? reason.trim().slice(0, 500) : undefined
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'gate', question: 'Does the operator hold steps, so each running run finishes the step it is in and starts no next one?', inputs: [],
    candidates: [
      { option: 'hold', selected: true, reasons: [`the operator held steps${why ? `: ${why}` : ''}`, 'each running run finishes its steps already sent and starts nothing new until the release or the next start of the host'] },
      { option: 'run', selected: false, reasons: ['not run: the operator held steps'] },
    ],
    decider: HOLD, outcome: { option: 'hold', detail: why ? { reason: why } : {} }, ...(why ? { rationale: why } : {}), deterministic: false,
  }, { producer: { type: 'operator', ref: 'operator' } }).id as ArtifactRef
  const held: StepHold = { since: now(), ...(why ? { reason: why } : {}), decision }
  e.ctx.store.transaction((db) => {
    db.prepare('INSERT OR IGNORE INTO workflow_dispatch_control (id, updated_at) VALUES (?, ?)').run(ROW, now())
    db.prepare('UPDATE workflow_dispatch_control SET paused = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(held), now(), ROW)
    e.ctx.eventLog.append({ type: 'workflow.steps.held', decision, data: { since: held.since, ...(why ? { reason: why } : {}) } })
  })
  return holdView(e)
}

/**
 * Release the hold: by the operator, or by the host's start (`restart`, before any run is scheduled).
 * A `gate` decision is recorded first, its input the hold's: the operator's (rule
 * `workflow.steps-hold`), or the engine's rule at a start (`workflow.steps-hold-restart`); the
 * `workflow.steps.released` event names it (INV-13). The operator's release schedules every running
 * run again, as a start does.
 */
export function release(e: Engine, by: 'operator' | 'restart'): HoldView {
  const held = heldNow(e)
  if (!held) return holdView(e)
  const why = by === 'operator' ? `the operator released steps, held since ${held.since}` : `the host started again: a hold never outlives the process it was set in (held since ${held.since})`
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'gate', question: 'Do held runs start their next steps again?', inputs: held.decision ? [held.decision] : [],
    candidates: [
      { option: 'run', selected: true, reasons: [why, 'each running run goes on from its recorded state; a step already sent is never sent again'] },
      { option: 'hold', selected: false, reasons: [by === 'operator' ? 'not hold: the operator released it' : 'not hold: the process the hold was set in has stopped'] },
    ],
    decider: by === 'operator' ? HOLD : RESTART, outcome: { option: 'run', detail: { heldSince: held.since, by } }, deterministic: by === 'restart',
  }, { producer: by === 'operator' ? { type: 'operator', ref: 'operator' } : { type: 'system', ref: 'workflow' } }).id as ArtifactRef
  e.ctx.store.transaction((db) => {
    db.prepare('UPDATE workflow_dispatch_control SET paused = NULL, updated_at = ? WHERE id = ?').run(now(), ROW)
    e.ctx.eventLog.append({ type: 'workflow.steps.released', decision, data: { heldSince: held.since, ...(held.reason ? { reason: held.reason } : {}), by } })
  })
  if (by === 'operator') {
    const runs = e.ctx.store.db.prepare("SELECT run_id FROM workflow_runs WHERE status = 'running' ORDER BY created_at").all() as Array<{ run_id: string }>
    for (const { run_id } of runs) e.schedule(run_id)
  }
  return holdView(e)
}
