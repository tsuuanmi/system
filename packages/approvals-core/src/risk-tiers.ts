/**
 * Process tiered by risk (PROP-0016 §4, D83, ADR-0071): the autonomy policy's path map gives each
 * changed path a tier, `light`, `normal`, or `heavy`, and a change's tier is the highest of its
 * paths. A path no rule matches, and a path that cannot be read, is heavy (INV-2). Pure: no store,
 * no clock, and it reads no file system (it imports only libs' `globMatches` and `globProblem`).
 * The tier is decided by what a change touches, never by a model.
 */

import { globMatches, globProblem } from '@tsuuanmi/system-libs'

/** A change's risk tier, from least to most process. */
export type RiskTier = 'light' | 'normal' | 'heavy'

/** The tiers from least to most strict: a change's tier is the highest of its paths'. */
export const RISK_TIERS: readonly RiskTier[] = ['light', 'normal', 'heavy']

/** One rule of a path map: the paths it gives a tier, and why, in a few words. */
export interface RiskTierRule {
  /** Repository-relative path patterns ({@link matchesPath}). */
  paths: string[]
  tier: RiskTier
  /** Why these paths have this tier: what an explanation of a tier quotes. */
  note: string
}

/**
 * A policy's path map (`autonomy-policy@1.1` `riskTiers`). Its own `version` changes whenever a
 * path's tier changes, so a tier decision names the map it was read from.
 */
export interface RiskTierMap {
  version: number
  rules: RiskTierRule[]
}

/** The most rules a map holds, and patterns a rule holds (INV-9). */
const RISK_MAP_BOUNDS = { rules: 200, paths: 64, noteChars: 500 } as const

/** Why a pattern is not one {@link matchesPath} reads (libs' `globProblem`, `**` and a trailing `/` allowed), or undefined when it is. */
export function patternProblem(pattern: string): string | undefined {
  const problem = globProblem(pattern, true)
  return problem && `the pattern ${JSON.stringify(String(pattern).slice(0, 40))}${String(pattern).length > 40 ? '…' : ''} ${problem}`
}

/**
 * Whether a repository-relative path (`packages/libs/src/x.ts`) matches a pattern: segments split on
 * `/`; `*` matches any characters within one segment, `**` any number of whole segments (none
 * included); a pattern ending in `/` is that directory and everything below it (`docs/` is
 * `docs/**`). A pattern {@link patternProblem} refuses matches nothing.
 */
export function matchesPath(pattern: string, path: string): boolean {
  return !patternProblem(pattern) && globMatches(pattern, path, undefined, true)
}

/** Every problem of a path map, in order; empty when it loads. */
export function riskMapProblems(map: unknown): string[] {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return ['riskTiers is an object with a version and rules']
  const { version, rules } = map as Partial<RiskTierMap>
  const problems: string[] = []
  if (!Number.isInteger(version) || version! < 1) problems.push('riskTiers.version is an integer of at least 1')
  if (!Array.isArray(rules) || !rules.length || rules.length > RISK_MAP_BOUNDS.rules) return [...problems, `riskTiers.rules is a list of 1 to ${RISK_MAP_BOUNDS.rules} rules`]
  rules.forEach((rule, i) => {
    const at = `riskTiers.rules[${i}]`
    if (!RISK_TIERS.includes(rule?.tier)) problems.push(`${at}.tier is one of ${RISK_TIERS.join(', ')}`)
    if (typeof rule?.note !== 'string' || !rule.note.length || rule.note.length > RISK_MAP_BOUNDS.noteChars) problems.push(`${at}.note says why, in 1 to ${RISK_MAP_BOUNDS.noteChars} characters`)
    if (!Array.isArray(rule?.paths) || !rule.paths.length || rule.paths.length > RISK_MAP_BOUNDS.paths) problems.push(`${at}.paths is a list of 1 to ${RISK_MAP_BOUNDS.paths} patterns`)
    else for (const pattern of rule.paths) {
      const problem = patternProblem(pattern)
      if (problem) problems.push(`${at}: ${problem}`)
    }
  })
  return problems
}

/** The higher of two tiers. */
const higher = (a: RiskTier, b: RiskTier): RiskTier => (RISK_TIERS.indexOf(a) >= RISK_TIERS.indexOf(b) ? a : b)

