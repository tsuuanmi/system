/**
 * The move from hand-named agent Workers to Workers derived as account × role (PROP-0012 phase F,
 * "Migration from hand-named rows"). {@link planMigration} is a pure rule: from the loaded rows, the
 * enrolled accounts, and the ledger's pools, it gives the roles, assignments, provider settings, and
 * pool templates of the new row, each old Worker's new id, and what stops the move. Nothing changes
 * until the operator applies it ({@link Cutover}): then each old Worker's move is an `enrollment`
 * decision, its agent sessions and runs are moved to its new id (each move kept, so a rollback puts
 * exactly those back), and the cutover itself is a decision. From then on the hand-named rows are
 * refused; until then they run exactly as before. A rollback undoes the moves and lifts the refusal,
 * recorded as a decision too (INV-13).
 * @module
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { type ContentId, canonicalJson } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { PoolState, PoolTemplate } from '@tsuuanmi/system-resources-core'
import type { AgentAccount } from './accounts.ts'
import { type AgentAssignmentConfig, type AgentProviderConfig, type AgentRoleConfig, type AgentRoleRuntime, workerIdOf } from './roles.ts'

/** A hand-named row as the planner reads it (the `workers` entries of the old shape). */
export interface HandNamedRow {
  id: string
  runtime: string
  workspace: string
  sandbox: AgentRoleConfig['sandbox']
  tier: AgentRoleConfig['tier']
  quotaClass?: AgentRoleConfig['quotaClass']
  tools?: string[] | undefined
  model?: string | undefined
  maxTurns?: number | undefined
  pool?: string | undefined
  account?: string | undefined
  windows?: Record<string, string> | undefined
  worktreePerRun?: boolean | undefined
  limitCooldownSeconds?: number | undefined
  family?: string | undefined
  reviewMember?: boolean | undefined
}

/** What becomes of one hand-named Worker. */
export interface WorkerMove {
  /** Its id, `agent:<id>`. */
  from: string
  runtime: string
  role: string
  /** The Worker it becomes, `agent:<accountId>/<role>`; absent when it stops (its account is not ready, and the operator stops its runtime). */
  to?: string
  account?: string
  why: string
}

export interface MigrationPlan {
  workers: WorkerMove[]
  roles: AgentRoleConfig[]
  assignments: AgentAssignmentConfig[]
  providers: AgentProviderConfig[]
  /** Pool templates for the `resources` row, from the old rows' pools. */
  templates: PoolTemplate[]
  /** Why the move cannot be applied now; empty when it can. */
  blockers: string[]
}

