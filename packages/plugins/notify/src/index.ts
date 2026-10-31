/**
 * Out-of-band notifications to the operator (PROP-0010 B5, docs/design/notifications.md): a surface
 * plugin that reads the event log after its own cursor and tells the operator what needs them, an
 * approval request opened or close to its expiry (unanswered, it is denied), a board task's review
 * held for the operator close to its expiry, a run that failed for the operator or was escalated, a
 * step waiting for an account's limit, a pool closed at its limit, an agent account quarantined,
 * with the exact command to act. It reads recorded events only,
 * never blocks or changes the producer of one (it reads after the commit, on its own clock), and
 * decides nothing. At most one notice per subject and kind per window; a bounded queue; one attempt
 * per sink, each outcome a `notify.delivery` event that health reads. Off by default in the bundle.
 * @module @tsuuanmi/system-notify
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import type { SystemEvent } from '@tsuuanmi/system-ledger-core'
import type {} from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import { holdsNotice, KINDS, type Kind, type Notice, type ReadOptions, readEvent, readHold, type Reminder, reminderNotice } from './notices.ts'
import { DESKTOP_COMMAND, DesktopSink, onPath, type Sink, WebhookSink, webhookProblem } from './sinks.ts'

export { desktopBody, KINDS, type Kind, type Notice, readEvent, type Reminder, reminderNotice } from './notices.ts'
export { DESKTOP_COMMAND, DesktopSink, onPath, type Outcome, type Sink, WebhookSink, webhookProblem } from './sinks.ts'

export const name = 'notify'
export const inject = ['store', 'eventLog']

/** The event every delivery outcome is recorded as; health reads it (`notifications`). */
export const DELIVERY_EVENT = 'notify.delivery'
/** Event-log entries one pass reads at most (INV-9): a longer backlog is read by the next passes, at once. */
const PAGE = 1000
const PAGES_PER_PASS = 10
/** Reminders kept at most (INV-9): one per open approval request, which the queue's own policies bound. */
export const MAX_REMINDERS = 10_000

export interface Config {
  /** The kinds of notice sent (default: every kind). */
  kinds?: Kind[]
  /** How long before an open approval request, or a review held for the operator, expires it is notified again, in minutes (default 60). */
  expiryLeadMinutes?: number
  /** At most one notice per subject and kind in this many minutes (default 10). */
  dedupMinutes?: number
  /** Notices waiting to be sent, at most; one more is dropped and recorded (default 50). */
  maxQueue?: number
  /** How often the event log and the reminders are read, in seconds, beside each new event (default 15). */
  pollSeconds?: number
  /** The longest one delivery to one sink may take, in seconds (default 10). */
  timeoutSeconds?: number
  /** An event older than this when read makes no notice (a host or row that was off), in minutes (default 60). */
  maxAgeMinutes?: number
  /** The operator page each notice links to, without its token (default the bundle's loopback /ui). */
  link?: string
  /** `on`: results held for the operator are sent as `review.held` and `review.expiring`, one batched message per sweep (default off). */
  holds?: 'off' | 'on'
  /** A held result is told as expiring this many hours before its hold expires (default 4). */
  holdsLeadHours?: number
  /** Batched hold messages sent at most this many per hour; what is over waits for the next hour (default 4). */
  holdsPerHour?: number
  /** Desktop notifications through notify-send (default true). */
  desktop?: boolean
  /** The webhook: off unless enabled; its URL is read from the credential reference, never from here. */
  webhook?: { enabled?: boolean; credential?: string }
}

export const DEFAULTS = {
  holdsLeadHours: 4, holdsPerHour: 4, expiryLeadMinutes: 60, dedupMinutes: 10, maxQueue: 50, pollSeconds: 15, timeoutSeconds: 10, maxAgeMinutes: 60,
  link: 'http://127.0.0.1:47317/ui/', credential: 'SYSTEM_NOTIFY_WEBHOOK_URL',
} as const

