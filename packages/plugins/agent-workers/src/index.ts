/**
 * The `agents` Worker source (docs/design/agent-runtimes.md): each configured Worker is an
 * agent runtime (`ctx.agentRuntimes`) held to a policy from configuration (workspace,
 * sandbox, tool allow-list; INV-6). Its capabilities are what `probe()` proves now; a policy
 * the runtime cannot enforce leaves the Worker unavailable, never loosened. Runs are durable
 * and run one at a time per Worker (one writer per workspace, INV-15). A run that started
 * and did not finish is never run again by itself: the agent may already have acted (INV-4).
 * @module @tsuuanmi/system-agent-workers
 */
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RunSpec, RuntimeEvidence, SandboxMode } from '@tsuuanmi/system-agent-runtime-core'
import type {} from '@tsuuanmi/system-artifacts'
import type { Classification } from '@tsuuanmi/system-egress'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { captureGitSubject, type ContentId, sha256 } from '@tsuuanmi/system-libs'
import { ProviderError, ProviderScheduler, dispositionOf, toProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import type { ArtifactRef, CapabilityDescriptor, ExecutionStatus, QuotaClass, Tier, WorkerExecution, WorkerStart } from '@tsuuanmi/system-workers-core'

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
}

export interface Config {
  workers: AgentWorkerConfig[]
  /** How long a probe result stands (default 5 min). */
  probeTtlMs?: number
  /** Hard deadline per run; the agent is stopped and the run fails as `timeout` (default 15 min). */
  runTimeoutMs?: number
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
  created_at: string
  updated_at: string
}

