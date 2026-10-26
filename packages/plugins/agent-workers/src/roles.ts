/**
 * Workers = account × role (PROP-0012 phase F, ADR-0051): role templates defined once, assignments
 * that give each enrolled account its roles (the trusted envelope of account choice, INV-6), and
 * the Workers derived from them, `agent:<accountId>/<role>`, never named by hand. A pure function of
 * the configuration: the same roles and assignments always derive the same Workers, in the same
 * order. What a Worker of an account draws on (its pool, windows, cooldown, how many of its runs
 * run at once) is its provider's, so it is the same for every role of the account. A role may give
 * its Workers a model per tier on a runtime (ADR-0073): one Worker then offers every tier it declares.
 * @module
 */
import { isAbsolute, resolve } from 'node:path'
import type { SandboxMode } from '@tsuuanmi/system-agent-runtime-core'
import { DESCRIPTION, LABEL, MAX_DESCRIPTION, MAX_LABEL, type ProviderAccounts } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { templatePool } from '@tsuuanmi/system-resources-core'
import { type QuotaClass, type Tier, TIERS, WORK_KIND } from '@tsuuanmi/system-workers-core'

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
  /**
   * How often each ready account with a pool has its runtime's usage report read, in seconds (ADR-0059;
   * default {@link DEFAULT_LIMIT_READ_SECONDS}, at least 60, at most a day; 0 turns the periodic read off). With pool only.
   */
  limitReadSeconds?: number | undefined
  /**
   * Per-model quota (ADR-0073): a model whose provider reports a window of its own (a weekly window
   * per model) draws on one more pool per account, `<pool>/<accountId>` of this template, with the
   * runtime's window names mapped to its windows. A run on that model reserves on both pools, and its
   * pool's limit closes only the tiers that run that model. The model is named here and in the roles
   * only: configuration, never code (INV-11). With pool only.
   */
  modelPools?: AgentModelPool[] | undefined
}

/** One model's own pool (ADR-0073): the model as the role's tiers name it, its pool template, and the runtime's window names mapped to the template's windows. */
export interface AgentModelPool {
  model: string
  pool: string
  windows?: Record<string, string> | undefined
}

/** The periodic read of each account's usage report, by default (ADR-0059, D55): every 10 minutes. */
export const DEFAULT_LIMIT_READ_SECONDS = 600
/** The longest period between two reads of an account's usage report (INV-9). */
export const MAX_LIMIT_READ_SECONDS = 86_400

/** What a role sets for one tier on one runtime (ADR-0073): its model, and any runtime option that differs at that tier. */
export interface AgentRoleTier {
  model: string
  tools?: string[] | undefined
  maxTurns?: number | undefined
}

/** What a role sets for one runtime: never a routing input. */
export interface AgentRoleRuntime {
  tools?: string[] | undefined
  model?: string | undefined
  maxTurns?: number | undefined
  /** Its provider family (ADR-0027; default the runtime); required for a review member. */
  family?: string | undefined
  /**
   * The tiers the role's Workers on this runtime offer (ADR-0073), each with its model and the options
   * that differ at it (`tools`, `maxTurns`, else this runtime's): one Worker offers them all, and routing
   * serves it at the lowest of them a step admits. Replaces the role's one `tier` on this runtime.
   */
  tiers?: Partial<Record<Tier, AgentRoleTier>> | undefined
}