export const Config: z<Config> = z.object({
  kinds: z.array(z.union([...KINDS])).default([...KINDS]).description('The kinds of notice sent: approval.opened, approval.expiring, run.user-action, run.escalated, run.waiting, pool.limited, worker.quarantined, review.expiring, dispatch.started'),
  holds: z.union(['off', 'on']).default('off').description('on: results held for the operator are sent to the sinks as review.held and review.expiring, one batched message per sweep, at most holdsPerHour an hour; off: none is'),
  holdsLeadHours: z.natural().min(1).max(168).default(DEFAULTS.holdsLeadHours).description('With holds on, a held result is told as expiring this many hours before its hold expires, once'),
  holdsPerHour: z.natural().min(1).max(60).default(DEFAULTS.holdsPerHour).description('With holds on, the batched hold messages sent in an hour, at most; what is over waits for the next hour'),
  expiryLeadMinutes: z.natural().min(1).max(1440).default(DEFAULTS.expiryLeadMinutes).description('How long before an open approval request expires (and is denied), or a review held for the operator expires, it is notified again, in minutes'),
  dedupMinutes: z.natural().min(1).max(1440).default(DEFAULTS.dedupMinutes).description('At most one notice per subject and kind in this many minutes'),
  maxQueue: z.natural().min(1).max(1000).default(DEFAULTS.maxQueue).description('Notices waiting to be sent, at most; one more is dropped, logged, and shown in health'),
  pollSeconds: z.natural().min(1).max(3600).default(DEFAULTS.pollSeconds).description('How often the event log and the reminders are read, in seconds, beside each new event'),
  timeoutSeconds: z.natural().min(1).max(60).default(DEFAULTS.timeoutSeconds).description('The longest one delivery to one sink may take, in seconds; it is not retried'),
  maxAgeMinutes: z.natural().min(1).max(10_080).default(DEFAULTS.maxAgeMinutes).description('An event older than this when read makes no notice (a host or row that was off), in minutes; an open request\'s expiry reminder is kept'),
  link: z.string().default(DEFAULTS.link).description('The operator page each notice links to, without its token (an http or https URL)'),
  desktop: z.boolean().default(true).description('Desktop notifications through notify-send; without it on PATH, a no-op that health shows'),
  webhook: z.object({
    enabled: z.boolean().default(false).description('POST each notice as notification@1.0 JSON; needs egress declared for the webhook class in the egress row'),
    credential: z.string().default(DEFAULTS.credential).description('The credential reference the webhook URL is stored under (system notify webhook); the URL is never configuration'),
  }).default({}).description('The webhook sink, off by default'),
}) as unknown as z<Config>

/** Every problem of a configuration that the schema cannot state. */
export function configProblems(config: Config): string[] {
  const problems: string[] = []
  const link = config.link ?? DEFAULTS.link
  try {
    const url = new URL(link)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') problems.push('link must be an http or https URL')
    if (url.hash || url.username || url.password) problems.push('link must carry no fragment, user, or password: the token stays out of notices')
  } catch {
    problems.push(`link is not a URL: ${link}`)
  }
  const ref = config.webhook?.credential ?? DEFAULTS.credential
  if (!isCredentialRefName(ref)) problems.push(`webhook.credential must be a credential reference (an UPPER_SNAKE name), not ${ref}`)
  if (!(config.kinds ?? KINDS).length) problems.push('kinds is empty: turn the notify row off instead')
  return problems
}

const MIGRATIONS = [{
  version: 1,
  sql: `CREATE TABLE notify_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
  CREATE TABLE notify_sent (kind TEXT NOT NULL, subject TEXT NOT NULL, sent_ms INTEGER NOT NULL, PRIMARY KEY (kind, subject));
  CREATE INDEX notify_sent_at ON notify_sent (sent_ms);
  CREATE TABLE notify_reminders (request_id TEXT PRIMARY KEY, remind_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, reminder TEXT NOT NULL);
  CREATE INDEX notify_reminders_due ON notify_reminders (remind_ms);`,
}, {
  version: 2,
  sql: `CREATE TABLE notify_holds (task_id TEXT PRIMARY KEY, project TEXT, expires_ms INTEGER NOT NULL, since_ms INTEGER NOT NULL, told INTEGER NOT NULL DEFAULT 0, expiring INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE notify_hold_batches (sent_ms INTEGER NOT NULL);`,
}]

