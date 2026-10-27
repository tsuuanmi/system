/**
 * A project's lead inbox (docs/design/notifications.md#the-leads-inbox, D107): what needs a project's
 * lead, and what finished, comes to it by itself. A service that reads the event log after its own
 * cursor and keeps `lead-notice@1.0` records per project, addressed to `lead:<project>`, from
 * recorded events only; a notice handled through its subject (the request decided, the task moved)
 * closes by itself, any other is acknowledged (`ack`). It pushes each new notice to the project's
 * sinks (a command's stdin, a line of a file) and wakes the leads waiting on it (`system lead wait`).
 * It decides nothing and never blocks the producer of an event: it reads after the commit, on its own
 * clock. At most one notice per project, subject, and kind per window; every table is bounded (INV-9).
 * @module @tsuuanmi/system-lead-inbox
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SystemEvent } from '@tsuuanmi/system-event-log'
import { readCapacity, reply, type RosterServices, type ToolContext, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import { z as zod } from 'zod'
import { type Closing, type Draft, KINDS, type Kind, type LeadNotice, makeNotice, readEvent, type Reading } from './notices.ts'
import { commandSink, DEFAULT_TIMEOUT_SECONDS, fileSink, type Sink, type SinkConfig, sinkProblems, waitSink } from './sinks.ts'

export { KINDS, type Kind, type LeadNotice, readEvent } from './notices.ts'
export { commandSink, fileSink, filePath, type Outcome, type Sink, type SinkConfig, sinkProblems } from './sinks.ts'

export const name = 'lead-inbox'

declare module '@deepseek-ai/cordis' {
  interface Context {
    leadInbox: LeadInbox
  }
}

/** The event every delivery outcome is recorded as. */
export const DELIVERY_EVENT = 'lead-inbox.delivery'
const PAGE = 1000
const PAGES_PER_PASS = 10
/** Open requests kept at most for `request.stale` (INV-9), and waiters of `system lead wait` at most. */
export const MAX_OPEN = 10_000
export const MAX_WAITERS = 64
/** The longest one wait is held, in seconds; a lead's loop asks again. */
export const MAX_WAIT_SECONDS = 55

export interface ProjectConfig {
  /** Where each notice is pushed, each sink failing open (default: the long-poll only). */
  sinks?: SinkConfig[]
}

export interface Config {
  kinds?: Kind[]
  /** An open request of a project older than this many minutes is `request.stale` (default 10). */
  staleMinutes?: number
  /** Ready tasks waiting while Workers that could take them are free, past this many minutes, are `quota.idle` (default 10). */
  idleMinutes?: number
  /** The landings of an interval are one `task.digest` notice, per this many minutes (default 60). */
  digestMinutes?: number
  /** At most one notice per project, subject, and kind in this many minutes (default 10). */
  dedupMinutes?: number
  /** An event older than this when read makes no notice, in minutes (default 60). */
  maxAgeMinutes?: number
  /** How often the event log and the time-based checks are read, in seconds, beside each new event (default 15). */
  pollSeconds?: number
  /** Handled notices are kept this many days (default 14). */
  retainDays?: number
  /** Notices kept per project, at most; the oldest handled go first (default 1000). */
  maxNotices?: number
  /** Notices waiting to be pushed, at most (default 200). */
  maxQueue?: number
  /** The directory a `file` sink writes under (an absolute path, the coordination directory). */
  coordinationDir?: string
  /** Each project's push delivery. */
  projects?: Record<string, ProjectConfig>
}

export const DEFAULTS = {
  staleMinutes: 10, idleMinutes: 10, digestMinutes: 60, dedupMinutes: 10, maxAgeMinutes: 60, pollSeconds: 15, retainDays: 14, maxNotices: 1000, maxQueue: 200,
} as const

const Sink: z<SinkConfig> = z.object({
  type: z.union(['command', 'file', 'wait']).required().description('command: run a program with the notice as JSON on stdin; file: append the notice as one JSON line; wait: the system lead wait long-poll'),
  argv: z.array(z.string()).description('command: the program and its arguments, run with no shell'),
  path: z.string().description('file: the file, under coordinationDir'),
  timeoutSeconds: z.natural().min(1).max(60).default(DEFAULT_TIMEOUT_SECONDS).description('command: the longest it may run, in seconds'),
}) as unknown as z<SinkConfig>

