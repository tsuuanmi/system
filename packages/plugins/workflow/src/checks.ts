/**
 * A run's required checks (docs/design/workflow-engine.md#a-runs-required-checks, T151, ADR-0063):
 * once every step of a run that wrote completed (its validation step last, in `algorithm-development`),
 * and before its acceptance is decided, the engine asks the autonomy policy which of the checks it
 * requires of the result are commands (`tests`, `typecheck`, `lint`) and still pending, and has the
 * Worker source that holds the run's worktree run them on the exact tree the result is on
 * (`ctx.workers.check`). Each check that ran to an exit code on that tree is reported in the
 * acceptance's `checks`, passed or failed; one that could not run stays pending, and the board holds
 * the result for the operator as before (INV-2). An agent's own account of a command is never a check.
 */
import type { Check } from '@tsuuanmi/system-approvals-core'
import type { Subject } from '@tsuuanmi/system-board-core'
import { type ArtifactRef, RUN_CHECKS, type RunCheck } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { queueOf } from './queue.ts'
import type { ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow } from './types.ts'

/** What a writing step's work is, as the autonomy policy names it: a plain run's checks are judged under it. */
export const WRITES = 'workspace-write'

/** How many failing lines of one failed check the task's dossier tells (T270). */
export const MAX_FAILURE_LINES = 200
/** How long each of those lines may be. */
const MAX_FAILURE_LINE_CHARS = 240

/** What a run's checks came to, for its acceptance decision. */
export interface RanChecks {
  /** The exact tree they ran on. */
  subject: Subject & { version: string }
  /** Each check that ran to an exit code on the result's subject: passed or failed. */
  checks: Partial<Record<RunCheck, boolean>>
  /** The `check-run@1.0` evidence the source recorded, when a command ran. */
  evidence?: ArtifactRef
  /** Why a check asked for did not run to an exit code, or why none was asked: it stays pending. */
  notes: string[]
  /** Each failed check's failing lines (its tests' names and assertions), as its source read them, bounded: for the task's dossier (T270). */
  failures?: Partial<Record<RunCheck, string[]>>
  /** What the acceptance decision's detail records of them. */
  detail: Record<string, unknown>
}

type Tree = { subject: Subject & { version: string }; workspace: string }

/** Where a run's worktree would land (ADR-0060): the repository's checked-out branch it was cut from, as its source tells it. */
export interface LandingTarget { workspace: string; repository: string; branch: string }

/**
 * The landing targets of a run's worktrees, read from the sources that hold them (`ctx.workers.changes`),
 * for a board task's acceptance to name (D80): none when no source tells, or it cannot be read now, so
 * the board's auto-accept rule holds the result for the operator (INV-2).
 */
export async function landingTargets(e: Engine, runId: string): Promise<LandingTarget[]> {
  if (typeof e.ctx.workers.changes !== 'function') return []
  try {
    const { changes } = await e.ctx.workers.changes(runId)
    return changes.map((c) => ({ workspace: c.workspace, repository: c.repository, branch: c.base.branch }))
  } catch (error) {
    e.ctx.logger.warn(`workflow: the landing target of run ${runId}'s worktree could not be read; its acceptance names none: ${(error as Error).message}`)
    return []
  }
}

/** The checks that ran on exactly `subject`, to report at its acceptance; none when they ran on another (INV-5). */
export function ranOn(ran: RanChecks | undefined, subject: Subject): Partial<Record<RunCheck, boolean>> {
  return ran && subject.type === ran.subject.type && subject.ref === ran.subject.ref && subject.version === ran.subject.version ? ran.checks : {}
}

/**
 * The tree a completed run's result is on, as its acceptance binds it: for a board task's run whose
 * task writes a subject, the latest result on that subject (`tasks.complete`), else (a plain run, or
 * a board task with no write subject) the latest agent result on a git working tree. Undefined when
 * that is not a git working tree with its workspace.
 */
function treeOf(e: Engine, done: NodeRow[], writes: Subject | undefined): Tree | undefined {
  for (const node of [...done].reverse()) {
    const result = (JSON.parse(node.record) as NodeRecord).outputReceipt?.result
    const body = result ? e.ctx.artifacts.get(result)?.body as { schema?: string; subject?: Subject; workspace?: string } | undefined : undefined
    if (writes ? body?.subject?.type !== writes.type || body.subject.ref !== writes.ref : !body?.schema?.startsWith('agent-result@') || body.subject?.type !== 'git-head') continue
    if (body!.subject!.type !== 'git-head' || body!.subject!.version === undefined || !body!.workspace) return undefined
    return { subject: { type: 'git-head', ref: body!.subject!.ref, version: body!.subject!.version }, workspace: body!.workspace }
  }
  return undefined
}

/**
 * A completed run's required checks, before its acceptance is decided: for a board task's run, under
 * the task's action class and project (what the board judges its acceptance under); for a plain run
 * that wrote (a `develop` step completed), under `workspace-write`. A board task's run is checked on
 * the tree of the subject its task writes, when that is a `git-head`; with no write subject (the
 * lead's parallel tasks on one repository, T165), on the tree its latest agent result is on, as a
 * plain run's, and `tasks.complete` binds the result to that tree when a check ran on it (INV-5).
 * Undefined when nothing was asked. Throws only when `signal` stopped it.
 */
