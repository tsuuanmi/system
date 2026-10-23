/**
 * The `agents` Worker source (docs/design/agent-runtimes.md): each configured Worker is an
 * agent runtime (`ctx.agentRuntimes`) held to a policy from configuration (workspace,
 * sandbox, tool allow-list; INV-6). Its capabilities are what `probe()` proves now; a policy
 * the runtime cannot enforce leaves the Worker unavailable, never loosened. Runs are durable
 * and run one at a time per Worker (one writer per workspace, INV-15). A run that started
 * and did not finish is never run again by itself: the agent may already have acted (INV-4).
 * A Worker configured with a resource pool meters its runs through `ctx.resources`
 * (docs/design/resources.md): a reservation before the run (none, nothing runs), one
 * `usage-record` from the runtime's own numbers after it, and its limit observations as readings.
 * A Worker configured with `worktreePerRun` works in a git worktree of its own per workflow run
 * (./worktrees.ts). Every tool call of a run passes the run's gate first (./gate.ts): the autonomy
 * policy through `ctx.approvals` (optional; none, and no tool call runs), so a Worker whose runtime
 * cannot ask a gate before each tool call is unavailable. A run that a gate deferred fails, naming
 * the approval request it waits for; a later run of its session makes the call once approved.
 * @module @tsuuanmi/system-agent-workers
 */
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type AgentRuntimeProvider, type LimitObservation, type RunMetering, type RunResult, type RunSpec, type RuntimeEvidence, type SandboxMode, meteringOf,
} from '@tsuuanmi/system-agent-runtime-core'
import type {} from '@tsuuanmi/system-artifacts'
import type { Classification } from '@tsuuanmi/system-egress'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { captureGitSubject, type ContentId, dshHome, sha256 } from '@tsuuanmi/system-libs'
import { ProviderError, ProviderScheduler, dispositionOf, promptOfStart, toProviderError } from '@tsuuanmi/system-provider-core'
import { type LimitState, type Resources, ResourcesError, type UsageRecord } from '@tsuuanmi/system-resources-core'
import type {} from '@tsuuanmi/system-store'
import type { ArtifactRef, CapabilityDescriptor, ExecutionStatus, QuotaClass, Tier, WorkerExecution, WorkerSandbox, WorkerStart } from '@tsuuanmi/system-workers-core'
import { GATE_MIGRATION, type Deferral, runGate } from './gate.ts'
import { RUN_ID, type RepositoryCheck, type SweepOutcome, Worktrees } from './worktrees.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentWorkers: AgentWorkers
  }
}

export interface AgentWorkerConfig {
  /** Worker id suffix: the Worker is `agent:<id>`. */
  id: string
  /** Agent runtime kind, as its provider registers it (for example `claude-agent-sdk`). */
  runtime: string
  /** Absolute workspace root the agent works in. */
  workspace: string
  sandbox: SandboxMode
  tools?: string[]
  model?: string
  maxTurns?: number
  tier: Tier
  /** Default `agent-plan` (purpose P1). */
  quotaClass?: QuotaClass
  /**
   * The resource pool its runs draw on: a pool id from the resources configuration, with the
   * `account` it belongs to. Set, the Worker's runs are metered through `ctx.resources` and fail
   * closed without it (INV-2); unset, they are not metered.
   */
  pool?: string
  account?: string
  /**
   * The runtime's own limit window names mapped to the pool's window ids (for example
   * `five_hour: five-hour`). An observation of a window not mapped here is not recorded.
   */
  windows?: Record<string, string>
  /**
   * Each run that belongs to a workflow run works in that run's own git worktree of `workspace`
   * (which must then be the top level of a git repository with a commit), on the branch
   * `system/run/<runId>`, never in the repository's main working tree. Default false.
   */
  worktreePerRun?: boolean
  /** How long a limit hit with no reset time keeps the pool closed, in seconds (default 3600). */
  limitCooldownSeconds?: number
}

export interface Config {
  workers: AgentWorkerConfig[]
  /** How long a probe result stands (default 5 min). */
  probeTtlMs?: number
  /** Hard deadline per run; the agent is stopped and the run fails as `timeout` (default 15 min). */
  runTimeoutMs?: number
  /** Where the worktrees of `worktreePerRun` Workers go (default `<DSH_HOME>/system/worktrees`). */
  worktreeRoot?: string
  /**
   * Hours a workflow run's worktree is kept after its last agent run ended, every one finished;
   * then its changes are committed on its branch and it is removed (default 168; 0 keeps them).
   */
  worktreeRetentionHours?: number
}

interface RunRow {
  run_id: string
  request_key: string
  worker: string
  session_id: string | null
  prompt: string
  classification: string
  status: ExecutionStatus
  submitted_at: string | null
  native_handle: string | null
  result: string | null
  error: string | null
  /** The run's egress decision (INV-12), part of its decision chain. */
  egress_decision?: string | null
  /** The run's `budget` decision, when its Worker is metered (INV-13). */
  budget_decision?: string | null
  /** The reservation the run holds while it runs, released once its usage is recorded. */
  reservation_id?: string | null
  /** The workflow run the run belongs to, when it belongs to one (`WorkerStart.runId`). */
  workflow_run_id?: string | null
  created_at: string
  updated_at: string
}

const ID = /^[a-z][a-z0-9-]*$/
const LEASE_TTL_MS = 60_000
const PREFIX = 'agent:'
const newId = (): string => `arun_${randomBytes(8).toString('hex')}`
/** At most this many per-model entries go into a record (`agent-result@1.2`, `usage-record@1.0`). */
const MAX_MODELS = 16
/** How often finished workflow runs' worktrees are looked at for removal. */
const SWEEP_MS = 60 * 60_000
const now = (): string => new Date().toISOString()

