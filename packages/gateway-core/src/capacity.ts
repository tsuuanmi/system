/**
 * Capacity now (docs/design/roster.md#capacity-now): the roster's "Right now" as data, made once on
 * the server from the roster and the board, so a lead (MCP `roster`, `system capacity`) and the
 * operator (the Workers page) read the same summary: each account's windows and whether it takes new
 * work now, the free Workers in the order their quota would be lost unused, the stalled runs, the
 * accounts with no quota left, the Workers that cannot work, and the ready board tasks with the
 * Worker a start would most likely go to. It decides nothing and stores nothing.
 *
 * A reading that is not known is never read as room (INV-2): a Worker whose account's quota cannot be
 * read is listed apart (`quotaUnknown`), never among the free, and an account whose windows have no reading
 * is `canWork: unknown`. Every list is bounded (INV-9, {@link CAPACITY_BOUNDS}), the rest counted in `more`.
 * @module
 */
import type { Known, Roster, RosterDescriptor, RosterEntry, RosterPoolView } from './roster.ts'

/** What capacity now lists and reads at most (INV-9). */
export const CAPACITY_BOUNDS = {
  /** Entries each list gives; the rest are counted in its `more`. */
  list: 16,
  /** Active board projects whose ready tasks are read, in id order; past them `ready` says `unread`. */
  projects: 32,
  /** Windows of one account listed; more make its `windows` unknown. */
  windows: 16,
} as const

/** One window of an account's pool now. */
export interface CapacityWindow { pool: string; id: string; seconds?: number; state: 'ok' | 'limited' | 'unknown'; used: Known<number>; resets: Known<string> }
/** An account: its pools' windows, and whether it takes new work now, with why. */
export interface CapacityAccount { account: string; name: string; windows: Known<CapacityWindow[]>; canWork: Known<boolean>; summary: string }
/**
 * The quota a free Worker has left: its account's window with the least left among those with a
 * current reading (one whose reset is still ahead), its used share, and when it resets.
 */
export interface CapacityQuota { pool: string; window: string; seconds?: number; used: number; left: number; resetsAt: string }
/** A Worker that takes work now. `quota` is `null` when no account quota applies to it (no account, or none tracked for its account). */
export interface CapacityFree {
  worker: string
  name: string
  account?: string
  role?: string
  kinds?: string[]
  tier: RosterDescriptor['tier']
  load: Known<{ running: number; queued: number; pending: number; slots: number }>
  quota: CapacityQuota | null
}
/** A Worker that takes work now as its source says, whose account's quota cannot be read now: never counted as free. */
export interface CapacityUnread { worker: string; name: string; account?: string; tier: RosterDescriptor['tier']; why: string }
export interface CapacityStalled { worker: string; name: string; execution: string; runId?: string; since: string }
export interface CapacityNoQuota { account: string; name: string; until: Known<string> }
export interface CapacityCannotWork { worker: string; name: string; state: 'unavailable' | 'quarantined'; reason: string }
/** A ready board task, and the Worker a start would most likely go to now (`null`: no Worker that takes work now can take its first step). */
export interface CapacityReady { projectId: string; taskId: string; title: string; template?: string; likely: Known<{ worker: string; name: string } | null> }
export interface CapacityList<T> { items: T[]; more: number }
export interface Capacity {
  asOf: string
  accounts: Known<CapacityList<CapacityAccount>>
  free: Known<CapacityList<CapacityFree>>
  /** The Workers ready as their source says whose account's quota cannot be read now: never counted free. */
  quotaUnknown: Known<CapacityList<CapacityUnread>>
  stalled: Known<CapacityList<CapacityStalled> & { unread?: string }>
  noQuota: Known<CapacityList<CapacityNoQuota>>
  cannotWork: Known<CapacityList<CapacityCannotWork>>
  ready: Known<CapacityList<CapacityReady> & { unread?: string }>
}

/** A ready board task as the board gives it. */
export interface CapacityTaskRead { projectId: string; taskId: string; title: string; template?: string | undefined; createdAt?: string | undefined }
/** A template's step as the engine previews it before a start (`templateSteps`). */
export interface CapacityStep { capabilities: string[]; tier: RosterDescriptor['tier']; kind?: string | undefined; source?: true | undefined }

