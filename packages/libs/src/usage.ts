/**
 * Usage the resource ledger could not count (docs/design/resources.md#usage-the-ledger-cannot-count):
 * a Worker source that meters an accounting unit and cannot give the ledger a counted record of it
 * appends one `usage.unknown` event, its data a `usage-unknown@1.0` record (`@1.1` when it names the
 * `partial` record of a lower bound the ledger counted); the report, the host's health, and the
 * ledger's caps read them back. A unit stays unknown until the ledger counts a record of its run in
 * its pool other than its own lower bound (reconciled): until then a cap of its scope and pool fails
 * closed (INV-2, ADR-0065), never counting it as 0. Nothing here estimates usage.
 */
import { SchemaRegistry } from './schemas.ts'

/** The event type of a unit whose usage the ledger could not count. */
export const USAGE_UNKNOWN_EVENT = 'usage.unknown'

/**
 * Why a unit's usage is unknown: `not-reported` (it ended without its runtime's final count: its
 * runtime reported neither tokens nor turns, or, with `partial`, only what it reported while it
 * ran), `interrupted` (the host stopped while it ran), `refused` (the ledger refused its record), or
 * `failed` (recording it failed otherwise).
 */
export type UsageUnknownKind = 'not-reported' | 'interrupted' | 'refused' | 'failed'
export const USAGE_UNKNOWN_KINDS: readonly UsageUnknownKind[] = ['not-reported', 'interrupted', 'refused', 'failed']

/** `usage-unknown@1.0`, or `@1.1` with `partial`; the schema in `schemas/` is canonical. */
export interface UsageUnknown {
  schema: 'usage-unknown@1.0' | 'usage-unknown@1.1'
  /** The unit, as a usage record of it names its `runId`. */
  runId: string
  kind: UsageUnknownKind
  account: string
  pool: string
  worker?: string
  sessionId?: string
  projectId?: string
  taskId?: string
  outcome?: 'completed' | 'failed' | 'aborted'
  observedAt: string
  /** Why, in plain words: how the unit ended, and what its runtime reported. */
  reason: string
  /** The ledger's refusal, for `refused`. */
  failure?: 'unknown-pool' | 'invalid'
  /** For `refused`: the refused record, kept as an `evidence` artifact when it is a valid one. */
  record?: `sha256:${string}`
  /**
   * For `not-reported` (1.1): the usage record the ledger counted of what the runtime reported while
   * the unit ran, before it ended without its final count. A lower bound, never the unit's usage: it
   * does not reconcile the unit.
   */
  partial?: `sha256:${string}`
}

/** The longest `reason` a record holds, in characters. */
export const MAX_UNKNOWN_REASON = 500

let registry: SchemaRegistry | undefined
const schemas = (): SchemaRegistry => (registry ??= new SchemaRegistry())

/**
 * The `usage-unknown@1` record of `fields` (`@1.1` when it names a `partial` record), its reason cut
 * to {@link MAX_UNKNOWN_REASON} whole characters; throws a `SchemaError` when it is still not one (an
 * id that is not one, say).
 */
export function usageUnknown(fields: Omit<UsageUnknown, 'schema'>): UsageUnknown {
  const chars = [...fields.reason]
  const reason = chars.length > MAX_UNKNOWN_REASON ? `${chars.slice(0, MAX_UNKNOWN_REASON - 1).join('')}…` : fields.reason
  const record: UsageUnknown = { schema: fields.partial ? 'usage-unknown@1.1' : 'usage-unknown@1.0', ...fields, reason }
  schemas().assert(record.schema, record)
  return record
}

/** A `usage.unknown` entry's data as its record, or undefined when it is not a valid `usage-unknown@1` (a reader never guesses, INV-14). */
export function usageUnknownOf(data: unknown): UsageUnknown | undefined {
  try {
    schemas().assert('usage-unknown@1.0', data)
    return data as UsageUnknown
  } catch {
    return undefined
  }
}

/**
 * Whether a unit is reconciled: the ledger counts a record of its run in its pool (`counted`), and
 * that is not only the `partial` record its own fact names, a lower bound of what it consumed. A
 * unit with only its lower bound stays unknown (INV-2: a lower bound is never read as the whole).
 */
export function reconciledBy(fact: Pick<UsageUnknown, 'partial'>, counted: boolean): boolean {
  return counted && fact.partial === undefined
}

/** `usage.unknown` entries {@link countUnknownUsage} and {@link unknownUsageOf} read at most (INV-9): past it, they say so. */
export const MAX_UNKNOWN_ENTRIES = 10_000
/** Entries asked for at once: the event log's most per query. */
const UNKNOWN_PAGE = 1000

