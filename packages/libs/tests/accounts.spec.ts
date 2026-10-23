import { describe, expect, it } from 'vitest'
import { accountSettings, ASSIGNED, pooledTermsDecision, SchemaRegistry } from '../src/index.ts'

const TERMS = { confirmedBy: 'operator', confirmedAt: '2026-10-24T09:00:00+07:00', terms: 'Team plan terms, section 3, read 2026-10-24' }

describe('account settings per provider (ADR-0052)', () => {
  it('is assigned by default, for a provider no entry names and one that names no mode', () => {
    const settings = accountSettings([{ provider: 'a' }], 'accounts.providers')
    expect(settings.get('a')).toEqual({ mode: 'assigned' })
    expect(settings.get('b') ?? ASSIGNED).toEqual({ mode: 'assigned' })
    expect(accountSettings(undefined, 'x').size).toBe(0)
  })

  it('refuses pooled without whole terms, naming the place, and keeps them when given', () => {
    expect(() => accountSettings([{ provider: 'a', accounts: 'pooled' }], 'accounts.providers')).toThrow(/accounts\.providers\[0\]: a is pooled, and no pooledTerms/)
    // An omitted object can come back empty from a configuration schema: it is no terms.
    expect(() => accountSettings([{ provider: 'a', accounts: 'pooled', pooledTerms: {} }], 'p')).toThrow(/no pooledTerms/)
    expect(() => accountSettings([{ provider: 'a', accounts: 'pooled', pooledTerms: { ...TERMS, confirmedAt: 'yesterday' } }], 'p')).toThrow(/p\[0\]\.pooledTerms\.confirmedAt/)
    expect(() => accountSettings([{ provider: 'a', accounts: 'pooled', pooledTerms: { ...TERMS, terms: ' ' } }], 'p')).toThrow(/terms/)
    expect(accountSettings([{ provider: 'a', accounts: 'pooled', pooledTerms: TERMS }], 'p').get('a')).toEqual({ mode: 'pooled', pooledTerms: TERMS })
    // Terms recorded for an assigned provider change nothing.
    expect(accountSettings([{ provider: 'a', pooledTerms: TERMS }], 'p').get('a')).toEqual({ mode: 'assigned', pooledTerms: TERMS })
  })

  it('refuses a provider named twice, or a mode that is neither', () => {
    expect(() => accountSettings([{ provider: 'a' }, { provider: 'a' }], 'p')).toThrow(/p\[1\]\.provider: a is configured twice/)
    expect(() => accountSettings([{ provider: 'a', accounts: 'rotating' as never }], 'p')).toThrow(/neither assigned nor pooled/)
  })

  it('records a pooled provider\'s terms as a valid gate decision, the same terms the same decision', () => {
    const decision = pooledTermsDecision('a', TERMS, 'turns.pooled-terms')
    new SchemaRegistry().assert('decision@1.0', { schema: 'decision@1.0', ...decision })
    expect(decision.outcome).toEqual({ option: 'pooled', detail: { provider: 'a', ...TERMS } })
    expect(pooledTermsDecision('a', TERMS, 'turns.pooled-terms')).toEqual(decision)
    expect(pooledTermsDecision('a', { ...TERMS, terms: 'other' }, 'turns.pooled-terms').decider.hash).not.toBe(decision.decider.hash)
  })
})
