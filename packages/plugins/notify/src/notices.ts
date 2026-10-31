/**
 * What one recorded event tells the operator (docs/design/notifications.md): a pure function from
 * an event-log entry to a `notification@1.0` notice, the reminder an approval request needs before
 * it expires, or the request a resolution ends. It reads only the ids, classes, kinds, and times the
 * producers put in their events, never a summary, prompt, answer, or command, and it cuts and
 * cleans every value it quotes. An event it cannot read whole makes no notice.
 * @module
 */
import type { SystemEvent } from '@tsuuanmi/system-ledger-core'

/** The notice kinds, in the order the design names them (`notification@1.x` `kind`; `review.expiring` since 1.1, `dispatch.started` since 1.2). */
export const KINDS = ['approval.opened', 'approval.expiring', 'run.user-action', 'run.escalated', 'run.waiting', 'pool.limited', 'worker.quarantined', 'review.expiring', 'dispatch.started', 'review.held'] as const
export type Kind = (typeof KINDS)[number]

/** `notification@1.0`, `@1.1` for a `review.expiring` notice, `@1.2` for a `dispatch.started` one, `@1.3` for a `review.held` one; the schema in `schemas/` is canonical. */
export interface Notice {
  schema: 'notification@1.0' | 'notification@1.1' | 'notification@1.2' | 'notification@1.3'
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
      text: `Board task ${taskId}${of} waits for your Accept or Reject, held for you until ${expiresAt}, in about ${minutes} min. Unanswered by then, the review expires: the task waits for input (review-expired), which only a re-opening revives (board_reopen_review).`,
      act: ['system ui', `MCP board_task {"taskId":"${taskId}"}`],
    })
  }
  return make({ seq: reminder.seq, type: 'approvals.requested', at: new Date(now).toISOString() }, options, 'approval.expiring', reminder.requestId, {
    title: reminder.policyChange ? 'A policy change expires soon' : `Approval expires soon: ${reminder.actionClass}`,
    text: `Request ${reminder.requestId}${of} (${reminder.actionClass}) is denied at ${expiresAt}, in about ${minutes} min, unless you answer it.`,
    act: approvalActs(reminder.requestId),
  })
}

/** A result held for the operator, or its end (`board.review.held`, `board.review.ended`), for the batched hold notice. */
interface HoldReading {
  held?: { taskId: string; projectId?: string; expiresMs: number }
  ended?: string
}

export function readHold(event: SystemEvent): HoldReading {
  const data = event.data ?? {}
  const taskId = id(data.taskId)
  if (!taskId) return {}
  if (event.type === 'board.review.ended') return { ended: taskId }
  if (event.type !== 'board.review.held') return {}
  const expiresAt = time(data.expiresAt)
  if (!expiresAt) return {}
  const projectId = id(data.projectId)
  return { held: { taskId, ...(projectId ? { projectId } : {}), expiresMs: Date.parse(expiresAt) } }
}

/** One hold of a batch. */
interface HoldLine { taskId: string; projectId?: string | null; expiresMs: number }

/** A notice's text, at most (`notification@1.x` `text`): a hold message is built to fit it, never cut. */
const TEXT_MAX = 1000

/** The batched hold message, and the holds it names: only those are told; the rest stay due. */
interface HoldsMessage {
  notice: Notice
  expiring: string[]
  held: string[]
}

/**
 * The one message of a sweep: the holds due, the expiring first (the soonest first), then the new
 * ones, each line whole (task, project, until when). Lines are added while the text stays within
 * {@link TEXT_MAX}; the holds that do not fit are counted in it ("N more ...") and are not named as
 * told, so the next message lists them. `due` counts every hold due, listed or not. A `review.held`
 * notice when it names a new hold, else `review.expiring`.
 */
export function holdsNotice(expiring: readonly HoldLine[], held: readonly HoldLine[], due: { expiring: number; held: number }, seq: number, now: number, options: ReadOptions): HoldsMessage | undefined {
  const line = (h: HoldLine): string => `${h.taskId}${h.projectId ? ` (${h.projectId})` : ''} until ${new Date(h.expiresMs).toISOString()}`
  const tail = ' Unanswered by its time, a review expires (review-expired).'
  const more = (n: number): string => ` ${n} more wait: on /ui now, and in the next message.`
  const budget = TEXT_MAX - tail.length - more(due.expiring + due.held).length
  const listed: { expiring: HoldLine[]; held: HoldLine[] } = { expiring: [], held: [] }
  const body = (): string => [
    ...(listed.expiring.length ? [`Expiring soon: ${listed.expiring.map(line).join('; ')}.`] : []),
    ...(listed.held.length ? [`Held for you: ${listed.held.map(line).join('; ')}.`] : []),
  ].join(' ')
  // The most urgent first; the first line that does not fit ends its sort, so none is listed out of turn.
  for (const [sort, lines] of [['expiring', expiring], ['held', held]] as const) {
    for (const h of lines) {
      listed[sort].push(h)
      if (body().length > budget) {
        listed[sort].pop()
        break
      }
    }
  }
  const count = listed.expiring.length + listed.held.length
  if (!count) return undefined
  const left = due.expiring + due.held - count
  const first = (listed.expiring[0] ?? listed.held[0])!
  const notice = make({ seq, type: 'board.review.held', at: new Date(now).toISOString() }, options, listed.held.length ? 'review.held' : 'review.expiring', 'holds', {
    title: `${due.held} result(s) newly held for you, ${due.expiring} expiring soon`,
    text: `${body()}${left > 0 ? more(left) : ''}${tail}`,
    act: ['system ui', `MCP board_task {"taskId":"${first.taskId}"}`],
  })
  return notice ? { notice, expiring: listed.expiring.map((h) => h.taskId), held: listed.held.map((h) => h.taskId) } : undefined
}

/** The operator's channels for a verdict: the queue on `/ui`, or MCP. */
const approvalActs = (requestId: string): string[] => ['system ui', `MCP approvals_get {"requestId":"${requestId}"}`, 'MCP approvals_decide']

function make(event: Pick<SystemEvent, 'seq' | 'type' | 'at'>, options: ReadOptions, kind: Kind, subject: string, body: { title: string; text: string; act: string[] }): Notice | undefined {
  const at = time(event.at)
  if (!at) return undefined
  return {
    schema: kind === 'review.held' ? 'notification@1.3' : kind === 'dispatch.started' ? 'notification@1.2' : kind === 'review.expiring' ? 'notification@1.1' : 'notification@1.0', id: clip(`${kind}:${subject}:${event.seq}`, 300), kind, subject, at, event: { seq: event.seq, type: event.type },
    title: clip(body.title, 120), text: clip(body.text, 1000), act: body.act.slice(0, 4).map((line) => clip(line, 300)),
    ...(options.link ? { link: options.link } : {}),
  }
}

/** A desktop notification's body: the text, each command on its own line, then the link. */
export const desktopBody = (notice: Notice): string => [notice.text, ...notice.act.map((line) => `→ ${line}`), ...(notice.link ? [notice.link] : [])].join('\n')
