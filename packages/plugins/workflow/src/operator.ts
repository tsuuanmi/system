/**
 * Operator actions on a run (REQ-WF-7): stop, continue, supersede (lineage invalidation), and
 * the verdict on a waiting plan (REQ-WF-11).
 * Each runs under the run's lease and is recorded as the operator's decision (INV-13).
 */
import type { Lease } from '@tsuuanmi/system-leases'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { decideGate } from './growth.ts'
import type { ResolvedNode } from './spec.ts'
import { LEASE_TTL_MS, type NodeRecord, type NodeRow, now, type RunRow, type RunView, type WorkflowError, WorkflowFailure } from './types.ts'

/**
 * The operator stops a run (REQ-WF-7): its advance halts, running executions are cancelled
 * through their sources, and every unfinished node fails as `stopped`, recorded as the
 * operator's decision. Nothing is resent, and finished work stays.
 */
export async function stop(e: Engine, runId: string, reason = 'stopped by the operator'): Promise<RunView> {
  const run = e.runRow(runId)
  if (!run || run.status !== 'running') throw new WorkflowFailure('invalid_input', `run ${runId} is not running`)
  e.runAborts.get(runId)?.abort()
  await e.running.get(runId)?.catch(() => undefined)
  return asOperator(e, runId, (lease) => {
    const decision = operatorDecision(e, run, 'stop', ['stop', 'keep'], reason)
    const error: WorkflowError = { kind: 'stopped', disposition: 'NONE', message: reason }
    for (const node of e.nodeRows(runId)) {
      if (node.state === 'COMPLETED' || node.state === 'FAILED') continue
      if (node.execution_id && node.source) e.ctx.workers.source(node.source)?.cancel?.(node.execution_id)
      e.writeNode(node, { state: 'FAILED', error: JSON.stringify(error) }, (r) => ({ ...r, lastDecision: decision }), lease)
    }
    e.finish(e.runRow(runId)!, 'failed', { error: JSON.stringify(error) }, lease)
  })
}

/**
 * The operator continues a failed run (REQ-WF-7): exactly one failed node (or, for a stopped
 * run, the nodes the stop failed) is reopened as a new attempt, recorded as the operator's
 * decision. A node whose work was sent may send again: that is the operator's call.
 */
export function continueRun(e: Engine, runId: string, nodeId?: string): RunView {
  const run = e.runRow(runId)
  if (!run || run.status !== 'failed') throw new WorkflowFailure('invalid_input', `run ${runId} is not failed`)
  const failed = e.nodeRows(runId).filter((n) => n.state === 'FAILED')
  const stopped = (JSON.parse(run.error ?? '{}') as WorkflowError).kind === 'stopped'
  const reopen = nodeId
    ? failed.filter((n) => n.node_id === nodeId)
    : stopped ? failed.filter((n) => (JSON.parse(n.error ?? '{}') as WorkflowError).kind === 'stopped') : failed
  if (!reopen.length) throw new WorkflowFailure('invalid_input', nodeId ? `node ${nodeId} of run ${runId} has not failed` : `run ${runId} has no failed node`)
  if (!stopped && reopen.length > 1) throw new WorkflowFailure('invalid_input', `run ${runId} has ${reopen.length} failed nodes; name the one to continue`)
  const view = asOperator(e, runId, (lease) => {
    const decision = operatorDecision(e, run, 'continue', ['continue', 'leave'], `reopen ${reopen.map((n) => n.node_id).join(', ')}`)
    for (const node of reopen) {
      const record = JSON.parse(node.record) as NodeRecord
      const spec = JSON.parse(node.spec) as ResolvedNode
      const ready = spec.executor !== 'gate' && record.inputReceipt !== undefined
      e.writeNode(node, { state: ready ? 'READY' : 'WAITING', execution_id: null, not_before: null, error: null }, (r) => {
        const next: NodeRecord = { ...r, lastDecision: decision }
        delete next.execution
        return next
      }, lease)
    }
    e.ctx.store.transaction((db) => {
      e.ctx.leases.fence(lease())
      db.prepare("UPDATE workflow_runs SET status = 'running', result = NULL, error = NULL, updated_at = ? WHERE run_id = ?").run(now(), runId)
      e.ctx.eventLog.append({ type: 'workflow.run.continued', runId, decision, data: { nodes: reopen.map((n) => n.node_id) } })
    })
  })
  e.schedule(runId)
  return view
}