export interface PlanInput {
  rows: readonly HandNamedRow[]
  providers: readonly AgentProviderConfig[]
  accounts: readonly AgentAccount[]
  /** Each runtime kind registered now, with its own configured home. */
  runtimes: ReadonlyMap<string, { home?: string | undefined }>
  /** The ledger's pools, or undefined with no ledger. */
  pools: readonly PoolState[] | undefined
  /** Runtimes whose Workers the operator stops at the cutover, their account not ready (PROP-0012 open question 1). */
  stop: readonly string[]
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFAULT_COOLDOWN = 3600
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The move from the hand-named rows (a pure rule, `agent-workers.migration` version 1):
 * - **Roles.** Rows that agree on what the work needs (workspace, sandbox, tier, quota class,
 *   `worktreePerRun`, `reviewMember`) are one role, with what each runtime sets (`tools`, `model`,
 *   `maxTurns`, `family`) under `runtimes`; a second row of one runtime in such a group starts another
 *   role, since one account has one Worker per role. A read-only role is `review`, a writing one
 *   `develop`, and later ones of a kind `review-2`, … in the order of their first row's id.
 * - **Assignments.** Each runtime's configured home is slot 1 of its provider: the account enrolled
 *   there serves the roles of that runtime's rows, by the id it was verified as. An account not
 *   `ready` stops the move, unless the operator stops that runtime (`stop`): its rows then become no
 *   Worker, and its roles keep what they set for it, for the assignment the operator adds later.
 * - **Providers.** The row's provider entries, kept, with what derived Workers draw on: an old `pool`
 *   becomes the provider's pool template (with its windows and cooldown), and
 *   `maxConcurrentRunsPerAccount` is the number of its rows, so as many of its runs run at once as did.
 * - **Templates.** Each old pool, as a template of its runtime with the pool's kind and windows.
 */
export function planMigration(input: PlanInput): MigrationPlan {
  const blockers: string[] = []
  const rows = [...input.rows].sort((a, b) => byString(a.id, b.id))
  // Roles: one group per work setting, a new role in a group for each repeated runtime.
  const groups = new Map<string, Array<Map<string, HandNamedRow>>>()
  const order: Array<Map<string, HandNamedRow>> = []
  for (const row of rows) {
    const key = canonicalJson([resolve(row.workspace), row.sandbox, row.tier, row.quotaClass ?? 'agent-plan', row.worktreePerRun === true, row.reviewMember === true])
    const layers = groups.get(key) ?? []
    groups.set(key, layers)
    let layer = layers.find((l) => !l.has(row.runtime))
    if (!layer) {
      layer = new Map()
      layers.push(layer)
      order.push(layer)
    }
    layer.set(row.runtime, row)
  }
  const counts = new Map<string, number>()
  const roleOf = new Map<string, string>()
  const roles: AgentRoleConfig[] = order.map((layer) => {
    const first = [...layer.values()][0]!
    const base = first.sandbox === 'read-only' ? 'review' : 'develop'
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    const id = n === 1 ? base : `${base}-${n}`
    const runtimes: Record<string, AgentRoleRuntime> = {}
    for (const [runtime, row] of [...layer].sort(([a], [b]) => byString(a, b))) {
      roleOf.set(row.id, id)
      const own: AgentRoleRuntime = {
        ...(row.tools?.length ? { tools: [...row.tools] } : {}), ...(row.model ? { model: row.model } : {}), ...(row.maxTurns ? { maxTurns: row.maxTurns } : {}),
        ...(row.family !== undefined ? { family: row.family } : {}),
      }
      if (Object.keys(own).length) runtimes[runtime] = own
    }
    return {
      id, workspace: first.workspace, sandbox: first.sandbox, tier: first.tier,
      ...(first.quotaClass && first.quotaClass !== 'agent-plan' ? { quotaClass: first.quotaClass } : {}),
      ...(first.worktreePerRun ? { worktreePerRun: true } : {}), ...(first.reviewMember ? { reviewMember: true } : {}),
      ...(Object.keys(runtimes).length ? { runtimes } : {}),
    }
  })
  // Providers and templates: what a runtime's rows draw on becomes its provider's.
  const runtimes = [...new Set(rows.map((r) => r.runtime))].sort(byString)
  const templates: PoolTemplate[] = []
  const providers: AgentProviderConfig[] = input.providers.filter((p) => !runtimes.includes(p.provider)).map((p) => ({ ...p }))
  for (const runtime of runtimes) {
    const own = rows.filter((r) => r.runtime === runtime)
    const entry: AgentProviderConfig = { ...input.providers.find((p) => p.provider === runtime) ?? { provider: runtime } }
    const meters = new Set(own.map((r) => canonicalJson([r.pool ?? null, r.account ?? null])))
    const windows = new Set(own.map((r) => canonicalJson(r.windows ?? {})))
    const cooldowns = new Set(own.map((r) => r.limitCooldownSeconds ?? DEFAULT_COOLDOWN))
    const names = own.map((r) => `agent:${r.id}`).join(', ')
    if (meters.size > 1) blockers.push(`${names} of ${runtime} draw on different pools (or some on none): each of its accounts draws on one pool template, so give them one pool first`)
    if (windows.size > 1) blockers.push(`${names} of ${runtime} map limit windows differently: give them one windows map first`)
    if (cooldowns.size > 1) blockers.push(`${names} of ${runtime} have different limitCooldownSeconds: give them one first`)
    const metered = own.find((r) => r.pool !== undefined)
    if (metered && meters.size === 1) {
      const pool = input.pools?.find((p) => p.pool === metered.pool && p.account === metered.account)
      if (!input.pools) blockers.push(`agent:${metered.id} draws on pool ${metered.pool}, and no resource ledger is loaded to read it from`)
      else if (!pool) blockers.push(`agent:${metered.id} draws on pool ${metered.pool} of ${metered.account}, which the resource ledger does not configure`)
      else if (!NAME.test(pool.pool)) blockers.push(`the pool ${pool.pool} of agent:${metered.id} cannot name a pool template (letters, digits, '.', '_', '-'; at most 64): rename it first`)
      else if (templates.some((t) => t.template === pool.pool)) blockers.push(`the pool ${pool.pool} is drawn on by Workers of two runtimes; a template applies to one`)
      else {
        templates.push({ template: pool.pool, group: runtime, kind: pool.kind, windows: pool.windows.map((w) => ({ ...w })), ...(pool.unknown === 'available' ? { unknown: 'available' as const } : {}) })
        entry.pool = pool.pool
        if (Object.keys(metered.windows ?? {}).length) entry.windows = { ...metered.windows }
      }
    }
    const cooldown = own[0]!.limitCooldownSeconds ?? DEFAULT_COOLDOWN
    if (cooldowns.size === 1 && cooldown !== DEFAULT_COOLDOWN) entry.limitCooldownSeconds = cooldown
    // As many of its runs at once as its rows ran: each ran one at a time, on the one account.
    if (own.length > 1) entry.maxConcurrentRunsPerAccount = own.length
    providers.push(entry)
  }
  providers.sort((a, b) => byString(a.provider, b.provider))
  // Assignments: slot 1 of each runtime is its configured home, and its account serves the rows' roles.
  const assigned = new Map<string, Set<string>>()
  const workers: WorkerMove[] = []
  for (const runtime of runtimes) {
    const own = rows.filter((r) => r.runtime === runtime)
    const registered = input.runtimes.get(runtime)
    const slot1 = input.accounts.find((a) => a.provider === runtime && a.slot === 1)
    const stopping = input.stop.includes(runtime)
    let account: string | undefined
    let why: string
    if (!registered) {
      why = `no ${runtime} runtime is registered (its row is off), so the account in its home cannot be read`
      if (!stopping) blockers.push(`${why}: turn its row on, or stop its Workers at the cutover (--stop ${runtime})`)
    } else if (!slot1) {
      why = `no account is enrolled in ${runtime}'s home`
      if (!stopping) blockers.push(`${why}: enroll it first (system account login ${runtime}, which adopts the home as slot 1 and verifies who is signed in)`)
    } else if (registered.home !== undefined && resolve(slot1.home) !== resolve(registered.home)) {
      why = `slot 1 of ${runtime} is ${slot1.home}, not the runtime's own home ${registered.home}, where its hand-named Workers run`
      if (!stopping) blockers.push(`${why}: the move keeps each Worker on the account it runs on now`)
    } else if (slot1.status !== 'ready' || !slot1.accountId) {
      const status = `${slot1.status}${slot1.quarantine ? ` (${slot1.quarantine.reason})` : ''}`
      why = `the account in ${runtime}'s home (slot 1) is ${status}, and only a ready account's Workers take work`
      if (!stopping) {
        blockers.push(slot1.quarantine?.reason === 'unverified'
          ? `${why}: the cutover waits until its identity can be verified, or stop its Workers at the cutover (--stop ${runtime}; PROP-0012 open question 1)`
          : `${why}: resolve it first (docs/operations/runbooks.md#resolve-a-quarantined-agent-account), or stop its Workers at the cutover (--stop ${runtime})`)
      }
    } else {
      account = slot1.accountId
      why = `${runtime}'s home is slot 1, signed in as ${account}`
    }
    for (const row of own) {
      const role = roleOf.get(row.id)!
      if (account) {
        const set = assigned.get(account) ?? new Set()
        set.add(role)
        assigned.set(account, set)
        workers.push({ from: `agent:${row.id}`, runtime, role, to: workerIdOf(account, role), account, why })
      } else {
        workers.push({ from: `agent:${row.id}`, runtime, role, why: stopping ? `${why}; stopped by the operator at the cutover` : why })
      }
    }
  }
  const assignments = [...assigned].sort(([a], [b]) => byString(a, b)).map(([account, set]) => ({ account, roles: [...set].sort(byString) }))
  return { workers: workers.sort((a, b) => byString(a.from, b.from)), roles, assignments, providers, templates, blockers }
}

/** The applied cutover, as stored. */
export interface CutoverRecord {
  /** The `enrollment` decision that applied it. */
  decision: ContentId
  appliedAt: string
  plan: MigrationPlan
}

/** The store tables of the cutover (agent-workers migration 11): the applied cutover, and each session and run it moved. */
export const CUTOVER_MIGRATION = {
  version: 11,
  sql: `CREATE TABLE agent_cutover (id INTEGER PRIMARY KEY CHECK (id = 1), plan TEXT NOT NULL, decision TEXT NOT NULL, applied_at TEXT NOT NULL);
  CREATE TABLE agent_cutover_moves (kind TEXT NOT NULL, key TEXT NOT NULL, old_worker TEXT NOT NULL, new_worker TEXT NOT NULL, PRIMARY KEY (kind, key));`,
}

const DECIDER = { type: 'rule' as const, id: 'agent-workers.migration', version: '1' }
const PRODUCER = { producer: { type: 'system' as const, ref: 'agent-workers' } }
const now = (): string => new Date().toISOString()

/** How many agent sessions and runs a cutover moved, or a rollback moved back. */
export interface Moved { sessions: number; runs: number }

/** The applied cutover of one install, on `ctx.store` (one daemon owns it, INV-1). */
export class Cutover {
  constructor(private readonly ctx: Context) {}