/** What capacity now is made from: the roster, the descriptors it was made from, the ready tasks, and each of their templates' steps. */
export interface CapacityInput {
  roster: Pick<Roster, 'asOf' | 'workers'>
  descriptors: ReadonlyMap<string, RosterDescriptor>
  ready: Known<{ tasks: CapacityTaskRead[]; unread?: string }>
  /** Each listed task's template's steps, by name: `null` when the engine does not serve it now. */
  steps: ReadonlyMap<string, Known<CapacityStep[] | null>>
}

const known = <T>(value: T): Known<T> => ({ value })
const unknown = <T>(why: string): Known<T> => ({ unknown: clip(why) })
const clip = (text: string, max = 300): string => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text)
const isKnown = <T>(k: Known<T>): k is { value: T } => 'value' in k
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const TIERS: readonly RosterDescriptor['tier'][] = ['economy', 'standard', 'frontier']
const bounded = <T>(all: T[]): CapacityList<T> => ({ items: all.slice(0, CAPACITY_BOUNDS.list), more: Math.max(0, all.length - CAPACITY_BOUNDS.list) })

/** An account's name for people: a Worker's display name without its work (`Claude Code · science`). */
export const accountName = (name: string): string => { const i = name.lastIndexOf(' · '); return i > 0 ? name.slice(0, i) : name }

/**
 * Whether a Worker could take a step, as the start preview tells it (T124): its descriptor proves
 * every capability the step needs (an offer of no scope), at the step's tier or above, and it takes
 * the step's kind of work (ADR-0057: a Worker that lists no kinds takes any). Routing decides at the
 * start; this decides nothing.
 */
export function canTakeStep(d: { capabilities?: ReadonlyArray<{ capability: string; scope?: unknown }> | undefined; tier: RosterDescriptor['tier']; kinds?: string[] | undefined }, step: CapacityStep): boolean {
  const offers = d.capabilities ?? []
  return step.capabilities.every((c) => offers.some((o) => o.capability === c && o.scope === undefined))
    && TIERS.indexOf(d.tier) >= TIERS.indexOf(step.tier)
    && (d.kinds === undefined || (step.kind !== undefined && d.kinds.includes(step.kind)))
}

/** An account's pools, from the first of its Workers whose pools were read. */
function poolsOf(entries: RosterEntry[]): Known<RosterPoolView[]> {
  return entries.find((e) => isKnown(e.pools))?.pools ?? entries[0]!.pools
}

/** Whether an account is at a limit, and until when: its `limitUntil`, else its closed pools' latest `until` when each names one, else its limited windows' latest reset. */
function limitOf(entries: RosterEntry[], pools: Known<RosterPoolView[]>): { until: Known<string> } | undefined {
  const limitUntil = entries.map((e) => (isKnown(e.account) ? e.account.value.limitUntil : undefined)).find((u) => u !== undefined)
  const list = isKnown(pools) ? pools.value : []
  const closed = list.filter((p) => !p.available)
  const limited = list.flatMap((p) => p.windows.filter((w) => w.state === 'limited'))
  if (limitUntil === undefined && !closed.length && !limited.length) return undefined
  if (limitUntil !== undefined) return { until: known(limitUntil) }
  const latest = (times: string[]): string => times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
  if (closed.length && closed.every((p) => p.until)) return { until: known(latest(closed.map((p) => p.until!))) }
  const resets = limited.map((w) => w.resets)
  if (!closed.length && resets.every(isKnown)) return { until: known(latest(resets.map((r) => (r as { value: string }).value))) }
  return { until: unknown('no reset is known: neither its account nor every closed pool or limited window names one') }
}

/**
 * The quota an account has left now: the window with the least left among those with a current
 * reading, `null` when its account has no pool, or why it cannot be read. A window with no reading,
 * no used share, no reset, or a reset already past (the reading is older than the window) is never read as room.
 */
