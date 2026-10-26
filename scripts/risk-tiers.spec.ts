import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type AutonomyPolicy, changeTier, type RiskTierMap } from '../packages/approvals-core/src/index.ts'
import { checkRiskTiers, mapCoverage, packageDirs, POLICY_FILE, trackedFiles } from './check-risk-tiers.ts'

// The system repository's path map (ADR-0071) and the check that keeps it whole: `pnpm check:tiers`.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const policy = JSON.parse(readFileSync(join(ROOT, POLICY_FILE), 'utf8')) as AutonomyPolicy
const map = policy.riskTiers!
const tierOf = (...paths: string[]) => changeTier([{ policy: { id: policy.id, version: policy.version }, map }], { paths, unreadable: [] })!.tier

describe('the system repository\'s path map (policies/system.json)', () => {
  it('loads, matches every tracked path, and names every package directory', () => {
    expect(checkRiskTiers(ROOT)).toEqual([])
    expect(packageDirs(trackedFiles(ROOT))).toContain('packages/plugins/workflow')
  })

  it('holds docs, proposals, research, READMEs, and changesets light', () => {
    expect(tierOf('docs/design/board.md', 'docs/proposals/0016-operating-model.md', 'docs/research/README.md', 'README.md', '.changeset/x.md')).toBe('light')
  })

  it('holds ADRs, invariants, the gate and approvals, dispatch and routing, confinement and credentials, the ledger, migrations, schema majors, and the policy itself heavy', () => {
    for (const path of [
      'docs/decisions/adr/0071-a.md', 'docs/architecture/invariants.md',
      'packages/plugins/approvals/src/policy.ts', 'packages/approvals-core/src/risk-tiers.ts', 'packages/plugins/board/src/index.ts', 'packages/plugins/workflow/src/risk.ts', 'packages/plugins/workflow/src/tasks.ts',
      'packages/plugins/workflow/src/dispatch.ts', 'packages/plugins/workers/src/index.ts', 'packages/workers-core/src/index.ts',
      'packages/plugins/runtime-claude-agent-sdk/src/index.ts', 'packages/plugins/agent-workers/src/gate.ts', 'packages/plugins/credentials-vault/src/index.ts', 'packages/plugins/egress/src/scan.ts',
      'packages/plugins/resources/src/index.ts', 'packages/plugins/store/src/index.ts', 'packages/plugins/artifacts/src/index.ts',
      'packages/plugins/workflow/src/migrations.ts', 'schemas/decision.v2.json', 'packages/workers-core/conformance/workers.ts', 'policies/system.json',
    ]) expect(tierOf(path), path).toBe('heavy')
  })

  it('holds the rest normal: a capability package, the tooling, a schema\'s minor version, root configuration', () => {
    expect(tierOf('packages/plugins/web-ui/src/assets.ts', 'packages/plugins/workflow/src/engine.ts', 'scripts/gen-reference.ts', 'schemas/decision.v1.json', 'package.json')).toBe('normal')
    // A README in a normal package is normal: the highest tier of the rules that match wins.
    expect(tierOf('packages/plugins/web-ui/README.md')).toBe('normal')
  })
})

describe('the coverage check', () => {
  const small: RiskTierMap = { version: 1, rules: [{ tier: 'normal', note: 'everything under packages', paths: ['packages/**'] }, { tier: 'light', note: 'docs', paths: ['docs/'] }] }

  it('names a tracked path no rule matches, which would be heavy', () => {
    expect(mapCoverage(small, ['docs/a.md', 'tools/x.sh'])).toEqual(['tools/x.sh: no rule of the path map matches it, so it would be heavy; give it a tier'])
  })

  it('names a package directory no rule names on its own, though a pattern matches it: a new package is classified on purpose', () => {
    expect(mapCoverage(small, ['packages/new/package.json', 'packages/new/src/index.ts'])).toEqual(['packages/new: no rule of the path map names this package directory; add it to the rule of its tier'])
    const named: RiskTierMap = { ...small, rules: [...small.rules, { tier: 'normal', note: 'new', paths: ['packages/new/'] }] }
    expect(mapCoverage(named, ['packages/new/package.json', 'packages/new/src/index.ts'])).toEqual([])
  })
})