  /** The cutover in force, or undefined while the hand-named rows may still load. */
  state(): CutoverRecord | undefined {
    const row = this.ctx.store.db.prepare('SELECT plan, decision, applied_at FROM agent_cutover WHERE id = 1').get() as { plan: string; decision: string; applied_at: string } | undefined
    return row && { decision: row.decision as ContentId, appliedAt: row.applied_at, plan: JSON.parse(row.plan) as MigrationPlan }
  }

  /**
   * Apply a plan: refused while it has blockers, or while a run of an old Worker is queued or running
   * (drain first); applied already, nothing changes and the cutover in force is returned. Otherwise, in
   * one transaction: an `enrollment` decision per old Worker (`migrated` to its new id, or `stopped`),
   * its agent sessions and runs moved to its new id, and the cutover's own decision, whose inputs are
   * theirs. `inputs` gives each account's latest enrollment decision.
   */
  apply(plan: MigrationPlan, inputs: (account: string) => ContentId | undefined): { cutover: CutoverRecord; applied: boolean; moved: Moved } {
    return this.ctx.store.transaction((db) => {
      const current = this.state()
      if (current) return { cutover: current, applied: false, moved: { sessions: 0, runs: 0 } }
      if (plan.blockers.length) throw new ProviderError('invalid_input', `the cutover is refused, nothing changed: ${plan.blockers.join('; ')}`)
      const old = plan.workers.map((w) => w.from)
      const active = old.length
        ? db.prepare(`SELECT run_id, worker FROM agent_runs WHERE status IN ('queued', 'running') AND worker IN (${old.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 8`).all(...old) as Array<{ run_id: string; worker: string }>
        : []
      if (active.length) throw new ProviderError('invalid_input', `the cutover is refused, nothing changed: ${active.map((r) => `${r.run_id} on ${r.worker}`).join(', ')} ${active.length > 1 ? 'are' : 'is'} queued or running; drain first (system drain)`)
      const moved: Moved = { sessions: 0, runs: 0 }
      const decisions: ContentId[] = []
      for (const move of plan.workers) {
        const option = move.to ? 'migrated' : 'stopped'
        const decision = this.ctx.artifacts.recordDecision({
          schema: 'decision@1.8', decisionType: 'enrollment',
          question: `Which Worker does the hand-named agent Worker ${move.from} become?`,
          inputs: move.account ? [inputs(move.account)].filter((d): d is ContentId => d !== undefined) : [],
          candidates: [
            { option: 'migrated', selected: option === 'migrated', reasons: [move.to ? `${move.to}: ${move.why}` : `not migrated: ${move.why}`] },
            { option: 'stopped', selected: option === 'stopped', reasons: [move.to ? 'not stopped: its account is ready' : move.why] },
          ],
          decider: DECIDER,
          outcome: { option, detail: { from: move.from, runtime: move.runtime, role: move.role, ...(move.to ? { to: move.to, accountId: move.account } : {}) } },
          deterministic: true, rationale: move.why,
        }, PRODUCER)
        decisions.push(decision.id as ContentId)
        if (!move.to) continue
        for (const [kind, table, key] of [['session', 'agent_sessions', 'session_id'], ['run', 'agent_runs', 'run_id']] as const) {
          db.prepare(`INSERT INTO agent_cutover_moves (kind, key, old_worker, new_worker) SELECT ?, ${key}, worker, ? FROM ${table} WHERE worker = ?`).run(kind, move.to, move.from)
          const changes = Number(db.prepare(`UPDATE ${table} SET worker = ? WHERE worker = ?`).run(move.to, move.from).changes)
          if (kind === 'session') moved.sessions += changes
          else moved.runs += changes
        }
      }
      const at = now()
      const decision = this.ctx.artifacts.recordDecision({
        schema: 'decision@1.8', decisionType: 'enrollment',
        question: 'Are the hand-named agent Workers replaced by Workers derived as account × role?',
        inputs: decisions,
        candidates: [
          { option: 'applied', selected: true, reasons: [`the operator applied the move: ${plan.workers.filter((w) => w.to).length} Worker(s) migrated, ${plan.workers.filter((w) => !w.to).length} stopped; ${moved.sessions} session(s) and ${moved.runs} run(s) moved to their new ids`] },
          { option: 'kept', selected: false, reasons: ['not kept: from now on the hand-named rows are refused at load'] },
        ],
        decider: DECIDER,
        outcome: {
          option: 'applied',
          detail: {
            workers: plan.workers.map((w) => ({ from: w.from, ...(w.to ? { to: w.to } : {}) })), roles: plan.roles.map((r) => r.id),
            assignments: plan.assignments.map((a) => ({ account: a.account, roles: a.roles })), sessions: moved.sessions, runs: moved.runs,
          },
        },
        deterministic: true, rationale: 'agent Workers are account × role (PROP-0012 phase F, ADR-0051); the hand-named rows are refused once this applies',
      }, PRODUCER)
      db.prepare('INSERT INTO agent_cutover (id, plan, decision, applied_at) VALUES (1, ?, ?, ?)').run(JSON.stringify(plan), decision.id, at)
      return { cutover: { decision: decision.id as ContentId, appliedAt: at, plan }, applied: true, moved }
    })
  }