/**
 * Lineage invalidation (docs/design/artifacts.md#lineage-and-invalidation): the operator
 * replaces a completed node's result. The replacement supersedes the old artifact and is
 * checked against the node's contract; every node downstream, directly or transitively, is
 * fenced and re-runs, its `recovery` decision pointing at both artifacts. New inputs mean new
 * input hashes, so nothing stale is reused.
 */
export function supersede(e: Engine, runId: string, nodeId: string, replacement: { text: string; note?: string }): RunView {
  const run = e.runRow(runId)
  if (!run || run.status === 'running') throw new WorkflowFailure('invalid_input', `run ${runId} is ${run ? 'running; stop it or wait' : 'unknown'}`)
  if (!replacement.text.trim()) throw new WorkflowFailure('invalid_input', 'the replacement text must not be empty')
  const nodes = e.nodeRows(runId)
  const node = nodes.find((n) => n.node_id === nodeId)
  const record = node ? (JSON.parse(node.record) as NodeRecord) : undefined
  if (!node || node.state !== 'COMPLETED' || !record?.outputReceipt) throw new WorkflowFailure('invalid_input', `node ${nodeId} of run ${runId} has no completed result`)
  // Everything downstream, transitively.
  const downstream = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const n of nodes) {
      const deps = (JSON.parse(n.spec) as ResolvedNode).dependsOn
      if (!downstream.has(n.node_id) && deps.some((d) => d === nodeId || downstream.has(d))) {
        downstream.add(n.node_id)
        grew = true
      }
    }
  }
  const affected = nodes.filter((n) => downstream.has(n.node_id))
  if ([node, ...affected].some((n) => { const sp = JSON.parse(n.spec) as ResolvedNode; return sp.grows || sp.executor === 'gate' })) {
    throw new WorkflowFailure('invalid_input', `superseding ${nodeId} would re-plan run ${runId}; re-planning is not supported yet`)
  }
  const spec = JSON.parse(node.spec) as ResolvedNode
  const old = e.ctx.artifacts.get(record.outputReceipt.result)!
  return asOperator(e, runId, (lease) => {
    const body = { ...(old.body as Record<string, unknown>), text: replacement.text }
    const artifact = e.ctx.artifacts.put({
      kind: old.kind, bodySchema: old.bodySchema, body, classification: old.classification,
      producer: { type: 'operator', ref: 'operator' }, inputs: [old.id], lineage: { supersedes: [old.id] }, runId, nodeId,
    })
    const result = artifact.id as ArtifactRef
    const acceptance = e.ctx.workers.accept(result, spec.acceptance, { producer: 'workflow', runId, nodeId, ...(spec.resultSchema ? { resultSchema: spec.resultSchema } : {}) })
    if (!acceptance.accepted) throw new WorkflowFailure('invalid_input', `the replacement fails ${spec.acceptance}: ${acceptance.reasons.join('; ')}`)
    const why = `${nodeId}'s result ${old.id} was superseded by ${result}${replacement.note ? `: ${replacement.note}` : ''}`
    e.ctx.store.transaction((db) => {
      e.writeNode(node, {}, (r) => ({ ...r, outputReceipt: { result, acceptance: acceptance.decision }, lastDecision: acceptance.decision }), lease)
      for (const dependent of affected) {
        const decision = e.ctx.artifacts.recordDecision({
          decisionType: 'recovery',
          question: `Does node ${dependent.node_id} of run ${runId} run again on the superseding input?`,
          inputs: [old.id, result],
          candidates: [{ option: 'rerun', selected: true, reasons: [why] }, { option: 'keep', selected: false, reasons: [] }],
          decider: { type: 'policy', id: 'workflow.lineage-invalidation', version: '1' },
          outcome: { option: 'rerun' },
          deterministic: true,
        }, { producer: { type: 'system', ref: 'workflow' }, runId, nodeId: dependent.node_id })
        e.writeNode(dependent, { state: 'WAITING', execution_id: null, not_before: null, error: null, escalations: 0 }, (r) => {
          const next: NodeRecord = { ...r, lastDecision: decision.id as ArtifactRef }
          delete next.execution
          delete next.inputReceipt
          delete next.outputReceipt
          return next
        }, lease)
      }
      e.ctx.leases.fence(lease())
      if (affected.length) {
        db.prepare("UPDATE workflow_runs SET status = 'running', result = NULL, error = NULL, updated_at = ? WHERE run_id = ?").run(now(), runId)
      } else if (run.status === 'completed') {
        // The final node itself: the run's result is the replacement.
        db.prepare('UPDATE workflow_runs SET result = ?, updated_at = ? WHERE run_id = ?').run(result, now(), runId)
      }
      e.ctx.eventLog.append({ type: 'workflow.node.superseded', runId, nodeId, data: { old: old.id, replacement: result, rerun: affected.map((n) => n.node_id) } })
    })
    if (affected.length) e.ctx.store.afterCommit(() => e.schedule(runId))
  })
}