function quotaOf(pools: Known<RosterPoolView[]>, now: Date): Known<CapacityQuota | null> {
  if (!isKnown(pools)) return unknown(pools.unknown)
  if (!pools.value.length) return known(null)
  const current = pools.value.flatMap((p) => p.windows.flatMap((w): CapacityQuota[] => {
    if (!isKnown(w.used) || !isKnown(w.resets) || Date.parse(w.resets.value) <= now.getTime()) return []
    return [{ pool: p.pool, window: w.id, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}), used: w.used.value, left: Math.max(0, 100 - w.used.value), resetsAt: w.resets.value }]
  }))
  if (!current.length) return unknown('no window of its account has a current reading (none yet, or each one\'s reset has passed)')
  return known(current.sort((a, b) => a.left - b.left || cmp(a.resetsAt, b.resetsAt) || cmp(a.pool, b.pool) || cmp(a.window, b.window))[0]!)
}

/**
 * How much of a quota would be lost unused per minute if no work is given to it: what is left over
 * the minutes until it resets. The free Workers are listed by it, the highest first (use it or lose
 * it): of two accounts, one resetting in 40 min at 10 % used and one at 85 % resetting in 4 h, the
 * first comes first.
 */
export const urgency = (quota: CapacityQuota, now: Date): number => quota.left / Math.max(1, (Date.parse(quota.resetsAt) - now.getTime()) / 60_000)

/** Free Workers in the order a lead should give them work: the most urgent quota first, then the most left, the soonest reset, the id; those no quota applies to last, by id. */
function orderFree(free: CapacityFree[], now: Date): CapacityFree[] {
  return [...free].sort((a, b) => {
    if (a.quota && b.quota) return urgency(b.quota, now) - urgency(a.quota, now) || b.quota.left - a.quota.left || cmp(a.quota.resetsAt, b.quota.resetsAt) || cmp(a.worker, b.worker)
    if (a.quota || b.quota) return a.quota ? -1 : 1
    return cmp(a.worker, b.worker)
  })
}

/** Whether a Worker takes new work now: ready, or busy with a slot its source says is free. */
const takesWork = (e: RosterEntry): boolean => e.availability.state === 'ready' || (e.availability.state === 'busy' && e.availability.slots !== undefined && (e.availability.running ?? 0) < e.availability.slots)

/**
 * Capacity now, from the roster and the board: deterministic, so the same input and time give the
 * same record.
 */
