/**
 * `ctx.workflow`: the single workflow engine (ADR-0004, ADR-0012, INV-1), MVP subset:
 * static DAGs from templates, durable `workflow-node@1.0` records, input-hash receipts,
 * acceptance through `ctx.workers` (REQ-WRK-3), bounded retries by disposition (REQ-WF-6),
 * and recovery on restart (REQ-WF-4). Every call, `ask` included, is a DAG on this engine.
 * A `worker` node runs as a turn on the website Worker runtime (`ctx.turns`), keyed by run,
 * node, attempt, and input hash, so a restart re-attaches to the same turn and never resends.
 * @module @tsuuanmi/system-workflow
 */
import { randomBytes } from 'node:crypto'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Decision } from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import type {} from '@tsuuanmi/system-gateway-core'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { canonicalJson, type ContentId, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import type {} from '@tsuuanmi/system-egress'
import { dispositionOf, type ProviderErrorKind } from '@tsuuanmi/system-provider-core'
import { AdmissionFailure, type AdmittedWorker, type ArtifactRef, type Classification, type Tier, type WorkRequirement, type WorkerExecution } from '@tsuuanmi/system-workers-core'
import { z as zod } from 'zod'
import { type CallerOptions, DEFAULT_TEMPLATES, type NodeTemplate, render, type ResolvedNode, resolve } from './spec.ts'

export { DEFAULT_TEMPLATES, preflight, render, resolve } from './spec.ts'
export type { NodeTemplate, ResolvedNode, ResolvedSpec } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflow: Workflow
  }
}

export type RunStatus = 'running' | 'completed' | 'failed'
export type NodeState = 'WAITING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED'

export interface WorkflowError {
  kind: string
  disposition: string
  message: string
}

/** A durable node record (`workflow-node@1.0`). */
export interface NodeRecord {
  schema: 'workflow-node@1.0'
  runId: string
  nodeId: string
  objective: string
  executor: 'worker'
  requirement: WorkRequirement
  dependsOn: string[]
  state: NodeState
  inputReceipt?: { inputHash: ContentId; bundle: ArtifactRef[] }
  outputReceipt?: { result: ArtifactRef; acceptance: ArtifactRef }
  execution?: { executionId: string; attempt: number; owner: string; generation: number; route: ArtifactRef }
  lastDecision?: ArtifactRef
  revision: number
}

export interface NodeView {
  nodeId: string
  state: NodeState
  /** The node's minimum tier. */
  minTier: Tier
  attempt: number
  /** The execution on the Worker's own runtime (a turn id for website Workers). */
  executionId?: string
  /** The Worker source that runs it. */
  source?: string
  worker?: string
  /** The tier of the Worker that served the node. */
  tier?: Tier
  quotaClass?: string
  result?: ArtifactRef
  error?: WorkflowError
}

/** What callers see: never the input text. */
export interface RunView {
  runId: string
  template: string
  status: RunStatus
  specHash: ContentId
  sessionId?: string
  /** The final node's result, and its text. */
  result?: ArtifactRef
  answer?: string
  nodes: NodeView[]
  error?: WorkflowError
  createdAt: string
  updatedAt: string
}

export interface StartInput extends CallerOptions {
  template: string
  /** The caller's text: the prompt or the research question. */
  input: string
  classification?: Classification | undefined
  /** Retry-safe request key: the same key returns the same run. */
  clientRequestId?: string | undefined
}

export interface ExplainedDecision {
  id: ArtifactRef
  type: string
  outcome: string
  /** Reasons of the selected candidate. */
  reasons: string[]
}

export interface Explanation {
  runId: string
  template: string
  status: RunStatus
  specHash: ContentId
  nodes: Array<{ nodeId: string; state: NodeState; executionId?: string; worker?: string; quotaClass?: string; decisions: ExplainedDecision[] }>
}

export interface Config {
  /** Workflow templates by name, added to (or replacing) the built-in `ask` and `research`. */
  templates?: Record<string, NodeTemplate[]>
  /** Attempts per node for IMMEDIATE, BACKOFF, and RECREATE_SESSION failures (default 3). */
  maxAttempts?: number
  /** First back-off delay; doubles per attempt (default 5 s). */
  retryDelayMs?: number
  /** Unfinished runs accepted at once (default 16); more are refused (INV-9). */
  maxActiveRuns?: number
  /** A finished run's input text and prompts are cleared after this many days (default 30); the run stays. */
  retainDays?: number
}

interface RunRow {
  run_id: string
  request_key: string | null
  template: string
  spec_hash: string
  input: string
  classification: Classification | null
  session_id: string | null
  status: RunStatus
  result: string | null
  error: string | null
  created_at: string
  updated_at: string
}

interface NodeRow {
  run_id: string
  node_id: string
  ordinal: number
  spec: string
  record: string
  state: NodeState
  prompt: string | null
  execution_id: string | null
  source: string | null
  attempt: number
  not_before: string | null
  worker: string | null
  served_tier: Tier | null
  quota_class: string | null
  /** The turn's egress, tier, and route (or admission) decisions, kept here because runs outlive turns. */
  decisions: string | null
  error: string | null
  updated_at: string
}