export const Config: z<Config> = z.object({
  kinds: z.array(z.union([...KINDS])).default([...KINDS]).description('The kinds of notice made (default every kind)'),
  staleMinutes: z.natural().min(1).max(10_080).default(DEFAULTS.staleMinutes).description('An open request of a project older than this is a request.stale notice, in minutes'),
  idleMinutes: z.natural().min(1).max(10_080).default(DEFAULTS.idleMinutes).description('Ready tasks waiting while Workers that could take them are free, past this many minutes, are a quota.idle notice'),
  digestMinutes: z.natural().min(1).max(10_080).default(DEFAULTS.digestMinutes).description('The landings of this many minutes are batched into one task.digest notice'),
  dedupMinutes: z.natural().min(1).max(1440).default(DEFAULTS.dedupMinutes).description('At most one notice per project, subject, and kind in this many minutes'),
  maxAgeMinutes: z.natural().min(1).max(10_080).default(DEFAULTS.maxAgeMinutes).description('An event older than this when read makes no notice (a host or row that was off), in minutes'),
  pollSeconds: z.natural().min(1).max(3600).default(DEFAULTS.pollSeconds).description('How often the event log and the time-based checks are read, in seconds, beside each new event'),
  retainDays: z.natural().min(1).max(366).default(DEFAULTS.retainDays).description('Handled notices are kept this many days'),
  maxNotices: z.natural().min(10).max(100_000).default(DEFAULTS.maxNotices).description('Notices kept per project, at most; the oldest handled go first, then the oldest unread (recorded)'),
  maxQueue: z.natural().min(1).max(10_000).default(DEFAULTS.maxQueue).description('Notices waiting to be pushed, at most; one more is dropped and recorded'),
  coordinationDir: z.string().description('The directory a file sink writes under: an absolute path, the project\'s coordination directory'),
  projects: z.dict(z.object({ sinks: z.array(Sink).default([{ type: 'wait' }]).description('Where each notice of the project is pushed; each sink fails open, its outcome recorded') })).default({}).description('Push delivery by project id'),
}) as unknown as z<Config>

/** Every problem of a configuration that the schema cannot state. */
export function configProblems(config: Config): string[] {
  const problems: string[] = []
  if (!(config.kinds ?? KINDS).length) problems.push('kinds is empty: turn the lead-inbox row off instead')
  for (const [project, row] of Object.entries(config.projects ?? {})) problems.push(...sinkProblems(project, row.sinks ?? [], config.coordinationDir))
  return problems
}

const MIGRATIONS = [{
  version: 1,
  sql: `CREATE TABLE lead_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
  CREATE TABLE lead_notices (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, task_id TEXT, made_ms INTEGER NOT NULL, handled_ms INTEGER, handled_by TEXT, record TEXT NOT NULL);
  CREATE INDEX lead_notices_unread ON lead_notices (project, handled_ms);
  CREATE INDEX lead_notices_subject ON lead_notices (subject, kind);
  CREATE TABLE lead_claims (project TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, claimed_ms INTEGER NOT NULL, PRIMARY KEY (project, kind, subject));
  CREATE TABLE lead_requests (request_id TEXT PRIMARY KEY, project TEXT NOT NULL, created_ms INTEGER NOT NULL, noted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE lead_idle (task_id TEXT PRIMARY KEY, project TEXT NOT NULL, since_ms INTEGER NOT NULL, noted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE lead_digests (project TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);`,
}]

const schemas = new SchemaRegistry()

/** What the inbox asks of the rest of the host, each replaceable by a test. */
export interface Sources {
  /** The board project of a task; undefined when it is unknown. */
  projectOf(taskId: string): Promise<string | undefined>
  /** Every project a live update tells. */
  projects(): Promise<string[]>
  /** Ready tasks that a Worker free now could take (capacity now, `ready` with a likely Worker); undefined when it cannot be read. */
  idle(): Promise<Array<{ projectId: string; taskId: string }> | undefined>
}

export interface Stats {
  unread: number
  handled: number
  /** Minutes-free: how long handled notices waited from made to handled, in ms. */
  waitMs: { n: number; median?: number; p90?: number }
  /** Handled notices of a task are the lead's touches of it (an ack, or a decision that closed its subject). */
  touches: { tasks: number; median?: number }
}

const median = (sorted: number[]): number | undefined => (sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined)
const percentile = (sorted: number[], p: number): number | undefined => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : undefined)

interface Waiter { project: string | undefined; wake: () => void }

export class LeadInbox extends Service {
  static inject = ['store', 'eventLog']
  static Config = Config

