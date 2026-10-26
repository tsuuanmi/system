/**
 * A step whose session's Worker cannot take it (docs/design/sessions-and-messaging.md#a-step-its-sessions-worker-cannot-take,
 * live 2026-10-26, board T229/T230). A session stays on its Worker (Model A), so a later step of it
 * routes only there. When every Worker the session stays on is refused for a reason no wait can
 * change (its input bound, a capability it lacks, its tier, where it runs), the step leaves the
 * session for this one execution and routes to any other admissible Worker, rather than failing the
 * run for that alone:
 *
 * - `sessionless`: every earlier turn of the session is already in the step's brief (a template's
 *   step quotes the results it builds on, `{{node:<id>}}`), so the step runs without the session.
 * - `handoff`: the brief carries, as `prior` pointers, the results of the session's earlier turns it
 *   does not already quote: what the conversation held that the step could need.
 *
 * Either way the session itself stays where it is, and a later step that runs on it again is handed
 * the results of the steps that ran off it (`sessionGaps`), so its conversation lacks nothing.
 * The choice is a `route` decision, `workflow.session-move` (INV-13). A step no Worker at all can
 * take still fails, with both refusals.
 */
import { BRIEF_LIMITS, type BriefPointer, type ContentId } from '@tsuuanmi/system-libs'
import { type AdmissionCheck, AdmissionFailure, type AdmittedWorker, type ArtifactRef, type RouteOptions, type WorkRequirement } from '@tsuuanmi/system-workers-core'
import { type Draft, renderedChars } from './briefs.ts'
import type { Engine } from './engine.ts'
import { clampText, type ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow } from './types.ts'

/** The decider of a step's move off its session. */
export const SESSION_MOVE = { type: 'rule', id: 'workflow.session-move', version: '1' } as const

/** Admission checks no wait can change: what a Worker takes and proves, its tier, and where it runs. */
const LASTING: ReadonlySet<AdmissionCheck> = new Set(['input', 'capability', 'tier', 'locality'])

/** One earlier turn of a session: its result, and what it was. */
export interface Turn { ref: ContentId; runId: string; nodeId: string; note: string }

/**
 * Why none of the Workers a session stays on (`own`) can ever take the step, from the refusal, or
 * undefined when one of them might once a wait passes (busy, at its limit, signed out, not listed).
 */
export function lastingRefusal(refused: AdmissionFailure, own: readonly string[]): string | undefined {
  const mine = refused.rejections.filter((r) => own.includes(r.worker))
  // A Worker of the session's that is not listed now may come back: that is a wait.
  if (!mine.length || own.some((w) => !mine.some((r) => r.worker === w))) return undefined
  const lasting = mine.map((r) => ({ worker: r.worker, failed: r.failed.filter((f) => LASTING.has(f.check)) }))
  if (lasting.some((r) => !r.failed.length)) return undefined
  return lasting.map((r) => `${r.worker}: ${r.failed.map((f) => f.reason).join(', ')}`).join('; ')
}

/**
 * The completed turns of a session other than this node's, oldest first: the steps of earlier runs
 * on it, then this run's, each with its stored result (one retention removed is left out: no brief
 * can point at it).
 */
export function turnsOf(e: Engine, sessionId: string, runId: string, nodeId: string): Turn[] {
  const rows = e.ctx.store.db.prepare(`SELECT n.run_id, n.node_id, n.record FROM workflow_nodes n JOIN workflow_runs r ON r.run_id = n.run_id
    WHERE json_extract(n.spec, '$.session.sessionId') = ? AND n.state = 'COMPLETED' ORDER BY r.created_at, r.run_id, n.ordinal`).all(sessionId) as Array<{ run_id: string; node_id: string; record: string }>
  const turns: Turn[] = []
  for (const row of rows) {
    if (row.run_id === runId && row.node_id === nodeId) continue
    const record = JSON.parse(row.record) as NodeRecord
    const ref = record.outputReceipt?.result
    if (!ref || !e.ctx.artifacts.get(ref)) continue
    const where = row.run_id === runId ? `step ${row.node_id}` : `step ${row.node_id} of run ${row.run_id}`
    turns.push({ ref: ref as ContentId, runId: row.run_id, nodeId: row.node_id, note: clampText(`an earlier turn of session ${sessionId}: ${where} (${record.objective})`, BRIEF_LIMITS.note) })
  }
  return turns
}

/**
 * Whether a node of the run ran off its session (it has a `workflow.session-move` decision): its
 * turn may be missing from the session's conversation, so a later step there is handed its result.
 */
function ranOff(e: Engine, runId: string, nodeId: string): boolean {
  return ['handoff', 'sessionless'].some((outcome) => e.ctx.artifacts.list({ kind: 'decision', decisionType: 'route', runId, nodeId, outcome, limit: 4 })
    .some((a) => (a.body as { decider?: { id?: string } }).decider?.id === SESSION_MOVE.id))
}

export const pointer = (turn: Turn): BriefPointer => ({ ref: turn.ref, role: 'prior', note: turn.note })

/**
 * A step on its session's Worker, after an earlier step of its run ran off the session: its brief
 * also points at those steps' results it does not quote, the turns its conversation never saw.
 * Unchanged otherwise, and while the brief has no room for them (its pointers' bound).
 */
