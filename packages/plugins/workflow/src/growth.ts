/**
 * Graph growth (REQ-WF-8, REQ-WF-10) and approval gates (REQ-WF-11): a planner's plan becomes
 * steps appended after it; steps that need approval wait behind a gate bound to the exact plan
 * (INV-5), opened or closed by the operator (`approve` in `operator.ts`) or by policy.
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { canonicalJson, sha256 } from '@tsuuanmi/system-libs'
import type { ArtifactRef, Tier } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { DEFAULT_GROWTH, growthPrefix, parsePlan, type PlannedNode, recordExecutor, type ResolvedNode } from './spec.ts'
import { type NodeRecord, type NodeRow, now, type RunRow, type WorkflowError } from './types.ts'

/**
 * Graph growth (REQ-WF-8, REQ-WF-10): a planner's accepted answer must carry a valid plan.
 * The plan is stored, a `graph-growth` decision records the outcome, and its steps are
 * appended after the planner; the planner's dependents now wait for them. Steps that need
 * approval run only behind a gate on the exact plan. Returns the reason when refused.
 */
export function grow(e: Engine, run: RunRow, planner: NodeRow, spec: ResolvedNode, result: ArtifactRef, lease: () => Lease): string | undefined {
  const policy = { ...DEFAULT_GROWTH, ...spec.grows }
  const generation = spec.generation ?? 1
  const prefix = growthPrefix(planner.node_id, generation)
  const grownBy = { node: planner.node_id, generation }
  const parsed = parsePlan(e.resultText(result), prefix, policy)
  const classification = run.classification ?? e.ctx.egress.defaultClassification
  // A planner that plans again (re-planning) supersedes its previous plan (REQ-ART-2): the new plan
  // is a new artifact, so an approval of the old one can never open the new gate (INV-5).
  const previous = e.ctx.artifacts.list({ kind: 'plan', runId: run.run_id, nodeId: planner.node_id, limit: 1000 }).at(-1)?.id
  const plan = parsed.ok
    ? e.ctx.artifacts.put({
      kind: 'plan', bodySchema: 'plan@1.0',
      body: { schema: 'plan@1.0', runId: run.run_id, planner: planner.node_id, nodes: parsed.nodes, confidence: parsed.confidence },
      classification, producer: { type: 'node', ref: planner.node_id }, inputs: [result], runId: run.run_id, nodeId: planner.node_id,
      ...(previous ? { lineage: { supersedes: [previous] } } : {}),
    })
    : undefined
  const gated = parsed.ok && parsed.nodes.some((n) => n.capabilities.some((c) => policy.approvalRequired.includes(c)))
  const reason = parsed.ok
    ? `${parsed.nodes.length} step(s) within the bounds (at most ${policy.maxNodes}; capabilities ${policy.capabilities.join(', ')})${gated ? '; steps needing approval wait behind a gate' : ''}`
    : parsed.reason
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'graph-growth',
    question: `Does run ${run.run_id} append the steps planner ${planner.node_id} proposed?`,
    inputs: [plan ? (plan.id as ArtifactRef) : result],
    candidates: [{ option: 'append', selected: parsed.ok, reasons: parsed.ok ? [reason] : [] }, { option: 'refuse', selected: !parsed.ok, reasons: parsed.ok ? [] : [reason] }],
    decider: { type: 'policy', id: 'workflow.graph-growth', version: '1' },
    outcome: { option: parsed.ok ? 'append' : 'refuse', ...(parsed.ok ? { detail: { steps: parsed.nodes.map((n) => n.nodeId), gated } } : {}) },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: planner.node_id })
  if (!parsed.ok || !plan) return `${reason} (decision ${decision.id})`
  const gateId = `${prefix}:gate`
  const added: ResolvedNode[] = [
    ...(gated ? [{
      nodeId: gateId, objective: `Approve the plan of ${planner.node_id}`, executor: 'gate' as const, plan: plan.id, prompt: '', capabilities: ['review'],
      tier: 'economy' as Tier, tierSource: 'profile' as const, acceptance: 'acceptance.answer', dependsOn: [planner.node_id], session: {}, grownBy,
      ...(spec.operatorApproval ? { operatorApproval: true as const } : {}),
    }] : []),
    ...parsed.nodes.map((step: PlannedNode): ResolvedNode => ({
      nodeId: step.nodeId, objective: step.objective, prompt: step.prompt, literal: true, capabilities: step.capabilities, tier: step.tier,
      tierSource: 'decision', tierDecision: decision.id, acceptance: 'acceptance.answer',
      dependsOn: step.dependsOn.length ? step.dependsOn : [gated ? gateId : planner.node_id], session: {}, grownBy,
    })),
  ]
  append(e, run, planner, added, parsed.nodes.map((n) => n.nodeId), lease)
  e.ctx.eventLog.append({ type: 'workflow.graph.grown', runId: run.run_id, nodeId: planner.node_id, decision: decision.id, data: { steps: parsed.nodes.map((n) => n.nodeId), gated } })
  return undefined
}

