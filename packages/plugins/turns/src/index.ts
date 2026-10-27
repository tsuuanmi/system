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
import { setTimeout as sleep } from 'node:timers/promises'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AccountStatus } from '@tsuuanmi/system-accounts'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-board-core'
import type {} from '@tsuuanmi/system-ledger-core'
import { reply } from '@tsuuanmi/system-gateway-core'
import type {} from '@tsuuanmi/system-login'
import { type ContentId, contentId, LABEL, pooledTermsDecision, sha256 } from '@tsuuanmi/system-libs'
import { type BrowserTurn, type ConversationMode, type Disposition, type PortableState, type ProviderDriver, ProviderError, type ProviderFeature, ProviderScheduler, type Tier, type TurnReceipt, type TurnSnapshot, boundaryMissing, dispositionOf, promptOfStart, toProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-turn-receipts'
import type { CapabilityDescriptor, Classification, ExecutionInfrastructure, WorkerExecution, WorkerStart, WorkerState } from '@tsuuanmi/system-workers-core'
import { z as zod } from 'zod'
import { type ConversationView, deleteDue, LEDGER_MIGRATION, type LedgerHost, type LedgerState, listConversations, recordConversation, releaseSessions, sessionReleased } from './ledger.ts'

/** Extra looks at a page that no longer shows a turn's boundary, 5 s apart, before it fails closed. */
const BOUNDARY_LOOKS = 3

export type { ConversationView, LedgerState } from './ledger.ts'

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
  /**
   * `siteError`: the site answered the sent prompt with its own error in place of an answer (ADR-0062).
   * `infrastructure`: the host's stop alone ended it (ADR-0069).
   */
  error?: { kind: string; disposition: Disposition; message: string; siteError?: true; infrastructure?: ExecutionInfrastructure }
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
  /** A ready account's feature probe is refreshed after this long (default 24 h, REQ-PRV-7). */
  probeTtlMs?: number
  /** A ready account's sign-in is checked after this long, sending nothing (default 6 h; 0: never). */
  authCheckMs?: number
  /**
   * Page opens across all accounts of one provider are spaced at least this far apart (default
   * 3 s, PROP-0007): they share the host's address. Each account keeps its own `pageGapMs` too.
   */
  providerPageGapMs?: number
  /** How long a site's usage limit on one feature keeps that feature off the account (default 6 h, ADR-0034). */
  featureLimitCooldownMs?: number
  /** How long a site's usage limit on the whole account keeps its Workers out of quota (default 1 h, ADR-0034). */
  accountLimitCooldownMs?: number
}

