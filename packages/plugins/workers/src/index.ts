/**
 * `ctx.workers`: the Worker registry, fail-closed admission, and the deterministic router
 * (docs/design/routing.md#algorithm). Sources describe their Workers on every route, so
 * admission sees current states; the router never branches on a provider (INV-11). Every
 * outcome is a decision artifact listing every candidate and why (INV-13).
 * @module @tsuuanmi/system-workers
 */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-artifacts'
import {
  type AccountQuota, extractJson, HEADROOM_KEYS, type HeadroomKeys, headroomLine, headroomOrderOf, headroomReason, QUOTA_DEFAULTS, QUOTA_SCORE, type QuotaPool, type QuotaSettings,
  quotaSettingsProblems, SchemaRegistry,
} from '@tsuuanmi/system-libs'
import {
  type Acceptance, type AcceptanceContract, ADMISSION_CHECKS, type AdmissionCheck, AdmissionFailure, type AdmittedWorker, type ArtifactRef, type Candidates, type CapabilityDescriptor, type Carried, type CarryStep, type Checked, type CheckStep, type Landed, type LandStep, type WorkChange, LIVENESS_STATES, type LivenessQuery,
  type LivenessState, MAX_LIVENESS_RUNS, provesFor, type QuotaClass, type Rejection, type RouteOptions, type RunLiveness, takesKind, TIERS, type Tier, type WorkRequirement, type WorkerSource,
  type WorkerSourceRead, Workers,
} from '@tsuuanmi/system-workers-core'

export * from '@tsuuanmi/system-workers-core'

export interface Config {
  /** Quota classes in order of preference when the requirement states none (REQ-WRK-8). */
  quotaPreference?: QuotaClass[]
  /** Worker ids preferred, in order, after tier and quota class; then the stable id decides. */
  priority?: string[]
}

const QUOTA_CLASSES: QuotaClass[] = ['subscription-chat', 'local', 'agent-plan', 'metered']
/** Version 2 (T185, PROP-0014 D3): the quota score's headroom order is part of every route's order. */
const DECIDER = { type: 'policy', id: 'workers.route.deterministic', version: '2' } as const

/** A pool of the resource ledger as routing reads it (`ctx.resources.pools()`): the account it is of, and what the quota score reads. */
type LedgerPool = QuotaPool & { account: string }
/** The resource ledger as routing reads it, when it is mounted: its pools now, and the operator's quota settings. */
interface Ledger {
  pools(filter?: { account?: string }, at?: Date): Promise<LedgerPool[]>
  quota?(): QuotaSettings
}
/** Each admitted Worker's account quota and its keys in the headroom order, by Worker id. */
type Quotas = ReadonlyMap<string, { quota: AccountQuota; keys: HeadroomKeys; settings: QuotaSettings }>
/** One key of routing's order, by name, so a decision says which one a Worker lost on. */
type OrderKey = { name: 'tier' | 'quota' | keyof HeadroomKeys | 'load' | 'priority'; key: (w: CapabilityDescriptor) => number }
/** How long one source may take to describe its Workers inside the routing lock (ADR-0033). */
const DESCRIBE_MS = 5000
/** Why a source counted as describing none: it did not answer within `DESCRIBE_MS`. */
const SILENT = `did not describe its Workers within ${DESCRIBE_MS / 1000} s`

const textOf = (body: unknown): string => {
  const text = (body as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : ''
}

/**
 * A URL without the sentence punctuation after it, by one backward scan: `[.,;:!?]+$` is retried
 * at every position of a long run that something else ends, which is quadratic on an answer.
 */
function withoutTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0 && '.,;:!?'.includes(url[end - 1]!)) end--
  return url.slice(0, end)
}

/** Contracts every deployment has; a plugin adds its own with `contract()`. */
const BUILT_IN: Record<string, AcceptanceContract> = {
  'acceptance.answer': ({ body }) => (textOf(body).trim()
    ? { accepted: true, reasons: ['the answer has text'] }
    : { accepted: false, reasons: ['the answer is empty'] }),
  'acceptance.cited': ({ body }) => {
    const text = textOf(body)
    if (!text.trim()) return { accepted: false, reasons: ['the answer is empty'] }
    const links = new Set((text.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).map(withoutTrailingPunctuation)).size
    return links ? { accepted: true, reasons: [`the answer cites ${links} source link(s)`] } : { accepted: false, reasons: ['the answer cites no source link'] }
  },
}

type Failed = Rejection['failed']

export class WorkerRouter extends Workers {
  static inject = ['artifacts']

  static Config: z<Config> = z.object({
    quotaPreference: z.array(z.union(QUOTA_CLASSES)).default(QUOTA_CLASSES).description('Quota classes in order of preference'),
    priority: z.array(z.string()).default([]).description('Worker ids preferred, in order, after tier and quota class'),
  })