/** A role template (defined once): what the work needs, whatever account serves it. */
export interface AgentRoleConfig {
  id: string
  workspace: string
  sandbox: SandboxMode
  /** Its one tier on a runtime that declares no `tiers`; may be left out when every runtime it is assigned on declares them. */
  tier?: Tier | undefined
  quotaClass?: QuotaClass | undefined
  worktreePerRun?: boolean | undefined
  reviewMember?: boolean | undefined
  /**
   * A read-only research role (T262, ADR-0074, ./research.ts): its Workers' tools are reads and the
   * web tools only, at every tier, never a writing tool or a shell, and they take research work only
   * (kinds default `[research]`). Each web call passes the gate under the autonomy policy's web access grant.
   * With no `tier` and no `tiers` on a runtime, it is on the standard tier there.
   */
  research?: boolean | undefined
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

/** One tier a derived Worker offers: its model and options, and its model's pool (`<template>/<accountId>`) with the window map, when it has one. */
export interface DerivedTier {
  tier: Tier
  /** Declared by its role's `runtimes.<runtime>.tiers` (else the role's one tier, with a model pool). */
  declared: boolean
  model?: string
  tools?: string[]
  maxTurns?: number
  modelPool?: { pool: string; windows: Record<string, string> }
}

/** A Worker derived from one assignment of one role: the account it runs on, and the role. */
export interface DerivedWorker {
  /** The id after `agent:`, `<accountId>/<role>`. */
  id: string
  runtime: string
  workspace: string
  sandbox: SandboxMode
  /** Its lowest tier: with `tiers`, the first of them. */
  tier: Tier
  quotaClass: QuotaClass
  worktreePerRun: boolean
  reviewMember: boolean
  research?: boolean
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
  /**
   * What it runs at each tier it offers (ADR-0073), lowest first: the tier's model and options, and its
   * model's own pool when the provider names one (`modelPools`). Set when its role declares tiers on
   * its runtime (`declared`), or, for a one-tier role, when its provider gives models pools of their
   * own (so its one tier names the pools it draws on); `tier` is the first.
   */
  tiers?: DerivedTier[]
  derived: { accountId: string; role: string }
}

/** A role id. */
const ROLE = /^[a-z][a-z0-9-]{0,31}$/
/** An agent account id, `<provider>:<16 hex>` (`agent-account@1.0`). */
export const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,63}:[0-9a-f]{16}$/
/** A pool template's id (resources `templates`). */
const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** The most roles, and the most Workers they derive (INV-9; `mcp-agent-accounts` lists at most 256 Workers). */
const MAX_ROLES = 64
const MAX_DERIVED = 256
/** The most runs one account runs at once. */
export const MAX_CONCURRENT_PER_ACCOUNT = 16
/** The most models with a pool of their own one provider names (INV-9). */
export const MAX_MODEL_POOLS = 8
/** The longest model name a role or a provider entry gives. */
const MAX_MODEL = 200

/** The Worker id of an account in a role: `agent:<accountId>/<role>`. */
export const workerIdOf = (accountId: string, role: string): string => `agent:${accountId}/${role}`
/** The provider (runtime) an account id names: its namespace. */
const providerOfAccount =(accountId: string): string => accountId.slice(0, accountId.indexOf(':'))

const fail = (message: string): never => {
  throw new ProviderError('config_error', message)
}

/** What is wrong with a model name as configuration gives it (one word of plain text, 1 to {@link MAX_MODEL} characters), or undefined. */
function modelProblem(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model.length || model.length > MAX_MODEL) return `must be a model name of 1 to ${MAX_MODEL} characters`
  if ([...model].some((c) => c.charCodeAt(0) < 0x21 || c.charCodeAt(0) === 0x7f)) return 'must be one word of plain text (no space or control character)'
  return undefined
}

