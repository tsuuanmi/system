/**
 * The autonomy policy as code (docs/design/approvals.md#the-autonomy-policy): the load-time rules
 * `autonomy-policy@1.0` cannot state (docs/reference/schemas.md#autonomy-policy), and the mode a
 * policy set gives an action. Pure: no store, no clock. Code decides, never a model.
 */
import type { Action, ActionClass, AutonomyPolicy, Check, Mode } from '@tsuuanmi/system-approvals-core'
import { MODES } from '@tsuuanmi/system-approvals-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'

/** Every action class (`common@1`'s `actionClass`), in the order `policy()` reports them. */
export const ACTION_CLASSES: readonly ActionClass[] = ['read', 'workspace-write', 'merge', 'command', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change']

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
  /** The strictest rule's own expiry, when it names one. */
  expiresSeconds?: number
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
}

/** The batch rule when no policy names one: every request is its own batch, at once. */
const NO_BATCHING = { maxSize: 1, maxWaitSeconds: 0 } as const

/**
 * Every problem of a configured policy set, in order; empty when it loads. Each policy must be a
 * valid `autonomy-policy@1.0` with one rule per action class, `expiry.defaultSeconds` and every
 * rule's `expiresSeconds` within `expiry.maxSeconds`; ids are unique; there is exactly one studio
 * policy; and each project policy, at most one per project, narrows that studio policy.
 */
export function policyProblems(policies: unknown, schemas: SchemaRegistry = new SchemaRegistry()): string[] {
  if (!Array.isArray(policies)) return ['policies must be a list of autonomy-policy@1.0 records']
  const problems: string[] = []
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
      if (rule.expiresSeconds !== undefined && rule.expiresSeconds > policy.expiry.maxSeconds) {
        problems.push(`${name}: the ${rule.actionClass} rule expires after ${rule.expiresSeconds} s, more than expiry.maxSeconds (${policy.expiry.maxSeconds})`)
      }
    }
    if (policy.expiry.defaultSeconds > policy.expiry.maxSeconds) {
      problems.push(`${name}: expiry.defaultSeconds (${policy.expiry.defaultSeconds}) is more than expiry.maxSeconds (${policy.expiry.maxSeconds})`)
    }
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
  return problems
}

/** Whether a policy's commands list allows an argv: a listed line word for word, alone or followed by more arguments. */
function allows(policy: AutonomyPolicy, argv: readonly string[]): boolean {
  return (policy.commands ?? []).some((line) => {
    const words = line.split(' ')
    return words.length <= argv.length && words.every((word, i) => argv[i] === word)
  })
}

/** A configured policy set, valid by {@link policyProblems}: the studio policy and the project policies that narrow it. */
export class PolicySet {
  readonly studio: AutonomyPolicy
  private readonly projects = new Map<string, AutonomyPolicy>()

  private constructor(policies: readonly AutonomyPolicy[]) {
    this.studio = policies.find((p) => p.scope === 'studio')!
    for (const p of policies) if (p.scope === 'project') this.projects.set(p.projectId!, p)
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
   * The strictest rule for a class over the policies that apply to it. A project policy constrains
   * only the classes it names; a class the studio policy does not name takes each policy's rule or
   * default, so the stricter default applies where neither names it.
   */
  effective(actionClass: ActionClass, projectId?: string): EffectiveRule {
    const [studio, ...narrowing] = this.of(projectId)
    const names = (p: AutonomyPolicy): boolean => p.rules.some((r) => r.actionClass === actionClass)
    const named = names(studio!)
    let best: EffectiveRule | undefined
    const requires = new Set<Check>()
    for (const policy of [studio!, ...narrowing.filter((p) => !named || names(p))]) {
      const rule = policy.rules.find((r) => r.actionClass === actionClass)
      const mode = rule?.mode ?? policy.default
      for (const check of rule?.requires ?? []) requires.add(check)
      if (!best || rank(mode) > rank(best.mode)) best = { policy, mode, named: rule !== undefined, requires: [], ...(rule?.expiresSeconds !== undefined ? { expiresSeconds: rule.expiresSeconds } : {}) }
    }
    return { ...best!, requires: [...requires] }
  }

  /**
   * Judge one action. A command whose argv every policy's list allows (the studio's, and the
   * project's when it has one) is judged by what it does, as `workspace-write`, unless the
   * `command` class is forbidden; any other command is the `command` class.
   */
  judge(action: Action): Judgement {
    const policies = this.of(action.projectId)
    const argv = action.command
    const listed = action.class === 'command' && argv !== undefined && allows(policies[0]!, argv)
      && policies.slice(1).every((p) => p.commands === undefined || allows(p, argv))
      && this.effective('command', action.projectId).mode !== 'forbid'
    const actionClass: ActionClass = listed ? 'workspace-write' : action.class
    const rule = this.effective(actionClass, action.projectId)
    const failedChecks = rule.mode === 'auto' || rule.mode === 'notify' ? rule.requires.filter((c) => action.checks?.[c] !== true) : []
    return { actionClass, rule, failedChecks, policies }
  }

  /** How long a request for the class waits: its rule's expiry, else the stricter default, never more than the stricter maximum. */
  expirySeconds(actionClass: ActionClass, projectId?: string): number {
    const policies = this.of(projectId)
    const max = Math.min(...policies.map((p) => p.expiry.maxSeconds))
    return Math.min(this.effective(actionClass, projectId).expiresSeconds ?? Math.min(...policies.map((p) => p.expiry.defaultSeconds)), max)
  }

  /** The batch rule for a project's requests: the first policy that names one, the studio's first. */
  batchRule(projectId?: string): { maxSize: number; maxWaitSeconds: number } {
    return this.of(projectId).map((p) => p.batch).find((b) => b !== undefined) ?? NO_BATCHING
  }
}
