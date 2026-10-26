/**
 * One task, one author session (board T232; operator 2026-10-26: "when a fix is needed, message it;
 * after a review, message that session directly to update; the whole task stays in one session while
 * still getting outside information from an independent reviewer"). A review's fix
 * (docs/design/sessions-and-messaging.md#a-review-fix-continues-its-authors-session) is not routed
 * like any step to a fresh context: it continues the writing step's own session on its Worker, the
 * review's findings its next message, so the author fixes its own work, keeping its reasoning. The
 * reviewer stays independent: every review and re-review runs in a session of its own, never the
 * author's.
 *
 * Which path a fix took is a `route` decision by `workflow.fix-session` (INV-13):
 * - `continue`: routed to the session's Worker, resuming its native session;
 * - `wait`: that Worker cannot take it now (out of quota, signed out, not listed): the fix waits for
 *   it, `READY` with `not_before` the next look, sending nothing and spending no attempt, at most
 *   `fixSessionWaitMinutes` from its first wait (INV-9);
 * - `handoff`: the session is lost (no Worker keeps it, or it keeps no native session to resume): the
 *   fix starts a new conversation of the session, its brief carrying the session's earlier turns as
 *   `prior` pointers. A Worker that can never take it, or one waited on past the bound, hands the fix
 *   off through T230's move (./session-moves.ts, a `workflow.session-move` decision) instead.
 * Never a fresh start in silence.
 *
 * Each fix keeps its result as its own commit of the run's review history (`workflow.fix-commit`, a
 * `gate` decision each), on the run's ref `refs/system/reviews/<runId>` in its repository: before a
 * fix runs, the tree its review read (the author's change, or the previous fix's), and after it
 * completes, the fix's result; so the history shows what each review changed, and the next review
 * reads the change between the two. The worktree's HEAD never moves: a board task binds its result
 * and its checks to the HEAD it writes (`writes.ref`), which a commit on the run's branch would leave.
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { BRIEF_LIMITS, type GitSubject, subjectId } from '@tsuuanmi/system-libs'
import type { AdmissionFailure, AdmittedWorker, ArtifactRef, LandStep } from '@tsuuanmi/system-workers-core'
import type { Draft } from './briefs.ts'
import type { Engine } from './engine.ts'
import { admissionKind, errorLine } from './recovery.ts'
import { pointer, turnsOf } from './session-moves.ts'
import { clampText, type ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow, WorkflowError } from './types.ts'

/** The decider of a fix's path to its author's session. */
export const FIX_SESSION = { type: 'rule', id: 'workflow.fix-session', version: '1' } as const
/** The bounded wait of a self-review for its author's account (T267 hotfix). */
export const SELF_REVIEW_WAIT = { type: 'rule', id: 'workflow.self-review-wait', version: '1' } as const
/** The decider of a review cycle's commits in the run's worktree. */
export const FIX_COMMIT = { type: 'rule', id: 'workflow.fix-commit', version: '1' } as const

/** How long a waiting fix sleeps between looks at its author's Worker, at most. */
const LOOK_MS = 60_000

