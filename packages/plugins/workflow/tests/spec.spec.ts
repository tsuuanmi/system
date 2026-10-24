import { describe, expect, it } from 'vitest'
import { type Brief, NO_LOCAL_SANDBOX, renderBrief } from '@tsuuanmi/system-libs'
import { appended, compose, DEFAULT_TEMPLATES, type NodeTemplate, parsePlan, preflight, resolve, UnfilledPlaceholders, unfilledPlaceholders } from '../src/spec.ts'
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
    expect(() => preflight([node('team', { team: { kind: 'brainstorm' }, variants: { deep: { tier: 'frontier' } } })])).toThrow('node team: a team or a planner has no variants')
    expect(() => preflight([node('a', { variants: { deep: { dependsOn: ['b'] } as never } })])).toThrow('node a, variant deep: dependsOn cannot vary')
    expect(() => preflight([node('a', { variants: { Deep: {} } })])).toThrow(/variant name "Deep"/)
  })

  it('keeps a step\'s kind of work, lets a variant change it, and refuses a kind that is no label or sits on a team or a source step (REQ-WRK-11, ADR-0056)', () => {
    const nodes = [node('a', { kind: 'code', variants: { docs: { kind: 'docs' } } }), node('b', { dependsOn: ['a'] })]
    const plain = resolve('t', nodes, {})
    const docs = resolve('t', nodes, { variant: 'docs' })
    expect(plain.nodes.map((n) => [n.nodeId, n.kind])).toEqual([['a', 'code'], ['b', undefined]])
    expect(docs.nodes[0]!.kind).toBe('docs')
    // The kind is part of what was admitted.
    expect(docs.specHash).not.toBe(plain.specHash)
    expect(resolve('t', [node('a')], {}).specHash).not.toBe(resolve('t', [node('a', { kind: 'code' })], {}).specHash)
    expect(() => preflight([node('a', { kind: 'Code' })])).toThrow('node a: kind "Code" is not a kind of work')
    expect(() => preflight([node('a', { kind: '' })])).toThrow('node a: kind "" is not a kind of work')
    expect(() => preflight([node('a', { kind: null as never })])).toThrow('node a: kind null is not a kind of work')
    expect(() => preflight([node('a', { variants: { docs: { kind: 'Docs work' } } })])).toThrow('node a, variant docs: invalid kind')
    expect(() => preflight([node('team', { kind: 'code', team: { kind: 'brainstorm' } })])).toThrow('node team: a team has no kind')
    expect(() => preflight([node('source', { kind: 'code', snapshot: true }), node('b', { dependsOn: ['source'] })])).toThrow('node source: a source step has no kind')
  })

  it('gives an own-conversation node a persistent conversation of its own, and refuses two parallel nodes on the run\'s one conversation', () => {
    const fork = (conversation: NodeTemplate['conversation']) => [node('a'), node('b', { dependsOn: ['a'], conversation }), node('c', { dependsOn: ['a'], conversation }), node('d', { dependsOn: ['b', 'c'] })]
    const own = resolve('t', fork('own'), {})
    expect(own.nodes.filter((n) => n.nodeId === 'b' || n.nodeId === 'c').map((n) => n.session)).toEqual([{ member: 'b:own' }, { member: 'c:own' }])
    expect(() => resolve('t', fork('persistent'), {})).toThrow('nodes b and c could run at once on the run\'s one conversation; give one of them conversation: own')
    // In sequence, nodes share the run's conversation as before.
    expect(() => resolve('t', [node('a', { conversation: 'persistent' }), node('b', { dependsOn: ['a'], conversation: 'persistent' })], {})).not.toThrow()
  })

  it('refuses differentFrom that would make a node wait for itself, and variant values that are not valid', () => {
    expect(() => preflight([node('a', { differentFrom: ['b'] }), node('b', { differentFrom: ['a'] }), node('c', { dependsOn: ['a', 'b'] })])).toThrow(/would wait for itself through differentFrom/)
    expect(() => preflight([node('a', { differentFrom: ['b'] }), node('b', { dependsOn: ['a'] })])).toThrow(/would wait for itself through differentFrom/)
    expect(() => preflight([node('a', { variants: { deep: { tier: 'huge' as never } } })])).toThrow('node a, variant deep: invalid tier')
    expect(() => preflight([node('a', { variants: { deep: { conversation: 'bogus' as never, capabilities: [] } } })])).toThrow('node a, variant deep: invalid conversation, capabilities')
  })

  it('checks that a node differs only from other single-Worker nodes of its template (ADR-0027)', () => {
    expect(() => preflight([node('a'), node('b', { differentFrom: ['a'] }), node('c', { dependsOn: ['a', 'b'] })])).not.toThrow()
    expect(() => preflight([node('a', { differentFrom: ['a'] })])).toThrow('node a differs from itself')
    expect(() => preflight([node('a', { differentFrom: ['zz'] })])).toThrow('node a differs from unknown node zz')
    expect(() => preflight([node('t', { team: { kind: 'brainstorm' } }), node('b', { dependsOn: ['t'], prompt: '{{node:t}}', differentFrom: ['t'] })])).toThrow('node b differs from team t, which has several Workers')
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

  it('composes the caller input as text and each dependency result as a pointer, which renders verbatim and is never expanded again', () => {
    const ref = `sha256:${'e'.repeat(64)}` as const
    const parts = compose('Q: {{input}}\n<r>{{node:research:1}}</r> again: {{node:research:1}}', 'why?', { 'research:1': ref })
    expect(parts).toEqual({
      segments: [{ text: 'Q: why?\n<r>' }, { artifact: 0 }, { text: '</r> again: ' }, { artifact: 0 }],
      pointers: [{ ref, role: 'input', note: 'the result of node research:1' }],
    })
    const brief: Brief = {
      schema: 'brief@1.1', goal: 'g', acceptance: [{ id: 'c', statement: 's' }], artifacts: parts.pointers, instructions: parts.segments,
      budget: { remaining: [] }, sandbox: NO_LOCAL_SANDBOX, classification: 'public',
    }
    const read = () => ({ bodySchema: 'provider-answer@1.0', body: { text: 'a {{input}} b' }, classification: 'public' as const })
    expect(renderBrief(brief, read)).toBe('Q: why?\n<r>a {{input}} b</r> again: a {{input}} b')
  })

  it('composes every placeholder of a template or none: one it cannot fill throws, naming it, and text it inserts is never scanned (INV-2)', () => {
    const ref = `sha256:${'e'.repeat(64)}` as const
    const unfilled = (prompt: string, results: Record<string, typeof ref> = {}, extras = {}): string[] => {
      try {
        compose(prompt, 'x', results, extras)
      } catch (error) {
        expect(error).toBeInstanceOf(UnfilledPlaceholders)
        return (error as UnfilledPlaceholders).placeholders
      }
      return []
    }
    expect(unfilled('Q: {{input}} {{node:a}} {{node:b}}', { a: ref })).toEqual(['{{node:b}}'])
    expect(unfilled('{{grown}} {{team}}')).toEqual(['{{grown}}', '{{team}}'])
    expect(unfilled('{{grown}} {{team}}', {}, { grown: [], team: 'ballot' })).toEqual([])
    expect(unfilled('{{other}} {{ input }} {{{input}}} {{input')).toEqual(['{{other}}', '{{ input }}', '{{{input}}', '{{input…'])
    // JSON in a template opens no placeholder; the caller's text is data, sent as written.
    expect(unfilled('{{input}}: {"a": {"b": [{"c": 1}]}}')).toEqual([])
    expect(compose('Q: {{input}}', 'what does {{input}} do?', {})).toEqual({ segments: [{ text: 'Q: what does {{input}} do?' }], pointers: [] })
    expect(unfilledPlaceholders('{{input}} {{node:a}} {{grown}} {{team}}', { refs: { a: ref }, grown: true, team: true })).toEqual([])
  })

  it('refuses at preflight a placeholder the engine does not fill, and {{team}} anywhere but a team\'s ballot (INV-2)', () => {
    expect(() => preflight([node('a', { prompt: 'Answer {{inptu}}' })])).toThrow('node a uses {{inptu}}, which is not a placeholder the engine fills')
    expect(() => preflight([node('a', { prompt: 'Answer {{ input }}' })])).toThrow(/node a uses \{\{ input \}\}/)
    expect(() => preflight([node('a', { prompt: 'Answer {{input' })])).toThrow(/node a uses \{\{input…/)
    expect(() => preflight([node('a', { prompt: '{{team}}' })])).toThrow(/node a uses \{\{team\}\}/)
    expect(() => preflight([node('a', { prompt: '{{input}}: {"a": {"b": 1}}' })])).not.toThrow()
    // A team's ballot is worded by the engine, with {{team}}.
    expect(resolve('t', [node('t', { team: { kind: 'brainstorm' } })], {}).nodes.filter((n) => n.prompt === '{{team}}').map((n) => n.team?.role)).toEqual(['ballot', 'ballot'])
  })

  it('splits a text longer than a brief holds on whole characters, and merges what it can', () => {
    const long = '😀'.repeat(262_145)
    const parts = appended(compose('{{input}}', long, {}), '!')
    expect(parts.segments.map((s) => ('text' in s ? [...s.text].length : -1))).toEqual([262_144, 2])
    expect(parts.segments.map((s) => ('text' in s ? s.text : '')).join('')).toBe(`${long}!`)
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

  it('unrolls a team: independent proposals, sealed ballots over them, a tally, and a decision under the team\'s id (REQ-TEAM-1, ADR-0027)', () => {
    const team = node('brainstorm', { prompt: '{{input}}', team: { kind: 'brainstorm', members: 3 } })
    const spec = resolve('t', [team, node('after', { dependsOn: ['brainstorm'], prompt: '{{node:brainstorm}}' })], {})
    const proposals = ['brainstorm:m1:propose', 'brainstorm:m2:propose', 'brainstorm:m3:propose']
    const ballots = ['brainstorm:m1:ballot:1', 'brainstorm:m2:ballot:1', 'brainstorm:m3:ballot:1']
    expect(spec.nodes.map((n) => [n.nodeId, n.dependsOn])).toEqual([
      ...proposals.map((p) => [p, []]),
      ...ballots.map((b) => [b, proposals]),
      ['brainstorm:tally:1', ballots],
      ['brainstorm', ['brainstorm:tally:1']],
      ['after', ['brainstorm']],
    ])
    // A proposal sees no peer; member k differs in provider family from every earlier member.
    expect(spec.nodes.slice(0, 3).map((n) => n.differentFrom)).toEqual([undefined, [proposals[0]], proposals.slice(0, 2)])
    expect(spec.nodes[0]!.prompt).toContain('You are member 1 of a team of 3')
    expect(spec.nodes[0]).toMatchObject({ acceptance: 'acceptance.team-proposal', session: { member: 'brainstorm:m1' }, team: { id: 'brainstorm', kind: 'brainstorm', role: 'propose', member: 1, members: 3, debateRounds: 1 } })
    // A ballot is engine-composed in the member's own conversation, checked against the options.
    expect(spec.nodes[3]).toMatchObject({ prompt: '{{team}}', acceptance: 'acceptance.team-ballot-3', session: { member: 'brainstorm:m1' }, team: { role: 'ballot', round: 1 } })
    // The tally and the decision run no Worker.
    expect(spec.nodes[6]).toMatchObject({ executor: 'tally', session: {}, team: { role: 'tally', round: 1 } })
    expect(spec.nodes[7]).toMatchObject({ executor: 'decide', session: {}, team: { role: 'decide' } })
    // A review reads its source first (PROP-0004 Phase 4): the caller's repository, or its text.
    const review = resolve('t', DEFAULT_TEMPLATES.review!, { repository: { url: 'https://github.com/a/b' } })
    expect(review.nodes[0]).toMatchObject({ nodeId: 'source', executor: 'snapshot', session: {}, repository: { url: 'https://github.com/a/b' } })
    expect(review.nodes[1]).toMatchObject({ acceptance: 'acceptance.team-findings', dependsOn: ['source'] })
    expect(review.nodes[3]).toMatchObject({ acceptance: 'acceptance.team-ballot-review' })
    expect(review.specHash).not.toBe(resolve('t', DEFAULT_TEMPLATES.review!, {}).specHash)
    expect(preflight(DEFAULT_TEMPLATES.brainstorm!)).toEqual(['brainstorm'])
    expect(DEFAULT_TEMPLATES.panel).toBeUndefined()
  })

  it('refuses a team policy outside its bounds, and fields a team cannot have', () => {
    expect(() => preflight([node('t', { team: { kind: 'brainstorm', members: 1 } })])).toThrow(/team must be/)
    expect(() => preflight([node('t', { team: { kind: 'brainstorm', debateRounds: 3 } })])).toThrow(/team must be/)
    expect(() => preflight([node('t', { team: { kind: 'vote' as never } })])).toThrow(/team must be/)
    // The procedure an earlier version ran (rounds, a lead, a synthesis) is refused, never half-run.
    expect(() => preflight([node('t', { team: { kind: 'brainstorm', rounds: 2 } as never })])).toThrow(/team must be/)
    expect(() => preflight([node('t', { team: { members: 2, rounds: 2 } as never })])).toThrow(/team must be/)
    expect(() => preflight([node('a'), node('t', { dependsOn: ['a'], prompt: '{{node:a}}', team: { kind: 'review' }, differentFrom: ['a'] })])).toThrow('node t: a team has no differentFrom, grows, or resultSchema')
  })
})
