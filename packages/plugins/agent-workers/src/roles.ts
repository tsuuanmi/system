/**
 * Workers = account × role (PROP-0012 phase F, ADR-0051): role templates defined once, assignments
 * that give each enrolled account its roles (the trusted envelope of account choice, INV-6), and
 * the Workers derived from them, `agent:<accountId>/<role>`, never named by hand. A pure function of
 * the configuration: the same roles and assignments always derive the same Workers, in the same
 * order. What a Worker of an account draws on (its pool, windows, cooldown, how many of its runs
 * run at once) is its provider's, so it is the same for every role of the account.
 * @module
 */
import { isAbsolute, resolve } from 'node:path'
import type { SandboxMode } from '@tsuuanmi/system-agent-runtime-core'
import { DESCRIPTION, LABEL, MAX_DESCRIPTION, MAX_LABEL, type ProviderAccounts } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { templatePool } from '@tsuuanmi/system-resources-core'
import { type QuotaClass, type Tier, WORK_KIND } from '@tsuuanmi/system-workers-core'

/** An agent provider (a runtime) of the `agent-workers` row: how its accounts are used, enrolled, metered, and run. */
export interface AgentProviderConfig extends ProviderAccounts {
  /** How many accounts may be enrolled (ADR-0051; default 1, its own home adopted as slot 1). */
  slots?: number | undefined
  /** Runs one account runs at once, across all its roles (default 1); one run at a time per Worker as well. Derived Workers only. */
  maxConcurrentRunsPerAccount?: number | undefined
  /** The pool template (resources `templates`) each of its accounts' Workers draws on: pool `<pool>/<accountId>`. Unset: not metered. */
  pool?: string | undefined
  /** The runtime's limit window names mapped to the template's window ids, once per provider. */
  windows?: Record<string, string> | undefined
  /** How long a limit hit with no reset time closes the account's pool (with none, cools the account down), in seconds (default 3600). */
  limitCooldownSeconds?: number | undefined
}

/** What a role sets for one runtime: never a routing input. */
export interface AgentRoleRuntime {
  tools?: string[] | undefined
  model?: string | undefined
  maxTurns?: number | undefined
  /** Its provider family (ADR-0027; default the runtime); required for a review member. */
  family?: string | undefined
}

/** A role template (defined once): what the work needs, whatever account serves it. */
export interface AgentRoleConfig {
  id: string
  workspace: string
  sandbox: SandboxMode
  tier: Tier
  quotaClass?: QuotaClass | undefined
  worktreePerRun?: boolean | undefined
  reviewMember?: boolean | undefined
  /** The kinds of work its Workers take (ADR-0057); unset, any work. */
  kinds?: string[] | undefined
  /** What its Workers are for, in the operator's words (`capability-descriptor@1.7`); never a routing input. */
  description?: string | undefined
  /** What differs per runtime, by runtime kind. */
  runtimes?: Record<string, AgentRoleRuntime> | undefined
}

/** Which roles an enrolled account serves (D24: assigned): by its id, never by a name. */
export interface AgentAssignmentConfig {
  account: string
  roles: string[]
  /** Its display label in the operator's words, such as `science`: for people only, never a routing input or part of a Worker id. */
  label?: string | undefined
}

/** A Worker derived from one assignment of one role: the account it runs on, and the role. */
export interface DerivedWorker {
  /** The id after `agent:`, `<accountId>/<role>`. */
  id: string
  runtime: string
  workspace: string
  sandbox: SandboxMode
  tier: Tier
  quotaClass: QuotaClass
  worktreePerRun: boolean
  reviewMember: boolean
  kinds?: string[]
  tools?: string[]
  model?: string
  maxTurns?: number
  family?: string
  pool?: string
  account?: string
  windows?: Record<string, string>
  limitCooldownSeconds?: number
  description?: string
  derived: { accountId: string; role: string }
}

/** A role id. */
export const ROLE = /^[a-z][a-z0-9-]{0,31}$/
/** An agent account id, `<provider>:<16 hex>` (`agent-account@1.0`). */
export const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,63}:[0-9a-f]{16}$/
/** A pool template's id (resources `templates`). */
const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** The most roles, and the most Workers they derive (INV-9; `mcp-agent-accounts` lists at most 256 Workers). */
export const MAX_ROLES = 64
export const MAX_DERIVED = 256
/** The most runs one account runs at once. */
export const MAX_CONCURRENT_PER_ACCOUNT = 16

/** The Worker id of an account in a role: `agent:<accountId>/<role>`. */
export const workerIdOf = (accountId: string, role: string): string => `agent:${accountId}/${role}`
/** The provider (runtime) an account id names: its namespace. */
export const providerOfAccount = (accountId: string): string => accountId.slice(0, accountId.indexOf(':'))