export class AgentWorkers extends Service {
  static inject = ['store', 'artifacts', 'leases', 'workers', 'agentRuntimes', 'egress']

  static Config: z<Config> = z.object({
    workers: z.array(z.object({
      id: z.string().pattern(ID).required(),
      runtime: z.string().required(),
      workspace: z.string().required(),
      sandbox: z.union(['read-only', 'workspace-write']).required(),
      tools: z.array(z.string()),
      model: z.string(),
      maxTurns: z.natural().min(1),
      tier: z.union(['economy', 'standard', 'frontier']).required(),
      quotaClass: z.union(['subscription-chat', 'agent-plan', 'metered', 'local']).default('agent-plan'),
      pool: z.string().description('The resource pool its runs draw on (a pool id from the resources configuration); unset: not metered'),
      account: z.string().description('The account the pool belongs to; required with pool'),
      windows: z.dict(z.string()).description('The runtime\'s limit window names mapped to the pool\'s window ids, for example five_hour: five-hour'),
      worktreePerRun: z.boolean().default(false).description('Each run of a workflow run works in that run\'s own git worktree of the workspace (the top level of a git repository), on branch system/run/<runId>'),
      limitCooldownSeconds: z.natural().min(60).max(604_800).default(3600).description('How long a limit hit with no reset time keeps the pool closed'),
    })).default([]).description('Agent-runtime Workers; each policy comes from here only (INV-6)'),
    probeTtlMs: z.natural().default(5 * 60_000).description('How long a probe result stands'),
    runTimeoutMs: z.natural().min(1).default(15 * 60_000).description('Hard deadline per run'),
    worktreeRoot: z.string().description('Where the worktrees of worktreePerRun Workers go (default <DSH_HOME>/system/worktrees)'),
    worktreeRetentionHours: z.natural().default(168).description('Hours a workflow run\'s worktree is kept after its last agent run ended; then its changes are committed on its branch and it is removed (0 keeps them)'),
  }) as unknown as z<Config>

  private readonly workers = new Map<string, AgentWorkerConfig>()
  private readonly probes = new Map<string, { at: number; evidence: RuntimeEvidence }>()
  private readonly schedulers = new Map<string, ProviderScheduler>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly cancels = new Map<string, AbortController>()
  private readonly stopped = new AbortController()
  private readonly retries = new Set<NodeJS.Timeout>()
  private readonly warned = new Set<string>()
  /** Whether each `worktreePerRun` Worker's workspace can hold a worktree per run, as last checked. */
  private readonly repositories = new Map<string, { at: number; check: RepositoryCheck }>()
  private readonly worktrees: Worktrees
  private sweeping: Promise<SweepOutcome> | undefined

  constructor(ctx: Context, private readonly config: Config = { workers: [] }) {
    super(ctx, 'agentWorkers')
    for (const worker of config.workers ?? []) {
      if (!ID.test(worker.id)) throw new ProviderError('config_error', `agent Worker id ${worker.id} must match ${ID}`)
      if (!isAbsolute(worker.workspace)) throw new ProviderError('config_error', `agent Worker ${worker.id}: workspace must be an absolute path`)
      if (this.workers.has(PREFIX + worker.id)) throw new ProviderError('config_error', `duplicate agent Worker ${worker.id}`)
      if ((worker.pool === undefined) !== (worker.account === undefined)) throw new ProviderError('config_error', `agent Worker ${worker.id}: pool and account are set together`)
      if (worker.pool === undefined && Object.keys(worker.windows ?? {}).length) throw new ProviderError('config_error', `agent Worker ${worker.id}: windows map limit windows to a pool, and no pool is set`)
      // Workers of one workspace agree on worktreePerRun: a reviewer must read the tree it reviews, the writer's worktree.
      const other = [...this.workers.values()].find((w) => resolve(w.workspace) === resolve(worker.workspace) && !!w.worktreePerRun !== !!worker.worktreePerRun)
      if (other) throw new ProviderError('config_error', `agent Workers ${other.id} and ${worker.id} share the workspace ${worker.workspace}, and only one of them works in a worktree per run (worktreePerRun): set it on both`)
      this.workers.set(PREFIX + worker.id, worker)
    }
    if (config.worktreeRoot !== undefined && !isAbsolute(config.worktreeRoot)) throw new ProviderError('config_error', 'agent Workers: worktreeRoot must be an absolute path')
    this.worktrees = new Worktrees(ctx, config.worktreeRoot ?? join(dshHome(), 'system', 'worktrees'))
    ctx.store.migrate('agent-workers', [{
      version: 1,
      sql: `CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, worker TEXT NOT NULL, session_id TEXT, prompt TEXT NOT NULL,
        classification TEXT NOT NULL, status TEXT NOT NULL, submitted_at TEXT, native_handle TEXT, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_runs_status ON agent_runs (status);
      CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY, worker TEXT NOT NULL, native_handle TEXT, created_at TEXT NOT NULL);`,
    }, {
      // The egress decision of each run (INV-12): the agent runs here, but its model is remote.
      version: 2,
      sql: 'ALTER TABLE agent_runs ADD COLUMN egress_decision TEXT;',
    }, {
      // Metering (docs/design/resources.md): the run's budget decision, and the reservation it holds.
      version: 3,
      sql: 'ALTER TABLE agent_runs ADD COLUMN budget_decision TEXT; ALTER TABLE agent_runs ADD COLUMN reservation_id TEXT;',
    }, {
      // A worktree per workflow run (./worktrees.ts): the run each agent run belongs to, and each run's worktree of a repository.
      version: 4,
      sql: `ALTER TABLE agent_runs ADD COLUMN workflow_run_id TEXT;
      CREATE INDEX agent_runs_workflow_run ON agent_runs (workflow_run_id);
      CREATE TABLE agent_worktrees (
        repository TEXT NOT NULL, workflow_run_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, gitdir TEXT NOT NULL,
        created_at TEXT NOT NULL, removed_at TEXT, decision TEXT, failure TEXT, failed_at TEXT,
        PRIMARY KEY (repository, workflow_run_id)
      );`,
    }, GATE_MIGRATION])
    ctx.workers.register({
      name: 'agents',
      describe: () => this.describe(),
      start: (request) => this.start(request),
      get: (id) => {
        const row = this.row(id)
        return row && execution(row)
      },
      wait: (id, timeoutMs) => this.wait(id, timeoutMs),
      cancel: (id) => this.cancel(id),
      sandbox: (worker, runId) => this.sandboxOf(worker, runId),
      affinity: (sessionId) => {
        const session = this.ctx.store.db.prepare('SELECT worker FROM agent_sessions WHERE session_id = ?').get(sessionId) as { worker: string } | undefined
        return session ? [session.worker] : undefined
      },
      handle: (sessionId) => (this.ctx.store.db.prepare('SELECT native_handle FROM agent_sessions WHERE session_id = ?').get(sessionId) as { native_handle: string | null } | undefined)?.native_handle ?? undefined,
      // The Worker stays (session affinity); without a handle the next run starts a new agent session.
      reset: (sessionId) => Number(this.ctx.store.db.prepare('UPDATE agent_sessions SET native_handle = NULL WHERE session_id = ?').run(sessionId).changes) > 0,
    })
    ctx.effect(() => {
      queueMicrotask(() => {
        this.recover()
        this.sweepSafely()
      })
      const hourly = setInterval(() => this.sweepSafely(), SWEEP_MS)
      hourly.unref()
      return async () => {
        clearInterval(hourly)
        // A stop is not a failure: a started run stays as it is, and the next start reconciles it.
        this.stopped.abort()
        for (const timer of this.retries) clearTimeout(timer)
        for (const scheduler of this.schedulers.values()) scheduler.close(new ProviderError('aborted', 'agent Workers stopped'))
        await Promise.allSettled(this.inflight)
        for (const set of this.waiters.values()) for (const wake of set) wake()
        this.waiters.clear()
      }
    })
  }

