/**
 * Graph growth (REQ-WF-8, REQ-WF-10) and approval gates (REQ-WF-11): a planner's plan becomes
 * steps appended after it; steps that need approval wait behind a gate bound to the exact plan
 * (INV-5), opened or closed by the operator (`approve` in `operator.ts`) or by policy.
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { canonicalJson, sha256 } from '@tsuuanmi/system-libs'
import type { ArtifactRef, Tier } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { DEFAULT_GROWTH, parsePlan, type PlannedNode, type ResolvedNode } from './spec.ts'
import { type NodeRecord, type NodeRow, now, type RunRow, type WorkflowError } from './types.ts'

/**
 * Graph growth (REQ-WF-8, REQ-WF-10): a planner's accepted answer must carry a valid plan.
 * The plan is stored, a `graph-growth` decision records the outcome, and its steps are
 * appended after the planner; the planner's dependents now wait for them. Steps that need
 * approval run only behind a gate on the exact plan. Returns the reason when refused.
 */
export function grow(e: Engine, run: RunRow, planner: NodeRow, spec: ResolvedNode, result: ArtifactRef, lease: () => Lease): string | undefined {
  const policy = { ...DEFAULT_GROWTH, ...spec.grows }
  const parsed = parsePlan(e.resultText(result), planner.node_id, policy)
  const classification = run.classification ?? e.ctx.egress.defaultClassification
  const plan = parsed.ok
    ? e.ctx.artifacts.put({
      kind: 'plan', bodySchema: 'plan@1.0',
      body: { schema: 'plan@1.0', runId: run.run_id, planner: planner.node_id, nodes: parsed.nodes, confidence: parsed.confidence },
      classification, producer: { type: 'node', ref: planner.node_id }, inputs: [result], runId: run.run_id, nodeId: planner.node_id,
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
  const gateId = `${planner.node_id}:gate`
  const added: ResolvedNode[] = [
    ...(gated ? [{
      nodeId: gateId, objective: `Approve the plan of ${planner.node_id}`, executor: 'gate' as const, plan: plan.id, prompt: '', capabilities: ['review'],
      tier: 'economy' as Tier, tierSource: 'profile' as const, acceptance: 'acceptance.answer', dependsOn: [planner.node_id], session: {},
    }] : []),
    ...parsed.nodes.map((step: PlannedNode): ResolvedNode => ({
      nodeId: step.nodeId, objective: step.objective, prompt: step.prompt, literal: true, capabilities: step.capabilities, tier: step.tier,
      tierSource: 'decision', tierDecision: decision.id, acceptance: 'acceptance.answer',
      dependsOn: step.dependsOn.length ? step.dependsOn : [gated ? gateId : planner.node_id], session: {},
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
        schema: 'workflow-node@1.0', runId: run.run_id, nodeId: node.nodeId, objective: node.objective, executor: node.executor ?? 'worker',
        requirement: e.requirementOf(node, false, run.classification ?? undefined), dependsOn: node.dependsOn, state: 'WAITING', revision: 0,
      }
      e.schemas.assertRecord(record)
      db.prepare(`INSERT INTO workflow_nodes (run_id, node_id, ordinal, spec, record, state, updated_at) VALUES (?, ?, ?, ?, ?, 'WAITING', ?)`)
        .run(run.run_id, node.nodeId, after.ordinal + 1 + index, JSON.stringify(node), JSON.stringify(record), now())
    })
    for (const dependent of e.nodeRows(run.run_id)) {
      const dspec = JSON.parse(dependent.spec) as ResolvedNode
      if (!dspec.dependsOn.includes(after.node_id) || added.some((a) => a.nodeId === dependent.node_id)) continue
      const dependsOn = [...new Set([...dspec.dependsOn, ...waitFor])]
      const drecord = JSON.parse(dependent.record) as NodeRecord
      db.prepare('UPDATE workflow_nodes SET spec = ?, record = ?, updated_at = ? WHERE run_id = ? AND node_id = ?')
        .run(JSON.stringify({ ...dspec, dependsOn }), JSON.stringify({ ...drecord, dependsOn, revision: drecord.revision + 1 }), now(), run.run_id, dependent.node_id)
    }
  })
}

/** The findings of the steps a planner this node depends on added, in order, under their objectives. */
export function grownText(e: Engine, spec: ResolvedNode, nodes: NodeRow[]): string {
  const planners = spec.dependsOn.filter((id) => (JSON.parse(nodes.find((n) => n.node_id === id)!.spec) as ResolvedNode).grows)
  return nodes
    .filter((n) => planners.some((p) => n.node_id.startsWith(`${p}:`)) && (JSON.parse(n.spec) as ResolvedNode).executor !== 'gate')
    .map((n) => {
      const step = JSON.parse(n.spec) as ResolvedNode
      const result = (JSON.parse(n.record) as NodeRecord).outputReceipt?.result
      return `### ${step.objective}\n${result ? e.resultText(result) : ''}`
    })
    .join('\n\n')
}

/** A gate whose planner finished waits for an approval of the exact plan (REQ-WF-11). */
export function block(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, lease: () => Lease): void {
  const plan = spec.plan as ArtifactRef
  const inputHash = sha256(canonicalJson({ node: spec, plan }))
  e.ctx.store.transaction(() => {
    e.writeNode(node, { state: 'BLOCKED' }, (record) => ({ ...record, inputReceipt: { inputHash, bundle: [plan] } }), lease)
    e.ctx.eventLog.append({ type: 'workflow.node.blocked', runId: run.run_id, nodeId: node.node_id, data: { plan } })
  })
  const body = e.ctx.artifacts.get(plan)?.body as { confidence?: string } | undefined
  if (e.config.autoApprovePlans && body?.confidence === 'high') {
    decideGate(e, run, e.nodeRow(run.run_id, node.node_id)!, { verdict: 'approved', by: 'policy', note: 'high-confidence plan approved by policy (autoApprovePlans)' }, lease)
  }
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