  private readonly registry = new Map<string, WorkerSource>()
  /** How each registered source answered its last read, by name: what `sources()` reports. */
  private readonly reads = new Map<string, WorkerSourceRead>()
  /** The registered sources one of whose describes has landed, even past the bound: a silent read of any other is still its first (`describing`). */
  private readonly landed = new WeakSet<WorkerSource>()
  private readonly registered = new Map<string, AcceptanceContract>(Object.entries(BUILT_IN))
  private readonly schemas = new SchemaRegistry()
  /** One route at a time, across every caller, so no two read the same load (ADR-0033). */
  private routing: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx)
  }

  register(source: WorkerSource): void {
    if (this.registry.has(source.name)) throw new Error(`Worker source ${source.name} is already registered`)
    this.ctx.effect(() => {
      this.registry.set(source.name, source)
      return () => {
        if (this.registry.get(source.name) !== source) return
        this.registry.delete(source.name)
        this.reads.delete(source.name)
      }
    })
  }

  source(name: string): WorkerSource | undefined {
    return this.registry.get(name)
  }

  sources(): WorkerSourceRead[] {
    return [...this.reads.values()].sort((a, b) => compare(a.source, b.source))
  }

  affinity(sessionId: string): string[] | undefined {
    for (const source of this.registry.values()) {
      const workers = source.affinity?.(sessionId)
      if (workers) return workers
    }
    return undefined
  }

  siblings(worker: string): string[] {
    for (const source of this.registry.values()) {
      const workers = source.siblings?.(worker)
      if (workers) return workers
    }
    return [worker]
  }

  handle(sessionId: string): string | undefined {
    for (const source of this.registry.values()) {
      const handle = source.handle?.(sessionId)
      if (handle) return handle
    }
    return undefined
  }

  reset(sessionId: string): boolean {
    for (const source of this.registry.values()) if (source.reset?.(sessionId)) return true
    return false
  }

  async held(sessionId: string): Promise<string | undefined> {
    for (const source of this.registry.values()) {
      let why: string | undefined
      try {
        why = await source.held?.(sessionId)
      } catch (error) {
        // A source that cannot answer cannot show the session free (INV-2).
        why = `source ${source.name} cannot tell whether session ${sessionId} takes input now: ${(error as Error).message.slice(0, 200)}`
      }
      if (why) return why
    }
    return undefined
  }

  async liveness(query: LivenessQuery = {}): Promise<{ runs: Array<RunLiveness & { source: string }>; counts: Record<LivenessState, number>; unread: Array<{ source: string; detail: string }> }> {
    const runs: Array<RunLiveness & { source: string }> = []
    const counts = Object.fromEntries(LIVENESS_STATES.map((s) => [s, 0])) as Record<LivenessState, number>
    const unread: Array<{ source: string; detail: string }> = []
    for (const source of this.registry.values()) {
      if (!source.liveness) continue
      try {
        const told = await source.liveness(query)
        for (const state of LIVENESS_STATES) counts[state] += told.counts[state] ?? 0
        runs.push(...told.runs.slice(0, MAX_LIVENESS_RUNS).map((run) => ({ ...run, source: source.name })))
      } catch (error) {
        // A source that cannot tell is never read as having none (INV-2).
        unread.push({ source: source.name, detail: (error as Error).message.slice(0, 200) })
      }
    }
    runs.sort((a, b) => compare(b.since, a.since) || compare(a.source, b.source) || compare(a.execution, b.execution))
    return { runs: runs.slice(0, MAX_LIVENESS_RUNS), counts, unread }
  }

  async land(step: LandStep): Promise<(Landed & { source: string }) | undefined> {
    for (const source of this.registry.values()) {
      if (!source.land) continue
      let landed: Landed | undefined
      try {
        landed = await source.land(step)
      } catch (error) {
        // A source that cannot answer is never read as not holding the worktree (INV-2).
        landed = { outcome: 'refused', cause: 'failed', reason: `source ${source.name} could not ${step.step} the worktree ${step.workspace}: ${(error as Error).message.slice(0, 300)}` }
      }
      if (landed) return { ...landed, source: source.name }
    }
    return undefined
  }

  async changes(runId: string): Promise<{ changes: Array<WorkChange & { source: string }>; unread: Array<{ source: string; detail: string }> }> {
    const changes: Array<WorkChange & { source: string }> = []
    const unread: Array<{ source: string; detail: string }> = []
    for (const source of this.registry.values()) {
      if (!source.changes) continue
      try {
        for (const change of (await source.changes(runId)) ?? []) changes.push({ ...change, source: source.name })
      } catch (error) {
        // A source that cannot read its worktree is never read as holding no change (INV-2).
        unread.push({ source: source.name, detail: (error as Error).message.slice(0, 300) })
      }
    }
    return { changes, unread }
  }

  async carry(step: CarryStep): Promise<(Carried & { source: string }) | undefined> {
    for (const source of this.registry.values()) {
      if (!source.carry) continue
      let carried: Carried | undefined
      try {
        carried = await source.carry(step)
      } catch (error) {
        // A source that cannot answer is never read as not holding the earlier tree (INV-2).
        carried = { outcome: 'refused', cause: 'failed', reason: `source ${source.name} could not carry the worktree ${step.from.workspace} into run ${step.runId}: ${(error as Error).message.slice(0, 300)}` }
      }
      if (carried) return { ...carried, source: source.name }
    }
    return undefined
  }

  async check(step: CheckStep, signal?: AbortSignal): Promise<(Checked & { source: string }) | undefined> {
    for (const source of this.registry.values()) {
      if (!source.check) continue
      let checked: Checked | undefined
      try {
        checked = await source.check(step, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        // A source that cannot answer is never read as not holding the worktree, nor as a check passed (INV-2).
        checked = { outcome: 'refused', cause: 'failed', reason: `source ${source.name} could not run the checks of run ${step.runId} in ${step.workspace}: ${(error as Error).message.slice(0, 300)}` }
      }
      if (checked) return { ...checked, source: source.name }
    }
    return undefined
  }

  release(sessionIds: readonly string[], reason: string): { due: number } {
    let due = 0
    if (sessionIds.length) for (const source of this.registry.values()) due += source.release?.(sessionIds, reason).due ?? 0
    return { due }
  }

  async list(): Promise<CapabilityDescriptor[]> {
    return (await this.described()).all.map((d) => d.worker)
  }

  /**
   * Every Worker with the name of its source, validated and ordered by id. A source that does not
   * describe its Workers within `DESCRIBE_MS` counts as describing none (`silent`), so one stuck
   * source never holds every route behind the routing lock; while none of its describes has landed
   * since it registered, that read says it is still `describing` (its Workers not known yet). A
   * source whose `describe` throws fails the read with its error, as before. How each source
   * answered is kept as its last read.
   */
  private async described(): Promise<{ all: Array<{ worker: CapabilityDescriptor; source: string }>; silent: string[] }> {
    const silent: string[] = []
    const at = new Date().toISOString()
    const described = await Promise.all([...this.registry.values()].map(async (source) => {
      const done = new AbortController()
      const late = delay(DESCRIBE_MS, undefined, { signal: done.signal }).catch(() => undefined)
      let workers: CapabilityDescriptor[] | undefined
      try {
        const describing = source.describe()
        // A describe that lands past the bound still lands: the source's next silent read is not its first.
        describing.then(() => this.landed.add(source), () => undefined)
        workers = await Promise.race([describing, late])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.remember(source, { source: source.name, state: 'failed', at, workers: 0, detail: `failed to describe its Workers: ${message.slice(0, 200)}` })
        throw error
      } finally {
        done.abort()
      }
      if (!workers) silent.push(source.name)
      this.remember(source, workers ? { source: source.name, state: 'described', at, workers: workers.length }
        : { source: source.name, state: 'silent', at, workers: 0, detail: SILENT, ...(this.landed.has(source) ? {} : { describing: true as const }) })
      return { source: source.name, workers: workers ?? [] }
    }))
    const seen = new Map<string, string>()
    const all: Array<{ worker: CapabilityDescriptor; source: string }> = []
    for (const { source, workers } of described) {
      for (const worker of workers) {
        this.schemas.assertRecord(worker)
        const other = seen.get(worker.worker)
        if (other) throw new Error(`Worker ${worker.worker} is described by both ${other} and ${source}`)
        seen.set(worker.worker, source)
        all.push({ worker, source })
      }
    }
    return { all: all.sort((a, b) => compare(a.worker.worker, b.worker.worker)), silent: silent.sort() }
  }

  /** Keep a read as the source's last, unless the source is gone or a read that started later is kept already. */
  private remember(source: WorkerSource, read: WorkerSourceRead): void {
    if (this.registry.get(source.name) !== source) return
    const kept = this.reads.get(source.name)
    if (!kept || kept.at <= read.at) this.reads.set(source.name, read)
  }

  async route(requirement: WorkRequirement, options: RouteOptions = {}): Promise<AdmittedWorker> {
    return this.inTurn(() => this.routeNow(requirement, options))
  }

  /**
   * Every Worker with the checks it fails for this requirement, judged as `route` judges it, under the
   * same lock (PROP-0014): nothing is reserved, and no decision is recorded (the caller that acts on it
   * records its own).
   */
  async candidates(requirement: WorkRequirement, options: RouteOptions = {}): Promise<Candidates> {
    return this.inTurn(async () => {
      const { described, requirementRef, failures, silent } = await this.judge(requirement, options)
      return {
        requirement: requirementRef,
        workers: described.map((d) => ({ worker: d.worker, source: d.source, failed: failures.get(d.worker.worker)! })),
        unheard: silent.map((source) => ({ source, reason: SILENT })),
        order: { quota: this.quotaOrder(requirement), priority: [...(this.config.priority ?? [])] },
      }
    })
  }

  /** One turn of the routing lock: what runs in it reads the Workers' load alone (ADR-0033). */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.routing.then(work)
    this.routing = turn.catch(() => undefined)
    return turn
  }

  /**
   * Admission for one requirement: every Worker described now, the stored requirement, and each
   * Worker's failed checks, in the design's order, the assigned-account hold applied (ADR-0052).
   */
  private async judge(requirement: WorkRequirement, options: RouteOptions): Promise<{ described: Array<{ worker: CapabilityDescriptor; source: string }>; silent: string[]; requirementRef: ArtifactRef; failures: Map<string, Failed>; limited: Limited[] }> {
    this.schemas.assertRecord(requirement)
    const { all: described, silent } = await this.described()
    const workers = described.map((d) => d.worker)
    const producer = { type: 'system' as const, ref: options.producer ?? 'workers' }
    const stored = this.ctx.artifacts.put({
      kind: 'objective', bodySchema: requirement.schema, body: requirement, classification: requirement.data.classification, producer,
    })
    const failures = new Map(workers.map((w) => [w.worker, this.admit(w, requirement, options)]))
    // Under assigned accounts, a limit keeps the work off the group's other accounts (ADR-0052).
    const limited = limitedOnly(workers, failures, requirement)
    assign(workers, failures, limited)
    return { described, silent, requirementRef: stored.id as ArtifactRef, failures, limited }
  }

  private async routeNow(requirement: WorkRequirement, options: RouteOptions): Promise<AdmittedWorker> {
    const { described, silent, requirementRef, failures, limited } = await this.judge(requirement, options)
    const workers = described.map((d) => d.worker)
    // A source that did not answer in time is named in the decision, as a candidate it could not offer.
    const unheard = silent.map((name) => ({ option: `source ${name}`, selected: false, reasons: [SILENT] }))
    const producer = { type: 'system' as const, ref: options.producer ?? 'workers' }
    const passed = workers.filter((w) => failures.get(w.worker)!.length === 0)
    // Each admitted Worker's account quota, in the quota score's one headroom order (PROP-0014 D3).
    const quotas = await this.quotas(passed)
    const admitted = passed.sort(this.order(requirement, quotas))
    const chosen = admitted[0]
    if (!chosen) {
      const rejections: Rejection[] = workers.map((w) => ({ worker: w.worker, state: w.state, failed: failures.get(w.worker)! }))
      // A capability no Worker proves now is the plainest reason, for example website-only work in a composition without website Workers.
      const unproven = requirement.capabilities.filter((c) => !workers.some((w) => w.capabilities.some((p) => p.capability === c && provesFor(p, requirement))))
      // Next plainest: Workers prove all of it, and the operator gives each of them other kinds of work (ADR-0057).
      const proving = workers.filter((w) => requirement.capabilities.every((c) => w.capabilities.some((p) => p.capability === c && provesFor(p, requirement))))
      const untaken = !unproven.length && proving.length > 0 && !proving.some((w) => takesKind(w, requirement))
      const limitUntil = waitUntil(limited)
      const why = unproven.length ? `no Worker proves ${unproven.join(', ')}`
        : untaken ? `no Worker that proves ${requirement.capabilities.join(', ')} takes ${requirement.kind === undefined ? 'work that names no kind' : `${requirement.kind} work`}`
        : limitUntil ? `no Worker passes admission; the assigned accounts that could take it are at their limit, the first back at ${limitUntil}`
        : workers.length ? 'no Worker passes admission' : 'no Worker is registered'
      const decision = this.ctx.artifacts.recordDecision({
        decisionType: 'admission',
        question: `Which Worker may take ${requirement.kind === undefined ? '' : `${requirement.kind} `}work needing ${requirement.capabilities.join(', ')} at tier ${requirement.tier.min} or above?`,
        inputs: [requirementRef],
        candidates: [
          ...rejections.map((r) => ({ option: r.worker, selected: false, reasons: r.failed.map((f) => f.reason) })),
          ...unheard,
          { option: 'none', selected: true, reasons: [why] },
        ],
        decider: DECIDER,
        outcome: { option: 'none' },
        deterministic: true,
      }, { producer, classification: requirement.data.classification })
      const summary = rejections.map((r) => `${r.worker}: ${r.failed.map((f) => f.reason).join(', ')}`).join('; ')
      throw new AdmissionFailure(rejections, decision.id as ArtifactRef, `no Worker can take this work: ${why} (${summary ? `${summary}; ` : ''}decision ${decision.id})`, limitUntil)
    }
    const tier = this.ctx.artifacts.recordDecision({
      decisionType: 'tier',
      question: `Which intelligence tier serves work needing tier ${requirement.tier.min}${requirement.tier.max ? ` to ${requirement.tier.max}` : ''} or above?`,
      inputs: [requirementRef],
      candidates: TIERS.map((t) => ({ option: t, selected: t === chosen.tier, reasons: this.tierReasons(t, chosen.tier, requirement, admitted) })),
      decider: DECIDER,
      outcome: { option: chosen.tier },
      deterministic: true,
    }, { producer, classification: requirement.data.classification })
    const route = this.ctx.artifacts.recordDecision({
      decisionType: 'route',
      question: `Which Worker runs ${requirement.kind === undefined ? '' : `${requirement.kind} `}work needing ${requirement.capabilities.join(', ')}?`,
      inputs: [requirementRef, tier.id],
      candidates: [...workers.map((w) => {
        // Every admitted Worker's score, when the ledger was read: its account's quota in one line.
        const score = quotas?.get(w.worker) ? [`quota (${QUOTA_SCORE}): ${headroomLine(quotas.get(w.worker)!.quota)}`] : []
        if (w === chosen) return { option: w.worker, selected: true, reasons: [...this.chosenReasons(w, requirement), ...inputBound(w, workers, failures, options), ...score] }
        const failed = failures.get(w.worker)!
        return { option: w.worker, selected: false, reasons: failed.length ? failed.map((f) => f.reason) : [`admitted; ${this.lostTo(w, chosen, requirement, quotas)}`, ...score] }
      }), ...unheard],
      decider: DECIDER,
      outcome: { option: chosen.worker },
      deterministic: true,
    }, { producer, classification: requirement.data.classification })
    const source = described.find((d) => d.worker === chosen)!.source
    // Counted as pending on the chosen Worker until the caller starts the work, or gives it up.
    let held = this.registry.get(source)?.reserve?.(chosen.worker)
    const release = (): void => {
      held?.()
      held = undefined
    }
    return { worker: chosen, source, requirement: requirementRef, decisions: { tier: tier.id as ArtifactRef, route: route.id as ArtifactRef }, release }
  }

  contract(id: string, check: AcceptanceContract): void {
    if (this.registered.has(id)) throw new Error(`acceptance contract ${id} is already registered`)
    this.ctx.effect(() => {
      this.registered.set(id, check)
      return () => {
        if (this.registered.get(id) === check) this.registered.delete(id)
      }
    })
  }

  contracts(): string[] {
    return [...this.registered.keys()].sort()
  }

  accept(result: ArtifactRef, contract: string, options: { producer?: string; runId?: string; nodeId?: string; resultSchema?: string } = {}): Acceptance {
    const check = this.registered.get(contract)
    if (!check) throw new Error(`unknown acceptance contract ${contract}`)
    const envelope = this.ctx.artifacts.get(result)
    if (!envelope) throw new Error(`unknown result artifact ${result}`)
    const structured = options.resultSchema ? this.structured(envelope.body, options.resultSchema) : undefined
    let verdict = structured ?? check({ id: result, bodySchema: envelope.bodySchema, body: envelope.body })
    if (!verdict.reasons.length) throw new TypeError(`acceptance contract ${contract} gave no reason`)
    if (options.resultSchema && !structured) verdict = { ...verdict, reasons: [`a valid ${options.resultSchema}`, ...verdict.reasons] }
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'acceptance',
      question: `Does result ${result} satisfy ${contract}${options.resultSchema ? ` and ${options.resultSchema}` : ''}?`,
      inputs: [result],
      candidates: [
        // The losing option's reason is the verdict seen from its side: the failed checks, or none failed.
        { option: 'accept', selected: verdict.accepted, reasons: verdict.accepted ? verdict.reasons : verdict.reasons.map((r) => `not accept: ${r}`) },
        { option: 'reject', selected: !verdict.accepted, reasons: verdict.accepted ? [`not reject: every check of ${contract}${options.resultSchema ? ` and ${options.resultSchema}` : ''} passed`] : verdict.reasons },
      ],
      decider: { type: 'rule', id: contract, version: '1' },
      outcome: { option: verdict.accepted ? 'accept' : 'reject' },
      deterministic: true,
    }, {
      producer: { type: 'system', ref: options.producer ?? 'workers' },
      ...(options.runId !== undefined ? { runId: options.runId } : {}), ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
    })
    return { accepted: verdict.accepted, reasons: verdict.reasons, decision: decision.id as ArtifactRef }
  }

  /** A structured result's check: its JSON, valid against the named schema; undefined when it is (then the contract decides). */
  private structured(body: unknown, tag: string): { accepted: false; reasons: string[] } | undefined {
    if (!this.schemas.knows(tag)) throw new Error(`unknown result schema ${tag}`)
    const value = extractJson(textOf(body))
    if (!value) return { accepted: false, reasons: [`the result has no JSON object for ${tag}`] }
    try {
      this.schemas.assert(tag, { ...value, schema: tag })
      return undefined
    } catch (error) {
      // A validation report can be any length; the verdict's reason stays short.
      return { accepted: false, reasons: [`the result is not a valid ${tag}: ${(error as Error).message}`.slice(0, 300)] }
    }
  }

  /** Every failed admission check, in the design's order; empty means admitted (REQ-WRK-1, -7, -9). */
  private admit(worker: CapabilityDescriptor, requirement: WorkRequirement, options: RouteOptions): Failed {
    const failed: Failed = []
    const fail = (check: AdmissionCheck, reason: string): void => {
      failed.push({ check, reason })
    }
    if (options.restrict && !options.restrict.workers.includes(worker.worker)) fail('restricted', options.restrict.reason)
    if (options.excludeWorkers?.workers.includes(worker.worker)) fail('excluded', options.excludeWorkers.reason)
    // ADR-0027: an opaque inequality. The reason names the nodes, never a family.
    if (options.exclude) {
      if (worker.family === undefined) fail('diversity', `declares no provider family, so it cannot differ (${options.exclude.reason})`)
      else if (options.exclude.families.includes(worker.family)) fail('diversity', `same provider family (${options.exclude.reason})`)
    }
    // An offer scoped to a kind of work proves its capability for that work only (ADR-0049).
    const proven = new Set(worker.capabilities.filter((c) => provesFor(c, requirement)).map((c) => c.capability))
    const missing = requirement.capabilities.filter((c) => !proven.has(c))
    if (missing.length) {
      const scoped = worker.capabilities.filter((c) => missing.includes(c.capability) && c.scope !== undefined).map((c) => `${c.capability} only for ${c.scope} work`)
      fail('capability', `does not prove ${missing.join(', ')}${scoped.length ? ` (it proves ${scoped.join(', ')})` : ''}`)
    }
    // A Worker the operator gives kinds takes work of those kinds only (ADR-0057); equality only.
    if (!takesKind(worker, requirement)) {
      fail('capability', `takes ${worker.kinds!.join(', ')} work only; this work ${requirement.kind === undefined ? 'names no kind' : `is ${requirement.kind} work`}`)
    }
    // A site's usage limit on a capability the work needs (ADR-0034); a lapsed one no longer counts.
    const now = Date.now()
    const cooled = (worker.cooldowns ?? []).filter((c) => requirement.capabilities.includes(c.capability) && Date.parse(c.until) > now)
    if (cooled.length) fail('cooldown', cooled.map((c) => `${c.capability} limit until ${c.until}`).join(', '))
    // The work stays on its account within its group (ADR-0052); opaque equality only.
    if (options.assignment && worker.account?.group === options.assignment.group && worker.account.id !== options.assignment.account) fail('assignment', options.assignment.reason)
    if (options.input && worker.maxInputChars !== undefined && options.input.chars > worker.maxInputChars) {
      fail('input', `the input has ${options.input.chars} characters; it takes at most ${worker.maxInputChars}`)
    }
    if (requirement.data.classification === 'local-private' && worker.locality !== 'local') fail('locality', 'local-private data stays on local Workers')
    // Busy is admissible: it only orders the Worker after less busy ones (ADR-0033).
    if (worker.state !== 'ready' && worker.state !== 'busy') fail('state', `state ${worker.state}`)
    const rank = TIERS.indexOf(worker.tier)
    if (rank < TIERS.indexOf(requirement.tier.min)) fail('tier', `tier ${worker.tier} is below the minimum ${requirement.tier.min}`)
    else if (requirement.tier.max && rank > TIERS.indexOf(requirement.tier.max)) fail('tier', `tier ${worker.tier} is above the maximum ${requirement.tier.max}`)
    return failed
  }

  /**
   * Each admitted Worker's account quota and headroom keys (`quota-score@2`, libs' one implementation),
   * read from the resource ledger once per route; undefined when no ledger is mounted, so the order is
   * routing's own as before. A ledger that cannot be read leaves every account's quota unknown, never
   * headroom (INV-2); settings it cannot tell are the defaults (the 20 % reserve, D63).
   */
  private async quotas(admitted: readonly CapabilityDescriptor[]): Promise<Quotas | undefined> {
    const ledger = this.ctx.get('resources' as never) as Ledger | undefined
    if (!ledger) return undefined
    const now = new Date()
    let pools: LedgerPool[] | { unknown: string }
    try {
      pools = await ledger.pools({}, now)
    } catch (error) {
      pools = { unknown: `the resource ledger could not be read: ${(error as Error).message.slice(0, 200)}` }
    }
    let settings: QuotaSettings = QUOTA_DEFAULTS
    try {
      const given = ledger.quota?.()
      if (given && !quotaSettingsProblems(given).length) settings = given
    } catch {
      settings = QUOTA_DEFAULTS
    }
    const poolsOf = (w: CapabilityDescriptor): readonly QuotaPool[] | { unknown: string } | undefined => {
      if (!w.account) return undefined
      return Array.isArray(pools) ? pools.filter((p) => p.account === w.account!.id) : pools
    }
    return new Map(headroomOrderOf(admitted, poolsOf, settings, now).map((o) => [o.item.worker, { quota: o.quota, keys: o.keys, settings }]))
  }

  /**
   * An account over its reserve last while another admitted Worker has headroom (it gets no new step,
   * writing or not, while one does); then lowest tier, quota class preference, the rest of the quota
   * score's headroom order (known before unknown, the window that resets soonest with headroom, the
   * most headroom), least busy, configured priority, and stable id.
   */
  private order(requirement: WorkRequirement, quotas?: Quotas): (a: CapabilityDescriptor, b: CapabilityDescriptor) => number {
    return (a, b) => {
      for (const { key } of this.keys(requirement, quotas)) {
        const difference = key(a) - key(b)
        if (difference) return difference
      }
      return compare(a.worker, b.worker)
    }
  }

  private keys(requirement: WorkRequirement, quotas?: Quotas): OrderKey[] {
    const quota = this.quotaOrder(requirement)
    const priority = this.config.priority ?? []
    const rankOf = (list: readonly string[], value: string): number => (list.includes(value) ? list.indexOf(value) : list.length)
    const headroom = (name: keyof HeadroomKeys): OrderKey => ({ name, key: (w) => quotas?.get(w.worker)?.keys[name] ?? 0 })
    return [
      headroom('reserve'),
      { name: 'tier', key: (w) => TIERS.indexOf(w.tier) }, { name: 'quota', key: (w) => rankOf(quota, w.quotaClass) },
      ...HEADROOM_KEYS.filter((k) => k !== 'reserve').map(headroom),
      { name: 'load', key: busy }, { name: 'priority', key: (w) => rankOf(priority, w.worker) },
    ]
  }

  private quotaOrder(requirement: WorkRequirement): QuotaClass[] {
    const preferred = requirement.budget?.preferQuota ?? []
    const rest = (this.config.quotaPreference ?? QUOTA_CLASSES).filter((q) => !preferred.includes(q))
    return [...preferred, ...rest]
  }

  private chosenReasons(worker: CapabilityDescriptor, requirement: WorkRequirement): string[] {
    const reasons = [`proves ${requirement.capabilities.join(', ')}${requirement.scope ? ` for ${requirement.scope} work` : ''}`, `lowest admissible tier ${worker.tier}`, `quota class ${worker.quotaClass}`]
    if (requirement.kind !== undefined) reasons.push(worker.kinds ? `takes ${requirement.kind} work, one of its kinds` : 'takes work of any kind')
    if (worker.load) reasons.push(loadOf(worker.load))
    if ((this.config.priority ?? []).includes(worker.worker)) reasons.push('first in the configured priority list')
    return reasons
  }

  /** Why an admitted Worker ordered after the chosen one: the first ordering key that differs. */
  private lostTo(worker: CapabilityDescriptor, chosen: CapabilityDescriptor, requirement: WorkRequirement, quotas?: Quotas): string {
    const differs = this.keys(requirement, quotas).find(({ key }) => key(worker) !== key(chosen))
    switch (differs?.name) {
      case undefined: return `${chosen.worker} comes first by id`
      case 'tier': return `${chosen.worker} has the lower tier ${chosen.tier}`
      case 'quota': return `${chosen.worker} has the preferred quota class ${chosen.quotaClass}`
      case 'load': return `${chosen.worker} is less busy (${loadOf(chosen.load)}; this one ${loadOf(worker.load)})`
      case 'priority': return `${chosen.worker} comes first in the configured priority list`
      default: {
        const a = quotas!.get(chosen.worker)!
        const b = quotas!.get(worker.worker)!
        return headroomReason({ who: chosen.worker, quota: a.quota, keys: a.keys }, b, a.settings) ?? `${chosen.worker} comes first by quota`
      }
    }
  }

  private tierReasons(tier: Tier, chosen: Tier, requirement: WorkRequirement, admitted: CapabilityDescriptor[]): string[] {
    const rank = TIERS.indexOf(tier)
    if (tier === chosen) return ['lowest tier at or above the minimum with an admitted Worker']
    if (rank < TIERS.indexOf(requirement.tier.min)) return [`below the minimum ${requirement.tier.min}`]
    if (requirement.tier.max && rank > TIERS.indexOf(requirement.tier.max)) return [`above the maximum ${requirement.tier.max}`]
    if (!admitted.some((w) => w.tier === tier)) return ['no admitted Worker at this tier']
    return [`the lower tier ${chosen} has an admitted Worker`]
  }
}

