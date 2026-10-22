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
import { AdmissionFailure, type AdmittedWorker, type ArtifactRef, type Classification, type RouteOptions, type WorkRequirement, type WorkerExecution } from '@tsuuanmi/system-workers-core'
import { block, expireGate, gateDeadline, grow, grownText } from './growth.ts'
import { admissionKind, escalate, failAttempt, inputHint, routedDecisions } from './recovery.ts'
import { remediate, reviewSubject, subjectGate } from './review.ts'
import { recoverWakes, settleWake } from './sessions.ts'
import { DEFAULT_TEMPLATES, type NodeTemplate, recordExecutor, render, type ResolvedNode, resolve, schemaBlock, variantProblem, variantsOf } from './spec.ts'
import { runSnapshot } from './sources.ts'
import { decide, expireTie, restriction, runtimeOf, tally, teamGroup, teamPrompt } from './teams.ts'
import { type Config, errorOf, LEASE_TTL_MS, newId, type NodeHelpers, type NodeRecord, type NodeRow, now, type RunRow, type RunView, type StartInput, type WorkflowError, WorkflowFailure } from './types.ts'
import { view } from './views.ts'

/** Preflight a template and each of its variants, and check that every result schema it names is known. Throws why. */
export function checkTemplate(name: string, nodes: NodeTemplate[], schemas: SchemaRegistry): void {
  resolve(name, nodes, {})
  // Each variant is a template of its own: check it when the template is added, not at a run's start.
  for (const variant of variantsOf(nodes)) resolve(name, nodes, { variant })
  for (const node of nodes) {
    if (node.resultSchema && !schemas.knows(node.resultSchema)) throw new TypeError(`template ${name}, node ${node.nodeId}: unknown result schema ${node.resultSchema}`)
  }
}

export class Engine {
  readonly schemas = new SchemaRegistry()
  readonly templates: Record<string, NodeTemplate[]>
  /** Configured templates refused at load, with why (health reports them). */
  readonly refused = new Map<string, string>()
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
  /** Nodes whose `execute` is in flight (`runId\0nodeId`): a node that must differ waits only on these. */
  private readonly executing = new Set<string>()

  constructor(readonly ctx: Context, readonly config: Config) {
    this.templates = { ...DEFAULT_TEMPLATES, ...config.templates }
    // Checked at load, not at the first call. A configured template that fails preflight is refused
    // alone, with why (INV-2): the engine and every other template keep working, and health names it.
    for (const [name, nodes] of Object.entries(this.templates)) {
      try {
        this.check(name, nodes)
      } catch (error) {
        if (!config.templates?.[name]) throw error
        delete this.templates[name]
        this.refused.set(name, (error as Error).message)
        ctx.logger.warn(`workflow: template ${name} is refused: ${(error as Error).message}`)
      }
    }
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
    checkTemplate(name, nodes, this.schemas)
  }