const LEASE_TTL_MS = 60_000
const RETRYABLE = new Set(['IMMEDIATE', 'BACKOFF', 'RECREATE_SESSION'])
const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`
const now = (): string => new Date().toISOString()

export class Workflow extends Service {
  static inject = ['store', 'artifacts', 'eventLog', 'leases', 'egress', 'workers']

  static Config: z<Config> = z.object({
    templates: z.dict(z.array(z.object({
      nodeId: z.string().required(),
      objective: z.string().required(),
      dependsOn: z.array(z.string()),
      prompt: z.string().required(),
      capabilities: z.array(z.string()).required(),
      tier: z.union(['economy', 'standard', 'frontier']).required(),
      callerTier: z.boolean(),
      conversation: z.union(['temporary', 'persistent', 'caller']).required(),
      acceptance: z.string().required(),
    }))).default({}).description('Workflow templates by name, added to the built-in ask and research'),
    maxAttempts: z.natural().min(1).max(10).default(3).description('Attempts per node for retryable failures'),
    retryDelayMs: z.natural().default(5000).description('First back-off delay, doubled per attempt'),
    maxActiveRuns: z.natural().min(1).default(16).description('Unfinished runs accepted at once'),
    retainDays: z.natural().min(1).default(30).description('Days a finished run keeps its input text and prompts'),
  }) as unknown as z<Config>

  private readonly schemas = new SchemaRegistry()
  private readonly templates: Record<string, NodeTemplate[]>
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly retries = new Set<NodeJS.Timeout>()
  private readonly stopped = new AbortController()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'workflow')
    this.templates = { ...DEFAULT_TEMPLATES, ...config.templates }
    // Fail at load, not at the first call: every template must pass preflight.
    for (const [name, nodes] of Object.entries(this.templates)) resolve(name, nodes, {})
    ctx.store.migrate('workflow', [{
      version: 1,
      sql: `CREATE TABLE workflow_runs (
        run_id TEXT PRIMARY KEY, request_key TEXT UNIQUE, template TEXT NOT NULL, spec_hash TEXT NOT NULL, input TEXT NOT NULL,
        classification TEXT, session_id TEXT, status TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX workflow_runs_status ON workflow_runs (status);
      CREATE TABLE workflow_nodes (
        run_id TEXT NOT NULL, node_id TEXT NOT NULL, ordinal INTEGER NOT NULL, spec TEXT NOT NULL, record TEXT NOT NULL, state TEXT NOT NULL,
        prompt TEXT, turn_id TEXT, attempt INTEGER NOT NULL DEFAULT 0, not_before TEXT, worker TEXT, served_tier TEXT, quota_class TEXT,
        error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (run_id, node_id)
      );`,
    }, {
      // Runs outlive turns (retention): a node keeps its turn's decision ids for explain.
      version: 2,
      sql: 'ALTER TABLE workflow_nodes ADD COLUMN decisions TEXT;',
    }, {
      // Nodes run on any Worker source, not only website turns.
      version: 3,
      sql: `ALTER TABLE workflow_nodes RENAME COLUMN turn_id TO execution_id;
      ALTER TABLE workflow_nodes ADD COLUMN source TEXT;
      UPDATE workflow_nodes SET source = 'website' WHERE execution_id IS NOT NULL;`,
    }])
    ctx.effect(() => {
      queueMicrotask(() => {
        this.purge()
        this.recover()
      })
      const daily = setInterval(() => this.purge(), 24 * 60 * 60_000)
      daily.unref()
      return async () => {
        // A stop is not a failure: runs stay as they are and resume on the next start.
        this.stopped.abort()
        clearInterval(daily)
        for (const timer of this.retries) clearTimeout(timer)
        await Promise.allSettled(this.running.values())
        for (const set of this.waiters.values()) for (const wake of set) wake()
        this.waiters.clear()
      }
    })
    ctx.inject(['mcp'], (c) => this.registerTools(c))
  }

  /** Admit a run: validated, hashed, and durable at once; it runs in the background. */
  start(input: StartInput): RunView {
    const nodes = this.templates[input.template]
    if (!nodes) throw new WorkflowFailure('invalid_input', `unknown workflow template ${input.template}`)
    if (!input.input.trim()) throw new WorkflowFailure('invalid_input', 'the input must not be empty')
    const requestKey = input.clientRequestId ? sha256(`workflow\0${input.clientRequestId}`) : null
    const spec = resolve(input.template, nodes, input)
    // Contracts can come from other plugins, so they are checked per run, before anything is sent.
    const known = new Set(this.ctx.workers.contracts())
    for (const node of spec.nodes) {
      if (!known.has(node.acceptance)) throw new WorkflowFailure('config_error', `template ${input.template}, node ${node.nodeId}: unknown acceptance contract ${node.acceptance}`)
    }
    const view = this.ctx.store.transaction((db) => {
      if (requestKey) {
        const existing = db.prepare('SELECT * FROM workflow_runs WHERE request_key = ?').get(requestKey) as RunRow | undefined
        if (existing) {
          if (existing.input !== input.input || existing.spec_hash !== spec.specHash) throw new WorkflowFailure('invalid_input', 'clientRequestId was reused with a different request')
          return this.view(existing)
        }
      }
      const active = (db.prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'running'").get() as { n: number }).n
      const limit = this.config.maxActiveRuns ?? 16
      if (active >= limit) throw new WorkflowFailure('overloaded', `${active} runs are already active (limit ${limit}); retry later`)
      // One persistent session per run, opened now so its id is returned at once (REQ-SES-8).
      // Sessions are the engine's: one per run, issued now so its id is returned at once (REQ-SES-8).
      if (input.sessionId && !db.prepare('SELECT 1 FROM workflow_runs WHERE session_id = ?').get(input.sessionId)) {
        throw new WorkflowFailure('invalid_input', `unknown session ${input.sessionId}`)
      }
      const sessionId = input.sessionId ?? (spec.nodes.some((n) => n.session.persist) ? newId('ses') : undefined)
      const run: RunRow = {
        run_id: newId('run'), request_key: requestKey, template: input.template, spec_hash: spec.specHash, input: input.input,
        classification: input.classification ?? null, session_id: sessionId ?? null, status: 'running', result: null, error: null, created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO workflow_runs (run_id, request_key, template, spec_hash, input, classification, session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`).run(run.run_id, requestKey, run.template, run.spec_hash, run.input, run.classification, run.session_id, run.created_at, run.updated_at)
      spec.nodes.forEach((node, ordinal) => {
        const resolved: ResolvedNode = { ...node, session: node.session.persist ? { sessionId: sessionId! } : node.session }
        const record: NodeRecord = {
          schema: 'workflow-node@1.0', runId: run.run_id, nodeId: node.nodeId, objective: node.objective, executor: 'worker',
          requirement: this.requirementOf(node, resolved.session.sessionId !== undefined, input.classification),
          dependsOn: node.dependsOn, state: 'WAITING', revision: 0,
        }
        this.schemas.assertRecord(record)
        db.prepare(`INSERT INTO workflow_nodes (run_id, node_id, ordinal, spec, record, state, updated_at) VALUES (?, ?, ?, ?, ?, 'WAITING', ?)`)
          .run(run.run_id, node.nodeId, ordinal, JSON.stringify(resolved), JSON.stringify(record), now())
      })
      this.ctx.eventLog.append({ type: 'workflow.run.started', runId: run.run_id, ...(sessionId ? { sessionId } : {}), data: { template: input.template, specHash: spec.specHash } })
      this.ctx.store.afterCommit(() => this.schedule(run.run_id))
      return this.view(run)
    })
    return view
  }

  get(runId: string): RunView | undefined {
    const run = this.runRow(runId)
    return run ? this.view(run) : undefined
  }

  /** The durable node records of a run, in dependency order. */
  records(runId: string): NodeRecord[] {
    return this.nodeRows(runId).map((n) => JSON.parse(n.record) as NodeRecord)
  }

  /** Wait until the run finishes or `timeoutMs` passes; returns the current view either way. */
  async wait(runId: string, timeoutMs: number): Promise<RunView> {
    const current = this.get(runId)
    if (!current) throw new WorkflowFailure('invalid_input', `unknown run ${runId}`)
    if (current.status !== 'running' || this.stopped.signal.aborted) return current
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
    return this.get(runId)!
  }

  /** Recent runs and, per node, which Worker, tier, and quota class served it (usage report). */
  usage(limit = 50): RunView[] {
    const rows = this.ctx.store.db.prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(1, limit), 500)) as unknown as RunRow[]
    return rows.map((r) => this.view(r))
  }

  /** The decision chain of a run, per node: egress, tier, route (or admission), acceptance (REQ-ART-3). */
  explain(runId: string): Explanation | undefined {
    const run = this.runRow(runId)
    if (!run) return undefined
    return {
      runId, template: run.template, status: run.status, specHash: run.spec_hash as ContentId,
      nodes: this.nodeRows(runId).map((node) => {
        const record = JSON.parse(node.record) as NodeRecord
        const kept = node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : []
        const last = record.outputReceipt?.acceptance ?? record.lastDecision
        const ids = [...kept, ...(last && !kept.includes(last) ? [last] : [])]
        return {
          nodeId: node.node_id, state: node.state,
          ...(node.execution_id ? { executionId: node.execution_id } : {}), ...(node.worker ? { worker: node.worker } : {}), ...(node.quota_class ? { quotaClass: node.quota_class } : {}),
          decisions: ids.filter((id): id is ArtifactRef => !!id).map((id) => this.decision(id)).filter((d): d is ExplainedDecision => !!d),
        }
      }),
    }
  }

  /**
   * A node's work requirement (`work-requirement@1.0`): its declared capabilities, plus
   * `persistent-conversation` when it runs in a session; the run's data classification; its
   * tier and where that came from; its acceptance contract.
   */
  private requirementOf(node: ResolvedNode, persistent: boolean, classification: Classification | undefined): WorkRequirement {
    return {
      schema: 'work-requirement@1.0',
      objective: node.objective,
      capabilities: [...new Set([...node.capabilities, ...(persistent ? ['persistent-conversation'] : [])])],
      data: { classification: classification ?? this.ctx.egress.defaultClassification, refs: [] },
      egressPolicy: 'egress.classification-and-secrets',
      tier: { min: node.tier, source: node.tierSource },
      acceptance: { contract: node.acceptance },
    }
  }

  private decision(id: ArtifactRef): ExplainedDecision | undefined {
    const body = this.ctx.artifacts.get(id)?.body as Decision | undefined
    if (!body) return undefined
    return { id, type: body.decisionType, outcome: body.outcome.option, reasons: body.candidates.find((c) => c.selected)?.reasons ?? [] }
  }

  private recover(): void {
    if (this.stopped.signal.aborted) return
    const rows = this.ctx.store.db.prepare("SELECT run_id FROM workflow_runs WHERE status = 'running' ORDER BY created_at").all() as Array<{ run_id: string }>
    for (const { run_id } of rows) this.schedule(run_id)
  }

  /**
   * Runs are deleted only by the operator (docs/design/workflow-engine.md#retention); what
   * expires is the private text: a finished run's input and its rendered prompts.
   */
  private purge(): void {
    if (this.stopped.signal.aborted) return
    const cutoff = new Date(Date.now() - (this.config.retainDays ?? 30) * 24 * 60 * 60_000).toISOString()
    this.ctx.store.transaction((db) => {
      db.prepare("UPDATE workflow_nodes SET prompt = NULL WHERE prompt IS NOT NULL AND run_id IN (SELECT run_id FROM workflow_runs WHERE status != 'running' AND updated_at < ?)").run(cutoff)
      db.prepare("UPDATE workflow_runs SET input = '' WHERE input != '' AND status != 'running' AND updated_at < ?").run(cutoff)
    })
  }

  /** At most one advance per run in this process; another process is fenced by the run lease. */
  private schedule(runId: string): void {
    if (this.stopped.signal.aborted || this.running.has(runId)) return
    // advance handles its own failures; a store closing under it must not crash the process.
    const advancing = this.advance(runId).catch(() => undefined).finally(() => this.running.delete(runId))
    this.running.set(runId, advancing)
  }

  private retryLater(runId: string, delayMs: number): void {
    if (this.stopped.signal.aborted) return
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      this.schedule(runId)
    }, delayMs)
    timer.unref()
    this.retries.add(timer)
  }

  private async advance(runId: string): Promise<void> {
    const resource = `run:${runId}`
    let lease = this.ctx.leases.acquire(resource, LEASE_TTL_MS)
    if (!lease) {
      const holder = this.ctx.leases.current(resource)
      this.retryLater(runId, Math.max(1000, (holder?.expiresAt ?? Date.now()) - Date.now() + 1000))
      return
    }
    const lost = new AbortController()
    const signal = AbortSignal.any([lost.signal, this.stopped.signal])
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
      for (;;) {
        if (signal.aborted) return
        const run = this.runRow(runId)
        if (!run || run.status !== 'running') return
        const nodes = this.nodeRows(runId)
        const failed = nodes.find((n) => n.state === 'FAILED')
        if (failed) return this.finish(run, 'failed', { error: failed.error }, current)
        if (nodes.every((n) => n.state === 'COMPLETED')) {
          const final = nodes[nodes.length - 1]!
          return this.finish(run, 'completed', { result: (JSON.parse(final.record) as NodeRecord).outputReceipt!.result }, current)
        }
        for (const node of nodes) {
          if (node.state === 'WAITING' && node.dependsOnCompleted(nodes)) this.promote(run, node, nodes, current)
        }
        const active = this.nodeRows(runId).filter((n) => n.state === 'READY' || n.state === 'RUNNING')
        if (!active.length) {
          return this.finish(run, 'failed', { error: JSON.stringify({ kind: 'internal', disposition: 'CODE_FIX', message: 'no node can run' }) }, current)
        }
        await Promise.all(active.map((node) => this.execute(run, node, current, signal)))
      }
    } catch (error) {
      if (this.stopped.signal.aborted) return
      if (lost.signal.aborted || error instanceof LeaseLost || error instanceof StaleGeneration) {
        // Ownership was lost (a host that slept past the lease, or a takeover): look again
        // once the lease can be taken, so the run is never stranded until the next start.
        this.retryLater(runId, 1000)
        return
      }
      // A scheduler exception blocks the run for a code fix; it never crash-loops.
      const run = this.runRow(runId)
      if (run?.status === 'running') this.finish(run, 'failed', { error: JSON.stringify({ kind: 'internal', disposition: 'CODE_FIX', message: (error as Error).message }) }, current)
    } finally {
      clearInterval(heartbeat)
      try {
        this.ctx.leases.release(current())
      } catch {
        // the store may already be closing; an unreleased lease simply expires
      }
    }
  }

  /** WAITING → READY: render the input from the dependencies' results and bind it by hash. */
  private promote(run: RunRow, node: NodeRow & NodeHelpers, nodes: NodeRow[], lease: () => Lease): void {
    const spec = JSON.parse(node.spec) as ResolvedNode
    const deps = spec.dependsOn.map((id) => nodes.find((n) => n.node_id === id)!)
    const results = deps.map((d) => (JSON.parse(d.record) as NodeRecord).outputReceipt!.result)
    const texts = Object.fromEntries(deps.map((d, i) => [d.node_id, this.resultText(results[i]!)]))
    const prompt = render(spec.prompt, run.input, texts)
    const inputHash = sha256(canonicalJson({ node: spec, prompt, dependencies: results }))
    this.writeNode(node, { state: 'READY', prompt }, (record) => ({ ...record, inputReceipt: { inputHash, bundle: results } }), lease)
  }

  /**
   * Run one node to a terminal state, or until the engine stops: route it by its requirement
   * (`ctx.workers`), start it on the admitted Worker's own runtime, then wait and accept.
   */
  private async execute(run: RunRow, initial: NodeRow, lease: () => Lease, signal: AbortSignal): Promise<void> {
    let node = initial
    const spec = JSON.parse(node.spec) as ResolvedNode
    if (!node.execution_id) {
      const delay = node.not_before ? Date.parse(node.not_before) - Date.now() : 0
      if (delay > 0 && !(await sleep(delay, signal))) return
      const record = JSON.parse(node.record) as NodeRecord
      const attempt = node.attempt + 1
      const affinity = spec.session.sessionId ? this.ctx.workers.affinity(spec.session.sessionId) : undefined
      let admitted: AdmittedWorker
      try {
        admitted = await this.ctx.workers.route(record.requirement, {
          producer: 'workflow',
          ...(affinity ? { restrict: { workers: affinity, reason: `session ${spec.session.sessionId} stays on its Worker` } } : {}),
        })
      } catch (error) {
        if (!(error instanceof AdmissionFailure)) throw error
        const hint = error.rejections.length ? '' : ': no Worker is configured (for website Workers, map tiers to modes in the account catalog, then sign the account in)'
        return this.failAttempt(run, { ...node, attempt }, { kind: admissionKind(error), disposition: dispositionOf(admissionKind(error)), message: `${error.message}${hint}` },
          { sent: false, decisions: [error.decision] }, lease)
      }
      // A stop while routing starts nothing: the node is routed again on the next start.
      if (signal.aborted) return
      const source = this.ctx.workers.source(admitted.source)
      if (!source) throw new Error(`Worker source ${admitted.source} is gone`)
      const routed = {
        worker: admitted.worker.worker, source: admitted.source, served_tier: admitted.worker.tier, quota_class: admitted.worker.quotaClass,
        decisions: JSON.stringify([admitted.decisions.tier, admitted.decisions.route]),
      }
      try {
        this.ctx.store.transaction(() => {
          const started = source.start({
            key: `workflow:${run.run_id}:${node.node_id}:${attempt}:${record.inputReceipt!.inputHash}`,
            worker: admitted.worker.worker, prompt: node.prompt!, sessionId: spec.session.sessionId,
            requirement: record.requirement, decisions: admitted.decisions,
          })
          this.writeNode(node, { state: 'RUNNING', execution_id: started.id, attempt, not_before: null, ...routed }, (r) => ({
            ...r, execution: { executionId: started.id, attempt, owner: admitted.source, generation: lease().generation, route: admitted.decisions.route }, lastDecision: admitted.decisions.route,
          }), lease)
          this.ctx.eventLog.append({
            type: 'workflow.node.started', runId: run.run_id, nodeId: node.node_id, decision: admitted.decisions.route,
            data: { executionId: started.id, source: admitted.source, worker: admitted.worker.worker, minTier: spec.tier, attempt },
          })
        })
      } catch (error) {
        if (error instanceof LeaseLost || error instanceof StaleGeneration) throw error
        return this.failAttempt(run, { ...node, attempt }, errorOf(error), { sent: false, decisions: [admitted.decisions.tier, admitted.decisions.route] }, lease)
      }
      node = this.nodeRow(run.run_id, node.node_id)!
    }
    const source = node.source ? this.ctx.workers.source(node.source) : undefined
    if (!source) {
      // The Worker's runtime is not loaded now; look again later instead of guessing.
      throw new Error(`Worker source ${node.source ?? '(none)'} of node ${node.node_id} is not registered`)
    }
    let current = source.get(node.execution_id!)
    const stop = aborted(signal)
    while (current && (current.status === 'queued' || current.status === 'running')) {
      if (signal.aborted) return
      const waited = Date.now()
      await Promise.race([source.wait(current.id, 30_000), stop])
      if (signal.aborted) return
      // A runtime that is stopping returns at once; never spin on it.
      if (Date.now() - waited < 50 && !(await sleep(1000, signal))) return
      current = source.get(current.id)
    }
    if (!current) return this.failAttempt(run, node, { kind: 'internal', disposition: 'CODE_FIX', message: `execution ${node.execution_id} is gone` }, { sent: true }, lease)
    if (current.status === 'failed') {
      return this.failAttempt(run, node, current.error ?? { kind: 'internal', disposition: 'CODE_FIX', message: 'the execution failed without an error' }, { sent: current.submitted, execution: current }, lease)
    }
    this.complete(run, node, spec, current, lease)
  }

  /** A finished execution: check its result against the node's contract, then commit the output receipt. */
  private complete(run: RunRow, node: NodeRow, spec: ResolvedNode, execution: WorkerExecution, lease: () => Lease): void {
    const result = execution.result as ArtifactRef
    const acceptance = this.ctx.workers.accept(result, spec.acceptance, { producer: 'workflow', runId: run.run_id, nodeId: node.node_id })
    const decisions = { decisions: JSON.stringify([...execution.decisions, ...this.routedDecisions(node)]) }
    const data = { executionId: execution.id, source: node.source, worker: node.worker, tier: node.served_tier, quotaClass: node.quota_class, accepted: acceptance.accepted }
    this.ctx.store.transaction(() => {
      if (acceptance.accepted) {
        this.writeNode(node, { state: 'COMPLETED', error: null, ...decisions }, (r) => ({ ...r, outputReceipt: { result, acceptance: acceptance.decision }, lastDecision: acceptance.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.completed', runId: run.run_id, nodeId: node.node_id, decision: acceptance.decision, data })
      } else {
        const error: WorkflowError = { kind: 'acceptance_rejected', disposition: 'NONE', message: `${spec.acceptance}: ${acceptance.reasons.join('; ')}` }
        this.writeNode(node, { state: 'FAILED', error: JSON.stringify(error), ...decisions }, (r) => ({ ...r, lastDecision: acceptance.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: acceptance.decision, data: { ...data, kind: error.kind } })
      }
    })
  }

  /** The tier and route decisions recorded when the node's current attempt was routed. */
  private routedDecisions(node: NodeRow): ArtifactRef[] {
    const stored = node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : []
    return stored.slice(-2)
  }

  /**
   * Retry or fail a node after a failed attempt (REQ-WF-6), recorded as a `recovery`
   * decision (INV-13). A retry needs a retryable disposition, attempts left, and a prompt
   * that never reached the provider: once sent, only the turn runtime may resubmit, within
   * its own bound, so the engine never causes a duplicate provider turn (INV-4).
   */
  private failAttempt(run: RunRow, node: NodeRow, error: WorkflowError, attempt: { sent: boolean; execution?: WorkerExecution; decisions?: ArtifactRef[] }, lease: () => Lease): void {
    const max = this.config.maxAttempts ?? 3
    const reasons = {
      retry: [] as string[],
      fail: [] as string[],
    }
    if (!RETRYABLE.has(error.disposition)) reasons.fail.push(`${error.kind} is ${error.disposition}, not retryable`)
    else if (attempt.sent) reasons.fail.push(`${error.kind} came after the prompt was sent; resending could duplicate the provider turn`)
    else if (node.attempt >= max) reasons.fail.push(`attempt ${node.attempt} of ${max} failed`)
    else reasons.retry.push(`${error.kind} is ${error.disposition}, the prompt was never sent, and attempt ${node.attempt} of ${max} failed`)
    const retry = reasons.retry.length > 0
    const kept = attempt.decisions ?? (attempt.execution ? [...attempt.execution.decisions, ...this.routedDecisions(node)] : node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : [])
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'recovery',
      question: `How does node ${node.node_id} of run ${run.run_id} recover from ${error.kind}?`,
      inputs: kept,
      candidates: [{ option: 'retry', selected: retry, reasons: reasons.retry }, { option: 'fail', selected: !retry, reasons: reasons.fail }],
      decider: { type: 'rule', id: 'workflow.recovery', version: '1' },
      outcome: { option: retry ? 'retry' : 'fail', detail: { kind: error.kind, disposition: error.disposition, attempt: node.attempt } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
    const decisions = kept.length ? { decisions: JSON.stringify(kept) } : {}
    if (retry) {
      const delay = error.disposition === 'IMMEDIATE' ? 0 : (this.config.retryDelayMs ?? 5000) * 2 ** Math.max(0, node.attempt - 1)
      this.ctx.store.transaction(() => {
        this.writeNode(node, { state: 'READY', execution_id: null, attempt: node.attempt, not_before: new Date(Date.now() + delay).toISOString(), error: JSON.stringify(error), ...decisions },
          (r) => {
            // The next attempt gets its own execution; the failed one no longer explains the node.
            const next: NodeRecord = { ...r, lastDecision: decision.id as ArtifactRef }
            delete next.execution
            return next
          }, lease)
        this.ctx.eventLog.append({ type: 'workflow.node.retry', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { attempt: node.attempt, kind: error.kind, disposition: error.disposition, delayMs: delay } })
      })
      return
    }
    // Sent and failed: nothing more is automatic; the operator decides (USER_ACTION).
    const final: WorkflowError = attempt.sent && RETRYABLE.has(error.disposition)
      ? { ...error, disposition: 'USER_ACTION', message: `${error.message} (the prompt was sent, so it is not resent automatically)` }
      : error
    this.ctx.store.transaction(() => {
      this.writeNode(node, { state: 'FAILED', attempt: node.attempt, error: JSON.stringify(final), ...decisions }, (r) => ({ ...r, lastDecision: decision.id as ArtifactRef }), lease)
      this.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { attempt: node.attempt, kind: final.kind, disposition: final.disposition } })
    })
  }

  private finish(run: RunRow, status: 'completed' | 'failed', fields: { result?: string | null; error?: string | null }, lease?: () => Lease): void {
    this.ctx.store.transaction((db) => {
      if (lease) this.ctx.leases.fence(lease())
      db.prepare('UPDATE workflow_runs SET status = ?, result = ?, error = ?, updated_at = ? WHERE run_id = ?').run(status, fields.result ?? null, fields.error ?? null, now(), run.run_id)
      this.ctx.eventLog.append({ type: `workflow.run.${status}`, runId: run.run_id, data: { template: run.template } })
    })
    this.ctx.store.afterCommit(() => {
      for (const wake of this.waiters.get(run.run_id) ?? []) wake()
      this.waiters.delete(run.run_id)
    })
  }

  /** Write a node's columns and its record together, fenced by the run lease; the record is validated first. */
  private writeNode(node: NodeRow, fields: Partial<Omit<NodeRow, 'run_id' | 'node_id' | 'record'>>, change: (record: NodeRecord) => NodeRecord, lease: () => Lease): void {
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      const stored = this.nodeRow(node.run_id, node.node_id)!
      const previous = JSON.parse(stored.record) as NodeRecord
      const record: NodeRecord = { ...change(previous), state: fields.state ?? stored.state, revision: previous.revision + 1 }
      this.schemas.assertRecord(record)
      const entries = Object.entries({ ...fields, record: JSON.stringify(record), updated_at: now() })
      db.prepare(`UPDATE workflow_nodes SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE run_id = ? AND node_id = ?`)
        .run(...entries.map(([, v]) => v as string | number | null), node.run_id, node.node_id)
    })
  }

  private resultText(result: ArtifactRef): string {
    const text = (this.ctx.artifacts.get(result)?.body as { text?: unknown } | undefined)?.text
    return typeof text === 'string' ? text : ''
  }

  private runRow(runId: string): RunRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM workflow_runs WHERE run_id = ?').get(runId) as RunRow | undefined
  }

  private nodeRow(runId: string, nodeId: string): NodeRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM workflow_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as NodeRow | undefined
  }

  private nodeRows(runId: string): Array<NodeRow & NodeHelpers> {
    const rows = this.ctx.store.db.prepare('SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY ordinal').all(runId) as unknown as NodeRow[]
    return rows.map((row) => ({
      ...row,
      dependsOnCompleted: (all: NodeRow[]) => (JSON.parse(row.spec) as ResolvedNode).dependsOn.every((id) => all.find((n) => n.node_id === id)?.state === 'COMPLETED'),
    }))
  }

  private view(run: RunRow): RunView {
    const nodes = this.nodeRows(run.run_id).map((n): NodeView => {
      const spec = JSON.parse(n.spec) as ResolvedNode
      const record = JSON.parse(n.record) as NodeRecord
      return {
        nodeId: n.node_id, state: n.state, minTier: spec.tier, attempt: n.attempt,
        ...(n.execution_id ? { executionId: n.execution_id } : {}), ...(n.source ? { source: n.source } : {}), ...(n.worker ? { worker: n.worker } : {}),
        ...(n.served_tier ? { tier: n.served_tier } : {}), ...(n.quota_class ? { quotaClass: n.quota_class } : {}),
        ...(record.outputReceipt ? { result: record.outputReceipt.result } : {}),
        ...(n.error && n.state !== 'COMPLETED' ? { error: JSON.parse(n.error) as WorkflowError } : {}),
      }
    })
    return {
      runId: run.run_id, template: run.template, status: run.status, specHash: run.spec_hash as ContentId,
      ...(run.session_id ? { sessionId: run.session_id } : {}),
      ...(run.result ? { result: run.result as ArtifactRef, answer: this.resultText(run.result as ArtifactRef) } : {}),
      nodes,
      ...(run.error ? { error: JSON.parse(run.error) as WorkflowError } : {}),
      createdAt: run.created_at, updatedAt: run.updated_at,
    }
  }

  private registerTools(c: Context): void {
    const shape = (view: RunView) => ({ content: [{ type: 'text' as const, text: view.status === 'completed' ? view.answer ?? '' : JSON.stringify(view) }], structuredContent: { ...view } })
    const json = (value: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { ...value } })
    const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] })
    const waitSeconds = zod.number().int().min(0).max(55).optional().describe('How long to wait for the run to finish before returning (default 45 s)')
    const classification = zod.enum(['public', 'operator-shared', 'local-private']).optional()
      .describe('Data classification of the input; local-private content never leaves the machine (INV-12)')
    const clientRequestId = zod.string().max(200).optional().describe('Retry-safe request key')
    c.mcp.tool('ask', {
      description: 'Ask a website Worker (separate chat quota). Waits up to waitSeconds; otherwise returns a runId for `result`.',
      inputSchema: {
        prompt: zod.string().min(1).max(32_000),
        sessionId: zod.string().max(200).optional().describe('Continue an existing persistent session'),
        persist: zod.boolean().optional().describe('Start a persistent session (a normal conversation)'),
        tier: zod.enum(['economy', 'standard', 'frontier']).optional().describe('Minimum intelligence tier; the lowest admitted tier at or above it runs'),
        classification, clientRequestId, waitSeconds,
      },
    }, async (args) => {
      try {
        const run = this.start({
          template: 'ask', input: String(args.prompt), sessionId: args.sessionId as string | undefined, persist: args.persist as boolean | undefined,
          tier: args.tier as Tier | undefined, classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
        })
        return shape(await this.wait(run.runId, ((args.waitSeconds as number | undefined) ?? 45) * 1000))
      } catch (error) {
        return failure(error)
      }
    })
    c.mcp.tool('research', {
      description: 'Deep research, then a cited compaction on a cheap tier. Returns at once with a runId and sessionId; poll `result` (runs take minutes to tens of minutes).',
      inputSchema: {
        question: zod.string().min(1).max(32_000),
        sessionId: zod.string().max(200).optional().describe('Research in an existing persistent session'),
        classification, clientRequestId,
      },
    }, async (args) => {
      try {
        return shape(this.start({
          template: 'research', input: String(args.question), sessionId: args.sessionId as string | undefined,
          classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
        }))
      } catch (error) {
        return failure(error)
      }
    })
    c.mcp.tool('run', {
      description: `Start any workflow template (${Object.keys(this.templates).sort().join(', ')}); its steps are routed by capability to website or local agent Workers. Waits up to waitSeconds; otherwise returns a runId for \`result\`.`,
      inputSchema: {
        template: zod.string().max(100),
        input: zod.string().min(1).max(32_000),
        sessionId: zod.string().max(200).optional().describe('Continue an existing session'),
        persist: zod.boolean().optional().describe('Start a persistent session'),
        tier: zod.enum(['economy', 'standard', 'frontier']).optional().describe('Minimum tier for the steps that take the caller\'s tier'),
        classification, clientRequestId, waitSeconds,
      },
    }, async (args) => {
      try {
        const run = this.start({
          template: String(args.template), input: String(args.input), sessionId: args.sessionId as string | undefined, persist: args.persist as boolean | undefined,
          tier: args.tier as Tier | undefined, classification: args.classification as Classification | undefined, clientRequestId: args.clientRequestId as string | undefined,
        })
        return shape(await this.wait(run.runId, ((args.waitSeconds as number | undefined) ?? 45) * 1000))
      } catch (error) {
        return failure(error)
      }
    })
    c.mcp.tool('result', {
      description: 'Fetch a run started by `ask` or `research`; waits up to waitSeconds for it to finish.',
      inputSchema: { runId: zod.string().max(200), waitSeconds },
    }, async (args) => {
      try {
        return shape(await this.wait(String(args.runId), ((args.waitSeconds as number | undefined) ?? 45) * 1000))
      } catch (error) {
        return failure(error)
      }
    })
    c.mcp.tool('usage', {
      description: 'Recent runs and, per step, which Worker, tier, and quota class served it.',
      inputSchema: { limit: zod.number().int().min(1).max(500).optional() },
    }, async (args) => json({ runs: this.usage((args.limit as number | undefined) ?? 50) }))
    c.mcp.tool('explain', {
      description: 'The decision chain behind a run (egress, tier, route, acceptance per step), or the inputs of any artifact id.',
      inputSchema: { id: zod.string().max(200) },
    }, async (args) => {
      const id = String(args.id)
      const explained = this.explain(id) ?? this.ctx.artifacts.explain(id)
      return explained ? json(explained) : failure(new Error(`nothing is known about ${id}`))
    })
  }
}