/** A Worker refused only for its usage limit, with its account, and when it is back (unknown: undefined). */
interface Limited {
  worker: CapabilityDescriptor
  until: string | undefined
}

/**
 * The Workers refused only for their usage limit (ADR-0052): every check they failed is a
 * `cooldown` on a capability the work needs, or their state `quota-exhausted`. Each is back once
 * every one of those limits lapses: the latest cooldown it fails, and its account's `limitUntil`
 * when its state is the limit; unknown when either is not known.
 */
function limitedOnly(workers: readonly CapabilityDescriptor[], failures: ReadonlyMap<string, Failed>, requirement: WorkRequirement): Limited[] {
  const now = Date.now()
  const out: Limited[] = []
  for (const worker of workers) {
    const failed = failures.get(worker.worker)!
    const exhausted = worker.state === 'quota-exhausted'
    if (!failed.length || !failed.every((f) => f.check === 'cooldown' || (f.check === 'state' && exhausted))) continue
    const resets = (worker.cooldowns ?? []).filter((c) => requirement.capabilities.includes(c.capability) && Date.parse(c.until) > now).map((c) => Date.parse(c.until))
    const account = worker.account?.limitUntil === undefined ? Number.NaN : Date.parse(worker.account.limitUntil)
    if (exhausted) resets.push(account > now ? account : Number.NaN)
    const back = Math.max(...resets)
    out.push({ worker, until: Number.isFinite(back) ? new Date(back).toISOString() : undefined })
  }
  return out
}

