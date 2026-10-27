/**
 * The roster (docs/design/roster.md): every Worker in one read model, with its account, role,
 * tier, quota class, availability, the work it serves now, its load, and the windows of its
 * account's pools. A projection computed on read from the seams that already hold each fact, never
 * stored: the same reads give the same roster. Each field a source could not give is
 * `{ unknown: why }`, never a default (INV-2), and every read is bounded (INV-9, {@link ROSTER_BOUNDS}).
 * The surfaces (MCP `roster`, `system roster`, the `/ui` Workers tab) share it. It holds no secret
 * (INV-8): an account's id, state, and the operator's label only.
 * @module
 */
import { countedWhole, countUnknownUsage, MAX_UNKNOWN_ENTRIES, type QuotaSettings, SchemaRegistry, type UnknownUsageCount, USAGE_UNKNOWN_EVENT, type UsageUnknownKind } from '@tsuuanmi/system-libs'
import { type Capacity, CAPACITY_BOUNDS, type CapacityStep, type CapacityTaskRead, formatCapacity, projectCapacity } from './capacity.ts'

/** The schema of the roster (`mcp-roster@1.9`, `#/$defs/roster-output`). */
export const ROSTER_SCHEMA = 'mcp-roster@1.9'

/** The engine's event when a step's attempt starts (docs/design/workflow-engine.md), read for when a running step began. */
const NODE_STARTED = 'workflow.node.started'

/** What one roster reads at most (INV-9). */
export const ROSTER_BOUNDS = {
  /** Workers listed, in id order; the rest are counted as `unlisted`. */
  workers: 256,
  /** Workflow runs read, the newest first: the most the engine's usage view serves. */
  runs: 500,
  /** Steps listed as one Worker's current work; the rest are counted as `more`. */
  workPerWorker: 32,
  /** Other Workers of one account listed as its siblings; more makes them `unknown`. */
  siblings: 64,
  /** Pools of one account, and windows of one pool, a roster lists; more makes its pools `unknown`. */
  pools: 64,
  windows: 16,
  /** Worker sources whose last read is listed; more makes them `unknown`. */
  sources: 64,
  /** Board tasks read for the steps listed; a task past them is `unknown`. */
  tasks: 64,
  /** Steps listed whose start is read from the event log, by run and node id; a step past them has its `since` unknown. */
  starts: 64,
  /** `workflow.node.started` entries read for one step: its attempts' starts. */
  startsPerStep: 100,
  /** `usage.unknown` entries read for the pools' unknown usage. */
  unknownEntries: MAX_UNKNOWN_ENTRIES,
  /** Runs whose liveness needs a look listed for one Worker (of the latest the router tells). */
  livenessPerWorker: 64,
} as const

/** A fact a source gave, or why it is not known. */
export type Known<T> = { value: T } | { unknown: string }

const known = <T>(value: T): Known<T> => ({ value })
const unknown = <T>(why: string): Known<T> => ({ unknown: clip(why) })
const clip = (text: string, max = 300): string => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text)
const isKnown = <T>(k: Known<T>): k is { value: T } => 'value' in k

// What the roster reads, by shape only: each surface passes the services it has mounted.

/** A Worker as its source describes it now (`capability-descriptor@1.x`). */
export interface RosterDescriptor {
  worker: string
  provider: string
  family?: string | undefined
  /** `@1.7`: what it is for, in the operator's words. */
  description?: string | undefined
  /** `@1.8`: its name for people, as its source gives it (a website provider's own, a model's from the operator's catalog). */
  title?: string | undefined
  /** `@1.9`: why an unavailable Worker takes no work, as its source knows it (a failed probe, a workspace problem, a gate). */
  unavailableReason?: string | undefined
  /** `@1.6`: the kinds of work the operator gives it. */
  kinds?: string[] | undefined
  account?: { id: string; group: string; mode: 'assigned' | 'pooled'; limitUntil?: string | undefined } | undefined
  load?: { running: number; queued: number; pending: number; slots: number } | undefined
  cooldowns?: Array<{ capability: string; until: string }> | undefined
  tier: 'economy' | 'standard' | 'frontier'
  /** `@1.10`: every tier it offers (ADR-0073), each closed while its model is at its limit. */
  tiers?: ReadonlyArray<RosterTier> | undefined
  quotaClass: 'subscription-chat' | 'agent-plan' | 'metered' | 'local'
  locality: 'local' | 'remote'
  state: 'ready' | 'busy' | 'quota-exhausted' | 'reauth-required' | 'unavailable'
  observedAt: string
  /** What it offers, read only to tell which Worker a ready task's start would most likely go to (capacity now). */
  capabilities?: ReadonlyArray<{ capability: string; scope?: unknown }> | undefined
}
/**
 * How a Worker source answered the router's last read (`ctx.workers.sources()`); `describing`
 * (`@1.4`) on a silent read whose source has not yet described its Workers once since it registered.
 */
export interface RosterSourceRead { source: string; state: 'described' | 'silent' | 'failed'; at: string; workers: number; detail?: string | undefined; describing?: true | undefined }
/** One enrollment slot of an agent runtime (`agent-account@1.0`), without its home or identity. */
export interface RosterAgentAccount {
  accountId?: string | undefined
  provider: string
  slot: number
  status: 'enrolled' | 'ready' | 'signed-out' | 'quarantined'
  /** `detail` (`agent-account@1.1`): what the reading that quarantined it found. */
  quarantine?: { reason: 'changed' | 'ambiguous' | 'duplicate' | 'unverified'; since: string; decision: string; detail?: string | undefined } | undefined
  hint?: string | undefined
}
/** A website account's secret-free view (`ctx.accounts`). */
export interface RosterWebsiteAccount { id: string; label?: string | undefined; status: string }
/** A pool of the resource ledger now (`ctx.resources.pools()`). */
export interface RosterPool {
  pool: string
  account: string
  kind: string
  windows: Array<{ id: string; kind: string; seconds?: number | undefined }>
  readings: Array<{ window: { id: string }; state: 'ok' | 'limited' | 'unknown'; usedPercentage?: number | undefined; resetsAt?: string | undefined; cooldownUntil?: string | undefined; source: string; observedAt: string }>
  available: boolean
  until?: string | undefined
  /** How the pool is configured when a window has no reading (`unknown: available` makes it available; T294). */
  unknown?: 'available' | 'unavailable' | undefined
}
/** A workflow run as the engine's usage view gives it. */
export interface RosterRun {
  runId: string
  template: string
  status: string
  nodes: Array<{ nodeId: string; state: string; attempt: number; worker?: string | undefined }>
  /** `startedBy` (workflow contract 1.10): who started the task's run. */
  task?: { taskId: string; startedBy?: RosterStartedBy | undefined } | undefined
}
/** Who started a board task's run: dispatch by itself, the lead, or the operator (PROP-0014 D2). */
export type RosterStartedBy = 'dispatch' | 'lead' | 'operator'
/** A board task, as much of it as the roster shows. */
export interface RosterTask { taskId: string; projectId: string; title: string; state: string }

/**
 * The services a roster reads, each absent when it is not mounted. A surface passes what it has
 * (`ctx.get(...)` of each), so its manifest names what it consumes.
 */
