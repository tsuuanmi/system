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
import { countUnknownUsage, MAX_UNKNOWN_ENTRIES, SchemaRegistry, type UnknownUsageCount, USAGE_UNKNOWN_EVENT, type UsageUnknownKind } from '@tsuuanmi/system-libs'

/** The schema of the roster (`mcp-roster@1.2`, `#/$defs/roster-output`). */
export const ROSTER_SCHEMA = 'mcp-roster@1.2'

/** The engine's event when a step's attempt starts (docs/design/workflow-engine.md), read for when a running step began. */
export const NODE_STARTED = 'workflow.node.started'

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
  account?: { id: string; group: string; mode: 'assigned' | 'pooled'; limitUntil?: string | undefined } | undefined
  load?: { running: number; queued: number; pending: number; slots: number } | undefined
  cooldowns?: Array<{ capability: string; until: string }> | undefined
  tier: 'economy' | 'standard' | 'frontier'
  quotaClass: 'subscription-chat' | 'agent-plan' | 'metered' | 'local'
  locality: 'local' | 'remote'
  state: 'ready' | 'busy' | 'quota-exhausted' | 'reauth-required' | 'unavailable'
  observedAt: string
}
/** How a Worker source answered the router's last read (`ctx.workers.sources()`). */
export interface RosterSourceRead { source: string; state: 'described' | 'silent' | 'failed'; at: string; workers: number; detail?: string | undefined }
/** One enrollment slot of an agent runtime (`agent-account@1.0`), without its home or identity. */
export interface RosterAgentAccount {
  accountId?: string | undefined
  provider: string
  slot: number
  status: 'enrolled' | 'ready' | 'signed-out' | 'quarantined'
  quarantine?: { reason: 'changed' | 'ambiguous' | 'duplicate' | 'unverified'; since: string; decision: string } | undefined
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
}
/** A workflow run as the engine's usage view gives it. */
export interface RosterRun {
  runId: string
  template: string
  status: string
  nodes: Array<{ nodeId: string; state: string; attempt: number; worker?: string | undefined }>
  task?: { taskId: string } | undefined
}
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

export interface RosterServices {
  workers?: { list(): Promise<RosterDescriptor[]>; sources?(): RosterSourceRead[]; siblings(worker: string): string[]; liveness?(): Promise<RosterLivenessRead> } | undefined
  accounts?: { list(): Promise<RosterWebsiteAccount[]>; duplicateIdentities(): Promise<string[][]> } | undefined
  agentWorkers?: { agentAccounts?: { list(): RosterAgentAccount[]; workersIn(account: never): string[] } } | undefined
  resources?: { pools(): Promise<RosterPool[]>; usage(filter: { runId: string; pool: string }): Promise<{ records: unknown[] }> } | undefined
  eventLog?: { query(filter: { type: string; since?: string; afterSeq: number; limit: number; runId?: string; nodeId?: string }): Array<{ seq: number; at: string; data?: unknown }> } | undefined
  workflow?: { usage(limit: number): RosterRun[] } | undefined
  board?: { task(taskId: string): Promise<RosterTask | undefined> } | undefined
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
  /** Each enrolled agent account with the Workers that run on it. */
  agentAccounts: Known<Array<{ account: RosterAgentAccount; workers: string[] }>>
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
}

/** The key of one step's start in {@link RosterInput}.starts. */
export const stepKey = (runId: string, nodeId: string): string => `${runId}\u0000${nodeId}`

// The record.

export type AvailabilityState = 'ready' | 'busy' | 'resting' | 'unavailable' | 'quarantined'
export type Availability =
  | { state: 'ready'; summary: string }
  | { state: 'busy'; summary: string; running?: number; slots?: number }
  | { state: 'resting'; summary: string; until: Known<string> }
  | { state: 'unavailable'; summary: string; reason: Known<string> }
  | { state: 'quarantined'; summary: string; reason: 'changed' | 'ambiguous' | 'duplicate' | 'unverified'; since: string; decision: string }