  /** Each configured Worker, with what its runtime's probe proves now. */
  private async describe(): Promise<CapabilityDescriptor[]> {
    const observedAt = now()
    return Promise.all([...this.workers].map(async ([id, worker]): Promise<CapabilityDescriptor> => {
      const evidence = await this.evidence(worker)
      // A Worker that works in a worktree per run takes no work while its workspace cannot hold one.
      const repository = worker.worktreePerRun ? await this.repository(id, worker) : undefined
      // A Worker whose runtime cannot keep the host state unreadable (ADR-0024), or cannot ask the
      // run's gate before each tool call, is never admitted.
      const proof = admits(evidence, worker) && (!repository || 'repository' in repository)
      // A metered Worker takes work only while its pool is available (INV-2).
      const pool = proof ? await this.poolGate(id, worker) : 'ready'
      const ready = proof && pool !== 'unavailable'
      const proven = ready
        ? [
            'local-data',
            // A review is independent of the change, so only a Worker that cannot write proves it (INV-15).
            ...(worker.sandbox === 'workspace-write' ? ['develop', ...(evidence.executes ? ['validate'] : [])] : ['review']),
            ...(evidence.resume ? ['persistent-conversation'] : []),
          ]
        : []
      return {
        // The runtime is who serves the work, so it is the Worker's family (ADR-0027).
        schema: 'capability-descriptor@1.1', worker: id, provider: worker.runtime, family: worker.runtime, tier: worker.tier, quotaClass: worker.quotaClass ?? 'agent-plan',
        locality: 'local', capabilities: proven.map((capability) => ({ capability, evidence: { kind: 'probe', at: observedAt } })),
        state: ready ? pool : 'unavailable', observedAt,
      }
    }))
  }

  /** The ledger a metered Worker's runs go through, or undefined for a Worker with no pool. */
  private meter(id: string, worker: AgentWorkerConfig): Meter | undefined {
    if (worker.pool === undefined || worker.account === undefined) return undefined
    const resources = this.ctx.get('resources')
    // Configured to be metered, and no ledger: no run starts (INV-2; docs/design/resources.md).
    if (!resources) throw new ProviderError('config_error', `${id} draws on pool ${worker.pool}, and no resource ledger (ctx.resources) is loaded`)
    return { resources, pool: worker.pool, account: worker.account }
  }

  /** Whether a metered Worker's pool takes work now: `ready`, `quota-exhausted` while it is unavailable, or `unavailable` when it cannot be read. */
  private async poolGate(id: string, worker: AgentWorkerConfig): Promise<'ready' | 'quota-exhausted' | 'unavailable'> {
    try {
      const meter = this.meter(id, worker)
      if (!meter) return 'ready'
      const pool = (await meter.resources.pools({ account: meter.account })).find((p) => p.pool === meter.pool)
      if (!pool) {
        this.warnOnce(`agent Workers: ${id} draws on pool ${meter.pool} of ${meter.account}, which the resource ledger does not configure`)
        return 'unavailable'
      }
      return pool.available ? 'ready' : 'quota-exhausted'
    } catch (error) {
      this.warnOnce(`agent Workers: the pool of ${id} cannot be read: ${(error as Error).message}`)
      return 'unavailable'
    }
  }