/** A run whose liveness needs a look, as `ctx.workers.liveness()` tells it (PROP-0013). */
export interface RosterLivenessRun {
  execution: string
  worker: string
  state: 'stalled' | 'looking' | 'unknown'
  since: string
  looks?: { taken: number; max: number } | undefined
  holds: string[]
  runId?: string | undefined
}
/** What `ctx.workers.liveness()` tells: the runs, the latest first, and each source that could not tell. */
export interface RosterLivenessRead { runs: RosterLivenessRun[]; counts: Record<RosterLivenessRun['state'], number>; unread: Array<{ source: string; detail: string }> }

/** What the engine's `teamExclusion()` tells: the operator's `teams.excludeWorkers` entries, and every Worker they leave out of teams now. */
export interface RosterTeamExclusion { entries: string[]; workers: string[] }

export interface RosterServices {
  workers?: { list(): Promise<RosterDescriptor[]>; sources?(): RosterSourceRead[]; siblings(worker: string): string[]; liveness?(): Promise<RosterLivenessRead> } | undefined
  accounts?: { list(): Promise<RosterWebsiteAccount[]>; duplicateIdentities(): Promise<string[][]> } | undefined
  agentWorkers?: {
    agentAccounts?: {
      list(): RosterAgentAccount[]
      workersIn(account: never): string[]
      /** The operator's display label of a slot's account, when one is configured. */
      labelOf?(account: never): string | undefined
      /** Why a slot's account's last usage report could not be read, and when, while no later one was read. */
      unreadReport?(account: never): { why: string; at: string } | undefined
      /** Each agent runtime, with its title for people when its provider gives one. */
      providers?(): Array<{ provider: string; title?: string | undefined }>
    }
  } | undefined
  resources?: {
    pools(): Promise<RosterPool[]>
    usage(filter: { runId: string; pool: string }): Promise<{ records: Array<{ partial?: unknown }> }>
    /** The operator's quota settings (the reserve), which capacity now's headroom reads; the defaults when absent. */
    quota?(): QuotaSettings
  } | undefined
  eventLog?: { query(filter: { type: string; since?: string; afterSeq: number; limit: number; runId?: string; nodeId?: string }): Array<{ seq: number; at: string; data?: unknown }> } | undefined
  workflow?: {
    usage(limit: number): RosterRun[]
    /** The Workers the operator keeps out of teams (`teams.excludeWorkers`, D58): the entries configured, and the Workers listed now that they leave out. */
    teamExclusion?(): Promise<RosterTeamExclusion>
    /** A template's steps as a start's preview reads them (capacity now: the Worker a ready task's start would most likely go to); undefined when it is not served. */
    templateSteps?(template: string): CapacityStep[] | undefined
  } | undefined
  board?: {
    task(taskId: string): Promise<RosterTask | undefined>
    /** The projects, for capacity now's ready tasks (of the active ones). */
    projects?(filter?: { state?: 'proposed' | 'active' | 'paused' | 'closed' }): Promise<Array<{ projectId: string }>>
    /** A project's tasks in some states, for capacity now's ready tasks. */
    tasks?(filter: { projectId: string; states?: Array<'ready'> }): Promise<Array<{ taskId: string; projectId: string; title: string; state: string; template?: string | undefined; createdAt?: string | undefined }>>
  } | undefined
}

/** Everything the projection takes, each source already read or known to be unreadable. */
export interface RosterInput {
  workers: Known<RosterDescriptor[]>
  sources: Known<RosterSourceRead[]>
  /** Each listed Worker's siblings (the Workers of its account, itself included). */
  siblings: ReadonlyMap<string, Known<string[]>>
  websiteAccounts: Known<RosterWebsiteAccount[]>
  /** Groups of website accounts signed in as one person. */
  duplicates: Known<string[][]>
  /**
   * Each enrolled agent account with the Workers that run on it, the operator's label when
   * configured, and why its last usage report could not be read, while no later one was.
   */
  agentAccounts: Known<Array<AgentEntry>>
  /** Each agent runtime's title for people, by its kind, as its provider gives it; a Worker of a runtime not in it is named by its provider. */
  titles?: ReadonlyMap<string, string>
  pools: Known<RosterPool[]>
  unknownUsage: Known<UnknownUsageCount>
  /** The newest runs, and whether the bound cut the read. */
  runs: Known<{ runs: RosterRun[]; full: boolean }>
  /** Each board task a listed step serves, by id. */
  tasks: ReadonlyMap<string, Known<RosterTask>>
  /** When each listed step's current attempt started, by {@link stepKey}; a step not in it has its start unknown (not read). */
  starts?: ReadonlyMap<string, Known<string>>
  /** The runs whose liveness needs a look; absent when the router tells none (no `liveness`). */
  liveness?: Known<RosterLivenessRead>
  /** The Workers the operator keeps out of teams; absent when the engine tells none (no `teamExclusion`). */
  teams?: Known<RosterTeamExclusion>
}

/** The key of one step's start in {@link RosterInput}.starts. */
const stepKey = (runId: string, nodeId: string): string => `${runId}\u0000${nodeId}`

// The record.

export type AvailabilityState = 'ready' | 'busy' | 'resting' | 'unavailable' | 'quarantined'
export type Availability =
  | { state: 'ready'; summary: string }
  | { state: 'busy'; summary: string; running?: number; slots?: number }
  | { state: 'resting'; summary: string; until: Known<string> }
  | { state: 'unavailable'; summary: string; reason: Known<string> }
  | { state: 'quarantined'; summary: string; reason: 'changed' | 'ambiguous' | 'duplicate' | 'unverified'; since: string; decision: string; detail?: string }

