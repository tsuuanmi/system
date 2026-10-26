import { describe, expect, it } from 'vitest'
import { type AutonomyPolicy, changeTier, matchesPath, type MapOf, pathTier, patternProblem, riskMapProblems, riskTierMaps, type RiskTierMap, tierReasons } from '../src/index.ts'

// Process tiered by risk (PROP-0016 §4, D83, ADR-0071): a change's tier comes from the policy's path
// map, by what it touches. The highest tier of its paths wins; a path no rule matches, and a part of
// the change that cannot be read, is heavy.
const MAP: RiskTierMap = {
  version: 3,
  rules: [
    { tier: 'light', note: 'documentation', paths: ['docs/', '**/README.md'] },
    { tier: 'heavy', note: 'ADRs', paths: ['docs/decisions/adr/'] },
    { tier: 'heavy', note: 'the gate', paths: ['packages/plugins/approvals/', 'packages/plugins/workflow/src/risk.ts'] },
    { tier: 'heavy', note: 'schema majors', paths: ['schemas/*.v2.json'] },
    { tier: 'normal', note: 'a capability package', paths: ['packages/plugins/web-ui/', 'packages/plugins/workflow/'] },
    { tier: 'normal', note: 'root configuration', paths: ['*.json'] },
  ],
}
const OF: MapOf[] = [{ policy: { id: 'studio', version: 7 }, map: MAP }]
const tierOf = (paths: string[], unreadable: string[] = []) => changeTier(OF, { paths, unreadable })?.tier

describe('a path\'s tier under a map', () => {
  it('matches * within one segment, ** across any number, and a trailing / as the directory and below', () => {
    expect(matchesPath('docs/', 'docs/a/b.md')).toBe(true)
    expect(matchesPath('docs/', 'docsx/a.md')).toBe(false)
    expect(matchesPath('**/README.md', 'README.md')).toBe(true)
    expect(matchesPath('**/README.md', 'packages/libs/README.md')).toBe(true)
    expect(matchesPath('schemas/*.v2.json', 'schemas/board-task.v2.json')).toBe(true)
    expect(matchesPath('schemas/*.v2.json', 'schemas/board-task.v1.json')).toBe(false)
    expect(matchesPath('schemas/*.v2.json', 'schemas/x/board-task.v2.json')).toBe(false)
    expect(matchesPath('*', 'package.json')).toBe(true)
    expect(matchesPath('*', 'scripts/a.ts')).toBe(false)
    expect(matchesPath('a/*b*c', 'a/xbyc')).toBe(true)
    expect(matchesPath('a/*b*c', 'a/xcyb')).toBe(false)
  })

  it('gives a path the highest tier of the rules that match it, with their notes, and an unmatched path heavy', () => {
    expect(pathTier(MAP, 'docs/design/board.md')).toEqual({ path: 'docs/design/board.md', tier: 'light', why: 'matched', rules: [{ note: 'documentation', pattern: 'docs/' }] })
    expect(pathTier(MAP, 'docs/decisions/adr/0071-x.md')).toMatchObject({ tier: 'heavy', rules: [{ note: 'ADRs' }] })
    // A README in a package the map holds normal is normal: the highest tier wins, never the most specific.
    expect(pathTier(MAP, 'packages/plugins/web-ui/README.md')).toMatchObject({ tier: 'normal' })
    expect(pathTier(MAP, 'packages/plugins/workflow/src/risk.ts')).toMatchObject({ tier: 'heavy', rules: [{ note: 'the gate' }] })
    expect(pathTier(MAP, 'packages/plugins/brand-new/src/index.ts')).toEqual({ path: 'packages/plugins/brand-new/src/index.ts', tier: 'heavy', why: 'unmatched' })
  })
})

