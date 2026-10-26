// The risk tier map gate (PROP-0016 §4, ADR-0071): the system repository's path map, in the
// `system` project's policy (`policies/system.json`), loads as an `autonomy-policy@1.1` with a valid
// map; every tracked path is matched by one of its rules (a path no rule matches would be heavy, so
// an unmatched path is a map to finish, not a tier to rely on); and every package directory is named
// by a rule of its own, never only by a pattern that matches anything, so a new package is classified
// on purpose before it lands.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AutonomyPolicy, pathTier, riskMapProblems, type RiskTierMap } from '../packages/approvals-core/src/index.ts'
import { SchemaRegistry } from '../packages/libs/src/index.ts'

/** Where the system repository's policy, and so its path map, is kept. */
export const POLICY_FILE = 'policies/system.json'

/** The tracked files of the repository at `root`, relative to it. */
export function trackedFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
}

/** The package directories among `files`: each directory under `packages/` that holds a `package.json`. */
export function packageDirs(files: readonly string[]): string[] {
  return [...new Set(files.filter((f) => f.startsWith('packages/') && f.endsWith('/package.json')).map((f) => f.slice(0, -'/package.json'.length)))].sort()
}

/** A pattern's literal start, before its first `*`. */
const literalOf = (pattern: string): string => pattern.split('*')[0]!

/**
 * Whether a rule names this directory: one of its patterns starts with the directory itself,
 * literally, or is exactly an enclosing package directory (`packages/system-bundle/` names the
 * package `packages/system-bundle/presets/api-first` inside it).
 */
export function names(map: RiskTierMap, dir: string, packages: readonly string[] = []): boolean {
  return map.rules.some((rule) => rule.paths.some((p) => {
    const literal = literalOf(p)
    return literal.startsWith(`${dir}/`) || (literal.endsWith('/') && packages.includes(literal.slice(0, -1)) && `${dir}/`.startsWith(literal))
  }))
}

/** Every problem of a path map against the files it must cover; empty when it holds. */
export function mapCoverage(map: RiskTierMap, files: readonly string[]): string[] {
  const problems: string[] = []
  const unmatched = files.filter((f) => pathTier(map, f).why === 'unmatched')
  for (const f of unmatched.slice(0, 50)) problems.push(`${f}: no rule of the path map matches it, so it would be heavy; give it a tier`)
  if (unmatched.length > 50) problems.push(`and ${unmatched.length - 50} more unmatched path(s)`)
  const packages = packageDirs(files)
  for (const dir of packages) {
    if (!names(map, dir, packages)) problems.push(`${dir}: no rule of the path map names this package directory; add it to the rule of its tier`)
  }
  return problems
}

/** Every problem of the policy at `root`'s {@link POLICY_FILE}; empty when it holds. */
export function checkRiskTiers(root: string, files = trackedFiles(root), schemas = new SchemaRegistry()): string[] {
  const path = join(root, POLICY_FILE)
  if (!existsSync(path)) return [`${POLICY_FILE}: missing; it holds the system project's policy and its path map`]
  let policy: AutonomyPolicy
  try {
    policy = JSON.parse(readFileSync(path, 'utf8')) as AutonomyPolicy
    schemas.assert('autonomy-policy@1.1', policy)
  } catch (error) {
    return [`${POLICY_FILE}: ${(error as Error).message}`]
  }
  if (!policy.riskTiers) return [`${POLICY_FILE}: it has no path map (riskTiers)`]
  const problems = riskMapProblems(policy.riskTiers).map((p) => `${POLICY_FILE}: ${p}`)
  return problems.length ? problems : mapCoverage(policy.riskTiers, files)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = trackedFiles(root)
  const problems = checkRiskTiers(root, files)
  for (const p of problems) console.error(p)
  console.log(`risk tiers: ${files.length} tracked path(s), ${packageDirs(files).length} package director(ies), ${problems.length} problem(s)`)
  process.exit(problems.length ? 1 : 0)
}