  /**
   * Undo the cutover: refused while a run of a Worker it moved to is queued or running (drain first);
   * with none in force, nothing changes. Otherwise, in one transaction: each session and run it moved
   * back to its old Worker (one moved again since is left as it is), the refusal of the hand-named rows
   * lifted, and a `rolled-back` decision whose input is the cutover's.
   */
  rollback(): { rolledBack: boolean; moved: Moved; decision?: ContentId } {
    return this.ctx.store.transaction((db) => {
      const current = this.state()
      if (!current) return { rolledBack: false, moved: { sessions: 0, runs: 0 } }
      const targets = current.plan.workers.flatMap((w) => (w.to ? [w.to] : []))
      const active = targets.length
        ? db.prepare(`SELECT run_id, worker FROM agent_runs WHERE status IN ('queued', 'running') AND worker IN (${targets.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 8`).all(...targets) as Array<{ run_id: string; worker: string }>
        : []
      if (active.length) throw new ProviderError('invalid_input', `the rollback is refused, nothing changed: ${active.map((r) => `${r.run_id} on ${r.worker}`).join(', ')} ${active.length > 1 ? 'are' : 'is'} queued or running; drain first (system drain)`)
      const moved: Moved = { sessions: 0, runs: 0 }
      for (const [kind, table, key] of [['session', 'agent_sessions', 'session_id'], ['run', 'agent_runs', 'run_id']] as const) {
        const changes = Number(db.prepare(`UPDATE ${table} SET worker = (SELECT old_worker FROM agent_cutover_moves m WHERE m.kind = ? AND m.key = ${table}.${key})
          WHERE EXISTS (SELECT 1 FROM agent_cutover_moves m WHERE m.kind = ? AND m.key = ${table}.${key} AND m.new_worker = ${table}.worker)`).run(kind, kind).changes)
        if (kind === 'session') moved.sessions = changes
        else moved.runs = changes
      }
      const decision = this.ctx.artifacts.recordDecision({
        schema: 'decision@1.8', decisionType: 'enrollment',
        question: 'Are the hand-named agent Workers replaced by Workers derived as account × role?',
        inputs: [current.decision],
        candidates: [
          { option: 'rolled-back', selected: true, reasons: [`the operator undid the cutover of ${current.appliedAt}: ${moved.sessions} session(s) and ${moved.runs} run(s) moved back to their hand-named Workers`] },
          { option: 'applied', selected: false, reasons: ['not applied any more: the hand-named rows load again'] },
        ],
        decider: DECIDER,
        outcome: { option: 'rolled-back', detail: { cutover: current.decision, sessions: moved.sessions, runs: moved.runs } },
        deterministic: true, rationale: 'the operator rolled the cutover back (system account migrate --rollback)',
      }, PRODUCER)
      db.prepare('DELETE FROM agent_cutover_moves').run()
      db.prepare('DELETE FROM agent_cutover WHERE id = 1').run()
      return { rolledBack: true, moved, decision: decision.id as ContentId }
    })
  }
}