/** A site's usage limit on an account: one feature, or `*` for all of it, until a time (ADR-0034). */
export interface Cooldown {
  account: string
  feature: string
  until: string
  /** What set it: the limit's message, shortened. */
  source: string
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
  cancel_requested_at: string | null
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

/** A stable offset in `[0, interval)` for an account: its background checks spread over the interval. */
export function phase(account: string, interval: number): number {
  return Number.parseInt(sha256(`phase\0${account}`).slice(-8), 16) % interval
}

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

/** Failures a signed-out page can show up as, once a turn is on it: each is re-checked against the page. */
const RECHECKED: ReadonlySet<string> = new Set(['provider_stalled', 'timeout', 'session_broken', 'ui_drift'])
/** How long that re-check may take (the driver's own sign-out evidence may hold a few seconds). */
const RECHECK_MS = 15_000

/**
 * The failure a turn reports: `error`, unless it is one a sign-out shows up as and the page now
 * positively shows the site signed out (then `reauth_required`) or a challenge (the driver's own
 * `challenge`). The page is read as it stands, never loaded again; an unclear page keeps `error`.
 */
async function signedOutAfter(driver: ProviderDriver, page: unknown, error: unknown): Promise<unknown> {
  if (!(error instanceof ProviderError) || !RECHECKED.has(error.kind)) return error
  let timer: NodeJS.Timeout | undefined
  try {
    const seen = await Promise.race([
      driver.checkAuth(page as never),
      new Promise<'unknown'>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), RECHECK_MS)
        timer.unref()
      }),
    ])
    return seen === 'signed-out' ? new ProviderError('reauth_required', `${driver.provider}: the page shows the site signed out (the turn had failed as ${error.kind}: ${error.message.slice(0, 200)})`, { cause: error }) : error
  } catch (checked) {
    return checked instanceof ProviderError && checked.kind === 'challenge' ? checked : error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A stall as the operator reads it: what showed no change, the bound that ended it, and what to
 * do. A site can work longer than the bound with nothing a driver can see change (a long think it
 * shows no progress of): only the page's outline (`provider.stall`) tells that from a site that
 * stopped answering.
 */
function stalledTurn(error: unknown, research: boolean): unknown {
  if (!(error instanceof ProviderError) || error.kind !== 'provider_stalled') return error
  const bound = `turns.${research ? 'researchStallTimeoutMs' : 'stallTimeoutMs'}`
  return new ProviderError('provider_stalled', `${error.message} (${bound}): no answer text, no activity the driver reads, and no start or stop of generation in that time. `
    + `The provider.stall event outlines the page as it stood (system events --type provider.stall): if the site was still working, raise ${bound}, which must stay below the turn's hard deadline, or map the tier to a faster mode`, { cause: error })
}

const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`
const now = (): string => new Date().toISOString()
const TERMINAL: ReadonlySet<TurnStatus> = new Set(['completed', 'failed'])
/** Ownership lease of a running turn; renewed every third of it. */
const LEASE_TTL_MS = 60_000

export class Turns extends Service {
  static inject = ['store', 'artifacts', 'leases', 'egress', 'turnReceipts', 'accounts', 'browser', 'providers', 'workers']

  /** The clock a turn's deadlines read (milliseconds), for a test to control; the wall clock when unset. */
  stallClock: (() => number) | undefined

  static Config: z<Config> = z.object({
    maxConcurrentTurnsPerAccount: z.natural().min(1).default(2).description('Parallel turns per account (different sessions)'),
    turnTimeoutMs: z.natural().default(15 * 60_000).description('Hard deadline per chat turn, in milliseconds'),
    stallTimeoutMs: z.natural().default(5 * 60_000).description('No-progress deadline per chat turn, in milliseconds'),
    researchTimeoutMs: z.natural().default(60 * 60_000).description('Hard deadline per Deep research turn, in milliseconds'),
    researchStallTimeoutMs: z.natural().default(30 * 60_000).description('No-progress deadline per Deep research turn, in milliseconds'),
    maxPendingTurns: z.natural().min(1).default(32).description('Accepted but unfinished turns; more are refused'),
    retainDays: z.natural().min(1).default(30).description('Days a finished turn (and its prompt) is kept'),
    probeTtlMs: z.natural().min(60_000).default(24 * 60 * 60_000).description('How long a ready account\'s feature probe stands before it is refreshed'),
    authCheckMs: z.natural().default(6 * 60 * 60_000).description('How often a ready account\'s sign-in is checked, sending nothing, so health shows a signed-out account before a turn finds it and an idle account keeps its refreshed session (0: never)'),
    providerPageGapMs: z.natural().max(600_000).default(3000).description('Minimum gap between page opens across all accounts of one provider, in milliseconds, at most 10 min: they share the host\'s address (each account keeps its own pageGapMs too)'),
    featureLimitCooldownMs: z.natural().min(60_000).default(6 * 60 * 60_000).description('How long a site\'s usage limit on one feature (Deep research, say) keeps that feature off the account, in milliseconds'),
    accountLimitCooldownMs: z.natural().min(60_000).default(60 * 60_000).description('How long a site\'s usage limit on the whole account keeps its Workers out of quota, in milliseconds'),
  })

  /** When each account's sign-in was last checked (sign-in checks), in this process. */
  private readonly authChecked = new Map<string, number>()
  private readonly startedAt = Date.now()
  private readonly schedulers = new Map<string, ProviderScheduler>()
  /** Admissions routed to each account and not started yet (ADR-0033). */
  private readonly pending = new Map<string, number>()
  private readonly waiters = new Map<string, Set<() => void>>()
  /** Turns of one session run in acceptance order, each after the previous one settles. */
  private readonly sessionChains = new Map<string, Promise<void>>()
  /** Re-checks of turns another process holds; cleared on stop. */
  private readonly retries = new Set<NodeJS.Timeout>()
  /** Runs in flight; a stop waits for them so their leases are released. */
  private readonly inflight = new Set<Promise<void>>()
  /** Operator cancellation of turns running in this process. */
  private readonly cancels = new Map<string, AbortController>()
  private stopping = false
  /** The deletion pass in progress, and whether another was asked for meanwhile. */
  private deleting: Promise<{ deleted: number; failed: number }> | undefined
  private deleteAgain = false
  /** Aborted when the runtime stops, so waits in progress end at once. */
  private readonly halted = new AbortController()

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
    }, LEDGER_MIGRATION, {
      // A cancel asked for while another owner holds the turn, or before a restart: honored at its next start.
      version: 8,
      sql: `ALTER TABLE turns ADD COLUMN cancel_requested_at TEXT;`,
    }, {
      // A site's usage limit per account and feature (ADR-0034): Worker state, never the account's status.
      version: 9,
      sql: `CREATE TABLE turn_cooldowns (account TEXT NOT NULL, feature TEXT NOT NULL, until TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (account, feature));`,
    }])
    // A pooled provider's recorded terms, as a gate decision at each start (ADR-0052, INV-13): the
    // same terms record the same decision.
    for (const { provider, pooledTerms } of ctx.accounts.pooled()) {
      ctx.artifacts.recordDecision(pooledTermsDecision(provider, pooledTerms, 'turns.pooled-terms'), { producer: { type: 'system', ref: 'turns' } })
    }
    ctx.workers.register({
      name: 'website',
      describe: () => this.describeWorkers(),
      start: (request) => execution(this.ask(request)),
      reserve: (worker) => this.reserve(worker),
      get: (id) => {
        const turn = this.get(id)
        return turn && execution(turn)
      },
      wait: async (id, timeoutMs) => execution(await this.wait(id, timeoutMs)),
      affinity: (sessionId) => {
        const account = this.held(sessionId)
        return account ? TIERS.map((t) => websiteWorker(account, t)) : undefined
      },
      // The tiers of one account share its scheduler, quota, and site: a failover leaves them all.
      siblings: (worker) => {
        const account = /^worker:([a-z][a-z0-9-]*)\/(?:economy|standard|frontier)$/.exec(worker)?.[1]
        return account ? TIERS.map((t) => websiteWorker(account, t)) : undefined
      },
      handle: (sessionId) => this.session(sessionId)?.binding ?? undefined,
      // The account stays (session affinity); without a binding the next turn opens a new conversation.
      reset: (sessionId) => {
        const reset = Number(this.ctx.store.db.prepare('UPDATE turn_sessions SET binding = NULL WHERE session_id = ?').run(sessionId).changes) > 0
        // A lost conversation's kept tab shows nothing to continue. It closes once the caller's
        // transaction commits, never before: a reset that rolls back leaves the tab, which a turn
        // of the session may be using, as it was (ADR-0062).
        if (reset) this.discardTab(sessionId)
        return reset
      },
      // The caller is done with these sessions: their recorded conversations are deleted on their sites.
      release: (sessionIds, reason) => this.release(sessionIds, reason),
      cancel: (id) => this.cancel(id),
    })
    ctx.inject(['mcp'], (c) => {
      c.mcp.tool('account_verify', {
        description: 'Re-verify a reauth-required account from its stored state, without a login: if the site still signs it in as the saved account, it is ready again (a false signed-out mark undone); nothing is saved.',
        inputSchema: { account: zod.string().max(100) },
      }, async (args) => {
        try {
          const outcome = await this.verify(String(args.account))
          return { content: [{ type: 'text' as const, text: outcome.reason }], structuredContent: outcome }
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
        }
      })
      c.mcp.tool('conversation_list', {
        description: 'The website conversations system recorded (the conversation ledger), oldest first: live, due for deletion, deleted, kept (and why), or failed.',
        inputSchema: { state: zod.enum(['live', 'due', 'deleted', 'kept', 'failed']).optional(), sessionId: zod.string().max(200).optional() },
      }, async (args) => {
        const conversations = this.conversations({ ...(args.state ? { state: args.state as LedgerState } : {}), ...(args.sessionId ? { sessionId: String(args.sessionId) } : {}) })
        return reply({ conversations }, `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`)
      })
      c.mcp.tool('conversation_inspect', {
        description: 'Outline a recorded website conversation\'s page and its own menu, choosing nothing (read-only evidence for its deletion; local-private, read with evidence).',
        inputSchema: { account: zod.string().max(100), binding: zod.string().max(200) },
      }, async (args) => {
        try {
          const outcome = await this.inspectConversation(String(args.account), String(args.binding))
          return { content: [{ type: 'text' as const, text: `evidence: ${outcome.evidence.join(', ')}` }], structuredContent: outcome }
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
        }
      })
      c.mcp.tool('account_cooldowns', {
        description: 'The site usage limits in force per account: a feature, or * for the whole account, kept off until a time. Work that needs it routes to another account meanwhile.',
        inputSchema: { account: zod.string().max(100).optional() },
      }, async (args) => {
        const cooldowns = this.cooldowns(args.account === undefined ? undefined : String(args.account))
        return reply({ cooldowns }, `${cooldowns.length} usage limit${cooldowns.length === 1 ? '' : 's'} in force`)
      })
      c.mcp.tool('account_clear_cooldown', {
        description: 'End an account\'s usage limit early: one feature, or every one when none is named. A feature probe never ends one.',
        inputSchema: { account: zod.string().max(100), feature: zod.string().max(100).optional() },
      }, async (args) => {
        try {
          const account = String(args.account)
          await this.ctx.accounts.get(account)
          const cleared = this.clearCooldown(account, args.feature === undefined ? undefined : String(args.feature))
          return { content: [{ type: 'text' as const, text: `${account}: ${cleared} usage limit(s) ended` }], structuredContent: { account, cleared } }
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
        }
      })
      c.mcp.tool('account_probe', {
        description: 'Prove which website features an account offers now (Deep research, Web search, ...), read from the site without sending anything; routing uses only proven features.',
        inputSchema: { account: zod.string().max(100) },
      }, async (args) => {
        try {
          const features = await this.probe(String(args.account))
          return { content: [{ type: 'text' as const, text: features.join(', ') || '(none)' }], structuredContent: { account: String(args.account), features } }
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
        }
      })
    })
    ctx.effect(() => {
      queueMicrotask(() => {
        this.purge()
        this.recover()
        // Deletions a stop or crash interrupted are checked on the site again first (INV-4).
        void this.deleteConversations()
      })
      const daily = setInterval(() => this.purge(), 24 * 60 * 60_000)
      daily.unref()
      // Features are proven per account (REQ-PRV-7): missing or stale probes are refreshed in the background.
      const probing = setTimeout(() => void this.refreshProbes(), 2000)
      const hourly = setInterval(() => {
        void this.refreshProbes()
        void this.deleteConversations()
      }, 60 * 60_000)
      probing.unref()
      hourly.unref()
      return async () => {
        // A stop is not a failure: running and queued turns stay as they are for the next start.
        this.stopping = true
        this.halted.abort(new ProviderError('aborted', 'turn runtime stopped'))
        clearInterval(daily)
        clearTimeout(probing)
        clearInterval(hourly)
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
    // A brief is rendered here, at start, its pointers resolved to their artifacts' text (INV-12).
    const { prompt, classification } = promptOfStart(request, (ref) => this.ctx.artifacts.get(ref))
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
        const bound = this.held(sessionId)
        if (bound && bound !== account) throw new ProviderError('invalid_input', `session ${sessionId} is bound to ${bound}, not ${account}`)
        // Moved before anything was sent: the tab the other account kept for it closes.
        const before = this.session(sessionId)?.account
        if (before && before !== account) this.ctx.store.afterCommit(() => void this.ctx.browser.discardTab(before, sessionId).catch(() => undefined))
        // A new persistent session is bound to the account that runs it; one that never sent
        // anything (its turns failed unsent) may move to a sibling account (ADR-0034).
        db.prepare('UPDATE turn_sessions SET account = ? WHERE session_id = ?').run(account, sessionId)
      }
      const requirement = request.requirement
      const row: Row = {
        turn_id: newId('turn'), request_key: requestKey, session_id: sessionId, mode: sessionId ? 'persistent' : 'temporary',
        feature: requirement.capabilities.includes('deep-research') ? 'deep-research' : requirement.capabilities.includes('web-search') ? 'web-search' : 'chat', tier, tier_source: requirement.tier.source,
        acceptance: requirement.acceptance.contract, objective: requirement.objective, submitted_at: null, prompt, status: 'queued',
        account, worker: request.worker, binding: null, answer: null, answer_artifact: null,
        route_decision: request.decisions.route, tier_decision: request.decisions.tier, egress_decision: null,
        classification, cancel_requested_at: null, error: null, created_at: now(), updated_at: now(),
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

  /**
   * Release sessions (the worker source's `release`): their recorded website conversations
   * become due and are deleted on their sites in the background (PROP-0004 Phase 5).
   */
  release(sessionIds: readonly string[], reason: string): { due: number; decision?: ContentId } {
    // Their kept tabs close with them (ADR-0030).
    for (const id of sessionIds) this.discardTab(id)
    const released = releaseSessions(this.ledgerHost, sessionIds, reason)
    if (released.due) this.ctx.store.afterCommit(() => void this.deleteConversations())
    return released
  }

  /**
   * Close a session's kept tab, if its account keeps one, once the store transaction it is asked in
   * commits (at once outside any): a rolled-back caller closes nothing.
   */
  private discardTab(sessionId: string): void {
    const account = this.session(sessionId)?.account
    if (account) this.ctx.store.afterCommit(() => void this.ctx.browser.discardTab(account, sessionId).catch(() => undefined))
  }

  /** The conversation ledger, oldest first (operator). */
  conversations(filter: { state?: LedgerState; sessionId?: string } = {}): ConversationView[] {
    return listConversations(this.ctx.store.db, filter)
  }

  /**
   * Read-only evidence of how a recorded conversation is deleted on its site: its page and its
   * own menu outlined (structure, never text), with nothing chosen, on the account's slot held
   * exclusively. Each outline is a local-private `evidence` artifact (`system evidence <id>`).
   */
  async inspectConversation(accountId: string, binding: string, signal?: AbortSignal): Promise<{ account: string; binding: string; evidence: ContentId[] }> {
    if (!this.conversations().some((c) => c.account === accountId && c.binding === binding)) {
      throw new ProviderError('invalid_input', `${binding} is not a conversation system recorded on ${accountId}; only recorded conversations are inspected`)
    }
    const view = await this.ctx.accounts.get(accountId)
    if (view.status !== 'ready') throw new ProviderError('reauth_required', `${accountId} is ${view.status}`)
    const driver = this.ctx.providers.get(view.provider)
    if (!driver.inspectConversation) throw new ProviderError('invalid_input', `${view.provider} cannot inspect a conversation`)
    const outlines = await this.scheduler(accountId).runExclusive(async () => {
      const turn = await this.openPage(accountId, driver, signal)
      try {
        return await driver.inspectConversation!(turn.page, binding)
      } finally {
        await turn.close()
      }
    }, signal)
    const evidence = outlines.map((body) => this.ctx.artifacts.put({ kind: 'evidence', bodySchema: body.schema, body, classification: 'local-private', producer: { type: 'system', ref: `turns/${view.provider}` } }).id)
    this.ctx.get('eventLog')?.append({ type: 'conversation.inspected', data: { account: accountId, binding, evidence } })
    return { account: accountId, binding, evidence }
  }

  /** One deletion pass at a time; a release during a pass is picked up by the next one. */
  async deleteConversations(): Promise<{ deleted: number; failed: number }> {
    if (this.stopping) return { deleted: 0, failed: 0 }
    if (this.deleting) {
      this.deleteAgain = true
      return this.deleting
    }
    const pass = (async () => {
      const total = { deleted: 0, failed: 0 }
      do {
        this.deleteAgain = false
        const one = await deleteDue(this.ledgerHost)
        total.deleted += one.deleted
        total.failed += one.failed
        if (one.retryInMs !== undefined && !this.stopping) {
          const timer = setTimeout(() => {
            this.retries.delete(timer)
            void this.deleteConversations()
          }, one.retryInMs)
          timer.unref()
          this.retries.add(timer)
        }
      } while (this.deleteAgain && !this.stopping)
      return total
    })()
    this.deleting = pass
    this.inflight.add(pass.then(() => undefined, () => undefined))
    try {
      return await pass
    } finally {
      this.deleting = undefined
    }
  }

  private get ledgerHost(): LedgerHost {
    return { ctx: this.ctx, scheduler: (account) => this.scheduler(account), stopping: () => this.stopping, openPage: (account, driver, signal) => this.openPage(account, driver, signal) }
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

  /** Delete finished turns (their prompts and receipts) past the retention period; answers stay as artifacts. */
  private purge(): void {
    if (this.stopping) return
    const cutoff = new Date(Date.now() - (this.config.retainDays ?? 30) * 24 * 60 * 60_000).toISOString()
    this.ctx.store.transaction((db) => {
      const expired = db.prepare("SELECT * FROM turns WHERE status IN ('completed', 'failed') AND updated_at < ?").all(cutoff) as unknown as Row[]
      for (const row of expired) if (row.account) this.ctx.turnReceipts.delete(this.identity(row, row.account))
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

  /**
   * Cancel a turn (REQ-WRK-4): a running one is aborted, a queued one never starts. The
   * provider may still finish an answer it was already generating; it is not taken. The cancel
   * is recorded first, so a turn this process does not hold now (another owner, or a restart
   * before the abort lands) fails as `aborted` when it next starts, and is never resent.
   */
  cancel(turnId: string): boolean {
    const row = this.row(turnId)
    if (!row || TERMINAL.has(row.status)) return false
    this.ctx.store.db.prepare('UPDATE turns SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE turn_id = ?').run(now(), turnId)
    const running = this.cancels.get(turnId)
    if (running) {
      running.abort(new ProviderError('aborted', 'cancelled by the operator'))
      return true
    }
    const lease = this.ctx.leases.acquire(`turn:${turnId}`, LEASE_TTL_MS)
    // Held elsewhere: its owner fails it when it next starts.
    if (!lease) return true
    try {
      this.fail(turnId, new ProviderError('aborted', 'cancelled by the operator'), () => lease)
    } finally {
      this.ctx.leases.release(lease)
    }
    return true
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
    // A failure the run could not record (its lease was taken meanwhile) is never left unhandled,
    // and never breaks its session's chain: the turn is looked at again once the lease can be taken.
    const running = this.runOwned(turnId).catch((error: unknown) => {
      if (error instanceof LeaseLost || error instanceof StaleGeneration) this.retryLater(turnId, LEASE_TTL_MS)
      else this.ctx.logger.warn(`turns: turn ${turnId} ended with a failure it could not record: ${(error as Error).message}`)
    })
    this.inflight.add(running)
    void running.finally(() => this.inflight.delete(running))
    return running
  }

  private earlierUnfinished(turnId: string): boolean {
    return !!this.ctx.store.db.prepare(`SELECT 1 FROM turns earlier JOIN turns me ON me.session_id = earlier.session_id
      WHERE me.turn_id = ? AND earlier.rowid < me.rowid AND earlier.status IN ('queued', 'running') LIMIT 1`).get(turnId)
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
    // A session's turns run in order, decided by the store, not by this process's memory: while
    // an earlier turn of the session is unfinished (even one held by a crashed process's lease),
    // a later one waits, so it never answers into a conversation that is not reconciled yet.
    if (this.earlierUnfinished(turnId)) {
      this.retryLater(turnId, 1000)
      return
    }
    const outcome = await this.ctx.leases.hold(`turn:${turnId}`, LEASE_TTL_MS, async ({ lease: current, lost }) => {
      const cancel = new AbortController()
      this.cancels.set(turnId, cancel)
      try {
        const row = this.row(turnId)
        if (!row || TERMINAL.has(row.status)) return
        // Cancelled while another owner held it, or before a restart: never run, reconciled, or resent.
        if (row.cancel_requested_at) {
          this.fail(turnId, new ProviderError('aborted', 'cancelled by the operator'), current)
          return
        }
        const receipt = row.account ? this.ctx.turnReceipts.read(this.identity(row, row.account)) : undefined
        if (row.status === 'running' && receipt?.status === 'SUBMITTED') {
          if ((await this.reconcileSubmitted(row, receipt, AbortSignal.any([lost, cancel.signal, this.halted.signal]), current)) === 'done') return
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
        await scheduler.runTurn(row.session_id ?? row.turn_id, AbortSignal.any([lost, cancel.signal]), async (slot) => {
          this.update(turnId, { status: 'running' }, current)
          await this.execute(this.row(turnId)!, account, slot.signal, current)
        })
      } catch (error) {
        if (this.stopping) return
        if (cancel.signal.aborted && !lost.aborted) {
          this.fail(turnId, new ProviderError('aborted', 'cancelled by the operator'), current)
          return
        }
        if (error instanceof LeaseLost || error instanceof StaleGeneration || lost.aborted) {
          // Lost ownership (for example, the host slept past the lease): look again once the lease
          // can be taken, so the turn is never stranded until the next start.
          this.retryLater(turnId, LEASE_TTL_MS)
          return
        }
        this.fail(turnId, error, current)
      } finally {
        this.cancels.delete(turnId)
      }
    })
    if (!outcome.held) this.retryLater(turnId, outcome.retryInMs)
  }

  /**
   * The website Workers: one per account and tier its catalog maps to a mode preset. They
   * prove what the account's driver declares; a missing driver, or a tier mapped to a preset the
   * driver does not have (an account left on a removed preset), makes them unavailable. So does an
   * account signed in as the same person as another catalog entry (REQ-ACC-7): both are, since
   * neither is a distinct account (health names them).
   */
  private async describeWorkers(): Promise<CapabilityDescriptor[]> {
    const providers = new Set(this.ctx.providers.list())
    const observedAt = now()
    const slots = this.config.maxConcurrentTurnsPerAccount ?? 2
    // Each account's turns as they stand, read with the routes that are not started yet (ADR-0033).
    const counts = new Map<string, { running: number; queued: number }>()
    for (const row of this.ctx.store.db.prepare(`SELECT account, status, COUNT(*) AS n FROM turns WHERE status IN ('queued', 'running') AND account IS NOT NULL GROUP BY account, status`).all() as Array<{ account: string; status: 'queued' | 'running'; n: number }>) {
      const count = counts.get(row.account) ?? { running: 0, queued: 0 }
      count[row.status] = row.n
      counts.set(row.account, count)
    }
    const cooled = this.cooldowns()
    const duplicated = new Set((await this.ctx.accounts.duplicateIdentities()).flat())
    return (await this.ctx.accounts.list()).flatMap((account) => {
      const driver = providers.has(account.provider) ? this.ctx.providers.get(account.provider) : undefined
      const load = { ...(counts.get(account.id) ?? { running: 0, queued: 0 }), pending: this.pending.get(account.id) ?? 0, slots }
      // A usage limit on the whole account takes its Workers out of quota; one on a feature keeps work that needs it away (ADR-0034).
      const limits = cooled.filter((c) => c.account === account.id)
      const state = !driver || account.status !== 'ready' ? undefined
        : limits.some((c) => c.feature === '*') ? 'quota-exhausted' : load.running >= slots ? 'busy' : undefined
      const cooldowns = limits.filter((c) => c.feature !== '*').map((c) => ({ capability: c.feature, until: c.until }))
      // Its provider's accounts are compared by the provider, under its setting (ADR-0052); a limit on the whole account says until when.
      const whole = limits.find((c) => c.feature === '*')
      const mode = this.ctx.accounts.setting(account.provider).mode
      // The site's name for people, as its driver gives it (`@1.8`); one that is not plain text on one line is left out.
      const title = driver?.title !== undefined && LABEL.test(driver.title) ? driver.title : undefined
      return TIERS.filter((tier) => account.tiers[tier]).map((tier): CapabilityDescriptor => ({
        // The site is who serves the work, so the account's provider is the Worker's family (ADR-0027).
        // The operator's description of the account, with the tier this Worker serves (`@1.7`).
        schema: title ? 'capability-descriptor@1.8' : account.description ? 'capability-descriptor@1.7' : 'capability-descriptor@1.5', worker: websiteWorker(account.id, tier), provider: account.provider, family: account.provider,
        ...(title ? { title } : {}), ...(account.description ? { description: `${account.description} (${tier} tier)` } : {}),
        account: { id: account.id, group: account.provider, mode, ...(whole ? { limitUntil: whole.until } : {}) },
        ...(driver?.maxInputChars ? { maxInputChars: driver.maxInputChars } : {}), load, ...(cooldowns.length ? { cooldowns } : {}), tier,
        quotaClass: account.quotaClass, locality: 'remote',
        capabilities: [
          ...(driver?.capabilities ?? []).map((capability) => ({ capability, evidence: { kind: 'conformance' as const, at: observedAt } })),
          // An account feature counts only once a probe on this account proved it (REQ-PRV-7).
          ...(account.features?.names ?? []).filter((f) => driver?.features?.includes(f)).map((capability) => ({ capability, evidence: { kind: 'probe' as const, at: account.features!.provedAt } })),
        ],
        state: driver && (!driver.modes || driver.modes.includes(account.tiers[tier]!)) && !duplicated.has(account.id) ? state ?? WORKER_STATE[account.status] : 'unavailable',
        observedAt,
      }))
    })
  }

  /**
   * The account a session is held to: once a turn of it was sent, is under way, or it has a
   * conversation. A session whose turns all failed before sending holds none, so its node may
   * move to a sibling account (ADR-0034).
   */
  private held(sessionId: string): string | undefined {
    const session = this.session(sessionId)
    if (!session?.account) return undefined
    if (session.binding) return session.account
    const used = this.ctx.store.db.prepare(`SELECT 1 FROM turns WHERE session_id = ? AND (submitted_at IS NOT NULL OR status IN ('queued', 'running', 'completed')) LIMIT 1`).get(sessionId)
    return used ? session.account : undefined
  }

  /** The usage limits in force (ADR-0034), of one account or every one; lapsed ones are gone. */
  cooldowns(account?: string): Cooldown[] {
    const at = now()
    this.ctx.store.db.prepare('DELETE FROM turn_cooldowns WHERE until <= ?').run(at)
    const rows = (account
      ? this.ctx.store.db.prepare('SELECT account, feature, until, source FROM turn_cooldowns WHERE account = ? ORDER BY account, feature').all(account)
      : this.ctx.store.db.prepare('SELECT account, feature, until, source FROM turn_cooldowns ORDER BY account, feature').all()) as unknown as Cooldown[]
    return rows.map((r) => ({ account: r.account, feature: r.feature, until: r.until, source: r.source }))
  }

  /**
   * End usage limits early, by the operator (`system account clear-cooldown`) or by a turn that used
   * the feature and succeeded: one feature, or every one of the account. How many ended.
   */
  clearCooldown(account: string, feature?: string, by = 'operator'): number {
    const cleared = feature
      ? this.ctx.store.db.prepare('DELETE FROM turn_cooldowns WHERE account = ? AND feature = ?').run(account, feature).changes
      : this.ctx.store.db.prepare('DELETE FROM turn_cooldowns WHERE account = ?').run(account).changes
    if (cleared) this.ctx.get('eventLog')?.append({ type: 'account.cooldown-cleared', data: { account, ...(feature ? { feature } : {}), by } })
    return Number(cleared)
  }

  /**
   * A site's usage limit (`quota_exhausted`): its feature, or the whole account (`*`), is cooled for
   * the configured time, so routing sends that work elsewhere (ADR-0034). Never the account's status:
   * its checks keep running, and health does not ask the operator to act.
   */
  private cool(account: string, error: ProviderError): void {
    const feature = error.feature ?? '*'
    const ms = feature === '*' ? this.config.accountLimitCooldownMs ?? 60 * 60_000 : this.config.featureLimitCooldownMs ?? 6 * 60 * 60_000
    const until = new Date(Date.now() + ms).toISOString()
    const source = error.message.slice(0, 200)
    this.ctx.store.db.prepare('INSERT OR REPLACE INTO turn_cooldowns (account, feature, until, source, created_at) VALUES (?, ?, ?, ?, ?)').run(account, feature, until, source, now())
    this.ctx.get('eventLog')?.append({ type: 'account.cooldown', data: { account, feature, until, source } })
  }

  /**
   * An admission routed to an account's Worker, counted in that account's `load.pending` until its
   * turn is started or given up (ADR-0033). Starting is synchronous, so the turn is queued by the
   * time its caller releases this.
   */
  private reserve(worker: string): () => void {
    const { account } = parseWebsiteWorker(worker)
    this.pending.set(account, (this.pending.get(account) ?? 0) + 1)
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = (this.pending.get(account) ?? 1) - 1
      if (left > 0) this.pending.set(account, left)
      else this.pending.delete(account)
    }
  }

  /**
   * Prove which website features an account offers (REQ-PRV-7): the driver reads them from the
   * site without sending anything, on the account's own scheduler, and they are recorded on the
   * account. Only features the driver declares are kept.
   */
  /**
   * Re-verify a reauth-required account from its stored state, without a login: open the site
   * with that state (nothing is sent), and if it is signed in as the account saved, mark it ready
   * again and record `account.re-verified`. Otherwise it stays reauth-required. Nothing is saved
   * or written back: a false signed-out mark is undone, never papered over.
   */
  async verify(accountId: string, signal?: AbortSignal): Promise<{ account: string; status: AccountStatus; verified: boolean; reason: string }> {
    const view = await this.ctx.accounts.get(accountId)
    if (view.status !== 'reauth-required') return { account: accountId, status: view.status, verified: false, reason: `${accountId} is ${view.status}; only a reauth-required account is re-verified` }
    const driver = this.ctx.providers.get(view.provider)
    const seen = await this.scheduler(accountId).runTurn(`verify:${accountId}`, signal, async () => {
      const turn = await this.openPage(accountId, driver, signal)
      try {
        if ((await driver.checkAuth(turn.page)) !== 'signed-in') return undefined
        return await driver.identity(turn.page)
      } finally {
        await turn.close()
      }
    })
    if (!seen) return { account: accountId, status: view.status, verified: false, reason: `${accountId}'s stored state does not sign in: sign in again (system account login ${accountId})` }
    const restored = await this.ctx.accounts.reverify(accountId, contentId({ provider: view.provider, identity: seen }), view.revision)
    this.ctx.get('eventLog')?.append({ type: 'account.re-verified', data: { account: accountId, revision: restored.revision } })
    return { account: accountId, status: restored.status, verified: true, reason: `${accountId}'s stored state signs in as the saved account: ready again` }
  }

  async probe(accountId: string, signal?: AbortSignal): Promise<string[]> {
    const view = await this.ctx.accounts.get(accountId)
    if (view.status !== 'ready') throw new ProviderError('reauth_required', `${accountId} is ${view.status}`)
    const driver = this.ctx.providers.get(view.provider)
    const found = driver.probeFeatures
      ? await this.scheduler(accountId).runTurn(`probe:${accountId}`, signal, async () => {
        // Waited for its slot: an account that stopped being ready meanwhile (challenged, signed out) is never loaded.
        await this.stillReady(accountId)
        const turn = await this.openPage(accountId, driver, signal)
        try {
          return await driver.probeFeatures!(turn.page)
        } catch (error) {
          await this.challenged(accountId, error, view.revision)
          throw error
        } finally {
          await turn.close()
        }
      })
      : []
    const names = found.filter((f) => driver.features?.includes(f))
    await this.ctx.accounts.setFeatures(accountId, names)
    return names
  }

  /**
   * Throws unless no other catalog entry is signed in as the same person as this account
   * (REQ-ACC-7): two entries of one identity are one account, so neither takes work until the
   * operator signs one of them in as someone else or removes it from the catalog. Nothing was sent.
   */
  private async distinct(accountId: string): Promise<void> {
    const group = (await this.ctx.accounts.duplicateIdentities()).find((ids) => ids.includes(accountId))
    if (!group) return
    const others = group.filter((id) => id !== accountId).join(', ')
    throw new ProviderError('reauth_required', `${accountId} is signed in as the same person as ${others}: neither takes work until one is signed in as another person (system account login <id>) or removed from the catalog; nothing was sent`)
  }

  /** Throws unless the account is still ready: checked again once a background operation has its slot. */
  private async stillReady(accountId: string): Promise<void> {
    const now = await this.ctx.accounts.get(accountId)
    if (now.status !== 'ready') throw new ProviderError('reauth_required', `${accountId} is ${now.status}`)
  }

  /** One background operation at a time, across every account and provider: probes and sign-in checks queue. */
  private async refreshProbes(): Promise<void> {
    if (this.stopping) return
    const ttl = this.config.probeTtlMs ?? 24 * 60 * 60_000
    const every = this.config.authCheckMs ?? 6 * 60 * 60_000
    for (const account of await this.ctx.accounts.list().catch(() => [])) {
      if (this.stopping) return
      if (account.status !== 'ready' || !this.ctx.providers.list().includes(account.provider)) continue
      const fresh = account.features && Date.now() - Date.parse(account.features.provedAt) < ttl
      if (!fresh) await this.probe(account.id).catch((error: unknown) => this.ctx.logger.warn(`turns: feature probe of ${account.id} failed: ${(error as Error).message}`))
      // The first check comes within one interval after start, at an offset of its own (derived from
      // the account id, so stable across restarts): the accounts' checks spread over the interval
      // instead of all loading their sites at once (PROP-0007). A turn at start checks the sign-in anyway.
      else if (every > 0 && Date.now() - (this.authChecked.get(account.id) ?? this.startedAt - phase(account.id, every)) >= every) {
        await this.checkSignIn(account.id).catch((error: unknown) => this.ctx.logger.warn(`turns: sign-in check of ${account.id} failed: ${(error as Error).message}`))
      }
    }
  }

  /**
   * Check a ready account's sign-in with its saved state, sending nothing: a page that shows it
   * signed out (positive evidence only, ADR-0017) marks it reauth-required now, so health shows it
   * before a turn finds it (event `account.signed-out`). Signed in, the state the site refreshed
   * is written back as a turn's is, so an idle account's session does not age out. Unknown
   * changes nothing.
   */
  async checkSignIn(accountId: string, signal?: AbortSignal): Promise<'signed-in' | 'signed-out' | 'unknown'> {
    const view = await this.ctx.accounts.get(accountId)
    if (view.status !== 'ready') return 'unknown'
    const driver = this.ctx.providers.get(view.provider)
    const auth = await this.scheduler(accountId).runTurn(`auth:${accountId}`, signal, async (slot): Promise<'signed-in' | 'signed-out' | 'unknown'> => {
      // Waited for its slot: an account that stopped being ready meanwhile is never loaded.
      if (!(await this.stillReady(accountId).then(() => true, () => false))) return 'unknown'
      const state = driver.sessionBound ? undefined : await this.ctx.accounts.portableState(accountId)
      const turn = await this.openPage(accountId, driver, signal, state)
      try {
        const seen = await driver.checkAuth(turn.page).catch(async (error: unknown) => {
          await this.challenged(accountId, error, view.revision)
          throw error
        })
        // A session-bound account's session lives in its profile: there is no copy to refresh.
        if (seen === 'signed-in' && !driver.sessionBound) await this.writeBack(accountId, turn, driver.stateOrigins, state, view.revision, () => slot.signal.throwIfAborted())
        return seen
      } finally {
        await turn.close()
      }
    })
    this.authChecked.set(accountId, Date.now())
    if (auth === 'signed-out') {
      await this.ctx.accounts.markSignedOut(accountId, 'login-surface', view.revision)
      this.ctx.get('eventLog')?.append({ type: 'account.signed-out', data: { account: accountId, by: 'sign-in check' } })
    }
    return auth
  }

  private async execute(row: Row, accountId: string, signal: AbortSignal, lease: () => Lease, relogged = false): Promise<void> {
    const view = await this.ctx.accounts.get(accountId)
    if (view.status !== 'ready') throw new ProviderError('reauth_required', `${accountId} is ${view.status}`)
    // Admitted before another entry signed in as the same person: nothing is sent on either (REQ-ACC-7).
    await this.distinct(accountId)
    const driver = this.ctx.providers.get(view.provider)
    const state = driver.sessionBound ? undefined : await this.ctx.accounts.portableState(accountId)
    const session = row.session_id ? this.session(row.session_id) : undefined
    // A released session has no conversation to continue: a new one would lose its context
    // (a team member's above all), so the turn fails, unsent, instead of starting over silently.
    if (row.session_id && !session?.binding && sessionReleased(this.ctx.store.db, row.session_id)) {
      throw new ProviderError('conversation_lost', `session ${row.session_id}'s conversation was released for deletion with its run; it cannot be continued, and a new conversation would lose its context`)
    }
    const identity = this.identity(row, accountId)
    const research = row.feature === 'deep-research'
    if (!row.worker) throw new ProviderError('internal', `turn ${row.turn_id} has an account but no Worker`)
    const { tier } = parseWebsiteWorker(row.worker)
    // Routed before a restart, then unmapped by the operator: never served by another mode (INV-2).
    const preset = view.tiers[tier]
    if (!preset) throw new ProviderError('config_error', `${accountId} no longer maps tier ${tier} to a mode; the turn is not sent`)
    const limits = research
      ? { timeoutMs: this.config.researchTimeoutMs ?? 60 * 60_000, stallTimeoutMs: this.config.researchStallTimeoutMs ?? 30 * 60_000 }
      : { timeoutMs: this.config.turnTimeoutMs ?? 15 * 60_000, stallTimeoutMs: this.config.stallTimeoutMs ?? 5 * 60_000 }
    const deadlines = this.stallClock ? { ...limits, now: this.stallClock } : limits
    // A session-bound account's persistent session keeps its tab between turns (ADR-0030). Its page
    // follows the turn's signal only until the answer is in: the turn's end must not close a page
    // that is being kept.
    const keep = driver.sessionBound && row.session_id && row.mode === 'persistent' ? row.session_id : undefined
    const pageAbort = new AbortController()
    const forward = (): void => pageAbort.abort(signal.reason)
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
    let turn: BrowserTurn
    try {
      turn = await this.openPage(accountId, driver, keep ? pageAbort.signal : signal, state, keep)
    } catch (error) {
      signal.removeEventListener('abort', forward)
      throw error
    }
    if (!keep) signal.removeEventListener('abort', forward)
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
    } catch (caught) {
      signal.removeEventListener('abort', forward)
      // A turn that failed on a page the site has since signed out reports the sign-out, so the
      // account shows its real state (live 2026-10-17: a stall on the logged-out home).
      const error = signal.aborted ? caught : stalledTurn(await signedOutAfter(driver, turn.page, caught), research)
      // Never kept after a failure: the next turn starts from a fresh page.
      await (turn.discard?.() ?? turn.close())
      if (error instanceof ProviderError && error.kind === 'reauth_required') {
        // Signed out before anything was sent: a credentials-mode account signs in again once
        // (ADR-0017), then the turn runs again; otherwise the account needs the operator. A turn
        // whose receipt exists may have been sent, so it is never run again (INV-4).
        const login = this.ctx.get('login')
        const sent = this.ctx.turnReceipts.read(this.identity(row, accountId)) !== undefined
        if (!relogged && !sent && view.loginMode === 'credentials' && login) {
          await login.relogin(accountId)
          return this.execute(this.row(row.turn_id)!, accountId, signal, lease, true)
        }
        await this.ctx.accounts.markSignedOut(accountId, 'login-surface', view.revision).catch(() => undefined)
      }
      await this.challenged(accountId, error, view.revision)
      throw error
    }
    // The answer is in: from here the page is kept or closed below, never by the turn's end.
    signal.removeEventListener('abort', forward)
    if (keep !== undefined) {
      // Kept (only when idle and clean) or closed before the turn completes, so the session's next
      // turn, which may start at once, finds it. A commit that fails takes the kept tab back.
      const idle = turn.discard !== undefined && (await driver.pageIdle?.(turn.page).catch(() => false) ?? false)
      await (idle ? turn.close() : (turn.discard?.() ?? turn.close()))
      try {
        this.commit(row, accountId, view.provider, result.text, result.binding, lease)
      } catch (error) {
        if (idle) await this.ctx.browser.discardTab(accountId, keep).catch(() => undefined)
        throw error
      }
      return
    }
    try {
      // Before completion is visible: callers that see `completed` see the refreshed account.
      if (!driver.sessionBound) await this.writeBack(accountId, turn, driver.stateOrigins, state, view.revision, () => this.ctx.store.transaction(() => this.ctx.leases.fence(lease())))
      this.commit(row, accountId, view.provider, result.text, result.binding, lease)
    } finally {
      await turn.close()
    }
  }

  /**
   * The page an operation on the account runs in. A session-bound driver's account (ADR-0030)
   * works in a page of its own login profile, paced by the driver; with `keep`, the session's kept
   * tab when there is one. Any other account works in a fresh context from its portable state:
   * `state` when the caller already read it, for its write-back.
   */
  private async openPage(accountId: string, driver: ProviderDriver, signal?: AbortSignal, state?: PortableState, keep?: string): Promise<BrowserTurn> {
    if (driver.sessionBound) {
      const login = this.ctx.get('login')
      if (!login) throw new ProviderError('config_error', `${accountId} works in its login profile (${driver.provider} is session-bound), but no login service is mounted`)
      const pace = { key: driver.provider, gapMs: this.config.providerPageGapMs ?? 3000 }
      return this.ctx.browser.openTurn(accountId, { profile: { dir: login.profileDir(accountId), gapMs: driver.pageGapMs, keep, pace }, signal })
    }
    return this.ctx.browser.openTurn(accountId, { state: state ?? await this.ctx.accounts.portableState(accountId), signal })
  }

  /**
   * Store the browser state refreshed during the turn (rotated session cookies), only if
   * the turn still holds its lease (`fence` throws otherwise) and the account is still at the
   * revision the turn started from (docs/design/browser-runtime.md). A failure never fails the
   * answered turn.
   */
  private async writeBack(accountId: string, turn: BrowserTurn, origins: readonly string[], previous: PortableState | undefined, revision: number, fence: () => void): Promise<void> {
    try {
      const state = await this.ctx.browser.capture(turn, { origins: [...origins], previous })
      fence()
      await this.ctx.accounts.refreshState(accountId, state, revision)
    } catch (error) {
      this.ctx.get('eventLog')?.append({ type: 'account.write-back-skipped', data: { account: accountId, reason: (error as Error).message.slice(0, 200) } })
    }
  }

  /**
   * A site's challenge (a CAPTCHA, an unusual-traffic check) needs the operator: the account is
   * marked `challenge`, so its Workers are unavailable and nothing loads the site again until the
   * operator has passed it and saved the account (event `account.challenged`).
   */
  private async challenged(accountId: string, error: unknown, revision: number): Promise<void> {
    if (!(error instanceof ProviderError) || error.kind !== 'challenge') return
    await this.ctx.accounts.markChallenge(accountId, error.message, revision).catch(() => undefined)
    this.ctx.get('eventLog')?.append({ type: 'account.challenged', data: { account: accountId, reason: error.message.slice(0, 200) } })
  }

  /** Record the conversation binding on the receipt, the session, the turn, and the conversation ledger (fenced). */
  private bind(row: Row, accountId: string, binding: string, lease: () => Lease): void {
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      this.ctx.turnReceipts.bindConversation(this.identity(row, accountId), binding)
      recordConversation(db, { account: accountId, binding, sessionId: row.session_id, turnId: row.turn_id, feature: row.feature, mode: row.mode })
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
    // A turn that used a feature and succeeded ends that feature's usage limit early (ADR-0034).
    if (row.feature !== 'chat') this.clearCooldown(accountId, row.feature, row.turn_id)
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
    // A page that no longer shows the boundary may still be hydrating: look again, a few times, before failing closed.
    let missingLooks = 0
    for (;;) {
      if (row.mode === 'persistent' && binding) {
        const view = await this.ctx.accounts.get(accountId)
        provider = view.provider
        const driver = this.ctx.providers.get(view.provider)
        const turn = await this.openPage(accountId, driver, signal)
        try {
          snapshot = await driver.snapshot(turn.page, binding, { feature: row.feature })
        } finally {
          await turn.close()
        }
      }
      // A look that a cancel, a stop, or a lost lease cut short is no evidence: the abort closed
      // its page under it, so it reads as unobservable. The turn ends as that abort, not AMBIGUOUS.
      signal.throwIfAborted()
      const { outcome, decision } = this.ctx.store.transaction(() => {
        this.ctx.leases.fence(lease())
        return this.ctx.turnReceipts.reconcile(identity, snapshot, { prompt: row.prompt })
      })
      if (outcome === 'RECOVER') {
        this.commit(row, accountId, provider, snapshot.text, binding, lease)
        return 'done'
      }
      if (outcome === 'RESUBMIT') return 'resubmit'
      if (outcome === 'AMBIGUOUS' && boundaryMissing(receipt, snapshot) && missingLooks < BOUNDARY_LOOKS && Date.now() <= deadline) {
        missingLooks += 1
        await sleep(5000, undefined, { signal })
        continue
      }
      if (outcome === 'AMBIGUOUS' || Date.now() > deadline) {
        // Its previous owner's stop alone left it unknown: the host's failure, not the turn's (ADR-0069).
        this.fail(row.turn_id, new ProviderError('reconciliation_failed',
          `the host stopped after this prompt was sent and the outcome cannot be established (decision ${decision}); it is not resent automatically`), lease, 'host-stopped')
        return 'done'
      }
      // WAIT: the provider is still generating; look again shortly (a cancel or a stop ends the wait).
      await sleep(5000, undefined, { signal })
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

  /** `infrastructure`: what of the infrastructure alone ended it, when this runtime knows it (ADR-0069). */
  private fail(turnId: string, error: unknown, lease?: () => Lease, infrastructure?: ExecutionInfrastructure): void {
    // A finished turn stays as it finished: a later failure (closing its browser turn) never rewrites it.
    if (TERMINAL.has(this.row(turnId)?.status ?? 'queued')) return
    const typed = toProviderError(error)
    const row = this.row(turnId)
    const account = row?.account
    if (typed.kind === 'quota_exhausted' && account) this.cool(account, typed)
    // The site's own error in place of an answer, read on the turn's page after its receipt was
    // written (ADR-0062): told to the caller, whose rule alone may start the work again. Without a
    // receipt nothing was sent, so it is not that.
    const siteError = typed.siteError && row?.submitted_at ? { siteError: true } : {}
    this.update(turnId, { status: 'failed', error: JSON.stringify({ kind: typed.kind, disposition: dispositionOf(typed.kind), message: typed.message, ...siteError, ...(infrastructure ? { infrastructure } : {}) }) }, lease)
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