const schemas = new SchemaRegistry()

/** Holds one batch reads at most (INV-9); past them, the rest are counted and wait for the next. */
const HOLDS_READ = 1000

/** A result held for the operator now, as the board shows it. */
export interface HeldNow { taskId: string; projectId: string; expiresMs: number }

/** What the notifier asks of the rest of the host, replaceable by a test. */
export interface Sources {
  /** Every result held for the operator now (the board's tasks in review, waiting on operator-review); undefined when it cannot be read whole. */
  holds(): Promise<HeldNow[] | undefined>
}

/** The holds the board shows now, read through the optional board row; undefined without it, or past {@link HOLDS_READ}. */
export function boardHolds(ctx: Context): Sources['holds'] {
  return async () => {
    type Task = { taskId: string; projectId: string; state: string; waiting?: { reason: string; expiresAt?: string } }
    const board = ctx.get('board' as never) as { projects?: () => Promise<Array<{ projectId: string; state: string }>>; tasks?: (filter: { projectId: string; states: string[] }) => Promise<Task[]> } | undefined
    if (!board?.projects || !board.tasks) return undefined
    const out: HeldNow[] = []
    for (const project of (await board.projects()).filter((p) => p.state !== 'closed')) {
      for (const t of await board.tasks({ projectId: project.projectId, states: ['review'] })) {
        const expiresMs = t.waiting?.reason === 'operator-review' && t.waiting.expiresAt ? Date.parse(t.waiting.expiresAt) : Number.NaN
        if (Number.isFinite(expiresMs)) out.push({ taskId: t.taskId, projectId: t.projectId, expiresMs })
        if (out.length > HOLDS_READ) return undefined
      }
    }
    return out
  }
}

/** The notifier of one plugin instance: its passes over the log, its queue, and its sinks. */
export class Notifier {
  readonly sources: Sources
  private readonly kinds: ReadonlySet<Kind>
  private readonly read: ReadOptions
  private readonly dedupMs: number
  private readonly maxAgeMs: number
  private readonly maxQueue: number
  private readonly holds: boolean
  private readonly holdsLeadMs: number
  private readonly holdsPerHour: number
  private readonly queue: Notice[] = []
  private readonly abort = new AbortController()
  private passing = false
  private again = false
  private sending: Promise<void> | undefined
  private disposed = false

  constructor(private readonly ctx: Context, config: Config, readonly sinks: readonly Sink[]) {
    this.kinds = new Set(config.kinds ?? KINDS)
    this.read = { leadMs: (config.expiryLeadMinutes ?? DEFAULTS.expiryLeadMinutes) * 60_000, link: config.link ?? DEFAULTS.link }
    this.dedupMs = (config.dedupMinutes ?? DEFAULTS.dedupMinutes) * 60_000
    this.maxAgeMs = (config.maxAgeMinutes ?? DEFAULTS.maxAgeMinutes) * 60_000
    this.maxQueue = config.maxQueue ?? DEFAULTS.maxQueue
    this.holds = config.holds === 'on'
    this.holdsLeadMs = (config.holdsLeadHours ?? DEFAULTS.holdsLeadHours) * 3_600_000
    this.holdsPerHour = config.holdsPerHour ?? DEFAULTS.holdsPerHour
    this.sources = { holds: boardHolds(ctx) }
    ctx.store.migrate('notify', MIGRATIONS)
  }

  /** Notices waiting to be sent. */
  get pending(): number {
    return this.queue.length
  }

