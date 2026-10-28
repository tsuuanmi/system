/**
 * The lead brief (PROP-0019 section 3): one read-only page a lead session reads at its start and
 * whenever it is lost. It adds nothing a session could not read elsewhere; its value is that nothing is
 * forgotten. Each part of a section reads from the source PROP-0019's table names; a source that cannot
 * be read, or not whole, is named in section 11 with its reason and the part shows no value, never an
 * empty list, because an empty list reads as "nothing to do" (INV-2). Each list holds at most
 * {@link LIST_MAX} entries and says how many it omitted (INV-9). The record is `lead-brief@1.0`
 * (schemas/lead-brief.v1.json). Pure: the sources are given, so the rows' absence and failure are
 * tested as such.
 * @module
 */

/** Entries one list of the brief holds at most. */
export const LIST_MAX = 20

/** What a source gives: the entries it read (bounded by the source) and how many there were in all. */
export interface Counted<T> { items: readonly T[]; total: number }
/** A list of the brief: at most {@link LIST_MAX} entries and the count left out. */
interface Listed<T> { items: T[]; omitted: number }
/** A section, or a part of one, that was read, or why it was not. */
type Read<T> = { value: T } | { unreadable: string }
/** A section that comes with a later task: shown as such, never empty. */
interface NotYet { status: 'not-yet-available'; note: string }

interface ProjectFacts { id: string; title: string; state: string; objective: string; constraints: string[]; createdAt: string; updatedAt?: string; deadline?: string }
interface NoticeFacts { id: string; kind: string; subject: string; at: string; act: string[] }
export interface RequestFacts { requestId: string; class: string; summary: string; expiresAt: string }
export interface ReviewFacts { taskId: string; title: string; reason: string; expiresAt?: string }
interface DecisionFacts { id: string; question: string; at: string }
export interface TaskFacts { taskId: string; title: string; state: string; waitingFor?: string; blockedBy?: string[]; runId?: string }
/** One run of the project's tasks: its status, what it waits for, and its steps (each node and its state). */
export interface RunFacts { runId: string; taskId: string; status: string; waitsFor?: string; steps: Counted<{ nodeId: string; state: string }> }
/**
 * One landing queue holding a result of the project: its target branch (never the repository's host
 * path), its depth, how many of its entries are the project's and the first one's place, and its head
 * only when the head is the project's own: another project's task is never named (ADR-0076).
 */
export interface QueueFacts { target: string; depth: number; ofProject: number; firstPosition: number; head?: { taskId: string; state: string } }
export interface WorktreeFacts { runId: string; state: string; changes: string }
interface LandedFacts { taskId: string; at: string; commit?: string }
interface FailedFacts { kind: string; subject: string; at: string }
interface DecidedFacts { id: string; what: string; at: string }
interface HealthFacts { state: string; checks: Array<{ name: string; state: string; detail?: string }> }

/**
 * What the brief asks of the host, each replaceable by a test. Each rejects when its source cannot be
 * read, and when it cannot be read whole within its bound: a part that would be a truncated list is
 * unreadable instead (INV-2).
 */