/**
 * The `assignment` check (ADR-0052): while a Worker of an assigned account is refused only for its
 * limit, no Worker of another account of its group takes the work. It compares opaque groups and
 * accounts for equality, and names the limited Worker, never a provider (INV-11).
 */
function assign(workers: readonly CapabilityDescriptor[], failures: Map<string, Failed>, limited: readonly Limited[]): void {
  const holding = limited.filter((l) => l.worker.account?.mode === 'assigned')
  if (!holding.length) return
  for (const worker of workers) {
    const account = worker.account
    if (!account) continue
    const by = holding.filter((l) => l.worker.account!.group === account.group && l.worker.account!.id !== account.id)
    if (!by.length) continue
    const named = by.slice(0, 3).map((l) => `${l.worker.worker} is at its limit${l.until ? ` until ${l.until}` : ''}`).join('; ')
    const failed = failures.get(worker.worker)!
    failed.push({ check: 'assignment', reason: `${named}${by.length > 3 ? ` (and ${by.length - 3} more)` : ''}; assigned accounts do not take another account's work at its limit` })
    failed.sort((a, b) => ADMISSION_CHECKS.indexOf(a.check) - ADMISSION_CHECKS.indexOf(b.check))
  }
}

/**
 * When the work may be tried again (ADR-0052): the earliest known reset, when every Worker refused
 * only for its limit is on an assigned account; undefined when one is not (the limit is someone
 * else's to move around, as before) or none is known.
 */
