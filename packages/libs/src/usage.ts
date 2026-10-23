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