  /**
   * Whether a `worktreePerRun` Worker's workspace can hold a worktree per run (the top level of a
   * git repository with a commit), checked at most once per `probeTtlMs`. A problem is a
   * configuration error: logged once, and the Worker takes no work.
   */
  private async repository(id: string, worker: AgentWorkerConfig): Promise<RepositoryCheck> {
    const cached = this.repositories.get(id)
    if (cached && Date.now() - cached.at < (this.config.probeTtlMs ?? 5 * 60_000)) return cached.check
    const check = await this.worktrees.check(worker.workspace)
    this.repositories.set(id, { at: Date.now(), check })
    if ('problem' in check) this.warnOnce(`agent Workers: ${id} works in a worktree per run, and ${check.problem} (config_error); it takes no work`)
    return check
  }

  /**
   * Where a run works: the configured workspace, or, for a run of a `worktreePerRun` Worker that
   * belongs to a workflow run, that run's own worktree, created on first use. Nothing has reached
   * the agent yet: a workspace that cannot be prepared fails the run unsubmitted.
   */
  private async workspaceOf(row: RunRow, worker: AgentWorkerConfig): Promise<string> {
    if (!worker.worktreePerRun) return worker.workspace
    const check = await this.repository(row.worker, worker)
    if ('problem' in check) throw new ProviderError('config_error', `${row.worker} works in a worktree per run, and ${check.problem}; nothing was run`)
    if (!row.workflow_run_id) return worker.workspace
    return this.worktrees.acquire(check.repository, row.workflow_run_id).catch((error: unknown) => {
      throw new ProviderError('config_error', `${row.worker}: the worktree of run ${row.workflow_run_id} cannot be prepared: ${(error as Error).message}; nothing was run`, { cause: error })
    })
  }

  /**
   * Retire the worktrees of finished workflow runs (INV-9): those whose agent runs have all
   * finished, the last more than `worktreeRetentionHours` before `at`, have their changes committed
   * on their branch and are removed; one that cannot be is left in place and tried again next
   * time. Runs hourly; a sweep already running is returned.
   */
  sweepWorktrees(at: number = Date.now()): Promise<SweepOutcome> {
    const hours = this.config.worktreeRetentionHours ?? 168
    if (!hours || this.stopped.signal.aborted) return Promise.resolve({ removed: [], kept: [] })
    if (this.sweeping) return this.sweeping
    const sweeping = this.worktrees.sweep(hours, at, this.stopped.signal).finally(() => {
      this.sweeping = undefined
    })
    this.sweeping = sweeping
    // A stop waits for it: a git command it started is bounded.
    const tracked = sweeping.then(() => undefined, () => undefined)
    this.inflight.add(tracked)
    void tracked.finally(() => this.inflight.delete(tracked))
    return sweeping
  }

  private sweepSafely(): void {
    this.sweepWorktrees().catch((error: unknown) => {
      this.ctx.logger.warn(`agent Workers: the worktree sweep failed; the next one tries again: ${(error as Error).message}`)
    })
  }