/**
 * The operator's verdict on a run's waiting plan, through a trusted channel (MCP or CLI,
 * never model text; INV-6): an `approval` artifact bound to the exact plan (INV-5), then a
 * `gate` decision. Approved, the steps run; rejected, the run fails. `plan` names the plan the
 * operator read; without it the run must be waiting on exactly one plan, so a plan that arrived
 * later is never approved unseen.
 */
export function approve(e: Engine, runId: string, input: { verdict: 'approved' | 'rejected'; note?: string; plan?: string }): RunView {
  const run = e.runRow(runId)
  if (!run) throw new WorkflowFailure('invalid_input', `unknown run ${runId}`)
  const lease = e.ctx.leases.acquire(`run:${runId}`, LEASE_TTL_MS)
  if (!lease) throw new WorkflowFailure('overloaded', `run ${runId} is busy; retry in a moment`)
  try {
    // Read under the run's lease: nothing else decides or adds a gate meanwhile.
    const waiting = run.status === 'running' ? e.nodeRows(runId).filter((n) => n.state === 'BLOCKED') : []
    const planOf = (n: NodeRow): string => String((JSON.parse(n.spec) as ResolvedNode).plan)
    const gate = input.plan ? waiting.find((n) => planOf(n) === input.plan) : waiting.length === 1 ? waiting[0] : undefined
    if (!gate) {
      if (!input.plan && waiting.length > 1) {
        throw new WorkflowFailure('invalid_input', `${waiting.length} plans wait in run ${runId}; name the one you approve: ${waiting.map(planOf).join(', ')}`)
      }
      throw new WorkflowFailure('invalid_input', `run ${runId} is not waiting for approval${input.plan ? ` of plan ${input.plan}` : ''}`)
    }
    decideGate(e, run, gate, { verdict: input.verdict, by: 'operator', ...(input.note ? { note: input.note } : {}) }, () => lease)
  } finally {
    e.ctx.leases.release(lease)
  }
  e.schedule(runId)
  return e.get(runId)!
}

/** Run `change` under the run's lease, as an operator action; the run must not be advancing elsewhere. */
function asOperator(e: Engine, runId: string, change: (lease: () => Lease) => void): RunView {
  const lease = e.ctx.leases.acquire(`run:${runId}`, LEASE_TTL_MS)
  if (!lease) throw new WorkflowFailure('overloaded', `run ${runId} is busy in another process; retry in a moment`)
  try {
    change(() => lease)
  } finally {
    e.ctx.leases.release(lease)
  }
  return e.get(runId)!
}

function operatorDecision(e: Engine, run: RunRow, option: string, options: [string, string], reason: string): ArtifactRef {
  return e.ctx.artifacts.recordDecision({
    decisionType: 'recovery',
    question: `Does the operator ${option} run ${run.run_id}?`,
    inputs: [],
    candidates: [{ option: options[0], selected: true, reasons: [reason] }, { option: options[1], selected: false, reasons: [] }],
    decider: { type: 'operator', id: `operator.${option}`, version: '1' },
    outcome: { option },
    deterministic: false,
  }, { producer: { type: 'operator', ref: 'operator' }, runId: run.run_id }).id as ArtifactRef
}
