import { describe, expect, it } from 'vitest'
import { applicable, defineSuite, runSuite, type Scenario } from '../conformance/runner.ts'

type Boot = () => number
const pass = (id: string, since: `${number}.${number}`): Scenario<Boot> => ({ id, since, title: id, run: async () => {} })

describe('the conformance runner (ADR-0037)', () => {
  it('refuses a suite whose scenario ids are not its seam\'s, repeat, or are newer than the suite', () => {
    expect(() => defineSuite({ seam: 's', contract: '1.0', scenarios: [pass('t.a', '1.0')] })).toThrow(/not named under s\./)
    expect(() => defineSuite({ seam: 's', contract: '1.0', scenarios: [pass('s.a', '1.0'), pass('s.a', '1.0')] })).toThrow(/duplicate/)
    expect(() => defineSuite({ seam: 's', contract: '1.1', scenarios: [pass('s.a', '1.2')] })).toThrow(/newer/)
  })

  it('runs for a pinned contract the scenarios since then, and refuses another major or a newer minor', () => {
    const suite = defineSuite({ seam: 's', contract: '1.2', scenarios: [pass('s.a', '1.0'), pass('s.b', '1.1'), pass('s.c', '1.2')] })
    expect(applicable(suite, '1.0').map((s) => s.id)).toEqual(['s.a'])
    expect(applicable(suite, '1.1').map((s) => s.id)).toEqual(['s.a', 's.b'])
    expect(applicable(suite, '1.2').map((s) => s.id)).toEqual(['s.a', 's.b', 's.c'])
    expect(() => applicable(suite, '2.0')).toThrow(/another major/)
    expect(() => applicable(suite, '1.3')).toThrow(/newer than this suite/)
  })

  it('refuses a baseline that names no applicable scenario', () => {
    const suite = defineSuite({ seam: 's', contract: '1.1', scenarios: [pass('s.a', '1.0'), pass('s.b', '1.1')] })
    expect(() => runSuite(suite, { name: 'p', contract: '1.0', boot: () => 0, expectedFailures: { 's.b': 'not yet' } })).toThrow(/baseline names s\.b/)
  })
})

// A baselined scenario that still fails is reported as expected, so the run stays green; were it to
// pass, vitest's `it.fails` would fail the run and the baseline entry would have to go.
runSuite(defineSuite({
  seam: 'meta', contract: '1.0',
  scenarios: [
    pass('meta.passes', '1.0'),
    { id: 'meta.known-gap', since: '1.0', title: 'a known gap', run: async () => { throw new Error('the gap') } },
  ],
}), { name: 'a provider with a known gap', contract: '1.0', boot: () => 0, expectedFailures: { 'meta.known-gap': 'tracked in the roadmap' } })
