/**
 * The autonomy policy as code (docs/design/approvals.md#the-autonomy-policy): the load-time rules
 * `autonomy-policy@1.x` cannot state (docs/reference/schemas.md#autonomy-policy), and the mode a
 * policy set gives an action. Pure: no store, no clock. Code decides, never a model.
 */
import type { Action, ActionClass, AutonomyPolicy, Check, ContentHash, Mode, ModeChange } from '@tsuuanmi/system-approvals-core'
import { ALWAYS_ASK, applyingPolicies as applying, MODES, riskMapProblems, SHELL_METACHARACTER, tierByRiskProblems, waitSeconds as expiryOf } from '@tsuuanmi/system-approvals-core'
import { contentId, SchemaRegistry } from '@tsuuanmi/system-libs'

/** Every action class (`common@1`'s `actionClass`), in the order `policy()` reports them. */
export const ACTION_CLASSES: readonly ActionClass[] = ['read', 'workspace-write', 'merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change', 'promotion', 'dispatch']

export const rank = (mode: Mode): number => MODES.indexOf(mode)

/** The rule an action class gets under the policies that apply to it. */
export interface EffectiveRule {
  /** The policy whose rule is the strictest; the studio's on a tie. */
  policy: AutonomyPolicy
  mode: Mode
  /** Whether that policy has a rule for the class; otherwise its `default` gave the mode. */
  named: boolean
  /** The checks of every applying policy, together. */
  requires: Check[]
  /** For a class in `ALWAYS_ASK`: the laxer mode the rules gave, before it was raised to ask. */
  raised?: Mode
}

/** How a policy set judges one action: the class it is judged as, its rule, and the checks that failed. */
export interface Judgement {
  /** The action's class, or `workspace-write` for a command on the commands list. */
  actionClass: ActionClass
  rule: EffectiveRule
  /** For an auto or notify rule: its required checks that did not pass. */
  failedChecks: Check[]
  /** The policies the action was judged under: the studio's, then the project's. */
  policies: AutonomyPolicy[]
  /** Why the action is forbidden whatever a rule says (an argv word with a shell metacharacter). */
  forbidden?: string
}

/** The policies a set holds at most: the studio's and 100 projects' (INV-9; `policy-change@1.0`). */
export const MAX_SET = 101

/** The batch rule when no policy names one: every request is its own batch, at once. */
const NO_BATCHING = { maxSize: 1, maxWaitSeconds: 0 } as const

/**
 * The strictest rule for a class over the policies that apply to it. A class the studio policy
 * does not name takes each policy's rule or default, so the stricter default applies where neither
 * names it. A class in `ALWAYS_ASK` is raised to at least ask, whatever a rule says (defence in
 * depth: the schema and the load-time rules already refuse a policy that says otherwise).
 */
function effectiveOf(policies: readonly AutonomyPolicy[], actionClass: ActionClass): EffectiveRule {
  let best: EffectiveRule | undefined
  const requires = new Set<Check>()
  for (const policy of applying(policies, actionClass)) {
    const rule = policy.rules.find((r) => r.actionClass === actionClass)
    const mode = rule?.mode ?? policy.default
    for (const check of rule?.requires ?? []) requires.add(check)
    if (!best || rank(mode) > rank(best.mode)) best = { policy, mode, named: rule !== undefined, requires: [] }
  }
  const effective = { ...best!, requires: [...requires] }
  return ALWAYS_ASK.includes(actionClass) && rank(effective.mode) < rank('ask') ? { ...effective, mode: 'ask', raised: effective.mode } : effective
}

/** The batch rule of a set: the first policy's that names one, the studio's first, and that policy. */
function batchOf(policies: readonly AutonomyPolicy[]): { rule: { maxSize: number; maxWaitSeconds: number }; from?: AutonomyPolicy } {
  const from = policies.find((p) => p.batch !== undefined)
  return from ? { rule: from.batch!, from } : { rule: NO_BATCHING }
}