export interface RosterAccountRecord {
  kind: 'agent' | 'website'
  /** The operator's label (a website account's catalog label, an agent account's masked hint); the operator's only. */
  label?: Known<string>
  status: string
  slot?: number
  quarantine?: { reason: string; since: string; decision: string }
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
  /** When its current attempt started. */
  since: Known<string>
  /** The step in one sentence: its task, the run, the step, and for how long. */
  summary: string
}
export interface RosterWindow { id: string; kind: string; seconds?: number; state: 'ok' | 'limited' | 'unknown'; used: Known<number>; resets: Known<string>; observedAt?: string; source?: string }
export interface RosterPoolView { pool: string; kind: string; available: boolean; until?: string; windows: RosterWindow[]; unknownUsage: Known<{ runs: number; kinds: Partial<Record<UsageUnknownKind, number>> }> }
export interface RosterEntry {
  worker: string
  /** A name for people: provider, account, and role or tier, `Claude · t***@example.com · review`; never an id to route by. */
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
}

/** Who reads the roster: an operator sees account labels, a client (the lead) does not. */
export type RosterScope = 'operator' | 'client'

const STATES: readonly AvailabilityState[] = ['ready', 'busy', 'resting', 'unavailable', 'quarantined']
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const later = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : Date.parse(b) > Date.parse(a) ? b : a)
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The account record a Worker runs on: the enrolled agent account of its id (or that lists it), else the website account of its id. */
function recordOf(input: RosterInput, d: RosterDescriptor, scope: RosterScope): { record: Known<RosterAccountRecord>; agent?: { account: RosterAgentAccount; workers: string[] } } {
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
        ...(a.quarantine ? { quarantine: { reason: a.quarantine.reason, since: a.quarantine.since, decision: a.quarantine.decision } } : {}),
      }),
    }
  }
  const sites = input.websiteAccounts
  const site = isKnown(sites) ? sites.value.find((a) => a.id === id) : undefined
  if (site) {
    const label = site.label ? known(site.label) : unknown<string>('the account catalog gives it no label')
    const sameAs = isKnown(input.duplicates) ? (input.duplicates.value.find((group) => group.includes(id)) ?? []).filter((other) => other !== id).sort(cmp) : undefined
    return { record: known({ kind: 'website', ...(scope === 'operator' ? { label } : {}), status: site.status, ...(sameAs?.length ? { sameAs } : {}) }) }
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
    const q = rec.quarantine as { reason: 'changed' | 'ambiguous' | 'duplicate' | 'unverified'; since: string; decision: string }
    return { state: 'quarantined', summary: `quarantined: ${q.reason}, since ${q.since}`, reason: q.reason, since: q.since, decision: q.decision }
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

/** Why an unavailable Worker takes no work, from what its account says; unknown when nothing does. */
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
  return unknown(`its Worker source gives no reason${isKnown(record) ? '' : `, and its account could not be read (${record.unknown})`}; system explain on a run it was refused for shows the route's reasons`)
}

function windowsOf(p: RosterPool): RosterWindow[] {
  return p.windows.map((w) => {
    const r = p.readings.find((reading) => reading.window.id === w.id)
    const base = { id: w.id, kind: w.kind, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}) }
    if (!r) return { ...base, state: 'unknown' as const, used: unknown<number>('no reading yet'), resets: unknown<string>('no reading yet') }
    const reset = later(r.resetsAt, r.cooldownUntil)
    return {
      ...base, state: r.state, observedAt: r.observedAt, source: r.source,
      used: r.usedPercentage !== undefined ? known(r.usedPercentage) : unknown<number>('its latest reading gives no used share'),
      resets: reset !== undefined ? known(reset) : unknown<string>('its latest reading names no reset'),
    }
  })
}

function poolsOf(input: RosterInput, d: RosterDescriptor): Known<RosterPoolView[]> {
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
    return { pool: p.pool, kind: p.kind, available: p.available, ...(p.until ? { until: p.until } : {}), windows: windowsOf(p), unknownUsage }
  }))
}

