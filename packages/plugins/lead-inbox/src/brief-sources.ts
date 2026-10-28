/**
 * Where the lead brief reads from by default (PROP-0019 section 3): the board, the approval queue, the
 * workflow's runs and landing queue, the agent-workers' run worktrees, and this inbox's own unread
 * notices, each through the optional row that holds it. A row that is not loaded rejects its source
 * with the row's name; a source that cannot be read whole within its bound rejects too, with the
 * bound: a list filtered from a truncated read would read as nothing to do (INV-2). What another
 * project holds is never named: a lead token reads its own project only (ADR-0076). Reads only.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { type BriefSources, type Counted, LIST_MAX, type QueueFacts, type RequestFacts, type ReviewFacts, type RunFacts, type TaskFacts, UnknownProject, type WorktreeFacts } from './brief.ts'
import type { LeadNotice } from './notices.ts'

/** What this reads of the rows, structurally: the rows are optional and none is imported (INV-10). */
interface BoardTaskLike { taskId: string; title: string; state: string; projectId: string; dependsOn: string[]; run?: { runId: string }; holder?: { leaseExpiresAt: string }; waiting?: { reason: string; expiresAt: string } }
interface BoardLike {
  project(id: string): Promise<{ projectId: string; title: string; state: string; charter: { intent: string; constraints: { deadline?: string; notes?: string[] } }; createdAt: string; updatedAt?: string } | undefined>
  task(id: string): Promise<BoardTaskLike | undefined>
  taskPage(filter: { projectId: string; states: string[]; limit: number; after?: string }): { items: BoardTaskLike[]; next?: string }
  counts(projectId: string): Record<string, number>
}
interface RequestLike { requestId: string; state: string; action: { class: string; summary: string }; expiresAt: string }
interface ApprovalsLike {
  list(filter: { states: string[] }): Promise<RequestLike[]>
  projectOfRequest(request: RequestLike): Promise<string | undefined>
  leadMay(project: string, request: RequestLike): Promise<{ ok: boolean }>
}
interface RunLike { runId: string; status: string; nodes: Array<{ nodeId: string; state: string }>; blocked?: { kind: string } }
interface WorkflowLike {
  openLandings(): { landings: Array<{ key: string; branch: string; taskId: string; state: string; position: number }>; more: boolean }
  projectOfRun(runId: string): Promise<string | undefined>
  get(runId: string): RunLike | undefined
}
interface AgentWorkersLike { runWorktrees(input: { limit?: number }): Promise<{ total: number; worktrees: Array<{ runId: string; state: string; changes: string }> }> }

/** The open requests one read looks at, at most (INV-9): past it, the requests are unreadable, not cut. */
const REQUESTS_MAX = 1000
/** The tasks of one page of the board, at most (the board's own page bound may be lower). */
const PAGE = 100
/** Pages of one read of the board, at most (INV-9): past them, the part is unreadable, not cut. */
const PAGES = 10
/** The run worktrees one read of agent-workers holds, at most (its `agent_worktrees` bound). */
const WORKTREES_MAX = 100
const OPERATOR_HELD = new Set(['operator-review', 'review-expired'])
const CHANGES = new Set(['policy-change', 'charter'])
/** The tasks whose runs the brief shows: those that are open and have started a run. */
const RUN_STATES = ['claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval']

/** The inbox methods the sources read. */
interface NoticeSource {
  unread(project?: string, limit?: number): LeadNotice[]
  stats(project?: string): { unread: number }
}

const byExpiry = <T extends { expiresAt?: string }>(a: T, b: T): number => (a.expiresAt ?? '￿').localeCompare(b.expiresAt ?? '￿')

