/**
 * Worker availability over time (PROP-0016 I4, docs/design/maturity-metrics.md): the roster reads
 * whether a Worker takes work now; this turns each change of it into an event the maturity metrics
 * read later. A Worker becomes **unavailable** (`roster.worker.unavailable`) for a reason, and
 * **available** again (`roster.worker.available`); each event names the Worker, the reason, and
 * carries the time the event log gives it. Pure: what is read, in, and the events to record, out.
 * @module
 */
import type { RosterEntry } from './roster.ts'

/** A Worker became unable to take work. */
export const WORKER_UNAVAILABLE_EVENT = 'roster.worker.unavailable'
/** A Worker became able to take work again (or was first seen able). */
export const WORKER_AVAILABLE_EVENT = 'roster.worker.available'

/**
 * Why a Worker cannot take work. `quota-exhausted`: resting at a usage limit, which the availability
 * metric leaves out (PROP-0016 §1); `login-lost`: its account is signed out or must sign in again;
 * `quarantined`: its account is; `stalled`: a run of it stalled; `unavailable`: any other reason its
 * source or its account gives.
 */
export const UNAVAILABLE_REASONS = ['quota-exhausted', 'login-lost', 'quarantined', 'stalled', 'unavailable'] as const
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

/** The reasons the availability metric leaves out of its hours: a usage limit is not a failure of the Worker. */
export const EXCLUDED_REASONS: readonly UnavailableReason[] = ['quota-exhausted']

/** Whether a Worker takes work, and if not why. */
export type Ability = { able: true } | { able: false; reason: UnavailableReason; detail: string }

/** Account statuses that mean the login is lost: the account must sign in (again) before its Workers take work. */
const LOGIN_LOST = new Set(['signed-out', 'reauth-required', 'challenge', 'new', 'enrolled'])

/** What a roster entry says of whether its Worker takes work now. */
export function abilityOf(entry: RosterEntry): Ability {
  const a = entry.availability
  if (a.state === 'quarantined') return { able: false, reason: 'quarantined', detail: a.summary }
  if (a.state === 'resting') return { able: false, reason: 'quota-exhausted', detail: a.summary }
  if (a.state === 'unavailable') {
    const record = 'value' in entry.account ? entry.account.value.record : undefined
    const status = record && 'value' in record ? record.value.status : undefined
    const lost = entry.state === 'reauth-required' || (status !== undefined && LOGIN_LOST.has(status))
    return { able: false, reason: lost ? 'login-lost' : 'unavailable', detail: a.summary }
  }
  const runs = entry.liveness && 'value' in entry.liveness ? entry.liveness.value : []
  const stalled = runs.find((r) => r.state === 'stalled')
  if (stalled) return { able: false, reason: 'stalled', detail: stalled.summary }
  return { able: true }
}

/** One event to record: its type and data (`worker`, and for an unavailable one `reason` and `detail`). */
export interface AvailabilityEvent { type: typeof WORKER_UNAVAILABLE_EVENT | typeof WORKER_AVAILABLE_EVENT; data: Record<string, unknown> }

/** The last state recorded of each Worker: able, or unable for a reason. */
export type RecordedAbility = ReadonlyMap<string, { able: true } | { able: false; reason: UnavailableReason }>

/** The longest detail an event carries (INV-9). */
const DETAIL_MAX = 300

/**
 * The events that bring `recorded` up to `entries`: a Worker never recorded is recorded as it is now
 * (the baseline), one whose ability or reason changed is recorded as changed, and one that did not
 * change records nothing. A Worker recorded and no longer listed changes nothing (its source may only
 * have been silent this read). Returns the events in Worker order and the state recorded after them.
 */
export function availabilityChanges(recorded: RecordedAbility, entries: readonly RosterEntry[]): { events: AvailabilityEvent[]; next: Map<string, { able: true } | { able: false; reason: UnavailableReason }> } {
  const next = new Map(recorded)
  const events: AvailabilityEvent[] = []
  for (const entry of [...entries].sort((a, b) => (a.worker < b.worker ? -1 : a.worker > b.worker ? 1 : 0))) {
    const now = abilityOf(entry)
    const was = recorded.get(entry.worker)
    if (was && was.able === now.able && (was.able || (!now.able && was.reason === now.reason))) continue
    if (now.able) {
      events.push({ type: WORKER_AVAILABLE_EVENT, data: { worker: entry.worker, ...(was && !was.able ? { was: was.reason } : {}) } })
      next.set(entry.worker, { able: true })
    } else {
      events.push({ type: WORKER_UNAVAILABLE_EVENT, data: { worker: entry.worker, reason: now.reason, detail: [...now.detail].slice(0, DETAIL_MAX).join('') } })
      next.set(entry.worker, { able: false, reason: now.reason })
    }
  }
  return { events, next }
}

/** The state each Worker was last recorded in, from availability events oldest first (a later event replaces an earlier one). */
export function recordedAbility(events: ReadonlyArray<{ type: string; data?: Record<string, unknown> | undefined }>): Map<string, { able: true } | { able: false; reason: UnavailableReason }> {
  const out = new Map<string, { able: true } | { able: false; reason: UnavailableReason }>()
  for (const e of events) {
    const worker = e.data?.['worker']
    if (typeof worker !== 'string') continue
    if (e.type === WORKER_AVAILABLE_EVENT) out.set(worker, { able: true })
    else if (e.type === WORKER_UNAVAILABLE_EVENT) {
      const reason = UNAVAILABLE_REASONS.find((r) => r === e.data?.['reason']) ?? 'unavailable'
      out.set(worker, { able: false, reason })
    }
  }
  return out
}