/** The problems of one commands-list entry: a word that is empty (a leading, trailing, or doubled space) or holds a shell metacharacter. */
export function commandProblems(line: string): string[] {
  const words = line.split(' ')
  const problems: string[] = []
  if (words.some((w) => w === '')) problems.push(`the commands entry ${JSON.stringify(line)} has an empty word (a leading, trailing, or doubled space)`)
  const unsafe = words.find((w) => SHELL_METACHARACTER.test(w))
  if (unsafe !== undefined) problems.push(`the commands entry ${JSON.stringify(line)} has a shell metacharacter in ${JSON.stringify(unsafe)}`)
  return problems
}

/**
 * Every problem of a configured policy set, in order; empty when it loads. Each policy must be a
 * valid `autonomy-policy@1.x` with one rule per action class, `expiry.defaultSeconds` and every
 * rule's `expiresSeconds` within `expiry.maxSeconds`, no rule giving a class in `ALWAYS_ASK` auto
 * or notify, and commands-list entries of non-empty words free of shell metacharacters; ids are
 * unique; there is exactly one studio policy; each project policy, at most one per project,
 * narrows that studio policy; and each batch rule's `maxWaitSeconds` is under the shortest expiry
 * a request it batches can get. A set holds at most {@link MAX_SET} policies.
 */
export function policyProblems(policies: unknown, schemas: SchemaRegistry = new SchemaRegistry()): string[] {
  if (!Array.isArray(policies)) return ['policies must be a list of autonomy-policy@1.0 records']
  const problems: string[] = policies.length > MAX_SET ? [`a set holds at most ${MAX_SET} policies (the studio's and 100 projects'); ${policies.length} configured`] : []
  const valid: AutonomyPolicy[] = []
  const ids = new Set<string>()
  const projects = new Set<string>()
  policies.forEach((value: unknown, index) => {
    const id = (value as { id?: unknown } | null)?.id
    const name = `policy ${typeof id === 'string' ? id : `#${index + 1}`}`
    try {
      schemas.assert('autonomy-policy@1.0', value)
    } catch (error) {
      problems.push(`${name}: ${(error as Error).message}`)
      return
    }
    const policy = value as AutonomyPolicy
    valid.push(policy)
    if (ids.has(policy.id)) problems.push(`${name}: another policy has the same id`)
    ids.add(policy.id)
    const classes = new Set<ActionClass>()
    for (const rule of policy.rules) {
      if (classes.has(rule.actionClass)) problems.push(`${name}: more than one rule for ${rule.actionClass}`)
      classes.add(rule.actionClass)
      if (ALWAYS_ASK.includes(rule.actionClass) && rank(rule.mode) < rank('ask')) problems.push(`${name}: ${rule.actionClass} always asks; its rule may not say ${rule.mode}`)
      if (rule.expiresSeconds !== undefined && rule.expiresSeconds > policy.expiry.maxSeconds) {
        problems.push(`${name}: the ${rule.actionClass} rule expires after ${rule.expiresSeconds} s, more than expiry.maxSeconds (${policy.expiry.maxSeconds})`)
      }
    }
    if (policy.expiry.defaultSeconds > policy.expiry.maxSeconds) {
      problems.push(`${name}: expiry.defaultSeconds (${policy.expiry.defaultSeconds}) is more than expiry.maxSeconds (${policy.expiry.maxSeconds})`)
    }
    for (const line of policy.commands ?? []) for (const problem of commandProblems(line)) problems.push(`${name}: ${problem}`)
    // The path map's patterns are read by code the schema's pattern cannot state in full (a `..` segment, `**` inside a segment).
    if (policy.riskTiers !== undefined) for (const problem of riskMapProblems(policy.riskTiers)) problems.push(`${name}: ${problem}`)
    // The tier-by-risk map's keys and tiers, read by code as the schema states them (ADR-0073).
    if (policy.tierByRisk !== undefined) for (const problem of tierByRiskProblems(policy.tierByRisk)) problems.push(`${name}: ${problem}`)
    if (policy.scope === 'project') {
      if (projects.has(policy.projectId!)) problems.push(`${name}: project ${policy.projectId} already has a policy`)
      projects.add(policy.projectId!)
    }
  })
  const studios = valid.filter((p) => p.scope === 'studio')
  if (studios.length !== 1) problems.push(`exactly one studio policy is needed; ${studios.length} configured`)
  for (const p of valid) {
    if (p.scope === 'project' && !studios.some((s) => s.id === p.narrows)) problems.push(`policy ${p.id}: narrows ${p.narrows}, which is not a configured studio policy`)
  }
  if (problems.length) return problems
  // A lone request waits maxWaitSeconds before it is batched: that must be under every expiry it
  // can get, or it expires before the operator is shown it.
  const studio = studios[0]!
  for (const set of [[studio], ...valid.filter((p) => p.scope === 'project').map((p) => [studio, p])]) {
    const { rule, from } = batchOf(set)
    const shortest = Math.min(...ACTION_CLASSES.map((c) => expiryOf(set, c)))
    if (from && rule.maxWaitSeconds >= shortest) {
      const of = set.length > 1 ? `project ${set[1]!.projectId}'s requests` : 'the studio\'s requests'
      problems.push(`policy ${from.id}: batch.maxWaitSeconds (${rule.maxWaitSeconds}) is not under the shortest expiry of ${of} (${shortest} s), so a request alone would expire before it is batched`)
    }
  }
  return problems
}