export interface RosterAccountRecord {
  kind: 'agent' | 'website'
  /** The operator's label (a website account's catalog label, an agent account's masked hint); the operator's only. */
  label?: Known<string>
  status: string
  slot?: number
  quarantine?: { reason: string; since: string; decision: string; detail?: string }
  /** The other website accounts signed in as the same person (none of them takes work). */
  sameAs?: string[]
}
export interface RosterAccount { id: string; group: string; mode: 'assigned' | 'pooled'; limitUntil?: string; record: Known<RosterAccountRecord> }
export interface RosterWork {
  runId: string
  template: string
  nodeId: string
  attempt: number
  task?: { taskId: string; board: Known<{ projectId: string; title: string; state: string }> }
  /** `@1.8`: who started the task's run (`dispatch`: System by itself); absent when the engine does not tell. */
  startedBy?: RosterStartedBy
  /** When its current attempt started. */
  since: Known<string>
  /** The step in one sentence: its task, the run, the step, and for how long. */
  summary: string
}
export interface RosterWindow { id: string; kind: string; seconds?: number; state: 'ok' | 'limited' | 'unknown'; used: Known<number>; resets: Known<string>; observedAt?: string; source?: string }
export interface RosterPoolView { pool: string; kind: string; available: boolean; until?: string; windows: RosterWindow[]; unknownUsage: Known<{ runs: number; kinds: Partial<Record<UsageUnknownKind, number>> }> }
/** One tier a Worker offers (`mcp-roster@1.10`): its model's display label from the live profile, its turn limit, and whether its model's limit closes it now. */
export interface RosterTier { tier: 'economy' | 'standard' | 'frontier'; label?: string | undefined; maxTurns?: number | undefined; closed?: true | undefined; until?: string | undefined }
export interface RosterEntry {
  worker: string
  /**
   * Its display name, `<runtime> · <account> · <role or tier> [<kinds>]`, for example
   * `Claude Code · science · develop [code]`: the runtime's title (else its provider's word), the
   * account's label for the operator (else its masked hint and slot, or its id), never a routing
   * input; the id stays the key.
   */
  name: string
  provider: string
  /** What it is for, in the operator's words; unknown when none is configured. */
  description: Known<string>
  /** A line made from its provider, role, and tier, which a reader shows, marked as derived, when there is no description. */
  derived: string
  family: Known<string>
  account: Known<RosterAccount>
  /** The role the Worker serves on its account, `null` for a Worker that is no role's (a website account's tier, a model, a hand-named agent Worker). */
  role: Known<string | null>
  tier: RosterDescriptor['tier']
  /** `@1.10`: every tier it offers, lowest first, each with its model's display label and turn limit; only a Worker that offers tiers (ADR-0073) has it. */
  tiers?: RosterTier[]
  quotaClass: RosterDescriptor['quotaClass']
  locality: RosterDescriptor['locality']
  /** The state its source describes; `availability` is what the roster makes of it with the account. */
  state: RosterDescriptor['state']
  observedAt: string
  availability: Availability
  load: Known<{ running: number; queued: number; pending: number; slots: number }>
  /** Capabilities held off by a usage limit until a time (the rest of the Worker takes work). */
  limits: Array<{ capability: string; until: string }>
  /** The other Workers of its account. */
  siblings: Known<string[]>
  work: Known<{ items: RosterWork[]; more: number; unread?: string }>
  /** Its runs whose liveness needs a look, each in one sentence; only when it has any, or they could not be told. */
  liveness?: Known<RosterLiveness[]>
  /**
   * `@1.6`: that the operator keeps it out of teams (`teams.excludeWorkers`, D58), in one sentence;
   * only when the engine tells it and leaves this Worker out, or could not tell.
   */
  teams?: Known<{ excluded: true; summary: string }>
  pools: Known<RosterPoolView[]>
}
/** A run of a Worker whose liveness needs a look, as the roster shows it (PROP-0013). */
export interface RosterLiveness { execution: string; state: RosterLivenessRun['state']; since: string; runId?: string; summary: string }
export interface Roster {
  asOf: string
  workers: Known<RosterEntry[]>
  /** Workers past {@link ROSTER_BOUNDS}.workers, not listed. */
  unlisted: number
  counts: Record<AvailabilityState, number>
  /** How each Worker source answered its last read: a silent or failed one's Workers are not listed. */
  sources: Known<RosterSourceRead[]>
  /** `usage.unknown` entries no pool counts: not valid records, or naming a pool the ledger does not configure. */
  unknownUsage: Known<{ unreadable: number; unconfigured: Array<{ pool: string; runs: number }> }>
  /** `@1.7`: capacity now ({@link readCapacity}, ./capacity.ts): who takes work, whose quota would be lost first, and the ready tasks; absent from a bare projection. */
  now?: Capacity
}

/** Who reads the roster: an operator sees account labels, a client (the lead) does not. */
export type RosterScope = 'operator' | 'client'

const STATES: readonly AvailabilityState[] = ['ready', 'busy', 'resting', 'unavailable', 'quarantined']
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const later = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : Date.parse(b) > Date.parse(a) ? b : a)
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** An enrolled agent account as the roster read it: the slot's record, its Workers, the operator's label when configured, and its last unread usage report. */
type AgentEntry = { account: RosterAgentAccount; workers: string[]; label?: string | undefined; unreadReport?: { why: string; at: string } | undefined }

/** The account record a Worker runs on: the enrolled agent account of its id (or that lists it), else the website account of its id. */
function recordOf(input: RosterInput, d: RosterDescriptor, scope: RosterScope): { record: Known<RosterAccountRecord>; agent?: AgentEntry; site?: RosterWebsiteAccount } {
  const id = d.account!.id
  const agents = input.agentAccounts
  const agent = isKnown(agents) ? agents.value.find((a) => a.account.accountId === id) ?? agents.value.find((a) => a.workers.includes(d.worker)) : undefined
  if (agent) {
    const a = agent.account
    const label = a.hint ? known(a.hint) : unknown<string>('its runtime shows no hint for this account')
    return {
      agent,
      record: known({
        kind: 'agent', ...(scope === 'operator' ? { label } : {}), status: a.status, slot: a.slot,
        ...(a.quarantine ? { quarantine: { reason: a.quarantine.reason, since: a.quarantine.since, decision: a.quarantine.decision, ...(a.quarantine.detail ? { detail: clip(a.quarantine.detail) } : {}) } } : {}),
      }),
    }
  }
  const sites = input.websiteAccounts
  const site = isKnown(sites) ? sites.value.find((a) => a.id === id) : undefined
  if (site) {
    const label = site.label ? known(site.label) : unknown<string>('the account catalog gives it no label')
    const sameAs = isKnown(input.duplicates) ? (input.duplicates.value.find((group) => group.includes(id)) ?? []).filter((other) => other !== id).sort(cmp) : undefined
    return { site, record: known({ kind: 'website', ...(scope === 'operator' ? { label } : {}), status: site.status, ...(sameAs?.length ? { sameAs } : {}) }) }
  }
  const unread = [...(isKnown(agents) ? [] : [`the agent accounts (${agents.unknown})`]), ...(isKnown(sites) ? [] : [`the website accounts (${sites.unknown})`])]
  return { record: unknown(unread.length ? `no account record read names ${id}, and ${unread.join(' and ')} could not be read` : `no enrolled agent account and no website account has the id ${id}`) }
}

/** What the roster makes of a Worker's state, its account, and its pools. */
function availabilityOf(d: RosterDescriptor, record: Known<RosterAccountRecord>, pools: Known<RosterPoolView[]>): Availability {
  const rec = isKnown(record) ? record.value : undefined
  // A quarantined account's Workers take no work; a hand-named Worker that still does (its runtime
  // has no verified reader, `unverified`) reads as its source describes it, the account record saying why.
  if (rec?.status === 'quarantined' && rec.quarantine && d.state !== 'ready' && d.state !== 'busy') {
    const q = rec.quarantine as { reason: 'changed' | 'ambiguous' | 'duplicate' | 'unverified'; since: string; decision: string; detail?: string }
    return {
      state: 'quarantined', summary: `quarantined: ${q.reason}${q.detail ? ` (${q.detail})` : ''}, since ${q.since}`, reason: q.reason, since: q.since, decision: q.decision,
      ...(q.detail ? { detail: q.detail } : {}),
    }
  }
  if (d.state === 'quota-exhausted') {
    // Back only once every closed pool is: the latest of their resets, none when one names none.
    const shut = isKnown(pools) ? pools.value.filter((p) => !p.available) : []
    const closed = shut.length && shut.every((p) => p.until) ? shut.reduce<string | undefined>((at, p) => later(at, p.until), undefined) : undefined
    const until = d.account?.limitUntil ?? closed
    return until
      ? { state: 'resting', summary: `resting at a limit until ${until}`, until: known(until) }
      : { state: 'resting', summary: 'resting at a limit until unknown (no reset is known)', until: unknown('no reset is known: its source names none, and not every closed pool of its account names one') }
  }
  if (d.state === 'unavailable' || d.state === 'reauth-required') {
    const reason = reasonOf(d, rec, record)
    return { state: 'unavailable', summary: `unavailable: ${isKnown(reason) ? reason.value : `unknown (${reason.unknown})`}`, reason }
  }
  const load = d.load
  if (d.state === 'busy' || (load && load.running > 0)) {
    return load
      ? { state: 'busy', summary: `busy ${load.running} of ${load.slots}`, running: load.running, slots: load.slots }
      : { state: 'busy', summary: 'busy (how many of how many is unknown: its source reports no load)' }
  }
  return { state: 'ready', summary: 'ready' }
}

