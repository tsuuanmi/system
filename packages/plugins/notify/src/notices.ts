/**
 * What one recorded event tells the operator (docs/design/notifications.md): a pure function from
 * an event-log entry to a `notification@1.0` notice, the reminder an approval request needs before
 * it expires, or the request a resolution ends. It reads only the ids, classes, kinds, and times the
 * producers put in their events, never a summary, prompt, answer, or command, and it cuts and
 * cleans every value it quotes. An event it cannot read whole makes no notice.
 * @module
 */
import type { SystemEvent } from '@tsuuanmi/system-event-log'

/** The notice kinds, in the order the design names them (`notification@1.x` `kind`; `review.expiring` since 1.1, `dispatch.started` since 1.2). */
export const KINDS = ['approval.opened', 'approval.expiring', 'run.user-action', 'run.escalated', 'run.waiting', 'pool.limited', 'worker.quarantined', 'review.expiring', 'dispatch.started'] as const
export type Kind = (typeof KINDS)[number]

/** `notification@1.0`, `@1.1` for a `review.expiring` notice, `@1.2` for a `dispatch.started` one; the schema in `schemas/` is canonical. */
export interface Notice {
  schema: 'notification@1.0' | 'notification@1.1' | 'notification@1.2'
  id: string
  kind: Kind
  subject: string
  at: string
  event: { seq: number; type: string }
  title: string
  text: string
  act: string[]
  link?: string
}

/**
 * A reminder an open approval request needs, made from its `approvals.requested` event; or, with
 * `review`, one a board task's review held for the operator needs, made from its
 * `board.review.held` event, keyed `review:<taskId>`.
 */
export interface Reminder {
  /** The key the reminder is kept and forgotten by: the request id, or `review:<taskId>`. */
  requestId: string
  /** When the reminder is due: the expiry less the lead time. */
  remindMs: number
  expiresMs: number
  /** The event it comes from. */
  seq: number
  actionClass: string
  projectId?: string
  policyChange: boolean
  /** A review held for the operator: the task it holds. */
  review?: { taskId: string }
}

/** The key a review held for the operator is reminded under, beside the approval requests' ids. */
const reviewKey = (taskId: string): string => `review:${taskId}`

/** What one event means to the notifier: a notice, a reminder to keep, or a request to forget. */
export interface Reading {
  notice?: Notice
  remind?: Reminder
  resolved?: string
}

/** An id as `common@1` defines it. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
/** A word a producer names: a class, kind, tier, reason, or window. */
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/

const id = (value: unknown): string | undefined => (typeof value === 'string' && ID.test(value) ? value : undefined)
const word = (value: unknown): string | undefined => (typeof value === 'string' && WORD.test(value) ? value : undefined)
/** A time as UTC ISO, or undefined when it is none. */
const time = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The `approvals.requested` reminder lead and the link every notice carries. */
export interface ReadOptions {
  leadMs: number
  link?: string | undefined
}