export function projectCapacity(input: CapacityInput, now: Date): Capacity {
  const workers = input.roster.workers
  const asOf = input.roster.asOf
  if (!isKnown(workers)) {
    const why = `the Workers are unknown (${workers.unknown})`
    return { asOf, accounts: unknown(why), free: unknown(why), quotaUnknown: unknown(why), stalled: unknown(why), noQuota: unknown(why), cannotWork: unknown(why), ready: readyOf(input, [], [], why) }
  }
  const entries = workers.value
  // Each account once, in id order, with its Workers in roster order.
  const groups = new Map<string, RosterEntry[]>()
  for (const e of entries) if (isKnown(e.account)) groups.set(e.account.value.id, [...(groups.get(e.account.value.id) ?? []), e])
  const ids = [...groups.keys()].sort(cmp)
  const accounts: CapacityAccount[] = []
  const noQuota: CapacityNoQuota[] = []
  const quotas = new Map<string, Known<CapacityQuota | null>>()
  const limits = new Set<string>()
  for (const id of ids) {
    const mine = groups.get(id)!
    const name = accountName(mine[0]!.name)
    const pools = poolsOf(mine)
    const limit = limitOf(mine, pools)
    const quota = quotaOf(pools, now)
    quotas.set(id, quota)
    if (limit) {
      limits.add(id)
      noQuota.push({ account: id, name, until: limit.until })
    }
    const windows: Known<CapacityWindow[]> = !isKnown(pools) ? unknown(pools.unknown) : (() => {
      const all = pools.value.flatMap((p) => p.windows.map((w): CapacityWindow => ({ pool: p.pool, id: w.id, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}), state: w.state, used: w.used, resets: w.resets })))
      return all.length > CAPACITY_BOUNDS.windows ? unknown(`its account has ${all.length} windows, more than the ${CAPACITY_BOUNDS.windows} listed`) : known(all)
    })()
    const taking = mine.filter(takesWork).length
    const left = (q: CapacityQuota): string => `${q.left} % left of ${q.window} (used ${q.used} %), resets ${q.resetsAt}`
    const [canWork, summary]: [Known<boolean>, string] = limit
      ? [known(false), `at its limit until ${isKnown(limit.until) ? limit.until.value : 'an unknown time'}`]
      : !taking ? [known(false), `none of its ${mine.length} Worker(s) takes work now (${[...new Set(mine.map((e) => e.availability.state))].join(', ')})`]
        : !isKnown(quota) ? [unknown(quota.unknown), `its quota is unknown: ${quota.unknown}`]
          : [known(true), `${taking} of its Worker(s) take work now; ${quota.value ? left(quota.value) : 'no quota is tracked for it'}`]
    accounts.push({ account: id, name, windows, canWork, summary: clip(summary, 500) })
  }
  // The free Workers: ready, and not on an account at a limit; a Worker whose account's quota cannot be read is listed apart.
  const free: CapacityFree[] = []
  const unread: CapacityUnread[] = []
  for (const e of entries) {
    if (e.availability.state !== 'ready') continue
    const account = isKnown(e.account) ? e.account.value.id : undefined
    if (account !== undefined && limits.has(account)) continue
    const quota = account === undefined ? known<CapacityQuota | null>(null) : quotas.get(account)!
    if (!isKnown(quota)) {
      unread.push({ worker: e.worker, name: e.name, ...(account !== undefined ? { account } : {}), tier: e.tier, why: quota.unknown })
      continue
    }
    const d = input.descriptors.get(e.worker)
    free.push({
      worker: e.worker, name: e.name, ...(account !== undefined ? { account } : {}),
      ...(isKnown(e.role) && e.role.value ? { role: e.role.value } : {}), ...(d?.kinds?.length ? { kinds: [...d.kinds] } : {}),
      tier: e.tier, load: e.load, quota: quota.value,
    })
  }
  const ordered = orderFree(free, now)
  // The stalled runs, the longest stalled first; a Worker whose liveness could not be told is said, never read as none.
  const stalled = entries.flatMap((e) => (e.liveness && isKnown(e.liveness) ? e.liveness.value.filter((r) => r.state === 'stalled').map((r): CapacityStalled => ({ worker: e.worker, name: e.name, execution: r.execution, ...(r.runId ? { runId: r.runId } : {}), since: r.since })) : []))
    .sort((a, b) => cmp(a.since, b.since) || cmp(a.worker, b.worker) || cmp(a.execution, b.execution))
  const untold = entries.filter((e) => e.liveness && !isKnown(e.liveness))
  const cannotWork = entries.filter((e) => e.availability.state === 'unavailable' || e.availability.state === 'quarantined')
    .map((e): CapacityCannotWork => ({ worker: e.worker, name: e.name, state: e.availability.state as 'unavailable' | 'quarantined', reason: e.availability.summary }))
  const unreadOrdered = [...unread].sort((a, b) => cmp(a.worker, b.worker))
  return {
    asOf,
    accounts: known(bounded(accounts)),
    free: known(bounded(ordered)),
    quotaUnknown: known(bounded(unreadOrdered)),
    stalled: known({ ...bounded(stalled), ...(untold.length ? { unread: clip(`the liveness of ${untold.length} Worker(s) could not be told (${(untold[0]!.liveness as { unknown: string }).unknown})`, 500) } : {}) }),
    noQuota: known(bounded(noQuota)),
    cannotWork: known(bounded(cannotWork)),
    ready: readyOf(input, ordered, unreadOrdered),
  }
}