/** A path's tier under one map: the highest of the rules that match it, with those rules; `unmatched` and heavy when none does. */
export interface PathTier {
  path: string
  tier: RiskTier
  /** `matched`: a rule gave it its tier; `unmatched`: no rule matches it; `unreadable`: what it holds could not be read. */
  why: 'matched' | 'unmatched' | 'unreadable'
  /** The notes of the rules that gave it its tier, and the patterns that matched. */
  rules?: Array<{ note: string; pattern: string }>
  /** For `unreadable`: what could not be read. */
  detail?: string
}

/** One path's tier under one map. */
export function pathTier(map: RiskTierMap, path: string): PathTier {
  let tier: RiskTier | undefined
  let rules: Array<{ note: string; pattern: string }> = []
  for (const rule of map.rules) {
    const pattern = rule.paths.find((p) => matchesPath(p, path))
    if (pattern === undefined) continue
    if (tier === undefined || RISK_TIERS.indexOf(rule.tier) > RISK_TIERS.indexOf(tier)) {
      tier = rule.tier
      rules = [{ note: rule.note, pattern }]
    } else if (rule.tier === tier) rules.push({ note: rule.note, pattern })
  }
  return tier === undefined ? { path, tier: 'heavy', why: 'unmatched' } : { path, tier, why: 'matched', rules }
}

/** A policy that carries a map, as a tier decision names it. */
export interface MapOf {
  policy: { id: string; version: number }
  map: RiskTierMap
}

/** A change as its tier reads it: the paths it touches (a rename's both), and what of it could not be read. */
export interface ChangePaths {
  paths: string[]
  /** Each part of the change that could not be read, with why: each counts as a heavy path (INV-2). */
  unreadable: string[]
}

/** A change's tier: the highest of its paths' under every map, each path with its tier and why. */
export interface ChangeTier {
  tier: RiskTier
  /** Each path at the tier it got, the highest of the maps'; unreadable parts last. */
  paths: PathTier[]
  /** The maps it was read under. */
  maps: Array<{ policy: { id: string; version: number }; version: number }>
  /** How many paths got each tier. */
  counts: Record<RiskTier, number>
}

/**
 * A change's tier under the maps of the policies that apply (the studio's, then the project's): each
 * path's tier is the highest any map gives it (a project's map can only make a path stricter), and
 * the change's is the highest of its paths'. An unreadable part is a heavy path. A change with no
 * path and nothing unreadable is light: it touches nothing. Undefined when no map applies (tiering
 * is off and the process is as before).
 */
export function changeTier(maps: readonly MapOf[], change: ChangePaths): ChangeTier | undefined {
  if (!maps.length) return undefined
  const paths: PathTier[] = [...new Set(change.paths)].sort().map((path) => {
    const each = maps.map((m) => pathTier(m.map, path))
    return each.reduce((a, b) => (RISK_TIERS.indexOf(b.tier) > RISK_TIERS.indexOf(a.tier) ? b : a))
  })
  for (const detail of change.unreadable) paths.push({ path: '', tier: 'heavy', why: 'unreadable', detail })
  const counts: Record<RiskTier, number> = { light: 0, normal: 0, heavy: 0 }
  for (const p of paths) counts[p.tier]++
  const tier = paths.reduce<RiskTier>((t, p) => higher(t, p.tier), 'light')
  return { tier, paths, maps: maps.map((m) => ({ policy: m.policy, version: m.map.version })), counts }
}

/** Why a change has its tier, in a few lines: the paths that set it, at most `max` of them, then how many more. */
export function tierReasons(result: ChangeTier, max = 8): string[] {
  const top = result.paths.filter((p) => p.tier === result.tier)
  const said = top.slice(0, max).map((p) => p.why === 'unreadable' ? `a part of the change could not be read (${p.detail}): heavy`
    : p.why === 'unmatched' ? `${p.path} matches no rule of the path map: heavy`
      : `${p.path} is ${p.tier}: ${p.rules!.map((r) => `${r.note} (${r.pattern})`).join('; ')}`)
  const more = top.length > max ? [`and ${top.length - max} more ${result.tier} path(s)`] : []
  const counts = `${result.paths.length} path(s): ${RISK_TIERS.map((t) => `${result.counts[t]} ${t}`).join(', ')}`
  return [`the change is ${result.tier}, the highest tier of its paths (${counts})`, ...said, ...more]
}