/** Why an unavailable Worker takes no work, from what its account says, else its source; unknown when nothing does. */
function reasonOf(d: RosterDescriptor, rec: RosterAccountRecord | undefined, record: Known<RosterAccountRecord>): Known<string> {
  if (rec?.sameAs?.length) return known(`its account is signed in as the same person as ${rec.sameAs.join(', ')}, so none of them takes work`)
  if (rec && rec.status !== 'ready') {
    const what: Record<string, string> = {
      enrolled: 'its account is enrolled and not verified yet (system account verify)',
      'signed-out': 'its account is signed out (system account login)',
      'reauth-required': 'its account must sign in again (system account login)',
      challenge: 'its account waits on a site challenge (system account login)',
      disabled: 'its account is disabled',
      new: 'its account has never signed in (system account login)',
    }
    return known(what[rec.status] ?? `its account is ${rec.status}`)
  }
  if (d.state === 'reauth-required') return known('its account must sign in again (system account login)')
  // Its source's own reason (`capability-descriptor@1.9`): a failed probe, a workspace problem, a gate.
  if (d.unavailableReason) return known(d.unavailableReason)
  return unknown(`its Worker source gives no reason${isKnown(record) ? '' : `, and its account could not be read (${record.unknown})`}; system explain on a run it was refused for shows the route's reasons`)
}

/** What the roster's `used` says of a window of an unread pool (T294); capacity reads the pool as unread from it. */
export const UNREAD_MARK = 'unread, admitted at the unread bound'

/**
 * A pool's windows as the roster shows them. A window with no reading yet says, for the operator, why
 * its account's last usage report could not be read (`unread`), when that is the latest read of it.
 */
function windowsOf(p: RosterPool, unread: { why: string; at: string } | undefined): RosterWindow[] {
  const none = unread ? `no reading yet: its account's usage report could not be read at ${unread.at}: ${unread.why}` : 'no reading yet'
  // A pool configured `unknown: available` with no reading of any window is unread: dispatch admits it at the unread bound (T294).
  // One read window makes it judged by its readings, so no window of it is marked then.
  const bound = p.unknown === 'available' && p.readings.length === 0 ?` (${UNREAD_MARK}: dispatch admits it one run at a time, after every account with headroom)` : ''
  return p.windows.map((w) => {
    const r = p.readings.find((reading) => reading.window.id === w.id)
    const base = { id: w.id, kind: w.kind, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}) }
    if (!r) return { ...base, state: 'unknown' as const, used: unknown<number>(none + bound), resets: unknown<string>('no reading yet') }
    const reset = later(r.resetsAt, r.cooldownUntil)
    return {
      ...base, state: r.state, observedAt: r.observedAt, source: r.source,
      used: r.usedPercentage !== undefined ? known(r.usedPercentage) : unknown<number>('its latest reading gives no used share'),
      resets: reset !== undefined ? known(reset) : unknown<string>('its latest reading names no reset'),
    }
  })
}

function poolsOf(input: RosterInput, d: RosterDescriptor, unread: { why: string; at: string } | undefined): Known<RosterPoolView[]> {
  if (!d.account) return unknown('its Worker source names no account, so no pool can be told to be its')
  if (!isKnown(input.pools)) return unknown(input.pools.unknown)
  const usage = input.unknownUsage
  const mine = input.pools.value.filter((p) => p.account === d.account!.id).sort((a, b) => cmp(a.pool, b.pool))
  if (mine.length > ROSTER_BOUNDS.pools) return unknown(`its account has ${mine.length} pools, more than the ${ROSTER_BOUNDS.pools} a roster lists`)
  const wide = mine.find((p) => p.windows.length > ROSTER_BOUNDS.windows)
  if (wide) return unknown(`the pool ${wide.pool} has ${wide.windows.length} windows, more than the ${ROSTER_BOUNDS.windows} a roster lists`)
  return known(mine.map((p): RosterPoolView => {
    const counted = isKnown(usage) ? usage.value.pools.find((c) => c.pool === p.pool) : undefined
    const unknownUsage: RosterPoolView['unknownUsage'] = !isKnown(usage) ? unknown(usage.unknown)
      : usage.value.unread ? unknown(`more than ${ROSTER_BOUNDS.unknownEntries} usage.unknown entries are in the pools' windows; only the first were read`)
        : known({ runs: counted?.runs ?? 0, kinds: counted?.kinds ?? {} })
    return { pool: p.pool, kind: p.kind, available: p.available, ...(p.until ? { until: p.until } : {}), windows: windowsOf(p, unread), unknownUsage }
  }))
}

/** How long from `since` to `now`, in words: "less than a minute", "4 min", "2 h 5 min", "3 days". */
function spanText(since: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 60_000))
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return `${Math.floor(minutes / 1440)} days`
}

/** A step in one sentence, as every surface shows it: the task it serves, the run, the step, and for how long. */
function summaryOf(work: Omit<RosterWork, 'summary'>, now: Date): string {
  const step = `${work.template} run ${work.runId}, step ${work.nodeId}${work.attempt > 1 ? ` (attempt ${work.attempt})` : ''}`
  const how = isKnown(work.since) ? `for ${spanText(work.since.value, now)}` : 'since an unknown time'
  if (!work.task) return clip(`Running ${step}, ${how}`)
  const board = work.task.board
  const task = isKnown(board) ? `"${board.value.title}" (task ${work.task.taskId}, project ${board.value.projectId})` : `task ${work.task.taskId}`
  return clip(`Working on ${task}: ${step}, ${how}${work.startedBy === 'dispatch' ? ', started by itself' : ''}`, 800)
}