/** A page of the `usage.unknown` entries since a time, in `seq` order, after `afterSeq`, at most `limit`. */
export type UnknownEntries = (query: { since: string; afterSeq: number; limit: number }) => Array<{ seq: number; at: string; data?: unknown }>

/** Every `usage.unknown` entry since `since`, a page at a time, at most {@link MAX_UNKNOWN_ENTRIES}; `unread` when more were there. */
function readEntries(entries: UnknownEntries, since: string): { read: ReturnType<UnknownEntries>; unread: boolean } {
  const read: ReturnType<UnknownEntries> = []
  for (let afterSeq = 0; ;) {
    const limit = Math.min(UNKNOWN_PAGE, MAX_UNKNOWN_ENTRIES + 1 - read.length)
    const page = entries({ since, afterSeq, limit })
    read.push(...page)
    if (read.length > MAX_UNKNOWN_ENTRIES) {
      read.length = MAX_UNKNOWN_ENTRIES
      return { read, unread: true }
    }
    if (page.length < limit) return { read, unread: false }
    afterSeq = page.at(-1)!.seq
  }
}

/** What {@link countUnknownUsage} reads: the ledger's pools and windows, a page of the entries, and whether it counted a run. */
export interface UnknownUsageSources {
  /** The configured pools, each with its windows' lengths (none: a window of no length, a credit balance). */
  pools: () => Promise<Array<{ pool: string; windows: Array<{ seconds?: number | undefined }> }>>
  /** A page of the `usage.unknown` entries since a time, in `seq` order, after `afterSeq`, at most `limit`. */
  entries: UnknownEntries
  /** Whether the ledger counted a usage record of a run in a pool. */
  counted: (runId: string, pool: string) => Promise<boolean>
}

/** The runs of a pool {@link countUnknownUsage} names, the latest first, at most this many; the rest are counted. */
export const NAMED_UNKNOWN_RUNS = 3

/** One open run as the count names it: which run, on which Worker, its kind, how it ended, and why, in its source's own words. */
export interface UnknownRun {
  runId: string
  worker?: string
  kind: UsageUnknownKind
  outcome?: UsageUnknown['outcome']
  reason: string
  /** The ledger counted a lower bound of it (`partial`): what its runtime reported before it ended. */
  lowerBound?: true
}

/** The runs whose usage the ledger could not count and has not counted since, per pool. */
export interface UnknownUsageCount {
  /**
   * Every configured pool, in id order: the length of its current window, its longest, in seconds
   * (absent: a window of no length, which never resets), its open runs in it by kind, and the latest
   * {@link NAMED_UNKNOWN_RUNS} of them, by their first entry.
   */
  pools: Array<{ pool: string; seconds?: number; runs: number; kinds: Partial<Record<UsageUnknownKind, number>>; named: UnknownRun[] }>
  /** Open runs that name a pool the ledger does not configure, so no window counts them. */
  unconfigured: Array<{ pool: string; runs: number }>
  /** Entries that are not a valid `usage-unknown@1` record, so no pool counts them. */
  unreadable: number
  /** More than {@link MAX_UNKNOWN_ENTRIES} entries were in the windows: only the first were read. */
  unread: boolean
}

/** A run as the count names it. */
const named = (fact: UsageUnknown): UnknownRun => ({
  runId: fact.runId, ...(fact.worker !== undefined ? { worker: fact.worker } : {}), kind: fact.kind, ...(fact.outcome !== undefined ? { outcome: fact.outcome } : {}),
  reason: fact.reason, ...(fact.partial !== undefined ? { lowerBound: true as const } : {}),
})

/**
 * Count, per configured pool, the runs whose usage the ledger could not count in its current window
 * (its longest, back from `now`; a pool with a window of no length reads every entry the log keeps)
 * that are not reconciled ({@link reconciledBy}): each run once per pool, by its first entry, the
 * latest {@link NAMED_UNKNOWN_RUNS} named. An entry that is not a valid record, or that names a pool
 * the ledger does not configure, is counted apart, never skipped (INV-14). The entries are read a
 * page at a time, at most {@link MAX_UNKNOWN_ENTRIES} (INV-9); `unread` says the rest were not. The
 * host's health and the roster read it (docs/design/resources.md#usage-the-ledger-cannot-count).
 */
