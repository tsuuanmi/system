/**
 * What one recorded event tells a project's lead (docs/design/notifications.md#the-leads-inbox): a
 * pure function from an event-log entry to the notices it makes (drafts, not yet addressed to a
 * project when the event names only a task), the notices it closes (a request decided, a task moved),
 * and the open request it starts or ends (for `request.stale`). It reads only ids, classes, kinds,
 * counts, and times, never a summary, prompt, answer, or command, and cuts every value it quotes.
 * An event it cannot read whole means nothing.
 * @module
 */
import type { SystemEvent } from '@tsuuanmi/system-ledger-core'

/** The notice kinds (`lead-notice@1.0` `kind`). */
export const KINDS = [
  'result.held', 'merge.held', 'worker.question', 'task.retries-spent', 'task.landing-gave-up', 'request.outside-rights', 'request.stale',
  'quota.idle', 'live-update.done', 'live-update.failed', 'task.landed', 'task.digest', 'review.held', 'review.expiring',
] as const
export type Kind = (typeof KINDS)[number]

/** The kinds `lead-notice@1.1` adds. */
const KINDS_1_1: readonly Kind[] = ['review.held', 'review.expiring']

/** `lead-notice@1.0`, `@1.1` for `review.held` and `review.expiring`; the schema in `schemas/` is canonical. */
export interface LeadNotice {
  schema: 'lead-notice@1.0' | 'lead-notice@1.1'
  id: string
  project: string
  to: string
  kind: Kind
  subject: string
  at: string
  event: { seq: number; type: string }
  title: string
  text: string
  act: string[]
  taskId?: string
  commit?: string
  changed?: string
  landed?: Array<{ taskId: string; commit?: string }>
}

/** A notice an event makes, before it is addressed: the project is the event's, or found from its task. */
export interface Draft {
  kind: Kind
  subject: string
  project?: string
  /** For a live update: it goes to every project. */
  everyProject?: true
  taskId?: string
  title: string
  text: string
  act: string[]
  commit?: string
  changed?: string
}

/** Notices of these kinds about `subject` are handled by it: the request decided, the task moved on. */
export interface Closing {
  kinds: readonly Kind[]
  subject: string
}

/** What one event means to the inbox. */
export interface Reading {
  drafts: Draft[]
  closes: Closing[]
  /** A request opened: kept until it is decided, so one left open too long is `request.stale`. */
  opened?: { requestId: string; project?: string; taskId?: string }
  resolved?: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/
const COMMIT = /^[0-9a-f]{4,64}$/

const id = (value: unknown): string | undefined => (typeof value === 'string' && ID.test(value) ? value : undefined)
const word = (value: unknown): string | undefined => (typeof value === 'string' && WORD.test(value) ? value : undefined)
const time = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1_000_000 ? value : undefined)
/** A one-line summary of a change: counts and words of a diff's last line, nothing else. */
const summary = (value: unknown): string | undefined => (typeof value === 'string' && /^[0-9A-Za-z ,()+\-.]{1,200}$/.test(value.trim()) ? value.trim() : undefined)
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const NOTHING: Reading = { drafts: [], closes: [] }
const taskAct = (taskId: string): string[] => [`MCP board_task {"taskId":"${taskId}"}`, 'system ui']
const requestAct = (requestId: string): string[] => [`MCP approvals_get {"requestId":"${requestId}"}`, 'MCP approvals_decide', 'system ui']

