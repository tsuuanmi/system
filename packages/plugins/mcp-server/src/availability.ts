/**
 * Records each change of a Worker's availability in the event log (PROP-0016 I4,
 * docs/design/maturity-metrics.md): the endpoint reads the roster on an interval, compares it with
 * what the log last recorded of each Worker, and appends one `roster.worker.unavailable` or
 * `roster.worker.available` event per change, so the metrics can count the hours each Worker could
 * take work. The first read of a Worker records it as it is (the baseline).
 */
import { availabilityChanges, recordedAbility, type Roster, WORKER_AVAILABLE_EVENT, WORKER_UNAVAILABLE_EVENT } from '@tsuuanmi/system-gateway-core'

/** What the tracker needs of the event log. */
export interface AvailabilityLog {
  query(filter: { type: string; order: 'desc'; limit: number }): Array<{ seq: number; type: string; data?: unknown }>
  append(event: { type: string; data: Record<string, unknown> }): unknown
}

/** The latest entries of each type read to find what was last recorded of each Worker (INV-9). */
export const AVAILABILITY_HISTORY = 2000

/**
 * Append the events that bring the log's record of each Worker up to `roster`; returns how many were
 * recorded. A roster whose Workers could not be read records nothing (a silent source is not a
 * Worker that cannot take work).
 */
export function recordAvailability(log: AvailabilityLog, roster: Roster): number {
  if (!('value' in roster.workers)) return 0
  const last = [WORKER_UNAVAILABLE_EVENT, WORKER_AVAILABLE_EVENT]
    .flatMap((type) => log.query({ type, order: 'desc', limit: AVAILABILITY_HISTORY }))
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ type: e.type, ...(e.data !== null && typeof e.data === 'object' ? { data: e.data as Record<string, unknown> } : {}) }))
  const { events } = availabilityChanges(recordedAbility(last), roster.workers.value)
  for (const event of events) log.append(event)
  return events.length
}