  /** Replace what the notifier asks of the host (tests, or a host that reads it another way). */
  use(sources: Partial<Sources>): void {
    Object.assign(this.sources, sources)
  }

  /**
   * With holds on, reconcile the holds kept with the ones the board shows now (T357): a hold the
   * event log did not tell this notifier (held before the upgrade, or while it was off) is kept and
   * so told; one the board no longer holds, and that was kept before this read began, is forgotten.
   * Nothing is sent here; the next pass does. A board that cannot be read changes nothing.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.disposed || !this.holds) return
    let holds: HeldNow[] | undefined
    try {
      holds = await this.sources.holds()
    } catch (error) {
      this.ctx.logger.warn(`notify: the holds could not be read from the board this time: ${(error as Error).message}`)
    }
    if (!holds || this.disposed) return
    try {
      this.ctx.store.transaction((db) => {
        const shown = new Set(holds.map((h) => h.taskId))
        db.prepare(`DELETE FROM notify_holds WHERE since_ms < ? AND task_id NOT IN (${holds.map(() => '?').join(', ') || "''"})`).run(now, ...shown)
        for (const h of holds) if (h.expiresMs > now) this.keepHold(h.taskId, h.projectId, h.expiresMs, now)
      })
    } catch (error) {
      this.ctx.logger.warn(`notify: the holds could not be reconciled this time: ${(error as Error).message}`)
    }
  }

  /** Keep a hold; a known one with the same expiry stays as it is, one held again (another expiry) is due again. */
  private keepHold(taskId: string, projectId: string | null, expiresMs: number, now: number): void {
    const db = this.ctx.store.db
    const known = db.prepare('SELECT expires_ms FROM notify_holds WHERE task_id = ?').get(taskId) as { expires_ms: number } | undefined
    if (known?.expires_ms === expiresMs) return
    if (!known && (db.prepare('SELECT COUNT(*) AS n FROM notify_holds').get() as { n: number }).n >= MAX_REMINDERS) {
      this.ctx.logger.warn(`notify: ${MAX_REMINDERS} holds are kept already; the hold of ${taskId} is not told`)
      return
    }
    db.prepare('INSERT INTO notify_holds (task_id, project, expires_ms, since_ms) VALUES (?, ?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET project = excluded.project, expires_ms = excluded.expires_ms, since_ms = excluded.since_ms, told = 0, expiring = 0').run(taskId, projectId, expiresMs, now)
  }