function workOf(input: RosterInput, worker: string, now: Date): Known<{ items: RosterWork[]; more: number; unread?: string }> {
  if (!isKnown(input.runs)) return unknown(input.runs.unknown)
  const items: RosterWork[] = []
  for (const run of input.runs.value.runs) {
    if (run.status !== 'running') continue
    for (const node of run.nodes) {
      if (node.state !== 'RUNNING' || node.worker !== worker) continue
      const task = run.task ? input.tasks.get(run.task.taskId) ?? unknown<RosterTask>('the board task was not read') : undefined
      const board = task && (isKnown(task) ? known({ projectId: task.value.projectId, title: task.value.title, state: task.value.state }) : unknown<{ projectId: string; title: string; state: string }>(task.unknown))
      const since = input.starts?.get(stepKey(run.runId, node.nodeId)) ?? unknown<string>('its start was not read')
      const startedBy = run.task?.startedBy
      const work = {
        runId: run.runId, template: run.template, nodeId: node.nodeId, attempt: node.attempt, ...(run.task && board ? { task: { taskId: run.task.taskId, board } } : {}),
        ...(startedBy === 'dispatch' || startedBy === 'lead' || startedBy === 'operator' ? { startedBy } : {}), since,
      }
      items.push({ ...work, summary: summaryOf(work, now) })
    }
  }
  items.sort((a, b) => cmp(a.runId, b.runId) || cmp(a.nodeId, b.nodeId))
  const listed = items.slice(0, ROSTER_BOUNDS.workPerWorker)
  return known({
    items: listed, more: items.length - listed.length,
    ...(input.runs.value.full ? { unread: `only the newest ${ROSTER_BOUNDS.runs} runs were read: an older run still running is not shown` } : {}),
  })
}

/** A run whose liveness needs a look, in one sentence, as every surface shows it beside what its Worker does now. */
function livenessSummary(run: RosterLivenessRun, now: Date): string {
  const of = run.runId ? ` of run ${run.runId}` : ''
  if (run.state === 'stalled') return clip(`Stalled: agent run ${run.execution}${of} has shown no activity for ${spanText(run.since, now)} or more; nothing is sent to it, and its own deadline ends it`, 800)
  if (run.state === 'looking') return clip(`Not known to be gone: agent run ${run.execution}${of} lost its holder ${spanText(run.since, now)} ago and is looked at again${run.looks ? ` (${run.looks.taken} of ${run.looks.max} verdicts)` : ''}`, 800)
  return clip(`Held for ${spanText(run.since, now)}: agent run ${run.execution}${of} ended without being known to be gone${run.holds.length ? `, holding ${run.holds.join(' and ')}` : ''}; free it once its agent is gone (system free ${run.execution} --agent-gone)`, 800)
}

/** A Worker's runs whose liveness needs a look, as its entry gives them: absent when it has none and they could be told. */
function livenessFor(input: RosterInput, worker: string, now: Date): Pick<RosterEntry, 'liveness'> {
  const told = input.liveness
  if (!told) return {}
  if (!isKnown(told)) return { liveness: unknown(told.unknown) }
  const runs = told.value.runs.filter((r) => r.worker === worker).slice(0, ROSTER_BOUNDS.livenessPerWorker)
  if (runs.length) return { liveness: known(runs.map((r) => ({ execution: r.execution, state: r.state, since: r.since, ...(r.runId ? { runId: r.runId } : {}), summary: livenessSummary(r, now) }))) }
  // A source that could not tell is never read as having none of its Workers' runs (INV-2).
  const unread = told.value.unread
  return unread.length ? { liveness: unknown(`${unread.map((u) => `source ${u.source} could not tell (${u.detail})`).join('; ')}`) } : {}
}

/**
 * Whether the operator keeps a Worker out of teams, as its entry gives it: absent when the engine
 * tells none or does not leave it out; unknown on every Worker when the engine could not tell (INV-2).
 */
function teamsFor(input: RosterInput, d: RosterDescriptor): Pick<RosterEntry, 'teams'> {
  const told = input.teams
  if (!told) return {}
  if (!isKnown(told)) return { teams: unknown(told.unknown) }
  if (!told.value.workers.includes(d.worker)) return {}
  const named = told.value.entries.includes(d.worker) ? 'it is named' : d.account && told.value.entries.includes(d.account.id) ? 'its account is named' : 'another Worker of its account is named'
  return { teams: known({ excluded: true, summary: clip(`Kept out of teams by the operator: ${named} in teams.excludeWorkers, so it is never a team member; it takes every other step`) }) }
}

/** A Worker's siblings without itself, in id order, at most {@link ROSTER_BOUNDS}.siblings. */
function siblingsOf(siblings: Known<string[]>, worker: string): Known<string[]> {
  if (!isKnown(siblings)) return siblings
  const others = siblings.value.filter((w) => w !== worker).sort(cmp)
  return others.length > ROSTER_BOUNDS.siblings ? unknown(`its account has ${others.length} other Workers, more than the ${ROSTER_BOUNDS.siblings} a roster lists`) : known(others)
}

/**
 * The roster of what was read: deterministic, so the same input and time give the same record.
 * Workers in id order, at most {@link ROSTER_BOUNDS}.workers.
 */
export function projectRoster(input: RosterInput, options: { scope: RosterScope; now: Date }): Roster {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<AvailabilityState, number>
  let unlisted = 0
  let workers: Known<RosterEntry[]>
  if (!isKnown(input.workers)) workers = unknown(input.workers.unknown)
  else {
    const all = [...input.workers.value].sort((a, b) => cmp(a.worker, b.worker))
    const listed = all.slice(0, ROSTER_BOUNDS.workers)
    unlisted = all.length - listed.length
    workers = known(listed.map((d): RosterEntry => {
      const { record, agent, site } = d.account ? recordOf(input, d, options.scope) : { record: unknown<RosterAccountRecord>('its Worker source names no account') }
      const account: Known<RosterAccount> = d.account
        ? known({ id: d.account.id, group: d.account.group, mode: d.account.mode, ...(d.account.limitUntil ? { limitUntil: d.account.limitUntil } : {}), record })
        : unknown('its Worker source names no account (a descriptor below capability-descriptor@1.5, or a Worker of none)')
      // Why its account's usage report could not be read is the operator's (it may name the account's home).
      const pools = poolsOf(input, d, options.scope === 'operator' && agent?.account.accountId === d.account?.id ? agent?.unreadReport : undefined)
      const work = workOf(input, d.worker, options.now)
      // A Worker the engine sees running a step is busy, whatever load its source reports (none, or none running).
      const running = isKnown(work) ? work.value.items.length : 0
      const described = availabilityOf(d, record, pools)
      const availability: Availability = described.state === 'ready' && running
        ? { state: 'busy', summary: `busy: it runs ${running} step(s) now (its source reports ${d.load ? `${d.load.running} running` : 'no load'})` }
        : described
      counts[availability.state] += 1
      const siblings = input.siblings.get(d.worker) ?? unknown<string[]>('its siblings were not read')
      const role = roleOf(input, d, record, agent)
      return {
        worker: d.worker, name: nameOf(input, d, role, options.scope, agent, site), provider: d.provider,
        description: d.description !== undefined ? known(d.description) : unknown('no description is configured for it'),
        derived: derivedOf(d, role),
        family: d.family !== undefined ? known(d.family) : unknown('its Worker source declares no provider family'),
        account, role, tier: d.tier, ...(d.tiers?.length ? { tiers: tiersOf(d.tiers) } : {}), quotaClass: d.quotaClass, locality: d.locality, state: d.state, observedAt: d.observedAt,
        availability,
        load: d.load ? known({ running: d.load.running, queued: d.load.queued, pending: d.load.pending, slots: d.load.slots }) : unknown('its Worker source reports no load'),
        limits: [...(d.cooldowns ?? [])].map((c) => ({ capability: c.capability, until: c.until })).sort((a, b) => cmp(a.capability, b.capability)),
        siblings: siblingsOf(siblings, d.worker),
        work,
        ...livenessFor(input, d.worker, options.now),
        ...teamsFor(input, d),
        pools,
      }
    }))
  }
  const usage = input.unknownUsage
  return {
    asOf: options.now.toISOString(), workers, unlisted, counts,
    sources: isKnown(input.sources) && input.sources.value.length > ROSTER_BOUNDS.sources ? unknown(`${input.sources.value.length} Worker sources, more than the ${ROSTER_BOUNDS.sources} a roster lists`)
      : isKnown(input.sources) ? known([...input.sources.value].sort((a, b) => cmp(a.source, b.source)).map((s) => ({
        source: s.source, state: s.state, at: s.at, workers: s.workers, ...(s.detail ? { detail: clip(s.detail) } : {}), ...(s.state === 'silent' && s.describing ? { describing: true as const } : {}),
      }))) : input.sources,
    unknownUsage: isKnown(usage) ? known({ unreadable: usage.value.unreadable, unconfigured: usage.value.unconfigured }) : unknown(usage.unknown),
  }
}