export interface BriefSources {
  project(project: string): Promise<ProjectFacts>
  /** The playbook's version (its blob id) and the rules that changed since `since`. */
  playbook(since: string | undefined): Promise<{ version: string; changed: string[] }>
  inbox(project: string): Promise<Counted<NoticeFacts>>
  /** Open requests of the project, sorted by expiry: those outside the lead's rights, those it may decide, and the project's policy and charter changes. */
  requests(project: string): Promise<{ operator: Counted<RequestFacts>; lead: Counted<RequestFacts>; changes: Counted<RequestFacts> }>
  /** Reviews held for the operator, and results the lead may accept, sorted by expiry. */
  reviews(project: string): Promise<{ operator: Counted<ReviewFacts>; lead: Counted<ReviewFacts> }>
  /** The lead's open questions to the operator and the decisions recorded since the last digest (operator-decision records). */
  decisions(project: string): Promise<Counted<DecisionFacts>>
  work(project: string): Promise<{ running: Counted<TaskFacts>; ready: Counted<TaskFacts>; waiting: Counted<TaskFacts>; blocked: Counted<TaskFacts> }>
  /** The workflow runs of the project's open tasks, with their steps. */
  runs(project: string): Promise<Counted<RunFacts>>
  /** The landing queues the project's results are in. */
  queues(project: string): Promise<Counted<QueueFacts>>
  /** The run worktrees of the project's runs that are not removed. */
  worktrees(project: string): Promise<Counted<WorktreeFacts>>
  health(): Promise<HealthFacts>
  /** What landed, what the lead decided, and what failed since `since` (`lead_digest`). */
  lastDay(project: string, since: string): Promise<{ landed: Counted<LandedFacts>; decided: Counted<DecidedFacts>; failed: Counted<FailedFacts> }>
}

/** `lead-brief@1.0`. */
export interface Brief {
  schema: 'lead-brief@1.0'
  project: string
  /** `lead:<project>`, or `operator` when the operator reads it. */
  principal: string
  at: string
  /** The start of "the last day": the last brief this principal read, else `since`'s default of a day before. */
  since: string
  /** When this principal last read a brief of the project; absent for the first one. */
  lastBrief?: string
  sections: {
    you: Read<{ project: { id: string; title: string; state: string }; principal: string; objective: string; constraints: string[]; dates: { createdAt: string; updatedAt?: string; deadline?: string; now: string }; playbook: Read<{ version: string; changed: Listed<string> }> }>
    inbox: Read<{ unread: Listed<{ id: string; kind: string; subject: string; ageSeconds: number; act: string[] }> }>
    waitingOnOperator: { requests: Read<Listed<RequestFacts>>; reviews: Read<Listed<ReviewFacts>> }
    heldOnYou: { requests: Read<Listed<RequestFacts>>; results: Read<Listed<ReviewFacts>> }
    pendingDecisions: { asked: Read<Listed<DecisionFacts>>; changes: Read<Listed<RequestFacts>> }
    runningWork: {
      tasks: Read<{ running: Listed<TaskFacts>; ready: Listed<TaskFacts>; waiting: Listed<TaskFacts>; blocked: Listed<TaskFacts> }>
      runs: Read<Listed<Omit<RunFacts, 'steps'> & { steps: Listed<{ nodeId: string; state: string }> }>>
      landingQueues: Read<Listed<QueueFacts>>
      worktrees: Read<Listed<WorktreeFacts>>
    }
    health: Read<HealthFacts>
    lastDay: Read<{ landed: Listed<LandedFacts>; decided: Listed<DecidedFacts>; failed: Listed<FailedFacts> }>
    switches: NotYet
    handover: NotYet
  }
  /** Section 11: each section, or part of one, that could not be read, with the reason; it shows no value above. */
  couldNotRead: Array<{ section: string; reason: string }>
  /** Section 12. */
  firstMoves: string[]
}

const FIRST_MOVES = [
  'system lead wait --project <id>   (block until a notice is unread; the loop you run instead of polling)',
  'system lead ack --project <id> <notice id>...   (mark a notice handled; MCP lead_inbox with ack)',
  'system handbook --role lead   (the playbook, whole; or docs/operations/lead-playbook.md)',
] as const

const limited = <T>(c: Counted<T>): Listed<T> => ({ items: c.items.slice(0, LIST_MAX) as T[], omitted: Math.max(0, c.total - Math.min(c.items.length, LIST_MAX)) })
const why = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 300) || 'the source failed with no reason'
const line = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A project the board does not know: the brief is refused, since every list of it would read as nothing to do. */
export class UnknownProject extends Error {
  readonly project: string
  constructor(project: string) {
    super(`project ${project} is unknown, so no brief was made`)
    this.name = 'UnknownProject'
    this.project = project
  }
}