const PRODUCER = (run: RunRow, node: NodeRow) => ({ producer: { type: 'system' as const, ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })

type Body = { decider?: { id?: string }; outcome?: { option?: string; detail?: Record<string, unknown> } }

/** This node's decisions by one rule with one outcome, oldest first. */
function decided(e: Engine, run: RunRow, node: NodeRow, decisionType: string, rule: string, outcome: string): Body[] {
  return e.ctx.artifacts.list({ kind: 'decision', decisionType, runId: run.run_id, nodeId: node.node_id, outcome, limit: 1000 })
    .map((a) => a.body as Body).filter((b) => b.decider?.id === rule)
}

/**
 * A fix's brief, before it is routed: as it is while the author's session keeps a Worker and a
 * native session to resume; else (the session lost) a recorded handoff, its brief carrying the
 * session's earlier turns it does not already point at, and no conversation to resume.
 */
export function authorDraft(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, draft: Draft): Draft {
  const author = spec.author
  if (!author) return draft
  const own = e.ctx.workers.affinity(author.sessionId)
  const handle = e.ctx.workers.handle(author.sessionId)
  if (own?.length && handle) return draft
  const pointed = new Set<string>(draft.artifacts.map((p) => p.ref))
  const carried = turnsOf(e, author.sessionId, run.run_id, node.node_id).filter((t) => !pointed.has(t.ref)).slice(-(BRIEF_LIMITS.pointers - draft.artifacts.length))
  const lost = !own?.length ? `no Worker keeps session ${author.sessionId} now` : `session ${author.sessionId} keeps no native session ${own.join(', ')} can resume`
  const handed = { ...draft, artifacts: [...draft.artifacts, ...carried.map(pointer)] }
  // Recorded once per attempt: a later look at a waiting fix hands the same turns off again, silently.
  if (decided(e, run, node, 'route', FIX_SESSION.id, 'handoff').some((b) => b.outcome?.detail?.attempt === node.attempt)) return handed
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'route',
    question: `How does fix ${node.node_id} of run ${run.run_id} reach the session of its author ${author.node}?`,
    inputs: carried.map((t) => t.ref as ArtifactRef),
    candidates: [
      { option: 'continue', selected: false, reasons: [`not continue: ${lost}`] },
      { option: 'wait', selected: false, reasons: ['not wait: a lost session does not come back by waiting'] },
      { option: 'handoff', selected: true, reasons: [clampText(`${lost}: the fix starts a new conversation of the session, its brief carrying the ${carried.length} earlier turn(s) of it (a handoff), never a fresh start in silence`, 300)] },
    ],
    decider: { ...FIX_SESSION },
    outcome: { option: 'handoff', detail: { sessionId: author.sessionId, author: author.node, lost, attempt: node.attempt, carried: carried.map((t) => t.ref) } },
    deterministic: true,
  }, PRODUCER(run, node)).id
  e.ctx.eventLog.append({ type: 'workflow.node.session-moved', runId: run.run_id, nodeId: node.node_id, decision, data: { sessionId: author.sessionId, how: 'handoff', lost, carried: carried.length } })
  return handed
}

/** A fix admitted on its author's session, resuming it: the `continue` decision. Undefined for one off it, or with nothing to resume (its handoff is recorded). */
export function continued(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, admitted: AdmittedWorker, draft: Draft): ArtifactRef | undefined {
  const author = spec.author
  if (!author || !draft.resume) return undefined
  const worker = admitted.worker.worker
  return e.ctx.artifacts.recordDecision({
    decisionType: 'route',
    question: `How does fix ${node.node_id} of run ${run.run_id} reach the session of its author ${author.node}?`,
    inputs: [admitted.decisions.route],
    candidates: [
      { option: 'continue', selected: true, reasons: [clampText(`${worker} keeps session ${author.sessionId}: the fix is its next message, resuming native session ${draft.resume.nativeHandle}, so the author fixes its own work with its earlier turns`, 300)] },
      { option: 'wait', selected: false, reasons: [`not wait: ${worker} takes it now`] },
      { option: 'handoff', selected: false, reasons: ['not handoff: the session and its Worker are there'] },
    ],
    decider: { ...FIX_SESSION },
    outcome: { option: 'continue', detail: { sessionId: author.sessionId, author: author.node, worker, nativeHandle: draft.resume.nativeHandle, attempt: node.attempt } },
    deterministic: true,
  }, PRODUCER(run, node)).id as ArtifactRef
}

/**
 * A fix its author's Worker refused for a reason a wait may change: it waits for it, recorded once as
 * a `wait` decision, at most `fixSessionWaitMinutes` from that first wait; past it, `handoff` says why,
 * and the caller hands the fix off (./session-moves.ts). `node` is the row as it stands.
 */
