import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATES, type NodeTemplate, preflight, render, resolve } from '../src/spec.ts'

const node = (nodeId: string, overrides: Partial<NodeTemplate> = {}): NodeTemplate => ({
  nodeId, objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...overrides,
})

describe('workflow specs', () => {
  it('ships ask (one node) and research (research:1 on frontier with Deep research → compact:1 on economy)', () => {
    expect(preflight(DEFAULT_TEMPLATES.ask!)).toEqual(['ask:1'])
    expect(preflight(DEFAULT_TEMPLATES.research!)).toEqual(['research:1', 'compact:1'])
    expect(DEFAULT_TEMPLATES.research).toMatchObject([
      { nodeId: 'research:1', capabilities: ['reason', 'deep-research'], tier: 'frontier', conversation: 'persistent', acceptance: 'acceptance.answer' },
      { nodeId: 'compact:1', dependsOn: ['research:1'], capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer' },
    ])
  })

  it('refuses invalid DAGs before anything runs (REQ-WF-1)', () => {
    expect(() => preflight([])).toThrow(/no nodes/)
    expect(() => preflight([node('a'), node('a')])).toThrow(/duplicate node a/)
    expect(() => preflight([node('a', { dependsOn: ['b'] })])).toThrow(/unknown node b/)
    expect(() => preflight([node('a', { dependsOn: ['b'] }), node('b', { dependsOn: ['a'] })])).toThrow(/cycle/)
    expect(() => preflight([node('a'), node('b', { prompt: '{{node:a}}' })])).toThrow(/b uses a, which it does not depend on/)
    expect(() => preflight([node('bad id!')])).toThrow(/node id/)
    expect(() => preflight([node('a'), node('b', { dependsOn: ['a'] }), node('c')])).toThrow(/one final node/)
  })

  it('resolves caller options into a spec with a stable hash', () => {
    const one = resolve('ask', DEFAULT_TEMPLATES.ask!, { tier: 'frontier', persist: true })
    expect(one.nodes[0]).toMatchObject({ nodeId: 'ask:1', tier: 'frontier', session: { persist: true } })
    expect(resolve('ask', DEFAULT_TEMPLATES.ask!, { tier: 'frontier', persist: true }).specHash).toBe(one.specHash)
    expect(resolve('ask', DEFAULT_TEMPLATES.ask!, {}).specHash).not.toBe(one.specHash)
    const research = resolve('research', DEFAULT_TEMPLATES.research!, { tier: 'economy', sessionId: 'ses_1' })
    // The research steps keep their own tiers; the caller's session continues the research conversation only.
    expect(research.nodes.map((n) => [n.nodeId, n.tier, n.session])).toEqual([['research:1', 'frontier', { sessionId: 'ses_1' }], ['compact:1', 'economy', {}]])
  })

  it('renders the caller input and dependency results verbatim', () => {
    expect(render('Q: {{input}}\n<r>{{node:research:1}}</r>', 'why?', { 'research:1': 'a {{input}} b' })).toBe('Q: why?\n<r>a {{input}} b</r>')
  })
})