/** Insert nodes after `after`; whatever depended on `after` now also waits for `waitFor`. */
export function append(e: Engine, run: RunRow, after: NodeRow, added: ResolvedNode[], waitFor: string[], lease: () => Lease): void {
  e.ctx.store.transaction((db) => {
    e.ctx.leases.fence(lease())
    db.prepare('UPDATE workflow_nodes SET ordinal = ordinal + ? WHERE run_id = ? AND ordinal > ?').run(added.length, run.run_id, after.ordinal)
    added.forEach((node, index) => {
      const record: NodeRecord = {
        schema: 'workflow-node@1.0', runId: run.run_id, nodeId: node.nodeId, objective: node.objective, executor: recordExecutor(node),
        requirement: e.requirementOf(node, node.session.sessionId !== undefined, run.classification ?? undefined), dependsOn: node.dependsOn, state: 'WAITING', revision: 0,
      }
      e.schemas.assertRecord(record)
      db.prepare(`INSERT INTO workflow_nodes (run_id, node_id, ordinal, spec, record, state, updated_at) VALUES (?, ?, ?, ?, ?, 'WAITING', ?)`)
        .run(run.run_id, node.nodeId, after.ordinal + 1 + index, JSON.stringify(node), JSON.stringify(record), now())
    })
    for (const dependent of e.nodeRows(run.run_id)) {
      const dspec = JSON.parse(dependent.spec) as ResolvedNode
      if (dependent.state === 'RETIRED' || !dspec.dependsOn.includes(after.node_id) || added.some((a) => a.nodeId === dependent.node_id)) continue
      const dependsOn = [...new Set([...dspec.dependsOn, ...waitFor])]
      const drecord = JSON.parse(dependent.record) as NodeRecord
      db.prepare('UPDATE workflow_nodes SET spec = ?, record = ?, updated_at = ? WHERE run_id = ? AND node_id = ?')
        .run(JSON.stringify({ ...dspec, dependsOn }), JSON.stringify({ ...drecord, dependsOn, revision: drecord.revision + 1 }), now(), run.run_id, dependent.node_id)
    }
  })
}

/** The findings of the steps a planner this node depends on added (never retired ones), in order, under their objectives. */
export function grownText(e: Engine, spec: ResolvedNode, nodes: NodeRow[]): string {
  const planners = spec.dependsOn.filter((id) => (JSON.parse(nodes.find((n) => n.node_id === id)!.spec) as ResolvedNode).grows)
  return nodes
    .filter((n) => n.state !== 'RETIRED' && planners.some((p) => grewFrom(n, p)) && (JSON.parse(n.spec) as ResolvedNode).executor !== 'gate')
    .map((n) => {
      const step = JSON.parse(n.spec) as ResolvedNode
      const result = (JSON.parse(n.record) as NodeRecord).outputReceipt?.result
      return `### ${step.objective}\n${result ? e.resultText(result) : ''}`
    })
    .join('\n\n')
}

/**
 * Whether `grower` grew this node: by its recorded origin, or, for a node grown before origins
 * were recorded, by its id under the grower's and the marks only growth leaves (a plan step's tier
 * comes from a decision; a gate approves a plan), so a template node that merely shares the
 * prefix is never taken for grown.
 */
export function grewFrom(node: NodeRow, grower: string): boolean {
  const spec = JSON.parse(node.spec) as ResolvedNode
  if (spec.grownBy) return spec.grownBy.node === grower
  return node.node_id.startsWith(`${grower}:`) && (spec.tierSource === 'decision' || spec.executor === 'gate')
}

/** The latest a gate blocked now waits for its verdict (INV-9). */
export const gateDeadline = (e: Engine): string => new Date(Date.now() + (e.config.gateTimeoutHours ?? 24) * 3_600_000).toISOString()

