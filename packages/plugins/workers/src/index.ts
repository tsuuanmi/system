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
import { extractJson, SchemaRegistry } from '@tsuuanmi/system-libs'
import {
  type Acceptance, type AcceptanceContract, type AdmissionCheck, AdmissionFailure, type AdmittedWorker, type ArtifactRef, type CapabilityDescriptor, type QuotaClass,
  type Rejection, type RouteOptions, TIERS, type Tier, type WorkRequirement, type WorkerSource, Workers,
} from '@tsuuanmi/system-workers-core'

export * from '@tsuuanmi/system-workers-core'

export interface Config {
  /** Quota classes in order of preference when the requirement states none (REQ-WRK-8). */
  quotaPreference?: QuotaClass[]
  /** Worker ids preferred, in order, after tier and quota class; then the stable id decides. */
  priority?: string[]
}

const QUOTA_CLASSES: QuotaClass[] = ['subscription-chat', 'local', 'agent-plan', 'metered']
const DECIDER = { type: 'policy', id: 'workers.route.deterministic', version: '1' } as const
/** How long one source may take to describe its Workers inside the routing lock (ADR-0033). */
const DESCRIBE_MS = 5000

const textOf = (body: unknown): string => {
  const text = (body as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : ''
}

/** Contracts every deployment has; a plugin adds its own with `contract()`. */
const BUILT_IN: Record<string, AcceptanceContract> = {
  'acceptance.answer': ({ body }) => (textOf(body).trim()
    ? { accepted: true, reasons: ['the answer has text'] }
    : { accepted: false, reasons: ['the answer is empty'] }),
  'acceptance.cited': ({ body }) => {
    const text = textOf(body)
    if (!text.trim()) return { accepted: false, reasons: ['the answer is empty'] }
    const links = new Set((text.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, ''))).size
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

  private readonly sources = new Map<string, WorkerSource>()
  private readonly registered = new Map<string, AcceptanceContract>(Object.entries(BUILT_IN))
  private readonly schemas = new SchemaRegistry()
  /** One route at a time, across every caller, so no two read the same load (ADR-0033). */
  private routing: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx)
  }

  register(source: WorkerSource): void {
    if (this.sources.has(source.name)) throw new Error(`Worker source ${source.name} is already registered`)
    this.ctx.effect(() => {
      this.sources.set(source.name, source)
      return () => {
        if (this.sources.get(source.name) === source) this.sources.delete(source.name)
      }
    })
  }

  source(name: string): WorkerSource | undefined {
    return this.sources.get(name)
  }

  affinity(sessionId: string): string[] | undefined {
    for (const source of this.sources.values()) {
      const workers = source.affinity?.(sessionId)
      if (workers) return workers
    }
    return undefined
  }

  handle(sessionId: string): string | undefined {
    for (const source of this.sources.values()) {
      const handle = source.handle?.(sessionId)
      if (handle) return handle
    }
    return undefined
  }

  reset(sessionId: string): boolean {
    for (const source of this.sources.values()) if (source.reset?.(sessionId)) return true
    return false
  }

  release(sessionIds: readonly string[], reason: string): { due: number } {
    let due = 0
    if (sessionIds.length) for (const source of this.sources.values()) due += source.release?.(sessionIds, reason).due ?? 0
    return { due }
  }

  async list(): Promise<CapabilityDescriptor[]> {
    return (await this.described()).all.map((d) => d.worker)
  }

  /**
   * Every Worker with the name of its source, validated and ordered by id. A source that does not
   * describe its Workers within `DESCRIBE_MS` counts as describing none (`silent`), so one stuck
   * source never holds every route behind the routing lock.
   */
  private async described(): Promise<{ all: Array<{ worker: CapabilityDescriptor; source: string }>; silent: string[] }> {
    const silent: string[] = []
    const described = await Promise.all([...this.sources.values()].map(async (source) => {
      const done = new AbortController()
      const late = delay(DESCRIBE_MS, undefined, { signal: done.signal }).catch(() => undefined)
      const workers = await Promise.race([source.describe(), late]).finally(() => done.abort())
      if (!workers) silent.push(source.name)
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

  async route(requirement: WorkRequirement, options: RouteOptions = {}): Promise<AdmittedWorker> {
    const turn = this.routing.then(() => this.routeNow(requirement, options))
    this.routing = turn.catch(() => undefined)
    return turn
  }

  private async routeNow(requirement: WorkRequirement, options: RouteOptions): Promise<AdmittedWorker> {
    this.schemas.assertRecord(requirement)
    const { all: described, silent } = await this.described()
    const workers = described.map((d) => d.worker)
    // A source that did not answer in time is named in the decision, as a candidate it could not offer.
    const unheard = silent.map((name) => ({ option: `source ${name}`, selected: false, reasons: [`did not describe its Workers within ${DESCRIBE_MS / 1000} s`] }))
    const producer = { type: 'system' as const, ref: options.producer ?? 'workers' }
    const stored = this.ctx.artifacts.put({
      kind: 'objective', bodySchema: 'work-requirement@1.0', body: requirement, classification: requirement.data.classification, producer,
    })
    const requirementRef = stored.id as ArtifactRef
    const failures = new Map(workers.map((w) => [w.worker, this.admit(w, requirement, options)]))
    const admitted = workers.filter((w) => failures.get(w.worker)!.length === 0).sort(this.order(requirement))
    const chosen = admitted[0]
    if (!chosen) {
      const rejections: Rejection[] = workers.map((w) => ({ worker: w.worker, state: w.state, failed: failures.get(w.worker)! }))
      // A capability no Worker proves now is the plainest reason, for example website-only work in a composition without website Workers.
      const unproven = requirement.capabilities.filter((c) => !workers.some((w) => w.capabilities.some((p) => p.capability === c)))
      const why = unproven.length ? `no Worker proves ${unproven.join(', ')}` : workers.length ? 'no Worker passes admission' : 'no Worker is registered'
      const decision = this.ctx.artifacts.recordDecision({
        decisionType: 'admission',
        question: `Which Worker may take work needing ${requirement.capabilities.join(', ')} at tier ${requirement.tier.min} or above?`,
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
      throw new AdmissionFailure(rejections, decision.id as ArtifactRef, `no Worker can take this work: ${why} (${summary ? `${summary}; ` : ''}decision ${decision.id})`)
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
      question: `Which Worker runs work needing ${requirement.capabilities.join(', ')}?`,
      inputs: [requirementRef, tier.id],
      candidates: [...workers.map((w) => {
        if (w === chosen) return { option: w.worker, selected: true, reasons: this.chosenReasons(w, requirement) }
        const failed = failures.get(w.worker)!
        return { option: w.worker, selected: false, reasons: failed.length ? failed.map((f) => f.reason) : [`admitted; ${this.lostTo(w, chosen, requirement)}`] }
      }), ...unheard],
      decider: DECIDER,
      outcome: { option: chosen.worker },
      deterministic: true,
    }, { producer, classification: requirement.data.classification })
    const source = described.find((d) => d.worker === chosen)!.source
    // Counted as pending on the chosen Worker until the caller starts the work, or gives it up.
    let held = this.sources.get(source)?.reserve?.(chosen.worker)
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
        { option: 'accept', selected: verdict.accepted, reasons: verdict.accepted ? verdict.reasons : [] },
        { option: 'reject', selected: !verdict.accepted, reasons: verdict.accepted ? [] : verdict.reasons },
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
    const proven = new Set(worker.capabilities.map((c) => c.capability))
    const missing = requirement.capabilities.filter((c) => !proven.has(c))
    if (missing.length) fail('capability', `does not prove ${missing.join(', ')}`)
    // A site's usage limit on a capability the work needs (ADR-0034); a lapsed one no longer counts.
    const now = Date.now()
    const cooled = (worker.cooldowns ?? []).filter((c) => requirement.capabilities.includes(c.capability) && Date.parse(c.until) > now)
    if (cooled.length) fail('cooldown', cooled.map((c) => `${c.capability} limit until ${c.until}`).join(', '))
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

  /** Lowest tier, then quota class preference, then least busy, then configured priority, then stable id. */
  private order(requirement: WorkRequirement): (a: CapabilityDescriptor, b: CapabilityDescriptor) => number {
    return (a, b) => {
      for (const key of this.keys(requirement)) {
        const difference = key(a) - key(b)
        if (difference) return difference
      }
      return compare(a.worker, b.worker)
    }
  }

  private keys(requirement: WorkRequirement): Array<(w: CapabilityDescriptor) => number> {
    const quota = this.quotaOrder(requirement)
    const priority = this.config.priority ?? []
    const rankOf = (list: readonly string[], value: string): number => (list.includes(value) ? list.indexOf(value) : list.length)
    return [(w) => TIERS.indexOf(w.tier), (w) => rankOf(quota, w.quotaClass), busy, (w) => rankOf(priority, w.worker)]
  }

  private quotaOrder(requirement: WorkRequirement): QuotaClass[] {
    const preferred = requirement.budget?.preferQuota ?? []
    const rest = (this.config.quotaPreference ?? QUOTA_CLASSES).filter((q) => !preferred.includes(q))
    return [...preferred, ...rest]
  }

  private chosenReasons(worker: CapabilityDescriptor, requirement: WorkRequirement): string[] {
    const reasons = [`proves ${requirement.capabilities.join(', ')}`, `lowest admissible tier ${worker.tier}`, `quota class ${worker.quotaClass}`]
    if (worker.load) reasons.push(loadOf(worker.load))
    if ((this.config.priority ?? []).includes(worker.worker)) reasons.push('first in the configured priority list')
    return reasons
  }

  /** Why an admitted Worker ordered after the chosen one: the first ordering key that differs. */
  private lostTo(worker: CapabilityDescriptor, chosen: CapabilityDescriptor, requirement: WorkRequirement): string {
    const [tier, quota, load, priority] = this.keys(requirement)
    if (tier!(worker) !== tier!(chosen)) return `${chosen.worker} has the lower tier ${chosen.tier}`
    if (quota!(worker) !== quota!(chosen)) return `${chosen.worker} has the preferred quota class ${chosen.quotaClass}`
    if (load!(worker) !== load!(chosen)) return `${chosen.worker} is less busy (${loadOf(chosen.load)}; this one ${loadOf(worker.load)})`
    if (priority!(worker) !== priority!(chosen)) return `${chosen.worker} comes first in the configured priority list`
    return `${chosen.worker} comes first by id`
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