/**
 * Check the provider entries' derived-only settings (`pool`, `windows`, `limitCooldownSeconds`,
 * `limitReadSeconds`, `maxConcurrentRunsPerAccount`, `modelPools`); the rest is checked where the
 * setting is applied. Throws `config_error`.
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
    const read = p.limitReadSeconds
    if (read !== undefined && !(Number.isInteger(read) && (read === 0 || (read >= 60 && read <= MAX_LIMIT_READ_SECONDS)))) {
      fail(`${at}.limitReadSeconds: 0 (off) or 60 to ${MAX_LIMIT_READ_SECONDS} seconds`)
    }
    if (read !== undefined && p.pool === undefined) fail(`${at}.limitReadSeconds: the usage report is read into an account's pool, and no pool is set`)
    const n = p.maxConcurrentRunsPerAccount
    if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= MAX_CONCURRENT_PER_ACCOUNT)) fail(`${at}.maxConcurrentRunsPerAccount: 1 to ${MAX_CONCURRENT_PER_ACCOUNT}`)
    if (p.modelPools !== undefined) {
      if (!Array.isArray(p.modelPools) || p.modelPools.length > MAX_MODEL_POOLS) fail(`${at}.modelPools: a list of at most ${MAX_MODEL_POOLS} models' pools`)
      if (p.pool === undefined && p.modelPools.length) fail(`${at}.modelPools: a model's pool is drawn on beside its account's, and no pool is set`)
      const models = new Set<string>()
      const templates = new Set<string>(p.pool !== undefined ? [p.pool] : [])
      for (const [j, m] of p.modelPools.entries()) {
        const where = `${at}.modelPools[${j}]`
        const problem = modelProblem(m?.model)
        if (problem) fail(`${where}.model ${problem}`)
        if (models.has(m.model)) fail(`${where}.model: ${JSON.stringify(m.model)} is named twice; one pool per model`)
        models.add(m.model)
        if (typeof m.pool !== 'string' || !TEMPLATE.test(m.pool)) fail(`${where}.pool: ${JSON.stringify(m.pool)} is not a pool template id`)
        if (templates.has(m.pool)) fail(`${where}.pool: the template ${m.pool} is already drawn on by this provider; each model's pool is a template of its own`)
        templates.add(m.pool)
        for (const [name, window] of Object.entries(m.windows ?? {})) {
          if (typeof window !== 'string' || !window.length) fail(`${where}.windows.${name}: a window id of the template`)
        }
      }
    }
  }
}

/** The most kinds of work one Worker takes (`capability-descriptor@1.6` `kinds`). */
const MAX_KINDS = 16

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

/**
 * Check a runtime's `tiers` (ADR-0073): an object of 1 to 3 tiers, each with a model and, optionally,
 * the tools and turn limit that differ at it. Throws `config_error` at `at`.
 */
function tiersProblem(at: string, tiers: unknown): void {
  if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers)) fail(`${at} must be an object of tiers (${TIERS.join(', ')}), each with its model`)
  const entries = Object.entries(tiers as Record<string, unknown>)
  if (!entries.length) fail(`${at} must name at least one tier (${TIERS.join(', ')})`)
  for (const [tier, settings] of entries) {
    if (!TIERS.includes(tier as Tier)) fail(`${at}.${tier}: not a tier (${TIERS.join(', ')})`)
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) fail(`${at}.${tier} must be an object with its model`)
    const s = settings as Partial<AgentRoleTier> & Record<string, unknown>
    const extra = Object.keys(s).find((k) => !['model', 'tools', 'maxTurns'].includes(k))
    if (extra !== undefined) fail(`${at}.${tier}.${extra}: a tier sets its model, tools, and maxTurns only; what else differs per runtime is set on the runtime`)
    const problem = modelProblem(s.model)
    if (problem) fail(`${at}.${tier}.model ${problem}`)
    if (s.tools !== undefined && (!Array.isArray(s.tools) || s.tools.some((t) => typeof t !== 'string' || !t.length))) fail(`${at}.${tier}.tools must be a list of tool names`)
    if (s.maxTurns !== undefined && !(Number.isInteger(s.maxTurns) && s.maxTurns >= 1)) fail(`${at}.${tier}.maxTurns must be a whole number of at least 1`)
  }
}

/** A model's own pool on an account (ADR-0073), when its provider names one: `<template>/<accountId>`, with its window map. */
function modelPoolOf(provider: AgentProviderConfig | undefined, model: string, accountId: string): DerivedTier['modelPool'] {
  const own = provider?.modelPools?.find((m) => m.model === model)
  return own ? { pool: templatePool(own.pool, accountId), windows: { ...own.windows } } : undefined
}

/**
 * The tiers a role's Worker on a runtime offers (ADR-0073), lowest first: each declared tier's model,
 * its tools and turn limit (else the runtime's), and its model's pool on the account. Undefined when the
 * role declares no tiers on that runtime.
 */