  /**
   * One pass: the events after the cursor (at most {@link PAGES_PER_PASS} pages), then the reminders
   * due; the cursor, the reminders, and each notice's claim on its window move in one transaction,
   * and the notices it makes are queued after it commits. A pass that fails changes nothing and is
   * logged; the next one reads the same events again. True when the backlog is not read to its end.
   */
  pass(now: number = Date.now()): boolean {
    if (this.disposed) return false
    if (this.passing) {
      this.again = true
      return false
    }
    this.passing = true
    let more = false
    try {
      const made: Notice[] = []
      this.ctx.store.transaction((db) => {
        let cursor = (db.prepare('SELECT seq FROM notify_cursor WHERE id = 1').get() as { seq: number } | undefined)?.seq ?? 0
        const start = cursor
        for (let page = 0; page < PAGES_PER_PASS; page++) {
          const events = this.ctx.eventLog.query({ afterSeq: cursor, limit: PAGE })
          for (const event of events) this.consume(event, now, made)
          if (events.length) cursor = events.at(-1)!.seq
          if (events.length < PAGE) break
          if (page === PAGES_PER_PASS - 1) more = true
        }
        if (cursor !== start) db.prepare('INSERT INTO notify_cursor (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq').run(cursor)
        // Reminders due: each once, and only while its request is still open by the log.
        const due = db.prepare('SELECT request_id, expires_ms, reminder FROM notify_reminders WHERE remind_ms <= ? ORDER BY remind_ms LIMIT ?').all(now, PAGE) as Array<{ request_id: string; expires_ms: number; reminder: string }>
        for (const row of due) {
          db.prepare('DELETE FROM notify_reminders WHERE request_id = ?').run(row.request_id)
          const reminder = JSON.parse(row.reminder) as Reminder
          // With holds on, a review's expiry is told in the batched hold message instead.
          if (row.expires_ms > now && !(reminder.review && this.holds) && this.kinds.has(reminder.review ? 'review.expiring' : 'approval.expiring')) {
            const notice = reminderNotice(reminder, now, this.read)
            if (notice) made.push(notice)
          }
        }
        // Bounded (INV-9): claims past their window, and reminders past their request's expiry, go.
        db.prepare('DELETE FROM notify_sent WHERE sent_ms <= ?').run(now - this.dedupMs)
        db.prepare('DELETE FROM notify_reminders WHERE expires_ms <= ?').run(now)
        db.prepare('DELETE FROM notify_holds WHERE expires_ms <= ?').run(now)
        const queued: Notice[] = []
        if (this.holds) {
          const batch = this.holdsBatch(Math.max(cursor, 1), now, this.queue.length)
          if (batch) queued.push(batch)
        }
        for (const notice of made) {
          const claimed = db.prepare('SELECT sent_ms FROM notify_sent WHERE kind = ? AND subject = ?').get(notice.kind, notice.subject) as { sent_ms: number } | undefined
          if (claimed && claimed.sent_ms > now - this.dedupMs) continue
          if (this.queue.length + queued.length >= this.maxQueue) {
            this.delivery({ outcome: 'dropped', kind: notice.kind, subject: notice.subject, notice: notice.id, reason: `the queue holds ${this.maxQueue} notices (maxQueue)` })
            continue
          }
          db.prepare('INSERT INTO notify_sent (kind, subject, sent_ms) VALUES (?, ?, ?) ON CONFLICT (kind, subject) DO UPDATE SET sent_ms = excluded.sent_ms').run(notice.kind, notice.subject, now)
          queued.push(notice)
        }
        this.ctx.store.afterCommit(() => {
          this.queue.push(...queued)
          this.drain()
        })
      })
    } catch (error) {
      this.ctx.logger.warn(`notify: a pass over the event log failed, and the next one reads it again: ${(error as Error).message}`)
    } finally {
      this.passing = false
    }
    if (this.again) {
      this.again = false
      more = true
    }
    return more
  }

  /**
   * The sweep's one hold message (T357), inside the pass's transaction: every hold not yet told, and
   * every one within `holdsLeadHours` of its expiry not yet told as expiring (each once per hold), as
   * one notice; none when nothing is due, the hour's budget is spent, or the queue is full. A hold that
   * is left out stays due for the next sweep. Holds that expired are forgotten.
   */
  private holdsBatch(seq: number, now: number, queueLength: number): Notice | undefined {
    const db = this.ctx.store.db
    db.prepare('DELETE FROM notify_hold_batches WHERE sent_ms <= ?').run(now - 3_600_000)
    const sent = (db.prepare('SELECT COUNT(*) AS n FROM notify_hold_batches').get() as { n: number }).n
    if (sent >= this.holdsPerHour || queueLength >= this.maxQueue) return undefined
    type Row = { task_id: string; project: string | null; expires_ms: number }
    const line = (r: Row) => ({ taskId: r.task_id, projectId: r.project, expiresMs: r.expires_ms })
    const count = (sql: string, ...args: number[]): number => (db.prepare(`SELECT COUNT(*) AS n FROM notify_holds WHERE ${sql}`).get(...args) as { n: number }).n
    const rows = (sql: string, ...args: number[]): Row[] => db.prepare(`SELECT task_id, project, expires_ms FROM notify_holds WHERE ${sql} ORDER BY expires_ms, task_id LIMIT ?`).all(...args, HOLDS_READ) as Row[]
    const NEW = 'told = 0'
    const EXPIRING = 'expiring = 0 AND expires_ms - ? <= ?'
    const onHeld = this.kinds.has('review.held')
    const onExpiring = this.kinds.has('review.expiring')
    const due = { expiring: onExpiring ? count(EXPIRING, this.holdsLeadMs, now) : 0, held: onHeld ? count(NEW) : 0 }
    const message = holdsNotice(onExpiring ? rows(EXPIRING, this.holdsLeadMs, now).map(line) : [], onHeld ? rows(NEW).map(line) : [], due, seq, now, this.read)
    if (!message) return undefined
    try {
      schemas.assert('notification@1.3', message.notice)
    } catch (error) {
      this.ctx.logger.warn(`notify: the hold notice is not a valid notification@1.3 and is not sent: ${(error as Error).message}`)
      return undefined
    }
    // Only the holds the message names are told; the rest stay due for the next one.
    for (const taskId of message.held) db.prepare('UPDATE notify_holds SET told = 1 WHERE task_id = ?').run(taskId)
    for (const taskId of message.expiring) db.prepare('UPDATE notify_holds SET expiring = 1, told = 1 WHERE task_id = ?').run(taskId)
    db.prepare('INSERT INTO notify_hold_batches (sent_ms) VALUES (?)').run(now)
    return message.notice
  }

