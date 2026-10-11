/**
 * `ctx.turns`: the website turn runtime (MVP slice 1, `ask`). A turn is durable from the
 * moment it is accepted: routed to the first ready account (a `route` decision, INV-13),
 * run on that account's scheduler in a fresh browser context, receipted immediately
 * before the send (INV-4), and answered as a `report` artifact. One-shot asks use the
 * provider's temporary conversation; `persist` or `sessionId` uses a persistent one bound
 * to its conversation id (docs/design/provider-turns.md#conversation-modes).
 * @module @tsuuanmi/system-turns
 */
import { randomBytes } from 'node:crypto'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-accounts'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-browser-patchright'
import { type ContentId, sha256 } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-mcp-server'
import { type ConversationMode, type Disposition, ProviderError, type ProviderFeature, ProviderScheduler, type Tier, dispositionOf } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-providers'
import type {} from '@tsuuanmi/system-store'
import type {} from '@tsuuanmi/system-turn-receipts'
import { z as zod } from 'zod'

declare module '@deepseek-ai/cordis' {
  interface Context {
    turns: Turns
  }
}

export type TurnStatus = 'queued' | 'running' | 'completed' | 'failed'

/** What callers see: never the prompt, never account state. */
export interface TurnView {
  turnId: string
  status: TurnStatus
  mode: ConversationMode
  feature: ProviderFeature
  tier: Tier
  sessionId?: string
  account?: string
  binding?: string
  answer?: string
  answerArtifact?: ContentId
  routeDecision?: ContentId
  tierDecision?: ContentId
  error?: { kind: string; disposition: Disposition; message: string }
  createdAt: string
  updatedAt: string
}

export interface AskInput {
  prompt: string
  /** Continue a persistent session. */
  sessionId?: string | undefined
  /** Start a persistent session (a normal conversation) instead of a temporary one. */
  persist?: boolean | undefined
  /** Retry-safe request key: the same key returns the same turn. */
  clientRequestId?: string | undefined
  /** Intelligence tier; mapped through the account's catalog to a provider mode preset. */
  tier?: Tier | undefined
  /** `deep-research` always runs in a persistent session. */
  feature?: ProviderFeature | undefined
}

export interface ResearchInput {
  question: string
  sessionId?: string | undefined
  clientRequestId?: string | undefined
}

const TIERS: readonly Tier[] = ['economy', 'standard', 'frontier']

export interface Config {
  maxConcurrentTurnsPerAccount?: number
  /** Tier for turns that name none (default `standard`). */
  defaultTier?: Tier
  /** Hard deadline per chat turn (default 15 min). */
  turnTimeoutMs?: number
  /** No-progress deadline per chat turn (default 5 min). */
  stallTimeoutMs?: number
  /** Hard deadline per Deep research turn (default 60 min). */
  researchTimeoutMs?: number
  /** No-progress deadline per Deep research turn (default 30 min). */
  researchStallTimeoutMs?: number
}

interface Row {
  turn_id: string
  request_key: string | null
  session_id: string | null
  mode: ConversationMode
  feature: ProviderFeature
  tier: Tier
  prompt: string
  status: TurnStatus
  account: string | null
  binding: string | null
  answer: string | null
  answer_artifact: string | null
  route_decision: string | null
  tier_decision: string | null
  error: string | null
  created_at: string
  updated_at: string
}

interface SessionRow {
  session_id: string
  account: string | null
  binding: string | null
}

