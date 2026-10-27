/**
 * agy's own usage report as limit observations, an account's usage report (ADR-0059,
 * docs/design/agent-runtimes.md#an-accounts-usage-report). A run's stream and its error name no
 * reset time (agy 1.4.6's quota errors are `individual quota reached`, `You have exhausted your
 * quota on this model.`, `Your AI credits balance is too low to continue.`), but print mode answers
 * `/usage` itself, without an agent turn, spending quota, or leaving a conversation behind (agy's
 * changelog), and under `--output-format json` it writes one JSON object whose `command.data` is the
 * quota summary, reset times in UTC:
 *
 * ```
 * { "status": "SUCCESS", …, "command": { "name": "usage", "data": {
 *     "description"?: string, "groups": [ { "name": string, "description"?: string, "buckets": [ {
 *       "id"?: string, "name": string, "description"?: string, "window"?: string, "disabled"?: boolean,
 *       "remaining_fraction"?: number, "remaining_amount"?: integer, "reset_time"?: RFC 3339 } ] } ] } } }
 * ```
 * @module
 */
import type { LimitObservation } from '@tsuuanmi/system-agent-runtime-core'
import { isRecord } from '@tsuuanmi/system-libs'

/**
 * agy versions whose `/usage` report is read. 1.4.6 (2026-10-24, the installed binary): its type
 * descriptors give the report's shape above (`printmode.quotaJSON`, `groupJSON`, `bucketJSON` under
 * `steps.JSONOutput.command`, a `steps.JSONCommand` of `name` and `data`), `printmode.bucketReset`
 * formats a reset with RFC 3339, and its changelog says print mode answers `/usage` with no agent
 * turn and that piped and JSON output keep UTC. `tests/fixtures/agy-1.4.6-usage.json` holds reports
 * in that shape. On any other version the report is never asked for (an agy that no longer answers
 * `/usage` itself would send it to the model as a prompt), and it reads `unreadable`, naming the
 * version.
 */
export const VERIFIED_LIMIT_VERSIONS: readonly string[] = ['1.4.6']

/** agy's arguments for its usage report: print mode answers it, so slash commands stay on. */
export const USAGE_ARGS: readonly string[] = ['--print=/usage', '--output-format', 'json']

/** The names under which agy reports its quota summary (`/usage` and `/quota` share it). */
const REPORTS = new Set(['usage', 'quota'])
/** A reset time further than this from now is not believed. */
const PLAUSIBLE_MS = 400 * 86_400_000
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const optional = (value: unknown, type: 'string' | 'boolean' | 'number'): boolean => value === undefined || typeof value === type

/**
 * The limit observations agy's usage report (`stdout`) gives, read at `observedAt` (ms), or why it
 * cannot be read. A report not in the shape above (any field of another type, a fraction outside 0
 * to 1, an amount that is not a whole number) is unreadable as a whole: something changed, so
 * nothing in it is believed. In a readable report, each bucket that is not `disabled` and says how
 * much is left is one observation of the window named by its `id`: `rejected` when nothing is left
 * (`remaining_fraction` or `remaining_amount` 0), else `allowed`, with `usedPercentage` from the
 * fraction and `resetsAt` from `reset_time` when it parses, is ahead of `observedAt` (for a
 * rejection), and is at most 400 days away. A bucket that says nothing about what is left is no
 * reading (unknown, never `allowed`); a rejected bucket without an `id` is reported as window `*`,
 * which no configuration maps, so the ledger closes every window of the pool; an allowed one
 * without an `id` is not reported.
 */
export function limitsFromUsage(stdout: string, observedAt: number): { limits: LimitObservation[] } | { unreadable: string } {
  let report: unknown
  try {
    report = JSON.parse(stdout)
  } catch {
    return { unreadable: 'it is not one JSON object' }
  }
  if (!isRecord(report)) return { unreadable: 'it is not one JSON object' }
  if (report.status !== undefined && report.status !== 'SUCCESS') return { unreadable: `its status is ${JSON.stringify(report.status).slice(0, 40)}` }
  const command = report.command
  if (!isRecord(command) || typeof command.name !== 'string' || !REPORTS.has(command.name)) return { unreadable: 'it holds no usage report (command)' }
  const data = command.data
  if (!isRecord(data) || !Array.isArray(data.groups)) return { unreadable: 'its report has no groups' }
  const observed = new Date(observedAt).toISOString()
  const limits: LimitObservation[] = []
  for (const group of data.groups as unknown[]) {
    if (!isRecord(group) || typeof group.name !== 'string' || !Array.isArray(group.buckets)) return { unreadable: 'a group is not a named list of buckets' }
    for (const bucket of group.buckets as unknown[]) {
      if (!isRecord(bucket) || typeof bucket.name !== 'string' || !optional(bucket.id, 'string') || !optional(bucket.window, 'string')
        || !optional(bucket.disabled, 'boolean') || !optional(bucket.reset_time, 'string')) return { unreadable: 'a bucket is not in the 1.4.6 shape' }
      const fraction = bucket.remaining_fraction
      const amount = bucket.remaining_amount
      if (fraction !== undefined && (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)) return { unreadable: 'a remaining_fraction is not between 0 and 1' }
      if (amount !== undefined && (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0)) return { unreadable: 'a remaining_amount is not a whole number' }
      if (bucket.disabled === true || (fraction === undefined && amount === undefined)) continue
      const status = fraction === 0 || amount === 0 ? 'rejected' : 'allowed'
      const window = typeof bucket.id === 'string' && bucket.id ? bucket.id : status === 'rejected' ? '*' : undefined
      if (!window) continue
      const reset = typeof bucket.reset_time === 'string' && RFC3339.test(bucket.reset_time) ? Date.parse(bucket.reset_time) : Number.NaN
      const believed = Number.isFinite(reset) && Math.abs(reset - observedAt) <= PLAUSIBLE_MS && (status !== 'rejected' || reset > observedAt)
      limits.push({
        window, status,
        ...(believed ? { resetsAt: new Date(reset).toISOString() } : {}),
        ...(fraction !== undefined ? { usedPercentage: Math.round((1 - fraction) * 10_000) / 100 } : {}),
        observedAt: observed,
      })
    }
  }
  return { limits }
}
