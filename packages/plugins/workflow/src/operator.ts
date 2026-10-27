/**
 * Operator actions on a run (REQ-WF-7): stop, continue, supersede (lineage invalidation), and
 * the verdict on a waiting plan (REQ-WF-11).
 * Each runs under the run's lease and is recorded as the operator's decision (INV-13).
 */
import type { Lease } from '@tsuuanmi/system-board-core'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { decideGate, grewFrom, grow } from './growth.ts'
import { queueOwns, withdrawUnheld } from './queue.ts'
import { DEFAULT_GROWTH, parsePlan, recordExecutor, type ResolvedNode } from './spec.ts'
import { isRemovedTeamStep } from './teams.ts'
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
  asOperator(e, runId, (lease) => {
    const decision = operatorDecision(e, run, 'stop', ['stop', 'keep'], reason, 'not keep: the operator asked to stop the run, which cancels its running executions')
    const error: WorkflowError = { kind: 'stopped', disposition: 'NONE', message: reason }
    for (const node of e.nodeRows(runId)) {
      if (node.state === 'COMPLETED' || node.state === 'FAILED' || node.state === 'RETIRED') continue
      if (node.execution_id && node.source) e.ctx.workers.source(node.source)?.cancel?.(node.execution_id)
      e.writeNode(node, { state: 'FAILED', error: JSON.stringify(error) }, (r) => ({ ...r, lastDecision: decision }), lease)
    }
    e.finish(e.runRow(runId)!, 'failed', { error: JSON.stringify(error) }, lease)
  })
  // A remediation request nothing waits on now is withdrawn, so a later approval opens nothing unseen.
  await withdrawUnheld(e, runId)
  return e.get(runId)!
}

/**
 * The operator continues a failed run (REQ-WF-7): exactly one failed node (or, for a stopped
 * run, the nodes the stop failed) is reopened as a new attempt, recorded as the operator's
 * decision. A node whose work was sent may send again: that is the operator's call.
 */