const fail = (message: string): never => {
  throw new ProviderError('config_error', message)
}

/**
 * Check the provider entries' derived-only settings (`pool`, `windows`, `limitCooldownSeconds`,
 * `maxConcurrentRunsPerAccount`); the rest is checked where the setting is applied. Throws `config_error`.
 */
export function checkProviders(providers: readonly AgentProviderConfig[]): void {
  for (const [i, p] of providers.entries()) {
    const at = `agent-workers.providers[${i}] (${p.provider})`
    if (p.pool !== undefined && (typeof p.pool !== 'string' || !TEMPLATE.test(p.pool))) fail(`${at}.pool: ${JSON.stringify(p.pool)} is not a pool template id`)
    if (p.pool === undefined && Object.keys(p.windows ?? {}).length) fail(`${at}.windows: windows map limit windows to a pool template, and no pool is set`)
    for (const [name, window] of Object.entries(p.windows ?? {})) {
      if (typeof window !== 'string' || !window.length) fail(`${at}.windows.${name}: a window id of the template`)
    }
    if (p.limitCooldownSeconds !== undefined && !(Number.isInteger(p.limitCooldownSeconds) && p.limitCooldownSeconds >= 60 && p.limitCooldownSeconds <= 604_800)) {
      fail(`${at}.limitCooldownSeconds: 60 to 604800 seconds`)
    }
    const n = p.maxConcurrentRunsPerAccount
    if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENT_PER_ACCOUNT)) fail(`${at}.maxConcurrentRunsPerAccount: 1 to ${MAX_CONCURRENT_PER_ACCOUNT}`)
  }
}

/** The most kinds of work one Worker takes (`capability-descriptor@1.6` `kinds`). */
export const MAX_KINDS = 16

/**
 * What is wrong with a Worker's or role's `kinds` (ADR-0057), or undefined when nothing is: at least
 * one, at most {@link MAX_KINDS}, each a kind label once; never on a review member, whose steps name
 * no kind, so it would take none of them.
 */
export function kindsProblem(kinds: unknown, reviewMember: boolean | undefined): string | undefined {
  if (kinds === undefined) return undefined
  if (!Array.isArray(kinds) || !kinds.length || kinds.length > MAX_KINDS) return `must list 1 to ${MAX_KINDS} kinds of work`
  const bad = kinds.find((k) => typeof k !== 'string' || !WORK_KIND.test(k))
  if (bad !== undefined) return `${JSON.stringify(bad)} is not a kind of work (${WORK_KIND})`
  if (new Set(kinds).size !== kinds.length) return 'name a kind twice'
  if (reviewMember) return 'are not for a review member: its steps name no kind, so it would take none of them'
  return undefined
}

/** Whether a provider entry sets anything only derived Workers use. */
export const setsDerivedOnly = (p: AgentProviderConfig): boolean =>
  p.pool !== undefined || Object.keys(p.windows ?? {}).length > 0 || p.limitCooldownSeconds !== undefined || p.maxConcurrentRunsPerAccount !== undefined

/**
 * The Workers the roles and assignments derive (ADR-0051): one per assignment and role it names,
 * `agent:<accountId>/<role>`, ordered by id. The role gives the work's settings, with what it sets for
 * the account's runtime; the account's provider gives what it draws on. Refuses, as `config_error`, a
 * role or assignment that is malformed, named twice, or unknown, and more than {@link MAX_DERIVED}.
 */
