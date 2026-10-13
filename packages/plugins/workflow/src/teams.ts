/**
 * Teams (REQ-TEAM-1..4, docs/design/teams.md): Model A members as persistent sessions behind an
 * independent-first barrier, their messages, a lead's convergence decision and the rounds it
 * carries, distinct accounts, and the team acceptance contracts.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Lease } from '@tsuuanmi/system-leases'
import { canonicalJson, sha256 } from '@tsuuanmi/system-libs'
import { type Runtime, RUNTIMES } from '@tsuuanmi/system-worker-sessions'
import type { ArtifactRef, WorkerExecution } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { parseLead, type ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow } from './types.ts'

export const teamGroup = (runId: string, team: string): string => `team:${runId}:${team}`

/** The session record's runtime, from the Worker's source and provider (metadata, never routing). */
export function runtimeOf(source: string, provider: string): Runtime {
  if (source === 'website') return 'website'
  // The engine never names a runtime (INV-11): a provider kind the session vocabulary knows is kept.
  const kind = provider.split(':')[0]!
  return (RUNTIMES as readonly string[]).includes(kind) ? kind as Runtime : 'local-tool'
}

/** The team acceptance contracts, registered with `ctx.workers`. */
export function teamContracts(ctx: Context): void {
  // A lead's answer is its decision: converged or not, with a reason.
  ctx.workers.contract('acceptance.team-lead', ({ body }) => {
    const lead = parseLead(String((body as { text?: unknown } | undefined)?.text ?? ''))
    return lead ? { accepted: true, reasons: [`the lead decided: ${lead.converged ? 'converged' : 'another round'}`] } : { accepted: false, reasons: ['the lead gave no {"converged": true|false} decision'] }
  })
  // A team's synthesis must have text and cite the member evidence it relies on (REQ-TEAM-3).
  ctx.workers.contract('acceptance.team-synthesis', ({ body }) => {
    const text = String((body as { text?: unknown } | undefined)?.text ?? '')
    const cited = [...new Set(text.match(/\[m\d+\]/g) ?? [])]
    if (!text.trim()) return { accepted: false, reasons: ['the synthesis is empty'] }
    return cited.length ? { accepted: true, reasons: [`the synthesis cites ${cited.join(', ')}`] } : { accepted: false, reasons: ['the synthesis cites no member ([m1], [m2], ...)'] }
  })
}

/**
 * After a lead decided the team converged, a later round runs nothing: each member keeps its
 * last answer, and a later lead keeps the decision. The lead's decision is the cause.
 */
export function carry(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, nodes: NodeRow[], lease: () => Lease): boolean {
  const team = spec.team
  if (!team?.round || team.round < 2 || (team.role !== 'member' && team.role !== 'lead')) return false
  const lead = nodes.find((n) => n.node_id === `${team.id}:lead:${team.round! - 1}`)
  const leadRecord = lead ? JSON.parse(lead.record) as NodeRecord : undefined
  if (!lead || !leadRecord?.outputReceipt || !parseLead(e.resultText(leadRecord.outputReceipt.result))?.converged) return false
  const source = team.role === 'lead' ? lead : nodes.find((n) => {
    const s = JSON.parse(n.spec) as ResolvedNode
    return s.team?.id === team.id && s.team.role === 'member' && s.team.member === team.member && s.team.round === team.round! - 1
  })!
  const result = (JSON.parse(source.record) as NodeRecord).outputReceipt!.result
  const decision = leadRecord.lastDecision!
  e.writeNode(node, { state: 'COMPLETED', error: null, decisions: JSON.stringify([decision]) }, (r) => ({
    ...r, inputReceipt: { inputHash: sha256(canonicalJson({ carried: result, decision })), bundle: [result] }, outputReceipt: { result, acceptance: decision }, lastDecision: decision,
  }), lease)
  e.ctx.eventLog.append({ type: 'workflow.node.completed', runId: run.run_id, nodeId: node.node_id, decision, data: { carried: true, from: source.node_id } })
  return true
}

/** A lead's accepted answer, as the procedure decision it is: another round, or close. */
export function leadDecision(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, result: ArtifactRef): ArtifactRef {
  const lead = parseLead(e.resultText(result))!
  const round = spec.team!.round!
  return e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `Does team ${spec.team!.id} of run ${run.run_id} need a round after round ${round}?`,
    inputs: [result],
    candidates: [
      { option: 'continue', selected: !lead.converged, reasons: lead.converged ? [] : [lead.reason || 'the members have not converged'] },
      { option: 'close', selected: lead.converged, reasons: lead.converged ? [lead.reason || 'the members converged'] : [] },
    ],
    decider: { type: 'model', id: 'workflow.team-lead', version: '1' },
    outcome: { option: lead.converged ? 'close' : 'continue' },
    // The Worker and the tier that served the lead (website models do not report their version).
    modelAnswers: [{ provider: (node.worker ?? 'unknown').slice(0, 64), modelVersion: node.served_tier ?? 'unknown', questionId: 'team-lead.converged', type: 'yes-no', choice: lead.converged ? 'yes' : 'no' }],
    deterministic: false,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
}