const TIER_ORDER = ['economy', 'standard', 'frontier']

/** The tiers a Worker offers as the roster lists them: lowest first, each with what a reader needs and nothing a router reads. */
function tiersOf(offers: ReadonlyArray<RosterTier>): RosterTier[] {
  return [...offers].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)).map((t) => ({
    tier: t.tier,
    ...(t.label !== undefined && /^[^\p{Cc}]{1,256}$/u.test(t.label) ? { label: t.label } : {}),
    ...(t.maxTurns !== undefined ? { maxTurns: t.maxTurns } : {}),
    ...(t.closed ? { closed: true as const } : {}),
    ...(t.until ? { until: t.until } : {}),
  }))
}

/** One offered tier in a line: `economy (model label, 12 turns, closed until …)`. */
const tierText = (t: RosterTier): string => {
  const parts = [...(t.label ? [t.label] : []), ...(t.maxTurns !== undefined ? [`max ${t.maxTurns} turns`] : []), ...(t.closed ? [`at its model's limit${t.until ? ` until ${t.until}` : ''}`] : [])]
  return parts.length ? `${t.tier} (${parts.join(', ')})` : t.tier
}

/** A Worker's line made from what its source says: provider, role, tier, quota class, and locality (shown, marked as derived, when it has no description). */
function derivedOf(d: RosterDescriptor, role: Known<string | null>): string {
  // A Worker that offers several tiers (ADR-0073) names them, and each its model's limit closes now.
  const tiers = d.tiers && d.tiers.length > 1
    ? `${d.tiers.map((t) => `${t.tier}${t.closed ? ` (at its model's limit${t.until ? ` until ${t.until}` : ''})` : ''}`).join(', ')} tiers`
    : `${d.tier} tier`
  return clip(`${d.provider} Worker${isKnown(role) && role.value ? `, role ${role.value}` : ''}, ${tiers}, ${d.quotaClass}, ${d.locality}`)
}

/**
 * A Worker's display name, `<runtime> · <account> · <role or tier> [<kinds>]`, for example
 * `Claude Code · science · develop [code]`, made from what was read
 * (docs/design/roster.md#display-names): the Worker's own title (`@1.8`: a website provider's, a
 * model's from the operator's catalog), else its runtime's title, else its provider's first word
 * capitalised (a model Worker's, its family's); for the operator the account's configured label,
 * else an agent account's masked hint and slot, or a website account's catalog label; for a client
 * (who gets no label) an agent account's slot, or the account id; with no account read, its
 * account's id, else the rest of its own id (none for a Worker of no account with its own title);
 * then its role, else its tier, with the kinds of work it takes. For people only: never a routing input, and never a key (the Worker id is).
 */
function nameOf(input: RosterInput, d: RosterDescriptor, role: Known<string | null>, scope: RosterScope, agent: AgentEntry | undefined, site: RosterWebsiteAccount | undefined): string {
  const word = (text: string): string => { const first = text.split(/[-_:.\s]/)[0] || text; return first.charAt(0).toUpperCase() + first.slice(1) }
  // Its own title (`@1.8`) when its source gives a usable one: plain text on one line, at most 64 characters.
  const title = d.title !== undefined && /^[^\p{Cc}]{1,64}$/u.test(d.title) ? d.title : undefined
  const runtime = title ?? input.titles?.get(d.provider) ?? (d.account || d.family === undefined ? word(d.provider) : word(d.family))
  const slot = agent ? `slot ${agent.account.slot}` : undefined
  const own = d.worker.slice(d.worker.indexOf(':') + 1)
  // A Worker of no account that has its own title (a model the operator named) is that title alone.
  const account = agent
    ? (scope === 'operator' ? agent.label ?? (agent.account.hint ? `${agent.account.hint}, ${slot}` : slot) : slot)
    : site
      ? (scope === 'operator' && site.label ? site.label : site.id)
      : d.account?.id ?? (title ? undefined : own.split('/')[0])
  const work = `${isKnown(role) && role.value ? role.value : d.tier}${d.kinds?.length ? ` [${d.kinds.join(', ')}]` : ''}`
  return clip([runtime, account, work].filter((part): part is string => !!part).join(' · '), 200)
}

/**
 * A Worker's role: the role of the enrolled agent account it runs on, read from its derived id
 * `…:<accountId>/<role>` (docs/design/agent-runtimes.md#workers--account--role) for a Worker that
 * account lists; `null` for a Worker that is no role's.
 */
function roleOf(input: RosterInput, d: RosterDescriptor, record: Known<RosterAccountRecord>, agent: { account: RosterAgentAccount; workers: string[] } | undefined): Known<string | null> {
  if (isKnown(record) && record.value.kind === 'website') return known(null)
  if (agent) {
    const id = agent.account.accountId
    const match = id && agent.workers.includes(d.worker) ? new RegExp(`^[a-z][a-z0-9-]*:${escape(id)}/([a-z][a-z0-9-]{0,31})$`).exec(d.worker) : null
    return known(match ? match[1]! : null)
  }
  if (!isKnown(input.agentAccounts)) return unknown(`the agent accounts could not be read (${input.agentAccounts.unknown})`)
  return known(null)
}

/** Read one source, bounded in what it says when it fails: `unknown (why)`, never a default (INV-2). */
async function read<T>(absent: string | undefined, run: () => T | Promise<T>): Promise<Known<T>> {
  if (absent !== undefined) return unknown(absent)
  try {
    return known(await run())
  } catch (error) {
    return unknown(`it could not be read: ${(error as Error).message}`)
  }
}

let registry: SchemaRegistry | undefined
const schemas = (): SchemaRegistry => (registry ??= new SchemaRegistry())

/**
 * Read every source the roster needs, each once and bounded, and project it
 * ({@link projectRoster}); the result is checked against {@link ROSTER_SCHEMA} (a record its schema
 * refuses is a defect, and throws).
 */
