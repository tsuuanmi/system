/**
 * Usage the resource ledger could not count (docs/design/resources.md#usage-the-ledger-cannot-count):
 * a Worker source that meters an accounting unit and cannot give the ledger a counted record of it
 * appends one `usage.unknown` event, its data a `usage-unknown@1.0` record; the report and the
 * host's health read them back. A cap counts such a unit as 0 until the ledger counts a record of
 * its run in its pool (reconciled). Nothing here estimates usage.
 */
import { SchemaRegistry } from './schemas.ts'

/** The event type of a unit whose usage the ledger could not count. */
export const USAGE_UNKNOWN_EVENT = 'usage.unknown'

/**
 * Why a unit's usage is unknown: `not-reported` (its runtime reported neither tokens nor turns),
 * `interrupted` (the host stopped while it ran), `refused` (the ledger refused its record), or
 * `failed` (recording it failed otherwise).
 */
export type UsageUnknownKind = 'not-reported' | 'interrupted' | 'refused' | 'failed'
export const USAGE_UNKNOWN_KINDS: readonly UsageUnknownKind[] = ['not-reported', 'interrupted', 'refused', 'failed']

/** `usage-unknown@1.0`; the schema in `schemas/` is canonical. */
export interface UsageUnknown {
  schema: 'usage-unknown@1.0'
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
  reason: string
  /** The ledger's refusal, for `refused`. */
  failure?: 'unknown-pool' | 'invalid'
  /** For `refused`: the refused record, kept as an `evidence` artifact when it is a valid one. */
  record?: `sha256:${string}`
}

/** The longest `reason` a record holds, in characters. */
export const MAX_UNKNOWN_REASON = 500

let registry: SchemaRegistry | undefined
const schemas = (): SchemaRegistry => (registry ??= new SchemaRegistry())

/**
 * The `usage-unknown@1.0` record of `fields`, its reason cut to {@link MAX_UNKNOWN_REASON} whole
 * characters; throws a `SchemaError` when it is still not one (an id that is not one, say).
 */
export function usageUnknown(fields: Omit<UsageUnknown, 'schema'>): UsageUnknown {
  const chars = [...fields.reason]
  const reason = chars.length > MAX_UNKNOWN_REASON ? `${chars.slice(0, MAX_UNKNOWN_REASON - 1).join('')}…` : fields.reason
  const record: UsageUnknown = { schema: 'usage-unknown@1.0', ...fields, reason }
  schemas().assert(record.schema, record)
  return record
}

/** A `usage.unknown` entry's data as its record, or undefined when it is not a valid `usage-unknown@1.0` (a reader never guesses, INV-14). */
export function usageUnknownOf(data: unknown): UsageUnknown | undefined {
  try {
    schemas().assert('usage-unknown@1.0', data)
    return data as UsageUnknown
  } catch {
    return undefined
  }
}

/** `usage.unknown` entries {@link countUnknownUsage} reads at most (INV-9): past it, the count says so. */
export const MAX_UNKNOWN_ENTRIES = 10_000
/** Entries it asks for at once: the event log's most per query. */
const UNKNOWN_PAGE = 1000

/** What {@link countUnknownUsage} reads: the ledger's pools and windows, a page of the entries, and whether it counted a run. */
export interface UnknownUsageSources {
  /** The configured pools, each with its windows' lengths (none: a window of no length, a credit balance). */
  pools: () => Promise<Array<{ pool: string; windows: Array<{ seconds?: number | undefined }> }>>
  /** A page of the `usage.unknown` entries since a time, in `seq` order, after `afterSeq`, at most `limit`. */
  entries: (query: { since: string; afterSeq: number; limit: number }) => Array<{ seq: number; at: string; data?: unknown }>
  /** Whether the ledger counted a usage record of a run in a pool (reconciled). */
  counted: (runId: string, pool: string) => Promise<boolean>
}

