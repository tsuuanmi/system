/**
 * `ctx.workers`: the Worker registry, fail-closed admission, and the deterministic router
 * (docs/design/routing.md#algorithm). Sources describe their Workers on every route, so
 * admission sees current states; the router never branches on a provider (INV-11). Every
 * outcome is a decision artifact listing every candidate and why (INV-13).
 * @module @tsuuanmi/system-workers
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import {
  type AdmissionCheck, AdmissionFailure, type AdmittedWorker, type ArtifactRef, type CapabilityDescriptor, type QuotaClass,
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

type Failed = Rejection['failed']

export class WorkerRouter extends Workers {
  static inject = ['artifacts']

  static Config: z<Config> = z.object({
    quotaPreference: z.array(z.union(QUOTA_CLASSES)).default(QUOTA_CLASSES).description('Quota classes in order of preference'),
    priority: z.array(z.string()).default([]).description('Worker ids preferred, in order, after tier and quota class'),
  })

  private readonly sources = new Map<string, WorkerSource>()
  private readonly schemas = new SchemaRegistry()

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

  async list(): Promise<CapabilityDescriptor[]> {
    const described = await Promise.all([...this.sources.values()].map(async (source) => ({ source: source.name, workers: await source.describe() })))
    const seen = new Map<string, string>()
    const all: CapabilityDescriptor[] = []
    for (const { source, workers } of described) {
      for (const worker of workers) {
        this.schemas.assertRecord(worker)
        const other = seen.get(worker.worker)
        if (other) throw new Error(`Worker ${worker.worker} is described by both ${other} and ${source}`)
        seen.set(worker.worker, source)
        all.push(worker)
      }
    }
    return all.sort((a, b) => compare(a.worker, b.worker))
  }

  async route(requirement: WorkRequirement, options: RouteOptions = {}): Promise<AdmittedWorker> {
    this.schemas.assertRecord(requirement)
    const workers = await this.list()
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
      const decision = this.ctx.artifacts.recordDecision({
        decisionType: 'admission',
        question: `Which Worker may take work needing ${requirement.capabilities.join(', ')} at tier ${requirement.tier.min} or above?`,
        inputs: [requirementRef],
        candidates: [
          ...rejections.map((r) => ({ option: r.worker, selected: false, reasons: r.failed.map((f) => f.reason) })),
          { option: 'none', selected: true, reasons: [workers.length ? 'no Worker passes admission' : 'no Worker is registered'] },
        ],
        decider: DECIDER,
        outcome: { option: 'none' },
        deterministic: true,
      }, { producer, classification: requirement.data.classification })
      const summary = rejections.map((r) => `${r.worker}: ${r.failed.map((f) => f.reason).join(', ')}`).join('; ') || 'no Worker is registered'
      throw new AdmissionFailure(rejections, decision.id as ArtifactRef, `no Worker can take this work (${summary}; decision ${decision.id})`)
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
      candidates: workers.map((w) => {
        if (w === chosen) return { option: w.worker, selected: true, reasons: this.chosenReasons(w, requirement) }
        const failed = failures.get(w.worker)!
        return { option: w.worker, selected: false, reasons: failed.length ? failed.map((f) => f.reason) : [`admitted; ${this.lostTo(w, chosen, requirement)}`] }
      }),
      decider: DECIDER,
      outcome: { option: chosen.worker },
      deterministic: true,
    }, { producer, classification: requirement.data.classification })
    return { worker: chosen, requirement: requirementRef, decisions: { tier: tier.id as ArtifactRef, route: route.id as ArtifactRef } }
  }

  /** Every failed admission check, in the design's order; empty means admitted (REQ-WRK-1, -7, -9). */
  private admit(worker: CapabilityDescriptor, requirement: WorkRequirement, options: RouteOptions): Failed {
    const failed: Failed = []
    const fail = (check: AdmissionCheck, reason: string): void => {
      failed.push({ check, reason })
    }
    if (options.restrict && !options.restrict.workers.includes(worker.worker)) fail('restricted', options.restrict.reason)
    const proven = new Set(worker.capabilities.map((c) => c.capability))
    const missing = requirement.capabilities.filter((c) => !proven.has(c))
    if (missing.length) fail('capability', `does not prove ${missing.join(', ')}`)
    if (requirement.data.classification === 'local-private' && worker.locality !== 'local') fail('locality', 'local-private data stays on local Workers')
    if (worker.state !== 'ready') fail('state', `state ${worker.state}`)
    const rank = TIERS.indexOf(worker.tier)
    if (rank < TIERS.indexOf(requirement.tier.min)) fail('tier', `tier ${worker.tier} is below the minimum ${requirement.tier.min}`)
    else if (requirement.tier.max && rank > TIERS.indexOf(requirement.tier.max)) fail('tier', `tier ${worker.tier} is above the maximum ${requirement.tier.max}`)
    return failed
  }

  /** Lowest tier, then quota class preference, then configured priority, then stable id. */
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
    return [(w) => TIERS.indexOf(w.tier), (w) => rankOf(quota, w.quotaClass), (w) => rankOf(priority, w.worker)]
  }

  private quotaOrder(requirement: WorkRequirement): QuotaClass[] {
    const preferred = requirement.budget?.preferQuota ?? []
    const rest = (this.config.quotaPreference ?? QUOTA_CLASSES).filter((q) => !preferred.includes(q))
    return [...preferred, ...rest]
  }

  private chosenReasons(worker: CapabilityDescriptor, requirement: WorkRequirement): string[] {
    const reasons = [`proves ${requirement.capabilities.join(', ')}`, `lowest admissible tier ${worker.tier}`, `quota class ${worker.quotaClass}`]
    if ((this.config.priority ?? []).includes(worker.worker)) reasons.push('first in the configured priority list')
    return reasons
  }

  /** Why an admitted Worker ordered after the chosen one: the first ordering key that differs. */
  private lostTo(worker: CapabilityDescriptor, chosen: CapabilityDescriptor, requirement: WorkRequirement): string {
    const [tier, quota, priority] = this.keys(requirement)
    if (tier!(worker) !== tier!(chosen)) return `${chosen.worker} has the lower tier ${chosen.tier}`
    if (quota!(worker) !== quota!(chosen)) return `${chosen.worker} has the preferred quota class ${chosen.quotaClass}`
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

/** Code-point order, independent of locale, so routing is the same on every machine. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export default WorkerRouter