export async function readRoster(services: RosterServices, options: { scope: RosterScope; now?: Date }): Promise<Roster> {
  const now = options.now ?? new Date()
  const { workers, accounts, agentWorkers, resources, eventLog, workflow, board } = services
  const listed = await read(workers ? undefined : 'the Worker registry (ctx.workers) is not mounted', () => workers!.list())
  const sources = await read(!workers ? 'the Worker registry (ctx.workers) is not mounted' : !workers.sources ? 'the router keeps no read of its sources' : undefined, () => workers!.sources!())
  const siblings = new Map<string, Known<string[]>>()
  if (isKnown(listed)) {
    for (const d of [...listed.value].sort((a, b) => cmp(a.worker, b.worker)).slice(0, ROSTER_BOUNDS.workers)) siblings.set(d.worker, await read(undefined, () => workers!.siblings(d.worker)))
  }
  const websiteAccounts = await read(accounts ? undefined : 'the website accounts (ctx.accounts) are not mounted', () => accounts!.list())
  const duplicates = await read(accounts ? undefined : 'the website accounts (ctx.accounts) are not mounted', () => accounts!.duplicateIdentities())
  const slots = agentWorkers?.agentAccounts
  const agentAccounts = await read(slots ? undefined : 'the agent accounts (ctx.agentWorkers) are not mounted', () => slots!.list().map((account) => {
    const label = slots!.labelOf?.(account as never)
    const unreadReport = slots!.unreadReport?.(account as never)
    return { account, workers: slots!.workersIn(account as never), ...(label !== undefined ? { label } : {}), ...(unreadReport ? { unreadReport } : {}) }
  }))
  // The agent runtimes' titles: a name for people only, so a read that fails names the Workers by their provider.
  const titles = new Map<string, string>()
  try {
    for (const p of slots?.providers?.() ?? []) if (p.title) titles.set(p.provider, p.title)
  } catch {
    titles.clear()
  }
  const pools = await read(resources ? undefined : 'the resource ledger (ctx.resources) is not mounted', () => resources!.pools())
  const unknownUsage = await read(!resources ? 'the resource ledger (ctx.resources) is not mounted' : !eventLog ? 'the event log (ctx.eventLog) is not mounted' : undefined, () => countUnknownUsage({
    pools: async () => (isKnown(pools) ? pools.value : await resources!.pools()).map((p) => ({ pool: p.pool, windows: p.windows.map((w) => (w.seconds !== undefined ? { seconds: w.seconds } : {})) })),
    entries: ({ since, afterSeq, limit }) => eventLog!.query({ type: USAGE_UNKNOWN_EVENT, since, afterSeq, limit }),
    counted: async (runId, pool) => countedWhole((await resources!.usage({ runId, pool })).records),
  }, now.getTime()))
  const runs = await read(workflow ? undefined : 'the workflow engine (ctx.workflow) is not mounted', () => {
    const page = workflow!.usage(ROSTER_BOUNDS.runs)
    return { runs: page, full: page.length >= ROSTER_BOUNDS.runs }
  })
  // The board tasks the listed Workers' steps serve now, in id order, at most ROSTER_BOUNDS.tasks.
  const tasks = new Map<string, Known<RosterTask>>()
  if (isKnown(runs) && isKnown(listed)) {
    const shown = new Set(siblings.keys())
    const ids = [...new Set(runs.value.runs.filter((r) => r.status === 'running' && r.task && r.nodes.some((n) => n.state === 'RUNNING' && n.worker !== undefined && shown.has(n.worker))).map((r) => r.task!.taskId))].sort(cmp)
    for (const [i, taskId] of ids.entries()) {
      tasks.set(taskId, i >= ROSTER_BOUNDS.tasks ? unknown(`more than ${ROSTER_BOUNDS.tasks} board tasks are served now; this one was not read`)
        : !board ? unknown('the board (ctx.board) is not mounted')
          : await read(undefined, async () => {
            const task = await board.task(taskId)
            if (!task) throw new Error(`the board has no task ${taskId}`)
            return { taskId: task.taskId, projectId: task.projectId, title: task.title, state: task.state }
          }))
    }
  }
  // When each listed step's current attempt started: its latest `workflow.node.started` event of that attempt, at most ROSTER_BOUNDS.starts steps.
  const starts = new Map<string, Known<string>>()
  if (isKnown(runs) && isKnown(listed)) {
    const shown = new Set(siblings.keys())
    const steps = runs.value.runs.filter((r) => r.status === 'running').flatMap((r) => r.nodes.filter((n) => n.state === 'RUNNING' && n.worker !== undefined && shown.has(n.worker)).map((n) => ({ runId: r.runId, node: n })))
      .sort((a, b) => cmp(a.runId, b.runId) || cmp(a.node.nodeId, b.node.nodeId))
    for (const [i, { runId, node }] of steps.entries()) {
      starts.set(stepKey(runId, node.nodeId), i >= ROSTER_BOUNDS.starts ? unknown(`more than ${ROSTER_BOUNDS.starts} steps run now; this one's start was not read`)
        : !eventLog ? unknown('the event log (ctx.eventLog) is not mounted')
          : await read(undefined, () => eventLog.query({ type: NODE_STARTED, runId, nodeId: node.nodeId, afterSeq: 0, limit: ROSTER_BOUNDS.startsPerStep })
            .filter((e) => (e.data as { attempt?: unknown } | undefined)?.attempt === node.attempt).at(-1)?.at)
            .then((at): Known<string> => !isKnown(at) ? at : at.value !== undefined ? known(at.value) : unknown(`the event log holds no ${NODE_STARTED} of attempt ${node.attempt} (its retention may have dropped it)`)))
    }
  }
  // The runs whose liveness needs a look, once, when the router tells them (PROP-0013).
  const liveness = workers?.liveness ? await read(undefined, () => workers.liveness!()) : undefined
  // The Workers the operator keeps out of teams, once, when the engine tells them (D58).
  const teams = workflow?.teamExclusion ? await read(undefined, () => workflow.teamExclusion!()) : undefined
  const roster = projectRoster({ workers: listed, sources, siblings, websiteAccounts, duplicates, agentAccounts, titles, pools, unknownUsage, runs, tasks, starts, ...(liveness ? { liveness } : {}), ...(teams ? { teams } : {}) }, { scope: options.scope, now })
  // Capacity now (`@1.7`): made from this roster, the descriptors it was made from, and the board's ready tasks.
  const ready = await readReady(board)
  const steps = new Map<string, Known<CapacityStep[] | null>>()
  if (isKnown(ready)) {
    for (const t of ready.value.tasks.slice(0, CAPACITY_BOUNDS.list)) {
      const template = t.template
      if (!template || steps.has(template)) continue
      steps.set(template, !workflow ? unknown('the workflow engine (ctx.workflow) is not mounted')
        : !workflow.templateSteps ? unknown('the workflow engine does not preview a template\'s steps')
          : await read(undefined, () => workflow.templateSteps!(template) ?? null))
    }
  }
  const descriptors = new Map(isKnown(listed) ? listed.value.map((d) => [d.worker, d] as const) : [])
  // The operator's reserve: a ledger that cannot tell its settings gives the defaults (20 %, D63), never none.
  let quota: QuotaSettings | undefined
  try {
    quota = resources?.quota?.()
  } catch {
    quota = undefined
  }
  const record: Roster = { ...roster, now: projectCapacity({ roster, descriptors, ready, steps, quota }, now) }
  schemas().assertDef(ROSTER_SCHEMA, 'roster-output', record)
  return record
}

