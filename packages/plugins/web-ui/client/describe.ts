// A request in plain words: what is asked, who asked, and what each verdict does. A request's own consequences, when its
// requester gave them, are shown as given; otherwise the page says what the board does with a verdict on its own kinds of request
// (docs/design/board.md).
import type { ApprovalRequest, ProjectCard, TaskCard } from '../src/api.js'
import { shortId, type Child } from './dom.js'
import { stepWords } from './runwords.js'

/** What Deny does to a start System proposes (ADR-0064): nothing starts, and that attempt is never asked about again (T197). */
export const DISPATCH_DENY = 'does not start it, and this attempt is not asked again'

export interface Described {
  title: string; subject: string; approve?: string; deny?: string; more?: Child; yes: string; no: string; next: string
  by: string; ids: Array<[string, string]>; for: string | null; project?: string | undefined
}
type Wording = { title: string; subject: string; approve?: string; deny?: string; more?: Child; yes?: string; no?: string; next?: string }

export function describe(r: ApprovalRequest, projects: Map<string, ProjectCard>): Described {
  const ref = r.subject.ref
  const all = [...projects.values()]
  const name = (id: string) => projects.get(id)?.title || id
  const charter = /^project:(.+):charter:(\d+)$/.exec(ref)
  const task = /^board-task:(.+?):attempt:(\d+)(?::answered:.+)?$/.exec(ref)
  const call = /^agent-tool-call:([^:]+):(.+)$/.exec(ref)
  const projectText = r.requester.projectId ? ' of project ' + name(r.requester.projectId) : ''
  const taskIn = (find: (t: TaskCard) => boolean): { task: TaskCard; project: ProjectCard } | undefined => {
    for (const project of all) { const t = (project.tasks ?? []).find(find); if (t) return { task: t, project } }
    return undefined
  }
  // A board task by its title when the board lists it, else by its id.
  const taskOf = (taskId: string) => { const t = taskIn((x) => x.taskId === taskId)?.task.title; return t ? 'the task "' + t + '"' : 'task ' + taskId }
  const Task = (taskId: string) => { const t = taskOf(taskId); return t.charAt(0).toUpperCase() + t.slice(1) }
  // The board task a run serves, by its run, when the board lists it.
  const runTask = (runId: string | undefined) => runId ? taskIn((x) => x.run?.runId === runId) : undefined
  let d: Wording
  if (r.action.class === 'charter' && charter) {
    const [, id = '', v = ''] = charter
    const version = Number(v)
    const p = projects.get(id)
    const proposed = p?.open.proposed
    const open = p ? Object.values(p.open).reduce((a, b) => a + b, 0) : undefined
    d = r.action.summary.startsWith('Found ') || version === 1 ? {
      title: 'Found project ' + name(id) + ' (charter version 1)',
      subject: 'charter version 1 of project ' + id,
      approve: 'Project ' + name(id) + ' becomes active; ' + (proposed === undefined ? 'its proposed tasks go' : proposed + ' proposed task(s) go') + ' through the autonomy policy. No run starts by itself.',
      deny: 'Project ' + name(id) + ' is closed as abandoned, and ' + (open === undefined ? 'its open tasks are' : open + ' open task(s) are') + ' cancelled. Cannot be undone.',
      more: 'The board activates it on its next sweep, within a minute: the proposed tasks the policy allows become ready for a Worker to claim, the others are asked here.',
      yes: 'activates the project', no: 'abandons the project',
      next: 'The board activates project ' + name(id) + ' on its next sweep, within a minute: see it on the Board page.',
    } : {
      title: 'Amend the charter of project ' + name(id) + ' to version ' + version,
      subject: 'charter version ' + version + ' of project ' + id,
      approve: 'Charter version ' + version + ' replaces version ' + (version - 1) + ' of project ' + name(id) + '.',
      deny: 'The amendment is dropped: charter version ' + (version - 1) + ' stays in force.',
      yes: 'adopts charter version ' + version, no: 'keeps version ' + (version - 1),
      next: 'The board applies it on its next sweep, within a minute.',
    }
  } else if (task) {
    const [, taskId = '', attempt = '0'] = task
    const reason = r.subject.version || ''
    const what = r.action.summary.replace(/^(approval-needed|budget-spent|reconciliation-failed): /, '')
    const subject = taskOf(taskId) + projectText + ', attempt ' + (Number(attempt) + 1)
    d = reason.startsWith('funding') || r.action.class === 'funding' ? {
      title: 'Raise the budget of a task: ' + (what.split('; ')[0] ?? what), subject,
      yes: 'raises the budget', no: 'keeps the budget',
      next: 'The board applies it to ' + taskOf(taskId) + ' on its next sweep, within a minute.',
    } : reason === 'reconciliation-failed' ? {
      title: 'Go on after a failed reconciliation: ' + what, subject,
      approve: Task(taskId) + ' tries again: its next attempt goes through the autonomy policy for ' + r.action.class + '.',
      deny: Task(taskId) + ' does not go on: it waits for your input until it is cancelled or its wait expires.',
      yes: 'tries again', no: 'holds the task',
      next: 'The board applies it to ' + taskOf(taskId) + ' on its next sweep, within a minute.',
    } : {
      title: 'Allow a ' + r.action.class + ' step: ' + what, subject,
      approve: Task(taskId) + ' may do this ' + r.action.class + ' step: it becomes ready on the board\'s next sweep (within a minute), for a Worker to claim.',
      deny: Task(taskId) + ' does not do it: it waits for your input until it is cancelled or its wait expires.',
      yes: 'allows this ' + r.action.class, no: 'holds the task',
      next: 'The board moves ' + taskOf(taskId) + ' on its next sweep, within a minute.',
    }
  } else if (call) {
    d = { title: 'Allow a tool call: ' + r.action.summary, subject: 'the exact ' + call[2] + ' call of agent run ' + call[1], yes: 'allows this call', no: 'refuses this call', next: 'The agent run gets your answer the next time it asks.' }
  } else if (r.action.class === 'policy-change') {
    d = { title: r.action.summary, subject: 'the policy set this change would put in force',
      approve: 'The proposed policy set comes into force at once; open requests are judged again under it.', deny: 'Nothing changes: the policy in force stays.',
      yes: 'puts the change in force', no: 'keeps the policy in force', next: 'See the Autonomy policy page.' }
  } else if (r.action.class === 'merge' && r.requester.component === 'workflow') {
    const landing = /^landing:merge:([0-9a-f]+):([0-9a-f]+)$/.exec(r.subject.version || '')
    const served = runTask(r.requester.runId)?.task
    const what = served ? 'The accepted change of the task "' + served.title + '"' : 'The accepted change'
    // The task first, "not pushed" in sight; the branch and both heads folded (T171).
    d = { title: r.action.summary, subject: (served ? 'the accepted change of "' + served.title + '"' : 'the accepted change on its run\'s branch') + ' · not pushed',
      approve: what + ' is merged as one merge commit. Not pushed.',
      deny: 'Not merged: the change stays on its branch; the task stays done.',
      more: ['branch ', shortId(ref, 'Copy branch'), ...(landing?.[2] && landing[1] ? [' at ', shortId(landing[2], 'Copy commit'), ', onto the base at ', shortId(landing[1], 'Copy commit')] : []), '. The run\'s branch is merged within a few seconds of your approval, as one merge commit; a conflict or a moved branch changes nothing.'],
      yes: 'merges the change', no: 'keeps the branch only',
      next: 'The run\'s branch is merged within a few seconds, as one merge commit; a conflict or a moved branch changes nothing. Nothing is pushed: see the task on the Board page.' }
  } else if (r.action.class === 'dispatch' && r.requester.component === 'workflow') {
    // A start System proposes (ADR-0064): the task, its attempt, and the Worker its summary names.
    const asked = /^dispatch:(.+):attempt:(\d+)$/.exec(ref)
    d = { title: r.action.summary, subject: 'attempt ' + (asked ? Number(asked[2]) + 1 : '?') + ' of ' + (r.requester.taskId ? taskOf(r.requester.taskId) : 'a task') + projectText,
      approve: 'System starts that attempt on the Worker named, at its next look, while the task is still ready and that Worker still free.',
      deny: 'Nothing starts, and System does not ask again for this attempt; you or the lead may still start it from the Board.',
      yes: 'starts it', no: DISPATCH_DENY,
      next: 'System starts the run at its next look, within a minute, on the Worker named: see it under Runs.' }
  } else if (r.action.class === 'remediation' && r.requester.component === 'workflow') {
    d = { title: 'Run a fix: ' + r.action.summary, subject: 'plan ' + ref + ' of run ' + (r.requester.runId || '?'), yes: 'runs the fix', no: 'does not run it', next: 'The run goes on with your answer: see it under Runs.' }
  } else d = { title: r.action.summary, subject: r.subject.type + ' ' + ref }
  // Who asked, by a readable name; the run, session, step, and change ids it gave are folded with the request's (T171).
  const q = r.requester
  const served = runTask(q.runId)?.task
  const by = q.component === 'board' ? 'the board' + (q.taskId ? ', for ' + taskOf(q.taskId) : '') + projectText
    : q.component === 'worker' ? 'an agent run'
    : q.component === 'workflow' ? (served ? 'the run of the task "' + served.title + '"' : 'a run' + (q.nodeId ? ' (' + (stepWords(q.nodeId) || 'step ' + q.nodeId) + ')' : ''))
    : q.component === 'approvals' ? 'the approval queue, for a policy change (Show change says who proposed it)'
    : q.component + projectText
  const ids = ([['run', q.runId], ['session', q.sessionId], ['step', q.nodeId], ['task', q.taskId], ['policy change', q.policyChangeId]] as const)
    .flatMap(([k, v]): Array<[string, string]> => v ? [[k, v]] : [])
  // For which task (else project, else run) it is asked, in the card's one line (T186).
  const forWhat = task?.[1] ? taskOf(task[1]) : q.taskId ? taskOf(q.taskId) : served ? 'the task "' + served.title + '"'
    : charter?.[1] ? 'project ' + name(charter[1]) : call ? 'an agent run' : q.projectId ? 'project ' + name(q.projectId) : q.runId ? 'a run' : null
  // The project it is for (T253): its requester's, its charter's, its task's, or its run's task's; none for what is in no project.
  const home = q.projectId || charter?.[1] || (task?.[1] ? taskIn((x) => x.taskId === task[1])?.project.projectId : undefined)
    || (q.taskId ? taskIn((x) => x.taskId === q.taskId)?.project.projectId : undefined) || runTask(q.runId)?.project.projectId
  return { yes: 'lets it go ahead as shown', no: 'refuses it', next: '', ...d, by, ids, for: forWhat, project: home }
}