  /** Admit a run: validated, hashed, and durable at once; it runs in the background. */
  start(input: StartInput): RunView {
    if (this.draining) throw new WorkflowFailure('overloaded', 'the host is draining for a stop or upgrade; retry after it restarts')
    const nodes = this.templates[input.template]
    if (!nodes) {
      const refused = this.refused.get(input.template)
      throw new WorkflowFailure('invalid_input', refused ? `workflow template ${input.template} was refused at load: ${refused}` : `unknown workflow template ${input.template}`)
    }
    if (!input.input.trim()) throw new WorkflowFailure('invalid_input', 'the input must not be empty')
    const requestKey = input.clientRequestId ? sha256(`workflow\0${input.clientRequestId}`) : null
    const unknown = variantProblem(input.template, nodes, input.variant)
    if (unknown) throw new WorkflowFailure('invalid_input', unknown)
    const spec = resolve(input.template, nodes, input)
    if (input.repository && !spec.nodes.some((n) => n.executor === 'snapshot')) throw new WorkflowFailure('invalid_input', `template ${input.template} reads no repository`)
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
      // A run that only waits on someone (a gate's approval, a tie's vote) runs nothing: it counts
      // against its own bound, not against the runs that execute (INV-9).
      const { total, waiting } = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(
          EXISTS (SELECT 1 FROM workflow_nodes n WHERE n.run_id = r.run_id AND n.state = 'BLOCKED')
          AND NOT EXISTS (SELECT 1 FROM workflow_nodes n WHERE n.run_id = r.run_id AND n.state IN ('READY', 'RUNNING'))), 0) AS waiting
        FROM workflow_runs r WHERE r.status = 'running'`).get() as { total: number; waiting: number }
      const limit = this.config.maxActiveRuns ?? 16
      const waitLimit = this.config.maxWaitingRuns ?? 16
      if (total - waiting >= limit) throw new WorkflowFailure('overloaded', `${total - waiting} runs are already executing (limit ${limit}); retry later`)
      if (total >= limit + waitLimit) throw new WorkflowFailure('overloaded', `${waiting} runs wait on an approval or a vote (limit ${waitLimit}); answer, stop, or let them time out, then retry`)
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
          schema: 'workflow-node@1.0', runId: run.run_id, nodeId: node.nodeId, objective: node.objective, executor: recordExecutor(node),
          requirement: this.requirementOf(node, resolved.session.sessionId !== undefined, input.classification),
          dependsOn: node.dependsOn, state: 'WAITING', revision: 0,
        }
        this.schemas.assertRecord(record)
        db.prepare(`INSERT INTO workflow_nodes (run_id, node_id, ordinal, spec, record, state, updated_at) VALUES (?, ?, ?, ?, ?, 'WAITING', ?)`)
          .run(run.run_id, node.nodeId, ordinal, JSON.stringify(resolved), JSON.stringify(record), now())
      })
      // One session group per team, holding its members' sessions (Model A). Members never message
      // each other: the engine composes their prompts from sealed records (REQ-TEAM-1).
      for (const team of new Set(spec.nodes.flatMap((n) => (n.team ? [n.team.id] : [])))) {
        this.ctx.workerSessions.group(teamGroup(run.run_id, team))
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
    // A run that waits on someone (a plan's approval, a tie's vote) is returned at once, like a finished one.
    if (current.status !== 'running' || current.blocked || this.stopped.signal.aborted) return current
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
    // A timer longer than 2^31-1 ms fires at once in Node: a long wait (a tie's) looks again then.
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      this.schedule(runId)
    }, Math.min(delayMs, 2 ** 31 - 1))
    timer.unref()
    this.retries.add(timer)
  }

  private async advance(runId: string): Promise<void> {
    // Ownership lost mid-advance (a host that slept past the lease, or a takeover): look again once
    // the lease can be taken, so the run is never stranded until the next start.
    let retake = false
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
          // A node that must differ from others is promoted with or after them, never before: it then
          // waits for their Workers while they run beside it (ADR-0027).
          const promoted = new Set(nodes.filter((n) => n.state !== 'WAITING').map((n) => n.node_id))
          // Until nothing more can be promoted, so the order nodes are listed in never serializes branches.
          for (let more = true; more;) {
            more = false
            for (const node of nodes) {
              const differs = (JSON.parse(node.spec) as ResolvedNode).differentFrom ?? []
              if (node.state === 'WAITING' && !promoted.has(node.node_id) && node.dependsOnCompleted(nodes) && differs.every((id) => promoted.has(id))) {
                this.promote(run, node, nodes, current)
                promoted.add(node.node_id)
                more = true
              }
            }
          }
          const current_ = this.nodeRows(runId).filter((n) => n.state !== 'RETIRED')
          if (current_.some((n) => n.state === 'FAILED')) continue
          // A step completed without a Worker (a team's tally or decision): its dependents may be ready now.
          if (current_.filter((n) => n.state === 'COMPLETED').length > nodes.filter((n) => n.state === 'COMPLETED').length) continue
          const runnable = current_.filter((n) => n.state === 'READY' || n.state === 'RUNNING')
          // A node that must differ from a peer with no Worker yet runs only beside that peer, so
          // it can wait for the peer's routing; otherwise it is parked until the peer is routed.
          const ids = new Set(runnable.map((n) => n.node_id))
          const active = runnable.filter((n) => !((JSON.parse(n.spec) as ResolvedNode).differentFrom ?? []).some((peer) => {
            const row = current_.find((r) => r.node_id === peer)
            return !row?.worker && row?.state !== 'FAILED' && !ids.has(peer)
          }))
          if (!active.length) {
            // A tie waits a bounded time for a deciding vote, and a plan's gate for its verdict (INV-9):
            // a tie then completes inconclusive, a gate closes and fails the run.
            const waiting = current_.filter((n) => n.state === 'BLOCKED' && ['decide', 'gate'].includes((JSON.parse(n.spec) as ResolvedNode).executor ?? ''))
            const expired = waiting.find((n) => !(Date.parse(n.not_before ?? '') - Date.now() > 0))
            if (expired) {
              if (!expired.not_before) {
                // Blocked before gates had a deadline: it gets one now, never an instant expiry.
                this.writeNode(expired, { not_before: gateDeadline(this) }, (r) => r, current)
              } else if ((JSON.parse(expired.spec) as ResolvedNode).executor === 'decide') expireTie(this, run, expired, current)
              else expireGate(this, run, expired, current)
              continue
            }
            if (waiting.length) this.retryLater(runId, Math.min(...waiting.map((n) => Date.parse(n.not_before!) - Date.now())))
            // Waiting for the operator's `approve` or the caller's `vote`, which schedule the run again;
            // whoever waits on the run learns now that it waits on them.
            if (current_.some((n) => n.state === 'BLOCKED')) {
              for (const wake of this.waiters.get(runId) ?? []) wake()
              return
            }
            return this.finish(run, 'failed', { error: JSON.stringify({ kind: 'internal', disposition: 'CODE_FIX', message: 'no node can run' }) }, current)
          }
          // All of them are executing before any routes, so a node that must differ from one listed
          // after it waits for that one's routing instead of deferring past it (ADR-0027).
          const keys = active.map((node) => `${run.run_id}\0${node.node_id}`)
          for (const key of keys) this.executing.add(key)
          const outcomes = await Promise.all(active.map(async (node, i) => {
            try {
              return await this.execute(run, node, current, signal)
            } catch (error) {
              if (signal.aborted || error instanceof LeaseLost || error instanceof StaleGeneration) throw error
              // A scheduler exception fails the node it happened on, for a code fix: the run then
              // fails on that node, and `continue` reopens it once fixed. It never crash-loops.
              const row = this.nodeRow(run.run_id, node.node_id)
              if (!row || (row.state !== 'READY' && row.state !== 'RUNNING')) throw error
              failAttempt(this, run, row, { kind: 'internal', disposition: 'CODE_FIX', message: (error as Error).message }, { sent: !!row.execution_id }, current)
            } finally {
              this.executing.delete(keys[i]!)
            }
          }))
          // Every node deferred to a peer that is not running (it backs off): look again shortly.
          if (outcomes.every((o) => o === 'deferred') && !(await sleep(250, signal))) return
        }
      } catch (error) {
        if (this.stopped.signal.aborted || operator.signal.aborted) return
        if (lost.aborted || error instanceof LeaseLost || error instanceof StaleGeneration) {
          retake = true
          return
        }
        // Outside a node's execution (promotion, growth), a scheduler exception fails the run for a code fix; it never crash-loops.
        const run = this.runRow(runId)
        if (run?.status === 'running') this.finish(run, 'failed', { error: JSON.stringify({ kind: 'internal', disposition: 'CODE_FIX', message: (error as Error).message }) }, current)
      } finally {
        // A lost lease ends the advance without an exception as well: a node waiting on its
        // execution returns once the signal aborts.
        if (lost.aborted && !this.stopped.signal.aborted && !operator.signal.aborted) retake = true
        if (this.runAborts.get(runId) === operator) this.runAborts.delete(runId)
      }
    })
    if (!outcome.held) this.retryLater(runId, outcome.retryInMs)
    else if (retake) this.retryLater(runId, 1000)
  }

  /** WAITING → READY: render the input from the dependencies' results and bind it by hash. */
  private promote(run: RunRow, node: NodeRow & NodeHelpers, nodes: NodeRow[], lease: () => Lease): void {
    const spec = JSON.parse(node.spec) as ResolvedNode
    if (spec.executor === 'gate') return block(this, run, node, spec, lease)
    if (spec.executor === 'tally') return tally(this, run, node, spec, nodes, lease)
    if (spec.executor === 'decide') return decide(this, run, node, spec, nodes, lease)
    const deps = spec.dependsOn.map((id) => nodes.find((n) => n.node_id === id)!)
    const results = deps.map((d) => (JSON.parse(d.record) as NodeRecord).outputReceipt!.result)
    const texts = Object.fromEntries(deps.map((d, i) => [d.node_id, this.resultText(results[i]!)]))
    const extras = {
      ...(spec.prompt.includes('{{grown}}') ? { grown: grownText(this, spec, nodes) } : {}),
      ...(spec.team?.role === 'ballot' || spec.team?.role === 'debate' ? { team: teamPrompt(this, spec, nodes) } : {}),
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
   * Whether this node may route yet under ADR-0027: it waits while one of its `differentFrom` nodes
   * has no Worker, so the branches of a run still start together, one routing turn apart. When one
   * of those nodes failed, the run fails on it: this node sends nothing and stays as it is. Undefined
   * when the node is in no such relation, either way.
   */
  private async diversity(run: RunRow, spec: ResolvedNode, signal: AbortSignal): Promise<'ready' | undefined | 'stopped' | 'deferred'> {
    const others = spec.differentFrom ?? []
    if (!others.length && !this.nodeRows(run.run_id).some((n) => ((JSON.parse(n.spec) as ResolvedNode).differentFrom ?? []).includes(spec.nodeId))) return undefined
    for (;;) {
      const rows = this.nodeRows(run.run_id).filter((n) => others.includes(n.node_id))
      if (rows.some((n) => n.state === 'FAILED')) return 'stopped'
      if (rows.every((n) => n.worker)) return 'ready'
      // A peer that is not running now (backing off before a retry) will not be routed while this
      // waits: give the turn back to the run loop, which runs both again.
      if (rows.some((n) => !n.worker && !this.executing.has(`${run.run_id}\0${n.node_id}`))) return 'deferred'
      if (!(await sleep(250, signal))) return 'stopped'
    }
  }

  /** The routed nodes that name this one in their `differentFrom`: the relation holds both ways. */
  private namers(run: RunRow, spec: ResolvedNode): NodeRow[] {
    return this.nodeRows(run.run_id).filter((n) => n.worker && ((JSON.parse(n.spec) as ResolvedNode).differentFrom ?? []).includes(spec.nodeId))
  }

  /**
   * The provider families this node's Worker must differ from (ADR-0027): those of the Workers that
   * served the nodes it differs from, read from their descriptors inside the run's routing turn, so
   * the Workers it reads are the ones routing sees. When a served Worker's family cannot be read, no
   * Worker can be shown to differ: that fails closed. Undefined while no such node has a Worker.
   */
  private async families(run: RunRow, spec: ResolvedNode): Promise<{ families: string[]; reason: string } | { problem: string } | undefined> {
    const others = spec.differentFrom ?? []
    // A node routing again (a retry, an escalation, a continue) also differs from the routed nodes
    // that name it, though it never waits for them.
    const named = this.namers(run, spec)
    const rows = this.nodeRows(run.run_id).filter((n) => others.includes(n.node_id))
    if (![...rows, ...named].some((n) => n.worker)) return undefined
    const listed = new Map((await this.ctx.workers.list()).map((w) => [w.worker, w.family]))
    const families = new Set<string>()
    for (const row of [...rows, ...named]) {
      if (!row.worker) continue
      const family = listed.get(row.worker)
      if (family === undefined) {
        return { problem: `node ${row.node_id}'s Worker ${row.worker} ${listed.has(row.worker) ? 'declares no provider family' : 'is no longer listed'}, so no Worker can be shown to differ from it (ADR-0027)` }
      }
      families.add(family)
    }
    const all = [...others, ...named.map((n) => n.node_id)]
    return { families: [...families], reason: `differs from node${all.length > 1 ? 's' : ''} ${all.join(', ')}` }
  }

  /**
   * Run one node to a terminal state, or until the engine stops: route it by its requirement
   * (`ctx.workers`), start it on the admitted Worker's own runtime, then wait and accept.
   */
  private async execute(run: RunRow, initial: NodeRow, lease: () => Lease, signal: AbortSignal): Promise<void | 'deferred'> {
    let node = initial
    const spec = JSON.parse(node.spec) as ResolvedNode
    if (!node.execution_id) {
      const delay = node.not_before ? Date.parse(node.not_before) - Date.now() : 0
      if (delay > 0 && !(await sleep(delay, signal))) return
      // A review's source is read by the engine, not a Worker.
      if (spec.executor === 'snapshot') return runSnapshot(this, run, node, spec, lease, signal)
      const record = JSON.parse(node.record) as NodeRecord
      const attempt = node.attempt + 1
      // A node that must differ from others routes once they have Workers (ADR-0027).
      const differs = await this.diversity(run, spec, signal)
      if (differs === 'stopped') return
      if (differs === 'deferred') return 'deferred'
      // Members of one team route one at a time, so each sees which accounts the others hold.
      const release = await this.routingTurn(run.run_id)
      const exclude = differs ? await this.families(run, spec) : undefined
      if (exclude && 'problem' in exclude) {
        release()
        return failAttempt(this, run, { ...node, attempt }, { kind: 'config_error', disposition: dispositionOf('config_error'), message: exclude.problem }, { sent: false, decisions: [] }, lease)
      }
      let admitted: AdmittedWorker
      // The routing turn, and the admission's place in its Worker's pending load, end together on
      // every path: started, refused, stopped, or failed (ADR-0033).
      const done = (): void => {
        release()
        ;(admitted as AdmittedWorker | undefined)?.release()
      }
      const { distinctAccounts, ...restricted } = await restriction(this, run, spec)
      // The prompt as it will be sent, in characters (ADR-0032): a Worker that takes less is not admitted.
      const input = { chars: [...(node.prompt ?? '')].length }
      // Recorded when the node runs on the same provider family for want of another (ADR-0029).
      let sameFamily: ArtifactRef | undefined
      // The Workers it failed over from, unsent (ADR-0034); with none left but them, it routes as before.
      const failed = node.excluded ? (JSON.parse(node.excluded) as string[]) : []
      const away = failed.length ? { excludeWorkers: { workers: failed, reason: `an earlier attempt of ${node.node_id} failed here before anything was sent` } } : {}
      const route = (options: RouteOptions): Promise<AdmittedWorker> => this.ctx.workers.route(record.requirement, { producer: 'workflow', input, ...options, ...away }).catch((error: unknown) => {
        if (!failed.length || !(error instanceof AdmissionFailure)) throw error
        return this.ctx.workers.route(record.requirement, { producer: 'workflow', input, ...options })
      })
      try {
        try {
          admitted = await route({ ...restricted, ...(exclude ? { exclude } : {}) })
        } catch (error) {
          if (!(error instanceof AdmissionFailure) || !this.config.allowSameFamily || (!exclude && !distinctAccounts)) throw error
          // Opt-in only: with no Worker of another family (or account), route without that rule, and say so.
          // A session's own Worker still binds it; only the family and distinct-account rules are
          // lifted, so a Worker refused for its quota, sign-in, tier, or capability stays refused.
          // First the family rule alone: a team on one provider keeps distinct accounts while it can
          // (ADR-0035); then the distinct-account rule too, members sharing an account (ADR-0029).
          // When nothing passes even then, the first refusal, with what the team needs, stands.
          const kept = exclude && distinctAccounts ? await route(restricted).catch(() => undefined) : undefined
          if (kept) {
            admitted = kept
            sameFamily = this.sameFamilyDecision(run, node, error.decision, [exclude!.reason], admitted, 'same-family')
          } else {
            admitted = await route(distinctAccounts ? {} : restricted).catch(() => {
              throw error
            })
            const rules = [exclude?.reason, distinctAccounts ? restricted.restrict?.reason : undefined].filter((r): r is string => !!r)
            sameFamily = this.sameFamilyDecision(run, node, error.decision, rules, admitted, distinctAccounts ? 'same-family-shared-account' : 'same-family')
          }
        }
      } catch (error) {
        done()
        if (!(error instanceof AdmissionFailure)) throw error
        const hint = error.rejections.length ? inputHint(this, spec, error, input.chars) : ': no Worker is configured (for website Workers, map tiers to modes in the account catalog, then sign the account in)'
        // A team member that finds no other provider family: say what the team needs, beside why this one failed.
        const team = spec.team?.role === 'propose' && exclude ? await this.familyShortage(spec) : ''
        return failAttempt(this, run, { ...node, attempt }, { kind: admissionKind(error), disposition: dispositionOf(admissionKind(error)), message: `${team}${error.message}${hint}` },
          { sent: false, decisions: [error.decision] }, lease)
      }
      // A stop while routing starts nothing: the node is routed again on the next start.
      if (signal.aborted) {
        done()
        return
      }
      const source = this.ctx.workers.source(admitted.source)
      if (!source) {
        done()
        throw new Error(`Worker source ${admitted.source} is gone`)
      }
      const routed = {
        worker: admitted.worker.worker, source: admitted.source, served_tier: admitted.worker.tier, quota_class: admitted.worker.quotaClass,
        // The same-family decision first: the last two stay the tier and route decisions.
        decisions: JSON.stringify([...(sameFamily ? [sameFamily] : []), admitted.decisions.tier, admitted.decisions.route]),
      }
      try {
        this.ctx.store.transaction(() => {
          // Model A: a member joins its team once, at its first admission, bound to the Worker that
          // admission chose. Later steps stay in the same conversation through session affinity,
          // which may admit another tier of the same conversation's account (an escalation).
          if (spec.team?.member && spec.session.sessionId && !this.ctx.workerSessions.session(spec.session.sessionId)) {
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
        done()
      }
      node = this.nodeRow(run.run_id, node.node_id)!
    }
    const source = node.source ? this.ctx.workers.source(node.source) : undefined
    if (!source) {
      // The Worker's runtime is not loaded now (its row is off): the node fails for the operator.
      // Its execution is never guessed at; `continue` runs the node again as a new attempt.
      return failAttempt(this, run, node, { kind: 'config_error', disposition: dispositionOf('config_error'),
        message: `Worker source ${node.source ?? '(none)'} of node ${node.node_id} is not registered (its row is off); turn it back on, then continue the run to run the node again as a new attempt` }, { sent: true }, lease)
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

  /**
   * The operator allows a node to run on the same provider family when no Worker of another
   * family (or another account, for a team member) is admitted (ADR-0029, `allowSameFamily`): the
   * choice is a decision that says so, never "independent", and its node stays in its own session.
   * Its outcome is `same-family` when only the family rule was lifted (a team member keeps an
   * account of its own, ADR-0035), `same-family-shared-account` when the team's distinct-account
   * rule was lifted too.
   */
  private sameFamilyDecision(run: RunRow, node: NodeRow, refused: ArtifactRef, rules: string[], admitted: AdmittedWorker, option: 'same-family' | 'same-family-shared-account'): ArtifactRef {
    const why = `no admitted Worker satisfies: ${rules.join('; ')}`
    const shared = option === 'same-family-shared-account'
    return this.ctx.artifacts.recordDecision({
      decisionType: 'admission',
      question: `Does node ${node.node_id} of run ${run.run_id} run on the same provider family, for want of another?`,
      inputs: [refused, admitted.decisions.route],
      candidates: [
        { option: 'same-family', selected: !shared, reasons: shared ? [] : [why, 'the operator allows it (workflow.allowSameFamily)', 'same provider family: its work is not judged by another provider'] },
        { option: 'same-family-shared-account', selected: shared, reasons: shared ? [why, 'the operator allows it (workflow.allowSameFamily)', 'same provider family, on an account another member holds: each member keeps its own conversation'] : [] },
        { option: 'fail', selected: false, reasons: [] },
      ],
      decider: { type: 'policy', id: 'workflow.same-family', version: '1' },
      outcome: { option, detail: { worker: admitted.worker.worker, sameProviderFamily: true, sharedAccount: shared, rules } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
  }

  /** A team's need for provider families against those ready now, as the start of a member's admission failure. */
  private async familyShortage(spec: ResolvedNode): Promise<string> {
    const ready = new Set((await this.ctx.workers.list()).filter((w) => (w.state === 'ready' || w.state === 'busy') && w.family !== undefined).map((w) => w.family))
    return `team ${spec.team!.id} needs ${spec.team!.members} provider families, one per member; ${ready.size} ${ready.size === 1 ? 'is' : 'are'} ready (ADR-0027). `
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
    const decisions = { decisions: JSON.stringify([...execution.decisions, ...routedDecisions(node, this)]) }
    const data = { executionId: execution.id, source: node.source, worker: node.worker, tier: node.served_tier, quotaClass: node.quota_class, accepted: acceptance.accepted }
    let gate: ReturnType<typeof subjectGate> | undefined
    this.ctx.store.transaction(() => {
      const refused = acceptance.accepted && spec.grows ? grow(this, run, node, spec, result, lease) : undefined
      if (refused) {
        const error: WorkflowError = { kind: 'plan_rejected', disposition: 'NONE', message: refused.message }
        this.writeNode(node, { state: 'FAILED', error: JSON.stringify(error), ...decisions }, (r) => ({ ...r, lastDecision: refused.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: refused.decision, data: { ...data, kind: error.kind } })
      } else if (acceptance.accepted && node.subject && !(gate = subjectGate(this, run, node, result)).passed) {
        const error: WorkflowError = { kind: 'stale_subject', disposition: 'NONE', message: `exact-subject gate: ${gate.reason}` }
        this.writeNode(node, { state: 'FAILED', error: JSON.stringify(error), ...decisions }, (r) => ({ ...r, lastDecision: gate!.decision }), lease)
        this.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: gate.decision, data: { ...data, kind: error.kind } })
      } else if (acceptance.accepted) {
        if (gate?.passed) {
          decisions.decisions = JSON.stringify([...JSON.parse(decisions.decisions) as string[], gate.decision])
          remediate(this, run, node, spec, gate.assessment, gate.subject, lease)
        }
        this.writeNode(node, { state: 'COMPLETED', error: null, ...decisions }, (r) => ({ ...r, outputReceipt: { result, acceptance: acceptance.decision }, lastDecision: acceptance.decision }), lease)
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
      // A member's mail is not the team's procedure: what is left over must not wake it later.
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