/** The runs whose usage the ledger could not count and has not counted since, per pool. */
export interface UnknownUsageCount {
  /**
   * Every configured pool, in id order: the length of its current window, its longest, in seconds
   * (absent: a window of no length, which never resets), and its open runs in it by kind.
   */
  pools: Array<{ pool: string; seconds?: number; runs: number; kinds: Partial<Record<UsageUnknownKind, number>> }>
  /** Open runs that name a pool the ledger does not configure, so no window counts them. */
  unconfigured: Array<{ pool: string; runs: number }>
  /** Entries that are not a valid `usage-unknown@1.0` record, so no pool counts them. */
  unreadable: number
  /** More than {@link MAX_UNKNOWN_ENTRIES} entries were in the windows: only the first were read. */
  unread: boolean
}

/**
 * Count, per configured pool, the runs whose usage the ledger could not count in its current window
 * (its longest, back from `now`; a pool with a window of no length reads every entry the log keeps)
 * that the ledger has not counted a record of since: each run once per pool, by its first entry. An
 * entry that is not a valid record, or that names a pool the ledger does not configure, is counted
 * apart, never skipped (INV-14). The entries are read a page at a time, at most
 * {@link MAX_UNKNOWN_ENTRIES} (INV-9); `unread` says the rest were not. The host's health and the
 * roster read it (docs/design/resources.md#usage-the-ledger-cannot-count).
 */
export async function countUnknownUsage(sources: UnknownUsageSources, now: number): Promise<UnknownUsageCount> {
  const windows = new Map((await sources.pools()).map((p) => {
    const bounded = p.windows.length > 0 && p.windows.every((w) => w.seconds !== undefined)
    return [p.pool, bounded ? Math.max(...p.windows.map((w) => w.seconds!)) : undefined] as const
  }))
  const count: UnknownUsageCount = { pools: [], unconfigured: [], unreadable: 0, unread: false }
  if (!windows.size) return count
  const starts = [...windows.values()].map((seconds) => (seconds === undefined ? 0 : now - seconds * 1000))
  // Every entry back to the earliest window's start, in `seq` order: one entry more says the rest went unread.
  const since = new Date(Math.min(...starts)).toISOString()
  const entries: ReturnType<UnknownUsageSources['entries']> = []
  for (let afterSeq = 0; ;) {
    const limit = Math.min(UNKNOWN_PAGE, MAX_UNKNOWN_ENTRIES + 1 - entries.length)
    const page = sources.entries({ since, afterSeq, limit })
    entries.push(...page)
    if (entries.length > MAX_UNKNOWN_ENTRIES) {
      count.unread = true
      entries.length = MAX_UNKNOWN_ENTRIES
      break
    }
    if (page.length < limit) break
    afterSeq = page.at(-1)!.seq
  }
  const runs = new Map<string, Map<string, UsageUnknownKind>>()
  const unconfigured = new Map<string, Set<string>>()
  for (const entry of entries) {
    const fact = usageUnknownOf(entry.data)
    if (!fact) {
      count.unreadable += 1
      continue
    }
    if (!windows.has(fact.pool)) {
      (unconfigured.get(fact.pool) ?? unconfigured.set(fact.pool, new Set()).get(fact.pool)!).add(fact.runId)
      continue
    }
    const seconds = windows.get(fact.pool)
    if (seconds !== undefined && Date.parse(entry.at) < now - seconds * 1000) continue
    const ofPool = runs.get(fact.pool) ?? runs.set(fact.pool, new Map()).get(fact.pool)!
    if (!ofPool.has(fact.runId)) ofPool.set(fact.runId, fact.kind)
  }
  for (const pool of [...windows.keys()].sort()) {
    const kinds: Partial<Record<UsageUnknownKind, number>> = {}
    let open = 0
    for (const [runId, kind] of runs.get(pool) ?? []) {
      if (await sources.counted(runId, pool)) continue
      kinds[kind] = (kinds[kind] ?? 0) + 1
      open += 1
    }
    const seconds = windows.get(pool)
    count.pools.push({ pool, ...(seconds !== undefined ? { seconds } : {}), runs: open, kinds })
  }
  for (const pool of [...unconfigured.keys()].sort()) {
    let open = 0
    for (const runId of unconfigured.get(pool)!) if (!(await sources.counted(runId, pool))) open += 1
    if (open) count.unconfigured.push({ pool, runs: open })
  }
  return count
}