export function waitForAuthor(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, refused: AdmissionFailure, lease: () => Lease): { waited: true } | { handoff: string } {
  const author = spec.author!
  const minutes = e.config.fixSessionWaitMinutes ?? 60
  const first = decided(e, run, node, 'route', FIX_SESSION.id, 'wait').find((b) => b.outcome?.detail?.attempt === node.attempt)
  const since = typeof first?.outcome?.detail?.since === 'string' ? first.outcome.detail.since : new Date().toISOString()
  const until = Date.parse(since) + minutes * 60_000
  const said = errorLine(refused.message)
  if (Date.now() >= until) {
    return { handoff: `the fix waited for them from ${since}, ${minutes} minute(s) at most (fixSessionWaitMinutes), and they still cannot take it (${said})` }
  }
  const decision = first ? undefined : e.ctx.artifacts.recordDecision({
    decisionType: 'route',
    question: `How does fix ${node.node_id} of run ${run.run_id} reach the session of its author ${author.node}?`,
    inputs: [refused.decision],
    candidates: [
      { option: 'continue', selected: false, reasons: [clampText(`not continue: the Worker of session ${author.sessionId} cannot take it now (${said})`, 300)] },
      { option: 'wait', selected: true, reasons: [`it waits for the session's Worker until ${new Date(until).toISOString()} (fixSessionWaitMinutes ${minutes}), sending nothing and spending no attempt`] },
      { option: 'handoff', selected: false, reasons: ['not handoff: a wait may give the author its own fix; once the bound passes, the session is handed off'] },
    ],
    decider: { ...FIX_SESSION },
    outcome: { option: 'wait', detail: { sessionId: author.sessionId, author: author.node, since, until: new Date(until).toISOString(), attempt: node.attempt, fixSessionWaitMinutes: minutes } },
    deterministic: true,
  }, PRODUCER(run, node)).id as ArtifactRef
  const next = new Date(Math.min(until, Date.now() + LOOK_MS)).toISOString()
  const error: WorkflowError = { kind: admissionKind(refused), disposition: 'BACKOFF', message: `the Worker of session ${author.sessionId} cannot take fix ${node.node_id} now (${said}); it waits for it until ${new Date(until).toISOString()}, then hands the session off` }
  e.ctx.store.transaction(() => {
    e.writeNode(node, { state: 'READY', execution_id: null, worker: null, not_before: next, error: JSON.stringify(error), decisions: JSON.stringify([refused.decision]) }, (r) => {
      const waiting: NodeRecord = { ...r, ...(decision ? { lastDecision: decision } : {}) }
      delete waiting.execution
      return waiting
    }, lease)
    if (decision) e.ctx.eventLog.append({ type: 'workflow.node.waiting', runId: run.run_id, nodeId: node.node_id, decision, data: { until: new Date(until).toISOString(), since, attempt: node.attempt } })
  })
  return { waited: true }
}

/** The tree a review was bound to (its row's `subject`), when it was bound to one. */
function reviewed(e: Engine, runId: string, review: string): { workspace: string; subject: GitSubject } | undefined {
  const row = e.nodeRow(runId, review)
  return row?.subject ? JSON.parse(row.subject) as { workspace: string; subject: GitSubject } : undefined
}

/** The commit of fix `fix`'s `workflow.fix-commit` of `what`, and the subject it holds; undefined when none was made. */
function recordedCommit(e: Engine, runId: string, fix: string, what: 'reviewed' | 'fixed'): { commit: string; subject: string } | undefined {
  const detail = e.ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', runId, nodeId: fix, outcome: 'commit', limit: 100 })
    .map((a) => a.body as Body).find((b) => b.decider?.id === FIX_COMMIT.id && b.outcome?.detail?.what === what)?.outcome?.detail
  return typeof detail?.commit === 'string' && typeof detail.subject === 'string' ? { commit: detail.commit, subject: detail.subject } : undefined
}