  /** `describe` runs on every route: a standing problem is logged once. */
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.ctx.logger.warn(message)
  }

  private async evidence(worker: AgentWorkerConfig): Promise<RuntimeEvidence> {
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    if (!provider) return { available: false, detail: `no ${worker.runtime} runtime is registered`, sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false }
    const cached = this.probes.get(worker.runtime)
    if (cached && Date.now() - cached.at < (this.config.probeTtlMs ?? 5 * 60_000)) return cached.evidence
    const evidence = await provider.probe().catch((error: unknown): RuntimeEvidence => ({ available: false, detail: (error as Error).message.slice(0, 200), sandboxes: [], resume: false, executes: false, readsConfined: false, gatesToolCalls: false }))
    this.probes.set(worker.runtime, { at: Date.now(), evidence })
    return evidence
  }

  /**
   * The confinement a run on an agent Worker is held to, for its brief (brief@1.x `sandbox`): the
   * configured sandbox in the workspace the run works in (with `worktreePerRun`, the workflow run's
   * own worktree), commands only where the runtime proved it confines them (`executes`) and the
   * workspace is writable, and network only as the egress policy and the run's tool gate allow.
   */
  private sandboxOf(id: string, runId: string | undefined): WorkerSandbox | undefined {
    const worker = this.workers.get(id)
    if (!worker) return undefined
    const workspace = worker.worktreePerRun && runId !== undefined && RUN_ID.test(runId) ? this.worktrees.pathOf(worker.workspace, runId) : worker.workspace
    const executes = this.probes.get(worker.runtime)?.evidence.executes === true
    return { mode: worker.sandbox, workspace, network: 'allow-list', commands: worker.sandbox === 'workspace-write' && executes }
  }

  /** Accept a run on an admitted agent Worker: durable at once, idempotent by key. */
  private start(request: WorkerStart): WorkerExecution {
    const worker = this.workers.get(request.worker)
    if (!worker) throw new ProviderError('invalid_input', `${request.worker} is not an agent Worker`)
    // A brief is rendered here, at start, its pointers resolved to their artifacts' text (INV-12).
    const { prompt, classification } = promptOfStart(request, (ref) => this.ctx.artifacts.get(ref))
    if (!prompt.trim()) throw new ProviderError('invalid_input', 'prompt must not be empty')
    // It may name a branch and a directory (a worktree per run): letters, digits, `_`, and `-` only.
    if (request.runId !== undefined && !RUN_ID.test(request.runId)) throw new ProviderError('invalid_input', `run id ${JSON.stringify(request.runId)} must match ${RUN_ID}`)
    const key = sha256(`agent\0${request.key}`)
    return this.ctx.store.transaction((db) => {
      const existing = db.prepare('SELECT * FROM agent_runs WHERE request_key = ?').get(key) as RunRow | undefined
      if (existing) {
        if (existing.prompt !== prompt) throw new ProviderError('invalid_input', 'the request key was reused with a different prompt')
        return execution(existing)
      }
      if (request.sessionId) {
        db.prepare('INSERT OR IGNORE INTO agent_sessions (session_id, worker, native_handle, created_at) VALUES (?, ?, NULL, ?)').run(request.sessionId, request.worker, now())
        const bound = (db.prepare('SELECT worker FROM agent_sessions WHERE session_id = ?').get(request.sessionId) as { worker: string }).worker
        if (bound !== request.worker) throw new ProviderError('invalid_input', `session ${request.sessionId} belongs to ${bound}, not ${request.worker}`)
      }
      const row: RunRow = {
        run_id: newId(), request_key: key, worker: request.worker, session_id: request.sessionId ?? null, prompt,
        classification, status: 'queued', submitted_at: null, native_handle: null, result: null, error: null,
        workflow_run_id: request.runId ?? null, created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO agent_runs (run_id, request_key, worker, session_id, prompt, classification, status, workflow_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(row.run_id, key, row.worker, row.session_id, row.prompt, row.classification, row.workflow_run_id ?? null, row.created_at, row.updated_at)
      this.ctx.store.afterCommit(() => this.schedule(row.run_id))
      return execution(row)
    })
  }

  private async wait(runId: string, timeoutMs: number): Promise<WorkerExecution> {
    const current = this.row(runId)
    if (!current) throw new ProviderError('invalid_input', `unknown agent run ${runId}`)
    if (current.status === 'completed' || current.status === 'failed' || this.stopped.signal.aborted) return execution(current)
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(runId) ?? new Set()
      this.waiters.set(runId, set)
      const wake = (): void => {
        clearTimeout(timer)
        set.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      set.add(wake)
    })
    return execution(this.row(runId)!)
  }

  /** Cancel a run (REQ-WRK-4): a running agent is stopped, a queued run never starts. */
  private cancel(runId: string): boolean {
    const row = this.row(runId)
    if (!row || row.status === 'completed' || row.status === 'failed') return false
    const running = this.cancels.get(runId)
    if (running) {
      running.abort(new ProviderError('aborted', 'cancelled by the operator'))
      return true
    }
    const lease = this.ctx.leases.acquire(`agent-run:${runId}`, LEASE_TTL_MS)
    if (!lease) return false
    try {
      this.fail(row, new ProviderError('aborted', 'cancelled by the operator'), () => lease)
    } finally {
      this.ctx.leases.release(lease)
    }
    return true
  }

  private recover(): void {
    if (this.stopped.signal.aborted) return
    const rows = this.ctx.store.db.prepare("SELECT run_id FROM agent_runs WHERE status IN ('queued', 'running') ORDER BY created_at").all() as Array<{ run_id: string }>
    for (const { run_id } of rows) this.schedule(run_id)
  }

  /** Look again later: a lease held elsewhere expires, a lost one is retaken (a started run then fails, INV-4). */
  private retryLater(runId: string, delayMs: number): void {
    if (this.stopped.signal.aborted) return
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      this.schedule(runId)
    }, delayMs)
    timer.unref()
    this.retries.add(timer)
  }

  private schedule(runId: string): void {
    if (this.stopped.signal.aborted) return
    const running = this.runOwned(runId).catch(() => undefined)
    this.inflight.add(running)
    void running.finally(() => this.inflight.delete(running))
  }

  private async runOwned(runId: string): Promise<void> {
    // While another process holds it, it finishes the run, or crashed and its lease expires.
    const outcome = await this.ctx.leases.hold(`agent-run:${runId}`, LEASE_TTL_MS, async ({ lease: current, lost }) => {
      const cancel = new AbortController()
      this.cancels.set(runId, cancel)
      const signal = AbortSignal.any([lost, this.stopped.signal, cancel.signal])
      try {
        const row = this.row(runId)
        if (!row || row.status === 'completed' || row.status === 'failed') return
        if (row.submitted_at) {
          // Started before a stop: the agent may already have acted in its workspace.
          this.fail(row, new ProviderError('reconciliation_failed',
            `the host stopped while ${row.worker} was running this task${row.native_handle ? ` (native session ${row.native_handle})` : ''}; it is not run again automatically`), current)
          // Its usage is not invented: it comes from the agent's transcript, reconciled later.
          if (row.reservation_id) await this.release(row.worker, row.reservation_id)
          return
        }
        const worker = this.workers.get(row.worker)
        if (!worker) throw new ProviderError('config_error', `${row.worker} is no longer configured`)
        // INV-12: the prompt reaches the agent's remote model, so it is checked before anything starts.
        const egress = await this.ctx.egress.check({ payload: row.prompt, classification: row.classification as Classification, workerClass: 'agent' })
        // Fenced like every write of a run: a holder that lost the run writes nothing.
        this.update(row.run_id, { egress_decision: egress.decision }, current)
        if (!egress.allowed) {
          this.fail(row, new ProviderError('egress_denied', `${egress.reason} (decision ${egress.decision})`), current)
          return
        }
        await this.scheduler(row.worker).runTurn(row.worker, signal, async (slot) => this.execute(row, worker, AbortSignal.any([signal, slot.signal]), current))
      } catch (error) {
        if (this.stopped.signal.aborted) return
        if (error instanceof LeaseLost || error instanceof StaleGeneration || lost.aborted) {
          this.retryLater(runId, LEASE_TTL_MS)
          return
        }
        const row = this.row(runId)
        if (cancel.signal.aborted && row && row.status !== 'completed' && row.status !== 'failed') {
          this.fail(row, new ProviderError('aborted', 'cancelled by the operator'), current)
          return
        }
        if (row && row.status !== 'completed' && row.status !== 'failed') this.fail(row, error, current)
      } finally {
        this.cancels.delete(runId)
      }
    })
    if (!outcome.held) this.retryLater(runId, outcome.retryInMs)
  }

  private async execute(row: RunRow, worker: AgentWorkerConfig, signal: AbortSignal, lease: () => Lease): Promise<void> {
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    if (!provider) throw new ProviderError('config_error', `no ${worker.runtime} runtime is registered`)
    // Admission proved it once; a queued run, or one taken up after a restart, runs only on
    // proof that still holds (ADR-0024). Nothing has reached the agent yet.
    const evidence = await this.evidence(worker)
    if (!admits(evidence, worker)) {
      throw new ProviderError('config_error', `${worker.runtime} cannot run this Worker now: ${evidence.gatesToolCalls ? evidence.detail : `${evidence.detail}; it cannot ask the run's gate before each tool call`}`)
    }
    const workspace = await this.workspaceOf(row, worker)
    // Every tool call passes the run's gate before it runs; the runtime's own policy still holds.
    const gate = runGate(this.ctx, {
      runId: row.run_id, worker: row.worker, workspace, sessionId: row.session_id ?? undefined, workflowRunId: row.workflow_run_id ?? undefined,
      classification: row.classification as 'public' | 'operator-shared' | 'local-private',
    })
    const session = row.session_id
      ? this.ctx.store.db.prepare('SELECT native_handle FROM agent_sessions WHERE session_id = ?').get(row.session_id) as { native_handle: string | null } | undefined
      : undefined
    const spec: RunSpec = {
      prompt: row.prompt, workspace, sandbox: worker.sandbox,
      // Omitted or empty means the runtime's minimal set: the config schema turns an omitted list into [].
      ...(worker.tools?.length ? { tools: worker.tools } : {}), ...(worker.model ? { model: worker.model } : {}), ...(worker.maxTurns ? { maxTurns: worker.maxTurns } : {}),
      ...(session?.native_handle ? { resume: session.native_handle } : {}),
      toolGate: gate.gate,
    }
    // Metered: nothing runs without a reservation (INV-2, INV-9).
    const meter = this.meter(row.worker, worker)
    const reservation = meter ? await this.reserve(row, meter, lease) : undefined
    try {
      const result = await this.submit(row, worker, provider, spec, signal, lease, meter, gate.deferral)
      this.complete(row, worker, workspace, result, lease)
    } finally {
      if (reservation) await this.release(row.worker, reservation)
    }
  }

  /** Run the agent, and meter what it consumed, completed or not. */
  private async submit(row: RunRow, worker: AgentWorkerConfig, provider: AgentRuntimeProvider, spec: RunSpec, signal: AbortSignal, lease: () => Lease, meter: Meter | undefined, deferral: () => Deferral | undefined): Promise<RunResult> {
    // Submitted from here on: the agent may act as soon as it starts.
    this.update(row.run_id, { status: 'running', submitted_at: now() }, lease)
    const startedAt = Date.now()
    const deadline = AbortSignal.timeout(this.config.runTimeoutMs ?? 15 * 60_000)
    let result: RunResult
    try {
      result = await provider.run(spec, AbortSignal.any([signal, deadline]), (handle) => {
        this.ctx.store.transaction((db) => {
          this.ctx.leases.fence(lease())
          db.prepare('UPDATE agent_runs SET native_handle = ?, updated_at = ? WHERE run_id = ?').run(handle, now(), row.run_id)
          if (row.session_id) db.prepare('UPDATE agent_sessions SET native_handle = ? WHERE session_id = ?').run(handle, row.session_id)
        })
      })
    } catch (error) {
      const deferred = deferral()
      const failure = deadline.aborted && !signal.aborted
        ? new ProviderError('timeout', `${row.worker} did not finish within ${this.config.runTimeoutMs ?? 15 * 60_000} ms; it was stopped`, { cause: error })
        : deferred && !signal.aborted ? waiting(row, deferred, error) : error
      if (meter) await this.account(row, worker, meter, meteringOf(error), toProviderError(failure).kind === 'aborted' ? 'aborted' : 'failed', Date.now() - startedAt)
      throw failure
    }
    // A run whose gate deferred a call did not finish, whatever its runtime reported (INV-2).
    const deferred = deferral()
    if (deferred) {
      if (meter) await this.account(row, worker, meter, result, 'failed', Date.now() - startedAt)
      throw waiting(row, deferred)
    }
    if (meter) await this.account(row, worker, meter, result, 'completed', Date.now() - startedAt)
    return result
  }

  /** Store the result as a `report` artifact and complete the run. */
  private complete(row: RunRow, worker: AgentWorkerConfig, workspace: string, result: RunResult, lease: () => Lease): void {
    const handle = result.nativeHandle ?? this.row(row.run_id)?.native_handle ?? undefined
    // A worktree whose .git file the agent pointed elsewhere is not read by git: its result is not trusted.
    if (workspace !== worker.workspace && !this.worktrees.intact(workspace)) {
      throw new ProviderError('reconciliation_failed', `${row.worker} changed the .git file of its worktree ${workspace}; the result is not trusted, and the worktree is left for the operator`)
    }
    // The workspace's exact subject after the run, so a review can bind to it (REQ-WF-5).
    const captured = captureGitSubject(workspace)
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      if (handle && row.session_id) db.prepare('UPDATE agent_sessions SET native_handle = ? WHERE session_id = ?').run(handle, row.session_id)
      // `agent-result@1.2` when the runtime reported its token usage, `@1.1` otherwise.
      const usage = usageOf(result)
      const schema = usage.usage ? 'agent-result@1.2' : 'agent-result@1.1'
      const artifact = this.ctx.artifacts.put({
        kind: 'report', bodySchema: schema,
        body: {
          schema, worker: row.worker, runtime: worker.runtime, runId: row.run_id,
          ...(row.session_id ? { sessionId: row.session_id } : {}), ...(handle ? { nativeHandle: handle } : {}),
          promptHash: sha256(row.prompt), sandbox: worker.sandbox, workspace,
          ...(captured ? { subject: captured.subject } : {}),
          ...(result.turns !== undefined ? { turns: result.turns } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(usage.usage && result.model ? { model: result.model } : {}), ...usage,
          text: result.text,
        },
        classification: row.classification as 'public' | 'operator-shared' | 'local-private',
        producer: { type: 'worker', ref: row.worker },
      })
      this.update(row.run_id, { status: 'completed', result: artifact.id, ...(handle ? { native_handle: handle } : {}) }, lease)
    })
  }

  /**
   * Reserve the run's draw on its pool, recording the `budget` decision on the run. A refusal fails
   * the run before anything reaches the agent: `quota_exhausted` while the pool is unavailable,
   * `config_error` when the ledger does not configure it. Returns the reservation id.
   */
  private async reserve(row: RunRow, meter: Meter, lease: () => Lease): Promise<string> {
    const reserved = await meter.resources.reserve({ runId: row.run_id, lines: [{ pool: meter.pool, unit: 'runs', amount: 1 }] }).catch((error: unknown) => {
      throw error instanceof ResourcesError ? new ProviderError('config_error', `the resource ledger refused to reserve for ${row.worker}: ${error.message}`, { cause: error }) : error
    })
    try {
      this.update(row.run_id, { budget_decision: reserved.decision, ...(reserved.state === 'reserved' ? { reservation_id: reserved.reservationId } : {}) }, lease)
    } catch (error) {
      if (reserved.state === 'reserved') await this.release(row.worker, reserved.reservationId)
      throw error
    }
    if (reserved.state === 'reserved') return reserved.reservationId
    const configured = await meter.resources.pools({ account: meter.account }).then((pools) => pools.some((p) => p.pool === meter.pool), () => true)
    const reasons = reserved.reasons.join('; ')
    throw new ProviderError(configured ? 'quota_exhausted' : 'config_error', `${row.worker} may not draw on pool ${meter.pool} now: ${reasons} (budget decision ${reserved.decision}); nothing was run`)
  }

  private async release(worker: string, reservationId: string): Promise<void> {
    const resources = this.ctx.get('resources')
    if (!resources) return
    await resources.release(reservationId).catch((error: unknown) => {
      // Released already (the run's own release, before a restart), or the ledger forgot it.
      if (error instanceof ResourcesError && error.failure === 'unknown-reservation') return
      this.ctx.logger.warn(`agent Workers: the reservation ${reservationId} of ${worker} could not be released: ${(error as Error).message}`)
    })
  }

  /**
   * Meter a run from what its runtime reported: each limit observation as a `limit-state`
   * reading, then one `usage-record` (source `runtime-result`). Numbers the runtime did not report
   * stay missing; a run that reported neither tokens nor turns gets no record here (its transcript
   * is reconciled later). The run's own outcome never depends on the ledger: a refusal is logged.
   */
  private async account(row: RunRow, worker: AgentWorkerConfig, meter: Meter, metering: RunMetering | undefined, outcome: 'completed' | 'failed' | 'aborted', durationMs: number): Promise<void> {
    if (metering?.limits?.length) await this.observe(row.worker, worker, meter, metering.limits)
    const usage = usageOf(metering)
    if (!usage.usage && metering?.turns === undefined) {
      this.ctx.logger.warn(`agent Workers: ${row.run_id} on ${row.worker} reported no usage; it is left to transcript reconciliation`)
      return
    }
    const model = { ...(worker.model ? { request: worker.model } : {}), ...(metering?.model ? { response: metering.model } : {}) }
    const record: UsageRecord = {
      schema: 'usage-record@1.0',
      // The runtime's own identity of its result, so another source of the same unit is a duplicate.
      requestId: `${worker.runtime}:${metering?.resultId ?? row.run_id}`,
      source: 'runtime-result', observedAt: now(), account: meter.account, pool: meter.pool, worker: row.worker, runId: row.run_id,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(Object.keys(model).length ? { model } : {}), ...usage,
      ...(metering?.turns !== undefined ? { turns: metering.turns } : {}), durationMs: Math.max(0, Math.round(durationMs)),
      ...(metering?.costUsd !== undefined ? { cost: { amount: metering.costUsd, currency: 'USD' as const, basis: 'runtime-estimate' as const } } : {}),
      outcome,
    }
    await meter.resources.record(record).catch((error: unknown) => {
      this.ctx.logger.warn(`agent Workers: the usage of ${row.run_id} on ${row.worker} was not recorded: ${(error as Error).message}`)
    })
  }

  /** Record the runtime's limit observations as readings of the pool's mapped windows. */
  private async observe(id: string, worker: AgentWorkerConfig, meter: Meter, limits: LimitObservation[]): Promise<void> {
    const pool = await meter.resources.pools({ account: meter.account }).then((pools) => pools.find((p) => p.pool === meter.pool), () => undefined)
    const cooldownMs = (worker.limitCooldownSeconds ?? 3600) * 1000
    for (const limit of limits) {
      const windowId = worker.windows?.[limit.window]
      const mapped = windowId === undefined ? undefined : pool?.windows.find((w) => w.id === windowId)
      // A limit hit the ledger cannot place (an unmapped or unnamed window) closes every window of
      // the pool: it is never retried on the same pool unseen (INV-2). Anything else unmapped is skipped.
      const windows = mapped ? [mapped] : limit.status === 'rejected' ? pool?.windows ?? [] : []
      if (!windows.length) {
        this.ctx.logger.warn(`agent Workers: ${id} observed limit window ${limit.window}, which ${windowId === undefined ? 'its windows do not map' : `maps to ${windowId}, not a window of pool ${meter.pool}`}; not recorded`)
        continue
      }
      for (const window of windows) {
        const reading: LimitState = {
          schema: 'limit-state@1.0', pool: meter.pool, account: meter.account,
          window: { id: window.id, kind: window.kind, ...(window.seconds !== undefined ? { seconds: window.seconds } : {}) },
          // A limit hit is limited until its reset, or, with none given, for the configured cooldown:
          // never unknown, which a pool configured to admit unknown windows would ignore.
          ...(limit.status !== 'rejected' ? { state: 'ok' as const, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) }
            : limit.resetsAt ? { state: 'limited' as const, resetsAt: limit.resetsAt }
              : { state: 'limited' as const, cooldownUntil: new Date(Date.parse(limit.observedAt) + cooldownMs).toISOString() }),
          ...(mapped && limit.usedPercentage !== undefined ? { usedPercentage: limit.usedPercentage } : {}),
          source: 'runtime-result', observedAt: limit.observedAt,
        }
        await meter.resources.observe(reading).catch((error: unknown) => {
          this.ctx.logger.warn(`agent Workers: a limit reading of ${id} was not recorded: ${(error as Error).message}`)
        })
      }
    }
  }

  private scheduler(worker: string): ProviderScheduler {
    if (this.stopped.signal.aborted) throw new ProviderError('aborted', 'agent Workers stopped')
    let scheduler = this.schedulers.get(worker)
    if (!scheduler) this.schedulers.set(worker, (scheduler = new ProviderScheduler(1)))
    return scheduler
  }

  private fail(row: RunRow, error: unknown, lease: () => Lease): void {
    const typed = toProviderError(error)
    this.update(row.run_id, { status: 'failed', error: JSON.stringify({ kind: typed.kind, disposition: dispositionOf(typed.kind), message: typed.message }) }, lease)
  }

  private update(runId: string, fields: Partial<Omit<RunRow, 'run_id'>>, lease: () => Lease): void {
    const entries = Object.entries({ ...fields, updated_at: now() })
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      db.prepare(`UPDATE agent_runs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE run_id = ?`).run(...entries.map(([, v]) => v as string | null), runId)
    })
    if (fields.status === 'completed' || fields.status === 'failed') {
      this.ctx.store.afterCommit(() => {
        for (const wake of this.waiters.get(runId) ?? []) wake()
        this.waiters.delete(runId)
      })
    }
  }

  private row(runId: string): RunRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as RunRow | undefined
  }
}

