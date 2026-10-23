/**
 * The `TASKS.md` projection of one project's board, for native agents without MCP, in the spirit of
 * Backlog.md's task format: per task its id, title, state, acceptance criteria as checkboxes,
 * dependencies, holder, and why it waits (its questions, or the funding a spent budget asks for).
 * A pure function of the stored records, so the same board renders the same text; it is never read
 * back (the store is the source of truth).
 */
import type { BoardTask, Project, TaskState } from './index.ts'

/** Sections in reading order: what moves now, what waits, what comes next, then what ended. */
const SECTIONS: ReadonlyArray<{ title: string; states: readonly TaskState[] }> = [
  { title: 'In progress', states: ['claimed', 'running', 'review'] },
  { title: 'Waiting', states: ['waiting-for-input', 'waiting-for-approval'] },
  { title: 'Ready', states: ['ready'] },
  { title: 'Proposed', states: ['proposed'] },
  { title: 'Done', states: ['done'] },
  { title: 'Cancelled', states: ['cancelled'] },
]

/** One line of caller text: no line breaks, so it cannot open a heading or a list of its own. */
const inline = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').trim()

function task(t: BoardTask): string[] {
  const lines = [`### ${inline(t.title)}`, '', `- id: \`${t.taskId}\``, `- state: ${t.state}`]
  if (t.milestone) lines.push(`- milestone: ${t.milestone}`)
  lines.push(`- action: ${t.actionClass}`, `- attempts: ${t.attempts.count} of ${t.attempts.max}`)
  lines.push(`- depends on: ${t.dependsOn.length ? t.dependsOn.map((d) => `\`${d}\``).join(', ') : 'nothing'}`)
  if (t.writes) lines.push(`- writes: ${t.writes.type} \`${inline(t.writes.ref)}\``)
  if (t.holder) lines.push(`- holder: ${t.holder.owner} (generation ${t.holder.generation}, lease until ${t.holder.leaseExpiresAt})`)
  if (t.run) lines.push(`- run: \`${t.run.runId}\`, started ${t.run.startedAt}`)
  if (t.waiting) {
    const what = t.state === 'waiting-for-approval' ? `for approval (${t.waiting.reason}, request \`${t.waiting.approvalRequest}\`)` : `for input (${t.waiting.reason})`
    lines.push(`- waiting: ${what} since ${t.waiting.since}, until ${t.waiting.expiresAt}`)
    for (const [i, q] of (t.waiting.questions ?? []).entries()) lines.push(`  ${i + 1}. ${inline(q)}`)
    // A spent budget's ask (board-task@1.1): the exact lines its request would add, as the queue shows them.
    if (t.waiting.funding?.length) lines.push(`  - funding asked: ${t.waiting.funding.map((l) => `+${l.amount} ${l.unit} of ${inline(l.pool)}`).join(', ')}`)
  }
  if (t.result) {
    const subject = `${t.result.subject.type} \`${inline(t.result.subject.ref)}\`${t.result.subject.version ? ` at \`${inline(t.result.subject.version)}\`` : ''}`
    lines.push(`- result: ${subject}${t.result.acceptance ? `, accepted by \`${t.result.acceptance}\`` : ''}${t.result.digest ? `; digest \`${t.result.digest}\`` : ''}`)
    if (t.result.next) lines.push(`- proposed next: ${inline(t.result.next)}`)
  }
  if (t.cancellation) lines.push(`- cancelled: ${t.cancellation.reason}${t.cancellation.note ? ` (${inline(t.cancellation.note)})` : ''} at ${t.cancellation.at}`)
  // The goal keeps its lines, quoted, so none of them reads as the board's own structure.
  lines.push('', ...t.goal.split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : '>')), '', 'Acceptance criteria:', '')
  const done = t.state === 'done'
  for (const a of t.acceptance) lines.push(`- [${done ? 'x' : ' '}] ${a.id}: ${inline(a.statement)}${a.check ? ` (${a.check})` : ''}`)
  return [...lines, '']
}

/**
 * Render `project`'s board from its tasks (in creation order), listing at most `maxTasks` of them,
 * open ones first; the rest are counted, never silently dropped.
 */
export function renderTasks(project: Project, tasks: readonly BoardTask[], maxTasks: number): string {
  const out = [
    `<!-- TASKS.md for project ${project.projectId}: a projection of the system board, generated from its store. Edits here are never read back; change the board through the board_* tools. -->`,
    '',
    `# ${inline(project.title)}`,
    '',
    `- project: \`${project.projectId}\``,
    `- state: ${project.state}`,
    `- charter: version ${project.charter.version}${project.charter.approval ? ', approved' : ', waiting for the operator'}${project.proposedCharter ? `; version ${project.proposedCharter.version} waits for the operator` : ''}`,
    `- intent: ${inline(project.charter.intent)}`,
  ]
  if (project.milestones.length) out.push(`- milestones: ${project.milestones.map((m) => `${m.id} ${inline(m.title)} (${m.state})`).join('; ')}`)
  if (project.closure) out.push(`- closed: ${project.closure.outcome} at ${project.closure.at}`)
  out.push('')
  let left = maxTasks
  let unlisted = 0
  for (const section of SECTIONS) {
    const members = tasks.filter((t) => section.states.includes(t.state))
    if (!members.length) continue
    const shown = members.slice(0, Math.max(left, 0))
    left -= shown.length
    unlisted += members.length - shown.length
    if (!shown.length) continue
    out.push(`## ${section.title}`, '')
    for (const t of shown) out.push(...task(t))
  }
  if (!tasks.length) out.push('No tasks yet.', '')
  if (unlisted) out.push(`${unlisted} more task(s) are not listed here (at most ${maxTasks} are): read them with board_tasks.`, '')
  return `${out.join('\n').trimEnd()}\n`
}