/**
 * The commits of the run's review history that hold the tree fix `fix`'s review read and the fix's
 * result (`workflow.fix-commit`): what a re-review is shown as the change since the last review, when
 * the tree it reads is still that result. Undefined when either was not recorded.
 */
export function fixCommits(e: Engine, runId: string, fix: string): { reviewed: string; fixed: string; subject: string } | undefined {
  const before = recordedCommit(e, runId, fix, 'reviewed')
  const after = recordedCommit(e, runId, fix, 'fixed')
  return before && after ? { reviewed: before.commit, fixed: after.commit, subject: after.subject } : undefined
}

/**
 * Keep a tree of the run's worktree as its own commit on the run's review history ref, through the
 * source that holds it (its `land` `record` step: only while the tree is still exactly `subject`,
 * INV-5; the worktree's HEAD, branch, index, and files never move, so a board task bound to the HEAD
 * it writes still binds the run's result and its checks); recorded as a `gate` decision either way.
 * Nothing when no source holds the tree as a run's worktree.
 */
async function commitTree(e: Engine, run: RunRow, node: NodeRow, what: 'reviewed' | 'fixed', workspace: string, subject: GitSubject, message: string, inputs: ArtifactRef[]): Promise<void> {
  const land = e.ctx.workers.land
  if (!land) return
  const id = subjectId(subject)
  // Once per fix and tree: a commit made, or refused, is not tried again on a later look.
  if (['commit', 'skip'].some((option) => decided(e, run, node, 'gate', FIX_COMMIT.id, option).some((b) => b.outcome?.detail?.what === what))) return
  const landed = await land.call(e.ctx.workers, { step: 'record', runId: run.run_id, workspace, subject: { ref: subject.ref, version: subject.version }, message } satisfies LandStep)
  if (!landed) return
  const done = landed.outcome === 'recorded'
  const tree = what === 'reviewed' ? 'the tree the review read' : 'the fix\'s result'
  const why = !done ? (landed.outcome === 'refused' ? `not recorded: ${landed.reason}` : `not recorded: the source answered ${landed.outcome}`)
    : landed.recorded ? `${tree} ${id} is commit ${landed.commit} on ${landed.ref}, on top of ${landed.parent}; the worktree's HEAD stays ${subject.ref}`
      : `${tree} ${id} is already held by commit ${landed.commit} (${landed.commit === subject.ref ? 'the worktree\'s HEAD, with nothing on top' : `on ${landed.ref}`})`
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `Does run ${run.run_id} keep ${what === 'reviewed' ? `the tree fix ${node.node_id}'s review read, before the fix` : `fix ${node.node_id}'s result`} as a commit of its review history?`,
    inputs,
    candidates: [
      { option: 'commit', selected: done, reasons: [clampText(done ? why : `not commit: ${why}`, 300)] },
      { option: 'skip', selected: !done, reasons: [clampText(done ? 'not skip: the tree is still exactly that subject' : `${why}; the cycle goes on, its next review reading the whole change`, 300)] },
    ],
    decider: { ...FIX_COMMIT },
    outcome: { option: done ? 'commit' : 'skip', detail: { what, workspace, subject: id, ...(done ? { commit: landed.commit, ref: landed.ref, parent: landed.parent, recorded: landed.recorded } : {}) } },
    deterministic: true,
  }, PRODUCER(run, node)).id as ArtifactRef
  if (!done) e.ctx.logger.warn(`workflow: run ${run.run_id}, ${node.node_id}: ${why} (decision ${decision})`)
}

/** Before a fix is first sent: keep the tree its review read (the author's change, or the previous fix's) as a commit, so the fix is a commit of its own on top. */
export async function commitReviewed(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode): Promise<void> {
  if (!spec.fixOf || node.attempt > 0 || node.escalations) return
  const tree = reviewed(e, run.run_id, spec.fixOf)
  if (!tree) return
  const review = (JSON.parse(e.nodeRow(run.run_id, spec.fixOf)!.record) as NodeRecord).outputReceipt?.result
  await commitTree(e, run, node, 'reviewed', tree.workspace, tree.subject,
    `system: the change review ${spec.fixOf} of run ${run.run_id} read (${subjectId(tree.subject)}), before ${node.node_id} fixes its blocking findings`, review ? [review] : [])
}

