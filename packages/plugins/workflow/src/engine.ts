/**
 * The engine's state and its core loop: admission (`start`), one advance per run under the run
 * lease, and a node's path WAITING → READY → RUNNING → COMPLETED or FAILED. Each mechanism the
 * loop reaches (recovery, growth and gates, review, teams, sessions, operator actions, retention)
 * lives in its own module and works on this state. Internal to the package: `ctx.workflow` is the
 * {@link Workflow} facade in `index.ts`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { canonicalJson, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import { dispositionOf } from '@tsuuanmi/system-provider-core'
import { AdmissionFailure, type AdmittedWorker, type ArtifactRef, type Classification, type WorkRequirement, type WorkerExecution } from '@tsuuanmi/system-workers-core'
import { block, grow, grownText } from './growth.ts'
import { admissionKind, escalate, failAttempt, routedDecisions } from './recovery.ts'
import { remediate, reviewSubject, subjectGate } from './review.ts'
import { recoverWakes, settleWake } from './sessions.ts'
import { DEFAULT_TEMPLATES, type NodeTemplate, render, type ResolvedNode, resolve, schemaBlock } from './spec.ts'
import { carry, leadDecision, post, restriction, runtimeOf, teamGroup, teamTexts } from './teams.ts'
import { type Config, errorOf, LEASE_TTL_MS, newId, type NodeHelpers, type NodeRecord, type NodeRow, now, type RunRow, type RunView, type StartInput, type WorkflowError, WorkflowFailure } from './types.ts'
import { view } from './views.ts'

export class Engine {
  readonly schemas = new SchemaRegistry()
  readonly templates: Record<string, NodeTemplate[]>
  readonly waiters = new Map<string, Set<() => void>>()
  readonly running = new Map<string, Promise<void>>()
  private readonly rescheduled = new Set<string>()
  /** Operator stops of runs advancing in this process. */
  readonly runAborts = new Map<string, AbortController>()
  private readonly retries = new Set<NodeJS.Timeout>()
  readonly stopped = new AbortController()
  /** While draining (REQ-HOST-1), no new run is admitted; runs already admitted finish. */
  draining = false
  private readonly routing = new Map<string, Promise<void>>()

  constructor(readonly ctx: Context, readonly config: Config) {
    this.templates = { ...DEFAULT_TEMPLATES, ...config.templates }
    // Fail at load, not at the first call: every template must pass preflight.
    for (const [name, nodes] of Object.entries(this.templates)) this.check(name, nodes)
  }

  /** The engine stops: runs stay as they are and resume on the next start (a stop is not a failure). */
  async close(): Promise<void> {
    this.stopped.abort()
    for (const timer of this.retries) clearTimeout(timer)
    await Promise.allSettled(this.running.values())
    for (const set of this.waiters.values()) for (const wake of set) wake()
    this.waiters.clear()
  }

  /** On start: every running run is scheduled again, then unfinished wakes are settled (REQ-WF-4). */
  recover(): void {
    if (this.stopped.signal.aborted) return
    const rows = this.ctx.store.db.prepare("SELECT run_id FROM workflow_runs WHERE status = 'running' ORDER BY created_at").all() as Array<{ run_id: string }>
    for (const { run_id } of rows) this.schedule(run_id)
    recoverWakes(this)
  }

  /** Preflight, and every result schema a template names is one the registry holds. */
  check(name: string, nodes: NodeTemplate[]): void {
    resolve(name, nodes, {})
    for (const node of nodes) {
      if (node.resultSchema && !this.schemas.knows(node.resultSchema)) throw new TypeError(`template ${name}, node ${node.nodeId}: unknown result schema ${node.resultSchema}`)
    }
  }

  /** Admit a run: validated, hashed, and durable at once; it runs in the background. */
  start(input: StartInput): RunView {
    if (this.draining) throw new WorkflowFailure('overloaded', 'the host is draining for a stop or upgrade; retry after it restarts')
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
    const started = this.ctx.store.transaction((db) => {
      if (requestKey) {
        const existing = db.prepare('SELECT * FROM workflow_runs WHERE request_key = ?').get(requestKey) as RunRow | undefined
        if (existing) {
          if (existing.input !== input.input || existing.spec_hash !== spec.specHash) throw new WorkflowFailure('invalid_input', 'clientRequestId was reused with a different request')
          return view(this, existing)
        }
      }
      const active = (db.prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'running'").get() as { n: number }).n
      const limit = this.config.maxActiveRuns ?? 16
      if (active >= limit) throw new WorkflowFailure('overloaded', `${active} runs are already active (limit ${limit}); retry later`)
      // One persistent session per run, opened now so its id is returned at once (REQ-SES-8).
      // Sessions are the engine's: one per run, issued now so its id is returned at once (REQ-SES-8).
      // A run continues an engine session, or a Worker session (a team member's, woken by a message).
      if (input.sessionId && !db.prepare('SELECT 1 FROM workflow_runs WHERE session_id = ?').get(input.sessionId) && !this.ctx.workerSessions.session(input.sessionId)) {
        throw new WorkflowFailure('invalid_input', `unknown session ${input.sessionId}`)
      }
      const sessionId = input.sessionId ?? (spec.nodes.some((n) => n.session.persist) ? newId('ses') : undefined)
      const run: RunRow = {
        run_id: newId('run'), request_key: requestKey, template: input.template, spec_hash: spec.specHash, input: input.input,
        classification: input.classification ?? null, session_id: sessionId ?? null, status: 'running', result: null, error: null, created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO workflow_runs (run_id, request_key, template, spec_hash, input, classification, session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`).run(run.run_id, requestKey, run.template, run.spec_hash, run.input, run.classification, run.session_id, run.created_at, run.updated_at)
      // Each team member is one persistent session for the team's lifetime (Model A, REQ-TEAM-2).
      const memberSessions = new Map<string, string>()
      const sessionOf = (member: string): string => memberSessions.get(member) ?? memberSessions.set(member, newId('ses')).get(member)!
      spec.nodes.forEach((node, ordinal) => {
        const session = node.session.member ? { sessionId: sessionOf(node.session.member) } : node.session.persist ? { sessionId: sessionId! } : node.session
        const resolved: ResolvedNode = { ...node, session }
        const record: NodeRecord = {
          schema: 'workflow-node@1.0', runId: run.run_id, nodeId: node.nodeId, objective: node.objective, executor: 'worker',
          requirement: this.requirementOf(node, resolved.session.sessionId !== undefined, input.classification),
          dependsOn: node.dependsOn, state: 'WAITING', revision: 0,
        }
        this.schemas.assertRecord(record)
        db.prepare(`INSERT INTO workflow_nodes (run_id, node_id, ordinal, spec, record, state, updated_at) VALUES (?, ?, ?, ?, ?, 'WAITING', ?)`)
          .run(run.run_id, node.nodeId, ordinal, JSON.stringify(resolved), JSON.stringify(record), now())
      })
      // One message group per team; its first round runs behind a closed barrier (REQ-TEAM-1).
      for (const team of new Set(spec.nodes.flatMap((n) => (n.team ? [n.team.id] : [])))) {
        this.ctx.workerSessions.group(teamGroup(run.run_id, team), { barrier: true })
      }
      this.ctx.eventLog.append({ type: 'workflow.run.started', runId: run.run_id, ...(sessionId ? { sessionId } : {}), data: { template: input.template, specHash: spec.specHash } })
      this.ctx.store.afterCommit(() => this.schedule(run.run_id))
      return view(this, run)
    })
    return started
  }

  get(runId: string): RunView | undefined {
    const run = this.runRow(runId)
    return run ? view(this, run) : undefined
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

  /**
   * A node's work requirement (`work-requirement@1.0`): its declared capabilities, plus
   * `persistent-conversation` when it runs in a session; the run's data classification; its
   * tier and where that came from; its acceptance contract.
   */
  requirementOf(node: ResolvedNode, persistent: boolean, classification: Classification | undefined): WorkRequirement {
    return {
      schema: 'work-requirement@1.0',
      objective: node.objective,
      capabilities: [...new Set([...node.capabilities, ...(persistent ? ['persistent-conversation'] : [])])],
      data: { classification: classification ?? this.ctx.egress.defaultClassification, refs: [] },
      egressPolicy: 'egress.classification-and-secrets',
      tier: { min: node.tier, source: node.tierSource, ...(node.tierDecision ? { decision: node.tierDecision as ArtifactRef } : {}) },
      acceptance: { contract: node.acceptance, maxEscalations: node.maxEscalations ?? 1, ...(node.resultSchema ? { resultSchema: node.resultSchema } : {}) },
    }
  }

  /**
   * At most one advance per run in this process; another process is fenced by the run lease.
   * A request arriving while an advance is still unwinding (for example an operator's
   * `continue` right after the run failed) runs once that advance ends: it is never dropped.
   */
  schedule(runId: string): void {
    if (this.stopped.signal.aborted) return
    if (this.running.has(runId)) {
      this.rescheduled.add(runId)
      return
    }
    // advance handles its own failures; a store closing under it must not crash the process.
    const advancing = this.advance(runId).catch(() => undefined).finally(() => {
      this.running.delete(runId)
      if (this.rescheduled.delete(runId)) this.schedule(runId)
    })
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
    const outcome = await this.ctx.leases.hold(`run:${runId}`, LEASE_TTL_MS, async ({ lease: current, lost }) => {
      const operator = new AbortController()
      this.runAborts.set(runId, operator)
      const signal = AbortSignal.any([lost, this.stopped.signal, operator.signal])
      try {
        for (;;) {
          if (signal.aborted) return
          const run = this.runRow(runId)
          if (!run || run.status !== 'running') return
          // Retired nodes (a re-plan's history) never run and never decide the run's outcome.
          const nodes = this.nodeRows(runId).filter((n) => n.state !== 'RETIRED')
          const failed = nodes.find((n) => n.state === 'FAILED')
          if (failed) return this.finish(run, 'failed', { error: failed.error }, current)
          if (nodes.every((n) => n.state === 'COMPLETED')) {
            const final = nodes[nodes.length - 1]!
            return this.finish(run, 'completed', { result: (JSON.parse(final.record) as NodeRecord).outputReceipt!.result }, current)
          }
          for (const node of nodes) {
            if (node.state === 'WAITING' && node.dependsOnCompleted(nodes)) this.promote(run, node, nodes, current)
          }
          const current_ = this.nodeRows(runId).filter((n) => n.state !== 'RETIRED')
          if (current_.some((n) => n.state === 'FAILED')) continue
          // A carried node completed without running (a converged team): its dependents may be ready now.
          if (current_.filter((n) => n.state === 'COMPLETED').length > nodes.filter((n) => n.state === 'COMPLETED').length) continue
          const active = current_.filter((n) => n.state === 'READY' || n.state === 'RUNNING')
          if (!active.length) {
            // Waiting for the operator: park until `approve` schedules the run again.
            if (current_.some((n) => n.state === 'BLOCKED')) return
            return this.finish(run, 'failed', { error: JSON.stringify({ kind: 'internal', disposition: 'CODE_FIX', message: 'no node can run' }) }, current)
          }
          await Promise.all(active.map((node) => this.execute(run, node, current, signal)))
        }
      } catch (error) {
        if (this.stopped.signal.aborted || operator.signal.aborted) return
        if (lost.aborted || error instanceof LeaseLost || error instanceof StaleGeneration) {
          // Ownership was lost (a host that slept past the lease, or a takeover): look again
          // once the lease can be taken, so the run is never stranded until the next start.
          this.retryLater(runId, 1000)
          return
        }
        // A scheduler exception blocks the run for a code fix; it never crash-loops.
        const run = this.runRow(runId)
        if (run?.status === 'running') this.finish(run, 'failed', { error: JSON.stringify({ kind: 'internal', disposition: 'CODE_FIX', message: (error as Error).message }) }, current)
      } finally {
        if (this.runAborts.get(runId) === operator) this.runAborts.delete(runId)
      }
    })
    if (!outcome.held) this.retryLater(runId, outcome.retryInMs)
  }

  /** WAITING → READY: render the input from the dependencies' results and bind it by hash. */
  private promote(run: RunRow, node: NodeRow & NodeHelpers, nodes: NodeRow[], lease: () => Lease): void {
    const spec = JSON.parse(node.spec) as ResolvedNode
    if (spec.executor === 'gate') return block(this, run, node, spec, lease)
    if (carry(this, run, node, spec, nodes, lease)) return
    const deps = spec.dependsOn.map((id) => nodes.find((n) => n.node_id === id)!)
    const results = deps.map((d) => (JSON.parse(d.record) as NodeRecord).outputReceipt!.result)
    const texts = Object.fromEntries(deps.map((d, i) => [d.node_id, this.resultText(results[i]!)]))
    const extras = {
      ...(spec.prompt.includes('{{grown}}') ? { grown: grownText(this, spec, nodes) } : {}),
      ...(spec.team ? teamTexts(this, spec, nodes) : {}),
    }
    let prompt = spec.literal ? spec.prompt : render(spec.prompt, run.input, texts, extras)
    if (spec.resultSchema) prompt = `${prompt}\n\n${schemaBlock(spec.resultSchema, this.schemas.schemaOf(spec.resultSchema))}`
    // A review of an agent's change binds to the workspace's exact subject now (REQ-TEAM-5, REQ-WF-5).
    const bound = spec.capabilities.includes('review') ? reviewSubject(this, results, run.input) : undefined
    if (bound) prompt = `${prompt}\n\n${bound.block}`
    const inputHash = sha256(canonicalJson({ node: spec, prompt, dependencies: results }))
    this.writeNode(node, { state: 'READY', prompt, ...(bound ? { subject: JSON.stringify({ workspace: bound.workspace, subject: bound.subject }) } : {}) },
      (record) => ({ ...record, inputReceipt: { inputHash, bundle: results } }), lease)
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
      // Members of one team route one at a time, so each sees which accounts the others hold.
      const release = await this.routingTurn(run.run_id)
      let admitted: AdmittedWorker
      try {
        admitted = await this.ctx.workers.route(record.requirement, { producer: 'workflow', ...(await restriction(this, run, spec)) })
      } catch (error) {
        release()
        if (!(error instanceof AdmissionFailure)) throw error
        const hint = error.rejections.length ? '' : ': no Worker is configured (for website Workers, map tiers to modes in the account catalog, then sign the account in)'
        return failAttempt(this, run, { ...node, attempt }, { kind: admissionKind(error), disposition: dispositionOf(admissionKind(error)), message: `${error.message}${hint}` },
          { sent: false, decisions: [error.decision] }, lease)
      }
      // A stop while routing starts nothing: the node is routed again on the next start.
      if (signal.aborted) {
        release()
        return
      }
      const source = this.ctx.workers.source(admitted.source)
      if (!source) {
        release()
        throw new Error(`Worker source ${admitted.source} is gone`)
      }
      const routed = {
        worker: admitted.worker.worker, source: admitted.source, served_tier: admitted.worker.tier, quota_class: admitted.worker.quotaClass,
        decisions: JSON.stringify([admitted.decisions.tier, admitted.decisions.route]),
      }
      try {
        this.ctx.store.transaction(() => {
          if (spec.team?.role === 'member' && spec.session.sessionId) {
            // Model A: the member's session is bound to the Worker its first admission chose.
            this.ctx.workerSessions.join(teamGroup(run.run_id, spec.team.id), {
              sessionId: spec.session.sessionId, role: `m${spec.team.member}`, runtime: runtimeOf(admitted.source, admitted.worker.provider),
              worker: admitted.worker.worker, formation: admitted.decisions.route, runId: run.run_id, nodeId: spec.team.id,
            })
          }
          const started = source.start({
            key: `workflow:${run.run_id}:${node.node_id}:${attempt}:${node.escalations}:${record.inputReceipt!.inputHash}`,
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
        return failAttempt(this, run, { ...node, attempt }, errorOf(error), { sent: false, decisions: [admitted.decisions.tier, admitted.decisions.route] }, lease)
      } finally {
        release()
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
    if (!current) return failAttempt(this, run, node, { kind: 'internal', disposition: 'CODE_FIX', message: `execution ${node.execution_id} is gone` }, { sent: true }, lease)
    if (current.status === 'failed') {
      return failAttempt(this, run, node, current.error ?? { kind: 'internal', disposition: 'CODE_FIX', message: 'the execution failed without an error' }, { sent: current.submitted, execution: current }, lease)
    }
    if (!current.result) {
      return failAttempt(this, run, node, { kind: 'internal', disposition: 'CODE_FIX', message: `${node.source} reported execution ${current.id} completed without a result` }, { sent: true, execution: current }, lease)
    }
    this.complete(run, node, spec, current, lease)
  }

  /** Wait for this run's turn to route; the returned function ends it. */
  private async routingTurn(runId: string): Promise<() => void> {
    const previous = this.routing.get(runId) ?? Promise.resolve()
    let done!: () => void
    const turn = new Promise<void>((resolve) => (done = resolve))
    const chained = previous.then(() => turn)
    this.routing.set(runId, chained)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      done()
      if (this.routing.get(runId) === chained) this.routing.delete(runId)
    }
  }

  /** A finished execution: check its result against the node's contract, then commit the output receipt. */
  private complete(run: RunRow, node: NodeRow, spec: ResolvedNode, execution: WorkerExecution, lease: () => Lease): void {
    const result = execution.result as ArtifactRef
    const acceptance = this.ctx.workers.accept(result, spec.acceptance, { producer: 'workflow', runId: run.run_id, nodeId: node.node_id, ...(spec.resultSchema ? { resultSchema: spec.resultSchema } : {}) })
    const decisions = { decisions: JSON.stringify([...execution.decisions, ...routedDecisions(node)]) }
    const data = { executionId: execution.id, source: node.source, worker: node.worker, tier: node.served_tier, quotaClass: node.quota_class, accepted: acceptance.accepted }
    let gate: ReturnType<typeof subjectGate> | undefined
    this.ctx.store.transaction(() => {
      const refused = acceptance.accepted && spec.grows ? grow(this, run, node, spec, result, lease) : undefined
      if (refused) {
        const error: WorkflowError = { kind: 'plan_rejected', disposition: 'NONE', message: refused }
        this.writeNode(node, { state: 'FAILED', error: JSON.stringify(error), ...decisions }, (r) => ({ ...r, lastDecision: acceptance.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: acceptance.decision, data: { ...data, kind: error.kind } })
      } else if (acceptance.accepted && node.subject && !(gate = subjectGate(this, run, node, result)).passed) {
        const error: WorkflowError = { kind: 'stale_subject', disposition: 'NONE', message: `exact-subject gate: ${gate.reason}` }
        this.writeNode(node, { state: 'FAILED', error: JSON.stringify(error), ...decisions }, (r) => ({ ...r, lastDecision: gate!.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: gate.decision, data: { ...data, kind: error.kind } })
      } else if (acceptance.accepted) {
        if (spec.team?.role === 'member') post(this, run, node, spec, execution, result)
        if (gate?.passed) {
          decisions.decisions = JSON.stringify([...JSON.parse(decisions.decisions) as string[], gate.decision])
          remediate(this, run, node, spec, gate.assessment, gate.subject, lease)
        }
        const lead = spec.team?.role === 'lead' ? leadDecision(this, run, node, spec, result) : undefined
        if (lead) decisions.decisions = JSON.stringify([...JSON.parse(decisions.decisions) as string[], lead])
        this.writeNode(node, { state: 'COMPLETED', error: null, ...decisions }, (r) => ({ ...r, outputReceipt: { result, acceptance: acceptance.decision }, lastDecision: lead ?? acceptance.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.completed', runId: run.run_id, nodeId: node.node_id, decision: acceptance.decision, data })
      } else if (!escalate(this, run, node, spec, result, acceptance.decision, acceptance.reasons, decisions, lease)) {
        const error: WorkflowError = { kind: 'acceptance_rejected', disposition: 'NONE', message: `${spec.acceptance}: ${acceptance.reasons.join('; ')}` }
        this.writeNode(node, { state: 'FAILED', error: JSON.stringify(error), ...decisions }, (r) => ({ ...r, lastDecision: acceptance.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: acceptance.decision, data: { ...data, kind: error.kind } })
      }
    })
  }

  finish(run: RunRow, status: 'completed' | 'failed', fields: { result?: string | null; error?: string | null }, lease?: () => Lease): void {
    this.ctx.store.transaction((db) => {
      if (lease) this.ctx.leases.fence(lease())
      db.prepare('UPDATE workflow_runs SET status = ?, result = ?, error = ?, updated_at = ? WHERE run_id = ?').run(status, fields.result ?? null, fields.error ?? null, now(), run.run_id)
      // The team's rounds consumed its members' mail: what is left over must not wake them later.
      for (const member of this.ctx.workerSessions.ofRun(run.run_id)) {
        const left = this.ctx.workerSessions.inbox(member.sessionId)
        if (left.length) this.ctx.workerSessions.ack(member.sessionId, left.at(-1)!.seq)
      }
      this.ctx.eventLog.append({ type: `workflow.run.${status}`, runId: run.run_id, data: { template: run.template } })
    })
    this.ctx.store.afterCommit(() => {
      for (const wake of this.waiters.get(run.run_id) ?? []) wake()
      this.waiters.delete(run.run_id)
      settleWake(this, run.run_id)
    })
  }

  /** Write a node's columns and its record together, fenced by the run lease; the record is validated first. */
  writeNode(node: NodeRow, fields: Partial<Omit<NodeRow, 'run_id' | 'node_id' | 'record'>>, change: (record: NodeRecord) => NodeRecord, lease: () => Lease): void {
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

  resultText(result: ArtifactRef): string {
    const text = (this.ctx.artifacts.get(result)?.body as { text?: unknown } | undefined)?.text
    return typeof text === 'string' ? text : ''
  }

  runRow(runId: string): RunRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM workflow_runs WHERE run_id = ?').get(runId) as RunRow | undefined
  }

  nodeRow(runId: string, nodeId: string): NodeRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM workflow_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as NodeRow | undefined
  }

  nodeRows(runId: string): Array<NodeRow & NodeHelpers> {
    const rows = this.ctx.store.db.prepare('SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY ordinal').all(runId) as unknown as NodeRow[]
    return rows.map((row) => ({
      ...row,
      dependsOnCompleted: (all: NodeRow[]) => (JSON.parse(row.spec) as ResolvedNode).dependsOn.every((id) => all.find((n) => n.node_id === id)?.state === 'COMPLETED'),
    }))
  }
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