/** The ready tasks, each with the Worker a start would most likely go to: the first, in the free order, that could take its first step a Worker runs. */
function readyOf(input: CapacityInput, free: CapacityFree[], unread: CapacityUnread[], workersUnknown?: string): Capacity['ready'] {
  if (!isKnown(input.ready)) return unknown(input.ready.unknown)
  const list = bounded(input.ready.value.tasks)
  // In the order a start's routing would most likely take them: the free first, then those whose quota is unknown.
  const candidates = [...free.map((f) => ({ worker: f.worker, name: f.name })), ...unread.map((u) => ({ worker: u.worker, name: u.name }))]
  const items = list.items.map((t): CapacityReady => {
    const likely = ((): CapacityReady['likely'] => {
      if (!t.template) return unknown('it names no template: the lead starts it with one it chooses')
      const steps = input.steps.get(t.template) ?? unknown<CapacityStep[] | null>('its template\'s steps were not read')
      if (!isKnown(steps)) return unknown(steps.unknown)
      if (steps.value === null) return unknown(`its template ${t.template} is not served now`)
      const step = steps.value.find((s) => !s.source)
      if (!step) return known(null)
      if (workersUnknown !== undefined) return unknown(workersUnknown)
      const descriptors = candidates.map((c) => input.descriptors.get(c.worker))
      if (candidates.length && descriptors.every((d) => !d?.capabilities)) return unknown('the Workers that take work now do not say their capabilities')
      const found = candidates.find((_, i) => descriptors[i] !== undefined && canTakeStep(descriptors[i]!, step))
      return known(found ?? null)
    })()
    return { projectId: t.projectId, taskId: t.taskId, title: t.title, ...(t.template ? { template: t.template } : {}), likely }
  })
  return known({ items, more: list.more, ...(input.ready.value.unread ? { unread: input.ready.value.unread } : {}) })
}

const at = (k: Known<string>): string => (isKnown(k) ? k.value : `an unknown time (${k.unknown})`)
const few = (lines: string[], more: number): string => (lines.length ? `${lines.join('; ')}${more ? `; and ${more} more` : ''}` : 'none')
const listed = <T>(k: Known<CapacityList<T>>, line: (item: T) => string): string => (isKnown(k) ? few(k.value.items.map(line), k.value.more) : `unknown (${k.unknown})`)

/** Capacity now as the operator and the lead read it in a terminal: one line per list. */
export function formatCapacity(c: Capacity): string[] {
  const quota = (q: CapacityQuota | null): string => (q ? `${q.left} % left of ${q.window}, resets ${q.resetsAt}` : 'no quota tracked')
  return [
    `Right now (as of ${c.asOf}):`,
    `  free         ${listed(c.free, (f) => `${f.name} (${f.worker}; ${quota(f.quota)})`)}`,
    ...(isKnown(c.quotaUnknown) && c.quotaUnknown.value.items.length ? [`  quota unknown, not counted free: ${listed(c.quotaUnknown, (u) => `${u.name} (${u.worker}; ${u.why})`)}`] : []),
    `  stalled      ${listed(c.stalled, (s) => `${s.name}: agent run ${s.execution}${s.runId ? ` of run ${s.runId}` : ''} since ${s.since}`)}${isKnown(c.stalled) && c.stalled.value.unread ? `; ${c.stalled.value.unread}` : ''}`,
    `  no quota     ${listed(c.noQuota, (n) => `${n.name} until ${at(n.until)}`)}`,
    `  cannot work  ${listed(c.cannotWork, (w) => `${w.name} (${w.reason})`)}`,
    `  accounts     ${listed(c.accounts, (a) => `${a.name}: ${isKnown(a.canWork) ? (a.canWork.value ? 'takes work' : 'takes no work') : 'unknown'}, ${a.summary}`)}`,
    `  ready        ${listed(c.ready, (t) => `"${t.title}" (task ${t.taskId}, project ${t.projectId}${t.template ? `, ${t.template}` : ''}) → ${isKnown(t.likely) ? (t.likely.value ? t.likely.value.name : 'no Worker that takes work now can take it') : `unknown (${t.likely.unknown})`}`)}${isKnown(c.ready) && c.ready.value.unread ? `; ${c.ready.value.unread}` : ''}`,
  ]
}
