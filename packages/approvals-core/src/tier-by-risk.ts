/**
 * Tier by risk (ADR-0073): the autonomy policy's `tierByRisk` map gives the intelligence tier a board
 * task's step takes at its task's risk tier (ADR-0071), by the step's capability (`develop`,
 * `review`, `validate`) or kind of work (`docs`), such as heavy → frontier for develop and review,
 * light → economy for validate and docs. Pure: no store, no clock. The map is configuration, named
 * by its version in the decision that applies it; it never names a model or a vendor (INV-11).
 */
import { RISK_TIERS, type RiskTier } from './risk-tiers.ts'

/** An intelligence tier (`common@1` `tier`), lowest first. */
export type IntelligenceTier = 'economy' | 'standard' | 'frontier'
export const INTELLIGENCE_TIERS: readonly IntelligenceTier[] = ['economy', 'standard', 'frontier']

/** A policy's map (`autonomy-policy@1.2` `tierByRisk`): under each risk tier, a step's capability or kind mapped to its tier. */
export interface TierByRisk {
  version: number
  light?: Record<string, IntelligenceTier>
  normal?: Record<string, IntelligenceTier>
  heavy?: Record<string, IntelligenceTier>
}

/** A policy that carries a map, as the decision that applies it names it. */
export interface TierByRiskOf {
  policy: { id: string; version: number }
  map: TierByRisk
}

/** The most entries one risk tier of a map holds (INV-9). */
export const TIER_BY_RISK_BOUNDS = { entries: 32 } as const
/** A key: a capability (`develop`, `connector:<name>`) or a kind of work (`docs`). */
const KEY = /^[a-z][a-z0-9:-]{0,63}$/

/** Every problem of a map, in order; empty when it loads. */
export function tierByRiskProblems(map: unknown): string[] {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return ['tierByRisk is an object with a version and, under light, normal, or heavy, the tier of each capability or kind of work']
  const problems: string[] = []
  const given = map as Record<string, unknown>
  if (!Number.isInteger(given.version) || (given.version as number) < 1) problems.push('tierByRisk.version is an integer of at least 1')
  for (const key of Object.keys(given)) if (key !== 'version' && !RISK_TIERS.includes(key as RiskTier)) problems.push(`tierByRisk.${key} is not a risk tier (${RISK_TIERS.join(', ')})`)
  for (const risk of RISK_TIERS) {
    const entries = given[risk]
    if (entries === undefined) continue
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries) || !Object.keys(entries).length || Object.keys(entries).length > TIER_BY_RISK_BOUNDS.entries) {
      problems.push(`tierByRisk.${risk} maps 1 to ${TIER_BY_RISK_BOUNDS.entries} capabilities or kinds of work to a tier`)
      continue
    }
    for (const [key, tier] of Object.entries(entries)) {
      if (!KEY.test(key)) problems.push(`tierByRisk.${risk}.${key} is not a capability or kind of work (${KEY})`)
      if (!INTELLIGENCE_TIERS.includes(tier as IntelligenceTier)) problems.push(`tierByRisk.${risk}.${key} is ${JSON.stringify(tier)}, not a tier (${INTELLIGENCE_TIERS.join(', ')})`)
    }
  }
  return problems
}

/** One entry that matched a step: the policy and map version, the key (a capability or the kind), and its tier. */
export interface TierByRiskMatch {
  policy: { id: string; version: number }
  version: number
  key: string
  tier: IntelligenceTier
}

/** What the maps give a step at a risk tier: the highest tier its entries give, and every entry that matched. */
export interface StepTierByRisk {
  tier: IntelligenceTier
  matched: TierByRiskMatch[]
}

/**
 * The tier the maps give a step at its task's risk tier: the highest of the entries under that risk
 * tier whose key is one of the step's capabilities or its kind, across the maps (the studio's, then the
 * project's). Undefined when no entry matches (the step keeps its own tier).
 */
export function stepTierByRisk(maps: readonly TierByRiskOf[], risk: RiskTier, step: { capabilities: readonly string[]; kind?: string | undefined }): StepTierByRisk | undefined {
  const matched: TierByRiskMatch[] = []
  for (const { policy, map } of maps) {
    for (const [key, tier] of Object.entries(map[risk] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (step.capabilities.includes(key) || step.kind === key) matched.push({ policy, version: map.version, key, tier })
    }
  }
  if (!matched.length) return undefined
  const tier = matched.reduce<IntelligenceTier>((t, m) => (INTELLIGENCE_TIERS.indexOf(m.tier) > INTELLIGENCE_TIERS.indexOf(t) ? m.tier : t), matched[0]!.tier)
  return { tier, matched }
}