/** Build the brief of `project` for `principal`; a source that rejects names itself in `couldNotRead`. Throws only {@link UnknownProject}. */
export async function buildBrief(input: { project: string; principal: string; now: Date; since: string; lastBrief?: string; sources: BriefSources }): Promise<Brief> {
  const { project, sources } = input
  const couldNotRead: Brief['couldNotRead'] = []
  const attempt = async <T>(section: string, read: () => Promise<T>): Promise<Read<T>> => {
    try {
      return { value: await read() }
    } catch (error) {
      if (error instanceof UnknownProject) throw error
      couldNotRead.push({ section, reason: why(error) })
      return { unreadable: why(error) }
    }
  }
  // The sources are independent: read them at once, and let one that is down leave the others whole.
  const [facts, playbook, inbox, requests, reviews, decisions, work, runs, queues, worktrees, health, lastDay] = await Promise.all([
    attempt('1 You', () => sources.project(project)),
    attempt('1 You (the playbook)', () => sources.playbook(input.lastBrief)),
    attempt('2 Inbox', () => sources.inbox(project)),
    attempt('3 Waiting on the operator, 4 Held on you, 5 Pending decisions (requests)', () => sources.requests(project)),
    attempt('3 Waiting on the operator, 4 Held on you (reviews and results)', () => sources.reviews(project)),
    attempt('5 Pending decisions (your questions and the decisions recorded)', () => sources.decisions(project)),
    attempt('6 Running work (tasks)', () => sources.work(project)),
    attempt('6 Running work (runs and their steps)', () => sources.runs(project)),
    attempt('6 Running work (landing queues)', () => sources.queues(project)),
    attempt('6 Running work (worktrees held)', () => sources.worktrees(project)),
    attempt('7 Health', () => sources.health()),
    attempt('8 The last day', () => sources.lastDay(project, input.since)),
  ])
  const at = input.now.toISOString()
  const map = <T, U>(r: Read<T>, f: (v: T) => U): Read<U> => ('value' in r ? { value: f(r.value) } : r)
  const playbookPart: Read<{ version: string; changed: Listed<string> }> = map(playbook, (p) => ({ version: p.version, changed: limited({ items: p.changed, total: p.changed.length }) }))
  const sections: Brief['sections'] = {
    you: map(facts, (f) => ({
      project: { id: f.id, title: f.title, state: f.state }, principal: input.principal, objective: line(f.objective), constraints: f.constraints.slice(0, LIST_MAX).map((c) => line(c)),
      dates: { createdAt: f.createdAt, ...(f.updatedAt ? { updatedAt: f.updatedAt } : {}), ...(f.deadline ? { deadline: f.deadline } : {}), now: at }, playbook: playbookPart,
    })),
    inbox: map(inbox, (n) => ({ unread: limited({ items: n.items.map((x) => ({ id: x.id, kind: x.kind, subject: x.subject, ageSeconds: Math.max(0, Math.round((input.now.getTime() - Date.parse(x.at)) / 1000)), act: x.act })), total: n.total }) })),
    waitingOnOperator: { requests: map(requests, (r) => limited(r.operator)), reviews: map(reviews, (r) => limited(r.operator)) },
    heldOnYou: { requests: map(requests, (r) => limited(r.lead)), results: map(reviews, (r) => limited(r.lead)) },
    pendingDecisions: { asked: map(decisions, (d) => limited({ items: d.items.map((x) => ({ ...x, question: line(x.question, 500) })), total: d.total })), changes: map(requests, (r) => limited(r.changes)) },
    runningWork: {
      tasks: map(work, (w) => ({ running: limited(w.running), ready: limited(w.ready), waiting: limited(w.waiting), blocked: limited(w.blocked) })),
      runs: map(runs, (r) => limited({ items: r.items.map((x) => ({ ...x, steps: limited(x.steps) })), total: r.total })),
      landingQueues: map(queues, limited),
      worktrees: map(worktrees, limited),
    },
    health: map(health, (h) => ({ state: h.state, checks: h.checks.slice(0, 200).map((c) => ({ ...c, ...(c.detail !== undefined ? { detail: line(c.detail, 1000) } : {}) })) })),
    lastDay: map(lastDay, (d) => ({ landed: limited(d.landed), decided: limited({ items: d.decided.items.map((x) => ({ ...x, what: line(x.what, 500) })), total: d.decided.total }), failed: limited(d.failed) })),
    switches: { status: 'not-yet-available', note: 'the lead mechanisms and their modes come with their own tasks (PROP-0019 rank 3 and after)' },
    handover: { status: 'not-yet-available', note: 'the handover note (lead-handover@1.0) comes with PROP-0019 rank 2' },
  }
  const { lastBrief } = input
  return { schema: 'lead-brief@1.0', project, principal: input.principal, at, since: input.since, ...(lastBrief ? { lastBrief } : {}), sections, couldNotRead, firstMoves: FIRST_MOVES.map((m) => m.replace('<id>', project)) }
}

