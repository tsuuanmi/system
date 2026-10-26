// Tier by risk (ADR-0073): the policy's map gives a board task's step a tier at its task's risk tier,
// by the step's capability or kind of work; pure.
import { describe, expect, it } from 'vitest'
import { stepTierByRisk, type TierByRisk, tierByRiskProblems, type TierByRiskOf } from '../src/index.ts'

const studio: TierByRiskOf = { policy: { id: 'studio', version: 3 }, map: { version: 1, heavy: { develop: 'frontier', review: 'frontier' }, light: { validate: 'economy', docs: 'economy' } } }

describe('tier by risk (ADR-0073)', () => {
  it('gives a step the tier its capability or kind maps to under its task\'s risk tier, and nothing when no entry names it', () => {
    expect(stepTierByRisk([studio], 'heavy', { capabilities: ['develop', 'persistent-conversation'] })).toEqual({
      tier: 'frontier', matched: [{ policy: { id: 'studio', version: 3 }, version: 1, key: 'develop', tier: 'frontier' }],
    })
    expect(stepTierByRisk([studio], 'light', { capabilities: ['develop'], kind: 'docs' })?.tier).toBe('economy')
    expect(stepTierByRisk([studio], 'light', { capabilities: ['validate'] })?.tier).toBe('economy')
    expect(stepTierByRisk([studio], 'normal', { capabilities: ['develop'] })).toBeUndefined()
    expect(stepTierByRisk([studio], 'heavy', { capabilities: ['reason'], kind: 'docs' })).toBeUndefined()
    expect(stepTierByRisk([], 'heavy', { capabilities: ['develop'] })).toBeUndefined()
  })

  it('takes the highest tier every applying map gives, a project\'s map beside the studio\'s', () => {
    const project: TierByRiskOf = { policy: { id: 'p1', version: 1 }, map: { version: 4, light: { docs: 'standard' } } }
    const step = stepTierByRisk([studio, project], 'light', { capabilities: ['develop'], kind: 'docs' })
    expect(step).toEqual({ tier: 'standard', matched: [{ policy: { id: 'studio', version: 3 }, version: 1, key: 'docs', tier: 'economy' }, { policy: { id: 'p1', version: 1 }, version: 4, key: 'docs', tier: 'standard' }] })
  })

  it('refuses a map that is not versioned, names a risk tier or a tier that is none, or a key that is no capability or kind', () => {
    expect(tierByRiskProblems(studio.map)).toEqual([])
    expect(tierByRiskProblems({ heavy: { develop: 'frontier' } })).toEqual(['tierByRisk.version is an integer of at least 1'])
    expect(tierByRiskProblems({ version: 1, severe: { develop: 'frontier' } })).toEqual(['tierByRisk.severe is not a risk tier (light, normal, heavy)'])
    expect(tierByRiskProblems({ version: 1, heavy: { develop: 'premium' } })).toEqual(['tierByRisk.heavy.develop is "premium", not a tier (economy, standard, frontier)'])
    expect(tierByRiskProblems({ version: 1, heavy: { Develop: 'frontier' } })).toEqual([expect.stringMatching(/^tierByRisk\.heavy\.Develop is not a capability or kind of work/)])
    expect(tierByRiskProblems({ version: 1, heavy: {} })).toEqual(['tierByRisk.heavy maps 1 to 32 capabilities or kinds of work to a tier'])
    expect(tierByRiskProblems([] as unknown as TierByRisk)).toHaveLength(1)
  })
})
