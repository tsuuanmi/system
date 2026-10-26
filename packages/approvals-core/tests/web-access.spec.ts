// Web access of a research role (T262, ADR-0074): the autonomy policy's `webAccess` grants, pure.
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { type AutonomyPolicy, DEFAULT_MAX_WEB_CALLS, type WebAccessGrants, webAccessLines, webAccessOf, webAccessProblems, withinClassification } from '../src/index.ts'

const GRANT: WebAccessGrants = {
  version: 3, rules: [{ profile: 'research', tools: ['WebSearch', 'WebFetch'], maxWebCallsPerRun: DEFAULT_MAX_WEB_CALLS, maxClassification: 'operator-shared', note: 'literature reviews' }],
}
const studio = (webAccess?: WebAccessGrants): AutonomyPolicy => ({
  schema: webAccess ? 'autonomy-policy@1.3' : 'autonomy-policy@1.0', id: 'studio', version: 4, scope: 'studio', rules: [{ actionClass: 'external-send', mode: 'ask' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86_400 }, ...(webAccess ? { webAccess } : {}),
})
const project = (webAccess?: WebAccessGrants): AutonomyPolicy => ({ ...studio(webAccess), id: 'p.policy', version: 2, scope: 'project', projectId: 'p', narrows: 'studio' })

describe('web access grants (autonomy-policy@1.3 webAccess)', () => {
  it('grants nothing unless the studio policy does; a project policy only narrows it, and one that names none leaves it', () => {
    expect(DEFAULT_MAX_WEB_CALLS).toBe(40)
    expect(webAccessOf([studio()], 'research')).toBeUndefined()
    // A project's grant alone grants nothing: it narrows the studio's, which grants none.
    expect(webAccessOf([studio(), project(GRANT)], 'research')).toBeUndefined()
    expect(webAccessOf([studio(GRANT)], 'research')).toEqual({ profile: 'research', tools: ['WebSearch', 'WebFetch'], maxWebCallsPerRun: 40, maxClassification: 'operator-shared', from: [{ id: 'studio', version: 4, webAccess: 3 }] })
    expect(webAccessOf([studio(GRANT), project()], 'research')!.maxWebCallsPerRun).toBe(40)
    const narrower: WebAccessGrants = { version: 1, rules: [{ profile: 'research', tools: ['WebSearch'], maxWebCallsPerRun: 10, maxClassification: 'public', note: 'search only' }] }
    expect(webAccessOf([studio(GRANT), project(narrower)], 'research')).toEqual({
      profile: 'research', tools: ['WebSearch'], maxWebCallsPerRun: 10, maxClassification: 'public', from: [{ id: 'studio', version: 4, webAccess: 3 }, { id: 'p.policy', version: 2, webAccess: 1 }],
    })
    // A looser project grant never widens the studio's.
    const looser: WebAccessGrants = { version: 1, rules: [{ ...narrower.rules[0]!, tools: ['WebSearch', 'WebFetch'], maxWebCallsPerRun: 200, maxClassification: 'operator-shared' }] }
    const strict = webAccessOf([studio({ version: 1, rules: [{ ...GRANT.rules[0]!, maxWebCallsPerRun: 5, maxClassification: 'public' }] }), project(looser)], 'research')!
    expect([strict.maxWebCallsPerRun, strict.maxClassification]).toEqual([5, 'public'])
    // A project grant with no tool in common withdraws it.
    const fetchOnly: WebAccessGrants = { version: 1, rules: [{ ...narrower.rules[0]!, tools: ['WebFetch'] }] }
    expect(webAccessOf([studio({ version: 1, rules: [{ ...GRANT.rules[0]!, tools: ['WebSearch'] }] }), project(fetchOnly)], 'research')).toBeUndefined()
    // Local-private content never leaves under a grant.
    expect([withinClassification('public', 'operator-shared'), withinClassification('operator-shared', 'public'), withinClassification('local-private', 'operator-shared')]).toEqual([true, false, false])
    expect(webAccessLines([studio(GRANT)])).toEqual(['research: WebSearch, WebFetch unasked when the egress check passes, at most 40 per run, content up to operator-shared'])
    expect(webAccessLines([studio()])).toEqual(['research: none (every web call asks)'])
  })

  it('bounds a grant that names no maxWebCallsPerRun at 40 calls per run, as studio and as project', () => {
    const { maxWebCallsPerRun: _max, ...unbounded } = GRANT.rules[0]!
    const plain: WebAccessGrants = { version: 1, rules: [unbounded] }
    expect(webAccessProblems(plain)).toEqual([])
    expect(() => new SchemaRegistry().assert('autonomy-policy@1.3', studio(plain))).not.toThrow()
    expect(webAccessOf([studio(plain)], 'research')!.maxWebCallsPerRun).toBe(40)
    // A project's grant with no bound narrows a looser studio bound to 40 too.
    expect(webAccessOf([studio({ version: 1, rules: [{ ...GRANT.rules[0]!, maxWebCallsPerRun: 100 }] }), project(plain)], 'research')!.maxWebCallsPerRun).toBe(40)
  })

  it('refuses a grant the load-time rules or the schema do not allow', () => {
    expect(webAccessProblems(GRANT)).toEqual([])
    expect(webAccessProblems([])).toEqual(['webAccess is an object with a version and rules'])
    expect(webAccessProblems({ version: 0, rules: [GRANT.rules[0], { ...GRANT.rules[0], tools: ['Bash'], maxWebCallsPerRun: 0, maxClassification: 'local-private', note: '' }] })).toEqual([
      'webAccess.version is an integer of at least 1',
      'webAccess.rules[1]: another grant is for the research profile',
      'webAccess.rules[1].tools is a list of distinct tools among WebSearch, WebFetch',
      'webAccess.rules[1].maxWebCallsPerRun is an integer from 1 to 200',
      'webAccess.rules[1].maxClassification is public or operator-shared: local-private content never leaves under a grant',
      'webAccess.rules[1].note says why, in 1 to 500 characters',
    ])
    const schemas = new SchemaRegistry()
    expect(() => schemas.assert('autonomy-policy@1.3', studio(GRANT))).not.toThrow()
    // A grant is refused before @1.3, and external-send still always asks in every rule.
    expect(() => schemas.assert('autonomy-policy@1.2', { ...studio(GRANT), schema: 'autonomy-policy@1.2' })).toThrow()
    expect(() => schemas.assert('autonomy-policy@1.3', { ...studio(GRANT), rules: [{ actionClass: 'external-send', mode: 'auto' }] })).toThrow()
    expect(() => schemas.assert('autonomy-policy@1.3', studio({ version: 1, rules: [{ ...GRANT.rules[0]!, maxClassification: 'local-private' as 'public' }] }))).toThrow()
  })
})