/** After a fix completed: keep its result, the tree it left, as its own commit of the review history. */
export async function commitFixed(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, result: ArtifactRef): Promise<void> {
  if (!spec.fixOf) return
  const body = e.ctx.artifacts.get(result)?.body as { schema?: string; workspace?: string; subject?: GitSubject } | undefined
  if (!body?.schema?.startsWith('agent-result@') || !body.workspace || body.subject?.type !== 'git-head') return
  await commitTree(e, run, node, 'fixed', body.workspace, body.subject, `system: ${node.node_id} of run ${run.run_id}, the fix of review ${spec.fixOf}'s blocking findings`, [result])
}

/**
 * A self-review whose author's account cannot take it now (busy, resting, or not yet back after a
 * restart) waits for it, bounded by `fixSessionWaitMinutes` from the first wait, recorded once as a
 * `wait` decision, sending nothing and spending no attempt. Past the bound the caller fails it as
 * before. Without this, a self-review refused for a moment failed as config_error and spent the
 * attempt (2026-10-26: T275 and T279 lost their last attempts at a live update's restart).
 */
export function waitForSelfReview(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, refused: AdmissionFailure, lease: () => Lease): { waited: true } | { why: string } {
  const minutes = e.config.fixSessionWaitMinutes ?? 60
  const first = decided(e, run, node, 'route', SELF_REVIEW_WAIT.id, 'wait').find((b) => b.outcome?.detail?.attempt === node.attempt)
  const since = typeof first?.outcome?.detail?.since === 'string' ? first.outcome.detail.since : new Date().toISOString()
  const until = Date.parse(since) + minutes * 60_000
  const said = errorLine(refused.message)
  if (Date.now() >= until) return { why: `the self-review waited for its author's account from ${since}, ${minutes} minute(s) at most (fixSessionWaitMinutes)` }
  const decision = first ? undefined : e.ctx.artifacts.recordDecision({
    decisionType: 'route',
    question: `When does self-review ${node.node_id} of run ${run.run_id} run on the account of ${spec.selfReview}?`,
    inputs: [refused.decision],
    candidates: [
      { option: 'run', selected: false, reasons: [clampText(`not run now: its author's account cannot take it (${said})`, 300)] },
      { option: 'wait', selected: true, reasons: [`it waits for that account until ${new Date(until).toISOString()} (fixSessionWaitMinutes ${minutes}), sending nothing and spending no attempt`] },
    ],
    decider: { ...SELF_REVIEW_WAIT },
    outcome: { option: 'wait', detail: { selfReviewOf: spec.selfReview, since, until: new Date(until).toISOString(), attempt: node.attempt, fixSessionWaitMinutes: minutes } },
    deterministic: true,
  }, PRODUCER(run, node)).id as ArtifactRef
  const next = new Date(Math.min(until, Date.now() + LOOK_MS)).toISOString()
  const error: WorkflowError = { kind: admissionKind(refused), disposition: 'BACKOFF', message: `self-review ${node.node_id} waits for its author's account until ${new Date(until).toISOString()} (${said})` }
  e.ctx.store.transaction(() => {
    e.writeNode(node, { state: 'READY', execution_id: null, worker: null, not_before: next, error: JSON.stringify(error), decisions: JSON.stringify([refused.decision]) }, (r) => {
      const waiting: NodeRecord = { ...r, ...(decision ? { lastDecision: decision } : {}) }
      delete waiting.execution
      return waiting
    }, lease)
    if (decision) e.ctx.eventLog.append({ type: 'workflow.node.waiting', runId: run.run_id, nodeId: node.node_id, decision, data: { until: new Date(until).toISOString(), since, attempt: node.attempt } })
  })
  return { waited: true }
}