interface NodeHelpers {
  dependsOnCompleted: (all: NodeRow[]) => boolean
}

/**
 * How a refused admission is handled: by the state that kept an otherwise fitting Worker
 * out. With no Worker at all, the operator still has to add and sign in an account.
 */
function admissionKind(failure: AdmissionFailure): ProviderErrorKind {
  if (failure.rejections.length === 0) return 'reauth_required'
  const onlyState = failure.rejections.filter((r) => r.failed.every((f) => f.check === 'state'))
  if (onlyState.some((r) => r.state === 'reauth-required' || r.state === 'unavailable')) return 'reauth_required'
  if (onlyState.some((r) => r.state === 'quota-exhausted')) return 'quota_exhausted'
  if (onlyState.length) return 'overloaded'
  if (failure.rejections.some((r) => r.failed.every((f) => f.check === 'locality'))) return 'egress_denied'
  return 'config_error'
}

/** A workflow-level refusal, typed like a turn failure. */
export class WorkflowFailure extends Error {
  readonly disposition: string
  constructor(readonly kind: 'invalid_input' | 'overloaded' | 'config_error', message: string) {
    super(message)
    this.name = 'WorkflowFailure'
    this.disposition = kind === 'overloaded' ? 'BACKOFF' : kind === 'config_error' ? 'CODE_FIX' : 'NONE'
  }
}


function errorOf(error: unknown): WorkflowError {
  const typed = error as { kind?: unknown; disposition?: unknown; message?: unknown }
  if (typeof typed?.kind === 'string' && typeof typed.disposition === 'string') {
    return { kind: typed.kind, disposition: typed.disposition, message: String(typed.message ?? '') }
  }
  return { kind: 'internal', disposition: 'CODE_FIX', message: error instanceof Error ? error.message : String(error) }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })))
}

/** Sleep unless aborted; true when the full delay passed. */
async function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve(true)
    }, ms)
    const stop = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

export default Workflow