  readonly sources: Sources
  private readonly kinds: ReadonlySet<Kind>
  private readonly dedupMs: number
  private readonly maxAgeMs: number
  private readonly staleMs: number
  private readonly idleMs: number
  private readonly digestMs: number
  private readonly retainMs: number
  private readonly maxNotices: number
  private readonly maxQueue: number
  private readonly sinks = new Map<string, Sink[]>()
  private readonly queue: LeadNotice[] = []
  private readonly waiters = new Set<Waiter>()
  private readonly cache = new Map<string, string>()
  private readonly abort = new AbortController()
  private passing = false
  private again = false
  private sending: Promise<void> | undefined
  private disposed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'leadInbox')
    const problems = configProblems(config)
    if (problems.length) throw new Error(`lead-inbox: ${problems.join('; ')}`)
    this.kinds = new Set(config.kinds ?? KINDS)
    this.dedupMs = (config.dedupMinutes ?? DEFAULTS.dedupMinutes) * 60_000
    this.maxAgeMs = (config.maxAgeMinutes ?? DEFAULTS.maxAgeMinutes) * 60_000
    this.staleMs = (config.staleMinutes ?? DEFAULTS.staleMinutes) * 60_000
    this.idleMs = (config.idleMinutes ?? DEFAULTS.idleMinutes) * 60_000
    this.digestMs = (config.digestMinutes ?? DEFAULTS.digestMinutes) * 60_000
    this.retainMs = (config.retainDays ?? DEFAULTS.retainDays) * 86_400_000
    this.maxNotices = config.maxNotices ?? DEFAULTS.maxNotices
    this.maxQueue = config.maxQueue ?? DEFAULTS.maxQueue
    for (const [project, row] of Object.entries(config.projects ?? {})) {
      this.sinks.set(project, (row.sinks ?? [{ type: 'wait' }]).map((s): Sink => {
        if (s.type === 'command') return commandSink(s.argv!, (s.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000, project)
        if (s.type === 'file') return fileSink(config.coordinationDir!, s.path!)
        return waitSink
      }))
    }
    this.sources = {
      projectOf: async (taskId) => {
        const board = ctx.get('board' as never) as { task?: (id: string) => Promise<{ projectId?: string } | undefined> } | undefined
        return (await board?.task?.(taskId))?.projectId
      },
      projects: async () => {
        const board = ctx.get('board' as never) as { projects?: () => Promise<Array<{ projectId: string; state: string }>> } | undefined
        return (await board?.projects?.())?.filter((p) => p.state !== 'closed').map((p) => p.projectId) ?? []
      },
      idle: async () => {
        const services: RosterServices = {
          workers: ctx.get('workers' as never), accounts: ctx.get('accounts' as never), agentWorkers: ctx.get('agentWorkers' as never), resources: ctx.get('resources' as never),
          eventLog: ctx.get('eventLog' as never), workflow: ctx.get('workflow' as never), board: ctx.get('board' as never),
        }
        if (!services.board || !services.workers) return undefined
        const ready = (await readCapacity(services, { scope: 'client' })).ready
        if (!('value' in ready)) return undefined
        return ready.value.items.filter((t) => 'value' in t.likely && t.likely.value !== null).map((t) => ({ projectId: t.projectId, taskId: t.taskId }))
      },
    }
    ctx.store.migrate('lead-inbox', MIGRATIONS)
    ctx.effect(() => {
      let timer: NodeJS.Timeout | undefined
      let stopped = false
      // A pass runs on the inbox's own clock, never in the producer's call: a new event only wakes it.
      const wake = (delay = 0): void => {
        if (stopped || timer) return
        timer = setTimeout(() => {
          timer = undefined
          void this.pass().then((more) => { if (more) wake() })
        }, delay)
        timer.unref()
      }
      const off = ctx.on('system/event', (event) => {
        if (!event.type.startsWith('lead-inbox.')) wake()
      })
      const poll = setInterval(() => { wake(); void this.sweep() }, (config.pollSeconds ?? DEFAULTS.pollSeconds) * 1000)
      poll.unref()
      wake()
      return () => {
        stopped = true
        off()
        clearInterval(poll)
        if (timer) clearTimeout(timer)
        this.stop()
      }
    })
    ctx.inject(['mcp'], (c) => {
      c.mcp.tool('lead_inbox', TOOL, (args, context) => this.tool(args, context))
      c.mcp.tool('live_update_record', RECORD_TOOL, async (args) => {
        try {
          return reply(this.recordLiveUpdate(args), `recorded the live update as ${String(args.outcome)}`)
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
        }
      })
    })
  }

  /**
   * Record how a live update ended (`host.live-update`, the event `live-update.done` and
   * `live-update.failed` are made from): scripts/live-update.sh calls it, as the operator, once the
   * daemon runs again, updated or rolled back. Ids and a reason word only.
   */
  recordLiveUpdate(args: Record<string, unknown>): { outcome: 'done' | 'failed'; from?: string; to?: string; reason?: string } {
    const given = args.outcome
    const outcome = given === 'done' || given === 'failed' ? given : undefined
    if (!outcome) throw new TypeError('outcome is done or failed')
    const sha = (v: unknown): string | undefined => (typeof v === 'string' && /^[0-9a-f]{4,64}$/.test(v) ? v : undefined)
    const from = sha(args.from)
    const to = sha(args.to)
    const reason = typeof args.reason === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.reason) ? args.reason : undefined
    const data: { outcome: 'done' | 'failed'; from?: string; to?: string; reason?: string } = { outcome, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(reason ? { reason } : {}) }
    this.ctx.eventLog.append({ type: 'host.live-update', data })
    return data
  }

  /** Notices waiting to be pushed. */
  get pending(): number {
    return this.queue.length
  }

  /** Replace what the inbox asks of the host (tests, or a host that reads them another way). */
  use(sources: Partial<Sources>): void {
    Object.assign(this.sources, sources)
  }

  // --- reading the event log ---

  /**
   * One pass: the events after the cursor (at most {@link PAGES_PER_PASS} pages) become notices, close
   * notices, and open or end requests, in one transaction with the cursor; the notices it makes are
   * pushed after it commits. A pass that fails changes nothing and is logged; the next one reads the
   * same events again. True when the backlog is not read to its end.
   */
  async pass(now: number = Date.now()): Promise<boolean> {
    if (this.disposed) return false
    if (this.passing) {
      this.again = true
      return false
    }
    this.passing = true
    let more = false
    try {
      const start = this.cursor()
      let cursor = start
      const read: Array<{ event: SystemEvent; reading: Reading }> = []
      for (let page = 0; page < PAGES_PER_PASS; page++) {
        const events = this.ctx.eventLog.query({ afterSeq: cursor, limit: PAGE })
        for (const event of events) {
          if (event.type.startsWith('lead-inbox.')) continue
          const reading = readEvent(event)
          if (reading.drafts.length || reading.closes.length || reading.opened || reading.resolved) read.push({ event, reading })
        }
        if (events.length) cursor = events.at(-1)!.seq
        if (events.length < PAGE) break
        if (page === PAGES_PER_PASS - 1) more = true
      }
      // Addressed after the read, before the transaction: the board is asked, never inside the store's lock.
      const addressed = await Promise.all(read.map(async ({ event, reading }) => ({
        event, reading,
        to: await Promise.all(reading.drafts.map((d) => this.addressees(d))),
        opened: reading.opened ? { ...reading.opened, project: reading.opened.project ?? (reading.opened.taskId ? await this.projectOf(reading.opened.taskId) : undefined) } : undefined,
      })))
      const made: LeadNotice[] = []
      this.ctx.store.transaction((db) => {
        for (const { event, reading, to, opened } of addressed) {
          for (const closing of reading.closes) this.closeNotices(closing, now)
          if (reading.resolved) db.prepare('DELETE FROM lead_requests WHERE request_id = ?').run(reading.resolved)
          if (opened?.project) {
            const open = (db.prepare('SELECT COUNT(*) AS n FROM lead_requests').get() as { n: number }).n
            if (open >= MAX_OPEN) this.ctx.logger.warn(`lead-inbox: ${MAX_OPEN} open requests are kept already; request ${opened.requestId} is not watched for staleness`)
            else db.prepare('INSERT INTO lead_requests (request_id, project, created_ms) VALUES (?, ?, ?) ON CONFLICT (request_id) DO NOTHING').run(opened.requestId, opened.project, Date.parse(event.at))
          }
          for (const [i, draft] of reading.drafts.entries()) {
            for (const project of to[i]!) this.insert(draft, project, { seq: event.seq, type: event.type, at: event.at }, now, made, true)
          }
        }
        if (cursor !== start) db.prepare('INSERT INTO lead_cursor (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq').run(cursor)
        this.prune(now)
        this.ctx.store.afterCommit(() => this.committed(made))
      })
    } catch (error) {
      this.ctx.logger.warn(`lead-inbox: a pass over the event log failed, and the next one reads it again: ${(error as Error).message}`)
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
   * The checks the clock makes: an open request older than `staleMinutes` (once), ready tasks waiting
   * while a Worker that could take them is free past `idleMinutes` (once), and the landings of an
   * interval as one digest. Each is read from what the inbox kept or the host tells now; none changes
   * anything outside the inbox.
   */
  async sweep(now: number = Date.now()): Promise<void> {
    if (this.disposed) return
    let idle: Array<{ projectId: string; taskId: string }> | undefined
    try {
      idle = this.kinds.has('quota.idle') ? await this.sources.idle() : undefined
    } catch (error) {
      this.ctx.logger.warn(`lead-inbox: the idle quota could not be read this time: ${(error as Error).message}`)
    }
    try {
      const seq = this.cursor()
      const made: LeadNotice[] = []
      this.ctx.store.transaction((db) => {
        const at = new Date(now).toISOString()
        const event = { seq, type: 'lead-inbox.sweep', at }
        const stale = db.prepare('SELECT request_id, project FROM lead_requests WHERE noted = 0 AND created_ms <= ? ORDER BY created_ms LIMIT 100').all(now - this.staleMs) as Array<{ request_id: string; project: string }>
        for (const row of stale) {
          db.prepare('UPDATE lead_requests SET noted = 1 WHERE request_id = ?').run(row.request_id)
          this.insert({
            kind: 'request.stale', subject: row.request_id, title: `A request waits: ${row.request_id.slice(0, 80)}`,
            text: `Request ${row.request_id} of project ${row.project} has been open for more than ${Math.round(this.staleMs / 60_000)} minutes.`,
            act: [`MCP approvals_get {"requestId":"${row.request_id}"}`, 'MCP approvals_decide', 'system ui'],
          }, row.project, event, now, made, false)
        }
        if (idle) {
          const seen = new Set(idle.map((t) => t.taskId))
          for (const row of db.prepare('SELECT task_id FROM lead_idle').all() as Array<{ task_id: string }>) if (!seen.has(row.task_id)) db.prepare('DELETE FROM lead_idle WHERE task_id = ?').run(row.task_id)
          for (const t of idle.slice(0, 1000)) db.prepare('INSERT INTO lead_idle (task_id, project, since_ms) VALUES (?, ?, ?) ON CONFLICT (task_id) DO NOTHING').run(t.taskId, t.projectId, now)
          const due = db.prepare('SELECT task_id, project, since_ms FROM lead_idle WHERE noted = 0 AND since_ms <= ? ORDER BY since_ms LIMIT 100').all(now - this.idleMs) as Array<{ task_id: string; project: string; since_ms: number }>
          for (const row of due) {
            db.prepare('UPDATE lead_idle SET noted = 1 WHERE task_id = ?').run(row.task_id)
            this.insert({
              kind: 'quota.idle', subject: row.task_id, taskId: row.task_id, title: `Quota is idle: board task ${row.task_id.slice(0, 60)}`,
              text: `Board task ${row.task_id} has been ready for more than ${Math.round(this.idleMs / 60_000)} minutes while a Worker that could take it is free: start it, or find why dispatch does not.`,
              act: ['system dispatch status', `MCP board_task {"taskId":"${row.task_id}"}`],
            }, row.project, event, now, made, false)
          }
        }
        this.digest(now, event, made)
        this.prune(now)
        this.ctx.store.afterCommit(() => this.committed(made))
      })
    } catch (error) {
      this.ctx.logger.warn(`lead-inbox: a check of the clock failed, and the next one tries again: ${(error as Error).message}`)
    }
  }

  /** The landings of the interval, per project, as one digest notice (the landings are pushed one by one as well). */
  private digest(now: number, event: { seq: number; type: string; at: string }, made: LeadNotice[]): void {
    const db = this.ctx.store.db
    const projects = db.prepare("SELECT DISTINCT project FROM lead_notices WHERE kind = 'task.landed'").all() as Array<{ project: string }>
    for (const { project } of projects) {
      const last = (db.prepare('SELECT at_ms FROM lead_digests WHERE project = ?').get(project) as { at_ms: number } | undefined)?.at_ms
      if (last === undefined) {
        // The first interval starts when the inbox first sees the project's landing.
        const first = (db.prepare("SELECT MIN(made_ms) AS ms FROM lead_notices WHERE project = ? AND kind = 'task.landed'").get(project) as { ms: number }).ms
        db.prepare('INSERT INTO lead_digests (project, at_ms) VALUES (?, ?)').run(project, first - 1)
        continue
      }
      if (now - last < this.digestMs) continue
      const rows = db.prepare("SELECT record FROM lead_notices WHERE project = ? AND kind = 'task.landed' AND made_ms > ? AND made_ms <= ? ORDER BY rowid LIMIT 50").all(project, last, now) as Array<{ record: string }>
      db.prepare('UPDATE lead_digests SET at_ms = ? WHERE project = ?').run(now, project)
      if (!rows.length) continue
      const landed = rows.map((r) => JSON.parse(r.record) as LeadNotice).map((n) => ({ taskId: n.taskId!, ...(n.commit ? { commit: n.commit } : {}) }))
      const notice = makeNotice({
        kind: 'task.digest', subject: `digest:${new Date(last).toISOString()}`,
        title: `${landed.length} task(s) landed`, text: `${landed.length} board task(s) of project ${project} landed since ${new Date(last).toISOString()}: ${landed.map((l) => `${l.taskId}${l.commit ? ` (${l.commit.slice(0, 8)})` : ''}`).join(', ')}.`,
        act: [`system lead wait --project ${project}`],
      }, project, event)
      if (notice && this.kinds.has('task.digest')) this.store({ ...notice, landed: landed.slice(0, 50) }, now, made)
    }
  }

  // --- the store ---

  private cursor(): number {
    return (this.ctx.store.db.prepare('SELECT seq FROM lead_cursor WHERE id = 1').get() as { seq: number } | undefined)?.seq ?? 0
  }

  /** The projects a draft goes to: the one it names, the one its task belongs to, or every project. */
  private async addressees(draft: Draft): Promise<string[]> {
    if (draft.project) return [draft.project]
    if (draft.everyProject) return this.sources.projects()
    const project = draft.taskId ? await this.projectOf(draft.taskId) : undefined
    return project ? [project] : []
  }

  private async projectOf(taskId: string): Promise<string | undefined> {
    const known = this.cache.get(taskId)
    if (known !== undefined) return known
    const project = await this.sources.projectOf(taskId)
    if (project !== undefined) {
      if (this.cache.size >= 2000) this.cache.clear()
      this.cache.set(taskId, project)
    }
    return project
  }

  /** Make a draft's notice for a project and keep it, once per project, subject, and kind in the window. */
  private insert(draft: Draft, project: string, event: { seq: number; type: string; at: string }, now: number, made: LeadNotice[], aged: boolean): void {
    if (!this.kinds.has(draft.kind)) return
    if (aged && now - Date.parse(event.at) > this.maxAgeMs) return
    const notice = makeNotice(draft, project, event)
    if (!notice) return
    this.store(notice, now, made)
  }

  private store(notice: LeadNotice, now: number, made: LeadNotice[]): void {
    try {
      schemas.assert('lead-notice@1.0', notice)
    } catch (error) {
      // A defect, never a notice that says less than its schema promises (INV-14).
      this.ctx.logger.warn(`lead-inbox: the ${notice.kind} notice of ${notice.subject} is not a valid lead-notice@1.0 and is not kept: ${(error as Error).message}`)
      return
    }
    const db = this.ctx.store.db
    const claimed = db.prepare('SELECT claimed_ms FROM lead_claims WHERE project = ? AND kind = ? AND subject = ?').get(notice.project, notice.kind, notice.subject) as { claimed_ms: number } | undefined
    if (claimed && claimed.claimed_ms > now - this.dedupMs) return
    const changes = db.prepare('INSERT INTO lead_notices (id, project, kind, subject, task_id, made_ms, record) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
      .run(notice.id, notice.project, notice.kind, notice.subject, notice.taskId ?? null, now, JSON.stringify(notice)).changes
    if (Number(changes) !== 1) return
    db.prepare('INSERT INTO lead_claims (project, kind, subject, claimed_ms) VALUES (?, ?, ?, ?) ON CONFLICT (project, kind, subject) DO UPDATE SET claimed_ms = excluded.claimed_ms').run(notice.project, notice.kind, notice.subject, now)
    made.push(notice)
  }

  /** Close the unread notices a decided request or a moved task ends. */
  private closeNotices(closing: Closing, now: number): void {
    const kinds = closing.kinds.map(() => '?').join(', ')
    this.ctx.store.db.prepare(`UPDATE lead_notices SET handled_ms = ?, handled_by = 'subject' WHERE handled_ms IS NULL AND subject = ? AND kind IN (${kinds})`).run(now, closing.subject, ...closing.kinds)
  }

  /** Bounded (INV-9): claims past their window, handled notices past their retention, and each project's notices past the cap. */
  private prune(now: number): void {
    const db = this.ctx.store.db
    db.prepare('DELETE FROM lead_claims WHERE claimed_ms <= ?').run(now - this.dedupMs)
    db.prepare('DELETE FROM lead_notices WHERE handled_ms IS NOT NULL AND handled_ms <= ?').run(now - this.retainMs)
    const over = db.prepare('SELECT project, COUNT(*) AS n FROM lead_notices GROUP BY project HAVING n > ?').all(this.maxNotices) as Array<{ project: string; n: number }>
    for (const { project, n } of over) {
      // The oldest handled go first; an unread one only when nothing handled is left, and then it is told.
      db.prepare('DELETE FROM lead_notices WHERE id IN (SELECT id FROM lead_notices WHERE project = ? AND handled_ms IS NOT NULL ORDER BY rowid LIMIT ?)').run(project, n - this.maxNotices)
      const left = (db.prepare('SELECT COUNT(*) AS n FROM lead_notices WHERE project = ?').get(project) as { n: number }).n
      if (left > this.maxNotices) {
        db.prepare('DELETE FROM lead_notices WHERE id IN (SELECT id FROM lead_notices WHERE project = ? ORDER BY rowid LIMIT ?)').run(project, left - this.maxNotices)
        this.ctx.logger.warn(`lead-inbox: project ${project} holds more than ${this.maxNotices} unread notices (maxNotices); the oldest were dropped`)
      }
    }
  }

  // --- reading and handling ---

  /** The unread notices, oldest first, of a project or of every project. */
  unread(project?: string, limit = 50): LeadNotice[] {
    const rows = (project === undefined
      ? this.ctx.store.db.prepare('SELECT record FROM lead_notices WHERE handled_ms IS NULL ORDER BY rowid LIMIT ?').all(limit)
      : this.ctx.store.db.prepare('SELECT record FROM lead_notices WHERE project = ? AND handled_ms IS NULL ORDER BY rowid LIMIT ?').all(project, limit)) as Array<{ record: string }>
    return rows.map((r) => JSON.parse(r.record) as LeadNotice)
  }

  /** The most recent digests of a project, newest first. */
  digests(project: string, limit = 5): LeadNotice[] {
    const rows = this.ctx.store.db.prepare("SELECT record FROM lead_notices WHERE project = ? AND kind = 'task.digest' ORDER BY rowid DESC LIMIT ?").all(project, limit) as Array<{ record: string }>
    return rows.map((r) => JSON.parse(r.record) as LeadNotice)
  }

  /** Mark notices handled by the lead; the ids of another project's notices, or already handled, are `unknown`. */
  ack(ids: readonly string[], project: string | undefined, now: number = Date.now()): { acked: string[]; unknown: string[] } {
    const acked: string[] = []
    const unknown: string[] = []
    this.ctx.store.transaction((db) => {
      for (const id of ids.slice(0, 50)) {
        const changes = project === undefined
          ? db.prepare("UPDATE lead_notices SET handled_ms = ?, handled_by = 'ack' WHERE id = ? AND handled_ms IS NULL").run(now, id).changes
          : db.prepare("UPDATE lead_notices SET handled_ms = ?, handled_by = 'ack' WHERE id = ? AND project = ? AND handled_ms IS NULL").run(now, id, project).changes
        ;(Number(changes) === 1 ? acked : unknown).push(id)
      }
    })
    return { acked, unknown }
  }

  /** The time notices wait until handled, and the lead's touches per task, read from the acks and the decisions that closed notices. */
  stats(project?: string): Stats {
    const db = this.ctx.store.db
    const where = project === undefined ? '' : 'WHERE project = ?'
    const args = project === undefined ? [] : [project]
    const counts = db.prepare(`SELECT SUM(handled_ms IS NULL) AS unread, SUM(handled_ms IS NOT NULL) AS handled FROM lead_notices ${where}`).get(...args) as { unread: number | null; handled: number | null }
    const waits = (db.prepare(`SELECT handled_ms - made_ms AS wait FROM lead_notices ${where ? `${where} AND` : 'WHERE'} handled_ms IS NOT NULL`).all(...args) as Array<{ wait: number }>).map((r) => r.wait).sort((a, b) => a - b)
    const perTask = (db.prepare(`SELECT COUNT(*) AS n FROM lead_notices ${where ? `${where} AND` : 'WHERE'} handled_ms IS NOT NULL AND task_id IS NOT NULL GROUP BY task_id`).all(...args) as Array<{ n: number }>).map((r) => r.n).sort((a, b) => a - b)
    return {
      unread: Number(counts.unread ?? 0), handled: Number(counts.handled ?? 0),
      waitMs: { n: waits.length, ...(waits.length ? { median: median(waits)!, p90: percentile(waits, 0.9)! } : {}) },
      touches: { tasks: perTask.length, ...(perTask.length ? { median: median(perTask)! } : {}) },
    }
  }

  /**
   * Block until a notice is unread (for a project, or for any), then give the unread ones; `[]` when
   * `timeoutMs` passes first, or the signal aborts. One that is unread already returns at once.
   */
  async wait(project: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<LeadNotice[]> {
    const now = this.unread(project)
    if (now.length || timeoutMs <= 0 || this.disposed) return now
    if (this.waiters.size >= MAX_WAITERS) throw new Error(`${MAX_WAITERS} leads wait on the inbox already (INV-9); try again`)
    return new Promise((done) => {
      let timer: NodeJS.Timeout | undefined
      const waiter: Waiter = { project, wake: () => finish() }
      const finish = (): void => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        this.waiters.delete(waiter)
        done(this.disposed ? [] : this.unread(project))
      }
      timer = setTimeout(finish, timeoutMs)
      timer.unref()
      signal?.addEventListener('abort', finish, { once: true })
      this.waiters.add(waiter)
    })
  }

  // --- pushing ---

  /** After a commit: wake the leads waiting, and push each new notice to its project's sinks. */
  private committed(made: LeadNotice[]): void {
    if (!made.length) return
    for (const waiter of [...this.waiters]) if (waiter.project === undefined || made.some((n) => n.project === waiter.project)) waiter.wake()
    for (const notice of made) {
      if (this.queue.length >= this.maxQueue) {
        this.delivery({ outcome: 'dropped', project: notice.project, kind: notice.kind, subject: notice.subject, notice: notice.id, reason: `the queue holds ${this.maxQueue} notices (maxQueue)` })
        continue
      }
      this.queue.push(notice)
    }
    this.drain()
  }

  /** Send what is queued, one notice at a time, to every sink of its project; each outcome is recorded. */
  private drain(): void {
    if (this.sending || this.disposed) return
    this.sending = (async () => {
      while (this.queue.length && !this.disposed) {
        const notice = this.queue.shift()!
        for (const sink of this.sinks.get(notice.project) ?? []) {
          const outcome = await sink.send(notice, this.abort.signal).catch((error: unknown) => ({ sent: false as const, reason: `the ${sink.name} sink failed: ${(error as Error).message}` }))
          if (this.disposed) return
          if (!outcome.sent) this.ctx.logger.warn(`lead-inbox: the ${notice.kind} notice of ${notice.subject} was not sent to ${sink.name} of project ${notice.project}: ${outcome.reason}`)
          this.delivery({ outcome: outcome.sent ? 'sent' : 'failed', sink: sink.name, project: notice.project, kind: notice.kind, subject: notice.subject, notice: notice.id, ...(outcome.sent ? {} : { reason: outcome.reason }) })
        }
      }
    })().finally(() => {
      this.sending = undefined
      if (this.queue.length && !this.disposed) this.drain()
    })
  }

  /** Record one outcome; an append that fails is logged, never thrown. */
  delivery(data: { outcome: 'sent' | 'failed' | 'dropped'; sink?: string; project: string; kind: Kind; subject: string; notice: string; reason?: string }): void {
    try {
      this.ctx.eventLog.append({ type: DELIVERY_EVENT, data })
    } catch (error) {
      this.ctx.logger.warn(`lead-inbox: a ${data.outcome} delivery was not recorded: ${(error as Error).message}`)
    }
  }

  /** Wait for the notice being sent, if any (tests, disposal). */
  async idle(): Promise<void> {
    while (this.sending) await this.sending
  }

  /** Stop the inbox: wake its waiters and drop what is queued. */
  stop(): void {
    this.disposed = true
    this.abort.abort()
    for (const waiter of [...this.waiters]) waiter.wake()
    if (this.queue.length) this.ctx.logger.warn(`lead-inbox: ${this.queue.length} queued notice(s) were not pushed before the plugin stopped`)
    this.queue.length = 0
  }

  // --- MCP ---

  /** `lead_inbox`: a lead's token reads its own project; the operator names the project. */
  private async tool(args: Record<string, unknown>, context: ToolContext) {
    const asked = typeof args.projectId === 'string' ? args.projectId : undefined
    const project = context.lead ?? asked
    if (context.lead !== undefined && asked !== undefined && asked !== context.lead) {
      return { isError: true, content: [{ type: 'text' as const, text: `the lead token of project ${context.lead} reaches only project ${context.lead}'s inbox; ${asked} is another project's, so nothing was read` }] }
    }
    if (context.lead === undefined && context.scope !== 'operator') {
      return { isError: true, content: [{ type: 'text' as const, text: 'the lead inbox is read with a project\'s lead token (or the operator\'s)' }] }
    }
    const ids = Array.isArray(args.ack) ? args.ack.filter((a): a is string => typeof a === 'string') : []
    const acked = ids.length ? this.ack(ids, project) : undefined
    const seconds = typeof args.waitSeconds === 'number' ? Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(args.waitSeconds))) : 0
    const notices = await this.wait(project, seconds * 1000)
    const stats = this.stats(project)
    const lines = notices.length ? notices.map((n) => `${n.id}  ${n.kind}  ${n.title}\n  ${n.text}\n  → ${n.act.join('  |  ')}`) : ['no unread notice']
    return reply({ ...(project !== undefined ? { project } : {}), notices, ...(acked ?? {}), stats }, `${notices.length} unread notice(s)${project ? ` for lead:${project}` : ''}${acked ? `; acked ${acked.acked.length}, unknown ${acked.unknown.length}` : ''}\n${lines.join('\n')}`)
  }
}

