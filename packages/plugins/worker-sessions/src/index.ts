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
import type {} from '@tsuuanmi/system-ledger-core'
import { type ContentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import { outline, reply } from '@tsuuanmi/system-gateway-core'
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
/**
 * The session binding's runtime kinds: the `worker-session@1.x` schema's vocabulary (metadata, never
 * routing). `antigravity-cli` came with `@1.1`.
 */
export const RUNTIMES = ['website', 'claude-agent-sdk', 'codex-sdk', 'antigravity-cli', 'acp', 'a2a', 'local-tool', 'model-api'] as const
export type Runtime = typeof RUNTIMES[number]

/** A `worker-session@1.x` record: `@1.1` when its binding's runtime is one `@1.0` does not name, `@1.0` otherwise. */
export interface WorkerSession {
  schema: 'worker-session@1.0' | 'worker-session@1.1'
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
  budgets: { maxTurns: number; maxMessages: number; maxLifetimeMinutes: number; maxIdleMinutes?: number; checkpointEveryTurns?: number; compactAtTokens?: number }
  usage?: { turns: number; messagesSent: number; estimatedTokens?: number }
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

/** Senders that are not sessions: the operator, and an MCP client holding the client scope (ADR-0023). */
export const EXTERNAL_SENDERS: readonly string[] = ['operator', 'client']

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
  /** Turns one session may take (default 100). */
  maxTurns?: number
  /** Minutes a session lives (default 1440). */
  maxLifetimeMinutes?: number
  /** Minutes a session may sit idle before it can no longer be woken (default 720). */
  maxIdleMinutes?: number
  /** A checkpoint artifact every this many turns (default 10, REQ-SES-6). */
  checkpointEveryTurns?: number
  /** Estimated context tokens at which the session is compacted into a handoff (default 60000). */
  compactAtTokens?: number
}

/** A write from an activation the session has moved past: refused, nothing changed (REQ-SES-1). */
export class StaleActivation extends Error {
  constructor(readonly sessionId: string, readonly generation: number, readonly current: number) {
    super(`session ${sessionId}: activation ${generation} is stale (the binding is at ${current})`)
    this.name = 'StaleActivation'
  }
}

/** A refused activation, classified by the budget it would exceed (REQ-SES-7). */
export type Refusal = { activated: false; reason: string; budget?: 'turns' | 'lifetime' | 'idle' }
const now = (): string => new Date().toISOString()

export class WorkerSessions extends Service {
  static inject = ['store', 'artifacts']
  static Config: z<Config> = z.object({
    maxMessages: z.natural().min(1).default(200).description('Messages one session may send'),
    maxTurns: z.natural().min(1).max(10_000).default(100).description('Turns one session may take'),
    maxLifetimeMinutes: z.natural().min(1).max(43_200).default(1440).description('Minutes a session lives'),
    maxIdleMinutes: z.natural().min(1).max(43_200).default(720).description('Minutes a session may sit idle and still be woken'),
    checkpointEveryTurns: z.natural().min(1).max(1000).default(10).description('A checkpoint artifact every this many turns'),
    compactAtTokens: z.natural().min(1000).default(60_000).description('Estimated context tokens at which a session is compacted into a handoff'),
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
    }, {
      // The idle budget is measured from the last activation (REQ-SES-7).
      version: 2,
      sql: 'ALTER TABLE worker_sessions ADD COLUMN last_active TEXT;',
    }])
    ctx.inject(['mcp'], (c) => {
      const json = (value: object) => reply(value, outline(value))
      c.mcp.tool('session_send', {
        scope: 'client',
        description: 'Send a message to a Worker session, or to its group, as the caller: the operator, or the client for a client token (recorded as a message artifact; delivered at most once).',
        inputSchema: {
          to: zod.string().max(200).describe('A SessionId, or a group id'),
          body: zod.string().min(1).max(32_000),
          intent: zod.enum(['inform', 'request', 'critique', 'answer', 'handoff', 'input-required', 'close']).optional(),
          messageId: zod.string().max(200).optional().describe('Retry-safe id; the same id is delivered once'),
        },
      }, async (args, { scope, lead }) => {
        const to = String(args.to)
        const isGroup = !!this.ctx.store.db.prepare('SELECT 1 FROM session_groups WHERE group_id = ?').get(to)
        // A lead answers the Workers of its own project only (T285, ADR-0076).
        const outside = lead === undefined ? undefined : await this.outsideProject(lead, isGroup ? { group: to } : { session: to })
        if (outside !== undefined) return { isError: true, content: [{ type: 'text' as const, text: outside }] }
        return json(this.send({
          // The audit trail names who wrote it (INV-13): a client token never writes as the operator.
          from: scope === 'operator' ? 'operator' : 'client', messageId: args.messageId ? String(args.messageId) : `${scope === 'operator' ? 'op' : 'cl'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          to: isGroup ? { group: to } : { session: to }, body: String(args.body), ...(args.intent ? { intent: args.intent as Message['intent'] & string } : {}),
        }))
      })
      c.mcp.tool('session_inbox', {
        scope: 'client',
        description: 'Read a Worker session: its record and its unread messages (not acknowledged).',
        inputSchema: { sessionId: zod.string().max(200) },
      }, async (args, context) => {
        const lead = context?.lead
        const session = this.session(String(args.sessionId))
        const outside = lead === undefined || !session ? undefined : await this.outsideProject(lead, { session: session.sessionId })
        if (outside !== undefined) return { isError: true, content: [{ type: 'text' as const, text: outside }] }
        return session
          ? json({ session, inbox: this.inbox(session.sessionId).map((m) => ({ seq: m.seq, from: m.from, intent: m.message.intent, body: m.message.body, artifact: m.artifact })) })
          : { isError: true, content: [{ type: 'text' as const, text: `unknown session ${String(args.sessionId)}` }] }
      })
    })
  }

  /**
   * Why a lead of `project` may not reach a session, or the sessions of a group; undefined when it may
   * (T285, ADR-0076). A session belongs to the project of the run it was made for, as the workflow
   * engine (`ctx.workflow.projectOfRun`) tells it. A session of no run, of another project's run, or one
   * that cannot be told (no engine loaded), and a group with no session, are not the lead's (INV-2).
   */
  async outsideProject(project: string, target: { session: string } | { group: string }): Promise<string | undefined> {
    const named = 'group' in target ? `group ${target.group}` : `session ${target.session}`
    const ids = 'group' in target
      ? (this.ctx.store.db.prepare('SELECT session_id FROM worker_sessions WHERE group_id = ? ORDER BY session_id').all(target.group) as Array<{ session_id: string }>).map((r) => r.session_id)
      : [target.session]
    const sessions = ids.map((id) => this.session(id))
    if (!sessions.length || sessions.some((s) => !s)) return `the lead token of project ${project} reaches only its own project's Workers; ${named} names no Worker session of it`
    const workflow = this.ctx.get('workflow' as never) as { projectOfRun?: (runId: string) => Promise<string | undefined> } | undefined
    for (const session of sessions as WorkerSession[]) {
      const of = session.runId !== undefined && typeof workflow?.projectOfRun === 'function' ? await workflow.projectOfRun(session.runId) : undefined
      if (of !== project) {
        return `the lead token of project ${project} reaches only its own project's Workers; session ${session.sessionId} belongs to ${of === undefined ? 'no project' : `project ${of}`}, so it is not yours to reach`
      }
    }
    return undefined
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
        schema: member.runtime === 'antigravity-cli' ? 'worker-session@1.1' : 'worker-session@1.0', sessionId: member.sessionId, group,
        ...(member.runId ? { runId: member.runId } : {}), ...(member.nodeId ? { nodeId: member.nodeId } : {}),
        worker: member.worker, role: member.role, formation: member.formation, state: 'IDLE', binding: { runtime: member.runtime, generation: 0 },
        policy: { mayMessage: member.mayMessage ?? [group], ...(row.barrier_open ? {} : { barrier: 'independent-first' }) },
        budgets: {
          maxTurns: this.config.maxTurns ?? 100, maxMessages: this.config.maxMessages ?? 200, maxLifetimeMinutes: this.config.maxLifetimeMinutes ?? 1440,
          maxIdleMinutes: this.config.maxIdleMinutes ?? 720, checkpointEveryTurns: this.config.checkpointEveryTurns ?? 10, compactAtTokens: this.config.compactAtTokens ?? 60_000,
        },
        usage: { turns: 0, messagesSent: 0, estimatedTokens: 0 },
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
   * Send a message (`operator` and `client`, the senders that are not sessions, may write to any
   * session). The group policy decides; a refusal
   * is a `gate` decision. Accepted, it becomes a `message@1.0` artifact appended to each
   * target's mailbox; a repeated sender message id is delivered once.
   */
  send(input: Omit<Message, 'schema'>): SendResult {
    const message: Message = { schema: 'message@1.0', ...input }
    return this.ctx.store.transaction((db) => {
      const external = EXTERNAL_SENDERS.includes(message.from)
      const sender = external ? undefined : this.session(message.from)
      const targets = 'group' in message.to
        ? (db.prepare('SELECT session_id FROM worker_sessions WHERE group_id = ? ORDER BY session_id').all(message.to.group) as Array<{ session_id: string }>).map((r) => r.session_id).filter((id) => id !== message.from)
        : [message.to.session]
      const target = 'group' in message.to ? message.to.group : message.to.session
      let reason: string | undefined
      if (!external && !sender) reason = `${message.from} is not a session`
      else if (sender && !this.allowed(sender, target)) reason = `${message.from} may not message ${target}`
      else if (sender && (sender.usage?.messagesSent ?? 0) >= sender.budgets.maxMessages) reason = `${message.from} has used its ${sender.budgets.maxMessages} messages`
      else if (!targets.length || targets.some((id) => !this.session(id))) reason = `no session ${target}`
      if (reason) return { accepted: false, reason, decision: this.refusal(message, reason) }
      const artifact = this.ctx.artifacts.put({
        kind: 'message', bodySchema: 'message@1.0', body: message, classification: 'operator-shared',
        producer: message.from === 'operator' ? { type: 'operator', ref: 'operator' } : message.from === 'client' ? { type: 'system', ref: 'mcp-client' } : { type: 'worker', ref: message.from },
        inputs: message.refs ?? [], ...(sender?.runId ? { runId: sender.runId } : {}), ...(sender?.nodeId ? { nodeId: sender.nodeId } : {}),
      }).id
      const delivered: string[] = []
      for (const id of targets) {
        const next = ((db.prepare('SELECT MAX(seq) AS seq FROM mailbox WHERE session_id = ?').get(id) as { seq: number | null }).seq ?? 0) + 1
        const inserted = db.prepare('INSERT OR IGNORE INTO mailbox (session_id, seq, sender, message_id, artifact, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, next, message.from, message.messageId, artifact, now())
        if (Number(inserted.changes) > 0) delivered.push(id)
      }
      if (sender && delivered.length) this.update(sender.sessionId, (r) => ({ ...r, usage: { ...r.usage, turns: r.usage?.turns ?? 0, messagesSent: (r.usage?.messagesSent ?? 0) + 1 } }))
      // A session waiting for input wakes on any reply; an idle one only on a message that asks for one.
      const waking = delivered.filter((id) => WAKING.has(message.intent) || this.session(id)?.state === 'INPUT_REQUIRED')
      if (waking.length) this.ctx.store.afterCommit(() => this.ctx.emit('worker-sessions/delivered', waking))
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
   * Activate a session for one turn (wake-on-message): from IDLE, or from INPUT_REQUIRED once
   * input arrived. ACTIVE needs the native conversation it resumes. A spent turn, lifetime, or
   * idle budget is a classified failure (REQ-SES-7): the session becomes FAILED and a `gate`
   * decision names the budget. Each activation advances the binding generation, which every
   * write the activation makes presents ({@link settle}), so a superseded one is fenced (REQ-SES-1).
   */
  activate(sessionId: string, nativeHandle: string | undefined, now: number = Date.now()): { activated: true; generation: number } | Refusal {
    return this.ctx.store.transaction((db) => {
      const session = this.session(sessionId)
      if (!session) return { activated: false, reason: `no session ${sessionId}` }
      if (session.state !== 'IDLE' && session.state !== 'INPUT_REQUIRED') return { activated: false, reason: `session ${sessionId} is ${session.state}` }
      const turns = session.usage?.turns ?? 0
      const lastActive = (db.prepare('SELECT last_active FROM worker_sessions WHERE session_id = ?').get(sessionId) as { last_active: string | null }).last_active ?? session.createdAt
      const idle = session.budgets.maxIdleMinutes
      const exceeded: [Refusal['budget'] & string, string] | undefined = turns >= session.budgets.maxTurns ? ['turns', `session ${sessionId} has used its ${session.budgets.maxTurns} turns`]
        : now - Date.parse(session.createdAt) > session.budgets.maxLifetimeMinutes * 60_000 ? ['lifetime', `session ${sessionId} has outlived its ${session.budgets.maxLifetimeMinutes} minutes`]
          : idle !== undefined && now - Date.parse(lastActive) > idle * 60_000 ? ['idle', `session ${sessionId} has been idle longer than ${idle} minutes`] : undefined
      if (exceeded) {
        this.ctx.artifacts.recordDecision({
          decisionType: 'gate',
          question: `May session ${sessionId} take another turn?`,
          inputs: [],
          candidates: [{ option: 'activate', selected: false, reasons: [`not activate: its ${exceeded[0]} budget is spent`] }, { option: 'refuse', selected: true, reasons: [exceeded[1]] }],
          decider: { type: 'policy', id: 'sessions.budget', version: '1' },
          outcome: { option: 'refuse', detail: { budget: exceeded[0], turns } },
          deterministic: true,
        }, { producer: { type: 'system', ref: 'worker-sessions' } })
        this.update(sessionId, (r) => ({ ...r, state: 'FAILED' }))
        return { activated: false, reason: exceeded[1], budget: exceeded[0] }
      }
      if (!nativeHandle) return { activated: false, reason: `session ${sessionId} has no conversation to resume` }
      const next = this.update(sessionId, (r) => ({ ...r, state: 'ACTIVE', binding: { ...r.binding, nativeHandle, generation: r.binding.generation + 1 }, usage: { ...r.usage, turns: turns + 1, messagesSent: r.usage?.messagesSent ?? 0 } }))
      return { activated: true, generation: next.binding.generation }
    })
  }

  /**
   * End an activation: idle again, or INPUT_REQUIRED when the session asked for input it cannot
   * proceed without (REQ-SES-7). The turn's estimated tokens add to the session's context, and the
   * native handle is the one the turn ran in (a fresh conversation after a compaction). The
   * activation presents its generation: a superseded one is refused ({@link StaleActivation}) and
   * changes nothing (REQ-SES-1, INV-4).
   */
  settle(sessionId: string, generation: number, turn: { inputRequired?: boolean; tokens?: number; nativeHandle?: string } = {}): WorkerSession {
    return this.ctx.store.transaction((db) => {
      const current = this.session(sessionId)
      if (current && current.binding.generation !== generation) throw new StaleActivation(sessionId, generation, current.binding.generation)
      const next = this.update(sessionId, (r) => (r.state === 'ACTIVE'
        ? {
          ...r, state: turn.inputRequired ? 'INPUT_REQUIRED' : 'IDLE',
          binding: { ...r.binding, ...(turn.nativeHandle ? { nativeHandle: turn.nativeHandle } : {}) },
          usage: { ...r.usage, turns: r.usage?.turns ?? 0, messagesSent: r.usage?.messagesSent ?? 0, estimatedTokens: (r.usage?.estimatedTokens ?? 0) + (turn.tokens ?? 0) },
        }
        : r))
      db.prepare('UPDATE worker_sessions SET last_active = ? WHERE session_id = ?').run(now(), sessionId)
      return next
    })
  }

  /**
   * After a compaction (REQ-SES-6): the session continues in a new native conversation, from its
   * handoff summary. Its SessionId stays; its binding generation advances, and its context is the
   * summary's size.
   */
  rebind(sessionId: string, tokens: number): WorkerSession {
    return this.update(sessionId, (r) => ({ ...r, binding: { ...r.binding, generation: r.binding.generation + 1 }, usage: { ...r.usage, turns: r.usage?.turns ?? 0, messagesSent: r.usage?.messagesSent ?? 0, estimatedTokens: tokens } }))
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
      candidates: [{ option: 'deliver', selected: false, reasons: [`not deliver: ${reason}`] }, { option: 'refuse', selected: true, reasons: [reason] }],
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