/** Whether a policy's commands list allows an argv: a listed line, word for word, and nothing more. */
function allows(policy: AutonomyPolicy, argv: readonly string[]): boolean {
  return (policy.commands ?? []).some((line) => {
    const words = line.split(' ')
    return words.length === argv.length && words.every((word, i) => argv[i] === word)
  })
}

/** A configured policy set, valid by {@link policyProblems}: the studio policy and the project policies that narrow it. */
export class PolicySet {
  readonly studio: AutonomyPolicy
  private readonly projects = new Map<string, AutonomyPolicy>()
  private readonly hashes = new Map<string, `sha256:${string}`>()
  private whole: ContentHash | undefined

  private constructor(policies: readonly AutonomyPolicy[]) {
    this.studio = policies.find((p) => p.scope === 'studio')!
    for (const p of [...policies].filter((p) => p.scope === 'project').sort((a, b) => (a.projectId! < b.projectId! ? -1 : 1))) this.projects.set(p.projectId!, p)
  }

  /** The whole set in its canonical order: the studio policy, then the project policies by project id. */
  all(): AutonomyPolicy[] {
    return [this.studio, ...this.projects.values()]
  }

  /** The projects that have a policy, by id. */
  projectIds(): string[] {
    return [...this.projects.keys()]
  }

  /**
   * The whole set's hash: the sha256 of the canonical JSON of {@link all}, so the order the
   * configuration lists its policies in does not count as a change. A policy change's subject.
   */
  setHash(): ContentHash {
    return this.whole ??= contentId(this.all())
  }

  /** The policy with an id, if the set has one. */
  byId(id: string): AutonomyPolicy | undefined {
    return this.all().find((p) => p.id === id)
  }

  /** Load a configured set, or throw naming every problem: an invalid set is never half used (INV-2). */
  static load(policies: unknown, schemas?: SchemaRegistry): PolicySet {
    const problems = policyProblems(policies, schemas)
    if (problems.length) throw new Error(`approvals: the autonomy policies are refused, so no ctx.approvals is provided:\n  ${problems.join('\n  ')}`)
    return new PolicySet(structuredClone(policies as AutonomyPolicy[]))
  }

  /** The studio policy, then the project's when it has one. */
  of(projectId?: string): AutonomyPolicy[] {
    const project = projectId === undefined ? undefined : this.projects.get(projectId)
    return project ? [this.studio, project] : [this.studio]
  }

  /**
   * A project's effective policy set as loaded, for `decider.hash`: the sha256 of the canonical
   * JSON of {@link of}, so an edit that keeps a policy's version still shows.
   */
  hash(projectId?: string): `sha256:${string}` {
    const policies = this.of(projectId)
    const key = policies.map((p) => p.id).join('\n')
    let hash = this.hashes.get(key)
    if (!hash) this.hashes.set(key, hash = contentId(policies))
    return hash
  }

  /** Whether a policy is in a project's set now, at that version. */
  current(policy: { id: string; version: number }, projectId?: string): boolean {
    return this.of(projectId).some((p) => p.id === policy.id && p.version === policy.version)
  }

