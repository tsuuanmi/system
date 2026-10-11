/**
 * `ctx.turns`: the website turn runtime (MVP slice 1, `ask`). A turn is durable from the
 * moment it is accepted: routed through `ctx.workers`, to which this runtime contributes one
 * website Worker per account and mapped tier (`tier` and `route` decisions, INV-13), run on
 * that account's scheduler in a fresh browser context, receipted immediately
 * before the send (INV-4), and answered as a `report` artifact. One-shot asks use the
 * provider's temporary conversation; `persist` or `sessionId` uses a persistent one bound
 * to its conversation id (docs/design/provider-turns.md#conversation-modes).
 * @module @tsuuanmi/system-turns
 */
import { randomBytes } from 'node:crypto'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AccountStatus } from '@tsuuanmi/system-accounts'
import type { Classification } from '@tsuuanmi/system-egress'
import type {} from '@tsuuanmi/system-event-log'
import type {} from '@tsuuanmi/system-login'
import type {} from '@tsuuanmi/system-artifacts'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { type ContentId, sha256 } from '@tsuuanmi/system-libs'
import { type BrowserTurn, type ConversationMode, type Disposition, type PortableState, ProviderError, type ProviderFeature, ProviderScheduler, type Tier, type TurnReceipt, type TurnSnapshot, dispositionOf, toProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import type {} from '@tsuuanmi/system-turn-receipts'
import type { CapabilityDescriptor, WorkerExecution, WorkerStart, WorkerState } from '@tsuuanmi/system-workers-core'

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
  /** The minimum tier asked for; the Worker's own tier may be higher. */
  tier: Tier
  sessionId?: string
  account?: string
  /** The admitted Worker, `worker:<account>/<tier>`. */
  worker?: string
  /** The prompt reached the provider (its receipt was written): a caller must never resend it (INV-4). */
  submitted: boolean
  binding?: string
  answer?: string
  answerArtifact?: ContentId
  routeDecision?: ContentId
  tierDecision?: ContentId
  egressDecision?: ContentId
  error?: { kind: string; disposition: Disposition; message: string }
  createdAt: string
  updatedAt: string
}

const TIERS: readonly Tier[] = ['economy', 'standard', 'frontier']

export interface Config {
  maxConcurrentTurnsPerAccount?: number
  /** Hard deadline per chat turn (default 15 min). */
  turnTimeoutMs?: number
  /** No-progress deadline per chat turn (default 5 min). */
  stallTimeoutMs?: number
  /** Hard deadline per Deep research turn (default 60 min). */
  researchTimeoutMs?: number
  /** No-progress deadline per Deep research turn (default 30 min). */
  researchStallTimeoutMs?: number
  /** Accepted turns not yet finished, across accounts (default 32); more are refused (INV-9). */
  maxPendingTurns?: number
  /** Finished turns, with their prompts, are deleted after this many days (default 30). */
  retainDays?: number
}

interface Row {
  turn_id: string
  request_key: string | null
  session_id: string | null
  mode: ConversationMode
  feature: ProviderFeature
  tier: Tier
  tier_source: string
  acceptance: string
  objective: string | null
  submitted_at: string | null
  prompt: string
  status: TurnStatus
  account: string | null
  worker: string | null
  binding: string | null
  answer: string | null
  answer_artifact: string | null
  route_decision: string | null
  tier_decision: string | null
  egress_decision: string | null
  classification: Classification | null
  error: string | null
  created_at: string
  updated_at: string
}

interface SessionRow {
  session_id: string
  account: string | null
  binding: string | null
}

/** Account status → Worker state (capability-descriptor@1.0). */
const WORKER_STATE: Record<AccountStatus, WorkerState> = { ready: 'ready', new: 'reauth-required', 'reauth-required': 'reauth-required', challenge: 'unavailable', disabled: 'unavailable' }

const websiteWorker = (account: string, tier: Tier): string => `worker:${account}/${tier}`

