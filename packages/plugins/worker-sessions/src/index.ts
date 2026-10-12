/**
 * `ctx.workerSessions` (docs/design/sessions-and-messaging.md, ADR-0015): durable Worker
 * sessions, each with its own SessionId, in groups with a messaging policy; a durable, ordered
 * mailbox per session; and direct messages between peers. A message is a `message@1.0`
 * artifact appended to each target's mailbox, delivered at most once per sender message id.
 * A closed barrier is a mailbox gate: messages are stored but held until it opens
 * (independent-first). The service records messages; it never relays or rewrites them.
 * @module @tsuuanmi/system-worker-sessions
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-artifacts'
import { type ContentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-gateway-core'
import type {} from '@tsuuanmi/system-store'
import { z as zod } from 'zod'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workerSessions: WorkerSessions
  }
  interface Events {
    /**
     * Messages were committed to these sessions' mailboxes, with intents that ask for a reply
     * (not `answer` or `close`). The workflow engine wakes idle sessions on it.
     * @mode emit
     */
    'worker-sessions/delivered'(sessionIds: string[]): void
  }
}

/** Intents that wake an idle target; an `answer` is read at its next activation (no reply loops). */
const WAKING = new Set<Message['intent'] | undefined>([undefined, 'inform', 'request', 'critique', 'handoff', 'input-required'])

export type SessionState = 'FORMING' | 'IDLE' | 'ACTIVE' | 'INPUT_REQUIRED' | 'FAILED' | 'CLOSED'
/** The session binding's runtime kinds: the `worker-session@1.0` schema's vocabulary (metadata, never routing). */
export const RUNTIMES = ['website', 'claude-agent-sdk', 'codex-sdk', 'acp', 'a2a', 'local-tool', 'model-api'] as const
export type Runtime = typeof RUNTIMES[number]

/** A `worker-session@1.0` record. */
export interface WorkerSession {
  schema: 'worker-session@1.0'
  sessionId: string
  group?: string
  runId?: string
  nodeId?: string
  worker: string
  role: string
  formation?: ContentId
  state: SessionState
  binding: { runtime: Runtime; nativeHandle?: string; generation: number }
  policy: { mayMessage: string[]; barrier?: string }
  budgets: { maxTurns: number; maxMessages: number; maxLifetimeMinutes: number }
  usage?: { turns: number; messagesSent: number }
  mailboxSeq: number
  createdAt: string
  revision: number
}

export interface Member {
  sessionId: string
  role: string
  runtime: Runtime
  /** Session ids, or the group id (the group and all its members; the default). */
  mayMessage?: string[]
}

export interface Message {
  schema: 'message@1.0'
  messageId: string
  from: string
  to: { session: string } | { group: string }
  intent?: 'inform' | 'request' | 'critique' | 'answer' | 'handoff' | 'input-required' | 'close'
  inReplyTo?: string
  body: string
  refs?: ContentId[]
}

export interface Delivered {
  seq: number
  from: string
  artifact: ContentId
  message: Message
}

export type SendResult = { accepted: true; artifact: ContentId; delivered: string[] } | { accepted: false; reason: string; decision?: ContentId }

export interface Config {
  /** Messages one session may send (default 200). */
  maxMessages?: number
}

const BUDGETS = { maxTurns: 100, maxLifetimeMinutes: 1440 }
const now = (): string => new Date().toISOString()

export class WorkerSessions extends Service {
  static inject = ['store', 'artifacts']
  static Config: z<Config> = z.object({
    maxMessages: z.natural().min(1).default(200).description('Messages one session may send'),
  })