  /** One event: a notice to make, a reminder to keep, or a request to forget. */
  private consume(event: SystemEvent, now: number, made: Notice[]): void {
    // Holds are kept whether or not `holds` is on, so turning it on tells the ones held meanwhile.
    const hold = readHold(event)
    if (hold.ended) this.ctx.store.db.prepare('DELETE FROM notify_holds WHERE task_id = ?').run(hold.ended)
    if (hold.held && hold.held.expiresMs > now) this.keepHold(hold.held.taskId, hold.held.projectId ?? null, hold.held.expiresMs, now)
    // Its own events, and every other plugin's it does not read, mean nothing here.
    const reading = readEvent(event, this.read)
    const db = this.ctx.store.db
    if (reading.resolved) db.prepare('DELETE FROM notify_reminders WHERE request_id = ?').run(reading.resolved)
    if (reading.remind && reading.remind.expiresMs > now) {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM notify_reminders').get() as { n: number }).n
      if (count >= MAX_REMINDERS) this.ctx.logger.warn(`notify: ${MAX_REMINDERS} expiry reminders are kept already; request ${reading.remind.requestId} gets none`)
      else db.prepare('INSERT INTO notify_reminders (request_id, remind_ms, expires_ms, reminder) VALUES (?, ?, ?, ?) ON CONFLICT (request_id) DO NOTHING').run(reading.remind.requestId, reading.remind.remindMs, reading.remind.expiresMs, JSON.stringify(reading.remind))
    }
    const notice = reading.notice
    if (!notice || !this.kinds.has(notice.kind)) return
    if (now - Date.parse(event.at) > this.maxAgeMs) return
    try {
      schemas.assert('notification@1.0', notice)
    } catch (error) {
      // A defect, never a notice that says less than its schema promises (INV-14).
      this.ctx.logger.warn(`notify: the notice of event ${event.seq} (${event.type}) is not a valid notification@1.0 and is not sent: ${(error as Error).message}`)
      return
    }
    made.push(notice)
  }

  /** Send what is queued, one notice at a time, to every sink; each outcome is recorded. */
  private drain(): void {
    if (this.sending || this.disposed) return
    this.sending = (async () => {
      while (this.queue.length && !this.disposed) {
        const notice = this.queue.shift()!
        for (const sink of this.sinks) {
          const outcome = await sink.send(notice, this.abort.signal).catch((error: unknown) => ({ sent: false as const, reason: `the ${sink.name} sink failed: ${(error as Error).message}` }))
          if (this.disposed) return
          if (!outcome.sent) this.ctx.logger.warn(`notify: the ${notice.kind} notice of ${notice.subject} was not sent to ${sink.name}: ${outcome.reason}`)
          this.delivery({ outcome: outcome.sent ? 'sent' : 'failed', sink: sink.name, kind: notice.kind, subject: notice.subject, notice: notice.id, ...(outcome.sent ? {} : { reason: outcome.reason }) })
        }
      }
    })().finally(() => {
      this.sending = undefined
      if (this.queue.length && !this.disposed) this.drain()
    })
  }