export function defaultSources(ctx: Context, inbox: NoticeSource): BriefSources {
  const row = <T>(name: string, found: unknown): T => {
    if (!found) throw new Error(`the ${name} row is not loaded`)
    return found as T
  }
  const boardRow = (): BoardLike => row('board', ctx.get('board' as never))
  const approvalsRow = (): ApprovalsLike => row('approvals', ctx.get('approvals' as never))
  const workflowRow = (): WorkflowLike => row('workflow', ctx.get('workflow' as never))
  const agentWorkersRow = (): AgentWorkersLike => row('agentWorkers', ctx.get('agentWorkers' as never))
  const counted = <T>(items: T[], total = items.length): Counted<T> => ({ items: items.slice(0, LIST_MAX), total })
  const facts = (t: BoardTaskLike): TaskFacts => ({ taskId: t.taskId, title: t.title, state: t.state, ...(t.waiting ? { waitingFor: t.waiting.reason } : {}), ...(t.run ? { runId: t.run.runId } : {}) })
  /** One page of a state group: the brief shows its first {@link LIST_MAX}, and the board's counts say how many there are. */
  const firstOf = (board: BoardLike, project: string, states: string[]): BoardTaskLike[] => board.taskPage({ projectId: project, states, limit: LIST_MAX }).items
  /** Every task of the project in these states, page by page; past {@link PAGES} pages it rejects, never a list cut short. */
  const allOf = (board: BoardLike, project: string, states: string[]): BoardTaskLike[] => {
    const out: BoardTaskLike[] = []
    let after: string | undefined
    for (let i = 0; i < PAGES; i++) {
      const page = board.taskPage({ projectId: project, states, limit: PAGE, ...(after !== undefined ? { after } : {}) })
      out.push(...page.items)
      if (page.next === undefined) return out
      after = page.next
    }
    throw new Error(`project ${project} has more ${states.join(', ')} tasks than one brief reads (${PAGES} pages); read them with board_tasks`)
  }
  const total = (board: BoardLike, project: string, states: string[]): number => { const c = board.counts(project); return states.reduce((n, s) => n + (c[s] ?? 0), 0) }
  return {
    project: async (project) => {
      const p = await boardRow().project(project)
      if (!p) throw new UnknownProject(project)
      return {
        id: p.projectId, title: p.title, state: p.state, objective: p.charter.intent, constraints: [...(p.charter.constraints.deadline ? [`deadline ${p.charter.constraints.deadline}`] : []), ...(p.charter.constraints.notes ?? [])],
        createdAt: p.createdAt, ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}), ...(p.charter.constraints.deadline ? { deadline: p.charter.constraints.deadline } : {}),
      }
    },
    playbook: async () => { throw new Error('the playbook\'s version is read through the handbook (I1 part 3), which is not built yet') },
    inbox: async (project) => {
      const notices = inbox.unread(project, LIST_MAX)
      return { items: notices.map((n) => ({ id: n.id, kind: n.kind, subject: n.subject, at: n.at, act: n.act })), total: inbox.stats(project).unread }
    },
    requests: async (project) => {
      const approvals = approvalsRow()
      const open = await approvals.list({ states: ['open', 'batched'] })
      if (open.length > REQUESTS_MAX) throw new Error(`the approval queue holds ${open.length} open requests, more than one brief reads (${REQUESTS_MAX}); read them with approvals_list`)
      const operator: RequestFacts[] = []
      const lead: RequestFacts[] = []
      const changes: RequestFacts[] = []
      for (const r of open) {
        // Only the project's own requests: a request of another project, or of none, is never named (ADR-0076).
        if (await approvals.projectOfRequest(r) !== project) continue
        const view = { requestId: r.requestId, class: r.action.class, summary: r.action.summary, expiresAt: r.expiresAt }
        if (CHANGES.has(r.action.class)) changes.push(view)
        else ((await approvals.leadMay(project, r)).ok ? lead : operator).push(view)
      }
      return { operator: counted(operator.sort(byExpiry)), lead: counted(lead.sort(byExpiry)), changes: counted(changes.sort(byExpiry)) }
    },
    reviews: async (project) => {
      const held = allOf(boardRow(), project, ['review', 'waiting-for-input', 'waiting-for-approval'])
      const view = (t: BoardTaskLike): ReviewFacts => {
        const expiresAt = t.waiting?.expiresAt ?? t.holder?.leaseExpiresAt
        return { taskId: t.taskId, title: t.title, reason: t.waiting?.reason ?? t.state, ...(expiresAt ? { expiresAt } : {}) }
      }
      const operator = held.filter((t) => t.waiting && OPERATOR_HELD.has(t.waiting.reason)).map(view).sort(byExpiry)
      const lead = held.filter((t) => t.state === 'review' && !t.waiting).map(view).sort(byExpiry)
      return { operator: counted(operator), lead: counted(lead) }
    },
    decisions: async () => { throw new Error('the decisions row (operator-decision records: your open questions and the decisions recorded since the last digest) is not built yet (PROP-0019 rank 4)') },
    work: async (project) => {
      const board = boardRow()
      const group = (states: string[]): Counted<TaskFacts> => counted(firstOf(board, project, states).map(facts), total(board, project, states))
      const blocked: TaskFacts[] = []
      for (const t of allOf(board, project, ['proposed', 'ready'])) {
        const unfinished: string[] = []
        for (const dep of t.dependsOn) if ((await board.task(dep))?.state !== 'done') unfinished.push(dep)
        if (unfinished.length) blocked.push({ ...facts(t), blockedBy: unfinished.slice(0, 5) })
      }
      return { running: group(['claimed', 'running']), ready: group(['ready']), waiting: group(['waiting-for-input', 'waiting-for-approval']), blocked: counted(blocked) }
    },
    runs: async (project) => {
      const workflow = workflowRow()
      const runs: RunFacts[] = []
      for (const t of allOf(boardRow(), project, RUN_STATES)) {
        if (!t.run) continue
        const run = workflow.get(t.run.runId)
        if (!run) throw new Error(`the workflow does not know run ${t.run.runId} of task ${t.taskId}`)
        runs.push({
          runId: run.runId, taskId: t.taskId, status: run.status, ...(run.blocked ? { waitsFor: run.blocked.kind } : {}),
          steps: { items: run.nodes.slice(0, LIST_MAX).map((n) => ({ nodeId: n.nodeId, state: n.state })), total: run.nodes.length },
        })
      }
      return counted(runs)
    },
    queues: async (project) => {
      const workflow = workflowRow()
      const board = boardRow()
      const open = workflow.openLandings()
      if (open.more) throw new Error('the landing queues hold more open landings than one read (500); read them with system explain on a run')
      const byKey = new Map<string, { branch: string; entries: Array<{ taskId: string; state: string; position: number; mine: boolean }> }>()
      for (const l of open.landings) {
        const mine = (await board.task(l.taskId))?.projectId === project
        const queue = byKey.get(l.key) ?? { branch: l.branch, entries: [] }
        queue.entries.push({ taskId: l.taskId, state: l.state, position: l.position, mine })
        byKey.set(l.key, queue)
      }
      const queues: QueueFacts[] = []
      for (const { branch, entries } of byKey.values()) {
        const mine = entries.filter((e) => e.mine)
        if (!mine.length) continue
        const head = entries[0]!
        // The head is named only when it is the project's own; another project's task, and the repository's host path, never are.
        queues.push({ target: branch, depth: entries.length, ofProject: mine.length, firstPosition: mine[0]!.position, ...(head.mine ? { head: { taskId: head.taskId, state: head.state } } : {}) })
      }
      return counted(queues)
    },
    worktrees: async (project) => {
      const workflow = workflowRow()
      const listing = await agentWorkersRow().runWorktrees({ limit: WORKTREES_MAX })
      if (listing.total > listing.worktrees.length) throw new Error(`the host holds ${listing.total} run worktrees, more than one read (${listing.worktrees.length}); read them with system worktrees`)
      const mine: WorktreeFacts[] = []
      for (const w of listing.worktrees) if (await workflow.projectOfRun(w.runId) === project) mine.push({ runId: w.runId, state: w.state, changes: w.changes })
      return counted(mine)
    },
    health: async () => { throw new Error('the health table (lead_health) is not built yet (PROP-0019 rank 10)') },
    lastDay: async () => { throw new Error('the digest (lead_digest: what landed, what you decided, what failed) is not built yet (PROP-0019 rank 10)') },
  }
}