/** Read one event; anything it does not name, or cannot read whole, means nothing. */
export function readEvent(event: SystemEvent, options: ReadOptions): Reading {
  const data = event.data ?? {}
  switch (event.type) {
    case 'approvals.requested': {
      const requestId = id(data.requestId)
      const actionClass = word(data.actionClass)
      const expiresAt = time(data.expiresAt)
      if (!requestId || !actionClass || !expiresAt) return {}
      const projectId = id(data.projectId)
      const policyChange = data.policyChangeId !== undefined
      const component = word(data.component)
      const of = `${projectId ? ` of project ${projectId}` : ''}`
      const notice = make(event, options, 'approval.opened', requestId, {
        title: policyChange ? 'A policy change waits for your approval' : `Approval needed: ${actionClass}`,
        text: `Request ${requestId}${of} (${actionClass}${component ? `, asked by ${component}` : ''}) waits for your verdict. Unanswered, it is denied at ${expiresAt}.`,
        act: approvalActs(requestId),
      })
      const expiresMs = Date.parse(expiresAt)
      const remindMs = expiresMs - options.leadMs
      // A request that expires within the lead time from its making is told once, as it opens.
      const remind = remindMs > Date.parse(event.at)
        ? { requestId, remindMs, expiresMs, seq: event.seq, actionClass, ...(projectId ? { projectId } : {}), policyChange }
        : undefined
      return { ...(notice ? { notice } : {}), ...(remind ? { remind } : {}) }
    }
    case 'approvals.resolved': {
      const requestId = id(data.requestId)
      return requestId ? { resolved: requestId } : {}
    }
    case 'board.review.held': {
      // A review only the operator may accept now: told `expiryLeadMinutes` before it expires, or at
      // once when it expires sooner than that, since a hold has no notice of its own.
      const taskId = id(data.taskId)
      const expiresAt = time(data.expiresAt)
      if (!taskId || !expiresAt) return {}
      const projectId = id(data.projectId)
      const expiresMs = Date.parse(expiresAt)
      const remindMs = Math.max(expiresMs - options.leadMs, Date.parse(event.at))
      return { remind: { requestId: reviewKey(taskId), remindMs, expiresMs, seq: event.seq, actionClass: 'review', ...(projectId ? { projectId } : {}), policyChange: false, review: { taskId } } }
    }
    case 'board.review.ended': {
      const taskId = id(data.taskId)
      return taskId ? { resolved: reviewKey(taskId) } : {}
    }
    case 'workflow.node.failed':
    case 'workflow.run.failed': {
      if (data.disposition !== 'USER_ACTION') return {}
      const runId = id(event.runId)
      if (!runId) return {}
      const nodeId = event.type === 'workflow.node.failed' ? id(event.nodeId) : undefined
      const kind = word(data.kind) ?? 'a failure'
      const notice = make(event, options, 'run.user-action', runId, {
        title: `Run ${clip(runId, 80)} needs you`,
        text: nodeId
          ? `Step ${nodeId} failed as ${kind} (USER_ACTION): nothing more runs on its own until you act.`
          : `The run failed as ${kind} (USER_ACTION): nothing more runs on its own until you act.`,
        act: [`system explain ${runId}`, ...(nodeId ? [`system continue ${runId} ${nodeId}`] : []), 'system ui'],
      })
      return notice ? { notice } : {}
    }
    case 'workflow.node.escalated': {
      const runId = id(event.runId)
      const nodeId = id(event.nodeId)
      if (!runId || !nodeId) return {}
      const from = word(data.from)
      const to = word(data.to)
      const notice = make(event, options, 'run.escalated', runId, {
        title: `Run ${clip(runId, 80)} escalated`,
        text: `Step ${nodeId}'s result was rejected, so it runs again at a higher tier${from && to ? ` (${from} to ${to})` : ''}.`,
        act: [`system explain ${runId}`, `system stop ${runId}`],
      })
      return notice ? { notice } : {}
    }
    case 'workflow.node.waiting': {
      const runId = id(event.runId)
      const nodeId = id(event.nodeId)
      const until = time(data.until)
      if (!runId || !nodeId || !until) return {}
      const notice = make(event, options, 'run.waiting', runId, {
        title: `Run ${clip(runId, 80)} waits for an account's limit`,
        text: `Step ${nodeId} waits until ${until} for its assigned account's limit to reset; nothing is sent, and no attempt is spent, meanwhile.`,
        act: [`system explain ${runId}`, 'system account list', `system stop ${runId}`],
      })
      return notice ? { notice } : {}
    }
    case 'workflow.dispatch.notice': {
      // PROP-0014 D2: the project's policy gives dispatch notify, so System started this run by itself and tells it.
      const runId = id(data.runId) ?? id(event.runId)
      const taskId = id(data.taskId)
      if (!runId || !taskId) return {}
      const projectId = id(data.projectId)
      const worker = id(data.worker)
      const attempt = typeof data.attempt === 'number' && Number.isInteger(data.attempt) && data.attempt > 0 ? data.attempt : undefined
      const notice = make(event, options, 'dispatch.started', runId, {
        title: `Started by itself: board task ${clip(taskId, 60)}`,
        text: `System started ${attempt ? `attempt ${attempt} of ` : ''}board task ${taskId}${projectId ? ` of project ${projectId}` : ''}${worker ? ` on ${worker}` : ''} (run ${runId}), as the project's policy gives dispatch notify. Nothing lands without your merge approval.`,
        act: [`system explain ${runId}`, `system stop ${runId}`, `system dispatch pause${projectId ? ` --project ${projectId}` : ''}`],
      })
      return notice ? { notice } : {}
    }
    case 'resources.pool.limited': {
      const pool = id(data.pool)
      const until = time(data.until)
      if (!pool || !until) return {}
      const window = word(data.window)
      const account = id(data.account)
      const notice = make(event, options, 'pool.limited', pool, {
        title: `Pool ${clip(pool, 80)} closed at its limit`,
        text: `${window ? `Window ${window}` : 'A window'}${account ? ` of account ${account}` : ''} reads limited until ${until}: no new work draws on the pool before then.`,
        act: ['system health', 'MCP resources_pools'],
      })
      return notice ? { notice } : {}
    }
    case 'agent-workers.account.quarantined': {
      const provider = word(data.provider)
      const slot = typeof data.slot === 'number' && Number.isInteger(data.slot) && data.slot > 0 ? data.slot : undefined
      const reason = word(data.reason)
      if (!provider || !slot || !reason) return {}
      const accountId = id(data.accountId)
      const subject = accountId ?? `${provider}:slot-${slot}`
      const workers = (Array.isArray(data.workers) ? data.workers : []).map(id).filter((w): w is string => w !== undefined)
      const named = accountId ?? `slot ${slot} of ${provider}`
      const notice = make(event, options, 'worker.quarantined', subject, {
        title: `Agent account quarantined (${reason})`,
        text: clip(`${named} is quarantined (${reason}): ${workers.length ? `its Workers ${workers.join(', ')} take` : 'its Workers take'} no work until you resolve it.`, 1000),
        act: ['system account list', reason === 'changed' ? `system account verify ${provider} --slot ${slot} --accept` : `system account verify ${accountId ?? `${provider} --slot ${slot}`}`, `system account login ${accountId ?? `${provider} --slot ${slot}`}`],
      })
      return notice ? { notice } : {}
    }
    default:
      return {}
  }
}