export function continueRun(e: Engine, runId: string, nodeId?: string): RunView {
  const run = e.runRow(runId)
  if (!run || run.status !== 'failed') throw new WorkflowFailure('invalid_input', `run ${runId} is not failed`)
  servesNoTask(e, runId, 'continued')
  const failed = e.nodeRows(runId).filter((n) => n.state === 'FAILED')
  const stopped = (JSON.parse(run.error ?? '{}') as WorkflowError).kind === 'stopped'
  const reopen = nodeId
    ? failed.filter((n) => n.node_id === nodeId)
    : stopped ? failed.filter((n) => (JSON.parse(n.error ?? '{}') as WorkflowError).kind === 'stopped') : failed
  if (!reopen.length) throw new WorkflowFailure('invalid_input', nodeId ? `node ${nodeId} of run ${runId} has not failed` : `run ${runId} has no failed node`)
  if (!stopped && reopen.length > 1) throw new WorkflowFailure('invalid_input', `run ${runId} has ${reopen.length} failed nodes; name the one to continue`)
  // A team procedure an earlier version ran (critique rounds, a lead, a synthesis) is not run any more: its record stays readable.
  if (e.nodeRows(runId).some((n) => isRemovedTeamStep(JSON.parse(n.spec) as ResolvedNode))) {
    throw new WorkflowFailure('invalid_input', `run ${runId} is a team procedure that was removed (PROP-0004); its record stays readable with explain and result, and it cannot run again`)
  }
  const view = asOperator(e, runId, (lease) => {
    const decision = operatorDecision(e, run, 'continue', ['continue', 'leave'], `reopen ${reopen.map((n) => n.node_id).join(', ')}`, `not leave: the operator asked to continue the run, and ${reopen.map((n) => n.node_id).join(', ')} failed and can run again`)
    for (const node of reopen) {
      const record = JSON.parse(node.record) as NodeRecord
      const spec = JSON.parse(node.spec) as ResolvedNode
      // A Worker step with its input bound runs again as it was; a gate, tally, or team decision is
      // promoted again, so it decides afresh (a tie blocks again, with a new deadline).
      const ready = recordExecutor(spec) === 'worker' && record.inputReceipt !== undefined
      // A remediation gate reopened asks the queue again: its old request was resolved, or is withdrawn.
      e.writeNode(node, { state: ready ? 'READY' : 'WAITING', execution_id: null, worker: null, not_before: null, error: null, excluded: null, approval_request: null, assignment: null, limit_wait_since: null }, (r) => {
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
 *
 * Re-planning (docs/design/workflow-engine.md#re-planning): what the replaced node, or a node that
 * runs again, grew (a planner's plan steps and gate, a review's remediation cycles, and what those
 * grew) is retired: it stays in the graph as `RETIRED`, recorded in a `graph-growth` decision with
 * each node's state and result, and whatever waited for it no longer does. A planner then plans
 * again, or a replaced planner's result is its new plan (validated before anything changes); new
 * growth gets new ids. The new plan supersedes the old one behind a new gate, so the old approval
 * never opens it (INV-5). Everything is read and changed under the run's lease.
 */
export async function supersede(e: Engine, runId: string, nodeId: string, replacement: { text: string; note?: string }): Promise<RunView> {
  if (!replacement.text.trim()) throw new WorkflowFailure('invalid_input', 'the replacement text must not be empty')
  // Everything that would refuse it is checked before any execution is cancelled.
  prepare(e, runId, nodeId, replacement)
  const ended = await endExecutions(e, runId, nodeId)
  let schedule = false
  const view = asOperator(e, runId, (lease) => {
    const { run, nodes, node, spec, affected, retired, rerun, old, result, acceptance } = prepare(e, runId, nodeId, replacement)
    const why = `${nodeId}'s result ${old.id} was superseded by ${result}${replacement.note ? `: ${replacement.note}` : ''}`
    schedule = !!spec.grows || rerun.length > 0
    e.ctx.store.transaction((db) => {
      e.writeNode(node, {}, (r) => ({ ...r, outputReceipt: { result, acceptance: acceptance.decision }, lastDecision: acceptance.decision }), lease)
      for (const grower of [node, ...affected]) {
        const grown = nodes.filter((n) => retired.has(n.node_id) && grewFrom(n, grower.node_id))
        if (grown.length) retireGrowth(e, run, grower.node_id, grown, [old.id, result], why, lease)
      }
      for (const dependent of rerun) {
        const stopped = ended.get(dependent.node_id)
        const decision = e.ctx.artifacts.recordDecision({
          decisionType: 'recovery',
          question: `Does node ${dependent.node_id} of run ${runId} run again on the superseding input?`,
          // An execution that had already finished keeps its result as history: it is never taken, nor resent.
          inputs: [old.id, result, ...(stopped?.result ? [stopped.result] : [])],
          candidates: [
            { option: 'rerun', selected: true, reasons: [why, ...(stopped ? [stopped.reason] : [])] },
            { option: 'keep', selected: false, reasons: [`not keep: its input derives from ${nodeId}'s result ${old.id}, which is superseded`] },
          ],
          decider: { type: 'policy', id: 'workflow.lineage-invalidation', version: '1' },
          outcome: { option: 'rerun' },
          deterministic: true,
        }, { producer: { type: 'system', ref: 'workflow' }, runId, nodeId: dependent.node_id })
        e.writeNode(e.nodeRow(runId, dependent.node_id)!, { state: 'WAITING', execution_id: null, not_before: null, error: null, escalations: 0 }, (r) => {
          const next: NodeRecord = { ...r, lastDecision: decision.id as ArtifactRef }
          delete next.execution
          delete next.inputReceipt
          delete next.outputReceipt
          return next
        }, lease)
      }
      if (spec.grows) {
        const planner = e.nodeRow(runId, nodeId)!
        const refused = grow(e, run, planner, specOf(planner), result, lease)
        if (refused) throw new WorkflowFailure('invalid_input', `the replacement plan is refused: ${refused.message}`)
      }
      e.ctx.leases.fence(lease())
      if (schedule) {
        db.prepare("UPDATE workflow_runs SET status = 'running', result = NULL, error = NULL, updated_at = ? WHERE run_id = ?").run(now(), runId)
      } else if (run.status === 'completed') {
        // The final node itself: the run's result is the replacement.
        db.prepare('UPDATE workflow_runs SET result = ?, updated_at = ? WHERE run_id = ?').run(result, now(), runId)
      }
      e.ctx.eventLog.append({ type: 'workflow.node.superseded', runId, nodeId, data: { old: old.id, replacement: result, rerun: rerun.map((n) => n.node_id), retired: [...retired] } })
    })
  })
  // Once the run's lease is free again, so the run advances at once.
  if (schedule) e.schedule(runId)
  return schedule ? e.get(runId)! : view
}

const specOf = (n: NodeRow): ResolvedNode => JSON.parse(n.spec) as ResolvedNode

/**
 * Check a supersede and store its replacement (idempotent: the same content keeps its id): the
 * run is not running, the node has a completed result an operator may replace, and the
 * replacement passes the node's contract (a planner's, as a valid plan).
 */
function prepare(e: Engine, runId: string, nodeId: string, replacement: { text: string; note?: string }) {
  const run = e.runRow(runId)
  if (!run || run.status === 'running') throw new WorkflowFailure('invalid_input', `run ${runId} is ${run ? 'running; stop it or wait' : 'unknown'}`)
  const nodes = e.nodeRows(runId).filter((n) => n.state !== 'RETIRED')
  const node = nodes.find((n) => n.node_id === nodeId)
  const record = node ? (JSON.parse(node.record) as NodeRecord) : undefined
  if (!node || node.state !== 'COMPLETED' || !record?.outputReceipt) throw new WorkflowFailure('invalid_input', `node ${nodeId} of run ${runId} has no completed result`)
  servesNoTask(e, runId, 'superseded')
  const spec = specOf(node)
  if (spec.executor === 'gate') throw new WorkflowFailure('invalid_input', `node ${nodeId} is a plan's gate: approve or reject the plan instead`)
  if (spec.executor === 'tally' || spec.executor === 'decide') {
    throw new WorkflowFailure('invalid_input', `node ${nodeId} is a team's ${spec.executor === 'tally' ? 'tally' : 'decision'}, which the engine computes: supersede a member's step, or break a tie with vote`)
  }
  if (nodes.some((n) => isRemovedTeamStep(specOf(n)))) {
    throw new WorkflowFailure('invalid_input', `run ${runId} is a team procedure that was removed (PROP-0004); its record stays readable with explain and result, and it cannot run again`)
  }
  const { affected, retired, rerun } = scopeOf(nodes, nodeId)
  if (spec.grows) {
    // A replaced planner's result is its new plan: an invalid one changes nothing.
    const parsed = parsePlan(replacement.text, nodeId, { ...DEFAULT_GROWTH, ...spec.grows })
    if (!parsed.ok) throw new WorkflowFailure('invalid_input', `the replacement plan is refused: ${parsed.reason}`)
  }
  const old = e.ctx.artifacts.get(record.outputReceipt.result)!
  const body = { ...(old.body as Record<string, unknown>), text: replacement.text }
  const artifact = e.ctx.artifacts.put({
    kind: old.kind, bodySchema: old.bodySchema, body, classification: old.classification,
    producer: { type: 'operator', ref: 'operator' }, inputs: [old.id], lineage: { supersedes: [old.id] }, runId, nodeId,
  })
  const result = artifact.id as ArtifactRef
  const acceptance = e.ctx.workers.accept(result, spec.acceptance, { producer: 'workflow', runId, nodeId, ...(spec.resultSchema ? { resultSchema: spec.resultSchema } : {}) })
  if (!acceptance.accepted) throw new WorkflowFailure('invalid_input', `the replacement fails ${spec.acceptance}: ${acceptance.reasons.join('; ')}`)
  return { run, nodes, node, spec, affected, retired, rerun, old, result, acceptance }
}


/** What superseding `nodeId` touches: every node downstream, transitively, and what they or it grew (retired, never run again). */
function scopeOf(nodes: NodeRow[], nodeId: string): { affected: NodeRow[]; retired: Set<string>; rerun: NodeRow[] } {
  const downstream = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const n of nodes) {
      if (!downstream.has(n.node_id) && specOf(n).dependsOn.some((d) => d === nodeId || downstream.has(d))) {
        downstream.add(n.node_id)
        grew = true
      }
    }
  }
  const affected = nodes.filter((n) => downstream.has(n.node_id))
  // What is retired: everything the replaced node or a node that runs again grew, transitively.
  const growers = new Set([nodeId, ...downstream])
  const retired = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const n of nodes) {
      if (retired.has(n.node_id) || n.node_id === nodeId) continue
      if ([...growers, ...retired].some((g) => grewFrom(n, g))) {
        retired.add(n.node_id)
        grew = true
      }
    }
  }
  return { affected, retired, rerun: affected.filter((n) => !retired.has(n.node_id)) }
}

/** How long a supersede waits for the executions it cancels to end before it refuses. */
const CANCEL_WAIT_MS = 30_000

/**
 * Before anything is reset, the executions of the nodes a supersede runs again or retires are
 * cancelled through their sources, as `stop` does, and have ended: a run left with a `RUNNING`
 * node (it failed beside it, then the host restarted) never gets a new attempt beside the
 * orphaned one (INV-4). One that had already finished keeps its result as history. One that does
 * not end within the bound, or whose source is not loaded, refuses the supersede: nothing is reset.
 */
async function endExecutions(e: Engine, runId: string, nodeId: string): Promise<Map<string, { reason: string; result?: ArtifactRef }>> {
  const nodes = e.nodeRows(runId).filter((n) => n.state !== 'RETIRED')
  const { retired, rerun } = scopeOf(nodes, nodeId)
  const live = [...rerun, ...nodes.filter((n) => retired.has(n.node_id))]
    .filter((n) => n.execution_id && n.state !== 'COMPLETED' && n.state !== 'FAILED')
  const ended = new Map<string, { reason: string; result?: ArtifactRef }>()
  for (const node of live) {
    const id = node.execution_id!
    const source = node.source ? e.ctx.workers.source(node.source) : undefined
    if (!source?.cancel) throw new WorkflowFailure('invalid_input', `node ${node.node_id}'s execution ${id} runs on ${node.source ?? 'no source'}, which cannot cancel it now (its row is off?); nothing was superseded`)
    const active = source.get(id)
    const cancelled = !!active && (active.status === 'queued' || active.status === 'running') && source.cancel(id)
    const deadline = Date.now() + CANCEL_WAIT_MS
    let current = source.get(id)
    while (current && (current.status === 'queued' || current.status === 'running') && Date.now() < deadline) {
      await source.wait(id, Math.max(1, Math.min(5000, deadline - Date.now())))
      current = source.get(id)
    }
    if (current && (current.status === 'queued' || current.status === 'running')) {
      throw new WorkflowFailure('overloaded', `node ${node.node_id}'s execution ${id} was cancelled but has not ended in ${CANCEL_WAIT_MS / 1000} s; supersede again in a moment (nothing was superseded)`)
    }
    // Answered before the cancel landed: that answer is history too.
    ended.set(node.node_id, current?.status === 'completed' && current.result
      ? { reason: `its execution ${id} had already finished; its result ${current.result} is history, never taken or resent`, result: current.result }
      : cancelled
        ? { reason: `its execution ${id} was cancelled first, so it never runs beside the new attempt (work already sent is not undone)` }
        : { reason: `its execution ${id} had already ended (${current?.error?.kind ?? current?.status ?? 'gone'}); nothing of it is taken or resent` })
  }
  return ended
}

/**
 * Retire what `grower` grew (re-planning): each node becomes `RETIRED`, kept as history, with a
 * `graph-growth` decision recording its state and result; whatever waited for it no longer does;
 * the grower's next growth is a new generation. A retired plan step that needed approval and had
 * started (it may have written) makes the planner's next plan the operator's to approve.
 */
function retireGrowth(e: Engine, run: RunRow, grower: string, grown: NodeRow[], inputs: ArtifactRef[], why: string, lease: () => Lease): void {
  const growerSpec = specOf(e.nodeRow(run.run_id, grower)!)
  const approvalRequired = growerSpec.grows ? { ...DEFAULT_GROWTH, ...growerSpec.grows }.approvalRequired : []
  const listed = grown.map((n) => {
    const result = (JSON.parse(n.record) as NodeRecord).outputReceipt?.result
    return { nodeId: n.node_id, state: n.state, ...(result ? { result } : {}) }
  })
  const started = (n: NodeRow): boolean => n.attempt > 0 || n.execution_id !== null || (JSON.parse(n.record) as NodeRecord).execution !== undefined
  const wrote = grown.filter((n) => specOf(n).executor !== 'gate' && started(n) && specOf(n).capabilities.some((c) => approvalRequired.includes(c))).map((n) => n.node_id)
  const plans = grown.map((n) => specOf(n)).filter((sp) => sp.executor === 'gate' && sp.plan).map((sp) => sp.plan as ArtifactRef)
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'graph-growth',
    question: `Does run ${run.run_id} retire what ${grower} grew, to grow it again?`,
    inputs: [...new Set([...inputs, ...plans])],
    candidates: [
      { option: 'retire', selected: true, reasons: [`${why}; ${grower} runs again`, ...(wrote.length ? [`${wrote.join(', ')} had started: the next plan needs the operator's approval`] : [])] },
      { option: 'keep', selected: false, reasons: [`not keep: ${grower} runs again, so what it grew from its superseded input is stale`] },
    ],
    decider: { type: 'policy', id: 'workflow.re-plan', version: '1' },
    outcome: { option: 'retire', detail: { retired: listed, wrote } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: grower }).id as ArtifactRef
  const gone = new Set(grown.map((n) => n.node_id))
  e.ctx.store.transaction((db) => {
    for (const n of grown) {
      e.writeNode(e.nodeRow(run.run_id, n.node_id)!, { state: 'RETIRED' }, (r) => ({ ...r, schema: r.execution?.brief ? 'workflow-node@1.2' : 'workflow-node@1.1', lastDecision: decision }), lease)
    }
    for (const dependent of e.nodeRows(run.run_id)) {
      const dspec = specOf(dependent)
      if (dependent.state === 'RETIRED' || !dspec.dependsOn.some((d) => gone.has(d))) continue
      const dependsOn = dspec.dependsOn.filter((d) => !gone.has(d))
      const drecord = JSON.parse(dependent.record) as NodeRecord
      db.prepare('UPDATE workflow_nodes SET spec = ?, record = ?, updated_at = ? WHERE run_id = ? AND node_id = ?')
        .run(JSON.stringify({ ...dspec, dependsOn }), JSON.stringify({ ...drecord, dependsOn, revision: drecord.revision + 1 }), now(), run.run_id, dependent.node_id)
    }
    // Re-read: an earlier retirement in this re-plan may have rewired the grower.
    const current = specOf(e.nodeRow(run.run_id, grower)!)
    db.prepare('UPDATE workflow_nodes SET spec = ?, updated_at = ? WHERE run_id = ? AND node_id = ?')
      .run(JSON.stringify({ ...current, generation: (current.generation ?? 1) + 1, ...(wrote.length ? { operatorApproval: true } : {}) }), now(), run.run_id, grower)
    e.ctx.eventLog.append({ type: 'workflow.graph.retired', runId: run.run_id, nodeId: grower, decision, data: { retired: [...gone], wrote } })
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
    // A tie is BLOCKED too, but waits on a `vote`, not on an approval.
    const waiting = run.status === 'running' ? e.nodeRows(runId).filter((n) => n.state === 'BLOCKED' && (JSON.parse(n.spec) as ResolvedNode).executor === 'gate') : []
    const planOf = (n: NodeRow): string => String((JSON.parse(n.spec) as ResolvedNode).plan)
    const gate = input.plan ? waiting.find((n) => planOf(n) === input.plan) : waiting.length === 1 ? waiting[0] : undefined
    if (!gate) {
      if (!input.plan && waiting.length > 1) {
        throw new WorkflowFailure('invalid_input', `${waiting.length} plans wait in run ${runId}; name the one you approve: ${waiting.map(planOf).join(', ')}`)
      }
      throw new WorkflowFailure('invalid_input', `run ${runId} is not waiting for approval${input.plan ? ` of plan ${input.plan}` : ''}`)
    }
    // A remediation fix's plan on the approval queue is decided there, never here (one channel per verdict).
    const queued = queueOwns(e, gate)
    if (queued) throw new WorkflowFailure('invalid_input', queued)
    // A re-plan replaced the plan the operator may have read: the verdict must name the new one.
    const replaced = e.ctx.artifacts.get(planOf(gate))?.lineage.supersedes ?? []
    if (!input.plan && replaced.length) {
      throw new WorkflowFailure('invalid_input', `plan ${planOf(gate)} of run ${runId} replaces plan ${replaced.join(', ')}; name the plan you approve`)
    }
    decideGate(e, run, gate, { verdict: input.verdict, by: 'operator', ...(input.note ? { note: input.note } : {}) }, () => lease)
  } finally {
    e.ctx.leases.release(lease)
  }
  e.schedule(runId)
  return e.get(runId)!
}

/**
 * A run that served an attempt of a board task is that attempt: its outcome went to the board,
 * which decides the next attempt, run as a new run. Running it again, or changing its result,
 * would be a second writer of one attempt (INV-15).
 */
function servesNoTask(e: Engine, runId: string, as: 'continued' | 'superseded'): void {
  const task = e.tasks.row(runId)
  if (task) throw new WorkflowFailure('invalid_input', `run ${runId} served an attempt of board task ${task.task_id}, so it is not ${as}: the board decides the next attempt, which runs as a new run (run with the task)`)
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

/** `reason` says why the operator chose `option`; `against`, why the other option lost. */
function operatorDecision(e: Engine, run: RunRow, option: string, options: [string, string], reason: string, against: string): ArtifactRef {
  return e.ctx.artifacts.recordDecision({
    decisionType: 'recovery',
    question: `Does the operator ${option} run ${run.run_id}?`,
    inputs: [],
    candidates: [{ option: options[0], selected: true, reasons: [reason] }, { option: options[1], selected: false, reasons: [against] }],
    decider: { type: 'operator', id: `operator.${option}`, version: '1' },
    outcome: { option },
    deterministic: false,
  }, { producer: { type: 'operator', ref: 'operator' }, runId: run.run_id }).id as ArtifactRef
}