/** Read one event; anything it does not name, or cannot read whole, means nothing. */
export function readEvent(event: SystemEvent): Reading {
  const data = event.data ?? {}
  switch (event.type) {
    case 'board.review.held': {
      const taskId = id(data.taskId)
      const projectId = id(data.projectId)
      if (!taskId || !projectId) return NOTHING
      const checks = (Array.isArray(data.pendingChecks) ? data.pendingChecks : []).map(word).filter((c): c is string => c !== undefined).slice(0, 8)
      const expiresAt = time(data.expiresAt)
      return { drafts: [{
        kind: 'result.held', subject: taskId, project: projectId, taskId,
        title: `A result is held: board task ${clip(taskId, 60)}`,
        text: `The result of board task ${taskId} waits for a person to accept or reject it${checks.length ? ` (checks not reported: ${checks.join(', ')})` : ' (a heavy-tier result)'}${expiresAt ? `; held until ${expiresAt}` : ''}.`,
        act: taskAct(taskId),
      }], closes: [] }
    }
    case 'board.review.ended': {
      const taskId = id(data.taskId)
      return taskId ? { drafts: [], closes: [{ kinds: ['result.held'], subject: taskId }] } : NOTHING
    }
    case 'board.waiting': {
      const taskId = id(data.taskId)
      const projectId = id(data.projectId)
      if (!taskId || !projectId || data.reason !== 'retries-spent') return NOTHING
      return { drafts: [{
        kind: 'task.retries-spent', subject: taskId, project: projectId, taskId,
        title: `Attempts spent: board task ${clip(taskId, 60)}`,
        text: `Board task ${taskId} spent its attempts and waits for input (retries-spent), which expires.`,
        act: taskAct(taskId),
      }], closes: [] }
    }
    case 'board.waiting.ended': {
      const taskId = id(data.taskId)
      return taskId ? { drafts: [], closes: [{ kinds: ['task.retries-spent', 'worker.question'], subject: taskId }] } : NOTHING
    }
    case 'workflow.task.question': {
      const taskId = id(data.taskId)
      if (!taskId) return NOTHING
      const n = count(data.questions)
      return { drafts: [{
        kind: 'worker.question', subject: taskId, taskId,
        title: `A Worker asks: board task ${clip(taskId, 60)}`,
        text: `A Worker asked ${n === undefined ? 'a question' : `${n} question(s)`} instead of answering board task ${taskId}; the task waits for the answers.`,
        act: taskAct(taskId),
      }], closes: [] }
    }
    case 'workflow.task.landing': return landing(event, data)
    case 'approvals.requested': {
      const requestId = id(data.requestId)
      if (!requestId) return NOTHING
      const project = id(data.projectId)
      const taskId = id(data.taskId)
      return { drafts: [], closes: [], opened: { requestId, ...(project ? { project } : {}), ...(taskId ? { taskId } : {}) } }
    }
    case 'approvals.resolved': {
      const requestId = id(data.requestId)
      return requestId ? { drafts: [], closes: [{ kinds: ['merge.held', 'request.outside-rights', 'request.stale'], subject: requestId }], resolved: requestId } : NOTHING
    }
    case 'approvals.lead-refused': {
      const requestId = id(data.requestId)
      const project = id(data.projectId)
      if (!requestId || !project) return NOTHING
      const actionClass = word(data.actionClass)
      return { drafts: [{
        kind: 'request.outside-rights', subject: requestId, project,
        title: `Needs the operator: request ${clip(requestId, 60)}`,
        text: `The lead's token was refused a verdict on request ${requestId}${actionClass ? ` (${actionClass})` : ''}: it is outside the lead's rights, so it waits for the operator.`,
        act: requestAct(requestId),
      }], closes: [] }
    }
    case 'host.live-update': {
      const outcome = data.outcome === 'done' || data.outcome === 'failed' ? data.outcome : undefined
      if (!outcome) return NOTHING
      const from = word(data.from)
      const to = word(data.to)
      const project = id(data.projectId)
      const subject = to ? `update:${to}` : `update:${event.seq}`
      return { drafts: [{
        kind: outcome === 'done' ? 'live-update.done' : 'live-update.failed', subject, ...(project ? { project } : { everyProject: true as const }),
        title: outcome === 'done' ? 'The live update is done' : 'The live update failed',
        text: outcome === 'done'
          ? `The live install was updated${from && to ? ` from ${from} to ${to}` : ''}; dispatch may be resumed once the Workers take work again.`
          : `The live update${from && to ? ` from ${from} to ${to}` : ''} failed${word(data.reason) ? ` (${word(data.reason)})` : ''}; it was rolled back or stopped.`,
        act: ['system health', 'system dispatch status'],
      }], closes: [] }
    }
    default:
      return NOTHING
  }
}

function landing(event: SystemEvent, data: Record<string, unknown>): Reading {
  const taskId = id(data.taskId)
  if (!taskId) return NOTHING
  // Any later landing step of the task ends a give-up told before it.
  const closes: Closing[] = [{ kinds: ['task.landing-gave-up'], subject: taskId }]
  switch (data.state) {
    case 'asked': {
      const requestId = id(data.requestId)
      if (!requestId) return { drafts: [], closes }
      return { drafts: [{
        kind: 'merge.held', subject: requestId, taskId,
        title: `A merge waits: board task ${clip(taskId, 60)}`,
        text: `The merge of board task ${taskId} waits for a verdict on request ${requestId}.`,
        act: requestAct(requestId),
      }], closes }
    }
    case 'merged': {
      const commit = typeof data.commit === 'string' && COMMIT.test(data.commit) ? data.commit : undefined
      const changed = summary(data.changed)
      const branch = word(data.branch)
      return { drafts: [{
        kind: 'task.landed', subject: taskId, taskId, ...(commit ? { commit } : {}), ...(changed ? { changed } : {}),
        title: `Landed: board task ${clip(taskId, 60)}`,
        text: `Board task ${taskId} landed${branch ? ` on ${branch}` : ''}${commit ? ` as commit ${commit.slice(0, 12)}` : ''}${changed ? `: ${changed}` : ''}.`,
        act: ['system lead wait', ...taskAct(taskId).slice(0, 1)],
      }], closes }
    }
    case 'refused': {
      const cause = word(data.cause)
      const rebases = typeof data.reason === 'string' ? /after (\d{1,3}) rebase/.exec(data.reason)?.[1] : undefined
      return { drafts: [{
        kind: 'task.landing-gave-up', subject: taskId, taskId,
        title: `A landing gave up: board task ${clip(taskId, 60)}`,
        text: rebases
          ? `The landing of board task ${taskId} gave up: the target branch moved again after ${rebases} rebase(s); merge the branch by hand.`
          : `The landing of board task ${taskId} gave up${cause ? ` (${cause})` : ''}: its accepted result is not merged.`,
        act: taskAct(taskId),
      }], closes: [] }
    }
    default:
      return { drafts: [], closes }
  }
}