const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`
const now = (): string => new Date().toISOString()
const TERMINAL: ReadonlySet<TurnStatus> = new Set(['completed', 'failed'])

export class Turns extends Service {
  static inject = ['store', 'artifacts', 'turnReceipts', 'accounts', 'browser', 'providers']

  static Config: z<Config> = z.object({
    maxConcurrentTurnsPerAccount: z.natural().min(1).default(2).description('Parallel turns per account (different sessions)'),
    defaultTier: z.union(['economy', 'standard', 'frontier']).default('standard').description('Tier for turns that name none'),
    turnTimeoutMs: z.natural().default(15 * 60_000).description('Hard deadline per chat turn, in milliseconds'),
    stallTimeoutMs: z.natural().default(5 * 60_000).description('No-progress deadline per chat turn, in milliseconds'),
    researchTimeoutMs: z.natural().default(60 * 60_000).description('Hard deadline per Deep research turn, in milliseconds'),
    researchStallTimeoutMs: z.natural().default(30 * 60_000).description('No-progress deadline per Deep research turn, in milliseconds'),
  })

  private readonly schedulers = new Map<string, ProviderScheduler>()
  private readonly waiters = new Map<string, Set<() => void>>()
  /** Turns of one session run in acceptance order, each after the previous one settles. */
  private readonly sessionChains = new Map<string, Promise<void>>()
  private stopping = false

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'turns')
    ctx.store.migrate('turns', [{
      version: 1,
      sql: `CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY, request_key TEXT UNIQUE, session_id TEXT, mode TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, account TEXT, binding TEXT, answer TEXT, answer_artifact TEXT, route_decision TEXT,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX turns_status ON turns (status);
      CREATE TABLE turn_sessions (session_id TEXT PRIMARY KEY, account TEXT NOT NULL, binding TEXT, created_at TEXT NOT NULL);`,
    }, {
      // Tier and feature per turn; sessions exist from acceptance, before an account is chosen.
      version: 2,
      sql: `ALTER TABLE turns ADD COLUMN feature TEXT NOT NULL DEFAULT 'chat';
      ALTER TABLE turns ADD COLUMN tier TEXT NOT NULL DEFAULT 'standard';
      ALTER TABLE turns ADD COLUMN tier_decision TEXT;
      CREATE TABLE turn_sessions_v2 (session_id TEXT PRIMARY KEY, account TEXT, binding TEXT, created_at TEXT NOT NULL);
      INSERT INTO turn_sessions_v2 SELECT session_id, account, binding, created_at FROM turn_sessions;
      DROP TABLE turn_sessions;
      ALTER TABLE turn_sessions_v2 RENAME TO turn_sessions;`,
    }])
    ctx.effect(() => {
      queueMicrotask(() => this.recover())
      return () => {
        // A stop is not a failure: running and queued turns stay as they are for the next start.
        this.stopping = true
        for (const scheduler of this.schedulers.values()) scheduler.close(new ProviderError('aborted', 'turn runtime stopped'))
      }
    })
    ctx.inject(['mcp'], (c) => this.registerTools(c))
  }

  /** Accept an ask: durable at once, run in the background. */
  ask(input: AskInput): TurnView {
    const prompt = input.prompt
    if (!prompt.trim()) throw new ProviderError('invalid_input', 'prompt must not be empty')
    const requestKey = input.clientRequestId ? sha256(`ask\0${input.clientRequestId}`) : null
    const view = this.ctx.store.transaction((db) => {
      if (requestKey) {
        const existing = db.prepare('SELECT * FROM turns WHERE request_key = ?').get(requestKey) as Row | undefined
        if (existing) {
          if (existing.prompt !== prompt) throw new ProviderError('invalid_input', 'clientRequestId was reused with a different prompt')
          return this.view(existing)
        }
      }
      const feature = input.feature ?? 'chat'
      const tier = input.tier ?? this.config.defaultTier ?? 'standard'
      if (!TIERS.includes(tier)) throw new ProviderError('invalid_input', `unknown tier ${String(tier)}`)
      let sessionId: string | null = null
      if (input.sessionId) {
        if (!db.prepare('SELECT 1 FROM turn_sessions WHERE session_id = ?').get(input.sessionId)) {
          throw new ProviderError('invalid_input', `unknown session ${input.sessionId}`)
        }
        sessionId = input.sessionId
      } else if (input.persist || feature === 'deep-research') {
        sessionId = newId('ses')
        db.prepare('INSERT INTO turn_sessions (session_id, account, binding, created_at) VALUES (?, NULL, NULL, ?)').run(sessionId, now())
      }
      const row: Row = {
        turn_id: newId('turn'), request_key: requestKey, session_id: sessionId, mode: sessionId ? 'persistent' : 'temporary', feature, tier,
        prompt, status: 'queued', account: null, binding: null, answer: null, answer_artifact: null, route_decision: null, tier_decision: null,
        error: null, created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO turns (turn_id, request_key, session_id, mode, feature, tier, prompt, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(row.turn_id, requestKey, sessionId, row.mode, feature, tier, prompt, row.created_at, row.updated_at)
      this.ctx.store.afterCommit(() => void this.schedule(row))
      return this.view(row)
    })
    return view
  }

  /** Start Deep research in a persistent session; returns at once (REQ-SES-8). */
  research(input: ResearchInput): TurnView {
    return this.ask({
      prompt: input.question, feature: 'deep-research', sessionId: input.sessionId, clientRequestId: input.clientRequestId,
      ...(input.sessionId ? {} : { persist: true }),
    })
  }

  get(turnId: string): TurnView | undefined {
    const row = this.row(turnId)
    return row ? this.view(row) : undefined
  }

  list(): TurnView[] {
    return (this.ctx.store.db.prepare('SELECT * FROM turns ORDER BY created_at').all() as unknown as Row[]).map((r) => this.view(r))
  }

  /** Resolve when the turn is terminal or `timeoutMs` passes (then with its current state). */
  async wait(turnId: string, timeoutMs: number): Promise<TurnView> {
    const current = this.get(turnId)
    if (!current) throw new ProviderError('invalid_input', `unknown turn ${turnId}`)
    if (TERMINAL.has(current.status)) return current
    await new Promise<void>((resolve) => {
      let set = this.waiters.get(turnId)
      if (!set) this.waiters.set(turnId, (set = new Set()))
      const done = (): void => {
        clearTimeout(timer)
        set.delete(done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      set.add(done)
    })
    return this.get(turnId)!
  }

  /** On start: queued turns run again; a running turn without a receipt was never sent and runs again; one with a receipt is not resent. */
  private recover(): void {
    if (this.stopping) return
    const rows = this.ctx.store.db.prepare(`SELECT * FROM turns WHERE status IN ('queued', 'running') ORDER BY created_at`).all() as unknown as Row[]
    for (const row of rows) {
      const receipt = row.account ? this.ctx.turnReceipts.read(this.identity(row, row.account)) : undefined
      if (row.status === 'running' && receipt) {
        // Recovering a submitted turn needs the conversation snapshot; a temporary one cannot be reopened.
        this.fail(row.turn_id, new ProviderError('reconciliation_failed',
          'the host stopped after this prompt was sent; it is not resent automatically (ambiguous whether the provider answered)'))
        continue
      }
      this.schedule(row)
    }
  }

  /** Run a turn now, or after the previous turn of its session settles. */
  private schedule(row: Row): void {
    if (!row.session_id) {
      void this.run(row.turn_id)
      return
    }
    const previous = this.sessionChains.get(row.session_id) ?? Promise.resolve()
    const next = previous.then(() => this.run(row.turn_id))
    this.sessionChains.set(row.session_id, next)
    void next.finally(() => {
      if (this.sessionChains.get(row.session_id!) === next) this.sessionChains.delete(row.session_id!)
    })
  }

  private async run(turnId: string): Promise<void> {
    const row = this.row(turnId)
    if (!row || TERMINAL.has(row.status) || this.stopping) return
    try {
      const account = row.account ?? (await this.route(row))
      const scheduler = this.scheduler(account)
      await scheduler.runTurn(row.session_id ?? row.turn_id, undefined, async (lease) => {
        this.update(turnId, { status: 'running' })
        await this.execute(this.row(turnId)!, account, lease.signal)
      })
    } catch (error) {
      if (this.stopping) return
      this.fail(turnId, error)
    }
  }

  /** Persistent sessions stay on their account; otherwise the first ready account in catalog order. */
  private async route(row: Row): Promise<string> {
    const accounts = await this.ctx.accounts.list()
    const providers = new Set(this.ctx.providers.list())
    const session = row.session_id ? this.session(row.session_id) : undefined
    const bound = session?.account ?? undefined
    let chosen: string | undefined
    const candidates = accounts.map((a) => {
      const reasons: string[] = []
      if (bound && a.id !== bound) reasons.push(`session is bound to ${bound}`)
      else if (!providers.has(a.provider)) reasons.push(`no driver for ${a.provider}`)
      else if (a.status !== 'ready') reasons.push(`status ${a.status}`)
      const selected = reasons.length === 0 && chosen === undefined
      if (selected) chosen = a.id
      else if (reasons.length === 0) reasons.push('a ready account earlier in the catalog was chosen')
      return { option: a.id, selected, reasons: selected ? [bound ? 'the session\'s account' : 'first ready account'] : reasons }
    })
    if (!chosen) {
      throw new ProviderError('reauth_required', `no ready account can take this turn (${candidates.map((c) => `${c.option}: ${c.reasons.join(', ')}`).join('; ') || 'no accounts configured'})`)
    }
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'route',
      question: `Which account runs turn ${row.turn_id}?`,
      inputs: [],
      candidates,
      decider: { type: 'rule', id: 'turns.route.first-ready', version: '1' },
      outcome: { option: chosen },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'turns' } })
    const account = chosen
    const preset = accounts.find((a) => a.id === account)?.tiers[row.tier]
    const tier = this.ctx.artifacts.recordDecision({
      decisionType: 'tier',
      question: `Which intelligence tier and mode preset does turn ${row.turn_id} use on ${account}?`,
      inputs: [decision.id],
      candidates: TIERS.map((t) => ({ option: t, selected: t === row.tier, reasons: t === row.tier ? [row.tier === (this.config.defaultTier ?? 'standard') ? 'requested or default tier' : 'requested tier'] : [] })),
      decider: { type: 'rule', id: 'turns.tier.catalog', version: '1' },
      outcome: { option: row.tier, detail: { account, preset: preset ?? null } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'turns' } })
    this.ctx.store.transaction((db) => {
      // A new persistent session is bound to the first account that runs it.
      if (row.session_id) db.prepare('UPDATE turn_sessions SET account = COALESCE(account, ?) WHERE session_id = ?').run(account, row.session_id)
    })
    this.update(row.turn_id, { account, route_decision: decision.id, tier_decision: tier.id })
    return account
  }

  private async execute(row: Row, accountId: string, signal: AbortSignal): Promise<void> {
    const view = await this.ctx.accounts.get(accountId)
    if (view.status !== 'ready') throw new ProviderError('reauth_required', `${accountId} is ${view.status}`)
    const driver = this.ctx.providers.get(view.provider)
    const state = await this.ctx.accounts.portableState(accountId)
    const session = row.session_id ? this.session(row.session_id) : undefined
    const identity = this.identity(row, accountId)
    const research = row.feature === 'deep-research'
    const deadlines = research
      ? { timeoutMs: this.config.researchTimeoutMs ?? 60 * 60_000, stallTimeoutMs: this.config.researchStallTimeoutMs ?? 30 * 60_000 }
      : { timeoutMs: this.config.turnTimeoutMs ?? 15 * 60_000, stallTimeoutMs: this.config.stallTimeoutMs ?? 5 * 60_000 }
    const turn = await this.ctx.browser.openTurn(accountId, { state, signal })
    let result: Awaited<ReturnType<typeof driver.ask>>
    try {
      result = await driver.ask(turn.page, row.prompt, {
        conversation: row.mode,
        binding: session?.binding ?? undefined,
        mode: view.tiers[row.tier],
        feature: row.feature,
        signal,
        deadlines,
        beforeSend: ({ previousResponse, mode }) => {
          this.ctx.turnReceipts.submit({
            ...identity, prompt: row.prompt, previousResponse,
            conversation: { provider: view.provider, binding: session?.binding ?? '' },
            mode: { verified: true, tier: row.tier, ...mode, feature: row.feature },
          })
        },
      })
    } catch (error) {
      await turn.close()
      // Positive evidence only (the driver saw the login surface): the account needs the operator.
      if (error instanceof ProviderError && error.kind === 'reauth_required') {
        await this.ctx.accounts.markSignedOut(accountId, 'login-surface', view.revision).catch(() => undefined)
      }
      throw error
    }
    try {
      this.ctx.store.transaction(() => {
        if (result.binding) {
          this.ctx.turnReceipts.bindConversation(identity, result.binding)
          if (row.session_id) {
            this.ctx.store.db.prepare(`INSERT INTO turn_sessions (session_id, account, binding, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (session_id) DO UPDATE SET binding = excluded.binding`).run(row.session_id, accountId, result.binding, now())
          }
        }
        this.ctx.turnReceipts.complete(identity, { response: result.text, providerTurnId: result.binding ?? row.turn_id })
        const answer = this.ctx.artifacts.put({
          kind: 'report',
          bodySchema: 'provider-answer@1.0',
          body: {
            schema: 'provider-answer@1.0', provider: view.provider, account: accountId, turnId: row.turn_id,
            ...(row.session_id ? { sessionId: row.session_id } : {}),
            conversation: { mode: row.mode, ...(result.binding ? { binding: result.binding } : {}) },
            promptHash: sha256(row.prompt), text: result.text,
          },
          classification: 'local-private',
          producer: { type: 'worker', ref: `${view.provider}/${accountId}` },
          inputs: row.route_decision ? [row.route_decision as ContentId] : [],
        })
        this.update(row.turn_id, { status: 'completed', answer: result.text, answer_artifact: answer.id, binding: result.binding ?? null })
      })
    } finally {
      await turn.close()
    }
  }

  private registerTools(c: Context): void {
    const shape = (view: TurnView) => ({ content: [{ type: 'text' as const, text: view.answer ?? JSON.stringify(view) }], structuredContent: { ...view } })
    const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] })
    const waitSeconds = zod.number().int().min(0).max(55).optional().describe('How long to wait for the answer before returning (default 45 s)')
    const tier = zod.enum(['economy', 'standard', 'frontier']).optional().describe('Intelligence tier; the account catalog maps it to a model and effort preset')
    c.mcp.tool('ask', {
      description: 'Ask a website model (a separate chat quota) through a saved account. One-shot by default (temporary conversation); persist=true or sessionId continues a conversation. Returns the answer, or a turnId to poll with `result` if it takes longer than waitSeconds.',
      inputSchema: {
        prompt: zod.string().min(1).max(32_000),
        sessionId: zod.string().max(200).optional().describe('Continue an existing persistent session'),
        persist: zod.boolean().optional().describe('Start a persistent session (a normal conversation)'),
        tier,
        clientRequestId: zod.string().max(200).optional().describe('Retry-safe request key'),
        waitSeconds,
      },
    }, async (args) => {
      try {
        const started = this.ask({
          prompt: String(args.prompt), sessionId: args.sessionId as string | undefined,
          persist: args.persist as boolean | undefined, clientRequestId: args.clientRequestId as string | undefined,
          tier: args.tier as Tier | undefined,
        })
        return shape(await this.wait(started.turnId, ((args.waitSeconds as number | undefined) ?? 45) * 1000))
      } catch (error) {
        return failure(error)
      }
    })
    c.mcp.tool('research', {
      description: 'Start provider-native Deep research in a persistent session. Returns at once with a turnId and sessionId; poll `result` (runs take minutes to tens of minutes).',
      inputSchema: {
        question: zod.string().min(1).max(32_000),
        sessionId: zod.string().max(200).optional().describe('Run in an existing persistent session'),
        clientRequestId: zod.string().max(200).optional().describe('Retry-safe request key'),
      },
    }, async (args) => {
      try {
        return shape(this.research({
          question: String(args.question), sessionId: args.sessionId as string | undefined, clientRequestId: args.clientRequestId as string | undefined,
        }))
      } catch (error) {
        return failure(error)
      }
    })
    c.mcp.tool('result', {
      description: 'Fetch a turn started by `ask`; waits up to waitSeconds for it to finish.',
      inputSchema: { turnId: zod.string().max(200), waitSeconds },
    }, async (args) => {
      try {
        return shape(await this.wait(String(args.turnId), ((args.waitSeconds as number | undefined) ?? 45) * 1000))
      } catch (error) {
        return failure(error)
      }
    })
  }

  private scheduler(account: string): ProviderScheduler {
    let scheduler = this.schedulers.get(account)
    if (!scheduler) this.schedulers.set(account, (scheduler = new ProviderScheduler(this.config.maxConcurrentTurnsPerAccount ?? 2)))
    return scheduler
  }

  private identity(row: Row, account: string) {
    return { account, sessionId: row.session_id ?? row.turn_id, requestId: row.turn_id }
  }

  private session(sessionId: string): SessionRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM turn_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined
  }

  private row(turnId: string): Row | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId) as Row | undefined
  }

  private fail(turnId: string, error: unknown): void {
    const typed = error instanceof ProviderError ? error : new ProviderError('session_broken', (error as Error)?.message ?? String(error), { cause: error })
    this.update(turnId, { status: 'failed', error: JSON.stringify({ kind: typed.kind, disposition: dispositionOf(typed.kind), message: typed.message }) })
  }

  private update(turnId: string, fields: Partial<Omit<Row, 'turn_id'>>): void {
    const entries = Object.entries({ ...fields, updated_at: now() })
    this.ctx.store.transaction((db) => {
      db.prepare(`UPDATE turns SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE turn_id = ?`).run(...entries.map(([, v]) => v as string | null), turnId)
    })
    if (fields.status && TERMINAL.has(fields.status)) {
      this.ctx.store.afterCommit(() => {
        for (const wake of this.waiters.get(turnId) ?? []) wake()
        this.waiters.delete(turnId)
      })
    }
  }

  private view(row: Row): TurnView {
    return {
      turnId: row.turn_id, status: row.status, mode: row.mode, feature: row.feature, tier: row.tier,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.account ? { account: row.account } : {}),
      ...(row.binding ? { binding: row.binding } : {}),
      ...(row.answer !== null ? { answer: row.answer } : {}),
      ...(row.answer_artifact ? { answerArtifact: row.answer_artifact as ContentId } : {}),
      ...(row.route_decision ? { routeDecision: row.route_decision as ContentId } : {}),
      ...(row.tier_decision ? { tierDecision: row.tier_decision as ContentId } : {}),
      ...(row.error ? { error: JSON.parse(row.error) as TurnView['error'] & object } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}

export default Turns