export function sessionGaps(e: Engine, run: RunRow, spec: ResolvedNode, draft: Draft): Draft {
  const sessionId = spec.session.sessionId
  if (!sessionId || spec.team?.member) return draft
  const pointed = new Set<string>(draft.artifacts.map((p) => p.ref))
  const gaps = turnsOf(e, sessionId, run.run_id, spec.nodeId).filter((t) => t.runId === run.run_id && !pointed.has(t.ref) && ranOff(e, t.runId, t.nodeId))
  if (!gaps.length || draft.artifacts.length + gaps.length > BRIEF_LIMITS.pointers) return draft
  return { ...draft, artifacts: [...draft.artifacts, ...gaps.map(pointer)] }
}

/** A step moved off its session: the Worker that takes it, its brief and requirement there, and the decision. */
export interface Moved { admitted: AdmittedWorker; draft: Draft; requirement: WorkRequirement; decision: ArtifactRef }

/**
 * Route a step off its session, when every Worker the session stays on (`own`) was refused for a
 * reason no wait can change. Undefined when one of them might take it after a wait (the refusal
 * stands as before); `why` (to append to the refusal) when it cannot leave or no other Worker takes
 * it either. `options` are the route options the step keeps off the session (provider diversity, an
 * assigned account); `failed` the Workers an earlier unsent attempt failed on. `waited`, for a review's
 * fix whose bounded wait for its author's Worker ended (./fix-sessions.ts), is why it leaves though a
 * further wait might change the refusal: it is handed off all the same.
 */
export async function leaveSession(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, draft: Draft, requirement: WorkRequirement, own: readonly string[],
  refused: AdmissionFailure, options: Pick<RouteOptions, 'exclude' | 'assignment'>, failed: readonly string[], waited?: string): Promise<Moved | { why: string } | undefined> {
  const sessionId = spec.session.sessionId
  if (!sessionId || spec.team?.member) return undefined
  const refusal = lastingRefusal(refused, own)
  const lasting = refusal ?? waited
  if (!lasting) return undefined
  const noWait = refusal ? 'no wait changes that' : 'its bounded wait for them ended'
  const pointed = new Set<string>(draft.artifacts.map((p) => p.ref))
  const carried = turnsOf(e, sessionId, run.run_id, node.node_id).filter((t) => !pointed.has(t.ref))
  if (draft.artifacts.length + carried.length > BRIEF_LIMITS.pointers) {
    return { why: `; it does not leave session ${sessionId}: a handoff would carry ${carried.length} earlier turn(s), and a brief points at ${BRIEF_LIMITS.pointers} artifacts at most` }
  }
  // Off the session: no conversation to resume, the session's turns it needs in the brief, and no
  // persistent conversation needed unless the step itself asks for one.
  const { resume: _resume, ...rest } = draft
  const off: Draft = { ...rest, artifacts: [...draft.artifacts, ...carried.map(pointer)] }
  const offRequirement: WorkRequirement = { ...requirement, capabilities: requirement.capabilities.filter((c) => c !== 'persistent-conversation' || spec.capabilities.includes(c)) }
  const chars = renderedChars(e, off)
  const stays = `session ${sessionId} stays on ${own.join(', ')}, which cannot take this step: ${lasting}`
  let admitted: AdmittedWorker
  try {
    admitted = await e.ctx.workers.route(offRequirement, {
      producer: 'workflow', input: { chars }, ...options,
      excludeWorkers: { workers: [...new Set([...own, ...failed])], reason: clampText(failed.length ? `${stays}; or an earlier attempt failed here before anything was sent` : stays, 300) },
    })
  } catch (error) {
    if (!(error instanceof AdmissionFailure)) throw error
    return { why: `; off session ${sessionId} (whose Workers cannot take it: ${lasting}), no other Worker takes it either: ${error.message}` }
  }
  const option = carried.length ? 'handoff' : 'sessionless'
  const taken = option === 'handoff'
    ? `it runs on ${admitted.worker.worker} off the session, its brief carrying the ${carried.length} earlier turn(s) of the session it does not quote (a handoff), ${chars} characters in all`
    : `it runs on ${admitted.worker.worker} without the session: its brief already quotes every earlier turn of the session (${chars} characters), so it does not need the conversation`
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'route',
    question: `Where does node ${node.node_id} of run ${run.run_id} run, when the Workers its session ${sessionId} stays on cannot take it?`,
    inputs: [...new Set([refused.decision, admitted.decisions.route, ...carried.map((t) => t.ref as ArtifactRef)])],
    candidates: [
      // The refusal is cut, never why it is not waited on.
      { option: 'stay', selected: false, reasons: [clampText(`not stay: ${clampText(stays, 300 - `not stay: ; ${noWait}`.length)}; ${noWait}`, 300)] },
      { option, selected: true, reasons: [clampText(taken, 300), 'the session stays on its Worker; a later step of it on that Worker is handed this step\'s result'] },
      { option: option === 'handoff' ? 'sessionless' : 'handoff', selected: false, reasons: [option === 'handoff' ? 'not sessionless: the step\'s brief does not quote every earlier turn of the session' : 'not handoff: the step\'s brief already quotes every earlier turn of the session'] },
      { option: 'fail', selected: false, reasons: [clampText(`not fail: ${admitted.worker.worker} takes it, and a step does not fail only because its session's Worker cannot take it`, 300)] },
    ],
    decider: { ...SESSION_MOVE },
    outcome: { option, detail: { sessionId, from: [...own], worker: admitted.worker.worker, inputChars: chars, carried: carried.map((t) => t.ref) } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
  e.ctx.eventLog.append({ type: 'workflow.node.session-moved', runId: run.run_id, nodeId: node.node_id, decision,
    data: { sessionId, how: option, worker: admitted.worker.worker, carried: carried.length } })
  return { admitted, draft: off, requirement: offRequirement, decision }
}
