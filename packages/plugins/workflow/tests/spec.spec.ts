import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATES, type NodeTemplate, parsePlan, preflight, render, resolve } from '../src/spec.ts'
import { TEST_TEMPLATES } from './templates.ts'

const node = (nodeId: string, overrides: Partial<NodeTemplate> = {}): NodeTemplate => ({
  nodeId, objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...overrides,
})

describe('workflow specs', () => {
  it('ships ask (one node); the deep-research test fixture runs research:1 on frontier with Deep research, then compact:1 on economy', () => {
    expect(preflight(DEFAULT_TEMPLATES.ask!)).toEqual(['ask:1'])
    expect(preflight(TEST_TEMPLATES['deep-research']!)).toEqual(['research:1', 'compact:1'])
    expect(TEST_TEMPLATES['deep-research']).toMatchObject([
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
    const research = resolve('deep-research', TEST_TEMPLATES['deep-research']!, { tier: 'economy', sessionId: 'ses_1' })
    // The research steps keep their own tiers; the caller's session continues the research conversation only.
    expect(research.nodes.map((n) => [n.nodeId, n.tier, n.session])).toEqual([['research:1', 'frontier', { sessionId: 'ses_1' }], ['compact:1', 'economy', {}]])
  })

  it('applies a named variant\'s fields to its node, hashes the choice, and refuses a variant the template lacks (PROP-0004)', () => {
    const nodes = [node('a', { variants: { deep: { capabilities: ['reason', 'deep-research'], tier: 'frontier', conversation: 'persistent' } } }), node('b', { dependsOn: ['a'] })]
    const plain = resolve('t', nodes, {})
    const deep = resolve('t', nodes, { variant: 'deep' })
    expect(plain.nodes[0]).toMatchObject({ capabilities: ['reason'], tier: 'standard', session: {} })
    expect(deep.nodes[0]).toMatchObject({ capabilities: ['reason', 'deep-research'], tier: 'frontier', session: { persist: true } })
    expect(deep.nodes[1]).toEqual(plain.nodes[1])
    expect(deep.specHash).not.toBe(plain.specHash)
    expect(JSON.stringify(deep)).not.toContain('variants')
    expect(() => resolve('t', nodes, { variant: 'fast' })).toThrow('template t has no variant fast (it has: deep)')
    expect(() => resolve('ask', DEFAULT_TEMPLATES.ask!, { variant: 'deep' })).toThrow('template ask has no variant deep (it has: none)')
    expect(() => preflight([node('team', { team: { members: 2 }, variants: { deep: { tier: 'frontier' } } })])).toThrow('node team: a team or a planner has no variants')
    expect(() => preflight([node('a', { variants: { deep: { dependsOn: ['b'] } as never } })])).toThrow('node a, variant deep: dependsOn cannot vary')
    expect(() => preflight([node('a', { variants: { Deep: {} } })])).toThrow(/variant name "Deep"/)
  })

  it('records where each value came from, and hashes what was admitted (REQ-WF-2)', () => {
    const nodes = [node('a', { callerTier: true, tier: 'economy' }), node('b', { dependsOn: ['a'] })]
    const asked = resolve('t', nodes, { tier: 'frontier' })
    expect(asked.nodes.map((n) => [n.nodeId, n.tier, n.tierSource])).toEqual([['a', 'frontier', 'caller'], ['b', 'standard', 'profile']])
    const plain = resolve('t', nodes, {})
    expect(plain.nodes[0]).toMatchObject({ tier: 'economy', tierSource: 'profile' })
    expect(plain.specHash).not.toBe(asked.specHash)
    expect(resolve('t', nodes, {}).specHash).toBe(plain.specHash)
  })

  it('renders the caller input and dependency results verbatim', () => {
    expect(render('Q: {{input}}\n<r>{{node:research:1}}</r>', 'why?', { 'research:1': 'a {{input}} b' })).toBe('Q: why?\n<r>a {{input}} b</r>')
  })

  it('lets {{grown}} appear only in nodes that depend on a planner', () => {
    expect(preflight([node('p', { grows: {} }), node('s', { dependsOn: ['p'], prompt: '{{grown}}' })])).toEqual(['p', 's'])
    expect(() => preflight([node('p'), node('s', { dependsOn: ['p'], prompt: '{{grown}}' })])).toThrow(/grown/)
    expect(preflight(TEST_TEMPLATES.investigate!)).toEqual(['plan:1', 'synthesis:1'])
    expect(() => preflight([node('p', { grows: { maxNodes: 99 } })])).toThrow(/grows must be/)
  })

  it('parses a model-written plan as untrusted input, and refuses anything outside the bounds (INV-6)', () => {
    const text = 'Here is the plan:\n```json\n' + JSON.stringify({
      confidence: 'high',
      nodes: [
        { id: 'a', objective: 'first', prompt: 'do a', capabilities: ['reason'], tier: 'economy' },
        { id: 'b', objective: 'second', prompt: 'do b', capabilities: ['reason'], tier: 'standard', dependsOn: ['a'] },
      ],
    }) + '\n```'
    const plan = parsePlan(text, 'plan:1', { maxNodes: 3, capabilities: ['reason'] })
    expect(plan).toEqual({ ok: true, confidence: 'high', nodes: [
      { nodeId: 'plan:1:a', objective: 'first', prompt: 'do a', capabilities: ['reason'], tier: 'economy', dependsOn: [] },
      { nodeId: 'plan:1:b', objective: 'second', prompt: 'do b', capabilities: ['reason'], tier: 'standard', dependsOn: ['plan:1:a'] },
    ] })
    const bad = (nodes: unknown[], extra = {}) => parsePlan(JSON.stringify({ confidence: 'low', nodes }), 'plan:1', { maxNodes: 2, capabilities: ['reason'], ...extra })
    const step = (id: string, more = {}) => ({ id, objective: 'o', prompt: 'p', capabilities: ['reason'], tier: 'economy', ...more })
    expect(parsePlan('no plan here', 'plan:1', { maxNodes: 2, capabilities: ['reason'] })).toMatchObject({ ok: false, reason: expect.stringMatching(/no JSON plan/) })
    expect(bad([step('a'), step('b'), step('c')])).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 2/) })
    expect(bad([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })])).toMatchObject({ ok: false, reason: expect.stringMatching(/cycle/) })
    expect(bad([step('a', { dependsOn: ['synthesis:1'] })])).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown/) })
    expect(bad([step('a', { capabilities: ['develop'] })])).toMatchObject({ ok: false, reason: expect.stringMatching(/develop/) })
    expect(bad([step('a'), step('a')])).toMatchObject({ ok: false, reason: expect.stringMatching(/duplicate/) })
    expect(bad([step('a', { tier: 'ultra' })])).toMatchObject({ ok: false })
  })

  it('unrolls a team into independent first-round members, critique rounds behind a barrier, and a synthesis under the team\'s id', () => {
    const team = node('panel', { prompt: '{{input}}', team: { members: 2, rounds: 2 } })
    const spec = resolve('t', [team, node('after', { dependsOn: ['panel'], prompt: '{{node:panel}}' })], {})
    expect(spec.nodes.map((n) => [n.nodeId, n.dependsOn])).toEqual([
      ['panel:m1:r1', []], ['panel:m2:r1', []],
      ['panel:m1:r2', ['panel:m1:r1', 'panel:m2:r1']], ['panel:m2:r2', ['panel:m1:r1', 'panel:m2:r1']],
      ['panel', ['panel:m1:r2', 'panel:m2:r2']],
      ['after', ['panel']],
    ])
    // Round 1 never sees a peer; later rounds read the peers; the synthesis reads every member.
    expect(spec.nodes[0]!.prompt).not.toContain('{{inbox}}')
    expect(spec.nodes[2]!.prompt).toContain('{{inbox}}')
    expect(spec.nodes[4]!.prompt).toContain('{{members}}')
    expect(spec.nodes[0]!.session).toEqual({ member: 'panel:m1' })
    expect(spec.nodes[2]!.session).toEqual({ member: 'panel:m1' })
    expect(spec.nodes[0]!.team).toMatchObject({ id: 'panel', role: 'member', member: 1, round: 1, members: 2, distinct: true })
    expect(spec.nodes[4]).toMatchObject({ acceptance: 'acceptance.team-synthesis', team: { role: 'synthesis' } })
    expect(() => preflight([node('t', { team: { members: 1 } })])).toThrow(/team/)
    expect(() => preflight([node('t', { team: { members: 2, rounds: 9 } })])).toThrow(/team/)
    expect(preflight(DEFAULT_TEMPLATES.panel!)).toEqual(['panel'])
  })

  it('puts a lead between rounds: the next round waits for its decision; it reads the members and answers nothing', () => {
    const spec = resolve('t', [node('panel', { prompt: '{{input}}', team: { members: 2, rounds: 2, lead: {} } })], {})
    expect(spec.nodes.map((n) => [n.nodeId, n.dependsOn])).toEqual([
      ['panel:m1:r1', []], ['panel:m2:r1', []],
      ['panel:lead:1', ['panel:m1:r1', 'panel:m2:r1']],
      ['panel:m1:r2', ['panel:m1:r1', 'panel:m2:r1', 'panel:lead:1']], ['panel:m2:r2', ['panel:m1:r1', 'panel:m2:r1', 'panel:lead:1']],
      ['panel', ['panel:m1:r2', 'panel:m2:r2']],
    ])
    expect(spec.nodes[2]).toMatchObject({ tier: 'economy', capabilities: ['reason'], acceptance: 'acceptance.team-lead', session: {}, team: { role: 'lead', round: 1 } })
    expect(spec.nodes[2]!.prompt).toContain('{{members}}')
    expect(() => preflight([node('t', { team: { members: 2, lead: { tier: 'huge' as never } } })])).toThrow(/lead/)
  })
})