/** How long from `since` to `now`, in words: "less than a minute", "4 min", "2 h 5 min", "3 days". */
export function spanText(since: string, now: Date): string {
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
  return clip(`Working on ${task}: ${step}, ${how}`, 800)
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
      const work = { runId: run.runId, template: run.template, nodeId: node.nodeId, attempt: node.attempt, ...(run.task && board ? { task: { taskId: run.task.taskId, board } } : {}), since }
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
      const { record, agent } = d.account ? recordOf(input, d, options.scope) : { record: unknown<RosterAccountRecord>('its Worker source names no account') }
      const account: Known<RosterAccount> = d.account
        ? known({ id: d.account.id, group: d.account.group, mode: d.account.mode, ...(d.account.limitUntil ? { limitUntil: d.account.limitUntil } : {}), record })
        : unknown('its Worker source names no account (a descriptor below capability-descriptor@1.5, or a Worker of none)')
      const pools = poolsOf(input, d)
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
        worker: d.worker, name: nameOf(d, record, role, options.scope), provider: d.provider,
        description: d.description !== undefined ? known(d.description) : unknown('no description is configured for it'),
        derived: derivedOf(d, role),
        family: d.family !== undefined ? known(d.family) : unknown('its Worker source declares no provider family'),
        account, role, tier: d.tier, quotaClass: d.quotaClass, locality: d.locality, state: d.state, observedAt: d.observedAt,
        availability,
        load: d.load ? known({ running: d.load.running, queued: d.load.queued, pending: d.load.pending, slots: d.load.slots }) : unknown('its Worker source reports no load'),
        limits: [...(d.cooldowns ?? [])].map((c) => ({ capability: c.capability, until: c.until })).sort((a, b) => cmp(a.capability, b.capability)),
        siblings: siblingsOf(siblings, d.worker),
        work,
        ...livenessFor(input, d.worker, options.now),
        pools,
      }
    }))
  }
  const usage = input.unknownUsage
  return {
    asOf: options.now.toISOString(), workers, unlisted, counts,
    sources: isKnown(input.sources) && input.sources.value.length > ROSTER_BOUNDS.sources ? unknown(`${input.sources.value.length} Worker sources, more than the ${ROSTER_BOUNDS.sources} a roster lists`)
      : isKnown(input.sources) ? known([...input.sources.value].sort((a, b) => cmp(a.source, b.source)).map((s) => ({ source: s.source, state: s.state, at: s.at, workers: s.workers, ...(s.detail ? { detail: clip(s.detail) } : {}) }))) : input.sources,
    unknownUsage: isKnown(usage) ? known({ unreadable: usage.value.unreadable, unconfigured: usage.value.unconfigured }) : unknown(usage.unknown),
  }
}

/**
 * A Worker's name for people, `<provider> · <account> · <role or tier>`: its provider's first word,
 * capitalised (a model's, its family's); its account's label for the operator (a website account's
 * catalog label, an agent account's masked hint), else its account's id, else the rest of its own
 * id; and its role, else its tier. Never an id to route by: the Worker id stays beside it.
 */
function nameOf(d: RosterDescriptor, record: Known<RosterAccountRecord>, role: Known<string | null>, scope: RosterScope): string {
  const word = (text: string): string => { const first = text.split(/[-_:.\s]/)[0] || text; return first.charAt(0).toUpperCase() + first.slice(1) }
  const provider = d.account || d.family === undefined ? word(d.provider) : word(d.family)
  const rec = isKnown(record) ? record.value : undefined
  const label = scope === 'operator' && rec?.label && isKnown(rec.label) ? rec.label.value : undefined
  const own = d.worker.slice(d.worker.indexOf(':') + 1)
  const account = label ?? (rec?.kind === 'website' ? d.account!.id : rec?.kind === 'agent' ? `slot ${rec.slot ?? '?'}` : own.split('/')[0]!)
  const part = isKnown(role) && role.value ? role.value : d.tier
  return clip([provider, account, part].join(' · '), 200)
}