/**
 * The board's ready tasks, of its active projects in id order (at most {@link CAPACITY_BOUNDS}.projects),
 * each project's oldest first; a paused project's ready task cannot start, so it is not read.
 */
async function readReady(board: RosterServices['board']): Promise<Known<{ tasks: CapacityTaskRead[]; unread?: string }>> {
  if (!board) return unknown('the board (ctx.board) is not mounted')
  const { projects: listProjects, tasks: listTasks } = board
  if (!listProjects || !listTasks) return unknown('the board does not list its projects and their tasks')
  return read(undefined, async () => {
    const projects = (await listProjects.call(board, { state: 'active' })).map((p) => p.projectId).sort(cmp)
    const tasks: CapacityTaskRead[] = []
    for (const projectId of projects.slice(0, CAPACITY_BOUNDS.projects)) {
      const ready = (await listTasks.call(board, { projectId, states: ['ready'] })).filter((t) => t.state === 'ready')
        .sort((a, b) => cmp(a.createdAt ?? '', b.createdAt ?? '') || cmp(a.taskId, b.taskId))
      tasks.push(...ready.map((t) => ({ projectId, taskId: t.taskId, title: clip(t.title, 200), ...(t.template ? { template: t.template } : {}), ...(t.createdAt ? { createdAt: t.createdAt } : {}) })))
    }
    return { tasks, ...(projects.length > CAPACITY_BOUNDS.projects ? { unread: `only the first ${CAPACITY_BOUNDS.projects} of ${projects.length} active projects were read: a ready task of another is not listed` } : {}) }
  })
}

/**
 * Capacity now (docs/design/roster.md#capacity-now): the roster's "Right now" as data, the one
 * summary MCP `roster` (`now`), `system capacity`, and the Workers page read. Made by
 * {@link readRoster}, which reads each source once.
 */
export async function readCapacity(services: RosterServices, options: { scope: RosterScope; now?: Date }): Promise<Capacity> {
  return (await readRoster(services, options)).now!
}

const text = <T>(k: Known<T>, show: (value: T) => string = String): string => (isKnown(k) ? show(k.value) : `unknown (${k.unknown})`)

/** The roster as the operator reads it in a terminal: one block per Worker, then what could not be read. */
export function formatRoster(roster: Roster): string {
  const c = roster.counts
  const lines: string[] = []
  // A source still describing for the first time has Workers not known yet: the count is so far, not every Worker.
  const describing = isKnown(roster.sources) ? roster.sources.value.filter((s) => s.describing).map((s) => s.source) : []
  if (!isKnown(roster.workers)) lines.push(`Roster as of ${roster.asOf}: the Workers are unknown (${roster.workers.unknown})`)
  else {
    const sofar = describing.length ? ` so far (source ${describing.join(', ')} still describing its Workers)` : ''
    lines.push(`Roster as of ${roster.asOf}: ${roster.workers.value.length} Worker(s)${sofar}: ${STATES.map((s) => `${c[s]} ${s}`).join(', ')}${roster.unlisted ? `; ${roster.unlisted} more not listed` : ''}`)
    for (const w of roster.workers.value) {
      lines.push('', `${w.name} (${w.worker})  ${w.availability.summary}`)
      lines.push(`  is         ${isKnown(w.description) ? w.description.value : `${w.derived} (derived: no description is configured)`}`)
      lines.push(`  serves     ${w.tiers ? `${w.tiers.map(tierText).join('; ')}` : w.tier}, ${w.quotaClass}, ${w.locality}; provider ${w.provider}, family ${text(w.family)}; role ${text(w.role, (r) => r ?? 'none')}`)
      lines.push(`  account    ${text(w.account, (a) => `${a.id} (${a.group}, ${a.mode}): ${text(a.record, (r) => `${r.kind} ${r.status}${r.label ? `, ${text(r.label, (l) => JSON.stringify(l))}` : ''}${r.slot !== undefined ? `, slot ${r.slot}` : ''}${r.quarantine ? `, quarantined ${r.quarantine.reason} since ${r.quarantine.since} (${r.quarantine.decision})` : ''}${r.sameAs ? `, same person as ${r.sameAs.join(', ')}` : ''}`)}`)}`)
      lines.push(`  load       ${text(w.load, (l) => `${l.running} running of ${l.slots}, ${l.queued} queued, ${l.pending} pending`)}${w.limits.length ? `; limited: ${w.limits.map((l) => `${l.capability} until ${l.until}`).join(', ')}` : ''}`)
      lines.push(`  work       ${text(w.work, (work) => [
        ...(work.items.length ? work.items.map((i) => i.summary) : ['none now']),
        ...(work.more ? [`${work.more} more`] : []), ...(work.unread ? [work.unread] : []),
      ].join('; '))}`)
      if (w.liveness) lines.push(`  liveness   ${text(w.liveness, (runs) => runs.map((r) => r.summary).join('; '))}`)
      if (w.teams) lines.push(`  teams      ${text(w.teams, (t) => t.summary)}`)
      if (!isKnown(w.pools)) lines.push(`  pools      unknown (${w.pools.unknown})`)
      else if (!w.pools.value.length) lines.push('  pools      none on its account')
      for (const p of isKnown(w.pools) ? w.pools.value : []) {
        lines.push(`  pool       ${p.pool} (${p.kind}): ${p.available ? 'available' : `closed${p.until ? ` until ${p.until}` : ''}`}; unknown usage ${text(p.unknownUsage, (u) => `${u.runs} run(s)`)}`)
        for (const win of p.windows) lines.push(`    window   ${win.id}: ${win.state}, used ${text(win.used, (n) => `${n}%`)}, resets ${text(win.resets)}`)
      }
    }
  }
  const unheard = isKnown(roster.sources) ? roster.sources.value.filter((s) => s.state !== 'described') : []
  for (const s of unheard) {
    lines.push('', s.describing
      ? `source ${s.source} describing… at ${s.at}: its first describe since it registered has not landed (${s.detail ?? 'silent'}); its Workers are not listed yet`
      : `source ${s.source} ${s.state} at ${s.at}${s.detail ? `: ${s.detail}` : ''}: its Workers are not listed`)
  }
  if (!isKnown(roster.sources)) lines.push('', `sources unknown (${roster.sources.unknown})`)
  if (isKnown(roster.unknownUsage)) {
    const u = roster.unknownUsage.value
    if (u.unreadable) lines.push('', `${u.unreadable} usage.unknown entr${u.unreadable === 1 ? 'y is' : 'ies are'} not a valid record, so no pool counts ${u.unreadable === 1 ? 'it' : 'them'}`)
    for (const g of u.unconfigured) lines.push('', `${g.runs} run(s) whose usage is unknown name the pool ${g.pool}, which the ledger does not configure`)
  }
  if (roster.now) lines.push('', ...formatCapacity(roster.now))
  return lines.join('\n')
}