/** The reminder of an open request, or of a review held for the operator, made when it is due. */
export function reminderNotice(reminder: Reminder, now: number, options: ReadOptions): Notice | undefined {
  const minutes = Math.max(1, Math.round((reminder.expiresMs - now) / 60_000))
  const expiresAt = new Date(reminder.expiresMs).toISOString()
  const of = reminder.projectId ? ` of project ${reminder.projectId}` : ''
  if (reminder.review) {
    const taskId = reminder.review.taskId
    return make({ seq: reminder.seq, type: 'board.review.held', at: new Date(now).toISOString() }, options, 'review.expiring', taskId, {
      title: `A review expires soon: board task ${clip(taskId, 60)}`,
      text: `Board task ${taskId}${of} waits for your Accept or Reject, held for you until ${expiresAt}, in about ${minutes} min. Unanswered by then, the review expires: the task waits for input (review-expired), which nothing revives.`,
      act: ['system ui', `MCP board_task {"taskId":"${taskId}"}`],
    })
  }
  return make({ seq: reminder.seq, type: 'approvals.requested', at: new Date(now).toISOString() }, options, 'approval.expiring', reminder.requestId, {
    title: reminder.policyChange ? 'A policy change expires soon' : `Approval expires soon: ${reminder.actionClass}`,
    text: `Request ${reminder.requestId}${of} (${reminder.actionClass}) is denied at ${expiresAt}, in about ${minutes} min, unless you answer it.`,
    act: approvalActs(reminder.requestId),
  })
}

/** The operator's channels for a verdict: the queue on `/ui`, or MCP. */
const approvalActs = (requestId: string): string[] => ['system ui', `MCP approvals_get {"requestId":"${requestId}"}`, 'MCP approvals_decide']

function make(event: Pick<SystemEvent, 'seq' | 'type' | 'at'>, options: ReadOptions, kind: Kind, subject: string, body: { title: string; text: string; act: string[] }): Notice | undefined {
  const at = time(event.at)
  if (!at) return undefined
  return {
    schema: kind === 'dispatch.started' ? 'notification@1.2' : kind === 'review.expiring' ? 'notification@1.1' : 'notification@1.0', id: clip(`${kind}:${subject}:${event.seq}`, 300), kind, subject, at, event: { seq: event.seq, type: event.type },
    title: clip(body.title, 120), text: clip(body.text, 1000), act: body.act.slice(0, 4).map((line) => clip(line, 300)),
    ...(options.link ? { link: options.link } : {}),
  }
}

/** A desktop notification's body: the text, each command on its own line, then the link. */
export const desktopBody = (notice: Notice): string => [notice.text, ...notice.act.map((line) => `→ ${line}`), ...(notice.link ? [notice.link] : [])].join('\n')