/** The operator page a hold's notice links to (the bundle's loopback /ui). */
export const UI_LINK = 'http://127.0.0.1:47317/ui/'

/** A review held for the operator, or its end, as `board.review.held` and `board.review.ended` record them. */
export interface HoldReading {
  held?: { taskId: string; project: string; expiresMs: number; checks: string[] }
  ended?: string
}

/** Read one event for the holds it starts or ends; anything else, or an event not read whole, means nothing. */
export function readHold(event: SystemEvent): HoldReading {
  const data = event.data ?? {}
  const taskId = id(data.taskId)
  if (!taskId) return {}
  if (event.type === 'board.review.ended') return { ended: taskId }
  if (event.type !== 'board.review.held') return {}
  const project = id(data.projectId)
  const expiresAt = time(data.expiresAt)
  if (!project || !expiresAt) return {}
  const checks = (Array.isArray(data.pendingChecks) ? data.pendingChecks : []).map(word).filter((c): c is string => c !== undefined).slice(0, 8)
  return { held: { taskId, project, expiresMs: Date.parse(expiresAt), checks } }
}

/**
 * `review.held`: told as the hold starts: the task, until when, where to decide it, and why it is
 * held, in that order, so a text cut at its bound keeps the task, the expiry, and the link whole
 * (the link is at most 300 characters, an id 200, and the checks come last).
 */
export function heldDraft(hold: NonNullable<HoldReading['held']>, link: string): Draft {
  return {
    kind: 'review.held', subject: hold.taskId, project: hold.project, taskId: hold.taskId,
    title: `Held for the operator: board task ${clip(hold.taskId, 60)}`,
    text: `The result of board task ${hold.taskId} is held for the operator until ${new Date(hold.expiresMs).toISOString()}; unanswered by then, the review expires. Decide it at ${link} . Why held: ${hold.checks.length ? `checks not reported: ${hold.checks.join(', ')}` : 'a heavy-tier result'}.`,
    act: taskAct(hold.taskId),
  }
}

/** `review.expiring`: told once, `hours` before the hold expires. */
export function expiringDraft(hold: { taskId: string; project: string; expiresMs: number }, now: number, link: string): Draft {
  const minutes = Math.max(1, Math.round((hold.expiresMs - now) / 60_000))
  return {
    kind: 'review.expiring', subject: hold.taskId, project: hold.project, taskId: hold.taskId,
    title: `A held result expires soon: board task ${clip(hold.taskId, 60)}`,
    text: `The review of board task ${hold.taskId} expires at ${new Date(hold.expiresMs).toISOString()}, in about ${minutes} min; unanswered, the task waits for input (review-expired). Decide it at ${link}.`,
    act: taskAct(hold.taskId),
  }
}

/** The notice a draft becomes, addressed to a project's lead; undefined when its time is none. */
export function makeNotice(draft: Draft, project: string, event: { seq: number; type: string; at: string }): LeadNotice | undefined {
  const at = time(event.at)
  if (!at) return undefined
  return {
    schema: KINDS_1_1.includes(draft.kind) ? 'lead-notice@1.1' : 'lead-notice@1.0', id: clip(`${project}:${draft.kind}:${draft.subject}:${event.seq}`, 300), project, to: `lead:${project}`, kind: draft.kind, subject: draft.subject, at,
    event: { seq: event.seq, type: event.type }, title: clip(draft.title, 120), text: clip(draft.text, 1000), act: draft.act.slice(0, 4).map((line) => clip(line, 300)),
    ...(draft.taskId ? { taskId: draft.taskId } : {}), ...(draft.commit ? { commit: draft.commit } : {}), ...(draft.changed ? { changed: clip(draft.changed, 200) } : {}),
  }
}