function parseWebsiteWorker(worker: string): { account: string; tier: Tier } {
  const match = /^worker:([a-z][a-z0-9-]*)\/(economy|standard|frontier)$/.exec(worker)
  if (!match) throw new ProviderError('internal', `${worker} is not a website Worker`)
  return { account: match[1]!, tier: match[2] as Tier }
}

/** A turn as a Worker execution (workers-core). */
function execution(turn: TurnView): WorkerExecution {
  return {
    id: turn.turnId, status: turn.status, submitted: turn.submitted,
    ...(turn.answerArtifact ? { result: turn.answerArtifact } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    decisions: turn.egressDecision ? [turn.egressDecision] : [],
  }
}

const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`
const now = (): string => new Date().toISOString()
const TERMINAL: ReadonlySet<TurnStatus> = new Set(['completed', 'failed'])
/** Ownership lease of a running turn; renewed every third of it. */
const LEASE_TTL_MS = 60_000

export class Turns extends Service {
  static inject = ['store', 'artifacts', 'leases', 'egress', 'turnReceipts', 'accounts', 'browser', 'providers', 'workers']

  static Config: z<Config> = z.object({
    maxConcurrentTurnsPerAccount: z.natural().min(1).default(2).description('Parallel turns per account (different sessions)'),
    turnTimeoutMs: z.natural().default(15 * 60_000).description('Hard deadline per chat turn, in milliseconds'),
    stallTimeoutMs: z.natural().default(5 * 60_000).description('No-progress deadline per chat turn, in milliseconds'),
    researchTimeoutMs: z.natural().default(60 * 60_000).description('Hard deadline per Deep research turn, in milliseconds'),
    researchStallTimeoutMs: z.natural().default(30 * 60_000).description('No-progress deadline per Deep research turn, in milliseconds'),
    maxPendingTurns: z.natural().min(1).default(32).description('Accepted but unfinished turns; more are refused'),
    retainDays: z.natural().min(1).default(30).description('Days a finished turn (and its prompt) is kept'),
  })

  private readonly schedulers = new Map<string, ProviderScheduler>()
  private readonly waiters = new Map<string, Set<() => void>>()
  /** Turns of one session run in acceptance order, each after the previous one settles. */
  private readonly sessionChains = new Map<string, Promise<void>>()
  /** Re-checks of turns another process holds; cleared on stop. */
  private readonly retries = new Set<NodeJS.Timeout>()
  /** Runs in flight; a stop waits for them so their leases are released. */
  private readonly inflight = new Set<Promise<void>>()
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
    }, {
      // The caller's data classification and the egress decision (INV-12).
      version: 3,
      sql: `ALTER TABLE turns ADD COLUMN classification TEXT;
      ALTER TABLE turns ADD COLUMN egress_decision TEXT;`,
    }, {
      // The admitted Worker (ctx.workers) and who set the minimum tier.
      version: 4,
      sql: `ALTER TABLE turns ADD COLUMN worker TEXT;
      ALTER TABLE turns ADD COLUMN tier_source TEXT NOT NULL DEFAULT 'caller';
      UPDATE turns SET worker = 'worker:' || account || '/' || tier WHERE account IS NOT NULL;`,
    }, {
      // The acceptance contract named in the turn's work requirement.
      version: 5,
      sql: `ALTER TABLE turns ADD COLUMN acceptance TEXT NOT NULL DEFAULT 'acceptance.answer';`,
    }, {
      // When the receipt was written (callers must not resend), and the requirement's objective.
      version: 6,
      sql: `ALTER TABLE turns ADD COLUMN submitted_at TEXT;
      ALTER TABLE turns ADD COLUMN objective TEXT;`,
    }])
    ctx.workers.register({
      name: 'website',
      describe: () => this.describeWorkers(),
      start: (request) => execution(this.ask(request)),
      get: (id) => {
        const turn = this.get(id)
        return turn && execution(turn)
      },
      wait: async (id, timeoutMs) => execution(await this.wait(id, timeoutMs)),
      affinity: (sessionId) => {
        const account = this.session(sessionId)?.account
        return account ? TIERS.map((t) => websiteWorker(account, t)) : undefined
      },
    })
    ctx.effect(() => {
      queueMicrotask(() => {
        this.purge()
        this.recover()
      })
      const daily = setInterval(() => this.purge(), 24 * 60 * 60_000)
      daily.unref()
      return async () => {
        // A stop is not a failure: running and queued turns stay as they are for the next start.
        this.stopping = true
        clearInterval(daily)
        for (const timer of this.retries) clearTimeout(timer)
        for (const scheduler of this.schedulers.values()) scheduler.close(new ProviderError('aborted', 'turn runtime stopped'))
        await Promise.allSettled(this.inflight)
        // Release every caller blocked in wait() while the store is still open.
        for (const set of this.waiters.values()) for (const wake of set) wake()
        this.waiters.clear()
      }
    })
  }

  /**
   * Accept a turn on the website Worker the caller admitted (the workflow engine routes):
   * durable at once, run in the background, idempotent by `key`. A session id is opened on
   * first use and stays on its account.
   */
  ask(request: WorkerStart): TurnView {
    const prompt = request.prompt
    if (!prompt.trim()) throw new ProviderError('invalid_input', 'prompt must not be empty')
    const { account, tier } = parseWebsiteWorker(request.worker)
    const requestKey = sha256(`ask\0${request.key}`)
    const view = this.ctx.store.transaction((db) => {
      const existing = db.prepare('SELECT * FROM turns WHERE request_key = ?').get(requestKey) as Row | undefined
      if (existing) {
        if (existing.prompt !== prompt) throw new ProviderError('invalid_input', 'the request key was reused with a different prompt')
        return this.view(existing)
      }
      const pending = (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE status IN ('queued', 'running')").get() as { n: number }).n
      const limit = this.config.maxPendingTurns ?? 32
      if (pending >= limit) throw new ProviderError('overloaded', `${pending} turns are already pending (limit ${limit}); retry later`)
      const sessionId = request.sessionId ?? null
      if (sessionId) {
        db.prepare('INSERT OR IGNORE INTO turn_sessions (session_id, account, binding, created_at) VALUES (?, NULL, NULL, ?)').run(sessionId, now())
        const bound = this.session(sessionId)?.account
        if (bound && bound !== account) throw new ProviderError('invalid_input', `session ${sessionId} is bound to ${bound}, not ${account}`)
        // A new persistent session is bound to the first account that runs it.
        db.prepare('UPDATE turn_sessions SET account = COALESCE(account, ?) WHERE session_id = ?').run(account, sessionId)
      }
      const requirement = request.requirement
      const row: Row = {
        turn_id: newId('turn'), request_key: requestKey, session_id: sessionId, mode: sessionId ? 'persistent' : 'temporary',
        feature: requirement.capabilities.includes('deep-research') ? 'deep-research' : 'chat', tier, tier_source: requirement.tier.source,
        acceptance: requirement.acceptance.contract, objective: requirement.objective, submitted_at: null, prompt, status: 'queued',
        account, worker: request.worker, binding: null, answer: null, answer_artifact: null,
        route_decision: request.decisions.route, tier_decision: request.decisions.tier, egress_decision: null,
        classification: requirement.data.classification, error: null, created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO turns (turn_id, request_key, session_id, mode, feature, tier, tier_source, acceptance, objective, classification, prompt, status,
        account, worker, route_decision, tier_decision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`)
        .run(row.turn_id, requestKey, sessionId, row.mode, row.feature, tier, row.tier_source, row.acceptance, row.objective, row.classification, prompt,
          account, row.worker, row.route_decision, row.tier_decision, row.created_at, row.updated_at)
      this.ctx.store.afterCommit(() => void this.schedule(row))
      return this.view(row)
    })
    return view
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
    if (TERMINAL.has(current.status) || this.stopping) return current
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

  /** Delete finished turns (and their prompts) past the retention period; answers stay as artifacts. */
  private purge(): void {
    if (this.stopping) return
    const cutoff = new Date(Date.now() - (this.config.retainDays ?? 30) * 24 * 60 * 60_000).toISOString()
    this.ctx.store.transaction((db) => {
      db.prepare("DELETE FROM turns WHERE status IN ('completed', 'failed') AND updated_at < ?").run(cutoff)
      db.prepare('DELETE FROM turn_sessions WHERE created_at < ? AND session_id NOT IN (SELECT session_id FROM turns WHERE session_id IS NOT NULL)').run(cutoff)
    })
  }

  /** On start: queued turns run again; a running turn without a receipt was never sent and runs again; one with a receipt is not resent. */
  private recover(): void {
    if (this.stopping) return
    const rows = this.ctx.store.db.prepare(`SELECT * FROM turns WHERE status IN ('queued', 'running') ORDER BY created_at`).all() as unknown as Row[]
    for (const row of rows) this.schedule(row)
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

  /**
   * Run a turn under its ownership lease (`turn:<id>`), so two processes sharing one home
   * never run it twice: the holder heartbeats it, and the receipt and the completion are
   * fenced inside their transactions (INV-4). A turn another live process holds is
   * re-checked when that lease would expire.
   */
  private run(turnId: string): Promise<void> {
    const running = this.runOwned(turnId)
    this.inflight.add(running)
    void running.finally(() => this.inflight.delete(running))
    return running
  }

  private retryLater(turnId: string, delayMs: number): void {
    if (this.stopping) return
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      void this.run(turnId)
    }, delayMs)
    timer.unref()
    this.retries.add(timer)
  }

  private async runOwned(turnId: string): Promise<void> {
    if (this.stopping) return
    const resource = `turn:${turnId}`
    let lease = this.ctx.leases.acquire(resource, LEASE_TTL_MS)
    if (!lease) {
      const holder = this.ctx.leases.current(resource)
      this.retryLater(turnId, Math.max(1000, (holder?.expiresAt ?? Date.now()) - Date.now() + 1000))
      return
    }
    const lost = new AbortController()
    const heartbeat = setInterval(() => {
      try {
        lease = this.ctx.leases.renew(lease!, LEASE_TTL_MS)
      } catch (error) {
        lost.abort(error)
      }
    }, LEASE_TTL_MS / 3)
    heartbeat.unref()
    const current = (): Lease => lease!
    try {
      const row = this.row(turnId)
      if (!row || TERMINAL.has(row.status)) return
      const receipt = row.account ? this.ctx.turnReceipts.read(this.identity(row, row.account)) : undefined
      if (row.status === 'running' && receipt?.status === 'SUBMITTED') {
        if ((await this.reconcileSubmitted(row, receipt, lost.signal, current)) === 'done') return
      }
      // INV-12: the actual outgoing payload is checked before any Worker is chosen or anything is sent.
      const egress = await this.ctx.egress.check({ payload: row.prompt, classification: row.classification ?? undefined, workerClass: 'website' })
      this.update(turnId, { egress_decision: egress.decision }, current)
      if (!egress.allowed) {
        this.fail(turnId, new ProviderError('egress_denied', `${egress.reason} (decision ${egress.decision})`), current)
        return
      }
      // The caller admitted the Worker; a turn never routes itself.
      const account = row.account
      if (!account || !row.worker) throw new ProviderError('internal', `turn ${turnId} has no admitted Worker`)
      const scheduler = this.scheduler(account)
      await scheduler.runTurn(row.session_id ?? row.turn_id, lost.signal, async (slot) => {
        this.update(turnId, { status: 'running' }, current)
        await this.execute(this.row(turnId)!, account, slot.signal, current)
      })
    } catch (error) {
      if (this.stopping) return
      if (error instanceof LeaseLost || error instanceof StaleGeneration || lost.signal.aborted) {
        // Lost ownership (for example, the host slept past the lease): look again once the lease
        // can be taken, so the turn is never stranded until the next start.
        this.retryLater(turnId, LEASE_TTL_MS)
        return
      }
      this.fail(turnId, error, current)
    } finally {
      clearInterval(heartbeat)
      try {
        this.ctx.leases.release(current())
      } catch {
        // the store may already be closing; an unreleased lease simply expires
      }
    }
  }

  /**
   * The website Workers: one per account and tier its catalog maps to a mode preset. They
   * prove what the account's driver declares; a missing driver makes them unavailable.
   */
  private async describeWorkers(): Promise<CapabilityDescriptor[]> {
    const providers = new Set(this.ctx.providers.list())
    const observedAt = now()
    return (await this.ctx.accounts.list()).flatMap((account) => {
      const driver = providers.has(account.provider) ? this.ctx.providers.get(account.provider) : undefined
      return TIERS.filter((tier) => account.tiers[tier]).map((tier): CapabilityDescriptor => ({
        schema: 'capability-descriptor@1.0', worker: websiteWorker(account.id, tier), provider: account.provider, tier,
        quotaClass: account.quotaClass, locality: 'remote',
        capabilities: (driver?.capabilities ?? []).map((capability) => ({ capability, evidence: { kind: 'conformance', at: observedAt } })),
        state: driver ? WORKER_STATE[account.status] : 'unavailable',
        observedAt,
      }))
    })
  }

  private async execute(row: Row, accountId: string, signal: AbortSignal, lease: () => Lease, relogged = false): Promise<void> {
    const view = await this.ctx.accounts.get(accountId)
    if (view.status !== 'ready') throw new ProviderError('reauth_required', `${accountId} is ${view.status}`)
    const driver = this.ctx.providers.get(view.provider)
    const state = await this.ctx.accounts.portableState(accountId)
    const session = row.session_id ? this.session(row.session_id) : undefined
    const identity = this.identity(row, accountId)
    const research = row.feature === 'deep-research'
    if (!row.worker) throw new ProviderError('internal', `turn ${row.turn_id} has an account but no Worker`)
    const { tier } = parseWebsiteWorker(row.worker)
    // Routed before a restart, then unmapped by the operator: never served by another mode (INV-2).
    const preset = view.tiers[tier]
    if (!preset) throw new ProviderError('config_error', `${accountId} no longer maps tier ${tier} to a mode; the turn is not sent`)
    const deadlines = research
      ? { timeoutMs: this.config.researchTimeoutMs ?? 60 * 60_000, stallTimeoutMs: this.config.researchStallTimeoutMs ?? 30 * 60_000 }
      : { timeoutMs: this.config.turnTimeoutMs ?? 15 * 60_000, stallTimeoutMs: this.config.stallTimeoutMs ?? 5 * 60_000 }
    const turn = await this.ctx.browser.openTurn(accountId, { state, signal })
    let result: Awaited<ReturnType<typeof driver.ask>>
    try {
      result = await driver.ask(turn.page, row.prompt, {
        conversation: row.mode,
        binding: session?.binding ?? undefined,
        mode: preset,
        feature: row.feature,
        signal,
        deadlines,
        beforeSend: ({ previousResponse, mode }) => {
          this.ctx.store.transaction((db) => {
            this.ctx.leases.fence(lease())
            db.prepare('UPDATE turns SET submitted_at = ? WHERE turn_id = ?').run(now(), row.turn_id)
            this.ctx.turnReceipts.submit({
            ...identity, prompt: row.prompt, previousResponse,
            conversation: { provider: view.provider, binding: session?.binding ?? '' },
            mode: { verified: true, tier, ...mode, feature: row.feature },
            })
          })
        },
        // Bind as soon as the conversation has its id, so a crash mid-answer can be reconciled.
        onBinding: (binding) => this.bind(row, accountId, binding, lease),
      })
    } catch (error) {
      await turn.close()
      if (error instanceof ProviderError && error.kind === 'reauth_required') {
        // Signed out before anything was sent: a credentials-mode account signs in again once
        // (ADR-0017), then the turn runs again; otherwise the account needs the operator.
        const login = this.ctx.get('login')
        if (!relogged && view.loginMode === 'credentials' && login) {
          await login.relogin(accountId)
          return this.execute(this.row(row.turn_id)!, accountId, signal, lease, true)
        }
        await this.ctx.accounts.markSignedOut(accountId, 'login-surface', view.revision).catch(() => undefined)
      }
      throw error
    }
    try {
      // Before completion is visible: callers that see `completed` see the refreshed account.
      await this.writeBack(accountId, turn, driver.stateOrigins, state, view.revision, lease)
      this.commit(row, accountId, view.provider, result.text, result.binding, lease)
    } finally {
      await turn.close()
    }
  }

  /**
   * Store the browser state refreshed during the turn (rotated session cookies), only if
   * the turn still holds its lease and the account is still at the revision the turn
   * started from (docs/design/browser-runtime.md). A failure never fails the answered turn.
   */
  private async writeBack(accountId: string, turn: BrowserTurn, origins: readonly string[], previous: PortableState | undefined, revision: number, lease: () => Lease): Promise<void> {
    try {
      const state = await this.ctx.browser.capture(turn, { origins: [...origins], previous })
      this.ctx.store.transaction(() => this.ctx.leases.fence(lease()))
      await this.ctx.accounts.refreshState(accountId, state, revision)
    } catch (error) {
      this.ctx.get('eventLog')?.append({ type: 'account.write-back-skipped', data: { account: accountId, reason: (error as Error).message.slice(0, 200) } })
    }
  }

  /** Record the conversation binding on the receipt, the session, and the turn (fenced). */
  private bind(row: Row, accountId: string, binding: string, lease: () => Lease): void {
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      this.ctx.turnReceipts.bindConversation(this.identity(row, accountId), binding)
      if (row.session_id) db.prepare('UPDATE turn_sessions SET binding = ?, account = COALESCE(account, ?) WHERE session_id = ?').run(binding, accountId, row.session_id)
      db.prepare('UPDATE turns SET binding = ?, updated_at = ? WHERE turn_id = ?').run(binding, now(), row.turn_id)
    })
  }

  /** Bind, complete the receipt, and store the answer artifact in one fenced transaction. */
  private commit(row: Row, accountId: string, provider: string, text: string, binding: string | undefined, lease: () => Lease): void {
    const identity = this.identity(row, accountId)
    this.ctx.store.transaction(() => {
      if (binding) this.bind(row, accountId, binding, lease)
      this.ctx.leases.fence(lease())
      this.ctx.turnReceipts.complete(identity, { response: text, providerTurnId: binding ?? row.turn_id })
      const answer = this.ctx.artifacts.put({
        kind: 'report',
        bodySchema: 'provider-answer@1.0',
        body: {
          schema: 'provider-answer@1.0', provider, account: accountId, turnId: row.turn_id,
          ...(row.session_id ? { sessionId: row.session_id } : {}),
          conversation: { mode: row.mode, ...(binding ? { binding } : {}) },
          promptHash: sha256(row.prompt), text,
        },
        classification: 'local-private',
        producer: { type: 'worker', ref: `${provider}/${accountId}` },
        inputs: [row.route_decision, row.egress_decision].filter((d): d is string => !!d) as ContentId[],
      })
      this.update(row.turn_id, { status: 'completed', answer: text, answer_artifact: answer.id, binding: binding ?? null }, lease)
    })
  }

  /**
   * A turn whose previous owner stopped after sending (INV-4): observe the conversation
   * (a temporary or never-bound one cannot be observed), record the reconciliation
   * decision, then wait, recover the answer, resubmit within the bound, or fail closed.
   */
  private async reconcileSubmitted(row: Row, receipt: TurnReceipt, signal: AbortSignal, lease: () => Lease): Promise<'resubmit' | 'done'> {
    const accountId = row.account!
    const identity = this.identity(row, accountId)
    const binding = receipt.conversation.binding || this.session(row.session_id ?? '')?.binding || undefined
    const deadline = Date.now() + (row.feature === 'deep-research' ? this.config.researchTimeoutMs ?? 60 * 60_000 : this.config.turnTimeoutMs ?? 15 * 60_000)
    let snapshot: TurnSnapshot = { text: '', running: false, observable: false }
    let provider = ''
    for (;;) {
      if (row.mode === 'persistent' && binding) {
        const view = await this.ctx.accounts.get(accountId)
        provider = view.provider
        const driver = this.ctx.providers.get(view.provider)
        const turn = await this.ctx.browser.openTurn(accountId, { state: await this.ctx.accounts.portableState(accountId), signal })
        try {
          snapshot = await driver.snapshot(turn.page, binding, { feature: row.feature })
        } finally {
          await turn.close()
        }
      }
      const { outcome, decision } = this.ctx.store.transaction(() => {
        this.ctx.leases.fence(lease())
        return this.ctx.turnReceipts.reconcile(identity, snapshot, { prompt: row.prompt })
      })
      if (outcome === 'RECOVER') {
        this.commit(row, accountId, provider, snapshot.text, binding, lease)
        return 'done'
      }
      if (outcome === 'RESUBMIT') return 'resubmit'
      if (outcome === 'AMBIGUOUS' || Date.now() > deadline) {
        this.fail(row.turn_id, new ProviderError('reconciliation_failed',
          `the host stopped after this prompt was sent and the outcome cannot be established (decision ${decision}); it is not resent automatically`), lease)
        return 'done'
      }
      // WAIT: the provider is still generating; look again shortly.
      await new Promise((resolve) => setTimeout(resolve, 5000))
      signal.throwIfAborted()
    }
  }

  /** A stopped runtime starts nothing: a turn caught mid-route stays as it is for the next start. */
  private scheduler(account: string): ProviderScheduler {
    if (this.stopping) throw new ProviderError('aborted', 'turn runtime stopped')
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

  private fail(turnId: string, error: unknown, lease?: () => Lease): void {
    const typed = toProviderError(error)
    this.update(turnId, { status: 'failed', error: JSON.stringify({ kind: typed.kind, disposition: dispositionOf(typed.kind), message: typed.message }) }, lease)
  }

  /** Write turn fields; with a lease, only while that lease still holds the turn (fenced). */
  private update(turnId: string, fields: Partial<Omit<Row, 'turn_id'>>, lease?: () => Lease): void {
    const entries = Object.entries({ ...fields, updated_at: now() })
    this.ctx.store.transaction((db) => {
      if (lease) this.ctx.leases.fence(lease())
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
      ...(row.worker ? { worker: row.worker } : {}),
      submitted: row.submitted_at !== null,
      ...(row.binding ? { binding: row.binding } : {}),
      ...(row.answer !== null ? { answer: row.answer } : {}),
      ...(row.answer_artifact ? { answerArtifact: row.answer_artifact as ContentId } : {}),
      ...(row.route_decision ? { routeDecision: row.route_decision as ContentId } : {}),
      ...(row.tier_decision ? { tierDecision: row.tier_decision as ContentId } : {}),
      ...(row.egress_decision ? { egressDecision: row.egress_decision as ContentId } : {}),
      ...(row.error ? { error: JSON.parse(row.error) as TurnView['error'] & object } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }
}

export default Turns