/** A Worker's line made from what its source says: provider, role, tier, quota class, and locality (shown, marked as derived, when it has no description). */
function derivedOf(d: RosterDescriptor, role: Known<string | null>): string {
  return clip(`${d.provider} Worker${isKnown(role) && role.value ? `, role ${role.value}` : ''}, ${d.tier} tier, ${d.quotaClass}, ${d.locality}`)
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
  const agentAccounts = await read(slots ? undefined : 'the agent accounts (ctx.agentWorkers) are not mounted', () => slots!.list().map((account) => ({ account, workers: slots!.workersIn(account as never) })))
  const pools = await read(resources ? undefined : 'the resource ledger (ctx.resources) is not mounted', () => resources!.pools())
  const unknownUsage = await read(!resources ? 'the resource ledger (ctx.resources) is not mounted' : !eventLog ? 'the event log (ctx.eventLog) is not mounted' : undefined, () => countUnknownUsage({
    pools: async () => (isKnown(pools) ? pools.value : await resources!.pools()).map((p) => ({ pool: p.pool, windows: p.windows.map((w) => (w.seconds !== undefined ? { seconds: w.seconds } : {})) })),
    entries: ({ since, afterSeq, limit }) => eventLog!.query({ type: USAGE_UNKNOWN_EVENT, since, afterSeq, limit }),
    counted: async (runId, pool) => (await resources!.usage({ runId, pool })).records.length > 0,
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
  const roster = projectRoster({ workers: listed, sources, siblings, websiteAccounts, duplicates, agentAccounts, pools, unknownUsage, runs, tasks, starts, ...(liveness ? { liveness } : {}) }, { scope: options.scope, now })
  schemas().assertDef(ROSTER_SCHEMA, 'roster-output', roster)
  return roster
}

const text = <T>(k: Known<T>, show: (value: T) => string = String): string => (isKnown(k) ? show(k.value) : `unknown (${k.unknown})`)

/** The roster as the operator reads it in a terminal: one block per Worker, then what could not be read. */
export function formatRoster(roster: Roster): string {
  const c = roster.counts
  const lines: string[] = []
  if (!isKnown(roster.workers)) lines.push(`Roster as of ${roster.asOf}: the Workers are unknown (${roster.workers.unknown})`)
  else {
    lines.push(`Roster as of ${roster.asOf}: ${roster.workers.value.length} Worker(s): ${STATES.map((s) => `${c[s]} ${s}`).join(', ')}${roster.unlisted ? `; ${roster.unlisted} more not listed` : ''}`)
    for (const w of roster.workers.value) {
      lines.push('', `${w.name} (${w.worker})  ${w.availability.summary}`)
      lines.push(`  is         ${isKnown(w.description) ? w.description.value : `${w.derived} (derived: no description is configured)`}`)
      lines.push(`  serves     ${w.tier}, ${w.quotaClass}, ${w.locality}; provider ${w.provider}, family ${text(w.family)}; role ${text(w.role, (r) => r ?? 'none')}`)
      lines.push(`  account    ${text(w.account, (a) => `${a.id} (${a.group}, ${a.mode}): ${text(a.record, (r) => `${r.kind} ${r.status}${r.label ? `, ${text(r.label, (l) => JSON.stringify(l))}` : ''}${r.slot !== undefined ? `, slot ${r.slot}` : ''}${r.quarantine ? `, quarantined ${r.quarantine.reason} since ${r.quarantine.since} (${r.quarantine.decision})` : ''}${r.sameAs ? `, same person as ${r.sameAs.join(', ')}` : ''}`)}`)}`)
      lines.push(`  load       ${text(w.load, (l) => `${l.running} running of ${l.slots}, ${l.queued} queued, ${l.pending} pending`)}${w.limits.length ? `; limited: ${w.limits.map((l) => `${l.capability} until ${l.until}`).join(', ')}` : ''}`)
      lines.push(`  work       ${text(w.work, (work) => [
        ...(work.items.length ? work.items.map((i) => i.summary) : ['none now']),
        ...(work.more ? [`${work.more} more`] : []), ...(work.unread ? [work.unread] : []),
      ].join('; '))}`)
      if (w.liveness) lines.push(`  liveness   ${text(w.liveness, (runs) => runs.map((r) => r.summary).join('; '))}`)
      if (!isKnown(w.pools)) lines.push(`  pools      unknown (${w.pools.unknown})`)
      else if (!w.pools.value.length) lines.push('  pools      none on its account')
      for (const p of isKnown(w.pools) ? w.pools.value : []) {
        lines.push(`  pool       ${p.pool} (${p.kind}): ${p.available ? 'available' : `closed${p.until ? ` until ${p.until}` : ''}`}; unknown usage ${text(p.unknownUsage, (u) => `${u.runs} run(s)`)}`)
        for (const win of p.windows) lines.push(`    window   ${win.id}: ${win.state}, used ${text(win.used, (n) => `${n}%`)}, resets ${text(win.resets)}`)
      }
    }
  }
  const unheard = isKnown(roster.sources) ? roster.sources.value.filter((s) => s.state !== 'described') : []
  for (const s of unheard) lines.push('', `source ${s.source} ${s.state} at ${s.at}${s.detail ? `: ${s.detail}` : ''}: its Workers are not listed`)
  if (!isKnown(roster.sources)) lines.push('', `sources unknown (${roster.sources.unknown})`)
  if (isKnown(roster.unknownUsage)) {
    const u = roster.unknownUsage.value
    if (u.unreadable) lines.push('', `${u.unreadable} usage.unknown entr${u.unreadable === 1 ? 'y is' : 'ies are'} not a valid record, so no pool counts ${u.unreadable === 1 ? 'it' : 'them'}`)
    for (const g of u.unconfigured) lines.push('', `${g.runs} run(s) whose usage is unknown name the pool ${g.pool}, which the ledger does not configure`)
  }
  return lines.join('\n')
}