export function deriveWorkers(roles: readonly AgentRoleConfig[], assignments: readonly AgentAssignmentConfig[], providers: readonly AgentProviderConfig[]): DerivedWorker[] {
  if (roles.length > MAX_ROLES) fail(`agent-workers.roles: ${roles.length} roles, more than ${MAX_ROLES}`)
  const byId = new Map<string, AgentRoleConfig>()
  for (const [i, role] of roles.entries()) {
    const at = `agent-workers.roles[${i}]`
    if (typeof role?.id !== 'string' || !ROLE.test(role.id)) fail(`${at}.id: ${JSON.stringify(role?.id)} must match ${ROLE}`)
    if (byId.has(role.id)) fail(`${at}.id: the role ${role.id} is defined twice; a role is defined once`)
    if (typeof role.workspace !== 'string' || !isAbsolute(role.workspace)) fail(`${at} (${role.id}).workspace must be an absolute path`)
    if (role.reviewMember) {
      // A writer never reviews (INV-15); a member works in an empty directory, never a worktree.
      if (role.sandbox !== 'read-only') fail(`${at} (${role.id}): a review member must be read-only (sandbox: read-only); a writer never reviews (INV-15)`)
      if (role.worktreePerRun) fail(`${at} (${role.id}): a review member works in an empty directory outside any repository, never a worktree per run (worktreePerRun)`)
    }
    const kinds = kindsProblem(role.kinds, role.reviewMember)
    if (kinds) fail(`${at} (${role.id}).kinds ${kinds}`)
    if (role.description !== undefined && (typeof role.description !== 'string' || !DESCRIPTION.test(role.description))) fail(`${at} (${role.id}).description must be plain text on one line, 1 to ${MAX_DESCRIPTION} characters`)
    for (const [runtime, settings] of Object.entries(role.runtimes ?? {})) {
      const family = settings?.family
      if (family !== undefined && (typeof family !== 'string' || !family.length || family.length > 128)) fail(`${at} (${role.id}).runtimes.${runtime}.family must be 1 to 128 characters`)
    }
    byId.set(role.id, role)
  }
  const meteredBy = new Map(providers.map((p) => [p.provider, p]))
  const seen = new Set<string>()
  const out: DerivedWorker[] = []
  for (const [i, assignment] of assignments.entries()) {
    const at = `agent-workers.assignments[${i}]`
    if (typeof assignment?.account !== 'string' || !ACCOUNT_ID.test(assignment.account)) {
      fail(`${at}.account: ${JSON.stringify(assignment?.account)} is not an agent account id (<provider>:<16 hex>, as system account list shows it)`)
    }
    if (seen.has(assignment.account)) fail(`${at}.account: ${assignment.account} is assigned twice; give it all its roles in one entry`)
    seen.add(assignment.account)
    if (!Array.isArray(assignment.roles) || !assignment.roles.length) fail(`${at} (${assignment.account}).roles: at least one role`)
    if (new Set(assignment.roles).size !== assignment.roles.length) fail(`${at} (${assignment.account}).roles: a role is named twice`)
    if (assignment.label !== undefined && (typeof assignment.label !== 'string' || !LABEL.test(assignment.label))) fail(`${at} (${assignment.account}).label must be plain text on one line, 1 to ${MAX_LABEL} characters`)
    const runtime = providerOfAccount(assignment.account)
    const provider = meteredBy.get(runtime)
    for (const name of assignment.roles) {
      const role = byId.get(name) ?? fail(`${at} (${assignment.account}).roles: no role ${JSON.stringify(name)} is defined`)
      const own = role.runtimes?.[runtime] ?? {}
      // Members are kept apart by provider family, which a runtime's name does not tell (ADR-0027).
      if (role.reviewMember && own.family === undefined) fail(`${at} (${assignment.account}): the role ${name} is a review member's, so it names the family of ${runtime} (roles.${name}.runtimes.${runtime}.family)`)
      out.push({
        id: `${assignment.account}/${name}`, runtime, workspace: role.workspace, sandbox: role.sandbox, tier: role.tier,
        quotaClass: role.quotaClass ?? 'agent-plan', worktreePerRun: role.worktreePerRun === true, reviewMember: role.reviewMember === true,
        ...(role.kinds ? { kinds: [...role.kinds] } : {}),
        ...(own.tools?.length ? { tools: [...own.tools] } : {}), ...(own.model ? { model: own.model } : {}), ...(own.maxTurns ? { maxTurns: own.maxTurns } : {}),
        ...(own.family !== undefined ? { family: own.family } : {}), ...(role.description !== undefined ? { description: role.description } : {}),
        ...(provider?.pool !== undefined ? { pool: templatePool(provider.pool, assignment.account), account: assignment.account, windows: { ...provider.windows } } : {}),
        ...(provider?.limitCooldownSeconds !== undefined ? { limitCooldownSeconds: provider.limitCooldownSeconds } : {}),
        derived: { accountId: assignment.account, role: name },
      })
    }
  }
  if (out.length > MAX_DERIVED) fail(`agent-workers.assignments derive ${out.length} Workers, more than ${MAX_DERIVED}`)
  // Workers of one workspace agree on worktreePerRun: a reviewer must read the tree it reviews, the writer's worktree.
  for (const role of byId.values()) {
    const other = [...byId.values()].find((r) => r !== role && resolve(r.workspace) === resolve(role.workspace) && !!r.worktreePerRun !== !!role.worktreePerRun)
    if (other) fail(`agent-workers roles ${other.id} and ${role.id} share the workspace ${role.workspace}, and only one of them works in a worktree per run (worktreePerRun): set it on both`)
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