const TOOL: ToolSpec = {
  scope: 'client',
  description: 'The unread notices of a project\'s lead inbox (what needs the lead, and what finished), oldest first, with `stats` (the time notices wait until handled; the lead\'s touches per task). `ack` marks notices handled by their ids; a notice handled through its subject (the request decided, the task moved) closes by itself. `waitSeconds` (up to 55) blocks until a notice is unread: the lead\'s loop, `system lead wait`. A lead token reads its own project only; the operator names `projectId`.',
  inputSchema: {
    projectId: zod.string().min(1).max(100).optional().describe('The project (the operator\'s token; a lead\'s is its own)'),
    ack: zod.array(zod.string().min(1).max(300)).max(50).optional().describe('Notice ids to mark handled'),
    waitSeconds: zod.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe('Block this long for an unread notice (default: do not wait)'),
  },
}

const RECORD_TOOL: ToolSpec = {
  scope: 'operator',
  description: 'Record how a live update ended, as the event host.live-update, from which every project\'s lead inbox makes live-update.done or live-update.failed: scripts/live-update.sh calls it once the daemon runs again. Commits and a reason word only.',
  inputSchema: {
    outcome: zod.enum(['done', 'failed']).describe('done: the live install runs the target; failed: it was rolled back or stopped'),
    from: zod.string().regex(/^[0-9a-f]{4,64}$/).optional().describe('The commit it ran before'),
    to: zod.string().regex(/^[0-9a-f]{4,64}$/).optional().describe('The commit it was updated to'),
    reason: zod.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional().describe('Why it failed, as one word (rolled-back)'),
  },
}

export default LeadInbox