function waitUntil(limited: readonly Limited[]): string | undefined {
  if (!limited.length || limited.some((l) => l.worker.account?.mode !== 'assigned')) return undefined
  const known = limited.map((l) => l.until).filter((u): u is string => u !== undefined).sort()
  return known[0]
}

/**
 * The input bound a route decision reports (T230): the input's size in characters against the
 * chosen Worker's `maxInputChars`, and the bounds of the other Workers that could take the work but
 * for it, the input refused by every one of them, so a lead reading the decision sees how close
 * the brief came to every bound. Nothing when the caller gave no input size.
 */
function inputBound(chosen: CapabilityDescriptor, workers: readonly CapabilityDescriptor[], failures: ReadonlyMap<string, Failed>, options: RouteOptions): string[] {
  if (!options.input) return []
  const chars = options.input.chars
  const own = chosen.maxInputChars === undefined ? `input ${chars} characters; ${chosen.worker} declares no input bound` : `input ${chars} characters, within its bound of ${chosen.maxInputChars}`
  // The Workers refused for the input alone: the bound is what keeps them from the work.
  const over = workers.filter((w) => failures.get(w.worker)!.length > 0 && failures.get(w.worker)!.every((f) => f.check === 'input'))
  if (!over.length) return [own]
  const largest = Math.max(...over.map((w) => w.maxInputChars!))
  return [own, `over the bound of ${over.length} other Worker(s) that could take it otherwise (the largest ${largest} characters)`]
}

/** A Worker's load as one number: what runs, waits, or is routed to it; a source that reports none reads 0. */
const busy = (w: CapabilityDescriptor): number => (w.load ? w.load.running + w.load.queued + w.load.pending : 0)

/** "load 1 of 2, 1 queued, 1 pending": running against slots, then what waits (ADR-0033). */
function loadOf(load: CapabilityDescriptor['load']): string {
  if (!load) return 'no load reported'
  return [`load ${load.running} of ${load.slots}`, ...(load.queued ? [`${load.queued} queued`] : []), ...(load.pending ? [`${load.pending} pending`] : [])].join(', ')
}

/** Code-point order, independent of locale, so routing is the same on every machine. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export default WorkerRouter