export async function countUnknownUsage(sources: UnknownUsageSources, now: number): Promise<UnknownUsageCount> {
  const windows = new Map((await sources.pools()).map((p) => {
    const bounded = p.windows.length > 0 && p.windows.every((w) => w.seconds !== undefined)
    return [p.pool, bounded ? Math.max(...p.windows.map((w) => w.seconds!)) : undefined] as const
  }))
  const count: UnknownUsageCount = { pools: [], unconfigured: [], unreadable: 0, unread: false }
  if (!windows.size) return count
  const starts = [...windows.values()].map((seconds) => (seconds === undefined ? 0 : now - seconds * 1000))
  // Every entry back to the earliest window's start, in `seq` order.
  const { read, unread } = readEntries(sources.entries, new Date(Math.min(...starts)).toISOString())
  count.unread = unread
  // Each run once per pool, by its first fact, in the order of the first facts.
  const runs = new Map<string, Map<string, UsageUnknown>>()
  const unconfigured = new Map<string, Map<string, UsageUnknown>>()
  for (const entry of read) {
    const fact = usageUnknownOf(entry.data)
    if (!fact) {
      count.unreadable += 1
      continue
    }
    const into = windows.has(fact.pool) ? runs : unconfigured
    if (into === runs) {
      const seconds = windows.get(fact.pool)
      if (seconds !== undefined && Date.parse(entry.at) < now - seconds * 1000) continue
    }
    const ofPool = into.get(fact.pool) ?? into.set(fact.pool, new Map()).get(fact.pool)!
    if (!ofPool.has(fact.runId)) ofPool.set(fact.runId, fact)
  }
  for (const pool of [...windows.keys()].sort()) {
    const kinds: Partial<Record<UsageUnknownKind, number>> = {}
    const open: UnknownRun[] = []
    for (const [runId, fact] of runs.get(pool) ?? []) {
      if (reconciledBy(fact, await sources.counted(runId, pool))) continue
      kinds[fact.kind] = (kinds[fact.kind] ?? 0) + 1
      open.push(named(fact))
    }
    const seconds = windows.get(pool)
    count.pools.push({ pool, ...(seconds !== undefined ? { seconds } : {}), runs: open.length, kinds, named: open.reverse().slice(0, NAMED_UNKNOWN_RUNS) })
  }
  for (const pool of [...unconfigured.keys()].sort()) {
    let open = 0
    for (const [runId, fact] of unconfigured.get(pool)!) if (!reconciledBy(fact, await sources.counted(runId, pool))) open += 1
    if (open) count.unconfigured.push({ pool, runs: open })
  }
  return count
}

/** What {@link unknownUsageOf} reads: the entries, and whether the ledger counted a run in a pool. */
export interface ScopeUnknownSources {
  entries: UnknownEntries
  counted: (runId: string, pool: string) => boolean
  /** The scope a run was reserved for, when its fact names none. */
  reservedFor?: (runId: string) => { projectId?: string | undefined; taskId?: string | undefined } | undefined
}

/**
 * The runs of a scope (a task, else a project) whose usage the ledger could not count in one of
 * `pools` and that are not reconciled: what a cap of that scope cannot count, so it fails closed
 * (INV-2, ADR-0065). A fact names its scope as the run's usage record would; one that names none
 * takes the scope its run was reserved for. Every entry the log keeps is read, at most
 * {@link MAX_UNKNOWN_ENTRIES}: `unread` (and `unreadable`, entries no reader can place) mean some
 * run of the scope may be missing, which a cap reads as unknown too.
 */
export function unknownUsageOf(sources: ScopeUnknownSources, scope: { taskId?: string | undefined; projectId?: string | undefined }, pools: ReadonlySet<string>): { runs: Array<UnknownRun & { pool: string }>; unread: boolean; unreadable: number } {
  const { read, unread } = readEntries(sources.entries, new Date(0).toISOString())
  const first = new Map<string, UsageUnknown>()
  let unreadable = 0
  for (const entry of read) {
    const fact = usageUnknownOf(entry.data)
    if (!fact) {
      unreadable += 1
      continue
    }
    if (!pools.has(fact.pool)) continue
    const key = `${fact.pool}\0${fact.runId}`
    if (!first.has(key)) first.set(key, fact)
  }
  const runs: Array<UnknownRun & { pool: string }> = []
  for (const fact of first.values()) {
    const placed = fact.taskId !== undefined || fact.projectId !== undefined ? fact : sources.reservedFor?.(fact.runId) ?? {}
    const inScope = scope.taskId !== undefined ? placed.taskId === scope.taskId : scope.projectId !== undefined ? placed.projectId === scope.projectId : false
    if (!inScope || reconciledBy(fact, sources.counted(fact.runId, fact.pool))) continue
    runs.push({ pool: fact.pool, runId: fact.runId, ...(fact.worker !== undefined ? { worker: fact.worker } : {}), kind: fact.kind, reason: fact.reason, ...(fact.partial !== undefined ? { lowerBound: true as const } : {}) })
  }
  return { runs, unread, unreadable }
}