export async function checksFor(e: Engine, run: RunRow, nodes: NodeRow[], signal: AbortSignal): Promise<RanChecks | undefined> {
  const done = nodes.filter((n) => n.state === 'COMPLETED')
  const row = e.tasks.row(run.run_id)
  let action: { class: string; projectId?: string }
  let tree: Tree | undefined
  if (row) {
    const writes = row.writes ? JSON.parse(row.writes) as Subject : undefined
    if (writes && writes.type !== 'git-head') return undefined
    tree = treeOf(e, done, writes)
    if (!tree || !e.board) return undefined
    try {
      const task = await e.board.task(row.task_id)
      if (!task) return undefined
      action = { class: task.actionClass, projectId: task.projectId }
    } catch (error) {
      e.ctx.logger.warn(`workflow: board task ${row.task_id} could not be read for run ${run.run_id}'s checks; they stay pending: ${(error as Error).message}`)
      return undefined
    }
  } else {
    if (!done.some((n) => (JSON.parse(n.spec) as ResolvedNode).capabilities.includes('develop'))) return undefined
    tree = treeOf(e, done, undefined)
    if (!tree) return undefined
    action = { class: WRITES }
  }
  return runRequiredChecks(e, run, tree, e.tasks.checksOf(done, tree.subject), action, signal)
}

/**
 * Run the checks the policy requires of the run's result under `action` (the task's class and
 * project, or `workspace-write` for a plain run) and has not seen pass among `own` (the checks the run
 * judged itself), on `tree`. Undefined when nothing was asked: no queue, a class the policy does not
 * let run unasked, an own check failed (the acceptance rejects), or no command check required.
 * Throws only when `signal` stopped it.
 */
async function runRequiredChecks(
  e: Engine, run: RunRow, tree: Tree, own: Partial<Record<Check, boolean>>,
  action: { class: string; projectId?: string }, signal: AbortSignal,
): Promise<RanChecks | undefined> {
  if (Object.values(own).some((passed) => !passed)) return undefined
  const approvals = queueOf(e)
  if (!approvals) return undefined
  let required: RunCheck[]
  try {
    const verdict = await approvals.check({ class: action.class as never, ...(action.projectId ? { projectId: action.projectId } : {}), checks: own })
    if (verdict.mode !== 'auto' && verdict.mode !== 'notify') return undefined
    required = RUN_CHECKS.filter((c) => verdict.failedChecks?.includes(c))
  } catch (error) {
    e.ctx.logger.warn(`workflow: the autonomy policy could not be read for run ${run.run_id}'s checks; they stay pending: ${(error as Error).message}`)
    return undefined
  }
  if (!required.length) return undefined
  const pending = (why: string): RanChecks => ({ subject: tree.subject, checks: {}, notes: [`its ${required.join(', ')} check(s) did not run: ${why}; they stay pending`], detail: { asked: required, outcome: 'not-run', reason: why.slice(0, 300) } })
  if (typeof e.ctx.workers.check !== 'function') return pending('the workers seam runs no check (ctx.workers.check)')
  let checked: Awaited<ReturnType<NonNullable<typeof e.ctx.workers.check>>>
  try {
    checked = await e.ctx.workers.check({
      runId: run.run_id, workspace: tree.workspace, subject: { ref: tree.subject.ref, version: tree.subject.version }, checks: required,
      classification: run.classification ?? e.ctx.egress.defaultClassification,
    }, signal)
  } catch (error) {
    // A stop or a lost lease ends the run's turn; anything else is a check not run, never a run failed for it.
    if (signal.aborted) throw error
    return pending(`the workers seam could not run them (${(error as Error).message.slice(0, 200)})`)
  }
  if (!checked) return pending(`no Worker source holds the worktree ${tree.workspace} of the run`)
  if (checked.outcome === 'refused') return { ...pending(`source ${checked.source} refused (${checked.cause}): ${checked.reason}`), detail: { asked: required, source: checked.source, outcome: 'refused', cause: checked.cause } }
  const checks: Partial<Record<RunCheck, boolean>> = {}
  const notes: string[] = []
  const failures: Partial<Record<RunCheck, string[]>> = {}
  for (const r of checked.results) {
    if (!required.includes(r.check)) continue
    // A source's lines are bounded again here: the dossier holds what a source sends only within its bound (INV-9).
    if (r.outcome === 'failed' && Array.isArray(r.failures) && r.failures.length) {
      failures[r.check] = r.failures.slice(0, MAX_FAILURE_LINES).map((line) => String(line).slice(0, MAX_FAILURE_LINE_CHARS))
    }
    if (r.outcome === 'error') notes.push(`its ${r.check} check did not run to an exit code on the result (${r.reason}); it stays pending`)
    else {
      checks[r.check] = r.outcome === 'passed'
      // A pass that did not run every test says so to the review, never read as covering them (T247).
      if (r.notRun) notes.push(`its ${r.check} check ${r.outcome} without running ${r.notRun}: its outcome says nothing of those`)
    }
  }
  return {
    subject: tree.subject, checks, notes, ...(Object.keys(failures).length ? { failures } : {}), ...(checked.evidence ? { evidence: checked.evidence as ArtifactRef } : {}),
    // Each result keeps what its command reported it did not run: the board's auto-accept rule holds a pass with it (T255).
    detail: { asked: required, source: checked.source, outcome: 'checked', results: checked.results.map((r) => ({ check: r.check, outcome: r.outcome, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}), ...(r.notRun ? { notRun: r.notRun.slice(0, 300) } : {}) })), ...(checked.evidence ? { evidence: checked.evidence } : {}) },
  }
}