describe('a change\'s tier: the highest of its paths\'', () => {
  it('is light for documentation only, normal once it touches a capability package, heavy once it touches the gate (tier per path set)', () => {
    expect(tierOf(['docs/a.md', 'docs/proposals/0016-x.md', 'README.md'])).toBe('light')
    expect(tierOf(['docs/a.md', 'packages/plugins/web-ui/src/assets.ts'])).toBe('normal')
    expect(tierOf(['docs/a.md', 'packages/plugins/web-ui/src/assets.ts', 'packages/plugins/approvals/src/policy.ts'])).toBe('heavy')
    expect(tierOf(['schemas/decision.v2.json'])).toBe('heavy')
    expect(tierOf(['packages/plugins/workflow/src/engine.ts'])).toBe('normal')
  })

  it('is heavy when a path matches no rule, whatever else it touches', () => {
    expect(tierOf(['docs/a.md', 'tools/new.sh'])).toBe('heavy')
    const result = changeTier(OF, { paths: ['docs/a.md', 'tools/new.sh'], unreadable: [] })!
    expect(result.paths.find((p) => p.path === 'tools/new.sh')).toEqual({ path: 'tools/new.sh', tier: 'heavy', why: 'unmatched' })
    expect(tierReasons(result)).toContain('tools/new.sh matches no rule of the path map: heavy')
  })

  it('is heavy when a part of the change cannot be read, even when every path it could read is light (INV-2)', () => {
    expect(tierOf(['docs/a.md'], ['3 file(s) of /w past the bound of the change\'s files'])).toBe('heavy')
    expect(tierOf([], ['the run\'s change could not be read (EIO)'])).toBe('heavy')
    const result = changeTier(OF, { paths: ['docs/a.md'], unreadable: ['source agents could not read its worktree of the run: gone'] })!
    expect(result.counts).toEqual({ light: 1, normal: 0, heavy: 1 })
    expect(result.paths.at(-1)).toEqual({ path: '', tier: 'heavy', why: 'unreadable', detail: 'source agents could not read its worktree of the run: gone' })
    expect(tierReasons(result)[1]).toBe('a part of the change could not be read (source agents could not read its worktree of the run: gone): heavy')
  })

  it('takes, under several maps, each path at the highest tier any of them gives it: a project\'s map only makes a path stricter', () => {
    const project: RiskTierMap = { version: 1, rules: [{ tier: 'heavy', note: 'the project holds its docs heavy', paths: ['docs/'] }] }
    const both: MapOf[] = [...OF, { policy: { id: 'p1.policy', version: 2 }, map: project }]
    const result = changeTier(both, { paths: ['docs/a.md'], unreadable: [] })!
    expect(result.tier).toBe('heavy')
    expect(result.maps).toEqual([{ policy: { id: 'studio', version: 7 }, version: 3 }, { policy: { id: 'p1.policy', version: 2 }, version: 1 }])
  })

  it('is off with no map: no tier, and the process is as before', () => {
    expect(changeTier([], { paths: ['packages/plugins/approvals/src/policy.ts'], unreadable: [] })).toBeUndefined()
    const policy = { schema: 'autonomy-policy@1.0', id: 's', version: 1, scope: 'studio', rules: [{ actionClass: 'read', mode: 'auto' }], default: 'ask', expiry: { defaultSeconds: 60, maxSeconds: 60 } } as AutonomyPolicy
    expect(riskTierMaps([policy])).toEqual([])
    expect(riskTierMaps([{ ...policy, schema: 'autonomy-policy@1.1', riskTiers: MAP }])).toEqual([{ policy: { id: 's', version: 1 }, map: MAP }])
  })

  it('names at most the paths it was asked to, and how many more set the tier', () => {
    const many = Array.from({ length: 12 }, (_, i) => `packages/plugins/approvals/src/f${String(i).padStart(2, '0')}.ts`)
    const reasons = tierReasons(changeTier(OF, { paths: many, unreadable: [] })!, 8)
    expect(reasons[0]).toBe('the change is heavy, the highest tier of its paths (12 path(s): 0 light, 0 normal, 12 heavy)')
    expect(reasons.at(-1)).toBe('and 4 more heavy path(s)')
    expect(reasons).toHaveLength(10)
  })
})

describe('a map\'s problems, refused when its policy loads', () => {
  it('refuses a pattern that escapes the repository or that matching cannot read', () => {
    expect(patternProblem('../x')).toMatch(/\. or \.\. segment/)
    expect(patternProblem('/abs')).toMatch(/repository-relative/)
    expect(patternProblem('a//b')).toMatch(/repository-relative/)
    expect(patternProblem('a/x**/b')).toMatch(/\*\* inside a segment/)
    expect(patternProblem('docs/')).toBeUndefined()
    expect(riskMapProblems({ version: 0, rules: [{ tier: 'medium', note: '', paths: ['../x'] }] })).toEqual([
      'riskTiers.version is an integer of at least 1',
      'riskTiers.rules[0].tier is one of light, normal, heavy',
      'riskTiers.rules[0].note says why, in 1 to 500 characters',
      'riskTiers.rules[0]: the pattern "../x" has a . or .. segment',
    ])
    expect(riskMapProblems(MAP)).toEqual([])
  })
})
