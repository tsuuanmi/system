/**
 * Web access of a research role (T262, ADR-0074): the autonomy policy's `webAccess` grant
 * (`autonomy-policy@1.3`). `external-send` stays a class that always asks, in every rule and every
 * effective mode; the grant is a separate, versioned record of the shape of call the operator
 * approved ahead: a `WebSearch` or `WebFetch` call of a Worker run under one role profile, whose
 * query or URL passes the egress check, at most `maxWebCallsPerRun` per run. The agent gate applies
 * it only after the policy said `ask` for the call (code decides, never a model); past the bound, on
 * an egress refusal, or for any other role, the call asks as before. Pure: no store, no clock.
 */
import type { Classification } from './index.ts'

/** The role profiles a grant may name: `research`, a read-only role whose only tools are reads and web calls. */
export type WebAccessProfile = 'research'
const WEB_ACCESS_PROFILES: readonly WebAccessProfile[] = ['research']

/** The tools a grant may name: the two calls that send a query or a URL out of this machine. */
export type WebTool = 'WebSearch' | 'WebFetch'
const WEB_TOOLS: readonly WebTool[] = ['WebSearch', 'WebFetch']

/** The bound of a grant's calls per run when it names none (T262). */
export const DEFAULT_MAX_WEB_CALLS = 40

/** The bounds of a grant (INV-9). */
const WEB_ACCESS_BOUNDS = { rules: 8, maxWebCallsPerRun: 200, noteChars: 500 } as const

/** One grant: the role profile it is for, its tools, its bound, the highest classification a run under it may hold, and why. */
export interface WebAccessRule {
  profile: WebAccessProfile
  tools: WebTool[]
  /** The calls one run may make under the grant, {@link DEFAULT_MAX_WEB_CALLS} when unset; past it, a call asks the operator. */
  maxWebCallsPerRun?: number | undefined
  /** A run whose content is classified above this never sends under the grant (`local-private` never does). */
  maxClassification: 'public' | 'operator-shared'
  note: string
}

/** A policy's grants (`autonomy-policy@1.3` `webAccess`); its own `version` changes whenever a grant does. */
export interface WebAccessGrants {
  version: number
  rules: WebAccessRule[]
}

const RANK: Record<Classification, number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }

/** Every problem of a policy's grants, in order; empty when they load. */
export function webAccessProblems(grants: unknown): string[] {
  if (typeof grants !== 'object' || grants === null || Array.isArray(grants)) return ['webAccess is an object with a version and rules']
  const { version, rules } = grants as Partial<WebAccessGrants>
  const problems: string[] = []
  if (!Number.isInteger(version) || version! < 1) problems.push('webAccess.version is an integer of at least 1')
  if (!Array.isArray(rules) || !rules.length || rules.length > WEB_ACCESS_BOUNDS.rules) return [...problems, `webAccess.rules is a list of 1 to ${WEB_ACCESS_BOUNDS.rules} grants`]
  const profiles = new Set<string>()
  rules.forEach((rule, i) => {
    const at = `webAccess.rules[${i}]`
    if (!WEB_ACCESS_PROFILES.includes(rule?.profile)) problems.push(`${at}.profile is one of ${WEB_ACCESS_PROFILES.join(', ')}`)
    else if (profiles.has(rule.profile)) problems.push(`${at}: another grant is for the ${rule.profile} profile`)
    else profiles.add(rule.profile)
    if (!Array.isArray(rule?.tools) || !rule.tools.length || rule.tools.some((t) => !WEB_TOOLS.includes(t)) || new Set(rule.tools).size !== rule.tools.length) problems.push(`${at}.tools is a list of distinct tools among ${WEB_TOOLS.join(', ')}`)
    const max = rule?.maxWebCallsPerRun
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > WEB_ACCESS_BOUNDS.maxWebCallsPerRun)) problems.push(`${at}.maxWebCallsPerRun is an integer from 1 to ${WEB_ACCESS_BOUNDS.maxWebCallsPerRun}`)
    if (rule?.maxClassification !== 'public' && rule?.maxClassification !== 'operator-shared') problems.push(`${at}.maxClassification is public or operator-shared: local-private content never leaves under a grant`)
    if (typeof rule?.note !== 'string' || !rule.note.length || rule.note.length > WEB_ACCESS_BOUNDS.noteChars) problems.push(`${at}.note says why, in 1 to ${WEB_ACCESS_BOUNDS.noteChars} characters`)
  })
  return problems
}

/** The grant in force for a profile under a set, and the policies (id, version, the grants' version) it was read from. */
export interface EffectiveWebAccess {
  profile: WebAccessProfile
  tools: WebTool[]
  maxWebCallsPerRun: number
  maxClassification: 'public' | 'operator-shared'
  /** Each policy that granted it, its version, and its grants' version: what a decision names. */
  from: Array<{ id: string; version: number; webAccess: number }>
}

/**
 * The grant in force for `profile` under a policy set (the studio's, then the project's): the studio
 * policy must grant it, since a project policy only narrows the studio's; a project policy that
 * carries `webAccess` narrows it (the fewer tools, the lower bound, the lower classification) and,
 * granting nothing for the profile, withdraws it; one that carries none leaves it as the studio's
 * (it constrains only what it names, as a commands list does). Undefined when nothing is granted.
 */
export function webAccessOf(policies: ReadonlyArray<{ id: string; version: number; webAccess?: WebAccessGrants | undefined }>, profile: WebAccessProfile): EffectiveWebAccess | undefined {
  const [studio, ...projects] = policies
  const own = studio?.webAccess?.rules.find((r) => r.profile === profile)
  if (!studio || !own) return undefined
  let effective: EffectiveWebAccess = {
    profile, tools: [...own.tools], maxWebCallsPerRun: own.maxWebCallsPerRun ?? DEFAULT_MAX_WEB_CALLS, maxClassification: own.maxClassification,
    from: [{ id: studio.id, version: studio.version, webAccess: studio.webAccess!.version }],
  }
  for (const project of projects) {
    if (project.webAccess === undefined) continue
    const rule = project.webAccess.rules.find((r) => r.profile === profile)
    if (!rule) return undefined
    const tools = effective.tools.filter((t) => rule.tools.includes(t))
    if (!tools.length) return undefined
    effective = {
      profile, tools, maxWebCallsPerRun: Math.min(effective.maxWebCallsPerRun, rule.maxWebCallsPerRun ?? DEFAULT_MAX_WEB_CALLS),
      maxClassification: RANK[rule.maxClassification] < RANK[effective.maxClassification] ? rule.maxClassification : effective.maxClassification,
      from: [...effective.from, { id: project.id, version: project.version, webAccess: project.webAccess.version }],
    }
  }
  return effective
}

/** Whether content of `classification` may be sent under a grant whose highest is `max`. */
export const withinClassification = (classification: Classification, max: EffectiveWebAccess['maxClassification']): boolean => RANK[classification] <= RANK[max]

/** A set's grants as one line per profile, for a policy change's consequences: "research: WebSearch, WebFetch, at most 40 per run, up to operator-shared". */
export function webAccessLines(policies: ReadonlyArray<{ id: string; version: number; webAccess?: WebAccessGrants | undefined }>): string[] {
  return WEB_ACCESS_PROFILES.map((profile) => {
    const grant = webAccessOf(policies, profile)
    return grant ? `${profile}: ${grant.tools.join(', ')} unasked when the egress check passes, at most ${grant.maxWebCallsPerRun} per run, content up to ${grant.maxClassification}` : `${profile}: none (every web call asks)`
  })
}