  private readonly schemas = new SchemaRegistry()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'workerSessions')
    ctx.store.migrate('worker-sessions', [{
      version: 1,
      sql: `CREATE TABLE worker_sessions (session_id TEXT PRIMARY KEY, group_id TEXT, record TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX worker_sessions_group ON worker_sessions (group_id);
      CREATE TABLE session_groups (group_id TEXT PRIMARY KEY, barrier_open INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE mailbox (session_id TEXT NOT NULL, seq INTEGER NOT NULL, sender TEXT NOT NULL, message_id TEXT NOT NULL, artifact TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq), UNIQUE (session_id, sender, message_id));`,
    }])
    ctx.inject(['mcp'], (c) => {
      const json = (value: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { ...value } })
      c.mcp.tool('session_send', {
        description: 'Send a message as the operator to a Worker session, or to its group (recorded as a message artifact; delivered at most once).',
        inputSchema: {
          to: zod.string().max(200).describe('A SessionId, or a group id'),
          body: zod.string().min(1).max(32_000),
          intent: zod.enum(['inform', 'request', 'critique', 'answer', 'handoff', 'input-required', 'close']).optional(),
          messageId: zod.string().max(200).optional().describe('Retry-safe id; the same id is delivered once'),
        },
      }, async (args) => {
        const to = String(args.to)
        const isGroup = !!this.ctx.store.db.prepare('SELECT 1 FROM session_groups WHERE group_id = ?').get(to)
        return json(this.send({
          from: 'operator', messageId: args.messageId ? String(args.messageId) : `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          to: isGroup ? { group: to } : { session: to }, body: String(args.body), ...(args.intent ? { intent: args.intent as Message['intent'] & string } : {}),
        }))
      })
      c.mcp.tool('session_inbox', {
        description: 'Read a Worker session: its record and its unread messages (not acknowledged).',
        inputSchema: { sessionId: zod.string().max(200) },
      }, async (args) => {
        const session = this.session(String(args.sessionId))
        return session
          ? json({ session, inbox: this.inbox(session.sessionId).map((m) => ({ seq: m.seq, from: m.from, intent: m.message.intent, body: m.message.body, artifact: m.artifact })) })
          : { isError: true, content: [{ type: 'text' as const, text: `unknown session ${String(args.sessionId)}` }] }
      })
    })
  }

  /** Create a group; with `barrier`, members' messages are held until `openBarrier`. */
  group(group: string, options: { barrier?: boolean } = {}): void {
    this.ctx.store.transaction((db) => {
      if (db.prepare('SELECT 1 FROM session_groups WHERE group_id = ?').get(group)) throw new Error(`group ${group} already exists`)
      db.prepare('INSERT INTO session_groups (group_id, barrier_open, created_at) VALUES (?, ?, ?)').run(group, options.barrier ? 0 : 1, now())
    })
  }

  /**
   * A member joins its group once its Worker is chosen (Model A: by its first admission, for
   * the session's lifetime). `mayMessage` lists session ids or the group id; the group id
   * allows the group and every member of it (the default).
   */
  join(group: string, member: Member & { worker: string; formation: ContentId; runId?: string; nodeId?: string }): WorkerSession {
    return this.ctx.store.transaction((db) => {
      const row = db.prepare('SELECT barrier_open FROM session_groups WHERE group_id = ?').get(group) as { barrier_open: number } | undefined
      if (!row) throw new Error(`unknown group ${group}`)
      const existing = this.session(member.sessionId)
      if (existing) {
        if (existing.group !== group || existing.worker !== member.worker) throw new Error(`session ${member.sessionId} is already bound to ${existing.worker} in ${existing.group}`)
        return existing
      }
      const record: WorkerSession = {
        schema: 'worker-session@1.0', sessionId: member.sessionId, group,
        ...(member.runId ? { runId: member.runId } : {}), ...(member.nodeId ? { nodeId: member.nodeId } : {}),
        worker: member.worker, role: member.role, formation: member.formation, state: 'IDLE', binding: { runtime: member.runtime, generation: 0 },
        policy: { mayMessage: member.mayMessage ?? [group], ...(row.barrier_open ? {} : { barrier: 'independent-first' }) },
        budgets: { ...BUDGETS, maxMessages: this.config.maxMessages ?? 200 }, usage: { turns: 0, messagesSent: 0 },
        mailboxSeq: 0, createdAt: now(), revision: 0,
      }
      this.schemas.assertRecord(record)
      db.prepare('INSERT INTO worker_sessions (session_id, group_id, record, updated_at) VALUES (?, ?, ?, ?)').run(member.sessionId, group, JSON.stringify(record), now())
      return record
    })
  }

  session(sessionId: string): WorkerSession | undefined {
    const row = this.ctx.store.db.prepare('SELECT record FROM worker_sessions WHERE session_id = ?').get(sessionId) as { record: string } | undefined
    return row ? (JSON.parse(row.record) as WorkerSession) : undefined
  }

  /**
   * Send a message (`operator` may write to any session). The group policy decides; a refusal
   * is a `gate` decision. Accepted, it becomes a `message@1.0` artifact appended to each
   * target's mailbox; a repeated sender message id is delivered once.
   */
  send(input: Omit<Message, 'schema'>): SendResult {
    const message: Message = { schema: 'message@1.0', ...input }
    return this.ctx.store.transaction((db) => {
      const sender = message.from === 'operator' ? undefined : this.session(message.from)
      const targets = 'group' in message.to
        ? (db.prepare('SELECT session_id FROM worker_sessions WHERE group_id = ? ORDER BY session_id').all(message.to.group) as Array<{ session_id: string }>).map((r) => r.session_id).filter((id) => id !== message.from)
        : [message.to.session]
      const target = 'group' in message.to ? message.to.group : message.to.session
      let reason: string | undefined
      if (message.from !== 'operator' && !sender) reason = `${message.from} is not a session`
      else if (sender && !this.allowed(sender, target)) reason = `${message.from} may not message ${target}`
      else if (sender && (sender.usage?.messagesSent ?? 0) >= sender.budgets.maxMessages) reason = `${message.from} has used its ${sender.budgets.maxMessages} messages`
      else if (!targets.length || targets.some((id) => !this.session(id))) reason = `no session ${target}`
      if (reason) return { accepted: false, reason, decision: this.refusal(message, reason) }
      const artifact = this.ctx.artifacts.put({
        kind: 'message', bodySchema: 'message@1.0', body: message, classification: 'operator-shared',
        producer: message.from === 'operator' ? { type: 'operator', ref: 'operator' } : { type: 'worker', ref: message.from },
        inputs: message.refs ?? [], ...(sender?.runId ? { runId: sender.runId } : {}), ...(sender?.nodeId ? { nodeId: sender.nodeId } : {}),
      }).id
      const delivered: string[] = []
      for (const id of targets) {
        const next = ((db.prepare('SELECT MAX(seq) AS seq FROM mailbox WHERE session_id = ?').get(id) as { seq: number | null }).seq ?? 0) + 1
        const inserted = db.prepare('INSERT OR IGNORE INTO mailbox (session_id, seq, sender, message_id, artifact, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, next, message.from, message.messageId, artifact, now())
        if (Number(inserted.changes) > 0) delivered.push(id)
      }
      if (sender && delivered.length) this.update(sender.sessionId, (r) => ({ ...r, usage: { turns: r.usage?.turns ?? 0, messagesSent: (r.usage?.messagesSent ?? 0) + 1 } }))
      if (delivered.length && WAKING.has(message.intent)) this.ctx.store.afterCommit(() => this.ctx.emit('worker-sessions/delivered', delivered))
      return { accepted: true, artifact, delivered }
    })
  }

  /** Open a group's barrier: held messages become deliverable. */
  openBarrier(group: string): void {
    this.ctx.store.db.prepare('UPDATE session_groups SET barrier_open = 1 WHERE group_id = ?').run(group)
  }

  /** Unread messages after the session's acknowledged sequence, in order; none while its group's barrier is closed. */
  inbox(sessionId: string): Delivered[] {
    const session = this.session(sessionId)
    if (!session) return []
    if (session.group) {
      const group = this.ctx.store.db.prepare('SELECT barrier_open FROM session_groups WHERE group_id = ?').get(session.group) as { barrier_open: number } | undefined
      if (group && !group.barrier_open) return []
    }
    const rows = this.ctx.store.db.prepare('SELECT seq, sender, artifact FROM mailbox WHERE session_id = ? AND seq > ? ORDER BY seq').all(sessionId, session.mailboxSeq) as Array<{ seq: number; sender: string; artifact: string }>
    return rows.map((r) => ({ seq: r.seq, from: r.sender, artifact: r.artifact as ContentId, message: this.ctx.artifacts.get(r.artifact)!.body as Message }))
  }

  /** Acknowledge delivery up to `seq`; redelivery after a crash resumes after it. */
  ack(sessionId: string, seq: number): void {
    this.update(sessionId, (record) => ({ ...record, mailboxSeq: Math.max(record.mailboxSeq, seq) }))
  }

  /**
   * Activate an idle session for one turn (wake-on-message): ACTIVE, and its turn counted.
   * Refused (a `gate` decision) when the session is not idle or its turn budget is spent.
   */
  activate(sessionId: string, nativeHandle: string | undefined): { activated: true } | { activated: false; reason: string } {
    return this.ctx.store.transaction(() => {
      const session = this.session(sessionId)
      const turns = session?.usage?.turns ?? 0
      const reason = !session ? `no session ${sessionId}`
        : session.state !== 'IDLE' ? `session ${sessionId} is ${session.state}`
          : turns >= session.budgets.maxTurns ? `session ${sessionId} has used its ${session.budgets.maxTurns} turns`
            : !nativeHandle ? `session ${sessionId} has no conversation to resume` : undefined
      if (reason) {
        if (session && session.state === 'IDLE') {
          this.ctx.artifacts.recordDecision({
            decisionType: 'gate',
            question: `May session ${sessionId} take another turn?`,
            inputs: [],
            candidates: [{ option: 'activate', selected: false, reasons: [] }, { option: 'refuse', selected: true, reasons: [reason] }],
            decider: { type: 'policy', id: 'sessions.budget', version: '1' },
            outcome: { option: 'refuse', detail: { turns } },
            deterministic: true,
          }, { producer: { type: 'system', ref: 'worker-sessions' } })
        }
        return { activated: false, reason }
      }
      this.update(sessionId, (r) => ({ ...r, state: 'ACTIVE', binding: { ...r.binding, nativeHandle: nativeHandle! }, usage: { turns: turns + 1, messagesSent: r.usage?.messagesSent ?? 0 } }))
      return { activated: true }
    })
  }

  /** End an activation: the session is idle again. */
  settle(sessionId: string): void {
    this.update(sessionId, (r) => (r.state === 'ACTIVE' ? { ...r, state: 'IDLE' } : r))
  }

  /** The sessions a run formed (its team members). */
  ofRun(runId: string): WorkerSession[] {
    return (this.ctx.store.db.prepare("SELECT record FROM worker_sessions WHERE json_extract(record, '$.runId') = ? ORDER BY session_id").all(runId) as Array<{ record: string }>)
      .map((r) => JSON.parse(r.record) as WorkerSession)
  }

  /** Sessions with unread messages (after their acknowledged sequence). */
  pending(): string[] {
    return (this.ctx.store.db.prepare(`SELECT DISTINCT m.session_id AS id FROM mailbox m JOIN worker_sessions s ON s.session_id = m.session_id
      WHERE m.seq > json_extract(s.record, '$.mailboxSeq') ORDER BY m.session_id`).all() as Array<{ id: string }>).map((r) => r.id)
  }

  /** The group id in a policy allows the group and every member of it. */
  private allowed(sender: WorkerSession, target: string): boolean {
    if (sender.policy.mayMessage.includes(target)) return true
    const member = this.session(target)
    return !!member && member.group === sender.group && !!sender.group && sender.policy.mayMessage.includes(sender.group)
  }

  private refusal(message: Message, reason: string): ContentId {
    const target = 'group' in message.to ? message.to.group : message.to.session
    return this.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `May ${message.from} message ${target}?`,
      inputs: [],
      candidates: [{ option: 'deliver', selected: false, reasons: [] }, { option: 'refuse', selected: true, reasons: [reason] }],
      decider: { type: 'policy', id: 'sessions.policy', version: '1' },
      outcome: { option: 'refuse', detail: { messageId: message.messageId } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'worker-sessions' } }).id
  }

  private update(sessionId: string, change: (record: WorkerSession) => WorkerSession): WorkerSession {
    return this.ctx.store.transaction((db) => {
      const current = this.session(sessionId)
      if (!current) throw new Error(`unknown session ${sessionId}`)
      const next = { ...change(current), revision: current.revision + 1 }
      this.schemas.assertRecord(next)
      db.prepare('UPDATE worker_sessions SET record = ?, updated_at = ? WHERE session_id = ?').run(JSON.stringify(next), now(), sessionId)
      return next
    })
  }
}

export default WorkerSessions