/** A gate whose planner finished waits for an approval of the exact plan (REQ-WF-11), until `gateTimeoutHours` pass. */
export function block(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, lease: () => Lease): void {
  const plan = spec.plan as ArtifactRef
  const inputHash = sha256(canonicalJson({ node: spec, plan }))
  const until = gateDeadline(e)
  e.ctx.store.transaction(() => {
    e.writeNode(node, { state: 'BLOCKED', not_before: until }, (record) => ({ ...record, inputReceipt: { inputHash, bundle: [plan] } }), lease)
    e.ctx.eventLog.append({ type: 'workflow.node.blocked', runId: run.run_id, nodeId: node.node_id, data: { plan, until } })
  })
  const body = e.ctx.artifacts.get(plan)?.body as { confidence?: string } | undefined
  if (e.config.autoApprovePlans && body?.confidence === 'high' && !spec.operatorApproval) {
    decideGate(e, run, e.nodeRow(run.run_id, node.node_id)!, { verdict: 'approved', by: 'policy', note: 'high-confidence plan approved by policy (autoApprovePlans)' }, lease)
  }
}

/**
 * A gate nobody decided within `gateTimeoutHours` closes by rule (INV-9): the run fails, saying so,
 * and `continue` reopens the gate to wait again. The plan stays as it was; nothing of it ran.
 */
export function expireGate(e: Engine, run: RunRow, gate: NodeRow, lease: () => Lease): void {
  const spec = JSON.parse(gate.spec) as ResolvedNode
  const plan = spec.plan as ArtifactRef
  const reason = `no verdict on plan ${plan} arrived by ${gate.not_before} (gateTimeoutHours ${e.config.gateTimeoutHours ?? 24}); continue the run to wait again`
  e.ctx.store.transaction(() => {
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `May the steps of plan ${plan} run in run ${run.run_id}?`,
      inputs: [plan],
      candidates: [{ option: 'open', selected: false, reasons: [] }, { option: 'closed', selected: true, reasons: [reason] }],
      decider: { type: 'rule', id: 'workflow.gate-timeout', version: '1' },
      outcome: { option: 'closed' },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: gate.node_id })
    const error: WorkflowError = { kind: 'gate_timeout', disposition: 'NONE', message: reason }
    e.writeNode(gate, { state: 'FAILED', error: JSON.stringify(error) }, (r) => ({ ...r, lastDecision: decision.id as ArtifactRef }), lease)
    e.ctx.eventLog.append({ type: 'workflow.gate.closed', runId: run.run_id, nodeId: gate.node_id, decision: decision.id, data: { plan, by: 'rule' } })
  })
}

export function decideGate(e: Engine, run: RunRow, gate: NodeRow, verdict: { verdict: 'approved' | 'rejected'; by: 'operator' | 'policy'; note?: string }, lease: () => Lease): void {
  const spec = JSON.parse(gate.spec) as ResolvedNode
  const plan = spec.plan as ArtifactRef
  e.ctx.store.transaction(() => {
    const approval = e.ctx.artifacts.put({
      kind: 'approval', bodySchema: 'approval@1.0',
      body: { schema: 'approval@1.0', subject: { type: 'artifact', ref: plan }, verdict: verdict.verdict, by: verdict.by, ...(verdict.note ? { note: verdict.note } : {}) },
      classification: run.classification ?? e.ctx.egress.defaultClassification, producer: { type: verdict.by, ref: verdict.by === 'operator' ? 'operator' : 'workflow' },
      inputs: [plan], subject: { type: 'artifact', ref: plan }, runId: run.run_id, nodeId: gate.node_id,
    })
    const approved = verdict.verdict === 'approved'
    const reason = `${verdict.by} ${verdict.verdict} plan ${plan}${verdict.note ? `: ${verdict.note}` : ''}`
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `May the steps of plan ${plan} run in run ${run.run_id}?`,
      inputs: [approval.id],
      candidates: [{ option: 'open', selected: approved, reasons: approved ? [reason] : [] }, { option: 'closed', selected: !approved, reasons: approved ? [] : [reason] }],
      decider: { type: verdict.by === 'operator' ? 'operator' : 'policy', id: verdict.by === 'operator' ? 'operator.approval' : 'workflow.auto-approve', version: '1' },
      outcome: { option: approved ? 'open' : 'closed' },
      deterministic: verdict.by === 'policy',
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: gate.node_id })
    const id = approval.id as ArtifactRef
    if (approved) {
      e.writeNode(gate, { state: 'COMPLETED' }, (r) => ({ ...r, outputReceipt: { result: id, acceptance: decision.id as ArtifactRef }, lastDecision: decision.id as ArtifactRef }), lease)
    } else {
      const error: WorkflowError = { kind: 'plan_rejected', disposition: 'NONE', message: reason }
      e.writeNode(gate, { state: 'FAILED', error: JSON.stringify(error) }, (r) => ({ ...r, lastDecision: decision.id as ArtifactRef }), lease)
    }
    e.ctx.eventLog.append({ type: `workflow.gate.${approved ? 'opened' : 'closed'}`, runId: run.run_id, nodeId: gate.node_id, decision: decision.id, data: { plan, by: verdict.by } })
  })
}
