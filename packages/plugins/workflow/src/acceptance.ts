/**
 * A plain run's acceptance (docs/design/workflow-engine.md#a-plain-runs-acceptance): a run that
 * serves no board task and wrote (a `develop` step completed) records, before it completes, an
 * `acceptance` decision naming the autonomy policy's required checks for `workspace-write` that
 * the run did not pass: the checks a Worker's tool calls left pending
 * (docs/design/approvals.md#a-verdict-is-not-yet-a-permission). It does not block the run: a plain
 * run applies nothing (its result is not accepted onto a task, merged, or deployed), so the checks
 * bind where its result is applied, as the board's acceptance binds them for a task's run. The
 * operator reads them in the run's decision chain (`explain`, under the final step).
 */
import type { Check } from '@tsuuanmi/system-approvals-core'
import type { Subject } from '@tsuuanmi/system-board-core'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { queueOf } from './queue.ts'
import type { ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow } from './types.ts'

/** What a writing step's work is, as the autonomy policy names it. */
const WRITES = 'workspace-write'

/** The subject the run's writing left: the latest result on a git working tree, else the final result. */
function subjectOf(e: Engine, done: NodeRow[], final: ArtifactRef): Subject {
  for (const node of [...done].reverse()) {
    const result = (JSON.parse(node.record) as NodeRecord).outputReceipt?.result
    const body = result ? e.ctx.artifacts.get(result)?.body as { schema?: string; subject?: Subject } | undefined : undefined
    if (body?.schema?.startsWith('agent-result@') && body.subject?.type === 'git-head') return body.subject
  }
  return { type: 'artifact', ref: final }
}

/**
 * Record a completed plain run's acceptance, when it wrote: the policy is asked about
 * `workspace-write` with the checks the run ran on its result (`schema`, `review`), and the checks
 * it still requires are recorded as pending. Never refuses: with no queue loaded, or one that
 * cannot be read, the decision says the pending checks are not known.
 */
export async function acceptPlain(e: Engine, run: RunRow, nodes: NodeRow[], final: ArtifactRef): Promise<void> {
  const done = nodes.filter((n) => n.state === 'COMPLETED')
  if (!done.some((n) => (JSON.parse(n.spec) as ResolvedNode).capabilities.includes('develop'))) return
  const subject = subjectOf(e, done, final)
  const checks = e.tasks.checksOf(done, subject)
  const approvals = queueOf(e)
  let policy: { mode: string; pending: Check[]; decision: ArtifactRef } | { problem: string }
  if (!approvals) policy = { problem: 'no approval queue (ctx.approvals) is loaded, so the policy\'s required checks are not known' }
  else {
    try {
      const verdict = await approvals.check({ class: WRITES, checks })
      policy = { mode: verdict.mode, pending: verdict.failedChecks ?? [], decision: verdict.decision }
    } catch (error) {
      policy = { problem: `the autonomy policy could not be read (${(error as Error).message.slice(0, 200)}), so its required checks are not known` }
    }
  }
  const ran = Object.keys(checks).length ? `the checks it ran: ${Object.entries(checks).map(([c, p]) => `${c} ${p ? 'passed' : 'failed'}`).join(', ')}` : 'it ran none of the checks a policy can require'
  const pending = 'problem' in policy ? policy.problem
    : policy.pending.length ? `the policy gives ${WRITES} ${policy.mode}, and its required checks ${policy.pending.join(', ')} are pending: they bind where the result is applied (a board task's acceptance), not here`
      : `the policy gives ${WRITES} ${policy.mode}, with no required check pending`
  const at = subject.type === 'artifact' ? `result ${subject.ref}` : `${subject.type} ${subject.ref}${subject.version ? ` at ${subject.version}` : ''}`
  e.ctx.artifacts.recordDecision({
    decisionType: 'acceptance',
    question: `Does run ${run.run_id}, which wrote ${at}, complete with the autonomy policy's required checks it did not pass recorded as pending?`,
    inputs: [final, ...('decision' in policy ? [policy.decision] : [])],
    candidates: [
      { option: 'accept', selected: true, reasons: ['every step of the run was accepted by its contract', ran, pending] },
      { option: 'hold', selected: false, reasons: ['not hold: a run that serves no board task applies nothing (its result is not accepted onto a task, merged, or deployed), so pending checks do not block it'] },
    ],
    decider: { type: 'rule', id: 'workflow.run-acceptance', version: '1' },
    outcome: {
      option: 'accept',
      detail: {
        runId: run.run_id, subject, checks, actionClass: WRITES,
        ...('problem' in policy ? { pendingChecks: 'unknown' } : { mode: policy.mode, pendingChecks: policy.pending, autonomy: policy.decision }),
      },
    },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: done.at(-1)!.node_id })
}
