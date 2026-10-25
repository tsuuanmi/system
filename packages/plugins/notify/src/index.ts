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
import type { SystemEvent } from '@tsuuanmi/system-event-log'
import type {} from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import { z as zod } from 'zod'
import { KINDS, type Kind, type Notice, type ReadOptions, readEvent, type Reminder, reminderNotice } from './notices.ts'
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
  /** Desktop notifications through notify-send (default true). */
  desktop?: boolean
  /** The webhook: off unless enabled; its URL is read from the credential reference, never from here. */
  webhook?: { enabled?: boolean; credential?: string }
}

export const DEFAULTS = {
  expiryLeadMinutes: 60, dedupMinutes: 10, maxQueue: 50, pollSeconds: 15, timeoutSeconds: 10, maxAgeMinutes: 60,
  link: 'http://127.0.0.1:47317/ui/', credential: 'SYSTEM_NOTIFY_WEBHOOK_URL',
} as const

export const Config: z<Config> = z.object({
  kinds: z.array(z.union([...KINDS])).default([...KINDS]).description('The kinds of notice sent: approval.opened, approval.expiring, run.user-action, run.escalated, run.waiting, pool.limited, worker.quarantined, review.expiring, dispatch.started'),
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
}]

const schemas = new SchemaRegistry()

/** The notifier of one plugin instance: its passes over the log, its queue, and its sinks. */
export class Notifier {
  private readonly kinds: ReadonlySet<Kind>
  private readonly read: ReadOptions
  private readonly dedupMs: number
  private readonly maxAgeMs: number
  private readonly maxQueue: number
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
    ctx.store.migrate('notify', MIGRATIONS)
  }

  /** Notices waiting to be sent. */
  get pending(): number {
    return this.queue.length
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
          if (row.expires_ms > now && this.kinds.has(reminder.review ? 'review.expiring' : 'approval.expiring')) {
            const notice = reminderNotice(reminder, now, this.read)
            if (notice) made.push(notice)
          }
        }
        // Bounded (INV-9): claims past their window, and reminders past their request's expiry, go.
        db.prepare('DELETE FROM notify_sent WHERE sent_ms <= ?').run(now - this.dedupMs)
        db.prepare('DELETE FROM notify_reminders WHERE expires_ms <= ?').run(now)
        const queued: Notice[] = []
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

  /** One event: a notice to make, a reminder to keep, or a request to forget. */
  private consume(event: SystemEvent, now: number, made: Notice[]): void {
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
    const poll = setInterval(() => wake(), (config.pollSeconds ?? DEFAULTS.pollSeconds) * 1000)
    poll.unref()
    wake()
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
