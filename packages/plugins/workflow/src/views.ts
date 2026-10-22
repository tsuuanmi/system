/** What callers see of runs: views (never the input text), the usage report, and the decision chain. */
import type { Decision } from '@tsuuanmi/system-artifacts'
import type { ContentId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import type { ResolvedNode } from './spec.ts'
import { isSameFamily } from './recovery.ts'
import { tieOf, type TeamRound } from './teams.ts'
import type { ExplainedDecision, Explanation, NodeRecord, NodeView, RunRow, RunView, WorkflowError } from './types.ts'

export function view(e: Engine, run: RunRow): RunView {
  const rows = e.nodeRows(run.run_id)
  const nodes = rows.map((n): NodeView => {
    const spec = JSON.parse(n.spec) as ResolvedNode
    const record = JSON.parse(n.record) as NodeRecord
    return {
      nodeId: n.node_id, state: n.state, minTier: spec.tier, attempt: n.attempt,
      ...(n.execution_id ? { executionId: n.execution_id } : {}), ...(n.source ? { source: n.source } : {}), ...(n.worker ? { worker: n.worker } : {}),
      ...(n.served_tier ? { tier: n.served_tier } : {}), ...(n.quota_class ? { quotaClass: n.quota_class } : {}),
      ...(record.outputReceipt ? { result: record.outputReceipt.result, ...usageOf(e, record.outputReceipt.result) } : {}),
      ...(n.error && n.state !== 'COMPLETED' ? { error: JSON.parse(n.error) as WorkflowError } : {}),
    }
  })
  return {
    runId: run.run_id, template: run.template, status: run.status, specHash: run.spec_hash as ContentId,
    ...(run.session_id ? { sessionId: run.session_id } : {}),
    ...(run.result ? { result: run.result as ArtifactRef, answer: sameFamilyNote(e, rows) + e.resultText(run.result as ArtifactRef) } : {}),
    nodes,
    ...blockedOf(e, run.run_id),
    ...(run.error ? { error: JSON.parse(run.error) as WorkflowError } : {}),
    ...taskOf(e, run.run_id),
    createdAt: run.created_at, updatedAt: rows.reduce((latest, n) => (n.updated_at > latest ? n.updated_at : latest), run.updated_at),
  }
}

/** The board task a run serves, if it serves one. */
function taskOf(e: Engine, runId: string): Pick<RunView, 'task'> {
  const task = e.tasks.view(runId)
  return task ? { task } : {}
}

/**
 * A run whose steps that should differ in provider family ran on one (ADR-0029) says so first,
 * naming them, so the caller reads it with the answer. A team says it in its own answer.
 */
function sameFamilyNote(e: Engine, rows: ReturnType<Engine['nodeRows']>): string {
  const same = rows.filter((n) => !(JSON.parse(n.spec) as ResolvedNode).team && (n.decisions ? (JSON.parse(n.decisions) as ArtifactRef[]) : []).some((d) => isSameFamily(e, d)))
  return same.length ? `Same provider family (allowSameFamily): ${same.map((n) => n.node_id).join(', ')} ran on the family of the steps ${same.length > 1 ? 'they' : 'it'} should differ from; no other provider judged ${same.length > 1 ? 'them' : 'it'}.\n\n` : ''
}

/** The token usage a result reports (`model-answer`), for the usage report. */
function usageOf(e: Engine, result: ArtifactRef): Pick<NodeView, 'usage'> {
  const usage = (e.ctx.artifacts.get(result)?.body as { usage?: { inputTokens?: unknown; outputTokens?: unknown } } | undefined)?.usage
  return typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number' ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}
}

/** What the run waits for: a plan's gate (the operator's `approve`) or a team's tie (a deciding `vote`). */
function blockedOf(e: Engine, runId: string): Pick<RunView, 'blocked'> {
  const node = e.nodeRows(runId).find((n) => n.state === 'BLOCKED')
  if (!node) return {}
  const spec = JSON.parse(node.spec) as ResolvedNode
  return { blocked: spec.executor === 'decide' ? tieOf(e, node) : { kind: 'gate', nodeId: node.node_id, plan: spec.plan as ArtifactRef, ...(node.not_before ? { until: node.not_before } : {}) } }
}

/** Recent runs and, per node, which Worker, tier, and quota class served it (usage report). */
export function usage(e: Engine, limit: number): RunView[] {
  const rows = e.ctx.store.db.prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as unknown as RunRow[]
  return rows.map((r) => view(e, r))
}

/** The decision chain of a run, per node: egress, tier, route (or admission), acceptance (REQ-ART-3). */
export function explain(e: Engine, runId: string): Explanation | undefined {
  const run = e.runRow(runId)
  if (!run) return undefined
  return {
    runId, template: run.template, status: run.status, specHash: run.spec_hash as ContentId,
    nodes: e.nodeRows(runId).map((node) => {
      const record = JSON.parse(node.record) as NodeRecord
      const kept = node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : []
      const last = record.outputReceipt?.acceptance ?? record.lastDecision
      // Every attempt's decisions, in the order they were made: an earlier attempt's rejected
      // acceptance and the escalation or retry it led to stay visible after a later attempt.
      // The latest attempt's chain keeps its order; earlier attempts' decisions come before it, as
      // made (a decision shared by content with an earlier one keeps its place in the chain).
      const latest = [...kept, ...(last && !kept.includes(last) ? [last] : [])]
      const earlier = e.ctx.artifacts.list({ kind: 'decision', runId, nodeId: node.node_id, limit: 1000 }).map((a) => a.id as ArtifactRef).filter((id) => !latest.includes(id))
      const ids = [...earlier, ...latest]
      return {
        nodeId: node.node_id, state: node.state,
        ...(node.execution_id ? { executionId: node.execution_id } : {}), ...(node.worker ? { worker: node.worker } : {}), ...(node.quota_class ? { quotaClass: node.quota_class } : {}),
        decisions: ids.filter((id): id is ArtifactRef => !!id).map((id) => decision(e, id)).filter((d): d is ExplainedDecision => !!d),
      }
    }),
  }
}

function decision(e: Engine, id: ArtifactRef): ExplainedDecision | undefined {
  const body = e.ctx.artifacts.get(id)?.body as Decision | undefined
  if (!body) return undefined
  const rounds = (body.vote as { rounds?: TeamRound[] } | undefined)?.rounds ?? []
  const ballots = rounds.flatMap((r) => r.ballots.map((b) => ({ round: r.round, member: b.member, choice: b.choice, confidence: b.confidence, rationale: b.rationale })))
  const result = body.decisionType === 'acceptance' ? body.inputs[0] as ArtifactRef | undefined : undefined
  return { id, type: body.decisionType, outcome: body.outcome.option, reasons: body.candidates.find((c) => c.selected)?.reasons ?? [], ...(result ? { result } : {}), ...(ballots.length ? { ballots } : {}) }
}