/** Whether a runtime's evidence admits a Worker: available, reads confined, its sandbox enforced, and a gate asked before each tool call. */
function admits(evidence: RuntimeEvidence, worker: AgentWorkerConfig): boolean {
  return evidence.available && evidence.readsConfined && evidence.gatesToolCalls === true && evidence.sandboxes.includes(worker.sandbox)
}

/**
 * The failure of a run that stopped at a deferred tool call. The workers seam has no waiting
 * status, so it fails as `config_error` (never retried), naming the request; a later run of its
 * session makes the call once the operator approved it.
 */
function waiting(row: RunRow, deferred: Deferral, cause?: unknown): ProviderError {
  return new ProviderError('config_error', `${row.worker} stopped at its ${deferred.tool} call, which waits for the operator's approval (approval request ${deferred.requestId}); nothing of that call ran. `
    + `Once it is approved, a later run of session ${row.session_id ?? '(none)'} makes exactly that call`, cause === undefined ? undefined : { cause })
}

function execution(row: RunRow): WorkerExecution {
  return {
    id: row.run_id, status: row.status, submitted: row.submitted_at !== null,
    ...(row.result ? { result: row.result as ArtifactRef } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as WorkerExecution['error'] & object } : {}),
    decisions: [row.egress_decision, row.budget_decision].filter((d): d is string => typeof d === 'string').map((d) => d as ContentId),
  }
}

/** The ledger a metered Worker draws on. */
interface Meter {
  resources: Resources
  pool: string
  account: string
}

/**
 * The token usage of a run as records carry it: totals, and the per-model split when it fits
 * (at most `MAX_MODELS`, or the totals alone).
 */
function usageOf(metering: RunMetering | undefined): Pick<UsageRecord, 'usage' | 'models'> {
  if (!metering?.usage) return {}
  const models = metering.models && metering.models.length <= MAX_MODELS ? metering.models : undefined
  return { usage: { ...metering.usage }, ...(models ? { models: models.map((m) => ({ model: m.model, usage: { ...m.usage }, ...(m.costUsd !== undefined ? { costUsd: m.costUsd } : {}) })) } : {}) }
}

export type { SweepOutcome } from './worktrees.ts'
export default AgentWorkers