function tiersOf(own: AgentRoleRuntime, provider: AgentProviderConfig | undefined, accountId: string): DerivedTier[] | undefined {
  if (!own.tiers) return undefined
  return TIERS.filter((t) => own.tiers![t] !== undefined).map((tier) => {
    const at = own.tiers![tier]!
    const tools = at.tools ?? own.tools
    const maxTurns = at.maxTurns ?? own.maxTurns
    const modelPool = modelPoolOf(provider, at.model, accountId)
    return { tier, declared: true, model: at.model, ...(tools?.length ? { tools: [...tools] } : {}), ...(maxTurns ? { maxTurns } : {}), ...(modelPool ? { modelPool } : {}) }
  })
}

/** Whether a provider entry sets anything only derived Workers use. */
export const setsDerivedOnly = (p: AgentProviderConfig): boolean =>
  p.pool !== undefined || Object.keys(p.windows ?? {}).length > 0 || p.limitCooldownSeconds !== undefined || p.limitReadSeconds !== undefined || p.maxConcurrentRunsPerAccount !== undefined
  || (p.modelPools?.length ?? 0) > 0

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
    if (role.tier !== undefined && !TIERS.includes(role.tier)) fail(`${at} (${role.id}).tier: ${JSON.stringify(role.tier)} is not a tier (${TIERS.join(', ')})`)
    for (const [runtime, settings] of Object.entries(role.runtimes ?? {})) {
      const family = settings?.family
      if (family !== undefined && (typeof family !== 'string' || !family.length || family.length > 128)) fail(`${at} (${role.id}).runtimes.${runtime}.family must be 1 to 128 characters`)
      if (settings?.model !== undefined) {
        const problem = modelProblem(settings.model)
        if (problem) fail(`${at} (${role.id}).runtimes.${runtime}.model ${problem}`)
      }
      if (settings?.tiers !== undefined) tiersProblem(`${at} (${role.id}).runtimes.${runtime}.tiers`, settings.tiers)
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
      // Capability stays the role's; the tiers it offers on this runtime, else its one tier (ADR-0073).
      const tiers = tiersOf(own, provider, assignment.account)
      // A research role with neither is on the standard tier (T262, ADR-0074).
      const tier = tiers?.[0]?.tier ?? role.tier ?? (role.research ? 'standard' : undefined) ?? fail(`${at} (${assignment.account}): the role ${name} gives no tier on ${runtime}: set its tier, or the tiers it offers there (roles.${name}.runtimes.${runtime}.tiers)`)
      // A one-tier role runs as before, unless its provider gives models pools of their own (ADR-0073):
      // then its one tier names the pools its runs draw on (the account's, and its model's when it has
      // one), so its headroom is never read from another model's pool.
      const modelPool = !tiers && own.model !== undefined ? modelPoolOf(provider, own.model, assignment.account) : undefined
      const perModel = !tiers && provider?.pool !== undefined && (provider.modelPools?.length ?? 0) > 0
      out.push({
        id: `${assignment.account}/${name}`, runtime, workspace: role.workspace, sandbox: role.sandbox, tier,
        quotaClass: role.quotaClass ?? 'agent-plan', worktreePerRun: role.worktreePerRun === true, reviewMember: role.reviewMember === true,
        ...(role.research ? { research: true } : {}),
        ...(role.kinds ? { kinds: [...role.kinds] } : {}),
        ...(own.tools?.length ? { tools: [...own.tools] } : {}), ...(own.model ? { model: own.model } : {}), ...(own.maxTurns ? { maxTurns: own.maxTurns } : {}),
        ...(own.family !== undefined ? { family: own.family } : {}), ...(role.description !== undefined ? { description: role.description } : {}),
        ...(provider?.pool !== undefined ? { pool: templatePool(provider.pool, assignment.account), account: assignment.account, windows: { ...provider.windows } } : {}),
        ...(provider?.limitCooldownSeconds !== undefined ? { limitCooldownSeconds: provider.limitCooldownSeconds } : {}),
        ...(tiers ? { tiers } : modelPool || perModel ? { tiers: [{ tier, declared: false, ...(own.model ? { model: own.model } : {}), ...(modelPool ? { modelPool } : {}) }] } : {}),
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