const ID = /^[a-z][a-z0-9-]*$/
const LEASE_TTL_MS = 60_000
const PREFIX = 'agent:'
const newId = (): string => `arun_${randomBytes(8).toString('hex')}`
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
    })).default([]).description('Agent-runtime Workers; each policy comes from here only (INV-6)'),
    probeTtlMs: z.natural().default(5 * 60_000).description('How long a probe result stands'),
    runTimeoutMs: z.natural().min(1).default(15 * 60_000).description('Hard deadline per run'),
  }) as unknown as z<Config>

  private readonly workers = new Map<string, AgentWorkerConfig>()
  private readonly probes = new Map<string, { at: number; evidence: RuntimeEvidence }>()
  private readonly schedulers = new Map<string, ProviderScheduler>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly cancels = new Map<string, AbortController>()
  private readonly stopped = new AbortController()
  private readonly retries = new Set<NodeJS.Timeout>()

  constructor(ctx: Context, private readonly config: Config = { workers: [] }) {
    super(ctx, 'agentWorkers')
    for (const worker of config.workers ?? []) {
      if (!ID.test(worker.id)) throw new ProviderError('config_error', `agent Worker id ${worker.id} must match ${ID}`)
      if (!isAbsolute(worker.workspace)) throw new ProviderError('config_error', `agent Worker ${worker.id}: workspace must be an absolute path`)
      if (this.workers.has(PREFIX + worker.id)) throw new ProviderError('config_error', `duplicate agent Worker ${worker.id}`)
      this.workers.set(PREFIX + worker.id, worker)
    }
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
    }])
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
      affinity: (sessionId) => {
        const session = this.ctx.store.db.prepare('SELECT worker FROM agent_sessions WHERE session_id = ?').get(sessionId) as { worker: string } | undefined
        return session ? [session.worker] : undefined
      },
      handle: (sessionId) => (this.ctx.store.db.prepare('SELECT native_handle FROM agent_sessions WHERE session_id = ?').get(sessionId) as { native_handle: string | null } | undefined)?.native_handle ?? undefined,
      // The Worker stays (session affinity); without a handle the next run starts a new agent session.
      reset: (sessionId) => Number(this.ctx.store.db.prepare('UPDATE agent_sessions SET native_handle = NULL WHERE session_id = ?').run(sessionId).changes) > 0,
    })
    ctx.effect(() => {
      queueMicrotask(() => this.recover())
      return async () => {
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
      // A Worker whose runtime cannot keep the host state unreadable is never admitted (ADR-0024).
      const ready = evidence.available && evidence.readsConfined && evidence.sandboxes.includes(worker.sandbox)
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
        state: ready ? 'ready' : 'unavailable', observedAt,
      }
    }))
  }

  private async evidence(worker: AgentWorkerConfig): Promise<RuntimeEvidence> {
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    if (!provider) return { available: false, detail: `no ${worker.runtime} runtime is registered`, sandboxes: [], resume: false, executes: false, readsConfined: false }
    const cached = this.probes.get(worker.runtime)
    if (cached && Date.now() - cached.at < (this.config.probeTtlMs ?? 5 * 60_000)) return cached.evidence
    const evidence = await provider.probe().catch((error: unknown): RuntimeEvidence => ({ available: false, detail: (error as Error).message.slice(0, 200), sandboxes: [], resume: false, executes: false, readsConfined: false }))
    this.probes.set(worker.runtime, { at: Date.now(), evidence })
    return evidence
  }

  /** Accept a run on an admitted agent Worker: durable at once, idempotent by key. */
  private start(request: WorkerStart): WorkerExecution {
    const worker = this.workers.get(request.worker)
    if (!worker) throw new ProviderError('invalid_input', `${request.worker} is not an agent Worker`)
    if (!request.prompt.trim()) throw new ProviderError('invalid_input', 'prompt must not be empty')
    const key = sha256(`agent\0${request.key}`)
    return this.ctx.store.transaction((db) => {
      const existing = db.prepare('SELECT * FROM agent_runs WHERE request_key = ?').get(key) as RunRow | undefined
      if (existing) {
        if (existing.prompt !== request.prompt) throw new ProviderError('invalid_input', 'the request key was reused with a different prompt')
        return execution(existing)
      }
      if (request.sessionId) {
        db.prepare('INSERT OR IGNORE INTO agent_sessions (session_id, worker, native_handle, created_at) VALUES (?, ?, NULL, ?)').run(request.sessionId, request.worker, now())
        const bound = (db.prepare('SELECT worker FROM agent_sessions WHERE session_id = ?').get(request.sessionId) as { worker: string }).worker
        if (bound !== request.worker) throw new ProviderError('invalid_input', `session ${request.sessionId} belongs to ${bound}, not ${request.worker}`)
      }
      const row: RunRow = {
        run_id: newId(), request_key: key, worker: request.worker, session_id: request.sessionId ?? null, prompt: request.prompt,
        classification: request.requirement.data.classification, status: 'queued', submitted_at: null, native_handle: null, result: null, error: null,
        created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO agent_runs (run_id, request_key, worker, session_id, prompt, classification, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(row.run_id, key, row.worker, row.session_id, row.prompt, row.classification, row.created_at, row.updated_at)
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
    if (!evidence.available || !evidence.readsConfined || !evidence.sandboxes.includes(worker.sandbox)) {
      throw new ProviderError('config_error', `${worker.runtime} cannot run this Worker now: ${evidence.detail}`)
    }
    const session = row.session_id
      ? this.ctx.store.db.prepare('SELECT native_handle FROM agent_sessions WHERE session_id = ?').get(row.session_id) as { native_handle: string | null } | undefined
      : undefined
    const spec: RunSpec = {
      prompt: row.prompt, workspace: worker.workspace, sandbox: worker.sandbox,
      // Omitted or empty means the runtime's minimal set: the config schema turns an omitted list into [].
      ...(worker.tools?.length ? { tools: worker.tools } : {}), ...(worker.model ? { model: worker.model } : {}), ...(worker.maxTurns ? { maxTurns: worker.maxTurns } : {}),
      ...(session?.native_handle ? { resume: session.native_handle } : {}),
    }
    // Submitted from here on: the agent may act as soon as it starts.
    this.update(row.run_id, { status: 'running', submitted_at: now() }, lease)
    const deadline = AbortSignal.timeout(this.config.runTimeoutMs ?? 15 * 60_000)
    const result = await provider.run(spec, AbortSignal.any([signal, deadline]), (handle) => {
      this.ctx.store.transaction((db) => {
        this.ctx.leases.fence(lease())
        db.prepare('UPDATE agent_runs SET native_handle = ?, updated_at = ? WHERE run_id = ?').run(handle, now(), row.run_id)
        if (row.session_id) db.prepare('UPDATE agent_sessions SET native_handle = ? WHERE session_id = ?').run(handle, row.session_id)
      })
    }).catch((error: unknown) => {
      if (deadline.aborted && !signal.aborted) throw new ProviderError('timeout', `${row.worker} did not finish within ${this.config.runTimeoutMs ?? 15 * 60_000} ms; it was stopped`, { cause: error })
      throw error
    })
    const handle = result.nativeHandle ?? this.row(row.run_id)?.native_handle ?? undefined
    // The workspace's exact subject after the run, so a review can bind to it (REQ-WF-5).
    const captured = captureGitSubject(worker.workspace)
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      if (handle && row.session_id) db.prepare('UPDATE agent_sessions SET native_handle = ? WHERE session_id = ?').run(handle, row.session_id)
      const artifact = this.ctx.artifacts.put({
        kind: 'report', bodySchema: 'agent-result@1.1',
        body: {
          schema: 'agent-result@1.1', worker: row.worker, runtime: worker.runtime, runId: row.run_id,
          ...(row.session_id ? { sessionId: row.session_id } : {}), ...(handle ? { nativeHandle: handle } : {}),
          promptHash: sha256(row.prompt), sandbox: worker.sandbox, workspace: worker.workspace,
          ...(captured ? { subject: captured.subject } : {}),
          ...(result.turns !== undefined ? { turns: result.turns } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          text: result.text,
        },
        classification: row.classification as 'public' | 'operator-shared' | 'local-private',
        producer: { type: 'worker', ref: row.worker },
      })
      this.update(row.run_id, { status: 'completed', result: artifact.id, ...(handle ? { native_handle: handle } : {}) }, lease)
    })
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

function execution(row: RunRow): WorkerExecution {
  return {
    id: row.run_id, status: row.status, submitted: row.submitted_at !== null,
    ...(row.result ? { result: row.result as ArtifactRef } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as WorkerExecution['error'] & object } : {}),
    decisions: row.egress_decision ? [row.egress_decision as ContentId] : [],
  }
}

export default AgentWorkers