/**
 * A member's peers (the other members' previous round) or, for the synthesis, every member's
 * final answer, each under its member label. Round 1 gets nothing: the barrier (REQ-TEAM-1).
 */
export function teamTexts(e: Engine, spec: ResolvedNode, nodes: NodeRow[]): { inbox?: string; members?: string } {
  const team = spec.team!
  const answers = (round: number): string => nodes
    .map((n) => ({ n, s: JSON.parse(n.spec) as ResolvedNode }))
    .filter(({ s }) => s.team?.id === team.id && s.team.role === 'member' && s.team.round === round)
    .map(({ n, s }) => {
      const result = (JSON.parse(n.record) as NodeRecord).outputReceipt?.result
      return `### [m${s.team!.member}]\n${result ? e.resultText(result) : ''}`
    })
    .join('\n\n')
  const sessions = e.ctx.workerSessions
  // Every member finished round 1 (a lead, a later round, and the synthesis all depend on it):
  // the barrier opens, also when a lead closes the team or it has a single round.
  if (team.role !== 'member' || (team.round ?? 1) > 1) sessions.openBarrier(teamGroup(nodes[0]!.run_id, team.id))
  if (team.role === 'synthesis') return { members: answers(team.rounds) }
  if (team.role === 'lead') return { members: answers(team.round!) }
  if (!team.round || team.round === 1 || !spec.session.sessionId) return {}
  const inbox = sessions.inbox(spec.session.sessionId)
  if (inbox.length) sessions.ack(spec.session.sessionId, inbox.at(-1)!.seq)
  return {
    inbox: inbox.map((m) => `### From [${sessions.session(m.from)?.role ?? m.from}] (${m.message.intent ?? 'inform'})\n${m.message.body}`).join('\n\n') || '(no messages)',
  }
}

/**
 * A member's accepted answer is its message to the team (the engine records it; it never
 * rewrites it); a `To m<k>: …` line is a direct message to one member instead. A plain line,
 * not a fenced block: a web model's answer is read from its rendered page.
 */
export function post(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, execution: WorkerExecution, result: ArtifactRef): void {
  const team = spec.team!
  const from = spec.session.sessionId!
  const group = teamGroup(run.run_id, team.id)
  const text = e.resultText(result)
  const DIRECT = /(?:^|\s)To (m\d+):[ \t]*([^\n]+)/g
  const direct = [...text.matchAll(DIRECT)]
  const open = text.replace(DIRECT, '').trim() || text
  const body = (t: string): string => (t.length > 32_000 ? `${t.slice(0, 31_900)}\n…(truncated; the full answer is the referenced artifact)` : t)
  const intent = team.round === 1 ? 'answer' : 'critique'
  e.ctx.workerSessions.send({ from, messageId: `${node.node_id}:${execution.id}`, to: { group }, intent, body: body(open), refs: [result] })
  direct.forEach(([, role, message], index) => {
    const target = e.nodeRows(run.run_id)
      .map((n) => JSON.parse(n.spec) as ResolvedNode)
      .find((s) => s.team?.id === team.id && s.team.role === 'member' && `m${s.team.member}` === role)?.session.sessionId
    if (target && message!.trim()) e.ctx.workerSessions.send({ from, messageId: `${node.node_id}:${execution.id}:${index}`, to: { session: target }, intent: 'inform', body: body(message!.trim()) })
  })
}

/**
 * Which Workers may take a node: a session stays on its Worker; a team member of a team that
 * needs distinct accounts avoids every account another member already holds (REQ-TEAM-4).
 */
export async function restriction(e: Engine, run: RunRow, spec: ResolvedNode): Promise<{ restrict?: { workers: string[]; reason: string } }> {
  const own = spec.session.sessionId ? e.ctx.workers.affinity(spec.session.sessionId) : undefined
  if (own) return { restrict: { workers: own, reason: `session ${spec.session.sessionId} stays on its Worker` } }
  if (!spec.team?.distinct || spec.team.role !== 'member') return {}
  const taken = new Set(e.nodeRows(run.run_id)
    .map((n) => JSON.parse(n.spec) as ResolvedNode)
    .filter((s) => s.team?.id === spec.team!.id && s.team.member !== spec.team!.member && s.session.sessionId)
    .flatMap((s) => e.ctx.workers.affinity(s.session.sessionId!) ?? []))
  if (!taken.size) return {}
  const workers = (await e.ctx.workers.list()).map((w) => w.worker).filter((w) => !taken.has(w))
  return { restrict: { workers, reason: `team ${spec.team.id}: members use distinct accounts (REQ-TEAM-4); another member holds this account` } }
}