  /** Record one outcome; an append that fails is logged, never thrown. */
  delivery(data: { outcome: 'sent' | 'failed' | 'dropped' | 'unavailable'; sink?: string; kind?: Kind; subject?: string; notice?: string; reason?: string }): void {
    try {
      this.ctx.eventLog.append({ type: DELIVERY_EVENT, data })
    } catch (error) {
      this.ctx.logger.warn(`notify: a ${data.outcome} delivery was not recorded: ${(error as Error).message}`)
    }
  }

  /** Wait for the notice being sent, if any (tests, disposal). */
  async idle(): Promise<void> {
    while (this.sending) await this.sending
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    if (this.queue.length) this.ctx.logger.warn(`notify: ${this.queue.length} queued notice(s) were not sent before the plugin stopped`)
    this.queue.length = 0
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const problems = configProblems(config)
  if (problems.length) throw new Error(`notify: ${problems.join('; ')}`)
  const timeoutMs = (config.timeoutSeconds ?? DEFAULTS.timeoutSeconds) * 1000
  const ref = config.webhook?.credential ?? DEFAULTS.credential
  const sinks: Sink[] = [
    ...(config.desktop ?? true ? [new DesktopSink(onPath(DESKTOP_COMMAND), timeoutMs)] : []),
    ...(config.webhook?.enabled ? [new WebhookSink(ctx, ref, timeoutMs)] : []),
  ]
  if (!sinks.length) ctx.logger.warn('notify: no sink is on (desktop: false, webhook off): nothing is sent')
  const notifier = new Notifier(ctx, config, sinks)
  for (const sink of sinks) {
    if (sink.unavailable) {
      ctx.logger.warn(`notify: ${sink.unavailable}`)
      notifier.delivery({ outcome: 'unavailable', sink: sink.name, reason: sink.unavailable })
    }
  }

  ctx.effect(() => {
    let timer: NodeJS.Timeout | undefined
    let stopped = false
    // A pass runs on the notifier's own clock, never in the producer's call: a new event only wakes it.
    const wake = (delay = 0): void => {
      if (stopped || timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (notifier.pass()) wake()
      }, delay)
      timer.unref()
    }
    const off = ctx.on('system/event', (event) => {
      if (!event.type.startsWith('notify.')) wake()
    })
    // Each poll first reconciles the holds with the board (holds on), then passes over the log.
    const sweep = (): void => { void notifier.sweep().finally(() => wake()) }
    const poll = setInterval(sweep, (config.pollSeconds ?? DEFAULTS.pollSeconds) * 1000)
    poll.unref()
    sweep()
    return () => {
      stopped = true
      off()
      clearInterval(poll)
      if (timer) clearTimeout(timer)
      notifier.dispose()
    }
  })

  // The operator stores the webhook URL in the vault; it is never echoed or logged.
  ctx.inject(['mcp', 'credentials'], (c) => {
    c.mcp.tool('notify_webhook', {
      description: `Store the notification webhook's URL, encrypted, under the credential reference the notify row names (${ref}). https only (or http to this machine). Nothing is returned or logged.`,
      inputSchema: { value: zod.string().min(1).max(2048).describe('The webhook URL') },
    }, async ({ value }) => {
      const problem = webhookProblem(String(value))
      if (problem) return { isError: true, content: [{ type: 'text', text: problem }] }
      try {
        await c.credentials.set(credentialRef(ref), String(value))
        return { content: [{ type: 'text', text: `stored the webhook URL under ${ref}${config.webhook?.enabled ? '' : '; the webhook is off until webhook.enabled is true in the notify row'}` }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: (error as Error).message }] }
      }
    })
  })
}