const failed = (r: Read<unknown>): r is { unreadable: string } => 'unreadable' in r
const ok = <T>(r: Read<T>): T | undefined => ('value' in r ? r.value : undefined)

function list<T>(out: string[], title: string, l: Listed<T>, show: (item: T) => string): void {
  out.push(`  ${title}:${l.items.length ? '' : ' none'}${l.omitted ? ` (${l.omitted} more not shown)` : ''}`)
  for (const item of l.items) out.push(`    ${show(item)}`)
}

function part<T>(out: string[], title: string, r: Read<Listed<T>>, show: (item: T) => string): void {
  if (failed(r)) out.push(`  ${title}: COULD NOT READ (${r.unreadable})`)
  else list(out, title, r.value, show)
}

const request = (r: RequestFacts): string => `${r.requestId}  ${r.class}  expires ${r.expiresAt}  ${line(r.summary, 120)}`
const task = (t: TaskFacts): string => `${t.taskId}  ${t.state}${t.waitingFor ? ` (${t.waitingFor})` : ''}${t.blockedBy?.length ? ` after ${t.blockedBy.join(', ')}` : ''}  ${line(t.title, 80)}${t.runId ? `  run ${t.runId}` : ''}`

/** The brief as text for a session to read: one screen when the project is quiet. A part that could not be read says so and shows no value. */
export function renderBrief(b: Brief): string {
  const out: string[] = [`LEAD BRIEF  project ${b.project}  for ${b.principal}  at ${b.at}  (since ${b.since}${b.lastBrief ? '' : '; the first brief of this principal'})`]
  const s = b.sections
  const head = (n: number, title: string): void => { out.push('', `${n}. ${title}`) }
  const unreadable = (r: Read<unknown>): boolean => {
    if (failed(r)) out.push(`  COULD NOT READ (${r.unreadable})`)
    return failed(r)
  }
  head(1, 'You')
  if (!unreadable(s.you)) {
    const y = ok(s.you)!
    out.push(`  ${y.project.id}: ${y.project.title} (${y.project.state}); you are ${y.principal}`, `  objective: ${y.objective}`)
    for (const c of y.constraints) out.push(`  constraint: ${c}`)
    out.push(`  created ${y.dates.createdAt}${y.dates.updatedAt ? `, updated ${y.dates.updatedAt}` : ''}${y.dates.deadline ? `, deadline ${y.dates.deadline}` : ''}`)
    if (failed(y.playbook)) out.push(`  playbook: COULD NOT READ (${y.playbook.unreadable})`)
    else out.push(`  playbook ${y.playbook.value.version}${y.playbook.value.changed.items.length ? `; changed since your last brief: ${y.playbook.value.changed.items.join(', ')}` : ''}`)
  }
  head(2, 'Inbox')
  if (!unreadable(s.inbox)) list(out, 'unread, oldest first', ok(s.inbox)!.unread, (n) => `${n.id}  ${n.kind}  ${n.subject}  ${n.ageSeconds}s old  → ${n.act.join('  |  ')}`)
  head(3, 'Waiting on the operator')
  part(out, 'requests outside your rights', s.waitingOnOperator.requests, request)
  part(out, 'reviews held for the operator', s.waitingOnOperator.reviews, (r) => `${r.taskId}  ${r.reason}${r.expiresAt ? `  expires ${r.expiresAt}` : ''}  ${line(r.title, 80)}`)
  head(4, 'Held on you')
  part(out, 'requests you may decide', s.heldOnYou.requests, request)
  part(out, 'results you may accept', s.heldOnYou.results, (r) => `${r.taskId}${r.expiresAt ? `  expires ${r.expiresAt}` : ''}  ${line(r.title, 80)}`)
  head(5, 'Pending decisions')
  part(out, 'your open questions and the decisions recorded', s.pendingDecisions.asked, (d) => `${d.id}  ${d.at}  ${line(d.question, 120)}`)
  part(out, 'policy or charter changes awaiting approval', s.pendingDecisions.changes, request)
  head(6, 'Running work')
  const w = s.runningWork
  if (failed(w.tasks)) out.push(`  tasks: COULD NOT READ (${w.tasks.unreadable})`)
  else {
    list(out, 'running', w.tasks.value.running, task)
    list(out, 'ready', w.tasks.value.ready, task)
    list(out, 'waiting', w.tasks.value.waiting, task)
    list(out, 'blocked by dependency', w.tasks.value.blocked, task)
  }
  part(out, 'runs and their steps', w.runs, (r) => `${r.runId}  ${r.status}${r.waitsFor ? ` (waits for ${r.waitsFor})` : ''}  task ${r.taskId}  steps: ${r.steps.items.map((x) => `${x.nodeId} ${x.state}`).join(', ') || 'none'}${r.steps.omitted ? ` (+${r.steps.omitted})` : ''}`)
  part(out, 'landing queues', w.landingQueues, (q) => `${q.target}  depth ${q.depth}, ${q.ofProject} of this project (first at ${q.firstPosition}), head ${q.head ? `yours: ${q.head.taskId} (${q.head.state})` : 'another project\'s'}`)
  part(out, 'worktrees held', w.worktrees, (t) => `${t.runId}  ${t.state}, ${t.changes}`)
  head(7, 'Health')
  if (!unreadable(s.health)) {
    const h = ok(s.health)!
    out.push(`  ${h.state}`)
    for (const c of h.checks.filter((x) => x.state !== 'ok').slice(0, LIST_MAX)) out.push(`    ${c.name}  ${c.state}${c.detail ? `  ${line(c.detail, 120)}` : ''}`)
  }
  head(8, `The last day (since ${b.since})`)
  if (!unreadable(s.lastDay)) {
    const d = ok(s.lastDay)!
    list(out, 'landed', d.landed, (l) => `${l.taskId}${l.commit ? ` (${l.commit.slice(0, 8)})` : ''}  ${l.at}`)
    list(out, 'decided by you', d.decided, (x) => `${x.id}  ${x.at}  ${line(x.what, 120)}`)
    list(out, 'failed', d.failed, (f) => `${f.kind}  ${f.subject}  ${f.at}`)
  }
  head(9, 'Switches')
  out.push(`  not yet available: ${s.switches.note}`)
  head(10, 'Handover note')
  out.push(`  not yet available: ${s.handover.note}`)
  head(11, 'What I could not read')
  if (!b.couldNotRead.length) out.push('  every section was read')
  for (const c of b.couldNotRead) out.push(`  ${c.section}: ${c.reason}`)
  head(12, 'First moves')
  for (const m of b.firstMoves) out.push(`  ${m}`)
  return out.join('\n')
}