  /** The strictest rule for a class over the policies that apply to it, at least ask for a class in `ALWAYS_ASK`. */
  effective(actionClass: ActionClass, projectId?: string): EffectiveRule {
    return effectiveOf(this.of(projectId), actionClass)
  }

  /**
   * Judge one action. An argv with a word holding a shell metacharacter is forbidden. A command
   * whose argv every policy's list allows exactly (the studio's, and the project's when it has
   * one) is judged as `workspace-write`, unless the `command` class is forbidden; any other
   * command is the `command` class.
   */
  judge(action: Action): Judgement {
    const policies = this.of(action.projectId)
    const argv = action.command
    const unsafe = argv?.findIndex((word) => SHELL_METACHARACTER.test(word)) ?? -1
    if (unsafe >= 0) {
      return { actionClass: action.class, rule: { ...this.effective(action.class, action.projectId), mode: 'forbid' }, failedChecks: [], policies, forbidden: `argv word ${unsafe + 1} holds a shell metacharacter` }
    }
    const listed = action.class === 'command' && argv !== undefined && allows(policies[0]!, argv)
      && policies.slice(1).every((p) => p.commands === undefined || allows(p, argv))
      && this.effective('command', action.projectId).mode !== 'forbid'
    const actionClass: ActionClass = listed ? 'workspace-write' : action.class
    const rule = this.effective(actionClass, action.projectId)
    const failedChecks = rule.mode === 'auto' || rule.mode === 'notify' ? rule.requires.filter((c) => action.checks?.[c] !== true) : []
    return { actionClass, rule, failedChecks, policies }
  }

  /** How long a request for the class waits: the shortest applying rule's expiry, else the stricter default, never more than the stricter maximum. */
  expirySeconds(actionClass: ActionClass, projectId?: string): number {
    return expiryOf(this.of(projectId), actionClass)
  }

  /** The batch rule for a project's requests: the first policy that names one, the studio's first. */
  batchRule(projectId?: string): { maxSize: number; maxWaitSeconds: number } {
    return batchOf(this.of(projectId)).rule
  }
}

/**
 * The whole set one proposed record makes from a set (docs/design/approvals.md#a-policy-change):
 * it replaces the policy with its id, at a higher version and the same scope and project, or adds
 * a policy for a project that has none. Every problem is named; the set it makes must then load
 * under {@link policyProblems} too.
 */
export function proposedSet(base: PolicySet, policy: AutonomyPolicy): { policies: AutonomyPolicy[]; previous?: AutonomyPolicy } | { problems: string[] } {
  const previous = base.byId(policy.id)
  if (previous) {
    const problems: string[] = []
    if (!(policy.version > previous.version)) problems.push(`policy ${policy.id}: version ${policy.version} is not above the version in force (${previous.version}); a change raises it`)
    if (policy.scope !== previous.scope || policy.projectId !== previous.projectId) problems.push(`policy ${policy.id}: its scope and project do not change (${previous.scope}${previous.projectId ? ` ${previous.projectId}` : ''}); propose another id`)
    if (problems.length) return { problems }
    return { policies: base.all().map((p) => (p.id === policy.id ? policy : p)), previous }
  }
  if (policy.scope !== 'project') return { problems: [`policy ${policy.id}: a new policy is a project's; the set has one studio policy (${base.studio.id})`] }
  return { policies: [...base.all(), policy] }
}

/** Every effective mode that differs between two sets, for the studio and for each project either set has a policy for. */
export function effectOf(before: PolicySet, after: PolicySet): ModeChange[] {
  const projects = [...new Set([...before.projectIds(), ...after.projectIds()])].sort()
  const changes: ModeChange[] = []
  for (const projectId of [undefined, ...projects]) {
    for (const actionClass of ACTION_CLASSES) {
      const from = before.effective(actionClass, projectId).mode
      const to = after.effective(actionClass, projectId).mode
      if (from !== to) changes.push({ ...(projectId !== undefined ? { projectId } : {}), actionClass, from, to })
    }
  }
  return changes
}
