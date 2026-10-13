/** What callers see of runs: views (never the input text), the usage report, and the decision chain. */
import type { Decision } from '@tsuuanmi/system-artifacts'
import type { ContentId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import type { ResolvedNode } from './spec.ts'
import type { ExplainedDecision, Explanation, NodeRecord, NodeView, RunRow, RunView, WorkflowError } from './types.ts'

export function view(e: Engine, run: RunRow): RunView {
  const nodes = e.nodeRows(run.run_id).map((n): NodeView => {
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
    ...(run.result ? { result: run.result as ArtifactRef, answer: e.resultText(run.result as ArtifactRef) } : {}),
    nodes,
    ...blockedOf(e, run.run_id),
    ...(run.error ? { error: JSON.parse(run.error) as WorkflowError } : {}),
    createdAt: run.created_at, updatedAt: run.updated_at,
  }
}

/** The token usage a result reports (`model-answer`), for the usage report. */
function usageOf(e: Engine, result: ArtifactRef): Pick<NodeView, 'usage'> {
  const usage = (e.ctx.artifacts.get(result)?.body as { usage?: { inputTokens?: unknown; outputTokens?: unknown } } | undefined)?.usage
  return typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number' ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}
}

function blockedOf(e: Engine, runId: string): { blocked?: { nodeId: string; plan: ArtifactRef } } {
  const gate = e.nodeRows(runId).find((n) => n.state === 'BLOCKED')
  return gate ? { blocked: { nodeId: gate.node_id, plan: (JSON.parse(gate.spec) as ResolvedNode).plan as ArtifactRef } } : {}
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
      const ids = [...kept, ...(last && !kept.includes(last) ? [last] : [])]
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
  return { id, type: body.decisionType, outcome: body.outcome.option, reasons: body.candidates.find((c) => c.selected)?.reasons ?? [] }
}
